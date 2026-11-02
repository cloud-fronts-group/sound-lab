# Sound Lab — FFmpeg Audio Toolkit for VS Code

[**GitHub repository**](https://github.com/cloud-fronts-group/sound-lab) · [Report an issue](https://github.com/cloud-fronts-group/sound-lab/issues) · [Source & releases](https://github.com/cloud-fronts-group/sound-lab/releases)
> **Also a Claude Code plugin marketplace.** Install the Sound Lab Studio plugin (FFmpeg dubbing, SFX, Whisper/MLX speech, MP3/MP4 experts, background media MCP server):
> ```text
> /plugin marketplace add cloud-fronts-group/sound-lab
> /plugin install sound-lab-studio@sound-lab
> ```
> See [plugins/sound-lab-studio](plugins/sound-lab-studio/README.md).

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

### mlx-audio: local speech AI inside VS Code
Sound Lab connects to the **[mlx-audio](https://github.com/Blaizzy/mlx-audio) API server** (`mlx_audio.server`) and can start and stop it for you:

| `soundLab.mlx.mode` | Runs | GPU |
|---|---|---|
| `auto` → `native` on Apple Silicon | `python -m mlx_audio.server` on your Mac (`pip install "mlx-audio[server]"`) | **Apple GPU (Metal)** |
| `docker` / `podman` + `soundLab.mlx.gpu: nvidia` | `ghcr.io/cloud-fronts-group/sound-lab-mlx-audio:cuda12` (`pip install mlx[cuda12]`) | **NVIDIA CUDA 12** |
| `docker` / `podman` / `apple-container` | `…:cpu` image (`mlx[cpu]`) | CPU (containers on macOS cannot reach Metal) |
| `external` | any server at `soundLab.mlx.url` | wherever it runs |

- **Status bar** (`MLX · n`): server state and loaded models. Click it for start/stop, Studio, models, voice clone and the log.
- **MLX Audio panel** (Sound Lab sidebar):
  - text-to-speech with voices listed live from the server (Kokoro, Chatterbox, Qwen3-TTS, CSM, Spark…), with inline playback and the result saved to `voice-overs/`;
  - transcription and source separation;
  - your cloned voices.
- **mlx-audio Studio, embedded**: *Sound Lab: Open mlx-audio Studio* opens the mlx-audio web UI in an editor tab, with its pages for text to speech, speech to text and separation.
  - Studio isn't in the pip wheel, so Sound Lab finds it in an editable install, or downloads `mlx_audio/ui` from GitHub.
  - It runs `next dev` pointed at the managed API server.
  - It works over Remote-SSH and Codespaces through VS Code port forwarding.
- **Transcription backend `mlx-audio`**: MLX Whisper or Parakeet through the same server, including the audio editor's Transcript panel.
- **Models**: load or unload them from a quick pick, or from the editor context menu (*Text to Speech* on a selection).

### Voice clone
**Voice clone** (sidebar, audio editor, Studio toolbar, or the command palette) walks you through four steps:
1. **Set up**: name the voice, choose what you'll make, pick a cloning model (default `mlx-community/chatterbox-turbo-4bit`) and a microphone, and confirm the consent statement. It's stored with the voice.
2. **Read aloud**: five sentences, four phonetically balanced Harvard sentences plus one in the style of your project. Each take is recorded through ffmpeg and checked for clipping, low level, length and speech. You can retake any of them.
3. **Your voice**: the takes are trimmed, denoised and loudness-matched into a 24 kHz reference. The reference is transcribed so the cloning model knows the words, and you hear a preview in your cloned voice.
4. **Create**, in one of three modes:
   - **Presentation**: transcribe a recorded talk (audio or video) and re-narrate every line in sync, pushing a line later if it would overlap. Videos get a new default narration track, and you also get an SRT. A script file or the active editor works too.
   - **Audiobook**: chapters come from headings, "Chapter …" lines or `---`. You get one MP3 per chapter at 44.1 kHz / 192 kb/s with peaks ≤ −3 dB and room tone (ACX-style), plus the full book with chapter markers.
   - **Vocals over an instrumental**: lines placed with `@bar` or `[m:ss]` on the beat grid, with de-ess, compression, tempo-synced echo and an optional double. The instrumental is gently ducked underneath, and you get the mix plus a vocal stem.

Voices live in VS Code's extension storage, and Sound Lab mounts them read-only into container modes, because mlx-audio reads `ref_audio` from the server's own disk. Only clone your own voice, or a voice you have explicit permission to use.

### Sound Lab Studio: create and DJ
**Open Sound Lab Studio** (command palette, the audio editor's title bar, or the MLX Audio sidebar's *Studio* button) opens an editor tab with two ribbons of icon tools. Each tool opens a drawer beside the page. You get a result you can play, open, reveal or chain into the next tool. mlx-audio Studio runs in the same tab when it's started.

**Create.** Tempo, key and scale are shared, so everything you make lines up:
- **Instrumental**: drums, voice-led chords, bass and a lead in 9 genres: lo-fi, pop, house, trap, R&B/neo-soul, drum & bass, reggaeton, ambient and cinematic. You choose a seamless loop or a song with an intro and a ring-out. Use a preset progression or type your own (`Am F C G`, `ii7 V7 Imaj7`).
- **Beats**: 7 styles (house, boom bap, trap with hi-hat rolls, lo-fi, rock, drum & bass, reggaeton) with swing, fills and humanized timing. Loops are sample-exact and wrap their reverb tails, so they tile without a click.
- **Chords**: roman numerals or chord names on a pad, electric piano, keys, Karplus-Strong pluck, FM bell, organ, strings or lead. Rhythms are sustained, strummed, off-beat stabs, 8th pulse or 16th arpeggio.
- **Sound FX**: riser, downlifter, whoosh, impact, sub drop, air horn, vinyl scratch, laser, explosion, beds and UI sounds. Risers and beds can be sized in bars of your tempo.
- **Auto-tune**: pitch-corrects a vocal to the key (detected or chosen) with retune speed and amount. 0 ms gives the hard snap, ~40 ms sounds natural, and 150 ms+ keeps vibrato. It uses YIN pitch tracking, scale snapping with hysteresis and PSOLA shifting, so length, rate and channels are unchanged.
- **Layer**: drops any generated part onto a track. The part is looped to fill the track, offset, levelled and optionally ducked under it.

**DJ.** Every move detects the tempo, beat grid, downbeats and key (with Camelot code) first, so it lands on the beat. Use ×2 / ÷2 when a track reads half- or double-time.

| Tool | What it does |
|---|---|
| Backspin | The platter is yanked backwards on a beat, whips to about −3× and slows to a stop. Then it stops, or rewinds to the start of the phrase. |
| Echo out | The track stops on a downbeat, and its last beat trails off on a 1- or ½-beat echo with a rising high-pass. |
| Beat jump | Skips forward or loops back by N beats, with a 6 ms crossfade. |
| Double drop | Tempo-matches track B and lines its drop (auto-detected) up with A's drop on the same downbeat. B rides in over 8 bars, both drops play together with one bass line, then A hands over. |
| Quick mix | A 1–4 bar beat-matched cut into B with a bass swap. |
| Long blend | An 8–32 bar blend: B's highs come in, the basses swap halfway, then A's highs go out. |
| Mashup | Vocals of one song over the instrumental of another. They're separated if needed, tempo-matched, aligned downbeat-to-downbeat, optionally shifted to the instrumental's key, with the bed ducked under the voice. |
| Acapella / Instrumental | Splits vocals from music. Uses mlx-audio AI separation when its server is running. Otherwise a built-in center-channel extractor (STFT similarity mask) handles stereo mixes with centered vocals. Set `soundLab.dj.separation` to choose. |

The same moves are one click away in the explorer's **Sound Lab → Sound Lab DJ** menu (select two files for the two-track moves) and in the audio editor's **DJ** row, which acts at the playhead. New material goes to `sound-lab-studio/` in your workspace (`soundLab.studio.outputDirectory`). Edits of a track are written next to it, in its format, and never overwrite it.

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

### CI and releases
GitHub Actions tests every pull request against real ffmpeg on Linux and macOS, runs the webview UI harness and the Claude Code plugin suite, and attaches a VSIX build. To release, add your changes under `## Unreleased` in `CHANGELOG.md`, then run **Actions → Release → Run workflow** and pick `patch`, `minor` or `major`. The workflow bumps the extension and plugin versions together, tags `vX.Y.Z`, and publishes a GitHub release with the VSIX and the plugin zip. It also publishes to the Marketplace and Open VSX (when the `VSCE_PAT` / `OVSX_PAT` secrets are set in the `marketplace` environment) and pushes versioned container images.

### Building and installing with `make`
```bash
make                # npm ci → compile → bump the patch version → dist/sound-lab-<version>.vsix
make install        # install the highest-versioned dist/*.vsix into VS Code (`code` on PATH)
make all install    # both
make BUMP=minor     # or major, an explicit X.Y.Z, or none
make package        # package the current version without bumping
make download       # the VSIX CI built from the latest green commit on main (gh CLI)
make help           # every target
```
A bump rewrites the version in `package.json`, `package-lock.json` and the plugin manifests together, and dates the CHANGELOG, through `scripts/version.js`. Commit those files to keep the bump. Official, tagged releases come from the **Release** workflow.

### Working on it with Claude Code
This repo is set up as a Claude Code project:

* **`CLAUDE.md`** covers the architecture, conventions and the FFmpeg gotchas learned so far.
* **`.claude/settings.json`** pre-approves the build, test and ffmpeg commands, and blocks `vsce publish` and force-pushes.
* **Post-edit hook** (`.claude/hooks/check-edit.js`): every time Claude edits `src/**/*.ts` or `package.json`, it recompiles and re-checks the manifest↔code wiring. It also syntax-checks `media/*.js` and stops `src/core/` from importing `vscode`. Problems are fed straight back to Claude.
* **Slash commands (skills):** `/add-command <idea>`, `/add-effect <effect>`, `/ffmpeg-explore <filter>`, `/verify`, `/release patch|minor|major`
* **Subagents:** `ffmpeg-expert` (filtergraphs, proven on generated signals), `transcription-engineer` (STT backends and subtitle formats), `extension-reviewer` (an independent review of a diff before it's called done).

Open the folder and run `claude`, then try e.g. `/add-effect tape-stop` or "use the ffmpeg-expert to add a de-esser".
