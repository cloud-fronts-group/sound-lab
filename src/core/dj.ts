// One-click DJ moves on decoded audio: backspin, echo out, beat jump, quick mix, long blend, double drop, mashup,
// and acapella / instrumental extraction (center-channel STFT masking; mlx-audio separation is used by the extension
// when its server is running). Times are seconds; everything lands on the detected beat grid. No vscode.
import * as path from 'path';
import { SR, Stereo, Svf } from './synth';
import { BeatGrid, detectBeatGrid, detectDrop, detectKey, keyShift, phrases, snapToGrid, KeyEstimate } from './beatgrid';
import { decode, encode, master, Tools } from './audioio';
import { fft, hann } from './fft';
import { formatTimecode } from './ffmpeg';

export interface Analysed { file: string; buf: Stereo; grid: BeatGrid; key?: KeyEstimate }
export interface DjResult { file: string; seconds: number; detail: string; grid?: BeatGrid; marks?: { label: string; t: number }[] }
export interface DjCommon { codec?: string[]; signal?: AbortSignal; bpm?: number }

export async function analyse(t: Tools, file: string, o: { bpm?: number; key?: boolean; af?: string; signal?: AbortSignal } = {}): Promise<Analysed> {
  const buf = await decode(t.ffmpeg, file, { af: o.af, signal: o.signal });
  if (buf.length < SR) { throw new Error(`${path.basename(file)} is shorter than a second.`); }
  return { file, buf, grid: detectBeatGrid(buf, o.bpm), key: o.key ? detectKey(buf) : undefined };
}

const tc = (s: number) => formatTimecode(s);
const slice = (b: Stereo, from: number, to: number): Stereo => {
  const a = Math.max(0, Math.round(from * SR)), z = Math.min(b.length, Math.round(to * SR));
  const o = new Stereo(Math.max(1, z - a));
  o.L.set(b.L.subarray(a, z)); o.R.set(b.R.subarray(a, z));
  return o;
};
function concat(...parts: Stereo[]): Stereo {
  const o = new Stereo(parts.reduce((s, p) => s + p.length, 0));
  let at = 0; for (const p of parts) { o.L.set(p.L, at); o.R.set(p.R, at); at += p.length; }
  return o;
}

/** Default action point: the last 8-bar phrase boundary that still leaves ≥ 4 bars of track (where a DJ would exit). */
export function exitPoint(g: BeatGrid): number {
  const ph = phrases(g, 8).filter(t => t <= g.duration - g.period * 16);
  return ph.length ? ph[ph.length - 1] : snapToGrid(g, g.duration * 0.75, true);
}

/** Read a buffer at a fractional sample position (linear) — used by the backspin's varispeed playhead. */
const read = (ch: Float32Array, p: number) => { const i = Math.floor(p), f = p - i; return i < 0 || i + 1 >= ch.length ? 0 : ch[i] + (ch[i + 1] - ch[i]) * f; };

// ---------------------------------------------------------------- backspin

/**
 * Backspin: at `at` (snapped to a beat) the platter is yanked backwards — the playhead whips from +1× to about −3×
 * and decelerates to a stop over `beats` beats — then silence (or the track restarts from the phrase start: "rewind").
 */
export function backspin(a: Analysed, o: { at?: number; beats?: number; then?: 'stop' | 'rewind' } = {}): { buf: Stereo; detail: string; at: number } {
  const g = a.grid;
  const at = snapToGrid(g, o.at ?? exitPoint(g));
  const D = Math.max(0.6, Math.min(3, (o.beats ?? 2) * g.period));
  const n = Math.round(D * SR);
  const spin = new Stereo(n);
  const lp = [new Svf('lp', 9000), new Svf('lp', 9000)];
  let p = at * SR;
  for (let i = 0; i < n; i++) {
    const s = i / SR;
    const grab = Math.min(1, s / 0.07);                                    // hand grabs the platter in ~70 ms
    const v = (1 - grab) * 1 + grab * (-3.2 * Math.pow(1 - s / D, 1.6));    // then decays to zero speed
    p = Math.max(0, p + v);
    const amp = Math.min(1, Math.abs(v) * 1.4) * (1 - Math.pow(s / D, 4));
    lp[0].set(800 + 9000 * Math.min(1, Math.abs(v) / 2)); lp[1].set(800 + 9000 * Math.min(1, Math.abs(v) / 2));
    spin.L[i] = lp[0].run(read(a.buf.L, p)) * amp; spin.R[i] = lp[1].run(read(a.buf.R, p)) * amp;
  }
  const head = slice(a.buf, 0, at);
  const parts = [head, spin];
  let detail = `Backspin at ${tc(at)} (${(D).toFixed(2)} s)`;
  if (o.then === 'rewind') {
    const ph = phrases(g, 8).filter(t => t < at - g.period * 4);
    const from = ph.length ? ph[ph.length - 1] : g.downbeats[0] ?? 0;
    parts.push(new Stereo(Math.round(g.period * SR / 2)), slice(a.buf, from, g.duration));
    detail += `, rewind to ${tc(from)}`;
  } else { parts.push(new Stereo(Math.round(0.3 * SR))); }
  return { buf: concat(...parts), detail, at };
}

