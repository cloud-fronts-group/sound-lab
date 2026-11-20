"""Authoritative catalog of mlx-audio containers, runtime modes, endpoints, and models."""

from __future__ import annotations

CONTAINER_SPEC = {
    "name": "soundlab-mlx-audio",
    "container_port": 8000,
    "dockerfile": "plugins/sound-lab-studio/containers/mlx-audio/Dockerfile",
    "compose_file": "plugins/sound-lab-studio/containers/compose.yaml",
    "base_image": "python:3.12-slim-bookworm",
    "mlx_audio_version": "0.6.3",
    "images": {
        "cpu": "ghcr.io/cloud-fronts-group/sound-lab-mlx-audio:cpu",
        "cuda12": "ghcr.io/cloud-fronts-group/sound-lab-mlx-audio:cuda12",
    },
    "volumes": {
        "huggingface_cache": "/root/.cache/huggingface",
        "voices_readonly": "/soundlab/voices",
    },
    "modes": {
        "native": {
            "gpu": "Apple Silicon Metal (fastest on macOS)",
            "entrypoint": "mlx_audio.server --host 127.0.0.1 --port <port>",
            "install": "brew tap cloud-fronts-group/sound-lab https://github.com/cloud-fronts-group/sound-lab && brew install mlx-audio",
        },
        "docker": {
            "gpu_nvidia": "Linux + NVIDIA (--gpus all) using :cuda12 image (mlx[cuda12])",
            "gpu_none": "CPU-only (:cpu image). Note: Docker Desktop on macOS runs a Linux VM with NO Metal access.",
        },
        "podman": {
            "gpu_nvidia": "Linux + NVIDIA (--device nvidia.com/gpu=all) using :cuda12 image",
            "macos_notes": "Set podman machine memory >= 8192 MiB and set default connection. Containers on macOS have no Metal for MLX.",
        },
        "apple-container": {
            "gpu": "CPU-only Linux micro-VM on macOS 26 (no Metal passthrough); uses VM IP from `container inspect` if localhost forwarding is absent.",
        },
        "external": {
            "gpu": "Depends on remote host (e.g. Linux GPU server running :cuda12).",
        },
    },
    "endpoints": {
        "GET /v1/models": "List loaded models.",
        "POST /v1/models?model_name=<id>": "Download and load a Hugging Face mlx-community model.",
        "DELETE /v1/models?model_name=<id>": "Unload a model from memory.",
        "GET /v1/audio/voices?model=<id>": "List built-in speaker voices (e.g. Kokoro).",
        "POST /v1/audio/speech": "JSON TTS synthesis; pass `ref_audio` (server filesystem path!) and `ref_text` (reference transcript) for zero-shot voice cloning.",
        "POST /v1/audio/transcriptions": "Multipart STT upload (`response_format=verbose_json` returns `text`, `language`, `segments`).",
        "POST /v1/audio/separations": "Multipart source separation (`description`, returns base64 `target` and `residual`).",
    },
    "critical_gotchas": [
        "mlx-audio reads `ref_audio` from the SERVER filesystem (not file upload). In container modes, voice profiles MUST live in `voices_dir` mounted read-only at `/soundlab/voices` and mapped to `/soundlab/voices/<id>/reference.wav`.",
        "Always supply accurate `ref_text` alongside `ref_audio` so zero-shot cloning models align prosody cleanly without hallucinating words or leaking accents.",
        "Containers on macOS (Docker, Podman, Apple container) cannot access Metal; use `native` mode on Apple Silicon for Metal acceleration.",
        "The `:cuda12` image links against host `libcuda.so.1` via NVIDIA Container Toolkit; it fails on CPU-only hosts.",
    ],
}

MODELS_CATALOG = {
    "voice_cloning_tts": [
        {
            "id": "mlx-community/chatterbox-turbo-4bit",
            "label": "Chatterbox Turbo (4-bit)",
            "notes": "Default Sound Lab cloning model; fast, expressive English zero-shot cloning.",
            "supports_ref_audio": True,
            "requires_ref_text": True,
        },
        {
            "id": "mlx-community/chatterbox-multilingual-v3",
            "label": "Chatterbox Multilingual v3",
            "notes": "Zero-shot voice cloning across 20+ languages.",
            "supports_ref_audio": True,
            "requires_ref_text": True,
        },
        {
            "id": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
            "label": "Qwen3-TTS 1.7B Base (8-bit)",
            "notes": "High-fidelity multilingual cloning; benefits from 16+ GB unified memory / VRAM.",
            "supports_ref_audio": True,
            "requires_ref_text": True,
        },
        {
            "id": "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit",
            "label": "Qwen3-TTS 0.6B Base (8-bit)",
            "notes": "Lighter Qwen3-TTS base cloning model for faster generation.",
            "supports_ref_audio": True,
            "requires_ref_text": True,
        },
        {
            "id": "mlx-community/csm-1b-8bit",
            "label": "Sesame CSM 1B (8-bit)",
            "notes": "Conversational Speech Model for natural instructional pacing.",
            "supports_ref_audio": True,
            "requires_ref_text": True,
        },
        {
            "id": "mlx-community/Spark-TTS-0.5B-bf16",
            "label": "Spark-TTS 0.5B",
            "notes": "Compact cloning-capable model.",
            "supports_ref_audio": True,
            "requires_ref_text": True,
        },
        {
            "id": "mlx-community/Llama-OuteTTS-1.0-1B-4bit",
            "label": "OuteTTS 1.0 1B (4-bit)",
            "notes": "Multilingual cloning-capable model.",
            "supports_ref_audio": True,
            "requires_ref_text": True,
        },
    ],
    "standard_tts": [
        {
            "id": "mlx-community/Kokoro-82M-bf16",
            "label": "Kokoro 82M",
            "notes": "Fast preset voices (af_heart, af_bella, am_adam, bf_emma, bm_george); not a zero-shot clone model.",
            "supports_ref_audio": False,
        },
    ],
    "speech_to_text": [
        {"id": "mlx-community/whisper-large-v3-turbo", "label": "Whisper Large v3 Turbo", "notes": "Default high-accuracy STT for reference & tutorial transcription."},
        {"id": "mlx-community/whisper-small-mlx", "label": "Whisper Small", "notes": "Fast CPU/container fallback STT."},
        {"id": "mlx-community/whisper-tiny", "label": "Whisper Tiny", "notes": "Ultra-fast lightweight STT for CPU containers & quick tests."},
        {"id": "mlx-community/parakeet-tdt-0.6b-v2", "label": "Parakeet TDT 0.6B v2", "notes": "Fast English ASR with crisp punctuation & timestamps."},
        {"id": "mlx-community/distil-whisper-large-v3", "label": "Distil-Whisper Large v3", "notes": "Distilled English Whisper."},
    ],
    "separation": [
        {"id": "mlx-community/sam-audio-large-fp16", "label": "SAM-Audio Large", "notes": "Prompted source separation (e.g. description='speech' or 'vocals')."},
    ],
}
