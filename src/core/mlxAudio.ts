// mlx-audio integration (no vscode imports): HTTP client for the `mlx_audio.server` OpenAI-style API
// plus lifecycle for the API server and for mlx-audio Studio (the Next.js UI in mlx_audio/ui).
//
// API server modes:
//   native           host Python `mlx_audio.server` → MLX on the Apple GPU (Metal). Fastest on Apple Silicon.
//   docker | podman  Linux image; :cuda12 = pip mlx[cuda12] on NVIDIA (needs --gpus / CDI), :cpu = mlx[cpu].
//                    Containers on macOS cannot reach Metal, so on a Mac they run on the CPU.
//   apple-container  Apple's `container` CLI (macOS 26, Apple silicon): Linux micro-VM, CPU MLX.
//   external         an already-running server at `url`.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, ChildProcess } from 'child_process';

export type MlxMode = 'native' | 'docker' | 'podman' | 'apple-container' | 'external';
export const CONTAINER_NAME = 'soundlab-mlx-audio';
export const CONTAINER_VOICES = '/soundlab/voices';
const CONTAINER_PORT = 8000;

export interface MlxConfig {
  mode: MlxMode;
  url?: string;          // base URL; default http://127.0.0.1:<port>
  port: number;
  image: string;
  gpu: 'none' | 'nvidia';
  python: string;        // for native mode when no `mlx_audio.server` executable is found (see findExecutable)
  hfCache: string;
  logDir: string;
  /** Host folder with voice-clone references; mounted read-only at /soundlab/voices in container modes. */
  voicesDir?: string;
  /** Overrides for the programs Sound Lab spawns (an explicit `mlx_audio.server` setting; fakes in tests). */
  binaries?: Partial<Record<'docker' | 'podman' | 'container' | 'mlx_audio.server' | 'mlx-audio-studio' | 'node' | 'npm' | 'git' | 'tar', string>>;
  /** Directories tried after PATH for native binaries; default WELL_KNOWN_BIN_DIRS (tests inject their own). */
  searchDirs?: readonly string[];
}

export interface Health { reachable: boolean; url: string; loadedModels?: string[]; error?: string; status?: number }
export interface Segment { start: number; end: number; text: string }
export interface Transcript { text: string; language?: string; segments: Segment[] }
export interface Voice { id: string; name: string }

/**
 * Directories tried after PATH for native-mode executables (`mlx_audio.server`, the `mlx-audio-studio` launcher, `node`), in order:
 * Homebrew on Apple silicon, Homebrew on Intel, pip/pipx `--user` installs. VS Code's extension host and launchd-started processes
 * often have a minimal PATH, and an auto-activated conda env can shadow the Homebrew binary.
 */
export const WELL_KNOWN_BIN_DIRS: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
/** Prebuilt Studio bundles installed by the `mlx-audio-studio` Homebrew formula (<prefix>/opt/<formula> is the keg link), in search order. */
export const HOMEBREW_STUDIO_DIRS: readonly string[] = ['/opt/homebrew/opt/mlx-audio-studio/libexec/ui', '/usr/local/opt/mlx-audio-studio/libexec/ui'];

function fileIn(dir: string, cmd: string): string | null {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const e of exts) { const p = path.join(dir, cmd + e); try { if (fs.statSync(p).isFile()) { return p; } } catch { /* next */ } }
  return null;
}

/** PATH lookup. A name with a path separator is returned as it is when it exists. */
export function which(cmd: string): string | null {
  if (cmd.includes('/') || cmd.includes('\\')) { return fs.existsSync(cmd) ? cmd : null; }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) { const p = fileIn(dir, cmd); if (p) { return p; } }
  return null;
}

/**
 * Find a native-mode executable: an explicit path or name wins (used as given), then PATH, then `dirs` (default WELL_KNOWN_BIN_DIRS).
 * Null when nothing is found, so the caller can fall back (e.g. `python -m mlx_audio.server`).
 */
export function findExecutable(name: string, explicit?: string, dirs: readonly string[] = WELL_KNOWN_BIN_DIRS): string | null {
  if (explicit) { return which(explicit) || explicit; }
  const onPath = which(name);
  if (onPath) { return onPath; }
  for (const d of dirs) { const p = fileIn(d, name); if (p) { return p; } }
  return null;
}

