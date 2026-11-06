# Troubleshooting

Find your symptom, check the likely cause, apply the fix. When in doubt, start with the log.

## First, look at the log

Run **Sound Lab: Show FFmpeg Log**. Every job writes `▶ title` and then `✔ title`, `✖ title: reason` or `✖ title cancelled`; jobs that create or render files also write the exact `$ ffmpeg …` command line and ffmpeg's own messages (**Analyze Loudness & Levels**, **Show Media Info** and **Transcribe** do not log a command line). Errors shown in pop-ups only quote the first line; the log has the last 30 lines of ffmpeg's output. You can paste a logged command into a terminal to see the failure directly.

Also useful: **Sound Lab: Show FFmpeg Capabilities** (which filters and encoders your build has), and, for editor problems, **Developer: Toggle Developer Tools** in the Command Palette (check the Console while the editor is open).

## Setup and FFmpeg

| Symptom | Likely cause | Fix |
|---|---|---|
| Status bar shows "ffmpeg missing", or a dialog says *Sound Lab needs ffmpeg and ffprobe.* | ffmpeg or ffprobe is not on the `PATH` that VS Code sees. On macOS and Linux, VS Code started from the Dock or a launcher may not inherit your shell's `PATH` | Set `soundLab.ffmpegPath` and `soundLab.ffprobePath` to absolute paths (for example `/opt/homebrew/bin/ffmpeg`), then click **Retry** in the dialog. Check that `ffprobe` is installed too; both are required |
| `Executable not found: "…". Install it or set its path in Sound Lab settings.` | A wrong path, a typo, or `~` in the setting (it is not expanded) | Use an absolute path. Run the same path in a terminal to confirm |
| `ffmpeg failed (exit 1): …` with a few log lines | ffmpeg rejected the command. Often an unsupported option on an old build, a missing filter or encoder, or an unreadable input | Read the log. Compare with **Show FFmpeg Capabilities**. Try the logged command in a terminal |
| An encoder error such as `Unknown encoder 'libmp3lame'` | Your build was compiled without that encoder | Use a build that has it. The capabilities report shows MP3, Vorbis, Opus, AAC and FLAC encoders |
| I installed FFmpeg after starting VS Code | Capabilities are detected at start-up | Run **Show FFmpeg Capabilities** (it re-detects), or change the path setting |

## The audio editor

