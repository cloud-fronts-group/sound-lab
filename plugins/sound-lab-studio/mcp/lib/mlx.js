'use strict';
// Client + lifecycle for an MLX audio inference service (mlx-audio's OpenAI-compatible server, `mlx_audio.server`).
//
// The same HTTP API is served from wherever you run it. Pick the mode by hardware:
//   native           host Python on macOS → MLX on the Apple GPU (Metal). Fastest on Apple Silicon.
//   docker / podman  Linux container. Image tag :cuda12 = `mlx[cuda12]` on NVIDIA GPUs (needs --gpus / CDI);
//                    tag :cpu = `mlx[cpu]`. Containers on macOS never see Metal, so on a Mac they run on the CPU.
//   apple-container  Apple's `container` CLI (macOS 26, Apple silicon): Linux micro-VM, CPU MLX.
//   external         any already-running server at `url` (another machine, a GPU box, a sidecar).
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CONTAINER_NAME = 'soundlab-mlx-audio';
const CONTAINER_PORT = 8000;

class MlxService {
  /**
   * @param {{mode: string, url: string, port: number, image: string, gpu: string, hfCache: string, dataDir: string,
   *          sttModel: string, ttsModel: string, ttsVoice: string, binaries?: Record<string,string>, which: (c:string)=>string|null}} cfg
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.url = (cfg.url || `http://127.0.0.1:${cfg.port || 8000}`).replace(/\/+$/, '').replace(/\/v1$/, '');
    this.pidFile = path.join(cfg.dataDir, 'mlx-server.pid');
    this.logFile = path.join(cfg.dataDir, 'mlx-server.log');
  }

  bin(name) { return this.cfg.binaries?.[name] || name; }

  // ---------------------------------------------------------------- HTTP
  async request(pathname, init = {}, timeoutMs = 600000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const onAbort = () => ac.abort();
    init.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(this.url + pathname, { ...init, signal: ac.signal });
      return res;
    } catch (e) {
      if (init.signal?.aborted) { throw new Error('Cancelled'); }
      throw new Error(`MLX audio service not reachable at ${this.url} (${e.cause?.code || e.message}). Start it with the mlx_service tool (action "start").`);
    } finally { clearTimeout(t); init.signal?.removeEventListener('abort', onAbort); }
  }

  async health(base) {
    const saved = this.url;
    if (base) { this.url = base; }
    try {
      const r = await this.request('/v1/models', {}, 3000);
      if (!r.ok) { return { reachable: false, url: this.url, status: r.status }; }
      const j = await r.json();
      return { reachable: true, url: this.url, loadedModels: (j.data || []).map(m => m.id || m) };
    } catch (e) { return { reachable: false, url: this.url, error: e.message }; }
    finally { if (base) { this.url = saved; } }
  }

  async waitReady(timeoutMs = 120000, signal) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (signal?.aborted) { throw new Error('Cancelled'); }
      if (this.nativeExit !== undefined) { break; } // native server process died — no point waiting
      const h = await this.health();
      if (h.reachable) { return h; }
      // Apple `container` gives each container its own VM IP; use it if the published localhost port isn't answering.
      if (this.startedMode === 'apple-container') {
        this.appleUrl = this.appleUrl || this.appleContainerUrl();
        if (this.appleUrl && (await this.health(this.appleUrl)).reachable) { this.url = this.appleUrl; return this.health(); }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    const logs = this.logs(this.cfg.mode, 12);
    const hint = /libcuda\.so|CUDA driver|no CUDA-capable device/i.test(logs)
      ? ' The :cuda12 image needs an NVIDIA GPU + driver on the host (NVIDIA Container Toolkit, mlx_gpu "nvidia"). Use the :cpu image (mlx_gpu "none") or mode "native" on Apple Silicon.'
      : /No module named|ModuleNotFoundError/.test(logs) ? ' Install the server extras: pip install "mlx-audio[server]".' : '';
    throw new Error(`MLX audio service did not become ready at ${this.url} within ${Math.round(timeoutMs / 1000)} s.${hint}\nRecent log:\n${logs}`);
  }

  /** Speech → text. Returns { text, language, segments:[{start,end,text}] }. */
  async transcribe(file, { model, language, prompt, wordTimestamps, signal } = {}) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
    form.append('model', model || this.cfg.sttModel);
    form.append('response_format', 'verbose_json');
    if (language && language !== 'auto') { form.append('language', language); }
    if (prompt) { form.append('prompt', prompt); }
    if (wordTimestamps) { form.append('word_timestamps', 'true'); }
    const res = await this.request('/v1/audio/transcriptions', { method: 'POST', body: form, signal });
    const body = await res.text();
    if (!res.ok) { throw new Error(`MLX transcription failed (${res.status}): ${body.slice(0, 400)}`); }
    return normalizeTranscript(body);
  }

  /** Text → speech, written to `out`. Format follows the extension (wav/mp3/flac/ogg/opus). */
  async synthesize(text, out, { model, voice, speed, langCode, refAudio, refText, instruct, signal } = {}) {
    const fmt = (path.extname(out).slice(1) || 'wav').toLowerCase();
    const payload = { model: model || this.cfg.ttsModel, input: text, response_format: fmt };
    if (voice || this.cfg.ttsVoice) { payload.voice = voice || this.cfg.ttsVoice; }
    if (speed) { payload.speed = speed; }
    if (langCode) { payload.lang_code = langCode; }
    if (refAudio) { payload.ref_audio = refAudio; }
    if (refText) { payload.ref_text = refText; }
    if (instruct) { payload.instruct = instruct; }
    const res = await this.request('/v1/audio/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal });
    if (!res.ok) { throw new Error(`MLX speech synthesis failed (${res.status}): ${(await res.text()).slice(0, 400)}`); }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) { throw new Error('MLX speech synthesis returned no audio'); }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    return { file: out, bytes: buf.length };
  }

  /** Source separation (e.g. "speech" vs everything else) → two WAV files. */
  async separate(file, outTarget, outResidual, { model, description, signal } = {}) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
    if (model) { form.append('model', model); }
    form.append('description', description || 'speech');
    const res = await this.request('/v1/audio/separations', { method: 'POST', body: form, signal }, 1800000);
    const body = await res.text();
    if (!res.ok) { throw new Error(`MLX separation failed (${res.status}): ${body.slice(0, 400)}`); }
    const j = JSON.parse(body);
    if (!j.target || !j.residual) { throw new Error('MLX separation response had no target/residual audio'); }
    fs.mkdirSync(path.dirname(outTarget), { recursive: true });
    fs.writeFileSync(outTarget, Buffer.from(j.target, 'base64'));
    fs.writeFileSync(outResidual, Buffer.from(j.residual, 'base64'));
    return { target: outTarget, residual: outResidual, sampleRate: j.sample_rate };
  }

  // ---------------------------------------------------------------- lifecycle
  /** Commands that `start` would run, without running them (also used for dry runs / docs). */
  plan(mode = this.cfg.mode) {
    const port = String(this.cfg.port || 8000);
    const hf = this.cfg.hfCache;
    switch (mode) {
      case 'native': {
        const exe = this.cfg.which('mlx_audio.server');
        return exe ? { cmd: exe, args: ['--host', '127.0.0.1', '--port', port] }
          : { cmd: this.bin('python3'), args: ['-m', 'mlx_audio.server', '--host', '127.0.0.1', '--port', port] };
      }
      case 'docker': case 'podman': {
        const gpu = this.cfg.gpu === 'nvidia' ? (mode === 'podman' ? ['--device', 'nvidia.com/gpu=all'] : ['--gpus', 'all']) : [];
        return { cmd: this.bin(mode), args: ['run', '-d', '--rm', '--name', CONTAINER_NAME, '-p', `127.0.0.1:${port}:${CONTAINER_PORT}`, '-v', `${hf}:/root/.cache/huggingface`, ...gpu, this.cfg.image] };
      }
      case 'apple-container':
        return { cmd: this.bin('container'), args: ['run', '-d', '--rm', '--name', CONTAINER_NAME, '-p', `127.0.0.1:${port}:${CONTAINER_PORT}`, '-v', `${hf}:/root/.cache/huggingface`, this.cfg.image] };
      case 'external':
        return null;
      default:
        throw new Error(`Unknown MLX service mode "${mode}" (native, docker, podman, apple-container, external)`);
    }
  }

  async start({ mode = this.cfg.mode, wait = true, signal } = {}) {
    const already = await this.health();
    if (already.reachable) { return { started: false, alreadyRunning: true, mode, ...already }; }
    if (mode === 'external') { throw new Error(`No MLX audio service answering at ${this.url} and mode is "external" — start it yourself or switch mode.`); }
    fs.mkdirSync(this.cfg.dataDir, { recursive: true });
    if (mode !== 'native') { fs.mkdirSync(this.cfg.hfCache, { recursive: true }); }
    const p = this.plan(mode);
    if (mode === 'native') {
      const log = fs.openSync(this.logFile, 'a');
      const child = spawn(p.cmd, p.args, { detached: true, stdio: ['ignore', log, log], env: process.env });
      await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
      this.nativeExit = undefined;
      child.once('exit', code => { this.nativeExit = code ?? -1; });
      child.unref();
      fs.writeFileSync(this.pidFile, String(child.pid));
    } else {
      // Remove a stale stopped container with the same name, then start.
      spawnSync(p.cmd, mode === 'apple-container' ? ['delete', '--force', CONTAINER_NAME] : ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore', timeout: 30000 });
      const r = spawnSync(p.cmd, p.args, { encoding: 'utf8', timeout: 600000 });
      if (r.error) { throw new Error(`${p.cmd} not available: ${r.error.message}`); }
      if (r.status !== 0) { throw new Error(`${p.cmd} run failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`); }
    }
    this.startedMode = mode; this.appleUrl = null;
    const h = wait ? await this.waitReady(this.cfg.startTimeoutMs || 180000, signal) : await this.health();
    return { started: true, mode, command: [p.cmd, ...p.args].join(' '), ...h };
  }

  /** VM address of the Apple container (from `container inspect`), or null. */
  appleContainerUrl() {
    const r = spawnSync(this.bin('container'), ['inspect', CONTAINER_NAME], { encoding: 'utf8', timeout: 15000 });
    const m = /"address"\s*:\s*"(\d+\.\d+\.\d+\.\d+)/.exec(r.stdout || '') || /(\d+\.\d+\.\d+\.\d+)\/\d+/.exec(r.stdout || '');
    return m ? `http://${m[1]}:${CONTAINER_PORT}` : null;
  }

  async stop(mode = this.cfg.mode) {
    if (mode === 'native') {
      let pid; try { pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'), 10); } catch { return { stopped: false, reason: 'no pid file (not started by Sound Lab)' }; }
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      fs.rmSync(this.pidFile, { force: true });
      return { stopped: true, pid };
    }
    if (mode === 'external') { return { stopped: false, reason: 'external service is not managed by Sound Lab' }; }
    const cmd = this.bin(mode === 'apple-container' ? 'container' : mode);
    const r = spawnSync(cmd, ['stop', CONTAINER_NAME], { encoding: 'utf8', timeout: 60000 });
    return { stopped: r.status === 0, output: (r.stderr || r.stdout || '').trim().slice(0, 300) };
  }

  logs(mode = this.cfg.mode, lines = 60) {
    if (mode === 'native') {
      try { return fs.readFileSync(this.logFile, 'utf8').split('\n').slice(-lines).join('\n'); } catch { return '(no log yet)'; }
    }
    if (mode === 'external') { return '(external service — logs live wherever it runs)'; }
    const cmd = this.bin(mode === 'apple-container' ? 'container' : mode);
    const r = spawnSync(cmd, ['logs', CONTAINER_NAME], { encoding: 'utf8', timeout: 15000 });
    return ((r.stdout || '') + (r.stderr || '')).split('\n').slice(-lines).join('\n');
  }
}

/** Accepts verbose_json, json, or ndjson bodies from mlx-audio and returns {text, language, segments}. */
function normalizeTranscript(body) {
  let obj;
  try { obj = JSON.parse(body); }
  catch {
    // ndjson: accumulate text; keep the last object that has segments
    let text = '', last = null;
    for (const line of body.split('\n')) {
      if (!line.trim()) { continue; }
      try { const o = JSON.parse(line); if (o.segments) { last = o; } else if (typeof o.text === 'string') { text += o.text; } } catch { /* skip */ }
    }
    obj = last || { text };
  }
  const raw = Array.isArray(obj.segments) ? obj.segments : Array.isArray(obj.chunks) ? obj.chunks : [];
  const segments = raw.map(s => {
    const ts = Array.isArray(s.timestamp) ? s.timestamp : null;
    return { start: Number(s.start ?? ts?.[0] ?? 0), end: Number(s.end ?? ts?.[1] ?? 0), text: String(s.text ?? '').trim() };
  }).filter(s => s.text);
  return { text: String(obj.text ?? segments.map(s => s.text).join(' ')).trim(), language: obj.language, segments };
}

module.exports = { MlxService, normalizeTranscript, CONTAINER_NAME };
