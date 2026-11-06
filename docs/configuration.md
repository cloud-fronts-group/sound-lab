# Configuration

Sound Lab has 32 settings, all under the `soundLab.` prefix. Open **Settings** and search for "Sound Lab", or edit `settings.json`. Settings are read when a command runs, so most changes take effect on the next command without a reload. Two groups react immediately: changing `soundLab.ffmpegPath` or `soundLab.ffprobePath` re-detects FFmpeg and updates the status bar, and changing any `soundLab.explorer.*` setting refreshes the Samples view.

## How settings are read and written

- **Reading.** Sound Lab reads the `soundLab` section with VS Code's normal precedence (user settings, overridden by workspace settings).
- **Writing.** Sound Lab changes your **user** settings itself in four cases:

  | When | Setting written |
  |---|---|
  | You run **Split on Silence…** and answer the two prompts | `soundLab.silence.thresholdDb`, `soundLab.silence.minDuration` |
  | **Transcribe** with whisper.cpp and you choose a model file | `soundLab.transcription.whisperCpp.model` |
  | **Transcribe** with `ffmpeg-whisper` and you choose a model file | `soundLab.transcription.ffmpegWhisper.model` |
  | **Transcribe** with whisper.cpp and you click **Use API Instead** | `soundLab.transcription.backend` (set to `openai-compatible`) |

- **Secrets.** The transcription API key is **not** a setting. It is kept in VS Code's secret storage; see [Transcription](transcription.md#openai-compatible-api).
- **Environment variables.** The only one the extension reads is `OPENAI_API_KEY`, as a fallback when no key is stored. (`FFMPEG` and `FFPROBE` are read by the test suites only.)

## Output location

By default every result is written next to its source. `soundLab.output.directory` redirects results; it is created if it does not exist.

