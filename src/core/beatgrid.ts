// Track analysis for the DJ tools: tempo + beat grid + downbeats (onset novelty, autocorrelation, comb refinement),
// drop detection (biggest low-end energy rise at a phrase boundary) and musical key (chroma + Krumhansl profiles). No vscode.
import { SR, Stereo, Svf } from './synth';
import { fft, hann } from './fft';
import { NOTE_NAMES } from './theory';

export interface BeatGrid { bpm: number; period: number; firstBeat: number; downbeatOffset: number; beats: number[]; downbeats: number[]; confidence: number; duration: number }

const HOP = 512;                       // novelty frame = 10.67 ms at 48 kHz
const FPS = SR / HOP;

/**
 * Onset novelty: half-wave-rectified log-energy flux in a low (kick), mid (snare/claps) and high (hats) band.
 * `nov` weights all bands (phase precision); `nk` is kick + snare only (tempo choice — hats otherwise pull to double time).
 */
export function novelty(buf: Stereo): { nov: Float64Array; nk: Float64Array; low: Float64Array; lowNov: Float64Array; midNov: Float64Array } {
  const n = Math.floor(buf.length / HOP);
  const lp = new Svf('lp', 150), hp = new Svf('hp', 2500), mp = new Svf('bp', 700, 0.8);
  const eL = new Float64Array(n), eM = new Float64Array(n), eH = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let a = 0, b = 0, c = 0;
    for (let i = f * HOP; i < (f + 1) * HOP; i++) {
      const x = 0.5 * (buf.L[i] + buf.R[i]);
      const l = lp.run(x), h = hp.run(x), m = mp.run(x);
      a += l * l; b += h * h; c += m * m;
    }
    eL[f] = a / HOP; eH[f] = b / HOP; eM[f] = c / HOP;
  }
  const nov = new Float64Array(n), nk = new Float64Array(n), lowNov = new Float64Array(n), midNov = new Float64Array(n);
  const lg = (v: number) => Math.log(1e-9 + v);
  for (let f = 1; f < n; f++) {
    const dl = Math.max(0, lg(eL[f]) - lg(eL[f - 1]));
    const dm = Math.max(0, lg(eM[f]) - lg(eM[f - 1]));
    const dh = Math.max(0, lg(eH[f]) - lg(eH[f - 1]));
    lowNov[f] = dl * Math.sqrt(eL[f]);
    midNov[f] = dm * Math.sqrt(eM[f]);
    nov[f] = dl + 0.6 * dm + 0.5 * dh;
    nk[f] = dl + 0.8 * dm;
  }
  return { nov: detrend(nov), nk: detrend(nk), low: eL, lowNov, midNov };
}

/** Subtract a moving mean so sustained material doesn't bias the autocorrelation. */
function detrend(x: Float64Array, w = 16): Float64Array {
  const n = x.length, out = new Float64Array(n);
  let s = 0, k = 0, lo = 0, hi = -1;
  for (let f = 0; f < n; f++) {
    while (hi < Math.min(n - 1, f + w)) { s += x[++hi]; k++; }
    while (lo < f - w) { s -= x[lo++]; k--; }
    out[f] = Math.max(0, x[f] - s / k);
  }
  return out;
}

const interp = (a: Float64Array, x: number) => { const i = Math.floor(x), f = x - i; return i < 0 || i + 1 >= a.length ? 0 : a[i] * (1 - f) + a[i + 1] * f; };

/** Comb score of a beat period (frames) and phase over the novelty curve. */
function comb(nov: Float64Array, periodF: number, phaseF: number): number {
  let s = 0, k = 0;
  for (let x = phaseF; x < nov.length - 1; x += periodF) { s += interp(nov, x) + 0.25 * (interp(nov, x - 0.5) + interp(nov, x + 0.5)); k++; }
  return k ? s / k : 0;
}

/** Best phase (frames) and its score for a tempo. */
function bestPhase(nov: Float64Array, bpm: number, step = 0.5): { ph: number; s: number; mean: number } {
  const p = 60 * FPS / bpm;
  let best = -1, ph = 0, sum = 0, k = 0;
  for (let x = 0; x < p; x += step) { const s = comb(nov, p, x); sum += s; k++; if (s > best) { best = s; ph = x; } }
  return { ph, s: best, mean: sum / Math.max(1, k) };
}

const prior = (b: number) => Math.exp(-0.5 * Math.pow(Math.log2(b / 115) / 0.65, 2));

/**
 * Detect tempo and the beat grid. `hint` (BPM) skips the global search and only refines near it.
 * Candidates (the autocorrelation peak and its ×2, ×½, ×3/2, ×2/3) are scored by a kick/snare comb filter
 * times a log-Gaussian tempo prior around 115 BPM (half/double-time ambiguity is resolved by the user with ×2 / ÷2), then refined to 0.01 BPM on the full novelty.
 */
