# Sound Lab — VS Code extension (FFmpeg audio toolkit)

This TypeScript VS Code extension covers sound sampling, editing, analysis and speech-to-text. All the work is done by shelling out to the user's `ffmpeg`, `ffprobe` and (optionally) `whisper-cli`. It has no runtime npm dependencies.

## Commands

```bash
npm run compile      # tsc → out/
npm test             # compile + node:test suites in test/*.test.js (needs ffmpeg/ffprobe on PATH; ~20 s)
npm run test:ui      # renders the real editor webview in Chromium with real ffmpeg data, asserts + screenshots → test/ui/out/
npm run package      # → sound-lab-<version>.vsix
node --test --test-name-pattern="slicing" test/*.test.js   # run one test
```

Use `FFMPEG=/path FFPROBE=/path npm test` to test against a different ffmpeg build.

## Repository layout
- VS Code extension: `src/`, `media/`, `test/`, `package.json` (everything below until "Claude Code plugin").
- Claude Code plugin marketplace: `.claude-plugin/marketplace.json` → `plugins/sound-lab-studio/` (skills, agents, hooks, zero-dependency MCP server in `mcp/`, scripts, containers). Tests: `cd plugins/sound-lab-studio && npm test`. Validate: `claude plugin validate plugins/sound-lab-studio && claude plugin validate .`
- Container images: `plugins/sound-lab-studio/containers/` (built by `.github/workflows/containers.yml` to GHCR).

## Architecture

```
src/
  core/            ← NO `vscode` import allowed here. Pure Node, so it can be unit-tested with real ffmpeg.
    ffmpeg.ts      run()/runOk(): spawn, progress from stderr `time=`, AbortSignal, gracefulStop ('q' on stdin), capabilities
    recipes.ts     argv builders for every operation + EFFECTS catalogue + codecArgs(format/bitDepth/rate)
    analysis.ts    parsers: silencedetect, loudnorm JSON, volumedetect, astats; waveform peak extraction (f32le on stdout)
    probe.ts       ffprobe JSON → AudioSummary, markdown report
    subtitles.ts   Segment model, SRT/VTT/TXT/JSON in and out, whisper.cpp & OpenAI response adapters
    transcribe.ts  backends: whisper.cpp CLI, OpenAI-compatible HTTP (chunked FLAC uploads), FFmpeg 8 `whisper` filter
  util.ts          VS Code glue: config, `job()` (progress + cancel + errors), output paths, resolveTargets()
  commands.ts      one exported `cmdXxx(arg, args)` per command (UI prompts → recipes → ff())
  audioEditor.ts   CustomReadonlyEditorProvider `soundLab.audioPreview` + webview HTML/CSP + message handling
  sampleExplorer.ts Tree view `soundLab.samples`
  extension.ts     activate(): registers the command map, views, editor, status bar
media/editor.js    webview script (plain JS, // @ts-check). It talks to audioEditor.ts via postMessage.
media/editor.css   webview styles. Use VS Code theme variables only, so it works in light and dark themes.
test/core.test.js       integration tests against real ffmpeg
test/activation.test.js mocks `vscode`, activates, and checks that the manifest and the code agree (commands, menus, settings, webview buttons)
test/ui/harness.js      Playwright webview check
```

### Webview ↔ extension messages
- webview → ext: `ready`, `exportSelection{start,end}`, `run{command}` (runs `soundLab.<command>` on this file), `analyze`, `spectrogram{width}`, `silence`, `transcribe`, `copy{text}`
- ext → webview: `info`, `audio{src}`, `peaks{peaks}`, `levels{report}`, `spectrogram{src}`, `regions{silences,segments}`, `transcript{segments}`, `busy`, `toast`, `error`

## Conventions (follow these)

