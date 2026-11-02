#!/usr/bin/env node
// Single source of truth for the repository version.
//
// The VS Code extension and the Claude Code plugin are released together, so every manifest below must carry the
// same version. CI runs `check`; the Release workflow runs `bump` and `notes`. Plain Node, no dependencies.
//
//   node scripts/version.js current                       print the current version
//   node scripts/version.js check [--tag v1.2.3]          fail if the manifests (or the tag) disagree
//   node scripts/version.js next <patch|minor|major|X.Y.Z> print the version a bump would produce
//   node scripts/version.js bump <patch|minor|major|X.Y.Z> [--dry-run] [--allow-empty-changelog] [--date YYYY-MM-DD]
//                                                         write the new version everywhere and date the CHANGELOG
//   node scripts/version.js notes [X.Y.Z|Unreleased]      print that CHANGELOG section (release notes)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.env.VERSION_ROOT ? path.resolve(process.env.VERSION_ROOT) : path.resolve(__dirname, '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

// Manifests whose top-level "version" is rewritten in place (regex, so hand-made formatting survives).
const MANIFESTS = [
  'package.json',
  'plugins/sound-lab-studio/package.json',
  'plugins/sound-lab-studio/.claude-plugin/plugin.json',
];
// npm writes this one itself, so a JSON round-trip reproduces its formatting exactly.
const LOCKFILE = 'package-lock.json';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/; // vsce/Marketplace only accept plain major.minor.patch

function fail(msg) { console.error(`version: ${msg}`); process.exit(1); }
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const write = (rel, text) => fs.writeFileSync(path.join(ROOT, rel), text);

function versions() {
  const out = {};
  for (const rel of MANIFESTS) { out[rel] = JSON.parse(read(rel)).version; }
  const lock = JSON.parse(read(LOCKFILE));
  out[LOCKFILE] = lock.version;
  out[`${LOCKFILE} (packages[""])`] = lock.packages && lock.packages[''] && lock.packages[''].version;
  return out;
}

function current() {
  const all = versions();
  const distinct = [...new Set(Object.values(all))];
  if (distinct.length !== 1) {
    fail('manifests disagree:\n' + Object.entries(all).map(([f, v]) => `  ${f}: ${v}`).join('\n') +
      '\nRun `node scripts/version.js bump <X.Y.Z>` to realign them.');
  }
  if (!SEMVER.test(distinct[0])) { fail(`"${distinct[0]}" is not a plain X.Y.Z version`); }
  return distinct[0];
}

function cmp(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) { return pa[i] - pb[i]; } }
  return 0;
}

function next(from, bump) {
  const m = SEMVER.exec(from);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let to;
  if (bump === 'major') { to = `${maj + 1}.0.0`; }
  else if (bump === 'minor') { to = `${maj}.${min + 1}.0`; }
  else if (bump === 'patch') { to = `${maj}.${min}.${pat + 1}`; }
  else if (SEMVER.test(String(bump).replace(/^v/, ''))) { to = String(bump).replace(/^v/, ''); }
  else { fail(`unknown bump "${bump}" (use patch, minor, major or an explicit X.Y.Z)`); }
  if (cmp(to, from) <= 0) { fail(`new version ${to} must be greater than the current ${from}`); }
  return to;
}

// ---------------------------------------------------------------- CHANGELOG
const HEADING = /^##\s+(.+?)\s*$/gm;

