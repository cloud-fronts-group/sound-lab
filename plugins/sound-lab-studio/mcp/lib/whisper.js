'use strict';
// Speech-to-text backends. Every backend returns {segments:[{start,end,text}], language?, backend}.
//   mlx-service  HTTP → mlx-audio server (native Metal, or docker/podman/apple-container with mlx[cpu])
//   mlx          local `mlx_whisper` CLI (Apple Silicon, Metal)
//   whisper.cpp  local `whisper-cli` (Metal on macOS, CUDA/Vulkan/CPU elsewhere) — or inside a container runner
//   openai       any OpenAI-compatible /audio/transcriptions endpoint
//   ffmpeg       FFmpeg 8+ `whisper` filter
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, tail, which } = require('./ff');
const { invocation } = require('./runners');
const Sub = require('./subtitles');

/** Decide which backend "auto" means on this host. */
async function pickBackend(cfg, mlxService, caps) {
  if (cfg.backend && cfg.backend !== 'auto') { return cfg.backend; }
  if (mlxService && (await mlxService.health()).reachable) { return 'mlx-service'; }
  if (caps.appleSilicon && which(cfg.mlxWhisperExe || 'mlx_whisper')) { return 'mlx'; }
  if (cfg.whisperCpp.model && fs.existsSync(cfg.whisperCpp.model) && (which(cfg.whisperCpp.exe) || cfg.runner !== 'local')) { return 'whisper.cpp'; }
  if (cfg.openai.apiKey) { return 'openai'; }
  if (caps.filters.has('whisper') && cfg.ffmpegWhisperModel) { return 'ffmpeg'; }
  throw new Error('No speech-to-text backend is available. Options: start the MLX audio service (mlx_service action "start"), '
    + '`pip install mlx-whisper` (Apple Silicon), install whisper.cpp + set whispercpp_model, or set OPENAI_API_KEY.');
}

