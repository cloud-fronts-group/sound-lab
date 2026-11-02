---
name: ffmpeg-fundamentals
description: Core FFmpeg knowledge for writing correct, safe ffmpeg/ffprobe commands — argument order, stream mapping, filtergraphs and escaping, seeking accuracy, codec/container matching, probing, and common failure modes. Use whenever composing or debugging an ffmpeg command line.
---

# FFmpeg fundamentals

## Anatomy (order matters)
```
ffmpeg [global] [input opts] -i in1 [input opts] -i in2 … [output opts] out1 [output opts] out2
```
- Options apply to the **next** `-i` or output file. `-ss` placed before `-i` seeks the input (fast). Placed after it, frames are decoded and discarded up to that point (slow).
- Global options: `-hide_banner -nostdin -y|-n`. Use `-n` (never overwrite) unless the user asked to replace a file.
- **Never write to an input path.** ffmpeg truncates the output first, so the source is destroyed. The plugin's guard hook blocks this.

## Inspect before you transcode
```bash
ffprobe -v error -show_entries format=duration,bit_rate:stream=index,codec_type,codec_name,sample_rate,channels,channel_layout,width,height,r_frame_rate -of json in.mp4
ffprobe -v error -select_streams a:0 -show_entries stream=duration_ts,time_base -of csv=p=0 in.wav   # exact sample count
```
Use the MCP `probe` tool for a compact summary.

## Stream selection
- `-map 0:a:0` = first audio stream of input 0. `-map 0:v?` means "if present". `-map -0:s` removes the subtitle streams.
- Without `-map`, ffmpeg picks one "best" stream per type. Always map explicitly when there are multiple inputs.
- `-vn -sn -dn` drop video, subtitle and data streams. `-map_metadata 0` copies tags. `-map_chapters 0` copies chapters.

## Filters
- Simple chain on one stream: `-af "highpass=f=80,acompressor,alimiter"`.
- Multiple inputs or outputs: `-filter_complex "[0:a][1:a]amix=inputs=2:normalize=0[out]" -map "[out]"`.
- Escaping has two levels. Inside an option value, escape `\ ' :`. Inside the graph, also escape `[ ] , ;`. Easiest: quote the whole graph for the shell and avoid user paths in filter options (or escape them).
- A filter that combines inputs stops when its *shortest relevant* input ends (`sidechaincompress` ends with its key; `amix duration=first|longest|shortest`). Pad with `apad` when a side input must not end the stream.
- `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo` before mixing makes mixed sources compatible.

## Accuracy
- Audio cuts with re-encoding (`-ss S -t D -i in … out.wav`) are sample-accurate for PCM and MP3. `-c copy` cuts snap to packets or keyframes.
- `-f segment` splits at packet boundaries (about 23 ms for AAC/MP3). For sample-exact slices use `asegment=samples=…` or `atrim=start_sample=…:end_sample=…`.
- Video stream copy can only start on keyframes. Re-encode, or accept the nearest keyframe.

## Codecs ↔ containers (audio)
| Container | Good codecs | Notes |
|---|---|---|
| .wav | pcm_s16le / pcm_s24le / pcm_f32le | RF64 above 4 GB: `-rf64 auto` |
| .aiff | pcm_s16be / pcm_s24be | |
| .flac | flac | 24-bit: `-sample_fmt s32 -bits_per_raw_sample 24` |
| .mp3 | libmp3lame | `-q:a 0` V0 VBR, `-b:a 320k` CBR, `-id3v2_version 3` for broad tag support |
| .m4a/.mp4 | aac, aac_at (macOS), alac | `-movflags +faststart` for web |
| .ogg | libvorbis (`-q:a 6`), libopus | |
| .opus | libopus | 8/12/16/24/48 kHz only |

## Generate test signals instead of hunting for files
```bash
ffmpeg -f lavfi -i "aevalsrc='0.5*sin(2*PI*440*t)':s=48000:d=2" tone.wav       # exact -6 dBFS
ffmpeg -f lavfi -i "anoisesrc=color=pink:amplitude=0.2:d=5" pink.wav
ffmpeg -f lavfi -i testsrc2=d=5:s=1280x720:r=30 -f lavfi -i sine=d=5 -shortest test.mp4
```
The lavfi `sine` source plays at 1/8 amplitude (−18 dBFS). Use `aevalsrc` when the level matters.

## Measure, don't guess
```bash
ffmpeg -i x.wav -af volumedetect -f null -                       # mean / max volume
ffmpeg -i x.wav -af ebur128=peak=true -f null -                 # LUFS, LRA, true peak
ffmpeg -i x.wav -af astats=measure_perchannel=none -f null -    # RMS, crest, DC offset, noise floor
ffmpeg -i x.wav -af silencedetect=noise=-40dB:d=0.3 -f null -   # silence boundaries
```

## Long or batch work
For many files, long renders, or live captures, use the **sound-lab-media** MCP server instead of a foreground Bash call. Run `batch_convert` (presets), `run_ffmpeg` (any argv) or `transcribe`, then `wait_job`. The jobs run in the background, survive cancellation cleanly and report per-file progress.

See `references/filters.md` for a categorised filter cheat-sheet.
