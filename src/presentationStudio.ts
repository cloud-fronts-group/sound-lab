// Presentation & Tutorial Studio:
// 1. Initialize by cloning the user's voice (or picking a saved voice)
// 2. Ask what the presentation will be about & which folder to inspect
// 3. Run Google ADK Deep Research Agent -> scaffold a 5-10 min instructional presentation
// 4. Present slides / record screen with simultaneous live transcription & cloned-voice video tutorial export.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CLONE_MODELS, MlxController } from './mlx';
import { checkAdkRuntime, runPresentationResearchWorkflow } from './core/adkBridge';
import { run, runOk } from './core/ffmpeg';
import { LiveTutorialSession } from './core/liveTutorial';
import { PresentationSpec, scaffoldPresentation, scanFolderContext, SlideSpec } from './core/presentation';
import { probe, summarize } from './core/probe';
import * as R from './core/recipes';
import * as VC from './core/voiceClone';
import { icon } from './icons';
import { announce, cfg, job, log, logLine, openMedia, state, storageDir, tools } from './util';
import { page } from './webviewKit';

export const GEMINI_SECRET_KEY = 'soundLab.gemini.apiKey';

export async function getGeminiApiKey(): Promise<string> {
  return (await state.context.secrets.get(GEMINI_SECRET_KEY)) || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

export async function cmdSetGeminiApiKey(): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    prompt: 'Gemini API key for Google ADK & Deep Research (stored securely in VS Code secret storage)',
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) { return undefined; }
  if (key) { await state.context.secrets.store(GEMINI_SECRET_KEY, key); }
  else { await state.context.secrets.delete(GEMINI_SECRET_KEY); }
  vscode.window.showInformationMessage(key ? 'Gemini API key saved.' : 'Gemini API key removed.');
  return key || undefined;
}

export class PresentationStudio {
  static current?: PresentationStudio;
  private session = path.join(storageDir('presentation-sessions'), `p-${Date.now()}`);
  private takes: (string | null)[] = [];
  private takeRecording?: AbortController;
  private draft?: { reference: string; referenceText: string };
  private liveSession?: LiveTutorialSession;
  private researchAbort?: AbortController;
  private initialFolder: string;
  private initialStep: number;

