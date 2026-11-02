// Integration tests for the ffmpeg core against the real ffmpeg/ffprobe binaries.
// Run: npm test   (FFMPEG / FFPROBE env vars override the binaries)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { runOk, run, parseTimecode, formatTimecode, detectCapabilities } = require('../out/core/ffmpeg');
const R = require('../out/core/recipes');
const A = require('../out/core/analysis');
const { probe, summarize } = require('../out/core/probe');
const Sub = require('../out/core/subtitles');
const T = require('../out/core/transcribe');

const FF = process.env.FFMPEG || 'ffmpeg';
const FP = process.env.FFPROBE || 'ffprobe';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundlab-test-'));
const p = (n) => path.join(dir, n);
const ff = (args) => runOk({ exe: FF, args });
const info = async (f) => summarize(await probe(FP, f));
const enc = { format: 'wav', bitDepth: 24 };

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('timecode helpers', () => {
  assert.equal(parseTimecode('1:02.5'), 62.5);
  assert.equal(parseTimecode('01:00:01'), 3601);
  assert.equal(parseTimecode('12.25'), 12.25);
  assert.ok(isNaN(parseTimecode('abc')));
  assert.equal(formatTimecode(62.5), '1:02.500');
});

test('capabilities detected', async () => {
  const c = await detectCapabilities(FF, FP);
  assert.ok(c.ffmpegVersion, c.error);
  for (const f of ['loudnorm', 'silencedetect', 'showspectrumpic', 'showwavespic', 'astats']) { assert.ok(c.filters.has(f), f); }
  assert.ok(c.encoders.has('flac'));
});

test('generate every signal type', async () => {
  for (const k of ['sine', 'square', 'sawtooth', 'triangle', 'white', 'pink', 'brown', 'sweep', 'silence']) {
    const out = p(`gen_${k}.wav`);
    await ff(R.generate(out, k, 1, 440, 48000, -6, enc));
    const s = await info(out);
    assert.equal(s.sampleRate, 48000, k);
    assert.equal(s.bitDepth, 24, k);
    assert.ok(Math.abs(s.duration - 1) < 0.01, `${k} duration ${s.duration}`);
  }
});

test('stereo test file + every output format', async () => {
  await ff(['-y', '-hide_banner', '-f', 'lavfi', '-i', 'sine=f=220:d=3:sample_rate=44100', '-f', 'lavfi', '-i', 'sine=f=330:d=3:sample_rate=44100',
    '-filter_complex', '[0][1]join=inputs=2:channel_layout=stereo', '-c:a', 'pcm_s16le', p('stereo.wav')]);
  const expect = { wav: 'pcm_s24le', flac: 'flac', aiff: 'pcm_s24be', mp3: 'mp3', ogg: 'vorbis', opus: 'opus', m4a: 'aac' };
  for (const f of R.FORMATS) {
    const out = p(`conv.${f}`);
    await ff(R.convert(p('stereo.wav'), out, { format: f, bitDepth: 24, sampleRate: f === 'opus' ? 44100 : 48000, bitrate: '192k' }));
    const s = await info(out);
    assert.equal(s.codec, expect[f], f);
    assert.equal(s.channels, 2, f);
    if (f === 'flac') { assert.equal(s.bitDepth, 24); }
    if (f === 'opus') { assert.equal(s.sampleRate, 48000); } // opus rate coerced
  }
  const mono16 = p('mono16.wav');
  await ff(R.convert(p('stereo.wav'), mono16, { format: 'wav', bitDepth: 16, channels: 1, sampleRate: 22050 }));
  const m = await info(mono16);
  assert.deepEqual([m.channels, m.bitDepth, m.sampleRate], [1, 16, 22050]);
});

test('trim with fades is sample-accurate', async () => {
  const out = p('trim.wav');
  await ff(R.trim(p('stereo.wav'), out, { ...enc, start: 0.5, end: 1.75, fadeIn: 0.01, fadeOut: 0.02 }));
  const s = await info(out);
  assert.ok(Math.abs(s.duration - 1.25) < 0.002, `duration ${s.duration}`);
});

