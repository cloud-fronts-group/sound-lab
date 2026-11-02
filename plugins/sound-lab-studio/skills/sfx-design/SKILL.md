---
name: sfx-design
description: Design sound effects procedurally with FFmpeg — whooshes, risers, impacts, lasers, UI clicks/confirms, coins, explosions, wind, rain, heartbeats, power-downs, alarms — with seeded pitch/time variations and game-ready export (peak-normalised, click-free, Ogg/WAV). Also layer/process existing recordings into new effects. Use for game audio, UI sounds, trailers and video stingers.
argument-hint: "<effect or description> [variations <n>] [format ogg|wav] [-> dir]"
---

# Sound-effect design

Request: $ARGUMENTS

## 1. Start from a recipe
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sfx.js" list
node "${CLAUDE_PLUGIN_ROOT}/scripts/sfx.js" make impact --duration 1.8 --out sfx/impact.wav
node "${CLAUDE_PLUGIN_ROOT}/scripts/sfx.js" make laser --variations 6 --spread 3 --seed 42 --out sfx/laser.ogg   # laser_01…06
node "${CLAUDE_PLUGIN_ROOT}/scripts/sfx.js" pack --out sfx-pack --format ogg --names whoosh,impact,coin,ui-click
```
Every output is mono 48 kHz, has 3 ms / 80 ms fades and peaks at −1 dBFS (`--peak`). `--pitch` shifts tape-style (pitch and length together). Variations randomise pitch within ±`--spread` semitones and length within ±10%, reproducibly with `--seed`.

## 2. Shape it (layering & processing)
Layer a recipe with a recording or another recipe, offset in time:
```bash
ffmpeg -i impact.wav -i whoosh.wav -filter_complex "[1]adelay=0[w];[0]adelay=900[i];[w][i]amix=inputs=2:normalize=0,alimiter=limit=0.89:level=0" trailer_hit.wav
```
Useful moves:
- **Bigger**: `asetrate=48000*0.7,aresample=48000` (an octave-ish down), plus `aecho=0.8:0.6:70|160:0.35|0.25`.
- **Distance**: `lowpass=f=2500,aecho=0.6:0.5:120:0.4,volume=-8dB`.
- **Grit**: `acrusher=bits=8:samples=6:mode=log` or `asoftclip=type=atan`.
- **Movement**: `aphaser`, `flanger`, `vibrato=f=7:d=0.3`, or auto-pan `apulsator=hz=0.5`.
- **Reverse swell**: `areverse,aecho=0.8:0.9:200:0.5,areverse` (the reverb tail leads into the hit).
- **Tighten**: `silenceremove=start_periods=1:start_threshold=-50dB` and a trailing fade.

## 3. From a recording
Trim to the transient (`silenceremove`), remove rumble (`highpass=f=40`), de-noise (`afftdn=nr=12`), then normalise the peak. For many files at once use the `sfx-pack` skill (MCP batch).

## 4. Deliver
- Games: Ogg Vorbis q6 (`ogg-game` preset) or 16-bit WAV. Mono for 3D/positional sounds, stereo for UI and music stingers. Name as `category_name_variant_##.ogg`.
- Video/trailers: 24-bit WAV at 48 kHz.
Report each file with its duration and peak level (the PostToolUse hook prints them).
