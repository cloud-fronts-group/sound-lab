'use strict';
// MLX audio service integration: lifecycle per mode (docker / podman / apple-container / external / native),
// transcription, TTS and separation through the MCP tools against an mlx-audio-compatible server.
// The fake container CLIs start tests/fixtures/mock-mlx-audio.js (API shape of mlx-audio 0.6.x `mlx_audio.server`).
// Optional real checks:
//   SOUND_LAB_TEST_MLX_URL=http://127.0.0.1:8000   → transcribe/TTS against a real running mlx-audio server
//   SOUND_LAB_TEST_CUDA_PYTHON=/path/venv/bin/python → native start with mlx[cuda12]; on a GPU-less host it must fail fast with the CUDA hint
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { McpClient, tmpdir, tone, info, FIX_BIN } = require('./helpers');
const { normalizeTranscript } = require('../mcp/lib/mlx');

const work = tmpdir('slmlx-');
const state = path.join(work, 'containers');
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const calls = () => fs.readFileSync(path.join(state, 'calls.log'), 'utf8').trim().split('\n').map(JSON.parse);
const reqLog = () => fs.readFileSync(path.join(work, 'mlx-requests.log'), 'utf8').trim().split('\n').map(JSON.parse);

async function client(mode, extra = {}) {
  const port = await freePort();
  const c = new McpClient({
    SOUND_LAB_DATA: path.join(work, `data-${mode}`), SOUND_LAB_MLX_MODE: mode, SOUND_LAB_MLX_PORT: String(port), SOUND_LAB_MLX_AUTOSTART: 'true',
    SOUND_LAB_DOCKER: path.join(FIX_BIN, 'docker'), SOUND_LAB_PODMAN: path.join(FIX_BIN, 'podman'), SOUND_LAB_APPLE_CONTAINER: path.join(FIX_BIN, 'container'),
    SOUND_LAB_HF_CACHE: path.join(work, 'hf'), FAKE_CONTAINER_STATE: state, MOCK_MLX_LOG: path.join(work, 'mlx-requests.log'), ...extra,
  });
  await c.init();
  return { c, port };
}

test.after(() => fs.rmSync(work, { recursive: true, force: true }));

test('normalizeTranscript handles verbose_json, json and ndjson bodies', () => {
  assert.deepEqual(normalizeTranscript(JSON.stringify({ text: ' a b', language: 'en', segments: [{ start: 0, end: 1, text: ' a' }, { start: 1, end: 2, text: ' b' }] })),
    { text: 'a b', language: 'en', segments: [{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'b' }] });
  assert.deepEqual(normalizeTranscript('{"text":"only"}'), { text: 'only', language: undefined, segments: [] });
  const nd = '{"text":"Hel"}\n{"text":"lo"}\n';
  assert.equal(normalizeTranscript(nd).text, 'Hello');
  assert.deepEqual(normalizeTranscript(JSON.stringify({ text: 'x', chunks: [{ timestamp: [0.5, 1.5], text: 'x' }] })).segments, [{ start: 0.5, end: 1.5, text: 'x' }]);
});

