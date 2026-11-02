---
name: dub-stream
description: Dub a live or long-running music stream — take an HTTP/Icecast/HLS/RTMP music stream (or a playlist file played in real time), overlay station IDs, voice drops, jingles or sound effects with automatic ducking, keep levels broadcast-safe, and record to file or re-stream to RTMP/SRT/Icecast/HLS. Runs in the background via the MCP server.
argument-hint: "<stream URL or file> overlay <file@seconds>... [every <s>] [duration <s>] -> <file|rtmp://|srt://|icecast://|.m3u8>"
---

# Dub a music stream

Request: $ARGUMENTS

1. **Check the source.** `ffprobe -v error -show_entries stream=codec_name,sample_rate,channels -of compact "<url>"`. For HLS use the `.m3u8` URL. For a local playlist, concatenate first or use `-stream_loop -1` with a file.
   - Only restream content you have the rights to. Many radio streams forbid redistribution, so ask the user if it's unclear.
2. **Plan the overlays.** Each `--overlay file@seconds` is placed at that offset. `--every N` repeats every overlay every N seconds (station ID every 15 min = `--every 900`). The builder ducks the music under the overlays, then applies a live-safe `dynaudnorm` and limiter (`loudnorm` needs the whole file and isn't suited to live).
3. **Build the command:**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dub.js" stream --input "https://radio.example/stream.mp3" \
        --overlay ids/station-id.wav@5 --overlay sfx/riser.wav@60 --every 900 \
        --duration 3600 --out "rtmp://live.example/app/STREAM_KEY" --json
   ```
   Outputs: a file (by extension), `rtmp://` (AAC/FLV), `srt://` or `udp://` (MPEG-TS), `icecast://source:pass@host:8000/mount` (MP3), or `*.m3u8` (rolling HLS).
4. **Run it in the background** with the MCP tool, passing the JSON argv: `run_ffmpeg { args: [...], title: "Station dub → RTMP", duration_s: 3600 }`. Watch it with `job_status`, stop it with `cancel_job` (ffmpeg gets `q` and closes the output cleanly).
   For short tests, run `dub.js … --duration 30 --out test.mp3 --run` in the foreground first and listen.
5. **Station IDs and voice drops** can be generated with `voice-over` (MLX TTS). Stingers and sweeps can come from `sfx-design` (riser, whoosh, impact).
6. **Report** the job id, the output target, the overlay schedule, and how to stop it.
