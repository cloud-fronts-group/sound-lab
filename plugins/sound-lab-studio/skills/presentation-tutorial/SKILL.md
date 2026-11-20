---
name: presentation-tutorial
description: Initialize an instructional presentation (clone voice first, gather topic/folder, run Deep Research, scaffold 5-10 min slides), overlay slides with cloned voice + embedded transcripts, or record a live screen/slide tutorial with simultaneous transcription.
---

# Creating & Recording Voice-Cloned Instructional Tutorials

Use this workflow whenever a user wants to scaffold an instructional presentation from a folder, clone their voice onto slides or a screen recording, or write live transcripts into video tutorials.

## 1. Initialize with Voice Clone First
- Confirm or build a voice reference pair (`ref_audio` WAV + exact `ref_text` transcript):
  - If the user has an audio recording of their voice, transcribe it with `transcribe` (`backend: "mlx-service"`) to get `ref_text`.
  - Verify `mlx_service` is running (`status` / `start`) and pick a cloning model (`mlx-community/chatterbox-turbo-4bit` for English, `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16` for multilingual).
  - Synthesize a short voice-check sample with `synthesize_speech` passing `ref_audio` and `ref_text`.

## 2. Ask Topic & Inspect Folder, Then Scaffold (5–10 Minutes)
- Collect `topic`, `folder_path`, `target_minutes` (clamped 5–10 min, default 7), and `audience`.
- If Sound Lab's Google ADK Python package (`adk/sound_lab_adk`) and `GEMINI_API_KEY` are configured, run `adk/.venv/bin/python -m sound_lab_adk.cli --action research-and-scaffold ...` to invoke `deep-research-preview-04-2026` first.
- Otherwise (or after generating `research_report`), call `scaffold_presentation` to scan the folder and generate `presentation.json`, `slides.md`, `slides.html`, `narration-script.txt`, and `research-report.md`.

## 3. Produce the Tutorial Video
- **Option A — Automated Slide Overlay (`overlay_presentation`)**:
  Pass `presentation_dir`, `ref_audio`, `ref_text`, and `model` to `overlay_presentation` + `wait_job`. Produces a `-16` LUFS cloned narration WAV, synchronized `.srt`/`.vtt`/`.txt`/`.json` transcript sidecars, 1280×720 PNG slide images, and a final MP4 with `h264`, default `aac` cloned audio, and `mov_text` subtitle track.
- **Option B — Live Screen / Slide Recording (`record_screen_plan`)**:
  Call `record_screen_plan` to generate the platform-appropriate (`avfoundation` / `gdigrab` / `x11grab`) dual-output `ffmpeg` command that captures screen + microphone while simultaneously segmenting rolling 16 kHz mono WAV chunks (`chunk_%04d.wav`). Process completed chunks via `transcribe` + `synthesize_speech` (`ref_audio`, `ref_text`) as they close, then mux cloned audio (default track), original audio (track 2), and `.srt` (`mov_text` subtitles) into the final MP4.