  private constructor(
    private panel: vscode.WebviewPanel,
    private ctl: MlxController,
    private ctx: vscode.ExtensionContext,
    private media: vscode.Uri,
    opts: { folder?: string; step?: number } = {},
  ) {
    this.initialFolder = opts.folder || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
    this.initialStep = opts.step ?? 1;
    panel.onDidDispose(() => {
      this.takeRecording?.abort();
      this.researchAbort?.abort();
      if (this.liveSession) { this.liveSession.stopAndFinalize().catch(() => undefined); }
      PresentationStudio.current = undefined;
      fs.rmSync(this.session, { recursive: true, force: true });
    });
    panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => {
      const msg = (e as Error).message.split('\n')[0];
      log(`Presentation Studio: ${(e as Error).message}`);
      this.post({ type: 'error', message: msg });
    }));
  }

  static open(ctl: MlxController, ctx: vscode.ExtensionContext, arg?: unknown, opts: { step?: number } = {}): void {
    let folder: string | undefined;
    if (arg instanceof vscode.Uri && fs.existsSync(arg.fsPath)) {
      folder = fs.statSync(arg.fsPath).isDirectory() ? arg.fsPath : path.dirname(arg.fsPath);
    }
    if (PresentationStudio.current) {
      PresentationStudio.current.panel.reveal();
      if (opts.step) { PresentationStudio.current.post({ type: 'init', initialStep: opts.step, profiles: PresentationStudio.current.profiles(), folder: folder || PresentationStudio.current.initialFolder }); }
      return;
    }
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    const roots = [
      media,
      vscode.Uri.file(storageDir()),
      vscode.Uri.file(os.tmpdir()),
      vscode.Uri.file(path.join(os.homedir(), 'Sound Lab')),
      ...(vscode.workspace.workspaceFolders || []).map(f => f.uri),
      ...(folder ? [vscode.Uri.file(folder)] : []),
    ];
    const panel = vscode.window.createWebviewPanel('soundLab.presentationStudio', 'Presentation & Tutorial Studio', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: roots,
    });
    panel.iconPath = { light: vscode.Uri.joinPath(media, 'icons', 'presentation-light.svg'), dark: vscode.Uri.joinPath(media, 'icons', 'presentation-dark.svg') };
    const inst = new PresentationStudio(panel, ctl, ctx, media, { folder, step: opts.step });
    PresentationStudio.current = inst;
    panel.webview.html = page({
      webview: panel.webview,
      media,
      title: 'Presentation & Tutorial Studio',
      script: 'presentation.js',
      css: ['presentation.css'],
      body: inst.body(),
    });
  }

  private post(m: unknown): void { this.panel.webview.postMessage(m); }
  private uri(file: string): string { return `${this.panel.webview.asWebviewUri(vscode.Uri.file(file))}?t=${Date.now()}`; }
  private profiles() { return VC.listProfiles(this.ctl.voicesDir).map(p => ({ ...p, refSrc: this.uri(p.reference) })); }

  private body(): string {
    return `<div class="pres-wrap">
<h1>${icon('presentation')} Presentation &amp; Tutorial Studio</h1>
<p class="muted">Clone your voice, run Google ADK Deep Research on your folder to scaffold a 5–10 minute instructional presentation, and record screen or slide tutorials with live transcription and cloned-voice audio overlay.</p>
<div class="steps">
  <span class="step" data-step="1">1 · Clone voice</span>
  <span class="step" data-step="2">2 · Topic &amp; folder</span>
  <span class="step" data-step="3">3 · Deep Research &amp; slides</span>
  <span class="step" data-step="4">4 · Present / Record &amp; Export</span>
</div>

<div id="pstep1">
  <div id="existingVoices" hidden>
    <h2>${icon('voice')}Your cloned voices</h2>
    <div id="voiceList" class="list"></div>
    <p class="small muted mt8">…or initialize a new cloned voice for this presentation:</p>
  </div>
  <div id="enrollSetup" class="card">
    <h3>${icon('voice-clone')}Initialize presenter voice</h3>
    <div class="col"><label for="vname">Voice name</label><input id="vname" type="text" placeholder="e.g. Presenter voice" maxlength="60"></div>
    <div class="row">
      <div class="col grow"><label for="cloneModel">Cloning model</label><select id="cloneModel">${CLONE_MODELS.map(m => `<option value="${m.id}">${m.label} — ${m.note}</option>`).join('')}</select></div>
      <div class="col grow"><label for="micDevice">Microphone</label><select id="micDevice"><option value="">Default microphone</option></select></div>
    </div>
    <label class="consent"><input id="consent" type="checkbox"><span>${VC.CONSENT_STATEMENT}</span></label>
    <div class="row mt12">
      <button id="startTakes" class="primary big" disabled>${icon('mic')}Start reading (5 sentences)</button>
      <button id="importVoice" class="link">${icon('folder')}Use an existing recording instead…</button>
    </div>
  </div>
  <div id="enrollRead" class="card" hidden>
    <div class="row"><span id="takeNo" class="pill"></span><div id="takeBar" class="takes"></div></div>
    <div id="takePrompt" class="prompt"></div>
    <div class="row">
      <button id="takeRec" class="primary big">${icon('record')}Record</button>
      <span id="takeRecTime" class="rec" hidden>${icon('record')}<span id="takeSecs">0.0</span> s</span>
      <span class="spacer"></span>
      <button id="takePrev" disabled>${icon('arrow-left')}Back</button>
      <button id="takeNext" class="primary" disabled>Next${icon('arrow-right')}</button>
    </div>
    <div id="takeInfo" class="col"></div>
    <audio id="takePlayer" controls hidden></audio>
  </div>
  <div id="enrollBuilt" class="card" hidden>
    <div id="buildingMsg" class="status">Building voice reference…</div>
    <div id="builtControls" hidden>
      <h2>${icon('voice')}Reference recording</h2>
      <audio id="refPlayer" controls></audio>
      <div class="col"><label for="refTranscript">Reference transcript (sent as <code>ref_text</code>)</label><textarea id="refTranscript" rows="2"></textarea></div>
      <div class="row"><input id="previewLine" type="text" value="Hello, my voice is ready for this instructional presentation."><button id="previewVoice">${icon('speak')}Preview</button></div>
      <audio id="previewAudio" controls hidden></audio>
      <div class="row mt12">
        <button id="rerecordVoice">${icon('record')}Re-record</button>
        <span class="spacer"></span>
        <button id="saveVoice" class="primary big">${icon('check')}Save voice &amp; continue</button>
      </div>
    </div>
  </div>
</div>

<div id="pstep2" hidden>
  <div class="row">
    <span>Voice:</span><b id="activeVoiceName"></b> <span id="activeVoiceModel" class="small muted"></span>
    <span class="spacer"></span>
    <span id="adkBadge" class="pill"></span>
    <span id="geminiKeyBadge" class="pill"></span>
    <button id="setGeminiKey" class="link">${icon('key')}Gemini API key</button>
    <button id="changeVoice" class="link">${icon('voice')}Change voice</button>
  </div>
  <div class="card mt8">
    <h3>${icon('wand')}What will this presentation be about?</h3>
    <div class="col"><label for="topicInput">Presentation topic &amp; learning goal</label><input id="topicInput" type="text" placeholder="e.g. Architecture and voice-cloning pipeline of Sound Lab"></div>
    <div class="row">
      <div class="col grow">
        <label>Folder to inspect &amp; ground slides in</label>
        <div class="row"><span id="folderDisplay" class="pill"></span><button id="pickFolder">${icon('folder')}Choose folder…</button></div>
      </div>
      <div class="col w160">
        <label for="minutesRange">Length: <span id="minutesVal">7 min</span></label>
        <input id="minutesRange" type="range" min="5" max="10" step="0.5" value="7">
      </div>
    </div>
    <div class="row">
      <div class="col grow"><label for="audienceInput">Audience</label><input id="audienceInput" type="text" value="Developers & technical learners"></div>
      <div class="col grow"><label for="researchAgent">Google ADK Deep Research Agent</label>
        <select id="researchAgent">
          <option value="deep-research-preview-04-2026">Deep Research (fast — deep-research-preview-04-2026)</option>
          <option value="deep-research-max-preview-04-2026">Deep Research Max (deepest — deep-research-max-preview-04-2026)</option>
        </select>
      </div>
    </div>
    <div class="row mt12">
      <button id="runResearch" class="primary big" disabled>${icon('wand')}Run Deep Research &amp; Scaffold 5–10 min Presentation</button>
      <span id="researchStatus" class="status"></span>
    </div>
    <div id="researchLog" class="live-feed mt8"></div>
  </div>
</div>

<div id="pstep3" hidden>
  <div class="row">
    <b id="deckSummary"></b>
    <span id="deckTimingPill" class="pill"></span>
    <span class="spacer"></span>
    <button id="openResearch" class="link">${icon('book')}Research report</button>
    <button id="openMd" class="link">${icon('open-external')}slides.md</button>
    <button id="openHtml" class="link">${icon('open-external')}Open HTML slides</button>
  </div>
  <div id="slidesEditor" class="list mt8"></div>
  <div class="row mt12">
    <button id="saveSlides">${icon('save')}Save slide edits</button>
    <span class="spacer"></span>
    <button id="toProduce" class="primary big">${icon('presentation')}Continue to Present / Record &amp; Export${icon('arrow-right')}</button>
  </div>
</div>

<div id="pstep4" hidden>
  <div class="row"><span>Presenter voice:</span><b id="stageVoiceName"></b></div>
  <div class="pres-grid2 mt8">
    <div class="card">
      <h3>${icon('presentation')}Option A · Auto-Overlay Slides with Cloned Audio &amp; Transcript</h3>
      <p class="small muted">Synthesizes each slide in your cloned voice via mlx-audio, renders 720p slide frames, writes .srt/.vtt/.txt/.json, and muxes audio + mov_text transcript into an MP4 tutorial.</p>
      <div id="noSlidesNotice" class="small warn" hidden>Scaffold a presentation in Steps 1–3 first to auto-overlay slides, or use Option B to record your screen directly.</div>
      <button id="overlaySlidesBtn" class="primary big mt8">${icon('speak')}Generate Cloned-Voice Slide Video Tutorial</button>
    </div>

    <div class="card">
      <h3>${icon('screen-record')}Option B · Record Screen / Present Slides Live</h3>
      <p class="small muted">Simultaneously captures screen or slide transitions + rolling audio chunks, writes a live transcript, clones narration in your voice, and embeds the transcript into the tutorial MP4.</p>
      <div class="row">
        <label><input type="radio" name="capMode" value="screen" checked> Screen + Mic capture</label>
        <label><input type="radio" name="capMode" value="slides"> Present scaffolded slides + Mic</label>
      </div>
      <div class="row">
        <div class="col grow"><label for="screenDevice">Screen</label><select id="screenDevice"><option value="1">Default screen</option></select></div>
        <div class="col grow"><label for="liveMicDevice">Microphone</label><select id="liveMicDevice"><option value="">Default microphone</option></select></div>
      </div>
      <label class="row small"><input id="cloneLiveChk" type="checkbox" checked> Clone spoken narration into my voice simultaneously</label>
      <div class="row mt8">
        <button id="startLiveBtn" class="primary big">${icon('record')}Start Recording / Presenting</button>
        <button id="stopLiveBtn" class="primary big" hidden>${icon('stop')}Stop &amp; Produce Video Tutorial</button>
        <span id="liveTimer" class="pill">0:00</span>
      </div>
    </div>
  </div>

  <div id="presenterCard" class="slide-stage mt12" hidden>
    <div class="row"><span id="presBadge" class="pill"></span><span class="spacer"></span>
      <button id="presPrev">${icon('arrow-left')}Prev</button>
      <button id="presNext" class="primary">Next${icon('arrow-right')}</button>
    </div>
    <h3 id="presSlideTitle"></h3>
    <ul id="presBullets"></ul>
    <pre id="presCode" hidden></pre>
    <p class="small muted" id="presNotes"></p>
  </div>

  <div class="card mt12">
    <h3>${icon('transcribe')}Live Transcript &amp; Production Status</h3>
    <div id="produceStatus" class="status"></div>
    <div id="liveTranscript" class="live-feed mt8"></div>
    <video id="tutorialPreview" class="preview" controls hidden></video>
    <div id="produceResults" class="list mt8"></div>
  </div>
</div>

<div id="perr" class="status err mt8"></div>
</div>`;
  }

  private async onMessage(m: { type: string; [k: string]: any }): Promise<void> {
    switch (m.type) {
      case 'ready': {
        const adk = checkAdkRuntime(this.ctx.extensionUri.fsPath, cfg().get<string>('adk.pythonPath') || undefined);
        const key = await getGeminiApiKey();
        this.post({
          type: 'init',
          profiles: this.profiles(),
          prompts: VC.enrollmentPrompts('presentation'),
          folder: this.initialFolder,
          initialStep: this.initialStep,
          defaultMinutes: cfg().get<number>('presentation.defaultMinutes') || 7,
          adkStatus: adk.available ? `Google ADK ${adk.adkVersion}` : 'Gemini Direct Fallback',
          hasGeminiKey: !!key,
        });
        this.loadDevices();
        break;
      }
      case 'recordTake': await this.recordTake(m.index, m.device); break;
      case 'stopTake': this.takeRecording?.abort(); break;
      case 'importVoice': await this.importVoice(); break;
      case 'buildVoice': await this.buildVoice(); break;
      case 'previewVoice': await this.previewVoice(m.text, m.model, m.refText); break;
      case 'saveVoice': {
        if (!m.consent) { throw new Error('Confirm voice cloning consent first.'); }
        if (!this.draft) { throw new Error('Build the voice reference first.'); }
        const p = VC.saveProfile(this.ctl.voicesDir, {
          name: m.name || 'Presenter voice',
          purpose: 'presentation',
          reference: this.draft.reference,
          referenceText: m.refText || this.draft.referenceText,
          model: m.model,
          consent: { confirmed: true, statement: VC.CONSENT_STATEMENT, at: new Date().toISOString() },
        });
        state.created.fire([p.reference]);
        this.post({ type: 'savedVoice', profile: { ...p, refSrc: this.uri(p.reference) }, profiles: this.profiles() });
        break;
      }
      case 'deleteVoice': {
        const ok = await vscode.window.showWarningMessage(`Delete cloned voice "${m.name}"?`, { modal: true }, 'Delete');
        if (ok) { VC.deleteProfile(this.ctl.voicesDir, m.id); this.post({ type: 'profiles', profiles: this.profiles() }); }
        break;
      }
      case 'pickFolder': {
        const f = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this folder' });
        if (f?.[0]) { this.post({ type: 'folderPicked', folder: f[0].fsPath }); }
        break;
      }
      case 'setGeminiKey': {
        await cmdSetGeminiApiKey();
        this.post({ type: 'geminiKeyUpdated', hasGeminiKey: !!(await getGeminiApiKey()) });
        break;
      }
      case 'researchAndScaffold': await this.researchAndScaffold({
        topic: String(m.topic || ''),
        folder: String(m.folder || this.initialFolder),
        minutes: Number(m.minutes || 7),
        audience: String(m.audience || ''),
        deepResearchAgent: String(m.deepResearchAgent || ''),
        profileId: m.profileId ? String(m.profileId) : undefined,
      }); break;
      case 'saveSlides': await this.saveSlides(m.dir, m.slides); break;
      case 'overlayPresentation': await this.overlayPresentation(m.dir, m.profileId); break;
      case 'startLiveTutorial': await this.startLiveTutorial({
        mode: m.mode === 'slides' ? 'slides' : 'screen',
        screenDevice: String(m.screenDevice || ''),
        micDevice: String(m.micDevice || ''),
        cloneVoice: m.cloneVoice !== false,
        profileId: String(m.profileId || ''),
        presentationDir: m.presentationDir ? String(m.presentationDir) : undefined,
        slideIndex: m.slideIndex !== undefined ? Number(m.slideIndex) : undefined,
      }); break;
      case 'markSlide': this.liveSession?.markSlide(Number(m.index) || 0); break;
      case 'stopLiveTutorial': await this.stopLiveTutorial(); break;
      case 'openFile': await openMedia(vscode.Uri.file(m.path)); break;
      case 'openExternal': await vscode.env.openExternal(vscode.Uri.file(m.path)); break;
      case 'revealFile': await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.path)); break;
    }
  }

  private async loadDevices(): Promise<void> {
    const fmt = cfg().get<string>('record.inputFormat') || '';
    const ff = tools().ffmpeg;
    const aArgs = R.listDevicesArgs(process.platform, fmt);
    const sArgs = R.listScreenDevicesArgs(process.platform, fmt);
    let audio: R.Device[] = [];
    let screen: R.ScreenDevice[] = [];
    if (aArgs) {
      const r = await run({ exe: ff, args: aArgs }).catch(() => undefined);
      if (r) {
        const out = r.stdout + '\n' + r.stderr;
        audio = R.parseDevices(process.platform, fmt, out);
        screen = R.parseScreenDevices(process.platform, fmt, out);
      }
    } else if (sArgs) {
      const r = await run({ exe: ff, args: sArgs }).catch(() => undefined);
      if (r) { screen = R.parseScreenDevices(process.platform, fmt, r.stdout + '\n' + r.stderr); }
    } else {
      screen = R.parseScreenDevices(process.platform, fmt, '');
    }
    this.post({ type: 'devices', audio, screen });
  }

  private async recordTake(index: number, device: string): Promise<void> {
    this.takeRecording?.abort();
    fs.mkdirSync(this.session, { recursive: true });
    const out = path.join(this.session, `take-${index + 1}-${Date.now()}.wav`);
    const ac = new AbortController();
    this.takeRecording = ac;
    const args = R.record(process.platform, cfg().get<string>('record.inputFormat') || '', device || cfg().get<string>('record.device') || '', out, 25, { format: 'wav', bitDepth: 16, sampleRate: 48000, channels: 1 });
    try {
      await runOk({
        exe: tools().ffmpeg, args, signal: ac.signal, gracefulStop: true,
        onLog: l => {
          const t = /time=\s*(\d+):(\d+):([\d.]+)/.exec(l);
          if (t) { this.post({ type: 'recTime', seconds: +t[1] * 3600 + +t[2] * 60 + +t[3] }); } else { logLine(l); }
        },
      });
    } catch (e) {
      this.post({ type: 'take', index, error: `Recording failed: ${(e as Error).message.split('\n').slice(-1)[0]}` });
      return;
    } finally { if (this.takeRecording === ac) { this.takeRecording = undefined; } }
    if (!fs.existsSync(out)) { this.post({ type: 'take', index, error: 'Nothing recorded.' }); return; }
    const report = await VC.checkTake(tools().ffmpeg, out);
    this.takes[index] = out;
    this.post({ type: 'take', index, src: this.uri(out), report });
  }

  private async importVoice(): Promise<void> {
    const f = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use as voice reference', filters: { Audio: ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'aiff', 'mp4', 'mov'] } });
    if (!f?.[0]) { return; }
    const s = summarize(await probe(tools().ffprobe, f[0].fsPath));
    if (s.duration < 5) { throw new Error('Use at least 5 seconds of clear speech.'); }
    fs.mkdirSync(this.session, { recursive: true });
    const out = path.join(this.session, 'imported.wav');
    await runOk({ exe: tools().ffmpeg, args: ['-hide_banner', '-nostdin', '-y', '-i', f[0].fsPath, '-map', '0:a:0', '-af', 'silenceremove=start_periods=1:start_threshold=-45dB', '-t', '30', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', out] });
    this.takes = [out];
    this.post({ type: 'importedVoice' });
  }

  private async buildVoice(): Promise<void> {
    const takes = this.takes.filter((t): t is string => !!t && fs.existsSync(t));
    const ref = path.join(this.session, 'reference.wav');
    this.post({ type: 'buildingVoice', status: 'Cleaning & joining voice takes…' });
    await VC.buildReference(tools().ffmpeg, takes, ref);
    let refText = takes.length === VC.enrollmentPrompts('presentation').length ? VC.enrollmentPrompts('presentation').join(' ') : '';
    try {
      this.post({ type: 'buildingVoice', status: 'Transcribing reference with mlx-audio…' });
      const client = await this.ctl.ensure();
      const tr = await client.transcribe(ref, { model: this.ctl.sttModel(), language: cfg().get<string>('transcription.language') || undefined });
      if (tr.text) { refText = tr.text; }
    } catch (e) { log(`Reference transcription skipped: ${(e as Error).message}`); }
    this.draft = { reference: ref, referenceText: refText };
    this.post({ type: 'builtVoice', refSrc: this.uri(ref), refText });
  }

  private async previewVoice(text: string, model: string, refText: string): Promise<void> {
    if (!this.draft) { throw new Error('Build the voice first.'); }
    const client = await this.ctl.ensure();
    const out = path.join(this.session, `preview-${Date.now()}.wav`);
    fs.writeFileSync(out, await client.speech(text || 'Hello, ready to present.', { model, refAudio: this.draft.reference, refText: refText || this.draft.referenceText, format: 'wav' }));
    this.post({ type: 'previewVoice', src: this.uri(out) });
  }

  private async researchAndScaffold(m: { topic: string; folder: string; minutes: number; audience: string; deepResearchAgent: string; profileId?: string }): Promise<void> {
    this.researchAbort?.abort();
    const ac = new AbortController();
    this.researchAbort = ac;
    const folderContext = scanFolderContext(m.folder);
    this.post({ type: 'researchLog', text: `Scanned ${folderContext.fileCount} files in ${folderContext.name}` });

    const outDir = path.join(m.folder, 'presentations', `${VC.slug(m.topic)}-${new Date().toISOString().slice(0, 10)}`);
    const apiKey = await getGeminiApiKey();
    const res = await runPresentationResearchWorkflow({
      extensionRoot: this.ctx.extensionUri.fsPath,
      topic: m.topic,
      folderPath: m.folder,
      folderContext,
      outputDir: outDir,
      targetMinutes: m.minutes,
      audience: m.audience,
      voiceProfileId: m.profileId,
      deepResearchAgent: m.deepResearchAgent || cfg().get<string>('adk.deepResearchAgent') || 'deep-research-preview-04-2026',
      model: cfg().get<string>('adk.model') || 'gemini-4-hydrogen',
      apiKey,
      pythonPath: cfg().get<string>('adk.pythonPath') || undefined,
      signal: ac.signal,
      onProgress: msg => this.post({ type: 'researchLog', text: msg }),
    });
    state.created.fire(Object.values(res.scaffold.files));
    this.post({ type: 'scaffolded', scaffold: res.scaffold, engine: res.engine });
  }

  private async saveSlides(dir: string, slides: SlideSpec[]): Promise<void> {
    const specFile = path.join(dir, 'presentation.json');
    const prev = JSON.parse(fs.readFileSync(specFile, 'utf8')) as PresentationSpec;
    const researchReport = fs.existsSync(path.join(dir, 'research-report.md')) ? fs.readFileSync(path.join(dir, 'research-report.md'), 'utf8') : '';
    const folderContext = scanFolderContext(prev.folderPath);
    const updated = scaffoldPresentation({
      outputDir: dir,
      title: prev.title,
      topic: prev.topic,
      folderContext,
      targetMinutes: prev.targetMinutes,
      audience: prev.audience,
      voiceProfileId: prev.voiceProfileId,
      researchReport,
      researchInteractionId: prev.researchInteractionId,
      slides,
    });
    this.post({ type: 'slidesSaved', scaffold: updated });
  }

  private async overlayPresentation(dir: string, profileId: string): Promise<void> {
    const p = VC.listProfiles(this.ctl.voicesDir).find(x => x.id === profileId);
    if (!p) { throw new Error('Pick a saved cloned voice profile first.'); }
    const spec = JSON.parse(fs.readFileSync(path.join(dir, 'presentation.json'), 'utf8')) as PresentationSpec;
    const files = await job(`Overlaying "${spec.title}" in ${p.name}'s voice`, async (rep, signal) => {
      const client = await this.ctl.ensure(signal);
      const speak: VC.Speak = async (text, out, sig) => {
        fs.writeFileSync(out, await client.speech(text, { model: p.model, refAudio: p.reference, refText: p.referenceText, format: 'wav', signal: sig }));
      };
      const r = await VC.renderSlidePresentationVideo(tools(), spec, dir, speak, {
        signal,
        onProgress: (f, msg) => { rep(f, msg); this.post({ type: 'produceProgress', text: msg }); },
      });
      return [r.video, r.narration, ...r.transcripts];
    });
    if (files) {
      state.created.fire(files);
      const video = files.find(f => f.endsWith('.mp4'));
      this.post({
        type: 'produced',
        videoSrc: video ? this.uri(video) : '',
        files: files.map(f => ({ path: f, name: path.basename(f) })),
      });
      await announce(files, 'Created tutorial');
    }
  }

  private async startLiveTutorial(m: { mode: 'screen' | 'slides'; screenDevice: string; micDevice: string; cloneVoice: boolean; profileId: string; presentationDir?: string; slideIndex?: number }): Promise<void> {
    const client = await this.ctl.ensure();
    const profile = m.cloneVoice ? VC.listProfiles(this.ctl.voicesDir).find(x => x.id === m.profileId) : undefined;
    let presentation: PresentationSpec | undefined;
    if (m.presentationDir && fs.existsSync(path.join(m.presentationDir, 'presentation.json'))) {
      presentation = JSON.parse(fs.readFileSync(path.join(m.presentationDir, 'presentation.json'), 'utf8')) as PresentationSpec;
    }
    const baseDir = m.presentationDir || path.join(this.initialFolder, 'tutorials', `tutorial-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
    const sess = new LiveTutorialSession({
      tools: tools(),
      outDir: baseDir,
      baseName: presentation ? VC.slug(presentation.title) : 'screen-tutorial',
      mode: m.mode,
      videoDevice: m.screenDevice || cfg().get<string>('record.screenDevice') || undefined,
      audioFormat: cfg().get<string>('record.inputFormat') || undefined,
      audioDevice: m.micDevice || cfg().get<string>('record.device') || undefined,
      chunkSeconds: cfg().get<number>('record.chunkSeconds') || 8,
      presentation,
      transcribeChunk: (wav, sig) => client.transcribe(wav, { model: this.ctl.sttModel(), signal: sig }),
      speak: profile ? async (text, out, sig) => {
        fs.writeFileSync(out, await client.speech(text, { model: profile.model, refAudio: profile.reference, refText: profile.referenceText, format: 'wav', signal: sig }));
      } : undefined,
      onLog: logLine,
    });
    sess.on('transcript', ev => this.post({ type: 'liveTranscript', segments: ev.segments }));
    sess.on('cloned', ev => this.post({ type: 'liveCloned', ...ev }));
    sess.on('warning', msg => log(`Live tutorial warning: ${msg}`));
    if (m.slideIndex && m.slideIndex > 0) { sess.markSlide(m.slideIndex); }
    this.liveSession = sess;
    await sess.start();
  }

  private async stopLiveTutorial(): Promise<void> {
    const sess = this.liveSession;
    if (!sess) { return; }
    this.liveSession = undefined;
    const res = await sess.stopAndFinalize();
    const files = [res.video, ...(res.narration ? [res.narration] : []), ...res.transcripts];
    state.created.fire(files);
    this.post({
      type: 'produced',
      videoSrc: this.uri(res.video),
      files: files.map(f => ({ path: f, name: path.basename(f) })),
    });
    await announce(files, 'Produced tutorial');
  }
}
