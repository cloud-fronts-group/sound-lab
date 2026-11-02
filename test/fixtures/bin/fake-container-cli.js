#!/usr/bin/env node
'use strict';
// Fake docker / podman / Apple `container` CLI for tests.
//  run … IMAGE ffmpeg ARGS   → maps -v host:ctr mounts back to host paths and runs the host ffmpeg/whisper-cli
//  run -d … -p H:P:C IMAGE   → starts the mock mlx-audio server on port P (a "service" container)
//  rm -f | delete --force | stop | kill NAME, logs NAME, inspect NAME
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const STATE = process.env.FAKE_CONTAINER_STATE || '/tmp/fake-container-state';
fs.mkdirSync(STATE, { recursive: true });
const args = process.argv.slice(2);
fs.appendFileSync(path.join(STATE, 'calls.log'), JSON.stringify({ cli: path.basename(process.argv[1]), args }) + '\n');
const cmd = args[0];
const pidFile = n => path.join(STATE, `${n}.pid`);
if (cmd === 'run') {
  const mounts = []; let name, port, detached = false, i = 1;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-v') { const [h, c] = args[++i].split(':'); mounts.push([h, c]); }
    else if (a === '--name') { name = args[++i]; }
    else if (a === '-p') { port = args[++i].split(':').slice(-2)[0]; }
    else if (a === '-d') { detached = true; }
    else if (['-w', '--user', '--device', '--gpus', '-e'].includes(a)) { i++; }
    else if (a.startsWith('-')) { /* flag */ }
    else { break; }
  }
  const image = args[i]; const rest = args.slice(i + 1);
  if (detached && rest.length === 0) {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'mock-mlx-audio.js'), port], { detached: true, stdio: 'ignore', env: process.env });
    child.unref(); fs.writeFileSync(pidFile(name), String(child.pid));
    fs.writeFileSync(path.join(STATE, `${name}.image`), image);
    process.stdout.write(`${name}-id\n`); process.exit(0);
  }
  const unmap = s => { for (const [h, c] of mounts.sort((a, b) => b[1].length - a[1].length)) { if (s === c || s.startsWith(c + '/')) { return h + s.slice(c.length); } s = s.split(c + '/').join(h + '/'); } return s; };
  const exe = rest[0] === 'whisper-cli' ? (process.env.FAKE_WHISPER_CLI || 'whisper-cli') : rest[0];
  const r = spawnSync(exe, rest.slice(1).map(unmap), { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
if (['rm', 'delete', 'stop', 'kill'].includes(cmd)) {
  const name = args[args.length - 1];
  try { process.kill(parseInt(fs.readFileSync(pidFile(name), 'utf8'), 10)); fs.rmSync(pidFile(name)); } catch { /* not running */ }
  process.exit(0);
}
if (cmd === 'logs') { process.stdout.write('mock mlx-audio logs\n'); process.exit(0); }
if (cmd === 'inspect') { process.stdout.write(JSON.stringify([{ networks: [{ address: '127.0.0.1/24' }] }])); process.exit(0); }
if (cmd === 'machine') { process.stdout.write('libkrun\n'); process.exit(0); }
process.exit(0);
