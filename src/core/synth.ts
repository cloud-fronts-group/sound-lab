// Small, deterministic synthesis engine for the Studio tools: stereo float buffers, instruments, drum voices,
// filters and a float WAV writer/reader. Pure Node (no vscode, no ffmpeg) so it is fast to test.
import * as fs from 'fs';

export const SR = 48000;

/** Stereo float buffer. With `wrap`, writes past the end wrap to the start, so release tails make seamless loops. */
export class Stereo {
  readonly L: Float32Array; readonly R: Float32Array;
  constructor(readonly length: number, readonly wrap = false) { this.L = new Float32Array(length); this.R = new Float32Array(length); }
  static seconds(s: number, wrap = false): Stereo { return new Stereo(Math.max(1, Math.round(s * SR)), wrap); }
  add(i: number, l: number, r: number): void {
    if (i < 0) { if (!this.wrap) { return; } i = ((i % this.length) + this.length) % this.length; }
    if (i >= this.length) { if (!this.wrap) { return; } i %= this.length; }
    this.L[i] += l; this.R[i] += r;
  }
  mix(o: Stereo, gain = 1): this {
    for (let i = 0; i < Math.min(this.length, o.length); i++) { this.L[i] += o.L[i] * gain; this.R[i] += o.R[i] * gain; }
    return this;
  }
  peak(): number { let p = 0; for (let i = 0; i < this.length; i++) { p = Math.max(p, Math.abs(this.L[i]), Math.abs(this.R[i])); } return p; }
  scale(g: number): this { for (let i = 0; i < this.length; i++) { this.L[i] *= g; this.R[i] *= g; } return this; }
}

/** Equal-power pan gains for pan −1 (left) … +1 (right). */
export const panGains = (pan: number): [number, number] => [Math.cos((pan + 1) * Math.PI / 4), Math.sin((pan + 1) * Math.PI / 4)];

