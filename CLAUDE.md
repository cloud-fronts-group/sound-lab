# Sound Lab — VS Code extension (FFmpeg audio toolkit)

This TypeScript VS Code extension covers sound sampling, editing, analysis and speech-to-text. All the work is done by shelling out to the user's `ffmpeg`, `ffprobe` and (optionally) `whisper-cli`. It has no runtime npm dependencies.

## Commands

```bash
npm run compile      # tsc → out/
npm test             # compile + node:test suites in test/*.test.js (needs ffmpeg/ffprobe on PATH; ~100 s, studio.test.js is ~70 s of that)
npm run test:ui      # renders the real editor webview in Chromium with real ffmpeg data, asserts + screenshots → test/ui/out/
npm run package      # → sound-lab-<version>.vsix
node --test --test-name-pattern="slicing" test/*.test.js   # run one test
```

Use `FFMPEG=/path FFPROBE=/path npm test` to test against a different ffmpeg build.

## Repository layout
- VS Code extension: `src/`, `media/`, `test/`, `package.json` (everything below until "Claude Code plugin").
- Claude Code plugin marketplace: `.claude-plugin/marketplace.json` → `plugins/sound-lab-studio/` (skills, agents, hooks, zero-dependency MCP server in `mcp/`, scripts, containers). Tests: `cd plugins/sound-lab-studio && npm test`. Validate: `claude plugin validate plugins/sound-lab-studio && claude plugin validate .`
- Container images: `plugins/sound-lab-studio/containers/` (built by `.github/workflows/containers.yml` to GHCR).

## CI, versioning and releases
- `.github/workflows/ci.yml` runs on every PR and push to `main`: version lockstep check, `npm test` (Ubuntu Node 20/22 + macOS), `npm run test:ui` (Playwright; screenshots uploaded as an artifact), plugin tests (Node 20/22) + `claude plugin validate`, and a VSIX artifact.
- **One version for everything.** `package.json`, `package-lock.json`, `plugins/sound-lab-studio/package.json` and its `.claude-plugin/plugin.json` must always match. Change them only with `node scripts/version.js bump <patch|minor|major|X.Y.Z>`, never by hand (`node scripts/version.js check` is in CI).
- Every user-visible change adds a line under `## Unreleased` in `CHANGELOG.md`. A release refuses to run if that section is empty, and its text becomes the GitHub release notes.
- Releasing: Actions → **Release** → Run workflow (on `main`, pick patch/minor/major). It runs CI, commits `Release vX.Y.Z` + tag to `main`, builds `sound-lab-X.Y.Z.vsix`, `sound-lab-studio-X.Y.Z.zip` and `SHA256SUMS.txt`, creates the GitHub release, publishes to the VS Code Marketplace / Open VSX when the `VSCE_PAT` / `OVSX_PAT` secrets exist in the `marketplace` environment, and pushes `:X.Y.Z`-tagged GHCR images. Pushing a `vX.Y.Z` tag yourself runs the same pipeline.

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
  mlx.ts           MlxController: settings → MlxAudioClient/StudioManager, status bar, MLX commands
  mlxPanel.ts      Sidebar webview view `soundLab.mlxPanel` (TTS, STT, separation, voices)
  studioPanel.ts   "Sound Lab Studio" tab: Create + DJ ribbons, drawers (media/studio.js), embedded mlx-audio Studio iframe
  voiceCloneWizard.ts  Voice Clone wizard webview (record → build → create)
  core/mlxAudio.ts     mlx-audio HTTP client + server/Studio lifecycle (no vscode)
  core/voiceClone.ts   prompts, take checks, reference, profiles, audiobook/presentation/vocals renderers (no vscode)
  core/theory.ts       keys, scales, chord symbols (roman numerals + names), progressions, voicing, snapMidi
  core/synth.ts        Stereo buffers (wrap = seamless loops), instruments, drum voices, SVF filter, float WAV writer
  core/composer.ts     beats / chords / instrumentals (genres) + layerOnto(); core/sfx.ts lavfi effect recipes
  core/audioio.ts      decode → Stereo (f32 pipe), master() (reverb, glue, LUFS, limiter; loops rendered twice), encode()
  core/autotune.ts     YIN tracker, correction curve (hysteresis, retune ms, amount), TD-PSOLA shifter
  core/beatgrid.ts     onset novelty, tempo (+ candidates × prior), downbeats (chroma flux), drop + key detection
  core/dj.ts           backspin, echo out, beat jump, transition (quick/long), double drop, centerSplit, mashup
  studioTools.ts       VS Code glue for all Studio tools: output paths/formats, jobs, one-click DJ/auto-tune commands
  extension.ts     activate(): registers the command map, views, editor, status bar
