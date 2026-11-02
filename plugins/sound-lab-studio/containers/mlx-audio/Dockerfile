# Sound Lab — MLX audio inference service (mlx-audio's OpenAI-compatible server: STT, TTS, source separation).
#
#   MLX_EXTRA=cuda12  → `mlx[cuda12]`: NVIDIA GPU on Linux hosts (SM >= 7.5, driver >= 550, NVIDIA Container Toolkit)
#   MLX_EXTRA=cpu     → `mlx[cpu]`: any Linux host, and Docker / Podman / Apple `container` on macOS
#
# Containers on macOS run in a Linux VM and cannot reach Metal, so on a Mac this image is CPU-only.
# For Apple-GPU speed run the same server natively: `pip install "mlx-audio[server]" && mlx_audio.server`
# (the MCP server's mlx_service mode "native" does exactly that).
#
#   docker build --build-arg MLX_EXTRA=cuda12 -t sound-lab-mlx-audio:cuda12 .
#   docker run -d --gpus all -p 127.0.0.1:8000:8000 -v ~/.cache/huggingface:/root/.cache/huggingface sound-lab-mlx-audio:cuda12
# MLX on Linux needs glibc >= 2.35 and Python >= 3.10 (Debian bookworm: glibc 2.36).
FROM python:3.12-slim-bookworm

ARG MLX_EXTRA=cpu
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

# mlx-audio[server] pulls in packages that have to be compiled: webrtcvad (no wheels at all) and, on arm64
# (e.g. Docker on Apple Silicon), miniaudio, whose build probes `c++`. The compilers are installed for this
# layer only and removed afterwards.
# Note: the cuda12 wheels link against libcuda.so.1, which comes from the HOST driver at run time
# (NVIDIA Container Toolkit, `--gpus all`). `import mlx` therefore fails at build time on GPU-less builders,
# so only the CPU variant is import-checked here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ libc6-dev \
 && pip install "mlx[${MLX_EXTRA}]" "mlx-audio[server]==${MLX_AUDIO_VERSION}" \
 && apt-get purge -y --auto-remove g++ libc6-dev \
 && rm -rf /var/lib/apt/lists/* \
 && if [ "${MLX_EXTRA}" = "cpu" ]; then python -c "import mlx.core as mx; print('mlx', mx.__version__, mx.default_device())"; \
    else pip show mlx-cuda-12 >/dev/null && echo "mlx[${MLX_EXTRA}] installed (GPU check happens at run time)"; fi

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${MLX_AUDIO_PORT}/v1/models" >/dev/null || exit 1

# Shell form so the env vars expand; exec keeps PID 1 = the server for clean SIGTERM on `docker stop`.
CMD exec mlx_audio.server --host "$MLX_AUDIO_HOST" --port "$MLX_AUDIO_PORT"
