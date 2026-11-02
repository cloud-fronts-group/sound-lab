// Procedural sound effects (ffmpeg lavfi synthesis), shared recipe set with the Claude Code plugin's scripts/sfx.js.
// Tempo-aware effects (risers, whooshes, downlifters, beds) can be sized in bars. No vscode.
import * as fs from 'fs';
import * as path from 'path';
import { runOk } from './ffmpeg';
import { tmpFile } from './audioio';

const SR = 48000;
export interface SfxRecipe { d: number; label: string; tempo?: boolean; build: (d: number) => { src: string; fx: string } }

export const SFX: Record<string, SfxRecipe> = {
  riser: { d: 3, label: 'Riser (tension build)', tempo: true,
    build: d => ({ src: `aevalsrc='0.35*sin(2*PI*(150*t+(1850/(2*${d}))*t*t))*(t/${d})+0.25*(random(0)*2-1)*pow(t/${d},2)':s=${SR}:d=${d}`, fx: 'highpass=f=120,aecho=0.8:0.6:60|120:0.3|0.2' }) },
  downlifter: { d: 2, label: 'Downlifter (after a drop)', tempo: true,
    build: d => ({ src: `aevalsrc='0.4*sin(2*PI*(1600*t-(1500/(2*${d}))*t*t))*(1-t/${d})+0.3*(random(0)*2-1)*pow(1-t/${d},2)':s=${SR}:d=${d}`, fx: 'lowpass=f=7000,aecho=0.8:0.6:70|140:0.3|0.2' }) },
  whoosh: { d: 1.2, label: 'Whoosh (transition)', tempo: true,
    build: d => ({ src: `anoisesrc=color=pink:amplitude=0.9:sample_rate=${SR}:duration=${d}`, fx: `bandpass=f=900:width_type=o:w=2,aphaser=in_gain=0.6:out_gain=0.9:delay=2:decay=0.5:speed=${(1.5 / d).toFixed(2)},volume='pow(sin(PI*t/${d}),3)':eval=frame` }) },
  impact: { d: 1.6, label: 'Impact (drop hit)',
    build: d => ({ src: `aevalsrc='0.95*sin(2*PI*(70*t-18*t*t))*exp(-3.2*t)+0.6*(random(0)*2-1)*exp(-35*t)':s=${SR}:d=${d}`, fx: 'lowpass=f=5000,acompressor=threshold=0.3:ratio=4:attack=1:release=80,aecho=0.7:0.5:45|90:0.3|0.15' }) },
  'sub-drop': { d: 2, label: 'Sub drop',
    build: d => ({ src: `aevalsrc='0.9*sin(2*PI*(90*t-(55/(2*${d}))*t*t))*exp(-1.4*t)':s=${SR}:d=${d}`, fx: 'lowpass=f=300' }) },
  'air-horn': { d: 1.4, label: 'Air horn',
    build: d => ({ src: `aevalsrc='0.25*(sgn(sin(2*PI*440*t))+0.8*sgn(sin(2*PI*554*t))+0.6*sgn(sin(2*PI*659*t)))*if(lt(mod(t,0.47),0.38),1,0.15)':s=${SR}:d=${d}`, fx: 'bandpass=f=1200:width_type=o:w=2.5,acompressor=threshold=0.2:ratio=6,aecho=0.8:0.5:60:0.25' }) },
  laser: { d: 0.45, label: 'Laser zap',
    build: d => ({ src: `aevalsrc='0.7*sin(2*PI*(2600/14)*(1-exp(-14*t)))*exp(-6*t)':s=${SR}:d=${d}`, fx: 'aecho=0.6:0.4:25:0.3' }) },
  explosion: { d: 3, label: 'Explosion',
    build: d => ({ src: `aevalsrc='(0.9*(random(0)*2-1)*exp(-2.2*t)+0.8*sin(2*PI*(50*t-6*t*t))*exp(-2*t))':s=${SR}:d=${d}`, fx: 'lowpass=f=900,lowpass=f=1400,acompressor=threshold=0.25:ratio=6:attack=2:release=200,aecho=0.8:0.6:70|160:0.35|0.25' }) },
  'vinyl-scratch': { d: 0.6, label: 'Vinyl scratch',
    build: d => ({ src: `aevalsrc='0.6*(random(0)*2-1)*abs(sin(2*PI*3.3*t))+0.4*sin(2*PI*(300+500*sin(2*PI*3.3*t))*t)':s=${SR}:d=${d}`, fx: 'bandpass=f=1500:width_type=o:w=2' }) },
  'ui-click': { d: 0.06, label: 'UI click',
    build: d => ({ src: `aevalsrc='0.9*sin(2*PI*2400*t)*exp(-140*t)+0.3*sin(2*PI*5200*t)*exp(-260*t)':s=${SR}:d=${d}`, fx: 'highpass=f=300' }) },
  coin: { d: 0.45, label: 'Coin pickup',
    build: d => ({ src: `aevalsrc='0.35*sgn(sin(2*PI*if(lt(t,0.08),988,1319)*t))*exp(-5*t)':s=${SR}:d=${d}`, fx: 'lowpass=f=9000' }) },
  wind: { d: 6, label: 'Wind bed', tempo: true,
    build: d => ({ src: `anoisesrc=color=brown:amplitude=0.8:sample_rate=${SR}:duration=${d}`, fx: "lowpass=f=1100,highpass=f=80,volume='0.55+0.45*sin(2*PI*0.23*t)*sin(2*PI*0.07*t+1)':eval=frame" }) },
  rain: { d: 6, label: 'Rain bed', tempo: true,
    build: d => ({ src: `anoisesrc=color=pink:amplitude=0.5:sample_rate=${SR}:duration=${d}`, fx: 'highpass=f=500,lowpass=f=9000,aecho=0.6:0.5:12|31:0.3|0.2' }) },
  heartbeat: { d: 3.4, label: 'Heartbeat',
    build: d => ({ src: `aevalsrc='0.9*sin(2*PI*48*t)*(exp(-22*mod(t,0.85))+0.75*gte(mod(t,0.85),0.22)*exp(-22*(mod(t,0.85)-0.22)))':s=${SR}:d=${d}`, fx: 'lowpass=f=160' }) },
  alarm: { d: 2, label: 'Alarm',
    build: d => ({ src: `aevalsrc='0.35*sgn(sin(2*PI*if(lt(mod(t,0.5),0.25),880,660)*t))':s=${SR}:d=${d}`, fx: 'lowpass=f=5000' }) },
};

