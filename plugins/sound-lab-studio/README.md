# Sound Lab Studio — Claude Code plugin

Sound Lab Studio is a Claude Code plugin for audio and video work. It covers FFmpeg dubbing, sound design, Whisper/MLX speech, and MP3/MP4 expertise. It also includes an MCP server that runs long media jobs in the background, either on your Mac's GPU, in Docker/Podman/Apple containers, or against an MLX inference service (`mlx[cuda12]` on NVIDIA).

## Install
```text
/plugin marketplace add cloud-fronts-group/sound-lab
/plugin install sound-lab-studio@sound-lab
```
Then `/plugin` → **Sound Lab Studio** → *Configure* to set the runner, the MLX mode and the models. Every option has a sensible default.

**Requirements:**
- Node 18+ and `ffmpeg`/`ffprobe` on PATH (`brew install ffmpeg` · `apt install ffmpeg` · `winget install ffmpeg`).
- Optional, by feature:
  - Apple Silicon speech: `pip install "mlx-audio[server]"` (MLX service) or `pip install mlx-whisper`.
  - NVIDIA: Docker plus the NVIDIA Container Toolkit for the `:cuda12` image.
  - whisper.cpp with a ggml model.
  - `OPENAI_API_KEY` for an OpenAI-compatible speech API.

## What's inside
| Type | Name | What it does |
|---|---|---|
| Skill (auto) | `ffmpeg-fundamentals` | Correct ffmpeg argv, mapping, filtergraph escaping, accuracy, codec/container matrix, filter cheat-sheet |
| Skill (auto) | `loudness-mastering` | LUFS/true-peak targets per platform, two-pass loudnorm, mastering chains |
| Skill (auto) | `apple-silicon-media` | VideoToolbox/AudioToolbox, MLX, whisper.cpp Metal, and where the GPU really is (host vs Docker/Podman/Apple container) |
| Skill (auto) | `whisper-transcription` | Backends, models, prompts, subtitle conventions |
| Command | `/sound-lab-studio:dub-music` | Voice-over on a music bed with sidechain ducking, offsets, fades, loudness target |
| Command | `/sound-lab-studio:dub-video` | Add or replace a dubbed language track in MP4/MOV/MKV (video stream-copied), M&E via separation |
| Command | `/sound-lab-studio:dub-stream` | Dub a live music stream (HTTP/Icecast/HLS/file) with IDs/jingles/SFX, re-stream to RTMP/SRT/Icecast/HLS |
| Command | `/sound-lab-studio:voice-over` | Script → speech with MLX TTS (Kokoro…) |
| Command | `/sound-lab-studio:sfx-design` | 13 procedural SFX recipes + seeded variations, layering moves |
| Command | `/sound-lab-studio:sfx-pack` | Batch-clean and convert an SFX/sample folder for game engines |
| Command | `/sound-lab-studio:transcribe` | Background transcription to SRT/VTT/TXT/JSON |
| Command | `/sound-lab-studio:batch-convert` | Presets (MP3 V0/320/podcast, AAC/ALAC, Opus, Ogg, loudness, MP4 H.264/HEVC with VideoToolbox) |
| Command | `/sound-lab-studio:jobs` | List, follow, cancel or resume background jobs |
| Command | `/sound-lab-studio:mlx-service` | Start or stop the MLX audio service (native, docker, podman, apple-container, external) |
| Agent | `whisper-transcriber` | Picks the backend, runs jobs, QA for hallucinations, names and language |
| Agent | `subtitle-editor` | Line length, reading speed, cue timing, translation, mux/burn-in |
| Agent | `mp3-expert` | LAME modes, ID3/art/chapters, gapless, diagnostics |
| Agent | `mp4-expert` | faststart/fMP4/CMAF, hvc1 vs hev1, tracks and dispositions, HDR, VideoToolbox, HLS |
| Agent | `soundlab-agent` | Live "QWERTY keyboard" ambient performance that slowly builds from pulse to chorus; can render to audio |
| Hook | SessionStart | One line of environment facts (ffmpeg version, HW encoders, Apple Silicon, tools, unfinished jobs) |
| Hook | PreToolUse(Bash) | **Blocks ffmpeg commands that would overwrite their own input** |
| Hook | PostToolUse(Bash) | ffprobes every ffmpeg output. Flags missing, empty or unreadable files |
| MCP | `sound-lab-media` | Background jobs (below) |

