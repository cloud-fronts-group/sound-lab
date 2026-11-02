// Speech-to-text backends: whisper.cpp CLI, OpenAI-compatible HTTP API, FFmpeg 8 `whisper` filter.
import * as fs from 'fs';
import * as path from 'path';
import { run, runOk } from './ffmpeg';
import { toWhisperWav, toUploadChunks } from './recipes';
import { probe, summarize } from './probe';
import { Segment, fromWhisperCppJson, fromOpenAiJson, parseCues } from './subtitles';
import { MlxAudioClient } from './mlxAudio';

export type Backend = 'whisper.cpp' | 'openai-compatible' | 'ffmpeg-whisper' | 'mlx-audio';

export interface TranscribeConfig {
  backend: Backend;
  ffmpeg: string;
  ffprobe: string;
  language: string;        // 'auto' or ISO code
  translate: boolean;
  prompt: string;
  tmpDir: string;
  whisperCpp: { exe: string; model: string; threads: number; extraArgs: string[] };
  ffmpegWhisperModel: string;
  openai: { baseUrl: string; model: string; apiKey?: string };
  /** mlx-audio server (backend 'mlx-audio'). ensure() starts it if needed and returns the client. */
  mlx?: { model: string; ensure: (signal?: AbortSignal) => Promise<MlxAudioClient> };
}

