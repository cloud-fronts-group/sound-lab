---
name: dub-video
description: Dub a video (MP4/MOV/MKV) into another language or add narration — add a new language audio track, replace the soundtrack, or build a ducked mix over the original/M&E bed — keeping the video stream untouched, with correct language tags, default track, subtitles and faststart. Use for localisation, voice-over on screen recordings, or audio-description tracks.
argument-hint: "<video> <dub voice audio | script text> [lang <iso639-2>] [mode add-track|replace|voice-only]"
---

# Dub a video

Request: $ARGUMENTS

1. **Inspect** the video: `probe` (MCP) or `ffprobe -show_streams`. Note the audio tracks, their languages, any existing subtitles and the duration.
2. **Get the dub voice.**
   - Recorded voice file: clean it (`highpass=f=80,afftdn=nr=10,deesser`) and align its start (`--voice-at`).
   - Script only: generate it with the `voice-over` skill (MLX TTS), one file per line or scene, then concatenate with silences, or place each cue with `--voice-at`.
   - Need the original **without dialogue** (an M&E bed)? Run `separate_audio { input: "<video>", description: "speech" }`. The `_no-speech.wav` residual becomes `--bed`.
3. **Build** with the plugin's builder. The video is stream-copied (no re-encode):
   ```bash
   # add a Spanish track next to the original, make it the default
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dub.js" video --video in.mp4 --voice es.wav --lang spa --title "Español" --mode add-track --out in_es.mp4 --run
   # replace the soundtrack: voice over an M&E bed
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dub.js" video --video in.mp4 --voice es.wav --bed in_no-speech.wav --mode replace --lang spa --out in_es.mp4 --run
   # audio-description / commentary only track
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dub.js" video --video in.mp4 --voice ad.wav --mode voice-only --lang eng --title "Audio description" --out in_ad.mp4 --run
   ```
   Long videos: use `--json` and the MCP `run_ffmpeg` tool so the render runs in the background, then `wait_job`.
4. **Subtitles** for the dub language: transcribe the dub voice (`transcribe`), check timing with the subtitle-editor agent, then mux: `-i subs.srt -map 2:0 -c:s mov_text -metadata:s:s:0 language=spa`.
5. **Verify** with `ffprobe -show_entries stream=index,codec_name:stream_tags=language,title:stream_disposition=default`. Confirm the video is still `copy` quality (same codec and bitrate), the durations match, and the dub track is tagged and default. The loudness target for video dubs is −23 LUFS (EBU) or −24 (ATSC) unless the platform says otherwise. Hand off to the **mp4-expert** agent for delivery specs (fragmented MP4, HLS, HDR metadata).