### MCP server tools
`capabilities` · `list_presets` · `probe` · `batch_convert` · `run_ffmpeg` · `transcribe` · `synthesize_speech` · `separate_audio` · `mlx_service` · `job_status` · `wait_job` · `list_jobs` · `cancel_job` · `resume_job`

- The server has **zero npm dependencies**: Node with stdio JSON-RPC.
- Jobs run with per-job and global concurrency limits and report progress parsed from ffmpeg. They are saved under the plugin data directory. Work that was running when Claude Code quit is marked *interrupted* and can be resumed. Partial outputs are cleaned up, and pre-existing files are never touched.
- Outputs never overwrite inputs. The folder structure is preserved for batches.

### Runners & GPUs
| Setting | Where it runs | GPU |
|---|---|---|
| `runner: local` (default) | host ffmpeg | Apple VideoToolbox/AudioToolbox on Macs, NVENC etc. elsewhere |
| `runner: docker`/`podman` | `ghcr.io/cloud-fronts-group/sound-lab-ffmpeg` | CPU. `container_gpu: nvidia` or `dri` for passthrough |
| `mlx_mode: native` (default on Apple Silicon) | host `mlx_audio.server` | **Apple GPU (Metal)** |
| `mlx_mode: docker`/`podman` + `mlx_gpu: nvidia` | `…/sound-lab-mlx-audio:cuda12` (`pip install mlx[cuda12]`) | **NVIDIA CUDA 12** |
| `mlx_mode: docker`/`podman`/`apple-container` | `…/sound-lab-mlx-audio:cpu` (`mlx[cpu]`) | CPU |
| `mlx_mode: external` | any mlx-audio server at `mlx_url` | wherever it runs |

Docker Desktop and Apple's `container` run Linux VMs that **cannot reach Metal**, so MLX inside them on a Mac runs on the CPU. The fast path on a Mac is `native`. For GPU work inside a container on macOS, use Podman with a libkrun machine (Vulkan → Metal) and the `whisper-vulkan` image (`container_gpu: dri`).

## Containers
Sources are in [`containers/`](containers/). GitHub Actions publishes the ffmpeg and whisper-vulkan images to GHCR (`.github/workflows/containers.yml`). The MLX audio image isn't built in CI: build it locally with the `cpu` or `cuda` compose profile below.
```bash
cd containers
docker compose --profile cpu  up -d mlx-audio-cpu        # MLX audio service, CPU, :8000
docker compose --profile cuda up -d mlx-audio-cuda       # MLX audio service, mlx[cuda12], NVIDIA
docker compose --profile build build ffmpeg whisper-vulkan
```

## Scripts (used by the commands, also handy on their own)
```bash
node scripts/dub.js music  --music bed.mp3 --voice vo.wav --voice-at 2 --out mix.wav --run
node scripts/dub.js video  --video in.mp4 --voice es.wav --lang spa --out in_es.mp4 --run
node scripts/dub.js stream --input https://radio/stream --overlay id.wav@0 --every 900 --out rtmp://host/app/key --json
node scripts/sfx.js pack --out sfx --format ogg --variations 3
node scripts/keyboard-synth.js --keymap
```

## Development
```bash
npm test         # 23 tests: MCP protocol + jobs against real ffmpeg, MLX service lifecycle via mock server & fake docker/podman/container CLIs, hooks, dubbing, SFX, synth
npm run validate # claude plugin validate (plugin + marketplace)
SOUND_LAB_TEST_MLX_URL=http://127.0.0.1:8000 npm test            # also hit a real mlx-audio server
SOUND_LAB_TEST_CUDA_PYTHON=/venv-with-mlx-cuda12/bin/python npm test  # real mlx[cuda12] start-up check
```
