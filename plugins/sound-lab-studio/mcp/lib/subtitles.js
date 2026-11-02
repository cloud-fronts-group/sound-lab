'use strict';
// Segment model + SRT/VTT/TXT/JSON conversion (shared with the Sound Lab VS Code extension's src/core/subtitles.ts).
exports.toSrt = toSrt;
exports.toVtt = toVtt;
exports.toTxt = toTxt;
exports.parseCues = parseCues;
exports.fromWhisperCppJson = fromWhisperCppJson;
exports.fromOpenAiJson = fromOpenAiJson;
exports.render = render;
function stamp(sec, sep) {
    if (!isFinite(sec) || sec < 0) {
        sec = 0;
    }
    const ms = Math.round(sec * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const r = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
}
function toSrt(segs) {
    return segs.map((s, i) => `${i + 1}\n${stamp(s.start, ',')} --> ${stamp(s.end, ',')}\n${s.text.trim()}\n`).join('\n');
}
function toVtt(segs) {
    return 'WEBVTT\n\n' + segs.map(s => `${stamp(s.start, '.')} --> ${stamp(s.end, '.')}\n${s.text.trim()}\n`).join('\n');
}
function toTxt(segs) {
    return segs.map(s => s.text.trim()).filter(Boolean).join('\n') + '\n';
}
function parseStamp(v) {
    const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(v.trim());
    if (!m) {
        return NaN;
    }
    return (+(m[1] ?? 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0').slice(0, 3)) / 1000;
}
/** Parses both SRT and WebVTT cue lists. */
function parseCues(text) {
    const segs = [];
    const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
    for (const block of blocks) {
        const lines = block.split('\n').filter(l => l.length);
        const ti = lines.findIndex(l => l.includes('-->'));
        if (ti < 0) {
            continue;
        }
        const [a, b] = lines[ti].split('-->');
        const start = parseStamp(a);
        const end = parseStamp(b.trim().split(/\s+/)[0]);
        if (isNaN(start) || isNaN(end)) {
            continue;
        }
        segs.push({ start, end, text: lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '') });
    }
    return segs;
}
/** whisper.cpp `-oj` output. */
function fromWhisperCppJson(json) {
    const j = json;
    return (j.transcription ?? []).map(t => ({ start: t.offsets.from / 1000, end: t.offsets.to / 1000, text: t.text.trim() }));
}
/** OpenAI-compatible verbose_json output (also plain json with only "text"). */
function fromOpenAiJson(json, offset, fallbackDuration) {
    const j = json;
    if (j.segments?.length) {
        return j.segments.map(s => ({ start: s.start + offset, end: s.end + offset, text: s.text.trim() }));
    }
    if (j.text?.trim()) {
        return [{ start: offset, end: offset + (j.duration ?? fallbackDuration), text: j.text.trim() }];
    }
    return [];
}
function render(format, t) {
    switch (format) {
        case 'srt': return toSrt(t.segments);
        case 'vtt': return toVtt(t.segments);
        case 'txt': return toTxt(t.segments);
        case 'json': return JSON.stringify(t, null, 2) + '\n';
        default: throw new Error(`Unknown transcript format ${format}`);
    }
}
