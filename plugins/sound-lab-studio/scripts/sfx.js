#!/usr/bin/env node
'use strict';
// Procedural sound-effect generator built on ffmpeg lavfi synthesis. Every effect is mono 48 kHz,
// click-free (micro fades), peak-normalised, with optional pitch/time variations for games.
//
//   sfx.js list
//   sfx.js make whoosh --duration 1.2 --out ./sfx/whoosh.wav
//   sfx.js make impact --variations 5 --spread 3 --seed 7 --out ./sfx/impact.ogg   → impact_01.ogg … impact_05.ogg
//   sfx.js pack --out ./sfx-pack --format ogg [--names whoosh,impact,coin]           → one of each (+ variations)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FF = process.env.SOUND_LAB_FFMPEG || 'ffmpeg';
const SR = 48000;

/** Each recipe: default duration and a builder returning {src: lavfi source graph, fx: filter chain}. */
const RECIPES = {
  whoosh: { d: 1.2, desc: 'Air whoosh: band-passed pink noise with a swelling envelope and phaser',
    build: d => ({ src: `anoisesrc=color=pink:amplitude=0.9:sample_rate=${SR}:duration=${d}`, fx: `bandpass=f=900:width_type=o:w=2,aphaser=in_gain=0.6:out_gain=0.9:delay=2:decay=0.5:speed=${(1.5 / d).toFixed(2)},volume='pow(sin(PI*t/${d}),3)':eval=frame` }) },
  riser: { d: 3, desc: 'Tension riser: upward sine glide + rising noise wash',
    build: d => ({ src: `aevalsrc='0.35*sin(2*PI*(150*t+(1850/(2*${d}))*t*t))*(t/${d})+0.25*(random(0)*2-1)*pow(t/${d},2)':s=${SR}:d=${d}`, fx: 'highpass=f=120,aecho=0.8:0.6:60|120:0.3|0.2' }) },
  impact: { d: 1.6, desc: 'Cinematic impact: pitched-down sub thump + noise crack + short tail',
    build: d => ({ src: `aevalsrc='0.95*sin(2*PI*(70*t-18*t*t))*exp(-3.2*t)+0.6*(random(0)*2-1)*exp(-35*t)':s=${SR}:d=${d}`, fx: 'lowpass=f=5000,acompressor=threshold=0.3:ratio=4:attack=1:release=80,aecho=0.7:0.5:45|90:0.3|0.15' }) },
  laser: { d: 0.45, desc: 'Sci-fi zap: fast exponential downward chirp',
    build: d => ({ src: `aevalsrc='0.7*sin(2*PI*(2600/14)*(1-exp(-14*t)))*exp(-6*t)':s=${SR}:d=${d}`, fx: 'aecho=0.6:0.4:25:0.3' }) },
  'ui-click': { d: 0.06, desc: 'Crisp UI click',
    build: d => ({ src: `aevalsrc='0.9*sin(2*PI*2400*t)*exp(-140*t)+0.3*sin(2*PI*5200*t)*exp(-260*t)':s=${SR}:d=${d}`, fx: 'highpass=f=300' }) },
  'ui-confirm': { d: 0.35, desc: 'Two-note UI confirm (rising fifth, soft sine)',
    build: d => ({ src: `aevalsrc='0.5*sin(2*PI*if(lt(t,0.09),660,990)*t)*exp(-7*t)':s=${SR}:d=${d}`, fx: 'lowpass=f=6000' }) },
  coin: { d: 0.45, desc: 'Arcade coin pickup (square B5→E6)',
    build: d => ({ src: `aevalsrc='0.35*sgn(sin(2*PI*if(lt(t,0.08),988,1319)*t))*exp(-5*t)':s=${SR}:d=${d}`, fx: 'lowpass=f=9000' }) },
  explosion: { d: 3, desc: 'Explosion: low brown-noise burst with sub drop and rumble tail',
    build: d => ({ src: `aevalsrc='(0.9*(random(0)*2-1)*exp(-2.2*t)+0.8*sin(2*PI*(50*t-6*t*t))*exp(-2*t))':s=${SR}:d=${d}`, fx: 'lowpass=f=900,lowpass=f=1400,acompressor=threshold=0.25:ratio=6:attack=2:release=200,aecho=0.8:0.6:70|160:0.35|0.25' }) },
  wind: { d: 6, desc: 'Gusty wind bed (loops well when cross-faded)',
    build: d => ({ src: `anoisesrc=color=brown:amplitude=0.8:sample_rate=${SR}:duration=${d}`, fx: "lowpass=f=1100,highpass=f=80,volume='0.55+0.45*sin(2*PI*0.23*t)*sin(2*PI*0.07*t+1)':eval=frame" }) },
  rain: { d: 6, desc: 'Steady rain bed',
    build: d => ({ src: `anoisesrc=color=pink:amplitude=0.5:sample_rate=${SR}:duration=${d}`, fx: 'highpass=f=500,lowpass=f=9000,aecho=0.6:0.5:12|31:0.3|0.2' }) },
  heartbeat: { d: 3.4, desc: 'Lub-dub heartbeat at ~70 BPM',
    build: d => ({ src: `aevalsrc='0.9*sin(2*PI*48*t)*(exp(-22*mod(t,0.85))+0.75*gte(mod(t,0.85),0.22)*exp(-22*(mod(t,0.85)-0.22)))':s=${SR}:d=${d}`, fx: 'lowpass=f=160' }) },
  'power-down': { d: 1.8, desc: 'Machine power-down: falling sine with fading harmonics',
    build: d => ({ src: `aevalsrc='0.5*(sin(2*PI*(820*t-380*t*t/${d}))+0.3*sin(4*PI*(820*t-380*t*t/${d})))*(1-t/${d})':s=${SR}:d=${d}`, fx: 'lowpass=f=4000' }) },
  alarm: { d: 2, desc: 'Two-tone alarm (880/660 Hz, 4 Hz alternation)',
    build: d => ({ src: `aevalsrc='0.35*sgn(sin(2*PI*if(lt(mod(t,0.5),0.25),880,660)*t))':s=${SR}:d=${d}`, fx: 'lowpass=f=5000' }) },
};

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]; } else { o._.push(argv[i]); }
  }
  return o;
}

