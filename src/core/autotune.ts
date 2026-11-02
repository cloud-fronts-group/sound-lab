// Auto-tune: YIN pitch tracking → snap to the key/scale (with hysteresis, retune speed and amount) → pitch-synchronous
// overlap-add (TD-PSOLA) pitch shifting. Duration, sample rate and channel count are preserved exactly; unvoiced audio
// and frames needing no correction pass through bit-transparently-ish (perfect-reconstruction grains). No vscode.
import * as path from 'path';
import { hzToMidi, midiToHz, noteName, scalePitchClasses, snapMidi, SCALES } from './theory';
import { decodeNative, writeWavPlanar, tmpFile, Tools } from './audioio';
import { runOk } from './ffmpeg';
import * as fs from 'fs';

export interface PitchFrame { t: number; hz: number; voiced: boolean; clarity: number }

/** One-pole-pair low-pass + decimation, so YIN runs on ~24 kHz audio (4× less work, same resolution after interpolation). */
function decimate(x: Float32Array, rate: number): { y: Float32Array; rate: number } {
  const d = Math.max(1, Math.floor(rate / 20000));
  if (d === 1) { return { y: x, rate }; }
  const a = 1 - Math.exp(-2 * Math.PI * (rate / d * 0.42) / rate);
  let s1 = 0, s2 = 0;
  const y = new Float32Array(Math.floor(x.length / d));
  for (let i = 0, j = 0; i < x.length; i++) { s1 += a * (x[i] - s1); s2 += a * (s1 - s2); if (i % d === 0 && j < y.length) { y[j++] = s2; } }
  return { y, rate: rate / d };
}

/**
 * YIN fundamental-frequency tracker (de Cheveigné & Kawahara 2002) with parabolic refinement, an RMS gate and a
 * median filter against octave jumps. Frames every `hopSec`.
 */
export function yinTrack(x: Float32Array, rate: number, o: { minHz?: number; maxHz?: number; hopSec?: number; threshold?: number; gateDb?: number } = {}): PitchFrame[] {
  const { y, rate: r } = decimate(x, rate);
  const minHz = o.minHz ?? 70, maxHz = o.maxHz ?? 1100, th = o.threshold ?? 0.15;
  const tauMax = Math.ceil(r / minHz), tauMin = Math.max(2, Math.floor(r / maxHz));
  const W = Math.max(tauMax + 2, Math.round(r * 0.02));
  const hop = Math.max(1, Math.round(r * (o.hopSec ?? 0.005)));
  const gate = Math.pow(10, (o.gateDb ?? -45) / 20);
  const d = new Float64Array(tauMax + 1);
  const frames: PitchFrame[] = [];
  for (let start = 0; start + W + tauMax < y.length; start += hop) {
    const t = (start + W / 2) / r;
    let e = 0; for (let i = 0; i < W; i++) { e += y[start + i] * y[start + i]; }
    if (Math.sqrt(e / W) < gate) { frames.push({ t, hz: 0, voiced: false, clarity: 0 }); continue; }
    d[0] = 1; let run = 0, best = -1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) { const v = y[start + i] - y[start + i + tau]; s += v * v; }
      run += s;
      d[tau] = run > 0 ? s * tau / run : 1;
    }
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (d[tau] < th) { while (tau + 1 < tauMax && d[tau + 1] < d[tau]) { tau++; } best = tau; break; }
    }
    if (best < 0) { frames.push({ t, hz: 0, voiced: false, clarity: 0 }); continue; }
    const a = d[best - 1], b = d[best], c = d[best + 1];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? Math.max(-1, Math.min(1, 0.5 * (a - c) / den)) : 0;
    frames.push({ t, hz: r / (best + shift), voiced: true, clarity: 1 - b });
  }
  // median-of-5 over voiced neighbours removes isolated octave errors
  const out = frames.map((f, i) => {
    if (!f.voiced) { return f; }
    const nb = frames.slice(Math.max(0, i - 2), i + 3).filter(g => g.voiced).map(g => g.hz).sort((p, q) => p - q);
    const med = nb[Math.floor(nb.length / 2)];
    return Math.abs(1200 * Math.log2(f.hz / med)) > 600 ? { ...f, hz: med } : f;
  });
  return out;
}