// ---------------------------------------------------------------- echo out

/**
 * Echo out: the last `feedBeats` before `at` feed a tempo-synced delay (1 beat, or ½ with `half`) with feedback;
 * the dry track stops at `at` and the echoes trail off over `tailBars` with a rising high-pass, like a DJ mixer's echo FX.
 */
export function echoOut(a: Analysed, o: { at?: number; tailBars?: number; feedback?: number; half?: boolean; feedBeats?: number } = {}): { buf: Stereo; detail: string; at: number } {
  const g = a.grid;
  const at = snapToGrid(g, o.at ?? exitPoint(g), true);
  const delay = Math.round(g.period * (o.half ? 0.5 : 1) * SR);
  const fb = Math.min(0.85, o.feedback ?? 0.62);
  const tail = (o.tailBars ?? 4) * 4 * g.period;
  const feedFrom = at - (o.feedBeats ?? 1) * g.period;
  const n = Math.round((at + tail) * SR);
  const out = new Stereo(n);
  const dl = [new Float32Array(delay), new Float32Array(delay)];
  const hp = [new Svf('hp', 60), new Svf('hp', 60)];
  const atS = Math.round(at * SR), feedS = Math.round(feedFrom * SR);
  for (let i = 0; i < n; i++) {
    const k = i % delay;
    const progress = Math.max(0, (i - atS) / (n - atS));
    const cutoff = 60 + 2400 * Math.pow(progress, 1.5);
    for (let c = 0; c < 2; c++) {
      const ch = c ? a.buf.R : a.buf.L;
      const dry = i < atS && i < ch.length ? ch[i] : 0;
      const send = i >= feedS && i < atS && i < ch.length ? ch[i] : 0;
      hp[c].set(cutoff);
      const wet = hp[c].run(dl[c][k]);
      dl[c][k] = send + wet * fb;
      const fade = i < atS ? 1 : Math.pow(1 - progress, 1.2);
      (c ? out.R : out.L)[i] = dry + 0.8 * wet * fade;
    }
  }
  return { buf: out, detail: `Echo out at ${tc(at)} · ${o.half ? '½' : '1'}-beat echo · ${o.tailBars ?? 4}-bar tail`, at };
}

// ---------------------------------------------------------------- beat jump

/** Beat jump: at `at` (snapped to a beat) skip forward (or back, repeating) by `beats` beats with a 6 ms crossfade. */
export function beatJump(a: Analysed, o: { at?: number; beats?: number } = {}): { buf: Stereo; detail: string; at: number; to: number } {
  const g = a.grid;
  const beats = Math.round(o.beats ?? 8);
  if (!beats) { throw new Error('Jump by at least one beat.'); }
  const at = snapToGrid(g, o.at ?? (phrases(g, 8)[1] ?? g.duration / 3));
  const to = at + beats * g.period;
  if (to < 0 || to >= g.duration - 0.1) { throw new Error(`A ${beats > 0 ? '+' : ''}${beats}-beat jump from ${tc(at)} leaves the track.`); }
  const head = slice(a.buf, 0, at), rest = slice(a.buf, to, g.duration);
  const xf = Math.min(Math.round(0.006 * SR), head.length, rest.length, Math.round(to * SR));
  // crossfade the last xf samples of head with the first xf of the jump target (equal-power)
  const pre = slice(a.buf, to - xf / SR, to);
  for (let i = 0; i < xf; i++) {
    const w = (i + 1) / (xf + 1), h = head.length - xf + i;
    head.L[h] = head.L[h] * Math.cos(w * Math.PI / 2) + pre.L[i] * Math.sin(w * Math.PI / 2);
    head.R[h] = head.R[h] * Math.cos(w * Math.PI / 2) + pre.R[i] * Math.sin(w * Math.PI / 2);
  }
  return { buf: concat(head, rest), detail: `Beat jump ${beats > 0 ? '+' : ''}${beats} beats at ${tc(at)} → ${tc(to)}`, at, to };
}

