// Webview button icons (24x24 grid, stroked paths). Generated set; edit paths here.
// Every button in media/editor.js and audioEditor.ts must use one of these (enforced by test/activation.test.js).
export const ICONS: Record<string, string> = {
  'play': 'M7 4l13 8-13 8z',
  'pause': 'M7 4h3v16H7zM14 4h3v16h-3z',
  'stop': 'M6 6h12v12H6z',
  'loop': 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  'zoom-in': 'M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0M10.5 8v5M8 10.5h5',
  'zoom-out': 'M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0M8 10.5h5',
  'zoom-fit': 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  'zoom-selection': 'M4 4v16M20 4v16M8 12h8M11 9l-3 3 3 3M13 9l3 3-3 3',
  'export': 'M12 15V3M7.5 7.5L12 3l4.5 4.5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5',
  'levels': 'M4 4v16h16M8 16v-4M12 16V8M16 16v-6',
  'spectrogram': 'M4 4v16h17M8 16h3M8 12h3M14 16h5M14 8h5M14 12h3',
  'find-silence': 'M3 12h3M18 12h3M9 9v6M12 6v12M15 9v6',
  'transcribe': 'M4 4h16v12H11l-4 4v-4H4zM8 8h8M8 11.5h5',
  'effects': 'M5 19L17 7M14 4l3 3M19 12v3M17.5 13.5h3M9 3v3M7.5 4.5h3',
  'normalize': 'M3 5h18M3 19h18M6 9v6M9 7v10M12 8.5v7M15 7v10M18 9v6',
  'convert': 'M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4',
  'slice-equal': 'M3 6h18v12H3zM9 6v12M15 6v12',
  'split-silence': 'M12 3v3M12 10.5v3M12 18v3M3 12h5M16 12h5',
  'info': 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 11v6M12 7.5h.01',
  'refresh': 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
  'copy': 'M9 9h11v11H9zM5 15H4V4h11v1',
  'server': 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01M12 7h4M12 17h4',
  'server-stop': 'M4 4h16v6H4zM8 7h.01M12 7h4M15 15l5 5M20 15l-5 5M4 14h7v6H4z',
  'studio': 'M3 4h18v12H3zM8 20h8M12 16v4M7 12V9M10 12V7M13 12v-2M16 12V8',
  'voice': 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3M5 11a7 7 0 0 0 14 0M12 18v3',
  'voice-clone': 'M9 3a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0v-5A2.5 2.5 0 0 0 9 3M3.5 10a5.5 5.5 0 0 0 11 0M9 15.5V19M16 7h5M16 11h5M16 15h3',
  'separate': 'M4 12h4M8 12l4-6h8M8 12l4 6h8M17 3l3 3-3 3M17 15l3 3-3 3',
  'model': 'M12 2l9 5v10l-9 5-9-5V7zM12 12l9-5M12 12v10M12 12L3 7',
  'mic': 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8',
  'record': 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  'check': 'M5 12l5 5L20 7',
  'trash': 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  'open-external': 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  'book': 'M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2zM4 19V5M8 7h8',
  'presentation': 'M3 4h18M4 4v11h16V4M12 15v4M8 21l4-2 4 2M8 11l3-3 2 2 3-3',
  'music': 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  'speak': 'M4 10v4h4l5 4V6L8 10zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12',
  'folder': 'M3 6h6l2 2h10v11H3z',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  'arrow-left': 'M19 12H5M11 6l-6 6 6 6',
};

/** Hidden SVG sprite: inlined once in the webview HTML; buttons reference it with <use href="#sl-name">. */
export function iconSprite(): string {
  const symbols = Object.entries(ICONS).map(([n, d]) => `<symbol id="sl-${n}" viewBox="0 0 24 24"><path d="${d}"/></symbol>`).join('');
  return `<svg width="0" height="0" aria-hidden="true" focusable="false" class="sprite">${symbols}</svg>`;
}

/** Inline icon markup for a button. */
export function icon(name: string): string {
  return `<svg class="ic" aria-hidden="true" focusable="false"><use href="#sl-${name}"/></svg>`;
}
