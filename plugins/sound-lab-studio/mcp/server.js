#!/usr/bin/env node
'use strict';
// Sound Lab media MCP server — background ffmpeg batch jobs, transcription and MLX audio inference.
// Zero npm dependencies: MCP over stdio (newline-delimited JSON-RPC 2.0), Node >= 18.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { run, tail, which, probe, capabilities } = require('./lib/ff');
const { expandInputs } = require('./lib/glob');
const { PRESETS, listPresets } = require('./lib/presets');
const { invocation, killContainer, containerInfo, defaultDataDir } = require('./lib/runners');
const { JobManager } = require('./lib/jobs');
const { MlxService } = require('./lib/mlx');
const whisper = require('./lib/whisper');
const Sub = require('./lib/subtitles');

const VERSION = '0.1.0';
const env = process.env;
const nonEmpty = (v, d) => (v === undefined || v === null || String(v).trim() === '' || /^\$\{user_config\./.test(String(v)) ? d : String(v).trim());
const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64';

// ------------------------------------------------------------------ configuration (env ← plugin userConfig)
const CFG = {
  ffmpeg: nonEmpty(env.SOUND_LAB_FFMPEG, 'ffmpeg'),
  ffprobe: nonEmpty(env.SOUND_LAB_FFPROBE, 'ffprobe'),
  dataDir: defaultDataDir(),
  outputDir: nonEmpty(env.SOUND_LAB_OUTPUT_DIR, ''),
  maxConcurrency: parseInt(nonEmpty(env.SOUND_LAB_MAX_CONCURRENCY, String(Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))))), 10),
  container: {
    runner: nonEmpty(env.SOUND_LAB_RUNNER, 'local'),
    image: nonEmpty(env.SOUND_LAB_IMAGE, 'ghcr.io/cloud-fronts-group/sound-lab-ffmpeg:latest'),
    whisperImage: nonEmpty(env.SOUND_LAB_WHISPER_IMAGE, 'ghcr.io/cloud-fronts-group/sound-lab-whisper-vulkan:latest'),
    gpu: nonEmpty(env.SOUND_LAB_GPU, 'none'),
    binaries: { ffmpeg: nonEmpty(env.SOUND_LAB_FFMPEG, 'ffmpeg'), ffprobe: nonEmpty(env.SOUND_LAB_FFPROBE, 'ffprobe'), docker: nonEmpty(env.SOUND_LAB_DOCKER, 'docker'), podman: nonEmpty(env.SOUND_LAB_PODMAN, 'podman') },
  },
};
const mlxMode = (() => { const m = nonEmpty(env.SOUND_LAB_MLX_MODE, 'auto'); return m === 'auto' ? (appleSilicon ? 'native' : 'docker') : m; })();
CFG.mlx = {
  mode: mlxMode,
  autostart: nonEmpty(env.SOUND_LAB_MLX_AUTOSTART, 'true') !== 'false',
  url: nonEmpty(env.SOUND_LAB_MLX_URL, ''),
  port: parseInt(nonEmpty(env.SOUND_LAB_MLX_PORT, '8000'), 10),
  image: nonEmpty(env.SOUND_LAB_MLX_IMAGE, 'ghcr.io/cloud-fronts-group/sound-lab-mlx-audio:cpu'),
  hfCache: nonEmpty(env.SOUND_LAB_HF_CACHE, path.join(os.homedir(), '.cache', 'huggingface')),
  dataDir: CFG.dataDir,
  sttModel: nonEmpty(env.SOUND_LAB_STT_MODEL, 'mlx-community/whisper-large-v3-turbo'),
  ttsModel: nonEmpty(env.SOUND_LAB_TTS_MODEL, 'mlx-community/Kokoro-82M-bf16'),
  ttsVoice: nonEmpty(env.SOUND_LAB_TTS_VOICE, 'af_heart'),
  binaries: { docker: CFG.container.binaries.docker, podman: CFG.container.binaries.podman, container: nonEmpty(env.SOUND_LAB_APPLE_CONTAINER, 'container'), python3: nonEmpty(env.SOUND_LAB_PYTHON, 'python3') },
  which,
};
CFG.stt = {
  backend: nonEmpty(env.SOUND_LAB_STT_BACKEND, 'auto'),
  ffmpeg: CFG.ffmpeg, ffprobe: CFG.ffprobe,
  language: 'auto', translate: false, prompt: '',
  tmpDir: path.join(CFG.dataDir, 'tmp'),
  mlxModel: CFG.mlx.sttModel,
  mlxWhisperExe: nonEmpty(env.SOUND_LAB_MLX_WHISPER, 'mlx_whisper'),
  whisperCpp: { exe: nonEmpty(env.SOUND_LAB_WHISPERCPP, 'whisper-cli'), model: nonEmpty(env.SOUND_LAB_WHISPERCPP_MODEL, ''), threads: 0 },
  ffmpegWhisperModel: nonEmpty(env.SOUND_LAB_FFMPEG_WHISPER_MODEL, ''),
  openai: { baseUrl: nonEmpty(env.SOUND_LAB_OPENAI_BASE_URL, 'https://api.openai.com/v1'), model: nonEmpty(env.SOUND_LAB_OPENAI_MODEL, 'whisper-1'), apiKey: nonEmpty(env.OPENAI_API_KEY, '') },
  container: CFG.container,
};
fs.mkdirSync(CFG.stt.tmpDir, { recursive: true });

