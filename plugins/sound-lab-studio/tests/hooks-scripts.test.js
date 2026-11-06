'use strict';
// Hooks (guard / verify / session-start) and the command scripts (dub, sfx, keyboard-synth) against real ffmpeg.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpdir, tone, ff, info, ROOT } = require('./helpers');
const { ffmpegCalls, splitCommands } = require('../hooks/scripts/shellwords');

const work = tmpdir('slhook-');
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

const hook = (name, input, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'scripts', name)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const script = (name, args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', name), ...args], { encoding: 'utf8', cwd: work });
const meanDb = (file, ss, t, af = '') => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(ss), '-t', String(t), '-i', file, '-af', `${af}${af ? ',' : ''}volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
  return parseFloat(/mean_volume: (-?[\d.]+)/.exec(r.stderr)[1]);
};

test('hooks.json is valid and every script exists', () => {
  const h = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  for (const ev of Object.values(h.hooks)) {
    for (const m of ev) {
      for (const x of m.hooks) {
        const rel = /CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(x.command)[1];
        assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
      }
    }
  }
});

test('shell tokenizer finds ffmpeg calls through quotes, pipes, env and continuation lines', () => {
  assert.deepEqual(splitCommands(`a 'b c' "d\\"e" && f | g; h`), [['a', 'b c', 'd"e'], ['f'], ['g'], ['h']]);
  const calls = ffmpegCalls(`cd x && FOO=1 /opt/bin/ffmpeg -hide_banner -y -ss 2 -i "my take.wav" -i b.wav \\\n -filter_complex "[0][1]amix" -c:a pcm_s24le "out file.wav" 2>&1 | tail -3`);
  assert.deepEqual(calls, [{ inputs: ['my take.wav', 'b.wav'], outputs: ['out file.wav'], overwrite: true }]);
  assert.deepEqual(ffmpegCalls('ffprobe -i a.wav'), []);
  assert.deepEqual(ffmpegCalls('ffmpeg -i a.wav -f null -')[0].outputs, ['-']);
});

test('PreToolUse guard denies in-place writes, allows everything else', () => {
  const deny = hook('ffmpeg-guard.js', { tool_name: 'Bash', cwd: work, tool_input: { command: `ffmpeg -y -i ./song.wav -af loudnorm ${path.join(work, 'song.wav')}` } });
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /song_new\.wav/);
  assert.equal(hook('ffmpeg-guard.js', { tool_name: 'Bash', cwd: work, tool_input: { command: 'ffmpeg -i song.wav -af loudnorm song_loud.wav' } }), null);
  assert.equal(hook('ffmpeg-guard.js', { tool_name: 'Bash', cwd: work, tool_input: { command: 'ls -la' } }), null);
  assert.equal(hook('ffmpeg-guard.js', { tool_name: 'Bash', cwd: work, tool_input: { command: 'ffmpeg -i rtmp://x/live -c copy rtmp://x/live' } }), null, 'URLs are not files');
  assert.equal(hook('ffmpeg-guard.js', 'not json'), null);
});

test('PostToolUse verify reports outputs, blocks on missing/empty/unreadable', () => {
  const good = tone(path.join(work, 'good.wav'), 1.5);
  const ok = hook('ffmpeg-verify.js', { tool_name: 'Bash', cwd: work, tool_input: { command: 'ffmpeg -i x.wav good.wav' } });
  assert.match(ok.hookSpecificOutput.additionalContext, /good\.wav: 1\.500 s, \d+ KB, pcm_s16le 48000Hz 1ch/);
  fs.writeFileSync(path.join(work, 'empty.wav'), '');
  fs.writeFileSync(path.join(work, 'junk.mp3'), 'not audio at all');
  const bad = hook('ffmpeg-verify.js', { tool_name: 'Bash', cwd: work, tool_input: { command: 'ffmpeg -i a -map 0 empty.wav -map 0 junk.mp3 -map 0 missing.flac -map 0 good.wav' } });
  assert.equal(bad.decision, 'block');
  assert.match(bad.reason, /empty\.wav: empty file/);
  assert.match(bad.reason, /junk\.mp3: ffprobe cannot read it/);
  assert.match(bad.reason, /missing\.flac: not created/);
  assert.match(bad.reason, /OK:\ngood\.wav/);
  assert.equal(hook('ffmpeg-verify.js', { tool_name: 'Bash', cwd: work, tool_input: { command: 'ffmpeg -i good.wav -f null -' } }), null);
  assert.ok(good);
});

