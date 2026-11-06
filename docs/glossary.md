# Glossary

Short definitions of the audio and FFmpeg terms used in these docs.

**Anti-click fade.** A fade of a few milliseconds at a cut so the waveform does not jump from zero to a non-zero value, which would be heard as a click. Sound Lab's cuts default to a 5 ms fade-in and a 10 ms fade-out.

**argv.** The list of arguments given to a program, as opposed to one shell command string. Sound Lab always passes ffmpeg an argv array, so file names cannot be misread as shell syntax.

**asegment.** An FFmpeg filter that splits a stream at given sample positions. Sound Lab uses it for slicing because it is sample-exact. See [FFmpeg internals](ffmpeg-internals.md#5-sample-accurate-slicing).

**atempo.** An FFmpeg filter that changes speed without changing pitch. Sound Lab keeps each instance within 0.5 to 2 (the limit of older FFmpeg versions) and chains several for larger changes.

**Bit depth.** How many bits describe each sample: 16 (CD quality), 24 (studio) or 32-bit float. Higher depth gives more dynamic range and headroom.

**Bitrate.** Data per second of a lossy file, for example 320 kb/s for MP3. Ogg Vorbis in Sound Lab uses a quality setting instead.

**BPM.** Beats per minute, the tempo. One beat lasts `60 / BPM` seconds.

**Chunk.** A 10-minute piece of audio uploaded as one request by the `openai-compatible` transcription backend.

**Crest factor.** The ratio of peak level to RMS level, a measure of how "spiky" a signal is.

**Custom editor.** A VS Code feature that lets an extension provide its own editor for certain files. The Sound Lab audio editor is one.

**DC offset.** A constant shift of the waveform away from zero. Small values are normal; large ones waste headroom.

**dBFS.** Decibels relative to digital full scale: 0 dBFS is the largest value a file can hold, and everything else is negative.

**dBTP.** Decibels of *true peak*, the highest level of the reconstructed analogue waveform, which can exceed the highest sample value. A ceiling such as −1 dBTP leaves headroom for lossy encoding.

**EBU R128 and ATSC A/85.** Loudness standards for broadcast: −23 LUFS in Europe (EBU R128) and −24 LKFS in the United States (ATSC A/85). Sound Lab lists both, with streaming targets, in its Levels report.

**ffprobe.** FFmpeg's companion tool that reads a file's streams, tags and chapters without decoding. Sound Lab uses it for every file's details.

**Filtergraph.** FFmpeg's description of how audio filters connect, such as `-af a,b,c` for a chain or `-filter_complex` for several inputs and outputs.

**ggml.** The model file format used by whisper.cpp and by FFmpeg's `whisper` filter, with names like `ggml-base.en.bin`.

**Integrated loudness (LUFS).** The perceived loudness of a whole programme, measured with the ITU BS.1770 weighting. One LU (loudness unit) is one dB.

**lavfi.** FFmpeg's virtual input device for generated signals, as in `-f lavfi -i "aevalsrc=…"`. Sound Lab's tests and its **Generate Tone / Noise…** command use it.

**Linear and dynamic loudnorm.** `loudnorm` in linear mode applies one gain to the whole file (preserving dynamics); in dynamic mode it adapts over time. FFmpeg falls back to dynamic when a pure gain change cannot meet the true-peak or loudness-range limits.

**Loudness range (LRA).** How much the loudness varies over a programme, in LU.

**Lossless and lossy.** Lossless formats (WAV, AIFF, FLAC) can reproduce the original samples exactly; lossy formats (MP3, Ogg Vorbis, Opus, AAC) discard detail to save space, and re-encoding loses more.

**m.ss.** Sound Lab's file-name time stamp for trims: minutes, a dot, then whole seconds, for example `1.15` for 75.3 s. Hours add another dot: `1.02.05`.

**mov_text.** The subtitle codec used inside MP4 and MOV containers. MKV uses `srt`.

**Noise floor.** The level of the background noise in a recording.

**One-shot.** A short sample played once, such as a drum hit.

**PCM.** Pulse-code modulation: uncompressed samples. WAV and AIFF hold PCM.

**Peak normalization and loudness normalization.** Peak normalization raises the whole file until its highest sample reaches a target. Loudness normalization targets perceived loudness (LUFS) instead.

**Quick pick.** VS Code's searchable list prompt, used for formats, effects and normalization targets.

**RMS.** Root-mean-square level, an average of signal energy.

**Sample rate.** Samples per second: 44,100 Hz (CD), 48,000 Hz (video) and so on.

**Sidecar file.** A companion file with the same name as the audio, such as `interview.srt`.

**SRT and VTT.** Plain-text subtitle formats with time ranges. WebVTT starts with the line `WEBVTT` and uses a dot before milliseconds; SRT uses a comma.

**Spectrogram.** A picture of frequency (vertical) over time (horizontal), with colour for intensity.

**True peak.** See dBTP.

**Varispeed.** Changing pitch and speed together, like a tape machine run faster or slower.

**Webview and CSP.** A webview is a web page inside VS Code; the editor's waveform runs in one. A Content-Security-Policy (CSP) restricts what that page may load or run.

**whisper.cpp.** A C/C++ implementation of OpenAI's Whisper speech-recognition model that runs locally. Its command-line tool is `whisper-cli`.
