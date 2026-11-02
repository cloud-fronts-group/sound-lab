// @ts-check
// Sound Lab Studio webview: ribbon (Create + DJ tools), tool drawers, results, and the embedded mlx-audio Studio iframe.
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const dataEl = $('data');
  const D = JSON.parse(dataEl.dataset.json || '{}');
  const esc = (/** @type {unknown} */ s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
  const icon = (/** @type {string} */ n) => `<svg class="ic" aria-hidden="true" focusable="false"><use href="#sl-${n}"/></svg>`;
  const button = (/** @type {string} */ ic, /** @type {string} */ label, attrs = '') => `<button ${attrs}>${icon(ic)}${esc(label)}</button>`;

  // ------------------------------------------------------------ mlx-audio Studio iframe tabs + actions
  let page = '';
  const frame = /** @type {HTMLIFrameElement|null} */ (document.getElementById('studio'));
  document.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => {
    page = /** @type {HTMLElement} */ (b).dataset.page || '';
    if (frame) { frame.src = (frame.dataset.base || '') + page; }
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t === b));
  }));
  document.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => vscode.postMessage({ type: /** @type {HTMLElement} */ (b).dataset.act, page })));

  // ------------------------------------------------------------ state
  /** @type {{tool: string, session: Record<string, any>, values: Record<string, Record<string, any>>, lastPart: string}} */
  const S = Object.assign({ tool: '', session: { bpm: 100, key: 'C', scale: 'minor' }, values: {}, lastPart: '' }, vscode.getState() || {});
  const save = () => vscode.setState(S);

  // ------------------------------------------------------------ tool definitions
  const opt = (/** @type {any[]} */ list) => list.map(x => Array.isArray(x) ? { value: String(x[0]), label: String(x[1]) } : { value: String(x.id ?? x), label: String(x.label ?? x) });
  const sel = (/** @type {string} */ k, /** @type {string} */ label, /** @type {any[]} */ options, /** @type {any} */ def) => ({ k, label, type: 'select', options: opt(options), def: def ?? (Array.isArray(options[0]) ? options[0][0] : options[0]?.id ?? options[0]) });
  const range = (/** @type {string} */ k, /** @type {string} */ label, /** @type {number} */ min, /** @type {number} */ max, /** @type {number} */ step, /** @type {number} */ def, unit = '') => ({ k, label, type: 'range', min, max, step, def, unit });
  const chk = (/** @type {string} */ k, /** @type {string} */ label, def = false) => ({ k, label, type: 'check', def });
  const text = (/** @type {string} */ k, /** @type {string} */ label, ph = '', def = '') => ({ k, label, type: 'text', ph, def });
  const file = (/** @type {string} */ k, /** @type {string} */ label, bpmKey = '') => ({ k, label, type: 'file', bpmKey });
  const time = (/** @type {string} */ k, /** @type {string} */ label, hint = 'auto') => ({ k, label, type: 'text', ph: `${hint} — or m:ss.mmm`, def: '' });
  const bars = (/** @type {number[]} */ list, def = 8, k = 'bars', label = 'Length') => sel(k, label, list.map(b => [b, `${b} bar${b === 1 ? '' : 's'}`]), def);
  const progressions = [['', 'Genre default'], ...D.progressions.map((/** @type {any} */ p) => [p.id, p.label])];

  /** @type {Record<string, {title: string, icon: string, desc: string, session?: 'full'|'key', action: string, fields: any[], dj?: boolean}>} */
  const TOOLS = {
    instrumental: { title: 'Instrumental', icon: 'instrumental', session: 'full', action: 'Compose', desc: 'Drums, chords, bass and a lead in a genre — locked to your tempo and key.',
      fields: [sel('genre', 'Genre', D.genres, 'lofi'), bars([4, 8, 16, 32], 8), sel('arrangement', 'Arrangement', [['loop', 'Seamless loop'], ['song', 'Song (intro + ending)']]),
        sel('progression', 'Progression', progressions, ''), text('customProg', 'Or your own chords', 'Am F C G  ·  ii7 V7 Imaj7'), chk('lead', 'Lead melody', true)] },
    beats: { title: 'Beats', icon: 'beats', session: 'full', action: 'Make beat', desc: 'A drum loop that tiles seamlessly.',
      fields: [sel('style', 'Style', D.styles, 'boombap'), bars([1, 2, 4, 8, 16], 4), range('swing', 'Swing', 0, 30, 1, D.styles.find((/** @type {any} */ x) => x.id === 'boombap')?.swing ?? 0, '%'), chk('fill', 'Fill on the last bar', true), chk('humanize', 'Humanize timing & velocity', true)] },
    chords: { title: 'Chords', icon: 'chords', session: 'full', action: 'Play chords', desc: 'A voice-led chord progression on the instrument of your choice.',
      fields: [sel('progression', 'Progression', D.progressions, 'pop'), text('customProg', 'Or your own chords', 'Am F C G  ·  ii7 V7 Imaj7'), sel('instrument', 'Instrument', D.instruments.filter((/** @type {any} */ i) => !['bass', 'sub808', 'reese'].includes(i.id)), 'ep'),
        sel('rhythm', 'Rhythm', [['sustain', 'Sustained'], ['strum', 'Strum (1 & 3)'], ['stabs', 'Off-beat stabs'], ['pulse', '8th-note pulse'], ['arp', 'Arpeggio (16ths)']]),
        sel('barsPerChord', 'Chord length', [[1, '1 bar each'], [2, '2 bars each'], [0.5, '½ bar each']], '1'), bars([2, 4, 8, 16], 4)] },
    sfx: { title: 'Sound FX', icon: 'sfx', session: 'full', action: 'Make effect', desc: 'Transition and impact effects. Risers, whooshes and beds can be sized in bars of your tempo.',
      fields: [sel('effect', 'Effect', D.sfx, 'riser'), sel('sfxBars', 'Length', [['', 'Default'], [1, '1 bar'], [2, '2 bars'], [4, '4 bars'], [8, '8 bars']], ''), text('duration', 'Or seconds', 'auto'), range('semitones', 'Pitch', -12, 12, 1, 0, ' st')] },
    autotune: { title: 'Auto-tune', icon: 'autotune', session: 'key', action: 'Auto-tune', desc: 'Pitch-corrects a vocal to the key: YIN tracking, scale snapping and PSOLA shifting (length and timing unchanged).',
      fields: [file('track', 'Vocal track'), chk('detectKey', 'Detect the key from the track', true), range('retune', 'Retune speed', 0, 400, 5, 40, ' ms'), range('amount', 'Amount', 0, 100, 5, 100, '%')] },
    layer: { title: 'Layer', icon: 'layers', action: 'Layer', desc: 'Mix a generated part (or any file) onto a track — looped to fill it, optionally ducked under it.',
      fields: [file('target', 'Track'), file('part', 'Part to layer'), chk('loop', 'Loop the part to fill the track', true), chk('duck', 'Duck the part under the track', false), range('gain', 'Part level', -24, 6, 1, -3, ' dB'), time('offset', 'Start at', '0')] },
    backspin: { title: 'Backspin', icon: 'backspin', dj: true, action: 'Backspin', desc: 'Yanks the record backwards to a stop on the beat.',
      fields: [file('track', 'Track', 'bpm'), time('at', 'At'), sel('beats', 'Spin length', [[1, '1 beat'], [2, '2 beats'], [4, '4 beats']], '2'), sel('then', 'Then', [['stop', 'Stop'], ['rewind', 'Rewind — restart the phrase']])] },
    echoout: { title: 'Echo out', icon: 'echo-out', dj: true, action: 'Echo out', desc: 'The track stops on a downbeat and trails off on a tempo-synced echo.',
      fields: [file('track', 'Track', 'bpm'), time('at', 'At'), sel('echo', 'Echo', [['beat', '1 beat'], ['half', '½ beat']]), sel('tailBars', 'Tail', [[2, '2 bars'], [4, '4 bars'], [8, '8 bars']], '4'), range('feedback', 'Feedback', 30, 85, 1, 62, '%')] },
    beatjump: { title: 'Beat jump', icon: 'beat-jump', dj: true, action: 'Jump', desc: 'Skips forward (or loops back) by a number of beats, on the beat.',
      fields: [file('track', 'Track', 'bpm'), time('at', 'At'), sel('beats', 'Jump by', [[-32, '−32 beats'], [-16, '−16'], [-8, '−8'], [-4, '−4'], [-1, '−1'], [1, '+1'], [4, '+4'], [8, '+8 beats'], [16, '+16'], [32, '+32 beats']], '8')] },
    doubledrop: { title: 'Double drop', icon: 'double-drop', dj: true, action: 'Double drop', desc: 'Tempo-matches B and lines its drop up with A’s drop on the same downbeat.',
      fields: [file('track', 'Track A', 'bpm'), file('trackB', 'Track B', 'bpmB'), time('dropA', 'A’s drop'), time('dropB', 'B’s drop'), sel('dropBars', 'Play both for', [[8, '8 bars'], [16, '16 bars'], [32, '32 bars']], '16')] },
    quickmix: { title: 'Quick mix', icon: 'quick-mix', dj: true, action: 'Mix', desc: 'A fast, beat-matched cut into the next track with a bass swap.',
      fields: [file('track', 'From', 'bpm'), file('trackB', 'Into', 'bpmB'), time('at', 'Mix at'), sel('mixBars', 'Over', [[1, '1 bar'], [2, '2 bars'], [4, '4 bars']], '1')] },
    longblend: { title: 'Long blend', icon: 'long-blend', dj: true, action: 'Blend', desc: 'B’s highs ride in, the basses swap halfway, then A’s highs ride out.',
      fields: [file('track', 'From', 'bpm'), file('trackB', 'Into', 'bpmB'), time('at', 'Start at'), sel('mixBars', 'Over', [[8, '8 bars'], [16, '16 bars'], [32, '32 bars']], '16')] },
    mashup: { title: 'Mashup', icon: 'mashup', dj: true, action: 'Mash up', desc: 'Vocals of one song over the instrumental of another — tempo-matched, on the downbeat, optionally key-matched.',
      fields: [file('track', 'Vocals from', 'bpm'), chk('aIsAcapella', 'This is already an acapella'), file('trackB', 'Instrumental from', 'bpmB'), chk('bIsInstrumental', 'This is already an instrumental'),
        chk('keyMatch', 'Shift the vocals to the instrumental’s key', true), range('offsetBars', 'Vocals start', 0, 16, 1, 0, ' bars in'), range('vocalGain', 'Vocal level', -6, 6, 1, 0, ' dB')] },
    acapella: { title: 'Acapella', icon: 'acapella', dj: true, action: 'Isolate vocals', desc: 'Vocals only. Uses mlx-audio AI separation when its server runs; otherwise extracts the stereo center (best on mixes with centered vocals).',
      fields: [file('track', 'Track')] },
    novocals: { title: 'Instrumental', icon: 'no-vocals', dj: true, action: 'Remove vocals', desc: 'Everything but the vocals. Uses mlx-audio AI separation when its server runs; otherwise removes the stereo center.',
      fields: [file('track', 'Track')] },
  };

  // ------------------------------------------------------------ drawer rendering
  const drawer = $('drawer');
  const vals = (/** @type {string} */ tool) => (S.values[tool] = S.values[tool] || {});

  function fieldHtml(/** @type {any} */ f, /** @type {any} */ v) {
    const id = `f-${f.k}`;
    if (f.type === 'select') { return `<div class="col"><label for="${id}">${esc(f.label)}</label><select id="${id}" data-k="${f.k}">${f.options.map((/** @type {any} */ o) => `<option value="${esc(o.value)}"${String(v) === o.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>`; }
    if (f.type === 'range') { return `<div class="col"><label for="${id}">${esc(f.label)} <span class="val" data-val="${f.k}">${esc(v)}${esc(f.unit)}</span></label><input id="${id}" type="range" data-k="${f.k}" min="${f.min}" max="${f.max}" step="${f.step}" value="${esc(v)}"></div>`; }
    if (f.type === 'check') { return `<label class="check"><input type="checkbox" data-k="${f.k}"${v ? ' checked' : ''}> ${esc(f.label)}</label>`; }
    if (f.type === 'text') { return `<div class="col"><label for="${id}">${esc(f.label)}</label><input id="${id}" type="text" data-k="${f.k}" placeholder="${esc(f.ph)}" value="${esc(v)}"></div>`; }
    if (f.type === 'file') {
      const name = v ? String(v).split(/[\\/]/).pop() : '';
      return `<div class="col file" data-file="${f.k}"><label>${esc(f.label)}</label>
        <div class="row"><span class="fname${v ? '' : ' muted'}" title="${esc(v)}">${esc(name || 'No file chosen')}</span><span class="spacer"></span>
        ${button('folder', 'Browse…', `data-pick="${f.k}"`)}${button('music', 'Open file', `data-active="${f.k}" title="Use the file open in the Sound Lab editor"`)}</div>
        ${f.bpmKey ? `<div class="row small analysis" data-an="${f.k}"></div>` : ''}</div>`;
    }
    return '';
  }

  function sessionHtml(/** @type {'full'|'key'} */ mode) {
    const s = S.session;
    const keys = D.keys.map((/** @type {string} */ k) => `<option${k === s.key ? ' selected' : ''}>${k}</option>`).join('');
    const scales = D.scales.map((/** @type {string} */ k) => `<option${k === s.scale ? ' selected' : ''}>${k}</option>`).join('');
    return `<div class="session">${mode === 'full' ? `<div class="col"><label for="s-bpm">Tempo</label><input id="s-bpm" type="number" min="40" max="220" step="1" data-s="bpm" value="${esc(s.bpm)}"></div>` : ''}
      <div class="col"><label for="s-key">Key</label><select id="s-key" data-s="key">${keys}</select></div>
      <div class="col"><label for="s-scale">Scale</label><select id="s-scale" data-s="scale">${scales}</select></div></div>
      <p class="small muted">${mode === 'full' ? 'Tempo, key and scale are shared by every Create tool, so parts line up.' : 'Used when key detection is off.'}</p>`;
  }

  function open(/** @type {string} */ tool, /** @type {string=} */ track) {
    const T = TOOLS[tool];
    document.querySelectorAll('.tool').forEach(b => b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.tool === tool));
    if (!T) { drawer.hidden = true; S.tool = ''; save(); vscode.postMessage({ type: 'tool', tool: '' }); return; }
    S.tool = tool; save(); vscode.postMessage({ type: 'tool', tool });
    const v = vals(tool);
    if (track) { const k = T.fields.find(f => f.type === 'file')?.k || 'track'; if (v[k] !== track) { v[k] = track; if (k === 'track') { delete v.bpm; } if (k === 'trackB') { delete v.bpmB; } } }
    if (tool === 'layer' && !v.part && S.lastPart) { v.part = S.lastPart; }
    T.fields.forEach(f => { if (v[f.k] === undefined && f.def !== undefined) { v[f.k] = f.def; } });
    drawer.innerHTML = `
      <div class="dhead"><h2>${icon(T.icon)}${esc(T.title)}</h2><span class="spacer"></span>${button('close', '', 'class="link" id="dclose" title="Close" aria-label="Close"')}</div>
      <p class="small muted">${esc(T.desc)}</p>
      ${T.session ? sessionHtml(T.session) : ''}
      <div class="fields">${T.fields.map(f => fieldHtml(f, v[f.k])).join('')}</div>
      <div class="row mt12">${button('wand', T.action, `class="primary big" id="go"`)}</div>
      <div class="progress" id="prog" hidden><div id="bar"></div></div>
      <div class="status" id="status"></div>
      <div id="result"></div>`;
    drawer.hidden = false;
    drawer.scrollTop = 0;
    wire(tool);
    // re-show analyses for files already chosen
    T.fields.filter(f => f.type === 'file' && f.bpmKey && v[f.k]).forEach(f => analyse(tool, f.k));
    if (lastResult[tool]) { showResult(lastResult[tool]); }
    if (busy.has(tool)) { /** @type {HTMLButtonElement} */ ($('go')).disabled = true; $('prog').hidden = false; status('Working…'); }
  }

  function wire(/** @type {string} */ tool) {
    const v = vals(tool);
    drawer.querySelectorAll('[data-k]').forEach(el => {
      const e = /** @type {HTMLInputElement} */ (el);
      e.addEventListener(e.type === 'range' || e.type === 'text' || e.type === 'number' ? 'input' : 'change', () => {
        v[e.dataset.k || ''] = e.type === 'checkbox' ? e.checked : e.value;
        const out = drawer.querySelector(`[data-val="${e.dataset.k}"]`);
        if (out) { const f = TOOLS[tool].fields.find(x => x.k === e.dataset.k); out.textContent = e.value + (f?.unit || ''); }
        if (tool === 'instrumental' && e.dataset.k === 'genre') { const g = D.genres.find((/** @type {any} */ x) => x.id === e.value); if (g) { setSession({ bpm: g.bpm, scale: g.scale }); } }
        if (tool === 'beats' && e.dataset.k === 'style') {
          const st = D.styles.find((/** @type {any} */ x) => x.id === e.value);
          if (st) {
            setSession({ bpm: st.bpm });
            v.swing = st.swing;   // each style's own groove (boom bap 12 %, lo-fi 18 %…)
            const sw = /** @type {HTMLInputElement|null} */ (drawer.querySelector('[data-k="swing"]')); if (sw) { sw.value = String(st.swing); }
            const lab = drawer.querySelector('[data-val="swing"]'); if (lab) { lab.textContent = `${st.swing}%`; }
          }
        }
        save();
      });
    });
    drawer.querySelectorAll('[data-s]').forEach(el => {
      const e = /** @type {HTMLInputElement} */ (el);
      e.addEventListener(e.type === 'number' ? 'input' : 'change', () => { S.session[e.dataset.s || ''] = e.type === 'number' ? Number(e.value) : e.value; save(); });
    });
    drawer.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => vscode.postMessage({ type: 'pick', field: /** @type {HTMLElement} */ (b).dataset.pick, tool })));
    drawer.querySelectorAll('[data-active]').forEach(b => b.addEventListener('click', () => vscode.postMessage({ type: 'active', field: /** @type {HTMLElement} */ (b).dataset.active, tool })));
    $('dclose').addEventListener('click', () => open(''));
    $('go').addEventListener('click', () => go(tool));
  }

  function setSession(/** @type {Record<string, any>} */ patch) {
    Object.assign(S.session, patch); save();
    for (const [k, val] of Object.entries(patch)) { const el = /** @type {HTMLInputElement|null} */ (drawer.querySelector(`[data-s="${k}"]`)); if (el) { el.value = String(val); } }
  }

  function go(/** @type {string} */ tool) {
    const T = TOOLS[tool], v = vals(tool);
    /** @type {Record<string, any>} */
    const params = {};
    for (const f of T.fields) { params[f.k] = v[f.k]; }
    if (T.session === 'full') { Object.assign(params, S.session); }
    if (T.session === 'key') { params.key = S.session.key; params.scale = S.session.scale; }
    if (params.customProg) { params.progression = params.customProg; }
    if (tool === 'instrumental' && params.bars) { params.bars = Number(params.bars); }
    if (tool === 'beats') { params.swing = Number(params.swing || 0) / 100; }
    // per-track tempo overrides (×2 / ÷2 or a hint) travel as bpm / bpmB
    if (v.bpm) { params.bpm = T.dj ? v.bpm : params.bpm; }
    if (v.bpmB) { params.bpmB = v.bpmB; }
    if (T.dj && !v.bpm) { delete params.bpm; }
    const missing = T.fields.find(f => f.type === 'file' && !v[f.k]);
    if (missing) { status(`Choose ${missing.label.toLowerCase()} first.`, 'err'); return; }
    vscode.postMessage({ type: 'generate', tool, params });
  }

  function status(/** @type {string} */ text, cls = '') { const s = $('status'); if (s) { s.textContent = text; s.className = `status ${cls}`; } }

  /** @type {Record<string, any>} */
  const lastResult = {};
  /** @type {Set<string>} tools with a job running (survives drawer re-renders) */
  const busy = new Set();
  function showResult(/** @type {any} */ r) {
    const box = $('result'); if (!box) { return; }
    const T = TOOLS[r.tool];
    const stems = (r.extra || []).map((/** @type {any} */ x) => `<div class="stem"><div class="row small"><b>${esc(x.name)}</b><span class="spacer"></span>${button('open-external', 'Open', `data-open="${esc(x.file)}"`)}</div><audio controls preload="metadata" src="${esc(x.src)}"></audio></div>`).join('');
    box.innerHTML = `<div class="card result mt12">
        <div class="row"><b class="grow">${esc(r.name)}</b><span class="pill">${esc(fmt(r.seconds))}</span></div>
        <div class="small muted">${esc(r.detail)}</div>
        <audio controls preload="metadata" src="${esc(r.src)}"></audio>
        <div class="row">${button('open-external', 'Open', `data-open="${esc(r.file)}"`)}${button('folder', 'Reveal', `data-reveal="${esc(r.file)}"`)}
          ${T.dj ? button('arrow-left', 'Use as track', `data-use="${esc(r.file)}" title="Chain another DJ move on this result"`) : button('layers', 'Layer onto…', `data-layer="${esc(r.file)}"`)}</div>
        ${stems}</div>`;
    box.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => vscode.postMessage({ type: 'open', file: /** @type {HTMLElement} */ (b).dataset.open })));
    box.querySelectorAll('[data-reveal]').forEach(b => b.addEventListener('click', () => vscode.postMessage({ type: 'reveal', file: /** @type {HTMLElement} */ (b).dataset.reveal })));
    box.querySelectorAll('[data-layer]').forEach(b => b.addEventListener('click', () => { const f = /** @type {HTMLElement} */ (b).dataset.layer || ''; vals('layer').part = f; S.lastPart = f; save(); open('layer'); }));
    box.querySelectorAll('[data-use]').forEach(b => b.addEventListener('click', () => { const f = /** @type {HTMLElement} */ (b).dataset.use || ''; setFile(r.tool, 'track', f); }));
  }
  const fmt = (/** @type {number} */ s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

  function setFile(/** @type {string} */ tool, /** @type {string} */ k, /** @type {string} */ path) {
    const v = vals(tool); v[k] = path;
    if (k === 'track') { delete v.bpm; } if (k === 'trackB') { delete v.bpmB; }
    save();
    if (S.tool === tool) { open(tool); }
  }

  function analyse(/** @type {string} */ tool, /** @type {string} */ k) {
    const v = vals(tool);
    const f = TOOLS[tool].fields.find(x => x.k === k);
    const bpm = f?.bpmKey ? v[f.bpmKey] : undefined;
    vscode.postMessage({ type: 'analyse', field: k, file: v[k], bpm, tool });
  }

  function showAnalysis(/** @type {any} */ m) {
    const box = drawer.querySelector(`[data-an="${m.field}"]`); if (!box) { return; }
    if (m.error) { box.textContent = m.error; return; }
    box.innerHTML = `<span class="pill">${esc(m.bpm)} BPM</span><span class="pill">${esc(m.key)} ${esc(m.scale)} · ${esc(m.camelot)}</span><span class="muted">${esc(fmt(m.duration))}</span><span class="spacer"></span>
      ${button('chevrons-up', '×2', 'class="link" data-tempo="2" title="Detected half-time? Double the tempo"')}${button('chevrons-down', '÷2', 'class="link" data-tempo="0.5" title="Detected double-time? Halve the tempo"')}`;
    box.querySelectorAll('[data-tempo]').forEach(b => b.addEventListener('click', () => {
      const tool = S.tool, f = TOOLS[tool].fields.find(x => x.k === m.field);
      if (!f) { return; }
      vals(tool)[f.bpmKey] = Math.round(m.bpm * Number(/** @type {HTMLElement} */ (b).dataset.tempo) * 100) / 100; save();
      analyse(tool, m.field);
    }));
    if (S.tool === 'autotune' || (S.tool === 'mashup' && m.field === 'trackB')) { /* key shown; auto-tune detects at run time */ }
  }

  // ------------------------------------------------------------ messages from the extension
  window.addEventListener('message', e => {
    const m = e.data;
    switch (m.type) {
      case 'show': open(m.tool, m.track); break;
      case 'picked': {
        const tool = m.tool || S.tool; if (!tool || !TOOLS[tool]) { break; }
        setFile(tool, m.field, m.file);
        break;
      }
      case 'analysing': { if (m.tool && m.tool !== S.tool) { break; } const box = drawer.querySelector(`[data-an="${m.field}"]`); if (box) { box.textContent = 'Detecting tempo, beat grid and key…'; } break; }
      case 'analysed': if (!m.tool || (m.tool === S.tool && vals(m.tool)[m.field] === m.file)) { showAnalysis(m); } break;
      case 'busy': {
        if (m.on) { busy.add(m.tool); } else { busy.delete(m.tool); }
        if (m.tool !== S.tool) { break; }
        const go = /** @type {HTMLButtonElement|null} */ (document.getElementById('go')); if (go) { go.disabled = m.on; }
        $('prog').hidden = !m.on; if (m.on) { $('bar').style.width = '2%'; status('Working…'); }
        break;
      }
      case 'progress': if (m.tool === S.tool) { $('bar').style.width = `${Math.round(Math.max(0.02, m.fraction) * 100)}%`; status(m.text || ''); } break;
      case 'result': {
        lastResult[m.tool] = m;
        if (!TOOLS[m.tool].dj && m.tool !== 'layer' && m.tool !== 'autotune') { S.lastPart = m.file; save(); }
        if (m.tool === S.tool) { status('Done.', 'ok'); showResult(m); }
        break;
      }
      case 'error': if (!m.tool || m.tool === S.tool) { status(m.message, 'err'); } break;
    }
  });

  // first paint: the tool requested by a command, else the last one used
  const first = dataEl.dataset.tool || S.tool;
  if (first) { open(first, dataEl.dataset.track || undefined); }
  document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => {
    const t = /** @type {HTMLElement} */ (b).dataset.tool || '';
    open(S.tool === t && !drawer.hidden ? '' : t);
  }));
})();
