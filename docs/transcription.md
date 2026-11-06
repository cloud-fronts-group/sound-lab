# Transcription and subtitles

**Sound Lab: Transcribe Audio…** turns speech into timed text. You choose a backend, and every backend produces the same thing: a list of segments (`start`, `end` in seconds, and `text`) that Sound Lab writes as SRT, VTT, TXT and JSON, shows in the audio editor and can mux into a video as a subtitle track.

```text
                    ┌─ whisper.cpp        ffmpeg → 16 kHz mono WAV → whisper-cli -oj      (local)
 Transcribe ───────▶├─ openai-compatible  ffmpeg → 10-minute FLAC chunks → HTTPS POST    (uploads audio)
                    └─ ffmpeg-whisper     ffmpeg -af whisper=…destination=out.srt         (local)
                                │
                                ▼
                         Segment[] ──▶ .srt  .vtt  .txt  .json   +  editor Transcript panel
```

## Choosing a backend

Set `soundLab.transcription.backend`.

| | `whisper.cpp` (default) | `openai-compatible` | `ffmpeg-whisper` |
|---|---|---|---|
| Runs | On your machine | On the server at the base URL | On your machine, inside ffmpeg |
| Audio leaves your machine | No | **Yes**, to that server | No |
| Needs | `whisper-cli` and a `ggml-*.bin` model | An endpoint, plus an API key for OpenAI | FFmpeg 8+ built with `--enable-whisper`, and a ggml model |
| Language | `-l <code>` or `auto` | `language` field (omitted for `auto`, and when translating) | `language=<code>` or `auto` |
| Translate to English | `-tr` | Uses `/audio/translations` | Not supported (the setting is ignored) |
| Prompt (names, jargon) | `--prompt` | `prompt` field | Not supported (ignored) |
| Progress | Parsed from `progress = N%` lines | Per uploaded chunk | From ffmpeg's `time=` |