function sections(text) {
  const heads = [...text.matchAll(HEADING)];
  return heads.map((h, i) => {
    const bodyStart = h.index + h[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    const title = h[1];
    return { title, key: title.split(/\s+/)[0].replace(/^\[|\]$/g, '').replace(/^v/, ''), start: h.index, bodyStart, end, body: text.slice(bodyStart, end).trim() };
  });
}

function findSection(text, key) {
  const want = key.toLowerCase();
  return sections(text).find(s => s.key.toLowerCase() === want);
}

function datedChangelog(text, version, date, allowEmpty) {
  if (findSection(text, version)) { fail(`CHANGELOG.md already has a "## ${version}" section`); }
  const unreleased = findSection(text, 'Unreleased');
  const body = unreleased ? unreleased.body : '';
  if (!body && !allowEmpty) {
    fail('the "## Unreleased" section of CHANGELOG.md is empty. Describe the changes first, or pass --allow-empty-changelog.');
  }
  const section = `## Unreleased\n\n## ${version} - ${date}\n${body ? body + '\n' : '- Maintenance release.\n'}\n`;
  if (unreleased) { return text.slice(0, unreleased.start) + section + text.slice(unreleased.end).replace(/^\n+/, ''); }
  // No Unreleased heading yet: insert right after the document title.
  const title = /^# .*\n+/m.exec(text);
  const at = title ? title.index + title[0].length : 0;
  return text.slice(0, at) + section + text.slice(at);
}

// ---------------------------------------------------------------- commands
function bumpCmd(bump, flags) {
  if (!bump) { fail('usage: bump <patch|minor|major|X.Y.Z>'); }
  const from = current();
  const to = next(from, bump);
  const date = flags.date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { fail(`--date must be YYYY-MM-DD, got "${date}"`); }

  const writes = [];
  for (const rel of MANIFESTS) {
    const text = read(rel);
    // The first `"version"` at two-space indentation is the top-level key in every manifest we own.
    const re = /^( {2}"version"\s*:\s*")([^"]+)(")/m;
    if (!re.test(text)) { fail(`no top-level "version" in ${rel}`); }
    const updated = text.replace(re, `$1${to}$3`);
    if (JSON.parse(updated).version !== to) { fail(`rewriting ${rel} did not change its top-level version`); }
    writes.push([rel, updated]);
  }
  const lock = JSON.parse(read(LOCKFILE));
  lock.version = to;
  if (lock.packages && lock.packages['']) { lock.packages[''].version = to; }
  writes.push([LOCKFILE, JSON.stringify(lock, null, 2) + '\n']);
  writes.push(['CHANGELOG.md', datedChangelog(fs.readFileSync(CHANGELOG, 'utf8'), to, date, flags['allow-empty-changelog'])]);

  if (!flags['dry-run']) { for (const [rel, text] of writes) { write(rel, text); } }
  console.error(`${flags['dry-run'] ? '[dry run] ' : ''}${from} -> ${to}: ${writes.map(w => w[0]).join(', ')}`);
  console.log(to);
}

function notesCmd(key) {
  const text = fs.readFileSync(CHANGELOG, 'utf8');
  const want = (key || 'Unreleased').replace(/^v/, '');
  const s = findSection(text, want);
  if (!s) { fail(`no "## ${want}" section in CHANGELOG.md`); }
  if (!s.body) { fail(`the "## ${want}" section of CHANGELOG.md is empty`); }
  console.log(s.body);
}

function checkCmd(flags) {
  const v = current();
  if (flags.tag) {
    const tag = String(flags.tag).replace(/^refs\/tags\//, '');
    if (tag !== `v${v}`) { fail(`tag ${tag} does not match the manifest version ${v} (expected v${v})`); }
  }
  console.log(`version ${v} is consistent across ${MANIFESTS.join(", ")} and ${LOCKFILE}${flags.tag ? ` and tag v${v}` : ''}`);
}

function parse(argv) {
  const pos = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) { flags[k] = v; }
      else if (['tag', 'date'].includes(k)) { flags[k] = argv[++i]; }
      else { flags[k] = true; }
    } else { pos.push(a); }
  }
  return { pos, flags };
}

if (require.main === module) {
  const { pos: [cmd, arg], flags } = parse(process.argv.slice(2));
  switch (cmd) {
    case 'current': console.log(current()); break;
    case 'check': checkCmd(flags); break;
    case 'next': console.log(next(current(), arg)); break;
    case 'bump': bumpCmd(arg, flags); break;
    case 'notes': notesCmd(arg); break;
    default: fail('usage: version.js <current|check|next|bump|notes> …');
  }
}

module.exports = { next, datedChangelog, findSection, cmp };