test('silence detection → segments → split', async () => {
  // tone 0.5s, silence 1s, tone 0.7s, silence 0.6s, tone 0.4s
  const parts = [['sine', 0.5], ['silence', 1], ['sine', 0.7], ['silence', 0.6], ['sine', 0.4]];
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const f = p(`part${i}.wav`); files.push(f);
    await ff(R.generate(f, parts[i][0], parts[i][1], 440, 48000, -6, enc));
  }
  await ff(R.concat(files, p('gappy.wav'), { ...enc, sampleRate: 48000 }));
  const s = await info(p('gappy.wav'));
  assert.ok(Math.abs(s.duration - 3.2) < 0.01, `concat duration ${s.duration}`);
  const r = await ff(R.silenceDetect(p('gappy.wav'), -40, 0.3));
  const sil = A.parseSilence(r.stderr, s.duration);
  assert.equal(sil.length, 2, JSON.stringify(sil));
  const segs = A.soundSegments(sil, s.duration, 0.02, 0.05);
  assert.equal(segs.length, 3);
  assert.ok(Math.abs(segs[1].start - (1.5 - 0.02)) < 0.03, JSON.stringify(segs));
  for (let i = 0; i < segs.length; i++) { await ff(R.trim(p('gappy.wav'), p(`seg${i}.wav`), { ...enc, ...segs[i] })); }
  assert.ok(Math.abs((await info(p('seg2.wav'))).duration - 0.42) < 0.03);
});

test('concat with crossfade shortens total', async () => {
  await ff(R.concat([p('gen_sine.wav'), p('gen_pink.wav'), p('gen_square.wav')], p('xfade.wav'), enc, 0.25));
  const s = await info(p('xfade.wav'));
  assert.ok(Math.abs(s.duration - 2.5) < 0.02, `xfade duration ${s.duration}`);
});

test('two-pass loudness normalization hits target', async () => {
  // 6 s of pink noise at -30 dBFS → normalise to -16 LUFS
  await ff(R.generate(p('quiet.wav'), 'pink', 6, 0, 48000, -30, enc));
  const t = { i: -16, tp: -1.5, lra: 11 };
  const m = A.parseLoudnormJson((await ff(R.loudnormAnalyze(p('quiet.wav'), t))).stderr);
  assert.ok(parseFloat(m.input_i) < -25);
  await ff(R.loudnormApply(p('quiet.wav'), p('loud.wav'), t, m, enc, 48000));
  const out = await info(p('loud.wav'));
  assert.equal(out.sampleRate, 48000, 'resampled back from 192k');
  const lv = await A.analyzeLevels(FF, p('loud.wav'), out.duration);
  assert.ok(Math.abs(lv.integratedLufs - -16) < 1, `integrated ${lv.integratedLufs}`);
  assert.ok(lv.truePeakDbtp <= -1.0, `tp ${lv.truePeakDbtp}`);
  assert.ok(Object.keys(lv.stats).length > 5, 'astats parsed');
});

test('peak normalization', async () => {
  const vd = A.parseVolumedetect((await ff(['-hide_banner', '-i', p('gen_sine.wav'), '-af', 'volumedetect', '-f', 'null', '-'])).stderr);
  assert.ok(Math.abs(vd.max - -6) < 0.2, `max ${vd.max}`);
  await ff(R.applyFilter(p('gen_sine.wav'), p('peak.wav'), R.peakNormalizeFilter(vd.max, -0.1), enc));
  const vd2 = A.parseVolumedetect((await ff(['-hide_banner', '-i', p('peak.wav'), '-af', 'volumedetect', '-f', 'null', '-'])).stderr);
  assert.ok(Math.abs(vd2.max - -0.1) < 0.15, `max after ${vd2.max}`);
});

