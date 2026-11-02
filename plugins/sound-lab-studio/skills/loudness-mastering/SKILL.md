---
name: loudness-mastering
description: Loudness targets and mastering chains with FFmpeg — EBU R128 / LUFS, true peak, LRA, two-pass loudnorm, limiting, and per-platform delivery specs (Spotify, Apple, YouTube, podcasts, broadcast, games). Use when normalizing, mastering or checking levels of music, dubs, podcasts or SFX.
---

# Loudness & mastering

## Targets
| Destination | Integrated | True peak | Notes |
|---|---|---|---|
| Spotify / YouTube / Tidal / Amazon | −14 LUFS | −1 dBTP | Spotify "loud" mode uses −11 LUFS. Leave −2 dBTP for lossy encodes of very loud masters |
| Apple Music | −16 LUFS | −1 dBTP | Sound Check |
| Podcasts (Apple, Spotify) | −16 LUFS (stereo), −19 LUFS (mono) | −1 dBTP | |
| EBU R128 broadcast | −23 LUFS ±0.5 | −1 dBTP | LRA ≤ 15 LU typical |
| ATSC A/85 (US TV) | −24 LKFS | −2 dBTP | |
| Netflix dialogue-gated | −27 LKFS ±2 | −2 dBTP | Measured on dialogue |
| Games (common practice) | −16 to −18 LUFS for music · SFX peak −1 dBFS | | Let the engine mix |
| Film/TV dubbing stems | −23/−24 LUFS per the deliverable spec | | Match the original M&E |

## Two-pass loudnorm (accurate, linear gain)
```bash
# pass 1 — measure
ffmpeg -hide_banner -i in.wav -af loudnorm=I=-14:TP=-1:LRA=11:print_format=json -f null - 2>&1 | tail -12
# pass 2 — apply measured values; linear=true keeps dynamics (falls back to dynamic mode if it can't hit the target)
ffmpeg -i in.wav -af "loudnorm=I=-14:TP=-1:LRA=11:measured_I=-20.1:measured_TP=-3.2:measured_LRA=6.1:measured_thresh=-30.4:offset=0.3:linear=true" -ar 48000 out.wav
```
- loudnorm resamples to 192 kHz internally. **Always set `-ar`** on the output.
- The MCP presets `normalize-14`, `normalize-23` and `mp3-podcast` do both passes for every file in a batch.

## Mastering chain (music bed, gentle)
```
highpass=f=25, acompressor=threshold=0.25:ratio=2:attack=25:release=250:makeup=1.5,
equalizer=f=3500:t=q:w=1.2:g=1, alimiter=limit=0.891:attack=5:release=50:level=0, loudnorm (two-pass)
```
- Limit **before** the final loudnorm only if the source peaks are wild. loudnorm's own true-peak limiter handles the rest.
- For speech, use `deesser`, `afftdn=nr=10` and `acompressor=threshold=0.1:ratio=3` before loudness.

## Peak normalisation (samples / one-shots)
Measure `max_volume` with `volumedetect`, then apply `volume=<target − max>dB` (e.g. target −1 dBFS). Lossy codecs can overshoot by about 0.5 dB, so target −1.5 dBFS for Ogg/MP3 delivery.

## Verify
```bash
ffmpeg -nostats -i out.wav -filter_complex ebur128=peak=true -f null - 2>&1 | grep -A12 Summary
```
Report integrated LUFS, LRA and true peak back to the user after any loudness change.
