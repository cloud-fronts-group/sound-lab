#!/usr/bin/env node
'use strict';
// Stand-in for `mlx_audio.server` (mlx-audio 0.6.x API shape): /v1/models, /v1/audio/transcriptions (verbose_json),
// /v1/audio/speech (audio bytes), /v1/audio/separations (base64 target/residual). Logs requests to $MOCK_MLX_LOG.
const http = require('http');
const fs = require('fs');
const { execFileSync } = require('child_process');
const port = parseInt(process.argv[2] || process.env.PORT || '8000', 10);
const logFile = process.env.MOCK_MLX_LOG;
const loaded = new Set();
const log = (o) => { if (logFile) { fs.appendFileSync(logFile, JSON.stringify(o) + '\n'); } };
function fields(body, ctype) {
  const b = /boundary=(.+)$/.exec(ctype || '')?.[1]; const out = {}; if (!b) { return out; }
  for (const part of body.toString('latin1').split(`--${b}`)) {
    const name = /name="([^"]+)"/.exec(part)?.[1]; if (!name) { continue; }
    const fname = /filename="([^"]+)"/.exec(part)?.[1];
    const val = part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
    out[name] = fname ? { filename: fname, bytes: val.length, riff: val.startsWith('RIFF') } : val;
  }
  return out;
}
const tone = (fmt, secs) => execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=f=330:d=${secs}`, '-f', fmt === 'mp3' ? 'mp3' : 'wav', '-'], { maxBuffer: 64e6 });
http.createServer((req, res) => {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const send = (code, obj, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(obj) : obj); };
    if (url.pathname === '/v1/models' && req.method === 'GET') { return send(200, { object: 'list', data: [...loaded].map(id => ({ id, object: 'model' })) }); }
    if (url.pathname === '/v1/models' && req.method === 'POST') { loaded.add(url.searchParams.get('model_name')); return send(200, { status: 'loaded' }); }
    if (url.pathname === '/v1/audio/transcriptions') {
      const f = fields(body, req.headers['content-type']); log({ path: url.pathname, ...f }); loaded.add(f.model);
      if (f.response_format !== 'verbose_json') { return send(200, { text: 'hello' }); }
      return send(200, { text: ' Hello from the mock MLX server. Second line.', language: f.language || 'en',
        segments: [{ id: 0, start: 0.0, end: 1.4, text: ' Hello from the mock MLX server.' }, { id: 1, start: 1.6, end: 2.6, text: ' Second line.' }] });
    }
    if (url.pathname === '/v1/audio/speech') {
      const j = JSON.parse(body.toString() || '{}'); log({ path: url.pathname, ...j }); loaded.add(j.model);
      if (!j.input) { return send(422, { detail: 'input required' }); }
      return send(200, tone(j.response_format, Math.min(3, 0.3 + j.input.length / 40)), `audio/${j.response_format}`);
    }
    if (url.pathname === '/v1/audio/separations') {
      const f = fields(body, req.headers['content-type']); log({ path: url.pathname, ...f });
      return send(200, { target: tone('wav', 1).toString('base64'), residual: tone('wav', 1).toString('base64'), sample_rate: 48000 });
    }
    send(404, { detail: 'not found' });
  });
}).listen(port, '127.0.0.1', () => process.stderr.write(`mock mlx-audio on ${port}\n`));
