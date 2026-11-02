// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  let page = '';
  const frame = /** @type {HTMLIFrameElement|null} */ (document.getElementById('studio'));
  document.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => {
    page = /** @type {HTMLElement} */ (b).dataset.page || '';
    if (frame) { frame.src = (frame.dataset.base || '') + page; }
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t === b));
  }));
  document.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => vscode.postMessage({ type: /** @type {HTMLElement} */ (b).dataset.act, page })));
})();
