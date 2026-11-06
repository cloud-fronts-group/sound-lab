# Images

| File | Original name | Where it is used | What it shows |
|---|---|---|---|
| `convert-format-picker.png` | `Screenshot 2026-11-03 at 12.46.14 PM.png` | [Getting started](../getting-started.md), [Commands](../commands.md) | The "Convert to…" format picker |
| `effects-picker.png` | `Screenshot 2026-11-03 at 12.46.01 PM.png` | [Effects](../effects.md), [Sound Lab Studio](../studio.md) | The "Pick effects" multi-select over a DJ-styled editor |
| `studio-text-to-speech.png` | `Screenshot 2026-11-03 at 12.46.29 PM.png` | [Sound Lab Studio](../studio.md) | The Text to speech panel with its model list open |
| `sound-lab-studio.png` | `Screenshot 2026-11-03 at 12.48.27 PM.png` | [Index](../README.md), [Sound Lab Studio](../studio.md) | The Sound Lab Studio screen with the Instrumental tool |
| `audio-editor-dark.png` | generated, not a screenshot | [Index](../README.md), [Audio editor](../audio-editor.md) | The audio editor with all panels open |

The first four are the screenshots taken on 2026-11-03 and copied byte for byte from the Downloads folder; only their names changed (the originals contain a narrow no-break space before "PM", which makes them awkward to link).

`audio-editor-dark.png` is produced by the repository's own UI test. To regenerate it:

```bash
npm install
npm install --save-dev playwright && npx playwright install chromium   # once, if Playwright is missing
npm run test:ui                                                          # writes test/ui/out/editor-dark.png and editor-light.png
cp test/ui/out/editor-dark.png docs/images/audio-editor-dark.png
```

It uses a synthetic 8-second signal and placeholder transcript lines, not real speech.