/** Accepts verbose_json, json or ndjson bodies from mlx-audio and returns a uniform transcript. */
export function normalizeTranscript(body: string): Transcript {
  let obj: any;
  try { obj = JSON.parse(body); }
  catch {
    let text = ''; let last: any = null;
    for (const line of body.split('\n')) {
      if (!line.trim()) { continue; }
      try { const o = JSON.parse(line); if (o.segments) { last = o; } else if (typeof o.text === 'string') { text += o.text; } } catch { /* skip */ }
    }
    obj = last || { text };
  }
  const raw: any[] = Array.isArray(obj.segments) ? obj.segments : Array.isArray(obj.chunks) ? obj.chunks : [];
  const segments = raw.map(s => {
    const ts = Array.isArray(s.timestamp) ? s.timestamp : null;
    return { start: Number(s.start ?? ts?.[0] ?? 0), end: Number(s.end ?? ts?.[1] ?? 0), text: String(s.text ?? '').trim() };
  }).filter(s => s.text);
  return { text: String(obj.text ?? segments.map(s => s.text).join(' ')).trim(), language: obj.language, segments };
}

export class MlxAudioClient {
  url: string;
  nativeExit?: number;
  private startedMode?: MlxMode;
  private appleUrl?: string | null;

  constructor(public cfg: MlxConfig) {
    this.url = baseUrl(cfg);
  }

  private bin(name: keyof NonNullable<MlxConfig['binaries']>): string { return this.cfg.binaries?.[name] || name; }
  get logFile(): string { return path.join(this.cfg.logDir, 'mlx-audio-server.log'); }
  get pidFile(): string { return path.join(this.cfg.logDir, 'mlx-audio-server.pid'); }

