'use strict';
// Process helpers for ffmpeg / ffprobe and other CLIs. No dependencies.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Parse "HH:MM:SS.ms", "MM:SS" or seconds. */
function parseTime(v) {
  if (v === undefined || v === null) { return NaN; }
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) { return parseFloat(s); }
  const parts = s.split(':').map(Number);
  if (parts.some(isNaN)) { return NaN; }
  return parts.reduce((a, p) => a * 60 + p, 0);
}

/**
 * Spawn a process. Resolves {code, stdout, stderr, cancelled}; never rejects on non-zero exit
 * (rejects only when the executable is missing).
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', partial = '', cancelled = false;
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env || process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (opts.onSpawn) { opts.onSpawn(child); }
    const cap = 8 * 1024 * 1024;
    const abort = () => {
      cancelled = true;
      try { child.stdin.write('q\n'); } catch { /* closed */ }
      setTimeout(() => { if (child.exitCode === null) { child.kill('SIGTERM'); } }, opts.graceMs ?? 1500);
      setTimeout(() => { if (child.exitCode === null) { child.kill('SIGKILL'); } }, (opts.graceMs ?? 1500) + 3000);
    };
    if (opts.signal) {
      if (opts.signal.aborted) { abort(); } else { opts.signal.addEventListener('abort', abort, { once: true }); }
    }
    child.stdout.on('data', d => { if (stdout.length < cap) { stdout += d; } opts.onStdout?.(d); });
    child.stderr.on('data', d => {
      const t = d.toString();
      if (stderr.length < cap) { stderr += t; }
      partial += t;
      const lines = partial.split(/\r\n|\r|\n/);
      partial = lines.pop() ?? '';
      for (const l of lines) { handle(l); }
    });
    const handle = (line) => {
      if (!line) { return; }
      opts.onLine?.(line);
      if (opts.onProgress && opts.duration > 0) {
        const m = /time=\s*(-?\d+:\d+:\d+(?:\.\d+)?)/.exec(line);
        if (m) { const t = parseTime(m[1]); if (t >= 0) { opts.onProgress(Math.min(1, t / opts.duration)); } }
      }
    };
    child.on('error', e => reject(e.code === 'ENOENT' ? new Error(`Executable not found: ${cmd}`) : e));
    child.on('close', code => {
      if (partial) { handle(partial); }
      opts.signal?.removeEventListener('abort', abort);
      try { child.stdin.end(); } catch { /* ignore */ }
      resolve({ code: code ?? -1, stdout, stderr, cancelled });
    });
    if (opts.stdinClose !== false) { /* keep stdin open so 'q' can stop ffmpeg gracefully */ }
  });
}

function tail(text, n = 8) {
  return String(text).split(/\r?\n/).filter(l => l.trim() && !/^\s*(size|frame)=/.test(l)).slice(-n).join('\n');
}

function which(cmd) {
  if (!cmd) { return null; }
  if (cmd.includes('/') || cmd.includes('\\')) { return fs.existsSync(cmd) ? cmd : null; }
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const e of exts) {
      const p = path.join(dir, cmd + e);
      try { if (fs.statSync(p).isFile()) { return p; } } catch { /* next */ }
    }
  }
  return null;
}

/**
 * Directories searched after PATH for native tools, in this order: Homebrew's bin (Apple silicon, then Intel), then
 * pipx / uv user installs. VS Code's extension host, launchd-started services and Claude Code hooks often run with a
 * minimal PATH, and an auto-activated conda env can shadow the Homebrew binary. The environment variable
 * SOUND_LAB_BIN_DIRS (a PATH-style list, may be empty) replaces the list; tests use it to pin discovery.
 */
const WELL_KNOWN_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
function wellKnownBinDirs(override = process.env.SOUND_LAB_BIN_DIRS) {
  return override === undefined ? WELL_KNOWN_BIN_DIRS : String(override).split(path.delimiter).filter(Boolean);
}