// ---------------------------------------------------------------- transitions

/** Split into low (<cutoff) and high bands with a complementary pair (low + high = input exactly). */
function bands(b: Stereo, cutoff = 180): { low: Stereo; high: Stereo } {
  const low = new Stereo(b.length), high = new Stereo(b.length);
  for (const [src, lo, hi] of [[b.L, low.L, high.L], [b.R, low.R, high.R]] as const) {
    const f1 = new Svf('lp', cutoff), f2 = new Svf('lp', cutoff);
    for (let i = 0; i < src.length; i++) { const l = f2.run(f1.run(src[i])); lo[i] = l; hi[i] = src[i] - l; }
  }
  return { low, high };
}

/** Tempo-match B to A at decode time (pitch-preserving atempo), with an optional key shift in semitones. */
export async function analyseMatched(t: Tools, file: string, toBpm: number, o: { bpm?: number; semitones?: number; signal?: AbortSignal; key?: boolean; srcGrid?: BeatGrid } = {}): Promise<Analysed & { ratio: number; srcBpm: number }> {
  // srcGrid: the tempo is already known (e.g. an acapella shares the full song's grid) — never re-detect on beatless audio
  const raw: Analysed = o.srcGrid
    ? { file, buf: await decode(t.ffmpeg, file, { signal: o.signal }), grid: o.srcGrid }
    : await analyse(t, file, { bpm: o.bpm, key: o.key, signal: o.signal });
  // fold half/double-time so a 70 BPM track mixes with a 140 BPM one
  let src = raw.grid.bpm;
  while (src / toBpm > 1.45) { src /= 2; } while (toBpm / src > 1.45) { src *= 2; }
  const ratio = toBpm / src;
  const semis = o.semitones ?? 0;
  if (Math.abs(ratio - 1) < 0.0005 && !semis) { return { ...raw, ratio: 1, srcBpm: raw.grid.bpm }; }
  const chain: string[] = [];
  if (semis) { const p = Math.pow(2, semis / 12); chain.push(`asetrate=${Math.round(SR * p)}`, `aresample=${SR}`, ...atempo(ratio / p)); }
  else { chain.push(...atempo(ratio)); }
  const buf = await decode(t.ffmpeg, file, { af: `aresample=${SR},${chain.join(',')}`, signal: o.signal });
  return { ...raw, buf, grid: rescaleGrid(raw.grid, ratio, toBpm, buf.length / SR), ratio, srcBpm: raw.grid.bpm };
}

/** The grid of a time-stretched track: positions scale by 1/ratio; beats are re-laid at the target tempo
 *  (so a half-time track folded onto a double-time one gets bars of the target's length). */
export function rescaleGrid(g: BeatGrid, ratio: number, toBpm: number, duration: number): BeatGrid {
  const k = 1 / ratio, period = 60 / toBpm;
  const first = (g.downbeats[0] ?? g.firstBeat) * k;
  const beats: number[] = [], downbeats: number[] = [];
  const start = first - Math.floor(first / period) * period;
  for (let j = 0; start + j * period < duration; j++) {
    const b = start + j * period;
    beats.push(b);
    if (((Math.round((b - first) / period) % 4) + 4) % 4 === 0) { downbeats.push(b); }
  }
  return { ...g, bpm: toBpm, period, firstBeat: start, beats, downbeats, duration, downbeatOffset: ((Math.round((first - start) / period) % 4) + 4) % 4 };
}
function atempo(f: number): string[] {
  const out: string[] = [];
  while (f > 2) { out.push('atempo=2'); f /= 2; } while (f < 0.5) { out.push('atempo=0.5'); f /= 0.5; }
  out.push(`atempo=${f.toFixed(6)}`);
  return out;
}

