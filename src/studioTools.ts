// VS Code glue for the Sound Lab Studio tools (Create: instrumental, beats, chords, SFX, auto-tune, layering;
// DJ: backspin, echo out, beat jump, double drop, quick mix, long blend, mashup, acapella, instrumental).
// Engines live in core/ (no vscode); this file picks output paths, encodes in the user's format, runs jobs, and
// implements the one-click commands. The Studio panel calls run() with the parameters from its drawers.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MlxController } from './mlx';
import { cfg, tools, job, outputFor, uniquePath, defaultEncode, sameFormatEncode, announce, resolveTargets, state, Reporter } from './util';
import { codecArgs, formatFromPath, Format } from './core/recipes';
import * as C from './core/composer';
import { renderSfx, SFX } from './core/sfx';
import { autoTune } from './core/autotune';
import * as D from './core/dj';
import { detectKey } from './core/beatgrid';
import { decode, encode, durationOf } from './core/audioio';
import { formatTimecode, parseTimecode } from './core/ffmpeg';

export type CreateTool = 'instrumental' | 'beats' | 'chords' | 'sfx' | 'autotune' | 'layer';
export type DjTool = 'backspin' | 'echoout' | 'beatjump' | 'doubledrop' | 'quickmix' | 'longblend' | 'mashup' | 'acapella' | 'novocals';
export type Tool = CreateTool | DjTool;
export interface ToolResult { tool: Tool; file: string; files?: string[]; seconds: number; detail: string }
export interface Analysis { file: string; bpm: number; key: string; scale: string; camelot: string; duration: number; downbeat: number }

export const DJ_LABELS: Record<DjTool, string> = {
  backspin: 'Backspin', echoout: 'Echo out', beatjump: 'Beat jump', doubledrop: 'Double drop', quickmix: 'Quick mix',
  longblend: 'Long blend', mashup: 'Mashup', acapella: 'Acapella', novocals: 'Instrumental',
};

type P = Record<string, unknown>;
const num = (v: unknown, d?: number): number | undefined => { const n = typeof v === 'string' ? (v.trim() === '' || v === 'auto' ? NaN : (v.includes(':') ? parseTimecode(v) : Number(v))) : typeof v === 'number' ? v : NaN; return isFinite(n) ? n : d; };
const str = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d);

export class StudioTools {
  private cache = new Map<string, D.Analysed>();
  constructor(private mlx: MlxController) {}