export interface TranscribeHooks {
  onProgress?: (fraction: number, message: string) => void;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

export async function transcribe(input: string, duration: number, cfg: TranscribeConfig, hooks: TranscribeHooks = {}): Promise<Segment[]> {
  fs.mkdirSync(cfg.tmpDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(cfg.tmpDir, 'stt-'));
  try {
    switch (cfg.backend) {
      case 'whisper.cpp': return await viaWhisperCpp(input, duration, cfg, hooks, work);
      case 'openai-compatible': return await viaOpenAi(input, duration, cfg, hooks, work);
      case 'ffmpeg-whisper': return await viaFfmpegFilter(input, duration, cfg, hooks, work);
      case 'mlx-audio': return await viaMlxAudio(input, duration, cfg, hooks, work);
      default: throw new Error(`Unknown transcription backend: ${cfg.backend}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function viaWhisperCpp(input: string, duration: number, cfg: TranscribeConfig, h: TranscribeHooks, work: string): Promise<Segment[]> {
  const w = cfg.whisperCpp;
  if (!w.model) { throw new Error('No whisper.cpp model configured. Set "soundLab.transcription.whisperCpp.model" to a ggml-*.bin file.'); }
  if (!fs.existsSync(w.model)) { throw new Error(`whisper.cpp model not found: ${w.model}`); }
  const wav = path.join(work, 'input.wav');
  h.onProgress?.(0, 'Preparing 16 kHz audio…');
  await runOk({ exe: cfg.ffmpeg, args: toWhisperWav(input, wav), durationSec: duration, onProgress: f => h.onProgress?.(f * 0.1, 'Preparing 16 kHz audio…'), onLog: h.onLog, signal: h.signal });

  const base = path.join(work, 'out');
  const args = ['-m', w.model, '-f', wav, '-oj', '-of', base, '-pp'];
  if (cfg.language && cfg.language !== 'auto') { args.push('-l', cfg.language); } else { args.push('-l', 'auto'); }
  if (cfg.translate) { args.push('-tr'); }
  if (cfg.prompt) { args.push('--prompt', cfg.prompt); }
  if (w.threads > 0) { args.push('-t', String(w.threads)); }
  args.push(...w.extraArgs);

  h.onProgress?.(0.1, 'Transcribing with whisper.cpp…');
  await runOk({
    exe: w.exe, args, signal: h.signal,
    onLog: line => {
      h.onLog?.(line);
      const m = /progress\s*=\s*(\d+)%/.exec(line);
      if (m) { h.onProgress?.(0.1 + 0.9 * (+m[1] / 100), `Transcribing with whisper.cpp… ${m[1]}%`); }
    },
  });
  const jsonPath = `${base}.json`;
  if (!fs.existsSync(jsonPath)) { throw new Error('whisper.cpp did not produce JSON output (is this an old build without -oj?).'); }
  return fromWhisperCppJson(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
}

const CHUNK_SECONDS = 600; // 10 min of 16 kHz mono FLAC stays well under the common 25 MB upload limit

async function viaOpenAi(input: string, duration: number, cfg: TranscribeConfig, h: TranscribeHooks, work: string): Promise<Segment[]> {
  const o = cfg.openai;
  const isOpenAi = /api\.openai\.com/.test(o.baseUrl);
  if (isOpenAi && !o.apiKey) { throw new Error('No API key set. Run "Sound Lab: Set Transcription API Key" or set OPENAI_API_KEY.'); }

  h.onProgress?.(0, 'Encoding upload chunks…');
  await runOk({
    exe: cfg.ffmpeg, args: toUploadChunks(input, path.join(work, 'chunk_%04d.flac'), CHUNK_SECONDS),
    durationSec: duration, onProgress: f => h.onProgress?.(f * 0.1, 'Encoding upload chunks…'), onLog: h.onLog, signal: h.signal,
  });
  const chunks = fs.readdirSync(work).filter(f => f.startsWith('chunk_')).sort();
  const endpoint = `${o.baseUrl.replace(/\/+$/, '')}/audio/${cfg.translate ? 'translations' : 'transcriptions'}`;
  const all: Segment[] = [];
  let offset = 0;

  for (let i = 0; i < chunks.length; i++) {
    const file = path.join(work, chunks[i]);
    const chunkDur = summarize(await probe(cfg.ffprobe, file)).duration;
    h.onProgress?.(0.1 + 0.9 * (i / chunks.length), `Uploading chunk ${i + 1}/${chunks.length} to ${new URL(endpoint).host}…`);

    let json = await postAudio(endpoint, file, cfg, 'verbose_json', h.signal);
    if (json === undefined) { json = await postAudio(endpoint, file, cfg, 'json', h.signal); } // models without verbose_json
    all.push(...fromOpenAiJson(json, offset, chunkDur));
    offset += chunkDur;
  }
  h.onProgress?.(1, 'Done');
  return all;
}

async function postAudio(endpoint: string, file: string, cfg: TranscribeConfig, responseFormat: string, signal?: AbortSignal): Promise<unknown | undefined> {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/flac' }), path.basename(file));
  form.append('model', cfg.openai.model);
  form.append('response_format', responseFormat);
  if (responseFormat === 'verbose_json') { form.append('timestamp_granularities[]', 'segment'); }
  if (!cfg.translate && cfg.language && cfg.language !== 'auto') { form.append('language', cfg.language); }
  if (cfg.prompt) { form.append('prompt', cfg.prompt); }
  const headers: Record<string, string> = {};
  if (cfg.openai.apiKey) { headers.Authorization = `Bearer ${cfg.openai.apiKey}`; }

  const res = await fetch(endpoint, { method: 'POST', body: form, headers, signal });
  const body = await res.text();
  if (!res.ok) {
    if (responseFormat === 'verbose_json' && res.status === 400 && /response_format|verbose_json/i.test(body)) { return undefined; }
    throw new Error(`Transcription API error ${res.status}: ${body.slice(0, 400)}`);
  }
  try { return JSON.parse(body); } catch { return { text: body }; }
}

/** Escape a value for use inside a filter option *and* a filtergraph (two levels of ffmpeg quoting). */
export function escapeFilterValue(v: string): string {
  const level1 = v.replace(/[\\':]/g, m => '\\' + m);
  return level1.replace(/[\\'[\],;]/g, m => '\\' + m);
}

async function viaFfmpegFilter(input: string, duration: number, cfg: TranscribeConfig, h: TranscribeHooks, work: string): Promise<Segment[]> {
  if (!cfg.ffmpegWhisperModel) { throw new Error('Set "soundLab.transcription.ffmpegWhisper.model" to a ggml model for FFmpeg\'s whisper filter.'); }
  const f = await run({ exe: cfg.ffmpeg, args: ['-hide_banner', '-filters'] });
  if (!/\swhisper\s/.test(f.stdout)) {
    throw new Error('This FFmpeg build has no "whisper" filter (needs FFmpeg 8.0+ configured with --enable-whisper). Switch backend to whisper.cpp or openai-compatible.');
  }
  const out = path.join(work, 'out.srt');
  const lang = cfg.language && cfg.language !== 'auto' ? cfg.language : 'auto';
  const af = `aresample=16000,aformat=channel_layouts=mono,whisper=model=${escapeFilterValue(cfg.ffmpegWhisperModel)}` +
    `:language=${lang}:queue=3:destination=${escapeFilterValue(out)}:format=srt`;
  h.onProgress?.(0, 'Transcribing with FFmpeg whisper filter…');
  await runOk({
    exe: cfg.ffmpeg, args: ['-hide_banner', '-nostdin', '-i', input, '-map', '0:a:0', '-af', af, '-f', 'null', '-'],
    durationSec: duration, onProgress: fr => h.onProgress?.(fr, `Transcribing with FFmpeg whisper filter… ${Math.round(fr * 100)}%`),
    onLog: h.onLog, signal: h.signal,
  });
  return parseCues(fs.readFileSync(out, 'utf8'));
}

async function viaMlxAudio(input: string, duration: number, cfg: TranscribeConfig, h: TranscribeHooks, work: string): Promise<Segment[]> {
  if (!cfg.mlx) { throw new Error('mlx-audio backend is not configured.'); }
  const wav = path.join(work, 'input.wav');
  h.onProgress?.(0, 'Preparing 16 kHz audio…');
  await runOk({ exe: cfg.ffmpeg, args: toWhisperWav(input, wav), durationSec: duration, onProgress: f => h.onProgress?.(f * 0.1, 'Preparing 16 kHz audio…'), onLog: h.onLog, signal: h.signal });
  h.onProgress?.(0.1, 'Connecting to mlx-audio server…');
  const client = await cfg.mlx.ensure(h.signal);
  h.onProgress?.(0.15, `Transcribing with ${cfg.mlx.model} on ${client.url}…`);
  const t = await client.transcribe(wav, { model: cfg.mlx.model, language: cfg.language, prompt: cfg.prompt, signal: h.signal });
  h.onProgress?.(1, 'Done');
  if (t.segments.length) { return t.segments; }
  return t.text ? [{ start: 0, end: duration, text: t.text }] : [];
}
