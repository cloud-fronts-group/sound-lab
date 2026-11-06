# Architecture

This page explains how Sound Lab is put together: the layers, the life of a command, the audio editor's webview protocol, where files and caches live, and the limits built into the code. Line counts are approximate and refer to commit `b8adc0b`.

## 1. The system in one picture

```text
┌──────────────────────────────── VS Code ────────────────────────────────┐
│  Command Palette   Explorer menu   Samples view   Editor title / buttons │
│         └────────────────┴───────────────┬───────────────┘              │
│                                          ▼  (arg, args)                 │
│   extension.ts ── command map ──▶ commands.ts ──▶ util.ts               │
│                                       prompts      job() · naming ·     │
│                                          │         resolveTargets()     │
│   ┌──────────────────────┐               ▼                              │
│   │ Audio editor         │        core/   (never imports `vscode`)      │
│   │ audioEditor.ts       │        recipes · ffmpeg · analysis · probe   │
│   │   ⇅ postMessage      │        subtitles · transcribe                │
│   │ media/editor.js      │               │ argv arrays                  │
│   └──────────────────────┘               ▼                              │
└───────────────────────────────── child processes ───────────────────────┘
                     ffmpeg · ffprobe · whisper-cli  ──▶  new files on disk
                     HTTPS POST (only the OpenAI-compatible backend)
```

Three ideas hold everything together:

1. **`core/` is pure Node.** It has no `vscode` import, so the same code is unit-tested against real ffmpeg without VS Code.
2. **Everything is an argv array.** `core/recipes.ts` returns `string[]` for `spawn`. There is no shell, so a file called `my "weird"; name.wav` is just one argument.
3. **Every command has the same shape**: resolve files, ask questions, run a cancellable job, name outputs safely, announce the result.

## 2. Design rules

