// Pure ffmpeg argument builders. Everything returns argv arrays (never shell strings), so paths with spaces are safe.
import { ffBase } from './ffmpeg';

export type Format = 'wav' | 'flac' | 'aiff' | 'mp3' | 'ogg' | 'opus' | 'm4a';
export const FORMATS: Format[] = ['wav', 'flac', 'aiff', 'mp3', 'ogg', 'opus', 'm4a'];
export const LOSSLESS: Format[] = ['wav', 'flac', 'aiff'];

export interface EncodeOptions {
  format: Format;
  bitDepth?: 16 | 24 | 32;
  sampleRate?: number;     // 0/undefined = keep
  channels?: number;       // 0/undefined = keep
  bitrate?: string;        // lossy formats, e.g. "320k"
}

/** Codec arguments for an output format. */
export function codecArgs(o: EncodeOptions): string[] {
  const args: string[] = [];
  const bd = o.bitDepth ?? 24;
  switch (o.format) {
    case 'wav':
      args.push('-c:a', bd === 16 ? 'pcm_s16le' : bd === 32 ? 'pcm_f32le' : 'pcm_s24le');
      break;
    case 'aiff':
      args.push('-c:a', bd === 16 ? 'pcm_s16be' : bd === 32 ? 'pcm_s32be' : 'pcm_s24be');
      break;
    case 'flac':
      // FLAC stores 24-bit inside s32 sample format; bits_per_raw_sample tells the encoder the real depth.
      args.push('-c:a', 'flac', '-compression_level', '8');
      if (bd === 16) { args.push('-sample_fmt', 's16'); }
      else { args.push('-sample_fmt', 's32', '-bits_per_raw_sample', '24'); }
      break;
    case 'mp3':
      args.push('-c:a', 'libmp3lame', '-b:a', o.bitrate ?? '320k');
      break;
    case 'ogg':
      args.push('-c:a', 'libvorbis', '-q:a', '7');
      break;
    case 'opus':
      args.push('-c:a', 'libopus', '-b:a', o.bitrate && parseInt(o.bitrate, 10) <= 256 ? o.bitrate : '160k');
      break;
    case 'm4a':
      args.push('-c:a', 'aac', '-b:a', o.bitrate && parseInt(o.bitrate, 10) <= 320 ? o.bitrate : '256k');
      break;
  }
  let sr = o.sampleRate;
  if (o.format === 'opus' && sr && ![8000, 12000, 16000, 24000, 48000].includes(sr)) { sr = 48000; }
  if (sr && sr > 0) { args.push('-ar', String(sr)); }
  if (o.channels && o.channels > 0) { args.push('-ac', String(o.channels)); }
  return args;
}

export function formatFromPath(p: string): Format | undefined {
  const ext = p.split('.').pop()?.toLowerCase();
  if (ext === 'aif') { return 'aiff'; }
  if (ext === 'oga') { return 'ogg'; }
  return FORMATS.includes(ext as Format) ? ext as Format : undefined;
}

export function convert(input: string, output: string, o: EncodeOptions): string[] {
  return [...ffBase(), '-i', input, '-map', '0:a:0', '-map_metadata', '0', ...codecArgs(o), output];
}

export interface TrimOptions extends EncodeOptions {
  start: number;
  end: number;
  fadeIn?: number;
  fadeOut?: number;
}

export function trim(input: string, output: string, o: TrimOptions): string[] {
  const dur = Math.max(0, o.end - o.start);
  const filters: string[] = [];
  if (o.fadeIn && o.fadeIn > 0) { filters.push(`afade=t=in:st=0:d=${o.fadeIn}`); }
  if (o.fadeOut && o.fadeOut > 0) { filters.push(`afade=t=out:st=${Math.max(0, dur - o.fadeOut).toFixed(6)}:d=${o.fadeOut}`); }
  return [
    ...ffBase(), '-ss', o.start.toFixed(6), '-t', dur.toFixed(6), '-i', input,
    '-map', '0:a:0', ...(filters.length ? ['-af', filters.join(',')] : []), ...codecArgs(o), output,
  ];
}

/**
 * Sample positions at which to cut `totalSamples` into slices of `samplesPerSlice` (may be fractional, e.g. 128 BPM).
 * Positions are rounded per cut so slices never drift.
 */
export function slicePoints(totalSamples: number, samplesPerSlice: number): number[] {
  const pts: number[] = [];
  for (let i = 1; ; i++) {
    const p = Math.round(i * samplesPerSlice);
    if (p >= totalSamples - 1) { break; }
    pts.push(p);
  }
  return pts;
}