test('every effect in the catalogue runs', async () => {
  for (const e of R.EFFECTS) {
    const params = Object.fromEntries(e.params.map(x => [x.key, String(x.default)]));
    if (e.id === 'custom') { params.expr = 'vibrato=f=6,tremolo'; }
    const chain = e.build(params, { sampleRate: 44100 });
    const out = p(`fx_${e.id}.wav`);
    try { await ff(R.applyFilter(p('stereo.wav'), out, chain, enc)); }
    catch (err) { assert.fail(`${e.id} (${chain}): ${err.message}`); }
    const s = await info(out);
    if (['speed'].includes(e.id)) { assert.ok(Math.abs(s.duration - 2) < 0.05, `speed → ${s.duration}`); }
    if (['pitch', 'reverse', 'gain', 'eq'].includes(e.id)) { assert.ok(Math.abs(s.duration - 3) < 0.05, `${e.id} keeps length → ${s.duration}`); }
    if (e.id === 'varispeed') { assert.ok(Math.abs(s.duration - 6) < 0.05, `varispeed -12st doubles length → ${s.duration}`); }
    if (e.id === 'loop') { assert.ok(Math.abs(s.duration - 12) < 0.05, `loop x3 → ${s.duration}`); }
    if (e.id === 'mono') { assert.equal(s.channels, 1); }
  }
  assert.equal(R.atempoChain(0.2), 'atempo=0.5,atempo=0.5,atempo=0.800000');
});

test('sample-accurate slicing (asegment)', async () => {
  const d = p('slices'); fs.mkdirSync(d);
  // stereo.wav = 3 s @ 44100 = 132300 samples; 128 BPM eighth notes = 10335.9375 samples (fractional!)
  const per = (60 / 128 / 2) * 44100;
  const pts = R.slicePoints(132300, per);
  assert.equal(pts.length, 12);
  assert.equal(pts[11], Math.round(12 * per)); // no cumulative drift
  const outs = Array.from({ length: pts.length + 1 }, (_, i) => path.join(d, `s_${i}.wav`));
  await ff(R.sliceAt(p('stereo.wav'), outs, pts, { format: 'wav', bitDepth: 16 }));
  let total = 0;
  for (let i = 0; i < outs.length; i++) {
    const r = await runOk({ exe: FP, args: ['-v', 'error', '-count_packets', '-show_entries', 'stream=duration_ts', '-of', 'csv=p=0', outs[i]] });
    const n = parseInt(r.stdout, 10);
    const want = (i < pts.length ? pts[i] : 132300) - (i ? pts[i - 1] : 0);
    assert.equal(n, want, `slice ${i} has ${n} samples, want ${want}`);
    total += n;
  }
  assert.equal(total, 132300);
});

test('waveform + spectrogram images, peaks', async () => {
  await ff(R.waveformPng(p('stereo.wav'), p('w.png'), 800, 200));
  await ff(R.spectrogramPng(p('gen_sweep.wav'), p('s.png'), 800, 300));
  assert.ok(fs.statSync(p('w.png')).size > 1000);
  assert.ok(fs.statSync(p('s.png')).size > 1000);
  const pk = await A.extractPeaks(FF, p('gen_sine.wav'), 1, 200);
  assert.ok(Math.abs(pk.data.length / 2 - 200) <= 2, `buckets ${pk.data.length / 2}`);
  const maxv = Math.max(...pk.data);
  assert.ok(Math.abs(maxv - 0.5) < 0.02, `peak ${maxv}`); // -6 dBFS ≈ 0.501
  assert.ok(Math.abs(pk.rms - 0.354) < 0.01, `rms ${pk.rms}`);
});

test('preview transcode + whisper wav prep', async () => {
  await ff(R.previewTranscode(p('conv.m4a'), p('prev.flac')));
  assert.equal((await info(p('prev.flac'))).codec, 'flac');
  await ff(R.toWhisperWav(p('stereo.wav'), p('w16.wav')));
  const s = await info(p('w16.wav'));
  assert.deepEqual([s.sampleRate, s.channels, s.codec], [16000, 1, 'pcm_s16le']);
});

test('video: extract audio (copy + encode) and mux subtitles', async () => {
  await ff(['-y', '-hide_banner', '-f', 'lavfi', '-i', 'testsrc=d=2:s=160x120:r=10', '-f', 'lavfi', '-i', 'sine=d=2',
    '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', p('clip.mp4')]);
  await ff(R.extractAudio(p('clip.mp4'), p('clip_audio.m4a'), 'copy'));
  assert.equal((await info(p('clip_audio.m4a'))).codec, 'aac');
  assert.equal((await info(p('clip_audio.m4a'))).hasVideo, false);
  await ff(R.extractAudio(p('clip.mp4'), p('clip_audio.wav'), enc));
  assert.equal((await info(p('clip_audio.wav'))).codec, 'pcm_s24le');
  fs.writeFileSync(p('clip.srt'), Sub.toSrt([{ start: 0, end: 1, text: 'Hello' }, { start: 1, end: 2, text: 'World' }]));
  await ff(R.muxSubtitles(p('clip.mp4'), p('clip.srt'), p('clip_subs.mp4'), 'eng'));
  const pr = await probe(FP, p('clip_subs.mp4'));
  const sub = pr.streams.find(s => s.codec_type === 'subtitle');
  assert.equal(sub?.codec_name, 'mov_text');
  assert.equal(sub?.tags?.language, 'eng');
});

