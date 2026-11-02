// Voice cloning workflows (no vscode imports): enrollment prompts, take quality checks, reference building,
// voice profiles, and the three productions — presentation narration, audiobook, vocals over an instrumental.
// Speech generation is injected (`speak`) so the mlx-audio client or a test double can drive it.
import * as fs from 'fs';
import * as path from 'path';
import { run, runOk } from './ffmpeg';
import { parseSilence } from './analysis';
import { Segment } from './subtitles';

export type Purpose = 'presentation' | 'audiobook' | 'vocals';

/** Harvard sentences (IEEE 1969, public domain) are phonetically balanced. The last prompt matches the purpose. */
const HARVARD = [
  'The birch canoe slid on the smooth planks.',
  'Glue the sheet to the dark blue background.',
  'It is easy to tell the depth of a well.',
  'Rice is often served in round bowls.',
];
const PURPOSE_LINE: Record<Purpose, string> = {
  presentation: 'Good morning, everyone. Today I will walk you through what we built, why it matters, and what comes next.',
  audiobook: 'Chapter one. It was late in the evening when the letter finally arrived, and nobody in the house wanted to open it.',
  vocals: 'Feel the rhythm rise and fall, here we go again, one more time, all night long.',
};

export function enrollmentPrompts(purpose: Purpose): string[] {
  return [...HARVARD, PURPOSE_LINE[purpose]];
}

// ---------------------------------------------------------------- takes

export interface TakeReport { ok: boolean; duration: number; peakDb: number; meanDb: number; leadingSilence: number; warnings: string[] }

/** Measure one recorded take and say whether it is usable for cloning. */
export async function checkTake(ffmpeg: string, file: string): Promise<TakeReport> {
  const r = await run({ exe: ffmpeg, args: ['-hide_banner', '-nostdin', '-i', file, '-af', 'volumedetect,silencedetect=noise=-45dB:d=0.25', '-f', 'null', '-'] });
  const peakDb = parseFloat(/max_volume:\s*(-?[\d.]+|-inf)/.exec(r.stderr)?.[1] ?? '-inf');
  const meanDb = parseFloat(/mean_volume:\s*(-?[\d.]+|-inf)/.exec(r.stderr)?.[1] ?? '-inf');
  const dur = /time=\s*(\d+):(\d+):([\d.]+)/g;
  let duration = 0; let m: RegExpExecArray | null;
  while ((m = dur.exec(r.stderr))) { duration = +m[1] * 3600 + +m[2] * 60 + +m[3]; }
  const sil = parseSilence(r.stderr, duration);
  const leadingSilence = sil.length && sil[0].start <= 0.05 ? sil[0].end : 0;
  const voiced = duration - sil.reduce((a, s) => a + (s.end - s.start), 0);
  const warnings: string[] = [];
  if (!isFinite(peakDb) || voiced < 1.0) { warnings.push('No speech detected — check the microphone input.'); }
  else {
    if (peakDb > -0.3) { warnings.push('Clipping — move back from the microphone or lower the input gain.'); }
    if (meanDb < -42) { warnings.push('Very quiet — move closer to the microphone or raise the input gain.'); }
    if (voiced < 1.5) { warnings.push('Too short — read the whole sentence.'); }
    if (duration > 20) { warnings.push('Long take — keep each take to the one sentence.'); }
  }
  const fatal = warnings.some(w => /No speech|Clipping|Too short/.test(w));
  return { ok: !fatal, duration, peakDb, meanDb, leadingSilence, warnings };
}

/**
 * Join takes into one clean reference clip: trim silence at both ends of each take, 0.35 s gaps, rumble/noise
 * cleanup, loudness −20 LUFS, 24 kHz mono 16-bit (what most cloning models resample to anyway).
 */
export async function buildReference(ffmpeg: string, takes: string[], out: string, signal?: AbortSignal): Promise<void> {
  if (!takes.length) { throw new Error('Record at least one take first.'); }
  const args = ['-hide_banner', '-nostdin', '-y'];
  takes.forEach(t => args.push('-i', t));
  const trim = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.1,areverse';
  const parts = takes.map((_, i) => `[${i}:a]aformat=sample_fmts=fltp:sample_rates=24000:channel_layouts=mono,${trim},apad=pad_dur=0.35[t${i}]`);
  const graph = `${parts.join(';')};${takes.map((_, i) => `[t${i}]`).join('')}concat=n=${takes.length}:v=0:a=1,highpass=f=70,afftdn=nr=10:nf=-45,loudnorm=I=-20:TP=-2:LRA=11,aresample=24000[out]`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await runOk({ exe: ffmpeg, args: [...args, '-filter_complex', graph, '-map', '[out]', '-ac', '1', '-c:a', 'pcm_s16le', out], signal });
}

