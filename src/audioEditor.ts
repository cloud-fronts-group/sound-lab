import * as vscode from 'vscode';
import { icon, iconSprite } from './icons';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { runOk } from './core/ffmpeg';
import { extractPeaks } from './core/analysis';
import { probe, summarize, audioStream, AudioSummary } from './core/probe';
import { previewTranscode } from './core/recipes';
import { cfg, job, state, storageDir, tools, log, ensureFfmpeg } from './util';
import * as C from './commands';

const NATIVE = ['mp3', 'ogg', 'oga', 'opus', 'flac', 'webm'];
const PCM_OK = /^pcm_(s16|s24|s32|f32|u8)/;

export class AudioEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'soundLab.audioPreview';
  private panels = new Map<string, Set<vscode.WebviewPanel>>();

  constructor(private readonly ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(C.onTranscribed.event(({ file, segments }) => this.post(file, { type: 'transcript', segments })));
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  private post(file: string, msg: unknown): void {
    for (const p of this.panels.get(file) ?? []) { p.webview.postMessage(msg); }
  }

  async resolveCustomEditor(doc: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const file = doc.uri.fsPath;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.dirname(file)), media, vscode.Uri.file(storageDir())],
    };
    panel.webview.html = this.html(panel.webview, media, path.basename(file));

    const set = this.panels.get(file) ?? new Set();
    set.add(panel); this.panels.set(file, set);
    state.activeEditorUri = doc.uri;

    const ac = new AbortController();
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
    const subs: vscode.Disposable[] = [
      watcher,
      watcher.onDidChange(() => this.load(doc.uri, panel, ac.signal)),
      panel.onDidChangeViewState(e => { if (e.webviewPanel.active) { state.activeEditorUri = doc.uri; } }),
      panel.webview.onDidReceiveMessage(m => this.onMessage(doc.uri, panel, m, ac.signal)),
    ];
    panel.onDidDispose(() => {
      ac.abort();
      subs.forEach(s => s.dispose());
      set.delete(panel);
      if (state.activeEditorUri?.fsPath === file) { state.activeEditorUri = undefined; }
    });
  }

  private async load(uri: vscode.Uri, panel: vscode.WebviewPanel, signal: AbortSignal): Promise<void> {
    const file = uri.fsPath;
    const post = (m: unknown) => panel.webview.postMessage(m);
    if (!(await ensureFfmpeg())) { post({ type: 'error', message: 'ffmpeg / ffprobe not found — set soundLab.ffmpegPath.' }); return; }
    try {
      const p = await probe(tools().ffprobe, file);
      const s = summarize(p);
      const st = fs.statSync(file);
      post({ type: 'info', info: { ...s, size: st.size, path: file, sampleFmt: audioStream(p)?.sample_fmt } });
      if (s.codec === 'none') { post({ type: 'error', message: 'No audio stream in this file.' }); return; }

      const src = await this.playableSource(file, s, st, signal);
      post({ type: 'audio', src: panel.webview.asWebviewUri(vscode.Uri.file(src)).toString() + `?v=${st.mtimeMs}` });

      const transcript = C.loadTranscript(file);
      if (transcript) { post({ type: 'transcript', segments: transcript }); }

      const peaks = await extractPeaks(tools().ffmpeg, file, s.duration, cfg().get<number>('preview.peaksPerSecond') ?? 200, signal);
      post({ type: 'peaks', peaks });
    } catch (e) {
      if (!signal.aborted) { post({ type: 'error', message: (e as Error).message }); log(`Audio editor: ${(e as Error).message}`); }
    }
  }

  /** The webview (Chromium without proprietary codecs) can't play AAC/AIFF/WMA…; transcode those to a cached FLAC. */
  private async playableSource(file: string, s: AudioSummary, st: fs.Stats, signal: AbortSignal): Promise<string> {
    const ext = path.extname(file).slice(1).toLowerCase();
    const native = NATIVE.includes(ext) || (ext === 'wav' && PCM_OK.test(s.codec));
    if (native && s.codec !== 'aac') { return file; }
    const key = crypto.createHash('sha1').update(`${file}|${st.mtimeMs}|${st.size}`).digest('hex').slice(0, 16);
    const out = path.join(storageDir('preview'), `${key}.flac`);
    if (!fs.existsSync(out)) {
      const tmp = out + '.part.flac';
      await runOk({ exe: tools().ffmpeg, args: previewTranscode(file, tmp), signal });
      fs.renameSync(tmp, out);
    }
    return out;
  }

  private async onMessage(uri: vscode.Uri, panel: vscode.WebviewPanel, m: { type: string; [k: string]: unknown }, signal: AbortSignal): Promise<void> {
    const post = (msg: unknown) => panel.webview.postMessage(msg);
    const file = uri.fsPath;
    switch (m.type) {
      case 'ready':
        await this.load(uri, panel, signal);
        break;
      case 'exportSelection': {
        const out = await C.cmdTrim(uri, { start: m.start as number, end: m.end as number });
        if (out) { post({ type: 'toast', text: `Saved ${path.basename(out)}` }); }
        break;
      }
      case 'run': {
        const id = String(m.command);
        if (/^[a-zA-Z]+$/.test(id)) { await vscode.commands.executeCommand(`soundLab.${id}`, uri); }
        break;
      }
      case 'analyze': {
        post({ type: 'busy', what: 'levels' });
        const report = await C.cmdAnalyze(uri, undefined, { silent: true });
        post({ type: 'levels', report: report ?? null });
        break;
      }
      case 'spectrogram': {
        post({ type: 'busy', what: 'spectrogram' });
        const w = Math.max(400, Math.min(4096, Math.round(Number(m.width) || 1600)));
        const st = fs.statSync(file);
        const key = crypto.createHash('sha1').update(`${file}|${st.mtimeMs}|${w}`).digest('hex').slice(0, 16);
        const out = path.join(storageDir('spectrograms'), `${key}.png`);
        const ok = fs.existsSync(out) || await job('Computing spectrogram', async (rep, sig) => { await C.renderImage('spec', file, out, rep, sig, [w, 512]); return true; });
        post({ type: 'spectrogram', src: ok ? panel.webview.asWebviewUri(vscode.Uri.file(out)).toString() : null });
        break;
      }
      case 'silence': {
        post({ type: 'busy', what: 'silence' });
        const r = await job('Detecting silence', async (rep, sig) => {
          const s = await probe(tools().ffprobe, file).then(summarize);
          return C.detectSilence(file, s.duration, rep, sig);
        });
        post({ type: 'regions', silences: r?.silences ?? [], segments: r?.segments ?? [] });
        break;
      }
      case 'transcribe':
        post({ type: 'busy', what: 'transcript' });
        if (!(await C.cmdTranscribe(uri))) { post({ type: 'transcript', segments: C.loadTranscript(file) ?? null }); }
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(String(m.text ?? ''));
        post({ type: 'toast', text: 'Copied to clipboard' });
        break;
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri, title: string): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'editor.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'editor.js'));
    const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; media-src ${webview.cspSource} blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>${esc(title)}</title>
</head>
<body>
  ${iconSprite()}
  <header>
    <h1 id="title">${esc(title)}</h1>
    <div id="chips" class="chips"></div>
  </header>

  <div id="error" class="error" hidden></div>

  <section class="wave-wrap">
    <canvas id="wave" tabindex="0" aria-label="Waveform. Drag to select, click to seek, scroll to zoom."></canvas>
    <div id="loading" class="loading">Decoding waveform…</div>
  </section>

  <div class="transport">
    <button id="play" class="primary" title="Play / pause (Space)" aria-label="Play / pause">${icon('play')}</button>
    <button id="stop" title="Stop (Home)" aria-label="Stop">${icon('stop')}</button>
    <button id="loop" class="toggle" title="Loop selection (L)">${icon('loop')}Loop</button>
    <span class="time"><span id="pos">0:00.000</span> / <span id="dur">0:00.000</span></span>
    <span class="sel" id="selInfo">No selection — drag on the waveform</span>
    <span class="spacer"></span>
    <label title="Playback rate">Rate
      <select id="rate"><option>0.5</option><option>0.75</option><option selected>1</option><option>1.25</option><option>1.5</option><option>2</option></select>
    </label>
    <label title="Volume">Vol <input id="vol" type="range" min="0" max="1" step="0.01" value="0.9"></label>
    <button id="zoomOut" title="Zoom out (-)" aria-label="Zoom out">${icon('zoom-out')}</button>
    <button id="zoomFit" title="Fit (0)">${icon('zoom-fit')}Fit</button>
    <button id="zoomIn" title="Zoom in (+)" aria-label="Zoom in">${icon('zoom-in')}</button>
  </div>

  <div class="actions">
    <button id="export" class="primary" disabled title="Save the selection as a new sample (E)">${icon('export')}Export selection</button>
    <button id="zoomSel" disabled title="Zoom to selection (Z)">${icon('zoom-selection')}Zoom to selection</button>
    <button data-panel="levels">${icon('levels')}Levels</button>
    <button data-panel="spectrogram">${icon('spectrogram')}Spectrogram</button>
    <button data-panel="silence">${icon('find-silence')}Find silence</button>
    <button data-panel="transcript">${icon('transcribe')}Transcript</button>
    <span class="spacer"></span>
    <button data-run="applyEffects">${icon('effects')}Effects…</button>
    <button data-run="normalize">${icon('normalize')}Normalize…</button>
    <button data-run="convert">${icon('convert')}Convert…</button>
    <button data-run="sliceEqual">${icon('slice-equal')}Slice…</button>
    <button data-run="splitOnSilence">${icon('split-silence')}Split on silence…</button>
    <button data-run="probe">${icon('info')}Info</button>
  </div>

  <section id="panel-levels" class="panel" hidden>
    <h2>Levels <button class="link" id="levelsRefresh">${icon('refresh')}re-measure</button></h2>
    <div id="levelsBody" class="muted">Measuring…</div>
  </section>

  <section id="panel-spectrogram" class="panel" hidden>
    <h2>Spectrogram</h2>
    <div id="specBody" class="muted">Computing…</div>
  </section>

  <section id="panel-silence" class="panel" hidden>
    <h2>Sound regions <span class="muted" id="silenceSummary"></span></h2>
    <div id="silenceBody" class="muted">Detecting…</div>
  </section>

  <section id="panel-transcript" class="panel" hidden>
    <h2>Transcript
      <input id="tsearch" type="search" placeholder="Filter…">
      <button class="link" id="tcopy">${icon('copy')}copy text</button>
      <button class="link" id="trun">${icon('transcribe')}transcribe again</button>
    </h2>
    <div id="transcriptBody" class="muted">No transcript yet.</div>
  </section>

  <div id="toast" class="toast" hidden></div>
  <audio id="audio" preload="auto"></audio>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