  // ------------------------------------------------------------ HTTP
  async request(pathname: string, init: RequestInit & { signal?: AbortSignal } = {}, timeoutMs = 600_000, base = this.url): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onAbort = () => ac.abort();
    init.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await fetch(base + pathname, { ...init, signal: ac.signal });
    } catch (e) {
      if (init.signal?.aborted) { throw new Error('Cancelled'); }
      const code = (e as { cause?: { code?: string } }).cause?.code;
      throw new Error(`mlx-audio server not reachable at ${base} (${code || (e as Error).message}).`);
    } finally { clearTimeout(timer); init.signal?.removeEventListener('abort', onAbort); }
  }

  async health(base = this.url): Promise<Health> {
    try {
      const r = await this.request('/v1/models', {}, 3000, base);
      if (!r.ok) { return { reachable: false, url: base, status: r.status }; }
      const j = await r.json() as { data?: { id?: string }[] };
      return { reachable: true, url: base, loadedModels: (j.data || []).map(m => m.id || String(m)) };
    } catch (e) { return { reachable: false, url: base, error: (e as Error).message }; }
  }

  async voices(model: string): Promise<Voice[]> {
    const r = await this.request(`/v1/audio/voices?model=${encodeURIComponent(model)}`, {}, 120_000);
    if (!r.ok) { throw new Error(`voices failed (${r.status}): ${(await r.text()).slice(0, 200)}`); }
    const j = await r.json() as { data?: Voice[] };
    return j.data || [];
  }

  async loadModel(model: string, signal?: AbortSignal): Promise<void> {
    const r = await this.request(`/v1/models?model_name=${encodeURIComponent(model)}`, { method: 'POST', signal }, 1_800_000);
    if (!r.ok) { throw new Error(`load ${model} failed (${r.status}): ${(await r.text()).slice(0, 300)}`); }
  }

  async unloadModel(model: string): Promise<void> {
    const r = await this.request(`/v1/models?model_name=${encodeURIComponent(model)}`, { method: 'DELETE' }, 60_000);
    if (!r.ok) { throw new Error(`unload ${model} failed (${r.status}): ${(await r.text()).slice(0, 300)}`); }
  }

  async transcribe(file: string, o: { model: string; language?: string; prompt?: string; wordTimestamps?: boolean; signal?: AbortSignal }): Promise<Transcript> {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
    form.append('model', o.model);
    form.append('response_format', 'verbose_json');
    if (o.language && o.language !== 'auto') { form.append('language', o.language); }
    if (o.prompt) { form.append('prompt', o.prompt); }
    if (o.wordTimestamps) { form.append('word_timestamps', 'true'); }
    const res = await this.request('/v1/audio/transcriptions', { method: 'POST', body: form, signal: o.signal });
    const body = await res.text();
    if (!res.ok) { throw new Error(`mlx-audio transcription failed (${res.status}): ${body.slice(0, 400)}`); }
    return normalizeTranscript(body);
  }

  /** Text → speech bytes. Format: wav | mp3 | flac | ogg | opus. */
  async speech(text: string, o: { model: string; voice?: string; speed?: number; langCode?: string; instruct?: string; format?: string; refAudio?: string; refText?: string; temperature?: number; signal?: AbortSignal }): Promise<Buffer> {
    const payload: Record<string, unknown> = { model: o.model, input: text, response_format: o.format || 'wav' };
    if (o.refAudio) { payload.ref_audio = this.serverPath(o.refAudio); }
    if (o.refText) { payload.ref_text = o.refText; }
    if (o.temperature !== undefined) { payload.temperature = o.temperature; }
    if (o.voice) { payload.voice = o.voice; }
    if (o.speed) { payload.speed = o.speed; }
    if (o.langCode) { payload.lang_code = o.langCode; }
    if (o.instruct) { payload.instruct = o.instruct; }
    const res = await this.request('/v1/audio/speech', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: o.signal });
    if (!res.ok) { throw new Error(`mlx-audio speech failed (${res.status}): ${(await res.text()).slice(0, 400)}`); }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) { throw new Error('mlx-audio speech returned no audio'); }
    return buf;
  }

  /** Source separation → { target, residual } WAV buffers. */
  async separate(file: string, o: { model?: string; description?: string; signal?: AbortSignal }): Promise<{ target: Buffer; residual: Buffer; sampleRate?: number }> {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
    if (o.model) { form.append('model', o.model); }
    form.append('description', o.description || 'speech');
    const res = await this.request('/v1/audio/separations', { method: 'POST', body: form, signal: o.signal }, 3_600_000);
    const body = await res.text();
    if (!res.ok) { throw new Error(`mlx-audio separation failed (${res.status}): ${body.slice(0, 400)}`); }
    const j = JSON.parse(body) as { target?: string; residual?: string; sample_rate?: number };
    if (!j.target || !j.residual) { throw new Error('mlx-audio separation returned no audio'); }
    return { target: Buffer.from(j.target, 'base64'), residual: Buffer.from(j.residual, 'base64'), sampleRate: j.sample_rate };
  }

  private voiceMount(): string[] {
    if (!this.cfg.voicesDir) { return []; }
    fs.mkdirSync(this.cfg.voicesDir, { recursive: true });
    return ['-v', `${this.cfg.voicesDir}:${CONTAINER_VOICES}:ro`];
  }

  /**
   * mlx-audio reads `ref_audio` as a path on the SERVER's filesystem. Native/external(local) servers see host paths;
   * containers see the voices folder at /soundlab/voices.
   */
  serverPath(hostPath: string, mode: MlxMode = this.startedMode || this.cfg.mode): string {
    if ((mode === 'docker' || mode === 'podman' || mode === 'apple-container') && this.cfg.voicesDir) {
      const rel = path.relative(this.cfg.voicesDir, hostPath);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) { return `${CONTAINER_VOICES}/${rel.split(path.sep).join('/')}`; }
      throw new Error(`Reference audio must live in the voices folder (${this.cfg.voicesDir}) to be visible inside the container.`);
    }
    return hostPath;
  }

  // ------------------------------------------------------------ lifecycle
  plan(mode: MlxMode = this.cfg.mode): { cmd: string; args: string[]; note?: string } | null {
    const port = String(this.cfg.port);
    const hf = this.cfg.hfCache;
    switch (mode) {
      case 'native': {
        // explicit setting → PATH → Homebrew's bin and ~/.local/bin → `<python> -m mlx_audio.server`
        const exe = findExecutable('mlx_audio.server', this.cfg.binaries?.['mlx_audio.server'], this.cfg.searchDirs);
        if (exe) { return { cmd: exe, args: ['--host', '127.0.0.1', '--port', port] }; }
        const dirs = this.cfg.searchDirs ?? WELL_KNOWN_BIN_DIRS;
        const python = this.cfg.python || 'python3';
        return { cmd: python, args: ['-m', 'mlx_audio.server', '--host', '127.0.0.1', '--port', port],
          note: `mlx_audio.server not found on PATH${dirs.length ? ` or in ${dirs.join(', ')}` : ''}; falling back to ${python} -m mlx_audio.server. Set the mlx_audio.server path explicitly if it is installed elsewhere.` };
      }
      case 'docker': case 'podman': {
        const gpu = this.cfg.gpu === 'nvidia' ? (mode === 'podman' ? ['--device', 'nvidia.com/gpu=all'] : ['--gpus', 'all']) : [];
        return { cmd: this.bin(mode), args: ['run', '-d', '--rm', '--name', CONTAINER_NAME, '-p', `127.0.0.1:${port}:${CONTAINER_PORT}`, '-v', `${hf}:/root/.cache/huggingface`, ...this.voiceMount(), ...gpu, this.cfg.image] };
      }
      case 'apple-container':
        return { cmd: this.bin('container'), args: ['run', '-d', '--rm', '--name', CONTAINER_NAME, '-p', `127.0.0.1:${port}:${CONTAINER_PORT}`, '-v', `${hf}:/root/.cache/huggingface`, ...this.voiceMount(), this.cfg.image] };
      case 'external':
        return null;
    }
  }

  async start(o: { mode?: MlxMode; wait?: boolean; timeoutMs?: number; signal?: AbortSignal; onLog?: (l: string) => void } = {}): Promise<Health & { started: boolean; command?: string }> {
    const mode = o.mode || this.cfg.mode;
    const already = await this.health();
    if (already.reachable) { return { ...already, started: false }; }
    if (mode === 'external') { throw new Error(`No mlx-audio server answers at ${this.url} and the mode is "external". Start it yourself or pick another mode.`); }
    fs.mkdirSync(this.cfg.logDir, { recursive: true });
    const p = this.plan(mode)!;
    o.onLog?.(`$ ${p.cmd} ${p.args.join(' ')}`);
    if (p.note) { o.onLog?.(p.note); }
    if (mode === 'native') {
      const log = fs.openSync(this.logFile, 'a');
      const child = spawn(p.cmd, p.args, { detached: true, stdio: ['ignore', log, log], env: process.env, windowsHide: true });
      await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('spawn', () => resolve()); });
      this.nativeExit = undefined;
      child.once('exit', code => { this.nativeExit = code ?? -1; });
      child.unref();
      fs.writeFileSync(this.pidFile, String(child.pid));
    } else {
      fs.mkdirSync(this.cfg.hfCache, { recursive: true });
      spawnSync(p.cmd, mode === 'apple-container' ? ['delete', '--force', CONTAINER_NAME] : ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore', timeout: 30_000 });
      const r = spawnSync(p.cmd, p.args, { encoding: 'utf8', timeout: 900_000 });
      if (r.error) { throw new Error(`${p.cmd} is not available: ${r.error.message}`); }
      if (r.status !== 0) { throw new Error(`${path.basename(p.cmd)} run failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`); }
    }
    this.startedMode = mode; this.appleUrl = null;
    const h = o.wait === false ? await this.health() : await this.waitReady(o.timeoutMs ?? 180_000, o.signal);
    return { ...h, started: true, command: [p.cmd, ...p.args].join(' ') };
  }

  async waitReady(timeoutMs: number, signal?: AbortSignal): Promise<Health> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (signal?.aborted) { throw new Error('Cancelled'); }
      if (this.nativeExit !== undefined) { break; }
      const h = await this.health();
      if (h.reachable) { return h; }
      if (this.startedMode === 'apple-container') {
        // Apple containers get their own VM IP; use it when the published localhost port isn't answering.
        this.appleUrl = this.appleUrl ?? this.appleContainerUrl();
        if (this.appleUrl && (await this.health(this.appleUrl)).reachable) { this.url = this.appleUrl; return this.health(); }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    const logs = this.logs(this.startedMode || this.cfg.mode, 12);
    const hint = /libcuda\.so|CUDA driver|no CUDA-capable device/i.test(logs)
      ? ' The :cuda12 image (mlx[cuda12]) needs an NVIDIA GPU and driver on the host. Use the :cpu image, or mode "native" on Apple Silicon.'
      : /No module named 'uvicorn'|No module named uvicorn/.test(logs) ? ' Install the server extras: pip install "mlx-audio[server]".'
        : /No module named/.test(logs) ? ' Install mlx-audio: pip install "mlx-audio[server]".' : '';
    throw new Error(`mlx-audio server did not become ready at ${this.url}.${hint}${logs ? `\n${logs}` : ''}`);
  }

  appleContainerUrl(): string | null {
    const r = spawnSync(this.bin('container'), ['inspect', CONTAINER_NAME], { encoding: 'utf8', timeout: 15_000 });
    const m = /"address"\s*:\s*"(\d+\.\d+\.\d+\.\d+)/.exec(r.stdout || '') || /(\d+\.\d+\.\d+\.\d+)\/\d+/.exec(r.stdout || '');
    return m ? `http://${m[1]}:${CONTAINER_PORT}` : null;
  }

  stop(mode: MlxMode = this.startedMode || this.cfg.mode): { stopped: boolean; detail: string } {
    if (mode === 'native') {
      let pid: number;
      try { pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'), 10); } catch { return { stopped: false, detail: 'not started by Sound Lab' }; }
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
      fs.rmSync(this.pidFile, { force: true });
      return { stopped: true, detail: `pid ${pid}` };
    }
    if (mode === 'external') { return { stopped: false, detail: 'external server — not managed by Sound Lab' }; }
    const r = spawnSync(this.bin(mode === 'apple-container' ? 'container' : mode), ['stop', CONTAINER_NAME], { encoding: 'utf8', timeout: 60_000 });
    return { stopped: r.status === 0, detail: (r.stderr || r.stdout || '').trim().slice(0, 300) };
  }

  logs(mode: MlxMode = this.cfg.mode, lines = 60): string {
    if (mode === 'native') { try { return fs.readFileSync(this.logFile, 'utf8').split('\n').slice(-lines).join('\n').trim(); } catch { return ''; } }
    if (mode === 'external') { return ''; }
    const r = spawnSync(this.bin(mode === 'apple-container' ? 'container' : mode), ['logs', CONTAINER_NAME], { encoding: 'utf8', timeout: 15_000 });
    return ((r.stdout || '') + (r.stderr || '')).split('\n').slice(-lines).join('\n').trim();
  }
}

