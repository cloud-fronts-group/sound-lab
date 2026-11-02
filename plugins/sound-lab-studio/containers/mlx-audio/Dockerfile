# Sound Lab — MLX audio inference service (mlx-audio's OpenAI-compatible server: STT, TTS, source separation).
#
# CPU-only image (`mlx[cpu]`) for Linux servers, and for Docker / Podman / Apple `container` on macOS.
# Containers on macOS run in a Linux VM and cannot reach Metal. For Apple-GPU speed run the same server
# natively: `pip install "mlx-audio[server]" && mlx_audio.server` (the MCP server's mlx_service mode "native").
#
#   docker build -t sound-lab-mlx-audio:cpu .
#   docker run -d -p 127.0.0.1:8000:8000 -v ~/.cache/huggingface:/root/.cache/huggingface sound-lab-mlx-audio:cpu
# MLX on Linux needs glibc >= 2.35 and Python >= 3.10 (Debian bookworm: glibc 2.36).
FROM python:3.12-slim-bookworm

ARG MLX_AUDIO_VERSION=0.6.3

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/root/.cache/huggingface \
    MLX_AUDIO_HOST=0.0.0.0 \
    MLX_AUDIO_PORT=8000

# ffmpeg: mlx-audio decodes uploads with it. espeak-ng: phonemizer fallback for Kokoro's non-English voices.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg espeak-ng libsndfile1 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# mlx-audio[server] pulls in webrtcvad, which ships no wheels and has to be compiled, so gcc is installed
# for this layer only and removed again afterwards.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev \
 && pip install "mlx[cpu]" "mlx-audio[server]==${MLX_AUDIO_VERSION}" \
 && apt-get purge -y --auto-remove gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/* \
 && python -c "import mlx.core as mx, mlx_audio; print('mlx', mx.__version__, mx.default_device())"

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${MLX_AUDIO_PORT}/v1/models" >/dev/null || exit 1

# Shell form so the env vars expand; exec keeps PID 1 = the server for clean SIGTERM on `docker stop`.
CMD exec mlx_audio.server --host "$MLX_AUDIO_HOST" --port "$MLX_AUDIO_PORT"