const log = (s) => process.stderr.write(`[sound-lab-mcp] ${s}\n`);
const caps = () => capabilities(CFG.ffmpeg, CFG.ffprobe);
const mlx = new MlxService(CFG.mlx);

async function ensureMlx(signal) {
  const h = await mlx.health();
  if (h.reachable) { return h; }
  if (!CFG.mlx.autostart) { throw new Error(`MLX audio service is not running at ${mlx.url}. Start it with mlx_service {"action":"start"}.`); }
  log(`starting MLX audio service (${CFG.mlx.mode})`);
  return mlx.start({ signal });
}

// ------------------------------------------------------------------ paths
function uniquePath(p, overwrite) {
  if (overwrite || !fs.existsSync(p)) { return p; }
  const { dir, name, ext } = path.parse(p);
  for (let i = 1; ; i++) { const c = path.join(dir, `${name}-${i}${ext}`); if (!fs.existsSync(c)) { return c; } }
}

function commonDir(files) {
  if (!files.length) { return process.cwd(); }
  let parts = path.dirname(files[0]).split(path.sep);
  for (const f of files.slice(1)) {
    const q = path.dirname(f).split(path.sep);
    let i = 0; while (i < parts.length && i < q.length && parts[i] === q[i]) { i++; }
    parts = parts.slice(0, i);
  }
  return parts.join(path.sep) || path.sep;
}

/** Output path for an input. Never returns the input itself. */
function plannedOutput(input, base, { outputDir, suffix, ext, overwrite, taken }) {
  const { name } = path.parse(input);
  const rel = path.relative(base, path.dirname(input));
  const dir = outputDir ? path.join(path.resolve(outputDir), rel) : path.dirname(input);
  let out = path.join(dir, `${name}${suffix}.${ext}`);
  if (path.resolve(out) === path.resolve(input)) { out = path.join(dir, `${name}${suffix || '_out'}-1.${ext}`); }
  out = uniquePath(out, overwrite);
  while (taken.has(out)) { out = uniquePath(out.replace(/(\.[^.]+)$/, '-x$1'), false); }
  taken.add(out);
  return out;
}

