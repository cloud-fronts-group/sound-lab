// End-to-end check of the mlx-audio experience WITHOUT VS Code: the real extension-side classes (MlxController,
// MlxPanelProvider, VoiceCloneWizard, StudioPanel + StudioTools) run against a mocked `vscode` module, a mock mlx-audio server,
// ffmpeg (a lavfi "voice" stands in for the microphone) and — when available — the real mlx-audio Studio dev server.
// The webviews render in Chromium with their real CSP; messages flow both ways. Screenshots → test/ui/out/.
//
//   node test/ui/mlx-harness.js [--studio /path/to/mlx_audio/ui]
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const argStudio = process.argv.includes('--studio') ? process.argv[process.argv.indexOf('--studio') + 1] : process.env.MLX_STUDIO_DIR;
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✔' : '✖'} ${msg}`); if (!cond) { failures++; } };
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadPlaywright() {
  try { return require('playwright'); } catch { /* global */ }
  return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'soundlab-mlxui-'));
  fs.mkdirSync(OUT, { recursive: true });
  const apiPort = await freePort(); const studioPort = await freePort();
  const mock = spawn(process.execPath, [path.join(ROOT, 'test', 'fixtures', 'mock-mlx-audio.js'), String(apiPort)], { env: { ...process.env, MOCK_MLX_LOG: path.join(work, 'mlx.log') }, stdio: 'ignore' });

  // ------------------------------------------------------------ vscode mock
  const settings = {
    'mlx.mode': 'external', 'mlx.url': `http://127.0.0.1:${apiPort}`, 'mlx.studio.port': studioPort, 'mlx.studio.path': argStudio || '',
    'mlx.python': '/nonexistent-python', 'mlx.autoStart': true,
    // A lavfi "voice" (pitched bursts with pauses) replaces the microphone so recording runs for real through ffmpeg.
    'record.inputFormat': 'lavfi', 'record.device': "aevalsrc='0.3*sin(2*PI*170*t)*lt(mod(t,0.55),0.4)*gt(t,0.3)':s=48000,arealtime",
    'transcription.language': 'en',
  };
  const dialogQueue = [];
  const opened = [];
  class Uri { constructor(p, s = 'file') { this.fsPath = p; this.path = p; this.scheme = s; } static file(p) { return new Uri(p); } static parse(s) { const u = new Uri(s, s.split(':')[0]); u._str = s; return u; } static joinPath(u, ...s) { return new Uri(path.join(u.fsPath, ...s)); } toString() { return this._str || 'file://' + this.fsPath; } }
  class Emitter { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(v) { this.l.forEach(f => f(v)); } dispose() {} }
  const panels = [];
  const fakeWebview = () => {
    const wv = { cspSource: 'file:', options: {}, html: '', handlers: [], posted: [], page: null,
      asWebviewUri: (u) => u.toString(),
      onDidReceiveMessage(fn) { wv.handlers.push(fn); return { dispose() {} }; },
      postMessage(m) { wv.posted.push(m); if (wv.page) { wv.page.evaluate(x => window.postMessage(x, '*'), m).catch(() => undefined); } return Promise.resolve(true); } };
    return wv;
  };
  const vscode = {
    Uri, EventEmitter: Emitter, ThemeColor: class {}, MarkdownString: class { constructor(v) { this.value = v; } },
    ViewColumn: { Active: -1, Beside: -2 }, ProgressLocation: { Notification: 15 }, StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1 }, QuickPickItemKind: { Default: 0 },
    window: {
      state: { focused: true },
      createOutputChannel: () => ({ appendLine: (l) => fs.appendFileSync(path.join(work, 'output.log'), l + '\n'), show() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      createWebviewPanel: (id, title) => { const p = { id, title, webview: fakeWebview(), reveal() {}, onDidDispose() { return { dispose() {} }; }, iconPath: null }; panels.push(p); return p; },
      showInformationMessage: async (msg, ...a) => { const items = a.filter(x => typeof x === 'string'); return items.find(i => /Start|Download/.test(i)); },
      showWarningMessage: async (msg, ...a) => a.filter(x => typeof x === 'string')[0],
      showErrorMessage: async (m) => { console.log('   [error message]', m); },
      showOpenDialog: async () => dialogQueue.shift(),
      showQuickPick: async (items) => (await items)[0],
      withProgress: async (_o, task) => task({ report() {} }, { onCancellationRequested() {} }),
      visibleTextEditors: [], activeTextEditor: undefined,
    },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d), update: async (k, v) => { settings[k] = v; } }),
      onDidChangeConfiguration: () => ({ dispose() {} }), workspaceFolders: [{ uri: Uri.file(work), name: 'ws' }],
      getWorkspaceFolder: () => ({ uri: Uri.file(work) }),
    },
    commands: { executeCommand: async (id, ...a) => { opened.push([id, ...a.map(String)]); } },
    env: { asExternalUri: async (u) => u, openExternal: async () => true, clipboard: { writeText: async () => {} } },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : orig.call(this, req, ...rest); };

  const { state } = require(path.join(ROOT, 'out', 'util'));
  const { MlxController } = require(path.join(ROOT, 'out', 'mlx'));
  const { MlxPanelProvider } = require(path.join(ROOT, 'out', 'mlxPanel'));
  const { VoiceCloneWizard } = require(path.join(ROOT, 'out', 'voiceCloneWizard'));
  const { StudioPanel } = require(path.join(ROOT, 'out', 'studioPanel'));
  const ctx = { subscriptions: [], extensionUri: Uri.file(ROOT), globalStorageUri: Uri.file(path.join(work, 'storage')), secrets: { get: async () => undefined } };
  state.context = ctx; state.output = vscode.window.createOutputChannel(); state.statusItem = vscode.window.createStatusBarItem();
  const mlx = new MlxController(ctx);
  await mlx.client.waitReady(15000);

  // ------------------------------------------------------------ browser plumbing
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const errors = [];
const THEME = `<style>:root{--vscode-foreground:#cccccc;--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#181818;--vscode-font-family:-apple-system,Segoe UI,sans-serif;--vscode-font-size:13px;
--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#1177bb;--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#ccc;--vscode-button-secondaryHoverBackground:#45494e;
--vscode-badge-background:#4d4d4d;--vscode-badge-foreground:#fff;--vscode-charts-blue:#3794ff;--vscode-descriptionForeground:#9d9d9d;--vscode-widget-border:#303031;--vscode-textLink-foreground:#3794ff;
--vscode-list-hoverBackground:#2a2d2e;--vscode-input-background:#313131;--vscode-input-foreground:#ccc;--vscode-input-border:#3c3c3c;--vscode-editor-font-family:Menlo,monospace;--vscode-focusBorder:#0078d4;
--vscode-testing-iconPassed:#73c991;--vscode-editorWarning-foreground:#cca700;--vscode-errorForeground:#f48771;--vscode-textBlockQuote-background:#2b2b2b;--vscode-toolbar-hoverBackground:#5a5d5e50}</style>`;
  async function mount(wv, file, size) {
    fs.writeFileSync(file, wv.html.replace('<head>', '<head>' + THEME)); // before the CSP meta, like VS Code's own injected theme
    const page = await browser.newPage({ viewport: size });
    page.on('pageerror', e => errors.push(`${path.basename(file)}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource|Refused to frame/.test(m.text())) { errors.push(`${path.basename(file)}: ${m.text()}`); } });
    await page.exposeFunction('__toExt', m => { for (const h of wv.handlers) { h(m); } });
    await page.addInitScript(() => { let st; window.acquireVsCodeApi = () => ({ postMessage: m => window.__toExt(m), getState: () => st, setState: s => { st = s; } }); });
    wv.page = page;
    await page.goto('file://' + file);
    return page;
  }
  const waitFor = async (pred, ms = 20000, what = '') => { const t = Date.now(); while (Date.now() - t < ms) { if (await pred()) { return true; } await sleep(150); } console.log(`   timed out waiting for ${what}`); return false; };

  // ------------------------------------------------------------ 1. MLX Audio sidebar
  const provider = new MlxPanelProvider(ctx, mlx);
  const view = { webview: fakeWebview(), visible: true, onDidChangeVisibility() { return { dispose() {} }; } };
  provider.resolveWebviewView(view);
  const side = await mount(view.webview, path.join(work, 'mlx-panel.html'), { width: 360, height: 1000 });
  check(/default-src 'none'/.test(view.webview.html) && /script-src 'nonce-/.test(view.webview.html), 'MLX panel ships a strict nonce CSP');
  await waitFor(() => side.evaluate(() => document.getElementById('srvText').textContent.startsWith('Running')), 10000, 'server running');
  check(await side.evaluate(() => document.getElementById('srvText').textContent.startsWith('Running')), 'panel shows the server as running');
  await waitFor(() => side.evaluate(() => document.querySelectorAll('#voice option').length >= 3), 10000, 'Kokoro voices');
  check((await side.$$eval('#voice option', o => o.map(x => x.value))).join() === 'af_heart,am_adam,bf_emma', 'voices listed from /v1/audio/voices');
  await side.fill('#text', 'Welcome back to Sound Lab radio. Here is the next track.');
  await side.selectOption('#voice', 'bf_emma');
  await side.click('#speak');
  check(await waitFor(() => side.evaluate(() => !document.getElementById('result').hidden), 20000, 'tts result'), 'Speak produces a playable result');
  const tts = fs.readFileSync(path.join(work, 'mlx.log'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.path === '/v1/audio/speech').pop();
  check(tts && tts.voice === 'bf_emma' && tts.model === 'mlx-community/Kokoro-82M-bf16', `TTS request used the chosen voice/model (${tts && tts.voice})`);
  check(fs.readdirSync(path.join(work, 'voice-overs')).some(f => /^welcome-back-to-sound-lab\.wav$/.test(f)), 'voice-over saved in the workspace');
  await side.screenshot({ path: path.join(OUT, 'mlx-panel.png'), fullPage: true });

  // ------------------------------------------------------------ 2. Voice Clone wizard
  VoiceCloneWizard.open(mlx, ctx);
  const wizPanel = panels.find(p => p.id === 'soundLab.voiceClone');
  const wiz = await mount(wizPanel.webview, path.join(work, 'voice-clone.html'), { width: 1000, height: 900 });
  await waitFor(() => wiz.evaluate(() => !document.getElementById('step1').hidden), 5000, 'step 1');
  check(await wiz.isDisabled('#toRecord'), 'cannot start without a name and consent');
  await wiz.fill('#vname', 'Ada Narrator');
  await wiz.click('[data-purpose="audiobook"] >> nth=0');
  check(await wiz.isDisabled('#toRecord'), 'still blocked until consent is ticked');
  await wiz.check('#consent');
  await wiz.screenshot({ path: path.join(OUT, 'voice-clone-1-setup.png'), fullPage: true });
  await wiz.click('#toRecord');
  const nPrompts = await wiz.evaluate(() => document.querySelectorAll('#takeBar .take').length);
  check(nPrompts === 5, `5 sentences to read (${nPrompts})`);
  for (let i = 0; i < nPrompts; i++) {
    await wiz.click('#rec');                       // Record (ffmpeg starts)
    await waitFor(() => wiz.evaluate(() => Number(document.getElementById('recSecs').textContent) >= 2.6), 15000, 'recording time');
    await wiz.click('#rec');                       // Stop (graceful 'q')
    await waitFor(() => wiz.evaluate(() => !document.getElementById('next').disabled), 15000, `take ${i + 1} accepted`);
    if (i === 0) { await wiz.screenshot({ path: path.join(OUT, 'voice-clone-2-read.png'), fullPage: true }); }
    if (i === nPrompts - 1) { check(/Chapter one/.test(await wiz.textContent('#prompt')), 'last sentence matches the audiobook purpose'); }
    await wiz.click('#next');
  }
  check(await waitFor(() => wiz.evaluate(() => !document.getElementById('built').hidden), 30000, 'voice built'), 'reference built from 5 recorded takes');
  check((await wiz.inputValue('#refText')).includes('Hello from the mock MLX server'), 'reference transcribed via mlx-audio STT');
  await wiz.click('#preview');
  check(await waitFor(() => wiz.evaluate(() => !document.getElementById('previewPlayer').hidden), 20000, 'preview'), 'preview synthesized in the cloned voice');
  const clonedReq = fs.readFileSync(path.join(work, 'mlx.log'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.path === '/v1/audio/speech' && r.ref_audio).pop();
  check(clonedReq && clonedReq.model === 'mlx-community/chatterbox-turbo-4bit' && fs.existsSync(clonedReq.ref_audio) && /Hello from the mock/.test(clonedReq.ref_text), 'clone request carries ref_audio (server path) + ref_text');
  await wiz.screenshot({ path: path.join(OUT, 'voice-clone-3-voice.png'), fullPage: true });
  await wiz.click('#save');
  check(await waitFor(() => wiz.evaluate(() => !document.getElementById('step4').hidden), 10000, 'step 4'), 'voice saved → create step');
  const profiles = fs.readdirSync(path.join(work, 'storage', 'voices'));
  check(profiles.includes('ada-narrator'), 'profile stored with consent record');
  const prof = JSON.parse(fs.readFileSync(path.join(work, 'storage', 'voices', 'ada-narrator', 'profile.json'), 'utf8'));
  check(prof.consent.confirmed === true && /my own voice/.test(prof.consent.statement), 'consent statement recorded in profile.json');
  // audiobook from a manuscript file
  const manuscript = path.join(work, 'book.md');
  fs.writeFileSync(manuscript, '# Chapter One\nIt was late. The letter arrived.\n\nNobody moved.\n\n# Chapter Two\nMorning came at last.');
  dialogQueue.push([Uri.file(manuscript)]);
  await wiz.click('#form-audiobook [data-pick]');
  await waitFor(() => wiz.evaluate(() => !document.getElementById('create').disabled), 5000, 'create enabled');
  await wiz.click('#create');
  check(await waitFor(() => wiz.evaluate(() => document.querySelectorAll('#results .item').length >= 3), 60000, 'audiobook done'), 'audiobook rendered (full book + 2 chapters)');
  const names = await wiz.$$eval('#results .item span:nth-of-type(1)', s => s.map(x => x.textContent));
  check(names.includes('Audiobook (full).mp3') && names.includes('01 - Chapter One.mp3'), `results listed: ${names.join(', ')}`);
  await wiz.screenshot({ path: path.join(OUT, 'voice-clone-4-create.png'), fullPage: true });
  // vocals over an instrumental
  const inst = path.join(work, 'beat.wav');
  execSync(`ffmpeg -v error -y -f lavfi -i "aevalsrc='0.25*sin(2*PI*110*t)*lt(mod(t,0.5),0.2)':s=48000:d=20" -ac 2 "${inst}"`);
  await wiz.click('#purposes4 [data-purpose="vocals"]');
  dialogQueue.push([Uri.file(inst)]);
  await wiz.click('#form-vocals [data-pick]');
  await wiz.fill('#bpm', '120');
  await wiz.fill('#cues', '@2 Feel the night\n@5 Here we go');
  await waitFor(() => wiz.evaluate(() => !document.getElementById('create').disabled), 5000, 'create enabled');
  await wiz.click('#create');
  check(await waitFor(() => wiz.evaluate(() => [...document.querySelectorAll('#results .item span')].some(s => /vocal stem/.test(s.textContent))), 60000, 'vocals done'), 'vocals mixed over the instrumental (+ vocal stem)');


  // ------------------------------------------------------------ 3. Sound Lab Studio tools (Create + DJ)
  const { StudioTools } = require(path.join(ROOT, 'out', 'studioTools'));
  const { runOk } = require(path.join(ROOT, 'out', 'core', 'ffmpeg'));
  const studioTools = new StudioTools(mlx);
  await StudioPanel.open(mlx, ctx, studioTools, { tool: 'beats' });
  const sp = panels.find(p => p.id === 'soundLab.mlxStudio');
  check(sp.title === 'Sound Lab Studio', 'panel is titled "Sound Lab Studio"');
  const st = await mount(sp.webview, path.join(work, 'studio-tools.html'), { width: 1440, height: 900 });
  const ribbon = await st.$$eval('.tool', bs => bs.map(b => ({ t: b.dataset.tool, label: b.textContent.trim(), icon: !!b.querySelector('svg use') })));
  check(ribbon.filter(r => ['instrumental', 'beats', 'chords', 'sfx', 'autotune', 'layer'].includes(r.t)).length === 6 && ribbon.every(r => r.icon), `Create ribbon: ${ribbon.slice(0, 6).map(r => r.label).join(', ')}`);
  check(['backspin', 'echoout', 'beatjump', 'doubledrop', 'quickmix', 'longblend', 'mashup', 'acapella', 'novocals'].every(t => ribbon.some(r => r.t === t && r.icon)), `DJ ribbon: ${ribbon.slice(6).map(r => r.label).join(', ')}`);
  check(await st.isVisible('#drawer') && /Beats/.test(await st.textContent('#drawer h2')), 'the command opened the Beats drawer');
  const result = async (tool, what, ms = 90000) => {
    const ok = await waitFor(() => st.evaluate(t => !!document.querySelector('#result audio') && !document.getElementById('go').disabled && (window.__lastTool = t), tool), ms, what);
    return ok ? st.evaluate(() => ({ name: document.querySelector('#result b').textContent, detail: document.querySelector('#result .muted').textContent, src: document.querySelector('#result audio').getAttribute('src'), stems: document.querySelectorAll('#result .stem audio').length })) : null;
  };
  const playable = () => st.evaluate(() => new Promise(r => { const a = document.querySelector('#result audio'); if (a.readyState >= 1) { r(a.duration); } a.onloadedmetadata = () => r(a.duration); a.onerror = () => r(-1); setTimeout(() => r(-2), 5000); }));

  await st.selectOption('[data-k="style"]', 'trap');
  check(await st.inputValue('#s-bpm') === '140', 'choosing Trap sets the session tempo to 140');
  await st.click('#go');
  let res = await result('beats', 'beats result');
  check(res && /Trap · 140 BPM · 4 bars/.test(res.detail), `beats generated: ${res && res.name} — ${res && res.detail}`);
  check(Math.abs((await playable()) - 4 * 4 * 60 / 140) < 0.01, 'the beat loop plays in the drawer (6.857 s)');
  check(fs.readdirSync(path.join(work, 'sound-lab-studio', 'beats')).some(f => /^trap-140bpm.*\.wav$/.test(f)), 'saved under sound-lab-studio/beats/');
  await st.screenshot({ path: path.join(OUT, 'studio-beats.png') });

  await st.click('[data-tool="instrumental"]');
  await st.selectOption('[data-k="genre"]', 'lofi');
  await st.selectOption('[data-k="bars"]', '8');
  await st.selectOption('#s-key', 'D');
  await st.selectOption('#s-scale', 'major');
  await st.click('#go');
  res = await result('instrumental', 'instrumental result');
  check(res && /Lo-fi · D major · 80 BPM · 8 bars/.test(res.detail), `instrumental composed: ${res && res.detail}`);
  const instFile = path.join(work, 'sound-lab-studio', 'instrumentals', fs.readdirSync(path.join(work, 'sound-lab-studio', 'instrumentals'))[0]);
  await st.screenshot({ path: path.join(OUT, 'studio-instrumental.png') });

  await st.click('[data-tool="chords"]');
  await st.fill('[data-k="customProg"]', 'Dmaj7 Bm7 Em7 A7');
  await st.selectOption('[data-k="rhythm"]', 'arp');
  await st.click('#go');
  res = await result('chords', 'chords result');
  check(res && /Dmaj7 → Bm7 → Em7 → A7/.test(res.detail), `chords from typed symbols: ${res && res.detail}`);

  await st.click('[data-tool="sfx"]');
  await st.selectOption('[data-k="effect"]', 'riser');
  await st.selectOption('[data-k="sfxBars"]', '2');
  await st.click('#go');
  res = await result('sfx', 'sfx result');
  check(res && /Riser .* 6\.00 s/.test(res.detail), `2-bar riser at 80 BPM = 6 s: ${res && res.detail}`);
  // Layer onto…: the riser goes onto the instrumental
  await st.click('#result [data-layer]');
  check(/Layer/.test(await st.textContent('#drawer h2')) && /riser/.test(await st.textContent('[data-file="part"] .fname')), 'Layer onto… opens the Layer drawer with the part filled in');
  dialogQueue.push([Uri.file(instFile)]);
  await st.click('[data-pick="target"]');
  await waitFor(() => st.evaluate(() => /lofi/.test(document.querySelector('[data-file="target"] .fname').textContent)), 5000, 'target picked');
  await st.click('#go');
  res = await result('layer', 'layer result');
  check(res && /riser.*→.*lofi.*looped/.test(res.detail), `layered: ${res && res.detail}`);

  // Auto-tune a sharp "vocal" (450 Hz) — key detection on, natural retune
  const vox = path.join(work, 'vocal take.wav');
  await runOk({ exe: 'ffmpeg', args: ['-y', '-v', 'error', '-f', 'lavfi', '-i', "aevalsrc='0.3*(sin(2*PI*450*t)+0.5*sin(4*PI*450*t))*lt(mod(t,1),0.8)':s=44100:d=3", vox] });
  await st.click('[data-tool="autotune"]');
  dialogQueue.push([Uri.file(vox)]);
  await st.click('[data-pick="track"]');
  await waitFor(() => st.evaluate(() => /vocal take/.test(document.querySelector('[data-file="track"] .fname').textContent)), 5000, 'vocal picked');
  await st.click('[data-k="detectKey"]');   // off → use the session key (D major contains A)
  await st.click('#go');
  res = await result('autotune', 'auto-tune result');
  check(res && /D major · retune 40 ms .* → [0-9] cents/.test(res.detail), `auto-tuned: ${res && res.detail}`);
  check(fs.existsSync(path.join(work, 'vocal take_autotuned.wav')), 'auto-tune output written next to the source');
  await st.screenshot({ path: path.join(OUT, 'studio-autotune.png') });

  // DJ: backspin on the instrumental — analysis shows tempo + key; ×2/÷2 present
  await st.click('[data-tool="backspin"]');
  dialogQueue.push([Uri.file(instFile)]);
  await st.click('[data-pick="track"]');
  await waitFor(() => st.evaluate(() => /BPM/.test(document.querySelector('[data-an="track"]').textContent)), 20000, 'analysis');
  const an = await st.textContent('[data-an="track"]');
  check(/(80|160)(\.\d+)? BPM/.test(an) && /major|minor/.test(an), `track analysed: ${an.replace(/\s+/g, ' ').trim()}`);
  await st.fill('[data-k="at"]', '0:06');
  await st.click('#go');
  res = await result('backspin', 'backspin result');
  check(res && /Backspin at 0:06\.000/.test(res.detail), `backspin on the beat: ${res && res.detail}`);
  await st.screenshot({ path: path.join(OUT, 'studio-dj-backspin.png') });

  // Quick mix the instrumental into the trap beat
  await st.click('[data-tool="quickmix"]');
  dialogQueue.push([Uri.file(instFile)]);
  await st.click('[data-pick="track"]');
  await waitFor(() => st.evaluate(() => /BPM/.test(document.querySelector('[data-an="track"]').textContent)), 20000, 'analysis A');
  const beatFile = path.join(work, 'sound-lab-studio', 'beats', fs.readdirSync(path.join(work, 'sound-lab-studio', 'beats'))[0]);
  dialogQueue.push([Uri.file(beatFile)]);
  await st.click('[data-pick="trackB"]');
  await waitFor(() => st.evaluate(() => /BPM/.test(document.querySelector('[data-an="trackB"]').textContent)), 20000, 'analysis B');
  await st.click('#go');
  res = await result('quickmix', 'quick mix result');
  check(res && /Quick mix .*lofi.* → trap.* over 1 bar/.test(res.detail) && /stretched/.test(res.detail), `quick mix, tempo-matched: ${res && res.detail}`);
  await st.screenshot({ path: path.join(OUT, 'studio-dj-quickmix.png') });

  // Acapella through mlx-audio (the mock server is running) → both stems listed
  await st.click('[data-tool="acapella"]');
  dialogQueue.push([Uri.file(instFile)]);
  await st.click('[data-pick="track"]');
  await waitFor(() => st.evaluate(() => /lofi/.test(document.querySelector('[data-file="track"] .fname').textContent)), 5000, 'picked');
  await st.click('#go');
  res = await result('acapella', 'acapella result');
  check(res && /via mlx-audio separation/.test(res.detail) && res.stems === 1, `acapella via mlx-audio (+ instrumental stem): ${res && res.detail}`);
  // and the built-in center extractor when separation is forced to "center"
  settings['dj.separation'] = 'center';
  await st.click('[data-tool="novocals"]');
  dialogQueue.push([Uri.file(instFile)]);
  await st.click('[data-pick="track"]');
  await waitFor(() => st.evaluate(() => /lofi/.test(document.querySelector('[data-file="track"] .fname').textContent)), 5000, 'picked');
  await st.click('#go');
  res = await result('novocals', 'instrumental result');
  check(res && /center-channel extraction/.test(res.detail), `instrumental via center extraction: ${res && res.detail}`);
  await st.screenshot({ path: path.join(OUT, 'studio-dj-stems.png') });
  await st.close();

  // one-click commands (explorer / editor path): editor playhead → {at}; explorer multi-select → two tracks
  await studioTools.cmdDj('echoout', Uri.file(instFile), { at: 9 });
  check(fs.readdirSync(path.dirname(instFile)).some(f => /_echo-out\.wav$/.test(f)), 'DJ: Echo Out command (at the editor playhead) writes <name>_echo-out.wav');
  await studioTools.cmdDj('longblend', Uri.file(instFile), [Uri.file(instFile), Uri.file(beatFile)]);
  check(fs.readdirSync(path.dirname(instFile)).some(f => /_long-blend-trap/.test(f)), 'DJ: Long Blend on two selected files writes <A>_long-blend-<B>');
  await studioTools.cmdAutoTune(Uri.file(vox));
  check(fs.existsSync(path.join(work, 'vocal take_autotuned-1.wav')), 'Auto-tune Vocals command (Natural preset) writes a second, uniquely named take');

  // ------------------------------------------------------------ 4. mlx-audio Studio embedded
  const studioDir = argStudio && fs.existsSync(path.join(argStudio, 'node_modules', '.bin', 'next')) ? argStudio : null;
  if (studioDir) {
    fs.writeFileSync(path.join(studioDir, 'node_modules', '.soundlab-installed'), 'harness');
    await StudioPanel.open(mlx, ctx, studioTools, { startStudio: true });
    check(new RegExp(`frame-src http://localhost:${studioPort}`).test(sp.webview.html), 'Studio CSP allows exactly the Studio origin in frame-src');
    const st = await mount(sp.webview, path.join(work, 'studio.html'), { width: 1280, height: 860 });
    const frame = await (await st.waitForSelector('#studio')).contentFrame();
    await frame.waitForLoadState('load').catch(() => undefined);
    await sleep(4000);
    const studioText = await frame.evaluate(() => document.body.innerText).catch(() => '');
    check(/speech|voice|audio/i.test(studioText), `real mlx-audio Studio rendered inside the panel (${studioText.slice(0, 60).replace(/\n/g, ' ')}…)`);
    await st.screenshot({ path: path.join(OUT, 'studio-embedded.png') });
    await st.click('[data-page="/text-to-speech"]');
    await sleep(5000);
    await st.screenshot({ path: path.join(OUT, 'studio-tts.png') });
    mlx.studio.stop();
  } else {
    console.log('– Studio not available (pass --studio /path/to/mlx_audio/ui with node_modules) — skipped');
  }

  check(errors.length === 0, `no webview errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  mock.kill();
  mlx.dispose();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\nScreenshots in ${path.relative(process.cwd(), OUT)}/`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
