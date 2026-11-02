'use strict';
// Minimal input expansion: files, directories (walked) and glob patterns (*, ?, **, {a,b}). No dependencies.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MEDIA_EXT = ['wav', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aif', 'aiff', 'wma', 'caf', 'ac3', 'amr', 'webm', 'mka',
  'mp4', 'mov', 'mkv', 'avi', 'm4v', 'wmv', 'flv', 'ts', 'mts', 'mxf'];

function expandHome(p) { return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p; }

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else { re += '.*'; } }
      else { re += '[^/]*'; }
    } else if (c === '?') { re += '[^/]'; }
    else if (c === '{') { const end = glob.indexOf('}', i); const alts = glob.slice(i + 1, end).split(','); re += `(?:${alts.map(a => a.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`; i = end; }
    else { re += c.replace(/[.+^$()|[\]\\]/g, '\\$&'); }
  }
  return new RegExp(`^${re}$`, process.platform === 'darwin' || process.platform === 'win32' ? 'i' : '');
}

function walk(dir, recursive, out = [], depth = 0) {
  if (depth > 20) { return out; }
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') { continue; }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (recursive) { walk(p, recursive, out, depth + 1); } }
    else if (e.isFile()) { out.push(p); }
  }
  return out;
}

/**
 * Expand files / dirs / globs into a sorted, de-duplicated list of absolute media file paths.
 * @param {string[]} patterns
 * @param {{cwd?: string, recursive?: boolean, extensions?: string[]}} opts
 */
function expandInputs(patterns, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const exts = (opts.extensions && opts.extensions.length ? opts.extensions : MEDIA_EXT).map(e => e.replace(/^\./, '').toLowerCase());
  const okExt = f => exts.includes(path.extname(f).slice(1).toLowerCase());
  const out = new Set();
  for (const raw of patterns) {
    const p = path.resolve(cwd, expandHome(String(raw)));
    if (!/[*?{]/.test(raw)) {
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isFile()) { out.add(p); }
      else if (st.isDirectory()) { walk(p, opts.recursive !== false).filter(okExt).forEach(f => out.add(f)); }
      continue;
    }
    // split into the literal base directory and the glob remainder
    const norm = p.split(path.sep).join('/');
    const segs = norm.split('/');
    const firstGlob = segs.findIndex(s => /[*?{]/.test(s));
    const base = segs.slice(0, firstGlob).join('/') || '/';
    const rest = segs.slice(firstGlob).join('/');
    const re = globToRegex(rest);
    const deep = rest.includes('**') || rest.includes('/');
    // "*.xyz" names its extension explicitly → trust it; "*" or "take_*" → only media files
    const explicitExt = /\.[A-Za-z0-9{},]+$/.test(rest);
    for (const f of walk(base.split('/').join(path.sep) || path.sep, deep)) {
      const rel = path.relative(base, f).split(path.sep).join('/');
      if (re.test(rel) && (explicitExt || okExt(f))) { out.add(f); }
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

module.exports = { expandInputs, globToRegex, expandHome, MEDIA_EXT };
