// Presentation scaffolding, folder analysis, 5-10 minute instructional pacing, and HTML/Markdown deck export (no vscode imports).
import * as fs from 'fs';
import * as path from 'path';
import { render, Segment, Transcript } from './subtitles';

export interface FolderContext {
  name: string;
  rootPath: string;
  fileCount: number;
  directories: string[];
  files: string[];
  extensions: Record<string, number>;
  manifests: { file: string; summary: string }[];
  docs: { file: string; excerpt: string }[];
  highlights: { file: string; symbols: string[]; excerpt: string }[];
  mediaFiles: string[];
  summaryText: string;
}

export interface SlideSpec {
  index: number;
  title: string;
  durationSec: number;
  bullets: string[];
  narration: string;
  codeSnippet?: string;
  codeLang?: string;
  speakerNotes?: string;
}

export interface PresentationSpec {
  title: string;
  topic: string;
  folderPath: string;
  targetMinutes: number;
  estimatedSeconds: number;
  audience: string;
  voiceProfileId?: string;
  createdAt: string;
  researchInteractionId?: string;
  slides: SlideSpec[];
}

export interface ScaffoldedPresentation {
  dir: string;
  spec: PresentationSpec;
  files: {
    json: string;
    markdown: string;
    html: string;
    script: string;
    research: string;
  };
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', 'build', '.venv', 'venv', '__pycache__', '.colabsync', '.next', '.claude', '.anchor']);
const TEXT_EXT = new Set(['.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.json', '.yaml', '.yml', '.toml', '.sh', '.css', '.html', '.sql', '.rb']);
const MEDIA_EXT = new Set(['.wav', '.mp3', '.flac', '.ogg', '.opus', '.m4a', '.aiff', '.mp4', '.mov', '.mkv', '.webm']);

/** Scan a folder safely and build structured context for Deep Research and instructional slide scaffolding. */
export function scanFolderContext(folderPath: string, opts: { maxDepth?: number; maxFiles?: number } = {}): FolderContext {
  const root = path.resolve(folderPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Presentation folder does not exist: ${root}`);
  }
  const maxDepth = opts.maxDepth ?? 4;
  const maxFiles = opts.maxFiles ?? 250;
  const files: string[] = [];
  const directories: string[] = [];
  const extensions: Record<string, number> = {};
  const mediaFiles: string[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || files.length >= maxFiles) { return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= maxFiles) { break; }
      if (e.name.startsWith('.') && e.name !== '.env.example') { continue; }
      if (SKIP_DIRS.has(e.name)) { continue; }
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (e.isDirectory()) {
        directories.push(rel);
        walk(full, depth + 1);
      } else if (e.isFile()) {
        files.push(rel);
        const ext = path.extname(e.name).toLowerCase() || '(no-ext)';
        extensions[ext] = (extensions[ext] || 0) + 1;
        if (MEDIA_EXT.has(ext)) { mediaFiles.push(rel); }
      }
    }
  };
  walk(root, 0);

  const readExcerpt = (rel: string, maxChars = 1600): string => {
    try {
      const txt = fs.readFileSync(path.join(root, rel), 'utf8');
      return txt.slice(0, maxChars).trim();
    } catch { return ''; }
  };

  const manifests: { file: string; summary: string }[] = [];
  for (const m of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'README.md']) {
    if (files.includes(m) && m !== 'README.md') {
      manifests.push({ file: m, summary: readExcerpt(m, 900) });
    }
  }

  const docCandidates = files.filter(f => /^(readme|changelog|claude|architecture|getting-started)/i.test(path.basename(f)) || /^docs\/.*\.md$/i.test(f));
  const docs = docCandidates.slice(0, 6).map(f => ({ file: f, excerpt: readExcerpt(f, 1400) })).filter(d => d.excerpt);

  const codeFiles = files.filter(f => /\.(ts|js|py|go|rs|java|kt)$/i.test(f) && !/\.test\.|\.spec\.|min\./i.test(f));
  const highlights = codeFiles.slice(0, 12).map(f => {
    const excerpt = readExcerpt(f, 1200);
    const symbols = [...excerpt.matchAll(/(?:export\s+(?:async\s+)?(?:function|class|const|interface|type)\s+|def\s+|class\s+)([A-Za-z_]\w*)/g)]
      .map(m => m[1]).slice(0, 10);
    return { file: f, symbols, excerpt: excerpt.slice(0, 500) };
  }).filter(h => h.excerpt && TEXT_EXT.has(path.extname(h.file).toLowerCase()));

  const topExt = Object.entries(extensions).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([e, n]) => `${e} (${n})`).join(', ');
  const summaryParts = [
    `Folder: ${path.basename(root)} (${root})`,
    `Files scanned: ${files.length} across ${directories.length} subdirectories`,
    topExt ? `File types: ${topExt}` : '',
    directories.length ? `Top directories: ${directories.filter(d => !d.includes(path.sep)).slice(0, 15).join(', ')}` : '',
    manifests.length ? `Manifests:\n${manifests.map(m => `--- ${m.file} ---\n${m.summary}`).join('\n')}` : '',
    docs.length ? `Documentation:\n${docs.map(d => `--- ${d.file} ---\n${d.excerpt.slice(0, 700)}`).join('\n')}` : '',
    highlights.length ? `Key Modules:\n${highlights.map(h => `- ${h.file}${h.symbols.length ? ` [${h.symbols.join(', ')}]` : ''}`).join('\n')}` : '',
    mediaFiles.length ? `Media assets (${mediaFiles.length}): ${mediaFiles.slice(0, 10).join(', ')}` : '',
  ].filter(Boolean);

  return {
    name: path.basename(root),
    rootPath: root,
    fileCount: files.length,
    directories,
    files,
    extensions,
    manifests,
    docs,
    highlights,
    mediaFiles,
    summaryText: summaryParts.join('\n\n'),
  };
}

/** Estimate spoken narration duration at ~140 WPM plus a small slide pause. */
export function estimateNarrationSeconds(text: string, wpm = 140): number {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(4, Math.round(((words / Math.max(80, wpm)) * 60 + 1.5) * 10) / 10);
}

export function clampPresentationMinutes(minutes?: number): number {
  const m = Number(minutes);
  if (!isFinite(m) || m <= 0) { return 7; }
  return Math.max(5, Math.min(10, m));
}

export interface TimingCheck {
  totalSeconds: number;
  totalWords: number;
  withinTargetWindow: boolean;
  targetMinSec: number;
  targetMaxSec: number;
}

/** Check whether a slide deck fits the 5-10 minute instructional presentation target (300-600 s). */
export function validatePresentationDuration(slides: Pick<SlideSpec, 'durationSec' | 'narration'>[]): TimingCheck {
  const totalSeconds = Math.round(slides.reduce((a, s) => a + (s.durationSec || estimateNarrationSeconds(s.narration)), 0));
  const totalWords = slides.reduce((a, s) => a + s.narration.trim().split(/\s+/).filter(Boolean).length, 0);
  return { totalSeconds, totalWords, withinTargetWindow: totalSeconds >= 300 && totalSeconds <= 600, targetMinSec: 300, targetMaxSec: 600 };
}

function buildFallbackSlides(topic: string, folder: FolderContext, researchReport: string, targetMinutes: number): SlideSpec[] {
  const targetSec = Math.round(clampPresentationMinutes(targetMinutes) * 60);
  const dirs = folder.directories.filter(d => !d.includes(path.sep)).slice(0, 5);
  const mods = folder.highlights.slice(0, 4);
  const docNames = folder.docs.map(d => d.file).slice(0, 4);
  const researchLines = researchReport.replace(/\r/g, '').split('\n')
    .map(l => l.replace(/^[#*\-\d.\s]+/, '').trim())
    .filter(l => l.length > 28 && !/^http/i.test(l));

  const rawSlides: Omit<SlideSpec, 'index' | 'durationSec'>[] = [
    {
      title: topic || `${folder.name}: Instructional Walkthrough`,
      bullets: [
        `Target workspace: ${folder.name} (${folder.fileCount} files)`,
        `Instructional overview grounded in repository architecture & Deep Research`,
        `Estimated duration: ${clampPresentationMinutes(targetMinutes)} minutes`,
      ],
      narration: `Welcome everyone. In this instructional session, we are exploring ${topic} inside the ${folder.name} workspace. Over the next several minutes, we will examine how the project is organized across its ${folder.fileCount} files, review key research insights and architectural best practices, walk step by step through the core modules, and look at hands-on workflows you can apply right away.`,
      speakerNotes: 'Open with the goal of the tutorial and why the folder structure matters.',
    },
    {
      title: 'Learning Objectives & Agenda',
      bullets: [
        'Understand the problem domain and research context',
        `Explore the structure of ${folder.name}`,
        'Walk through core implementation patterns and tools',
        'Review verification, testing, and next steps',
      ],
      narration: `Here is our roadmap for this tutorial. First, we will ground ourselves in the research background behind ${topic}. Second, we will tour the directory layout of ${folder.name} so you know where every component lives. Third, we will examine the key modules and code entry points in detail. Finally, we will connect those building blocks into an actionable workflow you can run and verify locally.`,
    },
    {
      title: 'Deep Research Findings & Context',
      bullets: (researchLines.slice(0, 3).length ? researchLines.slice(0, 3) : [
        `Core principles and modern practices for ${topic}`,
        'Tradeoffs between local execution, containers, and cloud orchestration',
        'Reliability, testing, and maintainability considerations',
      ]).map(x => x.slice(0, 96)),
      narration: researchLines.length
        ? `Let us review what our Deep Research task surfaced about ${topic}. ${researchLines.slice(0, 4).join(' ')} Keeping these principles in mind helps explain the design decisions we see inside the folder.`
        : `Before diving into code, let us summarize the key domain insights around ${topic}. Choosing the right architecture requires balancing developer ergonomics, hardware acceleration, and deterministic testing. Every module in this workspace reflects those priorities in practice.`,
    },
    {
      title: `Workspace Architecture: ${folder.name}`,
      bullets: [
        `Directories: ${dirs.length ? dirs.join(', ') : '(root level)'}`,
        `Primary docs: ${docNames.length ? docNames.join(', ') : 'Inline documentation'}`,
        `Assets: ${folder.mediaFiles.length ? `${folder.mediaFiles.length} media files` : `${Object.keys(folder.extensions).slice(0, 4).join(', ')} files`}`,
      ],
      codeSnippet: folder.files.slice(0, 10).map(f => `  ${f}`).join('\n'),
      codeLang: 'text',
      narration: `Now let us look at how ${folder.name} is laid out on disk. Across ${folder.fileCount} files, work is cleanly separated into focused directories${dirs.length ? ` including ${dirs.join(', ')}` : ''}. Documentation lives alongside the code${docNames.length ? ` in ${docNames.join(' and ')}` : ''}, making it straightforward to onboard and locate responsibilities without guesswork.`,
    },
    {
      title: mods[0] ? `Core Module: ${mods[0].file}` : 'Core Implementation Building Blocks',
      bullets: mods[0]
        ? [
            `File: ${mods[0].file}`,
            mods[0].symbols.length ? `Exports: ${mods[0].symbols.slice(0, 5).join(', ')}` : 'Core module responsibilities',
            'Designed with clear boundaries and testable helpers',
          ]
        : ['Clear separation between core logic and host integration', 'Typed contracts and structured error handling'],
      codeSnippet: mods[0]?.excerpt.split('\n').slice(0, 8).join('\n'),
      narration: mods[0]
        ? `Moving into the implementation, let us inspect ${mods[0].file}. ${mods[0].symbols.length ? `Notice the primary exports here: ${mods[0].symbols.slice(0, 5).join(', ')}. ` : ''}This module encapsulates focused responsibilities with clean interfaces so it can be reused and verified independently.`
        : `Let us examine the core implementation pattern in this workspace. By isolating pure logic from UI or transport plumbing, each function stays deterministic, composable, and easy to exercise in automated tests.`,
    },
    {
      title: mods[1] ? `Workflow & Integration: ${mods[1].file}` : 'Orchestration & End-to-End Flow',
      bullets: mods[1]
        ? [
            `File: ${mods[1].file}`,
            mods[1].symbols.length ? `Key symbols: ${mods[1].symbols.slice(0, 5).join(', ')}` : 'Connects inputs to outputs safely',
            'Handles progress reporting, cancellation, and non-destructive outputs',
          ]
        : ['Validates inputs before launching long-running work', 'Preserves originals and emits structured progress'],
      codeSnippet: mods[1]?.excerpt.split('\n').slice(0, 8).join('\n'),
      narration: mods[1]
        ? `Next, look at how ${mods[1].file} coordinates the workflow. ${mods[1].symbols.length ? `Through ${mods[1].symbols.slice(0, 4).join(', ')}, ` : ''}inputs are validated up front, long-running steps report progress cleanly, and outputs are written safely without overwriting original user files.`
        : `Looking at orchestration, every long-running operation validates inputs up front, streams progress back to the user, supports cancellation cleanly, and writes outputs to unique paths so original assets stay untouched.`,
    },
    {
      title: 'Hands-On Walkthrough & Practical Usage',
      bullets: [
        'Verify local prerequisites and configuration settings',
        'Run the primary workflow end-to-end with sample inputs',
        'Inspect generated artifacts, logs, and outputs',
      ],
      narration: `Let us walk through how you put this into practice step by step. First, confirm your configuration and environment tools are ready. Second, run the primary command or workflow against a representative folder or sample input. Third, inspect the generated output files, logs, and metadata to verify every stage completed accurately.`,
    },
    {
      title: 'Testing, Verification & Next Steps',
      bullets: [
        'Run automated unit and integration tests after every edit',
        'Check generated outputs with verification tools',
        `Explore further inside ${folder.name} documentation`,
      ],
      narration: `To wrap up, remember to validate every change through the project's test suite and inspect generated outputs directly. We covered the research foundation for ${topic}, toured the ${folder.name} directory structure, walked through key modules, and reviewed practical execution steps. Thank you for watching, and happy building.`,
    },
  ];

