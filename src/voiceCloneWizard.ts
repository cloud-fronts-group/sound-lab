// Voice Clone wizard: consent → read prompted sentences (recorded with ffmpeg) → build & preview the cloned voice →
// narrate a presentation, an audiobook, or vocals over an instrumental with the mlx-audio server.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MlxController, CLONE_MODELS } from './mlx';
import * as VC from './core/voiceClone';
import * as R from './core/recipes';
import { run, runOk } from './core/ffmpeg';
import { probe, summarize } from './core/probe';
import { toSrt, Segment } from './core/subtitles';
import { icon } from './icons';
import { page } from './webviewKit';
import { cfg, tools, job, log, logLine, state, storageDir, openMedia, announce } from './util';

const PURPOSES: Record<VC.Purpose, { label: string; icon: string; blurb: string }> = {
  presentation: { label: 'Presentation', icon: 'presentation', blurb: 'Transcribe a recorded talk (or use a script) and re-narrate it cleanly in your voice. Video gets a new narration track.' },
  audiobook: { label: 'Audiobook', icon: 'book', blurb: 'Narrate a manuscript chapter by chapter, mastered to audiobook levels (ACX), with chapter markers.' },
  vocals: { label: 'Vocals over an instrumental', icon: 'music', blurb: 'Place spoken or chanted lines on the beat grid of an instrumental, with tempo-synced echo and ducking.' },
};

export class VoiceCloneWizard {
  static current?: VoiceCloneWizard;
  private recording?: AbortController;
  private takes: (string | null)[] = [];
  private session = path.join(storageDir('voice-sessions'), `s-${Date.now()}`);
  private draft?: { reference: string; referenceText: string };

