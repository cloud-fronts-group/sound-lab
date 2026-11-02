#!/usr/bin/env node
'use strict';
// QWERTY "keyboard instrument" renderer for the soundlab-agent performance.
// Renders a phased score (pulse → chords/pad → melody/texture → chorus) to audio: synthesis in JS,
// then ffmpeg adds room reverb, gentle glue compression and loudness normalisation.
//
//   keyboard-synth.js --keymap
//   keyboard-synth.js --score performance.json --out performance.wav [--target -16]
//
// Keyboard mapping (key + scale come from the score):
//   number row 1-0  bass, scale degrees 1-10, octave 2
//   bottom row Z-M  chord ladder in stacked thirds from degree 4  (Z-X-C-V = IV7, +B = IV9)
//   home row  A-L   chord ladder in stacked thirds from degree 1  (A-S-D-F = I7,  +G = I9)
//   top row   Q-P   melody, scale degrees 1-10, octave 5
//   "." tick · "," rim tick · "Space" soft kick + tick (metronome / pulse)
//   Modifiers in "fx": "Shift:tape" (tape saturation + wow), "Ctrl:filter-sweep" (pad low-pass opens across the phase)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SR = 48000;
const FF = process.env.SOUND_LAB_FFMPEG || 'ffmpeg';
const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11], phrygian: [0, 1, 3, 5, 7, 8, 10], 'pentatonic-minor': [0, 3, 5, 7, 10], 'pentatonic-major': [0, 2, 4, 7, 9],
};
const ROWS = { number: '1234567890', top: 'QWERTYUIOP', home: 'ASDFGHJKL;', bottom: 'ZXCVBNM,./' };

function midiOf(degree, octave, keyRoot, scale) {
  // degree is 0-based scale index; may exceed scale length (wraps into higher octaves)
  const s = SCALES[scale] || SCALES.dorian;
  const oct = Math.floor(degree / s.length);
  return 12 * (octave + 1 + oct) + keyRoot + s[((degree % s.length) + s.length) % s.length];
}
const hz = m => 440 * Math.pow(2, (m - 69) / 12);

/** Map one key to a MIDI note for its row's role. */
function keyToMidi(key, ctx) {
  const k = key.toUpperCase();
  let i;
  if ((i = ROWS.top.indexOf(k)) >= 0) { return { role: 'melody', midi: midiOf(i, 5, ctx.root, ctx.scale) }; }
  if ((i = ROWS.home.indexOf(k)) >= 0) { return { role: 'chord', midi: midiOf(i * 2, 3, ctx.root, ctx.scale) }; }       // stacked thirds from I
  if ((i = ROWS.bottom.indexOf(k)) >= 0 && i < 7) { return { role: 'chord', midi: midiOf(3 + i * 2, 3, ctx.root, ctx.scale) }; } // stacked thirds from IV
  if ((i = ROWS.number.indexOf(k)) >= 0) { return { role: 'bass', midi: midiOf(i, 2, ctx.root, ctx.scale) }; }
  return null;
}

function keymapText(root = 'D', scale = 'dorian') {
  const ctx = { root: NOTE[root] ?? 2, scale };
  const name = m => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][m % 12] + (Math.floor(m / 12) - 1);
  const line = (row, label) => `${label.padEnd(16)}` + [...row].map(k => { const r = keyToMidi(k, ctx); return r ? `${k}=${name(r.midi)}` : null; }).filter(Boolean).join('  ');
  return [`Key ${root} ${scale}`, line(ROWS.number, 'number (bass)'), line(ROWS.top, 'top (melody)'), line(ROWS.home, 'home (I ladder)'), line(ROWS.bottom, 'bottom (IV)'),
    'pulse           "." tick  "," rim  "Space" kick+tick', 'modifiers       Shift:tape  Ctrl:filter-sweep'].join('\n');
}

