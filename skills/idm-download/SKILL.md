---
name: idm-download
description: Automate file and model weight downloads using Internet Download Manager (IDM / IDMan.exe) on Windows. Use whenever the user asks to download large files, AI models, checkpoints, safetensors, datasets, or push URLs to IDM (e.g., '用IDM下载', '推送到IDM', '帮我下这个模型', '后台下载', '加入IDM队列'). Supports direct URLs, Hugging Face, ModelScope CDN, Civitai, target directory resolution for ComfyUI models, silent background downloading, and batch queues.
---

# IDM Download Automation (User Skill)

Automates pushing download tasks for large files, model weights (`.safetensors`, `.pth`, `.bin`), and datasets directly to **Internet Download Manager (`IDMan.exe`)** on Windows. This enables high-speed multi-threaded background downloading without blocking agent sessions or incurring fragile Python streaming timeouts.

---

## 1. Quick CLI Usage

A bundled, zero-dependency Python script is provided with this skill:
- **Script Path**: `scripts/idm_push.py` (resolve relative to this skill's directory)

### 1.1 Single Download (Immediate Start)
```bash
python "<skill_dir>/scripts/idm_push.py" \
  --url "https://modelscope.cn/api/v1/models/Comfy-Org/Qwen-Image-2.1_ComfyUI/repo?Revision=master&FilePath=split_files%2Fdiffusion_models%2Fqwen_image_2.1_int8_convrot.safetensors" \
  --dir "<target_dir>/models/diffusion_models" \
  --filename "qwen_image_2.1_int8_convrot.safetensors"
```

### 1.2 Queue Only (Download Later)
Use `--queue` (passes `/a` instead of `/n` to IDM):
```bash
python "<skill_dir>/scripts/idm_push.py" \
  --url "<DOWNLOAD_URL>" \
  --dir "<target_dir>" \
  --filename "model.safetensors" \
  --queue
```

### 1.3 Start Processing IDM Queue
```bash
python "<skill_dir>/scripts/idm_push.py" --start-queue
```

### 1.4 Batch Download
Supports text file (`<URL> <FILENAME>`) or JSON format:
```bash
python "<skill_dir>/scripts/idm_push.py" \
  --batch "tasks.json" \
  --dir "<target_dir>/models/text_encoders"
```

*Example `tasks.json`:*
```json
[
  {
    "url": "https://modelscope.cn/api/v1/models/Comfy-Org/Qwen-Image-2.1_ComfyUI/repo?Revision=master&FilePath=split_files%2Ftext_encoders%2Fqwen3vl_8b_w4a8.safetensors",
    "filename": "qwen3vl_8b_w4a8.safetensors"
  }
]
```

### 1.5 Locate IDM Executable or Custom Path
```bash
# Auto-detect IDMan.exe from standard paths, PATH, or Windows Registry
python "<skill_dir>/scripts/idm_push.py" --locate

# Or explicitly provide a path or set IDM_PATH environment variable
python "<skill_dir>/scripts/idm_push.py" --idm-path "C:\Program Files (x86)\Internet Download Manager\IDMan.exe" --locate
```

---

## 2. Direct IDMan.exe Invocation (Native Windows Command)

If invoking directly without Python, use the native executable:

- **Standard Path**: `C:\Program Files (x86)\Internet Download Manager\IDMan.exe` (or `C:\Program Files\Internet Download Manager\IDMan.exe`)

```cmd
"C:\Program Files (x86)\Internet Download Manager\IDMan.exe" /d "<URL>" /p "<TARGET_DIR>" /f "<FILENAME>" /n /q
```

### IDM Command-Line Switches Reference

| Switch | Purpose | Notes |
|---|---|---|
| `/d <URL>` | Download URL | Direct downloadable HTTP/HTTPS link |
| `/p <local_path>` | Save directory | Folder will be created if not present |
| `/f <filename>` | Local file name | Recommended to prevent hash-based or query-string filenames |
| `/n` | Start immediately | Silent start without popup dialog |
| `/a` | Add to queue | Appends to IDM queue without downloading immediately |
| `/q` | Quiet mode | Exits IDM background window when queue/download finishes |
| `/s` | Start queue | Begins downloading scheduled items in IDM queue |

---

## 3. ComfyUI Model Target Folder Mapping

When the user asks to download weights for ComfyUI, automatically route the target directory according to model category:

*ComfyUI Base Directory: `<comfyui_root>/models` (detect from project workspace or ask user if unknown)*

| Category | Typical File Types | Target Subdirectory |
|---|---|---|
| **Diffusion Models** | DiT, Flux, Qwen-Image, SD3, Hunyuan | `models\diffusion_models` |
| **Checkpoints** | SD 1.5, SDXL, Animagine (All-in-one) | `models\checkpoints` |
| **Text Encoders / CLIP** | Qwen-VL, T5, CLIP-L, ViT | `models\text_encoders` (or `models\clip`) |
| **VAE** | SDXL VAE, Flux VAE, Qwen VAE | `models\vae` |
| **LoRA** | Character / Style LoRAs | `models\loras` |
| **ControlNet** | OpenPose, Depth, Canny | `models\controlnet` |
| **Upscalers / SR** | RealESRGAN, HAT, DAT, 4x-UltraSharp | `models\upscale_models` |

---

## 4. URL Resolution & Mirror Guidelines

### 4.1 ModelScope (High-Speed Mirror in China)
For Hugging Face models, prefer ModelScope's direct CDN to maximize speed and bypass proxy bottlenecks:

- **Format**:
  `https://modelscope.cn/api/v1/models/{namespace}/{model_name}/repo?Revision=master&FilePath={urlencoded_path}`
- **Example**:
  `https://modelscope.cn/api/v1/models/Comfy-Org/Qwen-Image-2.1_ComfyUI/repo?Revision=master&FilePath=split_files%2Fvae%2Fqwen_image_2.1_vae_bf16.safetensors`

### 4.2 Hugging Face Direct Download
- **Format**:
  `https://huggingface.co/{namespace}/{model_name}/resolve/main/{file_path}`
- **Fast Mirror**:
  `https://hf-mirror.com/{namespace}/{model_name}/resolve/main/{file_path}`

### 4.3 Civitai Direct
- **Format**:
  `https://civitai.com/api/download/models/{version_id}?type=Model&format=SafeTensor`
  *(Append `&token={API_KEY}` if model requires authentication. Note: Never hardcode private API keys in tracked files; read them from environment variables or secure inputs)*

---

## 5. Python Programmatic Integration

In any project Python code or subagent script:

```python
import sys
from pathlib import Path

# Resolve path relative to skill location or caller directory
skill_scripts_dir = Path("<skill_dir>/scripts").resolve()
if str(skill_scripts_dir) not in sys.path:
    sys.path.insert(0, str(skill_scripts_dir))

from idm_push import push_download, start_idm_queue

# Push download
success = push_download(
    url="https://modelscope.cn/.../model.safetensors",
    target_dir=r"<target_dir>/models/diffusion_models",
    filename="model.safetensors",
    start_immediately=True,
)
```
