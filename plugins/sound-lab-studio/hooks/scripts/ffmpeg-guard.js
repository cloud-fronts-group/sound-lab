#!/usr/bin/env node
'use strict';
// PreToolUse(Bash): block ffmpeg commands that would overwrite one of their own inputs.
// ffmpeg truncates the output before reading the input, so `ffmpeg -i a.wav … a.wav` destroys the source.
const path = require('path');
const { ffmpegCalls, isLocalPath } = require('./shellwords');

let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  let input; try { input = JSON.parse(raw); } catch { return process.exit(0); }
  const cmd = input?.tool_input?.command;
  if (typeof cmd !== 'string' || !/ffmpeg/.test(cmd)) { return process.exit(0); }
  const cwd = input.cwd || process.cwd();
  const abs = p => path.resolve(cwd, p.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
  for (const call of ffmpegCalls(cmd)) {
    const ins = call.inputs.filter(isLocalPath).map(abs);
    for (const out of call.outputs.filter(isLocalPath)) {
      if (ins.includes(abs(out))) {
        const reason = `Sound Lab guard: this ffmpeg command writes to its own input (${out}). ffmpeg truncates the output before reading, so the source would be destroyed. Write to a new file (e.g. ${out.replace(/(\.[^./]+)$/, '_new$1')}) and rename afterwards if needed.`;
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
        return process.exit(0);
      }
    }
  }
  process.exit(0);
});
