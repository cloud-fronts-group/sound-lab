---
name: sfx-pack
description: Batch-process a folder of sound effects or samples into a consistent, engine-ready pack — trim silence, remove DC/rumble, fade, peak or loudness normalise, mono/stereo, resample and convert (Ogg/WAV/M4A/CAF) — in the background with the sound-lab-media MCP server. Use for game/app audio handoffs and sample-library cleanup.
argument-hint: "<folder or glob> [format ogg|wav|m4a] [mono] [peak -1|lufs -18] [-> output dir]"
---

# Batch an SFX / sample pack

Request: $ARGUMENTS

1. **Survey**: `batch_convert { inputs: ["<folder>"], preset: "wav-24", dry_run: true }` lists the matching files and planned outputs. Spot-check 2–3 with `probe` (rates, channels, very long or silent files).
2. **Pick the processing chain** (ffmpeg_args, applied per file):
   ```text
   cleanup  : -af highpass=f=30,silenceremove=start_periods=1:start_threshold=-55dB:start_silence=0.005,areverse,silenceremove=start_periods=1:start_threshold=-55dB:start_silence=0.01,areverse,afade=t=in:d=0.003
   loudness : add ,loudnorm=I=-18:TP=-1 for consistent perceived level   (or use the normalize-14 / normalize-23 presets)
   mono     : -ac 1      rate: -ar 48000
   ```
3. **Run in the background**:
   ```text
   batch_convert {
     inputs: ["~/Audio/Raw SFX/**/*.wav"], output_dir: "~/Audio/SFX Pack", output_ext: "ogg", suffix: "",
     ffmpeg_args: ["-af","highpass=f=30,silenceremove=start_periods=1:start_threshold=-55dB,areverse,silenceremove=start_periods=1:start_threshold=-55dB,areverse,afade=t=in:d=0.003",
                   "-ac","1","-ar","48000","-c:a","libvorbis","-q:a","6"],
     concurrency: 4
   }
   wait_job { job_id: "convert-…", timeout_s: 300 }
   ```
   Folder structure below the common input folder is kept. Outputs never overwrite inputs.
4. **Peak normalisation per file** is better as a second pass. Measure each with `volumedetect` and apply `volume=`. Or run `node "${CLAUDE_PLUGIN_ROOT}/scripts/sfx.js"`-style normalisation in a small loop for fewer than 50 files.
5. **Report** the counts (done/failed), any failures with their reasons (`job_status` with `include_log: true`) and the output folder. Offer to `resume_job` the failures after fixing them.