test('subtitle formats round-trip', () => {
  const segs = [{ start: 0, end: 1.5, text: 'One' }, { start: 61.25, end: 3725.007, text: 'Two\nlines' }];
  assert.deepEqual(Sub.parseCues(Sub.toSrt(segs)), segs);
  assert.deepEqual(Sub.parseCues(Sub.toVtt(segs)), segs);
  assert.match(Sub.toSrt(segs), /01:02:05,007/);
  assert.match(Sub.toVtt(segs), /^WEBVTT/);
  assert.deepEqual(Sub.fromWhisperCppJson({ transcription: [{ offsets: { from: 500, to: 1500 }, text: ' hi ' }] }), [{ start: 0.5, end: 1.5, text: 'hi' }]);
  assert.deepEqual(Sub.fromOpenAiJson({ segments: [{ start: 1, end: 2, text: ' x' }] }, 600, 10), [{ start: 601, end: 602, text: 'x' }]);
  assert.deepEqual(Sub.fromOpenAiJson({ text: 'only text' }, 0, 7), [{ start: 0, end: 7, text: 'only text' }]);
});

test('filter value escaping survives a real filtergraph', async () => {
  assert.equal(T.escapeFilterValue('C:\\m'), 'C\\\\:\\\\\\\\m');
  assert.equal(T.escapeFilterValue('/plain/path.bin'), '/plain/path.bin');
  // A path full of filtergraph metacharacters, used as a filter option value.
  const weird = p("we:ird [dir], it's;here");
  fs.mkdirSync(weird);
  const target = path.join(weird, 'meta.txt');
  await ff(['-hide_banner', '-i', p('gen_sine.wav'), '-af', `astats=metadata=1:reset=0,ametadata=mode=print:file=${T.escapeFilterValue(target)}`, '-f', 'null', '-']);
  assert.ok(fs.statSync(target).size > 0);
});

test('device list parsing', () => {
  const mac = `[AVFoundation indev @ 0x1] AVFoundation video devices:\n[AVFoundation indev @ 0x1] [0] FaceTime HD Camera\n[AVFoundation indev @ 0x1] AVFoundation audio devices:\n[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone\n[AVFoundation indev @ 0x1] [1] Scarlett 2i2 USB`;
  assert.deepEqual(R.parseDevices('darwin', '', mac).map(d => d.id), ['0', '1']);
  const win = `[dshow @ 0] "Integrated Webcam" (video)\n[dshow @ 0] "Microphone (Realtek Audio)" (audio)\n[dshow @ 0]   Alternative name "@device_cm_..."`;
  assert.deepEqual(R.parseDevices('win32', '', win), [{ id: 'Microphone (Realtek Audio)', label: 'Microphone (Realtek Audio)' }]);
  const lin = `Auto-detected sources for pulse:\n* alsa_input.pci-0000_00_1f.3.analog-stereo [Built-in Audio Analog Stereo]\n  alsa_output.monitor [Monitor of Built-in]`;
  assert.deepEqual(R.parseDevices('linux', '', lin).map(d => d.id), ['alsa_input.pci-0000_00_1f.3.analog-stereo', 'alsa_output.monitor']);
  assert.deepEqual(R.recordInput('darwin', '', '1'), ['-f', 'avfoundation', '-i', ':1']);
  assert.deepEqual(R.recordInput('win32', '', 'Mic'), ['-f', 'dshow', '-i', 'audio=Mic']);
});

test('recording stops gracefully on abort and leaves a valid file', async () => {
  // Use a lavfi source in place of a microphone; abort after ~1.2 s.
  const out = p('rec.wav');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1200);
  await runOk({ exe: FF, args: ['-hide_banner', '-y', '-re', '-f', 'lavfi', '-i', 'sine=f=440', ...R.codecArgs(enc), out], signal: ac.signal, gracefulStop: true });
  const s = await info(out);
  assert.ok(s.duration > 0.5 && s.duration < 3, `recorded ${s.duration}`);
});

