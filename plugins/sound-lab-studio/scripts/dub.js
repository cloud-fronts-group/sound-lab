#!/usr/bin/env node
'use strict';
// Dubbing command builder: voice-over on music beds, dubbed tracks on video, live music-stream dubbing.
// Prints / runs a single ffmpeg command. Use --json to get argv for the sound-lab-media run_ffmpeg tool (background).
//
//   dub.js music  --music bed.mp3 --voice vo.wav [--voice-at 2.5] [--duck 8] [--target -16] [--fade-out 3] --out mix.wav
//   dub.js video  --video in.mp4 --voice es.wav [--mode add-track|replace|voice-only] [--bed m_and_e.wav] [--lang spa] --out out.mp4
//   dub.js stream --input https://radio/stream --overlay jingle.wav@0 --overlay id.wav@600 [--every 900] [--duration 3600] --out rtmp://… | file
//   Common: --print (default: show command) · --run (execute now) · --json (argv for run_ffmpeg)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const o = { _: [], overlay: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (['print', 'run', 'json', 'voice-only', 'no-loudnorm', 'loop-overlays'].includes(k)) { o[k] = true; continue; }
    const v = argv[++i];
    if (k === 'overlay') { o.overlay.push(v); } else { o[k] = v; }
  }
  return o;
}

const FF = process.env.SOUND_LAB_FFMPEG || 'ffmpeg';
const FP = process.env.SOUND_LAB_FFPROBE || 'ffprobe';
const num = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);
const isUrl = s => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

