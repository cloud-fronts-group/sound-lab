---
name: mlx-service
description: Set up, start, check or stop the MLX audio inference service (mlx-audio server — Whisper/Parakeet speech-to-text, Kokoro & other TTS, source separation) that the sound-lab-media MCP server talks to — natively on Apple Silicon (Metal), in Docker/Podman (mlx[cuda12] on NVIDIA or mlx[cpu]), in Apple's `container`, or an external URL.
argument-hint: "[status|start|stop|logs] [native|docker|podman|apple-container|external]"
---

# MLX audio service

Request: $ARGUMENTS

## Choose the mode
| Host | Mode | GPU | Setup |
|---|---|---|---|
| Apple Silicon Mac | `native` (default there) | ✅ Metal | Homebrew (recommended, next section) or `pip install "mlx-audio[server]"` (Python 3.10+, ffmpeg on PATH) |
| Linux + NVIDIA | `docker` / `podman` + setting `mlx_gpu: nvidia` | ✅ CUDA 12 (`mlx[cuda12]`) | NVIDIA driver ≥ 550 + NVIDIA Container Toolkit; image `…/sound-lab-mlx-audio:cuda12` |
| Any Linux / Mac (isolation) | `docker` / `podman` | ❌ CPU (`mlx[cpu]`) | image `…/sound-lab-mlx-audio:cpu` |
| Mac with macOS 26 | `apple-container` | ❌ CPU | Apple `container` CLI, `container system start` |
| Remote GPU box | `external` + `mlx_url` | wherever it runs | run the cuda12 image there |

Containers on macOS cannot reach Metal, so on a Mac the GPU path is `native`.

## Apple Silicon: install with Homebrew (recommended)
```bash
brew tap cloud-fronts-group/sound-lab https://github.com/cloud-fronts-group/sound-lab
brew install mlx-audio                 # mlx_audio.server (+ mlx_audio.tts.generate, mlx_audio.stt.generate, …) in $(brew --prefix)/bin
brew install mlx-audio-studio          # optional: prebuilt Studio web UI; launcher `mlx-audio-studio [-p 3000] [-H 127.0.0.1]`
brew services start mlx-audio          # optional: keep the API on 127.0.0.1:8000 (log: $(brew --prefix)/var/log/mlx-audio.log)
brew services start mlx-audio-studio   # optional: Studio on http://127.0.0.1:3000 (it is built for the API at http://localhost:8000)
```
- The formula is a self-contained Python virtualenv with `mlx` (Metal), `mlx-audio[server,stt,tts]` and `misaki[en]` (Kokoro). Nothing to activate, no conda.
- Native mode finds the server in this order: setting `mlx_server` (explicit path) → `mlx_audio.server` on PATH → `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` → `python3 -m mlx_audio.server`. So it works when Claude Code or VS Code has a minimal PATH, or an auto-activated conda env shadows the Homebrew binary. `capabilities` → `mlxService.server` shows what was found (`null` = python fallback); `mlx_service { action: "plan" }` shows the exact command.
- If `brew services` already runs the server on the configured `mlx_port`, `mlx_service` sees it as reachable and never starts a second one. Stop that one with `brew services stop mlx-audio` (`mlx_service stop` only stops servers Sound Lab started).

## Steps
1. `mlx_service { action: "status" }`. If it's reachable, you're done.
2. `mlx_service { action: "plan" }` shows the exact command for the configured mode. Show it to the user before starting containers.
3. `mlx_service { action: "start" }` (optionally `mode`). The first start pulls the image or downloads models, which can take minutes.
4. Smoke test: `synthesize_speech { text: "Sound Lab test.", output: "/tmp/sl-test.wav" }` then `wait_job`. Or transcribe a short clip.
5. Troubleshooting: `mlx_service { action: "logs" }`.
   - `… not found (native mode would run: …)` → install mlx-audio with Homebrew (above) or pip, or set `mlx_server` to the `mlx_audio.server` path.
   - `ModuleNotFoundError: uvicorn` → `pip install "mlx-audio[server]"`.
   - CUDA errors → check `nvidia-smi`, the driver version and `--gpus all`.
   - Port in use → change the `mlx_port` setting.
   - podman mode on macOS:
     - The podman machine must be running: `podman machine start` (`podman machine list` shows the state).
     - The CLI needs a default connection: `podman system connection default <machine>`. A stale SSH port shows up as "connection refused".
     - The `:cpu` image must be pullable: `ghcr.io/cloud-fronts-group/sound-lab-mlx-audio:cpu` is not public today, so build it (step 6) or set `mlx_image` to an image you can pull.
     - The VM's default 2 GiB of RAM is too small for speech models: `podman machine set --memory 8192`, then restart the machine.
     - Containers never see Metal, so MLX runs on the CPU there. On a Mac prefer `native`.
6. Building the images yourself (instead of pulling from GHCR):
   ```bash
   cd "${CLAUDE_PLUGIN_ROOT}/containers"
   docker compose --profile cuda build mlx-audio-cuda     # mlx[cuda12]
   docker compose --profile cpu  up -d mlx-audio-cpu      # build + run CPU image on :8000
   container build -t sound-lab-mlx-audio:cpu --build-arg MLX_EXTRA=cpu mlx-audio   # Apple container
   ```
Settings live in `/plugin` → Sound Lab Studio → configure (`mlx_mode`, `mlx_server`, `mlx_gpu`, `mlx_url`, `mlx_port`, `mlx_image`, `stt_model`, `tts_model`, `tts_voice`).
