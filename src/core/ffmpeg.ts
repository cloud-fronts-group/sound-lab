// Process runner for ffmpeg / ffprobe / whisper.cpp. No VS Code dependency so it can be unit-tested.
import { spawn } from 'child_process';

export interface RunOptions {
  /** Executable to run (ffmpeg path, ffprobe path, whisper-cli…). */
  exe: string;
  args: string[];
  cwd?: string;
  /** Known media duration in seconds, used to turn `time=` into a fraction. */
  durationSec?: number;
  /** Called with 0..1 when progress can be computed. */
  onProgress?: (fraction: number, timeSec: number) => void;
  /** Every stderr line (ffmpeg writes its log to stderr). */
  onLog?: (line: string) => void;
  /** Raw stdout chunks (e.g. PCM for waveform peaks). When set, stdout is not buffered. */
  onStdout?: (chunk: Buffer) => void;
  signal?: AbortSignal;
  /** Stop by sending "q" on stdin (lets ffmpeg finalise the file) instead of killing. */
  gracefulStop?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  cancelled: boolean;
}

export class ProcessError extends Error {
  constructor(message: string, public readonly result: RunResult) {
    super(message);
  }
}

const MAX_BUFFER = 16 * 1024 * 1024;

/** Parse "HH:MM:SS.ms", "MM:SS", or plain seconds into seconds. */
export function parseTimecode(value: string): number {
  const v = value.trim();
  if (!v) { return NaN; }
  if (/^-?\d+(\.\d+)?s?$/.test(v)) { return parseFloat(v); }
  const parts = v.split(':').map(Number);
  if (parts.some(isNaN)) { return NaN; }
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function formatTimecode(sec: number, withMs = true): string {
  if (!isFinite(sec) || sec < 0) { sec = 0; }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = withMs ? s.toFixed(3).padStart(6, '0') : Math.floor(s).toString().padStart(2, '0');
  return (h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${ss}`;
}

export function run(opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let cancelled = false;
    let partial = '';

    const child = spawn(opts.exe, opts.args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: [opts.gracefulStop ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    const onAbort = () => {
      cancelled = true;
      if (opts.gracefulStop && child.stdin && !child.stdin.destroyed) {
        child.stdin.write('q\n');
        setTimeout(() => { if (child.exitCode === null) { child.kill(); } }, 4000);
      } else {
        child.kill();
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) { onAbort(); }
      else { opts.signal.addEventListener('abort', onAbort, { once: true }); }
    }

    child.stdout!.on('data', (chunk: Buffer) => {
      if (opts.onStdout) { opts.onStdout(chunk); }
      else if (stdout.length < MAX_BUFFER) { stdout += chunk.toString('utf8'); }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (stderr.length < MAX_BUFFER) { stderr += text; }
      partial += text;
      const lines = partial.split(/\r\n|\r|\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) { handleLine(line); }
    });

    const handleLine = (line: string) => {
      if (!line) { return; }
      opts.onLog?.(line);
      if (opts.onProgress && opts.durationSec && opts.durationSec > 0) {
        const m = /time=\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(line);
        if (m) {
          const t = parseTimecode(m[1]);
          opts.onProgress(Math.min(1, t / opts.durationSec), t);
        }
      }
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new ProcessError(`Executable not found: "${opts.exe}". Install it or set its path in Sound Lab settings.`,
          { code: -1, stdout, stderr, cancelled }));
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (partial) { handleLine(partial); }
      opts.signal?.removeEventListener('abort', onAbort);
      const result: RunResult = { code: code ?? -1, stdout, stderr, cancelled };
      // ffmpeg exits 255 when stopped with 'q' / signal; treat a requested stop as success for recordings.
      if (code === 0 || (cancelled && opts.gracefulStop)) {
        resolve(result);
      } else if (cancelled) {
        reject(new ProcessError('Cancelled', result));
      } else {
        resolve(result); // caller decides; see ensureOk
      }
    });
  });
}

/** Run and throw a readable error if the exit code is non-zero. */
export async function runOk(opts: RunOptions): Promise<RunResult> {
  const r = await run(opts);
  if (r.code !== 0 && !(r.cancelled && opts.gracefulStop)) {
    const tail = r.stderr.split(/\r?\n/).filter(l => l.trim()).slice(-6).join('\n');
    throw new ProcessError(`${baseName(opts.exe)} failed (exit ${r.code}):\n${tail}`, r);
  }
  return r;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** Arguments every ffmpeg job starts with. */
export function ffBase(overwrite = true): string[] {
  return ['-hide_banner', '-nostdin', overwrite ? '-y' : '-n'];
}

export interface Capabilities {
  ffmpegVersion?: string;
  ffprobeVersion?: string;
  filters: Set<string>;
  encoders: Set<string>;
  error?: string;
}

export async function detectCapabilities(ffmpeg: string, ffprobe: string): Promise<Capabilities> {
  const caps: Capabilities = { filters: new Set(), encoders: new Set() };
  try {
    const v = await runOk({ exe: ffmpeg, args: ['-hide_banner', '-version'] });
    caps.ffmpegVersion = /ffmpeg version (\S+)/.exec(v.stdout)?.[1] ?? 'unknown';
    const f = await run({ exe: ffmpeg, args: ['-hide_banner', '-filters'] });
    for (const line of f.stdout.split(/\r?\n/)) {
      const m = /^\s[.TSC|]{3}\s+(\w+)\s/.exec(line);
      if (m) { caps.filters.add(m[1]); }
    }
    const e = await run({ exe: ffmpeg, args: ['-hide_banner', '-encoders'] });
    for (const line of e.stdout.split(/\r?\n/)) {
      const m = /^\s[A-Z.]{6}\s+(\S+)/.exec(line);
      if (m) { caps.encoders.add(m[1]); }
    }
  } catch (err) {
    caps.error = (err as Error).message;
  }
  try {
    const p = await runOk({ exe: ffprobe, args: ['-hide_banner', '-version'] });
    caps.ffprobeVersion = /ffprobe version (\S+)/.exec(p.stdout)?.[1] ?? 'unknown';
  } catch (err) {
    caps.error = caps.error ?? (err as Error).message;
  }
  return caps;
}
