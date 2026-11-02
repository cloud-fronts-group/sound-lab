import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Capabilities, ProcessError, detectCapabilities } from './core/ffmpeg';
import { EncodeOptions, Format, formatFromPath } from './core/recipes';
import { AudioSummary, probe, summarize } from './core/probe';

export const AUDIO_EXT = ['wav', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aif', 'aiff', 'wma', 'caf', 'ac3', 'amr', 'webm', 'mka'];
export const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'avi', 'm4v', 'wmv', 'flv', 'ts', 'mts', 'webm'];
export const MEDIA_EXT = [...new Set([...AUDIO_EXT, ...VIDEO_EXT])];

class State {
  output!: vscode.OutputChannel;
  context!: vscode.ExtensionContext;
  caps?: Capabilities;
  activeEditorUri?: vscode.Uri;
  statusItem?: vscode.StatusBarItem;
  /** Fired with paths of files Sound Lab created, so views can refresh. */
  readonly created = new vscode.EventEmitter<string[]>();
}
export const state = new State();

export function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('soundLab');
}

export function tools(): { ffmpeg: string; ffprobe: string } {
  const c = cfg();
  return { ffmpeg: c.get<string>('ffmpegPath') || 'ffmpeg', ffprobe: c.get<string>('ffprobePath') || 'ffprobe' };
}

export function log(line: string): void {
  state.output.appendLine(line);
}

export async function refreshCapabilities(): Promise<Capabilities> {
  const t = tools();
  state.caps = await detectCapabilities(t.ffmpeg, t.ffprobe);
  const item = state.statusItem;
  if (item) {
    if (state.caps.error || !state.caps.ffmpegVersion) {
      item.text = '$(warning) ffmpeg missing';
      item.tooltip = state.caps.error ?? 'ffmpeg not found';
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      item.text = `$(pulse) ffmpeg ${state.caps.ffmpegVersion.split('-')[0]}`;
      item.tooltip = 'Sound Lab: show FFmpeg capabilities';
      item.backgroundColor = undefined;
    }
    item.show();
  }
  return state.caps;
}

export async function ensureFfmpeg(): Promise<boolean> {
  const caps = state.caps ?? await refreshCapabilities();
  if (caps.ffmpegVersion && caps.ffprobeVersion) { return true; }
  const pick = await vscode.window.showErrorMessage(
    `Sound Lab needs ffmpeg and ffprobe. ${caps.error ?? ''}`, 'Open Settings', 'Download FFmpeg', 'Retry');
  if (pick === 'Open Settings') { vscode.commands.executeCommand('workbench.action.openSettings', 'soundLab.ffmpegPath'); }
  if (pick === 'Download FFmpeg') { vscode.env.openExternal(vscode.Uri.parse('https://ffmpeg.org/download.html')); }
  if (pick === 'Retry') { return !!(await refreshCapabilities()).ffmpegVersion; }
  return false;
}

export type Reporter = (fraction: number, message?: string) => void;