// ------------------------------------------------------------------ job item handlers
async function runFfmpegInvocation(args, files, ctx, duration) {
  const inv = invocation(CFG.container, 'ffmpeg', args, files);
  ctx.setCommand([inv.cmd, ...inv.args].map(a => (/[\s"'|;&()<>]/.test(a) ? JSON.stringify(a) : a)).join(' '));
  const r = await run(inv.cmd, inv.args, { signal: ctx.signal, duration, onProgress: ctx.onProgress, onLine: ctx.onLog });
  if (r.cancelled) { killContainer(CFG.container, inv.containerName); throw new Error('Cancelled'); }
  if (r.code !== 0) { throw new Error(`ffmpeg exited ${r.code}: ${tail(r.stderr, 4)}`); }
  return r;
}

/**
 * Make outputs safe to (re)write. First attempt: remember which outputs already existed (never ours to delete) and
 * refuse to clobber them unless overwrite. Retry/resume: delete partial files that a previous attempt of THIS item wrote.
 */
function prepareOutputs(it, writes) {
  if (!it.preexisting) { it.preexisting = writes.filter(w => fs.existsSync(w)); }
  for (const w of writes) {
    if (it.preexisting.includes(w)) {
      if (!it.overwrite) { throw new Error(`Output already exists: ${w}. Choose another path or pass overwrite: true.`); }
    } else if (fs.existsSync(w)) {
      fs.rmSync(w, { force: true }); // partial output from an earlier, interrupted attempt of this item
    }
    fs.mkdirSync(path.dirname(w), { recursive: true });
  }
}

async function verifyOutput(file) {
  if (!fs.existsSync(file)) { throw new Error(`ffmpeg reported success but ${file} was not created`); }
  const st = fs.statSync(file);
  if (st.size === 0) { throw new Error(`${file} is empty`); }
  try {
    const p = await probe(CFG.ffprobe, file);
    return { size: st.size, duration: Math.round(p.duration * 1000) / 1000, audio: p.audio?.codec, video: p.video?.codec, sampleRate: p.audio?.sampleRate, channels: p.audio?.channels };
  } catch (e) { throw new Error(`${file} was written but ffprobe cannot read it (${e.message.split('\n')[0]})`); }
}

const handlers = {
  async convert(it, ctx) {
    const src = await probe(CFG.ffprobe, it.input);
    const c = caps();
    const preset = it.preset ? PRESETS[it.preset] : null;
    let pre = [], post = [];
    if (preset) { ({ pre, post } = preset.build({ caps: c, hwaccel: it.hwaccel || 'auto', probe: src, opts: it.opts || {} })); }
    if (it.args) { post = [...post, ...it.args]; }
    const loud = preset?.loudnorm;
    let analyzeShare = 0;
    if (loud) {
      analyzeShare = 0.4;
      const a = await run(CFG.ffmpeg, ['-hide_banner', '-nostdin', '-i', it.input, '-map', '0:a:0', '-af', `loudnorm=I=${loud.I}:TP=${loud.TP}:LRA=${loud.LRA}:print_format=json`, '-f', 'null', '-'],
        { signal: ctx.signal, duration: src.duration, onProgress: f => ctx.onProgress(f * analyzeShare) });
      if (a.cancelled) { throw new Error('Cancelled'); }
      const js = a.stderr.slice(a.stderr.lastIndexOf('{'), a.stderr.lastIndexOf('}') + 1);
      const m = JSON.parse(js);
      const af = `loudnorm=I=${loud.I}:TP=${loud.TP}:LRA=${loud.LRA}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
      post = ['-af', af, ...post];
      if (!post.includes('-ar')) { post.push('-ar', String(src.audio?.sampleRate || 48000)); }
      ctx.onLog(`loudness measured: I=${m.input_i} LUFS, TP=${m.input_tp} dBTP, LRA=${m.input_lra}`);
    }
    prepareOutputs(it, [it.output]);
    const args = ['-hide_banner', '-nostdin', '-y', ...pre, '-i', it.input, ...post, it.output];
    await runFfmpegInvocation(args, { reads: [it.input], writes: [it.output] },
      { ...ctx, onProgress: f => ctx.onProgress(analyzeShare + f * (1 - analyzeShare)) }, src.duration);
    return verifyOutput(it.output);
  },

  async ffmpeg(it, ctx) {
    prepareOutputs(it, it.writes);
    await runFfmpegInvocation(it.args, { reads: it.reads, writes: it.writes }, ctx, it.duration);
    const out = {};
    for (const w of it.writes) { out[w] = await verifyOutput(w).catch(e => ({ error: e.message })); }
    return out;
  },

  async transcribe(it, ctx) {
    const src = await probe(CFG.ffprobe, it.input);
    const cfg = { ...CFG.stt, ...it.stt, openai: CFG.stt.openai, whisperCpp: CFG.stt.whisperCpp };
    if (cfg.backend === 'mlx-service') { await ensureMlx(ctx.signal); }
    const r = await whisper.transcribe(it.input, cfg, { signal: ctx.signal, onProgress: ctx.onProgress, onLog: ctx.onLog, mlxService: mlx, caps: caps(), duration: src.duration });
    if (!r.segments.length) { throw new Error(`No speech recognised (backend ${r.backend})`); }
    const t = { source: path.basename(it.input), backend: r.backend, language: r.language || cfg.language, createdAt: new Date().toISOString(), segments: r.segments };
    const files = [];
    for (const [fmt, file] of Object.entries(it.outputs)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Sub.render(fmt, t), 'utf8');
      files.push(file);
    }
    return { backend: r.backend, language: t.language, segments: r.segments.length, files, preview: r.segments.slice(0, 3).map(s => s.text).join(' ').slice(0, 200) };
  },

  async tts(it, ctx) {
    await ensureMlx(ctx.signal);
    ctx.onProgress(0.1);
    const r = await mlx.synthesize(it.text, it.output, { model: it.model, voice: it.voice, speed: it.speed, langCode: it.lang_code, instruct: it.instruct, signal: ctx.signal });
    return { ...r, ...(await verifyOutput(it.output)) };
  },

  async separate(it, ctx) {
    await ensureMlx(ctx.signal);
    ctx.onProgress(0.05);
    return mlx.separate(it.input, it.target, it.residual, { model: it.model, description: it.description, signal: ctx.signal });
  },
};

const jobs = new JobManager({ dataDir: CFG.dataDir, maxConcurrency: CFG.maxConcurrency, handlers, log });

// ------------------------------------------------------------------ ffmpeg argv analysis (for run_ffmpeg)
const NO_VALUE = new Set(['-y', '-n', '-nostdin', '-hide_banner', '-re', '-shortest', '-vn', '-an', '-sn', '-dn', '-copyts', '-stats', '-nostats', '-accurate_seek', '-noaccurate_seek', '-benchmark', '-ignore_unknown', '-copy_unknown', '-xerror', '-autorotate', '-noautorotate', '-dump', '-hex', '-start_at_zero']);
function analyzeArgs(args) {
  const reads = [], writes = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-i') { reads.push(args[++i]); continue; }
    if (a.startsWith('-') && a.length > 1) { if (!NO_VALUE.has(a)) { i++; } continue; }
    writes.push(a);
  }
  const isFile = s => s && s !== '-' && !/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith('pipe:');
  return { reads: reads.filter(isFile).map(p => path.resolve(p)), writes: writes.filter(isFile).map(p => path.resolve(p)), remote: reads.filter(r => /^[a-z][a-z0-9+.-]*:\/\//i.test(r)) };
}

// ------------------------------------------------------------------ tools
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const TOOLS = [
  {
    name: 'capabilities',
    description: 'Report what this machine can do: ffmpeg/ffprobe versions, Apple Silicon hardware (VideoToolbox, AudioToolbox, MLX), container runtimes (docker, podman + provider, Apple container), MLX audio service status, available speech-to-text backends, and configuration. Call this first.',
    inputSchema: { type: 'object', properties: { refresh: { type: 'boolean' } } },
    handler: async ({ refresh }) => {
      const c = capabilities(CFG.ffmpeg, CFG.ffprobe, !!refresh);
      const ci = containerInfo(which);
      const mlxHealth = await mlx.health();
      const backends = {
        'mlx-service': mlxHealth.reachable ? `ready at ${mlxHealth.url}` : `not running (mode ${CFG.mlx.mode}${CFG.mlx.autostart ? ', autostarts on demand' : ''})`,
        mlx: appleSilicon && which(CFG.stt.mlxWhisperExe) ? 'mlx_whisper CLI found' : 'not available (needs Apple Silicon + pip install mlx-whisper)',
        'whisper.cpp': which(CFG.stt.whisperCpp.exe) ? (CFG.stt.whisperCpp.model ? 'ready' : 'whisper-cli found, set whispercpp_model') : 'whisper-cli not found',
        openai: CFG.stt.openai.apiKey ? `key set (${CFG.stt.openai.baseUrl})` : 'OPENAI_API_KEY not set',
        ffmpeg: c.filters.has('whisper') ? 'whisper filter present' : 'no whisper filter (FFmpeg < 8)',
      };
      const recs = [];
      if (c.appleSilicon) {
        recs.push('Apple Silicon: use runner "local" for GPU work — VideoToolbox (h264/hevc_videotoolbox), AudioToolbox (aac_at) and MLX all need the host.');
        recs.push('MLX audio service mode "native" runs on the Apple GPU (Metal). Docker and Apple `container` run Linux VMs without Metal, so MLX there is CPU-only.');
        if (ci.podman && ci.podmanProvider !== 'libkrun') { recs.push('For GPU inside containers on macOS use a podman machine with the libkrun provider (Vulkan → Metal) and container_gpu "dri" with the whisper-vulkan image.'); }
      } else if (process.platform === 'linux') {
        recs.push('Linux: the MLX audio service runs on the CPU in docker/podman (the :cpu image, `mlx[cpu]`). For the Apple GPU, point mlx_url at a Mac running it natively (mlx_mode "external").');
      }
      if (!c.ffmpeg) { recs.push('Install ffmpeg: brew install ffmpeg (macOS) · apt install ffmpeg (Linux) · winget install ffmpeg (Windows).'); }
      return {
        host: { platform: c.platform, arch: c.arch, appleSilicon: c.appleSilicon, cpus: os.cpus().length },
        ffmpeg: { version: c.ffmpeg, ffprobe: c.ffprobe, hwaccels: [...c.hwaccels], videotoolbox: c.videotoolbox, audiotoolbox: c.audiotoolbox,
          keyEncoders: ['libmp3lame', 'aac', 'aac_at', 'libfdk_aac', 'alac', 'flac', 'libopus', 'libvorbis', 'libx264', 'libx265', 'h264_videotoolbox', 'hevc_videotoolbox', 'prores_videotoolbox', 'h264_nvenc'].filter(e => c.encoders.has(e)),
          keyFilters: ['loudnorm', 'sidechaincompress', 'amix', 'acrossfade', 'afftdn', 'arnndn', 'rubberband', 'whisper', 'showspectrumpic'].filter(f => c.filters.has(f)), errors: c.errors },
        containers: { ...ci, appleContainer: !!which(CFG.mlx.binaries.container) },
        mlxService: { ...mlxHealth, mode: CFG.mlx.mode, image: CFG.mlx.mode === 'native' ? null : CFG.mlx.image, sttModel: CFG.mlx.sttModel, ttsModel: CFG.mlx.ttsModel },
        speechToText: { configured: CFG.stt.backend, backends },
        config: { runner: CFG.container.runner, image: CFG.container.image, gpu: CFG.container.gpu, maxConcurrency: CFG.maxConcurrency, dataDir: CFG.dataDir, outputDir: CFG.outputDir || '(next to inputs)' },
        recommendations: recs,
      };
    },
  },
  {
    name: 'list_presets',
    description: 'List conversion presets for batch_convert (audio masters, MP3/AAC/Opus/Ogg delivery, two-pass loudness, MP4 H.264/HEVC with VideoToolbox on Apple Silicon, remux).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ presets: listPresets() }),
  },
  {
    name: 'probe',
    description: 'ffprobe summary of a media file: duration, container, audio/video codecs, sample rate, channels, resolution, tags.',
    inputSchema: { type: 'object', properties: { path: str('Media file path') }, required: ['path'] },
    handler: async ({ path: p }) => probe(CFG.ffprobe, path.resolve(p)),
  },
  {
    name: 'batch_convert',
    description: 'Convert many media files in the BACKGROUND. Returns a job_id immediately; follow with wait_job or job_status. Inputs may be files, folders or globs (e.g. "~/Samples/**/*.wav"). Use a preset (see list_presets) and/or custom ffmpeg output args. Outputs never overwrite inputs.',
    inputSchema: {
      type: 'object',
      properties: {
        inputs: { type: 'array', items: { type: 'string' }, description: 'Files, directories (walked recursively) or glob patterns' },
        preset: str('Preset name from list_presets'),
        ffmpeg_args: { type: 'array', items: { type: 'string' }, description: 'Extra/custom ffmpeg OUTPUT args, e.g. ["-af","highpass=f=80","-c:a","pcm_s24le"]. Required if no preset.' },
        output_ext: str('Output extension when not using a preset (e.g. "wav")'),
        output_dir: str('Directory for outputs (folder structure below the common input dir is kept). Default: next to each input'),
        suffix: str('Filename suffix, default "_<preset>" (or "_out")'),
        extensions: { type: 'array', items: { type: 'string' }, description: 'Only these extensions when walking folders (default: common audio/video)' },
        recursive: { type: 'boolean', description: 'Walk sub-folders (default true)' },
        overwrite: { type: 'boolean', description: 'Overwrite existing outputs (default false → numbered names)' },
        concurrency: { type: 'integer', minimum: 1, maximum: 32 },
        runner: str('local | docker | podman (default from settings)', { enum: ['local', 'docker', 'podman'] }),
        hwaccel: str('auto (VideoToolbox/AudioToolbox when present) | none', { enum: ['auto', 'none'] }),
        options: { type: 'object', description: 'Preset knobs: sample_rate, channels, audio_bitrate, video_bitrate, crf' },
        dry_run: { type: 'boolean', description: 'Only show the plan (files + first commands); do not start' },
      },
      required: ['inputs'],
    },
    handler: async (a) => {
      if (!a.preset && !a.ffmpeg_args) { throw new Error('Give a preset or ffmpeg_args'); }
      if (a.preset && !PRESETS[a.preset]) { throw new Error(`Unknown preset "${a.preset}". Available: ${Object.keys(PRESETS).join(', ')}`); }
      const files = expandInputs(a.inputs, { recursive: a.recursive, extensions: a.extensions });
      if (!files.length) { throw new Error(`No media files matched ${JSON.stringify(a.inputs)}`); }
      const ext = (a.preset ? PRESETS[a.preset].ext : a.output_ext || 'wav').replace(/^\./, '');
      const suffix = a.suffix ?? `_${a.preset || 'out'}`;
      const base = commonDir(files);
      const taken = new Set();
      const outputDir = a.output_dir || CFG.outputDir;
      const items = files.map(f => ({ type: 'convert', input: f, output: plannedOutput(f, base, { outputDir, suffix, ext, overwrite: a.overwrite, taken }), preset: a.preset, args: a.ffmpeg_args, hwaccel: a.hwaccel, opts: a.options, overwrite: !!a.overwrite }));
      const runner = a.runner || CFG.container.runner;
      if (a.dry_run) {
        return { plan: true, files: items.length, runner, outputDir: outputDir || '(next to inputs)', sample: items.slice(0, 5).map(i => ({ input: i.input, output: i.output })) };
      }
      const job = jobs.create('convert', `${a.preset || 'custom'} × ${items.length}`, items, { concurrency: a.concurrency, runner });
      return { job_id: job.id, files: items.length, runner, status: job.status, hint: 'Use wait_job (blocks up to 5 min) or job_status to follow progress.' };
    },
  },
  {
    name: 'run_ffmpeg',
    description: 'Run any ffmpeg command line in the BACKGROUND (dubbing mixes, stream capture/restream, long renders). Pass args WITHOUT the leading "ffmpeg". Refuses commands whose output path equals an input. Returns a job_id.',
    inputSchema: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' }, description: 'ffmpeg argv, e.g. ["-i","music.wav","-i","voice.wav","-filter_complex","…","-map","[out]","mix.wav"]' },
        title: str('Short description for the job list'),
        duration_s: { type: 'number', description: 'Expected output duration (for progress) — useful for stream captures with -t' },
        runner: str('local | docker | podman', { enum: ['local', 'docker', 'podman'] }),
        outputs: { type: 'array', items: { type: 'string' }, description: 'Output paths, if automatic detection would be ambiguous' },
        overwrite: { type: 'boolean', description: 'Allow replacing output files that already exist (default false)' },
      },
      required: ['args'],
    },
    handler: async (a) => {
      let args = a.args.map(String);
      if (args[0] === 'ffmpeg') { args = args.slice(1); }
      const an = analyzeArgs(args);
      const writes = a.outputs ? a.outputs.map(p => path.resolve(p)) : an.writes;
      const clash = writes.find(w => an.reads.includes(w));
      if (clash) { throw new Error(`Refusing to run: ${clash} is both an input and an output (ffmpeg would destroy it). Write to a new file.`); }
      // Existing outputs are checked by prepareOutputs (ffmpeg's own -n exits 0 without writing, which hides the problem).
      args = args.filter(a => a !== '-n' && a !== '-y');
      for (const flag of ['-y', '-nostdin', '-hide_banner']) { args.unshift(flag); }
      let duration = a.duration_s;
      if (!duration && an.reads[0]) { try { duration = (await probe(CFG.ffprobe, an.reads[0])).duration; } catch { /* stream or lavfi */ } }
      const tIdx = args.lastIndexOf('-t');
      if (tIdx >= 0 && !a.duration_s) { duration = parseFloat(args[tIdx + 1]) || duration; }
      const runner = a.runner || CFG.container.runner;
      if (runner !== 'local' && an.remote.length === 0 && an.reads.length === 0) { /* lavfi-only is fine */ }
      const job = jobs.create('ffmpeg', a.title || `ffmpeg → ${writes.map(w => path.basename(w)).join(', ') || 'stream'}`, [{ type: 'ffmpeg', args, reads: an.reads, writes, duration, output: writes[0], overwrite: !!a.overwrite }], { runner });
      return { job_id: job.id, outputs: writes, inputs: [...an.reads, ...an.remote], runner };
    },
  },
  {
    name: 'transcribe',
    description: 'Transcribe audio/video files to SRT/VTT/TXT/JSON in the BACKGROUND. Backends: mlx-service (MLX audio server — native Apple GPU, or a CPU docker/podman/Apple container with mlx[cpu]), mlx (mlx_whisper CLI), whisper.cpp, openai, ffmpeg (8+). "auto" prefers the MLX service.',
    inputSchema: {
      type: 'object',
      properties: {
        inputs: { type: 'array', items: { type: 'string' }, description: 'Files, folders or globs' },
        backend: str('auto | mlx-service | mlx | whisper.cpp | openai | ffmpeg', { enum: ['auto', 'mlx-service', 'mlx', 'whisper.cpp', 'openai', 'ffmpeg'] }),
        model: str('Model id, e.g. mlx-community/whisper-large-v3-turbo (MLX) — default from settings'),
        language: str('Language code or "auto"'),
        translate: { type: 'boolean', description: 'Translate to English (mlx, whisper.cpp, openai)' },
        prompt: str('Initial prompt: names, jargon, spelling hints'),
        formats: { type: 'array', items: { type: 'string', enum: ['srt', 'vtt', 'txt', 'json'] }, description: 'Default ["srt","txt","json"]' },
        output_dir: str('Where transcripts go (default: next to each input)'),
        concurrency: { type: 'integer', minimum: 1, maximum: 8 },
      },
      required: ['inputs'],
    },
    handler: async (a) => {
      const files = expandInputs(a.inputs, {});
      if (!files.length) { throw new Error(`No media files matched ${JSON.stringify(a.inputs)}`); }
      const formats = a.formats?.length ? a.formats : ['srt', 'txt', 'json'];
      const base = commonDir(files);
      const items = files.map(f => {
        const dir = a.output_dir ? path.join(path.resolve(a.output_dir), path.relative(base, path.dirname(f))) : path.dirname(f);
        const outputs = Object.fromEntries(formats.map(fmt => [fmt, path.join(dir, `${path.parse(f).name}.${fmt}`)]));
        return {
          type: 'transcribe', input: f, outputs, output: outputs[formats[0]],
          stt: { backend: a.backend || CFG.stt.backend, language: a.language || 'auto', translate: !!a.translate, prompt: a.prompt || '', ...(a.model ? { mlxModel: a.model } : {}) },
        };
      });
      const job = jobs.create('transcribe', `transcribe × ${items.length}`, items, { concurrency: a.concurrency || 1 });
      return { job_id: job.id, files: items.length, formats, backend: a.backend || CFG.stt.backend };
    },
  },
  {
    name: 'synthesize_speech',
    description: 'Text-to-speech through the MLX audio service (e.g. Kokoro, Dia, CSM, Spark…). Use for voice-overs, dubbing scratch tracks, announcer tags. Runs in the background; returns a job_id. Output format follows the file extension (wav, mp3, flac, ogg, opus).',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('Text to speak'),
        output: str('Output audio path, e.g. ./vo/intro.wav'),
        voice: str('Voice preset (Kokoro: af_heart, af_bella, am_adam, bf_emma, bm_george, …)'),
        model: str('TTS model id (default from settings, e.g. mlx-community/Kokoro-82M-bf16)'),
        speed: { type: 'number', minimum: 0.5, maximum: 2 },
        lang_code: str('Kokoro language code: a (US English), b (UK), e (es), f (fr), h (hi), i (it), j (ja), p (pt-br), z (zh)'),
        instruct: str('Style instruction for models that support it'),
      },
      required: ['text', 'output'],
    },
    handler: async (a) => {
      const out = uniquePath(path.resolve(a.output), false);
      const job = jobs.create('tts', `speech → ${path.basename(out)}`, [{ type: 'tts', ...a, output: out }]);
      return { job_id: job.id, output: out };
    },
  },
  {
    name: 'separate_audio',
    description: 'Source separation through the MLX audio service: split a mix into the described source ("speech", "vocals", "drums", "dialogue"…) and the residual (everything else). Ideal for dubbing: keep the music & effects bed, drop the original dialogue. Background job.',
    inputSchema: {
      type: 'object',
      properties: {
        input: str('Audio/video file'),
        description: str('What to extract, default "speech"'),
        model: str('Separation model id (server default: mlx-community/sam-audio-large-fp16)'),
        output_dir: str('Default: next to the input'),
      },
      required: ['input'],
    },
    handler: async (a) => {
      const input = path.resolve(a.input);
      const dir = a.output_dir ? path.resolve(a.output_dir) : path.dirname(input);
      const name = path.parse(input).name;
      const label = (a.description || 'speech').replace(/[^\w-]+/g, '-');
      const target = uniquePath(path.join(dir, `${name}_${label}.wav`)), residual = uniquePath(path.join(dir, `${name}_no-${label}.wav`));
      const job = jobs.create('separate', `separate ${label} from ${path.basename(input)}`, [{ type: 'separate', input, target, residual, output: target, description: a.description, model: a.model }]);
      return { job_id: job.id, target, residual };
    },
  },
  {
    name: 'mlx_service',
    description: 'Manage the MLX audio inference service (mlx-audio server: STT, TTS, separation). Modes: native (host Python, Apple GPU/Metal), docker | podman (Linux image, mlx[cpu]), apple-container (Apple `container` CLI, CPU), external (already running at url). Actions: status, start, stop, logs, plan, models.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('status | start | stop | logs | plan | models', { enum: ['status', 'start', 'stop', 'logs', 'plan', 'models'] }),
        mode: str('Override the configured mode for this call', { enum: ['native', 'docker', 'podman', 'apple-container', 'external'] }),
        load_model: str('With action "models": load this model id into the server'),
      },
      required: ['action'],
    },
    handler: async ({ action, mode, load_model }) => {
      const m = mode || CFG.mlx.mode;
      switch (action) {
        case 'status': return { mode: m, image: m === 'native' || m === 'external' ? null : CFG.mlx.image, ...(await mlx.health()) };
        case 'plan': { const p = mlx.plan(m); return { mode: m, command: p ? [p.cmd, ...p.args].join(' ') : '(external — nothing to start)', url: mlx.url }; }
        case 'start': return mlx.start({ mode: m });
        case 'stop': return mlx.stop(m);
        case 'logs': return { mode: m, logs: mlx.logs(m) };
        case 'models': {
          if (load_model) {
            const r = await mlx.request(`/v1/models?model_name=${encodeURIComponent(load_model)}`, { method: 'POST' }, 1800000);
            return { loaded: load_model, status: r.status, body: (await r.text()).slice(0, 500) };
          }
          return mlx.health();
        }
        default: throw new Error(`Unknown action ${action}`);
      }
    },
  },
  {
    name: 'job_status',
    description: 'Status of a background job: overall progress, per-item status/progress, outputs, errors (and recent ffmpeg log lines with include_log).',
    inputSchema: { type: 'object', properties: { job_id: str('Job id'), include_log: { type: 'boolean' } }, required: ['job_id'] },
    handler: async ({ job_id, include_log }) => jobs.detail(job_id, { includeLog: include_log }),
  },
  {
    name: 'wait_job',
    description: 'Block until a job finishes or the timeout passes (max 300 s), then return its status. Prefer this over polling job_status.',
    inputSchema: { type: 'object', properties: { job_id: str('Job id'), timeout_s: { type: 'number', minimum: 1, maximum: 300 } }, required: ['job_id'] },
    handler: async ({ job_id, timeout_s }) => jobs.wait(job_id, Math.min(300, timeout_s || 120) * 1000),
  },
  {
    name: 'list_jobs',
    description: 'Recent background jobs (newest first), including ones from earlier sessions.',
    inputSchema: { type: 'object', properties: { status: str('Filter', { enum: ['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted'] }), limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    handler: async (a) => ({ jobs: jobs.list(a) }),
  },
  {
    name: 'cancel_job',
    description: 'Cancel a job: queued items are dropped, running ffmpeg processes are stopped (gracefully, then killed).',
    inputSchema: { type: 'object', properties: { job_id: str('Job id') }, required: ['job_id'] },
    handler: async ({ job_id }) => jobs.cancel(job_id),
  },
  {
    name: 'resume_job',
    description: 'Re-queue the failed, cancelled or interrupted items of a job.',
    inputSchema: { type: 'object', properties: { job_id: str('Job id') }, required: ['job_id'] },
    handler: async ({ job_id }) => jobs.resume(job_id),
  },
];
const TOOL_MAP = new Map(TOOLS.map(t => [t.name, t]));

// ------------------------------------------------------------------ JSON-RPC over stdio
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === undefined) { return; } // a response to us — we never send requests
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'sound-lab-media', version: VERSION },
          instructions: 'Long ffmpeg/transcription/TTS work runs as background jobs: start it (batch_convert, run_ffmpeg, transcribe, synthesize_speech, separate_audio), then wait_job. Call capabilities first on a new machine.',
        });
      case 'notifications/initialized': case 'notifications/cancelled': return;
      case 'ping': return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const tool = TOOL_MAP.get(params?.name);
        if (!tool) { return fail(id, -32602, `Unknown tool: ${params?.name}`); }
        try {
          const result = await tool.handler(params.arguments || {});
          return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        } catch (e) {
          return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
      }
      default:
        if (!isNotification) { fail(id, -32601, `Method not found: ${method}`); }
    }
  } catch (e) {
    if (!isNotification) { fail(id, -32603, e.message); }
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) { return; }
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
  if (Array.isArray(msg)) { msg.forEach(m => handle(m)); } else { handle(msg); }
});
let stopping = false;
const shutdown = () => {
  if (stopping) { return; } stopping = true;
  jobs.shutdown(); // marks active work interrupted, sends 'q' to ffmpeg so files are finalised
  const t0 = Date.now();
  const tick = () => (jobs.running === 0 || Date.now() - t0 > 4000 ? process.exit(0) : setTimeout(tick, 100));
  tick();
};
rl.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
log(`ready (data ${CFG.dataDir}, runner ${CFG.container.runner}, mlx ${CFG.mlx.mode})`);
