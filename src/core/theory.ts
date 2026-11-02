// Music theory for the Studio tools: keys, scales, chord symbols (roman numerals and names), progressions,
// voicing and pitch snapping. Pure functions, no I/O.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export const KEYS = NOTE_NAMES;

export const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  'pentatonic-major': [0, 2, 4, 7, 9],
  'pentatonic-minor': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const hzToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);
export const centsBetween = (f: number, ref: number) => 1200 * Math.log2(f / ref);

export function noteName(midi: number, flats = false): string {
  const m = Math.round(midi);
  return (flats ? FLAT_NAMES : NOTE_NAMES)[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

/** "C", "F#", "Bb", "eb" → pitch class 0..11. */
export function pitchClass(name: string): number {
  const m = /^([A-Ga-g])([#b♯♭]*)/.exec(name.trim());
  if (!m) { throw new Error(`Not a note name: "${name}"`); }
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase() as 'C'];
  const acc = [...m[2]].reduce((a, c) => a + (c === '#' || c === '♯' ? 1 : -1), 0);
  return (((base + acc) % 12) + 12) % 12;
}

export function scaleOf(scale: string): number[] {
  const s = SCALES[scale];
  if (!s) { throw new Error(`Unknown scale "${scale}". Try: ${Object.keys(SCALES).join(', ')}`); }
  return s;
}

/** Pitch classes of key + scale, e.g. ("A", "minor") → [9, 11, 0, 2, 4, 5, 7]. */
export function scalePitchClasses(key: string, scale: string): number[] {
  const root = pitchClass(key);
  return scaleOf(scale).map(i => (root + i) % 12);
}

/** MIDI note of a 0-based scale degree (may exceed the scale length and go negative) in an octave. */
export function degreeToMidi(degree: number, octave: number, key: string, scale: string): number {
  const s = scaleOf(scale);
  const oct = Math.floor(degree / s.length);
  return 12 * (octave + 1 + oct) + pitchClass(key) + s[((degree % s.length) + s.length) % s.length];
}

/**
 * Nearest MIDI note (fractional input) whose pitch class is in `allowed`.
 * Ties go to the lower note so a pitch exactly between two notes is stable.
 */
export function snapMidi(midi: number, allowed: number[]): number {
  let best = Math.round(midi), bestD = Infinity;
  for (let c = Math.floor(midi) - 6; c <= Math.ceil(midi) + 6; c++) {
    if (!allowed.includes(((c % 12) + 12) % 12)) { continue; }
    const d = Math.abs(c - midi);
    if (d < bestD - 1e-9) { best = c; bestD = d; }
  }
  return best;
}

// ---------------------------------------------------------------- chords

const QUALITIES: Record<string, number[]> = {
  '': [0, 4, 7], 'm': [0, 3, 7], 'dim': [0, 3, 6], 'aug': [0, 4, 8], 'sus2': [0, 2, 7], 'sus4': [0, 5, 7], '5': [0, 7],
  '6': [0, 4, 7, 9], 'm6': [0, 3, 7, 9], '7': [0, 4, 7, 10], 'maj7': [0, 4, 7, 11], 'm7': [0, 3, 7, 10], 'mMaj7': [0, 3, 7, 11],
  'dim7': [0, 3, 6, 9], 'm7b5': [0, 3, 6, 10], 'add9': [0, 4, 7, 14], 'madd9': [0, 3, 7, 14],
  '9': [0, 4, 7, 10, 14], 'maj9': [0, 4, 7, 11, 14], 'm9': [0, 3, 7, 10, 14], '7sus4': [0, 5, 7, 10], '11': [0, 7, 10, 14, 17], 'm11': [0, 3, 7, 10, 14, 17],
};
const QUALITY_ALIASES: Record<string, string> = {
  'M7': 'maj7', 'Δ': 'maj7', 'Δ7': 'maj7', 'min': 'm', '-': 'm', 'min7': 'm7', '-7': 'm7', '°': 'dim', 'o': 'dim', '°7': 'dim7', 'o7': 'dim7',
  'ø': 'm7b5', 'ø7': 'm7b5', '+': 'aug', 'sus': 'sus4', 'M9': 'maj9', 'min9': 'm9', 'maj': '', 'M': '',
};

export interface Chord { symbol: string; name: string; root: number; intervals: number[]; bass?: number }

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

function quality(q: string): number[] {
  const k = QUALITY_ALIASES[q] ?? q;
  const iv = QUALITIES[k];
  if (!iv) { throw new Error(`Unknown chord quality "${q}"`); }
  return iv;
}

/**
 * Parse a chord symbol in a key: roman numerals ("I", "vi", "V7", "ii7", "IVmaj7", "bVII", "vii°", "V/V" not supported)
 * or absolute names ("Am7", "F#m", "Bbmaj7", "Dsus4", "C/E"). Lower-case numerals are minor, "°" diminished.
 */
export function parseChord(symbol: string, key = 'C', scale = 'major'): Chord {
  const sym = symbol.trim();
  const slash = /^(.+)\/([A-Ga-g][#b]?)$/.exec(sym);
  const body = slash ? slash[1] : sym;
  const bass = slash ? pitchClass(slash[2]) : undefined;
  const rm = /^([b#♭♯]?)(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)(.*)$/.exec(body);
  if (rm && !/^[A-G]/.test(body)) {
    const [, acc, num, rest] = rm;
    const deg = ROMAN.indexOf(num.toUpperCase());
    // "bVI", "#iv": accidentals are relative to the major scale (borrowed-chord convention); plain numerals follow the key's scale.
    const s = acc ? SCALES.major : scaleOf(scale).length === 7 ? scaleOf(scale) : SCALES.major;
    let root = (pitchClass(key) + s[deg] + (acc === 'b' || acc === '♭' ? -1 : acc === '#' || acc === '♯' ? 1 : 0) + 12) % 12;
    const minor = num === num.toLowerCase();
    let q = rest;
    if (minor && !/^(m|dim|°|o|ø)/.test(q)) { q = (q === '' ? 'm' : q === '7' ? 'm7' : q === '9' ? 'm9' : q === '6' ? 'm6' : q === '11' ? 'm11' : q === 'maj7' ? 'mMaj7' : 'm' + q); }
    if (q === 'm°' || q === 'm°7') { q = q.slice(1); }
    const intervals = quality(q);
    root = ((root % 12) + 12) % 12;
    return { symbol: sym, name: NOTE_NAMES[root] + (QUALITY_ALIASES[q] ?? q) + (bass !== undefined ? '/' + NOTE_NAMES[bass] : ''), root, intervals, bass };
  }
  const nm = /^([A-G][#b♯♭]?)(.*)$/.exec(body);
  if (!nm) { throw new Error(`Can't read chord "${symbol}". Use roman numerals (I V vi IV) or names (C G Am F).`); }
  const root = pitchClass(nm[1]);
  return { symbol: sym, name: NOTE_NAMES[root] + (QUALITY_ALIASES[nm[2]] ?? nm[2]) + (bass !== undefined ? '/' + NOTE_NAMES[bass] : ''), root, intervals: quality(nm[2]), bass };
}

/** Split "I V vi IV" / "Am7 | D9 | Gmaj7" / "ii7-V7-Imaj7" into symbols. */
export function splitProgression(text: string): string[] {
  return text.split(/[\s|,]+|(?<=[^b#\s])-(?=[b#]?[IViv]|[A-G])/).map(s => s.trim()).filter(Boolean);
}

export const PROGRESSIONS: Record<string, { label: string; chords: string; scale: 'major' | 'minor' }> = {
  pop: { label: 'Pop  I–V–vi–IV', chords: 'I V vi IV', scale: 'major' },
  sad: { label: 'Sad  vi–IV–I–V', chords: 'vi IV I V', scale: 'major' },
  doowop: { label: '50s  I–vi–IV–V', chords: 'I vi IV V', scale: 'major' },
  jazz: { label: 'Jazz  ii7–V7–Imaj7', chords: 'ii7 V7 Imaj7 Imaj7', scale: 'major' },
  lofi: { label: 'Lo-fi  IVmaj7–iii7–vi7–V', chords: 'IVmaj7 iii7 vi7 V7sus4', scale: 'major' },
  neosoul: { label: 'Neo-soul  Imaj9–vi9–ii9–V9', chords: 'Imaj9 vi9 ii9 V9', scale: 'major' },
  epic: { label: 'Epic  i–VI–III–VII', chords: 'i bVI bIII bVII', scale: 'minor' },
  andalusian: { label: 'Andalusian  i–VII–VI–V', chords: 'i bVII bVI V', scale: 'minor' },
  trap: { label: 'Dark trap  i–iv–VI–V', chords: 'i iv bVI V', scale: 'minor' },
  blues: { label: '12-bar blues', chords: 'I7 I7 I7 I7 IV7 IV7 I7 I7 V7 IV7 I7 V7', scale: 'major' },
};

/** Resolve a preset name or free text into parsed chords. */
export function progression(textOrPreset: string, key: string, scale: string): Chord[] {
  const preset = PROGRESSIONS[textOrPreset];
  const syms = splitProgression(preset ? preset.chords : textOrPreset);
  if (!syms.length) { throw new Error('Enter at least one chord.'); }
  if (!preset) { return syms.map(s => parseChord(s, key, scale)); }
  // A major-mode preset in a minor key (or vice versa) is played in the relative key, so its chords stay diatonic
  // to the key/scale everything else (bass, lead, auto-tune) uses: "pop" in A minor → C major's I–V–vi–IV.
  const minorish = scaleOf(scale).includes(3) && !scaleOf(scale).includes(4);
  const presetMinor = preset.scale === 'minor';
  const root = pitchClass(key);
  const k = minorish === presetMinor ? key : NOTE_NAMES[(root + (presetMinor ? 9 : 3)) % 12];
  return syms.map(s => parseChord(s, k, preset.scale));
}

/**
 * Voice a chord as MIDI notes around a centre note with smooth voice leading:
 * each chord tone goes to the octave nearest the previous voicing (or the centre).
 */
export function voiceChord(ch: Chord, centre = 60, previous?: number[]): number[] {
  const tones = ch.intervals.map(i => (ch.root + i));
  const ref = previous && previous.length ? previous.reduce((a, b) => a + b, 0) / previous.length : centre;
  const out = tones.map(t => {
    let m = t + 12 * Math.round((ref - t) / 12);
    if (m > centre + 9) { m -= 12; } if (m < centre - 10) { m += 12; }
    return m;
  }).sort((a, b) => a - b);
  // avoid seconds clashing at the bottom of the voicing
  for (let i = 1; i < out.length; i++) { if (out[i] - out[i - 1] < 2 && i < out.length) { out[i] += 12; } }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Bass note (MIDI) for a chord, in octave 2. */
export function bassNote(ch: Chord, octave = 2): number {
  return 12 * (octave + 1) + (ch.bass ?? ch.root);
}
