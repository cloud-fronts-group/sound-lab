'use strict';
// Conversion presets. Each returns ffmpeg args for one input → one output, adapting to the host:
// on Apple Silicon (hwaccel "auto") video presets use VideoToolbox and AAC uses AudioToolbox (aac_at).

/** @typedef {{caps: any, hwaccel: 'auto'|'videotoolbox'|'none', probe: any, opts: Record<string, any>}} Ctx */

const useVT = (ctx, enc = 'h264_videotoolbox') => ctx.hwaccel !== 'none' && ctx.caps.encoders.has(enc);
const aacEnc = (ctx, br) => (ctx.hwaccel !== 'none' && ctx.caps.encoders.has('aac_at')
  ? ['-c:a', 'aac_at', '-b:a', br]
  : ['-c:a', 'aac', '-b:a', br]);
const ar = (ctx, def) => { const r = ctx.opts.sample_rate || def; return r ? ['-ar', String(r)] : []; };
const ac = (ctx, def) => { const c = ctx.opts.channels || def; return c ? ['-ac', String(c)] : []; };
const vtDecode = (ctx) => (ctx.probe?.video && ctx.hwaccel !== 'none' && ctx.caps.hwaccels.has('videotoolbox') ? ['-hwaccel', 'videotoolbox'] : []);

/** Bitrate heuristic for hardware encoders that have no CRF: ~0.08 bits/pixel/frame, clamped. */
function autoVideoBitrate(probe, hevc) {
  const v = probe?.video;
  if (!v) { return '6M'; }
  const [n, d] = String(v.fps || '30/1').split('/').map(Number);
  const fps = d ? n / d : n || 30;
  const bps = v.width * v.height * fps * (hevc ? 0.05 : 0.08);
  return `${Math.round(Math.min(60e6, Math.max(1e6, bps)) / 1e5) / 10}M`;
}

