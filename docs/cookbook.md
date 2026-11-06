# Cookbook

Complete workflows, start to finish. Each recipe says what to click, what Sound Lab runs and which files you should end up with. File names follow the rules in [Output file naming](commands.md#output-file-naming). Numbers marked **real run** come from running the compiled code against FFmpeg 6.1.1 on synthetic test signals; your material will give different numbers.

- [Chop a drum session into one-shots](#chop-a-drum-session-into-one-shots)
- [Slice a loop to the beat](#slice-a-loop-to-the-beat)
- [Master a podcast episode](#master-a-podcast-episode)
- [Prepare game audio in bulk](#prepare-game-audio-in-bulk)
- [Pull quotes out of an interview](#pull-quotes-out-of-an-interview)
- [Add subtitles to a video](#add-subtitles-to-a-video)
- [Record a voice-over and clean it up](#record-a-voice-over-and-clean-it-up)
- [Make test signals](#make-test-signals)
- [Duck music under a voice with a recipe](#duck-music-under-a-voice-with-a-recipe)
- [Send every result to one folder](#send-every-result-to-one-folder)

---

## Chop a drum session into one-shots

**Goal:** one file per hit, each at the same peak level, ready for a sampler.

**Test material (real run):** `session.wav`, 7 seconds, stereo, 24-bit: a decaying 180 Hz tone every 1.1 s over a −60 dBFS noise bed, standing in for a recorded session.

1. **Preview.** Open `session.wav` and click **Find silence**. Check that each hit is its own chip. If two hits merge, or one hit splits, adjust `soundLab.silence.thresholdDb` and `soundLab.silence.minDuration` (see [Configuration](configuration.md#silence-detection)).
2. **Split.** Right-click the file, then **Sound Lab → Split on Silence…**. Accept −40 dBFS and 0.35 s. (Sound Lab saves your answers to your user settings.)
3. **Result.** A folder `session_split/` with one file per hit:

   | File | Starts at | Length | Peak |
   |---|---|---|---|
   | `session_001.wav` | 0.000 s | 0.630 s | −7.6 dB |
   | `session_002.wav` | 1.070 s | 0.660 s | −7.5 dB |
   | `session_003.wav` | 2.170 s | 0.660 s | −7.5 dB |
   | `session_004.wav` | 3.270 s | 0.660 s | −7.5 dB |
   | `session_005.wav` | 4.370 s | 0.660 s | −7.5 dB |
   | `session_006.wav` | 5.470 s | 0.660 s | −7.5 dB |
   | `session_007.wav` | 6.570 s | 0.430 s | −7.5 dB |

   Six silences were found and seven segments kept. Each segment starts 30 ms before its hit (the padding), except the first, which starts at 0. Every piece has a 2 ms fade-in and a 5 ms fade-out so it does not click. The last is shorter because the file ends at 7.0 s.

   The command for the second piece (**real output**; the odd last digits are the detector's timestamps):

   ```bash
   $ ffmpeg -hide_banner -nostdin -y -ss 1.070040 -t 0.659520 -i session.wav -map 0:a:0 -af afade=t=in:st=0:d=0.002,afade=t=out:st=0.654520:d=0.005 -c:a pcm_s24le session_split/session_002.wav
   ```
4. **Equalize.** Select all seven in the Explorer, right-click, **Normalize Loudness… → Peak -0.1 dBFS**. You get `session_001_peak-0.1.wav` … `session_007_peak-0.1.wav`. Each file is normalized on its own, so a soft hit ends up as loud as a hard one; if you want to keep the relative dynamics, skip this step.
5. **Convert.** Select the normalized files, **Convert Format… → FLAC → 24-bit → Keep → Keep** to get `.flac` copies (`session_001_peak-0.1.flac`, …).

**Tuning tips**

| Problem | Try |
|---|---|
| Two hits come out as one file | Lower **minimum silence** (for example 0.15 s) |
| One long hit is cut in two | Raise **minimum silence**, or lower the threshold (for example −50 dB) |
| Noise between hits counts as sound | Raise the threshold (for example −30 dB) |
| Hits start with a click | Raise `soundLab.silence.padding` |

---

## Slice a loop to the beat

**Goal:** cut a two-bar 128 BPM loop into eighth notes with no drift.

**The math.** Two bars of 4/4 are 8 beats: 8 × 60 ÷ 128 = 3.75 s, which is 165,375 samples at 44.1 kHz. An eighth note (0.5 beat) is 60 ÷ 128 × 0.5 = 0.234375 s = **10,335.9375 samples**, not a whole number.

1. Right-click `loop_128.wav`, then **Sound Lab → Slice into Equal Chunks…**.
2. Choose **By tempo (BPM + beats per slice)**, enter `128`, then `0.5`.
3. Sound Lab cuts in one `asegment` pass and writes `loop_128_slices/loop_128_001.wav` … `loop_128_016.wav`.

**Real output:** 15 cuts, 16 slices. Every cut position is rounded on its own (`round(i × 10335.9375)`), so the first cuts are at samples 10336, 20672, 31008, 41344 and the last at 155039. Fifteen slices are 10,336 samples long and one is 10,335, which sums to exactly 165,375. A slice never drifts because rounding error does not accumulate.

For other grids, change the beats: `1` for quarter notes, `0.25` for sixteenths, `4` for whole bars.

---

## Master a podcast episode

**Goal:** a −16 LUFS, clean-sounding mono MP3, plus a transcript.

1. **Settings.** Set `soundLab.normalize.targetLufs` to `-16` and `soundLab.normalize.truePeak` to `-1.5` ([Configuration](configuration.md#ready-made-settingsjson-blocks)).
2. **Clean up.** Right-click `episode.wav`, **Apply Effects / Filter Chain…**. Tick **High-pass filter**, **De-hum**, **Compressor** and **Limiter**; enter 80 Hz, your mains frequency (50 or 60), −18 dB with ratio 4, and −1 dBFS. The result is `episode_fx.wav`. The chain that runs (**real output**):

   ```bash
   $ ffmpeg -hide_banner -nostdin -y -i episode.wav -map 0:a:0 -af highpass=f=80:poles=2,bandreject=f=50:width_type=q:w=30,bandreject=f=100:width_type=q:w=30,bandreject=f=150:width_type=q:w=30,acompressor=threshold=-18dB:ratio=4:attack=10:release=120:makeup=2,alimiter=limit=0.8913:level=0 -c:a pcm_s24le episode_fx.wav
   ```

3. **Normalize.** **Normalize Loudness… → Loudness -16 LUFS** gives `episode_fx_-16LUFS.wav` after two passes.
4. **Verify.** Run **Analyze Loudness & Levels** on it. Integrated loudness should be close to −16 LUFS and true peak at or below −1.5 dBTP. Very dynamic material can fall short of the target when the true-peak ceiling limits the gain; the report tells you.
5. **Deliver.** **Convert Format… → MP3 → 128k → Keep → Mono** gives `episode_fx_-16LUFS.mp3`:

   ```bash
   $ ffmpeg -hide_banner -nostdin -y -i episode_fx_-16LUFS.wav -map 0:a:0 -map_metadata 0 -c:a libmp3lame -b:a 128k -ac 1 episode_fx_-16LUFS.mp3
   ```

6. **Transcribe.** Run **Transcribe Audio…** on `episode.wav` to get `episode.srt`, `episode.vtt`, `episode.txt` and `episode.json` (see [Transcription](transcription.md)).

---

## Prepare game audio in bulk

**Goal:** a mono 48 kHz Ogg copy of every sound effect, keeping the folder layout.

1. Right-click your `Assets/Audio` folder, then **Sound Lab → Batch Convert Folder…**.
2. Choose **OGG**. A bitrate prompt appears, but Ogg uses fixed variable-bitrate quality 7 and ignores it. Choose **48000** for the sample rate and **Mono** for channels.
3. Confirm the dialog: `Convert 214 files to OGG into converted_ogg/ ?`.
4. Watch the progress notification (`sfx/step_01.wav (3/214)`). A file that fails is logged as skipped; a warning at the end counts them.

Each file runs:

```bash
$ ffmpeg -hide_banner -nostdin -y -i step_01.wav -map 0:a:0 -map_metadata 0 -c:a libvorbis -q:a 7 -ar 48000 -ac 1 converted_ogg/sfx/step_01.ogg
```

You end up with `Assets/Audio/converted_ogg/sfx/step_01.ogg` and so on. Running it again overwrites the files in `converted_ogg/`. Add `converted_*` to `soundLab.explorer.exclude` so the Samples view does not list the copies (the pattern is shown in [Samples view](samples-view.md#choosing-which-files-appear)).

---

## Pull quotes out of an interview

**Goal:** save the sentence "…" as its own clip.

1. Right-click `interview.wav`, **Transcribe Audio…**. Files `interview.srt`, `.vtt`, `.txt` and `.json` appear and the `.srt` opens.
2. Open `interview.wav` in the audio editor. The **Transcript** panel opens with the lines.
3. Type a word from the quote into **Filter…**.
4. **Shift-click** the line. The waveform selects exactly that cue.
5. Press `E`, then Enter at the fade prompt. If the cue ran from 12.3 s to 18.4 s you get `interview_0.12-0.18.wav`.

To grab several quotes, repeat steps 3 to 5. **copy text** copies the whole transcript if you need the words as well.

---

## Add subtitles to a video

**Goal:** a soft subtitle track in an MP4, without re-encoding.

1. Right-click `talk.mp4`, **Sound Lab → Add Subtitles to Video…**.
2. Choose **Transcribe this video first**. Sound Lab transcribes `talk.mp4` and writes `talk.srt` and the other formats. (`srt` or `vtt` must be in `soundLab.transcription.outputFormats`.)
3. Accept the language `eng` or enter another ISO 639-2 code.
4. Result: `talk_subtitled.mp4` with a `mov_text` track tagged `eng`. Video and audio are copied untouched:

   ```bash
   $ ffmpeg -hide_banner -nostdin -y -i talk.mp4 -i talk.srt -map 0 -map 1:0 -c copy -c:s mov_text -metadata:s:s:0 language=eng talk_subtitled.mp4
   ```

If you already have a hand-edited `talk.srt` next to the video, Sound Lab offers it as the first choice, so you can fix the transcript in a text editor and then mux.

---

## Record a voice-over and clean it up

**Goal:** a clean, level voice-over file from a microphone.

1. Right-click your `vo` folder, **Sound Lab → Record Sample from Microphone…**. Pick the input device, enter `0` for "until you press Cancel", and speak. macOS may ask for permission to use the microphone the first time.
2. Press **Cancel** on the notification (`Recording — press Cancel to stop`, with `● REC 0:42` counting up). The file is finalized properly: `recording-20261103-143015.wav`.
3. Open it. Click **Find silence**, select the usable take, press `E`. You get `recording-20261103-143015_0.04-0.19.wav` (the take from 0:04 to 0:19, floored to whole seconds).
4. **Apply Effects…**: **High-pass filter** 80 Hz and **Denoise (FFT)** 12 dB give `…_fx.wav`.
5. **Normalize Loudness… → Loudness -16 LUFS** for the final level.

---

## Make test signals

**Sound Lab: Generate Tone / Noise…** writes reference material straight into your workspace:

| You want | Choose | Settings | File |
|---|---|---|---|
| A line-up tone | Sine | 1000 Hz, 10 s, −20 dBFS | `sine_1000Hz_10s.wav` |
| Noise for speaker or room tests | Pink noise | 30 s, −12 dBFS | `pink_30s.wav` |
| A sweep for impulse-response capture | Log sine sweep | end 20000 Hz, 10 s, −6 dBFS | `sweep_20000Hz_10s.wav` |
| Silence for padding | Digital silence | 5 s | `silence_5s.wav` |
| A tuning reference | Sine | 440 Hz, 2 s, −6 dBFS | `sine_440Hz_2s.wav` |

Tone levels are exact because the extension builds tones with `aevalsrc` (FFmpeg's own `sine` source is fixed at −18 dBFS); a −20 dBFS sine measured −20.0 dB. Noise comes from `anoisesrc`, whose level is an amplitude setting: white noise peaked at the level you ask for, but in testing pink noise peaked about 2 dB lower and brown noise about 1.5 dB lower. Run **Analyze Loudness & Levels** on the result if you want to confirm.

---

## Duck music under a voice with a recipe

**Goal:** lower a music bed whenever the voice is present.

1. Run **Sound Lab: FFmpeg Recipes (open in terminal)…** and pick **Sidechain duck music under voice**.
2. Sound Lab types this into a terminal named "Sound Lab" and does **not** press Enter:

   ```bash
   ffmpeg -i music.wav -i voice.wav -filter_complex "[0:a][1:a]sidechaincompress=threshold=0.05:ratio=8[d];[d][1:a]amix=inputs=2[a]" -map "[a]" ducked.wav
   ```

3. Edit `music.wav`, `voice.wav` and `ducked.wav` to your file names, adjust `threshold` and `ratio` to taste, and press Enter.

Recipes run in the terminal, outside Sound Lab's job system, so there is no progress notification or **Cancel** button. The recipe has no `-y`, so ffmpeg asks before overwriting an existing `ducked.wav`.

---

## Send every result to one folder

**Goal:** keep sources clean; collect every output under `export/`, one folder per source.

```jsonc
{
  "soundLab.output.directory": "${workspaceFolder}/export/${fileBasenameNoExtension}"
}
```

Now trimming `drums/kick.wav` writes `export/kick/kick_0.00-0.01.wav`. Collisions still get `-1`, `-2` unless you also set `soundLab.output.overwrite` to `true`. Remember that **Record** and **Generate** write into the folder you pick, and **Batch Convert** writes `converted_<fmt>/` inside the folder you pick. All variables are listed in [Configuration](configuration.md#output-location).

---

## Habits that save time

- **Multi-select in the Explorer** for Convert, Normalize, Effects, Split on Silence, Concatenate and Extract Audio.
- **Read the log** (**Sound Lab: Show FFmpeg Log**) to see the exact command. You can paste it into a terminal to repeat or tweak it.
- **Analyze after normalizing.** It takes seconds and shows the real loudness and true peak.
- **Work in WAV, deliver in lossy.** Edits keep the source format; trimming an MP3 re-encodes it. Convert to WAV first for repeated edits.
