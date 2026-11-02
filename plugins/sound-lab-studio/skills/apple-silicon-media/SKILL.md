---
name: apple-silicon-media
description: Use the Apple GPU / media engines for audio-video work on Apple Silicon Macs — VideoToolbox encode/decode, AudioToolbox AAC, MLX speech models (mlx-audio, mlx-whisper), whisper.cpp Metal — and the truth about GPUs inside Docker, Podman and Apple's `container` on macOS. Use when choosing encoders, speech backends, or where (host vs container) a media job should run.
---

# Apple Silicon media acceleration

## Where the GPU actually is
| Runs… | Apple GPU / media engine? | Use for |
|---|---|---|
| **Host** (native ffmpeg, Python, whisper.cpp) | ✅ VideoToolbox, AudioToolbox, Metal, MLX | Anything that needs speed on a Mac |
| **Docker Desktop** container | ❌ Linux VM with no Metal | Reproducible CPU jobs, Linux parity |
| **Apple `container`** (macOS 26) | ❌ Linux micro-VM, CPU only | Lightweight CPU containers |
| **Podman + libkrun** machine | ⚠️ Vulkan only (Venus → MoltenVK → Metal) as `/dev/dri` | whisper.cpp / llama.cpp Vulkan builds. **Not** MLX, not VideoToolbox |
| **Linux + NVIDIA** container | ✅ CUDA (`--gpus all`) | `mlx[cuda12]` MLX service, NVENC |

MLX uses Metal on macOS. On Linux it installs as `mlx[cpu]` or `mlx[cuda12]`, which is why the Sound Lab MLX image comes in `:cpu` and `:cuda12` tags. A Mac gets MLX GPU speed only from a **native** MLX process.

## VideoToolbox / AudioToolbox in ffmpeg
```bash
ffmpeg -hide_banner -encoders | grep -E "videotoolbox|_at "      # h264_videotoolbox hevc_videotoolbox prores_videotoolbox aac_at …
ffmpeg -hwaccel videotoolbox -i in.mov -c:v hevc_videotoolbox -b:v 8M -tag:v hvc1 -c:a aac_at -b:a 192k -movflags +faststart out.mp4
ffmpeg -i in.mov -c:v h264_videotoolbox -q:v 60 out.mp4         # constant-quality mode (Apple Silicon, recent ffmpeg)
ffmpeg -i in.mov -c:v prores_videotoolbox -profile:v 3 out.mov   # ProRes 422 HQ on M1 Pro/Max and later
```
- VideoToolbox has no CRF. Use `-b:v` (the MCP presets size it from resolution × fps) or `-q:v` (1–100) where supported.
- Use `-tag:v hvc1` for HEVC that QuickTime/iOS will play. Keep `-pix_fmt yuv420p` for broad compatibility.
- `aac_at` (AudioToolbox) sounds better than ffmpeg's native `aac` at the same bitrate. The MCP presets choose it automatically on macOS.

## Speech on the Apple GPU
| Option | Install | Notes |
|---|---|---|
| **MLX audio service** (recommended) | `pip install "mlx-audio[server]"` → `mlx_audio.server --port 8000` | STT (Whisper, Parakeet…), TTS (Kokoro…), source separation over an OpenAI-style API. The MCP `mlx_service` tool starts it (`mode: native`) |
| mlx-whisper CLI | `pip install mlx-whisper` | `mlx_whisper in.m4a --model mlx-community/whisper-large-v3-turbo --output-format srt` |
| whisper.cpp | `brew install whisper-cpp` | Metal is on by default on macOS. Download a ggml model |

The MCP `transcribe` tool with `backend: auto` uses the MLX service when it can reach it, then mlx-whisper, then whisper.cpp.

## Containers on a Mac: which to pick
- Want **GPU speech** on the Mac → native MLX service (`mlx_mode: native`).
- Want **isolation** and can accept CPU speed → `mlx_mode: docker` or `apple-container` with the `:cpu` image.
- Want **GPU inside a container** on the Mac → Podman machine with `--provider libkrun`, then the `whisper-vulkan` image with `container_gpu: dri` (whisper.cpp only).
- Have an **NVIDIA box** → run the `:cuda12` MLX image there and point `mlx_url` at it (`mlx_mode: external`).

## Check the machine first
Call the MCP `capabilities` tool. It reports VideoToolbox/AudioToolbox, container runtimes (including the podman provider and Apple `container`), the MLX service state, and recommendations.
