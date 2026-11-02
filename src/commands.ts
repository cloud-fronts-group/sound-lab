import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RunOptions, run, runOk, parseTimecode, formatTimecode } from './core/ffmpeg';
import * as R from './core/recipes';
import { Format, FORMATS, LOSSLESS, EncodeOptions } from './core/recipes';
import { analyzeLevels, parseLoudnormJson, parseSilence, parseVolumedetect, soundSegments, Interval, LevelReport } from './core/analysis';
import { probe, probeMarkdown, summarize, AudioSummary } from './core/probe';
import { Segment, Transcript, render, parseCues } from './core/subtitles';
import { transcribe as runTranscribe, Backend, TranscribeConfig } from './core/transcribe';
import {
  AUDIO_EXT, MEDIA_EXT, announce, askNumber, cfg, defaultEncode, job, log, logLine, openMedia, outputDir, outputFor,
  refreshCapabilities, resolveTargets, sameFormatEncode, state, storageDir, summaryOf, tools, uniquePath, Reporter,
} from './util';

export const onTranscribed = new vscode.EventEmitter<{ file: string; segments: Segment[] }>();
const SECRET_KEY = 'soundLab.transcription.apiKey';

type Range = { start?: number; end?: number };

/** Run ffmpeg with logging + progress mapped into [from, to] of the overall job. */
function ff(args: string[], duration: number, report: Reporter, signal: AbortSignal, msg: string, from = 0, to = 1, extra: Partial<RunOptions> = {}) {
  log(`$ ffmpeg ${args.map(a => (/[\s"'|;&]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  return runOk({
    exe: tools().ffmpeg, args, durationSec: duration, signal, onLog: logLine,
    onProgress: f => report(from + (to - from) * f, msg), ...extra,
  });
}

function rangeArg(arg: unknown, args: unknown): Range {
  for (const a of [args, arg]) {
    if (a && typeof a === 'object' && !Array.isArray(a) && ('start' in a || 'end' in a)) { return a as Range; }
  }
  return {};
}

// ---------------------------------------------------------------- pickers

async function pickFormat(placeholder = 'Output format', current?: Format): Promise<Format | undefined> {
  const desc: Record<Format, string> = {
    wav: 'PCM, uncompressed — best for samplers & DAWs', flac: 'Lossless compressed', aiff: 'PCM big-endian (Apple / Logic)',
    mp3: 'Lossy, universal', ogg: 'Ogg Vorbis, lossy (game engines)', opus: 'Opus, lossy, excellent at low bitrates', m4a: 'AAC in MP4, lossy (Apple)',
  };
  const items = FORMATS.map(f => ({ label: f.toUpperCase(), description: desc[f], f, picked: f === current }));
  const p = await vscode.window.showQuickPick(items, { placeHolder: placeholder });
  return p?.f;
}

async function pickEncode(src: AudioSummary | undefined, many: boolean): Promise<EncodeOptions | undefined> {
  const format = await pickFormat('Convert to…', (cfg().get<string>('defaults.format') as Format));
  if (!format) { return undefined; }
  const enc = defaultEncode(src, format);
  if (LOSSLESS.includes(format)) {
    const bd = await vscode.window.showQuickPick(
      [{ label: '24-bit', v: 24 }, { label: '16-bit', v: 16, description: 'CD quality / most hardware samplers' }, { label: format === 'flac' ? '24-bit (FLAC max)' : '32-bit float', v: format === 'flac' ? 24 : 32 }]
        .map(i => ({ ...i, picked: i.v === enc.bitDepth })),
      { placeHolder: 'Bit depth' });
    if (!bd) { return undefined; }
    enc.bitDepth = bd.v as 16 | 24 | 32;
  } else {
    const br = await vscode.window.showQuickPick(['320k', '256k', '192k', '160k', '128k', '96k', '64k'], { placeHolder: 'Bitrate' });
    if (!br) { return undefined; }
    enc.bitrate = br;
  }
  const keep = src?.sampleRate ? `Keep (${src.sampleRate} Hz)` : 'Keep source rate';
  const sr = await vscode.window.showQuickPick([keep, '44100', '48000', '88200', '96000', '32000', '22050', '16000'], { placeHolder: many ? 'Sample rate (all files)' : 'Sample rate' });
  if (!sr) { return undefined; }
  enc.sampleRate = sr.startsWith('Keep') ? undefined : +sr;
  const ch = await vscode.window.showQuickPick(['Keep channels', 'Mono', 'Stereo'], { placeHolder: 'Channels' });
  if (!ch) { return undefined; }
  enc.channels = ch === 'Mono' ? 1 : ch === 'Stereo' ? 2 : undefined;
  return enc;
}

// ---------------------------------------------------------------- info

export async function cmdProbe(arg?: unknown, args?: unknown): Promise<void> {
  const [uri] = await resolveTargets(arg, args);
  if (!uri) { return; }
  const p = await job('Reading media info', async () => probe(tools().ffprobe, uri.fsPath));
  if (!p) { return; }
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: probeMarkdown(uri.fsPath, p) });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  vscode.commands.executeCommand('markdown.showPreview', doc.uri).then(undefined, () => undefined);
}

export function levelsMarkdown(file: string, r: LevelReport): string {
  const f = (v?: number, u = '') => (v === undefined || isNaN(v) ? '—' : !isFinite(v) ? '-∞' + u : `${v.toFixed(1)}${u}`);
  const lines = [
    `# Levels — ${path.basename(file)}`, '',
    '| Measure | Value |', '|---|---|',
    `| Integrated loudness | ${f(r.integratedLufs, ' LUFS')} |`,
    `| True peak | ${f(r.truePeakDbtp, ' dBTP')} |`,
    `| Loudness range | ${f(r.lra, ' LU')} |`,
    `| Mean volume | ${f(r.meanVolumeDb, ' dB')} |`,
    `| Max volume | ${f(r.maxVolumeDb, ' dB')} |`,
  ];
  const keys = ['Peak level dB', 'RMS level dB', 'RMS peak dB', 'RMS trough dB', 'Crest factor', 'Dynamic range', 'DC offset', 'Zero crossings rate', 'Noise floor dB', 'Bit depth', 'Number of samples'];
  for (const k of keys) { if (r.stats[k]) { lines.push(`| ${k} | ${r.stats[k]} |`); } }
  lines.push('', '### Streaming targets', '', '| Platform | Target | Gain needed |', '|---|---|---|');
  for (const [name, t] of [['Spotify / YouTube / Tidal', -14], ['Apple Music', -16], ['Podcasts (Apple)', -16], ['EBU R128 broadcast', -23], ['ATSC A/85 (US TV)', -24]] as [string, number][]) {
    lines.push(`| ${name} | ${t} LUFS | ${r.integratedLufs !== undefined && isFinite(r.integratedLufs) ? (t - r.integratedLufs >= 0 ? '+' : '') + (t - r.integratedLufs).toFixed(1) + ' dB' : '—'} |`);
  }
  return lines.join('\n');
}