export function baseUrl(cfg: Pick<MlxConfig, 'url' | 'port'>): string {
  return (cfg.url || `http://127.0.0.1:${cfg.port}`).replace(/\/+$/, '').replace(/\/v1$/, '');
}

// ---------------------------------------------------------------- Studio (mlx-audio's Next.js UI, mlx_audio/ui)
//
// Two kinds of Studio folder:
//   dev       a checkout of mlx_audio/ui (package.json + app/): `npm install` once, then `next dev` with the API address in NEXT_PUBLIC_*.
//   prebuilt  a standalone production build (server.js + .next/), as installed by the `mlx-audio-studio` Homebrew formula under
//             <prefix>/opt/mlx-audio-studio/libexec/ui. Its API base URL is compiled into the build (studio.json "api"), so a bundle
//             is only used when that address is Sound Lab's API address. It runs through its launcher script, else `node server.js`.

export type StudioKind = 'dev' | 'prebuilt';

/** studio.json of a prebuilt bundle: "api" = API base URL compiled into the build, "launcher" = absolute path of the launcher script. */
export interface StudioManifest { name?: string; version?: string; api?: string; launcher?: string }

export interface StudioConfig {
  path?: string;          // explicit Studio folder (dev checkout or prebuilt bundle)
  port: number;           // Studio port (mlx-audio's own launcher uses 3000)
  apiBase: string;        // browser-visible API base, e.g. http://localhost
  apiPort: number;        // browser-visible API port
  python: string;
  storageDir: string;     // where a downloaded copy of the UI lives
  binaries?: MlxConfig['binaries'];  // npm/git/tar for a dev checkout; 'mlx-audio-studio' (launcher) and 'node' for a prebuilt bundle
  repo?: string;          // default Blaizzy/mlx-audio
  ref?: string;           // default main
  searchDirs?: readonly string[];   // tried after PATH for the launcher and node; default WELL_KNOWN_BIN_DIRS (tests inject)
  bundleDirs?: readonly string[];   // prebuilt bundles tried after the launcher's own; default HOMEBREW_STUDIO_DIRS (tests inject)
}