- **Never build shell strings.** Every ffmpeg call takes an argv array from `core/recipes.ts`. Filter option values that contain user paths must go through `escapeFilterValue()`, which applies the two levels of ffmpeg escaping.
- **Never overwrite the source.** Outputs go through `outputFor(src, suffix, ext)` / `uniquePath()`, which respect `soundLab.output.*`.
- Long work goes through `job(title, (report, signal) => …)` and `ff(args, duration, report, signal, msg, from, to)`, so the user gets progress, Cancel and logging.
- Edits keep the source format and bit depth (`sameFormatEncode`). New material uses `defaultEncode`.
- Commands accept `(arg, args)` from explorer, tree, editor-title or palette, and resolve files with `resolveTargets()`.
- **Adding a command touches 4 places:** `package.json` → `contributes.commands` (+ menus), `extension.ts` command map, `commands.ts` implementation, and a test. `test/activation.test.js` fails if these drift apart. Use the `/add-command` skill.
- **Adding a setting:** declare it in `package.json` `contributes.configuration`. The activation test fails if code reads an undeclared `soundLab.*` key.
- Webview: no inline scripts or styles (strict CSP with a nonce). Any new local resource directory must be added to `localResourceRoots`.
- Keep `core/` free of `vscode` imports. Core behaviour is tested in `test/core.test.js` by generating signals with lavfi, not with checked-in audio fixtures.

## Hard-won gotchas (don't regress these)

- The `-f segment` muxer cuts at packet boundaries (~23 ms off). Sample-accurate slicing uses the `asegment=samples=…` filter (`sliceAt`, `slicePoints`). `slicePoints` rounds each cut independently, so fractional BPM slice lengths never drift.
- `-ss <t> -t <d>` **before** `-i`, with re-encoding, is sample-exact for both PCM and MP3. This is verified, so keep it that way in `trim()`.
- The lavfi `sine` source has an amplitude of 1/8 (−18 dBFS). Use `aevalsrc` when the level matters (`generate()`).
- `loudnorm` upsamples internally to 192 kHz. Always set `-ar` back (`loudnormApply` does this). Two-pass with `linear=true` is required for accurate targets.
- Opus only accepts 8, 12, 16, 24 or 48 kHz. `codecArgs` coerces other rates to 48 k.
- FLAC 24-bit needs `-sample_fmt s32 -bits_per_raw_sample 24`.
- The `showspectrumpic` legend adds fixed margins. The plot starts at x=141, and the image is 282 px wider than the requested width (`editor.js` relies on this for click-to-seek).
- VS Code's Chromium can't play AAC, AIFF or WMA. `playableSource()` transcodes them to a cached FLAC under globalStorage.
- `[hidden]` must be `display:none !important` in CSS, because `.loading{display:flex}` otherwise keeps the overlay visible.
- Never use `scrollIntoView` in the webview. It scrolls the whole page away from the waveform mid-click (and breaks double-click). Scroll the list container's `scrollTop` instead.
- Recording stops with `gracefulStop` (sends `q`). ffmpeg then exits 255, and `run()` treats that as success.
- `alimiter level=` is a boolean: use `0`/`1`, not `disabled`.
- The ffmpeg 6.x on the dev box has **no `whisper` filter**. That backend is only covered by its "missing filter" error-path test.

## Verifying changes

1. `npm test`. All suites must pass. Add a test in `test/core.test.js` for any new recipe or effect, and assert durations, codecs or levels with ffprobe.
2. If you touched `media/` or `audioEditor.ts`: run `npm run test:ui` and look at `test/ui/out/editor.png`.
3. `npm run package` must succeed before you report a change as done.

## Claude Code plugin (plugins/sound-lab-studio)
- MCP server `mcp/server.js` is plain Node (no deps). Keep it that way so the plugin works straight from a git clone.
- Every ffmpeg output path goes through `prepareOutputs()`. **ffmpeg 6.x `-n` exits 0 without writing when the output exists**, so never rely on it.
- `sidechaincompress` ends when its key input ends. `dub.js` pads the key with `apad`, otherwise the music bed is cut at the end of the voice.
- `mlx[cuda12]` cannot even `import` without the host NVIDIA driver (`libcuda.so.1`). Only the `:cpu` image is import-checked at build time.
- Docker Desktop / Apple `container` on macOS have no Metal: MLX there is CPU-only. Native mode is the Apple-GPU path.
- `aecho` extends output by its longest delay (keyboard-synth adds a 347 ms tail).