| Variable | Expands to |
|---|---|
| `${fileDirname}` | The folder that contains the source file |
| `${workspaceFolder}` | The workspace folder that contains the source (the first workspace folder if the file is outside them all; the file's own folder if there is no workspace) |
| `${fileBasenameNoExtension}` | The source file's name without its extension |

No other VS Code variables are expanded. A path without a variable that is not absolute is resolved relative to the **source file's folder**.

For `/Users/me/proj/drums/kick.wav` in the workspace `/Users/me/proj`, a trim from 0.5 s to 1.75 s is written to:

| `soundLab.output.directory` | Result |
|---|---|
| *(empty)* | `/Users/me/proj/drums/kick_0.00-0.01.wav` |
| `${workspaceFolder}/export` | `/Users/me/proj/export/kick_0.00-0.01.wav` |
| `${fileDirname}/out` | `/Users/me/proj/drums/out/kick_0.00-0.01.wav` |
| `${workspaceFolder}/export/${fileBasenameNoExtension}` | `/Users/me/proj/export/kick/kick_0.00-0.01.wav` |
| `renders` | `/Users/me/proj/drums/renders/kick_0.00-0.01.wav` |

**Which commands use it.** Convert, Trim and Export selection, Normalize, Slice (the `_slices` folder), Split on Silence (the `_split` folder), Apply Effects, Concatenate, Extract Audio, the waveform and spectrogram images, Transcribe, and the result of Add Subtitles. **Batch Convert** writes `converted_<fmt>/` inside the folder you choose, and **Record** and **Generate** write into the folder you choose, so they ignore it.

**Collisions.** With `soundLab.output.overwrite` off (the default), a taken name gets `-1`, `-2`… With it on, the existing file is replaced. See [Output file naming](commands.md#output-file-naming).

## Tools

| Setting | Type | Default | What it does |
|---|---|---|---|
| `soundLab.ffmpegPath` | string | `"ffmpeg"` | Path to the `ffmpeg` executable (or just `ffmpeg` if it is on your PATH). |
| `soundLab.ffprobePath` | string | `"ffprobe"` | Path to the `ffprobe` executable. |

Values are passed straight to the operating system, so `~` and environment variables are **not** expanded; use an absolute path. An empty value falls back to `ffmpeg` / `ffprobe` on the `PATH`.

## Output

| Setting | Type | Default | What it does |
|---|---|---|---|
| `soundLab.output.directory` | string | `""` | Where results are written. Empty = next to the source file. Supports `${fileDirname}`, `${workspaceFolder}` and `${fileBasenameNoExtension}`. |
| `soundLab.output.overwrite` | boolean | `false` | Overwrite existing output files instead of adding a numeric suffix. |

## Defaults for new files

| Setting | Type | Default | What it does |
|---|---|---|---|
| `soundLab.defaults.format` | string (`wav`, `flac`, `aiff`, `mp3`, `ogg`, `opus`, `m4a`) | `"wav"` | Default output format for samples and effects. |
| `soundLab.defaults.bitDepth` | number (`16`, `24`, `32`) | `24` | Bit depth for WAV / AIFF / FLAC output (32 = float for WAV). |
| `soundLab.defaults.sampleRate` | number | `0` | Output sample rate in Hz. 0 keeps the source rate. |
| `soundLab.defaults.mp3Bitrate` | string | `"320k"` | Bitrate for MP3 / AAC / Opus encoding. |

Where these apply:

- **Record, Generate, and Extract Audio when encoding** use them directly.
- **Edits** (Trim, Normalize, Effects, Slice, Split on Silence, Concatenate) keep the source's own format and, for WAV, AIFF and FLAC, its bit depth. `defaults.format` and `defaults.bitDepth` are used only for sources Sound Lab cannot write as-is (for example WMA, CAF, AC-3, AMR, MKA or raw AAC), and `defaults.bitDepth` is always used by Concatenate.
- **`defaults.sampleRate`** is applied to every edit when it is not 0, not just new files. Leave it at 0 to keep each source's rate.
- **`defaults.mp3Bitrate`** feeds MP3, M4A (AAC) and Opus encoding. Ogg uses variable quality and ignores it, M4A caps at 320k (above that it uses 256k), and Opus uses it only up to 256k (above that it uses 160k).

## Loudness

| Setting | Type | Default | What it does |
|---|---|---|---|
| `soundLab.normalize.targetLufs` | number | `-14` | Integrated loudness target for EBU R128 normalization (LUFS). -14 streaming, -16 podcasts, -23 broadcast. |
| `soundLab.normalize.truePeak` | number | `-1` | Maximum true peak (dBTP). |
| `soundLab.normalize.lra` | number | `11` | Loudness range target (LU). |

`normalize.targetLufs` is the first choice in the **Normalize Loudness…** menu. `truePeak` and `lra` apply to every loudness mode, including the −14, −16 and −23 presets.

## Silence detection

| Setting | Type | Default | What it does |
|---|---|---|---|
| `soundLab.silence.thresholdDb` | number | `-40` | Level below which audio counts as silence (dBFS). |
| `soundLab.silence.minDuration` | number | `0.35` | Minimum silence length (seconds) that splits a sample. |
| `soundLab.silence.padding` | number | `0.03` | Seconds of silence kept around each split segment. |
| `soundLab.silence.minSegment` | number | `0.08` | Discard segments shorter than this (seconds). |

These drive both **Split on Silence…** and the editor's **Find silence** panel. A threshold closer to 0 (for example −30) treats quieter material as silence, which suits noisy recordings; a smaller `minDuration` splits at shorter pauses.

## Editor and Samples view

| Setting | Type | Default | What it does |
|---|---|---|---|
| `soundLab.preview.peaksPerSecond` | number | `200` | Waveform resolution in the audio editor. |
| `soundLab.explorer.include` | string | `"**/*.{wav,mp3,flac,ogg,oga,opus,m4a,aac,aif,aiff,wma,caf}"` | Glob of files listed in the Samples view. |
| `soundLab.explorer.exclude` | string | `"**/{node_modules,.git,out,dist}/**"` | Glob excluded from the Samples view. |

`preview.peaksPerSecond` is lowered automatically so a file never has more than 60,000 waveform buckets (a 10-minute file at 200 per second would need 120,000, so it uses 100). See [Architecture](architecture.md#14-limits-built-into-the-code).

## Recording

| Setting | Type | Default | What it does |
|---|---|---|---|
| `soundLab.record.inputFormat` | string | `""` | FFmpeg input device format for recording. Empty = auto (`avfoundation` on macOS, `dshow` on Windows, `pulse` on Linux). |
| `soundLab.record.device` | string | `""` | Recording device. Empty = pick from a list each time (falls back to `default`). |

Leave `record.inputFormat` empty to use the platform's default (`avfoundation` on macOS, `dshow` on Windows, `pulse` on Linux). If `record.device` is empty and ffmpeg's device list cannot be read, the command falls back per input format: `:0` for `avfoundation` and `default` for `pulse` and `alsa`. `dshow` has no usable fallback (the device name would be empty), so on Windows set `record.device`. Device values by input format:

| Input format | `record.device` looks like | Notes |
|---|---|---|
| `avfoundation` | `1` (becomes `:1`) | The number is the audio-device index from ffmpeg's list |
| `dshow` | `Microphone (Realtek Audio)` | Sound Lab adds the `audio=` prefix |
| `pulse` | a source name, or `default` | |
| `alsa` | `hw:1`, or `default` | Set `record.inputFormat` to `alsa` |

## Transcription

| Setting | Type | Default | What it does |
|---|---|---|---|
| `soundLab.transcription.backend` | string (`whisper.cpp`, `openai-compatible`, `ffmpeg-whisper`) | `"whisper.cpp"` | Speech-to-text engine. |
| `soundLab.transcription.language` | string | `"auto"` | Spoken language code (en, de, ja…) or 'auto'. |
| `soundLab.transcription.translateToEnglish` | boolean | `false` | Translate speech to English instead of transcribing it verbatim. |
| `soundLab.transcription.prompt` | string | `""` | Optional initial prompt (names, jargon) to guide recognition. |
| `soundLab.transcription.outputFormats` | string[] (`srt`, `vtt`, `txt`, `json`) | `["srt","vtt","txt","json"]` | Transcript files written next to the audio. |
| `soundLab.transcription.whisperCpp.executable` | string | `"whisper-cli"` | whisper.cpp CLI executable (whisper-cli, or main for older builds). |
| `soundLab.transcription.whisperCpp.model` | string | `""` | Path to a ggml model, e.g. ggml-base.en.bin. |
| `soundLab.transcription.whisperCpp.threads` | number | `0` | Threads for whisper.cpp (0 = its default). |
| `soundLab.transcription.whisperCpp.extraArgs` | string[] | `[]` | Extra CLI arguments for whisper.cpp. |
| `soundLab.transcription.ffmpegWhisper.model` | string | `""` | ggml model path for FFmpeg's whisper filter. |
| `soundLab.transcription.openai.baseUrl` | string | `"https://api.openai.com/v1"` | Base URL of an OpenAI-compatible API. |
| `soundLab.transcription.openai.model` | string | `"whisper-1"` | Model name, e.g. whisper-1, whisper-large-v3 (Groq), Systran/faster-whisper-small. |

How each backend uses them is in [Transcription and subtitles](transcription.md).

## mlx-audio

The speech features (text-to-speech, the `mlx-audio` transcription backend, voice cloning and separation) use the [mlx-audio](https://github.com/Blaizzy/mlx-audio) API server. These settings choose how Sound Lab runs it and where the embedded mlx-audio Studio comes from. The model choices (`soundLab.mlx.sttModel`, `ttsModel`, `ttsVoice`, `cloneModel`, `separationModel`), the container settings (`image`, `gpu`) and the lifecycle switches (`autoStart`, `stopOnExit`, `showStatusBar`) are described in the Settings UI.

| Setting | Type | Default | What it does |
|---|---|---|---|
| `soundLab.mlx.mode` | string (`auto`, `native`, `docker`, `podman`, `apple-container`, `external`) | `"auto"` | How Sound Lab runs the mlx-audio API server. `auto` is `native` on Apple Silicon and `docker` elsewhere. Containers on macOS have no Metal access, so the Apple-GPU path is `native`. |
| `soundLab.mlx.url` | string | `""` | Base URL of an mlx-audio server (mode `external`, or to override). Empty = `http://127.0.0.1:<port>`. |
| `soundLab.mlx.port` | number | `8000` | Port of the mlx-audio API server. |
| `soundLab.mlx.python` | string | `"python3"` | Python with `mlx-audio[server]` installed, for native mode. Used only when no `mlx_audio.server` executable is found (see `server`). |
| `soundLab.mlx.server` | string | `""` | Path to the `mlx_audio.server` executable for native mode. Empty = find it on the `PATH`, then in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`; when nothing is found, `<soundLab.mlx.python> -m mlx_audio.server` is run instead. |
| `soundLab.mlx.studio.path` | string | `""` | Folder of mlx-audio Studio: a checkout of `mlx_audio/ui` (`package.json` and `app/`) or a prebuilt standalone build (`server.js` and `.next/`). Empty = the Homebrew `mlx-audio-studio` bundle, then an editable mlx-audio install, then a download on first use. |
| `soundLab.mlx.studio.port` | number | `3000` | Port the embedded mlx-audio Studio listens on. |

**Native mode and Homebrew.** `brew install mlx-audio` from the `cloud-fronts-group/sound-lab` tap (see the [README](../README.md#mlx-audio-local-speech-ai-inside-vs-code)) puts `mlx_audio.server` in `/opt/homebrew/bin` (Apple Silicon) or `/usr/local/bin` (Intel). VS Code's extension host often starts with a minimal `PATH`, and an auto-activated conda or venv can put another `mlx_audio.server` first, so Sound Lab checks the well-known folders itself; set `soundLab.mlx.server` when you need a particular binary. Like `ffmpegPath`, the value is passed to the operating system as-is: no `~`, no environment variables.

**The Homebrew Studio.** `brew install mlx-audio-studio` installs a prebuilt Studio whose API address is fixed at build time to `http://localhost:8000` (its `studio.json` records it). Sound Lab uses that build only when the address matches your API, which means the default `soundLab.mlx.port` and a local server; with another port or an `external` URL it logs why it skipped the bundle and falls back to a downloaded Studio in dev mode. `soundLab.mlx.studio.path` always wins when it is set.

## Ready-made `settings.json` blocks

**Sampler workflow**: 16-bit / 44.1 kHz material, exports collected in one folder, silence splitting tuned for drum hits.

```jsonc
{
  "soundLab.defaults.format": "wav",
  "soundLab.defaults.bitDepth": 16,
  "soundLab.defaults.sampleRate": 44100,
  "soundLab.output.directory": "${workspaceFolder}/export",
  "soundLab.silence.thresholdDb": -45,
  "soundLab.silence.minDuration": 0.2
}
```

Remember that a non-zero `defaults.sampleRate` resamples every edit to 44.1 kHz.

**Podcast production**: −16 LUFS delivery with extra true-peak headroom, a 128k default bitrate for the lossy files Sound Lab encodes without asking (edits of MP3, M4A and Opus files, and **Extract Audio** when it encodes), and text transcripts only.

```jsonc
{
  "soundLab.normalize.targetLufs": -16,
  "soundLab.normalize.truePeak": -1.5,
  "soundLab.defaults.mp3Bitrate": "128k",
  "soundLab.transcription.language": "en",
  "soundLab.transcription.outputFormats": ["srt", "txt"]
}
```

**Game audio**: only list the audio folder, collect results per source, keep the project's rate.

```jsonc
{
  "soundLab.explorer.include": "Assets/Audio/**/*.{wav,ogg,flac}",
  "soundLab.explorer.exclude": "**/{node_modules,.git,Library,Temp}/**",
  "soundLab.output.directory": "${workspaceFolder}/Build/Audio/${fileBasenameNoExtension}",
  "soundLab.defaults.sampleRate": 48000
}
```

**Fully offline transcription** (whisper.cpp):

```jsonc
{
  "soundLab.transcription.backend": "whisper.cpp",
  "soundLab.transcription.whisperCpp.executable": "whisper-cli",
  "soundLab.transcription.whisperCpp.model": "/Users/me/models/ggml-large-v3-turbo.bin",
  "soundLab.transcription.whisperCpp.threads": 8,
  "soundLab.transcription.whisperCpp.extraArgs": ["--max-len", "40"]
}
```

**Hosted transcription** (Groq), then run **Sound Lab: Set Transcription API Key**:

```jsonc
{
  "soundLab.transcription.backend": "openai-compatible",
  "soundLab.transcription.openai.baseUrl": "https://api.groq.com/openai/v1",
  "soundLab.transcription.openai.model": "whisper-large-v3",
  "soundLab.transcription.language": "en"
}
```

**FFmpeg installed by Homebrew on Apple Silicon**, when VS Code cannot see your shell's `PATH`:

```jsonc
{
  "soundLab.ffmpegPath": "/opt/homebrew/bin/ffmpeg",
  "soundLab.ffprobePath": "/opt/homebrew/bin/ffprobe"
}
```

**mlx-audio from Homebrew on Apple Silicon**, when a conda or venv on your `PATH` shadows the Homebrew server, or VS Code cannot see your shell's `PATH`:

```jsonc
{
  "soundLab.mlx.mode": "native",
  "soundLab.mlx.server": "/opt/homebrew/bin/mlx_audio.server"
}
```

**Recording from an ALSA device on Linux**:

```jsonc
{
  "soundLab.record.inputFormat": "alsa",
  "soundLab.record.device": "hw:1"
}
```

## If a setting seems to be ignored

- A **workspace** setting overrides your user setting. Check `.vscode/settings.json`.
- Settings that Sound Lab reads when a command starts do not change a job that is already running.
- A misspelled key has no effect; copy the names from this page.
- After changing `soundLab.explorer.include`, run **Refresh Samples** if new files do not appear on their own; see [Samples view](samples-view.md#choosing-which-files-appear).