export async function cmdAnalyze(arg?: unknown, args?: unknown, opts: { silent?: boolean } = {}): Promise<LevelReport | undefined> {
  const [uri] = await resolveTargets(arg, args);
  if (!uri) { return; }
  const report = await job(`Analyzing ${path.basename(uri.fsPath)}`, async (rep, signal) => {
    const s = await summaryOf(uri.fsPath);
    return analyzeLevels(tools().ffmpeg, uri.fsPath, s.duration, f => rep(f, 'Measuring loudness…'), signal);
  });
  if (report && !opts.silent) {
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: levelsMarkdown(uri.fsPath, report) });
    await vscode.commands.executeCommand('markdown.showPreviewToSide', doc.uri).then(undefined, () => vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside));
  }
  return report;
}

export async function cmdShowCapabilities(): Promise<void> {
  const caps = await refreshCapabilities();
  const t = tools();
  const has = (f: string) => (caps.filters.has(f) ? '✅' : '❌');
  const enc = (e: string) => (caps.encoders.has(e) ? '✅' : '❌');
  const lines = [
    '# Sound Lab — FFmpeg capabilities', '',
    `- **ffmpeg**: \`${t.ffmpeg}\` — ${caps.ffmpegVersion ?? 'not found'}`,
    `- **ffprobe**: \`${t.ffprobe}\` — ${caps.ffprobeVersion ?? 'not found'}`,
    caps.error ? `- **Error**: ${caps.error}` : '', '',
    '## Filters used by Sound Lab', '', '| Filter | Purpose | Available |', '|---|---|---|',
    ...([
      ['loudnorm', 'EBU R128 loudness normalization'], ['silencedetect', 'Split on silence'], ['astats', 'Level statistics'],
      ['volumedetect', 'Peak / mean volume'], ['showspectrumpic', 'Spectrogram images'], ['showwavespic', 'Waveform images'],
      ['afftdn', 'Denoise'], ['acompressor', 'Compressor'], ['alimiter', 'Limiter'], ['acrusher', 'Bitcrusher'],
      ['rubberband', 'High-quality pitch/time (optional)'], ['whisper', 'Built-in speech-to-text (FFmpeg 8+)'],
    ] as [string, string][]).map(([f, d]) => `| \`${f}\` | ${d} | ${has(f)} |`),
    '', '## Encoders', '', '| Encoder | Format | Available |', '|---|---|---|',
    ...([['pcm_s24le', 'WAV'], ['flac', 'FLAC'], ['libmp3lame', 'MP3'], ['libvorbis', 'Ogg Vorbis'], ['libopus', 'Opus'], ['aac', 'AAC / M4A']] as [string, string][])
      .map(([e, d]) => `| \`${e}\` | ${d} | ${enc(e)} |`),
    '', `Total: ${caps.filters.size} filters, ${caps.encoders.size} encoders.`,
  ];
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.filter(l => l !== undefined).join('\n') });
  await vscode.commands.executeCommand('markdown.showPreview', doc.uri).then(undefined, () => vscode.window.showTextDocument(doc));
}

// ---------------------------------------------------------------- conversion & editing

export async function cmdConvert(arg?: unknown, args?: unknown): Promise<void> {
  const uris = await resolveTargets(arg, args, { many: true, title: 'Convert' });
  if (!uris.length) { return; }
  const first = await summaryOf(uris[0].fsPath).catch(() => undefined);
  const enc = await pickEncode(first, uris.length > 1);
  if (!enc) { return; }
  const created: string[] = [];
  await job(`Converting ${uris.length} file(s) to ${enc.format.toUpperCase()}`, async (rep, signal) => {
    for (let i = 0; i < uris.length; i++) {
      const src = uris[i].fsPath;
      const s = await summaryOf(src);
      const out = outputFor(src, path.extname(src).slice(1).toLowerCase() === enc.format ? 'converted' : '', enc.format);
      await ff(R.convert(src, out, enc), s.duration, rep, signal, `${path.basename(src)} (${i + 1}/${uris.length})`, i / uris.length, (i + 1) / uris.length);
      created.push(out);
    }
  });
  await announce(created);
}

function walk(dir: string, exts: string[], out: string[] = [], depth = 0): string[] {
  if (depth > 12) { return out; }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') { continue; }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, exts, out, depth + 1); }
    else if (exts.includes(path.extname(e.name).slice(1).toLowerCase())) { out.push(p); }
  }
  return out;
}

export async function cmdBatchConvert(arg?: unknown): Promise<void> {
  let folder = arg instanceof vscode.Uri && fs.existsSync(arg.fsPath) && fs.statSync(arg.fsPath).isDirectory() ? arg.fsPath : undefined;
  if (!folder) {
    const p = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Batch convert this folder' });
    folder = p?.[0]?.fsPath;
  }
  if (!folder) { return; }
  const files = walk(folder, AUDIO_EXT);
  if (!files.length) { vscode.window.showWarningMessage('No audio files found in that folder.'); return; }
  const enc = await pickEncode(undefined, true);
  if (!enc) { return; }
  const dest = path.join(folder, `converted_${enc.format}`);
  const go = await vscode.window.showInformationMessage(`Convert ${files.length} files to ${enc.format.toUpperCase()} into ${path.basename(dest)}/ ?`, { modal: true }, 'Convert');
  if (go !== 'Convert') { return; }
  const created: string[] = [];
  const failed: string[] = [];
  await job(`Batch converting ${files.length} files`, async (rep, signal) => {
    for (let i = 0; i < files.length; i++) {
      if (signal.aborted) { break; }
      const src = files[i];
      if (src.startsWith(dest + path.sep)) { continue; }
      const rel = path.relative(folder!, src);
      const out = path.join(dest, rel.replace(/\.[^.]+$/, `.${enc.format}`));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      try {
        const s = await summaryOf(src);
        await ff(R.convert(src, out, enc), s.duration, rep, signal, `${rel} (${i + 1}/${files.length})`, i / files.length, (i + 1) / files.length);
        created.push(out);
      } catch (e) {
        if (signal.aborted) { throw e; }
        failed.push(rel); log(`  skipped ${rel}: ${(e as Error).message}`);
      }
    }
  });
  if (failed.length) { vscode.window.showWarningMessage(`${failed.length} file(s) failed — see the Sound Lab log.`, 'Show Log').then(p => p && state.output.show()); }
  await announce(created, 'Converted');
}