/** Deterministic PRNG so variations are reproducible with --seed. */
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function codec(out) {
  const ext = path.extname(out).slice(1).toLowerCase();
  return { wav: ['-c:a', 'pcm_s24le'], ogg: ['-c:a', 'libvorbis', '-q:a', '6'], mp3: ['-c:a', 'libmp3lame', '-q:a', '2'], m4a: ['-c:a', 'aac', '-b:a', '192k'], flac: ['-c:a', 'flac'], caf: ['-c:a', 'pcm_s24le'], opus: ['-c:a', 'libopus', '-b:a', '96k'] }[ext] || ['-c:a', 'pcm_s24le'];
}

function ff(args) {
  const r = spawnSync(FF, ['-hide_banner', '-nostdin', ...args], { encoding: 'utf8' });
  if (r.status !== 0) { throw new Error(`ffmpeg failed: ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`); }
  return r.stderr;
}

/** Render one effect. semitones shifts pitch (and length, tape-style); peakDb normalises. */
function render(name, out, { duration, semitones = 0, peakDb = -1 } = {}) {
  const rec = RECIPES[name];
  if (!rec) { throw new Error(`Unknown effect "${name}". Try: ${Object.keys(RECIPES).join(', ')}`); }
  const d = +(duration || rec.d);
  const { src, fx } = rec.build(d);
  const rate = Math.round(SR * Math.pow(2, semitones / 12));
  const fadeOut = Math.min(0.08, d * 0.15);
  const chain = [fx, semitones ? `asetrate=${rate},aresample=${SR}` : null, 'highpass=f=20', `afade=t=in:st=0:d=0.003`, `areverse,afade=t=in:st=0:d=${fadeOut.toFixed(3)},areverse`, 'aformat=channel_layouts=mono'].filter(Boolean).join(',');
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const tmp = `${out}.tmp.wav`;
  ff(['-y', '-f', 'lavfi', '-i', src, '-af', chain, '-c:a', 'pcm_f32le', tmp]);
  const max = parseFloat(/max_volume:\s*(-?[\d.]+)/.exec(ff(['-i', tmp, '-af', 'volumedetect', '-f', 'null', '-']))?.[1] ?? '0');
  ff(['-y', '-i', tmp, '-af', `volume=${(peakDb - max).toFixed(2)}dB`, ...codec(out), '-ar', String(SR), out]);
  fs.rmSync(tmp, { force: true });
  return out;
}

function make(name, o) {
  const out = o.out || `${name}.${o.format || 'wav'}`;
  const n = Math.max(1, parseInt(o.variations || '1', 10));
  if (n === 1) { return [render(name, out, { duration: o.duration, semitones: +(o.pitch || 0), peakDb: +(o.peak || -1) })]; }
  const rnd = mulberry32(parseInt(o.seed || '1', 10));
  const spread = +(o.spread || 2);
  const { dir, name: base, ext } = path.parse(out);
  return Array.from({ length: n }, (_, i) => {
    const semis = +(o.pitch || 0) + (rnd() * 2 - 1) * spread;
    const dur = o.duration ? +o.duration * (0.9 + rnd() * 0.2) : undefined;
    return render(name, path.join(dir, `${base}_${String(i + 1).padStart(2, '0')}${ext}`), { duration: dur, semitones: semis, peakDb: +(o.peak || -1) });
  });
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const [cmd, name] = o._;
  try {
    if (cmd === 'list') {
      for (const [k, r] of Object.entries(RECIPES)) { process.stdout.write(`${k.padEnd(12)} ${String(r.d).padStart(4)} s  ${r.desc}\n`); }
    } else if (cmd === 'make') {
      if (!name) { throw new Error('usage: sfx.js make <effect> [--out file] [--duration s] [--pitch semitones] [--variations n --spread semis --seed n] [--peak dBFS]'); }
      make(name, o).forEach(f => process.stdout.write(`${f}\n`));
    } else if (cmd === 'pack') {
      const dir = o.out || 'sfx-pack';
      const names = o.names ? String(o.names).split(',') : Object.keys(RECIPES);
      for (const n of names) { make(n, { ...o, out: path.join(dir, `${n}.${o.format || 'wav'}`) }).forEach(f => process.stdout.write(`${f}\n`)); }
    } else {
      throw new Error('usage: sfx.js list | make <effect> … | pack --out dir [--format ogg] [--names a,b] [--variations n]');
    }
  } catch (e) { process.stderr.write(`sfx.js: ${e.message}\n`); process.exit(2); }
}

process.stdout.on('error', e => { if (e.code === 'EPIPE') { process.exit(0); } throw e; });
if (require.main === module) { main(); }
module.exports = { RECIPES, render };
