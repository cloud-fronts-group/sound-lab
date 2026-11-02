// VS Code glue for mlx-audio: settings → client, status bar, server/Studio lifecycle, MLX commands.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MlxAudioClient, MlxMode, StudioManager, Health } from './core/mlxAudio';
import { cfg, job, log, logLine, state, storageDir, resolveTargets, outputFor, uniquePath, announce, openMedia, summaryOf } from './util';

export const STT_MODELS = ['mlx-community/whisper-large-v3-turbo', 'mlx-community/whisper-small-mlx', 'mlx-community/whisper-tiny', 'mlx-community/parakeet-tdt-0.6b-v2', 'mlx-community/distil-whisper-large-v3'];
export const TTS_MODELS = ['mlx-community/Kokoro-82M-bf16', 'mlx-community/chatterbox-turbo-4bit', 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit', 'mlx-community/csm-1b-8bit', 'mlx-community/Spark-TTS-0.5B-bf16'];
/** Models that accept a reference voice (ref_audio / ref_text) for zero-shot cloning. */
export const CLONE_MODELS = [
  { id: 'mlx-community/chatterbox-turbo-4bit', label: 'Chatterbox Turbo (4-bit)', note: 'fast, English, expressive' },
  { id: 'mlx-community/chatterbox-multilingual-v3', label: 'Chatterbox Multilingual', note: '20+ languages' },
  { id: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit', label: 'Qwen3-TTS 1.7B Base (8-bit)', note: 'high quality, multilingual' },
  { id: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit', label: 'Qwen3-TTS 0.6B Base (8-bit)', note: 'lighter Qwen3-TTS' },
  { id: 'mlx-community/csm-1b-8bit', label: 'Sesame CSM 1B (8-bit)', note: 'conversational' },
  { id: 'mlx-community/Spark-TTS-0.5B-bf16', label: 'Spark-TTS 0.5B', note: 'small' },
  { id: 'mlx-community/Llama-OuteTTS-1.0-1B-4bit', label: 'OuteTTS 1.0 1B (4-bit)', note: 'multilingual' },
];

export type MlxState = { health: Health; mode: MlxMode; starting: boolean; studio: { running: boolean; url: string; found: boolean } };

export class MlxController implements vscode.Disposable {
  client!: MlxAudioClient;
  studio!: StudioManager;
  readonly status: vscode.StatusBarItem;
  private timer?: NodeJS.Timeout;
  private starting?: Promise<MlxAudioClient>;
  private last: Health = { reachable: false, url: '' };
  private readonly emitter = new vscode.EventEmitter<MlxState>();
  readonly onDidChange = this.emitter.event;
  private disposables: vscode.Disposable[] = [];

  constructor(private ctx: vscode.ExtensionContext) {
    this.status = vscode.window.createStatusBarItem('soundLab.mlx', vscode.StatusBarAlignment.Right, 49);
    this.status.name = 'Sound Lab: mlx-audio server';
    this.status.command = 'soundLab.mlxStatus';
    this.configure();
    this.disposables.push(this.status, this.emitter, vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('soundLab.mlx')) { this.configure(); this.refresh(); }
    }));
    if (cfg().get<boolean>('mlx.showStatusBar') !== false) { this.status.show(); }
    this.refresh();
    this.timer = setInterval(() => { if (vscode.window.state.focused) { this.refresh(); } }, 10_000);
    this.timer.unref?.();
  }

  get mode(): MlxMode {
    const m = cfg().get<string>('mlx.mode') || 'auto';
    return (m === 'auto' ? (process.platform === 'darwin' && process.arch === 'arm64' ? 'native' : 'docker') : m) as MlxMode;
  }
  get voicesDir(): string { return storageDir('voices'); }
  sttModel(): string { return cfg().get<string>('mlx.sttModel') || STT_MODELS[0]; }
  ttsModel(): string { return cfg().get<string>('mlx.ttsModel') || TTS_MODELS[0]; }
  cloneModel(): string { return cfg().get<string>('mlx.cloneModel') || CLONE_MODELS[0].id; }

  private configure(): void {
    const c = cfg();
    const port = c.get<number>('mlx.port') || 8000;
    const gpu = (c.get<string>('mlx.gpu') || 'none') as 'none' | 'nvidia';
    this.client = new MlxAudioClient({
      mode: this.mode, url: c.get<string>('mlx.url') || undefined, port,
      image: c.get<string>('mlx.image') || `ghcr.io/cloud-fronts-group/sound-lab-mlx-audio:${gpu === 'nvidia' ? 'cuda12' : 'cpu'}`,
      gpu, python: c.get<string>('mlx.python') || 'python3',
      hfCache: path.join(os.homedir(), '.cache', 'huggingface'), logDir: storageDir('mlx'), voicesDir: this.voicesDir,
    });
    const api = new URL(this.client.url);
    this.studio?.stop();
    this.studio = new StudioManager({
      path: c.get<string>('mlx.studio.path') || undefined, port: c.get<number>('mlx.studio.port') || 3000,
      apiBase: `${api.protocol}//${api.hostname === '127.0.0.1' ? 'localhost' : api.hostname}`, apiPort: parseInt(api.port || '80', 10),
      python: c.get<string>('mlx.python') || 'python3', storageDir: storageDir(),
    });
  }

  snapshot(): MlxState {
    return { health: this.last, mode: this.mode, starting: !!this.starting, studio: { running: this.studio.running, url: this.studio.url, found: false } };
  }

  async refresh(): Promise<Health> {
    this.last = await this.client.health();
    const h = this.last;
    if (this.starting) { this.status.text = '$(loading~spin) MLX'; this.status.tooltip = 'Starting the mlx-audio server…'; }
    else if (h.reachable) {
      this.status.text = `$(radio-tower) MLX${h.loadedModels?.length ? ` · ${h.loadedModels.length}` : ''}`;
      this.status.tooltip = new vscode.MarkdownString(`**mlx-audio server** — running (${this.mode})\n\n${h.url}\n\n${h.loadedModels?.length ? h.loadedModels.map(m => `- \`${m}\``).join('\n') : '_no models loaded yet_'}\n\nClick for actions`);
      this.status.backgroundColor = undefined;
    } else {
      this.status.text = '$(circle-slash) MLX';
      this.status.tooltip = `mlx-audio server not running (${this.mode}). Click to start.`;
    }
    this.emitter.fire(this.snapshot());
    return h;
  }

  /** Return a client whose server answers, starting it (with progress) if allowed. */
  async ensure(signal?: AbortSignal): Promise<MlxAudioClient> {
    if ((await this.client.health()).reachable) { return this.client; }
    if (!cfg().get<boolean>('mlx.autoStart', true)) {
      throw new Error(`mlx-audio server not running at ${this.client.url}. Run "Sound Lab: Start mlx-audio Server".`);
    }
    if (!this.starting) {
      this.starting = (async () => {
        log(`\n▶ Starting mlx-audio server (${this.mode})`);
        try {
          const r = await this.client.start({ signal, onLog: logLine });
          log(`✔ mlx-audio server ${r.started ? 'started' : 'already running'} at ${r.url}`);
          return this.client;
        } finally { this.starting = undefined; this.refresh(); }
      })();
      this.refresh();
    }
    return this.starting;
  }

  // ------------------------------------------------------------ commands
  async cmdStart(): Promise<void> {
    if ((await this.refresh()).reachable) { vscode.window.showInformationMessage(`mlx-audio server already running at ${this.client.url}`); return; }
    if (this.mode !== 'native' && this.mode !== 'external') {
      const plan = this.client.plan();
      const go = await vscode.window.showInformationMessage(`Start the mlx-audio server in ${this.mode}?`, { modal: true, detail: `${plan?.cmd} ${plan?.args.join(' ')}\n\nThe first start pulls the image (several GB for :cuda12).` }, 'Start');
      if (go !== 'Start') { return; }
    }
    await job(`Starting mlx-audio server (${this.mode})`, async (rep, signal) => { rep(0.05, 'Starting…'); await this.ensure(signal); });
  }

  async cmdStop(): Promise<void> {
    const r = this.client.stop(this.mode);
    log(`mlx-audio stop: ${r.detail}`);
    vscode.window.showInformationMessage(r.stopped ? 'mlx-audio server stopped.' : `mlx-audio server not stopped: ${r.detail}`);
    setTimeout(() => this.refresh(), 800);
  }

  async cmdStatus(): Promise<void> {
    const h = await this.refresh();
    type Item = vscode.QuickPickItem & { run?: () => unknown };
    const items: Item[] = [
      { label: h.reachable ? `$(pass-filled) Running at ${h.url}` : `$(circle-slash) Not running`, description: `mode: ${this.mode}`, kind: vscode.QuickPickItemKind.Default },
      ...(h.reachable ? [{ label: '$(debug-stop) Stop server', run: () => this.cmdStop() }] : [{ label: '$(play) Start server', run: () => this.cmdStart() }]),
      { label: '$(browser) Open mlx-audio Studio', run: () => vscode.commands.executeCommand('soundLab.mlxOpenStudio') },
      { label: '$(person) Voice clone…', run: () => vscode.commands.executeCommand('soundLab.voiceClone') },
      { label: '$(megaphone) Text to speech…', run: () => this.cmdSynthesize() },
      { label: '$(layers) Models…', run: () => this.cmdModels() },
      { label: '$(output) Server log', run: () => { const l = this.client.logs(this.mode); state.output.appendLine(`\n--- mlx-audio server log ---\n${l || '(empty)'}`); state.output.show(); } },
      { label: '$(gear) Settings', run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'soundLab.mlx') },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'mlx-audio' });
    await pick?.run?.();
  }

  async cmdModels(): Promise<void> {
    const client = await this.ensure();
    const loaded = (await client.health()).loadedModels || [];
    type Item = vscode.QuickPickItem & { id: string; loaded: boolean };
    const known = [...new Set([...STT_MODELS, ...TTS_MODELS, ...CLONE_MODELS.map(m => m.id), this.sttModel(), this.ttsModel(), this.cloneModel()])];
    const items: Item[] = [
      ...loaded.map(id => ({ label: `$(check) ${id}`, description: 'loaded — select to unload', id, loaded: true })),
      ...known.filter(id => !loaded.includes(id)).map(id => ({ label: id, description: STT_MODELS.includes(id) ? 'speech-to-text' : CLONE_MODELS.some(m => m.id === id) ? 'TTS · voice cloning' : 'text-to-speech', id, loaded: false })),
      { label: '$(add) Other model id…', id: '', loaded: false },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Load or unload an mlx-audio model' });
    if (!pick) { return; }
    let id = pick.id;
    if (!id) { id = (await vscode.window.showInputBox({ prompt: 'Hugging Face model id (mlx-community/…)', placeHolder: 'mlx-community/…' })) || ''; if (!id) { return; } }
    if (pick.loaded) { await client.unloadModel(id); vscode.window.showInformationMessage(`Unloaded ${id}`); }
    else { await job(`Loading ${id} (first time downloads it)`, async (_r, signal) => client.loadModel(id, signal)); }
    this.refresh();
  }

  /** Text → speech file. Text comes from the argument, the editor selection, or an input box. */
  async cmdSynthesize(arg?: unknown): Promise<string | undefined> {
    const ed = vscode.window.activeTextEditor;
    let text = typeof arg === 'string' ? arg : ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : '';
    if (!text) { text = (await vscode.window.showInputBox({ prompt: 'Text to speak', placeHolder: 'Welcome to Sound Lab.' })) || ''; }
    if (!text.trim()) { return; }
    const client = await this.ensure();
    const model = this.ttsModel();
    let voice = cfg().get<string>('mlx.ttsVoice') || undefined;
    const voices = await client.voices(model).catch(() => []);
    if (voices.length) {
      const v = await vscode.window.showQuickPick(voices.map(x => ({ label: x.name, picked: x.id === voice, id: x.id })), { placeHolder: `Voice for ${model}` });
      if (!v) { return; }
      voice = v.id;
    }
    const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const out = uniquePath(path.join(base, 'voice-overs', `${text.trim().split(/\s+/).slice(0, 5).join('-').replace(/[^\w-]+/g, '').toLowerCase() || 'speech'}.wav`));
    const ok = await job(`Speaking with ${model.split('/').pop()}`, async (rep, signal) => {
      rep(0.1, 'Generating speech…');
      const buf = await client.speech(text, { model, voice, format: 'wav', signal });
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
      return true;
    });
    if (ok) { await announce([out], 'Spoke'); return out; }
    return undefined;
  }

  async cmdSeparate(arg?: unknown, args?: unknown): Promise<void> {
    const [uri] = await resolveTargets(arg, args, { title: 'Separate' });
    if (!uri) { return; }
    const what = await vscode.window.showQuickPick(['speech', 'vocals', 'drums', 'bass', 'music', 'dialogue', 'Other…'], { placeHolder: 'What should be pulled out of the mix?' });
    if (!what) { return; }
    const description = what === 'Other…' ? await vscode.window.showInputBox({ prompt: 'Describe the sound to isolate (e.g. "guitar", "crowd noise")' }) : what;
    if (!description) { return; }
    const src = uri.fsPath;
    const label = description.replace(/[^\w-]+/g, '-');
    const target = outputFor(src, label, 'wav'); const residual = outputFor(src, `no-${label}`, 'wav');
    const ok = await job(`Separating ${description} from ${path.basename(src)}`, async (rep, signal) => {
      const client = await this.ensure(signal);
      rep(0.1, 'Separating (this can take a while)…');
      const model = cfg().get<string>('mlx.separationModel') || undefined;
      const r = await client.separate(src, { description, model, signal });
      fs.writeFileSync(target, r.target); fs.writeFileSync(residual, r.residual);
      return true;
    });
    if (ok) { await announce([target, residual], 'Separated into'); }
  }

  // ------------------------------------------------------------ Studio
  async ensureStudio(): Promise<string | undefined> {
    if (await this.studio.reachable()) { return this.studio.url; }
    let dir: string | null | undefined = this.studio.locate();
    if (!dir) {
      const pick = await vscode.window.showInformationMessage('mlx-audio Studio (the web UI) is not installed with the pip package. Download it from GitHub (Blaizzy/mlx-audio, about 1 MB of source plus npm dependencies)?',
        { modal: true }, 'Download Studio', 'Choose Folder…');
      if (pick === 'Choose Folder…') {
        const f = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this mlx_audio/ui folder' });
        if (!f) { return; }
        await cfg().update('mlx.studio.path', f[0].fsPath, vscode.ConfigurationTarget.Global);
        dir = f[0].fsPath;
      } else if (pick === 'Download Studio') {
        dir = await job('Downloading mlx-audio Studio', async rep => { rep(0.2, 'Fetching mlx_audio/ui…'); return this.studio.download(logLine); });
      }
      if (!dir) { return; }
    }
    await this.ensure();
    const ok = await job('Starting mlx-audio Studio (first run installs npm packages)', async (rep, signal) => {
      rep(0.05, 'npm install / next dev…');
      return this.studio.start(dir!, { onLog: logLine, signal });
    });
    this.refresh();
    return ok?.url;
  }

  cmdStopStudio(): void {
    vscode.window.showInformationMessage(this.studio.stop() ? 'mlx-audio Studio stopped.' : 'Studio was not started by Sound Lab.');
    this.refresh();
  }

  /** Transcription hook used by the 'mlx-audio' backend. */
  transcriptionConfig() { return { model: this.sttModel(), ensure: (signal?: AbortSignal) => this.ensure(signal) }; }

  dispose(): void {
    clearInterval(this.timer);
    this.studio?.stop();
    if (cfg().get<boolean>('mlx.stopOnExit') && this.mode === 'native') { this.client.stop('native'); }
    this.disposables.forEach(d => d.dispose());
  }
}

export async function pickAudioFile(title: string): Promise<string | undefined> {
  const f = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: title, filters: { 'Audio / video': ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aiff', 'aif', 'opus', 'mp4', 'mov', 'mkv', 'webm'] } });
  return f?.[0]?.fsPath;
}

export { openMedia, summaryOf };
