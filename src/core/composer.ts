// Studio "Create" tools: drum beats, chord progressions, full instrumentals, and layering a generated part onto a track.
// Synthesis happens in JS (synth.ts); ffmpeg masters (reverb, glue, loudness) and encodes. No vscode.
import * as path from 'path';
import * as fs from 'fs';
import { runOk } from './ffmpeg';
import { SR, Stereo, Instrument, DrumVoice, DrumKit, note, drum, vinyl, wow, rng } from './synth';
import { progression, voiceChord, bassNote, midiToHz, Chord, degreeToMidi, scalePitchClasses } from './theory';
import { Tools, master, durationOf } from './audioio';

export interface Groove { bpm: number; key: string; scale: string; bars: number; swing?: number; seed?: number; beatsPerBar?: number }
export interface RenderOut { file: string; seconds: number; detail: string }

const barSeconds = (g: Groove) => (60 / g.bpm) * (g.beatsPerBar ?? 4);
const stepSeconds = (g: Groove) => 60 / g.bpm / 4;
/** Time of a 16th step, with swing delaying the off-16ths. */
const stepTime = (g: Groove, bar: number, step: number) => bar * barSeconds(g) + step * stepSeconds(g) + (step % 2 === 1 ? (g.swing ?? 0) * stepSeconds(g) : 0);

// ---------------------------------------------------------------- beats