export async function cmdTrim(arg?: unknown, args?: unknown): Promise<string | undefined> {
  const [uri] = await resolveTargets(arg, args);
  if (!uri) { return; }
  const src = uri.fsPath;
  const s = await summaryOf(src);
  const range = rangeArg(arg, args);
  let start = range.start, end = range.end;
  if (start === undefined || end === undefined) {
    const a = await vscode.window.showInputBox({ prompt: `Start time (seconds or m:ss.ms) — length ${formatTimecode(s.duration)}`, value: '0:00.000', validateInput: v => isNaN(parseTimecode(v)) ? 'Invalid time' : undefined });
    if (a === undefined) { return; }
    const b = await vscode.window.showInputBox({ prompt: 'End time', value: formatTimecode(s.duration), validateInput: v => isNaN(parseTimecode(v)) ? 'Invalid time' : parseTimecode(v) <= parseTimecode(a) ? 'End must be after start' : undefined });
    if (b === undefined) { return; }
    start = parseTimecode(a); end = parseTimecode(b);
  }
  const fades = await vscode.window.showInputBox({ prompt: 'Fade in, fade out (seconds). Tiny fades avoid clicks at the cut points.', value: '0.005, 0.010' });
  if (fades === undefined) { return; }
  const [fi, fo] = fades.split(/[,\s]+/).map(Number);
  const enc = sameFormatEncode(src, s);
  const out = outputFor(src, `${formatTimecode(start, false).replace(/:/g, '.')}-${formatTimecode(end, false).replace(/:/g, '.')}`, enc.format);
  const ok = await job(`Cutting ${path.basename(src)}`, (rep, signal) =>
    ff(R.trim(src, out, { ...enc, start: start!, end: end!, fadeIn: fi || 0, fadeOut: fo || 0 }), end! - start!, rep, signal, 'Cutting…'));
  if (ok) { await announce([out]); return out; }
  return undefined;
}

export async function cmdNormalize(arg?: unknown, args?: unknown): Promise<void> {
  const uris = await resolveTargets(arg, args, { many: true, title: 'Normalize' });
  if (!uris.length) { return; }
  const c = cfg();
  const def = c.get<number>('normalize.targetLufs') ?? -14;
  const mode = await vscode.window.showQuickPick([
    { label: `$(pulse) Loudness ${def} LUFS`, description: 'EBU R128 two-pass (settings default)', lufs: def },
    { label: '$(pulse) Loudness -14 LUFS', description: 'Spotify, YouTube, Tidal', lufs: -14 },
    { label: '$(pulse) Loudness -16 LUFS', description: 'Apple Music, podcasts', lufs: -16 },
    { label: '$(pulse) Loudness -23 LUFS', description: 'EBU R128 broadcast', lufs: -23 },
    { label: '$(arrow-up) Peak -0.1 dBFS', description: 'Sample peak normalization (samples, one-shots)', peak: -0.1 },
    { label: '$(arrow-up) Peak -1.0 dBFS', description: 'Sample peak normalization with headroom', peak: -1 },
  ], { placeHolder: 'Normalization target' });
  if (!mode) { return; }
  const created: string[] = [];
  await job(`Normalizing ${uris.length} file(s)`, async (rep, signal) => {
    for (let i = 0; i < uris.length; i++) {
      const src = uris[i].fsPath;
      const s = await summaryOf(src);
      const enc = sameFormatEncode(src, s);
      const lo = i / uris.length, hi = (i + 1) / uris.length, mid = (lo + hi) / 2;
      const name = path.basename(src);
      if ('peak' in mode && mode.peak !== undefined) {
        const a = await ff(['-hide_banner', '-nostdin', '-i', src, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], s.duration, rep, signal, `Measuring ${name}`, lo, mid);
        const max = parseVolumedetect(a.stderr).max ?? 0;
        const out = outputFor(src, `peak${mode.peak}`, enc.format);
        await ff(R.applyFilter(src, out, R.peakNormalizeFilter(max, mode.peak), enc), s.duration, rep, signal, `Applying ${(mode.peak - max).toFixed(1)} dB to ${name}`, mid, hi);
        created.push(out);
      } else {
        const t = { i: mode.lufs!, tp: c.get<number>('normalize.truePeak') ?? -1, lra: c.get<number>('normalize.lra') ?? 11 };
        const a = await ff(R.loudnormAnalyze(src, t), s.duration, rep, signal, `Pass 1 — measuring ${name}`, lo, mid);
        const m = parseLoudnormJson(a.stderr);
        log(`  measured: I=${m.input_i} LUFS, TP=${m.input_tp} dBTP, LRA=${m.input_lra} LU`);
        const out = outputFor(src, `${t.i}LUFS`, enc.format);
        await ff(R.loudnormApply(src, out, t, m, enc, s.sampleRate), s.duration, rep, signal, `Pass 2 — normalizing ${name}`, mid, hi);
        created.push(out);
      }
    }
  });
  await announce(created, 'Normalized');
}

const COPY_EXT: Record<string, string> = { aac: 'm4a', mp3: 'mp3', opus: 'opus', vorbis: 'ogg', flac: 'flac', ac3: 'ac3', eac3: 'eac3', alac: 'm4a' };

