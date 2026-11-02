# Changelog

## Unreleased
- Claude Code plugin marketplace with the **sound-lab-studio** plugin: 14 skills (FFmpeg, loudness, Apple Silicon, Whisper, dubbing for music/video/streams, voice-over, SFX design and packs, batch convert, jobs, MLX service), 5 agents (whisper-transcriber, subtitle-editor, mp3-expert, mp4-expert, soundlab-agent), 3 safety hooks, and the `sound-lab-media` MCP server (background batch ffmpeg, transcription, MLX TTS/separation, docker/podman/Apple-container runners, MLX service lifecycle). Container images for ffmpeg, mlx-audio (`cpu` / `cuda12`) and whisper.cpp Vulkan.

## 0.1.0
- First release. Includes the audio editor (waveform, selection export, levels, spectrogram, silence regions, transcript), the Samples view, conversion and batch conversion, sample-accurate trim and slicing (BPM-aware), split on silence, two-pass loudness normalization, an effects chain, concatenation with crossfade, audio extraction from video, subtitle muxing, microphone recording, a tone/noise generator, FFmpeg recipes, and transcription via whisper.cpp, OpenAI-compatible APIs or the FFmpeg 8 whisper filter.
