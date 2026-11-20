// Pure Node PNG slide frame renderer (no runtime npm deps, no vscode imports, uses built-in zlib).
// Produces crisp 1280x720 (or custom-sized) RGB PNG slides for ffmpeg video overlay pipelines.
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

export interface SlideFrameInput {
  index: number;
  total: number;
  title: string;
  bullets: string[];
  codeSnippet?: string;
  presentationTitle?: string;
  subtitleHint?: string;
}

export interface PngSlideOptions {
  width?: number;
  height?: number;
}

// Compact 5x7 bitmap font (columns packed LSB-top to MSB-bottom or 5-bit rows; here 7 rows of 5-bit ints).
const FONT: Record<string, number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '!': [4, 4, 4, 4, 4, 0, 4],
  '"': [10, 10, 10, 0, 0, 0, 0],
  '#': [10, 10, 31, 10, 31, 10, 10],
  '$': [4, 15, 20, 14, 5, 30, 4],
  '%': [24, 25, 2, 4, 8, 19, 3],
  '&': [12, 18, 20, 8, 21, 18, 13],
  "'": [4, 4, 8, 0, 0, 0, 0],
  '(': [2, 4, 8, 8, 8, 4, 2],
  ')': [8, 4, 2, 2, 2, 4, 8],
  '*': [0, 4, 21, 14, 21, 4, 0],
  '+': [0, 4, 4, 31, 4, 4, 0],
  ',': [0, 0, 0, 0, 4, 4, 8],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 4, 4],
  '/': [1, 2, 2, 4, 8, 8, 16],
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 6, 8, 16, 31],
  '3': [31, 2, 4, 6, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  ':': [0, 4, 4, 0, 4, 4, 0],
  ';': [0, 4, 4, 0, 4, 4, 8],
  '<': [2, 4, 8, 16, 8, 4, 2],
  '=': [0, 0, 31, 0, 31, 0, 0],
  '>': [8, 4, 2, 1, 2, 4, 8],
  '?': [14, 17, 1, 2, 4, 0, 4],
  '@': [14, 17, 23, 21, 23, 16, 14],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 18, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 27, 17],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  '[': [14, 8, 8, 8, 8, 8, 14],
  '\\': [16, 8, 8, 4, 2, 2, 1],
  ']': [14, 2, 2, 2, 2, 2, 14],
  '^': [4, 10, 17, 0, 0, 0, 0],
  _: [0, 0, 0, 0, 0, 0, 31],
  '`': [8, 4, 2, 0, 0, 0, 0],
  a: [0, 0, 14, 1, 15, 17, 15],
  b: [16, 16, 22, 25, 17, 17, 30],
  c: [0, 0, 14, 16, 16, 17, 14],
  d: [1, 1, 13, 19, 17, 17, 15],
  e: [0, 0, 14, 17, 31, 16, 14],
  f: [6, 9, 8, 28, 8, 8, 8],
  g: [0, 0, 15, 17, 15, 1, 14],
  h: [16, 16, 22, 25, 17, 17, 17],
  i: [4, 0, 12, 4, 4, 4, 14],
  j: [2, 0, 6, 2, 2, 18, 12],
  k: [16, 16, 18, 20, 24, 20, 18],
  l: [12, 4, 4, 4, 4, 4, 14],
  m: [0, 0, 26, 21, 21, 17, 17],
  n: [0, 0, 22, 25, 17, 17, 17],
  o: [0, 0, 14, 17, 17, 17, 14],
  p: [0, 0, 30, 17, 30, 16, 16],
  q: [0, 0, 15, 17, 15, 1, 1],
  r: [0, 0, 22, 25, 16, 16, 16],
  s: [0, 0, 15, 16, 14, 1, 30],
  t: [8, 8, 28, 8, 8, 9, 6],
  u: [0, 0, 17, 17, 17, 19, 13],
  v: [0, 0, 17, 17, 17, 10, 4],
  w: [0, 0, 17, 17, 21, 21, 10],
  x: [0, 0, 17, 10, 4, 10, 17],
  y: [0, 0, 17, 17, 15, 1, 14],
  z: [0, 0, 31, 2, 4, 8, 31],
  '{': [6, 8, 8, 16, 8, 8, 6],
  '|': [4, 4, 4, 4, 4, 4, 4],
  '}': [12, 2, 2, 1, 2, 2, 12],
  '~': [0, 0, 8, 21, 2, 0, 0],
};

function sanitizeAscii(s: string): string {
  return String(s ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2022/g, '*')
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7E]/g, ' ');
}

function wrapText(text: string, maxChars: number): string[] {
  const clean = sanitizeAscii(text).trim();
  if (!clean) { return []; }
  const out: string[] = [];
  for (const para of clean.split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const w of words) {
      if (w.length > maxChars) {
        if (line) { out.push(line); line = ''; }
        for (let i = 0; i < w.length; i += maxChars) { out.push(w.slice(i, i + maxChars)); }
      } else if ((line ? line + ' ' + w : w).length > maxChars) {
        out.push(line);
        line = w;
      } else {
        line = line ? line + ' ' + w : w;
      }
    }
    if (line) { out.push(line); }
  }
  return out;
}