/** 'dev' for a checkout (package.json + app/), 'prebuilt' for a standalone build (server.js + .next/), null for anything else. */
export function studioKind(dir?: string | null): StudioKind | null {
  if (!dir) { return null; }
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  return has('server.js') && has('.next') ? 'prebuilt' : has('package.json') && has('app') ? 'dev' : null;
}

export function readStudioManifest(dir: string): StudioManifest | null {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'studio.json'), 'utf8')); return j && typeof j === 'object' ? j as StudioManifest : null; } catch { return null; }
}

function isExecutable(file: string): boolean {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}

export class StudioManager {
  private child?: ChildProcess;
  exited?: number;
  /** Why the last locate() skipped candidates (e.g. a Homebrew bundle built for another API address); for the log and the dialog. */
  lastLocateNote?: string;
  constructor(public cfg: StudioConfig) {}

  get url(): string { return `http://localhost:${this.cfg.port}`; }
  /** The API address as the Studio's browser code must see it; a prebuilt bundle's studio.json "api" has to spell it the same way. */
  get apiUrl(): string { return `${this.cfg.apiBase}:${this.cfg.apiPort}`; }
  get downloadDir(): string { return path.join(this.cfg.storageDir, 'mlx-audio-studio'); }
  private bin(n: 'npm' | 'git' | 'tar'): string { return this.cfg.binaries?.[n] || (process.platform === 'win32' && n === 'npm' ? 'npm.cmd' : n); }

