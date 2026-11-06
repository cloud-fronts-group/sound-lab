# Samples view and menus

The **Sound Lab** icon in the activity bar opens the **Samples** view: every audio file in your workspace in one tree. Sound Lab commands also appear in the Explorer's right-click menu, in the Samples view, in the editor's title bar and in the Command Palette. This page lists exactly where.

## The Samples view

```text
SAMPLES
├─ drums                       12        ← folder (file count)
│  ├─ kick_01.wav              1.1 MB    ← click to open in the audio editor
│  │  ├─ Duration              0:01.000  ← expand a file for details
│  │  ├─ Codec                 pcm_s24le
│  │  ├─ Sample rate           48 kHz
│  │  ├─ Channels              2 (stereo)
│  │  ├─ Bit depth             24-bit
│  │  └─ bpm                   128       ← tags, when present
│  └─ snare_01.wav             …
└─ vocals                      3
```

- **Grouping.** Files are grouped by folder and labelled relative to their workspace folder. In a multi-root workspace the label is prefixed with the workspace name. If all files live in one folder, the folders are skipped and the files are listed directly.
- **Details.** Expanding a file shows duration, codec, sample rate, channels (with layout), bit depth and bitrate where known, and the tags `title`, `artist`, `bpm`, `TBPM`, `key` and `comment` when the file has them. Results are cached until the file's modification time changes.
- **Refreshing.** The view refreshes (after a 400 ms pause) when audio files are created or deleted, and whenever Sound Lab itself writes files. Use the refresh button after changing files from outside VS Code in ways the watcher might miss.
- **Empty view.** With no workspace folder, or when nothing matches the include glob, the tree is empty and VS Code shows the welcome text *No audio files found in this workspace.* with three links: **Record Sample**, **Generate Tone / Noise** and **Open Audio File…**.

### Choosing which files appear

| Setting | Default | Meaning |
|---|---|---|
| `soundLab.explorer.include` | `**/*.{wav,mp3,flac,ogg,oga,opus,m4a,aac,aif,aiff,wma,caf}` | Glob of files to list |
| `soundLab.explorer.exclude` | `**/{node_modules,.git,out,dist}/**` | Glob to leave out |

At most 5,000 files are listed. The default include glob is narrower than the editor's file patterns: it does not list `ac3`, `amr`, `webm` or `mka`, although those open in the audio editor.

Examples:

```jsonc
{
  // Only the sample library
  "soundLab.explorer.include": "samples/**/*.{wav,flac}",
  // Skip renders and exports
  "soundLab.explorer.exclude": "**/{node_modules,.git,out,dist,export,converted_*}/**"
}
```

Editing either setting refreshes the list. The file-system watcher is created at start-up with the include glob you had then, so after changing `include` run **Refresh Samples** (or reload the window) if new files do not show up on their own.

## Where each command appears

| Command | Explorer: file | Explorer: folder | Samples: file | Samples: toolbar | Editor title | Editor buttons |
|---|:-:|:-:|:-:|:-:|:-:|---|
| Open in Audio Editor | ✓ | | ✓ (inline) | | | |
| Show Media Info (ffprobe) | ✓ | | ✓ | | ✓ | **Info** |
| Analyze Loudness & Levels | ✓ | | ✓ | | | **Levels** panel |
| Convert Format… | ✓ | | ✓ | | | **Convert…** |
| Trim / Cut Sample… | ✓ | | ✓ | | | **Export selection** |
| Normalize Loudness… | ✓ | | ✓ | | | **Normalize…** |
| Apply Effects / Filter Chain… | ✓ | | ✓ | | ✓ | **Effects…** |
| Concatenate Files… | ✓ | | | | | |
| Extract Audio from Video… | ✓ | | | | | |
| Slice into Equal Chunks… | ✓ | | ✓ | | | **Slice…** |
| Split on Silence… | ✓ | | ✓ | | | **Split on silence…** |
| Render Waveform Image | ✓ | | ✓ | | | |
| Render Spectrogram Image | ✓ | | ✓ | | | **Spectrogram** panel |
| Transcribe Audio… | ✓ | | ✓ (inline) | | ✓ | **Transcript** panel |
| Add Subtitles to Video… | ✓ | | | | | |
| FFmpeg Recipes (open in terminal)… | ✓ | | | ✓ | | |
| Batch Convert Folder… | | ✓ | | ⋯ menu | | |
| Record Sample from Microphone… | | ✓ | | ✓ | | |
| Generate Tone / Noise… | | ✓ | | ⋯ menu | | |
| Set Transcription API Key | | | | ⋯ menu | | |
| Show FFmpeg Capabilities | | | | ⋯ menu | | (status bar item) |
| Show FFmpeg Log | | | | ⋯ menu | | |
| Refresh Samples | | | | ✓ | | |

Notes:

- Every command except **Refresh Samples** is also in the Command Palette under the **Sound Lab** category. **Refresh Samples** is hidden from the palette.
- The Explorer entries live in a **Sound Lab** submenu that appears for audio and video files and for folders. Within it, items are grouped: open, edit, slice, render, speech, other, folder actions.
- "Toolbar ✓" means a button on the Samples view title bar; "⋯ menu" means the overflow menu of that title bar.
- Multi-select works in the Explorer for commands that accept several files: Convert, Normalize, Apply Effects, Split on Silence, Concatenate and Extract Audio.
- **Open in Audio Editor** and **Transcribe** are also inline buttons on each file in the Samples view.

## Status bar item

The status bar shows the detected FFmpeg version (or a warning if it is missing). Clicking it runs **Show FFmpeg Capabilities**.