| Symptom | Likely cause | Fix |
|---|---|---|
| *No audio stream in this file.* | The file has only video or data streams | Pick another file; for video use **Extract Audio from Video…** only if it has audio |
| *This audio could not be played in the editor preview (analysis tools still work).* | VS Code's Chromium cannot decode the file and the preview transcode did not help | Check the log. The preview needs ffmpeg's `flac` encoder. Delete the `preview/` cache folder and reopen |
| The waveform stays on "Decoding waveform…" | The file is long and is still being decoded. A failure does not leave this overlay up: the editor replaces it with an error message (for example *ffmpeg / ffprobe not found — set soundLab.ffmpegPath.*) | Wait for long files. If an error message appears instead, follow it and check the log |
| The waveform looks coarse when zoomed in on a long file | Long files are decoded at 8 kHz or 4 kHz with at most 60,000 buckets | Expected; see [limits](architecture.md#14-limits-built-into-the-code) |
| Clicking the spectrogram seeks slightly off | The editor assumes 141 px legend margins on each side, which is exact for 44.1 kHz audio. The margin grows with the sample rate (142 px at 48 kHz), and other FFmpeg versions may draw different margins | Use the waveform to seek; see [FFmpeg internals](ffmpeg-internals.md#8-images-and-waveform-peaks) |
| The spectrogram or Levels panel shows old data after the file changed | The waveform reloads, but those panels are computed once | Click **re-measure** in Levels; reopen the editor for the spectrogram |
| *No sound regions found with the current threshold* | The threshold is too high or too low, or the minimum silence is too long | Adjust `soundLab.silence.thresholdDb` (a quiet file may need −60 or lower; a noisy one −30) and `soundLab.silence.minDuration` |
| *No transcript yet* | No `<name>.json`, `.srt` or `.vtt` next to the audio or in the output folder | Click **Transcribe now**, or move the transcript next to the audio |
| Keyboard shortcuts do nothing | Focus is in a text field or menu | Click the waveform first |

## Output files

| Symptom | Likely cause | Fix |
|---|---|---|
| The result is not next to my file | `soundLab.output.directory` is set | Check [Output location](configuration.md#output-location). A relative path is resolved against the **source file's** folder |
| The result is named `…-1.wav` | The name was taken | Expected. Turn on `soundLab.output.overwrite` to replace instead |
| Two sub-second trims have odd names | Trim names are `m.ss`, floored to whole seconds | Expected; the second gets `-1`. Rename afterwards |
| **Concatenate** produced a stereo 48 kHz file from mono 44.1 kHz inputs | Concatenation converts every input to stereo and to 48 kHz (or `soundLab.defaults.sampleRate`) | Expected. Set `soundLab.defaults.sampleRate` to keep 44.1 kHz |
| Sample rates changed after trimming or normalizing | `soundLab.defaults.sampleRate` is not 0 | Set it back to 0 to keep each source's rate |
| An edited MP3 or M4A sounds worse | Edits re-encode in the source's format | Convert to WAV first, edit, then convert to the delivery format |
| An Opus file came out at 48 kHz and 160k | Opus accepts only 8, 12, 16, 24 and 48 kHz (other rates become 48 kHz), and a bitrate above 256k, such as 320k, falls back to 160k | Expected. Pick 256k or lower to choose the bitrate; see [codec matrix](ffmpeg-internals.md#3-codec-and-format-matrix) |
| "32-bit float" AIFF is not float | AIFF 32-bit is written as 32-bit **integer** PCM | Use WAV for 32-bit float |
| **Normalize** reached −14.07 LUFS, not exactly −14 | Loudness normalization is accurate to a fraction of a LU, and a true-peak ceiling can limit the gain | Check with **Analyze Loudness & Levels**. A lower `soundLab.normalize.truePeak` ceiling or more headroom in the source helps |
| **Apply Effects → Swap L/R** failed | It needs a stereo input; on mono, ffmpeg writes nothing | Use it on stereo files only |
| The file is longer after **Echo** | The echo tail extends the file by the delay time | Expected. Trim afterwards if needed |
| A half-written file remains after **Cancel** | Cancelling kills ffmpeg and the extension does not delete partial output | Delete it. (Recordings are the exception: they finalize on Cancel) |
| **Batch Convert** replaced my earlier results | Re-running into the same `converted_<fmt>/` overwrites | Expected; rename or move the folder first |

## Slicing and splitting

| Symptom | Likely cause | Fix |
|---|---|---|
| *That would create N slices — pick a longer slice length.* | The run would exceed 2,000 slices | Use a longer slice length or fewer beats |
| **Split on Silence** finds too many or too few pieces | Threshold or minimum silence unsuited to the material | Preview with **Find silence** first; see the [tuning table](cookbook.md#chop-a-drum-session-into-one-shots) |
| The log says `no sound segments found in <file>` | Everything counts as silence (the file is quieter than the threshold), or the minimum silence is longer than the gaps | Lower `soundLab.silence.thresholdDb` (for example to −60) |
| My silence settings changed on their own | **Split on Silence** saves its two answers to your user settings | Expected; edit them in settings |

## Samples view

| Symptom | Likely cause | Fix |
|---|---|---|
| The view is empty | No workspace folder is open, or nothing matches the include glob | Open a folder; check `soundLab.explorer.include` and `soundLab.explorer.exclude` |
| A format opens in the editor but is not listed | The default include glob omits `ac3`, `amr`, `webm` and `mka` | Add them to `soundLab.explorer.include` |
| New files do not appear after I changed `include` | The file watcher is created at start-up with the old glob | Run **Refresh Samples** or reload the window |
| Only the first 5,000 files show | Built-in limit | Narrow the include glob |

## Transcription

| Message or symptom | Cause | Fix |
|---|---|---|
| *whisper.cpp needs a ggml model file (e.g. ggml-base.en.bin).* | No model configured | **Choose Model File…**, or set `soundLab.transcription.whisperCpp.model` |
| `whisper.cpp model not found: <path>` | The path is wrong or the file moved | Correct the setting |
| `Executable not found: "whisper-cli"` | whisper.cpp is not installed or not on the `PATH` | Install it or set `soundLab.transcription.whisperCpp.executable` (older builds call it `main`) |
| `whisper.cpp did not produce JSON output (is this an old build without -oj?)` | Your whisper.cpp is too old for `-oj` | Update whisper.cpp |
| `No speech was recognised.` | The backend returned no segments | Check that the audio has speech; set the language; try a larger model |
| An API-key box appears, and when you close it Transcribe stops without an error | The base URL contains `api.openai.com`, no key is stored and `OPENAI_API_KEY` is not set, so Sound Lab asks for a key. You dismissed the box or submitted it empty | Run **Transcribe** again and enter the key, or run **Set Transcription API Key** first. Servers whose URL does not contain `api.openai.com` need no key |
| `Transcription API error 401: …` | Wrong or expired key | Set the key again |
| `Transcription API error 404: …` | Wrong base URL or model name | Check `baseUrl` (it should end in `/v1`) and `model` |
| `Transcription API error 413: …` | The server's upload limit is smaller than a 10-minute FLAC chunk | Use a server without that limit, or split the audio first |
| `Transcription API error 429: …` | Rate limit | Wait and retry |
| `This FFmpeg build has no "whisper" filter (needs FFmpeg 8.0+ configured with --enable-whisper)…` | The `ffmpeg-whisper` backend on an ordinary build | Switch to `whisper.cpp` or `openai-compatible` |
| Text in the wrong language | `auto` detection guessed wrong | Set `soundLab.transcription.language` |
| Invented text over silence or music | Whisper-family models can do this | Trim or split the silence first; use a prompt for names |
| **Add Subtitles** does nothing after *Transcribe this video first* | `srt` and `vtt` are missing from `soundLab.transcription.outputFormats` | Add `srt` |
| Very slow | Large local model, or a slow network for uploads | Use a smaller model or more threads; or `openai-compatible` with a fast server |

## mlx-audio

The speech features (text-to-speech, the `mlx-audio` transcription backend, voice clone, separation) need the mlx-audio API server. Click the `MLX` status bar item to open its log. A server started with `brew services start mlx-audio` logs to `$(brew --prefix)/var/log/mlx-audio.log` instead.

### mlx-audio server will not start in podman mode on macOS

Check these, in order:

- **The podman machine is stopped.** `podman machine list` shows it; `podman machine start` fixes it.
- **No default connection, or a stale SSH port.** `podman info` fails, or hangs after the machine was recreated. Run `podman system connection list`, then `podman system connection default <name>` (usually `podman-machine-default`).
- **The image cannot be pulled.** `ghcr.io/cloud-fronts-group/sound-lab-mlx-audio` must be public, or you must be logged in (`podman login ghcr.io`). Check with `podman pull`.
- **The VM has 2 GiB of RAM**, the podman default, and the models do not fit. With the machine stopped, run `podman machine set --memory 8192` (or more), then start it again.
- **There is no Metal in the VM.** Even with everything above fixed, MLX in the container runs on the CPU only. The same is true of Docker Desktop and Apple `container`.

**Fix:** on a Mac, use native mode. Install the server with Homebrew (`brew tap cloud-fronts-group/sound-lab https://github.com/cloud-fronts-group/sound-lab`, then `brew install mlx-audio`) and set `soundLab.mlx.mode` to `native`, or leave it at `auto`, which picks `native` on Apple Silicon. Sound Lab finds `mlx_audio.server` in `/opt/homebrew/bin` even when VS Code's `PATH` does not include it; if a conda or venv binary gets in the way, set `soundLab.mlx.server` to `/opt/homebrew/bin/mlx_audio.server`. See [mlx-audio in the README](../README.md#mlx-audio-local-speech-ai-inside-vs-code).

| Symptom | Likely cause | Fix |
|---|---|---|
| Native mode runs `python -m mlx_audio.server` (or fails with `No module named mlx_audio`) although `brew install mlx-audio` succeeded | `mlx_audio.server` was not found on VS Code's `PATH` or in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`, or `soundLab.mlx.server` points at a path that no longer exists | Run `which mlx_audio.server` in a terminal and put that path in `soundLab.mlx.server` |
| Sound Lab downloads mlx-audio Studio and runs `next dev` although `brew install mlx-audio-studio` succeeded | The Homebrew Studio is built for the API at `http://localhost:8000`. Sound Lab skips it (the MLX log says why) when `soundLab.mlx.port` is not 8000, when the API is an `external` URL, or when the bundle's `studio.json` is missing | Use port 8000 with a local server, or set `soundLab.mlx.studio.path` to a checkout of `mlx_audio/ui` |

## Recording

| Symptom | Likely cause | Fix |
|---|---|---|
| No devices listed, or silence is recorded (macOS) | VS Code has no microphone permission | Allow it in System Settings → Privacy & Security → Microphone, then try again |
| Wrong input | The wrong device was picked | Set `soundLab.record.device`, or leave it empty to pick each time |
| Windows: device not found | The dshow name must match exactly | Use the name from `ffmpeg -list_devices true -f dshow -i dummy` |
| Linux: nothing recorded | Wrong input format | Try `soundLab.record.inputFormat` `alsa` with `hw:1`, or list devices with `ffmpeg -sources pulse` |
| Nothing happens when I press Cancel | ffmpeg is finalizing the file | Wait a moment; after 4 seconds the process is killed if it is stuck |

## Recipes

| Symptom | Fix |
|---|---|
| I picked a recipe and nothing ran | Recipes are **typed** into the terminal without Enter. Press Enter after editing |
| A recipe with `subtitles=` fails on a path with spaces or a colon | Quote or escape the path inside the filter; see [Escaping](ffmpeg-internals.md#13-escaping-paths-inside-filters) |
| `ffplay: command not found` | The live spectrum recipe needs `ffplay`, which some installs omit |
| ffmpeg asks whether to overwrite | Recipes have no `-y`; answer `y` or choose another name |

## Disk space and caches

Sound Lab keeps two caches in the extension's global storage folder and never prunes them: `preview/` (FLAC copies of files the editor cannot play) and `spectrograms/` (PNG images). Delete the folders whenever you like; they are rebuilt on demand. Typical locations: `~/Library/Application Support/Code/User/globalStorage/sound-lab.sound-lab/` (macOS), `~/.config/Code/User/globalStorage/sound-lab.sound-lab/` (Linux), `%APPDATA%\Code\User\globalStorage\sound-lab.sound-lab\` (Windows).

## Starting over

- **Settings:** remove the `soundLab.*` entries from your user and workspace `settings.json`.
- **API key:** run **Set Transcription API Key** and submit an empty value.
- **Caches:** delete `preview/` and `spectrograms/` as above.
- Then **Developer: Reload Window**.

## Reporting a problem

Include: the Sound Lab version (0.1.0), your VS Code version and operating system, the first line of `ffmpeg -version`, the relevant lines of the **Sound Lab** output channel (including the `$ ffmpeg …` command), and for editor problems any red errors from **Developer: Toggle Developer Tools**. To check whether your FFmpeg build is the cause, run the project's own tests against it (`FFMPEG=… FFPROBE=… npm test`, see [Development](development.md#tests)).