  /** Prebuilt bundle candidates: ../libexec/ui next to the real `mlx-audio-studio` launcher, then the Homebrew keg paths (existing, deduplicated). */
  bundleCandidates(): string[] {
    const dirs: string[] = [];
    const launcher = findExecutable('mlx-audio-studio', this.cfg.binaries?.['mlx-audio-studio'], this.cfg.searchDirs);
    if (launcher) { try { dirs.push(path.join(path.dirname(fs.realpathSync(launcher)), '..', 'libexec', 'ui')); } catch { /* dangling link */ } }
    dirs.push(...(this.cfg.bundleDirs ?? HOMEBREW_STUDIO_DIRS));
    const seen = new Set<string>();
    return dirs.filter(d => { try { const real = fs.realpathSync(d); return seen.has(real) ? false : !!seen.add(real); } catch { return false; } });
  }

  /** Find a Studio: explicit setting → Homebrew prebuilt bundle → `ui` inside the mlx_audio package (editable install) → previous download. */
  locate(): string | null {
    const notes: string[] = [];
    const dir = this.find(notes);
    this.lastLocateNote = notes.length ? notes.join('\n') : undefined;
    return dir;
  }

  private find(notes: string[]): string | null {
    const usable = (dir: string, label: string, trustWithoutManifest = false): boolean => {
      if (studioKind(dir) !== 'prebuilt') { return true; }
      const m = readStudioManifest(dir);
      if (!m?.api) {
        if (trustWithoutManifest) { return true; }
        notes.push(`${label} (${dir}) has no studio.json naming the API address it was built for; skipped.`);
        return false;
      }
      if (m.api.trim().replace(/\/+$/, '') === this.apiUrl) { return true; }
      notes.push(`${label} is built for ${m.api}, Sound Lab's API is ${this.apiUrl} (${dir}); skipped because the API address is compiled into the build.`);
      return false;
    };
    const explicit = this.cfg.path;
    if (explicit && !studioKind(explicit)) { notes.push(`The configured Studio folder ${explicit} is not a Studio (needs package.json + app/, or server.js + .next/); ignored.`); }
    if (studioKind(explicit) && usable(explicit!, 'The configured Studio', true)) { return explicit!; }
    for (const dir of this.bundleCandidates()) { if (studioKind(dir) === 'prebuilt' && usable(dir, 'Homebrew Studio')) { return dir; } }
    const r = spawnSync(this.cfg.python, ['-c', 'import mlx_audio, pathlib; print(pathlib.Path(mlx_audio.__file__).parent / "ui")'], { encoding: 'utf8', timeout: 20_000 });
    const fromPkg = (r.stdout || '').trim();
    if (r.status === 0 && studioKind(fromPkg) && usable(fromPkg, 'The Studio in the mlx_audio package')) { return fromPkg; }
    const dl = path.join(this.downloadDir, 'mlx_audio', 'ui');
    return studioKind(dl) && usable(dl, 'The downloaded Studio') ? dl : null;
  }

