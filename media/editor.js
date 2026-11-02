// @ts-check
// Sound Lab audio editor webview: waveform, selection, playback, levels, spectrogram, silence regions, transcript.
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const ic = (/** @type {string} */ n) => `<svg class="ic" aria-hidden="true" focusable="false"><use href="#sl-${n}"/></svg>`;
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

  const canvas = /** @type {HTMLCanvasElement} */ ($('wave'));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const audio = /** @type {HTMLAudioElement} */ ($('audio'));

  const S = {
    info: /** @type {any} */ (null),
    peaks: /** @type {number[] | null} */ (null),
    bps: 1,
    duration: 0,
    view: { start: 0, end: 1 },
    sel: /** @type {{start:number,end:number}|null} */ (null),
    loop: false,
    silences: /** @type {{start:number,end:number}[]} */ ([]),
    segments: /** @type {{start:number,end:number}[]} */ ([]),
    transcript: /** @type {{start:number,end:number,text:string}[] | null} */ (null),
    activeSeg: -1,
    drag: /** @type {null | {x:number, t:number, moved:boolean, mode:'select'|'pan', view?:{start:number,end:number}}} */ (null),
    hoverT: /** @type {number|null} */ (null),
  };

  // ------------------------------------------------------------ helpers
  const fmt = (/** @type {number} */ s, ms = true) => {
    if (!isFinite(s) || s < 0) { s = 0; }
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const ss = ms ? sec.toFixed(3).padStart(6, '0') : String(Math.floor(sec)).padStart(2, '0');
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + ss;
  };
  const esc = (/** @type {string} */ s) => s.replace(/[&<>"]/g, c => /** @type {any} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const css = (/** @type {string} */ v, fb) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || fb;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const timeAt = (/** @type {number} */ x) => S.view.start + (x / canvas.clientWidth) * (S.view.end - S.view.start);
  const xAt = (/** @type {number} */ t) => ((t - S.view.start) / (S.view.end - S.view.start)) * canvas.clientWidth;
  const toast = (/** @type {string} */ text) => {
    const el = $('toast'); el.textContent = text; el.hidden = false;
    clearTimeout(/** @type {any} */ (toast).t); /** @type {any} */ (toast).t = setTimeout(() => (el.hidden = true), 2500);
  };

  // ------------------------------------------------------------ drawing
  let raf = 0;
  const requestDraw = () => { if (!raf) { raf = requestAnimationFrame(() => { raf = 0; draw(); }); } };

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const rulerH = 18, mid = (H - rulerH) / 2, amp = mid - 6;
    const waveColor = css('--wave', '#4fc3f7'), selColor = css('--wave-sel', '#ffb74d');
    const fg = css('--vscode-foreground', '#ccc'), muted = css('--muted', '#888');

    // silence regions
    ctx.fillStyle = 'rgba(127,127,127,0.13)';
    for (const r of S.silences) {
      const x0 = xAt(r.start), x1 = xAt(r.end);
      if (x1 >= 0 && x0 <= W) { ctx.fillRect(x0, 0, x1 - x0, H - rulerH); }
    }

    // selection background
    if (S.sel) {
      const x0 = xAt(S.sel.start), x1 = xAt(S.sel.end);
      ctx.fillStyle = hexA(selColor, 0.16);
      ctx.fillRect(x0, 0, x1 - x0, H - rulerH);
    }

    // centre line
    ctx.fillStyle = hexA(muted, 0.35);
    ctx.fillRect(0, mid, W, 1);

    // waveform
    if (S.peaks && S.peaks.length) {
      const n = S.peaks.length / 2;
      const secPerPx = (S.view.end - S.view.start) / W;
      for (let x = 0; x < W; x++) {
        const t0 = S.view.start + x * secPerPx, t1 = t0 + secPerPx;
        let b0 = Math.floor(t0 * S.bps), b1 = Math.max(b0 + 1, Math.ceil(t1 * S.bps));
        if (b1 <= 0 || b0 >= n) { continue; }
        b0 = clamp(b0, 0, n - 1); b1 = clamp(b1, 1, n);
        let lo = 1, hi = -1;
        for (let b = b0; b < b1; b++) { const a = S.peaks[b * 2], c = S.peaks[b * 2 + 1]; if (a < lo) { lo = a; } if (c > hi) { hi = c; } }
        if (hi < lo) { continue; }
        const inSel = S.sel && t0 >= S.sel.start && t1 <= S.sel.end + secPerPx;
        ctx.fillStyle = inSel ? selColor : waveColor;
        const y0 = mid - hi * amp, y1 = mid - lo * amp;
        ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    }

    // transcript cue markers
    if (S.transcript) {
      ctx.fillStyle = hexA(fg, 0.5);
      for (const s of S.transcript) { const x = xAt(s.start); if (x >= 0 && x <= W) { ctx.fillRect(x, 0, 1, 6); } }
    }

    // selection edges
    if (S.sel) {
      ctx.fillStyle = selColor;
      ctx.fillRect(xAt(S.sel.start) - 0.5, 0, 1, H - rulerH);
      ctx.fillRect(xAt(S.sel.end) - 0.5, 0, 1, H - rulerH);
    }

    // ruler
    ctx.fillStyle = css('--vscode-editor-background', '#1e1e1e');
    ctx.fillRect(0, H - rulerH, W, rulerH);
    ctx.fillStyle = hexA(muted, 0.5);
    ctx.fillRect(0, H - rulerH, W, 1);
    const span = S.view.end - S.view.start;
    const step = niceStep(span / Math.max(1, W / 90));
    ctx.font = `10px ${css('--vscode-editor-font-family', 'monospace')}`;
    ctx.textBaseline = 'middle';
    for (let t = Math.ceil(S.view.start / step) * step; t <= S.view.end; t += step) {
      const x = xAt(t);
      ctx.fillStyle = hexA(muted, 0.6); ctx.fillRect(x, H - rulerH, 1, 5);
      ctx.fillStyle = muted; ctx.fillText(fmt(t, step < 1), x + 3, H - rulerH / 2 + 1);
    }

    // hover line
    if (S.hoverT !== null && !S.drag) {
      ctx.fillStyle = hexA(fg, 0.25);
      ctx.fillRect(xAt(S.hoverT), 0, 1, H - rulerH);
    }

    // playhead
    const px = xAt(audio.currentTime || 0);
    if (px >= 0 && px <= W) { ctx.fillStyle = css('--playhead', '#fff'); ctx.fillRect(px - 0.5, 0, 1.5, H - rulerH); }
  }

  function niceStep(raw) {
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    return steps.find(s => s >= raw) ?? 3600;
  }

  function hexA(color, a) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
    if (!m) { return color; }
    let h = m[1]; if (h.length === 3) { h = h.split('').map(c => c + c).join(''); }
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ------------------------------------------------------------ view / zoom
  function setView(start, end) {
    const d = S.duration || 1;
    let span = clamp(end - start, Math.min(0.01, d), d);
    start = clamp(start, 0, d - span);
    S.view = { start, end: start + span };
    requestDraw();
  }
  function zoom(factor, around) {
    const c = around ?? (S.view.start + S.view.end) / 2;
    const span = (S.view.end - S.view.start) * factor;
    const ratio = (c - S.view.start) / (S.view.end - S.view.start);
    setView(c - span * ratio, c - span * ratio + span);
  }
  const fit = () => setView(0, S.duration || 1);

  // ------------------------------------------------------------ selection
  function setSel(sel) {
    S.sel = sel && sel.end - sel.start > 0.0005 ? { start: clamp(sel.start, 0, S.duration), end: clamp(sel.end, 0, S.duration) } : null;
    $('export').disabled = !S.sel;
    $('zoomSel').disabled = !S.sel;
    $('selInfo').textContent = S.sel
      ? `Selection ${fmt(S.sel.start)} → ${fmt(S.sel.end)}  (${fmt(S.sel.end - S.sel.start)})`
      : 'No selection — drag on the waveform';
    requestDraw();
  }

  canvas.addEventListener('mousedown', e => {
    canvas.focus();
    const t = timeAt(e.offsetX);
    if (e.button === 1 || e.altKey) { S.drag = { x: e.offsetX, t, moved: false, mode: 'pan', view: { ...S.view } }; return; }
    if (e.shiftKey && S.sel) {
      // extend selection
      const d0 = Math.abs(t - S.sel.start), d1 = Math.abs(t - S.sel.end);
      S.drag = { x: e.offsetX, t: d0 < d1 ? S.sel.end : S.sel.start, moved: true, mode: 'select' };
      setSel({ start: Math.min(S.drag.t, t), end: Math.max(S.drag.t, t) });
      return;
    }
    S.drag = { x: e.offsetX, t, moved: false, mode: 'select' };
  });
  window.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    S.hoverT = x >= 0 && x <= rect.width && e.clientY >= rect.top && e.clientY <= rect.bottom ? timeAt(x) : null;
    if (!S.drag) { requestDraw(); return; }
    if (Math.abs(x - S.drag.x) > 3) { S.drag.moved = true; }
    if (S.drag.mode === 'pan' && S.drag.view) {
      const dt = ((S.drag.x - x) / rect.width) * (S.drag.view.end - S.drag.view.start);
      setView(S.drag.view.start + dt, S.drag.view.end + dt);
    } else if (S.drag.moved) {
      const t = clamp(timeAt(clamp(x, 0, rect.width)), 0, S.duration);
      setSel({ start: Math.min(S.drag.t, t), end: Math.max(S.drag.t, t) });
    }
  });
  window.addEventListener('mouseup', () => {
    if (S.drag && S.drag.mode === 'select' && !S.drag.moved) { seek(S.drag.t); }
    S.drag = null; requestDraw();
  });
  canvas.addEventListener('dblclick', e => {
    // double-click selects the sound region (between silences) under the cursor, or clears.
    const t = timeAt(e.offsetX);
    const seg = S.segments.find(s => t >= s.start && t <= s.end);
    setSel(seg ? { ...seg } : null);
  });
  canvas.addEventListener('mouseleave', () => { S.hoverT = null; requestDraw(); });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const span = S.view.end - S.view.start;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = (e.shiftKey ? e.deltaY : e.deltaX) / canvas.clientWidth * span;
      setView(S.view.start + d, S.view.end + d);
    } else {
      zoom(Math.pow(1.0015, e.deltaY), timeAt(e.offsetX));
    }
  }, { passive: false });

  // ------------------------------------------------------------ playback
  function seek(t) {
    audio.currentTime = clamp(t, 0, S.duration || audio.duration || 0);
    tick(true);
  }
  function togglePlay() {
    if (!audio.src) { return; }
    if (audio.paused) {
      if (S.sel && (audio.currentTime < S.sel.start || audio.currentTime >= S.sel.end - 0.01)) { audio.currentTime = S.sel.start; }
      audio.play().catch(err => showError(`Playback failed: ${err.message}`));
    } else { audio.pause(); }
  }
  function stop() { audio.pause(); seek(S.sel ? S.sel.start : 0); }
  function playRange(a, b) { setSel({ start: a, end: b }); audio.currentTime = a; audio.play().catch(() => undefined); }

  function tick(force = false) {
    const t = audio.currentTime || 0;
    if (S.sel && !audio.paused) {
      if (t >= S.sel.end) {
        if (S.loop) { audio.currentTime = S.sel.start; }
        else { audio.pause(); audio.currentTime = S.sel.end; }
      }
    }
    $('pos').textContent = fmt(t);
    // keep playhead visible while playing
    if (!audio.paused && (t > S.view.end || t < S.view.start)) {
      const span = S.view.end - S.view.start; setView(t - span * 0.05, t + span * 0.95);
    }
    highlightSegment(t);
    if (force || !audio.paused) { requestDraw(); }
  }
  (function loop() { if (!audio.paused) { tick(); } requestAnimationFrame(loop); })();
  audio.addEventListener('play', () => { $('play').innerHTML = ic('pause'); });
  audio.addEventListener('pause', () => { $('play').innerHTML = ic('play'); tick(true); });
  audio.addEventListener('ended', () => { if (S.loop) { seek(S.sel ? S.sel.start : 0); audio.play(); } });
  audio.addEventListener('loadedmetadata', () => { if (!S.duration && isFinite(audio.duration)) { S.duration = audio.duration; $('dur').textContent = fmt(S.duration); fit(); } });
  audio.addEventListener('error', () => showError('This audio could not be played in the editor preview (analysis tools still work).'));

  $('play').onclick = togglePlay;
  $('stop').onclick = stop;
  $('loop').onclick = () => { S.loop = !S.loop; $('loop').classList.toggle('on', S.loop); };
  $('rate').onchange = () => { audio.playbackRate = Number($('rate').value); };
  $('vol').oninput = () => { audio.volume = Number($('vol').value); };
  audio.volume = 0.9;
  $('zoomIn').onclick = () => zoom(0.5);
  $('zoomOut').onclick = () => zoom(2);
  $('zoomFit').onclick = fit;
  $('zoomSel').onclick = () => { if (S.sel) { const pad = (S.sel.end - S.sel.start) * 0.05; setView(S.sel.start - pad, S.sel.end + pad); } };
  $('export').onclick = () => { if (S.sel) { vscode.postMessage({ type: 'exportSelection', start: S.sel.start, end: S.sel.end }); } };

  document.addEventListener('keydown', e => {
    if (/** @type {HTMLElement} */ (e.target).tagName === 'INPUT' || /** @type {HTMLElement} */ (e.target).tagName === 'SELECT') { return; }
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'Home': stop(); break;
      case 'l': case 'L': $('loop').click(); break;
      case 'Escape': setSel(null); break;
      case 'e': case 'E': $('export').click(); break;
      case '+': case '=': zoom(0.5); break;
      case '-': zoom(2); break;
      case '0': fit(); break;
      case 'z': case 'Z': $('zoomSel').click(); break;
      case 'ArrowLeft': seek((audio.currentTime || 0) - (e.shiftKey ? 5 : 1)); break;
      case 'ArrowRight': seek((audio.currentTime || 0) + (e.shiftKey ? 5 : 1)); break;
    }
  });

  // ------------------------------------------------------------ panels
  const panels = ['levels', 'spectrogram', 'silence', 'transcript'];
  const loaded = new Set();
  function openPanel(name, force = false) {
    const el = $(`panel-${name}`);
    const btn = document.querySelector(`[data-panel="${name}"]`);
    if (!force && !el.hidden) { el.hidden = true; btn?.classList.remove('on'); return; }
    el.hidden = false; btn?.classList.add('on');
    if (loaded.has(name) && !force) { return; }
    loaded.add(name);
    if (name === 'levels') { $('levelsBody').textContent = 'Measuring…'; vscode.postMessage({ type: 'analyze' }); }
    if (name === 'spectrogram') { $('specBody').textContent = 'Computing…'; vscode.postMessage({ type: 'spectrogram', width: Math.round(canvas.clientWidth * (window.devicePixelRatio || 1)) }); }
    if (name === 'silence') { $('silenceBody').textContent = 'Detecting…'; vscode.postMessage({ type: 'silence' }); }
    if (name === 'transcript' && !S.transcript) { renderTranscript(); }
  }
  document.querySelectorAll('[data-panel]').forEach(b => b.addEventListener('click', () => openPanel(/** @type {HTMLElement} */ (b).dataset.panel)));
  document.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => vscode.postMessage({ type: 'run', command: /** @type {HTMLElement} */ (b).dataset.run, at: audio.currentTime || 0 })));
  $('levelsRefresh').onclick = () => openPanel('levels', true);
  $('trun').onclick = () => { $('transcriptBody').textContent = 'Transcribing…'; vscode.postMessage({ type: 'transcribe' }); };
  $('tcopy').onclick = () => S.transcript && vscode.postMessage({ type: 'copy', text: S.transcript.map(s => s.text).join('\n') });
  $('tsearch').oninput = () => renderTranscript();

  function renderLevels(r) {
    if (!r) { $('levelsBody').textContent = 'Measurement cancelled or failed.'; return; }
    const f = (v, u) => (v === null || v === undefined || Number.isNaN(v) ? '—' : !isFinite(v) ? '−∞' : v.toFixed(1)) + (u ? ` ${u}` : '');
    const meter = (v, lo, hi) => `<div class="meter"><div data-w="${clamp(((v - lo) / (hi - lo)) * 100, 0, 100).toFixed(1)}"></div></div>`;
    const stats = Object.entries(r.stats || {}).filter(([k]) => /Peak level|RMS level|Crest|Dynamic range|DC offset|Noise floor|Zero crossings rate|Flat factor/.test(k));
    $('levelsBody').classList.remove('muted');
    $('levelsBody').innerHTML = `
      <div class="grid">
        <div><div class="muted">Integrated loudness</div><div class="big">${f(r.integratedLufs, 'LUFS')}</div>${meter(r.integratedLufs, -40, 0)}</div>
        <div><div class="muted">True peak</div><div class="big">${f(r.truePeakDbtp, 'dBTP')}</div>${meter(r.truePeakDbtp, -30, 3)}</div>
        <div><div class="muted">Loudness range</div><div class="big">${f(r.lra, 'LU')}</div>${meter(r.lra, 0, 25)}</div>
      </div>
      <table class="mt12">
        <tr><th>Mean volume</th><td>${f(r.meanVolumeDb, 'dB')}</td><th>Max volume</th><td>${f(r.maxVolumeDb, 'dB')}</td></tr>
        ${stats.map(([k, v]) => `<tr><th>${esc(k)}</th><td colspan="3">${esc(String(v))}</td></tr>`).join('')}
        <tr><th>To −14 LUFS</th><td>${isFinite(r.integratedLufs) ? ((-14 - r.integratedLufs >= 0 ? '+' : '') + (-14 - r.integratedLufs).toFixed(1) + ' dB') : '—'}</td>
            <th>To −23 LUFS</th><td>${isFinite(r.integratedLufs) ? ((-23 - r.integratedLufs >= 0 ? '+' : '') + (-23 - r.integratedLufs).toFixed(1) + ' dB') : '—'}</td></tr>
      </table>`;
    // CSP forbids inline style attributes; set meter widths through the CSSOM instead.
    $('levelsBody').querySelectorAll('[data-w]').forEach((/** @type {HTMLElement} */ el) => { el.style.width = `${el.dataset.w}%`; });
  }

  function renderRegions() {
    const body = $('silenceBody');
    if (!S.segments.length) { body.textContent = 'No sound regions found with the current threshold (see soundLab.silence.* settings).'; return; }
    $('silenceSummary').textContent = `${S.segments.length} regions · ${S.silences.length} silences — double-click a region on the waveform to select it`;
    body.classList.remove('muted');
    body.innerHTML = `<div class="regions">${S.segments.map((s, i) =>
      `<span class="region" data-i="${i}" title="Click: select & play · Shift-click: select only">#${i + 1} ${fmt(s.start)} · ${fmt(s.end - s.start)}</span>`).join('')}</div>`;
    body.querySelectorAll('.region').forEach(el => el.addEventListener('click', (/** @type {MouseEvent} */ e) => {
      const s = S.segments[Number(/** @type {HTMLElement} */ (el).dataset.i)];
      if (e.shiftKey) { setSel({ ...s }); } else { playRange(s.start, s.end); }
    }));
  }

  function renderTranscript() {
    const body = $('transcriptBody');
    if (!S.transcript || !S.transcript.length) {
      body.classList.add('muted');
      body.innerHTML = 'No transcript yet. <button class="link" id="tgo">'+ic('transcribe')+'Transcribe now</button>';
      const go = document.getElementById('tgo'); if (go) { go.onclick = () => $('trun').click(); }
      return;
    }
    const q = String($('tsearch').value || '').toLowerCase();
    body.classList.remove('muted');
    body.innerHTML = S.transcript.map((s, i) => (!q || s.text.toLowerCase().includes(q))
      ? `<div class="seg" data-i="${i}" title="Click: play from here · Shift-click: select this line as a sample"><span class="ts">${fmt(s.start)}</span><span>${esc(s.text)}</span></div>` : '').join('');
    body.querySelectorAll('.seg').forEach(el => el.addEventListener('click', (/** @type {MouseEvent} */ e) => {
      if (window.getSelection()?.toString()) { return; }
      const s = S.transcript[Number(/** @type {HTMLElement} */ (el).dataset.i)];
      if (e.shiftKey) { setSel({ start: s.start, end: s.end }); }
      else { setSel(null); seek(s.start); audio.play().catch(() => undefined); }
    }));
    S.activeSeg = -1;
  }

  function highlightSegment(t) {
    if (!S.transcript) { return; }
    const i = S.transcript.findIndex(s => t >= s.start && t < s.end);
    if (i === S.activeSeg) { return; }
    document.querySelector('.seg.active')?.classList.remove('active');
    S.activeSeg = i;
    const el = document.querySelector(`.seg[data-i="${i}"]`);
    if (el) {
      el.classList.add('active');
      // Scroll only the transcript list — scrollIntoView would also scroll the page away from the waveform.
      const list = $('transcriptBody'), top = /** @type {HTMLElement} */ (el).offsetTop;
      if (top < list.scrollTop || top + /** @type {HTMLElement} */ (el).offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = Math.max(0, top - list.clientHeight / 3);
      }
    }
  }

  function showError(msg) { const el = $('error'); el.textContent = msg; el.hidden = false; $('loading').hidden = true; }

  function renderInfo(i) {
    const chips = [];
    chips.push(i.codec);
    if (i.sampleRate) { chips.push(`${(i.sampleRate / 1000).toFixed(i.sampleRate % 1000 ? 1 : 0)} kHz`); }
    if (i.bitDepth) { chips.push(`${i.bitDepth}-bit${/flt|dbl/.test(i.sampleFmt || '') ? ' float' : ''}`); }
    chips.push(i.channels === 1 ? 'mono' : i.channels === 2 ? 'stereo' : `${i.channels} ch`);
    if (i.bitRate) { chips.push(`${Math.round(i.bitRate / 1000)} kb/s`); }
    if (i.size) { chips.push(i.size > 1048576 ? `${(i.size / 1048576).toFixed(1)} MB` : `${Math.round(i.size / 1024)} KB`); }
    if (i.tags?.title) { chips.push(`“${i.tags.title}”`); }
    $('chips').innerHTML = chips.map(c => `<span class="chip">${esc(String(c))}</span>`).join('');
    S.duration = i.duration || S.duration;
    $('dur').textContent = fmt(S.duration);
    fit();
  }

  // ------------------------------------------------------------ messages
  window.addEventListener('message', ev => {
    const m = ev.data;
    switch (m.type) {
      case 'info': S.info = m.info; renderInfo(m.info); break;
      case 'audio': {
        const t = audio.currentTime || 0;
        audio.src = m.src; audio.load();
        audio.addEventListener('loadedmetadata', () => { audio.currentTime = Math.min(t, audio.duration || 0); }, { once: true });
        break;
      }
      case 'peaks':
        S.peaks = m.peaks.data; S.bps = m.peaks.bucketsPerSecond;
        if (!S.duration) { S.duration = m.peaks.duration; fit(); }
        $('loading').hidden = true; requestDraw(); break;
      case 'levels': renderLevels(m.report); break;
      case 'spectrogram':
        if (!m.src) { $('specBody').textContent = 'Spectrogram failed — see the Sound Lab log.'; break; }
        $('specBody').classList.remove('muted');
        $('specBody').innerHTML = `<img src="${m.src}" alt="Spectrogram" title="Click to seek">`;
        $('specBody').querySelector('img').addEventListener('click', (/** @type {MouseEvent} */ e) => {
          // showspectrumpic's legend adds fixed margins: plot starts at x=141 and the image is 282 px wider than the plot.
          const img = /** @type {HTMLImageElement} */ (e.target); const r = img.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * img.naturalWidth;
          const f = clamp((px - 141) / Math.max(1, img.naturalWidth - 282), 0, 1);
          seek(f * S.duration);
        });
        break;
      case 'regions': S.silences = m.silences; S.segments = m.segments; renderRegions(); requestDraw(); break;
      case 'transcript':
        S.transcript = m.segments; renderTranscript(); requestDraw();
        if (m.segments && m.segments.length) { $('panel-transcript').hidden = false; document.querySelector('[data-panel="transcript"]')?.classList.add('on'); }
        break;
      case 'busy': break;
      case 'toast': toast(m.text); break;
      case 'error': showError(m.message); break;
    }
  });

  new ResizeObserver(() => requestDraw()).observe(canvas);
  vscode.postMessage({ type: 'ready' });
})();