  // ------------------------------------------------------------ paths & formats
  /** Where newly created material goes: soundLab.studio.outputDirectory, else <workspace>/sound-lab-studio, else ~/Sound Lab/Studio. */
  outDir(kind: string): string {
    const custom = cfg().get<string>('studio.outputDirectory') || '';
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const base = custom ? (path.isAbsolute(custom) ? custom : path.join(ws ?? os.homedir(), custom)) : ws ? path.join(ws, 'sound-lab-studio') : path.join(os.homedir(), 'Sound Lab', 'Studio');
    const d = path.join(base, kind);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  private newFile(kind: string, name: string): { file: string; codec: string[] } {
    const enc = defaultEncode();
    const ext = enc.format === 'aiff' ? 'aif' : enc.format;
    return { file: uniquePath(path.join(this.outDir(kind), `${name}.${ext}`)), codec: codecArgs({ ...enc, sampleRate: enc.format === 'opus' ? 48000 : enc.sampleRate }) };
  }
  /** Edits of an existing track keep its format and bit depth (at 48 kHz, the DJ engine's rate). */
  private editFile(src: string, suffix: string): { file: string; codec: string[] } {
    const enc = sameFormatEncode(src);
    const f: Format = formatFromPath(src) ?? enc.format;
    const ext = f === 'aiff' ? 'aif' : f;
    return { file: outputFor(src, suffix, ext), codec: codecArgs({ ...enc, format: f, sampleRate: undefined }) };
  }

  // ------------------------------------------------------------ analysis
  private async analysed(file: string, bpm?: number, signal?: AbortSignal): Promise<D.Analysed> {
    const st = fs.statSync(file);
    const key = `${file}|${st.mtimeMs}|${bpm ?? ''}`;
    let a = this.cache.get(key);
    if (!a) {
      a = await D.analyse(tools(), file, { bpm, key: true, signal });
      this.cache.set(key, a);
      while (this.cache.size > 3) { this.cache.delete(this.cache.keys().next().value as string); }
    }
    return a;
  }
  async analyse(file: string, bpm?: number): Promise<Analysis> {
    const a = await this.analysed(file, bpm);
    return { file, bpm: a.grid.bpm, key: a.key!.key, scale: a.key!.scale, camelot: a.key!.camelot, duration: a.grid.duration, downbeat: a.grid.downbeats[0] ?? 0 };
  }

  // ------------------------------------------------------------ run a tool with drawer parameters
  async run(tool: Tool, p: P, report: Reporter, signal: AbortSignal): Promise<ToolResult> {
    const t = tools();
    const groove = { bpm: num(p.bpm, 100)!, key: str(p.key, 'C'), scale: str(p.scale, 'minor'), bars: Math.max(1, Math.min(128, num(p.bars, 8)!)), seed: num(p.seed, 1) };
    const tag = `${groove.bpm}bpm-${groove.key.replace('#', 's')}${groove.scale === 'minor' ? 'm' : groove.scale === 'major' ? '' : '-' + groove.scale}`;
    switch (tool) {
      case 'instrumental': {
        const genre = str(p.genre, 'lofi');
        const { file, codec } = this.newFile('instrumentals', `${genre}-${tag}`);
        report(0.2, `Composing ${C.GENRES[genre]?.label ?? genre}…`);
        const r = await C.renderInstrumental(t, { ...groove, genre, progression: str(p.progression, '') || undefined, arrangement: p.arrangement === 'song' ? 'song' : 'loop', lead: p.lead !== false, swing: num(p.swing) }, file, { codec, signal });
        return { tool, file, seconds: r.seconds, detail: r.detail };
      }
      case 'beats': {
        const style = str(p.style, 'boombap');
        const { file, codec } = this.newFile('beats', `${style}-${groove.bpm}bpm`);
        report(0.2, `Programming ${C.BEAT_STYLES[style]?.label ?? style}…`);
        const r = await C.renderBeats(t, { ...groove, style, fill: p.fill !== false, humanize: p.humanize !== false, swing: num(p.swing) }, file, { codec, signal });
        return { tool, file, seconds: r.seconds, detail: r.detail };
      }
      case 'chords': {
        const { file, codec } = this.newFile('chords', `chords-${str(p.instrument, 'ep')}-${tag}`);
        report(0.2, 'Voicing chords…');
        const r = await C.renderChords(t, { ...groove, progression: str(p.progression, 'pop'), instrument: str(p.instrument, 'ep') as never, rhythm: str(p.rhythm, 'sustain') as C.ChordRhythm, barsPerChord: num(p.barsPerChord, 1) }, file, { codec, signal });
        return { tool, file, seconds: r.seconds, detail: r.detail };
      }
      case 'sfx': {
        const name = str(p.effect, 'riser');
        const { file, codec } = this.newFile('sfx', name);
        report(0.2, `Synthesizing ${SFX[name]?.label ?? name}…`);
        const r = await renderSfx(t.ffmpeg, name, file, { bars: num(p.sfxBars), bpm: groove.bpm, duration: num(p.duration), semitones: num(p.semitones, 0), codec, signal });
        return { tool, file, seconds: r.seconds, detail: r.detail };
      }
      case 'autotune': {
        const src = this.need(p.track, 'Choose a vocal track to auto-tune.');
        let key = str(p.key, ''), scale = str(p.scale, '');
        if (!key || p.detectKey === true) { report(0.05, 'Detecting key…'); const k = detectKey(await decode(t.ffmpeg, src, { signal })); key = k.key; scale = k.scale; }
        const { file, codec } = this.editFile(src, 'autotuned');
        const r = await autoTune(t, src, file, { key, scale: scale || 'major', retuneMs: num(p.retune, 40), amount: (num(p.amount, 100)!) / 100, codec, signal, onProgress: report });
        return { tool, file, seconds: await durationOf(t.ffprobe, file), detail: r.detail };
      }
      case 'layer': {
        const target = this.need(p.target, 'Choose the track to layer onto.');
        const part = this.need(p.part, 'Generate or choose a part to layer first.');
        const { file, codec } = this.editFile(target, `with-${path.parse(part).name}`.slice(0, 60));
        report(0.3, 'Layering…');
        const r = await C.layerOnto(t, target, part, file, { loop: p.loop !== false, duck: p.duck === true, gainDb: num(p.gain, 0), offset: num(p.offset, 0), codec, signal });
        return { tool, file, seconds: r.seconds, detail: r.detail };
      }
      default: return this.dj(tool, p, report, signal);
    }
  }

  private need(v: unknown, msg: string): string {
    const f = typeof v === 'string' ? v : '';
    if (!f || !fs.existsSync(f)) { throw new Error(msg); }
    return f;
  }

  private async dj(tool: DjTool, p: P, report: Reporter, signal: AbortSignal): Promise<ToolResult> {
    const t = tools();
    const a = this.need(p.track, 'Choose a track first.');
    const bpmA = num(p.bpm);
    report(0.05, `Analysing ${path.basename(a)} (tempo, beat grid, key)…`);
    const A = ['acapella', 'novocals'].includes(tool) ? undefined : await this.analysed(a, bpmA, signal);
    const label = DJ_LABELS[tool];
    const save = async (buf: Parameters<typeof D.saveEdit>[1], suffix: string, lufs?: number): Promise<{ file: string; seconds: number }> => {
      const { file, codec } = this.editFile(a, suffix);
      report(0.85, 'Encoding…');
      await D.saveEdit(t, buf, file, { codec, signal, lufs });
      return { file, seconds: buf.length / 48000 };
    };
    switch (tool) {
      case 'backspin': {
        const r = D.backspin(A!, { at: num(p.at), beats: num(p.beats, 2), then: p.then === 'rewind' ? 'rewind' : 'stop' });
        return { tool, ...(await save(r.buf, 'backspin')), detail: r.detail };
      }
      case 'echoout': {
        const r = D.echoOut(A!, { at: num(p.at), tailBars: num(p.tailBars, 4), feedback: (num(p.feedback, 62)!) / 100, half: p.echo === 'half' });
        return { tool, ...(await save(r.buf, 'echo-out')), detail: r.detail };
      }
      case 'beatjump': {
        const beats = num(p.beats, 8)!;
        const r = D.beatJump(A!, { at: num(p.at), beats });
        return { tool, ...(await save(r.buf, `jump${beats > 0 ? '+' : ''}${beats}`)), detail: r.detail };
      }
      case 'quickmix': case 'longblend': case 'doubledrop': case 'mashup': {
        const b = this.need(p.trackB, `${label} needs a second track.`);
        report(0.25, `Matching ${path.basename(b)} to ${A!.grid.bpm} BPM…`);
        if (tool === 'mashup') { return this.mashup(A!, b, p, report, signal); }
        const B = await D.analyseMatched(t, b, A!.grid.bpm, { bpm: num(p.bpmB), signal });
        report(0.6, `${label}…`);
        const r = tool === 'doubledrop'
          ? D.doubleDrop(A!, B, { dropA: num(p.dropA), dropB: num(p.dropB) !== undefined ? num(p.dropB)! / B.ratio : undefined, dropBars: num(p.dropBars, 16) })
          : D.transition(A!, B, { style: tool === 'quickmix' ? 'quick' : 'long', at: num(p.at), cue: num(p.cue) !== undefined ? num(p.cue)! / B.ratio : undefined, bars: num(p.mixBars) });
        const out = await save(r.buf, `${tool === 'doubledrop' ? 'double-drop' : tool === 'quickmix' ? 'quick-mix' : 'long-blend'}-${path.parse(b).name}`.slice(0, 70));
        return { tool, ...out, detail: `${r.detail}${B.ratio !== 1 ? ` · B stretched ${B.srcBpm} → ${A!.grid.bpm} BPM` : ''}` };
      }
      case 'acapella': case 'novocals': {
        const sep = await this.separate(a, report, signal);
        const keep = tool === 'acapella' ? sep.acapella : sep.instrumental;
        const other = tool === 'acapella' ? sep.instrumental : sep.acapella;
        const r = { tool, file: keep, files: [keep, other], seconds: await durationOf(t.ffprobe, keep), detail: `${label} via ${sep.engine}` };
        return r;
      }
    }
  }

  /** Vocals/instrumental split: mlx-audio (AI) when its server is up or chosen; otherwise the center-channel extractor. */
  async separate(src: string, report: Reporter, signal: AbortSignal): Promise<{ acapella: string; instrumental: string; engine: string }> {
    const t = tools();
    const mode = cfg().get<string>('dj.separation') || 'auto';
    const acap = this.editFile(src, 'acapella'), inst = this.editFile(src, 'instrumental');
    const up = mode !== 'center' && (await this.mlx.client.health()).reachable;
    if (mode === 'mlx' || up) {
      report(0.15, 'Separating vocals with mlx-audio…');
      const client = await this.mlx.ensure(signal);
      const r = await client.separate(src, { description: 'vocals', model: cfg().get<string>('mlx.separationModel') || undefined, signal });
      const tmpA = path.join(os.tmpdir(), `soundlab-sep-${Date.now()}-a.wav`), tmpI = tmpA.replace('-a.wav', '-i.wav');
      fs.writeFileSync(tmpA, r.target); fs.writeFileSync(tmpI, r.residual);
      try {
        await encode(t, await decode(t.ffmpeg, tmpA, { signal }), acap.file, acap.codec, signal);
        await encode(t, await decode(t.ffmpeg, tmpI, { signal }), inst.file, inst.codec, signal);
      } finally { fs.rmSync(tmpA, { force: true }); fs.rmSync(tmpI, { force: true }); }
      return { acapella: acap.file, instrumental: inst.file, engine: 'mlx-audio separation' };
    }
    report(0.2, 'Extracting the center channel (stereo vocal isolation)…');
    const buf = await decode(t.ffmpeg, src, { signal });
    const sp = D.centerSplit(buf);
    report(0.8, 'Encoding stems…');
    await D.saveEdit(t, sp.acapella, acap.file, { codec: acap.codec, signal });
    await D.saveEdit(t, sp.instrumental, inst.file, { codec: inst.codec, signal });
    return { acapella: acap.file, instrumental: inst.file, engine: 'center-channel extraction (start mlx-audio for AI separation)' };
  }

  private async mashup(A: D.Analysed, bFile: string, p: P, report: Reporter, signal: AbortSignal): Promise<ToolResult> {
    const t = tools();
    // A provides the vocals, B the instrumental (either may already be a stem)
    report(0.2, 'Preparing the instrumental…');
    const instFile = p.bIsInstrumental === true ? bFile : (await this.separate(bFile, (f, m) => report(0.2 + f * 0.25, m), signal)).instrumental;
    const vocFile = p.aIsAcapella === true ? A.file : (await this.separate(A.file, (f, m) => report(0.45 + f * 0.25, m), signal)).acapella;
    const inst = await this.analysed(bFile, num(p.bpmB), signal);
    const instA: D.Analysed = { ...inst, file: instFile, buf: instFile === bFile ? inst.buf : await decode(t.ffmpeg, instFile, { signal }) };
    let semis = num(p.semitones, 0)!;
    if (p.keyMatch === true && A.key && inst.key) { semis = D.keyShift(A.key, inst.key); }
    report(0.75, `Matching vocals to ${inst.grid.bpm} BPM${semis ? `, ${semis > 0 ? '+' : ''}${semis} st` : ''}…`);
    const voc = await D.analyseMatched(t, vocFile, inst.grid.bpm, { bpm: A.grid.bpm, semitones: semis, signal });
    // the acapella shares the original song's grid (detected on the full mix, where the beat is)
    voc.grid = D.rescaleGrid(A.grid, voc.ratio, inst.grid.bpm, voc.buf.length / 48000);
    const r = D.mashup(voc, instA, { offsetBars: num(p.offsetBars, 0), vocalGainDb: num(p.vocalGain, 0) });
    const { file, codec } = this.editFile(A.file, `mashup-${path.parse(bFile).name}`.slice(0, 60));
    report(0.9, 'Mastering…');
    await D.saveEdit(t, r.buf, file, { codec, signal, lufs: -14 });
    return { tool: 'mashup', file, seconds: r.buf.length / 48000, detail: r.detail + (semis ? ` · vocals ${semis > 0 ? '+' : ''}${semis} st` : '') };
  }

  // ------------------------------------------------------------ one-click commands (palette, explorer, editor)
  async exec(tool: Tool, title: string, p: P): Promise<ToolResult | undefined> {
    const r = await job(title, (report, signal) => this.run(tool, p, report, signal));
    if (r) { await announce(r.files ?? [r.file], r.tool === 'acapella' || r.tool === 'novocals' ? 'Separated into' : 'Created'); }
    return r;
  }

  /** DJ command entry point: `args` may carry {at} from the audio editor's playhead, or be the explorer multi-selection. */
  async cmdDj(tool: DjTool, arg?: unknown, args?: unknown): Promise<void> {
    const extra = args && !Array.isArray(args) && typeof args === 'object' && !(args instanceof vscode.Uri) ? args as P : {};
    const two = ['doubledrop', 'quickmix', 'longblend', 'mashup'].includes(tool);
    const files = await resolveTargets(arg, Array.isArray(args) ? args : undefined, { many: two, title: tool === 'mashup' ? 'Vocals from' : DJ_LABELS[tool] });
    if (!files.length) { return; }
    const p: P = { track: files[0].fsPath, ...extra };
    if (two) {
      let b = files[1];
      if (!b) {
        const picked = await vscode.window.showOpenDialog({ openLabel: tool === 'mashup' ? 'Instrumental from' : 'Mix into', filters: { Audio: ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aif', 'aiff', 'opus'] } });
        if (!picked?.length) { return; }
        b = picked[0];
      }
      p.trackB = b.fsPath;
      if (tool === 'mashup') { p.keyMatch = true; }
    }
    if (tool === 'beatjump' && extra.beats === undefined) {
      const pick = await vscode.window.showQuickPick(['+1', '+2', '+4', '+8', '+16', '+32', '−1', '−2', '−4', '−8', '−16', '−32'].map(l => ({ label: `${l} beats`, beats: Number(l.replace('−', '-')) })), { placeHolder: `Jump from ${typeof extra.at === 'number' ? formatTimecode(extra.at as number) : 'the next phrase'} by…` });
      if (!pick) { return; }
      p.beats = pick.beats;
    }
    await this.exec(tool, `${DJ_LABELS[tool]} · ${path.basename(files[0].fsPath)}`, p);
  }

  async cmdAutoTune(arg?: unknown, args?: unknown): Promise<void> {
    const [u] = await resolveTargets(arg, args, { title: 'Auto-tune' });
    if (!u) { return; }
    const style = await vscode.window.showQuickPick([
      { label: '$(pulse) Natural', description: '40 ms retune, key detected', retune: 40 },
      { label: '$(zap) Hard tune', description: '0 ms — the robotic snap', retune: 0 },
      { label: '$(heart) Gentle', description: '150 ms — keeps vibrato', retune: 150 },
    ], { placeHolder: `Auto-tune ${path.basename(u.fsPath)}` });
    if (!style) { return; }
    await this.exec('autotune', `Auto-tune · ${path.basename(u.fsPath)}`, { track: u.fsPath, retune: style.retune, amount: 100 });
  }

  async cmdDetect(arg?: unknown, args?: unknown): Promise<void> {
    const [u] = await resolveTargets(arg, args, { title: 'Detect tempo & key' });
    if (!u) { return; }
    const a = await job(`Detecting tempo & key · ${path.basename(u.fsPath)}`, async () => this.analyse(u.fsPath));
    if (!a) { return; }
    state.output.appendLine(`${path.basename(u.fsPath)}: ${a.bpm} BPM, ${a.key} ${a.scale} (${a.camelot}), first downbeat ${formatTimecode(a.downbeat)}`);
    const pick = await vscode.window.showInformationMessage(`${path.basename(u.fsPath)}: ${a.bpm} BPM · ${a.key} ${a.scale} (${a.camelot})`, 'Copy');
    if (pick) { await vscode.env.clipboard.writeText(`${a.bpm} BPM, ${a.key} ${a.scale} (${a.camelot})`); }
  }
}
