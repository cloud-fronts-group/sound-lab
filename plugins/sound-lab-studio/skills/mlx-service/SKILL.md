---
name: mlx-service
description: Set up, start, check or stop the MLX audio inference service (mlx-audio server — Whisper/Parakeet speech-to-text, Kokoro & other TTS, source separation) that the sound-lab-media MCP server talks to — natively on Apple Silicon (Metal), in Docker/Podman (mlx[cpu]), in Apple's `container`, or an external URL.
argument-hint: "[status|start|stop|logs] [native|docker|podman|apple-container|external]"
---

# MLX audio service

Request: $ARGUMENTS

## Choose the mode
| Host | Mode | GPU | Setup |
|---|---|---|---|
| Apple Silicon Mac | `native` (default there) | ✅ Metal | `pip install "mlx-audio[server]"` (Python 3.10+, ffmpeg on PATH) |
| Linux server, or a Mac wanting isolation | `docker` / `podman` | ❌ CPU (`mlx[cpu]`) | image `…/sound-lab-mlx-audio:cpu` |
| Mac with macOS 26 | `apple-container` | ❌ CPU | Apple `container` CLI, `container system start` |
| Linux client with a Mac nearby | `external` + `mlx_url` | ✅ Metal on that Mac | run `mlx_audio.server --host 0.0.0.0` natively on the Mac |

MLX only uses a GPU natively on Apple Silicon (Metal). Containers, on Linux or on macOS, run it on the CPU.

## Steps
1. `mlx_service { action: "status" }`. If it's reachable, you're done.
2. `mlx_service { action: "plan" }` shows the exact command for the configured mode. Show it to the user before starting containers.
3. `mlx_service { action: "start" }` (optionally `mode`). The first start pulls the image or downloads models, which can take minutes.
4. Smoke test: `synthesize_speech { text: "Sound Lab test.", output: "/tmp/sl-test.wav" }` then `wait_job`. Or transcribe a short clip.
5. Troubleshooting: `mlx_service { action: "logs" }`.
   - `ModuleNotFoundError: uvicorn` → `pip install "mlx-audio[server]"`.
   - Port in use → change the `mlx_port` setting.
6. Building the images yourself (instead of pulling from GHCR):
   ```bash
   cd "${CLAUDE_PLUGIN_ROOT}/containers"
   docker compose --profile cpu  up -d mlx-audio-cpu      # build + run CPU image on :8000
   container build -t sound-lab-mlx-audio:cpu mlx-audio   # Apple container
   ```
Settings live in `/plugin` → Sound Lab Studio → configure (`mlx_mode`, `mlx_url`, `mlx_port`, `mlx_image`, `stt_model`, `tts_model`, `tts_voice`).