async function toWav16k(cfg, input, out, signal) {
  const r = await run(cfg.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', input, '-map', '0:a:0', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out], { signal });
  if (r.code !== 0) { throw new Error(`Could not decode audio: ${tail(r.stderr, 3)}`); }
}

/**
 * @param {string} input
 * @param {object} cfg  transcription config (see server.js)
 * @param {{signal?: AbortSignal, onProgress?: (f:number)=>void, onLog?: (l:string)=>void, mlxService?: any, caps: any, duration?: number}} ctx
 */
async function transcribe(input, cfg, ctx) {
  const backend = await pickBackend(cfg, ctx.mlxService, ctx.caps);
  const work = fs.mkdtempSync(path.join(cfg.tmpDir || os.tmpdir(), 'stt-'));
  try {
    const segs = await BACKENDS[backend](input, cfg, ctx, work);
    return { backend, ...segs };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

const BACKENDS = {
  async 'mlx-service'(input, cfg, ctx, work) {
    if (!ctx.mlxService) { throw new Error('MLX service not configured'); }
    ctx.onProgress?.(0.05);
    const wav = path.join(work, 'in.wav');
    await toWav16k(cfg, input, wav, ctx.signal);
    ctx.onProgress?.(0.15);
    const r = await ctx.mlxService.transcribe(wav, { model: cfg.mlxModel, language: cfg.language, prompt: cfg.prompt, signal: ctx.signal });
    ctx.onProgress?.(1);
    const segments = r.segments.length ? r.segments : (r.text ? [{ start: 0, end: ctx.duration || 0, text: r.text }] : []);
    return { segments, language: r.language };
  },

  async mlx(input, cfg, ctx, work) {
    const exe = which(cfg.mlxWhisperExe || 'mlx_whisper');
    if (!exe) { throw new Error('mlx_whisper not found. Install with: pip install mlx-whisper (Apple Silicon only).'); }
    const args = [input, '--model', cfg.mlxModel, '--output-dir', work, '--output-format', 'json', '--verbose', 'False'];
    if (cfg.language && cfg.language !== 'auto') { args.push('--language', cfg.language); }
    if (cfg.translate) { args.push('--task', 'translate'); }
    if (cfg.prompt) { args.push('--initial-prompt', cfg.prompt); }
    const r = await run(exe, args, {
      signal: ctx.signal,
      onLine: l => { const m = /(\d{1,3})%\|/.exec(l); if (m) { ctx.onProgress?.(+m[1] / 100); } else { ctx.onLog?.(l); } },
    });
    if (r.cancelled) { throw new Error('Cancelled'); }
    if (r.code !== 0) { throw new Error(`mlx_whisper failed: ${tail(r.stderr, 5)}`); }
    const json = fs.readdirSync(work).find(f => f.endsWith('.json'));
    if (!json) { throw new Error('mlx_whisper produced no JSON output'); }
    const j = JSON.parse(fs.readFileSync(path.join(work, json), 'utf8'));
    return { segments: (j.segments || []).map(s => ({ start: s.start, end: s.end, text: String(s.text).trim() })).filter(s => s.text), language: j.language };
  },

  async 'whisper.cpp'(input, cfg, ctx, work) {
    const w = cfg.whisperCpp;
    if (!w.model || !fs.existsSync(w.model)) { throw new Error(`whisper.cpp model not found: "${w.model}". Set whispercpp_model to a ggml-*.bin file.`); }
    const wav = path.join(work, 'in.wav');
    await toWav16k(cfg, input, wav, ctx.signal);
    const base = path.join(work, 'out');
    const args = ['-m', w.model, '-f', wav, '-oj', '-of', base, '-pp', '-l', cfg.language && cfg.language !== 'auto' ? cfg.language : 'auto'];
    if (cfg.translate) { args.push('-tr'); }
    if (cfg.prompt) { args.push('--prompt', cfg.prompt); }
    if (w.threads > 0) { args.push('-t', String(w.threads)); }
    const inv = invocation({ ...cfg.container, image: cfg.container.whisperImage, binaries: { 'whisper-cli': w.exe, ...cfg.container.binaries } },
      'whisper-cli', args, { reads: [wav, w.model], writes: [work] });
    const r = await run(inv.cmd, inv.args, {
      signal: ctx.signal,
      onLine: l => { const m = /progress\s*=\s*(\d+)%/.exec(l); if (m) { ctx.onProgress?.(+m[1] / 100); } else { ctx.onLog?.(l); } },
    });
    if (r.cancelled) { throw new Error('Cancelled'); }
    if (r.code !== 0) { throw new Error(`whisper.cpp failed: ${tail(r.stderr, 5)}`); }
    return { segments: Sub.fromWhisperCppJson(JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'))) };
  },

  async openai(input, cfg, ctx, work) {
    const o = cfg.openai;
    const r = await run(cfg.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', input, '-map', '0:a:0', '-ar', '16000', '-ac', '1', '-c:a', 'flac',
      '-f', 'segment', '-segment_time', '600', '-reset_timestamps', '1', path.join(work, 'chunk_%04d.flac')], { signal: ctx.signal });
    if (r.code !== 0) { throw new Error(`Could not prepare upload: ${tail(r.stderr, 3)}`); }
    const chunks = fs.readdirSync(work).filter(f => f.startsWith('chunk_')).sort();
    const endpoint = `${o.baseUrl.replace(/\/+$/, '')}/audio/${cfg.translate ? 'translations' : 'transcriptions'}`;
    const out = []; let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      const file = path.join(work, chunks[i]);
      const p = await run(cfg.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
      const dur = parseFloat(p.stdout) || 600;
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/flac' }), chunks[i]);
      form.append('model', o.model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
      if (!cfg.translate && cfg.language && cfg.language !== 'auto') { form.append('language', cfg.language); }
      if (cfg.prompt) { form.append('prompt', cfg.prompt); }
      const res = await fetch(endpoint, { method: 'POST', body: form, headers: o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}, signal: ctx.signal });
      const body = await res.text();
      if (!res.ok) { throw new Error(`Transcription API ${res.status}: ${body.slice(0, 300)}`); }
      out.push(...Sub.fromOpenAiJson(JSON.parse(body), offset, dur));
      offset += dur;
      ctx.onProgress?.((i + 1) / chunks.length);
    }
    return { segments: out };
  },

  async ffmpeg(input, cfg, ctx, work) {
    if (!ctx.caps.filters.has('whisper')) { throw new Error('This FFmpeg has no "whisper" filter (needs FFmpeg 8+ built with --enable-whisper).'); }
    const out = path.join(work, 'out.srt');
    const esc = v => v.replace(/[\\':]/g, m => '\\' + m).replace(/[\\'[\],;]/g, m => '\\' + m);
    const af = `aresample=16000,aformat=channel_layouts=mono,whisper=model=${esc(cfg.ffmpegWhisperModel)}:language=${cfg.language || 'auto'}:queue=3:destination=${esc(out)}:format=srt`;
    const r = await run(cfg.ffmpeg, ['-hide_banner', '-nostdin', '-i', input, '-map', '0:a:0', '-af', af, '-f', 'null', '-'], { signal: ctx.signal, duration: ctx.duration, onProgress: ctx.onProgress });
    if (r.code !== 0) { throw new Error(`ffmpeg whisper failed: ${tail(r.stderr, 4)}`); }
    return { segments: Sub.parseCues(fs.readFileSync(out, 'utf8')) };
  },
};

module.exports = { transcribe, pickBackend, BACKENDS };
