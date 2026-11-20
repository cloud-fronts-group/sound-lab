// Simultaneous screen/slide recording, rolling live transcription, concurrent voice cloning, and video tutorial assembly.
// Pure Node (no vscode imports) so it can be unit-tested end-to-end with real ffmpeg and a mock mlx-audio server.
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { run, runOk } from './ffmpeg';
import { muxSubtitles, muxTutorialTracks, recordInput, recordScreen, ScreenRecordOptions, slidesToVideo } from './recipes';
import { writeSlidePngs } from './pngSlides';
import { PresentationSpec, writeTranscriptSidecars } from './presentation';
import { Segment } from './subtitles';
import { Speak, Tools } from './voiceClone';

export type TranscribeChunkFn = (wavPath: string, signal?: AbortSignal) => Promise<{ text: string; language?: string; segments: Segment[] }>;

export interface SlideMark {
  slideIndex: number; // 0-based
  title: string;
  atSeconds: number;
}

export interface LiveTutorialOptions {
  tools: Tools;
  outDir: string;
  baseName: string;
  mode: 'screen' | 'slides';
  platform?: NodeJS.Platform;
  videoFormat?: string;
  videoDevice?: string;
  audioFormat?: string;
  audioDevice?: string;
  fps?: number;
  chunkSeconds?: number;
  lang?: string;
  presentation?: PresentationSpec;
  transcribeChunk: TranscribeChunkFn;
  speak?: Speak;
  onLog?: (line: string) => void;
}

export interface LiveTutorialResult {
  video: string;
  rawCapture: string;
  narration?: string;
  segments: Segment[];
  transcripts: string[];
  slideMarks: SlideMark[];
}

export class LiveTutorialSession extends EventEmitter {
  private ac = new AbortController();
  private chunkDir: string;
  private rawCapture: string;
  private rawAudioPath: string;
  private ffmpegPromise?: Promise<unknown>;
  private pollTimer?: NodeJS.Timeout;
  private processingQueue: Promise<void> = Promise.resolve();
  private processedChunks = new Set<number>();
  private segments: Segment[] = [];
  private clonedChunks: { index: number; start: number; text: string; file: string }[] = [];
  private slideMarks: SlideMark[] = [];
  private startedAt = 0;
  private detectedLanguage?: string;
  private stopped = false;

  constructor(private opts: LiveTutorialOptions) {
    super();
    fs.mkdirSync(opts.outDir, { recursive: true });
    this.chunkDir = path.join(opts.outDir, `.${opts.baseName}-live-chunks`);
    fs.mkdirSync(this.chunkDir, { recursive: true });
    this.rawCapture = path.join(opts.outDir, `${opts.baseName} (raw-capture).mp4`);
    this.rawAudioPath = path.join(opts.outDir, `${opts.baseName} (mic).wav`);
    if (opts.presentation?.slides?.length) {
      this.slideMarks.push({ slideIndex: 0, title: opts.presentation.slides[0].title, atSeconds: 0 });
    }
  }

  get elapsedSeconds(): number {
    return this.startedAt ? Math.max(0, (Date.now() - this.startedAt) / 1000) : 0;
  }

  /** Record a live slide transition while presenting slides. */
  markSlide(slideIndex: number, title?: string): SlideMark {
    const t = this.elapsedSeconds;
    const label = title ?? this.opts.presentation?.slides?.[slideIndex]?.title ?? `Slide ${slideIndex + 1}`;
    const mark: SlideMark = { slideIndex, title: label, atSeconds: Math.round(t * 100) / 100 };
    this.slideMarks.push(mark);
    this.emit('slideMarked', mark);
    return mark;
  }

  /** Start recording screen (or mic for live slide presentation) and live rolling transcription + voice cloning. */
  async start(maxSeconds = 0): Promise<void> {
    if (this.ffmpegPromise) { throw new Error('Live tutorial session already started.'); }
    this.startedAt = Date.now();
    const chunkSeconds = Math.max(2, this.opts.chunkSeconds ?? 6);
    const platform = this.opts.platform ?? process.platform;
    let args: string[];

    if (this.opts.mode === 'screen') {
      const recOpts: ScreenRecordOptions = {
        platform,
        videoFormat: this.opts.videoFormat,
        videoDevice: this.opts.videoDevice,
        audioFormat: this.opts.audioFormat,
        audioDevice: this.opts.audioDevice,
        fps: this.opts.fps ?? 24,
        seconds: maxSeconds,
        chunkDir: this.chunkDir,
        chunkSeconds,
      };
      args = recordScreen(this.rawCapture, recOpts);
    } else {
      // Slides presenter mode: record mic + rolling 16 kHz mono WAV chunks for live STT & voice cloning.
      const aFmt = this.opts.audioFormat || (platform === 'darwin' ? 'avfoundation' : platform === 'win32' ? 'dshow' : 'pulse');
      const inputArgs = aFmt === 'lavfi'
        ? ['-re', '-f', 'lavfi', '-i', this.opts.audioDevice || 'sine=f=330:r=16000']
        : recordInput(platform, aFmt, this.opts.audioDevice || '');
      const pattern = path.join(this.chunkDir, 'chunk_%04d.wav');
      args = [
        '-hide_banner', '-y', ...inputArgs,
        ...(maxSeconds > 0 ? ['-t', String(maxSeconds)] : []),
        '-map', '0:a:0', '-c:a', 'pcm_s24le', '-ar', '48000', this.rawAudioPath,
        '-map', '0:a:0', '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
        '-f', 'segment', '-segment_time', String(chunkSeconds), '-reset_timestamps', '1', pattern,
      ];
    }

    this.opts.onLog?.(`$ ${this.opts.tools.ffmpeg} ${args.join(' ')}`);
    this.ffmpegPromise = runOk({
      exe: this.opts.tools.ffmpeg,
      args,
      signal: this.ac.signal,
      gracefulStop: true,
      onLog: l => this.opts.onLog?.(l),
    });

    this.pollTimer = setInterval(() => this.scanChunks(false), 750);
    this.pollTimer.unref?.();
    this.emit('started', { mode: this.opts.mode, chunkDir: this.chunkDir });
  }

