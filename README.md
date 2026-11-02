# Sound Lab — FFmpeg Audio Toolkit for VS Code

[**GitHub repository**](https://github.com/cloud-fronts-group/sound-lab) · [Report an issue](https://github.com/cloud-fronts-group/sound-lab/issues) · [Source & releases](https://github.com/cloud-fronts-group/sound-lab/releases)

Sampling, slicing, loudness, effects, spectrograms and speech-to-text, right inside VS Code. Everything runs on your own **FFmpeg** install, and every operation writes a *new* file, so your originals are never overwritten.

## Requirements

* **FFmpeg + ffprobe** 4.4 or newer on your `PATH`, or set `soundLab.ffmpegPath` / `soundLab.ffprobePath`.
  macOS: `brew install ffmpeg` · Windows: `winget install ffmpeg` · Linux: `apt install ffmpeg`
* For transcription you need **one** of these:
  * [whisper.cpp](https://github.com/ggml-org/whisper.cpp): `whisper-cli` plus a `ggml-*.bin` model. Local and offline.
  * Any **OpenAI-compatible** `/audio/transcriptions` endpoint: OpenAI, Groq, a local `faster-whisper-server`, LocalAI…
  * **FFmpeg 8+** built with `--enable-whisper`, which has a `whisper` audio filter.

The status bar shows the detected FFmpeg version. Click it to see which filters and encoders your build has.

## Features

### Audio editor
Opening any audio file (wav, mp3, flac, ogg, opus, m4a, aiff, wma, caf…) shows an interactive editor:

* A zoomable waveform. Drag to select, click to seek, scroll to zoom, Shift+scroll or Alt+drag to pan. Double-click a sound region to select it.
* Transport controls: play, loop selection, playback rate and volume.
* **Export selection** saves the selection as a new sample. The cut is sample-accurate, with tiny anti-click fades.
* A **Levels** panel: integrated LUFS, true peak, LRA, RMS, crest factor, DC offset, noise floor, and the gain needed to hit −14 / −23 LUFS.
* A **Spectrogram** panel with a log-frequency spectrogram. Click it to seek.
* **Find silence**: silent stretches are shaded on the waveform and the sound regions are listed. Click one to audition it.
* **Transcript**: timed lines with a search box. Click a line to play from there. Shift-click a line to select it as a sample, which is handy for chopping dialogue.
* Formats Chromium can't play (AAC, AIFF, WMA…) are transcoded behind the scenes to a cached FLAC preview.

Keyboard shortcuts: `Space` play/pause · `L` loop · `E` export · `Z` zoom to selection · `0` fit · `+`/`-` zoom · `←`/`→` seek 1 s (5 s with Shift) · `Esc` clear selection.

### Samples view
The **Sound Lab** activity bar view lists every audio file in the workspace, grouped by folder. Expand a file to see its duration, codec, sample rate, channels, bit depth and tags. Right-click a file for every action.

### Commands
The commands are in the Command Palette (`Sound Lab: …`), the explorer context menu and the Samples view.

| Command | What it does |
|---|---|
| Convert Format… | WAV / FLAC / AIFF (16, 24 or 32-bit float), MP3, Ogg, Opus, M4A, with a choice of sample rate and channels. Works on several files at once. |
| Batch Convert Folder… | Converts a whole tree into `converted_<fmt>/` and keeps the folder structure. |
| Trim / Cut Sample… | Sample-accurate cut with optional fades. |
| Normalize Loudness… | Two-pass EBU R128 `loudnorm` (−14 / −16 / −23 LUFS) or sample-peak normalization. |
| Slice into Equal Chunks… | Slice by **BPM + beats**, by seconds, or into N parts. Uses `asegment`, so the slices are sample-exact with no drift at fractional tempos. |
| Split on Silence… | Detects silence, then saves each hit or phrase as its own file. Good for drum hits, vocal phrases and one-shots. |
| Apply Effects / Filter Chain… | Chain any of: gain, reverse, speed, pitch shift, varispeed, fades, silence trim, HP/LP/EQ, FFT denoise, de-click, de-hum, compressor, limiter, echo, reverb, chorus, flanger, bitcrusher, mono, L/R swap, widen, loop, or your own `-af` string. |
| Concatenate Files… | Joins files, with an optional crossfade. |
| Extract Audio from Video… | Stream-copies the audio losslessly, or re-encodes it. |
| Render Waveform / Spectrogram Image | Writes a PNG. |
| Analyze Loudness & Levels | Opens a Markdown report that includes streaming-platform targets. |
| Show Media Info (ffprobe) | Shows streams, tags, chapters and the raw JSON. |
| Transcribe Audio… | Writes `.srt`, `.vtt`, `.txt` and `.json` next to the file. Long files are split into chunks for the API. |
| Add Subtitles to Video… | Muxes an SRT/VTT track into MP4 (`mov_text`) or MKV. It can transcribe the video first. |
| Record Sample from Microphone… | Uses avfoundation, dshow, pulse or alsa, with a device picker. Choose a fixed length or record until you press Cancel. |
| Generate Tone / Noise… | Sine, square, saw, triangle, white, pink or brown noise, a log sweep (for impulse responses), or silence. |
| FFmpeg Recipes… | More than 20 ready-made FFmpeg commands (ebur128, sidechain ducking, convolution reverb, channel split, waveform video, rubberband…). Each one is typed into a terminal for you to edit before running. |

Long jobs show a progress notification with a **Cancel** button. The exact FFmpeg command line is written to the **Sound Lab** output channel.

## Transcription setup

**whisper.cpp (local, the default)**
1. Build or install `whisper-cli`.
2. Download a model such as `ggml-base.en.bin` or `ggml-large-v3-turbo.bin`.
3. The first time you run **Transcribe**, Sound Lab asks for the model file and saves it to `soundLab.transcription.whisperCpp.model`.

**OpenAI-compatible API**
```jsonc
"soundLab.transcription.backend": "openai-compatible",
"soundLab.transcription.openai.baseUrl": "https://api.openai.com/v1",   // or https://api.groq.com/openai/v1, http://localhost:8000/v1 …
"soundLab.transcription.openai.model": "whisper-1"                      // or whisper-large-v3, Systran/faster-whisper-small …
```
Run **Sound Lab: Set Transcription API Key**. The key is kept in VS Code's secret storage, and `OPENAI_API_KEY` works as a fallback. Audio is sent as 16 kHz mono FLAC in 10-minute chunks, and the timestamps are stitched back together.

**FFmpeg 8 whisper filter**: set the backend to `ffmpeg-whisper` and choose a ggml model.

Other options: `language` (or `auto`), `translateToEnglish`, `prompt` (names and jargon), and `outputFormats`.

## Settings (highlights)

| Setting | Default | |
|---|---|---|
| `soundLab.output.directory` | *(next to source)* | Accepts `${fileDirname}`, `${workspaceFolder}`, `${fileBasenameNoExtension}` |
| `soundLab.defaults.format` / `bitDepth` / `sampleRate` | wav / 24 / keep | Defaults for new samples |
| `soundLab.normalize.targetLufs` / `truePeak` / `lra` | −14 / −1 / 11 | |
| `soundLab.silence.thresholdDb` / `minDuration` / `padding` | −40 / 0.35 / 0.03 | Used by Split on Silence and Find silence |
| `soundLab.record.inputFormat` / `device` | auto | e.g. `alsa` + `hw:1` |

## Development
```bash
npm install
npm test          # compiles, then runs 23 tests against your real ffmpeg (formats, effects, slicing accuracy, loudness, transcription backends with mocks…)
npm run test:ui   # 29 checks on the real editor webview in Chromium (dark + light) → test/ui/out/*.png  (needs Playwright)
npm run package   # → sound-lab-0.1.0.vsix
```
Press F5 in VS Code with this folder open to launch an Extension Development Host.

### Working on it with Claude Code
This repo is set up as a Claude Code project:

* **`CLAUDE.md`** covers the architecture, conventions and the FFmpeg gotchas learned so far.
* **`.claude/settings.json`** pre-approves the build, test and ffmpeg commands, and blocks `vsce publish` and force-pushes.
* **Post-edit hook** (`.claude/hooks/check-edit.js`): every time Claude edits `src/**/*.ts` or `package.json`, it recompiles and re-checks the manifest↔code wiring. It also syntax-checks `media/*.js` and stops `src/core/` from importing `vscode`. Problems are fed straight back to Claude.
* **Slash commands (skills):** `/add-command <idea>`, `/add-effect <effect>`, `/ffmpeg-explore <filter>`, `/verify`, `/release patch|minor|major`
* **Subagents:** `ffmpeg-expert` (filtergraphs, proven on generated signals), `transcription-engineer` (STT backends and subtitle formats), `extension-reviewer` (an independent review of a diff before it's called done).

Open the folder and run `claude`, then try e.g. `/add-effect tape-stop` or "use the ffmpeg-expert to add a de-esser".