export interface AutoTuneOptions {
  key: string; scale: string;
  /** ms to reach the target note: 0 = hard robotic snap, 20–80 = natural, 200+ = gentle (keeps vibrato). */
  retuneMs?: number;
  /** 0..1 how much of the correction to apply. */
  amount?: number;
  /** semitones of hysteresis before switching target note (prevents warbling between neighbours). */
  hysteresis?: number;
  minHz?: number; maxHz?: number;
}
export interface AutoTuneReport { voicedPct: number; meanErrorBefore: number; meanErrorAfter: number; notes: { note: string; pct: number }[]; frames: number }

/** Per-frame pitch ratio (output/input) from a pitch track. */
export function correctionCurve(frames: PitchFrame[], o: AutoTuneOptions): { ratio: Float64Array; target: Float64Array; report: AutoTuneReport } {
  const allowed = o.scale === 'chromatic' ? SCALES.chromatic : scalePitchClasses(o.key, o.scale);
  const amount = Math.max(0, Math.min(1, o.amount ?? 1));
  const hop = frames.length > 1 ? frames[1].t - frames[0].t : 0.005;
  const alpha = (o.retuneMs ?? 0) <= 0 ? 1 : 1 - Math.exp(-hop / ((o.retuneMs ?? 0) / 1000));
  const hyst = o.hysteresis ?? 0.15;
  const ratio = new Float64Array(frames.length).fill(1), target = new Float64Array(frames.length);
  let cur = 0, tgt = NaN, voiced = 0, eb = 0, ea = 0;
  const hist = new Map<number, number>();
  frames.forEach((f, i) => {
    let desired = 0;
    if (f.voiced) {
      const m = hzToMidi(f.hz);
      const pc = ((Math.round(tgt) % 12) + 12) % 12;
      if (!(isFinite(tgt) && allowed.includes(pc) && Math.abs(m - tgt) < 0.5 + hyst)) { tgt = snapMidi(m, allowed); }
      desired = (tgt - m) * amount;
      voiced++; eb += Math.abs(tgt - m) * 100;
      hist.set(tgt, (hist.get(tgt) ?? 0) + 1);
      target[i] = midiToHz(tgt);
    }
    cur += (desired - cur) * alpha;
    ratio[i] = Math.pow(2, cur / 12);
    if (f.voiced) { ea += Math.abs(hzToMidi(f.hz) + cur - tgt) * 100; }
  });
  const notes = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([m, n]) => ({ note: noteName(m), pct: Math.round(100 * n / Math.max(1, voiced)) }));
  return { ratio, target, report: { voicedPct: Math.round(100 * voiced / Math.max(1, frames.length)), meanErrorBefore: voiced ? eb / voiced : 0, meanErrorAfter: voiced ? ea / voiced : 0, notes, frames: frames.length } };
}

/** Cubic (Catmull-Rom) read at a fractional index. */
function readAt(x: Float32Array, p: number): number {
  const i = Math.floor(p), f = p - i;
  const xm1 = x[i - 1] ?? 0, x0 = x[i] ?? 0, x1 = x[i + 1] ?? 0, x2 = x[i + 2] ?? 0;
  return x0 + 0.5 * f * (x1 - xm1 + f * (2 * xm1 - 5 * x0 + 4 * x1 - x2 + f * (3 * (x0 - x1) + x2 - xm1)));
}

/**
 * TD-PSOLA: analysis marks one local period apart; synthesis marks every period/ratio; each synthesis mark takes the
 * nearest analysis grain (2 periods, Hann) — so time is preserved and pitch scales by ratio. When ratio = 1 the
 * synthesis marks coincide with the analysis marks and the grains reconstruct the input.
 */
