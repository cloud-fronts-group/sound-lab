---
name: batch-convert
description: Convert many audio/video files in the background with presets (WAV/FLAC/AIFF masters, MP3 V0/320/podcast, AAC/ALAC, Opus, Ogg, two-pass loudness, MP4 H.264/HEVC with VideoToolbox on Apple Silicon, faststart remux) or custom ffmpeg args — locally or in a Docker/Podman container. Use for any bulk conversion, normalisation or re-encode.
argument-hint: "<files|folder|glob> to <preset|format> [-> output dir] [runner local|docker|podman]"
---

# Batch convert

Request: $ARGUMENTS

1. `list_presets` and pick the closest one. If none fits, use `ffmpeg_args` + `output_ext`.
2. Dry run first and show the user the plan:
   ```text
   batch_convert { inputs: ["~/Music/Masters/**/*.wav"], preset: "mp3-v0", output_dir: "~/Music/MP3", dry_run: true }
   ```
3. Start it (`dry_run` false), with `concurrency` up to the CPU count / 2 for audio and 1–2 for video:
   - Apple Silicon video: keep `runner: "local"` and `hwaccel: "auto"` → VideoToolbox (much faster and cooler than libx264).
   - Reproducibility or a clean Linux toolchain: `runner: "docker"` (the image `ghcr.io/cloud-fronts-group/sound-lab-ffmpeg`). It's CPU-only on macOS.
4. `wait_job` (up to 300 s per call; call again for long batches) or `job_status`. On failures, read `job_status { include_log: true }`, fix the cause and `resume_job`.
5. Report the output folder, counts, total size, and anything skipped. The post-tool hook's ffprobe summaries cover the foreground Bash runs only, so for batch jobs quote `item.result` from `job_status` (duration, codec, size).
