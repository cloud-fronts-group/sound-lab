// Activates the extension against a minimal mock of the `vscode` API and checks the manifest ↔ code wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const fs = require('fs');

const registered = new Map();
const providers = {};
class Emitter { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(v) { this.l.forEach(f => f(v)); } dispose() {} }
class Uri { constructor(p) { this.fsPath = p; this.path = p; } static file(p) { return new Uri(p); } static parse(s) { return new Uri(s); } static joinPath(u, ...s) { return new Uri(path.join(u.fsPath, ...s)); } toString() { return 'file://' + this.fsPath; } }
const disposable = { dispose() {} };
const config = { get: (k) => undefined, update: async () => undefined };
const vscode = {
  Uri, EventEmitter: Emitter,
  ThemeColor: class { constructor(id) { this.id = id; } },
  ThemeIcon: class { constructor(id) { this.id = id; } static Folder = {}; },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 }, ProgressLocation: { Notification: 15 }, ViewColumn: { Beside: -2 },
  ConfigurationTarget: { Global: 1 }, RelativePattern: class {},
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    registerTreeDataProvider: (id, p) => { providers[id] = p; return disposable; },
    registerCustomEditorProvider: (id, p) => { providers[id] = p; return disposable; },
    showErrorMessage: async () => undefined, showInformationMessage: async () => undefined,
  },
  commands: { registerCommand: (id, fn) => { registered.set(id, fn); return disposable; }, executeCommand: async () => undefined },
  workspace: {
    getConfiguration: () => config, onDidChangeConfiguration: () => disposable,
    createFileSystemWatcher: () => ({ onDidCreate: () => disposable, onDidDelete: () => disposable, onDidChange: () => disposable, dispose() {} }),
    workspaceFolders: undefined, findFiles: async () => [],
  },
  env: {},
};

const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };

test('activate registers every contributed command, view and editor', async () => {
  const ext = require('../out/extension');
  const ctx = { subscriptions: [], extensionUri: Uri.file(path.join(__dirname, '..')), globalStorageUri: Uri.file(fs.mkdtempSync('/tmp/sl-')), secrets: { get: async () => undefined } };
  ext.activate(ctx);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const declared = pkg.contributes.commands.map(c => c.command).sort();
  const notRegistered = declared.filter(c => !registered.has(c));
  const notDeclared = [...registered.keys()].filter(c => !declared.includes(c));
  assert.ok(!notRegistered.length, `declared in package.json but not registered in extension.ts: ${notRegistered.join(', ')}`);
  assert.ok(!notDeclared.length, `registered in extension.ts but missing from package.json contributes.commands: ${notDeclared.join(', ')}`);
  assert.ok(providers['soundLab.samples'], 'tree provider');
  assert.ok(providers['soundLab.audioPreview'], 'custom editor');
  assert.equal(pkg.contributes.customEditors[0].viewType, 'soundLab.audioPreview');
  // every command referenced from a menu exists
  const menuCmds = Object.values(pkg.contributes.menus).flat().map(m => m.command).filter(Boolean);
  for (const c of menuCmds) { assert.ok(declared.includes(c), `menu references unknown command ${c}`); }
  // every setting read in code is declared
  const src = fs.readdirSync(path.join(__dirname, '..', 'src'), { recursive: true }).filter(f => f.endsWith('.ts'))
    .map(f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
  const keys = new Set([...src.matchAll(/get<[^>]+>\('([\w.]+)'\)/g)].map(m => m[1]));
  const props = Object.keys(pkg.contributes.configuration.properties).map(k => k.replace(/^soundLab\./, ''));
  for (const k of keys) { assert.ok(props.includes(k), `setting soundLab.${k} is read but not declared`); }
  // webview action buttons map to real commands
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'audioEditor.ts'), 'utf8');
  for (const [, id] of html.matchAll(/data-run="(\w+)"/g)) { assert.ok(declared.includes(`soundLab.${id}`), `button runs unknown soundLab.${id}`); }
  await new Promise(r => setTimeout(r, 300)); // let capability detection settle
});