/** 16-step patterns per bar. X accent, x hit, o ghost, r 32nd roll, t triplet roll, . rest. Two strings = alternating bars. */
export interface BeatStyle { label: string; bpm: number; swing: number; kit: DrumKit; parts: Partial<Record<DrumVoice, string | string[]>> }
export const BEAT_STYLES: Record<string, BeatStyle> = {
  house: { label: 'House (four on the floor)', bpm: 124, swing: 0, kit: { kickTune: 48, kickDecay: 8, snareTune: 200, tone: 'clean' },
    parts: { kick: 'X...X...X...X...', clap: '....X.......X...', hat: 'o.o.o.o.o.o.o.o.', ohat: '..x...x...x...x.' } },
  boombap: { label: 'Boom bap', bpm: 90, swing: 0.12, kit: { kickTune: 52, kickDecay: 7, snareTune: 185, tone: 'dusty' },
    parts: { kick: ['X......x..X.....', 'X......x..X..x..'], snare: ['....X.......X...', '....X.......X..o'], hat: 'x.x.x.x.x.x.x.x.' } },
  trap: { label: 'Trap', bpm: 140, swing: 0, kit: { kickTune: 46, kickDecay: 5, snareTune: 210, tone: 'hard' },
    parts: { kick: ['X.......x.X.....', 'X..x......X.....'], clap: '........X.......', snare: '........X.......', hat: ['x.x.x.x.x.xrx.x.', 'x.x.xtx.x.x.x.rr'] } },
  lofi: { label: 'Lo-fi hip hop', bpm: 80, swing: 0.18, kit: { kickTune: 50, kickDecay: 8, snareTune: 175, tone: 'dusty' },
    parts: { kick: ['X.....x...x.....', 'X.....x..x......'], snare: '....X.......X...', hat: 'x.xox.x.x.xox.x.', shaker: '..o...o...o...o.' } },
  rock: { label: 'Rock', bpm: 110, swing: 0, kit: { kickTune: 55, kickDecay: 9, snareTune: 190, tone: 'clean' },
    parts: { kick: 'X.....X.X.......', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' } },
  dnb: { label: 'Drum & bass', bpm: 172, swing: 0, kit: { kickTune: 52, kickDecay: 10, snareTune: 230, tone: 'hard' },
    parts: { kick: 'X.........X.....', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', ohat: '..............x.' } },
  reggaeton: { label: 'Reggaeton (dembow)', bpm: 95, swing: 0, kit: { kickTune: 50, kickDecay: 8, snareTune: 220, tone: 'clean' },
    parts: { kick: 'X...X...X...X...', snare: '...x..x....x..x.', hat: 'x.x.x.x.x.x.x.x.', rim: '..o.....' + '..o.....' } },
};

export interface BeatEvent { t: number; voice: DrumVoice; vel: number }
export interface BeatOptions extends Groove { style: string; fill?: boolean; humanize?: boolean }

function velOf(c: string): number { return c === 'X' ? 1 : c === 'x' ? 0.78 : c === 'o' ? 0.42 : c === 'r' || c === 't' ? 0.6 : 0; }

/** Schedule drum hits for a groove (exact times; humanize adds a few ms of seeded jitter). */
export function beatEvents(o: BeatOptions): BeatEvent[] {
  const st = BEAT_STYLES[o.style];
  if (!st) { throw new Error(`Unknown beat style "${o.style}". Try: ${Object.keys(BEAT_STYLES).join(', ')}`); }
  const g = { swing: st.swing, ...o };
  const r = rng(o.seed ?? 3);
  const ev: BeatEvent[] = [];
  for (let bar = 0; bar < o.bars; bar++) {
    const fillBar = o.fill && o.bars >= 4 && bar === o.bars - 1;
    for (const [voice, pat] of Object.entries(st.parts) as [DrumVoice, string | string[]][]) {
      const p = Array.isArray(pat) ? pat[bar % pat.length] : pat;
      for (let s = 0; s < 16; s++) {
        if (fillBar && s >= 12 && (voice === 'snare' || voice === 'clap' || voice === 'hat')) { continue; }
        const c = p[s] ?? '.';
        const v = velOf(c);
        if (!v) { continue; }
        const jitter = o.humanize ? (r() - 0.5) * 0.006 : 0;
        const t = stepTime(g, bar, s) + (s === 0 && bar === 0 ? 0 : jitter);
        const vel = o.humanize ? v * (0.9 + 0.2 * r()) : v;
        if (c === 'r') { ev.push({ t, voice, vel }, { t: t + stepSeconds(g) / 2, voice, vel: vel * 0.8 }); }
        else if (c === 't') { for (let k = 0; k < 3; k++) { ev.push({ t: t + k * stepSeconds(g) * 2 / 3, voice, vel: vel * (1 - k * 0.12) }); } }
        else { ev.push({ t, voice, vel }); }
      }
    }
    if (fillBar) { // snare/tom fill over the last beat
      for (let k = 0; k < 4; k++) { ev.push({ t: stepTime(g, bar, 12 + k), voice: k < 2 ? 'snare' : 'tom', vel: 0.55 + 0.15 * k }); }
    }
    if (o.fill && bar === 0 && o.bars >= 4) { ev.push({ t: 0, voice: 'crash', vel: 0.55 }); }
  }
  return ev.sort((a, b) => a.t - b.t);
}

export function renderBeatBuffer(o: BeatOptions, buf?: Stereo): { buf: Stereo; events: BeatEvent[] } {
  const st = BEAT_STYLES[o.style];
  const events = beatEvents(o);
  const b = buf ?? Stereo.seconds(o.bars * barSeconds(o), true);
  events.forEach((e, i) => drum(b, e.voice, e.t, e.vel, st.kit, i + 1));
  return { buf: b, events };
}

export async function renderBeats(t: Tools, o: BeatOptions, out: string, m: { codec?: string[]; lufs?: number; signal?: AbortSignal } = {}): Promise<RenderOut & { events: BeatEvent[] }> {
  const { buf, events } = renderBeatBuffer(o);
  await master(t, buf, out, { loop: true, codec: m.codec, lufs: m.lufs ?? -12, reverb: 0.12, signal: m.signal });
  return { file: out, seconds: buf.length / SR, events, detail: `${BEAT_STYLES[o.style].label} · ${o.bpm} BPM · ${o.bars} bars · ${events.length} hits` };
}

// ---------------------------------------------------------------- chords

export type ChordRhythm = 'sustain' | 'stabs' | 'pulse' | 'arp' | 'strum';
export interface ChordOptions extends Groove { progression: string; instrument: Instrument; rhythm: ChordRhythm; barsPerChord?: number; octave?: number }
export interface ChordEvent { t: number; dur: number; name: string; notes: number[] }

/** Lay out the progression over the bars, voice-led. */
export function chordEvents(o: ChordOptions): ChordEvent[] {
  const chords = progression(o.progression, o.key, o.scale);
  const per = (o.barsPerChord ?? 1) * barSeconds(o);
  const total = o.bars * barSeconds(o);
  const centre = 12 * ((o.octave ?? 4) + 1);
  const ev: ChordEvent[] = [];
  let prev: number[] | undefined;
  for (let i = 0, t = 0; t < total - 1e-6; i++, t += per) {
    const ch = chords[i % chords.length];
    prev = voiceChord(ch, centre, prev);
    ev.push({ t, dur: Math.min(per, total - t), name: ch.name, notes: prev });
  }
  return ev;
}

export function renderChordBuffer(o: ChordOptions, buf?: Stereo): { buf: Stereo; events: ChordEvent[] } {
  const b = buf ?? Stereo.seconds(o.bars * barSeconds(o), true);
  const events = chordEvents(o);
  const beat = 60 / o.bpm, step = stepSeconds(o);
  for (const e of events) {
    const spread = (i: number, n: number) => (n > 1 ? (i / (n - 1)) * 0.6 - 0.3 : 0);
    switch (o.rhythm) {
      case 'sustain':
        e.notes.forEach((m, i) => note(b, o.instrument, e.t, e.dur * 0.98, midiToHz(m), { pan: spread(i, e.notes.length), vel: 0.75 }));
        break;
      case 'stabs': // off-beat stabs (house/reggae)
        for (let q = 0; q * beat < e.dur - 1e-6; q++) { e.notes.forEach((m, i) => note(b, o.instrument, e.t + q * beat + beat / 2, beat * 0.3, midiToHz(m), { pan: spread(i, e.notes.length), vel: 0.7 })); }
        break;
      case 'pulse': // straight 8ths
        for (let k = 0; k * beat / 2 < e.dur - 1e-6; k++) { e.notes.forEach((m, i) => note(b, o.instrument, e.t + k * beat / 2, beat * 0.4, midiToHz(m), { pan: spread(i, e.notes.length), vel: k % 2 ? 0.5 : 0.7 })); }
        break;
      case 'arp': { // up-down 16ths through the voicing plus the octave
        const seq = [...e.notes, e.notes[0] + 12];
        const order = [...seq, ...seq.slice(1, -1).reverse()];
        for (let k = 0; k * step < e.dur - 1e-6; k++) {
          const t = e.t + k * step + (k % 2 ? (o.swing ?? 0) * step : 0);
          note(b, o.instrument, t, step * 0.9, midiToHz(order[k % order.length]), { pan: Math.sin(k * 0.7) * 0.4, vel: k % 4 === 0 ? 0.8 : 0.6 });
        }
        break;
      }
      case 'strum':
        for (const q of [0, 2]) { if (q * beat < e.dur) { e.notes.forEach((m, i) => note(b, o.instrument, e.t + q * beat + i * 0.018, Math.min(e.dur - q * beat, beat * 2) * 0.95, midiToHz(m), { pan: spread(i, e.notes.length), vel: 0.7 })); } }
        break;
    }
  }
  return { buf: b, events };
}

export async function renderChords(t: Tools, o: ChordOptions, out: string, m: { codec?: string[]; lufs?: number; signal?: AbortSignal } = {}): Promise<RenderOut & { events: ChordEvent[] }> {
  const { buf, events } = renderChordBuffer(o);
  await master(t, buf, out, { loop: true, codec: m.codec, lufs: m.lufs ?? -16, reverb: 0.35, signal: m.signal });
  const names: string[] = [];
  for (const e of events) { if (names[names.length - 1] !== e.name) { names.push(e.name); } }
  return { file: out, seconds: buf.length / SR, events, detail: `${names.slice(0, 8).join(' → ')}${names.length > 8 ? ' …' : ''} · ${o.bpm} BPM` };
}

// ---------------------------------------------------------------- instrumental

export type BassStyle = 'none' | 'sustain' | 'eighths' | 'octaves' | 'kick' | 'walk';
export interface Genre { label: string; bpm: number; scale: 'major' | 'minor'; beat?: string; progression: string; chords: Instrument; rhythm: ChordRhythm; bass: BassStyle; bassInst: Instrument; lead?: Instrument; vinyl?: boolean; reverb: number }
export const GENRES: Record<string, Genre> = {
  lofi: { label: 'Lo-fi', bpm: 80, scale: 'major', beat: 'lofi', progression: 'lofi', chords: 'ep', rhythm: 'sustain', bass: 'sustain', bassInst: 'bass', lead: 'keys', vinyl: true, reverb: 0.4 },
  pop: { label: 'Pop', bpm: 108, scale: 'major', beat: 'rock', progression: 'pop', chords: 'keys', rhythm: 'pulse', bass: 'eighths', bassInst: 'bass', lead: 'pluck', reverb: 0.3 },
  house: { label: 'House', bpm: 124, scale: 'major', beat: 'house', progression: 'sad', chords: 'organ', rhythm: 'stabs', bass: 'octaves', bassInst: 'bass', reverb: 0.25 },
  trap: { label: 'Trap', bpm: 140, scale: 'minor', beat: 'trap', progression: 'trap', chords: 'pad', rhythm: 'sustain', bass: 'kick', bassInst: 'sub808', lead: 'bell', reverb: 0.3 },
  rnb: { label: 'R&B / neo-soul', bpm: 88, scale: 'major', beat: 'boombap', progression: 'neosoul', chords: 'ep', rhythm: 'strum', bass: 'walk', bassInst: 'bass', reverb: 0.35 },
  dnb: { label: 'Drum & bass', bpm: 172, scale: 'minor', beat: 'dnb', progression: 'epic', chords: 'pad', rhythm: 'sustain', bass: 'sustain', bassInst: 'reese', lead: 'pluck', reverb: 0.35 },
  reggaeton: { label: 'Reggaeton', bpm: 95, scale: 'minor', beat: 'reggaeton', progression: 'andalusian', chords: 'pluck', rhythm: 'stabs', bass: 'kick', bassInst: 'bass', reverb: 0.25 },
  ambient: { label: 'Ambient', bpm: 70, scale: 'major', progression: 'epic', chords: 'pad', rhythm: 'sustain', bass: 'sustain', bassInst: 'bass', lead: 'bell', reverb: 0.8 },
  cinematic: { label: 'Cinematic', bpm: 90, scale: 'minor', progression: 'epic', chords: 'strings', rhythm: 'sustain', bass: 'sustain', bassInst: 'sub808', lead: 'bell', reverb: 0.7 },
};

export interface InstrumentalOptions extends Groove { genre: string; progression?: string; arrangement?: 'loop' | 'song'; lead?: boolean }

function bassLine(b: Stereo, o: InstrumentalOptions, gen: Genre, chords: ChordEvent[], kicks: BeatEvent[], parsed: Chord[], from = 0): void {
  const beat = 60 / o.bpm;
  const allowed = scalePitchClasses(o.key, o.scale);
  chords.forEach((e, ci) => {
    if (e.t < from) { return; }
    const ch = parsed[ci % parsed.length];
    const root = bassNote(ch, gen.bassInst === 'sub808' ? 1 : 2);
    const f = midiToHz(root);
    switch (gen.bass) {
      case 'sustain': note(b, gen.bassInst, e.t, e.dur * 0.97, f, { vel: 0.85 }); break;
      case 'eighths': for (let k = 0; k * beat / 2 < e.dur - 1e-6; k++) { note(b, gen.bassInst, e.t + k * beat / 2, beat * 0.42, f, { vel: k % 2 ? 0.6 : 0.85 }); } break;
      case 'octaves': for (let k = 0; k * beat / 2 < e.dur - 1e-6; k++) { note(b, gen.bassInst, e.t + k * beat / 2, beat * 0.3, midiToHz(root + (k % 2 ? 12 : 0)), { vel: k % 2 ? 0.75 : 0.6 }); } break;
      case 'kick':
        for (const k of kicks) { if (k.voice === 'kick' && k.t >= e.t - 1e-6 && k.t < e.t + e.dur - 1e-6) { const nxt = kicks.find(x => x.voice === 'kick' && x.t > k.t + 1e-6); note(b, gen.bassInst, k.t, Math.min((nxt ? nxt.t : e.t + e.dur) - k.t, beat * 2) * 0.95, f, { vel: 0.9 }); } }
        break;
      case 'walk': { // root, 3rd, 5th, chromatic/scale approach into the next chord
        const next = parsed[(ci + 1) % parsed.length];
        const nextRoot = bassNote(next, 2);
        const tones = [root, root + ch.intervals[1], root + ch.intervals[2]];
        const approach = allowed.includes(((nextRoot - 1) % 12 + 12) % 12) ? nextRoot - 1 : nextRoot + 1;
        const beats = Math.round(e.dur / beat);
        for (let k = 0; k < beats; k++) { note(b, gen.bassInst, e.t + k * beat, beat * 0.85, midiToHz(k === beats - 1 && beats > 1 ? approach : tones[k % 3]), { vel: k === 0 ? 0.9 : 0.7 }); }
        break;
      }
    }
  });
}

/** A simple motif: chord tones on a seeded rhythm, an octave above the pad. */
function leadLine(b: Stereo, o: InstrumentalOptions, inst: Instrument, chords: ChordEvent[], from: number): void {
  const r = rng((o.seed ?? 5) * 31);
  const step = stepSeconds(o);
  const rhythm = Array.from({ length: 16 }, (_, s) => (s % 4 === 0 ? r() < 0.75 : r() < 0.28));
  const deg = Array.from({ length: 16 }, () => Math.floor(r() * 4));
  for (const e of chords) {
    if (e.t < from) { continue; }
    for (let s = 0; s * step < e.dur - 1e-6; s++) {
      if (!rhythm[s % 16]) { continue; }
      const m = e.notes[deg[s % 16] % e.notes.length] + 12;
      note(b, inst, e.t + s * step, step * 1.6, midiToHz(m), { vel: 0.5, pan: 0.15 });
    }
  }
}

export async function renderInstrumental(t: Tools, o: InstrumentalOptions, out: string, m: { codec?: string[]; lufs?: number; signal?: AbortSignal } = {}): Promise<RenderOut & { chords: ChordEvent[]; events: BeatEvent[] }> {
  const gen = GENRES[o.genre];
  if (!gen) { throw new Error(`Unknown genre "${o.genre}". Try: ${Object.keys(GENRES).join(', ')}`); }
  const song = o.arrangement === 'song';
  const bar = barSeconds(o);
  const intro = song ? Math.min(2, Math.max(0, o.bars - 2)) : 0;
  const tail = song ? 2.5 : 0;
  const total = o.bars * bar;
  const b = Stereo.seconds(total + tail, !song);
  const prog = o.progression || gen.progression;
  const copt: ChordOptions = { ...o, progression: prog, instrument: gen.chords, rhythm: gen.rhythm, barsPerChord: o.genre === 'ambient' || o.genre === 'cinematic' ? 2 : 1, octave: 4 };
  const { events: chords } = renderChordBuffer(copt, b);
  // final chord rings out at the end of a song arrangement
  if (song) { const last = chords[chords.length - 1]; last.notes.forEach(n => note(b, gen.chords, total, bar * 0.9, midiToHz(n), { vel: 0.6 })); }
  let events: BeatEvent[] = [];
  if (gen.beat) {
    const bo: BeatOptions = { ...o, style: gen.beat, bars: o.bars - intro, fill: o.bars - intro >= 4, humanize: true, swing: o.swing ?? BEAT_STYLES[gen.beat].swing };
    const drums = new Stereo(b.length, b.wrap);
    const r = renderBeatBuffer(bo, drums);
    events = r.events.map(e => ({ ...e, t: e.t + intro * bar }));
    // shift into place after the intro (drums were rendered from t=0)
    const off = Math.round(intro * bar * SR);
    for (let i = 0; i < drums.length; i++) { b.add(i + off, drums.L[i] * 0.95, drums.R[i] * 0.95); }
  }
  const parsed = progression(prog, o.key, o.scale);
  bassLine(b, o, gen, chords, events, parsed, song ? intro * bar : 0);
  if (o.lead !== false && gen.lead) { leadLine(b, o, gen.lead, chords, song ? (intro + 2) * bar : 0); }
  if (gen.vinyl) { vinyl(b, 0.6); wow(b, 1.8, 0.5); }
  await master(t, b, out, { loop: !song, codec: m.codec, lufs: m.lufs ?? -14, reverb: gen.reverb, signal: m.signal, af: song ? `afade=t=out:st=${(total + tail - 2).toFixed(3)}:d=2` : undefined });
  return { file: out, seconds: b.length / SR, chords, events, detail: `${gen.label} · ${o.key} ${o.scale} · ${o.bpm} BPM · ${o.bars} bars · ${[...new Set(chords.map(c => c.name))].join(' ')}` };
}

// ---------------------------------------------------------------- melody helper for tests / previews

/** MIDI notes of a scale run (used by the auto-tune demo and tests). */
export function scaleRun(key: string, scale: string, octave = 4, n = 8): number[] {
  return Array.from({ length: n }, (_, i) => degreeToMidi(i, octave, key, scale));
}

// ---------------------------------------------------------------- layering

export interface LayerOptions { offset?: number; gainDb?: number; loop?: boolean; duck?: boolean; extend?: boolean; codec?: string[]; signal?: AbortSignal }

/**
 * Layer `part` (beats, chords, an instrumental, an SFX) onto `target`. The part can repeat to fill the target and can be
 * ducked under it (sidechain keyed by the target — the key is apad'ed so the bed isn't cut when the target ends).
 * Output length = target length (or the longer of the two with `extend`).
 */
export async function layerOnto(t: Tools, target: string, part: string, out: string, o: LayerOptions = {}): Promise<RenderOut> {
  const dur = await durationOf(t.ffprobe, target);
  const partDur = await durationOf(t.ffprobe, part);
  const off = Math.max(0, o.offset ?? 0);
  const outDur = o.extend && !o.loop ? Math.max(dur, off + partDur) : dur;
  const fmt = `aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=stereo`;
  const graph = [
    `[0:a]${fmt},apad,atrim=end=${outDur.toFixed(6)}${o.duck ? ',asplit=2[t][key];[key]apad[keyp]' : '[t]'}`,
    `[1:a]${fmt},volume=${(o.gainDb ?? 0).toFixed(2)}dB,adelay=${Math.round(off * 1000)}:all=1,apad,atrim=end=${outDur.toFixed(6)}[p0]`,
    o.duck ? '[p0][keyp]sidechaincompress=threshold=0.05:ratio=4:attack=15:release=250[p]' : '[p0]anull[p]',
    `[t][p]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=0:latency=1[out]`,
  ].join(';');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await runOk({ exe: t.ffmpeg, signal: o.signal, args: ['-hide_banner', '-nostdin', '-y', '-i', target, ...(o.loop ? ['-stream_loop', '-1'] : []), '-i', part,
    '-filter_complex', graph, '-map', '[out]', ...(o.codec ?? ['-c:a', 'pcm_s24le']), out] });
  return { file: out, seconds: outDur, detail: `${path.basename(part)} → ${path.basename(target)}${o.loop ? ' (looped)' : ''}${o.duck ? ' (ducked)' : ''}` };
}