export interface TransitionOptions { at?: number; cue?: number; bars?: number; style: 'quick' | 'long' }

/**
 * Mix A into B: B (already tempo-matched) is placed so its cue downbeat lands on A's `at` downbeat — every beat lines up.
 * quick: equal-power crossfade over `bars` (default 1) with an instant bass swap in the middle.
 * long: over `bars` (default 16) B's highs fade in, the basses swap at the halfway downbeat, then A's highs fade out.
 */
export function transition(a: Analysed, b: Analysed, o: TransitionOptions): { buf: Stereo; detail: string; at: number; end: number } {
  const g = a.grid;
  const bars = o.bars ?? (o.style === 'quick' ? 1 : 16);
  const len = bars * 4 * g.period;
  let at = snapToGrid(g, o.at ?? (o.style === 'quick' ? exitPoint(g) + 8 * 4 * g.period : exitPoint(g)), true);
  if (at + len > g.duration) { at = snapToGrid(g, Math.max(0, g.duration - len - g.period), true); }
  const cue = o.cue !== undefined ? snapToGrid(b.grid, o.cue, true) : (b.grid.downbeats[0] ?? 0);
  const off = at - cue;                                       // B time + off = mix time
  const total = Math.max(at + len, off + b.grid.duration);
  const out = new Stereo(Math.round(total * SR));
  const A = bands(a.buf), B = bands(b.buf);
  const s0 = Math.round(at * SR), s1 = Math.round((at + len) * SR), mid = Math.round((at + (bars >= 2 ? Math.round(bars / 2) * 4 : bars * 2) * g.period) * SR);
  const offS = Math.round(off * SR);
  for (let i = 0; i < out.length; i++) {
    const x = i < s0 ? 0 : i >= s1 ? 1 : (i - s0) / (s1 - s0);
    let aHi: number, aLo: number, bHi: number, bLo: number;
    if (o.style === 'quick') { aHi = Math.cos(x * Math.PI / 2); bHi = Math.sin(x * Math.PI / 2); aLo = i < mid ? 1 : 0; bLo = i < mid ? 0 : 1; }
    else {
      bHi = Math.sin(Math.min(1, x * 2) * Math.PI / 2);        // first half: B's highs come in
      aHi = Math.cos(Math.max(0, x * 2 - 1) * Math.PI / 2);    // second half: A's highs go out
      aLo = i < mid ? 1 : 0; bLo = i < mid ? 0 : 1;            // bass swap on the middle downbeat
    }
    if (i >= s1) { aHi = 0; aLo = 0; }
    const j = i - offS;
    const inA = i < a.buf.length, inB = j >= 0 && j < b.buf.length;
    out.L[i] = (inA ? A.high.L[i] * aHi + A.low.L[i] * aLo : 0) + (inB ? B.high.L[j] * bHi + B.low.L[j] * bLo : 0);
    out.R[i] = (inA ? A.high.R[i] * aHi + A.low.R[i] * aLo : 0) + (inB ? B.high.R[j] * bHi + B.low.R[j] * bLo : 0);
  }
  const name = o.style === 'quick' ? 'Quick mix' : 'Long blend';
  return { buf: out, detail: `${name} ${path.basename(a.file)} → ${path.basename(b.file)} at ${tc(at)} over ${bars} bar${bars > 1 ? 's' : ''} @ ${a.grid.bpm} BPM`, at, end: at + len };
}

/**
 * Double drop: B is tempo-matched and aligned so its drop hits on the same downbeat as A's drop. B's highs ride in
 * over the `buildBars` before the drop; both drops play together (B's bass removed so the low end stays clean) for
 * `dropBars`, then A's bass hands over and A fades out.
 */
