---
name: dub-music
description: Dub a voice-over (announcer, narration, ad read, DJ drop) onto a music bed with automatic sidechain ducking, timing offset, fades and loudness targeting. Use for "put this voice over that track", radio imaging, podcast intros, ad spots.
argument-hint: "<music file> <voice file> [at <seconds>] [target <LUFS>]"
---

# Dub a voice onto music

Request: $ARGUMENTS

1. **Probe both files** (MCP `probe`, or `ffprobe`). Note the durations, sample rates and channels. If the voice is very quiet or noisy, clean it first: `highpass=f=80,afftdn=nr=10,acompressor=threshold=0.1:ratio=3`.
2. **Need a voice?** If the user only has a script, generate one with the `voice-over` skill (MLX TTS) and use that file.
3. **Build the mix** with the plugin's builder. It does sidechain ducking (the music dips under the voice and recovers), a voice offset, fades and single-pass loudness:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dub.js" music --music "<music>" --voice "<voice>" --voice-at 2.5 \
        --duck 8 --threshold 0.03 --music-gain -2 --fade-in 0.5 --fade-out 3 --target -16 --out "<name>_dub.wav"
   ```
   - Add `--print` to review the ffmpeg command, `--run` to execute it now, or `--json` to get argv for the MCP `run_ffmpeg` tool (background, for long beds).
   - `--until voice` keeps going until the voice ends if it's longer than the music.
   - Ducking depth comes from `--duck` (ratio, 4 = gentle, 10+ = hard). `--release` (ms) controls how fast the music comes back.
   - Targets: −14 LUFS (streaming), −16 (podcast), −23 (broadcast). See the loudness-mastering skill.
4. **Verify.** The PostToolUse hook reports the output's duration and codec. Also confirm the duck depth:
   ```bash
   ffmpeg -hide_banner -ss <before voice> -t 1 -i out.wav -af volumedetect -f null - 2>&1 | grep mean_volume
   ffmpeg -hide_banner -ss <during voice> -t 1 -i out.wav -af volumedetect -f null - 2>&1 | grep mean_volume
   ```
   About 6–12 dB of difference on the music bed is typical. Report the final LUFS and true peak (`ebur128=peak=true`).
5. **Multiple voice cues**: run once per cue on the previous output, or use `dub.js stream` with one `--overlay file@seconds` per cue on a file input. It writes in real time (`-re`), so prefer `run_ffmpeg` for long programs.