  /** Sparse-clone just mlx_audio/ui (git), falling back to a GitHub tarball (tar). */
  download(onLog?: (l: string) => void): string {
    const repo = this.cfg.repo || 'Blaizzy/mlx-audio';
    const ref = this.cfg.ref || 'main';
    fs.rmSync(this.downloadDir, { recursive: true, force: true });
    fs.mkdirSync(this.cfg.storageDir, { recursive: true });
    const git = which(this.bin('git'));
    if (git) {
      const steps: string[][] = [
        ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', ref, `https://github.com/${repo}`, this.downloadDir],
        ['-C', this.downloadDir, 'sparse-checkout', 'set', 'mlx_audio/ui'],
      ];
      for (const s of steps) {
        onLog?.(`$ git ${s.join(' ')}`);
        const r = spawnSync(git, s, { encoding: 'utf8', timeout: 600_000 });
        if (r.status !== 0) { throw new Error(`git ${s[0] === '-C' ? 'sparse-checkout' : 'clone'} failed: ${(r.stderr || '').trim().slice(-300)}`); }
      }
    } else {
      const tar = which(this.bin('tar'));
      if (!tar) { throw new Error('Downloading Studio needs git or tar on PATH.'); }
      const url = `https://codeload.github.com/${repo}/tar.gz/refs/heads/${ref}`;
      onLog?.(`$ curl ${url} | tar -xz '*/mlx_audio/ui/*'`);
      fs.mkdirSync(this.downloadDir, { recursive: true });
      const r = spawnSync('sh', ['-c', `curl -fsSL "${url}" | "${tar}" -xz --strip-components=1 -C "${this.downloadDir}" --wildcards '*/mlx_audio/ui/*'`], { encoding: 'utf8', timeout: 600_000 });
      if (r.status !== 0) { throw new Error(`Studio download failed: ${(r.stderr || '').trim().slice(-300)}`); }
    }
    const ui = path.join(this.downloadDir, 'mlx_audio', 'ui');
    if (!fs.existsSync(path.join(ui, 'package.json'))) { throw new Error(`Downloaded ${repo}@${ref} but mlx_audio/ui is missing.`); }
    return ui;
  }

  async reachable(): Promise<boolean> {
    try { const r = await fetch(this.url, { signal: AbortSignal.timeout(3000) }); return r.status < 500; } catch { return false; }
  }

