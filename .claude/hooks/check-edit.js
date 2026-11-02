#!/usr/bin/env node
// PostToolUse hook: fast feedback after Claude edits a file.
//  • src/**/*.ts or package.json → full tsc compile + manifest/code wiring test (test/activation.test.js)
//  • media/*.js                  → syntax check
//  • src/core/**                 → reject `vscode` imports (core must stay testable without VS Code)
// Exit code 2 sends stderr back to Claude so it fixes the problem immediately.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let input = '';
process.stdin.on('data', c => (input += c));
process.stdin.on('end', () => {
  let file;
  try { file = JSON.parse(input).tool_input?.file_path; } catch { process.exit(0); }
  if (!file) { process.exit(0); }
  const root = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
  const rel = path.relative(root, path.resolve(root, file)).replace(/\\/g, '/');
  const problems = [];
  const sh = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });

  if (/^src\/core\/.*\.ts$/.test(rel) && /from ['"]vscode['"]|require\(['"]vscode['"]\)/.test(fs.readFileSync(path.join(root, rel), 'utf8'))) {
    problems.push(`${rel} imports 'vscode' — src/core/ must stay free of VS Code APIs (move the glue to util.ts/commands.ts).`);
  }
  if (/^src\/.*\.ts$/.test(rel) || rel === 'package.json') {
    if (rel === 'package.json') {
      try { JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch (e) { problems.push(`package.json is not valid JSON: ${e.message}`); }
    }
    const tsc = sh('npx', ['tsc', '-p', '.']);
    if (tsc.status !== 0) {
      problems.push('TypeScript errors:\n' + (tsc.stdout + tsc.stderr).trim().split('\n').slice(0, 25).join('\n'));
    } else {
      const t = sh('node', ['--test', 'test/activation.test.js']);
      if (t.status !== 0) {
        const msg = (t.stdout + t.stderr).split('\n').filter(l => /error:|message|not ok|unknown|not declared|AssertionError|expected|actual/.test(l)).slice(0, 15).join('\n');
        problems.push('Manifest ↔ code wiring check failed (test/activation.test.js):\n' + msg);
      }
    }
  }
  if (/^media\/.*\.js$/.test(rel)) {
    const c = sh('node', ['--check', rel]);
    if (c.status !== 0) { problems.push(`Syntax error in ${rel}:\n${c.stderr.trim()}`); }
  }
  if (problems.length) { process.stderr.write(problems.join('\n\n') + '\n'); process.exit(2); }
  process.exit(0);
});
