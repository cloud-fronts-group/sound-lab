---
name: whisper-transcription
description: Speech-to-text with Whisper-family models via MLX (Apple GPU natively, or CPU containers), whisper.cpp, OpenAI-compatible APIs or FFmpeg 8 — model choice, language/translation, prompts, chunking, subtitle formats and quality rules. Use for transcription, captions, subtitles or translation of audio/video.
---

# Whisper transcription

## Pick a backend (the MCP `transcribe` tool does this with `backend: auto`)
1. **mlx-service**: the mlx-audio server. Native on macOS (Metal), or a CPU Docker/Podman/Apple container (`mlx[cpu]`). It starts automatically when `autostart` is on.
2. **mlx**: the `mlx_whisper` CLI on Apple Silicon.
3. **whisper.cpp**: `whisper-cli` with a ggml model (Metal on macOS, CUDA/Vulkan/CPU elsewhere). It can also run in the `whisper-vulkan` container.
4. **openai**: any OpenAI-compatible `/audio/transcriptions` endpoint (`OPENAI_API_KEY`). Files are uploaded as 16 kHz mono FLAC in 10-minute chunks.
5. **ffmpeg**: FFmpeg 8+ `whisper` filter.

```text
transcribe { inputs: ["~/Interviews/*.m4a"], language: "en", formats: ["srt","vtt","txt","json"], prompt: "Names: Anaïs, Kwame, Sound Lab" }
wait_job   { job_id: "transcribe-…" }
```

## Models (MLX ids on Hugging Face)
| Model | Speed | Use |
|---|---|---|
| `mlx-community/whisper-large-v3-turbo` | fast, near large-v3 accuracy | default for everything |
| `mlx-community/whisper-large-v3-mlx` | slowest, most accurate | hard audio, rare languages |
| `mlx-community/whisper-small-mlx` / `-base-mlx` / `-tiny` | very fast | drafts, CPU containers |
| `mlx-community/distil-whisper-large-v3` | fast | English only |
| `mlx-community/parakeet-tdt-0.6b-v2` | very fast | English, strong punctuation |
On CPU-only containers, start with `whisper-small` or `base`. Large models are slow without a GPU.

## Quality levers
- **Prompt** with names, jargon and spelling (`prompt`). It biases the decoder, which helps a lot with proper nouns.
- Set **language** explicitly when known. Auto-detect can latch onto the wrong language for a quiet intro.
- Pre-clean noisy audio with `highpass=f=80,afftdn=nr=10,loudnorm`. Music under speech: separate first (`separate_audio`, description "speech").
- Whisper can hallucinate on long silences (repeated lines). Trim silence or split on silence first, then spot-check segments that are suspiciously repetitive.
- Whisper does **not** identify speakers. For diarisation use a dedicated tool (pyannote / WhisperX) and merge the timestamps.

## Subtitle conventions (fix with the subtitle-editor agent)
- At most 42 characters per line and 2 lines per cue. Duration 1–7 s. At most 17 characters per second for adults (13 for kids). Gaps between cues of at least 2 frames.
- Break lines at punctuation or after conjunctions, never between an article and its noun.
- SRT uses `00:00:01,000`, VTT uses `00:00:01.000` with a `WEBVTT` header.

## Deliver
- Sidecar files go next to the media (`name.srt`, `name.vtt`). Mux them into MP4 as `mov_text` (`-c:s mov_text -metadata:s:s:0 language=eng`) or MKV as `srt`.
- Burn-in (open captions): `-vf subtitles=name.srt:force_style='FontSize=22,Outline=2'` (re-encodes the video).