export function doubleDrop(a: Analysed, b: Analysed, o: { dropA?: number; dropB?: number; buildBars?: number; dropBars?: number } = {}): { buf: Stereo; detail: string; dropA: number; dropB: number } {
  const g = a.grid, bar = 4 * g.period;
  const dropA = snapToGrid(g, o.dropA ?? detectDrop(a.buf, g), true);
  const dropB = snapToGrid(b.grid, o.dropB ?? detectDrop(b.buf, b.grid), true);
  const off = dropA - dropB;
  const build = (o.buildBars ?? 8) * bar, together = (o.dropBars ?? 16) * bar;
  const startB = Math.max(dropA - build, off);               // B can't start before its own beginning
  const handover = dropA + together, end = handover + 4 * bar;
  const total = Math.max(Math.min(a.grid.duration, end), off + b.grid.duration);
  const out = new Stereo(Math.round(total * SR));
  const A = bands(a.buf), B = bands(b.buf);
  const offS = Math.round(off * SR);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const bIn = t < startB ? 0 : t < dropA ? Math.sin(((t - startB) / Math.max(1e-3, dropA - startB)) * Math.PI / 2) : 1;
    const bLo = t < handover ? 0 : 1;
    const aOut = t < handover ? 1 : t < end ? Math.cos(((t - handover) / (end - handover)) * Math.PI / 2) : 0;
    const aLo = t < handover ? 1 : 0;
    const j = i - offS;
    const inA = i < a.buf.length, inB = j >= 0 && j < b.buf.length;
    out.L[i] = (inA ? (A.high.L[i] + A.low.L[i] * aLo) * aOut * (t >= dropA && t < handover ? 0.8 : 1) : 0) + (inB ? (B.high.L[j] * bIn + B.low.L[j] * bLo) * (t >= dropA && t < handover ? 0.8 : 1) : 0);
    out.R[i] = (inA ? (A.high.R[i] + A.low.R[i] * aLo) * aOut * (t >= dropA && t < handover ? 0.8 : 1) : 0) + (inB ? (B.high.R[j] * bIn + B.low.R[j] * bLo) * (t >= dropA && t < handover ? 0.8 : 1) : 0);
  }
  return { buf: out, detail: `Double drop at ${tc(dropA)} (B's drop ${tc(dropB)} aligned) @ ${g.bpm} BPM`, dropA, dropB };
}

// ---------------------------------------------------------------- acapella / instrumental

/**
 * Center-channel extraction (Avendano–Jot similarity mask on a 4096-point STFT): energy that is identical in L and R
 * between 120 Hz and 9 kHz — where lead vocals sit in most stereo mixes — becomes the acapella; L/R minus it is the
 * instrumental. Mono files have nothing to separate on, so they are rejected (use mlx-audio separation instead).
 */
export function centerSplit(b: Stereo, o: { strength?: number } = {}): { acapella: Stereo; instrumental: Stereo; sideRatio: number } {
  const N = 4096, hop = 1024, w = hann(N);
  const strength = Math.max(0, Math.min(1, o.strength ?? 0.7));
  const thresh = 0.55 + 0.35 * strength;  // similarity needed to call a bin "center"
  let side = 0, all = 0;
  for (let i = 0; i < b.length; i += 7) { const d = b.L[i] - b.R[i], s = b.L[i] + b.R[i]; side += d * d; all += s * s + d * d; }
  const sideRatio = all ? side / all : 0;
  if (sideRatio < 1e-5) { throw new Error('This file is mono (or L = R), so there is no stereo image to separate. Start the mlx-audio server to use AI separation.'); }
  const n = b.length + N;
  const C = new Float32Array(n);
  const norm = new Float32Array(n);
  const lr = new Float64Array(N), li = new Float64Array(N), rr = new Float64Array(N), ri = new Float64Array(N);
  const cr = new Float64Array(N), ci = new Float64Array(N);
  const loBin = Math.floor(120 * N / SR), hiBin = Math.ceil(9000 * N / SR);
  for (let s = -N; s < b.length; s += hop) {
    for (let i = 0; i < N; i++) { const k = s + i; const inb = k >= 0 && k < b.length; lr[i] = inb ? b.L[k] * w[i] : 0; rr[i] = inb ? b.R[k] * w[i] : 0; li[i] = 0; ri[i] = 0; }
    fft(lr, li); fft(rr, ri);
    cr.fill(0); ci.fill(0);
    for (let k = loBin; k <= hiBin; k++) {
      for (const kk of k === 0 ? [0] : [k, N - k]) {
        const pl = lr[kk] * lr[kk] + li[kk] * li[kk], pr = rr[kk] * rr[kk] + ri[kk] * ri[kk];
        const cross = lr[kk] * rr[kk] + li[kk] * ri[kk];       // Re(L·R*)
        const sim = (2 * cross) / (pl + pr + 1e-12);
        let m = (sim - thresh) / (1 - thresh); m = m <= 0 ? 0 : m >= 1 ? 1 : m * m * (3 - 2 * m);
        // soft edges at the band limits
        const f = k * SR / N; const edge = Math.min(1, (f - 120) / 60, (9000 - f) / 1500);
        m *= Math.max(0, edge);
        cr[kk] = m * 0.5 * (lr[kk] + rr[kk]); ci[kk] = m * 0.5 * (li[kk] + ri[kk]);
      }
    }
    fft(cr, ci, true);
    for (let i = 0; i < N; i++) { const k = s + i + N; if (k >= 0 && k < n) { C[k] += cr[i] * w[i]; norm[k] += w[i] * w[i]; } }
  }
  const acapella = new Stereo(b.length), instrumental = new Stereo(b.length);
  for (let i = 0; i < b.length; i++) {
    const c = norm[i + N] > 1e-6 ? C[i + N] / norm[i + N] : 0;
    acapella.L[i] = c; acapella.R[i] = c;
    instrumental.L[i] = b.L[i] - c; instrumental.R[i] = b.R[i] - c;
  }
  return { acapella, instrumental, sideRatio };
}

