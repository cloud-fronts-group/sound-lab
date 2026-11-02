import * as vscode from 'vscode';
import { AudioEditorProvider } from './audioEditor';
import { SampleExplorer } from './sampleExplorer';
import * as C from './commands';
import { refreshCapabilities, resolveTargets, state, openMedia } from './util';
import { MlxController } from './mlx';
import { MlxPanelProvider } from './mlxPanel';
import { StudioPanel } from './studioPanel';
import { VoiceCloneWizard } from './voiceCloneWizard';

export function activate(context: vscode.ExtensionContext) {
  state.context = context;
  state.output = vscode.window.createOutputChannel('Sound Lab');
  state.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  state.statusItem.command = 'soundLab.showCapabilities';
  context.subscriptions.push(state.output, state.statusItem, state.created, C.onTranscribed);

  const explorer = new SampleExplorer();
  context.subscriptions.push(
    explorer,
    vscode.window.registerTreeDataProvider('soundLab.samples', explorer),
    vscode.window.registerCustomEditorProvider(AudioEditorProvider.viewType, new AudioEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
  );

  const mlx = new MlxController(context);
  C.setMlxTranscription(mlx.transcriptionConfig());
  context.subscriptions.push(mlx, vscode.window.registerWebviewViewProvider(MlxPanelProvider.viewType, new MlxPanelProvider(context, mlx), { webviewOptions: { retainContextWhenHidden: true } }));

  const commands: Record<string, (...args: any[]) => unknown> = {
    'soundLab.openPreview': async (a?: unknown, b?: unknown) => { const [u] = await resolveTargets(a, b, { title: 'Open' }); if (u) { await openMedia(u); } },
    'soundLab.probe': C.cmdProbe,
    'soundLab.convert': C.cmdConvert,
    'soundLab.batchConvert': C.cmdBatchConvert,
    'soundLab.trim': C.cmdTrim,
    'soundLab.normalize': C.cmdNormalize,
    'soundLab.extractAudio': C.cmdExtractAudio,
    'soundLab.sliceEqual': C.cmdSliceEqual,
    'soundLab.splitOnSilence': C.cmdSplitOnSilence,
    'soundLab.applyEffects': C.cmdApplyEffects,
    'soundLab.waveformImage': C.cmdWaveformImage,
    'soundLab.spectrogramImage': C.cmdSpectrogramImage,
    'soundLab.analyze': (a?: unknown, b?: unknown) => C.cmdAnalyze(a, b),
    'soundLab.transcribe': C.cmdTranscribe,
    'soundLab.setApiKey': C.cmdSetApiKey,
    'soundLab.record': C.cmdRecord,
    'soundLab.generateTone': C.cmdGenerateTone,
    'soundLab.concat': C.cmdConcat,
    'soundLab.muxSubtitles': C.cmdMuxSubtitles,
    'soundLab.recipes': C.cmdRecipes,
    'soundLab.showCapabilities': C.cmdShowCapabilities,
    'soundLab.showLog': () => state.output.show(),
    'soundLab.refreshSamples': () => explorer.refresh(),
    'soundLab.voiceClone': (a?: unknown) => VoiceCloneWizard.open(mlx, context, a),
    'soundLab.mlxStart': () => mlx.cmdStart(),
    'soundLab.mlxStop': () => mlx.cmdStop(),
    'soundLab.mlxStatus': () => mlx.cmdStatus(),
    'soundLab.mlxModels': () => mlx.cmdModels(),
    'soundLab.mlxSynthesize': (a?: unknown) => mlx.cmdSynthesize(a),
    'soundLab.mlxSeparate': (a?: unknown, b?: unknown) => mlx.cmdSeparate(a, b),
    'soundLab.mlxOpenStudio': () => StudioPanel.open(mlx, context),
    'soundLab.mlxStopStudio': () => mlx.cmdStopStudio(),
  };
  for (const [id, fn] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try { return await fn(...args); }
      catch (e) { vscode.window.showErrorMessage(`Sound Lab: ${(e as Error).message.split('\n')[0]}`); state.output.appendLine(String((e as Error).stack ?? e)); }
    }));
  }

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('soundLab.ffmpegPath') || e.affectsConfiguration('soundLab.ffprobePath')) { refreshCapabilities(); }
  }));
  refreshCapabilities();
}

export function deactivate() { /* nothing to clean up beyond subscriptions */ }
