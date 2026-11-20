// Bridge between Sound Lab (Node/VS Code) and the Google ADK Python agents (`adk/sound_lab_adk`),
// plus a pure-Node Gemini Interactions API client for Deep Research when Python ADK is absent.
// No vscode imports.
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FolderContext, PresentationSpec, scaffoldPresentation, ScaffoldedPresentation, SlideSpec } from './presentation';

export interface AdkRuntimeStatus {
  available: boolean;
  python?: string;
  adkVersion?: string;
  genaiVersion?: string;
  adkDir?: string;
  reason?: string;
}

export interface AdkResearchOptions {
  extensionRoot: string;
  topic: string;
  folderPath: string;
  folderContext: FolderContext;
  outputDir: string;
  targetMinutes: number;
  audience?: string;
  voiceProfileId?: string;
  deepResearchAgent?: string; // deep-research-preview-04-2026 | deep-research-max-preview-04-2026
  model?: string;             // gemini-4-hydrogen | gemini-4-neon | gemini-4-carbon
  apiKey?: string;
  pythonPath?: string;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}

export interface AdkResearchResult {
  scaffold: ScaffoldedPresentation;
  researchReport: string;
  interactionId?: string;
  engine: 'google-adk' | 'gemini-interactions' | 'local-folder-scaffold';
}

export function locateAdkDir(extensionRoot: string): string | undefined {
  const candidates = [
    path.join(extensionRoot, 'adk'),
    path.resolve(__dirname, '..', '..', 'adk'),
  ];
  return candidates.find(d => fs.existsSync(path.join(d, 'sound_lab_adk', 'agent.py')));
}

