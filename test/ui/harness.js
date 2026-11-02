// Renders the real audio-editor webview (HTML from audioEditor.ts + media/editor.js/css) in Chromium,
// feeds it real ffmpeg data, exercises selection/seek/zoom, asserts on behaviour and writes screenshots.
// Usage: npm run test:ui   (needs ffmpeg, ffprobe and Playwright with Chromium)
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const FF = process.env.FFMPEG || 'ffmpeg';
const FP = process.env.FFPROBE || 'ffprobe';

function loadPlaywright() {
  try { return require('playwright'); } catch { /* try global */ }
  try { return require(path.join(execSync('npm root -g').toString().trim(), 'playwright')); } catch { /* none */ }
  console.error('Playwright not found. Install it with: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

class Uri { constructor(p) { this.fsPath = p; } static file(p) { return new Uri(p); } static joinPath(u, ...s) { return new Uri(path.join(u.fsPath, ...s)); } toString() { return 'file://' + this.fsPath; } }
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') { return { Uri, EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} }, window: {}, workspace: {}, commands: {} }; }
  return origLoad.call(this, req, ...rest);
};

const THEMES = {
  dark: { fg: '#cccccc', bg: '#1e1e1e', btn: '#0e639c', btn2: '#3a3d41', btn2fg: '#cccccc', badge: '#4d4d4d', border: '#303031', hover: '#2a2d2e', sel: '#04395e', input: '#3c3c3c', cursor: '#aeafad' },
  light: { fg: '#3b3b3b', bg: '#ffffff', btn: '#005fb8', btn2: '#e5e5e5', btn2fg: '#3b3b3b', badge: '#cccccc', border: '#e5e5e5', hover: '#f2f2f2', sel: '#cce3f7', input: '#ffffff', cursor: '#000000' },
};
const themeCss = (t) => `<style>:root{--vscode-foreground:${t.fg};--vscode-editor-background:${t.bg};--vscode-font-family:-apple-system,Segoe UI,sans-serif;--vscode-font-size:13px;
--vscode-button-background:${t.btn};--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:${t.btn2};--vscode-button-secondaryForeground:${t.btn2fg};
--vscode-badge-background:${t.badge};--vscode-badge-foreground:${t.fg};--vscode-charts-blue:#3794ff;--vscode-charts-orange:#d18616;--vscode-descriptionForeground:#8b8b8b;
--vscode-widget-border:${t.border};--vscode-textLink-foreground:#3794ff;--vscode-list-hoverBackground:${t.hover};--vscode-list-activeSelectionBackground:${t.sel};--vscode-list-activeSelectionForeground:${t.fg};
--vscode-input-background:${t.input};--vscode-input-foreground:${t.fg};--vscode-editor-font-family:Menlo,monospace;--vscode-focusBorder:#007fd4;--vscode-editorCursor-foreground:${t.cursor}}</style>`;

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✔' : '✖'} ${msg}`); if (!cond) { failures++; } };

(async () => {
  const { chromium } = loadPlaywright();
  const { AudioEditorProvider } = require(path.join(ROOT, 'out/audioEditor'));
  const { extractPeaks, analyzeLevels, parseSilence, soundSegments } = require(path.join(ROOT, 'out/core/analysis'));
  const { probe, summarize } = require(path.join(ROOT, 'out/core/probe'));
  const { runOk } = require(path.join(ROOT, 'out/core/ffmpeg'));
  const R = require(path.join(ROOT, 'out/core/recipes'));

  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'soundlab-ui-'));
  const wav = path.join(work, 'demo.wav');
  const spec = path.join(work, 'spec.png');
  // 8 decaying "hits" with a click transient and a low noise bed → clear sound/silence structure
  await runOk({ exe: FF, args: ['-v', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='0.6*sin(2*PI*220*t)*exp(-3*mod(t,1.1))*lt(mod(t,1.1),0.7)+0.15*sin(2*PI*1320*t)*lt(mod(t,1.1),0.25)':s=44100:d=8",
    '-f', 'lavfi', '-i', 'anoisesrc=a=0.01:d=8', '-filter_complex', '[0][1]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo', '-c:a', 'pcm_s24le', wav] });
  await runOk({ exe: FF, args: R.spectrogramPng(wav, spec, 1400, 512) });

  const s = summarize(await probe(FP, wav));
  const peaks = await extractPeaks(FF, wav, s.duration, 200);
  const levels = await analyzeLevels(FF, wav, s.duration);
  const silences = parseSilence((await runOk({ exe: FF, args: R.silenceDetect(wav, -35, 0.2) })).stderr, s.duration);
  const segments = soundSegments(silences, s.duration, 0.02, 0.05);
  const lines = ['Kick it from the top.', 'Second hit, a little brighter.', 'Third one, let it ring.', 'Again, with feeling.', 'Fifth take.', 'Sixth.', 'Seven — and out.', 'End.'];
  const transcript = segments.map((g, i) => ({ start: g.start, end: g.end, text: lines[i % lines.length] }));

  const prov = new AudioEditorProvider({ subscriptions: [], extensionUri: Uri.file(ROOT) });
  const baseHtml = prov.html({ cspSource: 'file:', asWebviewUri: (u) => u.toString() }, Uri.file(path.join(ROOT, 'media')), 'demo.wav');
  check(/Content-Security-Policy/.test(baseHtml) && /script-src 'nonce-/.test(baseHtml), 'webview HTML ships a nonce-based CSP');

  const browser = await chromium.launch();
  for (const [themeName, theme] of Object.entries(THEMES)) {
    const html = baseHtml
      .replace('<head>', `<head>${themeCss(theme)}<script>window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted.push(m)});</script>`)
      ; // keep the real CSP: cspSource 'file:' covers the file:// test page, so CSP violations surface as page errors
    const pageFile = path.join(work, `page-${themeName}.html`);
    fs.writeFileSync(pageFile, html);

    const page = await browser.newPage({ viewport: { width: 1280, height: 980 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) { errors.push(m.text()); } });
    await page.goto('file://' + pageFile);
    await page.waitForFunction(() => window.__posted.some(m => m.type === 'ready'), null, { timeout: 5000 });
    const send = (m) => page.evaluate((m) => window.postMessage(m, '*'), m);

    await send({ type: 'info', info: { ...s, size: fs.statSync(wav).size, path: wav, sampleFmt: 's32' } });
    await send({ type: 'audio', src: 'file://' + wav });
    await send({ type: 'peaks', peaks });
    await send({ type: 'transcript', segments: transcript });
    await page.click('[data-panel="levels"]'); await send({ type: 'levels', report: levels });
    await page.click('[data-panel="silence"]'); await send({ type: 'regions', silences, segments });
    await page.click('[data-panel="spectrogram"]'); await send({ type: 'spectrogram', src: 'file://' + spec });
    await page.waitForTimeout(150);

    const tag = `[${themeName}]`;
    check(await page.locator('#loading').isHidden(), `${tag} loading overlay hides once peaks arrive`);
    check((await page.textContent('#dur')) === '0:08.000', `${tag} duration shown`);
    check((await page.locator('.chip').count()) >= 5, `${tag} metadata chips rendered`);
    check((await page.locator('.region').count()) === segments.length, `${tag} ${segments.length} sound regions listed`);
    check((await page.locator('.seg').count()) === transcript.length, `${tag} transcript rows rendered`);
    check(/LUFS/.test(await page.textContent('#levelsBody')), `${tag} levels panel rendered`);
    const widths = await page.$$eval('#levelsBody .meter > div', els => els.map(e => e.style.width));
    check(widths.length === 3 && widths.every(w => /%$/.test(w) && parseFloat(w) > 0), `${tag} loudness meters filled under CSP (${widths.join(', ')})`);

    await page.evaluate(() => window.scrollTo(0, 0));
    const box = await page.locator('#wave').boundingBox();
    await page.mouse.move(box.x + box.width * 0.30, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.42, box.y + 80, { steps: 5 });
    await page.mouse.up();
    check(await page.locator('#export').isEnabled(), `${tag} drag creates a selection (export enabled)`);
    await page.click('#export');
    const exp = (await page.evaluate(() => window.__posted)).find(m => m.type === 'exportSelection');
    check(exp && Math.abs(exp.start - 0.30 * 8) < 0.1 && Math.abs(exp.end - 0.42 * 8) < 0.1, `${tag} exportSelection posts ≈2.40–3.36 s (got ${exp?.start?.toFixed(3)}–${exp?.end?.toFixed(3)})`);

    await page.screenshot({ path: path.join(OUT, `editor-${themeName}.png`), fullPage: true });

    // Double-click a sound region selects exactly that region
    await page.keyboard.press('Escape');
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.dblclick(box.x + box.width * (segments[4].start + 0.1) / s.duration, box.y + 80);
    const selAfterDbl = await page.textContent('#selInfo');
    check(await page.evaluate(() => window.scrollY) === scrollBefore, `${tag} clicking the waveform does not scroll the page`);
    check(/Selection 0:04\.3/.test(selAfterDbl), `${tag} double-click selects region #5`);

    // Transcript click seeks
    await page.click('.seg[data-i="2"]', { position: { x: 5, y: 5 } });
    await page.waitForTimeout(150);
    const t = await page.evaluate(() => { const a = document.getElementById('audio'); a.pause(); return a.currentTime; });
    check(t >= transcript[2].start - 0.01 && t < transcript[2].start + 0.6, `${tag} transcript click seeks to line 3 (t=${t.toFixed(2)})`);

    // Zoom in with the wheel, then fit with "0"
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.mouse.move(box.x + box.width * 0.5, box.y + 60);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(100);
    const firstTick = await page.evaluate(() => document.getElementById('wave').toDataURL().length);
    await page.keyboard.press('0');
    check(firstTick > 1000, `${tag} canvas renders after zoom`);

    // Action buttons map to commands
    await page.click('[data-run="applyEffects"]');
    check((await page.evaluate(() => window.__posted)).some(m => m.type === 'run' && m.command === 'applyEffects'), `${tag} Effects… button posts run/applyEffects`);

    check(errors.length === 0, `${tag} no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await page.close();
  }
  await browser.close();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\nScreenshots: ${path.relative(process.cwd(), OUT)}/editor-{dark,light}.png`);
  if (failures) { console.error(`${failures} UI check(s) failed`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