test('transcription: OpenAI-compatible backend (mock server, chunk offsets)', async () => {
  // 12 s file with a forced 5 s chunk size isn't configurable, so use a 2-chunk long file via real CHUNK_SECONDS? Instead verify one chunk + request shape.
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = Buffer.alloc(0);
    req.on('data', c => (body = Buffer.concat([body, c])));
    req.on('end', () => {
      const text = body.toString('latin1');
      seen.push({ url: req.url, auth: req.headers.authorization, hasFlac: text.includes('fLaC'), model: /name="model"\r\n\r\n([^\r]+)/.exec(text)?.[1], fmt: /name="response_format"\r\n\r\n([^\r]+)/.exec(text)?.[1], lang: /name="language"\r\n\r\n([^\r]+)/.exec(text)?.[1] });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: 'hello world', segments: [{ start: 0.2, end: 1.1, text: ' hello' }, { start: 1.3, end: 2.0, text: ' world' }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const segs = await T.transcribe(p('stereo.wav'), 3, {
      backend: 'openai-compatible', ffmpeg: FF, ffprobe: FP, language: 'en', translate: false, prompt: '', tmpDir: p('stt'),
      whisperCpp: { exe: '', model: '', threads: 0, extraArgs: [] }, ffmpegWhisperModel: '',
      openai: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'whisper-1', apiKey: 'sk-test' },
    });
    assert.deepEqual(segs.map(s => s.text), ['hello', 'world']);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { url: '/v1/audio/transcriptions', auth: 'Bearer sk-test', hasFlac: true, model: 'whisper-1', fmt: 'verbose_json', lang: 'en' });
    assert.equal(fs.readdirSync(p('stt')).length, 0, 'temp dir cleaned');
  } finally { server.close(); }
});

test('transcription: whisper.cpp backend (fake CLI)', async () => {
  const fake = p('fake-whisper-cli.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const a = process.argv.slice(2); const of = a[a.indexOf('-of') + 1]; const f = a[a.indexOf('-f') + 1];
if (!require('fs').existsSync(f)) process.exit(3);
for (let i = 0; i <= 100; i += 50) process.stderr.write('whisper_print_progress_callback: progress = ' + i + '%\\n');
require('fs').writeFileSync(of + '.json', JSON.stringify({ args: a, transcription: [{ offsets: { from: 0, to: 1200 }, text: ' Testing one two.' }] }));
`);
  fs.chmodSync(fake, 0o755);
  fs.writeFileSync(p('model.bin'), 'x');
  const progress = [];
  const segs = await T.transcribe(p('stereo.wav'), 3, {
    backend: 'whisper.cpp', ffmpeg: FF, ffprobe: FP, language: 'de', translate: true, prompt: 'Names', tmpDir: p('stt2'),
    whisperCpp: { exe: fake, model: p('model.bin'), threads: 2, extraArgs: ['--max-len', '40'] }, ffmpegWhisperModel: '',
    openai: { baseUrl: '', model: '' },
  }, { onProgress: f => progress.push(f) });
  assert.deepEqual(segs, [{ start: 0, end: 1.2, text: 'Testing one two.' }]);
  assert.ok(progress.at(-1) >= 0.99, `progress ${progress}`);
});

test('transcription: ffmpeg-whisper backend reports missing filter clearly', async () => {
  const caps = await detectCapabilities(FF, FP);
  if (caps.filters.has('whisper')) { return; }
  await assert.rejects(T.transcribe(p('stereo.wav'), 3, {
    backend: 'ffmpeg-whisper', ffmpeg: FF, ffprobe: FP, language: 'auto', translate: false, prompt: '', tmpDir: p('stt3'),
    whisperCpp: { exe: '', model: '', threads: 0, extraArgs: [] }, ffmpegWhisperModel: '/x/model.bin', openai: { baseUrl: '', model: '' },
  }), /no "whisper" filter/);
});

test('missing executable gives a helpful error', async () => {
  await assert.rejects(run({ exe: 'definitely-not-ffmpeg-xyz', args: [] }), /Executable not found/);
});