test('docker mode: start → plan uses mlx[cuda12] image with --gpus, transcribe/TTS/separate, stop', async () => {
  const { c, port } = await client('docker', { SOUND_LAB_MLX_GPU: 'nvidia' });
  const plan = await c.call('mlx_service', { action: 'plan' });
  assert.match(plan.command, /run -d --rm --name soundlab-mlx-audio -p 127\.0\.0\.1:\d+:8000 -v .*:\/root\/\.cache\/huggingface --gpus all ghcr\.io\/cloud-fronts-group\/sound-lab-mlx-audio:cuda12$/);
  assert.equal((await c.call('mlx_service', { action: 'status' })).reachable, false);
  const started = await c.call('mlx_service', { action: 'start' });
  assert.equal(started.reachable, true);
  assert.equal(started.url, `http://127.0.0.1:${port}`);

  const audio = tone(path.join(work, 'speech.wav'), 3, 300);
  const t = await c.call('transcribe', { inputs: [audio], backend: 'mlx-service', language: 'en', model: 'mlx-community/whisper-tiny', formats: ['srt', 'vtt', 'txt', 'json'], output_dir: path.join(work, 'tx') });
  const td = await c.call('wait_job', { job_id: t.job_id, timeout_s: 60 });
  assert.equal(td.status, 'done', JSON.stringify(td.items));
  assert.equal(td.items[0].result.backend, 'mlx-service');
  assert.equal(td.items[0].result.segments, 2);
  const srt = fs.readFileSync(path.join(work, 'tx', 'speech.srt'), 'utf8');
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,400\nHello from the mock MLX server\.\n/);
  assert.match(fs.readFileSync(path.join(work, 'tx', 'speech.vtt'), 'utf8'), /^WEBVTT/);
  const sttReq = reqLog().find(r => r.path === '/v1/audio/transcriptions');
  assert.equal(sttReq.response_format, 'verbose_json');
  assert.equal(sttReq.model, 'mlx-community/whisper-tiny');
  assert.equal(sttReq.language, 'en');
  assert.ok(sttReq.file.riff, 'uploads 16 kHz WAV');

  const s = await c.call('synthesize_speech', { text: 'Welcome to Sound Lab radio.', output: path.join(work, 'vo', 'intro.wav'), voice: 'bm_george', speed: 1.1, lang_code: 'b' });
  const sd = await c.call('wait_job', { job_id: s.job_id, timeout_s: 60 });
  assert.equal(sd.status, 'done', JSON.stringify(sd.items));
  assert.ok(info(path.join(work, 'vo', 'intro.wav')).duration > 0.5);
  const ttsReq = reqLog().find(r => r.path === '/v1/audio/speech');
  assert.deepEqual([ttsReq.model, ttsReq.voice, ttsReq.speed, ttsReq.lang_code, ttsReq.response_format], ['mlx-community/Kokoro-82M-bf16', 'bm_george', 1.1, 'b', 'wav']);

  const sep = await c.call('separate_audio', { input: audio, description: 'speech' });
  const sepd = await c.call('wait_job', { job_id: sep.job_id, timeout_s: 60 });
  assert.equal(sepd.status, 'done');
  assert.ok(info(sep.target).duration > 0 && info(sep.residual).duration > 0);

  const models = await c.call('mlx_service', { action: 'models', load_model: 'mlx-community/parakeet-tdt-0.6b-v2' });
  assert.equal(models.status, 200);
  assert.ok((await c.call('mlx_service', { action: 'status' })).loadedModels.includes('mlx-community/parakeet-tdt-0.6b-v2'));
  const caps = await c.call('capabilities');
  assert.match(caps.speechToText.backends['mlx-service'], /ready/);
  await c.call('mlx_service', { action: 'stop' });
  assert.equal((await c.call('mlx_service', { action: 'status' })).reachable, false);
  await c.close();
});

test('podman and apple-container modes use their CLIs; transcribe auto-starts the service', async () => {
  const { c: p } = await client('podman', { SOUND_LAB_MLX_GPU: 'nvidia' });
  assert.match((await p.call('mlx_service', { action: 'plan' })).command, /podman run .* --device nvidia\.com\/gpu=all .*:cuda12$/);
  await p.close();

  const { c } = await client('apple-container');
  assert.match((await c.call('mlx_service', { action: 'plan' })).command, /container run -d --rm --name soundlab-mlx-audio -p 127\.0\.0\.1:\d+:8000 -v .* ghcr\.io\/cloud-fronts-group\/sound-lab-mlx-audio:cpu$/);
  const audio = tone(path.join(work, 'auto.wav'), 2, 300);
  const t = await c.call('transcribe', { inputs: [audio], backend: 'mlx-service' }); // not running yet → autostart
  const td = await c.call('wait_job', { job_id: t.job_id, timeout_s: 60 });
  assert.equal(td.status, 'done', JSON.stringify(td.items));
  const runs = calls().filter(x => x.args[0] === 'run' && x.args.includes('soundlab-mlx-audio'));
  assert.ok(runs.some(x => x.cli.includes('container') || x.args.includes('ghcr.io/cloud-fronts-group/sound-lab-mlx-audio:cpu')));
  assert.ok(calls().some(x => x.args[0] === 'delete' && x.args.includes('--force')), 'apple container uses delete --force for stale containers');
  await c.call('mlx_service', { action: 'stop' });
  await c.close();
});

