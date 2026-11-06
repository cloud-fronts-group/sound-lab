#!/usr/bin/env node
'use strict';
// Stand-in for the `mlx-audio-studio` launcher that the Homebrew formula installs in its bin:
//   mlx-audio-studio [-p|--port N] [-H|--host H]   (defaults: $MLX_AUDIO_STUDIO_PORT or 3000, $MLX_AUDIO_STUDIO_HOST or 127.0.0.1)
// It runs `node server.js` in ../libexec/ui (relative to this script's real location, like the keg layout
// <keg>/bin/mlx-audio-studio + <keg>/libexec/ui), with PORT and HOSTNAME set, stays in the foreground and
// stops its child on SIGTERM/SIGINT. Tests copy it into a fake keg next to a bundle.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
let port = process.env.MLX_AUDIO_STUDIO_PORT || '3000';
let host = process.env.MLX_AUDIO_STUDIO_HOST || '127.0.0.1';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-p' || argv[i] === '--port') { port = argv[++i]; }
  else if (argv[i] === '-H' || argv[i] === '--host') { host = argv[++i]; }
  else { process.stderr.write('usage: mlx-audio-studio [-p|--port N] [-H|--host H]\n'); process.exit(64); }
}
const ui = path.join(path.dirname(fs.realpathSync(__filename)), '..', 'libexec', 'ui');
const child = spawn(process.execPath, ['server.js'], { cwd: ui, stdio: 'inherit', env: { ...process.env, PORT: port, HOSTNAME: host } });
for (const sig of ['SIGTERM', 'SIGINT']) { process.on(sig, () => child.kill(sig)); }
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 143 : 1)));
