# FFmpeg internals

This page shows how each Sound Lab operation maps to ffmpeg arguments, and why the arguments are the way they are. Everything here comes from `src/core/recipes.ts` and `src/core/analysis.ts`; command lines are **real output** from the compiled code.

## 1. Ground rules

- **Argv arrays, never shell strings.** Builders return `string[]` for `spawn`. A path with spaces or quotes is one argument.
- **First audio stream only.** Edits and conversions use `-map 0:a:0`, so cover art, video and extra audio tracks are dropped. Tags are carried over with `-map_metadata 0` where that matters (conversion).
- **Common prefix.** Most builders start with `ffBase()`: `-hide_banner -nostdin -y`. Analysis passes that write nothing (`-f null -`) omit `-y`; recording omits `-nostdin` so it can receive `q` on stdin.
- **One pass where possible.** Effects are one `-af` chain; slicing is one `asegment` pass with N outputs.
- **Progress** is derived from `time=` in ffmpeg's stderr divided by the known duration.

## 2. Operation to ffmpeg map

| Operation | Builder | What it does |
|---|---|---|
| Convert | `convert` | `-map 0:a:0 -map_metadata 0` plus the codec arguments |
| Trim / export selection | `trim` | `-ss` and `-t` before `-i`; optional `afade` in and out; re-encode |
| Slice | `sliceAt` | `-filter_complex "[0:a:0]asegment=samples=P1\|P2\|…[s0][s1]…"` with one `-map` per output |
| Loudness, measure | `loudnormAnalyze` | `loudnorm=I=…:TP=…:LRA=…:print_format=json -f null -` |
| Loudness, apply | `loudnormApply` | second pass with `measured_*`, `offset`, `linear=true`, then `-ar` back |
| Peak normalize | `peakNormalizeFilter` + `applyFilter` | `volumedetect` to find the peak, then `volume=<gain>dB` |
| Effects | `applyFilter` | `-af <chain>` built from the `EFFECTS` catalogue |
| Concatenate | `concat` | normalize every input, then `concat` or chained `acrossfade` |
| Extract audio | `extractAudio` | `-vn -sn -dn -map 0:a:0` with `-c:a copy` or a codec |
| Add subtitles | `muxSubtitles` | `-map 0 -map 1:0 -c copy -c:s mov_text\|srt` plus a language tag |
| Level analysis | `levelsAnalyze` | `astats=measure_perchannel=none,volumedetect -f null -` |
| Silence detection | `silenceDetect` | `silencedetect=noise=<dB>dB:d=<sec> -f null -` |
| Waveform / spectrogram | `waveformPng`, `spectrogramPng` | `showwavespic`, `showspectrumpic`, `-frames:v 1` |
| Waveform peaks | `pcmForPeaks` | mono `f32le` PCM on stdout |
| Editor preview | `previewTranscode` | `-c:a flac -compression_level 0` |
| STT prep | `toWhisperWav`, `toUploadChunks` | 16 kHz mono PCM; 16 kHz mono FLAC segments |
| Record | `record` | `-f <input format> -i <device>` plus `-t` and the codec |
| Generate | `generate` | `-f lavfi -i <source>` plus the codec |

## 3. Codec and format matrix

`codecArgs()` turns the format, bit depth, bitrate, sample rate and channel count into arguments.

| Format | Arguments | Notes |
|---|---|---|
| WAV, 16-bit | `-c:a pcm_s16le` | |
| WAV, 24-bit | `-c:a pcm_s24le` | The default |
| WAV, 32-bit | `-c:a pcm_f32le` | Float |
| AIFF, 16 / 24 / 32-bit | `-c:a pcm_s16be` / `pcm_s24be` / `pcm_s32be` | The 32-bit option is integer, although the Convert menu labels it "32-bit float" |
| FLAC, 16-bit | `-c:a flac -compression_level 8 -sample_fmt s16` | |
| FLAC, 24-bit (and 32, treated as 24) | `-c:a flac -compression_level 8 -sample_fmt s32 -bits_per_raw_sample 24` | FLAC stores 24-bit audio in a 32-bit container; `bits_per_raw_sample` tells the encoder the real depth |
| MP3 | `-c:a libmp3lame -b:a <bitrate>` | Default 320k |
| Ogg Vorbis | `-c:a libvorbis -q:a 7` | Variable quality; the bitrate is ignored |
| Opus | `-c:a libopus -b:a <bitrate>` | The bitrate is used if it is 256k or less, else 160k |
| M4A (AAC) | `-c:a aac -b:a <bitrate>` | The bitrate is used if it is 320k or less, else 256k |