export async function cmdExtractAudio(arg?: unknown, args?: unknown): Promise<void> {
  const uris = await resolveTargets(arg, args, { many: true, video: true, title: 'Extract audio' });
  if (!uris.length) { return; }
  const choice = await vscode.window.showQuickPick([
    { label: '$(files) Copy original audio stream', description: 'No re-encode, instant, lossless', copy: true },
    ...FORMATS.map(f => ({ label: `$(arrow-swap) Encode to ${f.toUpperCase()}`, description: '', copy: false, f })),
  ], { placeHolder: 'How should the audio be extracted?' });
  if (!choice) { return; }
  const created: string[] = [];
  await job(`Extracting audio from ${uris.length} file(s)`, async (rep, signal) => {
    for (let i = 0; i < uris.length; i++) {
      const src = uris[i].fsPath;
      const p = await probe(tools().ffprobe, src);
      const s = summarize(p);
      if (s.codec === 'none') { log(`  ${path.basename(src)} has no audio stream`); continue; }
      let out: string; let enc: EncodeOptions | 'copy';
      if (choice.copy) {
        enc = 'copy';
        const ext = s.codec.startsWith('pcm_') ? 'wav' : COPY_EXT[s.codec] ?? 'mka';
        out = outputFor(src, 'audio', ext);
      } else {
        enc = defaultEncode(s, (choice as { f: Format }).f);
        out = outputFor(src, 'audio', enc.format);
      }
      await ff(R.extractAudio(src, out, enc), s.duration, rep, signal, path.basename(src), i / uris.length, (i + 1) / uris.length);
      created.push(out);
    }
  });
  await announce(created, 'Extracted');
}

export async function cmdSliceEqual(arg?: unknown, args?: unknown): Promise<void> {
  const [uri] = await resolveTargets(arg, args);
  if (!uri) { return; }
  const src = uri.fsPath;
  const s = await summaryOf(src);
  const mode = await vscode.window.showQuickPick([
    { label: 'By tempo (BPM + beats per slice)', id: 'bpm' },
    { label: 'By seconds', id: 'sec' },
    { label: 'Into N equal parts', id: 'n' },
  ], { placeHolder: `Slice ${path.basename(src)} (${formatTimecode(s.duration)})` });
  if (!mode) { return; }
  let seconds: number | undefined;
  if (mode.id === 'bpm') {
    const bpm = await askNumber('Tempo (BPM)', 120, n => (n <= 0 ? 'Must be positive' : undefined));
    if (bpm === undefined) { return; }
    const beats = await askNumber('Beats per slice (1 = quarter notes, 0.5 = eighths, 4 = one bar of 4/4)', 1, n => (n <= 0 ? 'Must be positive' : undefined));
    if (beats === undefined) { return; }
    seconds = (60 / bpm) * beats;
  } else if (mode.id === 'sec') {
    seconds = await askNumber('Slice length in seconds', 1, n => (n <= 0 ? 'Must be positive' : undefined));
  } else {
    const n = await askNumber('Number of slices', 16, v => (v < 1 || !Number.isInteger(v) ? 'Whole number ≥ 1' : undefined));
    if (n !== undefined) { seconds = s.duration / n + 1e-6; }
  }
  if (!seconds) { return; }
  const sr = s.sampleRate || 48000;
  const total = Math.round(s.duration * sr);
  const points = mode.id === 'n'
    ? Array.from({ length: Math.round(s.duration / seconds) - 1 }, (_, i) => Math.round(((i + 1) * total) / Math.round(s.duration / seconds)))
    : R.slicePoints(total, seconds * sr);
  if (points.length + 1 > 2000) { vscode.window.showWarningMessage(`That would create ${points.length + 1} slices — pick a longer slice length.`); return; }
  const enc = sameFormatEncode(src, s);
  const name = path.parse(src).name;
  const dir = uniquePath(path.join(outputDir(src), `${name}_slices`));
  fs.mkdirSync(dir, { recursive: true });
  const outputs = Array.from({ length: points.length + 1 }, (_, i) => path.join(dir, `${name}_${String(i + 1).padStart(3, '0')}.${enc.format}`));
  const ok = await job(`Slicing into ${outputs.length} pieces`, (rep, signal) =>
    ff(R.sliceAt(src, outputs, points, enc), s.duration, rep, signal, 'Slicing…'));
  if (ok) { await announce(outputs, 'Sliced into'); }
}

export async function detectSilence(src: string, duration: number, rep: Reporter, signal: AbortSignal, from = 0, to = 1): Promise<{ silences: Interval[]; segments: Interval[] }> {
  const c = cfg();
  const a = await ff(R.silenceDetect(src, c.get<number>('silence.thresholdDb') ?? -40, c.get<number>('silence.minDuration') ?? 0.35), duration, rep, signal, 'Detecting silence…', from, to);
  const silences = parseSilence(a.stderr, duration);
  const segments = soundSegments(silences, duration, c.get<number>('silence.padding') ?? 0.03, c.get<number>('silence.minSegment') ?? 0.08);
  return { silences, segments };
}

export async function cmdSplitOnSilence(arg?: unknown, args?: unknown): Promise<void> {
  const uris = await resolveTargets(arg, args, { many: true, title: 'Split on silence' });
  if (!uris.length) { return; }
  const c = cfg();
  const th = await askNumber('Silence threshold (dBFS). Raise (e.g. -30) for noisy recordings.', c.get<number>('silence.thresholdDb') ?? -40, n => (n > 0 ? 'Must be ≤ 0' : undefined));
  if (th === undefined) { return; }
  const md = await askNumber('Minimum silence length that separates samples (seconds)', c.get<number>('silence.minDuration') ?? 0.35, n => (n <= 0 ? 'Must be positive' : undefined));
  if (md === undefined) { return; }
  await c.update('silence.thresholdDb', th, vscode.ConfigurationTarget.Global);
  await c.update('silence.minDuration', md, vscode.ConfigurationTarget.Global);
  const created: string[] = [];
  await job('Splitting on silence', async (rep, signal) => {
    for (let fi = 0; fi < uris.length; fi++) {
      const src = uris[fi].fsPath;
      const s = await summaryOf(src);
      const lo = fi / uris.length, span = 1 / uris.length;
      const { segments } = await detectSilence(src, s.duration, rep, signal, lo, lo + span * 0.3);
      if (!segments.length) { log(`  no sound segments found in ${path.basename(src)}`); continue; }
      const enc = sameFormatEncode(src, s);
      const name = path.parse(src).name;
      const dir = uniquePath(path.join(outputDir(src), `${name}_split`));
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const out = path.join(dir, `${name}_${String(i + 1).padStart(3, '0')}.${enc.format}`);
        await ff(R.trim(src, out, { ...enc, ...seg, fadeIn: 0.002, fadeOut: 0.005 }), seg.end - seg.start, rep, signal,
          `${path.basename(src)}: segment ${i + 1}/${segments.length}`, lo + span * (0.3 + 0.7 * i / segments.length), lo + span * (0.3 + 0.7 * (i + 1) / segments.length));
        created.push(out);
      }
    }
  });
  await announce(created, 'Split into');
}

