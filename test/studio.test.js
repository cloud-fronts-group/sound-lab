// Studio tools (Create + DJ) against real ffmpeg: theory, beats, chords, instrumentals, SFX, layering, auto-tune,
// beat grid/key detection and every DJ move. Signals are generated (lavfi or the composer itself) — no fixtures.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'out', 'core');
const T = require(path.join(ROOT, 'theory'));
const C = require(path.join(ROOT, 'composer'));
const S = require(path.join(ROOT, 'sfx'));
const A = require(path.join(ROOT, 'autotune'));
const BG = require(path.join(ROOT, 'beatgrid'));
const D = require(path.join(ROOT, 'dj'));
const IO = require(path.join(ROOT, 'audioio'));
const { runOk } = require(path.join(ROOT, 'ffmpeg'));

const FF = process.env.FFMPEG || 'ffmpeg';
const FP = process.env.FFPROBE || 'ffprobe';
const tools = { ffmpeg: FF, ffprobe: FP };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundlab-studio-'));
const f = (n) => path.join(dir, n);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function probe(file) {
  const r = await runOk({ exe: FP, args: ['-v', 'error', '-show_entries', 'stream=sample_rate,channels,duration_ts,codec_name:format=duration', '-of', 'json', file] });
  const j = JSON.parse(r.stdout); return { ...j.streams[0], duration: +j.format.duration };
}
async function loudness(file) {
  const r = await runOk({ exe: FF, args: ['-hide_banner', '-nostdin', '-i', file, '-af', 'ebur128', '-f', 'null', '-'] });
  return parseFloat(/I:\s+(-?[\d.]+) LUFS/.exec(r.stderr.slice(r.stderr.lastIndexOf('Summary')))[1]);
}
async function bandDb(file, hz, from, to) {
  const r = await runOk({ exe: FF, args: ['-hide_banner', '-nostdin', ...(from !== undefined ? ['-ss', String(from), '-t', String(to - from)] : []), '-i', file, '-af', `bandpass=f=${hz}:width_type=q:w=30,volumedetect`, '-f', 'null', '-'] });
  return parseFloat(/mean_volume:\s*(-?[\d.]+)/.exec(r.stderr)[1]);
}
async function rmsDb(file, from, to) {
  const r = await runOk({ exe: FF, args: ['-hide_banner', '-nostdin', '-ss', String(from), '-t', String(to - from), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'] });
  return parseFloat(/mean_volume:\s*(-?[\d.]+)/.exec(r.stderr)[1]);
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
async function pitchOf(file, from = 0.2, to = 1.8) {
  const { rate, channels } = await IO.decodeNative(FF, FP, file);
  const fr = A.yinTrack(channels[0], rate).filter(x => x.voiced && x.t > from && x.t < to);
  return { median: median(fr.map(x => x.hz)), min: Math.min(...fr.map(x => x.hz)), max: Math.max(...fr.map(x => x.hz)), samples: channels[0].length };
}
async function tone(file, expr, d = 2, rate = 44100) {
  await runOk({ exe: FF, args: ['-y', '-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=${rate}:d=${d}`, '-c:a', 'pcm_s16le', file] });
}
const cents = (a, b) => 1200 * Math.log2(a / b);

// ---------------------------------------------------------------- theory

test('theory: roman numerals, names, borrowed chords, relative-key presets', () => {
  assert.deepStrictEqual(['V7', 'vi', 'ii7', 'IVmaj7', 'vii°', 'bVII'].map(s => T.parseChord(s, 'C', 'major').name), ['G7', 'Am', 'Dm7', 'Fmaj7', 'Bdim', 'A#']);
  assert.deepStrictEqual(['Am7', 'F#m', 'Bbmaj7', 'Dsus4', 'C/E'].map(s => T.parseChord(s).name), ['Am7', 'F#m', 'A#maj7', 'Dsus4', 'C/E']);
  const g7 = T.parseChord('V7', 'C');
  assert.deepStrictEqual(g7.intervals.map(i => (g7.root + i) % 12), [7, 11, 2, 5]);
  assert.deepStrictEqual(T.progression('epic', 'A', 'minor').map(c => c.name), ['Am', 'F', 'C', 'G']);
  // a major preset in a minor key plays in the relative major, so it stays diatonic to A minor
  assert.deepStrictEqual(T.progression('pop', 'A', 'minor').map(c => c.name), ['C', 'G', 'Am', 'F']);
  assert.deepStrictEqual(T.splitProgression('ii7-V7-Imaj7 | vi'), ['ii7', 'V7', 'Imaj7', 'vi']);
  assert.strictEqual(T.snapMidi(60.55, T.scalePitchClasses('C', 'major')), 60);
  assert.strictEqual(T.snapMidi(61.2, T.scalePitchClasses('C', 'major')), 62);
  const v = T.voiceChord(T.parseChord('Am'), 60);
  assert.ok(v.every(m => m >= 50 && m <= 70), `voicing near middle C: ${v}`);
});

// ---------------------------------------------------------------- beats / chords / instrumental / sfx

test('beats: loop is exactly N bars, hits land on the grid, mastered near the LUFS target', async () => {
  const o = { style: 'boombap', bpm: 90, key: 'C', scale: 'minor', bars: 4, fill: true };
  const ev = C.beatEvents(o);
  const step = 60 / 90 / 4;
  const kicks = ev.filter(e => e.voice === 'kick').map(e => +(e.t / step).toFixed(3));
  assert.deepStrictEqual(kicks.slice(0, 3), [0, 7 + 0.12, 10], 'boom-bap kick steps (swing delays odd 16ths by 12 %)');
  assert.ok(ev.some(e => e.voice === 'tom'), 'fill on the last bar');
  const r = await C.renderBeats(tools, o, f('beat.wav'));
  const p = await probe(f('beat.wav'));
  assert.strictEqual(+p.duration_ts, Math.round(4 * 4 * 60 / 90 * 48000), 'sample-exact 4 bars');
  assert.strictEqual(+p.sample_rate, 48000); assert.strictEqual(+p.channels, 2);
  assert.ok(Math.abs(await loudness(f('beat.wav')) - -12) < 1.2, 'beats mastered to ≈ −12 LUFS');
  assert.match(r.detail, /Boom bap · 90 BPM · 4 bars/);
});

test('chords: a sustained A minor chord contains A, C and E', async () => {
  await C.renderChords(tools, { progression: 'Am', instrument: 'pad', rhythm: 'sustain', bpm: 120, key: 'A', scale: 'minor', bars: 2 }, f('am.wav'));
  const ev = C.chordEvents({ progression: 'Am', instrument: 'pad', rhythm: 'sustain', bpm: 120, key: 'A', scale: 'minor', bars: 2 });
  const freqs = ev[0].notes.map(T.midiToHz);
  const inChord = await Promise.all(freqs.map(hz => bandDb(f('am.wav'), hz)));
  const offChord = await Promise.all(freqs.map(hz => bandDb(f('am.wav'), hz * Math.pow(2, 1 / 12))));
  inChord.forEach((db, i) => assert.ok(db > offChord[i] + 6, `chord tone ${T.noteName(ev[0].notes[i])} (${db} dB) stands above its neighbour semitone (${offChord[i]} dB)`));
  const key = BG.detectKey(await IO.decode(FF, f('am.wav')));
  assert.ok(key.key === 'A' && key.scale === 'minor' || key.key === 'C' && key.scale === 'major', `key ≈ A minor / C major (got ${key.key} ${key.scale})`);
});

test('instrumental: every genre renders; song arrangement adds an outro; beat grid is recovered', async () => {
  for (const g of Object.keys(C.GENRES)) {
    const r = await C.renderInstrumental(tools, { genre: g, bpm: C.GENRES[g].bpm, key: 'D', scale: C.GENRES[g].scale, bars: 4 }, f(`inst-${g}.wav`));
    assert.ok(Math.abs(r.seconds - 4 * 4 * 60 / C.GENRES[g].bpm) < 1e-3, `${g} loop length`);
    assert.ok((await rmsDb(f(`inst-${g}.wav`), 0, r.seconds)) > -30, `${g} is audible`);
  }
  const song = await C.renderInstrumental(tools, { genre: 'house', bpm: 124, key: 'A', scale: 'minor', bars: 16, arrangement: 'song' }, f('house-song.wav'));
  assert.ok(song.seconds > 16 * 4 * 60 / 124 + 2, 'song keeps a ring-out tail');
  assert.ok(Math.abs(await loudness(f('house-song.wav')) - -14) < 1.2, 'instrumental ≈ −14 LUFS');
  const grid = BG.detectBeatGrid(await IO.decode(FF, f('house-song.wav')));
  assert.ok(Math.abs(grid.bpm - 124) < 0.3, `tempo detected (${grid.bpm})`);
  // song arrangement: 2 intro bars then drums; downbeats sit on bar lines
  const bar = 4 * 60 / 124;
  assert.ok(grid.downbeats.every(t => Math.abs(t / bar - Math.round(t / bar)) < 0.02), `downbeats on bar lines (first ${grid.downbeats[0]})`);
});

test('sfx: every effect renders peak-normalised; tempo effects last exactly N bars', async () => {
  for (const name of Object.keys(S.SFX)) {
    const r = await S.renderSfx(FF, name, f(`sfx-${name}.wav`), { bars: 2, bpm: 120 });
    const v = await runOk({ exe: FF, args: ['-hide_banner', '-i', r.file, '-af', 'volumedetect', '-f', 'null', '-'] });
    assert.ok(Math.abs(parseFloat(/max_volume:\s*(-?[\d.]+)/.exec(v.stderr)[1]) - -1) < 0.3, `${name} peaks at −1 dBFS`);
    if (S.SFX[name].tempo) { assert.strictEqual(+(await probe(r.file)).duration_ts, 4 * 48000, `${name}: 2 bars at 120 BPM = 4 s`); }
  }
  const up = await S.renderSfx(FF, 'impact', f('impact-up.wav'), { semitones: 5 });
  assert.ok(Math.abs(+(await probe(up.file)).duration_ts - Math.round(1.6 * 48000)) <= 1, 'pitch shift keeps the length');
});

test('layer: a part loops under a track for exactly the track length, ducked', async () => {
  await tone(f('vox.wav'), '0.5*sin(2*PI*300*t)*gte(mod(t,2),1)', 6, 48000);   // voice on 1–2, 3–4, 5–6 s
  const r = await C.layerOnto(tools, f('vox.wav'), f('beat.wav'), f('layered.wav'), { loop: true, duck: true, gainDb: -3, offset: 0.5 });
  assert.strictEqual(+(await probe(r.file)).duration_ts, 6 * 48000, 'output = target length');
  assert.ok(await rmsDb(r.file, 0, 0.45) < -60, 'offset leaves the first 0.5 s to the target only (silent there)');
  assert.ok(await rmsDb(r.file, 0.55, 0.95) > -40, 'the part plays in the gaps of the voice');
});

// ---------------------------------------------------------------- auto-tune

test('auto-tune: 450 Hz → A4 440 Hz; 270 Hz in C major → C4; glides flatten; amount 0 is a no-op', async () => {
  await tone(f('t450.wav'), '0.3*(sin(2*PI*450*t)+0.5*sin(4*PI*450*t)+0.3*sin(6*PI*450*t))');
  const r = await A.autoTune(tools, f('t450.wav'), f('t450_at.wav'), { key: 'C', scale: 'chromatic', retuneMs: 0 });
  const p = await pitchOf(f('t450_at.wav'));
  assert.ok(Math.abs(cents(p.median, 440)) < 3, `450 Hz corrected to ${p.median.toFixed(2)} Hz`);
  assert.strictEqual(p.samples, 88200, 'duration preserved to the sample');
  assert.ok(r.report.meanErrorBefore > 30 && r.report.meanErrorAfter < 2, `report: ${r.detail}`);
  const pr = await probe(f('t450_at.wav')); assert.strictEqual(+pr.sample_rate, 44100, 'source rate kept');

  await tone(f('t270.wav'), '0.3*(sin(2*PI*270*t)+0.4*sin(4*PI*270*t))');
  await A.autoTune(tools, f('t270.wav'), f('t270_at.wav'), { key: 'C', scale: 'major', retuneMs: 20 });
  assert.ok(Math.abs(cents((await pitchOf(f('t270_at.wav'))).median, 261.6256)) < 3, '270 Hz snaps to C4 in C major');

  await tone(f('glide.wav'), '0.3*sin(2*PI*(430*t+5*t*t))+0.1*sin(4*PI*(430*t+5*t*t))');
  await A.autoTune(tools, f('glide.wav'), f('glide_at.wav'), { key: 'A', scale: 'minor', retuneMs: 0 });
  const g = await pitchOf(f('glide_at.wav'));
  assert.ok(Math.abs(cents(g.min, 440)) < 5 && Math.abs(cents(g.max, 440)) < 5, `430→450 Hz glide held on A4 (${g.min.toFixed(1)}–${g.max.toFixed(1)} Hz)`);

  await A.autoTune(tools, f('t450.wav'), f('t450_0.wav'), { key: 'C', scale: 'chromatic', amount: 0 });
  const a = (await IO.decodeNative(FF, FP, f('t450.wav'))).channels[0], b = (await IO.decodeNative(FF, FP, f('t450_0.wav'))).channels[0];
  let e = 0, pw = 0; for (let i = 0; i < a.length; i++) { e += (a[i] - b[i]) ** 2; pw += a[i] ** 2; }
  assert.ok(10 * Math.log10(pw / e) > 40, `amount 0 reconstructs the input (SNR ${(10 * Math.log10(pw / e)).toFixed(1)} dB)`);
});

test('auto-tune: slow retune keeps vibrato, fast retune removes it', async () => {
  await tone(f('vib.wav'), '0.3*sin(2*PI*(440*t-(8/(2*PI*5))*cos(2*PI*5*t)))', 2);   // ±8 Hz vibrato at 5 Hz
  await A.autoTune(tools, f('vib.wav'), f('vib_fast.wav'), { key: 'A', scale: 'major', retuneMs: 0 });
  await A.autoTune(tools, f('vib.wav'), f('vib_slow.wav'), { key: 'A', scale: 'major', retuneMs: 400 });
  const fast = await pitchOf(f('vib_fast.wav')), slow = await pitchOf(f('vib_slow.wav'));
  assert.ok(fast.max - fast.min < 3, `fast retune flattens vibrato (${(fast.max - fast.min).toFixed(1)} Hz swing)`);
  assert.ok(slow.max - slow.min > 10, `slow retune keeps vibrato (${(slow.max - slow.min).toFixed(1)} Hz swing)`);
});

// ---------------------------------------------------------------- beat grid + DJ

const within = (a, b, tol) => Math.abs(a - b) <= tol;
const octaveOk = (got, want) => [want, want * 2, want / 2].some(w => within(got, w, 0.3));

test('beat grid: tempo (± half/double time), phase and downbeats on generated tracks; BPM hint is exact', async () => {
  for (const [g, bpm] of [['house', 124], ['trap', 140], ['rnb', 88], ['pop', 108], ['lofi', 80], ['dnb', 172]]) {
    const file = f(`grid-${g}.wav`);
    await C.renderInstrumental(tools, { genre: g, bpm, key: 'A', scale: 'minor', bars: 16 }, file);
    const buf = await IO.decode(FF, file);
    const grid = BG.detectBeatGrid(buf);
    assert.ok(octaveOk(grid.bpm, bpm), `${g}: ${grid.bpm} BPM ≈ ${bpm} (or ×2 / ÷2)`);
    const hinted = BG.detectBeatGrid(buf, bpm);
    assert.ok(within(hinted.bpm, bpm, 0.05), `${g}: hint ${bpm} → ${hinted.bpm}`);
    assert.ok(hinted.beats.every(t => within(t / hinted.period, Math.round(t / hinted.period), 0.04)), `${g}: beats on the grid`);
  }
});

let house, pop;
test('DJ: backspin, echo out and beat jump land on the beat with the right lengths', async () => {
  await C.renderInstrumental(tools, { genre: 'house', bpm: 124, key: 'A', scale: 'minor', bars: 16 }, f('dj-house.wav'));
  house = await D.analyse(tools, f('dj-house.wav'));
  const g = house.grid; const beat = 60 / 124;
  assert.ok(within(g.bpm, 124, 0.05));

  const bs = D.backspin(house, { at: 10 });
  assert.ok(within(bs.at / beat, Math.round(bs.at / beat), 1e-6), 'backspin snaps to a beat');
  assert.ok(within(bs.buf.length / 48000, bs.at + 2 * beat + 0.3, 0.002), 'cut + 2-beat spin + 0.3 s');
  await D.saveEdit(tools, bs.buf, f('bs.wav'));
  assert.ok(await rmsDb(f('bs.wav'), bs.at + 0.1, bs.at + 0.5) > -35, 'spin is audible');
  assert.ok(await rmsDb(f('bs.wav'), bs.buf.length / 48000 - 0.25, bs.buf.length / 48000) < -80, 'then silence');

  const eo = D.echoOut(house, { at: 15.5 });
  assert.ok(within(eo.at, 4 * 4 * beat * 2, 1e-6), `echo out on the bar line (${eo.at})`);
  await D.saveEdit(tools, eo.buf, f('eo.wav'));
  const tail = eo.at + 4 * 4 * beat;
  assert.ok(within(eo.buf.length / 48000, tail, 0.001), '4-bar tail');
  const e1 = await rmsDb(f('eo.wav'), eo.at + 0.1, eo.at + 1.5), e2 = await rmsDb(f('eo.wav'), tail - 1.5, tail - 0.1);
  assert.ok(e1 > -40 && e2 < e1 - 10, `echoes decay (${e1} → ${e2} dB)`);

  const bj = D.beatJump(house, { at: 7.8, beats: 8 });
  assert.ok(within(bj.buf.length / 48000, g.duration - 8 * beat, 0.001), 'jump +8 beats shortens by 8 beats');
  const back = D.beatJump(house, { at: 7.8, beats: -4 });
  assert.ok(within(back.buf.length / 48000, g.duration + 4 * beat, 0.001), 'jump −4 beats repeats 4 beats');
});

test('DJ: quick mix and long blend tempo-match and phase-align B', async () => {
  await C.renderInstrumental(tools, { genre: 'pop', bpm: 108, key: 'C', scale: 'major', bars: 16 }, f('dj-pop.wav'));
  pop = await D.analyseMatched(tools, f('dj-pop.wav'), house.grid.bpm);
  assert.ok(within(pop.ratio, 124 / 108, 0.002), `stretch ratio ${pop.ratio}`);
  const re = BG.detectBeatGrid(pop.buf, 124);
  assert.ok(within(re.bpm, 124, 0.1), `B now runs at ${re.bpm} BPM`);
  const q = D.transition(house, pop, { style: 'quick', at: 15.5 });
  const bar = 4 * 60 / 124;
  assert.ok(within(q.end - q.at, bar, 1e-6), 'quick mix = 1 bar');
  assert.ok(within(q.buf.length / 48000, q.at + pop.grid.duration - pop.grid.downbeats[0], 0.01), 'B plays out after the mix');
  await D.saveEdit(tools, q.buf, f('quick.wav'));
  // after the mix point only B is left: B's beat grid continues A's
  const after = BG.detectBeatGrid(await IO.decode(FF, f('quick.wav')), 124);
  assert.ok(after.beats.some(t => within(t, q.at, 0.012)), 'the mixed result keeps one continuous beat grid through the transition');
  const l = D.transition(house, pop, { style: 'long', at: 0, bars: 8 });
  assert.ok(within(l.end - l.at, 8 * bar, 1e-6), 'long blend = 8 bars');
});

test('DJ: double drop aligns both drops on one downbeat', async () => {
  // build "break 8 bars → drop 8 bars" tracks from the composer: chords only, then the full instrumental
  async function dropTrack(name, genre, bpm, key) {
    await C.renderChords(tools, { progression: 'epic', instrument: 'pad', rhythm: 'sustain', bpm, key, scale: 'minor', bars: 8 }, f(`${name}-break.wav`), { lufs: -26 });
    await C.renderInstrumental(tools, { genre, bpm, key, scale: 'minor', bars: 8 }, f(`${name}-drop.wav`));
    await runOk({ exe: FF, args: ['-y', '-v', 'error', '-i', f(`${name}-break.wav`), '-i', f(`${name}-drop.wav`), '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1', '-c:a', 'pcm_s24le', f(`${name}.wav`)] });
    return 8 * 4 * 60 / bpm;
  }
  const dA = await dropTrack('ddA', 'house', 124, 'A');
  const dB = await dropTrack('ddB', 'trap', 128, 'A');
  const a = await D.analyse(tools, f('ddA.wav'), { bpm: 124 });
  const b = await D.analyseMatched(tools, f('ddB.wav'), 124, { bpm: 128 });
  assert.ok(within(BG.detectDrop(a.buf, a.grid), dA, 0.03), `A's drop found at ${BG.detectDrop(a.buf, a.grid).toFixed(3)} (expected ${dA.toFixed(3)})`);
  const r = D.doubleDrop(a, b);
  assert.ok(within(r.dropA, dA, 0.03), 'drop A');
  assert.ok(within(r.dropB, dB * 128 / 124, 0.03), `drop B (stretched) at ${r.dropB.toFixed(3)}`);
  await D.saveEdit(tools, r.buf, f('dd.wav'));
  // energy jumps at the shared drop
  assert.ok(await rmsDb(f('dd.wav'), r.dropA + 0.2, r.dropA + 3) > await rmsDb(f('dd.wav'), r.dropA - 3, r.dropA - 0.2) + 3, 'both drops hit together');
});

test('DJ: acapella / instrumental by center extraction; mashup keeps the vocal on the beat', async () => {
  await runOk({ exe: FF, args: ['-y', '-v', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*440*t)*(1+0.3*sin(2*PI*5*t))+0.3*(2*mod(330*t,1)-1)|0.3*sin(2*PI*440*t)*(1+0.3*sin(2*PI*5*t))+0.2*sgn(sin(2*PI*554*t))':s=48000:d=4", f('mix.wav')] });
  const sp = D.centerSplit(await IO.decode(FF, f('mix.wav')));
  await D.saveEdit(tools, sp.acapella, f('acap.wav')); await D.saveEdit(tools, sp.instrumental, f('inst.wav'));
  const [v1, l1, r1] = await Promise.all([440, 330, 554].map(hz => bandDb(f('acap.wav'), hz)));
  const [v2, l2, r2] = await Promise.all([440, 330, 554].map(hz => bandDb(f('inst.wav'), hz)));
  assert.ok(v1 - Math.max(l1, r1) > 18, `acapella keeps the centered voice (${v1} vs ${l1}/${r1} dB)`);
  assert.ok(Math.min(l2, r2) - v2 > 15, `instrumental drops it (${v2} vs ${l2}/${r2} dB)`);
  const { Stereo } = require(path.join(ROOT, 'synth'));
  assert.throws(() => D.centerSplit(new Stereo(48000)), /mono/);

  // mashup: a "vocal" that blips on each of its own downbeats, over a silent bed, offset by one bar →
  // the first blip must land exactly one bar after the instrumental's first downbeat
  const bar = 4 * 60 / 124;
  const vbuf = new Stereo(house.buf.length);
  for (const t of house.grid.downbeats) { const i = Math.round(t * 48000); for (let k = 0; k < 200; k++) { vbuf.L[i + k] = vbuf.R[i + k] = 0.5; } }
  const vocals = { ...house, buf: vbuf, file: 'vocals.wav' };
  const bed = { ...pop, buf: new Stereo(pop.buf.length) };
  const m = D.mashup(vocals, bed, { offsetBars: 1 });
  const first = m.buf.L.findIndex(x => x > 0.25) / 48000;
  assert.ok(within(first, pop.grid.downbeats[0] + bar, 0.002), `vocal enters on the instrumental's bar 2 (${first.toFixed(4)} s)`);
  assert.ok(m.buf.length / 48000 >= pop.grid.duration, 'mashup spans the instrumental');
  assert.match(m.detail, /\+1 bars/);
});

test('key shift: smallest move between keys (relative major/minor are equal)', () => {
  const k = (key, scale) => ({ key, scale, confidence: 1, camelot: '' });
  assert.strictEqual(BG.keyShift(k('A', 'minor'), k('C', 'major')), 0);
  assert.strictEqual(BG.keyShift(k('C', 'major'), k('D', 'major')), 2);
  assert.strictEqual(BG.keyShift(k('C', 'major'), k('A#', 'major')), -2);
});