test('SessionStart hook summarises the environment, unfinished jobs, and finds mlx_audio.server off PATH', () => {
  const data = path.join(work, 'plugdata'); fs.mkdirSync(path.join(data, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(data, 'jobs', 'convert-x.json'), JSON.stringify({ id: 'convert-x', status: 'interrupted', items: [] }));
  const out = hook('session-start.js', { hook_event_name: 'SessionStart' }, { CLAUDE_PLUGIN_DATA: data });
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(ctx, /ffmpeg \d/);
  assert.match(ctx, /convert-x \(interrupted\)/);
  // With a minimal PATH (hooks, VS Code) a Homebrew mlx_audio.server is still reported: the hook searches the same well-known
  // bin directories as the MCP server (SOUND_LAB_BIN_DIRS pins them for the test).
  const brewBin = path.join(work, 'brew-bin'); fs.mkdirSync(brewBin, { recursive: true });
  fs.writeFileSync(path.join(brewBin, 'mlx_audio.server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const emptyBin = path.join(work, 'empty-bin'); fs.mkdirSync(emptyBin, { recursive: true });
  const minimal = hook('session-start.js', { hook_event_name: 'SessionStart' }, { CLAUDE_PLUGIN_DATA: data, PATH: emptyBin, SOUND_LAB_BIN_DIRS: brewBin }).hookSpecificOutput.additionalContext;
  assert.match(minimal, /ffmpeg NOT found/);
  assert.ok(minimal.includes(`tools: mlx_audio.server (${brewBin}, not on PATH)`), minimal);
  const none = hook('session-start.js', { hook_event_name: 'SessionStart' }, { CLAUDE_PLUGIN_DATA: data, PATH: emptyBin, SOUND_LAB_BIN_DIRS: '' }).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(none, /mlx_audio\.server/);
});

test('dub.js music: full-length mix, voice offset, measurable ducking, loudness target', () => {
  const music = path.join(work, 'music.wav');
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*220*t)+0.3*sin(2*PI*330*t)':s=48000:d=12", '-ac', '2', music]);
  const voice = path.join(work, 'voice.wav');
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*600*t)*lt(mod(t,0.5),0.3)':s=48000:d=4", voice]);
  const r = script('dub.js', ['music', '--music', music, '--voice', voice, '--voice-at', '3', '--fade-out', '2', '--target', '-16', '--out', 'mix.wav', '--run']);
  assert.equal(r.status, 0, r.stderr.slice(-500));
  const mix = path.join(work, 'mix.wav');
  assert.ok(Math.abs(info(mix).duration - 12) < 0.01, 'bed plays to the end (sidechain key padded)');
  const bedOnly = 'lowpass=f=400,lowpass=f=400';
  const before = meanDb(mix, 1, 1, bedOnly), during = meanDb(mix, 4, 1, bedOnly), after = meanDb(mix, 9, 1, bedOnly);
  assert.ok(before - during > 6, `ducked ${before} → ${during}`);
  assert.ok(Math.abs(after - before) < 2, `recovers ${after} vs ${before}`);
  const json = JSON.parse(script('dub.js', ['music', '--music', music, '--voice', voice, '--out', 'x.mp3', '--json']).stdout);
  assert.ok(Array.isArray(json) && json.includes('-filter_complex') && !json.includes('-y'), 'argv for run_ffmpeg');
});

test('dub.js video: add-track keeps original + tagged default dub; replace; voice-only', () => {
  const video = path.join(work, 'video.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc=d=8:s=320x240:r=25', '-f', 'lavfi', '-i', 'sine=f=300:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  const voice = tone(path.join(work, 'es.wav'), 3, 700);
  for (const [mode, out] of [['add-track', 'dub_add.mp4'], ['replace', 'dub_rep.mp4'], ['voice-only', 'dub_vo.mkv']]) {
    const r = script('dub.js', ['video', '--video', video, '--voice', voice, '--voice-at', '1', '--mode', mode, '--lang', 'spa', '--out', out, '--run']);
    assert.equal(r.status, 0, `${mode}: ${r.stderr.slice(-400)}`);
  }
  const add = info(path.join(work, 'dub_add.mp4'));
  const aud = add.streams.filter(s => s.codec_type === 'audio');
  assert.equal(aud.length, 2);
  assert.equal(aud[1].tags.language, 'spa');
  assert.equal(aud[1].disposition.default, 1);
  assert.equal(aud[0].disposition.default, 0);
  assert.ok(Math.abs(add.duration - 8) < 0.1, `duration ${add.duration}`);
  const rep = info(path.join(work, 'dub_rep.mp4'));
  assert.equal(rep.streams.filter(s => s.codec_type === 'audio').length, 1);
  assert.equal(rep.vcodec, 'h264');
  assert.ok(Math.abs(rep.duration - 8) < 0.1);
  assert.equal(info(path.join(work, 'dub_vo.mkv')).streams.filter(s => s.codec_type === 'audio').length, 2);
});

test('dub.js stream: overlays ducked into a (file-played-live) stream, output targets', () => {
  const bed = tone(path.join(work, 'bed.wav'), 8, 220);
  const id = tone(path.join(work, 'id.wav'), 1, 900);
  const r = script('dub.js', ['stream', '--input', bed, '--overlay', `${id}@2`, '--duration', '5', '--out', 'live.mp3', '--run']);
  assert.equal(r.status, 0, r.stderr.slice(-400));
  assert.ok(Math.abs(info(path.join(work, 'live.mp3')).duration - 5) < 0.1);
  const rtmp = script('dub.js', ['stream', '--input', 'https://radio.example/stream', '--overlay', 'id.wav@0', '--every', '900', '--out', 'rtmp://live.example/app/key']).stdout;
  assert.match(rtmp, /-reconnect 1 .* -stream_loop -1 -i id\.wav .*apad=whole_dur=900.* -f flv rtmp:\/\/live\.example\/app\/key/);
  assert.match(script('dub.js', ['stream', '--input', bed, '--out', 'icecast://source:pw@host:8000/live']).stdout, /-content_type audio\/mpeg -f mp3/);
  assert.match(script('dub.js', ['stream', '--input', bed, '--out', 'hls/live.m3u8']).stdout, /-f hls -hls_time 6/);
  assert.equal(script('dub.js', ['nope']).status, 2);
});

test('sfx.js: every recipe renders, peak-normalised; seeded variations are reproducible', () => {
  const list = script('sfx.js', ['list']).stdout.trim().split('\n');
  assert.ok(list.length >= 13);
  const r = script('sfx.js', ['pack', '--out', 'pack', '--format', 'wav']);
  assert.equal(r.status, 0, r.stderr);
  for (const f of fs.readdirSync(path.join(work, 'pack'))) {
    const p = path.join(work, 'pack', f);
    const v = spawnSync('ffmpeg', ['-hide_banner', '-i', p, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const max = parseFloat(/max_volume: (-?[\d.]+)/.exec(v)[1]);
    assert.ok(Math.abs(max - -1) < 0.3, `${f} peak ${max}`);
    assert.equal(info(p).ch, 1);
    assert.equal(info(p).sr, 48000);
  }
  script('sfx.js', ['make', 'laser', '--variations', '3', '--seed', '9', '--out', 'v1/laser.wav']);
  script('sfx.js', ['make', 'laser', '--variations', '3', '--seed', '9', '--out', 'v2/laser.wav']);
  const d1 = [1, 2, 3].map(i => info(path.join(work, 'v1', `laser_0${i}.wav`)).duration);
  const d2 = [1, 2, 3].map(i => info(path.join(work, 'v2', `laser_0${i}.wav`)).duration);
  assert.deepEqual(d1, d2, 'same seed → same variations');
  assert.ok(new Set(d1).size > 1, 'variations differ from each other');
  assert.equal(script('sfx.js', ['make', 'nope']).status, 2);
});

test('keyboard-synth.js: QWERTY map is musical and the 4-phase build gets denser', () => {
  const { keyToMidi } = require('../scripts/keyboard-synth');
  const ctx = { root: 2, scale: 'dorian' };
  const notes = k => k.split('-').map(x => keyToMidi(x, ctx).midi % 12);
  assert.deepEqual(notes('A-S-D-F'), [2, 5, 9, 0], 'home row A-S-D-F = Dm7');
  assert.deepEqual(notes('Z-X-C-V'), [7, 11, 2, 5], 'bottom row Z-X-C-V = G7 (dorian IV)');
  assert.equal(keyToMidi('Q', ctx).role, 'melody');
  const score = { bpm: 80, key: 'D', scale: 'dorian', phases: [
    { name: 'The Pulse', bars: 2, metronome: '.' },
    { name: 'The Foundation', bars: 2, metronome: '.', chords: ['A-S-D-F', 'Z-X-C-V'] },
    { name: 'Instrumental', bars: 2, metronome: '.', chords: ['A-S-D-F'], melody: ['Q', '-', 'E', 'T'], fx: ['Shift:tape', 'Ctrl:filter-sweep'] },
    { name: 'Chorus', bars: 2, metronome: 'Space', chords: ['A-S-D-F-G', 'Z-X-C-V-B'], melody: ['Q', 'W', 'E', 'T'] }] };
  fs.writeFileSync(path.join(work, 'score.json'), JSON.stringify(score));
  const r = script('keyboard-synth.js', ['--score', 'score.json', '--out', 'perf.wav']);
  assert.equal(r.status, 0, r.stderr);
  const bar = 60 / 80 * 4;
  const out = path.join(work, 'perf.wav');
  assert.ok(Math.abs(info(out).duration - (8 * bar + 4 + 0.347)) < 0.05, `duration ${info(out).duration} (incl. 347 ms reverb tail)`);
  const pulse = meanDb(out, 0.2, bar * 1.5), chorus = meanDb(out, 6 * bar + 0.2, bar * 1.5);
  assert.ok(chorus - pulse > 6, `chorus (${chorus}) much denser than the pulse (${pulse})`);
  assert.match(script('keyboard-synth.js', ['--keymap']).stdout, /A=D3 {2}S=F3/);
});