// ---------------------------------------------------------------- synthesis primitives (stereo float buffers)
function addTone(buf, startS, durS, f, { amp = 0.2, attack = 0.01, release = 0.3, wave = 'sine', pan = 0, detune = 0, vibrato = 0, decay = 0 } = {}) {
  const [L, R] = buf; const n0 = Math.floor(startS * SR); const nDur = Math.floor(durS * SR); const nRel = Math.floor(release * SR);
  const gl = amp * Math.cos((pan + 1) * Math.PI / 4), gr = amp * Math.sin((pan + 1) * Math.PI / 4);
  let ph = 0, ph2 = 0;
  for (let n = 0; n < nDur + nRel && n0 + n < L.length; n++) {
    const t = n / SR;
    let env = Math.min(1, t / attack);
    if (decay > 0) { env *= Math.exp(-decay * t); }
    if (n > nDur) { env *= 1 - (n - nDur) / nRel; }
    const fm = f * (1 + vibrato * Math.sin(2 * Math.PI * 5.2 * t));
    ph += 2 * Math.PI * fm / SR; ph2 += 2 * Math.PI * fm * (1 + detune) / SR;
    let s;
    if (wave === 'saw') { s = 0.5 * (((ph / Math.PI) % 2) - 1) + 0.5 * (((ph2 / Math.PI) % 2) - 1); }
    else if (wave === 'tri') { s = (2 / Math.PI) * Math.asin(Math.sin(ph)); }
    else if (wave === 'ep') { s = Math.sin(ph) + 0.35 * Math.sin(2 * ph) * Math.exp(-6 * t) + 0.12 * Math.sin(3 * ph2); }
    else { s = Math.sin(ph); }
    if (n0 + n >= 0) { L[n0 + n] += s * env * gl; R[n0 + n] += s * env * gr; }
  }
}

function addClick(buf, startS, { amp = 0.25, freq = 1800, pan = 0.25, kick = false } = {}) {
  addTone(buf, startS, 0.02, freq, { amp, attack: 0.0005, release: 0.02, decay: 60, pan });
  if (kick) {
    const [L, R] = buf; const n0 = Math.floor(startS * SR);
    let ph = 0;
    for (let n = 0; n < SR * 0.35 && n0 + n < L.length; n++) {
      const t = n / SR; const f = 45 + 70 * Math.exp(-30 * t);
      ph += 2 * Math.PI * f / SR;
      const s = 0.55 * Math.sin(ph) * Math.exp(-9 * t);
      L[n0 + n] += s; R[n0 + n] += s;
    }
  }
}

/** One-pole low-pass on a region with a cutoff that moves linearly from c0 to c1. */
function lowpassRegion(chan, n0, n1, c0, c1) {
  let y = 0;
  for (let n = n0; n < n1 && n < chan.length; n++) {
    const fc = c0 + (c1 - c0) * ((n - n0) / Math.max(1, n1 - n0));
    const a = 1 - Math.exp(-2 * Math.PI * fc / SR);
    y += a * (chan[n] - y); chan[n] = y;
  }
}

// ---------------------------------------------------------------- score rendering
function render(score) {
  const bpm = score.bpm || 76;
  const beat = 60 / bpm;
  const bar = beat * (score.beatsPerBar || 4);
  const ctx = { root: NOTE[score.key || 'D'] ?? 2, scale: score.scale || 'dorian' };
  const phases = score.phases || [];
  const totalBars = phases.reduce((a, p) => a + (p.bars || 4), 0);
  const tail = 4;
  const len = Math.ceil((totalBars * bar + tail) * SR);
  const mk = () => [new Float32Array(len), new Float32Array(len)];
  const mix = mk();
  const log = [];
  let t0 = 0;

  for (const ph of phases) {
    const bars = ph.bars || 4;
    const fx = (ph.fx || []).map(s => String(s).toLowerCase());
    const pad = mk(); const keys = mk(); const lead = mk(); const pulse = mk();
    const chords = (ph.chords || []).map(c => String(c).split(/[-+\s]+/).map(k => keyToMidi(k, ctx)).filter(Boolean).map(r => r.midi));
    const melody = ph.melody || [];
    const step = beat / 2; // melody tokens are eighth notes
    for (let b = 0; b < bars; b++) {
      const bt = t0 + b * bar;
      // pulse / metronome
      const pk = ph.metronome;
      if (pk) {
        for (let q = 0; q < (score.beatsPerBar || 4); q++) {
          const accent = q === 0;
          if (pk === 'Space') { addClick(pulse, bt + q * beat, { amp: accent ? 0.22 : 0.14, kick: q % 2 === 0 }); }
          else { addClick(pulse, bt + q * beat, { amp: accent ? 0.16 : 0.09, freq: pk === ',' ? 2600 : accent ? 2100 : 1600 }); }
        }
      }
      // harmony
      if (chords.length) {
        const ch = chords[b % chords.length];
        ch.forEach((m, i) => {
          if (ph.pad !== false) {
            addTone(pad, bt, bar, hz(m), { amp: 0.055, attack: Math.min(1.2, bar * 0.4), release: bar * 0.6, wave: 'saw', detune: 0.004, pan: (i % 2 ? 0.35 : -0.35) });
          }
          // electric-piano voicing struck on beats 1 and 3 once the instrumental layer arrives
          if (ph.ep || melody.length) {
            for (const q of [0, 2]) { addTone(keys, bt + q * beat + i * 0.012, beat * 1.6, hz(m + 12), { amp: 0.06, attack: 0.004, release: 0.5, decay: 1.8, wave: 'ep', pan: -0.1 + i * 0.07 }); }
          }
        });
        if (ph.bass || (ph.name && /chorus/i.test(ph.name))) {
          addTone(keys, bt, beat * 2.8, hz(ch[0] - 12), { amp: 0.16, attack: 0.01, release: 0.3, decay: 0.6, wave: 'tri' });
          addTone(keys, bt + 2 * beat, beat * 1.8, hz(ch[0] - 12), { amp: 0.12, attack: 0.01, release: 0.25, decay: 0.8, wave: 'tri' });
        }
        log.push(`${ph.name || 'phase'} bar ${b + 1}: chord [${(ph.chords[b % chords.length])}]`);
      }
      // melody: eighth-note tokens, "-" = rest/hold
      if (melody.length) {
        const per = Math.round(bar / step);
        for (let s = 0; s < per; s++) {
          const tok = melody[(b * per + s) % melody.length];
          if (!tok || tok === '-') { continue; }
          const r = keyToMidi(String(tok), ctx);
          if (!r) { continue; }
          let hold = 1; while (melody[(b * per + s + hold) % melody.length] === '-' && hold < 4) { hold++; }
          addTone(lead, bt + s * step, step * hold * 0.95, hz(r.midi), { amp: 0.11, attack: 0.012, release: 0.35, wave: 'tri', vibrato: 0.004, pan: 0.05 });
        }
      }
    }
    // modifier-key textures for this phase
    const n0 = Math.floor(t0 * SR), n1 = Math.floor((t0 + bars * bar + 2) * SR);
    const sweep = fx.find(f => f.includes('filter-sweep'));
    for (const ch of pad) { lowpassRegion(ch, n0, n1, sweep ? 350 : 1800, sweep ? 4200 : 1800); }
    const tape = fx.some(f => f.includes('tape'));
    for (const layer of [pad, keys, lead, pulse]) {
      for (let c = 0; c < 2; c++) {
        const src = layer[c], dst = mix[c];
        for (let n = n0; n < n1 && n < len; n++) { dst[n] += tape ? Math.tanh(src[n] * 1.8) / 1.5 : src[n]; }
      }
    }
    log.push(`${ph.name || 'phase'}: ${bars} bars @ ${bpm} BPM${fx.length ? `, fx ${fx.join(' ')}` : ''}`);
    t0 += bars * bar;
  }
  return { mix, seconds: t0 + tail, log };
}

