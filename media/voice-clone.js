// @ts-check
// Voice Clone wizard webview.
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
  const esc = (/** @type {string} */ s) => String(s ?? '').replace(/[&<>"']/g, c => /** @type {any} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ic = (/** @type {string} */ n) => `<svg class="ic" aria-hidden="true"><use href="#sl-${n}"/></svg>`;
  const send = (/** @type {string} */ type, extra = {}) => vscode.postMessage({ type, ...extra });
  document.body.classList.add('editor');

  const S = {
    step: 1, purpose: /** @type {string} */ ('presentation'), prompts: /** @type {Record<string,string[]>} */ ({}),
    index: 0, takes: /** @type {any[]} */ ([]), recording: false, imported: false,
    profiles: /** @type {any[]} */ ([]), profile: /** @type {any} */ (null), files: /** @type {Record<string,string>} */ ({}), busy: false,
  };

  // ------------------------------------------------------------ navigation
  function go(step) {
    S.step = step;
    for (let i = 1; i <= 4; i++) { $(`step${i}`).hidden = i !== step; }
    document.querySelectorAll('.step').forEach(el => {
      const n = Number(/** @type {HTMLElement} */ (el).dataset.step);
      el.classList.toggle('on', n === step); el.classList.toggle('done', n < step);
    });
    $('err').textContent = '';
    if (step === 2) { renderPrompt(); }
    if (step === 4) { renderUse(); }
  }

  function choosePurpose(p, scope) {
    S.purpose = p;
    document.querySelectorAll(`${scope} [data-purpose]`).forEach(c => c.classList.toggle('on', /** @type {HTMLElement} */ (c).dataset.purpose === p));
    if (scope === '#purposes4') { for (const k of ['presentation', 'audiobook', 'vocals']) { $(`form-${k}`).hidden = k !== p; } updateCreate(); }
  }
  for (const scope of ['#purposes', '#purposes4']) {
    document.querySelectorAll(`${scope} [data-purpose]`).forEach(c => {
      const pick = () => choosePurpose(/** @type {HTMLElement} */ (c).dataset.purpose, scope);
      c.addEventListener('click', pick);
      c.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
  }

  // ------------------------------------------------------------ step 1
  const canStart = () => $('vname').value.trim().length > 0 && $('consent').checked;
  const refresh1 = () => { $('toRecord').disabled = !canStart(); };
  $('vname').addEventListener('input', refresh1);
  $('consent').addEventListener('change', refresh1);
  $('toRecord').addEventListener('click', () => { S.takes = []; S.index = 0; S.imported = false; go(2); });
  $('import').addEventListener('click', () => {
    if (!canStart()) { $('err').textContent = 'Give the voice a name and confirm the consent statement first.'; return; }
    send('import');
  });

  function renderProfiles() {
    $('existing').hidden = !S.profiles.length;
    $('profiles').innerHTML = S.profiles.map(p => `
      <div class="item">${ic('voice')}<span><b>${esc(p.name)}</b> <span class="small muted">${esc(p.purpose)} · ${esc(p.model.split('/').pop())}</span></span><span class="spacer"></span>
        <button class="link" data-play="${esc(p.refSrc)}" aria-label="Play reference" title="Play the reference recording">${ic('play')}</button>
        <button class="link" data-use="${esc(p.id)}">${ic('arrow-right')}Use</button>
        <button class="link danger" data-del="${esc(p.id)}" data-name="${esc(p.name)}" aria-label="Delete voice" title="Delete">${ic('trash')}</button></div>`).join('');
    $('profiles').querySelectorAll('[data-use]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => useProfile(b.dataset.use)));
    $('profiles').querySelectorAll('[data-del]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => send('deleteVoice', { id: b.dataset.del, name: b.dataset.name })));
    $('profiles').querySelectorAll('[data-play]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => { const a = new Audio(b.dataset.play); a.play(); }));
  }

  function useProfile(id) {
    const p = S.profiles.find(x => x.id === id);
    if (!p) { return; }
    S.profile = p;
    choosePurpose(p.purpose, '#purposes4');
    go(4);
  }

  // ------------------------------------------------------------ step 2: read aloud
  function prompts() { return S.prompts[S.purpose] || []; }
  function renderPrompt() {
    const list = prompts();
    $('promptNo').textContent = `Sentence ${S.index + 1} of ${list.length}`;
    $('prompt').textContent = list[S.index] || '';
    $('takeBar').innerHTML = list.map((_, i) => `<span class="take${S.takes[i]?.report?.ok ? ' ok' : ''}${i === S.index ? ' cur' : ''}"></span>`).join('');
    const t = S.takes[S.index];
    $('takeInfo').innerHTML = t ? takeHtml(t) : '<span class="small muted">Press Record, read the sentence, then press Stop.</span>';
    $('takePlayer').hidden = !t?.src;
    if (t?.src) { $('takePlayer').src = t.src; }
    $('prev').disabled = S.index === 0 || S.recording;
    const usable = t && (t.report?.ok || t.force);
    $('next').disabled = !usable || S.recording;
    $('next').innerHTML = (S.index === list.length - 1 ? 'Build my voice' : 'Next') + ic('arrow-right');
    $('rec').innerHTML = S.recording ? `${ic('stop')}Stop` : `${ic('record')}${t ? 'Retake' : 'Record'}`;
    $('rec').classList.toggle('primary', !t || S.recording);
    $('recTime').hidden = !S.recording;
  }
  function takeHtml(t) {
    if (t.error) { return `<span class="status err">${esc(t.error)}</span>`; }
    const r = t.report;
    const facts = `<span class="small muted">${r.duration.toFixed(1)} s · peak ${isFinite(r.peakDb) ? r.peakDb.toFixed(1) : '−∞'} dB · average ${isFinite(r.meanDb) ? r.meanDb.toFixed(1) : '−∞'} dB</span>`;
    const warn = r.warnings.map((/** @type {string} */ w) => `<span class="warn small">${ic('info')}${esc(w)}</span>`).join('');
    const status = r.ok ? `<span class="status ok">${ic('check')}Good take</span>` : `<span class="status err">Please retake</span> <button class="link" id="force">${ic('check')}use it anyway</button>`;
    return `<div class="row">${status}${facts}</div>${warn}`;
  }
  $('rec').addEventListener('click', () => {
    if (S.recording) { send('stop'); return; }
    S.recording = true; S.takes[S.index] = undefined; $('recSecs').textContent = '0.0'; renderPrompt();
    send('record', { index: S.index, device: $('device').value });
  });
  $('prev').addEventListener('click', () => { S.index--; renderPrompt(); });
  $('next').addEventListener('click', () => {
    if (S.index < prompts().length - 1) { S.index++; renderPrompt(); return; }
    go(3); build();
  });
  $('takeInfo').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    if (/** @type {HTMLElement} */ (e.target).id === 'force') { S.takes[S.index].force = true; renderPrompt(); }
  });
  document.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (S.step === 2 && e.key === ' ' && /** @type {HTMLElement} */ (e.target).tagName !== 'BUTTON') { e.preventDefault(); $('rec').click(); }
  });

  // ------------------------------------------------------------ step 3: build & preview
  function build() {
    $('building').hidden = false; $('building').className = 'status'; $('building').textContent = 'Building your voice…'; $('built').hidden = true;
    send('build', { purpose: S.purpose });
  }
  $('rerecord').addEventListener('click', () => { S.takes = []; S.index = 0; go(S.imported ? 1 : 2); });
  $('preview').addEventListener('click', () => send('preview', { text: $('previewText').value, model: $('model').value, refText: $('refText').value }));
  $('save').addEventListener('click', () => send('save', { name: $('vname').value.trim(), purpose: S.purpose, model: $('model').value, refText: $('refText').value.trim(), consent: $('consent').checked }));

  // ------------------------------------------------------------ step 4: create
  function renderUse() {
    $('useName').textContent = S.profile?.name || '';
    $('useModel').textContent = S.profile ? `· ${S.profile.model.split('/').pop()}` : '';
    choosePurpose(S.purpose, '#purposes4');
  }
  $('changeVoice').addEventListener('click', () => go(1));
  const radio = (/** @type {string} */ name) => /** @type {HTMLInputElement|null} */ (document.querySelector(`input[name=${name}]:checked`))?.value;
  document.querySelectorAll('[data-pick]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => send('pick', { purpose: b.dataset.pick, source: radio('psrc') })));
  document.querySelectorAll('input[name=psrc], input[name=asrc]').forEach(r => r.addEventListener('change', () => { S.files[S.purpose] = ''; $(`pick-${S.purpose}`).textContent = ''; updateCreate(); }));
  function updateCreate() {
    const src = S.purpose === 'presentation' ? radio('psrc') : S.purpose === 'audiobook' ? radio('asrc') : 'file';
    const needsFile = src !== 'editor';
    document.querySelectorAll(`#form-${S.purpose} [data-pick]`).forEach(b => { /** @type {HTMLElement} */ (b).hidden = !needsFile; });
    $('create').disabled = S.busy || !S.profile || (needsFile && !S.files[S.purpose]);
  }
  $('create').addEventListener('click', () => {
    S.busy = true; updateCreate(); $('results').innerHTML = ''; $('progress').className = 'status'; $('progress').textContent = 'Starting…';
    const source = S.purpose === 'presentation' ? radio('psrc') : S.purpose === 'audiobook' ? radio('asrc') : 'file';
    send('create', { profileId: S.profile.id, purpose: S.purpose, source, file: S.files[S.purpose], bpm: Number($('bpm').value), cues: $('cues').value, double: $('double').checked });
  });

  // ------------------------------------------------------------ messages
  window.addEventListener('message', ev => {
    const m = ev.data;
    switch (m.type) {
      case 'init':
        S.prompts = m.prompts; S.profiles = m.profiles;
        if (m.model) { $('model').value = m.model; }
        choosePurpose('presentation', '#purposes');
        renderProfiles(); go(1);
        if (m.preselect) { useProfile(m.preselect); }
        break;
      case 'devices':
        $('device').innerHTML = '<option value="">Default input</option>' + m.list.map((/** @type {any} */ d) => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('');
        break;
      case 'recording': S.recording = true; renderPrompt(); break;
      case 'recTime': $('recSecs').textContent = Number(m.seconds).toFixed(1); break;
      case 'take':
        S.recording = false;
        S.takes[m.index] = m.error ? { error: m.error } : { src: m.src, report: m.report };
        if (S.step === 2) { renderPrompt(); }
        break;
      case 'imported': S.imported = true; S.takes = [{ report: { ok: true } }]; go(3); build(); break;
      case 'building': $('building').textContent = m.status; break;
      case 'built':
        $('building').hidden = true; $('built').hidden = false;
        $('refPlayer').src = m.refSrc; $('refText').value = m.refText || '';
        break;
      case 'previewing': $('preview').disabled = true; $('preview').innerHTML = `${ic('speak')}Speaking…`; break;
      case 'preview':
        $('preview').disabled = false; $('preview').innerHTML = `${ic('speak')}Preview`;
        $('previewPlayer').hidden = false; $('previewPlayer').src = m.src; $('previewPlayer').play().catch(() => undefined);
        break;
      case 'saved': S.profiles = m.profiles; S.profile = m.profile; renderProfiles(); go(4); break;
      case 'profiles': S.profiles = m.profiles; renderProfiles(); break;
      case 'useProfile': S.profiles.length && useProfile(m.id); break;
      case 'picked': S.files[m.purpose] = m.path; $(`pick-${m.purpose}`).textContent = m.name; updateCreate(); break;
      case 'progress':
        $('progress').textContent = m.text; $('progress').className = 'status' + (m.error ? ' err' : '');
        if (m.error) { S.busy = false; updateCreate(); }
        break;
      case 'done':
        S.busy = false; updateCreate();
        $('progress').className = 'status ok'; $('progress').innerHTML = `${ic('check')}Done`;
        $('results').innerHTML = m.files.map((/** @type {any} */ f) => `<div class="item">${ic(/\.(mp4|mov|mkv)$/i.test(f.name) ? 'presentation' : /\.srt$/i.test(f.name) ? 'transcribe' : 'music')}<span>${esc(f.name)}</span><span class="spacer"></span>
          ${f.src ? `<button class="link" data-play="${esc(f.src)}" aria-label="Play" title="Play">${ic('play')}</button>` : ''}
          <button class="link" data-open="${esc(f.path)}">${ic('open-external')}Open</button></div>`).join('');
        $('results').querySelectorAll('[data-open]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => send('open', { path: b.dataset.open })));
        $('results').querySelectorAll('[data-play]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => new Audio(b.dataset.play).play()));
        break;
      case 'error':
        $('err').textContent = m.message;
        S.recording = false; S.busy = false;
        if (S.step === 2) { renderPrompt(); }
        if (S.step === 3) { $('building').hidden = false; $('building').className = 'status err'; $('building').textContent = m.message; $('preview').disabled = false; $('preview').innerHTML = `${ic('speak')}Preview`; }
        if (S.step === 4) { updateCreate(); $('progress').textContent = ''; }
        break;
    }
  });
  send('ready');
})();