/** Sample-accurate split with the asegment filter: one ffmpeg pass, N outputs. */
export function sliceAt(input: string, outputs: string[], points: number[], o: EncodeOptions): string[] {
  if (outputs.length !== points.length + 1) { throw new Error('outputs must be points + 1'); }
  if (!points.length) { return convert(input, outputs[0], o); }
  const labels = outputs.map((_, i) => `[s${i}]`).join('');
  const args = [...ffBase(), '-i', input, '-filter_complex', `[0:a:0]asegment=samples=${points.join('|')}${labels}`];
  outputs.forEach((out, i) => args.push('-map', `[s${i}]`, ...codecArgs(o), out));
  return args;
}

export function extractAudio(input: string, output: string, o: EncodeOptions | 'copy'): string[] {
  const enc = o === 'copy' ? ['-c:a', 'copy'] : codecArgs(o);
  return [...ffBase(), '-i', input, '-vn', '-sn', '-dn', '-map', '0:a:0', ...enc, output];
}

export function applyFilter(input: string, output: string, filterChain: string, o: EncodeOptions): string[] {
  return [...ffBase(), '-i', input, '-map', '0:a:0', '-af', filterChain, ...codecArgs(o), output];
}

// ---------- Loudness ----------

export interface LoudnormTarget { i: number; tp: number; lra: number; }

export function loudnormAnalyze(input: string, t: LoudnormTarget): string[] {
  return ['-hide_banner', '-nostdin', '-i', input, '-map', '0:a:0',
    '-af', `loudnorm=I=${t.i}:TP=${t.tp}:LRA=${t.lra}:print_format=json`, '-f', 'null', '-'];
}

export interface LoudnormMeasured {
  input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string;
}

