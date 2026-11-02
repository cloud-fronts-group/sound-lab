import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { iconSprite } from './icons';

export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Standard Sound Lab webview document: strict CSP with a nonce, shared panel.css, icon sprite, one script. */
export function page(o: { webview: vscode.Webview; media: vscode.Uri; title: string; body: string; script: string; css?: string[]; frameSrc?: string[]; connectSrc?: string[] }): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const u = (f: string) => o.webview.asWebviewUri(vscode.Uri.joinPath(o.media, f)).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${o.webview.cspSource} data: blob:`,
    `media-src ${o.webview.cspSource} blob: data:`,
    `style-src ${o.webview.cspSource}`,
    `font-src ${o.webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    ...(o.frameSrc?.length ? [`frame-src ${o.frameSrc.join(' ')}`] : []),
    ...(o.connectSrc?.length ? [`connect-src ${o.connectSrc.join(' ')}`] : []),
  ].join('; ');
  const css = ['panel.css', ...(o.css || [])].map(f => `<link rel="stylesheet" href="${u(f)}">`).join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${css}
<title>${esc(o.title)}</title></head>
<body>${iconSprite()}
${o.body}
<script nonce="${nonce}" src="${u(o.script)}"></script>
</body></html>`;
}
