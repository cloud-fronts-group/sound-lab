---
name: add-effect
description: Add an audio effect to the "Apply Effects / Filter Chain" catalogue (EFFECTS in src/core/recipes.ts) and prove it works with real ffmpeg. Use for requests like "add a vocoder / tremolo / tape-stop effect".
argument-hint: "<effect name or description>"
---

# Add an effect to the catalogue

Effect: $ARGUMENTS

1. Find the right ffmpeg filter or chain: `ffmpeg -hide_banner -h filter=<name>` shows its options. Check that the filter exists in the local build (`ffmpeg -hide_banner -filters | grep <name>`). If it's an optional library filter (rubberband, ladspa, lv2…), say that in `detail` and expect some users not to have it.
2. Prototype it on a generated signal before writing any code:
   ```bash
   ffmpeg -v error -f lavfi -i "sine=f=220:d=3" -af "<chain>" -y /tmp/fx.wav && ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/fx.wav
   ```
   Listen to the result if you can, or check it with `-af astats` / `volumedetect`.
3. Add an entry to `EFFECTS` in `src/core/recipes.ts`:
   `{ id, label, detail, params: [{ key, label, default }], build: (p, ctx) => '<filter string>' }`
   - `ctx.sampleRate` is the source rate. Use it for rate-dependent filters (see `pitch` and `varispeed`).
   - The values in `p` are strings typed by the user. Convert them with `+p.x` and keep the defaults sensible.
   - If the effect changes the duration, document that in `detail`.
4. `test/core.test.js` → `every effect in the catalogue runs` already exercises every entry with its default params. If the effect changes length or channels in a predictable way, add a duration or channel assertion there.
5. Run `node --test --test-name-pattern="effect" test/*.test.js`, then `/verify`.
