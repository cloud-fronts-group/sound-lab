'use strict';
// Tiny POSIX-ish shell tokenizer: splits a command line into simple commands (on ; && || | newline)
// and each into words, honouring quotes and backslashes. Good enough to find ffmpeg invocations.
function splitCommands(line) {
  const cmds = [[]]; let word = null; let q = null;
  const push = () => { if (word !== null) { cmds[cmds.length - 1].push(word); word = null; } };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (c === '\\' && q === '"' && i + 1 < line.length) { word = (word ?? '') + line[++i]; continue; }
      word = (word ?? '') + c; continue;
    }
    if (c === "'" || c === '"') { q = c; word = word ?? ''; continue; }
    if (c === '\\' && i + 1 < line.length) { if (line[i + 1] === '\n') { i++; continue; } word = (word ?? '') + line[++i]; continue; }
    if (/\s/.test(c) && c !== '\n') { push(); continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&') {
      push(); if (cmds[cmds.length - 1].length) { cmds.push([]); }
      if ((c === '|' || c === '&') && line[i + 1] === c) { i++; }
      continue;
    }
    word = (word ?? '') + c;
  }
  push();
  return cmds.filter(c => c.length);
}

const NO_VALUE = new Set(['-y', '-n', '-nostdin', '-hide_banner', '-re', '-shortest', '-vn', '-an', '-sn', '-dn', '-copyts', '-stats', '-nostats', '-accurate_seek', '-noaccurate_seek', '-benchmark', '-xerror', '-autorotate', '-noautorotate', '-dump', '-hex', '-start_at_zero', '-ignore_unknown', '-copy_unknown']);

/** Find ffmpeg invocations; return [{inputs, outputs, overwrite}] with paths as written. */
function ffmpegCalls(line) {
  const calls = [];
  for (const words of splitCommands(line)) {
    // skip env assignments, sudo, time, nice, etc.
    let i = 0;
    while (i < words.length && (/^\w+=/.test(words[i]) || ['sudo', 'time', 'nice', 'nohup', 'exec', 'command'].includes(words[i]))) { i++; }
    if (!words[i] || !/(^|\/)ffmpeg(\.exe)?$/.test(words[i])) { continue; }
    const inputs = [], outputs = []; let overwrite = false;
    for (let j = i + 1; j < words.length; j++) {
      const a = words[j];
      if (a === '-i') { inputs.push(words[++j]); continue; }
      if (a === '-y') { overwrite = true; continue; }
      if (a.startsWith('-') && a.length > 1) { if (!NO_VALUE.has(a)) { j++; } continue; }
      if (a.startsWith('>') || a.startsWith('2>') || a.startsWith('<')) { continue; }
      outputs.push(a);
    }
    calls.push({ inputs, outputs, overwrite });
  }
  return calls;
}

const isLocalPath = s => !!s && s !== '-' && !/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.includes('%') && !s.startsWith('pipe:');

module.exports = { splitCommands, ffmpegCalls, isLocalPath };