export interface SfxOptions { duration?: number; bars?: number; bpm?: number; semitones?: number; peakDb?: number; codec?: string[]; signal?: AbortSignal }

/** Render one effect, click-free and peak-normalised. With bars+bpm, tempo effects last exactly that many bars. */
export async function renderSfx(ffmpeg: string, name: string, out: string, o: SfxOptions = {}): Promise<{ file: string; seconds: number; detail: string }> {
  const rec = SFX[name];
  if (!rec) { throw new Error(`Unknown effect "${name}". Try: ${Object.keys(SFX).join(', ')}`); }
  const d = o.duration || (rec.tempo && o.bars && o.bpm ? o.bars * 4 * 60 / o.bpm : rec.d);
  const { src, fx } = rec.build(+d.toFixed(6));
  const semis = o.semitones ?? 0;
  const fadeOut = Math.min(0.08, d * 0.15);
  // pitch shift is tape-style (asetrate), so restore the exact length afterwards with apad+atrim
  const chain = [fx, semis ? `asetrate=${Math.round(SR * Math.pow(2, semis / 12))},aresample=${SR}` : null, 'highpass=f=20', 'afade=t=in:st=0:d=0.003',
    `areverse,afade=t=in:st=0:d=${fadeOut.toFixed(3)},areverse`, `apad,atrim=end_sample=${Math.round(d * SR)}`, 'aformat=channel_layouts=stereo'].filter(Boolean).join(',');
  const tmp = tmpFile('wav');
  try {
    await runOk({ exe: ffmpeg, signal: o.signal, args: ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', src, '-af', chain, '-c:a', 'pcm_f32le', tmp] });
    const v = await runOk({ exe: ffmpeg, args: ['-hide_banner', '-nostdin', '-i', tmp, '-af', 'volumedetect', '-f', 'null', '-'] });
    const max = parseFloat(/max_volume:\s*(-?[\d.]+)/.exec(v.stderr)?.[1] ?? '0');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await runOk({ exe: ffmpeg, signal: o.signal, args: ['-hide_banner', '-nostdin', '-y', '-i', tmp, '-af', `volume=${((o.peakDb ?? -1) - max).toFixed(2)}dB`, ...(o.codec ?? ['-c:a', 'pcm_s24le']), '-ar', String(SR), out] });
  } finally { fs.rmSync(tmp, { force: true }); }
  return { file: out, seconds: d, detail: `${rec.label} · ${d.toFixed(2)} s${semis ? ` · ${semis > 0 ? '+' : ''}${semis} st` : ''}` };
}