export async function cmdApplyEffects(arg?: unknown, args?: unknown): Promise<void> {
  const uris = await resolveTargets(arg, args, { many: true, title: 'Apply effects' });
  if (!uris.length) { return; }
  const picks = await vscode.window.showQuickPick(
    R.EFFECTS.map(e => ({ label: e.label, description: e.detail, e })),
    { canPickMany: true, placeHolder: 'Pick effects (applied top-to-bottom in this list order)', matchOnDescription: true });
  if (!picks?.length) { return; }
  const params: Record<string, string>[] = [];
  for (const p of picks) {
    const values: Record<string, string> = {};
    for (const prm of p.e.params) {
      const v = await vscode.window.showInputBox({ prompt: `${p.e.label}: ${prm.label}`, value: String(prm.default) });
      if (v === undefined) { return; }
      values[prm.key] = v;
    }
    params.push(values);
  }
  const suffix = picks.length === 1 ? picks[0].e.id : 'fx';
  const created: string[] = [];
  await job(`Applying ${picks.map(p => p.e.label).join(' → ')}`, async (rep, signal) => {
    for (let i = 0; i < uris.length; i++) {
      const src = uris[i].fsPath;
      const s = await summaryOf(src);
      const chain = picks.map((p, k) => p.e.build(params[k], { sampleRate: s.sampleRate || 48000 })).filter(Boolean).join(',');
      log(`  filter chain: ${chain}`);
      const enc = sameFormatEncode(src, s);
      const out = outputFor(src, suffix, enc.format);
      await ff(R.applyFilter(src, out, chain, enc), s.duration, rep, signal, path.basename(src), i / uris.length, (i + 1) / uris.length);
      created.push(out);
    }
  });
  await announce(created);
}

export async function cmdConcat(arg?: unknown, args?: unknown): Promise<void> {
  let uris = await resolveTargets(arg, args, { many: true, title: 'Concatenate' });
  if (uris.length === 1) {
    const more = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Append these', filters: { Audio: AUDIO_EXT } });
    if (!more) { return; }
    uris = [...uris, ...more];
  }
  if (uris.length < 2) { return; }
  const order = await vscode.window.showQuickPick(
    [{ label: 'As listed', o: uris }, { label: 'Sorted by file name', o: [...uris].sort((a, b) => a.fsPath.localeCompare(b.fsPath, undefined, { numeric: true })) }],
    { placeHolder: uris.map(u => path.basename(u.fsPath)).join(' + ') });
  if (!order) { return; }
  const xf = await askNumber('Crossfade between files (seconds, 0 = butt splice)', 0, n => (n < 0 ? 'Must be ≥ 0' : undefined));
  if (xf === undefined) { return; }
  const files = order.o.map(u => u.fsPath);
  const enc = sameFormatEncode(files[0]);
  const out = outputFor(files[0], 'concat', enc.format);
  let total = 0;
  for (const f of files) { total += (await summaryOf(f)).duration; }
  const ok = await job(`Joining ${files.length} files`, (rep, signal) => ff(R.concat(files, out, enc, xf), total, rep, signal, 'Joining…'));
  if (ok) { await announce([out]); }
}

// ---------------------------------------------------------------- visuals

export async function renderImage(kind: 'wave' | 'spec', src: string, out: string, rep: Reporter, signal: AbortSignal, size?: [number, number]): Promise<void> {
  const s = await summaryOf(src);
  const args = kind === 'wave' ? R.waveformPng(src, out, size?.[0], size?.[1]) : R.spectrogramPng(src, out, size?.[0], size?.[1]);
  await ff(args, s.duration, rep, signal, kind === 'wave' ? 'Drawing waveform…' : 'Computing spectrogram…');
}

async function cmdImage(kind: 'wave' | 'spec', arg?: unknown, args?: unknown): Promise<void> {
  const [uri] = await resolveTargets(arg, args);
  if (!uri) { return; }
  const out = outputFor(uri.fsPath, kind === 'wave' ? 'waveform' : 'spectrogram', 'png');
  const ok = await job(kind === 'wave' ? 'Rendering waveform' : 'Rendering spectrogram', async (rep, signal) => { await renderImage(kind, uri.fsPath, out, rep, signal); return true; });
  if (ok) {
    state.created.fire([out]);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(out), vscode.ViewColumn.Beside);
  }
}
export const cmdWaveformImage = (a?: unknown, b?: unknown) => cmdImage('wave', a, b);
export const cmdSpectrogramImage = (a?: unknown, b?: unknown) => cmdImage('spec', a, b);

// ---------------------------------------------------------------- transcription

export async function cmdSetApiKey(): Promise<void> {
  const key = await vscode.window.showInputBox({ prompt: 'API key for the OpenAI-compatible transcription endpoint (stored in VS Code secret storage)', password: true, ignoreFocusOut: true });
  if (key === undefined) { return; }
  if (key) { await state.context.secrets.store(SECRET_KEY, key); } else { await state.context.secrets.delete(SECRET_KEY); }
  vscode.window.showInformationMessage(key ? 'Transcription API key saved.' : 'Transcription API key removed.');
}