export function psola(channels: Float32Array[], rate: number, frames: PitchFrame[], ratio: Float64Array): Float32Array[] {
  const n = channels[0].length;
  const hop = frames.length > 1 ? frames[1].t - frames[0].t : 0.005;
  const t0 = frames.length ? frames[0].t : 0;
  const idx = (s: number) => Math.max(0, Math.min(frames.length - 1, Math.round((s / rate - t0) / hop)));
  const unvoicedP = rate * 0.008;
  const periodAt = (s: number) => { const f = frames[idx(s)]; return f && f.voiced ? rate / f.hz : unvoicedP; };
  // analysis marks
  const marks: number[] = []; const periods: number[] = [];
  for (let a = 0; a < n; ) { const p = periodAt(a); marks.push(a); periods.push(p); a += p; }
  const out = channels.map(() => new Float32Array(n));
  const wsum = new Float32Array(n);
  let k = 0;
  for (let s = 0; s < n; ) {
    while (k + 1 < marks.length && Math.abs(marks[k + 1] - s) <= Math.abs(marks[k] - s)) { k++; }
    const a = marks[k], P = periods[k];
    const fr = frames[idx(s)];
    const r = fr && fr.voiced ? ratio[idx(s)] : 1;
    const lo = Math.ceil(s - P), hi = Math.floor(s + P);
    for (let m = Math.max(0, lo); m <= Math.min(n - 1, hi); m++) {
      const u = (m - s) / P;                         // −1..1
      const w = 0.5 + 0.5 * Math.cos(Math.PI * u);    // Hann over two periods
      const src = a + (m - s);
      for (let c = 0; c < channels.length; c++) { out[c][m] += w * readAt(channels[c], src); }
      wsum[m] += w;
    }
    s += P / r;
  }
  for (let m = 0; m < n; m++) { const w = wsum[m]; if (w > 1e-3) { for (const o of out) { o[m] /= w; } } }
  return out;
}

/** Decode → track → correct → shift → encode. Output keeps the source rate and channel count. */
export async function autoTune(t: Tools, input: string, out: string, o: AutoTuneOptions & { codec?: string[]; signal?: AbortSignal; onProgress?: (f: number, m: string) => void }): Promise<{ file: string; report: AutoTuneReport; detail: string }> {
  o.onProgress?.(0.05, 'Decoding');
  const { rate, channels } = await decodeNative(t.ffmpeg, t.ffprobe, input, o.signal);
  if (!channels.length || !channels[0].length) { throw new Error(`${path.basename(input)} has no audio.`); }
  const mono = new Float32Array(channels[0].length);
  for (const ch of channels) { for (let i = 0; i < mono.length; i++) { mono[i] += ch[i] / channels.length; } }
  o.onProgress?.(0.2, 'Tracking pitch (YIN)');
  const frames = yinTrack(mono, rate, { minHz: o.minHz, maxHz: o.maxHz });
  const { ratio, report } = correctionCurve(frames, o);
  if (o.signal?.aborted) { throw new Error('Cancelled'); }
  o.onProgress?.(0.6, 'Shifting pitch (PSOLA)');
  const tuned = psola(channels, rate, frames, ratio);
  o.onProgress?.(0.85, 'Encoding');
  const raw = tmpFile('wav');
  try {
    writeWavPlanar(raw, rate, tuned);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await runOk({ exe: t.ffmpeg, signal: o.signal, args: ['-hide_banner', '-nostdin', '-y', '-i', raw, ...(o.codec ?? ['-c:a', 'pcm_s24le']), '-ar', String(rate), out] });
  } finally { fs.rmSync(raw, { force: true }); }
  const detail = `${o.key} ${o.scale} · retune ${o.retuneMs ?? 0} ms · ${Math.round((o.amount ?? 1) * 100)}% · avg error ${report.meanErrorBefore.toFixed(0)} → ${report.meanErrorAfter.toFixed(0)} cents · ${report.voicedPct}% voiced`;
  return { file: out, report, detail };
}