  private constructor(private panel: vscode.WebviewPanel, private ctl: MlxController, private media: vscode.Uri, private preselect?: string) {
    panel.onDidDispose(() => { this.recording?.abort(); VoiceCloneWizard.current = undefined; fs.rmSync(this.session, { recursive: true, force: true }); });
    panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => {
      const msg = (e as Error).message.split('\n')[0];
      log(`Voice clone: ${(e as Error).message}`);
      this.post({ type: 'error', message: msg });
    }));
  }

  static open(ctl: MlxController, ctx: vscode.ExtensionContext, arg?: unknown): void {
    const profileId = arg && typeof arg === 'object' && 'profileId' in (arg as object) ? String((arg as { profileId: string }).profileId) : undefined;
    if (VoiceCloneWizard.current) {
      VoiceCloneWizard.current.panel.reveal();
      if (profileId) { VoiceCloneWizard.current.post({ type: 'useProfile', id: profileId }); }
      return;
    }
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    const roots = [media, vscode.Uri.file(storageDir()), vscode.Uri.file(os.tmpdir()), vscode.Uri.file(path.join(os.homedir(), 'Sound Lab')), ...(vscode.workspace.workspaceFolders || []).map(f => f.uri)];
    const panel = vscode.window.createWebviewPanel('soundLab.voiceClone', 'Voice Clone', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots });
    panel.iconPath = { light: vscode.Uri.joinPath(media, 'icons', 'voice-clone-light.svg'), dark: vscode.Uri.joinPath(media, 'icons', 'voice-clone-dark.svg') };
    const w = new VoiceCloneWizard(panel, ctl, media, profileId);
    VoiceCloneWizard.current = w;
    panel.webview.html = page({ webview: panel.webview, media, title: 'Voice Clone', script: 'voice-clone.js', body: w.body() });
  }

  private post(m: unknown): void { this.panel.webview.postMessage(m); }
  private uri(file: string): string { return `${this.panel.webview.asWebviewUri(vscode.Uri.file(file))}?t=${Date.now()}`; }

  private body(): string {
    const cards = (Object.keys(PURPOSES) as VC.Purpose[]).map(k => `
      <div class="choice" data-purpose="${k}" tabindex="0" role="button">${icon(PURPOSES[k].icon)}<b>${PURPOSES[k].label}</b><span class="small muted">${PURPOSES[k].blurb}</span></div>`).join('');
    return `<div class="editor-wrap">
<h1>${icon('voice-clone')} Voice clone</h1>
<p class="muted">Read a few sentences aloud. Sound Lab builds a reference of your voice and uses an MLX voice-cloning model to narrate in it.</p>
<div class="steps"><span class="step" data-step="1">1 · Set up</span><span class="step" data-step="2">2 · Read aloud</span><span class="step" data-step="3">3 · Your voice</span><span class="step" data-step="4">4 · Create</span></div>

<div id="step1">
  <div id="existing" hidden><h2>${icon('voice')}Your voices</h2><div id="profiles" class="list"></div><p class="small muted">…or make a new one:</p></div>
  <div class="col"><label for="vname">Voice name</label><input id="vname" type="text" placeholder="e.g. My narration voice" maxlength="60"></div>
  <div class="col"><label>What will you make with it?</label><div class="grid3" id="purposes">${cards}</div></div>
  <div class="row">
    <div class="col grow"><label for="model">Cloning model</label><select id="model">${CLONE_MODELS.map(m => `<option value="${m.id}">${m.label} — ${m.note}</option>`).join('')}</select></div>
    <div class="col grow"><label for="device">Microphone</label><select id="device"><option value="">Default input</option></select></div>
  </div>
  <label class="consent"><input id="consent" type="checkbox"><span>${VC.CONSENT_STATEMENT} I will not use a cloned voice to impersonate anyone or to deceive listeners.</span></label>
  <div class="row mt12"><button id="toRecord" class="primary big" disabled>${icon('mic')}Start reading</button><button id="import" class="link">${icon('folder')}Use an existing recording of me instead…</button></div>
</div>

<div id="step2" hidden>
  <div class="row"><span id="promptNo" class="pill"></span><div id="takeBar" class="takes"></div><span class="spacer"></span><span class="small muted">Quiet room · normal speaking voice · 15–30 cm from the mic</span></div>
  <div id="prompt" class="prompt"></div>
  <div class="row">
    <button id="rec" class="primary big">${icon('record')}Record</button>
    <span id="recTime" class="rec" hidden>${icon('record')}<span id="recSecs">0.0</span> s</span>
    <span class="spacer"></span>
    <button id="prev" disabled>${icon('arrow-left')}Back</button>
    <button id="next" class="primary" disabled>Next${icon('arrow-right')}</button>
  </div>
  <div id="takeInfo" class="col"></div>
  <audio id="takePlayer" controls hidden></audio>
</div>

<div id="step3" hidden>
  <div id="building" class="status">Building your voice…</div>
  <div id="built" hidden>
    <h2>${icon('voice')}Reference recording</h2>
    <audio id="refPlayer" controls></audio>
    <div class="col"><label for="refText">What you said (used by the cloning model; fix any mistakes)</label><textarea id="refText"></textarea></div>
    <h2 class="mt14">${icon('speak')}Preview in your cloned voice</h2>
    <div class="row"><input id="previewText" type="text" value="Hi, this is my Sound Lab voice. It should sound a lot like me."><button id="preview">${icon('speak')}Preview</button></div>
    <audio id="previewPlayer" controls hidden></audio>
    <div class="row mt12"><button id="rerecord">${icon('record')}Re-record</button><span class="spacer"></span><button id="save" class="primary big">${icon('check')}Sounds like me — save voice</button></div>
  </div>
</div>

<div id="step4" hidden>
  <div class="row"><span>Voice:</span><b id="useName"></b><span id="useModel" class="small muted"></span><span class="spacer"></span><button id="changeVoice" class="link">${icon('voice')}Change voice</button></div>
  <div class="grid3" id="purposes4">${cards}</div>

  <div id="form-presentation" class="card" hidden>
    <h3>${icon('presentation')}Presentation</h3>
    <div class="row"><label><input type="radio" name="psrc" value="recording" checked> Recorded talk (audio/video): transcribe, then re-narrate in sync</label></div>
    <div class="row"><label><input type="radio" name="psrc" value="file"> Script file (.txt / .md)</label></div>
    <div class="row"><label><input type="radio" name="psrc" value="editor"> Text in the active editor</label></div>
    <div class="row"><button data-pick="presentation">${icon('folder')}Choose file…</button><span id="pick-presentation" class="small muted"></span></div>
  </div>

  <div id="form-audiobook" class="card" hidden>
    <h3>${icon('book')}Audiobook</h3>
    <p class="small muted">Chapters start at Markdown headings (#, ##), “Chapter …” lines or ---. Output: one MP3 per chapter (44.1 kHz, 192 kb/s, peaks ≤ −3 dB, room tone) plus a full book with chapter markers.</p>
    <div class="row"><label><input type="radio" name="asrc" value="file" checked> Manuscript file (.txt / .md)</label><label><input type="radio" name="asrc" value="editor"> Active editor</label></div>
    <div class="row"><button data-pick="audiobook">${icon('folder')}Choose manuscript…</button><span id="pick-audiobook" class="small muted"></span></div>
  </div>

  <div id="form-vocals" class="card" hidden>
    <h3>${icon('music')}Vocals over an instrumental</h3>
    <div class="row"><button data-pick="vocals">${icon('folder')}Choose instrumental…</button><span id="pick-vocals" class="small muted"></span></div>
    <div class="row"><div class="col w120"><label for="bpm">Tempo (BPM)</label><input id="bpm" type="number" min="40" max="220" value="90"></div>
      <label class="mt18"><input id="double" type="checkbox" checked> Double the voice</label></div>
    <div class="col"><label for="cues">Lines — one per line. Place with <code>@bar</code> or <code>[m:ss]</code>; untimed lines follow the previous one.</label>
      <textarea id="cues" rows="6">@5 Feel the night come alive
@9 Hands up, here we go
Lose yourself in the sound
@17 One more time</textarea></div>
  </div>

  <div class="row mt12"><button id="create" class="primary big" disabled>${icon('play')}Create</button><span id="progress" class="status"></span></div>
  <div id="results" class="list"></div>
</div>
<div id="err" class="status err"></div>
</div>`;
  }

  private outDir(purpose: string): string {
    const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.join(os.homedir(), 'Sound Lab');
    const d = path.join(base, 'voice-clone', `${purpose}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  private profiles() { return VC.listProfiles(this.ctl.voicesDir).map(p => ({ ...p, refSrc: this.uri(p.reference) })); }

  private async onMessage(m: { type: string; [k: string]: any }): Promise<void> {
    switch (m.type) {
      case 'ready': {
        this.post({ type: 'init', prompts: { presentation: VC.enrollmentPrompts('presentation'), audiobook: VC.enrollmentPrompts('audiobook'), vocals: VC.enrollmentPrompts('vocals') },
          profiles: this.profiles(), model: this.ctl.cloneModel(), preselect: this.preselect, device: cfg().get<string>('record.device') || '' });
        this.listDevices();
        break;
      }
      case 'record': await this.record(m.index, m.device); break;
      case 'stop': this.recording?.abort(); break;
      case 'import': await this.importRecording(); break;
      case 'build': await this.build(m.purpose); break;
      case 'preview': await this.preview(m.text, m.model, m.refText); break;
      case 'save': {
        if (!m.consent) { throw new Error('Please confirm the consent statement first.'); }
        if (!this.draft) { throw new Error('Build the voice first.'); }
        const p = VC.saveProfile(this.ctl.voicesDir, { name: m.name || 'My voice', purpose: m.purpose, reference: this.draft.reference, referenceText: m.refText || this.draft.referenceText, model: m.model, consent: { confirmed: true, statement: VC.CONSENT_STATEMENT, at: new Date().toISOString() } });
        state.created.fire([p.reference]);
        this.post({ type: 'saved', profile: { ...p, refSrc: this.uri(p.reference) }, profiles: this.profiles() });
        break;
      }
      case 'deleteVoice': {
        const ok = await vscode.window.showWarningMessage(`Delete the cloned voice "${m.name}"?`, { modal: true }, 'Delete');
        if (ok) { VC.deleteProfile(this.ctl.voicesDir, m.id); this.post({ type: 'profiles', profiles: this.profiles() }); }
        break;
      }
      case 'pick': {
        const filters: Record<string, Record<string, string[]>> = {
          presentation: m.source === 'recording' ? { 'Audio / video': ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'mp4', 'mov', 'mkv', 'webm'] } : { Text: ['txt', 'md', 'markdown'] },
          audiobook: { Manuscript: ['txt', 'md', 'markdown'] }, vocals: { Instrumental: ['wav', 'mp3', 'flac', 'm4a', 'aiff', 'aif', 'ogg'] },
        };
        const f = await vscode.window.showOpenDialog({ canSelectMany: false, filters: filters[m.purpose], openLabel: 'Use this file' });
        if (f) { this.post({ type: 'picked', purpose: m.purpose, path: f[0].fsPath, name: path.basename(f[0].fsPath) }); }
        break;
      }
      case 'create': await this.create(m as any); break;
      case 'open': await openMedia(vscode.Uri.file(m.path)); break;
      case 'reveal': await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.path)); break;
    }
  }

  private async listDevices(): Promise<void> {
    const fmt = cfg().get<string>('record.inputFormat') || '';
    const a = R.listDevicesArgs(process.platform, fmt);
    if (!a) { return; }
    const r = await run({ exe: tools().ffmpeg, args: a }).catch(() => undefined);
    if (r) { this.post({ type: 'devices', list: R.parseDevices(process.platform, fmt, r.stdout + '\n' + r.stderr) }); }
  }

  /** Record one take with ffmpeg (webviews cannot open the microphone) until the user presses Stop. */
  private async record(index: number, device: string): Promise<void> {
    this.recording?.abort();
    fs.mkdirSync(this.session, { recursive: true });
    const out = path.join(this.session, `take-${index + 1}-${Date.now()}.wav`);
    const ac = new AbortController(); this.recording = ac;
    const args = R.record(process.platform, cfg().get<string>('record.inputFormat') || '', device || cfg().get<string>('record.device') || '', out, 25, { format: 'wav', bitDepth: 16, sampleRate: 48000, channels: 1 });
    log(`$ ffmpeg ${args.join(' ')}`);
    this.post({ type: 'recording', index });
    let elapsed = 0;
    try {
      await runOk({ exe: tools().ffmpeg, args, signal: ac.signal, gracefulStop: true, onLog: l => {
        const t = /time=\s*(\d+):(\d+):([\d.]+)/.exec(l);
        if (t) { elapsed = +t[1] * 3600 + +t[2] * 60 + +t[3]; this.post({ type: 'recTime', index, seconds: elapsed }); } else { logLine(l); }
      } });
    } catch (e) {
      this.post({ type: 'take', index, error: `Recording failed: ${(e as Error).message.split('\n').slice(-1)[0]}. Check the microphone setting (soundLab.record.*) and macOS microphone permission for VS Code.` });
      return;
    } finally { if (this.recording === ac) { this.recording = undefined; } }
    if (!fs.existsSync(out)) { this.post({ type: 'take', index, error: 'Nothing was recorded.' }); return; }
    const report = await VC.checkTake(tools().ffmpeg, out);
    this.takes[index] = out;
    this.post({ type: 'take', index, src: this.uri(out), report });
  }

  private async importRecording(): Promise<void> {
    const f = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use as my voice reference', filters: { Audio: ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'aiff', 'aif', 'mp4', 'mov'] } });
    if (!f) { return; }
    const s = summarize(await probe(tools().ffprobe, f[0].fsPath));
    if (s.duration < 5) { throw new Error('Use at least 5 seconds of clear speech (10–30 s is best).'); }
    fs.mkdirSync(this.session, { recursive: true });
    const out = path.join(this.session, 'imported.wav');
    // keep at most 30 s from the first speech onward
    await runOk({ exe: tools().ffmpeg, args: ['-hide_banner', '-nostdin', '-y', '-i', f[0].fsPath, '-map', '0:a:0', '-af', 'silenceremove=start_periods=1:start_threshold=-45dB', '-t', '30', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', out] });
    this.takes = [out];
    this.post({ type: 'imported', name: path.basename(f[0].fsPath), seconds: Math.min(30, s.duration) });
  }

  private async build(purpose: VC.Purpose): Promise<void> {
    const takes = this.takes.filter((t): t is string => !!t && fs.existsSync(t));
    const reference = path.join(this.session, 'reference.wav');
    this.post({ type: 'building', status: 'Cleaning and joining your takes…' });
    await VC.buildReference(tools().ffmpeg, takes, reference);
    // The cloning model needs the words spoken in the reference: transcribe it (fall back to the prompts).
    let referenceText = takes.length === VC.enrollmentPrompts(purpose).length ? VC.enrollmentPrompts(purpose).join(' ') : '';
    try {
      this.post({ type: 'building', status: 'Transcribing your reference with the mlx-audio server…' });
      const client = await this.ctl.ensure();
      const t = await client.transcribe(reference, { model: this.ctl.sttModel(), language: cfg().get<string>('transcription.language') || undefined });
      if (t.text) { referenceText = t.text; }
    } catch (e) { log(`Reference transcription skipped: ${(e as Error).message}`); }
    this.draft = { reference, referenceText };
    this.post({ type: 'built', refSrc: this.uri(reference), refText: referenceText });
  }

  private async speakTo(out: string, text: string, model: string, ref: string, refText: string, signal?: AbortSignal): Promise<void> {
    const client = await this.ctl.ensure(signal);
    fs.writeFileSync(out, await client.speech(text, { model, refAudio: ref, refText, format: 'wav', signal }));
  }

  private async preview(text: string, model: string, refText: string): Promise<void> {
    if (!this.draft) { throw new Error('Build the voice first.'); }
    this.post({ type: 'previewing' });
    const out = path.join(this.session, `preview-${Date.now()}.wav`);
    await this.speakTo(out, text || 'Hello, this is my Sound Lab voice.', model, this.draft.reference, refText || this.draft.referenceText);
    this.post({ type: 'preview', src: this.uri(out) });
  }

  private async create(m: { profileId: string; purpose: VC.Purpose; source?: string; file?: string; bpm?: number; cues?: string; double?: boolean }): Promise<void> {
    const p = VC.listProfiles(this.ctl.voicesDir).find(x => x.id === m.profileId);
    if (!p) { throw new Error('Pick a saved voice first.'); }
    const t = tools();
    const speak: VC.Speak = (text, out, signal) => this.speakTo(out, text, p.model, p.reference, p.referenceText, signal);
    const editorText = () => {
      const ed = vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file' || e.document.uri.scheme === 'untitled');
      const s = ed?.document.getText().trim();
      if (!s) { throw new Error('Open the text in an editor first (or choose a file).'); }
      return { text: s, base: ed!.document.isUntitled ? 'script' : path.parse(ed!.document.fileName).name };
    };
    const files = await job(`${PURPOSES[m.purpose].label} in ${p.name}'s voice`, async (rep, signal) => {
      const hooks = { signal, onProgress: (f: number, msg: string) => { rep(f, msg); this.post({ type: 'progress', text: msg, fraction: f }); }, onLog: logLine };
      await this.ctl.ensure(signal);
      if (m.purpose === 'audiobook') {
        const src = m.source === 'editor' ? editorText() : (() => { if (!m.file) { throw new Error('Choose a manuscript.'); } return { text: fs.readFileSync(m.file, 'utf8'), base: path.parse(m.file).name }; })();
        const r = await VC.renderAudiobook(t, src.text, this.outDir(`audiobook-${VC.slug(src.base)}`), speak, hooks);
        return [r.full, ...r.chapters];
      }
      if (m.purpose === 'presentation') {
        const out = this.outDir('presentation');
        if (m.source === 'recording') {
          if (!m.file) { throw new Error('Choose the recorded presentation.'); }
          const s = summarize(await probe(t.ffprobe, m.file));
          hooks.onProgress(0.02, 'Transcribing the presentation…');
          const wav = path.join(this.session, 'talk16k.wav');
          fs.mkdirSync(this.session, { recursive: true });
          await runOk({ exe: t.ffmpeg, args: R.toWhisperWav(m.file, wav), signal });
          const client = await this.ctl.ensure(signal);
          const tr = await client.transcribe(wav, { model: this.ctl.sttModel(), signal });
          const segs: Segment[] = tr.segments.length ? tr.segments : [{ start: 0, end: s.duration, text: tr.text }];
          const base = path.parse(m.file).name;
          fs.writeFileSync(path.join(out, `${base} (transcript).srt`), toSrt(segs));
          const r = await VC.renderPresentation(t, segs, out, speak, { ...hooks, video: s.hasVideo ? m.file : undefined, baseName: base, lang: tr.language });
          if (r.pushed) { log(`${r.pushed} narrated line(s) ran longer than the original and were pushed later.`); }
          return [r.video, r.narration, path.join(out, `${base} (transcript).srt`)].filter((x): x is string => !!x);
        }
        const src = m.source === 'editor' ? editorText() : (() => { if (!m.file) { throw new Error('Choose a script.'); } return { text: fs.readFileSync(m.file, 'utf8'), base: path.parse(m.file).name }; })();
        const r = await VC.renderPresentation(t, src.text, out, speak, { ...hooks, baseName: src.base });
        fs.writeFileSync(path.join(out, `${src.base} (narration).srt`), toSrt(r.timeline));
        return [r.narration, path.join(out, `${src.base} (narration).srt`)];
      }
      if (!m.file) { throw new Error('Choose the instrumental.'); }
      const bpm = Number(m.bpm) || 90;
      const cues = VC.parseVocalCues(m.cues || '', bpm);
      const out = path.join(this.outDir('vocals'), `${path.parse(m.file).name} + ${VC.slug(p.name)} vocals.wav`);
      const r = await VC.renderVocals(t, m.file, cues, bpm, out, speak, { ...hooks, doubleVoice: m.double !== false });
      return [r.mix, r.stem];
    });
    if (files) {
      state.created.fire(files);
      this.post({ type: 'done', files: files.map(f => ({ path: f, name: path.basename(f), src: /\.(wav|mp3|flac|ogg|m4a)$/i.test(f) ? this.uri(f) : '' })) });
      announce(files, 'Created');
    } else { this.post({ type: 'progress', text: 'Cancelled or failed — see the Sound Lab log.', error: true }); }
  }
}