  // Calibrate narration/slide durations into the requested 5-10 minute window (targetSec).
  const initialTotal = rawSlides.reduce((a, s) => a + estimateNarrationSeconds(s.narration), 0);
  const scale = targetSec / Math.max(1, initialTotal);
  return rawSlides.map((s, idx) => ({
    index: idx + 1,
    title: s.title,
    durationSec: Math.max(25, Math.round(estimateNarrationSeconds(s.narration) * scale)),
    bullets: s.bullets,
    narration: s.narration,
    codeSnippet: s.codeSnippet,
    codeLang: s.codeLang,
    speakerNotes: s.speakerNotes,
  }));
}

export interface ScaffoldInput {
  outputDir: string;
  title: string;
  topic: string;
  folderContext: FolderContext;
  targetMinutes?: number;
  audience?: string;
  voiceProfileId?: string;
  researchReport?: string;
  researchInteractionId?: string;
  slides?: Omit<SlideSpec, 'index'>[];
}

/**
 * Scaffold a 5-10 minute instructional presentation (presentation.json, slides.md, slides.html,
 * narration-script.txt, research-report.md) grounded in the folder contents and Deep Research report.
 */
export function scaffoldPresentation(input: ScaffoldInput): ScaffoldedPresentation {
  const targetMinutes = clampPresentationMinutes(input.targetMinutes);
  const research = (input.researchReport || `# Deep Research Report: ${input.topic}\n\nTopic: ${input.topic}\nFolder: ${input.folderContext.rootPath}\n`).trim();

  let slides: SlideSpec[];
  if (input.slides?.length) {
    slides = input.slides.map((s, idx) => ({
      index: idx + 1,
      title: s.title || `Slide ${idx + 1}`,
      durationSec: s.durationSec > 0 ? Math.round(s.durationSec) : estimateNarrationSeconds(s.narration),
      bullets: Array.isArray(s.bullets) ? s.bullets : [],
      narration: String(s.narration || '').trim(),
      codeSnippet: s.codeSnippet,
      codeLang: s.codeLang,
      speakerNotes: s.speakerNotes,
    }));
    // Normalize durations if outside 5-10 minutes (300-600s) so the instructional deck fits the target window
    const check = validatePresentationDuration(slides);
    if (!check.withinTargetWindow && check.totalSeconds > 0) {
      const targetSec = Math.round(targetMinutes * 60);
      const factor = targetSec / check.totalSeconds;
      slides = slides.map(s => ({ ...s, durationSec: Math.max(20, Math.round(s.durationSec * factor)) }));
    }
  } else {
    slides = buildFallbackSlides(input.topic, input.folderContext, research, targetMinutes);
  }

  const estimatedSeconds = slides.reduce((a, s) => a + s.durationSec, 0);
  const spec: PresentationSpec = {
    title: input.title || input.topic,
    topic: input.topic,
    folderPath: input.folderContext.rootPath,
    targetMinutes,
    estimatedSeconds,
    audience: input.audience || 'Developers & technical learners',
    voiceProfileId: input.voiceProfileId,
    createdAt: new Date().toISOString(),
    researchInteractionId: input.researchInteractionId,
    slides,
  };

  const dir = path.resolve(input.outputDir);
  fs.mkdirSync(dir, { recursive: true });

  const jsonPath = path.join(dir, 'presentation.json');
  const mdPath = path.join(dir, 'slides.md');
  const htmlPath = path.join(dir, 'slides.html');
  const scriptPath = path.join(dir, 'narration-script.txt');
  const researchPath = path.join(dir, 'research-report.md');

  fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2));
  fs.writeFileSync(mdPath, renderSlidesMarkdown(spec));
  fs.writeFileSync(htmlPath, renderSlidesHtml(spec));
  fs.writeFileSync(scriptPath, spec.slides.map(s => `## Slide ${s.index}: ${s.title} (~${s.durationSec}s)\n${s.narration}`).join('\n\n') + '\n');
  fs.writeFileSync(researchPath, research + '\n');

  return {
    dir,
    spec,
    files: { json: jsonPath, markdown: mdPath, html: htmlPath, script: scriptPath, research: researchPath },
  };
}