/** @type {Record<string, {description: string, ext: string, kind: 'audio'|'video', loudnorm?: {I:number,TP:number,LRA:number}, build: (ctx: Ctx) => {pre: string[], post: string[]}}>} */
const PRESETS = {
  'wav-24': { description: '24-bit PCM WAV (keeps rate unless sample_rate given)', ext: 'wav', kind: 'audio', build: c => ({ pre: [], post: ['-vn', '-c:a', 'pcm_s24le', ...ar(c), ...ac(c)] }) },
  'wav-16-44k': { description: '16-bit / 44.1 kHz WAV (CD, most hardware samplers)', ext: 'wav', kind: 'audio', build: c => ({ pre: [], post: ['-vn', '-c:a', 'pcm_s16le', ...ar(c, 44100), ...ac(c)] }) },
  'wav-24-48k': { description: '24-bit / 48 kHz WAV (video post, broadcast)', ext: 'wav', kind: 'audio', build: c => ({ pre: [], post: ['-vn', '-c:a', 'pcm_s24le', ...ar(c, 48000), ...ac(c)] }) },
  flac: { description: 'FLAC lossless, level 8 (24-bit kept when the source has it)', ext: 'flac', kind: 'audio', build: c => ({ pre: [], post: ['-vn', '-c:a', 'flac', '-compression_level', '8', ...ar(c), ...ac(c)] }) },
  'aiff-24': { description: '24-bit AIFF (Logic / Apple tools)', ext: 'aiff', kind: 'audio', build: c => ({ pre: [], post: ['-vn', '-c:a', 'pcm_s24be', ...ar(c), ...ac(c)] }) },
  'mp3-v0': { description: 'MP3 LAME VBR V0 (~245 kb/s), ID3v2.3 tags kept', ext: 'mp3', kind: 'audio', build: c => ({ pre: [], post: ['-map', '0:a:0', '-map_metadata', '0', '-c:a', 'libmp3lame', '-q:a', '0', '-id3v2_version', '3', ...ar(c), ...ac(c)] }) },
  'mp3-320': { description: 'MP3 CBR 320 kb/s, ID3v2.3 tags kept', ext: 'mp3', kind: 'audio', build: c => ({ pre: [], post: ['-map', '0:a:0', '-map_metadata', '0', '-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3', ...ar(c), ...ac(c)] }) },
  'mp3-podcast': { description: 'Podcast MP3: mono 96 kb/s 44.1 kHz, loudness -16 LUFS (two-pass)', ext: 'mp3', kind: 'audio', loudnorm: { I: -16, TP: -1.5, LRA: 11 }, build: c => ({ pre: [], post: ['-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', '96k', '-ac', '1', ...ar(c, 44100), '-id3v2_version', '3'] }) },
  'aac-256': { description: 'AAC 256 kb/s in .m4a (AudioToolbox aac_at on macOS)', ext: 'm4a', kind: 'audio', build: c => ({ pre: [], post: ['-vn', ...aacEnc(c, c.opts.audio_bitrate || '256k'), ...ar(c), ...ac(c), '-movflags', '+faststart'] }) },
  alac: { description: 'Apple Lossless in .m4a', ext: 'm4a', kind: 'audio', build: c => ({ pre: [], post: ['-vn', '-c:a', 'alac', ...ar(c), ...ac(c)] }) },
  'opus-voice': { description: 'Opus 32 kb/s mono 48 kHz (speech, voice notes)', ext: 'opus', kind: 'audio', build: () => ({ pre: [], post: ['-vn', '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-ar', '48000', '-application', 'voip'] }) },
  'opus-music': { description: 'Opus 160 kb/s 48 kHz (music streaming)', ext: 'opus', kind: 'audio', build: c => ({ pre: [], post: ['-vn', '-c:a', 'libopus', '-b:a', c.opts.audio_bitrate || '160k', '-ar', '48000'] }) },
  'ogg-game': { description: 'Ogg Vorbis q6, 48 kHz (Unity/Godot/Unreal SFX & music)', ext: 'ogg', kind: 'audio', build: c => ({ pre: [], post: ['-vn', '-c:a', 'libvorbis', '-q:a', '6', ...ar(c, 48000), ...ac(c)] }) },
  'normalize-14': { description: 'Two-pass EBU R128 to -14 LUFS / -1 dBTP, 24-bit WAV (streaming masters)', ext: 'wav', kind: 'audio', loudnorm: { I: -14, TP: -1, LRA: 11 }, build: c => ({ pre: [], post: ['-vn', '-c:a', 'pcm_s24le', ...ar(c, c.probe?.audio?.sampleRate || 48000)] }) },
  'normalize-23': { description: 'Two-pass EBU R128 to -23 LUFS / -1 dBTP, 24-bit 48 kHz WAV (broadcast)', ext: 'wav', kind: 'audio', loudnorm: { I: -23, TP: -1, LRA: 15 }, build: c => ({ pre: [], post: ['-vn', '-c:a', 'pcm_s24le', ...ar(c, 48000)] }) },
  'whisper-16k': { description: '16 kHz mono 16-bit WAV for speech recognition', ext: 'wav', kind: 'audio', build: () => ({ pre: [], post: ['-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le'] }) },
  'mp4-h264': {
    description: 'MP4 H.264 + AAC, faststart. VideoToolbox on Apple Silicon, libx264 CRF 20 elsewhere', ext: 'mp4', kind: 'video',
    build: c => ({
      pre: vtDecode(c),
      post: [...(useVT(c) ? ['-c:v', 'h264_videotoolbox', '-b:v', c.opts.video_bitrate || autoVideoBitrate(c.probe, false), '-profile:v', 'high']
        : ['-c:v', 'libx264', '-crf', String(c.opts.crf ?? 20), '-preset', 'medium']),
      '-pix_fmt', 'yuv420p', ...aacEnc(c, c.opts.audio_bitrate || '192k'), '-movflags', '+faststart'],
    }),
  },
  'mp4-hevc': {
    description: 'MP4 HEVC (hvc1 tag for Apple players) + AAC. hevc_videotoolbox on Apple Silicon, libx265 CRF 24 elsewhere', ext: 'mp4', kind: 'video',
    build: c => ({
      pre: vtDecode(c),
      post: [...(useVT(c, 'hevc_videotoolbox') ? ['-c:v', 'hevc_videotoolbox', '-b:v', c.opts.video_bitrate || autoVideoBitrate(c.probe, true)]
        : ['-c:v', 'libx265', '-crf', String(c.opts.crf ?? 24), '-preset', 'medium']),
      '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', ...aacEnc(c, c.opts.audio_bitrate || '192k'), '-movflags', '+faststart'],
    }),
  },
  'mp4-faststart': { description: 'Remux to MP4 with moov atom up front (no re-encode)', ext: 'mp4', kind: 'video', build: () => ({ pre: [], post: ['-map', '0', '-c', 'copy', '-movflags', '+faststart'] }) },
  'm4a-extract': { description: 'Extract the audio track from a video without re-encoding (AAC → .m4a)', ext: 'm4a', kind: 'audio', build: () => ({ pre: [], post: ['-vn', '-map', '0:a:0', '-c:a', 'copy', '-movflags', '+faststart'] }) },
};

function listPresets() {
  return Object.entries(PRESETS).map(([name, p]) => ({ name, ext: p.ext, kind: p.kind, description: p.description, twoPassLoudnorm: !!p.loudnorm }));
}

module.exports = { PRESETS, listPresets, autoVideoBitrate };
