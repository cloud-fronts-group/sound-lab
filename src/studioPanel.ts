// Sound Lab Studio: an editor tab with a creation ribbon (Instrumental, Beats, Chords, Sound FX, Auto-tune, Layer),
// a DJ ribbon (Backspin, Echo out, Beat jump, Double drop, Quick mix, Long blend, Mashup, Acapella, Instrumental),
// tool drawers, and — beside them — the embedded mlx-audio Studio (iframe of its Next.js dev server) when it runs.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { MlxController } from './mlx';
import { icon } from './icons';
import { esc, page } from './webviewKit';
import { job, openMedia, state } from './util';
import { StudioTools, Tool } from './studioTools';
import { GENRES, BEAT_STYLES } from './core/composer';
import { PROGRESSIONS, KEYS, SCALES } from './core/theory';
import { INSTRUMENTS } from './core/synth';
import { SFX } from './core/sfx';

/** Ribbon: [tool id, icon, label, tooltip]. */
export const CREATE_TOOLS: [Tool, string, string, string][] = [
  ['instrumental', 'instrumental', 'Instrumental', 'Compose a full instrumental (drums, chords, bass, lead) in a genre'],
  ['beats', 'beats', 'Beats', 'Program a drum loop'],
  ['chords', 'chords', 'Chords', 'Play a chord progression'],
  ['sfx', 'sfx', 'Sound FX', 'Risers, impacts, whooshes, drops and more'],
  ['autotune', 'autotune', 'Auto-tune', 'Pitch-correct vocals to a key'],
  ['layer', 'layers', 'Layer', 'Layer a generated part onto a track'],
];
export const DJ_TOOLS: [Tool, string, string, string][] = [
  ['backspin', 'backspin', 'Backspin', 'Spin the track backward to a stop'],
  ['echoout', 'echo-out', 'Echo out', 'Leave the track on a tempo-synced echo'],
  ['beatjump', 'beat-jump', 'Beat jump', 'Jump forward or back by N beats'],
  ['doubledrop', 'double-drop', 'Double drop', 'Line up two drops on the same downbeat'],
  ['quickmix', 'quick-mix', 'Quick mix', 'Fast beat-matched transition into another track'],
  ['longblend', 'long-blend', 'Long blend', 'Gradual 16-bar blend with a bass swap'],
  ['mashup', 'mashup', 'Mashup', 'Vocals of one song over the instrumental of another'],
  ['acapella', 'acapella', 'Acapella', 'Isolate the vocals'],
  ['novocals', 'no-vocals', 'Instrumental', 'Remove the vocals'],
];