export function loudnormApply(input: string, output: string, t: LoudnormTarget, m: LoudnormMeasured, o: EncodeOptions, sourceRate: number): string[] {
  const af = `loudnorm=I=${t.i}:TP=${t.tp}:LRA=${t.lra}:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
    `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`;
  // loudnorm upsamples to 192 kHz internally; resample back to the source rate unless the user chose one.
  const enc = { ...o, sampleRate: o.sampleRate || sourceRate || 48000 };
  return [...ffBase(), '-i', input, '-map', '0:a:0', '-af', af, ...codecArgs(enc), output];
}

export function peakNormalizeFilter(maxVolumeDb: number, targetDb: number): string {
  return `volume=${(targetDb - maxVolumeDb).toFixed(2)}dB`;
}

export function levelsAnalyze(input: string): string[] {
  return ['-hide_banner', '-nostdin', '-i', input, '-map', '0:a:0',
    '-af', 'astats=measure_perchannel=none,volumedetect', '-f', 'null', '-'];
}

export function silenceDetect(input: string, thresholdDb: number, minDur: number): string[] {
  return ['-hide_banner', '-nostdin', '-i', input, '-map', '0:a:0',
    '-af', `silencedetect=noise=${thresholdDb}dB:d=${minDur}`, '-f', 'null', '-'];
}

// ---------- Visuals ----------

export function waveformPng(input: string, output: string, width = 1800, height = 360, color = '#4fc3f7'): string[] {
  return [...ffBase(), '-i', input, '-filter_complex',
    `[0:a:0]aformat=channel_layouts=mono,showwavespic=s=${width}x${height}:colors=${color}:scale=sqrt`,
    '-frames:v', '1', output];
}

export function spectrogramPng(input: string, output: string, width = 1600, height = 600, legend = true): string[] {
  return [...ffBase(), '-i', input, '-filter_complex',
    `[0:a:0]showspectrumpic=s=${width}x${height}:mode=combined:color=intensity:scale=log:fscale=log:legend=${legend ? 1 : 0}`,
    '-frames:v', '1', output];
}

/** Mono float32 PCM on stdout for waveform peak extraction. */
export function pcmForPeaks(input: string, rate: number): string[] {
  return ['-hide_banner', '-nostdin', '-v', 'error', '-i', input, '-map', '0:a:0', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'];
}

/** Preview transcode for formats the webview cannot play natively. */
export function previewTranscode(input: string, output: string): string[] {
  return [...ffBase(), '-v', 'error', '-i', input, '-map', '0:a:0', '-c:a', 'flac', '-compression_level', '0', output];
}

// ---------- Generation / combination ----------

export type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle' | 'white' | 'pink' | 'brown' | 'sweep' | 'silence';

export function generate(output: string, kind: Waveform, seconds: number, freq: number, sampleRate: number, amplitudeDb: number, o: EncodeOptions): string[] {
  const amp = Math.pow(10, amplitudeDb / 20).toFixed(4);
  let src: string;
  const d = seconds;
  switch (kind) {
    case 'sine': src = `aevalsrc='${amp}*sin(2*PI*${freq}*t)':s=${sampleRate}:d=${d}`; break;
    case 'square': src = `aevalsrc='${amp}*sgn(sin(2*PI*${freq}*t))':s=${sampleRate}:d=${d}`; break;
    case 'sawtooth': src = `aevalsrc='${amp}*(2*(t*${freq}-floor(0.5+t*${freq})))':s=${sampleRate}:d=${d}`; break;
    case 'triangle': src = `aevalsrc='${amp}*(2*abs(2*(t*${freq}-floor(0.5+t*${freq})))-1)':s=${sampleRate}:d=${d}`; break;
    case 'white': case 'pink': case 'brown':
      src = `anoisesrc=color=${kind}:amplitude=${amp}:sample_rate=${sampleRate}:duration=${d}`; break;
    case 'sweep':
      // Logarithmic sine sweep 20 Hz → freq (useful for impulse-response capture).
      src = `aevalsrc='${amp}*sin(2*PI*20*${d}/log(${freq}/20)*(exp(t/${d}*log(${freq}/20))-1))':s=${sampleRate}:d=${d}`; break;
    case 'silence': src = `anullsrc=r=${sampleRate}:cl=mono`; break;
  }
  const extra: string[] = kind === 'silence' ? ['-t', String(d)] : [];
  return [...ffBase(), '-f', 'lavfi', '-i', src, ...extra, ...codecArgs({ ...o, sampleRate }), output];
}

export function concat(inputs: string[], output: string, o: EncodeOptions, crossfade = 0): string[] {
  const args = [...ffBase()];
  for (const i of inputs) { args.push('-i', i); }
  let graph: string;
  // Normalise every input to the same rate/layout so concat/acrossfade accept them.
  const sr = o.sampleRate || 48000;
  const prep = inputs.map((_, i) => `[${i}:a:0]aresample=${sr},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`).join(';');
  if (crossfade > 0 && inputs.length > 1) {
    let prev = 'a0';
    const steps: string[] = [];
    for (let i = 1; i < inputs.length; i++) {
      const out = i === inputs.length - 1 ? 'out' : `x${i}`;
      steps.push(`[${prev}][a${i}]acrossfade=d=${crossfade}[${out}]`);
      prev = out;
    }
    graph = `${prep};${steps.join(';')}`;
  } else {
    graph = `${prep};${inputs.map((_, i) => `[a${i}]`).join('')}concat=n=${inputs.length}:v=0:a=1[out]`;
  }
  args.push('-filter_complex', graph, '-map', '[out]', ...codecArgs({ ...o, sampleRate: sr }), output);
  return args;
}

export function muxSubtitles(video: string, subs: string, output: string, language = 'und'): string[] {
  const isMp4 = /\.(mp4|m4v|mov)$/i.test(output);
  return [...ffBase(), '-i', video, '-i', subs, '-map', '0', '-map', '1:0', '-c', 'copy',
    '-c:s', isMp4 ? 'mov_text' : 'srt', `-metadata:s:s:0`, `language=${language}`, output];
}

/** Speech-recognition friendly input: 16 kHz mono 16-bit PCM. */
export function toWhisperWav(input: string, output: string): string[] {
  return [...ffBase(), '-i', input, '-map', '0:a:0', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output];
}

/** Compact upload format for remote APIs, optionally split into chunks. */
export function toUploadChunks(input: string, outputPattern: string, chunkSeconds: number): string[] {
  return [...ffBase(), '-i', input, '-map', '0:a:0', '-ar', '16000', '-ac', '1', '-c:a', 'flac',
    '-f', 'segment', '-segment_time', String(chunkSeconds), '-reset_timestamps', '1', outputPattern];
}

// ---------- Recording ----------

export function recordInput(platform: NodeJS.Platform, inputFormat: string, device: string): string[] {
  const fmt = inputFormat || (platform === 'darwin' ? 'avfoundation' : platform === 'win32' ? 'dshow' : 'pulse');
  let dev = device;
  if (!dev) { dev = fmt === 'avfoundation' ? ':0' : fmt === 'alsa' ? 'default' : fmt === 'dshow' ? '' : 'default'; }
  if (fmt === 'avfoundation' && !dev.includes(':')) { dev = `:${dev}`; }
  if (fmt === 'dshow' && !dev.startsWith('audio=')) { dev = `audio=${dev}`; }
  return ['-f', fmt, '-i', dev];
}

export function record(platform: NodeJS.Platform, inputFormat: string, device: string, output: string, seconds: number, o: EncodeOptions): string[] {
  return ['-hide_banner', '-y', ...recordInput(platform, inputFormat, device),
    ...(seconds > 0 ? ['-t', String(seconds)] : []), ...codecArgs(o), output];
}

export function listDevicesArgs(platform: NodeJS.Platform, inputFormat: string): string[] | undefined {
  const fmt = inputFormat || (platform === 'darwin' ? 'avfoundation' : platform === 'win32' ? 'dshow' : 'pulse');
  if (fmt === 'avfoundation') { return ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']; }
  if (fmt === 'dshow') { return ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']; }
  if (fmt === 'pulse' || fmt === 'alsa') { return ['-hide_banner', '-sources', fmt]; }
  return undefined;
}

export interface Device { id: string; label: string; }

export function parseDevices(platform: NodeJS.Platform, inputFormat: string, output: string): Device[] {
  const fmt = inputFormat || (platform === 'darwin' ? 'avfoundation' : platform === 'win32' ? 'dshow' : 'pulse');
  const devices: Device[] = [];
  const lines = output.split(/\r?\n/);
  if (fmt === 'avfoundation') {
    let inAudio = false;
    for (const l of lines) {
      if (/AVFoundation audio devices/.test(l)) { inAudio = true; continue; }
      if (/AVFoundation video devices/.test(l)) { inAudio = false; continue; }
      const m = /\[(\d+)\]\s+(.+)$/.exec(l);
      if (inAudio && m) { devices.push({ id: m[1], label: m[2].trim() }); }
    }
  } else if (fmt === 'dshow') {
    for (const l of lines) {
      const m = /"([^"]+)"\s+\(audio\)/.exec(l);
      if (m) { devices.push({ id: m[1], label: m[1] }); }
    }
  } else {
    for (const l of lines) {
      const m = /^\s*\*?\s*(\S+)\s+\[(.+)\]/.exec(l);
      if (m && !/^Auto-detected/.test(l)) { devices.push({ id: m[1], label: m[2] }); }
    }
  }
  return devices;
}

// ---------- Effect catalogue for "Apply Effects" ----------

export interface EffectParam { key: string; label: string; default: number | string; }
export interface Effect {
  id: string;
  label: string;
  detail: string;
  params: EffectParam[];
  build: (p: Record<string, string>, ctx: { sampleRate: number }) => string;
}

export function atempoChain(factor: number): string {
  const parts: string[] = [];
  let f = factor;
  while (f > 2) { parts.push('atempo=2'); f /= 2; }
  while (f < 0.5) { parts.push('atempo=0.5'); f /= 0.5; }
  parts.push(`atempo=${f.toFixed(6)}`);
  return parts.join(',');
}

export const EFFECTS: Effect[] = [
  { id: 'gain', label: 'Gain', detail: 'volume=…dB', params: [{ key: 'db', label: 'Gain (dB)', default: 3 }], build: p => `volume=${p.db}dB` },
  { id: 'reverse', label: 'Reverse', detail: 'areverse', params: [], build: () => 'areverse' },
  { id: 'speed', label: 'Change speed (keep pitch)', detail: 'atempo', params: [{ key: 'factor', label: 'Speed factor (0.25–4)', default: 1.5 }], build: p => atempoChain(+p.factor) },
  {
    id: 'pitch', label: 'Pitch shift (keep length)', detail: 'asetrate + aresample + atempo',
    params: [{ key: 'semitones', label: 'Semitones (+/-)', default: 3 }],
    build: (p, c) => { const r = Math.pow(2, +p.semitones / 12); return `asetrate=${Math.round(c.sampleRate * r)},aresample=${c.sampleRate},${atempoChain(1 / r)}`; },
  },
  {
    id: 'varispeed', label: 'Varispeed (tape-style, pitch + speed)', detail: 'asetrate',
    params: [{ key: 'semitones', label: 'Semitones (+/-)', default: -12 }],
    build: (p, c) => `asetrate=${Math.round(c.sampleRate * Math.pow(2, +p.semitones / 12))},aresample=${c.sampleRate}`,
  },
  { id: 'fadein', label: 'Fade in', detail: 'afade=t=in', params: [{ key: 'd', label: 'Fade-in seconds', default: 0.5 }], build: p => `afade=t=in:st=0:d=${p.d}` },
  { id: 'fadeout', label: 'Fade out (end of file)', detail: 'areverse,afade,areverse', params: [{ key: 'd', label: 'Fade-out seconds', default: 0.5 }], build: p => `areverse,afade=t=in:st=0:d=${p.d},areverse` },
  { id: 'trimsilence', label: 'Trim leading/trailing silence', detail: 'silenceremove', params: [{ key: 'db', label: 'Threshold (dB)', default: -50 }], build: p => `silenceremove=start_periods=1:start_threshold=${p.db}dB:start_silence=0.01,areverse,silenceremove=start_periods=1:start_threshold=${p.db}dB:start_silence=0.01,areverse` },
  { id: 'highpass', label: 'High-pass filter', detail: 'highpass', params: [{ key: 'f', label: 'Cutoff Hz', default: 80 }], build: p => `highpass=f=${p.f}:poles=2` },
  { id: 'lowpass', label: 'Low-pass filter', detail: 'lowpass', params: [{ key: 'f', label: 'Cutoff Hz', default: 12000 }], build: p => `lowpass=f=${p.f}:poles=2` },
  { id: 'eq', label: 'Parametric EQ band', detail: 'equalizer', params: [{ key: 'f', label: 'Centre Hz', default: 1000 }, { key: 'g', label: 'Gain dB', default: -3 }, { key: 'q', label: 'Q', default: 1 }], build: p => `equalizer=f=${p.f}:t=q:w=${p.q}:g=${p.g}` },
  { id: 'denoise', label: 'Denoise (FFT)', detail: 'afftdn', params: [{ key: 'nr', label: 'Noise reduction dB (0.01–97)', default: 12 }], build: p => `afftdn=nr=${p.nr}:nf=-40` },
  { id: 'declick', label: 'De-click', detail: 'adeclick', params: [], build: () => 'adeclick' },
  { id: 'dehum', label: 'De-hum (50/60 Hz notch + harmonics)', detail: 'bandreject ×3', params: [{ key: 'f', label: 'Mains Hz (50 or 60)', default: 60 }], build: p => [1, 2, 3].map(h => `bandreject=f=${+p.f * h}:width_type=q:w=30`).join(',') },
  { id: 'compressor', label: 'Compressor', detail: 'acompressor', params: [{ key: 'threshold', label: 'Threshold dB', default: -18 }, { key: 'ratio', label: 'Ratio', default: 4 }], build: p => `acompressor=threshold=${p.threshold}dB:ratio=${p.ratio}:attack=10:release=120:makeup=2` },
  { id: 'limiter', label: 'Limiter', detail: 'alimiter', params: [{ key: 'db', label: 'Ceiling dBFS', default: -1 }], build: p => `alimiter=limit=${Math.pow(10, +p.db / 20).toFixed(4)}:level=0` },
  { id: 'echo', label: 'Echo / delay', detail: 'aecho', params: [{ key: 'ms', label: 'Delay ms', default: 250 }, { key: 'decay', label: 'Decay 0–1', default: 0.4 }], build: p => `aecho=0.8:0.85:${p.ms}:${p.decay}` },
  { id: 'reverb', label: 'Simple reverb', detail: 'aecho multi-tap', params: [], build: () => 'aecho=0.8:0.7:40|57|83|111:0.4|0.3|0.25|0.2' },
  { id: 'chorus', label: 'Chorus', detail: 'chorus', params: [], build: () => 'chorus=0.6:0.9:50|60:0.4|0.32:0.25|0.4:2|1.3' },
  { id: 'flanger', label: 'Flanger', detail: 'flanger', params: [], build: () => 'flanger' },
  { id: 'bitcrush', label: 'Bitcrusher', detail: 'acrusher', params: [{ key: 'bits', label: 'Bits', default: 8 }, { key: 'samples', label: 'Downsample factor', default: 4 }], build: p => `acrusher=bits=${p.bits}:samples=${p.samples}:mix=1:mode=log` },
  { id: 'mono', label: 'Downmix to mono', detail: 'pan', params: [], build: () => 'pan=mono|c0=0.5*c0+0.5*c1' },
  { id: 'swap', label: 'Swap L/R', detail: 'channelmap', params: [], build: () => 'channelmap=map=FR-FL|FL-FR' },
  { id: 'widen', label: 'Stereo widen', detail: 'stereowiden', params: [], build: () => 'stereowiden' },
  { id: 'loop', label: 'Loop N times', detail: 'aloop', params: [{ key: 'n', label: 'Extra repetitions', default: 3 }], build: p => `aloop=loop=${p.n}:size=2147483647` },
  { id: 'custom', label: 'Custom filter string…', detail: 'any -af expression', params: [{ key: 'expr', label: 'FFmpeg audio filter (e.g. "vibrato=f=6,tremolo")', default: '' }], build: p => p.expr },
];
