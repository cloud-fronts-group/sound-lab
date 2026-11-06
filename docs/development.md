# Development

How to build, test, package and extend Sound Lab. Numbers here (test counts, package size) were measured on commit `b8adc0b` with Node 22 and FFmpeg 6.1.1.

## Prerequisites

| Need | For |
|---|---|
| Node.js 20 or newer (tested on 22) and npm | building and running the tests |
| VS Code 1.85 or newer | running the extension |
| `ffmpeg` and `ffprobe` with the `libmp3lame`, `libvorbis`, `libopus`, `aac` and `flac` encoders, and the `loudnorm`, `silencedetect`, `showspectrumpic`, `showwavespic` and `astats` filters | the core tests (they run real ffmpeg) |
| [Playwright](https://playwright.dev) with Chromium | the webview UI test |

## Get running

```bash
git clone git@github.com:cloud-fronts-group/sound-lab.git
cd sound-lab
npm install
npm run compile        # tsc → out/
```

Open the folder in VS Code and press **F5**. The `Run Extension` launch configuration compiles first (`preLaunchTask: npm: compile`) and starts an Extension Development Host. For continuous compilation run the `npm: watch` task.

| Script | What it does |
|---|---|
| `npm run compile` | `tsc -p ./` into `out/` |
| `npm run watch` | `tsc -watch -p ./` |
| `npm test` | compile, then `node --test test/*.test.js` |
| `npm run test:ui` | compile, then `node test/ui/harness.js` |
| `npm run test:all` | `npm test && node test/ui/harness.js` |
| `npm run package` | `vsce package --allow-missing-repository` → `sound-lab-<version>.vsix` |

`tsconfig.json` targets ES2022 as CommonJS with `strict` on, `rootDir` `src` and `outDir` `out`.

## Tests

**`npm test`** ran **23 tests in about 20 seconds** here (22 in `test/core.test.js`, 1 in `test/activation.test.js`), all passing. To test against a different FFmpeg build:

```bash
FFMPEG=/opt/ffmpeg-8/bin/ffmpeg FFPROBE=/opt/ffmpeg-8/bin/ffprobe npm test
```

### What the core tests cover

The core tests generate signals with `lavfi` instead of shipping audio files, run the real builders against real ffmpeg, and measure the result with ffprobe or the analysis filters.

| Test | Proves |
|---|---|
| timecode helpers | `parseTimecode` reads `1:02.5`, `01:00:01` and `12.25` and returns NaN for `abc`; `formatTimecode(62.5)` is `1:02.500` |
| capabilities detected | the loudness, silence, spectrogram and stats filters and the FLAC encoder are found |
| generate every signal type | all nine signals come out at 48 kHz, 24-bit, 1 s |
| stereo test file + every output format | each of the 7 formats has the expected codec; FLAC is 24-bit; Opus is coerced to 48 kHz; mono 16-bit 22.05 kHz works |
| trim with fades is sample-accurate | a 1.25 s cut is 1.25 s to within 2 ms |
| silence detection → segments → split | two silences found, three segments, split files have the expected length |
| concat with crossfade shortens total | a 0.25 s crossfade across three files gives 2.5 s |
| two-pass loudness normalization hits target | −16 LUFS within 1 LU, true peak at or below −1 dBTP, 48 kHz restored |
| peak normalization | −6 dB peak becomes −0.1 dB |
| every effect in the catalogue runs | each `EFFECTS` entry runs with its defaults; length-changing effects change length as expected |
| sample-accurate slicing (asegment) | 12 cuts at 128 BPM eighths, no drift, every slice has the exact sample count |
| waveform + spectrogram images, peaks | PNGs are written; the peak extractor finds 0.5 and an RMS of about 0.354 |
| preview transcode + whisper wav prep | FLAC preview and 16 kHz mono 16-bit WAV |
| video: extract audio and mux subtitles | stream-copy and encode extraction; `mov_text` track with the `eng` tag |
| subtitle formats round-trip | SRT and VTT parse back to the same segments; whisper.cpp and OpenAI adapters |
| filter value escaping survives a real filtergraph | a path full of metacharacters round-trips through `escapeFilterValue()` |
| device list parsing | macOS, Windows and Linux device listings parse; recording input arguments |
| recording stops gracefully on abort | a recording aborted after 1.2 s is a valid file |
| transcription: OpenAI-compatible backend | a mock server sees the right URL, auth header, FLAC body, model, format and language |
| transcription: whisper.cpp backend | a fake `whisper-cli`'s JSON output is parsed into segments; progress reaches 99% or more |
| transcription: ffmpeg-whisper backend | a build without the filter gives the clear error |
| missing executable gives a helpful error | `Executable not found` |

### The activation test

`test/activation.test.js` activates the extension against a minimal mock of `vscode` and asserts that:

- every command in `contributes.commands` is registered in `extension.ts`, and nothing is registered that is not declared;
- the tree provider and the custom editor are registered, and the custom editor's view type is `soundLab.audioPreview`;
- every command referenced in a menu is declared;
- every `get<…>('key')` in `src/` has a matching `soundLab.key` in `contributes.configuration`;
- every `data-run="…"` button in the editor HTML maps to a declared `soundLab.*` command.

Its failure messages are explicit. **Real output** when the registration was removed, and when code read an undeclared setting:

```text
declared in package.json but not registered in extension.ts: soundLab.reverse
setting soundLab.reverse.fadeMs is read but not declared
```

### Running one test

Pass a regular expression to `--test-name-pattern`. **The core tests share fixtures**: they all write into one temporary folder, and several reuse files that earlier tests created. A single test run on its own can therefore fail with "No such file or directory". On a clean checkout, `node --test --test-name-pattern="slicing" test/*.test.js` fails this way (and so does the `"effect"` pattern in the add-effect skill's instructions). Include the test that creates the fixture:

```bash
# the slicing test needs stereo.wav
node --test --test-name-pattern="stereo test file|sample-accurate slicing" test/core.test.js

# the effect catalogue needs stereo.wav
node --test --test-name-pattern="stereo test file|every effect" test/core.test.js
```

| Fixture | Created by | Needed by |
|---|---|---|
| `stereo.wav`, `conv.*` | "stereo test file + every output format" | trim, every effect, slicing, images and peaks, preview transcode, the OpenAI-compatible and whisper.cpp transcription tests |
| `gen_*.wav` | "generate every signal type" | concat with crossfade, peak normalization, images and peaks, filter escaping |

The silence, loudness, video, device, subtitle and timecode tests are self-contained.

### The webview UI test

`npm run test:ui` runs `test/ui/harness.js`. It builds the editor's real HTML with `AudioEditorProvider.html()` (loading it with a mocked `vscode`), opens it in Chromium via Playwright in a dark and a light theme, feeds it real ffmpeg output (peaks, levels, silences, a spectrogram, a placeholder transcript) and asserts behaviour. It passed **29 of 29 checks**: the CSP check, plus 14 per theme.

| Check (per theme) | |
|---|---|
| Loading overlay hides once peaks arrive | Duration shown (`0:08.000`) |
| Metadata chips rendered | 8 sound regions listed |
| Transcript rows rendered | Levels panel rendered |
| Drag creates a selection (export enabled) | `exportSelection` posts about 2.40–3.36 s |
| Clicking the waveform does not scroll the page | Double-click selects region #5 |
| Transcript click seeks to line 3 | Canvas renders after zoom |
| **Effects…** button posts `run` / `applyEffects` | No page errors |

Screenshots land in `test/ui/out/editor-dark.png` and `editor-light.png`. If Playwright is missing, the harness prints how to install it: `npm i -D playwright && npx playwright install chromium`. The harness strips the CSP `<meta>` before loading the page from `file://`, so the CSP itself is checked only by matching its text in the generated HTML.

## Packaging and release

`npm run package` compiles (via `vscode:prepublish`) and runs `vsce`. What goes into the VSIX is controlled by `.vscodeignore`:

```text
src/**
test/**
**/*.map
tsconfig.json
node_modules/**
.vscode/**
*.vsix
.claude/**
CLAUDE.md
.gitignore
docs/**
```

The package is **21 files, 146 KB**: `package.json`, the README, LICENSE and CHANGELOG, the compiled `out/` JavaScript, and `media/`. `docs/**` is excluded on purpose: with the screenshots, `docs/` would add 6 files and push the VSIX from 146 KB to about 1.9 MB.

The release flow is the `/release` skill:

1. `/verify` first (compile and test, UI test if the webview changed, `npm run package`, `git status`).
2. Bump `version` in `package.json` (new commands or settings: minor; fixes only: patch).
3. Add a `## <version>` section to `CHANGELOG.md`.
4. `npm run package` and confirm `sound-lab-<version>.vsix` exists.
5. Commit `Release v<version>` and tag `v<version>`.
6. Install with `code --install-extension sound-lab-<version>.vsix`.

Publishing to the Marketplace is deliberately not part of it: `.claude/settings.json` denies `vsce publish`, because it needs your publisher token.

## Repository layout

```text
.claude/            Claude Code project setup: settings, hook, skills, agents
.vscode/            launch.json (F5), tasks.json, extensions.json
docs/               this documentation (excluded from the VSIX)
media/              editor.js, editor.css, icon.png, activity.svg
src/                extension.ts, commands.ts, util.ts, audioEditor.ts, sampleExplorer.ts, core/*.ts
test/               core.test.js, activation.test.js, ui/harness.js
.gitignore  .vscodeignore  CHANGELOG.md  CLAUDE.md  LICENSE  README.md  package.json  package-lock.json  tsconfig.json
```

`out/`, `node_modules/`, `*.vsix` and `test/ui/out/` are git-ignored.

## Conventions

Condensed from `CLAUDE.md`; the full list and the FFmpeg gotchas are there and in [FFmpeg internals](ffmpeg-internals.md#14-gotchas-the-code-already-handles).

- Never build shell strings; every ffmpeg call is an argv array from `core/recipes.ts`. Run user paths that land inside a filter value through `escapeFilterValue()`.
- Never overwrite the source. Use `outputFor(src, suffix, ext)` and `uniquePath()`.
- Long work goes through `job()` and `ff()`.
- Edits use `sameFormatEncode`; new material uses `defaultEncode`.
- Commands accept `(arg, args)` and resolve files with `resolveTargets()`.
- Keep `src/core/` free of `vscode` imports; test core behaviour with generated signals.
- Webview: no inline scripts or styles; add any new local resource folder to `localResourceRoots`.

## Add a command

A command touches four places, and the activation test fails if they drift apart. This walk-through adds an illustrative **Reverse…** command. (The same result is available today through **Apply Effects → Reverse**.) The steps below were applied to a scratch copy and the activation test passed.

**1. `package.json`: declare it and put it in menus.**

```jsonc
// contributes.commands
{ "command": "soundLab.reverse", "title": "Reverse…", "category": "Sound Lab" }

// contributes.menus["soundLab.explorerMenu"]
{ "command": "soundLab.reverse", "group": "2_edit@7", "when": "!explorerResourceIsFolder" }

// contributes.menus["view/item/context"]
{ "command": "soundLab.reverse", "when": "view == soundLab.samples && viewItem == soundLab.file", "group": "2_edit@5" }
```

**2. `src/extension.ts`: register it in the command map.**

```ts
'soundLab.reverse': C.cmdReverse,
```

**3. `src/commands.ts`: implement it.** The shape is always the same: resolve, prompt, `job`, name, `announce`.

```ts
export async function cmdReverse(arg?: unknown, args?: unknown): Promise<void> {
  const uris = await resolveTargets(arg, args, { many: true, title: 'Reverse' });
  if (!uris.length) { return; }
  const created: string[] = [];
  await job(`Reversing ${uris.length} file(s)`, async (rep, signal) => {
    for (let i = 0; i < uris.length; i++) {
      const src = uris[i].fsPath;
      const s = await summaryOf(src);
      const enc = sameFormatEncode(src, s);
      const out = outputFor(src, 'reversed', enc.format);
      await ff(R.applyFilter(src, out, 'areverse', enc), s.duration, rep, signal,
        path.basename(src), i / uris.length, (i + 1) / uris.length);
      created.push(out);
    }
  });
  await announce(created);
}
```

**4. `test/core.test.js`: test the ffmpeg behaviour** with generated input (new builders go in `core/recipes.ts` first). This test passed in the scratch copy; it relies on the `stereo.wav` fixture, so place it after the test that creates it:

```js
test('reverse keeps the duration', async () => {
  await ff(R.applyFilter(p('stereo.wav'), p('rev.wav'), 'areverse', enc));
  assert.ok(Math.abs((await info(p('rev.wav'))).duration - 3) < 0.05);
});
```

Then update the command table in the README and `CHANGELOG.md`. To expose the command as a button in the editor, add `<button data-run="reverse">Reverse…</button>` to the HTML in `audioEditor.ts`; the activation test checks that the ID maps to a command. The `/add-command` skill walks through the same steps.

## Add a setting

1. Declare it in `package.json` under `contributes.configuration.properties` with a type, default and description.
2. Read it with `cfg().get<T>('your.key')` (the `soundLab.` prefix is implied).
3. Run `npm test`. If you skip step 1 the activation test fails with `setting soundLab.your.key is read but not declared`.
4. Document it in [Configuration](configuration.md).

## Add an effect

The picker, the parameter prompts and the "every effect runs" test all read the `EFFECTS` array in `src/core/recipes.ts`, so one entry is enough. This **Tremolo** entry was added to a scratch copy and passed the catalogue test:

```ts
{ id: 'tremolo', label: 'Tremolo', detail: 'tremolo',
  params: [{ key: 'f', label: 'Rate Hz', default: 5 }, { key: 'd', label: 'Depth 0–1', default: 0.5 }],
  build: p => `tremolo=f=${p.f}:d=${p.d}` },
```

1. Check the filter exists and read its options: `ffmpeg -hide_banner -filters | grep tremolo` and `ffmpeg -hide_banner -h filter=tremolo`.
2. Prototype on a generated signal: `ffmpeg -v error -f lavfi -i "sine=f=220:d=3" -af "tremolo=f=5:d=0.5" -y /tmp/fx.wav`.
3. Add the entry. `build` receives the user's values as **strings** and a context with the source `sampleRate`.
4. Run the catalogue test with its fixture: `node --test --test-name-pattern="stereo test file|every effect" test/core.test.js`. Add a duration or channel assertion if the effect changes them.
5. Add a row to [Effects](effects.md). The `/add-effect` skill automates steps 1 to 5.

## Add a transcription backend

1. Add the value to the `Backend` type and the settings you need to `TranscribeConfig` (`core/transcribe.ts`).
2. Write `viaYourBackend(input, duration, cfg, hooks, work)` returning `Segment[]`, and add a case to the `switch` in `transcribe()`.
3. Declare the new enum value (and any settings) in `package.json`, and read the settings in `transcribeConfig()` in `commands.ts`.
4. Add a mock-based test next to the existing ones: a mock HTTP server, a fake CLI, or an error-path test.
5. Update [Transcription](transcription.md).

## Working with Claude Code

The repository is set up as a Claude Code project.

**Permissions** (`.claude/settings.json`). Allowed without asking: `npm run compile|watch|test|test:ui|test:all|package`, `npx tsc`, `node --test`, `node test/ui/harness.js`, `ffmpeg`, `ffprobe`, and read-only git (`status`, `diff`, `log`) plus `git add`. Denied: `vsce publish`, `git push --force`, and reading `./.env` or `*.key` files.

**Post-edit hook** (`.claude/hooks/check-edit.js`). After Claude edits a file, the hook runs a quick check and feeds problems back so Claude fixes them immediately:

| File edited | Check |
|---|---|
| `src/core/**/*.ts` | rejects any `vscode` import |
| `package.json` | must be valid JSON; then the compile and wiring check below |
| `src/**/*.ts` or `package.json` | `npx tsc -p .`, then `node --test test/activation.test.js` |
| `media/*.js` | `node --check` for syntax |

**Skills** (slash commands):

| Skill | Use it to |
|---|---|
| `/add-command <idea>` | add a command with all four wiring points and a test |
| `/add-effect <effect>` | add and prove an effect |
| `/ffmpeg-explore <topic>` | investigate what your local FFmpeg build can do before designing a feature |
| `/verify` | compile, run all tests, check the VSIX, and `git status` |
| `/release patch\|minor\|major` | bump the version, update the changelog, package and tag (never publishes) |

**Agents**:

| Agent | Role |
|---|---|
| `ffmpeg-expert` | designs and debugs argv and filtergraphs, proving each claim on generated signals |
| `transcription-engineer` | owns `core/transcribe.ts` and `core/subtitles.ts`; checks provider docs before changing requests |
| `extension-reviewer` | an independent review of a diff against the project's conventions before work is called done |

`CLAUDE.md` holds the architecture, conventions and gotchas that Claude reads at the start of every session.