export function detectBeatGrid(buf: Stereo, hint?: number): BeatGrid {
  const { nov, nk, lowNov, midNov } = novelty(buf);
  const duration = buf.length / SR;
  const n = nov.length;
  let bpm0 = hint ?? 0;
  if (!bpm0) {
    const minLag = Math.floor(FPS * 60 / 200), maxLag = Math.ceil(FPS * 60 / 60);
    let best = 0, bestLag = minLag;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0; for (let i = 0; i + lag < n; i++) { s += nk[i] * nk[i + lag]; }
      const v = s / (n - lag) * prior(60 * FPS / lag);
      if (v > best) { best = v; bestLag = lag; }
    }
    const peak = 60 * FPS / bestLag;
    const cands = [1, 2, 0.5, 1.5, 2 / 3, 4 / 3, 0.75].map(k => peak * k).filter(b => b >= 60 && b <= 190);
    let bestScore = -1;
    for (const c of cands) {
      // local refinement of each candidate (±2 %) before comparing
      let cb = c, cs = -1;
      for (let b = c * 0.98; b <= c * 1.02; b += 0.1) { const r = bestPhase(nk, b, 1); if (r.s > cs) { cs = r.s; cb = b; } }
      const score = cs * prior(cb);
      if (score > bestScore) { bestScore = score; bpm0 = cb; }
    }
  }
  // fine search around the winner: 0.1 then 0.01 BPM steps, all phases (0.5-frame resolution)
  let bestS = -1, bestBpm = bpm0, bestPh = 0, bestMean = 0;
  const scan = (lo: number, hi: number, step: number) => {
    for (let b = lo; b <= hi + 1e-9; b += step) { const r = bestPhase(nov, b); if (r.s > bestS) { bestS = r.s; bestBpm = b; bestPh = r.ph; bestMean = r.mean; } }
  };
  scan(bpm0 * (hint ? 0.99 : 0.995), bpm0 * (hint ? 1.01 : 1.005), 0.1);
  const coarse = bestBpm;
  scan(coarse - 0.12, coarse + 0.12, 0.01);
  const bpm = Math.round(bestBpm * 100) / 100;
  const period = 60 / bpm;
  let firstBeat = (bestPh / FPS) % period;
  if (firstBeat > period - 0.03) { firstBeat = Math.max(0, firstBeat - period); }  // a beat a hair before 0 is the beat at 0
  const beats: number[] = [];
  for (let t = firstBeat; t < duration - 1e-6; t += period) { beats.push(t); }
  const off = downbeatClass(buf, beats, period, lowNov, midNov);
  const downbeats = beats.filter((_, i) => i % 4 === off);
  return { bpm, period, firstBeat, downbeatOffset: off, beats, downbeats, confidence: Math.max(0, Math.min(1, (bestS - bestMean) / (bestS + 1e-9))), duration };
}

/**
 * Which beat class (mod 4) is beat 1. Cues, strongest first: harmony changes on the bar line (chroma flux across the
 * beat), the kick is strongest on 1, and snares/claps sit on 2 and 4. Near-ties prefer the earliest class.
 */
function downbeatClass(buf: Stereo, beats: number[], period: number, lowNov: Float64Array, midNov: Float64Array): number {
  const at = (a: Float64Array, t: number) => Math.max(interp(a, t * FPS), interp(a, t * FPS + 1), interp(a, t * FPS - 1));
  const low = [0, 0, 0, 0], mid = [0, 0, 0, 0], flux = [0, 0, 0, 0];
  beats.forEach((t, i) => { low[i % 4] += at(lowNov, t); mid[i % 4] += at(midNov, t); });
  const nrm = (a: number[]) => { const m = Math.max(...a) || 1; return a.map(v => v / m); };
  const L = nrm(low), M = nrm(mid);
  // harmonic change at each beat: chroma over the beat before vs the beat after (two frames each side)
  const N = 4096, w = hann(N), re = new Float64Array(N), im = new Float64Array(N);
  const chromaAt = (s: number) => {
    const c = new Array(12).fill(0);
    if (s < 0 || s + N > buf.length) { return c; }
    for (let i = 0; i < N; i++) { re[i] = 0.5 * (buf.L[s + i] + buf.R[s + i]) * w[i]; im[i] = 0; }
    fft(re, im);
    for (let k = Math.ceil(65 * N / SR); k < 2000 * N / SR; k++) { c[((Math.round(12 * Math.log2(k * SR / N / 440)) + 9) % 12 + 12) % 12] += Math.hypot(re[k], im[k]); }
    return c;
  };
  const cos = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < 12; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? d / Math.sqrt(x * y) : 1; };
  const lim = Math.min(beats.length, 256);
  const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);
  const side = (s: number, from: number, to: number) => add(chromaAt(s + Math.round(from * period * SR) - N / 2), chromaAt(s + Math.round(to * period * SR) - N / 2));
  for (let i = 1; i < lim; i++) {
    const s = Math.round(beats[i] * SR);
    flux[i % 4] += 1 - cos(side(s, -0.75, -0.35), side(s, 0.35, 0.75));
  }
  const F = nrm(flux);
  const score = [0, 1, 2, 3].map(k => F[k] + 0.6 * L[k] + 0.15 * (M[(k + 1) % 4] + M[(k + 3) % 4] - M[k] - M[(k + 2) % 4]));
  let best = 0;
  for (let k = 1; k < 4; k++) { if (score[k] > score[best] * 1.03) { best = k; } }
  return best;
}

