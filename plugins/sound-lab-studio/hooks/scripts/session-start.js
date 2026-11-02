#!/usr/bin/env node
'use strict';
// SessionStart: one short line of environment facts so Claude picks the right encoders / backends.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sh = (c, a) => { try { return spawnSync(c, a, { encoding: 'utf8', timeout: 4000 }); } catch { return { status: -1, stdout: '' }; } };
const has = c => { const r = sh(process.platform === 'win32' ? 'where' : 'which', [c]); return r.status === 0; };
const facts = [];
const v = sh('ffmpeg', ['-hide_banner', '-version']);
if (v.status === 0) {
  facts.push(`ffmpeg ${/ffmpeg version (\S+)/.exec(v.stdout)?.[1] || '?'}`);
  const enc = sh('ffmpeg', ['-hide_banner', '-encoders']).stdout || '';
  const hw = ['h264_videotoolbox', 'hevc_videotoolbox', 'aac_at', 'h264_nvenc', 'libfdk_aac'].filter(e => enc.includes(` ${e} `));
  if (hw.length) { facts.push(`hw encoders: ${hw.join(', ')}`); }
  const flt = sh('ffmpeg', ['-hide_banner', '-filters']).stdout || '';
  if (/\swhisper\s/.test(flt)) { facts.push('ffmpeg whisper filter available'); }
} else { facts.push('ffmpeg NOT found (brew install ffmpeg / apt install ffmpeg)'); }
const apple = process.platform === 'darwin' && process.arch === 'arm64';
facts.push(apple ? 'Apple Silicon (Metal/MLX available natively; containers have no Metal)' : `${process.platform}/${process.arch}`);
const tools = ['mlx_whisper', 'mlx_audio.server', 'whisper-cli', 'docker', 'podman', 'container'].filter(has);
if (tools.length) { facts.push(`tools: ${tools.join(', ')}`); }
// running background jobs from the MCP server
const dataDir = process.env.CLAUDE_PLUGIN_DATA || process.env.SOUND_LAB_DATA || path.join(os.homedir(), '.sound-lab');
try {
  const dir = path.join(dataDir, 'jobs');
  const active = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter(j => ['running', 'queued', 'interrupted'].includes(j.status));
  if (active.length) { facts.push(`${active.length} unfinished Sound Lab job(s): ${active.map(j => `${j.id} (${j.status})`).slice(0, 3).join(', ')} — see list_jobs / resume_job`); }
} catch { /* no jobs yet */ }
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `Sound Lab Studio: ${facts.join(' · ')}. Long or batch media work → sound-lab-media MCP tools (background jobs).` } }));
