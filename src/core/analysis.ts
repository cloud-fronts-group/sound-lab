// Parsers for ffmpeg analysis-filter output and waveform peak extraction.
import { run, runOk } from './ffmpeg';
import { pcmForPeaks } from './recipes';
import type { LoudnormMeasured } from './recipes';

export interface Interval { start: number; end: number; }

export function parseSilence(stderr: string, duration: number): Interval[] {
  const out: Interval[] = [];
  let open: number | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) { open = Math.max(0, parseFloat(s[1])); continue; }
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e) { out.push({ start: open ?? 0, end: parseFloat(e[1]) }); open = undefined; }
  }
  if (open !== undefined) { out.push({ start: open, end: duration }); }
  return out;
}

/** Invert silences into sound segments, with padding and minimum length. */
export function soundSegments(silences: Interval[], duration: number, padding: number, minLength: number): Interval[] {
  const segs: Interval[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) { segs.push({ start: cursor, end: s.start }); }
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) { segs.push({ start: cursor, end: duration }); }
  return segs
    .map(s => ({ start: Math.max(0, s.start - padding), end: Math.min(duration, s.end + padding) }))
    .filter(s => s.end - s.start >= minLength);
}

export function parseLoudnormJson(stderr: string): LoudnormMeasured {
  const idx = stderr.lastIndexOf('[Parsed_loudnorm');
  const start = stderr.indexOf('{', idx >= 0 ? idx : 0);
  const end = stderr.indexOf('}', start);
  if (start < 0 || end < 0) { throw new Error('Could not read loudnorm measurements from ffmpeg output.'); }
  return JSON.parse(stderr.slice(start, end + 1));
}

export interface LevelReport {
  integratedLufs?: number;
  truePeakDbtp?: number;
  lra?: number;
  threshold?: number;
  meanVolumeDb?: number;
  maxVolumeDb?: number;
  stats: Record<string, string>;
  histogram: { db: number; count: number }[];
}

export function parseVolumedetect(stderr: string): { mean?: number; max?: number; histogram: { db: number; count: number }[] } {
  const mean = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr)?.[1];
  const max = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr)?.[1];
  const histogram: { db: number; count: number }[] = [];
  const re = /histogram_(\d+)db:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) { histogram.push({ db: -parseInt(m[1], 10), count: parseInt(m[2], 10) }); }
  const num = (v?: string) => v === undefined ? undefined : v === '-inf' ? -Infinity : parseFloat(v);
  return { mean: num(mean), max: num(max), histogram };
}

/** Parse the "Overall" block of astats. */
export function parseAstats(stderr: string): Record<string, string> {
  const stats: Record<string, string> = {};
  const lines = stderr.split(/\r?\n/);
  let inOverall = false;
  for (const line of lines) {
    if (!/Parsed_astats/.test(line)) { continue; }
    const body = line.replace(/^\[Parsed_astats[^\]]*\]\s*/, '');
    if (/^Overall/.test(body)) { inOverall = true; continue; }
    if (/^Channel:/.test(body)) { inOverall = false; continue; }
    const kv = /^([^:]+):\s*(.+)$/.exec(body);
    if (kv && inOverall) { stats[kv[1].trim()] = kv[2].trim(); }
  }
  return stats;
}

export async function analyzeLevels(ffmpeg: string, input: string, durationSec: number, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<LevelReport> {
  const { levelsAnalyze, loudnormAnalyze } = await import('./recipes');
  const a = await runOk({ exe: ffmpeg, args: levelsAnalyze(input), durationSec, onProgress: f => onProgress?.(f / 2), signal });
  const l = await runOk({ exe: ffmpeg, args: loudnormAnalyze(input, { i: -23, tp: -1, lra: 11 }), durationSec, onProgress: f => onProgress?.(0.5 + f / 2), signal });
  const vd = parseVolumedetect(a.stderr);
  const ln = parseLoudnormJson(l.stderr);
  const num = (s: string) => (s === '-inf' ? -Infinity : parseFloat(s));
  return {
    integratedLufs: num(ln.input_i),
    truePeakDbtp: num(ln.input_tp),
    lra: num(ln.input_lra),
    threshold: num(ln.input_thresh),
    meanVolumeDb: vd.mean,
    maxVolumeDb: vd.max,
    stats: parseAstats(a.stderr),
    histogram: vd.histogram,
  };
}

export interface Peaks {
  /** Interleaved [min0, max0, min1, max1, …] in -1..1 */
  data: number[];
  bucketsPerSecond: number;
  duration: number;
  rms: number;
}

/**
 * Decode audio to mono float PCM and reduce it to min/max pairs.
 * Decodes at a modest rate (≤ 8 kHz for long files) to keep memory and time low.
 */
export async function extractPeaks(ffmpeg: string, input: string, duration: number, bucketsPerSecond: number, signal?: AbortSignal): Promise<Peaks> {
  const maxBuckets = 60000;
  let bps = bucketsPerSecond;
  if (duration * bps > maxBuckets) { bps = Math.max(1, Math.floor(maxBuckets / Math.max(duration, 1))); }
  const rate = duration > 600 ? 4000 : duration > 60 ? 8000 : 22050;
  const perBucket = Math.max(1, Math.round(rate / bps));
  const data: number[] = [];
  let min = 1, max = -1, n = 0, sumSq = 0, total = 0;
  let leftover: Buffer = Buffer.alloc(0);

  const r = await run({
    exe: ffmpeg, args: pcmForPeaks(input, rate), signal,
    onStdout: chunk => {
      const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = buf.length - (buf.length % 4);
      for (let off = 0; off < usable; off += 4) {
        const v = buf.readFloatLE(off);
        if (v < min) { min = v; }
        if (v > max) { max = v; }
        sumSq += v * v; total++;
        if (++n === perBucket) { data.push(round(min), round(max)); min = 1; max = -1; n = 0; }
      }
      leftover = buf.subarray(usable);
    },
  });
  if (r.code !== 0) { throw new Error(`Waveform decode failed: ${r.stderr.trim().split('\n').pop()}`); }
  if (n > 0) { data.push(round(min), round(max)); }
  return { data, bucketsPerSecond: rate / perBucket, duration: total / rate || duration, rms: total ? Math.sqrt(sumSq / total) : 0 };
}

function round(v: number): number { return Math.round(Math.max(-1, Math.min(1, v)) * 1000) / 1000; }