export function renderSlidesMarkdown(spec: PresentationSpec): string {
  const mins = (spec.estimatedSeconds / 60).toFixed(1);
  const head = [
    '---',
    `title: ${spec.title}`,
    `topic: ${spec.topic}`,
    `duration: ${mins} min`,
    '---',
    '',
    `# ${spec.title}`,
    `> Instructional presentation (${mins} min) · Source: \`${spec.folderPath}\``,
    '',
  ];
  const body = spec.slides.map(s => {
    const lines = [`---`, '', `## ${s.index}. ${s.title}`, ''];
    for (const b of s.bullets) { lines.push(`- ${b}`); }
    if (s.codeSnippet) {
      lines.push('', '```' + (s.codeLang || ''), s.codeSnippet.trim(), '```');
    }
    lines.push('', `<!-- Narration (~${s.durationSec}s): ${s.narration} -->`, '');
    return lines.join('\n');
  });
  return [...head, ...body].join('\n');
}

function escHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function renderSlidesHtml(spec: PresentationSpec): string {
  const dataJson = JSON.stringify(spec).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(spec.title)}</title>
<style>
  :root { color-scheme: dark; --bg:#0f172a; --card:#1e293b; --fg:#f8fafc; --muted:#94a3b8; --accent:#38bdf8; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,-apple-system,Segoe UI,sans-serif; background:var(--bg); color:var(--fg); display:flex; flex-direction:column; height:100vh; }
  header { display:flex; align-items:center; gap:12px; padding:12px 24px; border-bottom:1px solid #334155; font-size:14px; }
  header .pill { background:var(--card); color:var(--accent); padding:4px 10px; border-radius:999px; font-weight:600; }
  header .spacer { flex:1; }
  main { flex:1; display:flex; flex-direction:column; justify-content:center; padding:40px 7vw; gap:24px; overflow:auto; }
  h1 { margin:0; font-size:clamp(28px,4vw,46px); border-bottom:2px solid #334155; padding-bottom:14px; }
  .cols { display:grid; grid-template-columns:1fr; gap:28px; align-items:start; }
  .cols.two { grid-template-columns:1.1fr 0.9fr; }
  ul { margin:0; padding-left:24px; display:flex; flex-direction:column; gap:14px; font-size:clamp(18px,2vw,24px); line-height:1.45; color:#e2e8f0; }
  pre { margin:0; background:#020617; border:1px solid #334155; border-top:3px solid var(--accent); border-radius:10px; padding:18px; overflow:auto; font-size:14px; line-height:1.5; color:#a5f3fc; }
  footer { background:var(--card); border-top:1px solid #334155; padding:14px 24px; display:flex; flex-direction:column; gap:8px; }
  .notes { color:#cbd5e1; font-size:14px; line-height:1.45; }
  .controls { display:flex; align-items:center; gap:10px; }
  button { background:#0284c7; color:#fff; border:0; border-radius:6px; padding:7px 14px; cursor:pointer; font-weight:600; }
  button.sec { background:#334155; }
  .bar { height:4px; background:#334155; border-radius:2px; overflow:hidden; }
  .bar > div { height:100%; background:var(--accent); width:0%; transition:width .2s; }
</style>
</head>
<body>
<header>
  <span class="pill" id="badge">Slide 1</span>
  <strong id="deckTitle">${escHtml(spec.title)}</strong>
  <span class="spacer"></span>
  <span id="timer" class="muted">00:00 / ${Math.floor(spec.estimatedSeconds / 60)}:${String(spec.estimatedSeconds % 60).padStart(2, '0')}</span>
</header>
<main>
  <h1 id="slideTitle"></h1>
  <div id="grid" class="cols"><ul id="bullets"></ul><pre id="code" hidden></pre></div>
</main>
<footer>
  <div class="bar"><div id="prog"></div></div>
  <div class="notes" id="notes"></div>
  <div class="controls">
    <button class="sec" id="prev">← Previous</button>
    <button id="next">Next →</button>
    <span style="flex:1"></span>
    <span style="color:var(--muted);font-size:12px">Use Arrow keys or Space to present</span>
  </div>
</footer>
<script id="deck-data" type="application/json">${dataJson}</script>
<script>
const deck = JSON.parse(document.getElementById('deck-data').textContent);
let idx = 0, sec = 0;
function show(i) {
  idx = Math.max(0, Math.min(deck.slides.length - 1, i));
  const s = deck.slides[idx];
  document.getElementById('badge').textContent = 'Slide ' + s.index + ' / ' + deck.slides.length;
  document.getElementById('slideTitle').textContent = s.title;
  document.getElementById('bullets').innerHTML = s.bullets.map(b => '<li>' + b.replace(/[<>&]/g, m => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m])) + '</li>').join('');
  const code = document.getElementById('code'), grid = document.getElementById('grid');
  if (s.codeSnippet) { code.hidden = false; code.textContent = s.codeSnippet; grid.className = 'cols two'; }
  else { code.hidden = true; grid.className = 'cols'; }
  document.getElementById('notes').textContent = s.narration;
  document.getElementById('prog').style.width = ((idx + 1) / deck.slides.length * 100) + '%';
}
document.getElementById('prev').onclick = () => show(idx - 1);
document.getElementById('next').onclick = () => show(idx + 1);
document.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); show(idx + 1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); show(idx - 1); }
});
setInterval(() => {
  sec++;
  const t = deck.estimatedSeconds || 0;
  document.getElementById('timer').textContent = Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0')+' / '+Math.floor(t/60)+':'+String(t%60).padStart(2,'0');
}, 1000);
show(0);
</script>
</body>
</html>`;
}

/** Write .srt, .vtt, .txt, and .json transcript sidecars next to `basePath` (without extension). */
export function writeTranscriptSidecars(basePathWithoutExt: string, segments: Segment[], meta: { source: string; backend: string; language?: string }): string[] {
  fs.mkdirSync(path.dirname(basePathWithoutExt), { recursive: true });
  const t: Transcript = {
    source: meta.source,
    backend: meta.backend,
    language: meta.language || 'und',
    createdAt: new Date().toISOString(),
    segments,
  };
  const written: string[] = [];
  for (const fmt of ['srt', 'vtt', 'txt', 'json'] as const) {
    const out = `${basePathWithoutExt}.${fmt}`;
    fs.writeFileSync(out, render(fmt, t), 'utf8');
    written.push(out);
  }
  return written;
}
