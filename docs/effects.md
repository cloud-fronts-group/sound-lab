# Effects catalogue

**Sound Lab: Apply Effects / Filter Chain…** (`soundLab.applyEffects`) applies one or more of 26 effects to each selected file. You pick the effects, type a value for each parameter, and Sound Lab joins everything into a single FFmpeg `-af` filter chain, so the whole chain runs in one pass.

![The Pick effects multi-select quick pick, with 0 selected, listing Gain, Reverse, Change speed, Pitch shift, Varispeed, Fade in, Fade out, Trim leading/trailing silence, High-pass, Low-pass, Parametric EQ, Denoise, De-click, De-hum, Compressor, Limiter and Echo](images/effects-picker.png)

*The first prompt, as captured in a screenshot. Each row shows the effect's name and the FFmpeg filter behind it; the badge reads "0 Selected". Behind the picker is a DJ-styled editor that is not part of this repository; see [Sound Lab Studio](studio.md).*

## How a chain is built

1. **Pick effects.** The placeholder says *Pick effects (applied top-to-bottom in this list order)*. The order is the **list order**, not the order in which you tick items. Typing filters the list by name or filter (it matches the description too).
2. **Enter parameters.** For each picked effect, one input box per parameter, pre-filled with the default. Values are plain text and are not range-checked; an invalid value shows up as an ffmpeg error in the log.
3. **Run.** The effects' filter strings are joined with commas (empty ones are dropped) and applied as `-af <chain>`. The log shows `filter chain: …` first.
4. **Result.** The file keeps its source format and bit depth. A single effect names the file `<name>_<effect id>.<ext>`; several effects produce `<name>_fx.<ext>`.

Because it is one `-af` chain, the output is only encoded once, however many effects you stack.

## The 26 effects

Defaults are what the prompts offer. The filter column shows what is built with those defaults for a 44.1 kHz source (**real output**).

| ID | Effect | Parameters (defaults) | Filter built with the defaults |
|---|---|---|---|
| `gain` | Gain | Gain (dB): 3 | `volume=3dB` |
| `reverse` | Reverse | — | `areverse` |
| `speed` | Change speed (keep pitch) | Speed factor (0.25–4): 1.5 | `atempo=1.500000` |
| `pitch` | Pitch shift (keep length) | Semitones (+/-): 3 | `asetrate=52444,aresample=44100,atempo=0.840896` |
| `varispeed` | Varispeed (tape-style, pitch + speed) | Semitones (+/-): -12 | `asetrate=22050,aresample=44100` |
| `fadein` | Fade in | Fade-in seconds: 0.5 | `afade=t=in:st=0:d=0.5` |
| `fadeout` | Fade out (end of file) | Fade-out seconds: 0.5 | `areverse,afade=t=in:st=0:d=0.5,areverse` |
| `trimsilence` | Trim leading/trailing silence | Threshold (dB): -50 | `silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.01,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.01,areverse` |
| `highpass` | High-pass filter | Cutoff Hz: 80 | `highpass=f=80:poles=2` |
| `lowpass` | Low-pass filter | Cutoff Hz: 12000 | `lowpass=f=12000:poles=2` |
| `eq` | Parametric EQ band | Centre Hz: 1000; Gain dB: -3; Q: 1 | `equalizer=f=1000:t=q:w=1:g=-3` |
| `denoise` | Denoise (FFT) | Noise reduction dB (0.01–97): 12 | `afftdn=nr=12:nf=-40` |
| `declick` | De-click | — | `adeclick` |
| `dehum` | De-hum (50/60 Hz notch + harmonics) | Mains Hz (50 or 60): 60 | `bandreject=f=60:width_type=q:w=30,bandreject=f=120:width_type=q:w=30,bandreject=f=180:width_type=q:w=30` |
| `compressor` | Compressor | Threshold dB: -18; Ratio: 4 | `acompressor=threshold=-18dB:ratio=4:attack=10:release=120:makeup=2` |
| `limiter` | Limiter | Ceiling dBFS: -1 | `alimiter=limit=0.8913:level=0` |
| `echo` | Echo / delay | Delay ms: 250; Decay 0–1: 0.4 | `aecho=0.8:0.85:250:0.4` |
| `reverb` | Simple reverb | — | `aecho=0.8:0.7:40\|57\|83\|111:0.4\|0.3\|0.25\|0.2` |
| `chorus` | Chorus | — | `chorus=0.6:0.9:50\|60:0.4\|0.32:0.25\|0.4:2\|1.3` |
| `flanger` | Flanger | — | `flanger` |
| `bitcrush` | Bitcrusher | Bits: 8; Downsample factor: 4 | `acrusher=bits=8:samples=4:mix=1:mode=log` |
| `mono` | Downmix to mono | — | `pan=mono\|c0=0.5*c0+0.5*c1` |
| `swap` | Swap L/R | — | `channelmap=map=FR-FL\|FL-FR` |
| `widen` | Stereo widen | — | `stereowiden` |
| `loop` | Loop N times | Extra repetitions: 3 | `aloop=loop=3:size=2147483647` |
| `custom` | Custom filter string… | FFmpeg audio filter (e.g. "vibrato=f=6,tremolo"): (empty) | *(empty: nothing is added to the chain)* |

