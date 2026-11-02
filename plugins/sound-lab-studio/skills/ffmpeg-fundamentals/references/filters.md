# Audio filter cheat-sheet

| Job | Filter(s) | Example |
|---|---|---|
| Gain | `volume` | `volume=-3dB` · `volume='if(lt(t,2),t/2,1)':eval=frame` (ramp) |
| Fades | `afade`, `acrossfade` | `afade=t=out:st=27:d=3` · `[0][1]acrossfade=d=2:c1=tri:c2=tri` |
| Trim / pad | `atrim`, `apad`, `adelay` | `atrim=start_sample=48000:end_sample=96000` · `apad=whole_dur=30` · `adelay=1500:all=1` |
| Mix / join | `amix`, `amerge`, `join`, `concat` | `amix=inputs=3:normalize=0:duration=first` |
| Ducking | `sidechaincompress` | `[music][voicekey]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=400` |
| Dynamics | `acompressor`, `alimiter`, `dynaudnorm`, `agate` | `alimiter=limit=0.89:level=0` |
| Loudness | `loudnorm`, `ebur128` | two-pass `loudnorm … linear=true` (see the loudness-mastering skill) |
| EQ | `highpass`, `lowpass`, `equalizer`, `bass`, `treble`, `anequalizer` | `equalizer=f=3000:t=q:w=1:g=-4` |
| De-noise | `afftdn`, `anlmdn`, `arnndn` (model file) | `afftdn=nr=12:nf=-40` |
| Repair | `adeclick`, `adeclip`, `dcshift` | |
| De-ess | `deesser` | `deesser=i=0.4:f=0.5` |
| Time / pitch | `atempo`, `asetrate+aresample`, `rubberband` | `atempo=1.25` · `rubberband=pitch=1.059463` |
| Reverse | `areverse` | |
| Space | `aecho`, `afir` (convolution with an IR), `stereowiden`, `extrastereo`, `haas` | `[0][1]afir=dry=8:wet=6` |
| Mod FX | `chorus`, `flanger`, `aphaser`, `tremolo`, `vibrato` | |
| Lo-fi | `acrusher`, `asoftclip` | `acrusher=bits=8:samples=4:mode=log` |
| Channels | `pan`, `channelsplit`, `channelmap`, `amerge` | `pan=mono|c0=0.5*c0+0.5*c1` |
| Silence | `silencedetect`, `silenceremove` | `silenceremove=start_periods=1:start_threshold=-50dB` |
| Split exactly | `asegment` | `asegment=samples=22050|44100[a][b][c]` |
| Analysis | `astats`, `volumedetect`, `ebur128`, `aspectralstats` | |
| Visuals | `showwavespic`, `showspectrumpic`, `showwaves`, `showcqt`, `avectorscope` | `showspectrumpic=s=1600x600:legend=1:fscale=log` |
| Sources | `aevalsrc`, `sine`, `anoisesrc`, `anullsrc` | `anullsrc=r=48000:cl=stereo` |
| Speech-to-text | `whisper` (FFmpeg 8+, `--enable-whisper`) | `whisper=model=ggml-base.en.bin:destination=out.srt:format=srt` |

## Live input helpers
- HTTP/Icecast/HLS: `-reconnect 1 -reconnect_streamed 1 -reconnect_on_network_error 1 -reconnect_delay_max 5 -i URL`
- Treat a file as live: `-re -i file` · loop forever: `-stream_loop -1 -i file`
- Outputs: RTMP `-c:a aac -f flv rtmp://…` · SRT/UDP `-f mpegts srt://…` · Icecast `-content_type audio/mpeg -f mp3 icecast://source:pw@host:8000/mount` · HLS `-f hls -hls_time 6 -hls_list_size 10 -hls_flags delete_segments out.m3u8`