Settings that apply to every backend: `soundLab.transcription.language` (`auto` or a code such as `en`, `de`, `ja`), `soundLab.transcription.translateToEnglish`, `soundLab.transcription.prompt` and `soundLab.transcription.outputFormats`. All keys are listed in [Configuration](configuration.md#transcription).

## whisper.cpp (local)

1. Install or build [whisper.cpp](https://github.com/ggml-org/whisper.cpp) so that `whisper-cli` is available (older builds call it `main`; set `soundLab.transcription.whisperCpp.executable` to match).
2. Download a ggml model, for example `ggml-base.en.bin` or `ggml-large-v3-turbo.bin`. The extension links to the model list at `huggingface.co/ggerganov/whisper.cpp`.
3. Run **Transcribe Audio…**. If no model is configured, Sound Lab offers **Choose Model File…** (the path is saved to your user settings as `soundLab.transcription.whisperCpp.model`), **Download Models** (opens the model list in your browser and ends the command) or **Use API Instead** (switches the backend to `openai-compatible` in your user settings and continues).

```jsonc
{
  "soundLab.transcription.backend": "whisper.cpp",
  "soundLab.transcription.whisperCpp.executable": "whisper-cli",
  "soundLab.transcription.whisperCpp.model": "/Users/me/models/ggml-large-v3-turbo.bin",
  "soundLab.transcription.whisperCpp.threads": 8,
  "soundLab.transcription.whisperCpp.extraArgs": ["--max-len", "40"]
}
```

**What runs**

```text
ffmpeg -i <input> -map 0:a:0 -ar 16000 -ac 1 -c:a pcm_s16le <work>/input.wav          (progress 0–10 %)
<executable> -m <model> -f <work>/input.wav -oj -of <work>/out -pp -l <lang|auto>      (progress 10–100 %)
             [-tr] [--prompt "<prompt>"] [-t <threads>] [<extraArgs…>]
```

`-oj` makes whisper.cpp write `out.json`, whose `transcription[].offsets` (milliseconds) and `text` become segments. `threads` of 0 leaves whisper.cpp's default. Progress comes from the `progress = N%` lines on its output. Possible failures: no model set, `whisper.cpp model not found: <path>`, or `whisper.cpp did not produce JSON output (is this an old build without -oj?)`.

## OpenAI-compatible API

Any server that implements `POST {baseUrl}/audio/transcriptions` works: OpenAI, Groq, a local `faster-whisper-server`, LocalAI and others.

```jsonc
{
  "soundLab.transcription.backend": "openai-compatible",
  "soundLab.transcription.openai.baseUrl": "https://api.openai.com/v1",
  "soundLab.transcription.openai.model": "whisper-1"
}
```

| Service | `baseUrl` | `model` |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `whisper-1` |
| Groq | `https://api.groq.com/openai/v1` | `whisper-large-v3` |
| Local faster-whisper-server | `http://localhost:8000/v1` | `Systran/faster-whisper-small` |

**API key.** Run **Sound Lab: Set Transcription API Key**. It is stored in VS Code's secret storage. If no key is stored, `OPENAI_API_KEY` is used. A key is **required** only when the base URL contains `api.openai.com` (Sound Lab prompts for it); other servers receive an `Authorization: Bearer` header only if a key exists. Submit an empty value to remove the stored key.

**What runs**

1. ffmpeg encodes the audio as 16 kHz mono FLAC in **10-minute chunks** (`-f segment -segment_time 600`), which keeps each upload under the common 25 MB limit.
2. For each chunk, a multipart `POST` to `{baseUrl}/audio/transcriptions` (or `/audio/translations` when `translateToEnglish` is on) with fields `file`, `model`, `response_format=verbose_json`, `timestamp_granularities[]=segment`, plus `language` (unless `auto` or translating) and `prompt` when set.
3. If the server rejects `verbose_json` with a 400 that mentions the response format, Sound Lab retries that chunk with `response_format=json` (some models do not offer segment timestamps). With only plain text, the whole chunk becomes one segment.
4. Each chunk's segment times are shifted by the total duration of the chunks before it, so timestamps run continuously over the whole file.

Errors appear as `Transcription API error <status>: <first 400 characters of the body>`.

## FFmpeg 8 `whisper` filter

Needs FFmpeg 8.0 or newer configured with `--enable-whisper`. Set the backend to `ffmpeg-whisper` and point `soundLab.transcription.ffmpegWhisper.model` at a ggml model (Sound Lab asks for the file the first time).

```text
ffmpeg -i <input> -map 0:a:0 -af "aresample=16000,aformat=channel_layouts=mono,whisper=model=<model>:language=<lang>:queue=3:destination=<work>/out.srt:format=srt" -f null -
```

(Simplified: the real call also passes `-hide_banner -nostdin`. The SRT that the filter writes is parsed back into segments.)

Sound Lab checks `ffmpeg -filters` first and fails with a clear message if your build has no `whisper` filter. The model path and destination go through `escapeFilterValue()`, because they sit inside a filtergraph (see [FFmpeg internals](ffmpeg-internals.md#13-escaping-paths-inside-filters)). `translateToEnglish` and `prompt` are not passed to this backend.

## Output

Files are written to the output folder (next to the audio unless you set `soundLab.output.directory`) as `<name>.<ext>` for each format in `soundLab.transcription.outputFormats` (default `["srt", "vtt", "txt", "json"]`). **Re-running replaces them.** Afterwards Sound Lab opens the `.srt` (or `.txt`) beside the editor and shows `Transcribed N segments → .srt, .vtt, …`.

**Real output** from the formatter for two segments:

`interview.srt`

```text
1
00:00:00,200 --> 00:00:02,900
Welcome to the show.

2
00:00:03,400 --> 00:00:07,150
Today we're talking about
sampling.
```

`interview.vtt`

```text
WEBVTT

00:00:00.200 --> 00:00:02.900
Welcome to the show.

00:00:03.400 --> 00:00:07.150
Today we're talking about
sampling.
```

`interview.txt` has one segment per line, without times:

```text
Welcome to the show.
Today we're talking about
sampling.
```

`interview.json` keeps everything, including which backend produced it:

```json
{
  "source": "interview.mp3",
  "backend": "whisper.cpp",
  "language": "auto",
  "createdAt": "2026-11-03T18:00:00.000Z",
  "segments": [
    {
      "start": 0.2,
      "end": 2.9,
      "text": "Welcome to the show."
    },
    {
      "start": 3.4,
      "end": 7.15,
      "text": "Today we're talking about\nsampling."
    }
  ]
}
```

Hours roll over correctly: a segment at 3725.007 s is written `01:02:05,007`. The segment model has an optional `speaker` field, but none of the three backends fills it in, so there is no speaker labelling.

## In the audio editor

When you open an audio file, the editor looks for `<name>.json`, then `.srt`, then `.vtt`, first next to the audio and then in your output folder. If it finds one, the **Transcript** panel shows it with cue ticks along the top of the waveform, and a click on a line plays from there. After you run **Transcribe**, every open editor on that file updates. See [Audio editor](audio-editor.md#transcript).

## Subtitles on a video

1. Run **Transcribe Audio…** on the video itself. Every backend starts with `-map 0:a:0`, so video files work.
2. Run **Add Subtitles to Video…**. Sound Lab offers the `<name>.srt` (or, if there is none, `<name>.vtt`) that it finds next to the video. You can also choose **Choose subtitle file…** (`.srt`, `.vtt` or `.ass`) or **Transcribe this video first** and let Sound Lab do both steps.
3. Enter the language as an ISO 639-2 code (`eng` by default). The result is `<name>_subtitled.<ext>`: an `.mp4`, `.m4v` or `.mov` video keeps its extension and gets a `mov_text` track, and any other container becomes `.mkv` with an `srt` track. The video and audio are copied untouched.

**Transcribe this video first** looks for the `.srt` or `.vtt` it has just written, so `soundLab.transcription.outputFormats` must still include one of them (the default includes both). If neither exists, the command ends without making a file.

```bash
$ ffmpeg -hide_banner -nostdin -y -i talk.mp4 -i talk.srt -map 0 -map 1:0 -c copy -c:s mov_text -metadata:s:s:0 language=eng talk_subtitled.mp4
```

To burn subtitles into the picture instead, use the **Burn subtitles into video** entry in [FFmpeg Recipes](commands.md#recipe-catalogue).

## Getting better transcripts

- **Name the language** instead of leaving it on `auto` when you know it. This avoids mis-detection on short or noisy clips.
- **Use the prompt** for names and jargon: `"soundLab.transcription.prompt": "Ableton, sidechain, LUFS"`. Where the prompt is supported, it nudges the spelling of those words.
- **Mind the chunk seams** with the API backend: files are cut every 10 minutes, not at pauses, so a word on the boundary can be split. Timestamps stay continuous.
- **Remove silence and music first.** Whisper-family models sometimes invent text over silence. Splitting on silence or trimming the intro can help.
- **Pick the model to match the job.** Smaller ggml models are faster; larger ones are more accurate. `.en` models are English-only.

## Privacy and cost

- `whisper.cpp` and `ffmpeg-whisper` never send audio anywhere.
- `openai-compatible` uploads your audio, in 16 kHz mono FLAC, to the base URL you configured. A hosted service may bill per minute of audio, and its retention policy applies. Use a `localhost` URL to keep everything on your machine.
- The API key is held in VS Code's secret storage, sent only in the `Authorization` header, and not written to the log.

## Troubleshooting

See [Troubleshooting](troubleshooting.md#transcription) for each error message above and its fix.