media/editor.js    webview script (plain JS, // @ts-check). It talks to audioEditor.ts via postMessage.
media/editor.css   webview styles. Use VS Code theme variables only, so it works in light and dark themes.
test/core.test.js       integration tests against real ffmpeg
test/activation.test.js mocks `vscode`, activates, and checks that the manifest and the code agree (commands, menus, settings, webview buttons)
test/studio.test.js     theory, composer, SFX, auto-tune (pitch in cents), beat grid and every DJ move against real ffmpeg (~70 s)
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

- mlx-audio reads `ref_audio` as a **path on the server's filesystem** (no upload). Voice references live in `globalStorage/voices` and are mounted read-only at `/soundlab/voices` for container modes (`MlxAudioClient.serverPath`).
- mlx-audio Studio (`mlx_audio/ui`, Next.js) is **not in the pip wheel**. `StudioManager` locates or downloads it and runs `next dev` with `NEXT_PUBLIC_API_BASE_URL`/`NEXT_PUBLIC_API_PORT` pointing at the managed server. Embed it via `asExternalUri` and add the origin to `frame-src`.
- Webview CSP forbids inline `style="…"` attributes, including in `innerHTML` templates. Use classes, or set `element.style` from script. The UI harnesses run under the real CSP, so violations fail the run.
- MP4 drops the `title` stream tag. Write `handler_name` too.
- A lavfi "microphone" renders faster than real time. Add `arealtime` when it stands in for live recording.

## Verifying changes

1. `npm test`. All suites must pass. Add a test in `test/core.test.js` for any new recipe or effect, and assert durations, codecs or levels with ffprobe.
2. If you touched `media/` or any webview: run `npm run test:ui` (editor harness plus the end-to-end mlx-audio harness; set `MLX_STUDIO_DIR` to an installed `mlx_audio/ui` to include the embedded Studio) and look at `test/ui/out/*.png`.
3. `npm run package` must succeed before you report a change as done.

## Claude Code plugin (plugins/sound-lab-studio)
- MCP server `mcp/server.js` is plain Node (no deps). Keep it that way so the plugin works straight from a git clone.
- Every ffmpeg output path goes through `prepareOutputs()`. **ffmpeg 6.x `-n` exits 0 without writing when the output exists**, so never rely on it.
- `sidechaincompress` ends when its key input ends. `dub.js` pads the key with `apad`, otherwise the music bed is cut at the end of the voice.
- `mlx[cuda12]` cannot even `import` without the host NVIDIA driver (`libcuda.so.1`). Only the `:cpu` image is import-checked at build time.
- Docker Desktop / Apple `container` on macOS have no Metal: MLX there is CPU-only. Native mode is the Apple-GPU path.
- `aecho` extends output by its longest delay (keyboard-synth adds a 347 ms tail).

## Studio tools (Create + DJ) gotchas
- Loops (`Stereo(…, wrap=true)`) wrap note tails to the start, and `master()` renders them twice with `-stream_loop 1` and keeps the second copy. That keeps reverb, compressor and limiter state seamless and the length sample-exact. Don't add filters after the `atrim`.
- `alimiter` needs `latency=1`, or it delays the signal by its attack. The ceiling is 0.79 (−2 dBFS sample peak), because drum transients overshoot about 1.4 dB between samples.
- Tempo has an inherent half/double ambiguity. Detection scores candidates (×2, ×½, ×3/2, ×2/3) by a kick+snare comb times a prior around 115 BPM. Tests accept ±octave, and the UI offers ×2 / ÷2. Pass a BPM hint to `detectBeatGrid` for an exact refinement.
- Downbeats come from chroma flux across each beat (harmony changes on bar lines), then kick strength, then snare backbeat. Four-on-the-floor alone can't tell beat 1 from beat 3.
- Preset progressions are written for major or minor. In the other mode they play in the relative key (`pop` in A minor → C G Am F), so chords stay diatonic to what auto-tune and the bass use.
- Auto-tune uses PSOLA, not a delay-line shifter. A doppler/two-tap shifter comb-filters even at ratio 1. PSOLA with synthesis marks equal to analysis marks reconstructs the input (amount 0 → SNR > 40 dB). YIN runs on audio decimated to about 24 kHz for speed.
- `atempo` is used to tempo-match (pitch preserved). Key shift = `asetrate`·`aresample`·`atempo(1/p)`. `rescaleGrid()` re-lays the grid at the target tempo, so a folded half-time track gets bars of the right length.
- Center-channel separation needs stereo. Mono or L=R input throws and suggests mlx-audio. mlx-audio separation is asked for `description: 'vocals'`: target = acapella, residual = instrumental.
