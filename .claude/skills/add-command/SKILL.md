---
name: add-command
description: Add a new Sound Lab command (palette + menus + implementation + test), wired consistently across package.json, extension.ts and commands.ts. Use whenever a new user-facing action is requested.
argument-hint: "<what the command should do>"
---

# Add a Sound Lab command

Goal: $ARGUMENTS

Work through these steps in order. The activation test (`test/activation.test.js`) and the post-edit hook fail if any wiring is missing.

1. **Recipe (pure ffmpeg)**: if the command needs new ffmpeg arguments, add a builder to `src/core/recipes.ts`. It must return an argv array, never a shell string. Run any path that lands inside a filter option value through `escapeFilterValue()` (in `core/transcribe.ts`). Start with `...ffBase()` and use `codecArgs(enc)` for the output.
2. **Test the recipe first** in `test/core.test.js`. Generate input with lavfi (`R.generate`, `sine`, `anoisesrc`), run it with `ff(...)`, and assert the result with `info()` / ffprobe (duration to the sample where it matters, codec, channels, levels). Run it: `node --test --test-name-pattern="<name>" test/*.test.js`.
3. **Implementation**: add `export async function cmdXxx(arg?: unknown, args?: unknown)` to `src/commands.ts`:
   - `const uris = await resolveTargets(arg, args, { many: true })` (or `{ video: true }`)
   - ask for options with QuickPick or `askNumber`, and default them from `cfg()`
   - `outputFor(src, '<suffix>', enc.format)`, so the source is never overwritten
   - `await job('Title', (rep, signal) => ff(args, duration, rep, signal, 'msg'))`
   - `await announce(createdFiles)`
4. **Register** it in `src/extension.ts` → the `commands` map, as `'soundLab.xxx': C.cmdXxx`.
5. **Manifest**: in `package.json` → `contributes.commands`, add `{ "command": "soundLab.xxx", "title": "…", "category": "Sound Lab" }`. Then add it to the relevant menus: `soundLab.explorerMenu` (with a `when` clause for files or folders), `view/item/context` (`viewItem == soundLab.file`), and optionally `editor/title`.
6. **Settings**: any new `cfg().get('foo.bar')` needs a matching `soundLab.foo.bar` in `contributes.configuration`.
7. Optional: add a button to the editor webview with `data-run="xxx"` in `audioEditor.ts`.
8. Update the README command table and `CHANGELOG.md`.
9. Run `/verify`.
