'use strict';
// Zero-dependency presentation folder scanner, 5-10 min instructional deck scaffolder,
// pure-Node RGB bitmap PNG slide renderer, and screen tutorial ffmpeg plan builder.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', '.claude']);
const TEXT_EXT = new Set(['.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.json', '.yaml', '.yml', '.toml', '.sh']);
const MEDIA_EXT = new Set(['.wav', '.mp3', '.flac', '.ogg', '.opus', '.m4a', '.mp4', '.mov', '.mkv', '.webm']);

const clampMinutes = (m) => {
  const n = Number(m);
  return (!isFinite(n) || n <= 0) ? 7 : Math.max(5, Math.min(10, n));
};
const estimateSec = (text, wpm = 148) => Math.max(25, Math.round((String(text || '').trim().split(/\s+/).filter(Boolean).length / wpm) * 60));
const slug = (s) => String(s || 'presentation').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'presentation';
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function scanFolderContext(folderPath, opts = {}) {
  const root = path.resolve(folderPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Presentation folder does not exist: ${root}`);
  }
  const maxDepth = opts.maxDepth ?? 4;
  const maxFiles = opts.maxFiles ?? 250;
  const files = [], directories = [], extensions = {}, mediaFiles = [], docs = [], highlights = [];
  function walk(dir, depth) {
    if (depth > maxDepth || files.length >= maxFiles) { return; }
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const e of entries) {
      if (files.length >= maxFiles) { break; }
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) { continue; }
      const full = path.join(dir, e.name), rel = path.relative(root, full);
      if (e.isDirectory()) { directories.push(rel); walk(full, depth + 1); continue; }
      if (!e.isFile()) { continue; }
      files.push(rel);
      const ext = path.extname(e.name).toLowerCase() || '(no-ext)';
      extensions[ext] = (extensions[ext] || 0) + 1;
      if (MEDIA_EXT.has(ext)) { mediaFiles.push(rel); }
      if (!TEXT_EXT.has(ext)) { continue; }
      try {
        const txt = fs.readFileSync(full, 'utf8').slice(0, 1400).trim();
        if (/^(readme|architecture|design|guide)/i.test(e.name) && docs.length < 4) { docs.push({ file: rel, excerpt: txt }); }
        else if (['.ts', '.js', '.py', '.go', '.rs', '.sh'].includes(ext) && highlights.length < 6) {
          const syms = [...txt.matchAll(/(?:export\s+)?(?:async\s+)?(?:function|class|def|interface|const)\s+([A-Za-z_]\w*)/g)].map(m => m[1]).slice(0, 8);
          highlights.push({ file: rel, symbols: syms, excerpt: txt.slice(0, 600) });
        }
      } catch { /* unreadable */ }
    }
  }
  walk(root, 0);
  return { name: path.basename(root), rootPath: root, fileCount: files.length, directories, files, extensions, docs, highlights, mediaFiles };
}

function buildDefaultSlides(topic, ctx, research, targetMinutes) {
  const targetSec = Math.round(clampMinutes(targetMinutes) * 60);
  const dirs = ctx.directories.filter(d => !d.includes(path.sep)).slice(0, 5);
  const docs = ctx.docs.map(d => d.file);
  const mods = ctx.highlights;
  const rLines = String(research || '').split('\n').map(l => l.replace(/^[#*\-\d.\s]+/, '').trim()).filter(l => l.length > 25 && !/^http/i.test(l)).slice(0, 4);
  const raw = [
    { title: topic || `${ctx.name} Walkthrough`, bullets: [`Folder: ${ctx.name} (${ctx.fileCount} files)`, `Target duration: ${clampMinutes(targetMinutes)} minutes`, 'Grounded in Deep Research + source analysis'], narration: `Welcome everyone. Today we will explore ${topic} using the ${ctx.name} folder (${ctx.fileCount} files), covering key research insights, architecture, core modules, and live execution.` },
    { title: 'Research Synthesis & Best Practices', bullets: rLines.length ? rLines : [`Domain fundamentals for ${topic}`, 'Local-first privacy & GPU acceleration', 'Non-destructive automated pipelines'], narration: rLines.length ? `Let us anchor our design in research findings. ${rLines.join(' ')}` : `Before inspecting code, let us outline the architectural principles behind ${topic}, balancing throughput, modular separation, and verifiable outputs.` },
    { title: `Workspace Layout: ${ctx.name}`, bullets: [`Directories: ${dirs.join(', ') || '(root)'}`, `Docs: ${docs.join(', ') || 'inline'}`, `Media assets: ${ctx.mediaFiles.length}`], codeSnippet: ctx.files.slice(0, 8).join('\n'), narration: `Here is how ${ctx.name} is organized across ${ctx.fileCount} files. Documentation and implementation sit side by side so contributors can trace every workflow easily.` },
    { title: mods[0] ? `Core Module: ${mods[0].file}` : 'Core Implementation', bullets: mods[0] ? [`File: ${mods[0].file}`, `Symbols: ${mods[0].symbols.slice(0, 4).join(', ') || 'core helpers'}`] : ['Single-purpose composable helpers', 'Structured error and validation checks'], codeSnippet: mods[0]?.excerpt.split('\n').slice(0, 7).join('\n'), narration: mods[0] ? `Inspecting ${mods[0].file}, notice the primary symbols ${mods[0].symbols.slice(0, 4).join(', ')}. Keeping pure logic testable lets us verify behavior quickly.` : `In the core implementation layer, pure helpers stay isolated from transport and UI concerns.` },
    { title: mods[1] ? `Workflow & Integration: ${mods[1].file}` : 'End-to-End Pipeline', bullets: mods[1] ? [`File: ${mods[1].file}`, `Key exports: ${mods[1].symbols.slice(0, 4).join(', ') || 'orchestrator'}`] : ['Validates inputs before running jobs', 'Streams progress & writes unique outputs'], narration: mods[1] ? `Next, ${mods[1].file} orchestrates inputs, background jobs, and safe output generation.` : `Our orchestration pipeline coordinates validation, background processing, and synchronized output artifacts.` },
    { title: 'Live Demo, Testing & Takeaways', bullets: ['Clone or select presenter voice first', 'Record or overlay slides with synchronized transcripts', 'Verify outputs with automated tests & ffprobe'], narration: `Finally, verify generated outputs with ffprobe and automated tests. Thank you for watching this ${clampMinutes(targetMinutes)}-minute instructional walkthrough of ${topic}.` },
  ];
  const baseSum = raw.reduce((a, s) => a + estimateSec(s.narration), 0);
  const scale = targetSec / Math.max(1, baseSum);
  return raw.map((s, i) => ({ index: i + 1, ...s, durationSec: Math.max(25, Math.round(estimateSec(s.narration) * scale)) }));
}

function scaffoldPresentation({ outputDir, title, topic, folderContext, targetMinutes, audience = 'Developers', voiceProfileId, researchReport, slides }) {
  const mins = clampMinutes(targetMinutes);
  const research = String(researchReport || `# Research Brief: ${topic}\n\nFolder: ${folderContext.rootPath} (${folderContext.fileCount} files)\n`).trim();
  const deckSlides = slides?.length ? slides.map((s, i) => ({ ...s, index: i + 1, durationSec: s.durationSec || estimateSec(s.narration) })) : buildDefaultSlides(topic, folderContext, research, mins);
  const estimatedSeconds = deckSlides.reduce((a, s) => a + s.durationSec, 0);
  const spec = { title: title || topic || folderContext.name, topic: topic || title || folderContext.name, folderPath: folderContext.rootPath, targetMinutes: mins, estimatedSeconds, audience, voiceProfileId, createdAt: new Date().toISOString(), slides: deckSlides };

  const out = path.resolve(outputDir);
  fs.mkdirSync(out, { recursive: true });
  const files = {
    json: path.join(out, 'presentation.json'),
    markdown: path.join(out, 'slides.md'),
    html: path.join(out, 'slides.html'),
    script: path.join(out, 'narration-script.txt'),
    research: path.join(out, 'research-report.md'),
  };
  fs.writeFileSync(files.json, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  fs.writeFileSync(files.research, research + '\n', 'utf8');
  fs.writeFileSync(files.script, deckSlides.map(s => `[Slide ${s.index} — ${s.title} (~${s.durationSec}s)]\n${s.narration}\n`).join('\n'), 'utf8');
  fs.writeFileSync(files.markdown, `# ${spec.title}\n\n_Target: ${mins} min (~${Math.round(estimatedSeconds / 60 * 10) / 10} min) · Audience: ${audience}_\n\n` + deckSlides.map(s => `---\n\n## Slide ${s.index}: ${s.title}\n\n${s.bullets.map(b => `- ${b}`).join('\n')}\n\n${s.codeSnippet ? '```\n' + s.codeSnippet + '\n```\n\n' : ''}> **Narration (~${s.durationSec}s):** ${s.narration}\n`).join('\n'), 'utf8');
  fs.writeFileSync(files.html, `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(spec.title)}</title><style>body{margin:0;font:16px/1.5 system-ui;background:#0b1220;color:#e2e8f0;padding:32px}section{max-width:900px;margin:0 auto 24px;padding:24px;border:1px solid #334155;border-radius:12px;background:#111c33}h1,h2{color:#38bdf8}pre{background:#020617;padding:12px;border-radius:8px;overflow:auto}</style></head><body><h1>${escHtml(spec.title)}</h1><p>${escHtml(String(mins))} min instructional deck</p>${deckSlides.map(s => `<section><h2>Slide ${s.index}: ${escHtml(s.title)}</h2><ul>${s.bullets.map(b => `<li>${escHtml(b)}</li>`).join('')}</ul>${s.codeSnippet ? `<pre>${escHtml(s.codeSnippet)}</pre>` : ''}<p><em>${escHtml(s.narration)}</em></p></section>`).join('')}</body></html>`, 'utf8');
  return { dir: out, spec, files };
}

// ------------------------------------------------------------------ Minimal 5x7 RGB PNG renderer (zero deps)
const GLYPHS = { ' ': [0,0,0,0,0,0,0], '-': [0,0,0,31,0,0,0], '.': [0,0,0,0,0,4,4], ':': [0,4,4,0,4,4,0], '/': [1,2,2,4,8,8,16], '(': [2,4,8,8,8,4,2], ')': [8,4,2,2,2,4,8], ',': [0,0,0,0,4,4,8], '\'': [4,4,8,0,0,0,0], '*': [0,4,21,14,21,4,0], '+': [0,4,4,31,4,4,0], '=': [0,0,31,0,31,0,0], '_': [0,0,0,0,0,0,31], '0': [14,17,19,21,25,17,14], '1': [4,12,4,4,4,4,14], '2': [14,17,1,6,8,16,31], '3': [31,2,4,6,1,17,14], '4': [2,6,10,18,31,2,2], '5': [31,16,30,1,1,17,14], '6': [6,8,16,30,17,17,14], '7': [31,1,2,4,8,8,8], '8': [14,17,17,14,17,17,14], '9': [14,17,17,15,1,2,12], A: [14,17,17,31,17,17,17], B: [30,17,17,30,17,17,30], C: [14,17,16,16,16,17,14], D: [30,17,17,17,17,17,30], E: [31,16,16,30,16,16,31], F: [31,16,16,30,16,16,16], G: [14,17,16,23,17,17,15], H: [17,17,17,31,17,17,17], I: [14,4,4,4,4,4,14], J: [7,2,2,2,18,18,12], K: [17,18,20,24,20,18,17], L: [16,16,16,16,16,16,31], M: [17,27,21,21,17,17,17], N: [17,25,21,19,17,17,17], O: [14,17,17,17,17,17,14], P: [30,17,17,30,16,16,16], Q: [14,17,17,17,21,18,13], R: [30,17,17,30,20,18,17], S: [15,16,16,14,1,1,30], T: [31,4,4,4,4,4,4], U: [17,17,17,17,17,17,14], V: [17,17,17,17,17,10,4], W: [17,17,17,21,21,27,17], X: [17,17,10,4,10,17,17], Y: [17,17,10,4,4,4,4], Z: [31,1,2,4,8,16,31] };
const CRC_TBL = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TBL[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) { const o = Buffer.alloc(12 + data.length); o.writeUInt32BE(data.length, 0); o.write(type, 4, 4, 'ascii'); data.copy(o, 8); o.writeUInt32BE(crc32(o.subarray(4, 8 + data.length)), 8 + data.length); return o; }

function renderSlidePng(slide, total, opts = {}) {
  const w = opts.width || 1280, h = opts.height || 720;
  const buf = Buffer.alloc(w * h * 3);
  const rect = (x, y, rw, rh, rgb) => {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y)), x1 = Math.min(w, Math.floor(x + rw)), y1 = Math.min(h, Math.floor(y + rh));
    for (let py = y0; py < y1; py++) { let o = (py * w + x0) * 3; for (let px = x0; px < x1; px++) { buf[o++] = rgb[0]; buf[o++] = rgb[1]; buf[o++] = rgb[2]; } }
  };
  const text = (str, x, y, sc, rgb) => {
    let cx = x;
    for (const rawCh of String(str || '').toUpperCase()) {
      if (cx + 5 * sc > w) { break; }
      const g = GLYPHS[rawCh] || GLYPHS[' '];
      for (let ry = 0; ry < 7; ry++) for (let rx = 0; rx < 5; rx++) if ((g[ry] >> (4 - rx)) & 1) rect(cx + rx * sc, y + ry * sc, sc, sc, rgb);
      cx += 6 * sc;
    }
  };
  rect(0, 0, w, h, [15, 23, 42]);
  rect(0, 0, w, 6, [56, 189, 248]);
  text(`SLIDE ${slide.index} / ${total}`, 64, 48, 2, [56, 189, 248]);
  text(String(slide.title || '').slice(0, 44), 64, 110, 4, [248, 250, 252]);
  let y = 210;
  for (const b of (slide.bullets || []).slice(0, 6)) {
    rect(72, y + 8, 8, 8, [56, 189, 248]);
    text(String(b).slice(0, 60), 98, y, 2, [203, 213, 225]);
    y += 42;
  }
  const stride = 1 + w * 3, raw = Buffer.alloc(stride * h);
  for (let py = 0; py < h; py++) buf.copy(raw, py * stride + 1, py * w * 3, (py + 1) * w * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0))]);
}