The default for *Custom filter string…* is empty, so by default it adds nothing to the chain. If it is the **only** effect you pick and you leave it empty, ffmpeg receives an empty filter and fails with `Error initializing a simple filtergraph`. Type an expression such as `vibrato=f=6,tremolo` instead.

## Notes by group

**Level and dynamics**

- *Gain* does not limit. If you boost, add *Limiter* afterwards.
- *Compressor* exposes threshold and ratio; attack (10 ms), release (120 ms) and make-up gain are fixed. FFmpeg's `makeup` is a linear multiplier, so `makeup=2` is about +6 dB.
- *Limiter* takes the ceiling in dBFS and converts it to the linear `limit` the filter expects (−1 dBFS becomes `0.8913`). `level=0` turns off the filter's auto-levelling.

**Time and pitch**

- *Change speed* uses `atempo`. Sound Lab keeps each instance within 0.5 to 2 (the limit of older FFmpeg versions; 6.1 accepts up to 100) and chains instances for other factors (table below). Pitch stays the same.
- *Pitch shift* keeps the length: it resamples to move the pitch, then compensates with `atempo`. At +3 semitones on a 44.1 kHz file: `asetrate=52444,aresample=44100,atempo=0.840896`. For a higher-quality shift, use the `rubberband` recipe in [FFmpeg Recipes](commands.md#recipe-catalogue) (needs an FFmpeg built with librubberband).
- *Varispeed* changes pitch and speed together, like a tape machine: −12 semitones halves the speed, drops an octave and doubles the length.
- *Loop N times* adds N repetitions, so the file plays N + 1 times in total.
- *Reverse* (and *Fade out* and *Trim leading/trailing silence*, which use it internally) makes FFmpeg's `areverse` hold the whole clip in memory, so avoid them on very long files.

**Fades and trimming**

- *Fade out (end of file)* does not need the duration: it reverses, fades *in*, and reverses back. The length is unchanged.
- *Trim leading/trailing silence* runs `silenceremove` at the start, reverses, runs it again, and reverses back. It keeps 10 ms of silence at each end.

**Filters and EQ**

- *High-pass* and *Low-pass* use two poles (12 dB per octave).
- *Parametric EQ band* is one band: centre frequency, gain and Q. Chain several by running the command again.

**Clean-up**

- *Denoise (FFT)* takes the reduction in dB (`nr`); the noise floor estimate (`nf`) is fixed at −40 dB.
- *De-click* uses `adeclick` with its default settings.
- *De-hum* places three notch filters (`bandreject`, Q = 30) at the mains frequency and its second and third harmonics: 50, 100 and 150 Hz, or 60, 120 and 180 Hz.

**Space and modulation**

- *Echo / delay* is a single `aecho` tap and extends the file by the delay (a 4.000 s file with the default 250 ms became 4.250 s in testing).
- *Simple reverb* is four `aecho` taps at 40, 57, 83 and 111 ms. *Chorus* uses a fixed two-voice setting (`chorus=0.6:0.9:50|60:0.4|0.32:0.25|0.4:2|1.3`) and *Flanger* uses FFmpeg's defaults.
- *Bitcrusher* takes bits and a sample-rate-reduction factor.

**Channels**

- *Downmix to mono* is `pan=mono|c0=0.5*c0+0.5*c1`, the average of the front left and right channels.
- *Swap L/R* is `channelmap=map=FR-FL|FL-FR` and needs a stereo input (see below).
- *Stereo widen* uses `stereowiden`.

**Custom filter string…** takes any FFmpeg audio filter expression, with the same syntax as `-af`.

## Effects that change the length

Measured on a 3-second, 48 kHz test file (**real run**):

| Effect | Settings | Result |
|---|---|---|
| Trim leading/trailing silence | −50 dB, 0.5 s of silence at each end | 3.000 s → 2.020 s |
| Fade out | 0.5 s | 3.000 s (unchanged) |
| Change speed | 1.5× | 3.000 s → 1.987 s (about 2 s) |
| Loop N times | 3 | 3.000 s → 12.000 s |
| Varispeed | −12 semitones | 3.000 s → 6.000 s |
| Echo / delay | 250 ms (4 s file) | 4.000 s → 4.250 s |

How *Change speed* chains `atempo` for factors outside 0.5–2 (**real output**):

| Factor | Chain |
|---|---|
| 0.2 | `atempo=0.5,atempo=0.5,atempo=0.800000` |
| 0.5 | `atempo=0.500000` |
| 1.5 | `atempo=1.500000` |
| 3 | `atempo=2,atempo=1.500000` |
| 4 | `atempo=2,atempo=2.000000` |
| 8 | `atempo=2,atempo=2,atempo=2.000000` |

## Compatibility

- **Mono files.** Of the 26 effects, only *Swap L/R* failed on a mono input: ffmpeg reported that nothing was written to the output file. *Stereo widen* turned a mono file into a stereo one.
- **5.1 files.** All 26 ran without errors on a six-channel input. The channel effects are written for stereo; for example, *Downmix to mono* mixes only the front left and right channels.
- **Filters your build must have.** Every filter in this catalogue is a built-in FFmpeg filter; none needs an external library such as rubberband. Run **Show FFmpeg Capabilities** to see whether your build includes `afftdn`, `acompressor`, `alimiter` and `acrusher`.

## Example chains

All of these ran successfully on a 4-second stereo test file (**real run**). Select the effects in list order and enter the values shown.

**Podcast clean-up**: *High-pass* 80 Hz, *De-hum* 50 Hz, *Compressor* (−18 dB, 4:1), *Limiter* (−1 dBFS).

```bash
$ ffmpeg -hide_banner -nostdin -y -i podcast.wav -map 0:a:0 -af highpass=f=80:poles=2,bandreject=f=50:width_type=q:w=30,bandreject=f=100:width_type=q:w=30,bandreject=f=150:width_type=q:w=30,acompressor=threshold=-18dB:ratio=4:attack=10:release=120:makeup=2,alimiter=limit=0.8913:level=0 -c:a pcm_s24le podcast_fx.wav
```

**Lo-fi**: *Low-pass* 6000 Hz, *Echo* (250 ms, 0.4), *Bitcrusher* (8 bits, factor 4). The list puts Echo before Bitcrusher, so the chain is `lowpass=f=6000:poles=2,aecho=0.8:0.85:250:0.4,acrusher=bits=8:samples=4:mix=1:mode=log`. The echo adds a 0.25 s tail (a 4.000 s file came out at 4.250 s).

**Telephone**: *High-pass* 300 Hz, *Low-pass* 3400 Hz. Chain: `highpass=f=300:poles=2,lowpass=f=3400:poles=2`.

**Custom filter strings that worked in testing:**

| Enter in *Custom filter string…* | Effect |
|---|---|
| `aphaser` | Phaser |
| `vibrato=f=6:d=0.5` | Vibrato |
| `tremolo=f=5:d=0.5` | Tremolo |
| `highpass=f=100,lowpass=f=8000` | A band-pass made from two filters |
| `vibrato=f=6,tremolo` | The string the project's own test uses |

For a pitch shift at another sample rate the formula is `asetrate = round(sampleRate × 2^(semitones/12))`. At 48 kHz, −5 semitones builds `asetrate=35959,aresample=48000,atempo=1.334840`.

## Adding an effect

The catalogue is an array, `EFFECTS` in `src/core/recipes.ts`; every entry is picked up by the picker and by the test that runs the whole catalogue. See [Development](development.md#add-an-effect).