async function transcribeConfig(): Promise<TranscribeConfig | undefined> {
  const c = cfg();
  const t = tools();
  const backend = (c.get<string>('transcription.backend') ?? 'whisper.cpp') as Backend;
  const conf: TranscribeConfig = {
    backend, ffmpeg: t.ffmpeg, ffprobe: t.ffprobe,
    language: c.get<string>('transcription.language') || 'auto',
    translate: c.get<boolean>('transcription.translateToEnglish') ?? false,
    prompt: c.get<string>('transcription.prompt') ?? '',
    tmpDir: storageDir('tmp'),
    whisperCpp: {
      exe: c.get<string>('transcription.whisperCpp.executable') || 'whisper-cli',
      model: c.get<string>('transcription.whisperCpp.model') ?? '',
      threads: c.get<number>('transcription.whisperCpp.threads') ?? 0,
      extraArgs: c.get<string[]>('transcription.whisperCpp.extraArgs') ?? [],
    },
    ffmpegWhisperModel: c.get<string>('transcription.ffmpegWhisper.model') ?? '',
    openai: {
      baseUrl: c.get<string>('transcription.openai.baseUrl') || 'https://api.openai.com/v1',
      model: c.get<string>('transcription.openai.model') || 'whisper-1',
      apiKey: (await state.context.secrets.get(SECRET_KEY)) || process.env.OPENAI_API_KEY,
    },
  };
  // First-run help: point at a model / key instead of failing deep inside the job.
  if (backend === 'whisper.cpp' && !conf.whisperCpp.model) {
    const pick = await vscode.window.showWarningMessage('whisper.cpp needs a ggml model file (e.g. ggml-base.en.bin).', 'Choose Model File…', 'Download Models', 'Use API Instead');
    if (pick === 'Download Models') { vscode.env.openExternal(vscode.Uri.parse('https://huggingface.co/ggerganov/whisper.cpp/tree/main')); return undefined; }
    if (pick === 'Use API Instead') { await c.update('transcription.backend', 'openai-compatible', vscode.ConfigurationTarget.Global); return transcribeConfig(); }
    if (pick !== 'Choose Model File…') { return undefined; }
    const f = await vscode.window.showOpenDialog({ filters: { 'ggml model': ['bin'] }, openLabel: 'Use this model' });
    if (!f) { return undefined; }
    conf.whisperCpp.model = f[0].fsPath;
    await c.update('transcription.whisperCpp.model', f[0].fsPath, vscode.ConfigurationTarget.Global);
  }
  if (backend === 'openai-compatible' && !conf.openai.apiKey && /api\.openai\.com/.test(conf.openai.baseUrl)) {
    await cmdSetApiKey();
    conf.openai.apiKey = await state.context.secrets.get(SECRET_KEY);
    if (!conf.openai.apiKey) { return undefined; }
  }
  if (backend === 'ffmpeg-whisper' && !conf.ffmpegWhisperModel) {
    const f = await vscode.window.showOpenDialog({ filters: { 'ggml model': ['bin'] }, openLabel: 'Use this model for FFmpeg whisper' });
    if (!f) { return undefined; }
    conf.ffmpegWhisperModel = f[0].fsPath;
    await c.update('transcription.ffmpegWhisper.model', f[0].fsPath, vscode.ConfigurationTarget.Global);
  }
  return conf;
}

/** Transcript sidecar files next to the audio (or in the output folder). */
export function transcriptPaths(src: string): string[] {
  const name = path.parse(src).name;
  const dirs = [...new Set([path.dirname(src), outputDir(src)])];
  return dirs.flatMap(d => ['json', 'srt', 'vtt'].map(e => path.join(d, `${name}.${e}`)));
}

export function loadTranscript(src: string): Segment[] | undefined {
  for (const p of transcriptPaths(src)) {
    if (!fs.existsSync(p)) { continue; }
    try {
      const txt = fs.readFileSync(p, 'utf8');
      if (p.endsWith('.json')) {
        const j = JSON.parse(txt) as Transcript;
        if (Array.isArray(j.segments)) { return j.segments; }
      } else {
        const segs = parseCues(txt);
        if (segs.length) { return segs; }
      }
    } catch { /* ignore malformed sidecars */ }
  }
  return undefined;
}

export async function cmdTranscribe(arg?: unknown, args?: unknown): Promise<Segment[] | undefined> {
  const [uri] = await resolveTargets(arg, args);
  if (!uri) { return; }
  const conf = await transcribeConfig();
  if (!conf) { return; }
  const src = uri.fsPath;
  const formats = cfg().get<string[]>('transcription.outputFormats') ?? ['srt', 'txt'];
  const written: string[] = [];
  const segments = await job(`Transcribing ${path.basename(src)} (${conf.backend})`, async (rep, signal) => {
    const s = await summaryOf(src);
    const segs = await runTranscribe(src, s.duration, conf, { onProgress: (f, m) => rep(f, m), onLog: logLine, signal });
    if (!segs.length) { throw new Error('No speech was recognised.'); }
    const t: Transcript = { source: path.basename(src), backend: conf.backend, language: conf.language, createdAt: new Date().toISOString(), segments: segs };
    const name = path.parse(src).name;
    for (const fmt of formats) {
      const out = path.join(outputDir(src), `${name}.${fmt}`);
      fs.writeFileSync(out, render(fmt, t), 'utf8');
      written.push(out);
    }
    return segs;
  });
  if (!segments) { return; }
  onTranscribed.fire({ file: src, segments });
  state.created.fire(written);
  const primary = written.find(w => w.endsWith('.srt')) ?? written.find(w => w.endsWith('.txt')) ?? written[0];
  if (primary) { await vscode.window.showTextDocument(vscode.Uri.file(primary), { viewColumn: vscode.ViewColumn.Beside, preview: true }); }
  vscode.window.showInformationMessage(`Transcribed ${segments.length} segments → ${written.map(w => path.extname(w)).join(', ')}`);
  return segments;
}

export async function cmdMuxSubtitles(arg?: unknown, args?: unknown): Promise<void> {
  const [uri] = await resolveTargets(arg, args, { video: true, title: 'Add subtitles to this video' });
  if (!uri) { return; }
  const src = uri.fsPath;
  const base = path.join(path.dirname(src), path.parse(src).name);
  let subs = ['.srt', '.vtt'].map(e => base + e).find(p => fs.existsSync(p));
  const pick = await vscode.window.showQuickPick([
    ...(subs ? [{ label: `$(check) ${path.basename(subs)}`, description: 'found next to the video', p: subs }] : []),
    { label: '$(file) Choose subtitle file…', p: '' },
    { label: '$(comment-discussion) Transcribe this video first', p: '__transcribe' },
  ], { placeHolder: 'Subtitle source' });
  if (!pick) { return; }
  if (pick.p === '__transcribe') {
    const segs = await cmdTranscribe(uri);
    if (!segs) { return; }
    subs = ['.srt', '.vtt'].map(e => path.join(outputDir(src), path.parse(src).name + e)).find(p => fs.existsSync(p));
  } else if (!pick.p) {
    const f = await vscode.window.showOpenDialog({ filters: { Subtitles: ['srt', 'vtt', 'ass'] } });
    subs = f?.[0]?.fsPath;
  } else { subs = pick.p; }
  if (!subs) { return; }
  const lang = await vscode.window.showInputBox({ prompt: 'Subtitle language (ISO 639-2, e.g. eng, deu, jpn)', value: 'eng' });
  if (lang === undefined) { return; }
  const ext = /\.(mp4|m4v|mov)$/i.test(src) ? path.extname(src).slice(1) : 'mkv';
  const out = outputFor(src, 'subtitled', ext);
  const s = await summaryOf(src);
  const ok = await job('Adding subtitle track', (rep, signal) => ff(R.muxSubtitles(src, subs!, out, lang), s.duration, rep, signal, 'Muxing…'));
  if (ok) { await announce([out]); }
}

