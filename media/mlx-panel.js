// @ts-check
// MLX Audio sidebar panel.
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
  const esc = (/** @type {string} */ s) => String(s).replace(/[&<>"']/g, c => /** @type {any} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ic = (/** @type {string} */ n) => `<svg class="ic" aria-hidden="true"><use href="#sl-${n}"/></svg>`;
  const send = (/** @type {string} */ type, extra = {}) => vscode.postMessage({ type, ...extra });
  const saved = vscode.getState() || {};
  let S = /** @type {any} */ (null);
  let resultPath = '';

  $('text').value = saved.text || '';
  $('text').addEventListener('input', () => vscode.setState({ ...vscode.getState(), text: $('text').value }));
  for (const [id, type] of [['start', 'start'], ['stop', 'stop'], ['studio', 'studio'], ['modelsBtn', 'models'], ['refresh', 'refresh'], ['cloneBtn', 'clone'], ['transcribe', 'transcribe'], ['separate', 'separate']]) {
    $(id).addEventListener('click', () => send(type));
  }
  $('speed').addEventListener('input', () => { $('speedVal').textContent = `${Number($('speed').value).toFixed(2)}×`; });
  $('ttsModel').addEventListener('change', () => { vscode.setState({ ...vscode.getState(), model: $('ttsModel').value }); loadVoices(); });
  $('speak').addEventListener('click', () => {
    $('err').textContent = '';
    $('speak').disabled = true;
    send('speak', { text: $('text').value, model: $('ttsModel').value, voice: $('voice').value, speed: Number($('speed').value) });
  });
  $('openResult').addEventListener('click', () => resultPath && send('open', { path: resultPath }));

  function loadVoices() {
    const model = $('ttsModel').value;
    $('voiceRow').hidden = model.startsWith('profile:');
    if (!model.startsWith('profile:')) { $('voice').innerHTML = '<option value="">Loading voices…</option>'; send('voices', { model }); }
  }

  function renderState() {
    const h = S.health;
    $('dot').className = 'dot' + (S.starting ? ' busy' : h.reachable ? ' on' : '');
    $('srvText').innerHTML = S.starting ? 'Starting…' : h.reachable ? `Running · <span class="muted">${esc(h.url)} · ${esc(S.mode)}</span>` : `Not running · <span class="muted">${esc(S.mode)}</span>`;
    $('start').hidden = h.reachable || S.mode === 'external';
    $('stop').hidden = !h.reachable || S.mode === 'external';
    $('models').innerHTML = (h.loadedModels || []).map((/** @type {string} */ m) => `<span class="pill" title="${esc(m)}">${esc(m.split('/').pop())}</span>`).join('');
    // voices list
    $('voices').innerHTML = S.profiles.length ? S.profiles.map((/** @type {any} */ p) => `
      <div class="item" data-id="${esc(p.id)}">
        ${ic('voice')}<span><b>${esc(p.name)}</b> <span class="muted small">${esc(p.purpose)}</span></span><span class="spacer"></span>
        <button class="link" data-play="${esc(p.ref)}" title="Play the reference recording" aria-label="Play reference">${ic('play')}</button>
        <button class="link" data-use="${esc(p.id)}" title="Narrate with this voice">${ic('arrow-right')}Use</button>
        <button class="link danger" data-del="${esc(p.id)}" data-name="${esc(p.name)}" title="Delete" aria-label="Delete voice">${ic('trash')}</button>
      </div>`).join('') : '<span class="small muted">No cloned voices yet.</span>';
    $('voices').querySelectorAll('[data-use]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => send('clone', { profileId: b.dataset.use })));
    $('voices').querySelectorAll('[data-del]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => send('deleteVoice', { id: b.dataset.del, name: b.dataset.name })));
    $('voices').querySelectorAll('[data-play]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => { $('player').src = b.dataset.play; $('result').hidden = false; $('player').play(); }));
    // model select: TTS models + cloned voices
    const want = vscode.getState()?.model || $('ttsModel').value || S.ttsModel;
    const opts = S.ttsModels.map((/** @type {string} */ m) => `<option value="${esc(m)}">${esc(m.replace('mlx-community/', ''))}</option>`).join('')
      + (S.profiles.length ? `<optgroup label="My cloned voices">${S.profiles.map((/** @type {any} */ p) => `<option value="profile:${esc(p.id)}">${esc(p.name)} (${esc(p.model.split('/').pop())})</option>`).join('')}</optgroup>` : '');
    if ($('ttsModel').dataset.opts !== opts) {
      $('ttsModel').innerHTML = opts; $('ttsModel').dataset.opts = opts;
      $('ttsModel').value = [...$('ttsModel').options].some((/** @type {HTMLOptionElement} */ o) => o.value === want) ? want : S.ttsModel;
      loadVoices();
    }
  }

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'state') { S = m; renderState(); }
    if (m.type === 'voices' && m.model === $('ttsModel').value) {
      $('voice').innerHTML = m.list.length ? m.list.map((/** @type {any} */ v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')
        : `<option value="">${m.offline ? '(start the server to list voices)' : '(model default)'}</option>`;
      if (S?.voice && m.list.some((/** @type {any} */ v) => v.id === S.voice)) { $('voice').value = S.voice; }
    }
    if (m.type === 'tts') {
      $('ttsStatus').textContent = m.status || '';
      $('ttsStatus').className = 'status' + (m.error ? ' err' : m.done ? ' ok' : '');
      if (m.done || m.error) { $('speak').disabled = false; }
      if (m.done) { resultPath = m.path; $('player').src = m.src; $('resultName').textContent = m.name; $('result').hidden = false; $('player').play().catch(() => undefined); }
    }
    if (m.type === 'error') { $('err').textContent = m.message; $('speak').disabled = false; $('ttsStatus').textContent = ''; }
  });
  send('ready');
})();