test('external mode never starts anything and explains itself; auto backend skips an unreachable service', async () => {
  const { c } = await client('external', { SOUND_LAB_MLX_URL: 'http://127.0.0.1:9/v1', SOUND_LAB_STT_BACKEND: 'auto', SOUND_LAB_MLX_WHISPER: path.join(FIX_BIN, 'mlx_whisper') });
  await assert.rejects(c.call('mlx_service', { action: 'start' }), /mode is "external"/);
  const s = await c.call('mlx_service', { action: 'status' });
  assert.equal(s.url, 'http://127.0.0.1:9');
  assert.equal(s.reachable, false);
  // explicit mlx CLI backend (fake mlx_whisper)
  const audio = tone(path.join(work, 'cli.wav'), 2, 300);
  const t = await c.call('transcribe', { inputs: [audio], backend: 'mlx', language: 'de', model: 'mlx-community/whisper-large-v3-turbo', formats: ['json'] });
  const td = await c.call('wait_job', { job_id: t.job_id, timeout_s: 60 });
  assert.equal(td.status, 'done', JSON.stringify(td.items));
  const j = JSON.parse(fs.readFileSync(path.join(work, 'cli.json'), 'utf8'));
  assert.equal(j.backend, 'mlx');
  assert.equal(j.language, 'de');
  assert.match(j.segments[1].text, /whisper-large-v3-turbo/);
  await c.close();
});

test('native mode: fails fast with a CUDA hint when mlx[cuda12] has no GPU (real wheel, optional)', { skip: !process.env.SOUND_LAB_TEST_CUDA_PYTHON }, async () => {
  const { c } = await client('native', { SOUND_LAB_PYTHON: process.env.SOUND_LAB_TEST_CUDA_PYTHON, PATH: '/usr/bin:/bin' });
  const t0 = Date.now();
  await assert.rejects(c.call('mlx_service', { action: 'start' }), /libcuda|NVIDIA GPU/);
  assert.ok(Date.now() - t0 < 60000, 'did not wait for the full timeout');
  await c.close();
});

test('real mlx-audio server (optional)', { skip: !process.env.SOUND_LAB_TEST_MLX_URL }, async () => {
  const { c } = await client('external', { SOUND_LAB_MLX_URL: process.env.SOUND_LAB_TEST_MLX_URL, SOUND_LAB_STT_MODEL: process.env.SOUND_LAB_TEST_STT_MODEL || 'mlx-community/whisper-tiny' });
  const s = await c.call('synthesize_speech', { text: 'Testing the Sound Lab plugin.', output: path.join(work, 'real', 'tts.wav') });
  assert.equal((await c.call('wait_job', { job_id: s.job_id, timeout_s: 300 })).status, 'done');
  const t = await c.call('transcribe', { inputs: [path.join(work, 'real', 'tts.wav')], backend: 'mlx-service', formats: ['txt'] });
  const d = await c.call('wait_job', { job_id: t.job_id, timeout_s: 300 });
  assert.equal(d.status, 'done', JSON.stringify(d.items));
  assert.match(fs.readFileSync(path.join(work, 'real', 'tts.txt'), 'utf8').toLowerCase(), /sound lab|plugin/);
  await c.close();
});