class Canvas {
  readonly data: Buffer;
  constructor(readonly w: number, readonly h: number, bg: [number, number, number]) {
    this.data = Buffer.alloc(w * h * 3);
    this.fillRect(0, 0, w, h, bg);
  }
  fillRect(x: number, y: number, w: number, h: number, rgb: [number, number, number]): void {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.floor(x + w)), y1 = Math.min(this.h, Math.floor(y + h));
    for (let py = y0; py < y1; py++) {
      let off = (py * this.w + x0) * 3;
      for (let px = x0; px < x1; px++) {
        this.data[off++] = rgb[0]; this.data[off++] = rgb[1]; this.data[off++] = rgb[2];
      }
    }
  }
  drawChar(ch: string, x: number, y: number, scale: number, rgb: [number, number, number]): void {
    const rows = FONT[ch] ?? FONT[' '];
    for (let ry = 0; ry < 7; ry++) {
      const row = rows[ry];
      for (let rx = 0; rx < 5; rx++) {
        if ((row >> (4 - rx)) & 1) {
          this.fillRect(x + rx * scale, y + ry * scale, scale, scale, rgb);
        }
      }
    }
  }
  drawText(text: string, x: number, y: number, scale: number, rgb: [number, number, number]): void {
    const adv = 6 * scale;
    let cx = x;
    for (const ch of sanitizeAscii(text)) {
      if (cx + 5 * scale > this.w) { break; }
      this.drawChar(ch, cx, y, scale, rgb);
      cx += adv;
    }
  }
  toPng(): Buffer {
    const stride = 1 + this.w * 3;
    const raw = Buffer.alloc(stride * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * stride] = 0; // filter type 0
      this.data.copy(raw, y * stride + 1, y * this.w * 3, (y + 1) * this.w * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const idat = zlib.deflateSync(raw, { level: 6 });
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', idat),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) { c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) { c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Render one slide into an RGB PNG buffer (default 1280x720). */
export function renderSlidePng(slide: SlideFrameInput, opts: PngSlideOptions = {}): Buffer {
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  const c = new Canvas(w, h, [15, 23, 42]); // #0f172a

  // Top accent gradient strip
  for (let x = 0; x < w; x++) {
    const t = x / Math.max(1, w - 1);
    c.fillRect(x, 0, 1, 6, [Math.round(56 + t * 73), Math.round(189 - t * 49), 248]);
  }

  const padX = Math.round(w * 0.055);
  // Slide badge + presentation title
  const badgeText = `SLIDE ${String(slide.index).padStart(2, '0')} / ${String(slide.total).padStart(2, '0')}`;
  c.fillRect(padX, 34, badgeText.length * 12 + 24, 30, [30, 41, 59]);
  c.drawText(badgeText, padX + 12, 42, 2, [56, 189, 248]);
  if (slide.presentationTitle) {
    c.drawText(slide.presentationTitle.slice(0, 56), padX + badgeText.length * 12 + 44, 42, 2, [148, 163, 184]);
  }

  // Title
  const titleScale = w >= 1200 ? 4 : 3;
  const titleMaxChars = Math.floor((w - padX * 2) / (6 * titleScale));
  const titleLines = wrapText(slide.title, titleMaxChars).slice(0, 2);
  let y = 92;
  for (const line of titleLines) {
    c.drawText(line, padX, y, titleScale, [248, 250, 252]);
    y += 9 * titleScale;
  }
  c.fillRect(padX, y + 6, w - padX * 2, 2, [51, 65, 85]);
  y += 30;

  // Content layout: single column or split with code snippet
  const hasCode = !!(slide.codeSnippet && slide.codeSnippet.trim());
  const bodyW = hasCode ? Math.floor((w - padX * 2) * 0.52) : (w - padX * 2);
  const bulletScale = w >= 1200 ? 3 : 2;
  const bulletMaxChars = Math.floor((bodyW - 32) / (6 * bulletScale));
  const maxBodyY = h - 76;

  for (const bullet of slide.bullets) {
    if (y + 10 * bulletScale > maxBodyY) { break; }
    c.fillRect(padX + 4, y + Math.floor(2.5 * bulletScale), bulletScale * 2, bulletScale * 2, [56, 189, 248]);
    const lines = wrapText(bullet, bulletMaxChars);
    for (const line of lines) {
      if (y + 8 * bulletScale > maxBodyY) { break; }
      c.drawText(line, padX + 28, y, bulletScale, [226, 232, 240]);
      y += 9 * bulletScale;
    }
    y += 10;
  }

  if (hasCode) {
    const codeX = padX + bodyW + 24;
    const codeW = w - padX - codeX;
    const codeY = 92 + titleLines.length * 9 * titleScale + 36;
    const codeH = Math.max(120, maxBodyY - codeY);
    c.fillRect(codeX, codeY, codeW, codeH, [17, 24, 39]);
    c.fillRect(codeX, codeY, codeW, 3, [56, 189, 248]);
    const codeScale = 2;
    const maxCodeChars = Math.floor((codeW - 28) / (6 * codeScale));
    let cy = codeY + 18;
    for (const rawLine of sanitizeAscii(slide.codeSnippet!).split(/\r?\n/)) {
      if (cy + 16 > codeY + codeH - 12) { break; }
      c.drawText(rawLine.slice(0, maxCodeChars), codeX + 14, cy, codeScale, [165, 243, 252]);
      cy += 20;
    }
  }

  // Footer & progress bar
  const barY = h - 38;
  c.fillRect(padX, barY, w - padX * 2, 6, [30, 41, 59]);
  const pct = Math.max(0.05, Math.min(1, slide.index / Math.max(1, slide.total)));
  c.fillRect(padX, barY, Math.round((w - padX * 2) * pct), 6, [56, 189, 248]);
  if (slide.subtitleHint) {
    c.drawText(slide.subtitleHint.slice(0, 72), padX, h - 24, 2, [148, 163, 184]);
  }

  return c.toPng();
}

export function writeSlidePngs(slides: SlideFrameInput[], outDir: string, opts: PngSlideOptions = {}): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  return slides.map((s, i) => {
    const p = path.join(outDir, `slide_${String(i + 1).padStart(3, '0')}.png`);
    fs.writeFileSync(p, renderSlidePng(s, opts));
    return p;
  });
}
