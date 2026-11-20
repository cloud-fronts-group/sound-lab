// @ts-check
// Presentation & Tutorial Studio webview.
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
  const esc = (/** @type {string} */ s) => String(s ?? '').replace(/[&<>"']/g, c => /** @type {any} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ic = (/** @type {string} */ n) => `<svg class="ic" aria-hidden="true"><use href="#sl-${n}"/></svg>`;
  const send = (/** @type {string} */ type, extra = {}) => vscode.postMessage({ type, ...extra });
  document.body.classList.add('editor');

  const S = {
    step: 1,
    profiles: /** @type {any[]} */ ([]),
    profile: /** @type {any} */ (null),
    prompts: /** @type {string[]} */ ([]),
    takes: /** @type {any[]} */ ([]),
    takeIdx: 0,
    recordingTake: false,
    imported: false,
    folder: '',
    scaffold: /** @type {any} */ (null),
    presentIdx: 0,
    liveRecording: false,
    liveTimer: /** @type {any} */ (null),
    liveStartedAt: 0,
    busy: false,
  };

  function go(step) {
    S.step = step;
    for (let i = 1; i <= 4; i++) { $(`pstep${i}`).hidden = i !== step; }
    document.querySelectorAll('.step').forEach(el => {
      const n = Number(/** @type {HTMLElement} */ (el).dataset.step);
      el.classList.toggle('on', n === step);
      el.classList.toggle('done', n < step);
    });
    $('perr').textContent = '';
    if (step === 1) { renderTakePrompt(); }
    if (step === 2) { updateTopicButton(); }
    if (step === 3) { renderScaffold(); }
    if (step === 4) { renderStage(); }
  }

  document.querySelectorAll('.step').forEach(el => {
    el.addEventListener('click', () => {
      const n = Number(/** @type {HTMLElement} */ (el).dataset.step);
      if (n === 1 || (n === 2 && S.profile) || (n === 3 && S.scaffold) || n === 4) { go(n); }
    });
  });

  // ------------------------------------------------------------ Step 1: Clone Voice
  function renderProfiles() {
    $('existingVoices').hidden = !S.profiles.length;
    $('voiceList').innerHTML = S.profiles.map(p => `
      <div class="item">
        ${ic('voice')}<span><b>${esc(p.name)}</b> <span class="small muted">${esc(p.purpose)} · ${esc(p.model.split('/').pop())}</span></span>
        <span class="spacer"></span>
        <button class="link" data-play="${esc(p.refSrc)}" title="Play reference">${ic('play')}</button>
        <button class="primary" data-pick-voice="${esc(p.id)}">${ic('arrow-right')}Use voice</button>
        <button class="link danger" data-del-voice="${esc(p.id)}" data-name="${esc(p.name)}" title="Delete">${ic('trash')}</button>
      </div>`).join('');
    $('voiceList').querySelectorAll('[data-play]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => new Audio(b.dataset.play).play()));
    $('voiceList').querySelectorAll('[data-pick-voice]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => selectProfile(b.dataset.pickVoice)));
    $('voiceList').querySelectorAll('[data-del-voice]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => send('deleteVoice', { id: b.dataset.delVoice, name: b.dataset.name })));
  }

  function selectProfile(id) {
    const p = S.profiles.find(x => x.id === id);
    if (!p) { return; }
    S.profile = p;
    $('activeVoiceName').textContent = p.name;
    $('activeVoiceModel').textContent = p.model.split('/').pop() || p.model;
    $('stageVoiceName').textContent = p.name;
    go(2);
  }

  const canEnroll = () => $('vname').value.trim().length > 0 && $('consent').checked;
  const refreshEnroll = () => { $('startTakes').disabled = !canEnroll(); };
  $('vname').addEventListener('input', refreshEnroll);
  $('consent').addEventListener('change', refreshEnroll);
  $('startTakes').addEventListener('click', () => {
    S.takes = []; S.takeIdx = 0; S.imported = false;
    $('enrollSetup').hidden = true; $('enrollRead').hidden = false; $('enrollBuilt').hidden = true;
    renderTakePrompt();
  });
  $('importVoice').addEventListener('click', () => {
    if (!canEnroll()) { $('perr').textContent = 'Enter a voice name and check the consent statement first.'; return; }
    send('importVoice');
  });

  function renderTakePrompt() {
    if (!S.prompts.length) { return; }
    $('takeNo').textContent = `Sentence ${S.takeIdx + 1} of ${S.prompts.length}`;
    $('takePrompt').textContent = S.prompts[S.takeIdx] || '';
    $('takeBar').innerHTML = S.prompts.map((_, i) => `<span class="take${S.takes[i]?.report?.ok ? ' ok' : ''}${i === S.takeIdx ? ' cur' : ''}"></span>`).join('');
    const t = S.takes[S.takeIdx];
    if (t) {
      if (t.error) { $('takeInfo').innerHTML = `<span class="status err">${esc(t.error)}</span>`; }
      else {
        const r = t.report;
        const okTag = r.ok ? `<span class="status ok">${ic('check')}Good take</span>` : `<span class="status err">Retake recommended</span> <button class="link" id="forceTake">${ic('check')}Use anyway</button>`;
        const warn = r.warnings.map((/** @type {string} */ w) => `<span class="warn small">${ic('info')}${esc(w)}</span>`).join('');
        $('takeInfo').innerHTML = `<div class="row">${okTag}<span class="small muted">${r.duration.toFixed(1)}s · peak ${isFinite(r.peakDb) ? r.peakDb.toFixed(1) : '-inf'} dB</span></div>${warn}`;
      }
    } else {
      $('takeInfo').innerHTML = '<span class="small muted">Press Record, read the prompt clearly, then press Stop.</span>';
    }
    $('takePlayer').hidden = !t?.src;
    if (t?.src) { $('takePlayer').src = t.src; }
    $('takePrev').disabled = S.takeIdx === 0 || S.recordingTake;
    const usable = t && (t.report?.ok || t.force);
    $('takeNext').disabled = !usable || S.recordingTake;
    $('takeNext').innerHTML = (S.takeIdx === S.prompts.length - 1 ? 'Build voice' : 'Next') + ic('arrow-right');
    $('takeRec').innerHTML = S.recordingTake ? `${ic('stop')}Stop` : `${ic('record')}${t ? 'Retake' : 'Record'}`;
    $('takeRecTime').hidden = !S.recordingTake;
  }

  $('takeRec').addEventListener('click', () => {
    if (S.recordingTake) { send('stopTake'); return; }
    S.recordingTake = true; S.takes[S.takeIdx] = undefined; $('takeSecs').textContent = '0.0'; renderTakePrompt();
    send('recordTake', { index: S.takeIdx, device: $('micDevice').value });
  });
  $('takePrev').addEventListener('click', () => { S.takeIdx--; renderTakePrompt(); });
  $('takeNext').addEventListener('click', () => {
    if (S.takeIdx < S.prompts.length - 1) { S.takeIdx++; renderTakePrompt(); return; }
    $('enrollRead').hidden = true; $('enrollBuilt').hidden = false; $('buildingMsg').hidden = false; $('builtControls').hidden = true;
    send('buildVoice');
  });
  $('takeInfo').addEventListener('click', (/** @type {MouseEvent} */ e) => {
    if (/** @type {HTMLElement} */ (e.target).id === 'forceTake') { S.takes[S.takeIdx].force = true; renderTakePrompt(); }
  });
  $('previewVoice').addEventListener('click', () => send('previewVoice', { text: $('previewLine').value, model: $('cloneModel').value, refText: $('refTranscript').value }));
  $('rerecordVoice').addEventListener('click', () => { $('enrollBuilt').hidden = true; $('enrollSetup').hidden = false; $('enrollRead').hidden = true; });
  $('saveVoice').addEventListener('click', () => send('saveVoice', { name: $('vname').value.trim(), model: $('cloneModel').value, refText: $('refTranscript').value.trim(), consent: $('consent').checked }));

  // ------------------------------------------------------------ Step 2: Topic & Folder
  $('changeVoice').addEventListener('click', () => go(1));
  $('pickFolder').addEventListener('click', () => send('pickFolder'));
  $('setGeminiKey').addEventListener('click', () => send('setGeminiKey'));
  $('minutesRange').addEventListener('input', () => { $('minutesVal').textContent = `${$('minutesRange').value} min`; });
  function updateTopicButton() {
    $('runResearch').disabled = S.busy || !$('topicInput').value.trim() || !S.folder;
  }
  $('topicInput').addEventListener('input', updateTopicButton);
  $('runResearch').addEventListener('click', () => {
    S.busy = true; updateTopicButton();
    $('researchLog').innerHTML = '';
    $('researchStatus').className = 'status';
    $('researchStatus').textContent = 'Inspecting folder & launching Google ADK Deep Research Agent…';
    send('researchAndScaffold', {
      topic: $('topicInput').value.trim(),
      folder: S.folder,
      minutes: Number($('minutesRange').value),
      audience: $('audienceInput').value.trim(),
      deepResearchAgent: $('researchAgent').value,
      profileId: S.profile?.id || '',
    });
  });

  // ------------------------------------------------------------ Step 3: Scaffold Review
  function renderScaffold() {
    if (!S.scaffold) { return; }
    const spec = S.scaffold.spec;
    const mins = (spec.estimatedSeconds / 60).toFixed(1);
    const inWin = spec.estimatedSeconds >= 300 && spec.estimatedSeconds <= 600;
    $('deckSummary').textContent = `${spec.title} · ${spec.slides.length} slides · ${mins} min (${spec.estimatedSeconds}s)`;
    $('deckTimingPill').textContent = inWin ? '5–10 min target met' : `${mins} min`;
    $('deckTimingPill').className = 'pill ' + (inWin ? 'badge-ok' : 'badge-warn');
    $('slidesEditor').innerHTML = spec.slides.map((/** @type {any} */ s, /** @type {number} */ idx) => `
      <div class="slide-card" data-slide="${idx}">
        <div class="slide-head">
          <span class="pill">Slide ${s.index}</span>
          <input type="text" class="s-title" value="${esc(s.title)}">
          <input type="number" class="s-dur w90" min="15" max="180" value="${Number(s.durationSec)}">
          <span class="small muted">sec</span>
        </div>
        <div class="col">
          <label>Bullets (one per line)</label>
          <textarea class="s-bullets" rows="2">${esc((s.bullets || []).join('\n'))}</textarea>
        </div>
        <div class="col">
          <label>Narration script (spoken in your cloned voice)</label>
          <textarea class="s-narration" rows="3">${esc(s.narration || '')}</textarea>
        </div>
      </div>`).join('');
  }

  $('saveSlides').addEventListener('click', () => {
    if (!S.scaffold) { return; }
    const cards = [...document.querySelectorAll('#slidesEditor .slide-card')];
    const updated = cards.map((card, i) => {
      const orig = S.scaffold.spec.slides[i];
      return {
        ...orig,
        title: (/** @type {HTMLInputElement} */ (card.querySelector('.s-title'))).value.trim() || orig.title,
        durationSec: Number((/** @type {HTMLInputElement} */ (card.querySelector('.s-dur'))).value) || orig.durationSec,
        bullets: (/** @type {HTMLTextAreaElement} */ (card.querySelector('.s-bullets'))).value.split(/\r?\n/).map(x => x.trim()).filter(Boolean),
        narration: (/** @type {HTMLTextAreaElement} */ (card.querySelector('.s-narration'))).value.trim(),
      };
    });
    send('saveSlides', { dir: S.scaffold.dir, slides: updated });
  });
  $('openMd').addEventListener('click', () => S.scaffold && send('openFile', { path: S.scaffold.files.markdown }));
  $('openResearch').addEventListener('click', () => S.scaffold && send('openFile', { path: S.scaffold.files.research }));
  $('openHtml').addEventListener('click', () => S.scaffold && send('openExternal', { path: S.scaffold.files.html }));
  $('toProduce').addEventListener('click', () => go(4));

  // ------------------------------------------------------------ Step 4: Present, Record & Overlay
  function renderStage() {
    const slides = S.scaffold?.spec?.slides || [];
    $('noSlidesNotice').hidden = slides.length > 0;
    $('presenterCard').hidden = slides.length === 0;
    $('overlaySlidesBtn').disabled = S.busy || !S.profile || slides.length === 0;
    if (!slides.length) { return; }
    S.presentIdx = Math.max(0, Math.min(slides.length - 1, S.presentIdx));
    const s = slides[S.presentIdx];
    $('presBadge').textContent = `Slide ${s.index} / ${slides.length}`;
    $('presSlideTitle').textContent = s.title;
    $('presBullets').innerHTML = (s.bullets || []).map((/** @type {string} */ b) => `<li>${esc(b)}</li>`).join('');
    $('presCode').hidden = !s.codeSnippet;
    $('presCode').textContent = s.codeSnippet || '';
    $('presNotes').textContent = s.narration || '';
    $('presPrev').disabled = S.presentIdx === 0;
    $('presNext').disabled = S.presentIdx >= slides.length - 1;
  }

  $('presPrev').addEventListener('click', () => {
    if (S.presentIdx > 0) {
      S.presentIdx--;
      renderStage();
      if (S.liveRecording) { send('markSlide', { index: S.presentIdx }); }
    }
  });
  $('presNext').addEventListener('click', () => {
    const slides = S.scaffold?.spec?.slides || [];
    if (S.presentIdx < slides.length - 1) {
      S.presentIdx++;
      renderStage();
      if (S.liveRecording) { send('markSlide', { index: S.presentIdx }); }
    }
  });

  $('overlaySlidesBtn').addEventListener('click', () => {
    if (!S.scaffold || !S.profile) { return; }
    S.busy = true;
    $('overlaySlidesBtn').disabled = true;
    $('produceStatus').className = 'status';
    $('produceStatus').textContent = 'Synthesizing cloned-voice narration & rendering tutorial video…';
    send('overlayPresentation', { dir: S.scaffold.dir, profileId: S.profile.id });
  });

  $('startLiveBtn').addEventListener('click', () => {
    S.liveRecording = true;
    S.liveStartedAt = Date.now();
    $('startLiveBtn').hidden = true;
    $('stopLiveBtn').hidden = false;
    $('liveTranscript').innerHTML = '';
    $('produceStatus').className = 'status';
    $('produceStatus').textContent = 'Recording live — transcript & voice cloning running concurrently…';
    const captureMode = (/** @type {HTMLInputElement} */ (document.querySelector('input[name="capMode"]:checked')))?.value || 'screen';
    clearInterval(S.liveTimer);
    S.liveTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - S.liveStartedAt) / 1000);
      $('liveTimer').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    }, 500);
    send('startLiveTutorial', {
      mode: captureMode,
      screenDevice: $('screenDevice').value,
      micDevice: $('liveMicDevice').value,
      cloneVoice: $('cloneLiveChk').checked,
      profileId: S.profile?.id || '',
      presentationDir: S.scaffold?.dir || '',
      slideIndex: S.presentIdx,
    });
  });

  $('stopLiveBtn').addEventListener('click', () => {
    clearInterval(S.liveTimer);
    $('stopLiveBtn').disabled = true;
    $('produceStatus').textContent = 'Finalizing remaining chunks, cloned narration & embedded video transcript…';
    send('stopLiveTutorial');
  });

  // ------------------------------------------------------------ Messages from extension
  window.addEventListener('message', ev => {
    const m = ev.data;
    switch (m.type) {
      case 'init':
        S.profiles = m.profiles || [];
        S.prompts = m.prompts || [];
        S.folder = m.folder || '';
        $('folderDisplay').textContent = S.folder || '(choose a folder)';
        $('minutesRange').value = String(m.defaultMinutes || 7);
        $('minutesVal').textContent = `${$('minutesRange').value} min`;
        $('adkBadge').textContent = m.adkStatus || '';
        $('geminiKeyBadge').textContent = m.hasGeminiKey ? 'Gemini API key ready' : 'Gemini API key not set';
        $('geminiKeyBadge').className = 'pill ' + (m.hasGeminiKey ? 'badge-ok' : 'badge-warn');
        renderProfiles();
        if (m.initialProfileId) { selectProfile(m.initialProfileId); }
        if (m.initialStep) { go(m.initialStep); }
        break;
      case 'devices': {
        const audioOpts = '<option value="">Default microphone</option>' + (m.audio || []).map((/** @type {any} */ d) => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('');
        $('micDevice').innerHTML = audioOpts;
        $('liveMicDevice').innerHTML = audioOpts;
        $('screenDevice').innerHTML = (m.screen || []).length
          ? m.screen.map((/** @type {any} */ d) => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('')
          : '<option value="1">Default screen</option>';
        break;
      }
      case 'take':
        S.recordingTake = false;
        S.takes[m.index] = m.error ? { error: m.error } : { src: m.src, report: m.report };
        renderTakePrompt();
        break;
      case 'recTime': $('takeSecs').textContent = Number(m.seconds).toFixed(1); break;
      case 'importedVoice':
        S.imported = true; S.takes = [{ report: { ok: true } }];
        $('enrollSetup').hidden = true; $('enrollRead').hidden = true; $('enrollBuilt').hidden = false;
        $('buildingMsg').hidden = false; $('builtControls').hidden = true;
        send('buildVoice');
        break;
      case 'buildingVoice': $('buildingMsg').textContent = m.status; break;
      case 'builtVoice':
        $('buildingMsg').hidden = true; $('builtControls').hidden = false;
        $('refPlayer').src = m.refSrc; $('refTranscript').value = m.refText || '';
        break;
      case 'previewVoice':
        $('previewAudio').hidden = false; $('previewAudio').src = m.src;
        $('previewAudio').play().catch(() => undefined);
        break;
      case 'savedVoice':
        S.profiles = m.profiles || [];
        renderProfiles();
        selectProfile(m.profile.id);
        break;
      case 'profiles':
        S.profiles = m.profiles || [];
        renderProfiles();
        break;
      case 'folderPicked':
        S.folder = m.folder;
        $('folderDisplay').textContent = m.folder;
        updateTopicButton();
        break;
      case 'geminiKeyUpdated':
        $('geminiKeyBadge').textContent = m.hasGeminiKey ? 'Gemini API key ready' : 'Gemini API key not set';
        $('geminiKeyBadge').className = 'pill ' + (m.hasGeminiKey ? 'badge-ok' : 'badge-warn');
        break;
      case 'researchLog':
        $('researchStatus').textContent = m.text;
        $('researchLog').innerHTML += `<div class="live-line"><span class="live-ts">•</span><span>${esc(m.text)}</span></div>`;
        $('researchLog').scrollTop = $('researchLog').scrollHeight;
        break;
      case 'scaffolded':
        S.busy = false; updateTopicButton();
        S.scaffold = m.scaffold;
        $('researchStatus').className = 'status ok';
        $('researchStatus').textContent = `Scaffolded (${m.engine}) → ${m.scaffold.spec.slides.length} slides`;
        go(3);
        break;
      case 'slidesSaved':
        S.scaffold = m.scaffold;
        renderScaffold();
        break;
      case 'liveTranscript':
        $('liveTranscript').innerHTML = (m.segments || []).map((/** @type {any} */ s) => `<div class="live-line"><span class="live-ts">[${Number(s.start).toFixed(1)}s]</span><span>${esc(s.text)}</span></div>`).join('');
        $('liveTranscript').scrollTop = $('liveTranscript').scrollHeight;
        break;
      case 'liveCloned':
        $('produceStatus').textContent = `Cloned chunk ${m.chunkIndex + 1}: "${String(m.text || '').slice(0, 48)}…"`;
        break;
      case 'produceProgress':
        $('produceStatus').className = 'status';
        $('produceStatus').textContent = m.text;
        break;
      case 'produced': {
        S.busy = false; S.liveRecording = false;
        clearInterval(S.liveTimer);
        $('startLiveBtn').hidden = false; $('stopLiveBtn').hidden = true; $('stopLiveBtn').disabled = false;
        $('overlaySlidesBtn').disabled = false;
        $('produceStatus').className = 'status ok';
        $('produceStatus').innerHTML = `${ic('check')}Tutorial ready`;
        if (m.videoSrc) { $('tutorialPreview').hidden = false; $('tutorialPreview').src = m.videoSrc; }
        $('produceResults').innerHTML = (m.files || []).map((/** @type {any} */ f) => `
          <div class="item">
            ${ic(/\.(mp4|mov|mkv)$/i.test(f.name) ? 'presentation' : /\.(srt|vtt|txt|json)$/i.test(f.name) ? 'transcribe' : 'music')}
            <span>${esc(f.name)}</span>
            <span class="spacer"></span>
            <button class="link" data-open="${esc(f.path)}">${ic('open-external')}Open</button>
            <button class="link" data-rev="${esc(f.path)}">${ic('folder')}Reveal</button>
          </div>`).join('');
        $('produceResults').querySelectorAll('[data-open]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => send('openFile', { path: b.dataset.open })));
        $('produceResults').querySelectorAll('[data-rev]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => send('revealFile', { path: b.dataset.rev })));
        break;
      }
      case 'error':
        S.busy = false; S.recordingTake = false; S.liveRecording = false;
        clearInterval(S.liveTimer);
        $('startLiveBtn').hidden = false; $('stopLiveBtn').hidden = true; $('stopLiveBtn').disabled = false;
        updateTopicButton();
        $('overlaySlidesBtn').disabled = false;
        $('perr').textContent = m.message || 'Error';
        break;
    }
  });
  send('ready');
})();