  private listChunkIndices(): number[] {
    if (!fs.existsSync(this.chunkDir)) { return []; }
    return fs.readdirSync(this.chunkDir)
      .map(f => /^chunk_(\d+)\.wav$/.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map(m => parseInt(m[1], 10))
      .sort((a, b) => a - b);
  }

  private scanChunks(finalDrain: boolean): void {
    const indices = this.listChunkIndices();
    if (!indices.length) { return; }
    const maxIdx = indices[indices.length - 1];
    for (const idx of indices) {
      if (this.processedChunks.has(idx)) { continue; }
      // While recording, chunk N is guaranteed flushed & closed once chunk N+1 exists.
      if (!finalDrain && idx >= maxIdx) { continue; }
      this.processedChunks.add(idx);
      this.processingQueue = this.processingQueue.then(() => this.processChunk(idx)).catch(err => {
        this.emit('warning', `Chunk ${idx} failed: ${(err as Error).message}`);
      });
    }
  }

  private async processChunk(idx: number): Promise<void> {
    const chunkFile = path.join(this.chunkDir, `chunk_${String(idx).padStart(4, '0')}.wav`);
    if (!fs.existsSync(chunkFile) || fs.statSync(chunkFile).size < 1024) { return; }
    const chunkSeconds = Math.max(2, this.opts.chunkSeconds ?? 6);
    const offset = idx * chunkSeconds;

    const tr = await this.opts.transcribeChunk(chunkFile);
    if (tr.language && !this.detectedLanguage) { this.detectedLanguage = tr.language; }
    const chunkSegs: Segment[] = tr.segments.length
      ? tr.segments.filter(s => s.text.trim()).map(s => ({ start: offset + s.start, end: offset + s.end, text: s.text.trim() }))
      : tr.text.trim() ? [{ start: offset, end: offset + chunkSeconds, text: tr.text.trim() }] : [];
    if (!chunkSegs.length) { return; }

    this.segments.push(...chunkSegs);
    this.segments.sort((a, b) => a.start - b.start);

    // Continuously persist live transcript sidecars while recording!
    const liveBase = path.join(this.opts.outDir, `${this.opts.baseName} (transcript)`);
    const sidecars = writeTranscriptSidecars(liveBase, this.segments, {
      source: this.opts.baseName,
      backend: 'mlx-audio-live',
      language: this.detectedLanguage || this.opts.lang,
    });
    this.emit('transcript', { chunkIndex: idx, added: chunkSegs, segments: [...this.segments], sidecars });

    // Synthesize cloned voice narration concurrently if enabled.
    if (this.opts.speak) {
      const text = chunkSegs.map(s => s.text).join(' ').trim();
      if (text) {
        const clonedOut = path.join(this.chunkDir, `cloned_${String(idx).padStart(4, '0')}.wav`);
        await this.opts.speak(text, clonedOut);
        this.clonedChunks.push({ index: idx, start: chunkSegs[0].start, text, file: clonedOut });
        this.emit('cloned', { chunkIndex: idx, file: clonedOut, text, start: chunkSegs[0].start });
      }
    }
  }

  /** Stop recording gracefully, finish any final audio chunks, and produce the final MP4 tutorial with cloned voice & embedded transcript. */
  async stopAndFinalize(): Promise<LiveTutorialResult> {
    if (this.stopped) { throw new Error('Already finalized.'); }
    this.stopped = true;
    const totalRecordingSec = Math.max(1, this.elapsedSeconds);
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    this.ac.abort();
    if (this.ffmpegPromise) {
      await this.ffmpegPromise.catch(() => undefined);
    }

    // Drain any final partial chunk after ffmpeg flushes & closes files.
    this.scanChunks(true);
    await this.processingQueue;

    const lang = this.detectedLanguage || this.opts.lang || 'eng';
    const transcriptBase = path.join(this.opts.outDir, `${this.opts.baseName} (transcript)`);
    let finalSegments = [...this.segments];
    let narration: string | undefined;

    if (this.opts.speak && this.clonedChunks.length) {
      // Lay out cloned chunks so they never overlap, mirroring renderPresentation().
      this.clonedChunks.sort((a, b) => a.index - b.index);
      const placed: { file: string; start: number; end: number; text: string }[] = [];
      let cursor = 0;
      for (const c of this.clonedChunks) {
        const probeRes = await runOk({ exe: this.opts.tools.ffprobe, args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', c.file] });
        const d = parseFloat(probeRes.stdout) || 1;
        const start = Math.max(c.start, cursor + 0.15);
        placed.push({ file: c.file, start, end: start + d, text: c.text });
        cursor = start + d;
      }
      if (placed.length) {
        narration = path.join(this.opts.outDir, `${this.opts.baseName} (narration).wav`);
        const args = ['-hide_banner', '-nostdin', '-y'];
        placed.forEach(p => args.push('-i', p.file));
        const parts = placed.map((p, i) => `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono,adelay=${Math.round(p.start * 1000)}:all=1[n${i}]`);
        const graph = `${parts.join(';')};${placed.map((_, i) => `[n${i}]`).join('')}amix=inputs=${placed.length}:duration=longest:normalize=0,highpass=f=70,acompressor=threshold=0.12:ratio=2.5:attack=8:release=120,loudnorm=I=-16:TP=-1.5:LRA=9,aresample=48000[out]`;
        await runOk({ exe: this.opts.tools.ffmpeg, args: [...args, '-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_s24le', narration] });
        finalSegments = placed.map(p => ({ start: p.start, end: p.end, text: p.text }));
      }
    }

    const transcripts = finalSegments.length
      ? writeTranscriptSidecars(transcriptBase, finalSegments, { source: this.opts.baseName, backend: 'mlx-audio-live', language: lang })
      : [];
    const srtPath = transcripts.find(f => f.endsWith('.srt'));

    const finalVideo = path.join(this.opts.outDir, `${this.opts.baseName} (tutorial).mp4`);
    if (this.opts.mode === 'screen') {
      if (narration) {
        await runOk({
          exe: this.opts.tools.ffmpeg,
          args: muxTutorialTracks(this.rawCapture, narration, srtPath, finalVideo, { language: lang, keepOriginalAudio: true }),
        });
      } else if (srtPath) {
        await runOk({
          exe: this.opts.tools.ffmpeg,
          args: muxSubtitles(this.rawCapture, srtPath, finalVideo, lang),
        });
      } else {
        fs.copyFileSync(this.rawCapture, finalVideo);
      }
    } else {
      // Build timed slide frames from the live SlideMarks recorded during presentation!
      const slides = this.opts.presentation?.slides?.length
        ? this.opts.presentation.slides
        : [{ index: 1, title: this.opts.baseName, durationSec: totalRecordingSec, bullets: [this.opts.baseName], narration: '' }];
      const marks = this.slideMarks.length ? this.slideMarks : [{ slideIndex: 0, title: slides[0].title, atSeconds: 0 }];
      const audioTrack = narration || this.rawAudioPath;
      let totalDur = totalRecordingSec;
      if (fs.existsSync(audioTrack)) {
        const pDur = await runOk({ exe: this.opts.tools.ffprobe, args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioTrack] });
        totalDur = Math.max(totalDur, parseFloat(pDur.stdout) || 0);
      }
      const framesDir = path.join(this.opts.outDir, 'slides-frames');
      const pngs = writeSlidePngs(
        slides.map((s, si) => ({ index: si + 1, total: slides.length, title: s.title, bullets: s.bullets, codeSnippet: s.codeSnippet, presentationTitle: this.opts.presentation?.title || this.opts.baseName })),
        framesDir,
      );
      const concatFile = path.join(this.chunkDir, 'live-slides.ffconcat');
      const lines = ['ffconcat version 1.0'];
      for (let i = 0; i < marks.length; i++) {
        const cur = marks[i];
        const nextAt = i + 1 < marks.length ? marks[i + 1].atSeconds : totalDur;
        const dur = Math.max(0.5, nextAt - cur.atSeconds);
        const png = pngs[Math.min(pngs.length - 1, Math.max(0, cur.slideIndex))];
        lines.push(`file '${png.replace(/'/g, `'\\''`)}'`, `duration ${dur.toFixed(3)}`);
      }
      const lastPng = pngs[Math.min(pngs.length - 1, Math.max(0, marks[marks.length - 1].slideIndex))];
      lines.push(`file '${lastPng.replace(/'/g, `'\\''`)}'`);
      fs.writeFileSync(concatFile, lines.join('\n') + '\n');
      await runOk({
        exe: this.opts.tools.ffmpeg,
        args: slidesToVideo(concatFile, audioTrack, finalVideo, { subtitles: srtPath, language: lang }),
      });
    }

    fs.rmSync(this.chunkDir, { recursive: true, force: true });
    const res: LiveTutorialResult = {
      video: finalVideo,
      rawCapture: this.opts.mode === 'screen' ? this.rawCapture : this.rawAudioPath,
      narration,
      segments: finalSegments,
      transcripts,
      slideMarks: [...this.slideMarks],
    };
    this.emit('completed', res);
    return res;
  }
}
