---
name: ffmpeg-explore
description: Investigate what the local FFmpeg build can do (filters, encoders, formats, devices, option syntax) before designing a feature, and prototype filtergraphs on generated test signals. Use before adding anything that depends on a specific ffmpeg filter or codec.
argument-hint: "<filter, codec or capability to investigate>"
---

# Explore FFmpeg capabilities

Topic: $ARGUMENTS

Useful probes:
```bash
ffmpeg -hide_banner -version | head -1                 # build version (whisper filter needs 8.0+)
ffmpeg -hide_banner -filters | grep -i <word>          # is the filter compiled in?
ffmpeg -hide_banner -h filter=<name>                   # every option and its type/range
ffmpeg -hide_banner -encoders | grep -i <codec>
ffmpeg -hide_banner -h encoder=<name>                  # supported sample formats / rates
ffmpeg -hide_banner -sources pulse                     # capture devices (linux); avfoundation/dshow on mac/win
```

Generate test material with lavfi instead of hunting for fixtures:
```bash
ffmpeg -v error -y -f lavfi -i "aevalsrc='0.5*sin(2*PI*440*t)':s=48000:d=2" tone.wav   # exact level (−6 dBFS)
ffmpeg -v error -y -f lavfi -i "anoisesrc=color=pink:amplitude=0.1:d=5" pink.wav
ffmpeg -v error -y -f lavfi -i "testsrc=d=2:s=160x120" -f lavfi -i "sine=d=2" -shortest clip.mp4
```

Measure the results instead of eyeballing them:
```bash
ffprobe -v error -show_entries stream=codec_name,sample_rate,channels,duration_ts -of json out.wav
ffmpeg -hide_banner -i out.wav -af "astats=measure_perchannel=none,volumedetect" -f null - 2>&1 | grep -E "Peak|RMS|max_volume"
ffmpeg -hide_banner -i out.wav -af loudnorm=print_format=json -f null - 2>&1 | tail -12
```

Record what you find, including version limits and option quirks, in the "Hard-won gotchas" section of `CLAUDE.md` when it affects how code must be written.
