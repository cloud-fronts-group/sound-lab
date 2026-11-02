---
name: transcribe
description: Transcribe or translate audio/video files to SRT, VTT, TXT and JSON in the background with the sound-lab-media MCP server (MLX service, mlx-whisper, whisper.cpp, OpenAI-compatible API, or FFmpeg 8 whisper). Use for "transcribe this", captions, subtitles, meeting notes.
argument-hint: "<files|folder|glob> [language <code>] [translate] [model <id>] [formats srt,vtt,txt,json]"
---

# Transcribe

Request: $ARGUMENTS

1. `capabilities`: confirm a speech backend is available. If none is, offer one:
   - Apple Silicon: `mlx_service { action: "start", mode: "native" }` (needs `pip install "mlx-audio[server]"`), or `pip install mlx-whisper`.
   - Linux + NVIDIA: `mlx_service { action: "start", mode: "docker" }` with the `mlx_gpu: nvidia` setting (`:cuda12` image).
   - Anywhere: the `:cpu` container, whisper.cpp, or an API key.
2. Start the job:
   ```text
   transcribe { inputs: ["<path or glob>"], language: "auto", formats: ["srt","vtt","txt","json"], prompt: "<names, jargon>" }
   ```
   Add `translate: true` for English output (mlx, whisper.cpp, openai backends), or `model` to override the configured MLX model.
3. `wait_job`, then read the `.txt` to sanity-check. Look for repeated lines (hallucinations over silence) and misheard names, and re-run with a better `prompt` if needed.
4. For publishable subtitles, hand the `.srt` to the **subtitle-editor** agent (line length, reading speed, cue timing).
5. Report the files written, the detected language, the backend used and the segment count.
