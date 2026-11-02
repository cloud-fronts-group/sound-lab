#!/usr/bin/env node
'use strict';
// PostToolUse(Bash): after an ffmpeg command, ffprobe its outputs and report what was actually produced
// (duration, codecs, size). Missing or empty outputs are flagged back to Claude.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ffmpegCalls, isLocalPath } = require('./shellwords');

let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  let input; try { input = JSON.parse(raw); } catch { return process.exit(0); }
  const cmd = input?.tool_input?.command;
  if (typeof cmd !== 'string' || !/ffmpeg/.test(cmd)) { return process.exit(0); }
  const cwd = input.cwd || process.cwd();
  const outs = [...new Set(ffmpegCalls(cmd).flatMap(c => c.outputs).filter(o => isLocalPath(o) && o !== '/dev/null' && o !== 'NUL'))];
  if (!outs.length) { return process.exit(0); }
  const ffprobe = process.env.SOUND_LAB_FFPROBE || 'ffprobe';
  const lines = []; const problems = [];
  for (const o of outs.slice(0, 12)) {
    const p = path.resolve(cwd, o);
    if (!fs.existsSync(p)) { problems.push(`${o}: not created`); continue; }
    const st = fs.statSync(p);
    if (st.isDirectory()) { continue; }
    if (st.size === 0) { problems.push(`${o}: empty file (0 bytes)`); continue; }
    const r = spawnSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', p], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) { problems.push(`${o}: ffprobe cannot read it (${(r.stderr || '').trim().split('\n').pop()})`); continue; }
    try {
      const j = JSON.parse(r.stdout);
      const streams = j.streams.map(s => s.codec_type === 'audio' ? `${s.codec_name} ${s.sample_rate}Hz ${s.channels}ch` : s.codec_type === 'video' ? `${s.codec_name} ${s.width}x${s.height}` : `${s.codec_type}:${s.codec_name}`);
      const kb = Math.round(st.size / 1024);
      lines.push(`${o}: ${(+j.format.duration || 0).toFixed(3)} s, ${kb} KB, ${streams.join(' + ')}`);
    } catch { lines.push(`${o}: ${st.size} bytes`); }
  }
  if (problems.length) {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: `Sound Lab output check — problems:\n${problems.join('\n')}${lines.length ? `\nOK:\n${lines.join('\n')}` : ''}` }));
  } else if (lines.length) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `Sound Lab output check:\n${lines.join('\n')}` } }));
  }
  process.exit(0);
});
