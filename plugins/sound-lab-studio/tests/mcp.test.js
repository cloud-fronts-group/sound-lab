'use strict';
// MCP server: protocol, batch conversion with presets, run_ffmpeg, cancellation, persistence/resume, container runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { McpClient, tmpdir, ff, tone, info, lufs, FIX_BIN } = require('./helpers');

const work = tmpdir('slmcp-');
const data = path.join(work, 'data');
const env = { SOUND_LAB_DATA: data };
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

test('protocol: initialize, tools/list, ping, unknown tool/method', async () => {
  const c = new McpClient(env);
  const init = await c.init();
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.equal(init.serverInfo.name, 'sound-lab-media');
  assert.ok(init.capabilities.tools);
  const tools = (await c.request('tools/list')).result.tools;
  const names = tools.map(t => t.name);
  for (const n of ['capabilities', 'list_presets', 'probe', 'batch_convert', 'run_ffmpeg', 'transcribe', 'synthesize_speech', 'separate_audio', 'mlx_service', 'job_status', 'wait_job', 'list_jobs', 'cancel_job', 'resume_job']) {
    assert.ok(names.includes(n), n);
  }
  for (const t of tools) { assert.equal(t.inputSchema.type, 'object', t.name); assert.ok(t.description.length > 30, t.name); }
  assert.deepEqual((await c.request('ping')).result, {});
  assert.equal((await c.request('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  assert.equal((await c.request('does/not/exist')).error.code, -32601);
  const c2 = new McpClient(env);
  const old = await c2.request('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
  assert.equal(old.result.protocolVersion, '2025-06-18', 'unknown version → server latest');
  await c2.close();
  await c.close();
});

test('capabilities + presets + probe', async () => {
  const c = new McpClient(env); await c.init();
  const caps = await c.call('capabilities');
  assert.ok(caps.ffmpeg.version);
  assert.ok(caps.ffmpeg.keyFilters.includes('loudnorm'));
  assert.equal(caps.mlxService.reachable, false);
  assert.ok(Array.isArray(caps.recommendations));
  const presets = (await c.call('list_presets')).presets;
  assert.ok(presets.length >= 15);
  assert.ok(presets.find(p => p.name === 'normalize-14').twoPassLoudnorm);
  const f = tone(path.join(work, 'probe.wav'), 1.5);
  const p = await c.call('probe', { path: f });
  assert.equal(p.audio.sampleRate, 48000);
  assert.ok(Math.abs(p.duration - 1.5) < 0.01);
  await c.close();
});

test('batch_convert: folder → mp3/flac with structure kept, never overwriting', async () => {
  const src = path.join(work, 'src'); fs.mkdirSync(path.join(src, 'drums', 'kicks'), { recursive: true });
  tone(path.join(src, 'pad.wav'), 2, 220);
  tone(path.join(src, 'drums', 'snare 01.wav'), 1, 200);
  tone(path.join(src, 'drums', 'kicks', 'kick.wav'), 0.5, 60);
  fs.writeFileSync(path.join(src, 'notes.txt'), 'not media');
  const c = new McpClient(env); await c.init();
  const plan = await c.call('batch_convert', { inputs: [src], preset: 'mp3-v0', output_dir: path.join(work, 'mp3'), dry_run: true });
  assert.equal(plan.files, 3);
  const r = await c.call('batch_convert', { inputs: [src], preset: 'mp3-v0', output_dir: path.join(work, 'mp3'), concurrency: 3 });
  const done = await c.call('wait_job', { job_id: r.job_id, timeout_s: 60 });
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.ok(fs.existsSync(path.join(work, 'mp3', 'drums', 'kicks', 'kick_mp3-v0.mp3')));
  assert.equal(info(path.join(work, 'mp3', 'drums', 'snare 01_mp3-v0.mp3')).acodec, 'mp3');
  assert.ok(done.items.every(i => i.result.size > 0 && i.result.audio === 'mp3'));
  // same job again → numbered names, originals untouched
  const again = await c.call('batch_convert', { inputs: [path.join(src, '*.wav')], preset: 'mp3-v0', output_dir: path.join(work, 'mp3') });
  const d2 = await c.call('wait_job', { job_id: again.job_id, timeout_s: 60 });
  assert.equal(d2.items.length, 1, 'non-recursive glob matched only pad.wav');
  assert.match(d2.items[0].output, /pad_mp3-v0-1\.mp3$/);
  // custom args next to the source with empty suffix and same extension can't clobber the source
  const same = await c.call('batch_convert', { inputs: [path.join(src, 'pad.wav')], ffmpeg_args: ['-c:a', 'pcm_s16le'], output_ext: 'wav', suffix: '' });
  const d3 = await c.call('wait_job', { job_id: same.job_id, timeout_s: 60 });
  assert.notEqual(d3.items[0].output, path.join(src, 'pad.wav'));
  assert.equal(info(path.join(src, 'pad.wav')).duration, 2);
  await c.close();
});

test('batch_convert: two-pass loudness preset hits target; flac 24-bit; video preset', async () => {
  const quiet = path.join(work, 'quiet.wav');
  ff(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.03:d=8:sample_rate=44100', '-c:a', 'pcm_s24le', quiet]);
  const vid = path.join(work, 'clip.mov');
  ff(['-f', 'lavfi', '-i', 'testsrc2=d=2:s=640x360:r=25', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-shortest', vid]);
  const c = new McpClient(env); await c.init();
  const a = await c.call('batch_convert', { inputs: [quiet], preset: 'normalize-14', output_dir: path.join(work, 'norm') });
  const b = await c.call('batch_convert', { inputs: [quiet], preset: 'flac', output_dir: path.join(work, 'flac') });
  const v = await c.call('batch_convert', { inputs: [vid], preset: 'mp4-h264', output_dir: path.join(work, 'mp4') });
  for (const j of [a, b, v]) { const d = await c.call('wait_job', { job_id: j.job_id, timeout_s: 120 }); assert.equal(d.status, 'done', JSON.stringify(d.items)); }
  const n = path.join(work, 'norm', 'quiet_normalize-14.wav');
  const l = lufs(n);
  assert.ok(Math.abs(l.i - -14) < 1, `integrated ${l.i}`);
  assert.ok(l.tp <= -0.9, `true peak ${l.tp}`);
  assert.equal(info(n).sr, 44100, 'rate restored after loudnorm');
  const fl = info(path.join(work, 'flac', 'quiet_flac.flac'));
  assert.equal(fl.acodec, 'flac');
  assert.equal(fl.streams[0].bits_per_raw_sample, '24');
  const mp4 = info(path.join(work, 'mp4', 'clip_mp4-h264.mp4'));
  assert.equal(mp4.vcodec, 'h264'); assert.equal(mp4.acodec, 'aac');
  await c.close();
});

test('run_ffmpeg: background mix, refuses in-place writes, reports failures', async () => {
  const m = tone(path.join(work, 'm.wav'), 3, 200); const v = tone(path.join(work, 'v.wav'), 1, 800);
  const c = new McpClient(env); await c.init();
  await assert.rejects(c.call('run_ffmpeg', { args: ['-i', m, '-af', 'volume=2', m] }), /both an input and an output/);
  const out = path.join(work, 'mixed', 'mix.wav');
  const r = await c.call('run_ffmpeg', { args: ['ffmpeg', '-i', m, '-i', v, '-filter_complex', '[0][1]amix=inputs=2:duration=first:normalize=0[o]', '-map', '[o]', out], title: 'mix test' });
  assert.deepEqual(r.outputs, [out]);
  const d = await c.call('wait_job', { job_id: r.job_id, timeout_s: 30 });
  assert.equal(d.status, 'done');
  assert.ok(Math.abs(d.items[0].result[out].duration - 3) < 0.01);
  const bad = await c.call('run_ffmpeg', { args: ['-i', path.join(work, 'missing.wav'), path.join(work, 'x.wav')] });
  const bd = await c.call('wait_job', { job_id: bad.job_id, timeout_s: 30 });
  assert.equal(bd.status, 'failed');
  assert.match(bd.items[0].error, /No such file|ffmpeg exited/);
  await c.close();
});

test('cancel_job stops a running ffmpeg; interrupted jobs survive restart and resume', async () => {
  const c = new McpClient(env); await c.init();
  const long = await c.call('run_ffmpeg', { args: ['-re', '-f', 'lavfi', '-i', 'sine=d=60', path.join(work, 'long.wav')], duration_s: 60 });
  await new Promise(r => setTimeout(r, 1200));
  const st = await c.call('job_status', { job_id: long.job_id });
  assert.equal(st.status, 'running');
  assert.ok(st.items[0].progress > 0, 'progress reported');
  await c.call('cancel_job', { job_id: long.job_id });
  const d = await c.call('wait_job', { job_id: long.job_id, timeout_s: 15 });
  assert.equal(d.status, 'cancelled');

  // start a job, kill the server mid-run, restart → interrupted → resume → done
  const slow = await c.call('run_ffmpeg', { args: ['-re', '-f', 'lavfi', '-i', 'sine=d=3', path.join(work, 'resumed.wav')], duration_s: 3 });
  await new Promise(r => setTimeout(r, 800));
  await c.close(); // stdin close → graceful shutdown marks running work interrupted
  const c2 = new McpClient(env); await c2.init();
  const listed = (await c2.call('list_jobs', {})).jobs.find(j => j.id === slow.job_id);
  assert.equal(listed.status, 'interrupted');
  assert.match(listed.note, /resume_job/);
  const res = await c2.call('resume_job', { job_id: slow.job_id });
  assert.equal(res.requeued, 1);
  const fin = await c2.call('wait_job', { job_id: slow.job_id, timeout_s: 30 });
  assert.equal(fin.status, 'done');
  assert.ok(Math.abs(info(path.join(work, 'resumed.wav')).duration - 3) < 0.05);
  await c2.close();
});

test('docker runner: paths are bind-mounted and rewritten (fake docker shim runs host ffmpeg)', async () => {
  const state = path.join(work, 'fake-state');
  const src = path.join(work, 'dock in'); fs.mkdirSync(src, { recursive: true });
  tone(path.join(src, 'a b.wav'), 1);
  const c = new McpClient({ ...env, SOUND_LAB_RUNNER: 'docker', SOUND_LAB_DOCKER: path.join(FIX_BIN, 'docker'), FAKE_CONTAINER_STATE: state, SOUND_LAB_GPU: 'nvidia' });
  await c.init();
  const r = await c.call('batch_convert', { inputs: [src], preset: 'ogg-game', output_dir: path.join(work, 'dock out') });
  const d = await c.call('wait_job', { job_id: r.job_id, timeout_s: 60 });
  assert.equal(d.status, 'done', JSON.stringify(d.items));
  assert.equal(info(path.join(work, 'dock out', 'a b_ogg-game.ogg')).acodec, 'vorbis');
  const call = fs.readFileSync(path.join(state, 'calls.log'), 'utf8').trim().split('\n').map(JSON.parse).find(x => x.args[0] === 'run');
  const a = call.args;
  assert.ok(a.includes('--gpus'), 'nvidia passthrough flag');
  assert.ok(a.includes('ghcr.io/cloud-fronts-group/sound-lab-ffmpeg:latest'));
  const vols = a.filter((x, i) => a[i - 1] === '-v');
  assert.ok(vols.some(v => v.startsWith(src + ':/mnt/sl') && v.endsWith(':ro')), `input mounted read-only: ${vols}`);
  assert.ok(vols.some(v => v.startsWith(path.join(work, 'dock out') + ':/mnt/sl') && !v.endsWith(':ro')), 'output dir mounted rw');
  const after = a.slice(a.indexOf('ffmpeg') + 1);
  assert.ok(after.every(x => !x.startsWith(work)), 'no host paths leak into the container argv');
  await c.close();
});
