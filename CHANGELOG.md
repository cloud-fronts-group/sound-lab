# Changelog

## Unreleased
- **CI/CD**: GitHub Actions CI on every pull request (Linux + macOS, real ffmpeg, webview UI harness, plugin tests and validation), and a one-click Release workflow that versions the extension and plugin together and publishes the VSIX, plugin zip, Marketplace/Open VSX listing and versioned container images.
- **Sound Lab Studio** (the Studio tab, renamed): Create and DJ ribbons with tool drawers. mlx-audio Studio is embedded in the same tab.
  - Create: Instrumental (9 genres), Beats (7 styles), Chords (roman numerals or names, 8 instruments, 5 rhythms), Sound FX (15, tempo-sized), Auto-tune (YIN + scale snapping + PSOLA, retune speed and amount) and Layer (loop, offset, duck), all sharing one tempo, key and scale.
  - DJ: Backspin, Echo Out, Beat Jump, Double Drop, Quick Mix, Long Blend, Mashup, Acapella and Instrumental, on a detected beat grid (tempo, downbeats, drops, key with Camelot code). Two-track moves are tempo-matched.
  - Commands for every tool, a *Sound Lab DJ* explorer submenu, a DJ row in the audio editor that acts at the playhead, and *Detect Tempo & Key*.
  - Settings `soundLab.studio.outputDirectory` and `soundLab.dj.separation`.
- **mlx-audio integration**:
  - Lifecycle for the API server: native (Apple GPU), docker/podman (`mlx[cuda12]` or `mlx[cpu]`), Apple `container` or external, with a status bar item and quick actions.
  - MLX Audio sidebar panel (TTS with live voice lists, transcription, separation, models).
  - `mlx-audio` transcription backend.
  - mlx-audio Studio embedded in an editor tab (downloaded and started on demand, remote-friendly).
- **Homebrew (Apple Silicon)**: this repository is a Homebrew tap. `Formula/` holds `mlx-audio` (`mlx_audio.server` with Metal, works with `brew services`) and `mlx-audio-studio` (a prebuilt Studio with an `mlx-audio-studio` launcher): `brew tap cloud-fronts-group/sound-lab https://github.com/cloud-fronts-group/sound-lab`, then `brew install mlx-audio`.
  - Native mode finds `mlx_audio.server` on the `PATH`, then in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`, before falling back to `python -m mlx_audio.server`. The new setting `soundLab.mlx.server` (plugin: `mlx_server`) pins the binary, for example when a conda or venv shadows the Homebrew one.
  - mlx-audio Studio runs from the prebuilt Homebrew bundle (no `npm install`, no `next dev`) when the API URL baked into it matches Sound Lab's; otherwise the download-and-`next dev` path is used as before, and the log says why.
  - Plugin `mlx-service` skill: the Homebrew route for native mode, and podman troubleshooting on macOS (stopped machine, missing default connection, 2 GiB VM, no Metal).
- **Voice clone**: guided recording of 5 prompted sentences with per-take quality checks, consent capture, reference building and transcription, and a cloned-voice preview. Then presentation re-narration (transcribe a talk and narrate in sync, adding a video track), audiobook production (chapters, ACX-style mastering, chapter markers), or vocals over an instrumental (beat-grid placement, tempo-synced echo, ducking, stem).
- Fix: audio editor loudness meters were blocked by the webview CSP (inline styles). The UI harnesses now run under the real CSP.
- Fix: MP4 track names are written to `handler_name` (MP4 drops `title`). This affected dub tracks in the plugin too.
- Claude Code plugin marketplace with the **sound-lab-studio** plugin: 14 skills (FFmpeg, loudness, Apple Silicon, Whisper, dubbing for music/video/streams, voice-over, SFX design and packs, batch convert, jobs, MLX service), 5 agents (whisper-transcriber, subtitle-editor, mp3-expert, mp4-expert, soundlab-agent), 3 safety hooks, and the `sound-lab-media` MCP server (background batch ffmpeg, transcription, MLX TTS/separation, docker/podman/Apple-container runners, MLX service lifecycle). Container images for ffmpeg, mlx-audio (`cpu` / `cuda12`) and whisper.cpp Vulkan.

## 0.1.0
- First release. Includes the audio editor (waveform, selection export, levels, spectrogram, silence regions, transcript), the Samples view, conversion and batch conversion, sample-accurate trim and slicing (BPM-aware), split on silence, two-pass loudness normalization, an effects chain, concatenation with crossfade, audio extraction from video, subtitle muxing, microphone recording, a tone/noise generator, FFmpeg recipes, and transcription via whisper.cpp, OpenAI-compatible APIs or the FFmpeg 8 whisper filter.
