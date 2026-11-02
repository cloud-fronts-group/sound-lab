import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { formatTimecode } from './core/ffmpeg';
import { AudioSummary, humanSize } from './core/probe';
import { cfg, state, summaryOf } from './util';

type Node = FolderNode | FileNode | InfoNode;

class FolderNode extends vscode.TreeItem {
  constructor(public readonly dir: string, label: string, public readonly files: vscode.Uri[]) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = vscode.ThemeIcon.Folder;
    this.description = `${files.length}`;
    this.contextValue = 'soundLab.folder';
    this.resourceUri = vscode.Uri.file(dir);
  }
}

class FileNode extends vscode.TreeItem {
  constructor(public readonly uri: vscode.Uri) {
    super(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.Collapsed);
    this.resourceUri = uri;
    this.contextValue = 'soundLab.file';
    this.iconPath = new vscode.ThemeIcon('file-media');
    this.command = { command: 'vscode.openWith', title: 'Open', arguments: [uri, 'soundLab.audioPreview'] };
    try { this.description = humanSize(fs.statSync(uri.fsPath).size); } catch { /* deleted */ }
    this.tooltip = uri.fsPath;
  }
}

class InfoNode extends vscode.TreeItem {
  constructor(label: string, value: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'soundLab.info';
  }
}

export class SampleExplorer implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private cache = new Map<string, { mtime: number; s: AudioSummary }>();
  private disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(cfg().get<string>('explorer.include') ?? '**/*.wav');
    this.disposables.push(watcher,
      watcher.onDidCreate(() => this.refreshSoon()), watcher.onDidDelete(() => this.refreshSoon()),
      state.created.event(() => this.refreshSoon()),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('soundLab.explorer')) { this.refresh(); } }));
  }

  refresh(): void { this.emitter.fire(undefined); }
  private refreshSoon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 400);
  }

  getTreeItem(n: Node): vscode.TreeItem { return n; }

  async getChildren(n?: Node): Promise<Node[]> {
    if (!n) { return this.roots(); }
    if (n instanceof FolderNode) { return n.files.map(u => new FileNode(u)); }
    if (n instanceof FileNode) { return this.details(n.uri); }
    return [];
  }

  private async roots(): Promise<Node[]> {
    if (!vscode.workspace.workspaceFolders?.length) { return []; }
    const c = cfg();
    const files = await vscode.workspace.findFiles(c.get<string>('explorer.include') ?? '**/*.wav', c.get<string>('explorer.exclude') || undefined, 5000);
    const groups = new Map<string, vscode.Uri[]>();
    for (const f of files) {
      const dir = path.dirname(f.fsPath);
      groups.set(dir, [...(groups.get(dir) ?? []), f]);
    }
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const nodes = [...groups.entries()].map(([dir, list]) => {
      list.sort((a, b) => a.fsPath.localeCompare(b.fsPath, undefined, { numeric: true }));
      const wf = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir));
      let label = wf ? path.relative(wf.uri.fsPath, dir) || wf.name : dir;
      if (multiRoot && wf && label !== wf.name) { label = `${wf.name}/${label}`; }
      return new FolderNode(dir, label.replace(/\\/g, '/'), list);
    });
    nodes.sort((a, b) => String(a.label).localeCompare(String(b.label)));
    if (nodes.length === 1) { return nodes[0].files.map(u => new FileNode(u)); }
    return nodes;
  }

  private async details(uri: vscode.Uri): Promise<Node[]> {
    try {
      const mtime = fs.statSync(uri.fsPath).mtimeMs;
      let hit = this.cache.get(uri.fsPath);
      if (!hit || hit.mtime !== mtime) { hit = { mtime, s: await summaryOf(uri.fsPath) }; this.cache.set(uri.fsPath, hit); }
      const s = hit.s;
      const rows: Node[] = [
        new InfoNode('Duration', formatTimecode(s.duration), 'clock'),
        new InfoNode('Codec', s.codec, 'symbol-misc'),
        new InfoNode('Sample rate', s.sampleRate ? `${(s.sampleRate / 1000).toFixed(s.sampleRate % 1000 ? 1 : 0)} kHz` : '—', 'pulse'),
        new InfoNode('Channels', `${s.channels}${s.channelLayout ? ` (${s.channelLayout})` : ''}`, 'split-horizontal'),
      ];
      if (s.bitDepth) { rows.push(new InfoNode('Bit depth', `${s.bitDepth}-bit`, 'symbol-numeric')); }
      if (s.bitRate) { rows.push(new InfoNode('Bitrate', `${Math.round(s.bitRate / 1000)} kb/s`, 'dashboard')); }
      for (const k of ['title', 'artist', 'bpm', 'TBPM', 'key', 'comment']) {
        const v = s.tags[k] ?? s.tags[k.toUpperCase()];
        if (v) { rows.push(new InfoNode(k, v, 'tag')); }
      }
      return rows;
    } catch (e) {
      return [new InfoNode('Error', (e as Error).message.split('\n')[0], 'error')];
    }
  }

  dispose(): void { this.disposables.forEach(d => d.dispose()); this.emitter.dispose(); }
}