export class StudioPanel {
  static current?: StudioPanel;
  private tool = '';
  private track = '';
  private constructor(private panel: vscode.WebviewPanel, private ctl: MlxController, private tools: StudioTools, private media: vscode.Uri) {
    panel.onDidDispose(() => { StudioPanel.current = undefined; });
    panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => this.post({ type: 'error', tool: m.tool, message: (e as Error).message.split('\n')[0] })));
  }

  static roots(media: vscode.Uri, tools: StudioTools): vscode.Uri[] {
    return [media, ...(vscode.workspace.workspaceFolders || []).map(f => f.uri), vscode.Uri.file(os.tmpdir()), vscode.Uri.file(path.dirname(tools.outDir('.')))];
  }

  /** Open (or reveal) the Studio tab. `tool` opens that drawer; `track` pre-fills its track; `startStudio` boots mlx-audio Studio. */
  static async open(ctl: MlxController, ctx: vscode.ExtensionContext, tools: StudioTools, o: { tool?: string; track?: string; startStudio?: boolean; page?: string } = {}): Promise<void> {
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    if (!StudioPanel.current) {
      const panel = vscode.window.createWebviewPanel('soundLab.mlxStudio', 'Sound Lab Studio', vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: StudioPanel.roots(media, tools) });
      panel.iconPath = { light: vscode.Uri.joinPath(media, 'icons', 'studio-light.svg'), dark: vscode.Uri.joinPath(media, 'icons', 'studio-dark.svg') };
      StudioPanel.current = new StudioPanel(panel, ctl, tools, media);
      if (o.tool) { StudioPanel.current.tool = o.tool; StudioPanel.current.track = o.track ?? ''; }
      await StudioPanel.current.render(o.page, !!o.startStudio);
      return;
    } else {
      StudioPanel.current.panel.reveal();
      if (o.startStudio) { await StudioPanel.current.render(o.page, true); }
    }
    if (o.tool) { StudioPanel.current.tool = o.tool; StudioPanel.current.post({ type: 'show', tool: o.tool, track: o.track }); }
  }

  private post(m: unknown): void { this.panel.webview.postMessage(m); }

  private webviewSrc(file: string): string {
    const roots = StudioPanel.roots(this.media, this.tools).map(u => u.fsPath + path.sep);
    let f = file;
    if (!roots.some(r => file.startsWith(r))) {
      // outside the webview's resource roots (e.g. an edit next to a source elsewhere): preview a temp copy
      const d = path.join(os.tmpdir(), 'soundlab-preview'); fs.mkdirSync(d, { recursive: true });
      f = path.join(d, crypto.createHash('sha1').update(file).digest('hex').slice(0, 10) + path.extname(file));
      fs.copyFileSync(file, f);
    }
    return this.panel.webview.asWebviewUri(vscode.Uri.file(f)).toString() + `?v=${Date.now()}`;
  }

  private async onMessage(m: { type: string; tool?: Tool; page?: string; params?: Record<string, unknown>; field?: string; file?: string; bpm?: number }): Promise<void> {
    switch (m.type) {
      case 'reload': await this.render(m.page); break;
      case 'external': vscode.env.openExternal(vscode.Uri.parse(this.ctl.studio.url + (m.page || ''))); break;
      case 'stop': this.ctl.cmdStopStudio(); await this.render(); break;
      case 'start': await this.ctl.ensureStudio(); await this.render(); break;
      case 'clone': vscode.commands.executeCommand('soundLab.voiceClone'); break;
      case 'tool': this.tool = String(m.tool || ''); break;
      case 'pick': {
        const picked = await vscode.window.showOpenDialog({ openLabel: 'Choose', canSelectMany: false, defaultUri: state.activeEditorUri,
          filters: { Audio: ['wav', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aif', 'aiff', 'caf', 'webm', 'mka', 'mp4', 'mov'], 'All files': ['*'] } });
        if (picked?.[0]) { this.post({ type: 'picked', field: m.field, file: picked[0].fsPath, name: path.basename(picked[0].fsPath) }); }
        break;
      }
      case 'analyse': {
        if (!m.file) { break; }
        this.post({ type: 'analysing', field: m.field });
        try { const a = await this.tools.analyse(m.file, m.bpm || undefined); this.post({ type: 'analysed', field: m.field, ...a }); }
        catch (e) { this.post({ type: 'analysed', field: m.field, error: (e as Error).message.split('\n')[0] }); }
        break;
      }
      case 'generate': {
        const tool = m.tool as Tool;
        this.post({ type: 'busy', tool, on: true });
        let failed = '';
        const label = [...CREATE_TOOLS, ...DJ_TOOLS].find(t => t[0] === tool)?.[2] ?? tool;
        const r = await job(`Studio · ${label}`, async (report, signal) => {
          try {
            return await this.tools.run(tool, m.params || {}, (f, msg) => { report(f, msg); this.post({ type: 'progress', tool, fraction: f, text: msg }); }, signal);
          } catch (e) { failed = (e as Error).message.split('\n')[0]; throw e; }
        });
        this.post({ type: 'busy', tool, on: false });
        if (r) {
          state.created.fire(r.files ?? [r.file]);
          this.post({ type: 'result', tool, file: r.file, name: path.basename(r.file), src: this.webviewSrc(r.file), detail: r.detail, seconds: r.seconds,
            extra: (r.files || []).filter(f => f !== r.file).map(f => ({ file: f, name: path.basename(f), src: this.webviewSrc(f) })) });
        } else { this.post({ type: 'error', tool, message: failed || 'Cancelled' }); }
        break;
      }
      case 'open': if (m.file) { await openMedia(vscode.Uri.file(m.file)); } break;
      case 'reveal': if (m.file) { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.file)); } break;
      case 'active': {
        const u = state.activeEditorUri;
        if (u) { this.post({ type: 'picked', field: m.field, file: u.fsPath, name: path.basename(u.fsPath) }); }
        else { this.post({ type: 'error', tool: m.tool, message: 'No audio file is open in the Sound Lab editor.' }); }
        break;
      }
    }
  }

  /** Options for the drawers (genres, styles, presets, instruments, effects, keys, scales). */
  private data(): string {
    return JSON.stringify({
      genres: Object.entries(GENRES).map(([id, g]) => ({ id, label: g.label, bpm: g.bpm, scale: g.scale })),
      styles: Object.entries(BEAT_STYLES).map(([id, s]) => ({ id, label: s.label, bpm: s.bpm, swing: Math.round(s.swing * 100) })),
      progressions: Object.entries(PROGRESSIONS).map(([id, p]) => ({ id, label: p.label })),
      instruments: INSTRUMENTS, keys: KEYS, scales: Object.keys(SCALES).filter(s => s !== 'chromatic'),
      sfx: Object.entries(SFX).map(([id, s]) => ({ id, label: s.label, tempo: !!s.tempo, d: s.d })),
    });
  }

  private async render(pagePath = '', tryStart = false): Promise<void> {
    let url: string | undefined;
    if (await this.ctl.studio.reachable()) { url = this.ctl.studio.url; }
    else if (tryStart) { url = await this.ctl.ensureStudio(); }
    // asExternalUri makes localhost reachable from the webview when VS Code runs remotely (SSH, WSL, Codespaces).
    const external = url ? (await vscode.env.asExternalUri(vscode.Uri.parse(url))).toString().replace(/\/$/, '') : '';
    const origin = external ? new URL(external).origin : '';
    const pages = [['', 'Home', 'studio'], ['/text-to-speech', 'Text to speech', 'speak'], ['/speech-to-text', 'Speech to text', 'transcribe'], ['/audio-separation', 'Separation', 'separate']];
    const nav = pages.map(([p, label, ic]) => `<button class="tab${url && p === pagePath ? ' on' : ''}" data-page="${p}"${url ? '' : ' disabled'}>${icon(ic)}${esc(label)}</button>`).join('');
    const ribbon = (items: typeof CREATE_TOOLS) => items.map(([id, ic, label, tip]) => `<button class="tool" data-tool="${id}" title="${esc(tip)}">${icon(ic)}<span>${esc(label)}</span></button>`).join('');
    const stage = url
      ? `<iframe id="studio" src="${esc(external + pagePath)}" data-base="${esc(external)}" title="mlx-audio Studio" allow="microphone; autoplay; clipboard-write"></iframe>`
      : `<div class="empty">
          <h1>${icon('studio')}Sound Lab Studio</h1>
          <p>Pick a tool above. <b>Create</b> composes instrumentals, beats, chords and sound effects in your tempo and key, auto-tunes vocals, and layers parts onto tracks. <b>DJ</b> spins, echoes, jumps, mixes, blends and mashes up tracks on the beat, and splits vocals from instrumentals.</p>
          <p class="muted">mlx-audio Studio (text-to-speech, speech-to-text and AI separation in the browser) opens here when it runs. API server: ${esc(this.ctl.client.url)} · Studio port: ${this.ctl.studio.cfg.port}</p>
          <button data-act="start">${icon('play')}Start mlx-audio Studio</button>
        </div>`;
    const body = `
      <div class="ribbon">
        <span class="brand">${icon('studio')}Sound Lab Studio</span>
        <div class="group"><span class="glabel">Create</span><div class="tools">${ribbon(CREATE_TOOLS)}</div></div>
        <div class="group"><span class="glabel">DJ</span><div class="tools">${ribbon(DJ_TOOLS)}</div></div>
      </div>
      <div class="toolbar">
        <span class="sub">${icon('model')}mlx-audio</span>
        ${nav}
        <span class="spacer"></span>
        <button data-act="clone" title="Record your voice and narrate with it">${icon('voice-clone')}Voice clone</button>
        ${url ? `<button data-act="reload" title="Reload">${icon('refresh')}</button>
        <button data-act="external" title="Open in browser">${icon('open-external')}</button>
        <button data-act="stop" title="Stop the Studio dev server">${icon('stop')}</button>` : ''}
      </div>
      <div class="main">
        <aside id="drawer" class="drawer" hidden></aside>
        <div class="stage">${stage}</div>
      </div>
      <div id="data" hidden data-json="${esc(this.data())}" data-tool="${esc(this.tool)}" data-track="${esc(this.track)}"></div>`;
    this.panel.webview.html = page({ webview: this.panel.webview, media: this.media, title: 'Sound Lab Studio', body, script: 'studio.js', css: ['studio.css'], frameSrc: origin ? [origin] : [] });
  }
}
