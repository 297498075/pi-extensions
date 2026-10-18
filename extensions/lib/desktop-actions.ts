import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, win32 } from "node:path";

export interface DesktopCommand {
	command: string;
	args: string[];
	input?: string;
	env?: NodeJS.ProcessEnv;
}

export type DesktopResult = { ok: true } | { ok: false; error: string };

/** All executable names/scripts are fixed; user text is only stdin, an argv item, or an env value. */
export function clipboardCommand(text: string, platform: NodeJS.Platform = process.platform): DesktopCommand {
	if (platform === "win32") {
		const root = process.env.SystemRoot || process.env.WINDIR;
		return { command: root ? win32.join(root, "System32", "clip.exe") : "clip.exe", args: [], input: text };
	}
	if (platform === "darwin") return { command: "pbcopy", args: [], input: text };
	return { command: "xclip", args: ["-selection", "clipboard"], input: text };
}

const OPEN_FILE_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"$info = New-Object System.Diagnostics.ProcessStartInfo",
	"$info.FileName = [Environment]::GetEnvironmentVariable('PI_EXTENSIONS_OPEN_PATH')",
	"$info.UseShellExecute = $true",
	"[System.Diagnostics.Process]::Start($info) | Out-Null",
].join("; ");

export function openFileCommand(filePath: string, platform: NodeJS.Platform = process.platform): DesktopCommand {
	if (platform === "win32") {
		// ShellExecute opens an OS file association, not a cmd/PowerShell command
		// string. The fixed script never interpolates the path, even for &, %, ', etc.
		const root = process.env.SystemRoot || process.env.WINDIR;
		return {
			command: root ? win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe",
			args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(OPEN_FILE_SCRIPT, "utf16le").toString("base64")],
			env: { ...process.env, PI_EXTENSIONS_OPEN_PATH: filePath },
		};
	}
	return { command: platform === "darwin" ? "open" : "xdg-open", args: [filePath] };
}

/** Resolve every process failure, including async spawn and stdin errors; never throw into the TUI. */
export function runDesktopCommand(spec: DesktopCommand, signal?: AbortSignal, timeoutMs = 5000): Promise<DesktopResult> {
	return new Promise(resolve => {
		if (signal?.aborted) { resolve({ ok: false, error: "操作已取消" }); return; }
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let child: ReturnType<typeof spawn> | undefined;
		let stderr = "";
		const stop = () => {
			try { child?.kill(); } catch { /* process may already be gone */ }
		};
		const finish = (result: DesktopResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const fail = (error: unknown) => {
			if (settled) return;
			finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
			stop();
		};
		const onAbort = () => { if (settled) return; finish({ ok: false, error: "操作已取消" }); stop(); };
		try {
			child = spawn(spec.command, spec.args, {
				shell: false,
				windowsHide: true,
				stdio: ["pipe", "ignore", "pipe"],
				...(spec.env ? { env: spec.env } : {}),
			});
			child.on("error", fail);
			child.stdin?.on("error", fail);
			child.stderr?.on("error", fail);
			child.stderr?.on("data", chunk => { if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length); });
			child.once("close", (code, reason) => {
				finish(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `${spec.command} 退出失败 (${reason || code})` });
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) { onAbort(); return; }
			timer = setTimeout(() => { finish({ ok: false, error: `${spec.command} 等待超时` }); stop(); }, timeoutMs);
			timer.unref?.();
			child.stdin?.end(spec.input ?? "", "utf8");
		} catch (error) { fail(error); }
	});
}

export function copyToClipboard(text: string, signal?: AbortSignal): Promise<DesktopResult> {
	return runDesktopCommand(clipboardCommand(text), signal);
}

export function openLocalFile(filePath: string, signal?: AbortSignal): Promise<DesktopResult> {
	if (!isAbsolute(filePath) || !existsSync(filePath)) {
		return Promise.resolve({ ok: false, error: "只能打开存在的本地绝对路径" });
	}
	return runDesktopCommand(openFileCommand(filePath), signal);
}
