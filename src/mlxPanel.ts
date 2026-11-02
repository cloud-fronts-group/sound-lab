// Sidebar webview "MLX Audio": server status, voice clone, text-to-speech, speech-to-text, separation, Studio.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MlxController, TTS_MODELS, CLONE_MODELS } from './mlx';
import { listProfiles, deleteProfile } from './core/voiceClone';
import { icon } from './icons';
import { page } from './webviewKit';
import { cfg, uniquePath, openMedia, state } from './util';

export class MlxPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'soundLab.mlxPanel';
  private view?: vscode.WebviewView;

  constructor(private ctx: vscode.ExtensionContext, private ctl: MlxController) {
    ctx.subscriptions.push(ctl.onDidChange(() => this.pushState()), state.created.event(() => this.pushState()));
  }

  private roots(): vscode.Uri[] {
    return [vscode.Uri.joinPath(this.ctx.extensionUri, 'media'), vscode.Uri.file(this.ctl.voicesDir), vscode.Uri.file(os.tmpdir()),
      ...(vscode.workspace.workspaceFolders || []).map(f => f.uri), vscode.Uri.file(path.join(os.homedir(), 'Sound Lab'))];
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: this.roots() };
    view.webview.html = page({ webview: view.webview, media: vscode.Uri.joinPath(this.ctx.extensionUri, 'media'), title: 'MLX Audio', script: 'mlx-panel.js', body: this.body() });
    view.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => this.post({ type: 'error', message: (e as Error).message.split('\n')[0] })));
    view.onDidChangeVisibility(() => { if (view.visible) { this.ctl.refresh(); } });
  }

  private body(): string {
    return `
<section id="server">
  <h2>${icon('server')}mlx-audio server</h2>
  <div class="row"><span id="dot" class="dot"></span><span id="srvText">Checking…</span></div>
  <div id="models" class="row small"></div>
  <div class="row">
    <button id="start" class="primary">${icon('play')}Start</button>
    <button id="stop" hidden>${icon('server-stop')}Stop</button>
    <button id="studio" title="Open mlx-audio Studio in an editor tab">${icon('studio')}Studio</button>
    <button id="modelsBtn" title="Load / unload models">${icon('model')}Models</button>
    <button id="refresh" title="Refresh" aria-label="Refresh">${icon('refresh')}</button>
  </div>
</section>

<section id="clone">
  <h2>${icon('voice-clone')}Voice clone</h2>
  <p class="small muted">Read a few sentences aloud, then narrate a presentation, an audiobook or vocals over an instrumental in your voice.</p>
  <button id="cloneBtn" class="primary big">${icon('voice-clone')}Voice clone</button>
  <div id="voices" class="list mt8"></div>
</section>

<section id="tts">
  <h2>${icon('speak')}Text to speech</h2>
  <textarea id="text" placeholder="Type or paste a script…"></textarea>
  <div class="col"><label for="ttsModel">Model / voice source</label><select id="ttsModel"></select></div>
  <div class="col" id="voiceRow"><label for="voice">Voice</label><select id="voice"><option value="">(default)</option></select></div>
  <div class="col"><label for="speed">Speed <span id="speedVal">1.0×</span></label><input id="speed" type="range" min="0.6" max="1.6" step="0.05" value="1"></div>
  <div class="row"><button id="speak" class="primary">${icon('speak')}Speak</button><span id="ttsStatus" class="status"></span></div>
  <div id="result" hidden>
    <audio id="player" controls></audio>
    <div class="row"><button id="openResult">${icon('open-external')}Open in editor</button><span id="resultName" class="small muted"></span></div>
  </div>
</section>

<section id="stt">
  <h2>${icon('transcribe')}Speech to text · separation</h2>
  <div class="row">
    <button id="transcribe" title="Transcribe the active audio file with the mlx-audio server">${icon('transcribe')}Transcribe…</button>
    <button id="separate" title="Split a mix into a sound and the rest">${icon('separate')}Separate…</button>
  </div>
  <div id="err" class="status err"></div>
</section>`;
  }

  post(m: unknown): void { this.view?.webview.postMessage(m); }

  pushState(): void {
    if (!this.view) { return; }
    const s = this.ctl.snapshot();
    const profiles = listProfiles(this.ctl.voicesDir).map(p => ({ id: p.id, name: p.name, purpose: p.purpose, model: p.model, ref: this.view!.webview.asWebviewUri(vscode.Uri.file(p.reference)).toString() }));
    this.post({ type: 'state', health: s.health, mode: s.mode, starting: s.starting, studio: s.studio, profiles,
      ttsModels: [...new Set([this.ctl.ttsModel(), ...TTS_MODELS])], cloneModels: CLONE_MODELS, ttsModel: this.ctl.ttsModel(), voice: cfg().get<string>('mlx.ttsVoice') || '' });
  }

  private async onMessage(m: { type: string; [k: string]: any }): Promise<void> {
    switch (m.type) {
      case 'ready': this.pushState(); await this.ctl.refresh(); break;
      case 'refresh': await this.ctl.refresh(); break;
      case 'start': await this.ctl.cmdStart(); break;
      case 'stop': await this.ctl.cmdStop(); break;
      case 'studio': await vscode.commands.executeCommand('soundLab.mlxOpenStudio'); break;
      case 'models': await this.ctl.cmdModels(); break;
      case 'clone': await vscode.commands.executeCommand('soundLab.voiceClone', m.profileId ? { profileId: m.profileId } : undefined); break;
      case 'deleteVoice': {
        const ok = await vscode.window.showWarningMessage(`Delete the cloned voice "${m.name}"? Its reference recording is removed.`, { modal: true }, 'Delete');
        if (ok) { deleteProfile(this.ctl.voicesDir, m.id); this.pushState(); }
        break;
      }
      case 'voices': {
        if (String(m.model).startsWith('profile:')) { this.post({ type: 'voices', model: m.model, list: [] }); break; }
        const h = await this.ctl.client.health();
        const list = h.reachable ? await this.ctl.client.voices(m.model).catch(() => []) : [];
        this.post({ type: 'voices', model: m.model, list, offline: !h.reachable });
        break;
      }
      case 'speak': await this.speak(m as unknown as { text: string; model: string; voice?: string; speed?: number }); break;
      case 'open': await openMedia(vscode.Uri.file(m.path)); break;
      case 'transcribe': await vscode.commands.executeCommand('soundLab.transcribe', undefined, { backend: 'mlx-audio' }); break;
      case 'separate': await vscode.commands.executeCommand('soundLab.mlxSeparate'); break;
    }
  }

  private async speak(m: { text: string; model: string; voice?: string; speed?: number }): Promise<void> {
    const text = String(m.text || '').trim();
    if (!text) { this.post({ type: 'tts', status: 'Type something to speak.', error: true }); return; }
    this.post({ type: 'tts', status: 'Starting server…' });
    const client = await this.ctl.ensure();
    const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.join(os.homedir(), 'Sound Lab');
    const name = text.split(/\s+/).slice(0, 5).join('-').replace(/[^\w-]+/g, '').toLowerCase() || 'speech';
    const out = uniquePath(path.join(base, 'voice-overs', `${name}.wav`));
    let model = m.model; let refAudio: string | undefined; let refText: string | undefined;
    if (model.startsWith('profile:')) {
      const p = listProfiles(this.ctl.voicesDir).find(x => x.id === model.slice(8));
      if (!p) { throw new Error('That cloned voice no longer exists.'); }
      model = p.model; refAudio = p.reference; refText = p.referenceText;
    }
    this.post({ type: 'tts', status: `Speaking with ${model.split('/').pop()}${refAudio ? ' (your cloned voice)' : ''}…` });
    const t0 = Date.now();
    const buf = await client.speech(text, { model, voice: m.voice || undefined, speed: m.speed && m.speed !== 1 ? m.speed : undefined, refAudio, refText, format: 'wav' });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    state.created.fire([out]);
    this.post({ type: 'tts', status: `Done in ${((Date.now() - t0) / 1000).toFixed(1)} s`, done: true, src: this.view!.webview.asWebviewUri(vscode.Uri.file(out)).toString(), path: out, name: path.relative(base, out) });
  }
}