| Rule | Why | Enforced by |
|---|---|---|
| Never build shell strings | Paths with spaces, quotes or `;` must be safe | `spawn(exe, args)` without `shell`; `extension-reviewer` agent checks |
| Filter values containing paths go through `escapeFilterValue()` | ffmpeg parses filtergraphs on two levels | A test that runs a path full of metacharacters through a real filtergraph |
| Never overwrite the source | Sampling workflows are destructive enough already | `outputFor()` / `uniquePath()`; see [Security and privacy](#13-security-and-privacy) for the exceptions |
| Long work goes through `job()` | Users get progress, **Cancel**, logging and a readable error | Convention; the reviewer agent checks |
| Edits keep the source format and bit depth | A normalized WAV should still be a WAV | `sameFormatEncode()`; new material uses `defaultEncode()` |
| A new command touches four places | The manifest and the code must agree | `test/activation.test.js` fails if they drift |
| Webview: strict CSP, no inline script or style | Defence in depth for HTML built from file names and transcripts | Nonce-based CSP in `audioEditor.ts` |

## 3. Source layout

```text
src/
  extension.ts        activate(): registers everything
  commands.ts         one cmdXxx(arg, args) per command, plus shared helpers
  util.ts             VS Code glue: settings, jobs, naming, target resolution
  audioEditor.ts      custom editor provider for *.wav, *.mp3, …
  sampleExplorer.ts   the Samples tree view
  core/               NO vscode imports
    ffmpeg.ts         process runner, timecodes, capability detection
    recipes.ts        argv builders, codec matrix, effects catalogue
    analysis.ts       parsers for ffmpeg analysis output, waveform peaks
    probe.ts          ffprobe JSON → AudioSummary, Markdown report
    subtitles.ts      Segment model, SRT / VTT / TXT / JSON
    transcribe.ts     whisper.cpp, OpenAI-compatible HTTP, FFmpeg whisper filter
media/
  editor.js           webview script (plain JS, checked with // @ts-check)
  editor.css          webview styles, VS Code theme variables only
  icon.png            extension icon;  activity.svg  activity bar icon
test/
  core.test.js        integration tests against real ffmpeg
  activation.test.js  mocks `vscode`; checks manifest ↔ code agreement
  ui/harness.js       Playwright check of the real webview
```

| File | Lines | Main exports |
|---|---|---|
| `extension.ts` | 62 | `activate`, `deactivate` |
| `commands.ts` | 761 | `cmdProbe`, `cmdConvert`, `cmdTrim`, … (20 handlers), `levelsMarkdown`, `detectSilence`, `renderImage`, `loadTranscript`, `transcriptPaths`, `onTranscribed` |
| `util.ts` | 218 | `state`, `cfg`, `tools`, `job`, `outputFor`, `uniquePath`, `outputDir`, `defaultEncode`, `sameFormatEncode`, `resolveTargets`, `announce`, `storageDir`, `AUDIO_EXT`, `VIDEO_EXT` |
| `audioEditor.ts` | 241 | `AudioEditorProvider` |
| `sampleExplorer.ts` | 118 | `SampleExplorer` |
| `core/ffmpeg.ts` | 186 | `run`, `runOk`, `ProcessError`, `ffBase`, `parseTimecode`, `formatTimecode`, `detectCapabilities` |
| `core/recipes.ts` | 345 | `convert`, `trim`, `slicePoints`, `sliceAt`, `loudnormAnalyze`, `loudnormApply`, `concat`, `generate`, `record`, `EFFECTS`, … |
| `core/analysis.ts` | 142 | `parseSilence`, `soundSegments`, `parseLoudnormJson`, `analyzeLevels`, `extractPeaks` |
| `core/probe.ts` | 137 | `probe`, `summarize`, `probeMarkdown`, `humanSize` |
| `core/subtitles.ts` | 87 | `toSrt`, `toVtt`, `toTxt`, `parseCues`, `render`, `fromWhisperCppJson`, `fromOpenAiJson` |
| `core/transcribe.ts` | 149 | `transcribe`, `escapeFilterValue` |
| `media/editor.js` | 444 | (IIFE; talks to the extension via `postMessage`) |

The shared mutable state is one object, `state` in `util.ts`: the output channel, the extension context, the detected `Capabilities`, the URI of the active audio editor, the status bar item, and an event emitter (`created`) that fires whenever Sound Lab writes files.

## 4. Activation and registration

The manifest's `activationEvents` entry is `workspaceContains:**/*.{wav,mp3,flac,ogg,opus,m4a,aac,aif,aiff,wma}`, so a workspace that contains audio activates the extension. VS Code 1.74 and later also generate activation events for contributed commands, views and custom editors, so running a command or opening an audio file activates it too.

`activate()` does six things, in order:

1. Stores the context and creates the **Sound Lab** output channel and a right-aligned status bar item (priority 50) whose click runs `soundLab.showCapabilities`.
2. Creates the `SampleExplorer` and registers it as the tree provider for `soundLab.samples`.
3. Registers the custom editor `soundLab.audioPreview` with `retainContextWhenHidden: true` and `supportsMultipleEditorsPerDocument: true`.
4. Registers all 23 commands from one map: 20 handlers exported by `commands.ts`, plus three one-liners defined inline (`openPreview`, `showLog`, `refreshSamples`). Each handler is wrapped so that an exception shows `Sound Lab: <first line of the message>` and writes the stack to the log.
5. Listens for configuration changes: editing `soundLab.ffmpegPath` or `soundLab.ffprobePath` re-detects capabilities.
6. Calls `refreshCapabilities()` once.

`deactivate()` does nothing; every disposable is in `context.subscriptions`.

## 5. Anatomy of a command

```text
trigger ──▶ handler(arg, args)
              │
              ├─ resolveTargets()      files from Explorer / tree / editor / active editor / picker
              ├─ prompts               QuickPick, InputBox, askNumber(); defaults come from cfg()
              ├─ job(title, fn)        ensureFfmpeg() → progress notification (cancellable)
              │     └─ ff(args, duration, report, signal, msg, from, to)
              │           ├─ log("$ ffmpeg …")
              │           └─ runOk()  → spawn → parse stderr `time=` → progress 0..1
              ├─ outputFor() / uniquePath()      choose a safe new file name
              └─ announce(files)       "Created X" with Open / Reveal; fires state.created
                                         └─▶ Samples view refreshes (400 ms debounce)
```

**Which file does a command act on?** `resolveTargets(arg, args, opts)` accepts, in this order:

1. An array of URIs in `args`. Explorer multi-selection passes `(clickedUri, allSelectedUris[])`.
2. A single URI, or a tree node that has a `resourceUri`, in `arg`.
3. If nothing was passed and an audio editor is active (and the command is not video-only), that editor's file.
4. Otherwise, an open-file dialog with an *Audio / video* filter and an *All files* filter. The two video-only commands, **Extract Audio from Video…** and **Add Subtitles to Video…**, offer a *Video* filter instead.

With `many: false` only the first file is used. Only recognised media extensions count (`AUDIO_EXT` plus `VIDEO_EXT`).

**Commands can return values.** `cmdTrim` returns the output path (the editor's *Export selection* uses it for its toast), `cmdAnalyze(…, { silent: true })` returns the `LevelReport` without opening a document, and `cmdTranscribe` returns the segments. The editor reuses commands instead of duplicating logic.

**Progress.** A multi-file job maps each file into a slice of the 0–1 range: file `i` of `n` reports `(i + f) / n`. Two-pass operations such as loudness normalization split each file's slice in half.

## 6. The process runner

`core/ffmpeg.ts` wraps `child_process.spawn`:

| Option | Purpose |
|---|---|
| `exe`, `args`, `cwd` | What to run. No shell is involved; on Windows `windowsHide: true` suppresses a console window |
| `durationSec` + `onProgress` | When both are set, every stderr line is matched against `time=HH:MM:SS.xx` and reported as `min(1, t / duration)` |
| `onLog` | Receives every stderr line. ffmpeg uses `\r` for in-place progress, so lines are split on `\r\n`, `\r` and `\n` |
| `onStdout` | Raw stdout chunks, used for PCM when extracting waveform peaks. When set, stdout is not buffered |
| `signal` | An `AbortSignal` that kills the child |
| `gracefulStop` | On abort, write `q` to stdin so ffmpeg can finalize the file, and kill after 4 s if it is still running. Used for recording |

What each outcome produces:

| Situation | Result |
|---|---|
| Exit code 0 | `run()` resolves |
| Aborted with `gracefulStop` | `run()` resolves (a requested stop is a success for recordings) |
| Aborted without `gracefulStop` | `run()` rejects with `ProcessError('Cancelled')` |
| Any other non-zero exit | `run()` resolves with the code; `runOk()` throws `ProcessError("<exe> failed (exit N):\n<last 6 non-empty stderr lines>")`, where `<exe>` is the base name of the program that ran (`ffmpeg`, `ffprobe`, `whisper-cli`, or `ffmpeg.exe` on Windows) |
| Executable missing (`ENOENT`) | `ProcessError('Executable not found: "x". Install it or set its path in Sound Lab settings.')` |

`stdout` and `stderr` are each kept up to 16 MiB. Most argument builders start with `ffBase()`: `-hide_banner -nostdin -y`. The analysis calls that write nothing (`loudnormAnalyze`, `levelsAnalyze`, `silenceDetect`, peak extraction) leave out `-y`, and recording leaves out `-nostdin` because it needs stdin to receive the `q` that stops it gracefully.

**Capability detection** runs `ffmpeg -version`, `ffmpeg -filters` and `ffmpeg -encoders`, plus `ffprobe -version`, and keeps the filter and encoder names in sets. The result drives the status bar and the **Show FFmpeg Capabilities** report, and `ensureFfmpeg()` refuses to start a job when either binary is missing. Individual features check the filters they need at run time (for example the FFmpeg `whisper` filter).

## 7. Jobs, errors and logging

`job(title, fn)` in `util.ts` is the single place where long work is wrapped:

1. `ensureFfmpeg()`; if a binary is missing, an error dialog offers **Open Settings**, **Download FFmpeg** and **Retry**.
2. Logs `▶ title` to the output channel.
3. Runs `fn(report, signal, logLine)` inside a cancellable `withProgress` notification.
4. On success logs `✔ title`.
5. On cancellation logs `✖ title cancelled` and returns `undefined`.
6. On any other error logs `✖ title: message`, logs the last 30 stderr lines of a `ProcessError`, and shows the first line of the message with a **Show Log** button.

`ff()` in `commands.ts` logs the command line (`$ ffmpeg …`) before running, so a job that goes through it can be reproduced from the log. The analysis, media-info and transcription helpers call `runOk()` directly and do not log a command line. `logLine()` drops ffmpeg's per-frame `size=… time=…` progress lines but keeps everything else.

## 8. The audio editor

`AudioEditorProvider` implements `CustomReadonlyEditorProvider` for view type `soundLab.audioPreview`, registered with default priority for `*.{wav,mp3,flac,ogg,oga,opus,m4a,aac,aif,aiff,wma,caf,ac3,amr,webm,mka}`.

**Per-file state.** The provider keeps a map from file path to the set of open panels, so a transcript produced by a command reaches every editor that shows that file. A file watcher on the file reloads the waveform when it changes on disk. `state.activeEditorUri` tracks the focused editor so palette commands act on it.

**Load sequence** (triggered by the webview's `ready` message, and again on file change):

```text
ensureFfmpeg ─▶ ffprobe ─▶ post info ─▶ (no audio stream? post error, stop)
             ─▶ playableSource() ─▶ post audio (file URI + ?v=mtime)
             ─▶ loadTranscript() sidecar? ─▶ post transcript
             ─▶ extractPeaks() ─▶ post peaks
```

**Playable source.** VS Code's Chromium cannot play AAC, AIFF, WMA and several others. Files with extension `mp3`, `ogg`, `oga`, `opus`, `flac` or `webm`, and WAV files whose codec is PCM s16, s24, s32, f32 or u8, are played directly. Anything else, and any `aac` stream, is transcoded once to a FLAC preview in the global storage folder (`preview/<sha1>.flac`, keyed by path, modification time and size).

**Message protocol.** The webview and the extension exchange plain objects with a `type` field.

| Webview → extension | Payload | Handled by |
|---|---|---|
| `ready` | — | loads the file |
| `exportSelection` | `start`, `end` (seconds) | `cmdTrim(uri, {start, end})`, then a `toast` |
| `run` | `command` (letters only) | runs `soundLab.<command>` on this file |
| `analyze` | — | `cmdAnalyze(…, {silent: true})` → `levels` |
| `spectrogram` | `width` (px) | renders and caches a PNG → `spectrogram` |
| `silence` | — | `detectSilence()` → `regions` |
| `transcribe` | — | `cmdTranscribe(uri)`; falls back to any sidecar |
| `copy` | `text` | writes to the clipboard, then a `toast` |

| Extension → webview | Payload |
|---|---|
| `info` | `AudioSummary` plus `size`, `path`, `sampleFmt` |
| `audio` | `src` (a webview URI) |
| `peaks` | `peaks` (`data`, `bucketsPerSecond`, `duration`, `rms`) |
| `levels` | `report` (`LevelReport`, or `null` on failure) |
| `spectrogram` | `src` (a webview URI, or `null` on failure) |
| `regions` | `silences`, `segments` (arrays of `{start, end}`) |
| `transcript` | `segments` (or `null`) |
| `busy` | `what` (currently ignored by the webview) |
| `toast` | `text` |
| `error` | `message` |

**Security of the webview.** The page is built in `AudioEditorProvider.html()` with this Content-Security-Policy:

```text
default-src 'none'; img-src ${cspSource} data: blob:; media-src ${cspSource} blob:;
style-src ${cspSource}; script-src 'nonce-<random>';
```

`localResourceRoots` is the audio file's folder, the extension's `media/` folder and the global storage folder. Text from files and transcripts is inserted with an `esc()` helper, and the `run` message accepts only `[a-zA-Z]+` command names. For the editor itself, see [Audio editor](audio-editor.md).

## 9. The Samples view

`SampleExplorer` is a `TreeDataProvider` with three node types: folders, files and info rows. It lists files with `workspace.findFiles(include, exclude, 5000)`, groups them by folder, and, if there is only one folder, shows the files directly. Metadata rows come from `ffprobe` on demand and are cached per file by modification time. A file-system watcher, plus the `state.created` event, triggers a debounced (400 ms) refresh. Details are in [Samples view](samples-view.md).

## 10. The transcription pipeline

```text
cmdTranscribe ─▶ transcribeConfig()   first-run helpers: pick a model, or set an API key
      │
      └─▶ job ─▶ core/transcribe.transcribe(input, duration, config, hooks)
                    ├─ whisper.cpp       ffmpeg → 16 kHz mono WAV → whisper-cli -oj → fromWhisperCppJson
                    ├─ openai-compatible ffmpeg → 10-minute FLAC chunks → POST each → fromOpenAiJson(+offset)
                    └─ ffmpeg-whisper    ffmpeg -af whisper=…destination=out.srt → parseCues
      ▼
   Segment[] ─▶ render('srt' | 'vtt' | 'txt' | 'json') ─▶ files in the output folder
             └▶ onTranscribed event ─▶ open editors update their Transcript panel
```

All three backends return the same `Segment[]` (`start`, `end` in seconds, `text`). Format conversion lives only in `subtitles.ts`. Full detail: [Transcription](transcription.md).

## 11. Storage, secrets and caches

| What | Where | Lifetime |
|---|---|---|
| Your results | Next to the source, or in `soundLab.output.directory` | Yours |
| Preview transcodes | `<global storage>/preview/<sha1>.flac` | Never pruned automatically |
| Spectrogram images | `<global storage>/spectrograms/<sha1>.png` (key: path, mtime, width) | Never pruned automatically |
| Transcription scratch | `<global storage>/tmp/stt-<random>/` | Removed in a `finally` block after each job |
| API key | VS Code secret storage, key `soundLab.transcription.apiKey` | Until you remove it with **Set Transcription API Key** and empty input |
| Settings | VS Code settings (`soundLab.*`) | Yours |

`<global storage>` is the extension's `globalStorageUri` folder. For this extension it is typically `~/Library/Application Support/Code/User/globalStorage/sound-lab.sound-lab` on macOS, `~/.config/Code/User/globalStorage/sound-lab.sound-lab` on Linux and `%APPDATA%\Code\User\globalStorage\sound-lab.sound-lab` on Windows. The code contains no cache pruning, so delete `preview/` and `spectrograms/` yourself if they grow.

## 12. Ordering and concurrency

Inside one command, work is sequential: files are processed one after another, and each ffmpeg call finishes before the next starts. There is no global job queue, so two commands started back to back run at the same time. Cancelling a batch aborts the current ffmpeg process and stops the loop.

## 13. Security and privacy

- **No shell.** ffmpeg, ffprobe and whisper-cli are started with `spawn(exe, args)`.
- **Webview hardening.** Nonce-based CSP, restricted `localResourceRoots`, escaped HTML, validated command names.
- **Your files stay local.** The only network call in the codebase is `fetch` in the OpenAI-compatible transcription backend, and it goes to `soundLab.transcription.openai.baseUrl`. If that is a hosted service, your audio (as 16 kHz mono FLAC chunks) is uploaded to it. whisper.cpp and the FFmpeg `whisper` filter are fully local.
- **Secrets.** The API key lives in secret storage. `OPENAI_API_KEY` is read as a fallback. The key is sent only as a `Bearer` header and is not written to the log.
- **Source files are protected by naming, not by a lock.** In every command the output name differs from the source's (a suffix, or a different extension), and `uniquePath()` avoids existing files unless `soundLab.output.overwrite` is on. Three behaviours replace existing *outputs* (never your source): re-running **Transcribe** rewrites `<name>.srt/.vtt/.txt/.json`; re-running **Batch Convert Folder…** into the same `converted_<fmt>/` folder overwrites files in it; and `soundLab.output.overwrite` lets any result replace an earlier result with the same name.

## 14. Limits built into the code

| Limit | Value | Where |
|---|---|---|
| Waveform buckets | at most 60,000 per file; `soundLab.preview.peaksPerSecond` (default 200) is lowered for long files | `extractPeaks` |
| Peak decode rate | 22,050 Hz up to 60 s, 8,000 Hz up to 600 s, 4,000 Hz beyond | `extractPeaks` |
| Spectrogram width in the editor | 400–4096 px (height 512) | `audioEditor.ts` |
| Slices per run | 2,000 | `cmdSliceEqual` |
| Samples view | 5,000 files | `SampleExplorer.roots` |
| Batch convert recursion | 12 levels of subfolders; skips any file or folder whose name starts with `.`, and `node_modules` | `walk()` |
| Transcription upload chunk | 600 s of 16 kHz mono FLAC | `CHUNK_SECONDS` |
| Captured process output | 16 MiB each for stdout and stderr | `MAX_BUFFER` |
| Graceful-stop grace period | 4 s before the process is killed | `run()` |

## 15. How the pieces are tested

`test/core.test.js` runs the core against real ffmpeg (22 tests); `test/activation.test.js` activates the extension against a mocked `vscode` and checks that every contributed command is registered, every menu entry points at a real command, every setting read in code is declared, and every webview button maps to a command; `test/ui/harness.js` renders the real webview in Chromium and checks 29 behaviours. See [Development](development.md#tests) for how to run them.
