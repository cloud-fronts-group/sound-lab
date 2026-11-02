// mlx-audio Studio embedded in a VS Code editor tab (iframe of the Next.js dev server).
import * as vscode from 'vscode';
import { MlxController } from './mlx';
import { icon } from './icons';
import { esc, page } from './webviewKit';

export class StudioPanel {
  static current?: StudioPanel;
  private constructor(private panel: vscode.WebviewPanel, private ctl: MlxController, private media: vscode.Uri) {
    panel.onDidDispose(() => { StudioPanel.current = undefined; });
    panel.webview.onDidReceiveMessage(async (m: { type: string; page?: string }) => {
      if (m.type === 'reload') { await this.render(m.page); }
      if (m.type === 'external') { vscode.env.openExternal(vscode.Uri.parse(this.ctl.studio.url + (m.page || ''))); }
      if (m.type === 'stop') { this.ctl.cmdStopStudio(); await this.render(); }
      if (m.type === 'start') { await this.ctl.ensureStudio(); await this.render(); }
      if (m.type === 'clone') { vscode.commands.executeCommand('soundLab.voiceClone'); }
    });
  }

  static async open(ctl: MlxController, ctx: vscode.ExtensionContext, page?: string): Promise<void> {
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    if (!StudioPanel.current) {
      const panel = vscode.window.createWebviewPanel('soundLab.mlxStudio', 'mlx-audio Studio', vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
      panel.iconPath = { light: vscode.Uri.joinPath(media, 'icons', 'studio-light.svg'), dark: vscode.Uri.joinPath(media, 'icons', 'studio-dark.svg') };
      StudioPanel.current = new StudioPanel(panel, ctl, media);
    }
    StudioPanel.current.panel.reveal();
    await StudioPanel.current.render(page, true);
  }

  private async render(pagePath = '', tryStart = false): Promise<void> {
    let url: string | undefined;
    if (await this.ctl.studio.reachable()) { url = this.ctl.studio.url; }
    else if (tryStart) { url = await this.ctl.ensureStudio(); }
    // asExternalUri makes localhost reachable from the webview when VS Code runs remotely (SSH, WSL, Codespaces).
    const external = url ? (await vscode.env.asExternalUri(vscode.Uri.parse(url))).toString().replace(/\/$/, '') : '';
    const origin = external ? new URL(external).origin : '';
    const pages = [['', 'Home', 'studio'], ['/text-to-speech', 'Text to speech', 'speak'], ['/speech-to-text', 'Speech to text', 'transcribe'], ['/audio-separation', 'Separation', 'separate']];
    const nav = pages.map(([p, label, ic]) => `<button class="tab${p === pagePath ? ' on' : ''}" data-page="${p}">${icon(ic)}${esc(label)}</button>`).join('');
    const body = url ? `
      <div class="toolbar">
        <span class="brand">${icon('studio')}mlx-audio Studio</span>
        ${nav}
        <span class="spacer"></span>
        <button data-act="clone" title="Record your voice and narrate with it">${icon('voice-clone')}Voice clone</button>
        <button data-act="reload" title="Reload">${icon('refresh')}</button>
        <button data-act="external" title="Open in browser">${icon('open-external')}</button>
        <button data-act="stop" title="Stop the Studio dev server">${icon('stop')}</button>
      </div>
      <iframe id="studio" src="${esc(external + pagePath)}" data-base="${esc(external)}" title="mlx-audio Studio" allow="microphone; autoplay; clipboard-write"></iframe>`
      : `<div class="empty">
          <h1>${icon('studio')}mlx-audio Studio</h1>
          <p>Studio is the web UI that ships with <a href="https://github.com/Blaizzy/mlx-audio">mlx-audio</a>: text-to-speech, speech-to-text and source separation in the browser, talking to your mlx-audio server.</p>
          <p class="muted">API server: ${esc(this.ctl.client.url)} · Studio port: ${this.ctl.studio.cfg.port}</p>
          <button class="primary" data-act="start">${icon('play')}Start Studio</button>
        </div>`;
    this.panel.webview.html = page({ webview: this.panel.webview, media: this.media, title: 'mlx-audio Studio', body, script: 'studio.js', css: ['studio.css'], frameSrc: origin ? [origin] : [] });
  }
}
