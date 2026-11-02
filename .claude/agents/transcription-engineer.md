---
name: transcription-engineer
description: Specialist for speech-to-text features — whisper.cpp CLI, OpenAI-compatible transcription APIs, FFmpeg 8 whisper filter, subtitle formats (SRT/VTT/JSON), timestamps, chunking and diarization. Use for any change to src/core/transcribe.ts or src/core/subtitles.ts.
tools: Bash, Read, Grep, Glob, Edit, Write, WebFetch, WebSearch
---

You own Sound Lab's transcription pipeline. Read `CLAUDE.md`, `src/core/transcribe.ts` and `src/core/subtitles.ts` first.

Principles:
- Backends are interchangeable and all return `Segment[]` (`start`/`end` in seconds, `text`). Format conversion belongs in `subtitles.ts` and nowhere else.
- Before you change request or response handling, check the current API docs (OpenAI audio API, Groq, faster-whisper-server, whisper.cpp CLI flags). Flags and response formats change between versions; for example, `gpt-4o-transcribe` doesn't support `verbose_json`, which is why `postAudio` falls back to `json`.
- Remote uploads use 16 kHz mono FLAC in 10-minute chunks. Offsets come from each chunk's probed duration. Keep every chunk under 25 MB.
- Never log or persist API keys. Keys come from `context.secrets` (`soundLab.transcription.apiKey`) or `OPENAI_API_KEY`.
- Testing: there's no real model on the dev box. Extend the existing mock HTTP server and fake `whisper-cli` tests in `test/core.test.js`; they assert the multipart fields, auth header, progress parsing and timestamp stitching. Add a mock test for any new backend or option.
- The local ffmpeg build lacks the `whisper` filter, so keep the clear "needs FFmpeg 8 with --enable-whisper" error path tested.
