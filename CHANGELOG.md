# Changelog

## Unreleased
- **mlx-audio integration**:
  - Lifecycle for the API server: native (Apple GPU), docker/podman (`mlx[cuda12]` or `mlx[cpu]`), Apple `container` or external, with a status bar item and quick actions.
  - MLX Audio sidebar panel (TTS with live voice lists, transcription, separation, models).
  - `mlx-audio` transcription backend.
  - mlx-audio Studio embedded in an editor tab (downloaded and started on demand, remote-friendly).
- **Voice clone**: guided recording of 5 prompted sentences with per-take quality checks, consent capture, reference building and transcription, and a cloned-voice preview. Then presentation re-narration (transcribe a talk and narrate in sync, adding a video track), audiobook production (chapters, ACX-style mastering, chapter markers), or vocals over an instrumental (beat-grid placement, tempo-synced echo, ducking, stem).
- Fix: audio editor loudness meters were blocked by the webview CSP (inline styles). The UI harnesses now run under the real CSP.
- Fix: MP4 track names are written to `handler_name` (MP4 drops `title`). This affected dub tracks in the plugin too.
- Claude Code plugin marketplace with the **sound-lab-studio** plugin: 14 skills (FFmpeg, loudness, Apple Silicon, Whisper, dubbing for music/video/streams, voice-over, SFX design and packs, batch convert, jobs, MLX service), 5 agents (whisper-transcriber, subtitle-editor, mp3-expert, mp4-expert, soundlab-agent), 3 safety hooks, and the `sound-lab-media` MCP server (background batch ffmpeg, transcription, MLX TTS/separation, docker/podman/Apple-container runners, MLX service lifecycle). Container images for ffmpeg, mlx-audio (`cpu` / `cuda12`) and whisper.cpp Vulkan.

## 0.1.0
- First release. Includes the audio editor (waveform, selection export, levels, spectrogram, silence regions, transcript), the Samples view, conversion and batch conversion, sample-accurate trim and slicing (BPM-aware), split on silence, two-pass loudness normalization, an effects chain, concatenation with crossfade, audio extraction from video, subtitle muxing, microphone recording, a tone/noise generator, FFmpeg recipes, and transcription via whisper.cpp, OpenAI-compatible APIs or the FFmpeg 8 whisper filter.