// ---------------------------------------------------------------- mashup

/**
 * Mashup: vocals from one song over the instrumental of another. Vocals are tempo-matched (and optionally key-shifted)
 * to the instrumental and aligned downbeat-to-downbeat, offset by `offsetBars`; the bed ducks gently under the voice.
 */
export function mashup(vocals: Analysed, inst: Analysed, o: { offsetBars?: number; vocalGainDb?: number } = {}): { buf: Stereo; detail: string } {
  const g = inst.grid, bar = 4 * g.period;
  const vDown = vocals.grid.downbeats[0] ?? 0;
  const iDown = (inst.grid.downbeats[0] ?? 0) + (o.offsetBars ?? 0) * bar;
  const off = iDown - vDown;
  const total = Math.max(inst.buf.length / SR, off + vocals.buf.length / SR);
  const out = new Stereo(Math.round(total * SR));
  const vg = Math.pow(10, (o.vocalGainDb ?? 0) / 20);
  const offS = Math.round(off * SR);
  // envelope follower on the vocal drives a gentle duck (max −4 dB) on the bed
  let env = 0; const att = 1 - Math.exp(-1 / (0.01 * SR)), rel = 1 - Math.exp(-1 / (0.25 * SR));
  for (let i = 0; i < out.length; i++) {
    const j = i - offS;
    const vl = j >= 0 && j < vocals.buf.length ? vocals.buf.L[j] * vg : 0, vr = j >= 0 && j < vocals.buf.length ? vocals.buf.R[j] * vg : 0;
    const lvl = Math.abs(vl) + Math.abs(vr);
    env += (lvl > env ? att : rel) * (lvl - env);
    const duck = 1 - 0.37 * Math.min(1, env * 6);
    const il = i < inst.buf.length ? inst.buf.L[i] : 0, ir = i < inst.buf.length ? inst.buf.R[i] : 0;
    out.L[i] = il * duck + vl; out.R[i] = ir * duck + vr;
  }
  return { buf: out, detail: `Mashup: vocals of ${path.basename(vocals.file)} over ${path.basename(inst.file)} @ ${g.bpm} BPM${o.offsetBars ? `, +${o.offsetBars} bars` : ''}` };
}

// ---------------------------------------------------------------- file-level wrappers

export async function saveEdit(t: Tools, buf: Stereo, out: string, o: DjCommon & { lufs?: number } = {}): Promise<void> {
  if (o.lufs !== undefined) { await master(t, buf, out, { codec: o.codec, lufs: o.lufs, signal: o.signal }); }
  else {
    // keep levels, but never clip: scale down only if the edit (e.g. two overlapping tracks) exceeds full scale
    const p = buf.peak(); if (p > 0.98) { buf.scale(0.98 / p); }
    await encode(t, buf, out, o.codec, o.signal);
  }
}

export { keyShift, detectKey };