Then, for every format: `-ar <rate>` when a sample rate is set (Opus rates other than 8, 12, 16, 24 and 48 kHz become `-ar 48000`), and `-ac <n>` when a channel count is set. **Real output:**

```text
-c:a libopus -b:a 160k -ar 48000          ← Opus, 44.1 kHz and 320k requested
-c:a aac -b:a 256k                        ← M4A, 512k requested
-c:a flac -compression_level 8 -sample_fmt s32 -bits_per_raw_sample 24
```

## 4. Sample-accurate trimming

```bash
$ ffmpeg -hide_banner -nostdin -y -ss 12.500000 -t 5.750000 -i take1.wav -map 0:a:0 -af afade=t=in:st=0:d=0.005,afade=t=out:st=5.740000:d=0.01 -c:a pcm_s24le take1_0.12-0.18.wav
```

`-ss` and `-t` are placed **before** `-i`, and the audio is re-encoded rather than copied. The project's notes record that this is sample-exact for both PCM and MP3, whereas a stream copy can only cut at packet boundaries. **Real run:** an MP3 trimmed from 1.234567 s to 3.0 s came out with 77,856 samples, exactly `round(1.765433 × 44100)`.

The fade-out starts at `duration − fadeOut`, so the last few milliseconds ramp to silence.

## 5. Sample-accurate slicing

ffmpeg's `segment` muxer cuts at packet boundaries, which in the project's measurements puts cuts about 23 ms away from the requested time. For musical slicing that is audible, so Sound Lab uses the `asegment` **filter**, which cuts at exact sample positions:

```bash
$ ffmpeg -hide_banner -nostdin -y -i loop.wav -filter_complex "[0:a:0]asegment=samples=44100|88200|132300[s0][s1][s2][s3]" -map [s0] -c:a pcm_s24le loop_slices/loop_001.wav -map [s1] … -map [s3] -c:a pcm_s24le loop_slices/loop_004.wav
```

`asegment=samples=P1|P2|P3` splits the stream at those sample positions and creates one output pad per piece: N cut points give N + 1 outputs, which is why `sliceAt()` requires `outputs.length === points.length + 1`. A single ffmpeg pass writes all of them.

**Where the cut points come from.** For a slice length of `L` samples (often fractional, for example 128 BPM eighths at 44.1 kHz are 10,335.9375), `slicePoints(total, L)` returns `round(i × L)` for `i = 1, 2, …` while the position is below `total − 1`. Each point is rounded independently, so the error never accumulates: the slice lengths wobble by one sample but the grid stays locked to the tempo. **Real output** for 3 s at 44.1 kHz:

```text
per-slice samples = 10335.9375, cuts = 12
first cuts = 10336, 20672, 31008, 41344, 51680, 62016 … last = 124031
slice lengths: 10336 ×8, 10335, 10336 ×3, 8269   (sum = 132300 = 3 s × 44100)
```

If the cuts were instead `i × round(L)` the 12th cut would land at 124,032 instead of 124,031. Over a long file the difference would keep growing.

**Into N equal parts** uses `round(i × total / N)` for `i = 1 … N − 1`; a 10 s, 48 kHz file in 16 parts has 15 cuts, 30,000 samples apart.

## 6. Loudness

**Measuring** (pass 1) runs `loudnorm` with `print_format=json` and discards the audio. ffmpeg prints a JSON block on stderr; `parseLoudnormJson()` finds the last `[Parsed_loudnorm` marker and parses the braces after it. **Real output** for 6 s of pink noise generated with a −30 dBFS level setting, target −14 / −1 / 11:

```json
{
  "input_i": "-44.67",
  "input_tp": "-31.42",
  "input_lra": "0.00",
  "input_thresh": "-54.67",
  "output_i": "-13.99",
  "output_tp": "-1.00",
  "output_lra": "0.10",
  "output_thresh": "-23.99",
  "normalization_type": "dynamic",
  "target_offset": "-0.01"
}
```

**Applying** (pass 2) feeds `input_i`, `input_tp`, `input_lra`, `input_thresh` and `target_offset` back as `measured_I`, `measured_TP`, `measured_LRA`, `measured_thresh` and `offset`, with `linear=true`, so the file gets one gain change instead of dynamic processing. FFmpeg's documentation says linear mode falls back to dynamic when the target loudness range is lower than the source's or when the needed gain would push the true peak above the target. The output of the real run was −14.07 LUFS and −1.06 dBTP.

`loudnorm` works internally at 192 kHz, so `loudnormApply()` always adds `-ar` (the source's rate, unless you chose one). Without it the file would come out at 192 kHz.

**Peak normalization** is simpler: `volumedetect` reports `max_volume`, and the gain is `target − max`. `peakNormalizeFilter(-6.0, -0.1)` returns `volume=5.90dB`; `peakNormalizeFilter(-12.3, -1)` returns `volume=11.30dB`.

**Level report.** **Analyze Loudness & Levels** runs `astats=measure_perchannel=none,volumedetect` and then a `loudnorm` analysis pass with −23 LUFS, −1 dBTP and 11 LU as its targets (the measurements Sound Lab reads do not depend on those values, and nothing is written). `parseAstats()` reads the "Overall" block of `astats`, and `parseVolumedetect()` reads `mean_volume`, `max_volume` and the histogram.

## 7. Silence detection to sound regions

```bash
$ ffmpeg -hide_banner -nostdin -i session.wav -map 0:a:0 -af silencedetect=noise=-40dB:d=0.35 -f null -
```

ffmpeg logs `silence_start: <t>` and `silence_end: <t> | silence_duration: <d>`. `parseSilence()` pairs them (a silence still open at the end of the file closes at the file's duration, and a negative start is clamped to 0). `soundSegments()` then inverts the silences:

1. Walk the silences in order. Whatever lies between the cursor and the next `silence_start` is a sound segment; move the cursor to `silence_end`.
2. Add the tail after the last silence, if any.
3. Widen each segment by `padding` on both sides, clamped to the file.
4. Drop segments shorter than `minSegment`.

**Real output** for a file made of tone (0.5 s), silence (1.0 s), tone (0.7 s), silence (0.6 s), tone (0.4 s), with −40 dB, 0.35 s, padding 0.03 s and minimum 0.08 s:

```text
silences = [0.5 → 1.50002], [2.2 → 2.80002]
segments = [0 → 0.53], [1.47 → 2.23], [2.77 → 3.2]
```

## 8. Images and waveform peaks

**Waveform image.** A mono mix drawn by `showwavespic` with a square-root amplitude scale:

```text
[0:a:0]aformat=channel_layouts=mono,showwavespic=s=1800x360:colors=#4fc3f7:scale=sqrt -frames:v 1
```

**Spectrogram image.** `showspectrumpic=s=WxH:mode=combined:color=intensity:scale=log:fscale=log:legend=1`. With the legend on, the image is larger than the requested size. **Real run** on FFmpeg 6.1.1 with 44.1 kHz audio:

| Requested | Produced |
|---|---|
| 800 × 300 | 1082 × 428 |
| 800 × 512 (the editor's request) | 1082 × 640 |
| 1600 × 600 (the command's default) | 1882 × 728 |

The legend adds 128 px of height and a width margin that depends on the audio's sample rate. **Real run**, requested 800 × 300: 1066 × 428 at 22.05 kHz, 1082 × 428 at 44.1 kHz, 1084 × 428 at 48 kHz and 1098 × 428 at 96 kHz. Those four widths fit `2 × int((log10(sampleRate) + 1) × 25)` extra pixels, which is 282 at 44.1 kHz. `media/editor.js` assumes the plot starts 141 px from the left and has an equal margin on the right, and converts a click on the picture into a time with `(x − 141) / (imageWidth − 282)`: exact at 44.1 kHz and a pixel or two off at 48 kHz. A different FFmpeg version could change the margins too; the project's notes list this as a "don't regress" item.

**Waveform peaks for the editor.** ffmpeg decodes to mono `f32le` PCM on stdout (`-ac 1 -ar <rate> -f f32le -`); the extension reads the floats, tracks min and max per bucket, and rounds to three decimals. The decode rate and bucket density depend on the duration (**real run** confirmed the formula to within one bucket):

| Duration | Decode rate | Buckets per second (setting 200) | Buckets |
|---|---|---|---|
| 10 s | 22,050 Hz | 200.5 | 2,005 |
| 60 s | 22,050 Hz | 200.5 | 12,027 |
| 90 s | 8,000 Hz | 200.0 | 18,000 |
| 5 min | 8,000 Hz | 200.0 | 60,000 |
| 10 min | 8,000 Hz | 100.0 | 60,000 |
| 11 min | 4,000 Hz | 90.9 | 60,000 |
| 1 h | 4,000 Hz | 16.0 | 57,600 |
| 3 h | 4,000 Hz | 5.0 | 54,000 |

The rules: the rate is 22,050 Hz up to 60 s, 8,000 Hz up to 600 s and 4,000 Hz beyond; the bucket density is lowered to `floor(60000 / duration)` if the file would otherwise exceed 60,000 buckets; the samples per bucket are `round(rate / density)`.

## 9. Editor preview transcode

```bash
$ ffmpeg -hide_banner -nostdin -y -v error -i song.m4a -map 0:a:0 -c:a flac -compression_level 0 cache.flac
```

Compression level 0 makes the encode fast; FLAC is lossless, so the preview matches the source.

## 10. Recording

The input arguments depend on the platform (**real output**):

| Platform | Arguments |
|---|---|
| macOS | `-f avfoundation -i :<index>` (default `:0`) |
| Windows | `-f dshow -i "audio=<device name>"` |
| Linux | `-f pulse -i default`, or `-f alsa -i hw:1` |

A fixed length adds `-t <seconds>`. For an open-ended recording, Sound Lab keeps stdin open, and **Cancel** writes `q` to ffmpeg, which finalizes the file; after 4 seconds a stuck process is killed. The runner treats a stop that was requested this way as success (the code comment notes ffmpeg may exit with 255 in that case; ffmpeg 6.1.1 exited 0 in testing). The repository's test records from a `lavfi` sine source, aborts after 1.2 s and checks that the file is a valid WAV.

## 11. Generated signals

| Signal | Source expression |
|---|---|
| Sine | `aevalsrc='A*sin(2*PI*f*t)'` |
| Square | `aevalsrc='A*sgn(sin(2*PI*f*t))'` |
| Sawtooth | `aevalsrc='A*(2*(t*f-floor(0.5+t*f)))'` |
| Triangle | `aevalsrc='A*(2*abs(2*(t*f-floor(0.5+t*f)))-1)'` |
| White, pink, brown | `anoisesrc=color=<c>:amplitude=A` |
| Log sweep | `aevalsrc='A*sin(2*PI*20*T/log(F/20)*(exp(t/T*log(F/20))-1))'` for duration `T` and end frequency `F` |
| Silence | `anullsrc=r=<rate>:cl=mono` with `-t <seconds>` |

`A` is the amplitude, `10^(dBFS/20)` to four decimals. A −6 dBFS signal uses `0.5012`. `aevalsrc` is used instead of ffmpeg's `sine` source because `sine` is fixed at an amplitude of 1/8 (−18 dBFS). For noise, `amplitude` is a setting of the generator rather than an exact peak: white noise peaked at the requested level in testing, pink noise about 2 dB lower and brown noise about 1.5 dB lower.

## 12. Concatenation

```text
[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0]; …
[a0][a1][a2]concat=n=3:v=0:a=1[out]                     ← straight join
[a0][a1]acrossfade=d=0.25[x1];[x1][a2]acrossfade=d=0.25[out]   ← with a crossfade
```

Every input is resampled to one rate (`soundLab.defaults.sampleRate`, or 48 kHz), converted to float stereo, and then joined. That is why mono inputs come out as stereo and 44.1 kHz inputs come out at 48 kHz unless you set the default rate. Each crossfade overlaps neighbouring files by its length, so the total is the sum of the durations minus `crossfade × (files − 1)`.

## 13. Escaping paths inside filters

Most of Sound Lab never puts a path inside a filtergraph, but two places do: the `whisper` filter's `model=` and `destination=`. ffmpeg parses such a value on two levels, first as a filter option and then as part of the filtergraph, and the escape characters differ:

1. **Option level:** escape `\`, `'` and `:`.
2. **Filtergraph level:** escape `\`, `'`, `[`, `]`, `,` and `;`.

`escapeFilterValue()` in `core/transcribe.ts` applies level 1 and then level 2. **Real output:**

| Path | Escaped |
|---|---|
| `/Users/me/My Models/ggml-base.en.bin` | `/Users/me/My Models/ggml-base.en.bin` (unchanged; spaces are fine) |
| `C:\models\ggml-base.en.bin` | `C\\:\\\\models\\\\ggml-base.en.bin` |
| `/tmp/it's [here], ok;` | `/tmp/it\\\'s \[here\]\, ok\;` |

A test writes analysis metadata to a folder named `we:ird [dir], it's;here` through a real filtergraph to prove that the escaping round-trips. If you add a feature that puts a user path inside a filter option, run it through `escapeFilterValue()`.

## 14. Gotchas the code already handles

These come from the project's `CLAUDE.md` ("Hard-won gotchas") and are worth knowing before you change related code.

| Gotcha | What the code does |
|---|---|
| The `-f segment` muxer cuts at packet boundaries (about 23 ms off) | `sliceAt()` uses the `asegment=samples=…` filter and rounds each cut independently |
| `-ss <t> -t <d>` before `-i` with re-encoding is sample-exact for PCM and MP3 | `trim()` keeps that order |
| The lavfi `sine` source is −18 dBFS | `generate()` uses `aevalsrc` when the level matters |
| `loudnorm` upsamples to 192 kHz | `loudnormApply()` sets `-ar`; two-pass with `linear=true` hits the target |
| Opus accepts only 8, 12, 16, 24 and 48 kHz | `codecArgs()` coerces other rates to 48 kHz |
| FLAC 24-bit needs `-sample_fmt s32 -bits_per_raw_sample 24` | `codecArgs()` |
| `showspectrumpic` adds legend margins (plot at x = 141, image 282 px wider, at 44.1 kHz) | `editor.js` accounts for it in click-to-seek |
| VS Code's Chromium cannot play AAC, AIFF or WMA | `playableSource()` transcodes to a cached FLAC |
| `.loading { display: flex }` would keep the overlay visible | CSS sets `[hidden] { display: none !important }` |
| `scrollIntoView` scrolls the whole webview away from the waveform and breaks double-click | The transcript list scrolls its own `scrollTop` |
| Stopping a recording with `q` makes ffmpeg exit non-zero | `run()` treats a requested graceful stop as success |
| `alimiter level=` is a boolean | The Limiter effect passes `level=0`, not `disabled` |
| FFmpeg 6.x has no `whisper` filter | That backend is covered only by its "missing filter" error test |

## 15. FFmpeg versions

- The README names **4.4** as the minimum. Nothing in the extension enforces it; unsupported options surface as ffmpeg errors in the log.
- The `whisper` filter needs **FFmpeg 8.0+** built with `--enable-whisper`. Sound Lab checks `ffmpeg -filters` before using it.
- `rubberband` (used only by a recipe) needs an FFmpeg built with librubberband.
- Capability detection parses `ffmpeg -filters` and `ffmpeg -encoders` by pattern, so unusual builds are reported as best effort.
- All measurements on this page came from FFmpeg 6.1.1 (Ubuntu 6.1.1-3ubuntu5).