function writeWavF32(file, [L, R]) {
  const n = L.length; const data = Buffer.alloc(n * 8);
  for (let i = 0; i < n; i++) { data.writeFloatLE(L[i], i * 8); data.writeFloatLE(R[i], i * 8 + 4); }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 8, 28); h.writeUInt16LE(8, 32); h.writeUInt16LE(32, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

function main() {
  const a = process.argv.slice(2);
  const get = k => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
  if (a.includes('--keymap')) { process.stdout.write(keymapText(get('key'), get('scale')) + '\n'); return; }
  const scoreFile = get('score'); const out = get('out') || 'performance.wav';
  if (!scoreFile) { process.stderr.write('usage: keyboard-synth.js --score score.json --out file.wav [--target -16] | --keymap [--key D --scale dorian]\n'); process.exit(2); }
  const score = JSON.parse(fs.readFileSync(scoreFile, 'utf8'));
  const { mix, seconds, log } = render(score);
  const raw = `${out}.raw.wav`;
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeWavF32(raw, mix);
  const ext = path.extname(out).slice(1).toLowerCase();
  const codec = { mp3: ['-c:a', 'libmp3lame', '-q:a', '0'], flac: ['-c:a', 'flac'], ogg: ['-c:a', 'libvorbis', '-q:a', '6'], m4a: ['-c:a', 'aac', '-b:a', '256k'] }[ext] || ['-c:a', 'pcm_s24le'];
  const target = Number(get('target') ?? -16);
  const r = spawnSync(FF, ['-hide_banner', '-nostdin', '-y', '-i', raw, '-af',
    `aecho=0.8:0.75:73|127|211|347:0.32|0.24|0.18|0.12,acompressor=threshold=0.2:ratio=2:attack=30:release=300,loudnorm=I=${target}:TP=-1.5:LRA=14,aresample=${SR}`,
    ...codec, out], { encoding: 'utf8' });
  fs.rmSync(raw, { force: true });
  if (r.status !== 0) { process.stderr.write(r.stderr.split('\n').slice(-4).join('\n')); process.exit(1); }
  process.stdout.write(`${out}  (${seconds.toFixed(1)} s)\n${log.filter(l => !/bar \d+:/.test(l)).join('\n')}\n`);
}

if (require.main === module) { main(); }
module.exports = { keyToMidi, keymapText, render, NOTE, SCALES };
