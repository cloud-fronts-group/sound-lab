// scripts/version.js: keeps the extension, plugin and lockfile versions in lockstep and dates the CHANGELOG.
// Runs against a scratch copy of the real manifests (VERSION_ROOT), so the repository is never modified.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'version.js');
const FILES = ['package.json', 'package-lock.json', 'CHANGELOG.md', 'plugins/sound-lab-studio/package.json', 'plugins/sound-lab-studio/.claude-plugin/plugin.json'];

function scratch(changelog) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soundlab-version-'));
  for (const rel of FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  if (changelog !== undefined) { fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog); }
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, VERSION_ROOT: dir }, encoding: 'utf8' });
const json = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));

test('version: repository manifests are in lockstep', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('version: bump rewrites every manifest, keeps formatting, dates the CHANGELOG', () => {
  const dir = scratch('# Changelog\n\n## Unreleased\n- Added a thing.\n\n## 1.2.3\n- Old.\n');
  for (const rel of FILES.filter(f => f.endsWith('.json'))) {
    const p = path.join(dir, rel); const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(`"version": "${j.version}"`, '"version": "1.2.3"').replace(`"version": "${j.version}"`, '"version": "1.2.3"'));
  }
  const before = fs.readFileSync(path.join(dir, 'plugins/sound-lab-studio/.claude-plugin/plugin.json'), 'utf8');
  const r = run(dir, 'bump', 'minor', '--date', '2030-01-02');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '1.3.0');
  for (const rel of ['package.json', 'plugins/sound-lab-studio/package.json', 'plugins/sound-lab-studio/.claude-plugin/plugin.json']) {
    assert.equal(json(dir, rel).version, '1.3.0', rel);
  }
  const lock = json(dir, 'package-lock.json');
  assert.equal(lock.version, '1.3.0');
  assert.equal(lock.packages[''].version, '1.3.0');
  // Only the version line changed in the hand-formatted plugin manifest.
  const after = fs.readFileSync(path.join(dir, 'plugins/sound-lab-studio/.claude-plugin/plugin.json'), 'utf8');
  assert.equal(after, before.replace('"version": "1.2.3"', '"version": "1.3.0"'));
  assert.equal(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'),
    '# Changelog\n\n## Unreleased\n\n## 1.3.0 - 2030-01-02\n- Added a thing.\n\n## 1.2.3\n- Old.\n');
  assert.equal(run(dir, 'notes', 'v1.3.0').stdout.trim(), '- Added a thing.');
  assert.equal(run(dir, 'check', '--tag', 'v1.3.0').status, 0);
  assert.notEqual(run(dir, 'check', '--tag', 'v1.2.3').status, 0);
});

test('version: refuses empty changelogs, downgrades, drift and non-X.Y.Z versions', () => {
  const empty = scratch('# Changelog\n\n## Unreleased\n\n## 0.1.0\n- First.\n');
  const r = run(empty, 'bump', 'patch');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unreleased.*empty/);
  assert.equal(json(empty, 'package.json').version, json(ROOT, 'package.json').version, 'nothing written on failure');
  assert.equal(run(empty, 'bump', 'patch', '--allow-empty-changelog', '--dry-run').status, 0);

  const dir = scratch();
  assert.match(run(dir, 'next', '0.0.1').stderr, /must be greater/);
  assert.match(run(dir, 'next', '9.0.0-beta.1').stderr, /unknown bump/);
  assert.equal(run(dir, 'next', 'v9.0.0').stdout.trim(), '9.0.0');

  const p = path.join(dir, 'plugins/sound-lab-studio/package.json');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/"version": "[^"]+"/, '"version": "9.9.9"'));
  const drift = run(dir, 'check');
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /manifests disagree/);
});
