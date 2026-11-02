// mlx-audio integration + voice cloning against a mock `mlx_audio.server` (API shape of mlx-audio 0.6.3) and real ffmpeg.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const { MlxAudioClient, StudioManager, normalizeTranscript, baseUrl } = require('../out/core/mlxAudio');
const VC = require('../out/core/voiceClone');
const T = require('../out/core/transcribe');

const FF = process.env.FFMPEG || 'ffmpeg';
const FP = process.env.FFPROBE || 'ffprobe';
const BIN = path.join(__dirname, 'fixtures', 'bin');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundlab-mlx-'));
const p = (n) => path.join(dir, n);
const reqLog = p('requests.log');
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => r(port)); }); });
const reqs = () => fs.existsSync(reqLog) ? fs.readFileSync(reqLog, 'utf8').trim().split('\n').map(JSON.parse) : [];
const dur = (f) => parseFloat(execFileSync(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
const ff = (args) => execFileSync(FF, ['-hide_banner', '-v', 'error', '-y', ...args]);
const meanDb = (f, ss, t) => parseFloat(/mean_volume: (-?[\d.]+)/.exec(require('child_process').spawnSync(FF, ['-hide_banner', '-ss', String(ss), '-t', String(t), '-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr)?.[1] ?? '-99');

let server, port, client;
test.before(async () => {
  port = await freePort();
  server = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'mock-mlx-audio.js'), String(port)], { env: { ...process.env, MOCK_MLX_LOG: reqLog }, stdio: 'ignore' });
  client = new MlxAudioClient({ mode: 'external', port, image: 'x', python: 'python3', hfCache: p('hf'), logDir: p('logs'), voicesDir: p('voices') });
  await client.waitReady(15000);
});
test.after(() => { server?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('client: health, models load/unload, voices, speech, transcribe, separate', async () => {
  const h = await client.health();
  assert.equal(h.reachable, true);
  assert.equal(baseUrl({ url: 'http://x:9/v1/', port: 1 }), 'http://x:9');
  await client.loadModel('mlx-community/Kokoro-82M-bf16');
  assert.deepEqual((await client.health()).loadedModels, ['mlx-community/Kokoro-82M-bf16']);
  await client.unloadModel('mlx-community/Kokoro-82M-bf16');
  await assert.rejects(client.unloadModel('nope'), /404/);
  assert.deepEqual((await client.voices('mlx-community/Kokoro-82M-bf16')).map(v => v.id), ['af_heart', 'am_adam', 'bf_emma']);
  assert.deepEqual(await client.voices('mlx-community/chatterbox-turbo-4bit'), []);
  const wav = await client.speech('Hello there friend', { model: 'mlx-community/Kokoro-82M-bf16', voice: 'af_heart', speed: 1.2, langCode: 'a' });
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  const sp = reqs().find(r => r.path === '/v1/audio/speech');
  assert.deepEqual([sp.voice, sp.speed, sp.lang_code, sp.response_format], ['af_heart', 1.2, 'a', 'wav']);
  fs.writeFileSync(p('in.wav'), wav);
  const t = await client.transcribe(p('in.wav'), { model: 'mlx-community/whisper-tiny', language: 'en' });
  assert.equal(t.segments.length, 2);
  assert.equal(reqs().find(r => r.path === '/v1/audio/transcriptions').response_format, 'verbose_json');
  const s = await client.separate(p('in.wav'), { description: 'speech' });
  assert.equal(s.target.subarray(0, 4).toString(), 'RIFF');
  assert.equal(normalizeTranscript('{"text":"a"}\n{"text":"b"}').text, 'ab');
});

test('ref_audio is a server-side path: host path natively, /soundlab/voices/… in containers', async () => {
  fs.mkdirSync(p('voices/me'), { recursive: true });
  fs.writeFileSync(p('voices/me/reference.wav'), 'x');
  assert.equal(client.serverPath(p('voices/me/reference.wav'), 'native'), p('voices/me/reference.wav'));
  assert.equal(client.serverPath(p('voices/me/reference.wav'), 'docker'), '/soundlab/voices/me/reference.wav');
  assert.throws(() => client.serverPath('/elsewhere/ref.wav', 'podman'), /voices folder/);
  const plan = new MlxAudioClient({ ...client.cfg, mode: 'docker', image: 'ghcr.io/cloud-fronts-group/sound-lab-mlx-audio:cpu' }).plan();
  assert.ok(plan.args.join(' ').includes(`-v ${p('voices')}:/soundlab/voices:ro`));
  assert.ok(!plan.args.includes('--gpus'), 'MLX containers are CPU-only');
  await assert.rejects(client.speech('hi', { model: 'm', refAudio: '/missing/ref.wav' }), /Reference audio file not found/);
});

test('docker lifecycle via fake CLI; apple-container plan; external refuses to start', async () => {
  const p2 = await freePort();
  const c = new MlxAudioClient({ mode: 'docker', port: p2, image: 'img:cpu', python: 'python3', hfCache: p('hf'), logDir: p('logs2'), voicesDir: p('voices'), binaries: { docker: path.join(BIN, 'docker') } });
  process.env.FAKE_CONTAINER_STATE = p('fake');
  const r = await c.start({ timeoutMs: 20000 });
  assert.equal(r.started, true);
  assert.equal(r.reachable, true);
  assert.equal((await c.start()).started, false, 'already running');
  assert.equal(c.stop().stopped, true);
  const a = new MlxAudioClient({ ...c.cfg, mode: 'apple-container', binaries: { container: path.join(BIN, 'container') } }).plan();
  assert.match(a.cmd, /container$/);
  assert.deepEqual(a.args.slice(0, 4), ['run', '-d', '--rm', '--name']);
  await assert.rejects(new MlxAudioClient({ ...c.cfg, mode: 'external', port: 9 }).start(), /mode is "external"/);
});

test('native start fails fast with an install hint when mlx-audio is missing', async () => {
  const fakePy = p('fakepy.sh');
  fs.writeFileSync(fakePy, '#!/bin/sh\necho "No module named \'uvicorn\'" >&2\nexit 1\n'); fs.chmodSync(fakePy, 0o755);
  const c = new MlxAudioClient({ mode: 'native', port: await freePort(), image: '', python: fakePy, hfCache: p('hf'), logDir: p('logs3'), binaries: { 'mlx_audio.server': fakePy } });
  const t0 = Date.now();
  await assert.rejects(c.start({ timeoutMs: 30000 }), /pip install "mlx-audio\[server\]"/);
  assert.ok(Date.now() - t0 < 10000);
});

test('transcribe backend "mlx-audio" writes segments through the extension pipeline', async () => {
  ff(['-f', 'lavfi', '-i', 'sine=d=3', p('talk.wav')]);
  const segs = await T.transcribe(p('talk.wav'), 3, {
    backend: 'mlx-audio', ffmpeg: FF, ffprobe: FP, language: 'en', translate: false, prompt: '', tmpDir: p('stt'),
    whisperCpp: { exe: '', model: '', threads: 0, extraArgs: [] }, ffmpegWhisperModel: '', openai: { baseUrl: '', model: '' },
    mlx: { model: 'mlx-community/whisper-large-v3-turbo', ensure: async () => client },
  });
  assert.deepEqual(segs.map(s => s.text), ['Hello from the mock MLX server.', 'Second line.']);
});

test('voice clone: prompts, take checks, reference build, profiles', async () => {
  const prompts = VC.enrollmentPrompts('audiobook');
  assert.equal(prompts.length, 5);
  assert.match(prompts[4], /Chapter one/);
  // speech-like take: tone bursts with silence around; plus bad takes
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*180*t)*lt(mod(t,0.6),0.45)*between(t,0.5,3.2)':s=48000:d=3.6", p('take1.wav')]);
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.25*sin(2*PI*210*t)*lt(mod(t,0.5),0.4)*between(t,0.3,2.8)':s=48000:d=3", p('take2.wav')]);
  ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '3', p('silent.wav')]);
  ff(['-f', 'lavfi', '-i', "aevalsrc='1.2*sin(2*PI*200*t)':s=48000:d=3", '-c:a', 'pcm_s16le', p('clip.wav')]);
  const good = await VC.checkTake(FF, p('take1.wav'));
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.ok(Math.abs(good.leadingSilence - 0.6) < 0.05, `leading ${good.leadingSilence}`); // first burst starts at 0.6 s
  assert.match((await VC.checkTake(FF, p('silent.wav'))).warnings.join(), /No speech/);
  const clip = await VC.checkTake(FF, p('clip.wav'));
  assert.equal(clip.ok, false); assert.match(clip.warnings.join(), /Clipping/);
  await VC.buildReference(FF, [p('take1.wav'), p('take2.wav')], p('ref/reference.wav'));
  const d = dur(p('ref/reference.wav'));
  assert.ok(d > 4.5 && d < 6.2, `silence-trimmed reference ${d}`);
  const info = JSON.parse(execFileSync(FP, ['-v', 'error', '-show_streams', '-of', 'json', p('ref/reference.wav')]).toString()).streams[0];
  assert.deepEqual([info.sample_rate, info.channels, info.codec_name], ['24000', 1, 'pcm_s16le']);
  const prof = VC.saveProfile(p('voices'), { name: 'Ada Narrator', purpose: 'audiobook', reference: p('ref/reference.wav'), referenceText: prompts.join(' '), model: 'mlx-community/chatterbox-turbo-4bit', consent: { confirmed: true, statement: VC.CONSENT_STATEMENT, at: new Date().toISOString() } });
  assert.equal(prof.id, 'ada-narrator');
  const prof2 = VC.saveProfile(p('voices'), { ...prof, name: 'Ada Narrator' });
  assert.equal(prof2.id, 'ada-narrator-2');
  assert.deepEqual(VC.listProfiles(p('voices')).map(x => x.id).sort(), ['ada-narrator', 'ada-narrator-2']);
  VC.deleteProfile(p('voices'), 'ada-narrator-2');
  assert.equal(VC.listProfiles(p('voices')).length, 1);
});

test('text helpers: chunking, chapters, speakable, vocal cues', () => {
  const chunks = VC.chunkText('One. Two two. Three!\n\nNew paragraph here? Yes.', 12);
  assert.deepEqual(chunks.map(c => c.text), ['One.', 'Two two.', 'Three!', 'New', 'paragraph', 'here? Yes.']);
  assert.ok(chunks.every(c => c.text.length <= 12));
  assert.deepEqual(chunks.filter(c => c.paragraphEnd).length, 2);
  const ch = VC.splitChapters('# Intro\nHello.\n\n## The Storm\nRain fell.\n---\nUntitled tail.\nChapter 3: Dawn\nLight.');
  assert.deepEqual(ch.map(c => c.title), ['Intro', 'The Storm', 'Part 3', 'Chapter 3: Dawn']);
  assert.equal(VC.speakable('**Bold** [link](http://x) `code`\n- item\n1. step').replace(/\s+/g, ' ').trim(), 'Bold link code item step');
  const cues = VC.parseVocalCues('[0:04] Here we go\n@5 Rise up\nNo time given\n// comment', 120);
  assert.deepEqual(cues.map(c => c.at), [4, 8, cues[2].at]);
  assert.ok(cues[2].at > 8 && (cues[2].at / 2) % 1 === 0, `untimed cue lands on a bar line after the previous one: ${cues[2].at}`);
});

test('renderers: audiobook (chapters + ACX-ish master), presentation (timed + video track), vocals (beat-placed, ducked)', async () => {
  const ref = p('ref/reference.wav');
  const calls = [];
  const speak = async (text, out) => {
    calls.push(text);
    fs.writeFileSync(out, await client.speech(text, { model: 'mlx-community/chatterbox-turbo-4bit', refAudio: ref, refText: 'reference words' }));
  };
  // audiobook
  const book = await VC.renderAudiobook({ ffmpeg: FF, ffprobe: FP }, '# Chapter One\nIt was late. The letter arrived.\n\nNobody moved.\n# Chapter Two\nMorning came.', p('book'), speak);
  assert.equal(book.chapters.length, 2);
  assert.match(path.basename(book.chapters[0]), /^01 - Chapter One\.mp3$/);
  const tts = reqs().filter(r => r.path === '/v1/audio/speech' && r.ref_audio);
  assert.equal(tts.at(-1).ref_audio, ref);
  assert.equal(tts.at(-1).ref_text, 'reference words');
  const chap = JSON.parse(execFileSync(FP, ['-v', 'error', '-show_chapters', '-of', 'json', book.full]).toString()).chapters;
  assert.deepEqual(chap.map(c => c.tags.title), ['Chapter One', 'Chapter Two']);
  const stream = JSON.parse(execFileSync(FP, ['-v', 'error', '-show_streams', '-of', 'json', book.chapters[0]]).toString()).streams[0];
  assert.deepEqual([stream.codec_name, stream.sample_rate, stream.channels, stream.bit_rate], ['mp3', '44100', 1, '192000']);
  const vd = require('child_process').spawnSync(FF, ['-hide_banner', '-i', book.chapters[0], '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  assert.ok(parseFloat(/max_volume: (-?[\d.]+)/.exec(vd)[1]) <= -3, 'ACX peak ≤ −3 dB');
  assert.ok(meanDb(book.chapters[0], 0, 0.6) < -60, 'room tone at the head');
  assert.ok(!fs.existsSync(p('book/.work')), 'work files cleaned');

  // presentation from a transcript, with video
  ff(['-f', 'lavfi', '-i', 'testsrc=d=10:s=320x240:r=25', '-f', 'lavfi', '-i', 'sine=f=300:d=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p('talk.mp4')]);
  const segs = [{ start: 1, end: 3, text: 'Welcome everyone to this rather long opening remark about the project' }, { start: 2, end: 4, text: 'this line overlaps the first one' }, { start: 9, end: 10, text: 'Thanks' }];
  const pres = await VC.renderPresentation({ ffmpeg: FF, ffprobe: FP }, segs, p('pres'), speak, { video: p('talk.mp4'), baseName: 'talk', lang: 'eng' });
  assert.equal(pres.pushed, 1, 'overlapping line pushed later');
  assert.equal(pres.timeline[0].start, 1);
  assert.ok(pres.timeline[1].start >= pres.timeline[0].end);
  assert.equal(pres.timeline[2].start, 9);
  const v = JSON.parse(execFileSync(FP, ['-v', 'error', '-show_streams', '-of', 'json', pres.video]).toString()).streams;
  const aud = v.filter(s => s.codec_type === 'audio');
  assert.equal(aud.length, 2);
  assert.equal(aud[0].tags.title ?? aud[0].tags.handler_name, 'Narration (cloned voice)'); // MP4 keeps track names in handler_name
  assert.equal(aud[0].disposition.default, 1);
  assert.equal(v.find(s => s.codec_type === 'video').codec_name, 'h264');
  // untimed script
  const script = await VC.renderPresentation({ ffmpeg: FF, ffprobe: FP }, 'First slide text.\n\nSecond slide.', p('pres'), speak, { baseName: 'script' });
  assert.equal(script.timeline.length, 2);
  assert.ok(Math.abs(script.timeline[1].start - script.timeline[0].end - 0.9) < 0.01, 'paragraph pause');

  // vocals over an instrumental (120 BPM, bars of 2 s)
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.25*sin(2*PI*110*t)+0.25*sin(2*PI*165*t)':s=48000:d=12", '-ac', '2', p('inst.wav')]);
  const cues = VC.parseVocalCues('@2 Feel it\n@4 Here we go now', 120);
  const voc = await VC.renderVocals({ ffmpeg: FF, ffprobe: FP }, p('inst.wav'), cues, 120, p('vox/song.wav'), speak, { doubleVoice: true });
  assert.ok(Math.abs(dur(voc.mix) - 12) < 0.05, 'instrumental length kept');
  assert.ok(fs.existsSync(voc.stem));
  assert.ok(meanDb(voc.stem, 0, 1.8) < -50, 'stem silent before bar 2');
  assert.ok(meanDb(voc.stem, 2.05, 0.5) > -40, 'vocal starts on bar 2 (2.0 s)');
  assert.ok(calls.length >= 9);
});

test('Studio manager: locate a checkout; reachable() false when nothing listens', async () => {
  const fake = p('studio-ui'); fs.mkdirSync(path.join(fake, 'app'), { recursive: true }); fs.writeFileSync(path.join(fake, 'package.json'), '{}');
  const s = new StudioManager({ path: fake, port: await freePort(), apiBase: 'http://localhost', apiPort: port, python: 'python3', storageDir: p('store') });
  assert.equal(s.locate(), fake);
  assert.equal(await s.reachable(), false);
  const none = new StudioManager({ port: 1, apiBase: 'http://localhost', apiPort: port, python: '/nonexistent-python', storageDir: p('store2') });
  assert.equal(none.locate(), null);
});