/**
 * The executable native mode runs: `explicit` (a setting) wins as given, then `name` on PATH, then `name` in the
 * well-known directories in order. Returns a path, or null when nothing was found so the caller keeps its fallback
 * (e.g. `python3 -m mlx_audio.server`).
 */
function findExecutable(name, explicit, dirs = wellKnownBinDirs()) {
  if (explicit) { return explicit; }
  const onPath = which(name);
  if (onPath) { return onPath; }
  for (const dir of dirs) {
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) { return p; } } catch { /* next */ }
  }
  return null;
}

async function probe(ffprobe, file) {
  const r = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) { throw new Error(`ffprobe failed for ${file}: ${tail(r.stderr, 3)}`); }
  const j = JSON.parse(r.stdout);
  const a = j.streams.find(s => s.codec_type === 'audio');
  const v = j.streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  return {
    duration: parseFloat(j.format.duration ?? a?.duration ?? v?.duration ?? '0') || 0,
    format: j.format.format_name,
    size: parseInt(j.format.size ?? '0', 10) || 0,
    bitRate: parseInt(j.format.bit_rate ?? '0', 10) || undefined,
    audio: a ? { codec: a.codec_name, sampleRate: parseInt(a.sample_rate, 10), channels: a.channels, layout: a.channel_layout, bitRate: parseInt(a.bit_rate ?? '0', 10) || undefined, sampleFmt: a.sample_fmt } : null,
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: v.avg_frame_rate, pixFmt: v.pix_fmt, tag: v.codec_tag_string } : null,
    audioStreams: j.streams.filter(s => s.codec_type === 'audio').length,
    subtitleStreams: j.streams.filter(s => s.codec_type === 'subtitle').length,
    tags: j.format.tags || {},
  };
}

let capsCache = null;
/** Detect ffmpeg build features and the host's acceleration options. Cached per process. */
function capabilities(ffmpeg, ffprobe, refresh = false) {
  if (capsCache && !refresh) { return capsCache; }
  const caps = { platform: process.platform, arch: process.arch, appleSilicon: process.platform === 'darwin' && process.arch === 'arm64', ffmpeg: null, ffprobe: null, encoders: new Set(), filters: new Set(), hwaccels: new Set(), errors: [] };
  const sync = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const v = sync(ffmpeg, ['-hide_banner', '-version']);
  if (v.error || v.status !== 0) { caps.errors.push(`ffmpeg not usable at "${ffmpeg}": ${v.error?.message || v.stderr}`); }
  else {
    caps.ffmpeg = /ffmpeg version (\S+)/.exec(v.stdout)?.[1] ?? 'unknown';
    for (const l of sync(ffmpeg, ['-hide_banner', '-encoders']).stdout.split('\n')) { const m = /^\s[A-Z.]{6}\s+(\S+)/.exec(l); if (m) { caps.encoders.add(m[1]); } }
    for (const l of sync(ffmpeg, ['-hide_banner', '-filters']).stdout.split('\n')) { const m = /^\s[.TSC|]{3}\s+(\w+)\s/.exec(l); if (m) { caps.filters.add(m[1]); } }
    for (const l of sync(ffmpeg, ['-hide_banner', '-hwaccels']).stdout.split('\n').slice(1)) { if (l.trim()) { caps.hwaccels.add(l.trim()); } }
  }
  const p = sync(ffprobe, ['-hide_banner', '-version']);
  if (p.error || p.status !== 0) { caps.errors.push(`ffprobe not usable at "${ffprobe}"`); } else { caps.ffprobe = /ffprobe version (\S+)/.exec(p.stdout)?.[1] ?? 'unknown'; }
  caps.videotoolbox = caps.encoders.has('h264_videotoolbox');
  caps.audiotoolbox = caps.encoders.has('aac_at');
  capsCache = caps;
  return caps;
}

module.exports = { run, tail, which, findExecutable, wellKnownBinDirs, WELL_KNOWN_BIN_DIRS, probe, capabilities, parseTime };