/** Run a cancellable job behind a progress notification; errors are surfaced with a "Show Log" action. */
export async function job<T>(title: string, fn: (report: Reporter, signal: AbortSignal, logLine: (l: string) => void) => Promise<T>): Promise<T | undefined> {
  if (!(await ensureFfmpeg())) { return undefined; }
  log(`\n▶ ${title}`);
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Sound Lab: ${title}`, cancellable: true }, async (progress, token) => {
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    let last = 0;
    const report: Reporter = (f, message) => {
      const pct = Math.max(0, Math.min(100, f * 100));
      progress.report({ increment: Math.max(0, pct - last), message: message ?? `${Math.round(pct)}%` });
      last = Math.max(last, pct);
    };
    try {
      const r = await fn(report, ac.signal, l => log(l));
      log(`✔ ${title}`);
      return r;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (ac.signal.aborted || msg === 'Cancelled' || (err as Error).name === 'AbortError') {
        log(`✖ ${title} cancelled`);
        return undefined;
      }
      log(`✖ ${title}: ${msg}`);
      if (err instanceof ProcessError) { log(err.result.stderr.split(/\r?\n/).slice(-30).join('\n')); }
      const pick = await vscode.window.showErrorMessage(`Sound Lab: ${msg.split('\n')[0]}`, 'Show Log');
      if (pick) { state.output.show(true); }
      return undefined;
    }
  });
}

/** Wrap ffmpeg run options with logging and progress plumbing. */
export function logLine(line: string): void {
  // ffmpeg's per-frame stats lines are noisy; keep them out of the log.
  if (/^(size|frame)=.*time=/.test(line.trim())) { return; }
  log(line);
}

export function expandVars(template: string, src: string): string {
  const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(src))?.uri.fsPath
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(src);
  return template
    .replace(/\$\{fileDirname\}/g, path.dirname(src))
    .replace(/\$\{workspaceFolder\}/g, ws)
    .replace(/\$\{fileBasenameNoExtension\}/g, path.parse(src).name);
}

export function outputDir(src: string): string {
  const tpl = cfg().get<string>('output.directory') || '';
  const dir = tpl ? expandVars(tpl, src) : path.dirname(src);
  const abs = path.isAbsolute(dir) ? dir : path.join(path.dirname(src), dir);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

export function uniquePath(p: string): string {
  if (cfg().get<boolean>('output.overwrite') || !fs.existsSync(p)) { return p; }
  const { dir, name, ext } = path.parse(p);
  for (let i = 1; ; i++) {
    const c = path.join(dir, `${name}-${i}${ext}`);
    if (!fs.existsSync(c)) { return c; }
  }
}

/** e.g. outputFor("/a/kick.wav", "trim", "flac") → "/a/kick_trim.flac" (made unique). */
export function outputFor(src: string, suffix: string, ext: string): string {
  const name = path.parse(src).name;
  return uniquePath(path.join(outputDir(src), `${name}${suffix ? '_' + suffix : ''}.${ext}`));
}

export function defaultEncode(src?: AudioSummary, format?: Format): EncodeOptions {
  const c = cfg();
  return {
    format: format ?? (c.get<string>('defaults.format') as Format) ?? 'wav',
    bitDepth: (c.get<number>('defaults.bitDepth') as 16 | 24 | 32) ?? 24,
    sampleRate: c.get<number>('defaults.sampleRate') || undefined,
    bitrate: c.get<string>('defaults.mp3Bitrate') || '320k',
    channels: undefined,
    ...(src ? {} : {}),
  };
}

/** Prefer the source's own format for in-place-style edits (effects, normalize) when it is one we can write. */
export function sameFormatEncode(src: string, summary?: AudioSummary): EncodeOptions {
  const f = formatFromPath(src);
  const enc = defaultEncode(summary, f ?? undefined);
  if (summary?.bitDepth && [16, 24, 32].includes(summary.bitDepth) && f && ['wav', 'aiff', 'flac'].includes(f)) {
    enc.bitDepth = summary.bitDepth as 16 | 24 | 32;
    if (f === 'flac' && enc.bitDepth === 32) { enc.bitDepth = 24; }
  }
  return enc;
}

export async function summaryOf(file: string): Promise<AudioSummary> {
  return summarize(await probe(tools().ffprobe, file));
}

function isMedia(uri: vscode.Uri): boolean {
  return MEDIA_EXT.includes(path.extname(uri.fsPath).slice(1).toLowerCase());
}

/** Resolve the files a command should act on from explorer/tree/editor arguments, the active audio editor, or a picker. */
export async function resolveTargets(arg: unknown, args: unknown, opts: { many?: boolean; video?: boolean; title?: string } = {}): Promise<vscode.Uri[]> {
  const out: vscode.Uri[] = [];
  const add = (u: unknown) => {
    if (u instanceof vscode.Uri) { out.push(u); }
    else if (u && typeof u === 'object' && (u as { resourceUri?: unknown }).resourceUri instanceof vscode.Uri) { out.push((u as { resourceUri: vscode.Uri }).resourceUri); }
  };
  if (Array.isArray(args) && args.length) { args.forEach(add); } else { add(arg); }
  const media = out.filter(isMedia);
  if (media.length) { return opts.many ? media : media.slice(0, 1); }
  if (!out.length && state.activeEditorUri && !opts.video) { return [state.activeEditorUri]; }
  const exts = opts.video ? VIDEO_EXT : MEDIA_EXT;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: !!opts.many, openLabel: opts.title ?? 'Select',
    filters: { [opts.video ? 'Video' : 'Audio / video']: exts, 'All files': ['*'] },
  });
  return picked ?? [];
}

export async function announce(files: string[], verb = 'Created'): Promise<void> {
  if (!files.length) { return; }
  state.created.fire(files);
  const label = files.length === 1 ? path.basename(files[0]) : `${files.length} files in ${path.basename(path.dirname(files[0]))}`;
  const actions = files.length === 1 ? ['Open', 'Reveal'] : ['Reveal'];
  const pick = await vscode.window.showInformationMessage(`${verb} ${label}`, ...actions);
  const uri = vscode.Uri.file(files[0]);
  if (pick === 'Open') { await openMedia(uri); }
  if (pick === 'Reveal') { await vscode.commands.executeCommand('revealFileInOS', uri); }
}

export async function openMedia(uri: vscode.Uri): Promise<void> {
  const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
  if (AUDIO_EXT.includes(ext)) { await vscode.commands.executeCommand('vscode.openWith', uri, 'soundLab.audioPreview'); }
  else { await vscode.commands.executeCommand('vscode.open', uri); }
}

export async function askNumber(prompt: string, value: number | string, validate?: (n: number) => string | undefined): Promise<number | undefined> {
  const r = await vscode.window.showInputBox({
    prompt, value: String(value),
    validateInput: v => { const n = Number(v); if (v.trim() === '' || isNaN(n)) { return 'Enter a number'; } return validate?.(n); },
  });
  return r === undefined ? undefined : Number(r);
}

export function storageDir(...sub: string[]): string {
  const d = path.join(state.context.globalStorageUri.fsPath, ...sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