export function findAdkPython(extensionRoot: string, explicit?: string): string | undefined {
  const adkDir = locateAdkDir(extensionRoot);
  const candidates = [
    explicit,
    adkDir ? path.join(adkDir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python') : undefined,
    'python3',
    'python',
  ].filter((x): x is string => !!x);

  for (const py of candidates) {
    if (py.includes(path.sep) && !fs.existsSync(py)) { continue; }
    const r = spawnSync(py, ['-c', 'import google.adk, google.genai; print(google.adk.__version__, google.genai.__version__)'], {
      encoding: 'utf8', timeout: 8000,
    });
    if (r.status === 0) { return py; }
  }
  return undefined;
}

export function checkAdkRuntime(extensionRoot: string, explicitPython?: string): AdkRuntimeStatus {
  const adkDir = locateAdkDir(extensionRoot);
  if (!adkDir) { return { available: false, reason: 'adk/sound_lab_adk directory not found' }; }
  const py = findAdkPython(extensionRoot, explicitPython);
  if (!py) {
    return {
      available: false, adkDir,
      reason: `google-adk Python runtime not found. Install in ${adkDir}: uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python "google-adk[mcp]>=2.12.0"`,
    };
  }
  const r = spawnSync(py, ['-c', 'import google.adk, google.genai; print(google.adk.__version__); print(google.genai.__version__)'], { encoding: 'utf8', timeout: 5000 });
  const [adkVersion, genaiVersion] = (r.stdout || '').trim().split(/\r?\n/);
  return { available: true, python: py, adkDir, adkVersion, genaiVersion };
}

function extractInteractionText(interaction: any): string {
  if (typeof interaction?.output_text === 'string' && interaction.output_text.trim()) {
    return interaction.output_text.trim();
  }
  const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
  const chunks: string[] = [];
  for (const st of steps) {
    if (st?.type === 'model_output' && Array.isArray(st.content)) {
      for (const item of st.content) {
        if (item?.type === 'text' && item.text) { chunks.push(String(item.text)); }
      }
    }
  }
  return chunks.join('\n').trim();
}

/** Direct Gemini v1beta Interactions API call for Deep Research + structured 5-10 min presentation scaffolding. */
export async function runGeminiDeepResearchDirect(opts: AdkResearchOptions, apiKey: string, baseUrl = 'https://generativelanguage.googleapis.com'): Promise<AdkResearchResult> {
  const agent = opts.deepResearchAgent || 'deep-research-preview-04-2026';
  const model = opts.model || 'gemini-4-hydrogen';
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': apiKey };
  const targetMin = Math.max(5, Math.min(10, opts.targetMinutes || 7));

  opts.onProgress?.(`Starting Gemini Deep Research (${agent}) on "${opts.topic}"…`);
  const researchPrompt = [
    `Conduct comprehensive technical research to prepare a ${targetMin}-minute instructional presentation on:`,
    `Topic: ${opts.topic}`,
    `Audience: ${opts.audience || 'Developers & technical learners'}`,
    '',
    'Ground the research in this local folder context so explanations connect industry best practices directly to the project files:',
    opts.folderContext.summaryText.slice(0, 8000),
    '',
    'Produce a structured research report with:',
    '1. Core Concepts & Technical Background',
    '2. Architectural Patterns, Tradeoffs & Hardware/Container Considerations',
    '3. Step-by-Step Instructional Sequence for a 5-10 Minute Walkthrough',
    '4. Practical Examples, Pitfalls & Verification Checklist',
    '5. Cited Sources',
  ].join('\n');

  const createRes = await fetch(`${baseUrl}/v1beta/interactions`, {
    method: 'POST',
    headers,
    signal: opts.signal,
    body: JSON.stringify({
      agent,
      input: researchPrompt,
      agent_config: { type: 'deep-research', thinking_summaries: 'auto', visualization: 'auto' },
      background: true,
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Deep Research failed (${createRes.status}): ${(await createRes.text()).slice(0, 400)}`);
  }
  const initial = await createRes.json() as any;
  const interactionId: string = initial.id;
  opts.onProgress?.(`Deep Research running (interaction ${interactionId})…`);

  let completed: any = initial;
  const deadline = Date.now() + 25 * 60_000;
  while (!['completed', 'failed', 'cancelled', 'incomplete'].includes(completed.status)) {
    if (opts.signal?.aborted) { throw new Error('Cancelled'); }
    if (Date.now() > deadline) { throw new Error('Deep Research timed out.'); }
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`${baseUrl}/v1beta/interactions/${encodeURIComponent(interactionId)}`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: opts.signal,
    });
    if (!pollRes.ok) { throw new Error(`Deep Research poll failed (${pollRes.status})`); }
    completed = await pollRes.json();
    const steps = Array.isArray(completed.steps) ? completed.steps : [];
    const lastThought = [...steps].reverse().find((s: any) => s.type === 'thought');
    if (lastThought?.summary) { opts.onProgress?.(`Researching: ${String(lastThought.summary).slice(0, 120)}`); }
  }
  if (completed.status !== 'completed') {
    throw new Error(`Deep Research did not complete (status: ${completed.status}): ${JSON.stringify(completed.errors || completed.error || '')}`);
  }
  const researchReport = extractInteractionText(completed);

  opts.onProgress?.(`Structuring ${targetMin}-minute instructional slides with ${model}…`);
  const slideSchema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      slides: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            durationSec: { type: 'number' },
            bullets: { type: 'array', items: { type: 'string' } },
            narration: { type: 'string' },
            codeSnippet: { type: 'string' },
            codeLang: { type: 'string' },
            speakerNotes: { type: 'string' },
          },
          required: ['title', 'durationSec', 'bullets', 'narration'],
        },
      },
    },
    required: ['title', 'slides'],
  };

  const synthPrompt = [
    `Scaffold an instructional presentation strictly lasting ${targetMin} minutes (${Math.round(targetMin * 60)} seconds, within 300-600s total) on "${opts.topic}".`,
    `Target 8-12 slides with ~140 words/minute speakable narration (natural spoken prose, no markdown punctuation in narration).`,
    `Ground every slide in both the folder contents and the Deep Research report below.`,
    '',
    'FOLDER CONTEXT:',
    opts.folderContext.summaryText.slice(0, 6000),
    '',
    'DEEP RESEARCH REPORT:',
    researchReport.slice(0, 14000),
  ].join('\n');

  const synthRes = await fetch(`${baseUrl}/v1beta/interactions`, {
    method: 'POST',
    headers,
    signal: opts.signal,
    body: JSON.stringify({
      model,
      input: synthPrompt,
      response_format: { type: 'text', mime_type: 'application/json', schema: slideSchema },
      store: false,
    }),
  });
  let parsedSlides: Omit<SlideSpec, 'index'>[] | undefined;
  let title = opts.topic;
  if (synthRes.ok) {
    const sj = await synthRes.json();
    const rawJson = extractInteractionText(sj);
    try {
      const obj = JSON.parse(rawJson) as { title?: string; slides?: Omit<SlideSpec, 'index'>[] };
      if (obj.title) { title = obj.title; }
      if (Array.isArray(obj.slides) && obj.slides.length >= 3) { parsedSlides = obj.slides; }
    } catch { /* fall back to folder+research deterministic deck builder */ }
  }

  const scaffold = scaffoldPresentation({
    outputDir: opts.outputDir,
    title,
    topic: opts.topic,
    folderContext: opts.folderContext,
    targetMinutes: targetMin,
    audience: opts.audience,
    voiceProfileId: opts.voiceProfileId,
    researchReport,
    researchInteractionId: interactionId,
    slides: parsedSlides,
  });
  return { scaffold, researchReport, interactionId, engine: 'gemini-interactions' };
}

/**
 * Run the Google ADK `deep_research_agent` workflow via Python (`adk/sound_lab_adk/cli.py`),
 * falling back to direct Gemini Interactions API if Python ADK is unavailable, or local
 * folder-grounded scaffolding if no Gemini API key is configured.
 */
export async function runPresentationResearchWorkflow(opts: AdkResearchOptions): Promise<AdkResearchResult> {
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  const rt = checkAdkRuntime(opts.extensionRoot, opts.pythonPath);

  if (rt.available && rt.python && rt.adkDir && apiKey) {
    opts.onProgress?.(`Running Google ADK Deep Research Agent (google-adk ${rt.adkVersion})…`);
    const result = await new Promise<AdkResearchResult>((resolve, reject) => {
      const child = spawn(rt.python!, [
        '-m', 'sound_lab_adk.cli',
        '--action', 'research-and-scaffold',
        '--topic', opts.topic,
        '--folder', opts.folderPath,
        '--out', opts.outputDir,
        '--minutes', String(opts.targetMinutes),
        '--audience', opts.audience || 'Developers & technical learners',
        '--deep-research-agent', opts.deepResearchAgent || 'deep-research-preview-04-2026',
        '--model', opts.model || 'gemini-4-hydrogen',
        ...(opts.voiceProfileId ? ['--voice-profile', opts.voiceProfileId] : []),
      ], {
        cwd: rt.adkDir,
        env: { ...process.env, GEMINI_API_KEY: apiKey, GOOGLE_API_KEY: apiKey, PYTHONUNBUFFERED: '1' },
        windowsHide: true,
      });

      let stdout = ''; let stderr = '';
      const onAbort = () => child.kill('SIGTERM');
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => {
        const txt = d.toString();
        stderr += txt;
        for (const line of txt.split(/\r?\n/).filter(Boolean)) {
          opts.onProgress?.(line.replace(/^\[adk\]\s*/, ''));
        }
      });
      child.on('error', reject);
      child.on('close', code => {
        opts.signal?.removeEventListener('abort', onAbort);
        if (opts.signal?.aborted) { return reject(new Error('Cancelled')); }
        if (code !== 0) {
          return reject(new Error(`Google ADK workflow exited ${code}: ${stderr.trim().split('\n').slice(-4).join(' | ')}`));
        }
        try {
          const j = JSON.parse(stdout.trim()) as { dir: string; spec: PresentationSpec; files: ScaffoldedPresentation['files']; researchReport: string; interactionId?: string };
          resolve({
            scaffold: { dir: j.dir, spec: j.spec, files: j.files },
            researchReport: j.researchReport,
            interactionId: j.interactionId,
            engine: 'google-adk',
          });
        } catch (e) {
          reject(new Error(`Could not parse Google ADK output: ${(e as Error).message}`));
        }
      });
    });
    return result;
  }

  if (apiKey) {
    return runGeminiDeepResearchDirect(opts, apiKey);
  }

  // Offline / no API key fallback: scaffold directly from scanned folder contents and warn clearly.
  opts.onProgress?.('No GEMINI_API_KEY set — scaffolding 5–10 min presentation from folder contents (set Gemini API Key for live Deep Research).');
  const researchReport = [
    `# Research Brief: ${opts.topic}`,
    '',
    `> Generated locally from folder context because \`GEMINI_API_KEY\` is not set. Run **Sound Lab: Set Gemini API Key** to enable live Google ADK Deep Research (\`deep-research-preview-04-2026\`).`,
    '',
    '## Folder Analysis',
    opts.folderContext.summaryText,
  ].join('\n');

  const scaffold = scaffoldPresentation({
    outputDir: opts.outputDir,
    title: opts.topic,
    topic: opts.topic,
    folderContext: opts.folderContext,
    targetMinutes: opts.targetMinutes,
    audience: opts.audience,
    voiceProfileId: opts.voiceProfileId,
    researchReport,
  });
  return { scaffold, researchReport, engine: 'local-folder-scaffold' };
}