/** Deterministic PRNG (mulberry32). */
export function rng(seed = 1): () => number {
  let a = seed | 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Topology-preserving state-variable filter (Simper). mode: lp | hp | bp. */
export class Svf {
  private ic1 = 0; private ic2 = 0; private g = 0; private k = 1;
  constructor(private mode: 'lp' | 'hp' | 'bp', fc: number, q = 0.707) { this.set(fc, q); }
  set(fc: number, q = 0.707): void { this.g = Math.tan(Math.PI * Math.min(fc, SR * 0.45) / SR); this.k = 1 / q; }
  run(x: number): number {
    const a1 = 1 / (1 + this.g * (this.g + this.k)), a2 = this.g * a1, a3 = this.g * a2;
    const v3 = x - this.ic2, v1 = a1 * this.ic1 + a2 * v3, v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    return this.mode === 'lp' ? v2 : this.mode === 'bp' ? v1 : x - this.k * v1 - v2;
  }
}

// ---------------------------------------------------------------- instruments

export type Instrument = 'pad' | 'ep' | 'keys' | 'pluck' | 'bell' | 'organ' | 'strings' | 'lead' | 'bass' | 'sub808' | 'reese';
export const INSTRUMENTS: { id: Instrument; label: string }[] = [
  { id: 'pad', label: 'Warm pad' }, { id: 'ep', label: 'Electric piano' }, { id: 'keys', label: 'Piano-ish keys' }, { id: 'pluck', label: 'Pluck (Karplus-Strong)' },
  { id: 'bell', label: 'FM bell' }, { id: 'organ', label: 'Organ' }, { id: 'strings', label: 'Strings' }, { id: 'lead', label: 'Square lead' },
  { id: 'bass', label: 'Bass' }, { id: 'sub808', label: '808 sub' }, { id: 'reese', label: 'Reese bass' },
];

export interface NoteOpts { vel?: number; pan?: number; glideFrom?: number; cutoff?: number; seed?: number }

/** Release time (s) each instrument rings after its note-off. */
const RELEASE: Record<Instrument, number> = { pad: 0.9, ep: 0.35, keys: 0.5, pluck: 0.25, bell: 1.2, organ: 0.06, strings: 0.7, lead: 0.12, bass: 0.08, sub808: 0.15, reese: 0.15 };

/** Render one note into `buf` starting at `t` seconds, held for `dur` seconds (plus the instrument's release). */
export function note(buf: Stereo, inst: Instrument, t: number, dur: number, f: number, o: NoteOpts = {}): void {
  const vel = o.vel ?? 0.8;
  const [gl, gr] = panGains(o.pan ?? 0);
  const n0 = Math.round(t * SR);
  const rel = RELEASE[inst];
  const nOn = Math.max(1, Math.round(dur * SR)), nTot = nOn + Math.round(rel * SR);
  if (inst === 'pluck') { return pluck(buf, n0, nTot, nOn, f, vel, gl, gr, o.seed ?? 1); }
  const lp = new Svf('lp', o.cutoff ?? ({ pad: 2200, strings: 3200, lead: 3800, reese: 900, bass: 1400, sub808: 900 } as Record<string, number>)[inst] ?? 12000, inst === 'reese' ? 1.2 : 0.707);
  let p1 = 0, p2 = 0, p3 = 0, pm = 0;
  for (let n = 0; n < nTot; n++) {
    const s = n / SR;
    // envelope: attack / decay-sustain / release
    let env: number;
    switch (inst) {
      case 'pad': env = Math.min(1, s / 0.35); break;
      case 'strings': env = Math.min(1, s / 0.22); break;
      case 'ep': env = Math.min(1, s / 0.003) * (0.35 + 0.65 * Math.exp(-2.2 * s)); break;
      case 'keys': env = Math.min(1, s / 0.002) * Math.exp(-1.6 * s); break;
      case 'bell': env = Math.min(1, s / 0.002) * Math.exp(-1.8 * s); break;
      case 'organ': env = Math.min(1, s / 0.01); break;
      case 'lead': env = Math.min(1, s / 0.01) * (0.7 + 0.3 * Math.exp(-6 * s)); break;
      case 'bass': env = Math.min(1, s / 0.004) * (0.55 + 0.45 * Math.exp(-5 * s)); break;
      case 'sub808': env = Math.min(1, s / 0.002) * Math.exp(-1.1 * s); break;
      case 'reese': env = Math.min(1, s / 0.01); break;
      default: env = 1;
    }
    if (n >= nOn) { env *= Math.max(0, 1 - (n - nOn) / (nTot - nOn)); }
    // pitch (808 glides down from glideFrom or a fifth above)
    let fr = f;
    if (inst === 'sub808') { fr = f * (1 + ((o.glideFrom ?? f * 1.5) / f - 1) * Math.exp(-28 * s)); }
    else if (o.glideFrom) { fr = f + (o.glideFrom - f) * Math.exp(-40 * s); }
    if (inst === 'strings' || inst === 'lead') { fr *= 1 + 0.004 * Math.sin(2 * Math.PI * 5.4 * s) * Math.min(1, s / 0.3); }
    const w = 2 * Math.PI * fr / SR;
    p1 += w; p2 += w * 1.0058; p3 += w * 0.9943; pm += w;
    const saw = (ph: number) => ((ph / Math.PI) % 2) - 1;
    let x: number;
    switch (inst) {
      case 'pad': x = (saw(p1) + saw(p2) + saw(p3)) / 3; break;
      case 'strings': x = (saw(p1) + saw(p2)) / 2; break;
      case 'reese': x = (saw(p1 * 0.5) + saw(p2 * 0.5 * 1.006)) / 2; break;
      case 'ep': x = Math.sin(p1 + 1.3 * Math.exp(-5 * s) * Math.sin(p1)) + 0.15 * Math.sin(14 * p1) * Math.exp(-30 * s); break;
      case 'keys': x = Math.sin(p1) + 0.5 * Math.sin(2 * p1) * Math.exp(-2 * s) + 0.25 * Math.sin(3 * p1) * Math.exp(-3 * s) + 0.12 * Math.sin(4.01 * p1) * Math.exp(-5 * s); break;
      case 'bell': x = Math.sin(p1 + 2.2 * Math.exp(-3 * s) * Math.sin(3.5 * pm)); break;
      case 'organ': x = 0.5 * Math.sin(p1) + 0.3 * Math.sin(2 * p1) + 0.18 * Math.sin(3 * p1) + 0.1 * Math.sin(4 * p1) + 0.06 * Math.sin(6 * p1); break;
      case 'lead': x = Math.sign(Math.sin(p1)) * 0.6 + 0.4 * saw(p2); break;
      case 'bass': x = Math.tanh(1.6 * (Math.sin(p1) + 0.35 * saw(p1))); break;
      case 'sub808': x = Math.tanh(1.4 * Math.sin(p1)); break;
      default: x = Math.sin(p1);
    }
    x = lp.run(x) * env * vel * GAIN[inst];
    buf.add(n0 + n, x * gl, x * gr);
  }
}
const GAIN: Record<Instrument, number> = { pad: 0.22, strings: 0.22, ep: 0.3, keys: 0.3, bell: 0.22, organ: 0.25, lead: 0.18, bass: 0.5, sub808: 0.7, reese: 0.4, pluck: 0.4 };

/** Karplus-Strong plucked string with a fractional-delay tuning allpass. */
function pluck(buf: Stereo, n0: number, nTot: number, nOn: number, f: number, vel: number, gl: number, gr: number, seed: number): void {
  const period = SR / f;
  const N = Math.floor(period - 0.5);
  const frac = period - 0.5 - N;
  const c = (1 - frac) / (1 + frac); // allpass coefficient for the fractional part
  const line = new Float32Array(N);
  const r = rng(seed + Math.round(f * 100));
  const tone = new Svf('lp', Math.min(9000, f * 9));
  for (let i = 0; i < N; i++) { line[i] = tone.run(r() * 2 - 1); }
  let idx = 0, prev = 0, apX = 0, apY = 0;
  const damp = 0.996;
  for (let n = 0; n < nTot; n++) {
    const cur = line[idx];
    const avg = damp * 0.5 * (cur + prev);
    prev = cur;
    const y = c * avg + apX - c * apY; apX = avg; apY = y;
    line[idx] = y;
    idx = (idx + 1) % N;
    let env = 1;
    if (n >= nOn) { env = Math.max(0, 1 - (n - nOn) / (nTot - nOn)); }
    const x = cur * env * vel * GAIN.pluck;
    buf.add(n0 + n, x * gl, x * gr);
  }
}

// ---------------------------------------------------------------- drums

export type DrumVoice = 'kick' | 'snare' | 'clap' | 'hat' | 'ohat' | 'rim' | 'tom' | 'shaker' | 'crash';
export interface DrumKit { kickTune: number; kickDecay: number; snareTune: number; tone: 'clean' | 'dusty' | 'hard' }

export function drum(buf: Stereo, v: DrumVoice, t: number, vel = 1, kit: DrumKit = { kickTune: 50, kickDecay: 7, snareTune: 190, tone: 'clean' }, seed = 1): void {
  const n0 = Math.round(t * SR);
  const r = rng(seed);
  const pan: Record<DrumVoice, number> = { kick: 0, snare: 0.04, clap: -0.05, hat: 0.3, ohat: 0.3, rim: -0.25, tom: -0.2, shaker: 0.4, crash: -0.35 };
  const [gl, gr] = panGains(pan[v]);
  const len = { kick: 0.5, snare: 0.32, clap: 0.35, hat: 0.07, ohat: 0.45, rim: 0.06, tom: 0.45, shaker: 0.12, crash: 1.8 }[v];
  const N = Math.round(len * SR);
  const hp = new Svf('hp', v === 'hat' || v === 'ohat' ? 7000 : v === 'crash' ? 4500 : v === 'shaker' ? 5000 : 1200);
  const bp = new Svf('bp', v === 'clap' ? 1200 : 3000, v === 'clap' ? 1.4 : 0.8);
  let ph = 0;
  for (let n = 0; n < N; n++) {
    const s = n / SR;
    const noise = r() * 2 - 1;
    let x = 0;
    switch (v) {
      case 'kick': {
        const f = kit.kickTune + 110 * Math.exp(-34 * s);
        ph += 2 * Math.PI * f / SR;
        x = Math.sin(ph) * Math.exp(-kit.kickDecay * s) + 0.25 * noise * Math.exp(-400 * s);
        x = Math.tanh(1.5 * x) * 0.95;
        break;
      }
      case 'snare': {
        ph += 2 * Math.PI * kit.snareTune / SR;
        x = 0.45 * Math.sin(ph) * Math.exp(-28 * s) + 0.25 * Math.sin(ph * 1.74) * Math.exp(-35 * s) + 0.7 * hp.run(noise) * Math.exp(-14 * s);
        break;
      }
      case 'clap': {
        const burst = [0, 0.009, 0.019, 0.03].reduce((a, o) => a + (s >= o ? Math.exp(-180 * (s - o)) : 0), 0);
        x = 1.6 * bp.run(noise) * (0.6 * burst + 0.5 * Math.exp(-11 * Math.max(0, s - 0.03)) * (s > 0.03 ? 1 : 0));
        break;
      }
      case 'hat': x = 0.55 * hp.run(noise) * Math.exp(-70 * s); break;
      case 'ohat': x = 0.35 * hp.run(noise) * Math.exp(-13 * s); break;
      case 'crash': x = 0.35 * hp.run(noise + 0.4 * Math.sign(Math.sin(2 * Math.PI * 4170 * s))) * Math.exp(-2.4 * s); break;
      case 'shaker': x = 0.4 * hp.run(noise) * Math.min(1, s / 0.012) * Math.exp(-35 * s); break;
      case 'rim': { ph += 2 * Math.PI * 1700 / SR; x = 0.5 * Math.sin(ph) * Math.exp(-90 * s) + 0.4 * bp.run(noise) * Math.exp(-120 * s); break; }
      case 'tom': { const f = 95 + 50 * Math.exp(-20 * s); ph += 2 * Math.PI * f / SR; x = 0.8 * Math.sin(ph) * Math.exp(-7 * s); break; }
    }
    if (kit.tone === 'dusty') { x = Math.round(x * 64) / 64; }       // 6-bit grit
    if (kit.tone === 'hard') { x = Math.tanh(2.2 * x) / Math.tanh(2.2); }
    x *= vel;
    buf.add(n0 + n, x * gl, x * gr);
  }
}

// ---------------------------------------------------------------- textures

/** Vinyl crackle + hiss bed (lo-fi). */
export function vinyl(buf: Stereo, amount = 0.5, seed = 7): void {
  const r = rng(seed); const lp = new Svf('lp', 4000); const hp = new Svf('hp', 300);
  for (let i = 0; i < buf.length; i++) {
    let x = 0.012 * hp.run(lp.run(r() * 2 - 1));
    if (r() < 0.0004) { x += (r() * 2 - 1) * 0.25; }
    buf.add(i, x * amount, x * amount * (0.8 + 0.2 * r()));
  }
}

/** Simple feed-forward lo-fi wobble (tape wow) applied in place. */
export function wow(buf: Stereo, depthMs = 2.5, rateHz = 0.6): void {
  for (const ch of [buf.L, buf.R]) {
    const src = Float32Array.from(ch);
    for (let i = 0; i < ch.length; i++) {
      const d = (depthMs / 1000) * SR * (1 + Math.sin(2 * Math.PI * rateHz * i / SR)) / 2;
      const p = i - d, i0 = Math.floor(p), fr = p - i0;
      const a = src[(i0 + ch.length) % ch.length], b = src[(i0 + 1 + ch.length) % ch.length];
      ch[i] = a + (b - a) * fr;
    }
  }
}

// ---------------------------------------------------------------- WAV I/O

export function writeWavF32(file: string, buf: Stereo): void {
  const n = buf.length; const data = Buffer.alloc(n * 8);
  for (let i = 0; i < n; i++) { data.writeFloatLE(buf.L[i], i * 8); data.writeFloatLE(buf.R[i], i * 8 + 4); }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 8, 28); h.writeUInt16LE(8, 32); h.writeUInt16LE(32, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}