  /**
   * Dev checkout: npm install (first time) then `next dev -p <port>` with the API location baked into NEXT_PUBLIC_*.
   * Prebuilt bundle: no npm; the launcher named in studio.json (--port/--host), else `node server.js`, with PORT and HOSTNAME set.
   */
  async start(dir: string, o: { onLog?: (l: string) => void; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ url: string; started: boolean }> {
    if (await this.reachable()) { return { url: this.url, started: false }; }
    const kind = studioKind(dir) || 'dev';
    const port = String(this.cfg.port);
    let cmd: string, args: string[], env: NodeJS.ProcessEnv;
    if (kind === 'prebuilt') {
      const m = readStudioManifest(dir);
      const launcher = m?.launcher && isExecutable(m.launcher) ? m.launcher : null;
      const node = findExecutable('node', this.cfg.binaries?.node, this.cfg.searchDirs) || 'node';
      [cmd, args] = launcher ? [launcher, ['--port', port, '--host', '127.0.0.1']] : [node, ['server.js']];
      env = { ...process.env, PORT: port, HOSTNAME: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1' };
      o.onLog?.(`$ ${cmd} ${args.join(' ')}   (prebuilt Studio in ${dir}${m?.api ? `, built for API ${m.api}` : ''})`);
    } else {
      const npm = this.bin('npm');
      const stamp = path.join(dir, 'node_modules', '.soundlab-installed');
      if (!fs.existsSync(stamp)) {
        o.onLog?.(`$ npm install   (in ${dir})`);
        await runStreaming(npm, ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir, process.env, o.onLog, o.signal, 1_800_000);
        fs.writeFileSync(stamp, new Date().toISOString());
      }
      [cmd, args] = [npm, ['exec', '--', 'next', 'dev', '-p', port]];
      env = { ...process.env, PORT: port, NEXT_PUBLIC_API_BASE_URL: this.cfg.apiBase, NEXT_PUBLIC_API_PORT: String(this.cfg.apiPort), NEXT_TELEMETRY_DISABLED: '1', BROWSER: 'none' };
      o.onLog?.(`$ npx next dev -p ${port}   (API ${this.apiUrl})`);
    }
    this.exited = undefined;
    let failure: Error | undefined;
    const child = this.child = spawn(cmd, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    const pipe = (d: Buffer) => d.toString().split(/\r?\n/).filter(Boolean).forEach(l => o.onLog?.(l));
    child.stdout?.on('data', pipe); child.stderr?.on('data', pipe);
    const done = (code: number) => { this.exited = code; if (this.child === child) { this.child = undefined; } };
    child.once('error', e => { failure = e; done(-1); });
    child.once('exit', c => done(c ?? -1));
    const until = Date.now() + (o.timeoutMs ?? 240_000);
    while (Date.now() < until) {
      if (o.signal?.aborted) { this.stop(); throw new Error('Cancelled'); }
      if (this.exited !== undefined) {
        throw new Error(failure ? `Could not start mlx-audio Studio (${cmd}): ${failure.message}` : `Studio ${kind === 'prebuilt' ? 'server' : 'dev server'} exited with code ${this.exited}. See the Sound Lab log.`);
      }
      if (await this.reachable()) { return { url: this.url, started: true }; }
      await new Promise(r => setTimeout(r, 1000));
    }
    this.stop();
    throw new Error(`Studio did not start on ${this.url} in time.`);
  }

  get running(): boolean { return !!this.child; }

  /** Kills the Studio's process group (launcher + node, or npm + next), like a Ctrl-C in its terminal. */
  stop(): boolean {
    const c = this.child;
    if (!c?.pid) { return false; }
    try { process.platform === 'win32' ? spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F']) : process.kill(-c.pid, 'SIGTERM'); }
    catch { try { c.kill('SIGTERM'); } catch { /* gone */ } }
    this.child = undefined;
    return true;
  }
}

function runStreaming(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, onLog?: (l: string) => void, signal?: AbortSignal, timeoutMs = 600_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let tail = '';
    const on = (d: Buffer) => { const t = d.toString(); tail = (tail + t).slice(-2000); t.split(/\r?\n/).filter(Boolean).forEach(l => onLog?.(l)); };
    c.stdout.on('data', on); c.stderr.on('data', on);
    const timer = setTimeout(() => c.kill(), timeoutMs);
    const abort = () => c.kill();
    signal?.addEventListener('abort', abort, { once: true });
    c.on('error', e => { clearTimeout(timer); reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`${cmd} not found — install Node.js/npm to run mlx-audio Studio.`) : e); });
    c.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (signal?.aborted) { reject(new Error('Cancelled')); } else if (code === 0) { resolve(); } else { reject(new Error(`${cmd} ${args[0]} failed (exit ${code}): ${tail.trim().split('\n').slice(-4).join(' | ')}`)); }
    });
  });
}