// ---------------------------------------------------------------- profiles

export interface VoiceProfile {
  id: string; name: string; createdAt: string; purpose: Purpose;
  reference: string;      // reference.wav (absolute)
  referenceText: string;  // what is said in reference.wav
  model: string;          // cloning-capable TTS model used for the preview
  consent: { confirmed: true; statement: string; at: string };
}

export const CONSENT_STATEMENT = 'This is my own voice, or I have the speaker\'s explicit permission to clone it.';

export function slug(s: string): string { return s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'voice'; }

export function saveProfile(voicesDir: string, p: Omit<VoiceProfile, 'id' | 'createdAt'>): VoiceProfile {
  let id = slug(p.name); let i = 2;
  while (fs.existsSync(path.join(voicesDir, id, 'profile.json'))) { id = `${slug(p.name)}-${i++}`; }
  const dir = path.join(voicesDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const ref = path.join(dir, 'reference.wav');
  if (path.resolve(p.reference) !== ref) { fs.copyFileSync(p.reference, ref); }
  fs.writeFileSync(path.join(dir, 'reference.txt'), p.referenceText + '\n');
  const profile: VoiceProfile = { ...p, id, reference: ref, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profile, null, 2));
  return profile;
}

export function listProfiles(voicesDir: string): VoiceProfile[] {
  if (!fs.existsSync(voicesDir)) { return []; }
  return fs.readdirSync(voicesDir).flatMap(d => {
    try { const p = JSON.parse(fs.readFileSync(path.join(voicesDir, d, 'profile.json'), 'utf8')) as VoiceProfile; return fs.existsSync(p.reference) ? [p] : []; }
    catch { return []; }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteProfile(voicesDir: string, id: string): void {
  const dir = path.join(voicesDir, slug(id));
  if (dir.startsWith(path.resolve(voicesDir) + path.sep)) { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- text → chunks

/** Split prose into TTS-sized chunks (sentence boundaries, ≤ maxChars), keeping paragraph breaks. */
export function chunkText(text: string, maxChars = 280): { text: string; paragraphEnd: boolean }[] {
  const out: { text: string; paragraphEnd: boolean }[] = [];
  const paras = text.replace(/\r/g, '').split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const para of paras) {
    const sentences = para.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g)?.map(s => s.trim()).filter(Boolean) ?? [para];
    let cur = '';
    const flush = () => { if (cur) { out.push({ text: cur, paragraphEnd: false }); cur = ''; } };
    for (const s of sentences) {
      if (s.length > maxChars) { // hard-wrap a run-on sentence at commas / spaces
        flush();
        let rest = s;
        while (rest.length > maxChars) {
          let cut = Math.max(rest.lastIndexOf(', ', maxChars), rest.lastIndexOf('; ', maxChars));
          if (cut < maxChars / 3) { cut = rest.lastIndexOf(' ', maxChars); }
          if (cut <= 0) { cut = maxChars; }
          out.push({ text: rest.slice(0, cut + 1).trim(), paragraphEnd: false });
          rest = rest.slice(cut + 1).trim();
        }
        cur = rest;
      } else if ((cur + ' ' + s).trim().length > maxChars) { flush(); cur = s; }
      else { cur = (cur + ' ' + s).trim(); }
    }
    flush();
    if (out.length) { out[out.length - 1].paragraphEnd = true; }
  }
  return out;
}

export interface Chapter { title: string; body: string }

/** Markdown headings (#, ##), "Chapter N" / "Part N" lines, or "---" separators start a new chapter. */
export function splitChapters(text: string): Chapter[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const chapters: Chapter[] = [];
  let cur: Chapter = { title: '', body: '' };
  const push = () => { if (cur.body.trim() || cur.title) { chapters.push({ title: cur.title || `Part ${chapters.length + 1}`, body: cur.body.trim() }); } };
  for (const l of lines) {
    const h = /^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/.exec(l) || /^\s*((?:chapter|part|prologue|epilogue)\b.{0,80})$/i.exec(l);
    if (h) { push(); cur = { title: h[1].trim(), body: '' }; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(l)) { push(); cur = { title: '', body: '' }; continue; }
    cur.body += l + '\n';
  }
  push();
  return chapters.filter(c => c.body);
}

/** Strip markdown/markup that would be read aloud. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_`~#>|]/g, '')
    .replace(/[ \t]+/g, ' ');
}

// ---------------------------------------------------------------- vocal cues

export interface VocalCue { at: number; text: string }

/**
 * Lyric / vocal-cue sheet → timed cues. One cue per line:
 *   "[1:04.5] Here we go"   absolute time
 *   "@9 Rise up"            bar 9 (needs bpm; bars are 1-based, beatsPerBar default 4)
 *   "Rise up"               untimed: placed `gapBars` after the previous cue's estimated end
 */
export function parseVocalCues(sheet: string, bpm: number, beatsPerBar = 4, startAt = 0, gapBars = 1): VocalCue[] {
  const bar = (60 / bpm) * beatsPerBar;
  const cues: VocalCue[] = [];
  let next = startAt;
  for (const raw of sheet.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) { continue; }
    let at: number | undefined; let text = line;
    const abs = /^\[(\d+:)?(\d+(?:\.\d+)?)\]\s*(.+)$/.exec(line);
    const barRef = /^@(\d+(?:\.\d+)?)\s+(.+)$/.exec(line);
    if (abs) { at = (abs[1] ? parseInt(abs[1], 10) * 60 : 0) + parseFloat(abs[2]); text = abs[3]; }
    else if (barRef) { at = (parseFloat(barRef[1]) - 1) * bar; text = barRef[2]; }
    at = at ?? next;
    cues.push({ at, text: text.trim() });
    // estimate ~2.6 words/s for spoken vocals, then quantise the next untimed cue to the bar grid
    const est = Math.max(1, text.split(/\s+/).length / 2.6);
    next = Math.ceil((at + est) / bar) * bar + gapBars * bar - bar;
    if (next <= at) { next = at + bar; }
  }
  return cues.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------- rendering

export type Speak = (text: string, out: string, signal?: AbortSignal) => Promise<void>;
export interface RenderHooks { onProgress?: (f: number, msg: string) => void; onLog?: (l: string) => void; signal?: AbortSignal }

async function duration(ffprobe: string, file: string): Promise<number> {
  const r = await runOk({ exe: ffprobe, args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file] });
  return parseFloat(r.stdout) || 0;
}

/** Synthesize chunks to numbered WAVs in `dir`. */
async function speakAll(texts: string[], dir: string, speak: Speak, h: RenderHooks, from = 0, to = 0.85): Promise<string[]> {
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (h.signal?.aborted) { throw new Error('Cancelled'); }
    const f = path.join(dir, `chunk_${String(i + 1).padStart(4, '0')}.wav`);
    h.onProgress?.(from + (to - from) * (i / texts.length), `Speaking ${i + 1}/${texts.length}: “${texts[i].slice(0, 48)}${texts[i].length > 48 ? '…' : ''}”`);
    await speak(texts[i], f, h.signal);
    files.push(f);
  }
  return files;
}

/** Concatenate WAVs with per-boundary gaps (seconds) into one 48 kHz mono stream. */
async function joinWithGaps(ffmpeg: string, files: string[], gaps: number[], out: string, post: string, codec: string[], signal?: AbortSignal): Promise<void> {
  const args = ['-hide_banner', '-nostdin', '-y'];
  files.forEach(f => args.push('-i', f));
  const parts = files.map((_, i) => `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono${gaps[i] ? `,apad=pad_dur=${gaps[i].toFixed(3)}` : ''}[c${i}]`);
  const graph = `${parts.join(';')};${files.map((_, i) => `[c${i}]`).join('')}concat=n=${files.length}:v=0:a=1${post ? `,${post}` : ''}[out]`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await runOk({ exe: ffmpeg, args: [...args, '-filter_complex', graph, '-map', '[out]', ...codec, out], signal });
}

export interface Tools { ffmpeg: string; ffprobe: string }

/**
 * Audiobook: chapters → narrated chapter MP3s mastered toward ACX (RMS −23…−18 dB, peaks ≤ −3 dB, 44.1 kHz, 192 kb/s CBR mono,
 * 0.5–1 s room tone at the head, 1–5 s at the tail) plus a combined M4B-style MP3 with chapter metadata.
 */
export async function renderAudiobook(t: Tools, text: string, outDir: string, speak: Speak, h: RenderHooks = {}): Promise<{ chapters: string[]; full: string; cues: { title: string; start: number; end: number }[] }> {
  const chapters = splitChapters(text);
  if (!chapters.length) { throw new Error('No text to narrate.'); }
  const work = path.join(outDir, '.work');
  const outs: string[] = [];
  const total = chapters.reduce((a, c) => a + chunkText(speakable(c.body)).length + 1, 0);
  let done = 0;
  for (let ci = 0; ci < chapters.length; ci++) {
    const c = chapters[ci];
    const chunks = [{ text: speakable(c.title).trim() + '.', paragraphEnd: true }, ...chunkText(speakable(c.body))];
    const files = await speakAll(chunks.map(x => x.text), path.join(work, `ch${ci + 1}`), speak, h, done / total * 0.85, (done + chunks.length) / total * 0.85);
    done += chunks.length;
    // head room tone 0.75 s, sentence 0.35 s, paragraph 0.9 s, after the title 1.5 s, tail 2.5 s
    const gaps = chunks.map((x, i) => (i === 0 ? 1.5 : i === chunks.length - 1 ? 2.5 : x.paragraphEnd ? 0.9 : 0.35));
    const out = path.join(outDir, `${String(ci + 1).padStart(2, '0')} - ${c.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 60)}.mp3`);
    h.onProgress?.(0.85 + 0.1 * (ci / chapters.length), `Mastering “${c.title}”`);
    await joinWithGaps(t.ffmpeg, files, gaps, out,
      'adelay=750:all=1,highpass=f=70,acompressor=threshold=0.1:ratio=2.5:attack=10:release=150,loudnorm=I=-19:TP=-3.5:LRA=9,alimiter=limit=0.70:level=0,aresample=44100',
      ['-ac', '1', '-c:a', 'libmp3lame', '-b:a', '192k', '-id3v2_version', '3', '-metadata', `title=${c.title}`, '-metadata', `track=${ci + 1}/${chapters.length}`], h.signal);
    outs.push(out);
  }
  // combined file with chapter markers
  const cues: { title: string; start: number; end: number }[] = [];
  let pos = 0;
  for (let i = 0; i < outs.length; i++) { const d = await duration(t.ffprobe, outs[i]); cues.push({ title: chapters[i].title, start: pos, end: pos + d }); pos += d; }
  const meta = path.join(work, 'chapters.txt');
  fs.writeFileSync(meta, ';FFMETADATA1\n' + cues.map(c => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(c.start * 1000)}\nEND=${Math.round(c.end * 1000)}\ntitle=${c.title.replace(/[=;#\\\n]/g, ' ')}\n`).join(''));
  const list = path.join(work, 'list.txt');
  fs.writeFileSync(list, outs.map(o => `file '${o.replace(/'/g, `'\\''`)}'`).join('\n'));
  const full = path.join(outDir, 'Audiobook (full).mp3');
  h.onProgress?.(0.97, 'Joining chapters');
  await runOk({ exe: t.ffmpeg, args: ['-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', meta, '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy', '-id3v2_version', '3', full], signal: h.signal });
  fs.rmSync(work, { recursive: true, force: true });
  return { chapters: outs, full, cues };
}

/**
 * Presentation: narrate timed segments (from a transcript of the recorded talk) in the cloned voice, each starting at its
 * original time (pushed later if the previous line is still speaking), or untimed script paragraphs back to back.
 * With a video, the narration is added as a new default audio track (original kept as track 2).
 */
export async function renderPresentation(t: Tools, segments: Segment[] | string, outDir: string, speak: Speak, o: { video?: string; baseName: string; lang?: string } & RenderHooks): Promise<{ narration: string; video?: string; timeline: Segment[]; pushed: number }> {
  const timed = typeof segments !== 'string';
  const items: Segment[] = timed ? (segments as Segment[]).filter(s => s.text.trim())
    : chunkText(speakable(segments as string)).map(c => ({ start: NaN, end: NaN, text: c.text, ...(c.paragraphEnd ? { speaker: 'para' } : {}) }));
  if (!items.length) { throw new Error('Nothing to narrate.'); }
  const work = path.join(outDir, `.${o.baseName}-work`);
  const files = await speakAll(items.map(s => s.text), work, speak, o, 0, 0.8);
  // lay out the timeline
  const timeline: Segment[] = []; let cursor = 0; let pushed = 0;
  for (let i = 0; i < files.length; i++) {
    const d = await duration(t.ffprobe, files[i]);
    let start = timed ? items[i].start : cursor + (i === 0 ? 0.5 : (items[i - 1] as Segment & { speaker?: string }).speaker === 'para' ? 0.9 : 0.3);
    if (start < cursor + 0.15) { if (timed) { pushed++; } start = cursor + 0.15; }
    timeline.push({ start, end: start + d, text: items[i].text });
    cursor = start + d;
  }
  const narration = path.join(outDir, `${o.baseName} (narration).wav`);
  const args = ['-hide_banner', '-nostdin', '-y'];
  files.forEach(f => args.push('-i', f));
  const parts = files.map((_, i) => `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono,adelay=${Math.round(timeline[i].start * 1000)}:all=1[n${i}]`);
  const graph = `${parts.join(';')};${files.map((_, i) => `[n${i}]`).join('')}amix=inputs=${files.length}:duration=longest:normalize=0,highpass=f=70,acompressor=threshold=0.12:ratio=2.5:attack=8:release=120,loudnorm=I=-16:TP=-1.5:LRA=9,aresample=48000[out]`;
  o.onProgress?.(0.85, 'Assembling narration');
  await runOk({ exe: t.ffmpeg, args: [...args, '-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_s24le', narration], signal: o.signal });
  let video: string | undefined;
  if (o.video) {
    video = path.join(outDir, `${o.baseName} (narrated)${/\.(mov|mkv)$/i.test(o.video) ? path.extname(o.video) : '.mp4'}`);
    o.onProgress?.(0.93, 'Adding narration track to the video');
    const mp4 = /\.(mp4|m4v|mov)$/i.test(video);
    await runOk({ exe: t.ffmpeg, signal: o.signal, args: ['-hide_banner', '-nostdin', '-y', '-i', o.video, '-i', narration, '-map', '0:v?', '-map', '1:a', '-map', '0:a?',
      '-c:v', 'copy', '-c:a:0', 'aac', '-b:a:0', '192k', '-c:a:1', 'copy', '-metadata:s:a:0', `language=${o.lang || 'und'}`, '-metadata:s:a:0', 'title=Narration (cloned voice)', '-metadata:s:a:0', 'handler_name=Narration (cloned voice)',
      '-disposition:a:0', 'default', '-disposition:a:1', '0', ...(mp4 ? ['-movflags', '+faststart'] : []), video] });
  }
  fs.rmSync(work, { recursive: true, force: true });
  return { narration, video, timeline, pushed };
}

/**
 * Vocals over an instrumental: speak each cue, process like a vocal (HPF, de-ess, compression, tempo-synced echo, optional
 * doubling), place on the timeline, gently duck the instrumental under the voice and master to −14 LUFS.
 */
export async function renderVocals(t: Tools, instrumental: string, cues: VocalCue[], bpm: number, out: string, speak: Speak, o: { doubleVoice?: boolean; vocalGainDb?: number } & RenderHooks): Promise<{ mix: string; stem: string; cues: VocalCue[] }> {
  if (!cues.length) { throw new Error('Add at least one vocal line.'); }
  const work = path.join(path.dirname(out), `.${path.parse(out).name}-work`);
  const files = await speakAll(cues.map(c => c.text), work, speak, o, 0, 0.75);
  const beatMs = Math.round(60000 / bpm);
  const args = ['-hide_banner', '-nostdin', '-y', '-i', instrumental];
  files.forEach(f => args.push('-i', f));
  const placed = files.map((_, i) => `[${i + 1}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=${Math.round(cues[i].at * 1000)}:all=1[v${i}]`);
  const vocalChain = [
    `${files.map((_, i) => `[v${i}]`).join('')}amix=inputs=${files.length}:duration=longest:normalize=0`,
    'highpass=f=110', 'deesser=i=0.4', 'acompressor=threshold=0.1:ratio=4:attack=5:release=80:makeup=2',
    `aecho=0.8:0.55:${Math.round(beatMs / 2)}|${beatMs}:0.28|0.16`,
    ...(o.doubleVoice ? ['chorus=0.6:0.85:28|36:0.35|0.3:0.4|0.5:1.6|2.1'] : []),
    `volume=${o.vocalGainDb ?? 0}dB`, 'asplit=3[vox][key][stem]',
  ].join(',');
  const graph = [
    ...placed, vocalChain,
    '[key]apad[keyp]',
    '[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[inst]',
    '[inst][keyp]sidechaincompress=threshold=0.05:ratio=3:attack=20:release=300:makeup=1[duck]',
    '[duck][vox]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1:LRA=11,aresample=48000[mix]',
  ].join(';');
  const stem = out.replace(/(\.[^.]+)$/, ' (vocal stem).wav');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  o.onProgress?.(0.85, 'Mixing vocals over the instrumental');
  const ext = path.extname(out).slice(1).toLowerCase();
  const codec = ext === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', '0'] : ext === 'flac' ? ['-c:a', 'flac'] : ['-c:a', 'pcm_s24le'];
  await runOk({ exe: t.ffmpeg, signal: o.signal, args: [...args, '-filter_complex', graph, '-map', '[mix]', ...codec, out, '-map', '[stem]', '-c:a', 'pcm_s24le', stem] });
  fs.rmSync(work, { recursive: true, force: true });
  return { mix: out, stem, cues };
}
