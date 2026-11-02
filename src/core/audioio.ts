// Decode any media to float buffers (via ffmpeg → f32le on stdout) and encode buffers back through ffmpeg.
// Shared by the composer, auto-tune and DJ engines. No vscode.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runOk } from './ffmpeg';
import { SR, Stereo, writeWavF32 } from './synth';

export interface Tools { ffmpeg: string; ffprobe: string }

/** Decode to 48 kHz stereo float. `af` is an optional filter chain applied while decoding (e.g. atempo for tempo matching). */
export async function decode(ffmpeg: string, file: string, o: { af?: string; signal?: AbortSignal } = {}): Promise<Stereo> {
  const chunks: Buffer[] = [];
  await runOk({
    exe: ffmpeg, signal: o.signal, onStdout: c => chunks.push(c),
    args: ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', ...(o.af ? ['-af', o.af] : []), '-ac', '2', '-ar', String(SR), '-f', 'f32le', '-'],
  });
  const raw = Buffer.concat(chunks);
  const n = Math.floor(raw.length / 8);
  const b = new Stereo(n);
  for (let i = 0; i < n; i++) { b.L[i] = raw.readFloatLE(i * 8); b.R[i] = raw.readFloatLE(i * 8 + 4); }
  return b;
}

/** Decode keeping the source's own rate and channel count (auto-tune preserves both). */
export async function decodeNative(ffmpeg: string, ffprobe: string, file: string, signal?: AbortSignal): Promise<{ rate: number; channels: Float32Array[] }> {
  const pr = await runOk({ exe: ffprobe, args: ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels', '-of', 'json', file] });
  const s = JSON.parse(pr.stdout).streams?.[0];
  if (!s) { throw new Error(`${path.basename(file)} has no audio stream.`); }
  const rate = +s.sample_rate, nch = Math.min(2, +s.channels || 1);
  const chunks: Buffer[] = [];
  await runOk({ exe: ffmpeg, signal, onStdout: c => chunks.push(c), args: ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-ac', String(nch), '-f', 'f32le', '-'] });
  const raw = Buffer.concat(chunks);
  const n = Math.floor(raw.length / (4 * nch));
  const channels = Array.from({ length: nch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) { for (let c = 0; c < nch; c++) { channels[c][i] = raw.readFloatLE((i * nch + c) * 4); } }
  return { rate, channels };
}

export function tmpFile(ext = 'wav'): string {
  return path.join(os.tmpdir(), `soundlab-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

/** Write planar float channels at any rate as a float WAV. */
export function writeWavPlanar(file: string, rate: number, channels: Float32Array[]): void {
  const nch = channels.length, n = channels[0].length;
  const data = Buffer.alloc(n * nch * 4);
  for (let i = 0; i < n; i++) { for (let c = 0; c < nch; c++) { data.writeFloatLE(channels[c][i], (i * nch + c) * 4); } }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(nch, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * nch * 4, 28); h.writeUInt16LE(nch * 4, 32); h.writeUInt16LE(32, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

export interface MasterOptions {
  /** Codec args for the output (from recipes.codecArgs); defaults to 24-bit WAV. */
  codec?: string[];
  /** Integrated loudness target (LUFS). Undefined = no loudness change (peak-safe only). */
  lufs?: number;
  /** Reverb send 0..1 (multi-tap aecho). */
  reverb?: number;
  /** Treat the buffer as a seamless loop: effects tails wrap around and the output is exactly buf.length samples. */
  loop?: boolean;
  /** Extra ffmpeg filters (before loudness). */
  af?: string;
  signal?: AbortSignal;
}

/**
 * Master a float buffer to a file: optional reverb + glue compression, gain to a LUFS target with a −2 dBFS sample-peak
 * limiter (≈ −1 dBTP on drums), encode. Loops are rendered twice and the second copy kept, so reverb/compressor/limiter state wraps seamlessly.
 */
export async function master(t: Tools, buf: Stereo, out: string, o: MasterOptions = {}): Promise<void> {
  const raw = tmpFile('wav');
  writeWavF32(raw, buf);
  const N = buf.length;
  const fx: string[] = [];
  if (o.reverb && o.reverb > 0) {
    const r = Math.min(1, o.reverb);
    fx.push(`aecho=0.9:${(0.6 + 0.35 * r).toFixed(2)}:31|53|79|113|163|229:${[0.32, 0.26, 0.22, 0.18, 0.14, 0.1].map(v => (v * r).toFixed(3)).join('|')}`);
  }
  if (o.af) { fx.push(o.af); }
  fx.push('acompressor=threshold=0.25:ratio=2:attack=25:release=250:makeup=1');
  const input = o.loop ? ['-stream_loop', '1', '-i', raw] : ['-i', raw];
  const trim = o.loop ? [`atrim=start_sample=${N}:end_sample=${2 * N}`, 'asetpts=N/SR/TB'] : [];
  try {
    let gain = 0;
    if (o.lufs !== undefined) {
      const m = await runOk({ exe: t.ffmpeg, signal: o.signal, args: ['-hide_banner', '-nostdin', ...input, '-af', [...fx, ...trim, 'ebur128=framelog=quiet'].join(','), '-f', 'null', '-'] });
      const I = parseFloat(/I:\s+(-?[\d.]+) LUFS/.exec(m.stderr.slice(m.stderr.lastIndexOf('Summary')))?.[1] ?? 'NaN');
      if (isFinite(I)) { gain = o.lufs - I; }
    }
    const chain = [...fx, `volume=${gain.toFixed(2)}dB`, 'alimiter=limit=0.79:level=0:attack=3:release=60:latency=1', ...trim, `aresample=${SR}`].join(',');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await runOk({ exe: t.ffmpeg, signal: o.signal, args: ['-hide_banner', '-nostdin', '-y', ...input, '-af', chain, ...(o.codec ?? ['-c:a', 'pcm_s24le']), out] });
  } finally { fs.rmSync(raw, { force: true }); }
}

/** Encode a buffer as-is (no processing) — for DJ edits that must not change level or timing. */
export async function encode(t: Tools, buf: Stereo, out: string, codec: string[] = ['-c:a', 'pcm_s24le'], signal?: AbortSignal): Promise<void> {
  const raw = tmpFile('wav');
  writeWavF32(raw, buf);
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await runOk({ exe: t.ffmpeg, signal, args: ['-hide_banner', '-nostdin', '-y', '-i', raw, ...codec, out] });
  } finally { fs.rmSync(raw, { force: true }); }
}

export async function durationOf(ffprobe: string, file: string): Promise<number> {
  const r = await runOk({ exe: ffprobe, args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file] });
  return parseFloat(r.stdout) || 0;
}
