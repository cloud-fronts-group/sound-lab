'use strict';
// Minimal MCP stdio client for tests + media fixtures generated with lavfi.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const FIX_BIN = path.join(__dirname, 'fixtures', 'bin');

class McpClient {
  constructor(env = {}) {
    this.child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.js')], {
      env: { ...process.env, SOUND_LAB_MLX_AUTOSTART: 'false', ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pending = new Map(); this.nextId = 1; this.stderr = '';
    this.child.stderr.on('data', d => (this.stderr += d));
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      const msg = JSON.parse(line);
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p(msg); }
    });
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise(resolve => { this.pending.set(id, resolve); this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  }
  notify(method, params) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  async init() {
    const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    this.notify('notifications/initialized');
    return r.result;
  }
  /** Call a tool; returns parsed JSON (or throws with the error text when isError). */
  async call(name, args = {}) {
    const r = await this.request('tools/call', { name, arguments: args });
    if (r.error) { throw new Error(`JSON-RPC error ${r.error.code}: ${r.error.message}`); }
    const text = r.result.content[0].text;
    if (r.result.isError) { const e = new Error(text); e.toolError = true; throw e; }
    return JSON.parse(text);
  }
  async close() {
    this.child.stdin.end();
    await new Promise(r => { if (this.child.exitCode !== null) { r(); } else { this.child.once('exit', r); } });
  }
  kill() { this.child.kill('SIGKILL'); }
}

function tmpdir(prefix = 'slplug-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function ff(args) { return execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); }
function tone(out, secs = 2, freq = 440, extra = []) { ff(['-f', 'lavfi', '-i', `aevalsrc='0.5*sin(2*PI*${freq}*t)':s=48000:d=${secs}`, ...extra, out]); return out; }
function info(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString());
  const a = j.streams.find(s => s.codec_type === 'audio'); const v = j.streams.find(s => s.codec_type === 'video');
  return { duration: +j.format.duration, acodec: a?.codec_name, vcodec: v?.codec_name, sr: +a?.sample_rate, ch: a?.channels, streams: j.streams, tags: j.format.tags || {} };
}
function lufs(file) {
  const r = require('child_process').spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  const j = JSON.parse(r.stderr.slice(r.stderr.lastIndexOf('{'), r.stderr.lastIndexOf('}') + 1));
  return { i: +j.input_i, tp: +j.input_tp };
}

module.exports = { McpClient, tmpdir, ff, tone, info, lufs, ROOT, FIX_BIN };
