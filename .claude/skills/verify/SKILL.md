---
name: verify
description: Full verification of the Sound Lab extension before declaring work done — compile, ffmpeg integration tests, manifest wiring, webview UI check with screenshots, and VSIX packaging.
---

# Verify Sound Lab

Run each step and stop at the first failure. Fix the root cause rather than weakening a test.

1. `npm test`: TypeScript compile, plus the integration suite against real ffmpeg, plus the manifest wiring check.
2. `npm run test:ui`: this is required if `media/`, `src/audioEditor.ts` or the webview messages changed. Then **look at** `test/ui/out/editor-dark.png` and `editor-light.png` with the Read tool. Check that the waveform, selection, panels and text all stay readable in both themes.
3. `npm run package`: it must produce `sound-lab-<version>.vsix` with no warnings about missing files. `.vscodeignore` keeps `src/` and `test/` out of the VSIX. Confirm the file count is still around 20 and the size is about 150 KB or less.
4. `git status`: check that only the files you meant to change are modified, and that `out/`, `*.vsix` and `test/ui/out/` are ignored.

Report each step as one line: pass/fail with counts (e.g. "23/23 core tests, 26/26 UI checks, VSIX 21 files / 135 KB").
