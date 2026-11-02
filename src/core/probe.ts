import { runOk } from './ffmpeg';

export interface StreamInfo {
  index: number;
  codec_type: string;
  codec_name?: string;
  codec_long_name?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  sample_fmt?: string;
  bits_per_sample?: number;
  bits_per_raw_sample?: string;
  bit_rate?: string;
  duration?: string;
  width?: number;
  height?: number;
  tags?: Record<string, string>;
}

export interface ProbeResult {
  format: {
    filename: string;
    format_name: string;
    format_long_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
  streams: StreamInfo[];
  chapters?: { start_time: string; end_time: string; tags?: Record<string, string> }[];
}

export interface AudioSummary {
  duration: number;
  codec: string;
  sampleRate: number;
  channels: number;
  channelLayout: string;
  bitDepth?: number;
  bitRate?: number;
  container: string;
  size?: number;
  hasVideo: boolean;
  tags: Record<string, string>;
}

export async function probe(ffprobe: string, file: string): Promise<ProbeResult> {
  const r = await runOk({
    exe: ffprobe,
    args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file],
  });
  return JSON.parse(r.stdout) as ProbeResult;
}

export function audioStream(p: ProbeResult): StreamInfo | undefined {
  return p.streams.find(s => s.codec_type === 'audio');
}

export function bitDepthOf(s: StreamInfo): number | undefined {
  if (s.bits_per_raw_sample && +s.bits_per_raw_sample > 0) { return +s.bits_per_raw_sample; }
  if (s.bits_per_sample && s.bits_per_sample > 0) { return s.bits_per_sample; }
  const fmt = s.sample_fmt ?? '';
  if (fmt.startsWith('s16')) { return 16; }
  if (fmt.startsWith('s32') || fmt.startsWith('flt')) { return 32; }
  if (fmt.startsWith('dbl') || fmt.startsWith('s64')) { return 64; }
  if (fmt.startsWith('u8')) { return 8; }
  return undefined;
}

export function summarize(p: ProbeResult): AudioSummary {
  const a = audioStream(p);
  const duration = parseFloat(p.format.duration ?? a?.duration ?? '0') || 0;
  return {
    duration,
    codec: a?.codec_name ?? 'none',
    sampleRate: a?.sample_rate ? parseInt(a.sample_rate, 10) : 0,
    channels: a?.channels ?? 0,
    channelLayout: a?.channel_layout ?? (a?.channels === 1 ? 'mono' : a?.channels === 2 ? 'stereo' : ''),
    bitDepth: a ? bitDepthOf(a) : undefined,
    bitRate: parseInt(a?.bit_rate ?? p.format.bit_rate ?? '', 10) || undefined,
    container: p.format.format_name,
    size: parseInt(p.format.size ?? '', 10) || undefined,
    hasVideo: p.streams.some(s => s.codec_type === 'video' && !(s as { disposition?: { attached_pic?: number } }).disposition?.attached_pic),
    tags: { ...(p.format.tags ?? {}), ...(a?.tags ?? {}) },
  };
}

export function humanSize(bytes?: number): string {
  if (!bytes) { return ''; }
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/** Markdown report used by "Show Media Info". */
export function probeMarkdown(file: string, p: ProbeResult): string {
  const s = summarize(p);
  const lines: string[] = [];
  lines.push(`# ${file.split(/[\\/]/).pop()}`, '');
  lines.push('| Property | Value |', '|---|---|');
  lines.push(`| Container | ${p.format.format_long_name ?? p.format.format_name} |`);
  lines.push(`| Duration | ${s.duration.toFixed(3)} s |`);
  if (s.size) { lines.push(`| Size | ${humanSize(s.size)} |`); }
  if (p.format.bit_rate) { lines.push(`| Overall bitrate | ${Math.round(+p.format.bit_rate / 1000)} kb/s |`); }
  lines.push('');
  for (const st of p.streams) {
    lines.push(`## Stream #${st.index} — ${st.codec_type}`, '');
    lines.push('| Property | Value |', '|---|---|');
    lines.push(`| Codec | ${st.codec_long_name ?? st.codec_name ?? '?'} |`);
    if (st.codec_type === 'audio') {
      lines.push(`| Sample rate | ${st.sample_rate} Hz |`);
      lines.push(`| Channels | ${st.channels} (${st.channel_layout ?? '—'}) |`);
      lines.push(`| Sample format | ${st.sample_fmt ?? '—'} |`);
      const bd = bitDepthOf(st);
      if (bd) { lines.push(`| Bit depth | ${bd} |`); }
    }
    if (st.codec_type === 'video') { lines.push(`| Resolution | ${st.width}×${st.height} |`); }
    if (st.bit_rate) { lines.push(`| Bitrate | ${Math.round(+st.bit_rate / 1000)} kb/s |`); }
    for (const [k, v] of Object.entries(st.tags ?? {})) { lines.push(`| tag:${k} | ${String(v).replace(/\|/g, '\\|')} |`); }
    lines.push('');
  }
  const tags = Object.entries(p.format.tags ?? {});
  if (tags.length) {
    lines.push('## Metadata', '', '| Tag | Value |', '|---|---|');
    for (const [k, v] of tags) { lines.push(`| ${k} | ${String(v).replace(/\|/g, '\\|')} |`); }
    lines.push('');
  }
  if (p.chapters?.length) {
    lines.push('## Chapters', '', '| Start | End | Title |', '|---|---|---|');
    for (const c of p.chapters) { lines.push(`| ${c.start_time} | ${c.end_time} | ${c.tags?.title ?? ''} |`); }
  }
  lines.push('', '<details><summary>Raw ffprobe JSON</summary>', '', '```json', JSON.stringify(p, null, 2), '```', '</details>');
  return lines.join('\n');
}