function duration(file) {
  if (!file || isUrl(file)) { return 0; }
  const r = spawnSync(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return parseFloat(r.stdout) || 0;
}

/** Sidechain-ducking voice-over filtergraph. inputs: [bedLabel, voiceLabel] → [out] */
function duckGraph({ bed, voice, voiceAtMs, duckRatio, threshold, bedGain, voiceGain, release, out = 'out', until = 'first' }) {
  return [
    `${bed}aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${bedGain}dB[bed]`,
    `${voice}aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=${voiceAtMs}:all=1,volume=${voiceGain}dB,asplit=2[vo][keysrc]`,
    // sidechaincompress ends when its key input ends — pad the key with silence so the bed plays to its end
    `[keysrc]apad[key]`,
    `[bed][key]sidechaincompress=threshold=${threshold}:ratio=${duckRatio}:attack=15:release=${release}:makeup=1:link=maximum[ducked]`,
    `[ducked][vo]amix=inputs=2:duration=${until}:normalize=0:dropout_transition=0[${out}]`,
  ].join(';');
}

function finishChain(o, total) {
  const parts = [];
  const fi = num(o['fade-in'], 0), fo = num(o['fade-out'], 0);
  if (fi > 0) { parts.push(`afade=t=in:st=0:d=${fi}`); }
  if (fo > 0 && total > fo) { parts.push(`afade=t=out:st=${(total - fo).toFixed(3)}:d=${fo}`); }
  if (!o['no-loudnorm']) { parts.push(`loudnorm=I=${num(o.target, -16)}:TP=${num(o['true-peak'], -1.5)}:LRA=11`); }
  parts.push('aresample=48000');
  return parts.join(',');
}

function audioCodec(out) {
  const ext = path.extname(out).slice(1).toLowerCase();
  return {
    wav: ['-c:a', 'pcm_s24le'], flac: ['-c:a', 'flac'], aiff: ['-c:a', 'pcm_s24be'],
    mp3: ['-c:a', 'libmp3lame', '-q:a', '0'], m4a: ['-c:a', 'aac', '-b:a', '256k'], aac: ['-c:a', 'aac', '-b:a', '256k'],
    ogg: ['-c:a', 'libvorbis', '-q:a', '6'], opus: ['-c:a', 'libopus', '-b:a', '160k'],
  }[ext] || ['-c:a', 'pcm_s24le'];
}

const MODES = {
  music(o) {
    if (!o.music || !o.voice || !o.out) { throw new Error('music needs --music, --voice and --out'); }
    const voiceAt = num(o['voice-at'], 0);
    const until = o.until === 'voice' ? 'longest' : 'first';
    const total = until === 'first' ? duration(o.music) : Math.max(duration(o.music), voiceAt + duration(o.voice));
    const graph = duckGraph({ bed: '[0:a]', voice: '[1:a]', voiceAtMs: Math.round(voiceAt * 1000), duckRatio: num(o.duck, 8), threshold: num(o.threshold, 0.03),
      bedGain: num(o['music-gain'], -2), voiceGain: num(o['voice-gain'], 0), release: num(o.release, 450), out: 'mix', until });
    return ['-hide_banner', '-y', '-i', o.music, '-i', o.voice, '-filter_complex', `${graph};[mix]${finishChain(o, total)}[out]`, '-map', '[out]', ...audioCodec(o.out), o.out];
  },

  video(o) {
    if (!o.video || !o.voice || !o.out) { throw new Error('video needs --video, --voice and --out'); }
    const mode = o.mode || 'add-track';
    const lang = o.lang || 'und';
    const title = o.title || (lang !== 'und' ? `Dub (${lang})` : 'Dub');
    const total = duration(o.video);
    const voiceAt = num(o['voice-at'], 0);
    const inputs = ['-i', o.video, '-i', o.voice];
    let bedLabel = '[0:a:0]';
    if (o.bed) { inputs.push('-i', o.bed); bedLabel = '[2:a:0]'; }
    let graph;
    if (mode === 'voice-only' || o['voice-only']) {
      graph = `[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=${Math.round(voiceAt * 1000)}:all=1,apad,atrim=0:${total.toFixed(3)},${finishChain({ ...o, 'fade-in': 0, 'fade-out': 0 }, total)}[dub]`;
    } else {
      // With an M&E bed (--bed) the original dialogue is gone, so duck gently; over the full original mix duck harder.
      graph = `${duckGraph({ bed: bedLabel, voice: '[1:a]', voiceAtMs: Math.round(voiceAt * 1000), duckRatio: num(o.duck, o.bed ? 4 : 10), threshold: num(o.threshold, 0.025),
        bedGain: num(o['bed-gain'], o.bed ? 0 : -4), voiceGain: num(o['voice-gain'], 0), release: num(o.release, 350), out: 'mix', until: 'first' })};[mix]${finishChain({ ...o, target: o.target ?? -23 }, total)}[dub]`;
    }
    const container = path.extname(o.out).slice(1).toLowerCase();
    const aac = ['-c:a', 'aac', '-b:a', o['audio-bitrate'] || '192k'];
    const args = ['-hide_banner', '-y', ...inputs, '-filter_complex', graph, '-map', '0:v?', '-c:v', 'copy'];
    if (mode === 'replace') {
      args.push('-map', '[dub]', ...aac, '-metadata:s:a:0', `language=${lang}`, '-metadata:s:a:0', `title=${title}`);
    } else {
      // keep the original audio as track 0, add the dub as track 1 and make it the default
      args.push('-map', '0:a:0', '-map', '[dub]', '-c:a:0', 'copy', '-c:a:1', 'aac', '-b:a:1', o['audio-bitrate'] || '192k',
        '-metadata:s:a:1', `language=${lang}`, '-metadata:s:a:1', `title=${title}`, '-disposition:a:0', '0', '-disposition:a:1', 'default');
    }
    args.push('-map', '0:s?', '-c:s', container === 'mp4' || container === 'mov' || container === 'm4v' ? 'mov_text' : 'copy');
    if (['mp4', 'mov', 'm4v'].includes(container)) { args.push('-movflags', '+faststart'); }
    args.push('-shortest', o.out);
    return args;
  },

  stream(o) {
    if (!o.input || !o.out) { throw new Error('stream needs --input (URL or file) and --out (file or rtmp/srt/icecast URL)'); }
    const args = ['-hide_banner', '-y'];
    if (isUrl(o.input) && /^https?:/i.test(o.input)) { args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5'); }
    if (!isUrl(o.input)) { args.push('-re'); } // play files in real time so the output behaves like a live stream
    args.push('-i', o.input);
    const overlays = o.overlay.map(spec => {
      const at = spec.lastIndexOf('@');
      return at > 0 ? { file: spec.slice(0, at), t: num(spec.slice(at + 1), 0) } : { file: spec, t: 0 };
    });
    const every = num(o.every, 0);
    overlays.forEach(ov => { if (every > 0 || o['loop-overlays']) { args.push('-stream_loop', '-1'); } args.push('-i', ov.file); });
    const dur = num(o.duration, 0);
    let graph = '[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=' + num(o['music-gain'], -1) + 'dB[bed]';
    if (overlays.length) {
      const labels = overlays.map((ov, i) => {
        // Repeat an overlay every N seconds by padding it to N seconds and looping the input.
        const pad = every > 0 ? `,apad=whole_dur=${every},atrim=0:${every}` : '';
        graph += `;[${i + 1}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo${pad},adelay=${Math.round(ov.t * 1000)}:all=1,volume=${num(o['voice-gain'], 0)}dB[ov${i}]`;
        return `[ov${i}]`;
      });
      graph += `;${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0,asplit=2[vo][keysrc];[keysrc]apad[key]`;
      graph += `;[bed][key]sidechaincompress=threshold=${num(o.threshold, 0.03)}:ratio=${num(o.duck, 8)}:attack=15:release=${num(o.release, 500)}:makeup=1[ducked]`;
      graph += `;[ducked][vo]amix=inputs=2:duration=first:normalize=0[mix]`;
    } else { graph += ';[bed]anull[mix]'; }
    // Live-safe loudness: dynaudnorm + limiter (loudnorm needs look-ahead and is meant for files).
    graph += `;[mix]dynaudnorm=f=250:g=15:p=0.9,alimiter=limit=${Math.pow(10, num(o['true-peak'], -1) / 20).toFixed(3)}:level=0[out]`;
    args.push('-filter_complex', graph, '-map', '[out]');
    if (dur > 0) { args.push('-t', String(dur)); }
    const out = o.out;
    if (/^rtmps?:/i.test(out)) { args.push('-c:a', 'aac', '-b:a', o['audio-bitrate'] || '160k', '-ar', '44100', '-f', 'flv', out); }
    else if (/^srt:/i.test(out) || /^udp:/i.test(out)) { args.push('-c:a', 'aac', '-b:a', o['audio-bitrate'] || '160k', '-f', 'mpegts', out); }
    else if (/^icecast:/i.test(out)) { args.push('-c:a', 'libmp3lame', '-b:a', o['audio-bitrate'] || '192k', '-content_type', 'audio/mpeg', '-f', 'mp3', out); }
    else if (/\.m3u8$/i.test(out)) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); args.push('-c:a', 'aac', '-b:a', o['audio-bitrate'] || '160k', '-f', 'hls', '-hls_time', '6', '-hls_list_size', '10', '-hls_flags', 'delete_segments', out); }
    else { args.push(...audioCodec(out), out); }
    return args;
  },
};

function main() {
  const o = parseArgs(process.argv.slice(2));
  const mode = o._[0];
  if (!MODES[mode]) {
    process.stderr.write('usage: dub.js <music|video|stream> [options]  (see header of this file)\n');
    process.exit(2);
  }
  let args;
  try { args = MODES[mode](o); } catch (e) { process.stderr.write(`dub.js: ${e.message}\n`); process.exit(2); }
  if (o.json) { process.stdout.write(JSON.stringify(args.filter(a => a !== '-y').concat()) + '\n'); return; }
  if (o.run) {
    const r = spawnSync(FF, args, { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  const q = a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  process.stdout.write(`${FF} ${args.map(q).join(' ')}\n`);
}

process.stdout.on('error', e => { if (e.code === 'EPIPE') { process.exit(0); } throw e; });
if (require.main === module) { main(); }
module.exports = { MODES, duckGraph, parseArgs };