/** Snap a time to the nearest beat (or downbeat). */
export function snapToGrid(g: BeatGrid, t: number, downbeat = false): number {
  const list = downbeat ? g.downbeats : g.beats;
  if (!list.length) { return t; }
  let best = list[0];
  for (const b of list) { if (Math.abs(b - t) < Math.abs(best - t)) { best = b; } }
  return best;
}

/** Phrase boundaries: every `bars` bars from the first downbeat. */
export function phrases(g: BeatGrid, bars = 8): number[] { return g.downbeats.filter((_, i) => i % bars === 0); }

/**
 * The drop: the downbeat (phrase boundary when possible) with the largest rise in low-end energy between the
 * `bars` before and after it. Falls back to the strongest rise anywhere.
 */
export function detectDrop(buf: Stereo, g: BeatGrid, bars = 4): number {
  const { low } = novelty(buf);
  const barF = g.period * 4 * FPS;
  const mean = (a: number, b: number) => { let s = 0, k = 0; for (let f = Math.max(0, Math.floor(a)); f < Math.min(low.length, Math.floor(b)); f++) { s += low[f]; k++; } return k ? s / k : 0; };
  let best = g.downbeats[0] ?? 0, bestV = -Infinity;
  g.downbeats.forEach((t, i) => {
    const f = t * FPS;
    if (f - barF * bars < 0 || f + barF * bars > low.length) { return; }
    const v = Math.log(1e-9 + mean(f, f + barF * bars)) - Math.log(1e-9 + mean(f - barF * bars, f));
    const phraseBonus = i % 8 === 0 ? 0.15 : i % 4 === 0 ? 0.05 : 0;
    if (v + phraseBonus > bestV) { bestV = v + phraseBonus; best = t; }
  });
  return best;
}

// ---------------------------------------------------------------- key detection

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Pitch-class energy (chroma) summed over the track (first `maxSec` seconds, 8192-point frames). */
export function chroma(buf: Stereo, maxSec = 90): number[] {
  const N = 8192, hop = 4096, w = hann(N);
  const c = new Array(12).fill(0);
  const re = new Float64Array(N), im = new Float64Array(N);
  const binPc: number[] = [];
  for (let k = 0; k < N / 2; k++) {
    const f = k * SR / N;
    binPc.push(f < 65 || f > 4200 ? -1 : ((Math.round(12 * Math.log2(f / 440)) + 9) % 12 + 12) % 12);
  }
  const end = Math.min(buf.length - N, Math.round(maxSec * SR));
  for (let s = 0; s < end; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = 0.5 * (buf.L[s + i] + buf.R[s + i]) * w[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) { const pc = binPc[k]; if (pc >= 0) { c[pc] += Math.sqrt(re[k] * re[k] + im[k] * im[k]); } }
  }
  return c;
}

function corr(a: number[], b: number[]): number {
  const ma = a.reduce((x, y) => x + y) / 12, mb = b.reduce((x, y) => x + y) / 12;
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < 12; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return s / Math.sqrt(sa * sb + 1e-12);
}

export interface KeyEstimate { key: string; scale: 'major' | 'minor'; confidence: number; camelot: string }

const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

/** Krumhansl-Schmuckler key estimate from chroma. Camelot code included for harmonic mixing. */
export function detectKey(buf: Stereo): KeyEstimate {
  const c = chroma(buf);
  let best = { key: 'C', scale: 'major' as 'major' | 'minor', r: -2, root: 0 }, second = -2;
  for (let root = 0; root < 12; root++) {
    const rot = c.slice(root).concat(c.slice(0, root));
    for (const [scale, prof] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]] as const) {
      const r = corr(rot, prof);
      if (r > best.r) { second = best.r; best = { key: NOTE_NAMES[root], scale, r, root }; } else if (r > second) { second = r; }
    }
  }
  return { key: best.key, scale: best.scale, confidence: Math.max(0, best.r - second), camelot: (best.scale === 'major' ? CAMELOT_MAJOR : CAMELOT_MINOR)[best.root] };
}

/** Smallest semitone shift (−6..+5) that moves key `from` onto key `to` (relative major/minor treated as equal). */
export function keyShift(from: KeyEstimate, to: KeyEstimate): number {
  const pc = (k: KeyEstimate) => (NOTE_NAMES.indexOf(k.key) + (k.scale === 'minor' ? 3 : 0)) % 12; // compare relative majors
  let d = (pc(to) - pc(from) + 12) % 12;
  if (d > 5) { d -= 12; }
  return d;
}
