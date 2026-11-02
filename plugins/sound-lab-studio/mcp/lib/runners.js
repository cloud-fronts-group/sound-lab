'use strict';
// Where a command runs: on the host ("local"), or inside a container via docker / podman.
//
// Apple GPU reality check:
//  • local on macOS  → real Apple GPU: VideoToolbox encoders, AudioToolbox AAC, whisper.cpp (Metal), mlx-whisper (MLX).
//  • docker on macOS → Linux VM, NO Metal/GPU access. Portable + reproducible, CPU only.
//  • podman on macOS with the libkrun machine provider → Vulkan (Venus → MoltenVK → Metal) is exposed as /dev/dri,
//    which whisper.cpp's Vulkan backend can use (container_gpu="dri"). ffmpeg's encoders still run on CPU there.
//  • docker/podman on Linux + NVIDIA → container_gpu="nvidia".
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Build the invocation for `exe args` under the given runner.
 * Absolute paths in args that are (or live inside) known files are bind-mounted and rewritten.
 * @param {{runner: string, image: string, gpu?: string, binaries?: Record<string,string>, extraArgs?: string[]}} cfg
 * @param {string} exe  logical binary: 'ffmpeg' | 'ffprobe' | 'whisper-cli'
 * @param {string[]} args
 * @param {{reads?: string[], writes?: string[], name?: string}} files
 */
function invocation(cfg, exe, args, files = {}) {
  const runner = cfg.runner || 'local';
  if (runner === 'local') {
    return { cmd: cfg.binaries?.[exe] || exe, args, runner, containerName: null };
  }
  if (runner !== 'docker' && runner !== 'podman') { throw new Error(`Unknown runner "${runner}" (use local, docker or podman)`); }

  const reads = (files.reads || []).map(p => path.resolve(p));
  const writes = (files.writes || []).map(p => path.resolve(p));
  /** host dir → { mount, rw } */
  const dirs = new Map();
  const addDir = (d, rw) => {
    const cur = dirs.get(d);
    if (cur) { cur.rw = cur.rw || rw; return; }
    dirs.set(d, { mount: `/mnt/sl${dirs.size}`, rw });
  };
  for (const r of reads) { addDir(fs.existsSync(r) && fs.statSync(r).isDirectory() ? r : path.dirname(r), false); }
  for (const w of writes) { addDir(fs.existsSync(w) && fs.statSync(w).isDirectory() ? w : path.dirname(w), true); }

  // Longest host dir first so nested dirs map to their own mount.
  const ordered = [...dirs.entries()].sort((a, b) => b[0].length - a[0].length);
  const mapPath = (s) => {
    for (const [host, m] of ordered) {
      if (s === host) { return m.mount; }
      if (s.startsWith(host + path.sep)) { return m.mount + '/' + path.relative(host, s).split(path.sep).join('/'); }
    }
    return null;
  };
  const mapped = args.map(a => {
    if (typeof a !== 'string') { return a; }
    if (path.isAbsolute(a)) { return mapPath(a) ?? a; }
    // key=value filter options such as subtitles=/abs/file.srt or model=/abs/model.bin
    return a.replace(/((?:^|[=:,'])\s*)(\/[^:,'"\s]+)/g, (m, pre, p) => { const r = mapPath(p); return r ? pre + r : m; });
  });

  const name = files.name || `soundlab-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const cargs = ['run', '--rm', '-i', '--name', name];
  if (process.platform === 'linux' && typeof process.getuid === 'function') { cargs.push('--user', `${process.getuid()}:${process.getgid()}`); }
  for (const [host, m] of dirs) { cargs.push('-v', `${host}:${m.mount}${m.rw ? '' : ':ro'}`); }
  if (cfg.gpu === 'dri') { cargs.push('--device', '/dev/dri'); }
  else if (cfg.gpu === 'nvidia') { cargs.push(...(runner === 'podman' ? ['--device', 'nvidia.com/gpu=all'] : ['--gpus', 'all'])); }
  const first = ordered.length ? ordered[ordered.length - 1][1].mount : '/tmp';
  cargs.push('-w', first, ...(cfg.extraArgs || []), cfg.image, exe, ...mapped);
  return { cmd: cfg.binaries?.[runner] || runner, args: cargs, runner, containerName: name };
}

/** Stop a running container started by invocation(). Best effort. */
function killContainer(cfg, name) {
  if (!name || cfg.runner === 'local') { return; }
  try { require('child_process').spawn(cfg.binaries?.[cfg.runner] || cfg.runner, ['kill', name], { stdio: 'ignore' }).unref(); } catch { /* ignore */ }
}

/** Describe runtime + GPU options for the capabilities tool. */
function containerInfo(which, run) {
  const info = { docker: !!which('docker'), podman: !!which('podman'), podmanProvider: null };
  if (info.podman && process.platform === 'darwin') {
    try {
      const r = require('child_process').spawnSync('podman', ['machine', 'inspect', '--format', '{{.VMType}}'], { encoding: 'utf8', timeout: 5000 });
      info.podmanProvider = (r.stdout || '').trim() || null;
    } catch { /* ignore */ }
  }
  return info;
}

function defaultDataDir() {
  return process.env.SOUND_LAB_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.sound-lab');
}

module.exports = { invocation, killContainer, containerInfo, defaultDataDir };