function writeSlidePngs(slides, outDir, opts = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  return slides.map((s, i) => {
    const file = path.join(outDir, `slide_${String(i + 1).padStart(3, '0')}.png`);
    fs.writeFileSync(file, renderSlidePng({ ...s, index: s.index || i + 1 }, slides.length, opts));
    return file;
  });
}

function recordScreenPlan({ output, platform = process.platform, videoDevice, audioDevice, chunkDir, chunkSeconds = 8, fps = 30 }) {
  const out = path.resolve(output || 'screen-tutorial.mp4');
  const vFmt = platform === 'darwin' ? 'avfoundation' : platform === 'win32' ? 'gdigrab' : 'x11grab';
  const aFmt = platform === 'darwin' ? 'avfoundation' : platform === 'win32' ? 'dshow' : 'pulse';
  const args = ['-hide_banner', '-y'];
  let audioMap = '1:a:0';
  if (platform === 'darwin') {
    args.push('-f', 'avfoundation', '-framerate', String(fps), '-capture_cursor', '1', '-capture_mouse_clicks', '1', '-i', `${videoDevice || '1'}:${audioDevice || '0'}`);
    audioMap = '0:a:0';
  } else {
    args.push('-f', vFmt, '-framerate', String(fps), '-i', videoDevice || (platform === 'win32' ? 'desktop' : ':0.0'));
    args.push('-f', aFmt, '-i', audioDevice || (platform === 'win32' ? 'audio=default' : 'default'));
  }
  const cDir = path.resolve(chunkDir || path.join(path.dirname(out), '.live-chunks'));
  const chunkPattern = path.join(cDir, 'chunk_%04d.wav');
  args.push(
    '-map', '0:v:0', '-map', audioMap, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+frag_keyframe+empty_moov', out,
    '-map', audioMap, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', String(Math.max(2, chunkSeconds)), '-reset_timestamps', '1', chunkPattern,
  );
  return {
    platform,
    videoInputFormat: vFmt,
    audioInputFormat: aFmt,
    output: out,
    chunkPattern,
    captureFfmpegArgs: args,
    workflow: [
      '1. Start simultaneous screen + rolling chunk capture with captureFfmpegArgs (using run_ffmpeg or terminal).',
      '2. As each closed chunk_%04d.wav appears, call transcribe -> get text, and synthesize_speech with ref_audio + ref_text to generate cloned chunk audio.',
      '3. When capture finishes, stop gracefully with "q", write final .srt transcript, and mux video + cloned audio (default track) + original audio (track 2) + mov_text subtitles.',
    ],
  };
}

module.exports = { scanFolderContext, scaffoldPresentation, writeSlidePngs, recordScreenPlan, clampMinutes, slug };
