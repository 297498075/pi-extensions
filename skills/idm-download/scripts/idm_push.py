#!/usr/bin/env python3
"""
IDM Download Helper Script.
Automates scheduling single and batch download tasks to Internet Download Manager (IDMan.exe).
Pure Python standard library; zero external dependencies.
"""

import argparse
import os
import sys
import subprocess
from pathlib import Path
from typing import Optional, Union, List, Dict, Any


CANDIDATE_IDM_PATHS = [
    Path(r"C:\Program Files (x86)\Internet Download Manager\IDMan.exe"),
    Path(r"C:\Program Files\Internet Download Manager\IDMan.exe"),
]


def find_idm_executable() -> Optional[Path]:
    """Finds IDMan.exe via IDM_PATH env, default paths, PATH environment, or Windows Registry."""
    # Check IDM_PATH environment variable
    env_path = os.environ.get("IDM_PATH")
    if env_path:
        p = Path(env_path)
        if p.is_file():
            return p
        candidate = p / "IDMan.exe"
        if candidate.is_file():
            return candidate

    for p in CANDIDATE_IDM_PATHS:
        if p.is_file():
            return p

    # Check PATH
    try:
        res = subprocess.run(["where", "IDMan.exe"], capture_output=True, text=True, shell=True)
        if res.returncode == 0 and res.stdout.strip():
            first = Path(res.stdout.strip().splitlines()[0])
            if first.is_file():
                return first
    except Exception:
        pass

    # Check Windows Registry
    if sys.platform == "win32":
        try:
            import winreg
            keys_to_check = [
                (winreg.HKEY_CURRENT_USER, r"Software\DownloadManager"),
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Internet Download Manager"),
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Internet Download Manager"),
            ]
            for hkey, subkey in keys_to_check:
                try:
                    with winreg.OpenKey(hkey, subkey) as key:
                        val, _ = winreg.QueryValueEx(key, "ExePath")
                        if val and Path(val).is_file():
                            return Path(val)
                except OSError:
                    continue
        except Exception:
            pass

    return None


def push_download(
    url: str,
    target_dir: Union[str, Path],
    filename: Optional[str] = None,
    start_immediately: bool = True,
    idm_path: Optional[Union[str, Path]] = None,
) -> bool:
    """Pushes a single download URL to IDMan.exe."""
    exe = Path(idm_path) if idm_path else find_idm_executable()
    if not exe or not exe.is_file():
        print(f"[Error] IDMan.exe not found on system.", file=sys.stderr)
        return False

    out_dir = Path(target_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        str(exe),
        "/d", url,
        "/p", str(out_dir),
    ]
    if filename:
        cmd.extend(["/f", str(filename)])

    if start_immediately:
        cmd.append("/n")
    else:
        cmd.append("/a")

    cmd.append("/q")

    try:
        res = subprocess.run(cmd, check=True, capture_output=True)
        return res.returncode == 0
    except subprocess.SubprocessError as e:
        print(f"[Error] Failed to invoke IDMan: {e}", file=sys.stderr)
        return False


def start_idm_queue(idm_path: Optional[Union[str, Path]] = None) -> bool:
    """Commands IDM to start processing its download queue (/s)."""
    exe = Path(idm_path) if idm_path else find_idm_executable()
    if not exe or not exe.is_file():
        return False
    try:
        subprocess.run([str(exe), "/s"], check=True, capture_output=True)
        return True
    except subprocess.SubprocessError:
        return False


def parse_args():
    parser = argparse.ArgumentParser(description="IDM Download Push Utility")
    parser.add_argument("--url", "-u", type=str, help="Direct download URL")
    parser.add_argument("--dir", "-d", type=str, default=".", help="Target directory (default: current dir)")
    parser.add_argument("--filename", "-f", type=str, default=None, help="Explicit destination filename")
    parser.add_argument("--queue", "-q", action="store_true", help="Add to queue without starting immediately (/a instead of /n)")
    parser.add_argument("--batch", "-b", type=str, default=None, help="Path to text or JSON file with batch downloads")
    parser.add_argument("--start-queue", action="store_true", help="Start processing the IDM queue (/s)")
    parser.add_argument("--locate", action="store_true", help="Check and print detected IDMan.exe location")
    parser.add_argument("--idm-path", type=str, default=None, help="Explicit path to IDMan.exe executable")
    return parser.parse_args()


def main():
    args = parse_args()
    explicit_idm = args.idm_path

    if args.locate:
        exe = Path(explicit_idm) if explicit_idm else find_idm_executable()
        if exe and exe.is_file():
            print(f"[OK] Found IDMan.exe at: {exe}")
            sys.exit(0)
        else:
            print("[Fail] IDMan.exe not found.")
            sys.exit(1)

    if args.start_queue:
        if start_idm_queue(idm_path=explicit_idm):
            print("[OK] IDM queue started successfully.")
            sys.exit(0)
        else:
            print("[Fail] Failed to start IDM queue.", file=sys.stderr)
            sys.exit(1)

    if args.batch:
        batch_path = Path(args.batch)
        if not batch_path.is_file():
            print(f"[Error] Batch file not found: {batch_path}", file=sys.stderr)
            sys.exit(1)

        tasks = []
        if batch_path.suffix.lower() == ".json":
            import json
            with open(batch_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    tasks = data
                elif isinstance(data, dict) and "downloads" in data:
                    tasks = data["downloads"]
        else:
            with open(batch_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        parts = line.split()
                        u = parts[0]
                        fn = parts[1] if len(parts) > 1 else None
                        tasks.append({"url": u, "filename": fn, "dir": args.dir})

        success_count = 0
        for item in tasks:
            u = item.get("url")
            fn = item.get("filename")
            d = item.get("dir", args.dir)
            ok = push_download(u, d, fn, start_immediately=not args.queue, idm_path=explicit_idm)
            if ok:
                success_count += 1
                print(f"[OK] Queued: {fn or u} -> {d}")
            else:
                print(f"[Fail] Failed: {fn or u}")

        print(f"\n[Summary] Pushed {success_count}/{len(tasks)} tasks to IDM.")
        sys.exit(0 if success_count == len(tasks) else 1)

    if not args.url:
        print("[Error] Either --url or --batch is required.", file=sys.stderr)
        sys.exit(1)

    ok = push_download(
        url=args.url,
        target_dir=args.dir,
        filename=args.filename,
        start_immediately=not args.queue,
        idm_path=explicit_idm,
    )

    if ok:
        print(f"[OK] Task successfully pushed to IDM:")
        print(f"  URL:      {args.url}")
        print(f"  Target:   {Path(args.dir).resolve()}")
        if args.filename:
            print(f"  Filename: {args.filename}")
        print(f"  Mode:     {'Queue only (/a)' if args.queue else 'Immediate download (/n)'}")
    else:
        print(f"[Fail] Could not push task to IDM.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