// ---------------------------------------------------------------- creation

function targetFolder(arg: unknown): string | undefined {
  if (arg instanceof vscode.Uri && fs.existsSync(arg.fsPath)) {
    return fs.statSync(arg.fsPath).isDirectory() ? arg.fsPath : path.dirname(arg.fsPath);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function askFolder(arg: unknown, label: string): Promise<string | undefined> {
  const f = targetFolder(arg);
  if (f) { return f; }
  const p = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: label });
  return p?.[0]?.fsPath;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function cmdRecord(arg?: unknown): Promise<void> {
  const folder = await askFolder(arg, 'Save recordings here');
  if (!folder) { return; }
  const c = cfg();
  const fmtSetting = c.get<string>('record.inputFormat') ?? '';
  let device = c.get<string>('record.device') ?? '';
  if (!device) {
    const listArgs = R.listDevicesArgs(process.platform, fmtSetting);
    let devices: R.Device[] = [];
    if (listArgs) {
      const r = await run({ exe: tools().ffmpeg, args: listArgs }).catch(() => undefined);
      if (r) { devices = R.parseDevices(process.platform, fmtSetting, r.stdout + '\n' + r.stderr); }
    }
    if (devices.length) {
      const d = await vscode.window.showQuickPick(devices.map(x => ({ label: x.label, description: x.id, id: x.id })), { placeHolder: 'Input device' });
      if (!d) { return; }
      device = d.id;
    }
  }
  const secs = await askNumber('Recording length in seconds (0 = until you press Cancel)', 0, n => (n < 0 ? 'Must be ≥ 0' : undefined));
  if (secs === undefined) { return; }
  const format = (c.get<string>('defaults.format') as Format) || 'wav';
  const enc = defaultEncode(undefined, format);
  const out = uniquePath(path.join(folder, `recording-${stamp()}.${format}`));
  const args = R.record(process.platform, fmtSetting, device, out, secs, enc);
  log(`$ ffmpeg ${args.join(' ')}`);
  let elapsed = 0;
  const ok = await job(secs ? `Recording ${secs}s` : 'Recording — press Cancel to stop', async (rep, signal) => {
    await runOk({
      exe: tools().ffmpeg, args, signal, gracefulStop: true,
      onLog: line => {
        const m = /time=\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(line);
        if (m) { elapsed = parseTimecode(m[1]); rep(secs ? elapsed / secs : 0, `● REC ${formatTimecode(elapsed, false)}`); } else { logLine(line); }
      },
    });
    return fs.existsSync(out);
  });
  if (ok || fs.existsSync(out)) { await announce([out], 'Recorded'); }
}

export async function cmdGenerateTone(arg?: unknown): Promise<void> {
  const folder = await askFolder(arg, 'Save generated audio here');
  if (!folder) { return; }
  const kinds: { label: string; k: R.Waveform; freq: boolean; description?: string }[] = [
    { label: 'Sine', k: 'sine', freq: true }, { label: 'Square', k: 'square', freq: true },
    { label: 'Sawtooth', k: 'sawtooth', freq: true }, { label: 'Triangle', k: 'triangle', freq: true },
    { label: 'White noise', k: 'white', freq: false }, { label: 'Pink noise', k: 'pink', freq: false }, { label: 'Brown noise', k: 'brown', freq: false },
    { label: 'Log sine sweep (20 Hz → f)', k: 'sweep', freq: true, description: 'for impulse-response / room measurement' },
    { label: 'Digital silence', k: 'silence', freq: false },
  ];
  const kind = await vscode.window.showQuickPick(kinds, { placeHolder: 'Signal type' });
  if (!kind) { return; }
  let freq = 440;
  if (kind.freq) {
    const f = await askNumber(kind.k === 'sweep' ? 'Sweep end frequency (Hz)' : 'Frequency (Hz) — A4 = 440, C4 ≈ 261.63', kind.k === 'sweep' ? 20000 : 440, n => (n <= 0 ? 'Must be positive' : undefined));
    if (f === undefined) { return; }
    freq = f;
  }
  const dur = await askNumber('Duration (seconds)', kind.k === 'sweep' ? 10 : 2, n => (n <= 0 ? 'Must be positive' : undefined));
  if (dur === undefined) { return; }
  const amp = kind.k === 'silence' ? 0 : await askNumber('Level (dBFS)', -6, n => (n > 0 ? 'Must be ≤ 0' : undefined));
  if (amp === undefined) { return; }
  const enc = defaultEncode();
  const sr = enc.sampleRate || 48000;
  const out = uniquePath(path.join(folder, `${kind.k}${kind.freq ? '_' + freq + 'Hz' : ''}_${dur}s.${enc.format}`));
  const ok = await job(`Generating ${kind.label}`, (rep, signal) => ff(R.generate(out, kind.k, dur, freq, sr, amp, enc), dur, rep, signal, 'Rendering…'));
  if (ok) { await announce([out], 'Generated'); }
}

// ---------------------------------------------------------------- recipes

interface Recipe { label: string; detail: string; cmd: string; }
const RECIPES: Recipe[] = [
  { label: 'Show stream info (ffprobe)', detail: 'Pretty JSON of format and streams', cmd: 'ffprobe -v error -show_format -show_streams -of json {in}' },
  { label: 'Convert to 24-bit / 48 kHz WAV', detail: 'pcm_s24le', cmd: 'ffmpeg -i {in} -c:a pcm_s24le -ar 48000 {out}.wav' },
  { label: 'Convert to 320k MP3 keeping tags', detail: 'libmp3lame', cmd: 'ffmpeg -i {in} -map_metadata 0 -c:a libmp3lame -b:a 320k {out}.mp3' },
  { label: 'Cut without re-encoding', detail: 'stream copy (frame-accurate only)', cmd: 'ffmpeg -ss 00:00:05 -to 00:00:15 -i {in} -c copy {out}_cut{ext}' },
  { label: 'EBU R128 loudness report', detail: 'ebur128 summary', cmd: 'ffmpeg -nostats -i {in} -filter_complex ebur128=peak=true -f null -' },
  { label: 'Loudnorm single pass to -14 LUFS', detail: 'quick, slightly less accurate than two-pass', cmd: 'ffmpeg -i {in} -af loudnorm=I=-14:TP=-1:LRA=11 -ar 48000 {out}_loud.wav' },
  { label: 'Detect silence', detail: 'prints silence_start / silence_end', cmd: 'ffmpeg -i {in} -af silencedetect=noise=-40dB:d=0.5 -f null -' },
  { label: 'Remove silence everywhere', detail: 'silenceremove', cmd: 'ffmpeg -i {in} -af silenceremove=stop_periods=-1:stop_duration=0.3:stop_threshold=-45dB {out}_nosilence.wav' },
  { label: 'Spectrogram PNG', detail: 'showspectrumpic', cmd: 'ffmpeg -i {in} -lavfi showspectrumpic=s=1920x1080:legend=1:scale=log {out}_spec.png' },
  { label: 'Waveform video (for socials)', detail: 'showwaves → mp4', cmd: 'ffmpeg -i {in} -filter_complex "[0:a]showwaves=s=1280x720:mode=cline:colors=white,format=yuv420p[v]" -map "[v]" -map 0:a -c:v libx264 -c:a aac {out}_wave.mp4' },
  { label: 'Live spectrum player', detail: 'ffplay visualiser', cmd: 'ffplay -showmode 2 {in}' },
  { label: 'Split stereo into L / R mono files', detail: 'channelsplit', cmd: 'ffmpeg -i {in} -filter_complex "channelsplit=channel_layout=stereo[L][R]" -map "[L]" {out}_L.wav -map "[R]" {out}_R.wav' },
  { label: 'Merge two mono files into stereo', detail: 'amerge / join', cmd: 'ffmpeg -i left.wav -i right.wav -filter_complex "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]" -map "[a]" stereo.wav' },
  { label: 'Mix two files', detail: 'amix', cmd: 'ffmpeg -i {in} -i other.wav -filter_complex amix=inputs=2:duration=longest:normalize=0 {out}_mix.wav' },
  { label: 'Sidechain duck music under voice', detail: 'sidechaincompress', cmd: 'ffmpeg -i music.wav -i voice.wav -filter_complex "[0:a][1:a]sidechaincompress=threshold=0.05:ratio=8[d];[d][1:a]amix=inputs=2[a]" -map "[a]" ducked.wav' },
  { label: 'Convolution reverb with an impulse response', detail: 'afir', cmd: 'ffmpeg -i {in} -i ir.wav -filter_complex "[0:a][1:a]afir=dry=8:wet=6" {out}_reverb.wav' },
  { label: 'High-quality pitch shift (rubberband)', detail: 'needs --enable-librubberband', cmd: 'ffmpeg -i {in} -af rubberband=pitch=1.122462 {out}_up2st.wav' },
  { label: 'Add cover art + tags to MP3', detail: 'ID3v2', cmd: 'ffmpeg -i {in} -i cover.jpg -map 0:a -map 1 -c copy -id3v2_version 3 -metadata title="Title" -metadata artist="Artist" -metadata:s:v comment="Cover (front)" {out}_tagged.mp3' },
  { label: 'Speech-optimised mono 16 kHz WAV', detail: 'for ASR / whisper', cmd: 'ffmpeg -i {in} -ar 16000 -ac 1 -c:a pcm_s16le {out}_16k.wav' },
  { label: 'Burn subtitles into video', detail: 'subtitles filter (re-encodes video)', cmd: 'ffmpeg -i {in} -vf subtitles={base}.srt -c:a copy {out}_burned.mp4' },
  { label: 'Whisper transcription in FFmpeg 8+', detail: 'whisper filter → SRT', cmd: 'ffmpeg -i {in} -vn -af "whisper=model=ggml-base.en.bin:language=en:queue=3:destination={base}.srt:format=srt" -f null -' },
  { label: 'List capture devices', detail: process.platform === 'darwin' ? 'avfoundation' : process.platform === 'win32' ? 'dshow' : 'pulse / alsa', cmd: process.platform === 'darwin' ? 'ffmpeg -f avfoundation -list_devices true -i ""' : process.platform === 'win32' ? 'ffmpeg -list_devices true -f dshow -i dummy' : 'ffmpeg -sources pulse' },
];

export async function cmdRecipes(arg?: unknown, args?: unknown): Promise<void> {
  const r = await vscode.window.showQuickPick(RECIPES.map(x => ({ label: x.label, description: x.detail, detail: x.cmd, x })), { placeHolder: 'Pick an FFmpeg recipe — it is typed into a terminal for you to edit and run', matchOnDetail: true });
  if (!r) { return; }
  let cmd = r.x.cmd;
  if (/\{in\}|\{out\}|\{base\}|\{ext\}/.test(cmd)) {
    const uris = await resolveTargets(arg, args, { title: 'Use this file as input' });
    const src = uris[0]?.fsPath ?? 'input.wav';
    const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
    const base = path.join(path.dirname(src), path.parse(src).name);
    cmd = cmd
      .replace(/\{in\}/g, q(src))
      .replace(/\{out\}(\S*)/g, (_, rest: string) => q(base + rest.replace('{ext}', path.extname(src))))
      .replace(/\{base\}/g, base.replace(/\\/g, '/'))
      .replace(/\{ext\}/g, path.extname(src));
    // Use the configured binaries.
    cmd = cmd.replace(/^ffmpeg\b/, q(tools().ffmpeg)).replace(/^ffprobe\b/, q(tools().ffprobe));
    if (!/[\\/]/.test(tools().ffmpeg)) { cmd = cmd.replace(/^"ffmpeg"/, 'ffmpeg').replace(/^"ffprobe"/, 'ffprobe'); }
  }
  const term = vscode.window.terminals.find(t => t.name === 'Sound Lab') ?? vscode.window.createTerminal({ name: 'Sound Lab', cwd: targetFolder(arg) });
  term.show();
  term.sendText(cmd, false);
}

export { MEDIA_EXT, openMedia };
