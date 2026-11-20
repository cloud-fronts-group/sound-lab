"""Media, ffmpeg, PNG slide rendering, subtitle, and mlx-audio HTTP helpers for ADK tools."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import struct
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib
from pathlib import Path
from typing import Any

CONTAINER_VOICES = "/soundlab/voices"
CONSENT_STATEMENT = "This is my own voice, or I have the speaker's explicit permission to clone it."

# 5x7 ASCII bitmap font for pure-Python RGB PNG slide frames (no system font dependencies).
_FONT: dict[str, list[int]] = {
    " ": [0, 0, 0, 0, 0, 0, 0], "!": [4, 4, 4, 4, 4, 0, 4], '"': [10, 10, 10, 0, 0, 0, 0],
    "#": [10, 10, 31, 10, 31, 10, 10], "$": [4, 15, 20, 14, 5, 30, 4], "%": [24, 25, 2, 4, 8, 19, 3],
    "&": [12, 18, 20, 8, 21, 18, 13], "'": [4, 4, 8, 0, 0, 0, 0], "(": [2, 4, 8, 8, 8, 4, 2],
    ")": [8, 4, 2, 2, 2, 4, 8], "*": [0, 4, 21, 14, 21, 4, 0], "+": [0, 4, 4, 31, 4, 4, 0],
    ",": [0, 0, 0, 0, 4, 4, 8], "-": [0, 0, 0, 31, 0, 0, 0], ".": [0, 0, 0, 0, 0, 4, 4],
    "/": [1, 2, 2, 4, 8, 8, 16], "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14],
    "2": [14, 17, 1, 6, 8, 16, 31], "3": [31, 2, 4, 6, 1, 17, 14], "4": [2, 6, 10, 18, 31, 2, 2],
    "5": [31, 16, 30, 1, 1, 17, 14], "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8],
    "8": [14, 17, 17, 14, 17, 17, 14], "9": [14, 17, 17, 15, 1, 2, 12], ":": [0, 4, 4, 0, 4, 4, 0],
    ";": [0, 4, 4, 0, 4, 4, 8], "<": [2, 4, 8, 16, 8, 4, 2], "=": [0, 0, 31, 0, 31, 0, 0],
    ">": [8, 4, 2, 1, 2, 4, 8], "?": [14, 17, 1, 2, 4, 0, 4], "@": [14, 17, 23, 21, 23, 16, 14],
    "A": [14, 17, 17, 31, 17, 17, 17], "B": [30, 17, 17, 30, 17, 17, 30], "C": [14, 17, 16, 16, 16, 17, 14],
    "D": [30, 17, 17, 17, 17, 17, 30], "E": [31, 16, 16, 30, 16, 16, 31], "F": [31, 16, 16, 30, 16, 16, 16],
    "G": [14, 17, 16, 23, 17, 17, 15], "H": [17, 17, 17, 31, 17, 17, 17], "I": [14, 4, 4, 4, 4, 4, 14],
    "J": [7, 2, 2, 2, 18, 18, 12], "K": [17, 18, 20, 24, 20, 18, 17], "L": [16, 16, 16, 16, 16, 16, 31],
    "M": [17, 27, 21, 21, 17, 17, 17], "N": [17, 25, 21, 19, 17, 17, 17], "O": [14, 17, 17, 17, 17, 17, 14],
    "P": [30, 17, 17, 30, 16, 16, 16], "Q": [14, 17, 17, 17, 21, 18, 13], "R": [30, 17, 17, 30, 20, 18, 17],
    "S": [15, 16, 16, 14, 1, 1, 30], "T": [31, 4, 4, 4, 4, 4, 4], "U": [17, 17, 17, 17, 17, 17, 14],
    "V": [17, 17, 17, 17, 17, 10, 4], "W": [17, 17, 17, 21, 21, 27, 17], "X": [17, 17, 10, 4, 10, 17, 17],
    "Y": [17, 17, 10, 4, 4, 4, 4], "Z": [31, 1, 2, 4, 8, 16, 31], "[": [14, 8, 8, 8, 8, 8, 14],
    "\\": [16, 8, 8, 4, 2, 2, 1], "]": [14, 2, 2, 2, 2, 2, 14], "^": [4, 10, 17, 0, 0, 0, 0],
    "_": [0, 0, 0, 0, 0, 0, 31], "`": [8, 4, 2, 0, 0, 0, 0],
    "a": [0, 0, 14, 1, 15, 17, 15], "b": [16, 16, 22, 25, 17, 17, 30], "c": [0, 0, 14, 16, 16, 17, 14],
    "d": [1, 1, 13, 19, 17, 17, 15], "e": [0, 0, 14, 17, 31, 16, 14], "f": [6, 9, 8, 28, 8, 8, 8],
    "g": [0, 0, 15, 17, 15, 1, 14], "h": [16, 16, 22, 25, 17, 17, 17], "i": [4, 0, 12, 4, 4, 4, 14],
    "j": [2, 0, 6, 2, 2, 18, 12], "k": [16, 16, 18, 20, 24, 20, 18], "l": [12, 4, 4, 4, 4, 4, 14],
    "m": [0, 0, 26, 21, 21, 17, 17], "n": [0, 0, 22, 25, 17, 17, 17], "o": [0, 0, 14, 17, 17, 17, 14],
    "p": [0, 0, 30, 17, 30, 16, 16], "q": [0, 0, 15, 17, 15, 1, 1], "r": [0, 0, 22, 25, 16, 16, 16],
    "s": [0, 0, 15, 16, 14, 1, 30], "t": [8, 8, 28, 8, 8, 9, 6], "u": [0, 0, 17, 17, 17, 19, 13],
    "v": [0, 0, 17, 17, 17, 10, 4], "w": [0, 0, 17, 17, 21, 21, 10], "x": [0, 0, 17, 10, 4, 10, 17],
    "y": [0, 0, 17, 17, 15, 1, 14], "z": [0, 0, 31, 2, 4, 8, 31], "{": [6, 8, 8, 16, 8, 8, 6],
    "|": [4, 4, 4, 4, 4, 4, 4], "}": [12, 2, 2, 1, 2, 2, 12], "~": [0, 0, 8, 21, 2, 0, 0],
}


def slugify(text: str) -> str:
    s = re.sub(r"[^\w]+", "-", text.lower()).strip("-")[:40]
    return s or "voice"


def find_bin(name: str, extra_dirs: tuple[str, ...] = ("/opt/homebrew/bin", "/usr/local/bin")) -> str | None:
    hit = shutil.which(name)
    if hit:
        return hit
    for d in (*extra_dirs, str(Path.home() / ".local" / "bin")):
        cand = Path(d) / name
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    return None


def ffmpeg_bins() -> tuple[str, str]:
    ff = os.environ.get("FFMPEG") or find_bin("ffmpeg") or "ffmpeg"
    fp = os.environ.get("FFPROBE") or find_bin("ffprobe") or "ffprobe"
    return ff, fp


def run_cmd(args: list[str], timeout: int = 600) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or proc.stdout or "").strip().splitlines()[-8:])
        raise RuntimeError(f"{Path(args[0]).name} failed ({proc.returncode}): {tail}")
    return proc


def probe_duration(ffprobe_bin: str, media_path: str) -> float:
    proc = run_cmd([ffprobe_bin, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", media_path], timeout=30)
    try:
        return float((proc.stdout or "").strip())
    except ValueError:
        return 0.0


def to_server_ref_path(host_path: str, voices_dir: str | None, mode: str) -> str:
    """Translate host voice reference path to container path `/soundlab/voices/...` when running inside a container."""
    if mode in ("docker", "podman", "apple-container") and voices_dir:
        rel = os.path.relpath(os.path.abspath(host_path), os.path.abspath(voices_dir))
        if rel.startswith("..") or os.path.isabs(rel):
            raise ValueError(f"Reference audio {host_path} must live inside voices_dir ({voices_dir}) to be mounted at {CONTAINER_VOICES}.")
        return f"{CONTAINER_VOICES}/{rel.replace(os.sep, '/')}"
    return os.path.abspath(host_path)


def default_voices_dir() -> str:
    return os.environ.get("SOUND_LAB_VOICES_DIR") or str(Path.home() / "Sound Lab" / "voices")


def mlx_http_json(base_url: str, path: str, method: str = "GET", payload: dict[str, Any] | None = None, timeout: int = 600) -> Any:
    url = base_url.rstrip("/") + path
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"content-type": "application/json"} if payload is not None else {}
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            ctype = resp.headers.get("content-type", "")
            if "json" in ctype or raw.lstrip().startswith((b"{", b"[")):
                return json.loads(raw.decode("utf-8"))
            return raw
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:400]
        raise RuntimeError(f"mlx-audio HTTP {e.code} on {path}: {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"mlx-audio not reachable at {base_url}: {e.reason}") from e


def mlx_transcribe(base_url: str, file_path: str, model: str, language: str | None = None) -> dict[str, Any]:
    boundary = f"----SoundLab{uuid.uuid4().hex}"
    parts: list[bytes] = []

    def add_field(name: str, val: str) -> None:
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{val}\r\n".encode("utf-8"))

    add_field("model", model)
    add_field("response_format", "verbose_json")
    if language and language != "auto":
        add_field("language", language)

    mime = mimetypes.guess_type(file_path)[0] or "audio/wav"
    fname = Path(file_path).name
    file_bytes = Path(file_path).read_bytes()
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{fname}"\r\nContent-Type: {mime}\r\n\r\n'.encode("utf-8")
        + file_bytes
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(parts)

    req = urllib.request.Request(
        base_url.rstrip("/") + "/v1/audio/transcriptions",
        data=body,
        method="POST",
        headers={"content-type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"mlx-audio transcription failed ({e.code}): {e.read().decode('utf-8', errors='replace')[:400]}") from e
    data = json.loads(raw)
    segs = [
        {"start": float(s.get("start", 0)), "end": float(s.get("end", 0)), "text": str(s.get("text", "")).strip()}
        for s in (data.get("segments") or [])
        if str(s.get("text", "")).strip()
    ]
    return {"text": str(data.get("text", "")).strip(), "language": data.get("language"), "segments": segs}


def check_take_ffmpeg(ffmpeg_bin: str, file_path: str) -> dict[str, Any]:
    proc = subprocess.run(
        [ffmpeg_bin, "-hide_banner", "-nostdin", "-i", file_path, "-af", "volumedetect,silencedetect=noise=-45dB:d=0.25", "-f", "null", "-"],
        capture_output=True, text=True, timeout=60,
    )
    err = proc.stderr or ""
    m_peak = re.search(r"max_volume:\s*(-?[\d.]+|-inf)", err)
    m_mean = re.search(r"mean_volume:\s*(-?[\d.]+|-inf)", err)
    peak_db = float(m_peak.group(1)) if m_peak else float("-inf")
    mean_db = float(m_mean.group(1)) if m_mean else float("-inf")
    times = re.findall(r"time=\s*(\d+):(\d+):([\d.]+)", err)
    duration = int(times[-1][0]) * 3600 + int(times[-1][1]) * 60 + float(times[-1][2]) if times else 0.0
    warnings: list[str] = []
    if peak_db == float("-inf") or duration < 0.8:
        warnings.append("No speech detected or recording too short.")
    elif peak_db > -0.3:
        warnings.append("Clipping detected (> -0.3 dBFS).")
    elif mean_db < -42:
        warnings.append("Very quiet take (< -42 dBFS).")
    fatal = any(w.startswith(("No speech", "Clipping")) for w in warnings)
    return {"ok": not fatal, "duration": duration, "peak_db": peak_db, "mean_db": mean_db, "warnings": warnings}


def build_reference_ffmpeg(ffmpeg_bin: str, takes: list[str], out_wav: str) -> str:
    if not takes:
        raise ValueError("Provide at least one take audio file.")
    Path(out_wav).parent.mkdir(parents=True, exist_ok=True)
    args = ["-hide_banner", "-nostdin", "-y"]
    for t in takes:
        args.extend(["-i", t])
    trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.1,areverse"
    parts = [f"[{i}:a]aformat=sample_fmts=fltp:sample_rates=24000:channel_layouts=mono,{trim},apad=pad_dur=0.35[t{i}]" for i in range(len(takes))]
    concat_inputs = "".join(f"[t{i}]" for i in range(len(takes)))
    graph = f"{';'.join(parts)};{concat_inputs}concat=n={len(takes)}:v=0:a=1,highpass=f=70,afftdn=nr=10:nf=-45,loudnorm=I=-20:TP=-2:LRA=11,aresample=24000[out]"
    run_cmd([ffmpeg_bin, *args, "-filter_complex", graph, "-map", "[out]", "-ac", "1", "-c:a", "pcm_s16le", out_wav])
    return out_wav


def _fmt_srt_ts(sec: float) -> str:
    ms = max(0, round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _fmt_vtt_ts(sec: float) -> str:
    return _fmt_srt_ts(sec).replace(",", ".")


def write_transcript_sidecars(base_no_ext: str, segments: list[dict[str, Any]], source: str, backend: str = "mlx-audio-voice-clone", language: str = "eng") -> list[str]:
    Path(base_no_ext).parent.mkdir(parents=True, exist_ok=True)
    srt_lines = [f"{i + 1}\n{_fmt_srt_ts(s['start'])} --> {_fmt_srt_ts(s['end'])}\n{s['text']}" for i, s in enumerate(segments)]
    vtt_lines = ["WEBVTT", "", *[f"{_fmt_vtt_ts(s['start'])} --> {_fmt_vtt_ts(s['end'])}\n{s['text']}\n" for s in segments]]
    txt_lines = [s["text"] for s in segments]
    json_obj = {"source": source, "backend": backend, "language": language, "segments": segments}

    outputs = {
        "srt": "\n\n".join(srt_lines) + "\n",
        "vtt": "\n".join(vtt_lines) + "\n",
        "txt": "\n".join(txt_lines) + "\n",
        "json": json.dumps(json_obj, indent=2) + "\n",
    }
    paths: list[str] = []
    for ext, content in outputs.items():
        out = f"{base_no_ext}.{ext}"
        Path(out).write_text(content, encoding="utf-8")
        paths.append(out)
    return paths


def _sanitize_ascii(text: str) -> str:
    return re.sub(r"[^\x20-\x7E]", " ", text.replace("\u2018", "'").replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"').replace("\u2013", "-").replace("\u2014", "-"))


def _wrap(text: str, max_chars: int) -> list[str]:
    out: list[str] = []
    for para in _sanitize_ascii(text).strip().splitlines():
        words = para.split()
        if not words:
            out.append("")
            continue
        cur = ""
        for w in words:
            if len(w) > max_chars:
                if cur:
                    out.append(cur)
                    cur = ""
                for i in range(0, len(w), max_chars):
                    out.append(w[i : i + max_chars])
            elif len(f"{cur} {w}".strip()) > max_chars:
                out.append(cur)
                cur = w
            else:
                cur = f"{cur} {w}".strip()
        if cur:
            out.append(cur)
    return out


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def render_slide_png(index: int, total: int, title: str, bullets: list[str], code_snippet: str = "", presentation_title: str = "", subtitle_hint: str = "", width: int = 1280, height: int = 720) -> bytes:
    buf = bytearray([15, 23, 42] * (width * height))

    def fill(x: int, y: int, w: int, h: int, r: int, g: int, b: int) -> None:
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(width, x + w), min(height, y + h)
        row = bytes([r, g, b]) * max(0, x1 - x0)
        for py in range(y0, y1):
            off = (py * width + x0) * 3
            buf[off : off + len(row)] = row

    def draw_text(txt: str, x: int, y: int, scale: int, rgb: tuple[int, int, int]) -> None:
        cx = x
        for ch in _sanitize_ascii(txt):
            if cx + 5 * scale > width:
                break
            rows = _FONT.get(ch, _FONT[" "])
            for ry, bits in enumerate(rows):
                for rx in range(5):
                    if (bits >> (4 - rx)) & 1:
                        fill(cx + rx * scale, y + ry * scale, scale, scale, *rgb)
            cx += 6 * scale

    for x in range(width):
        t = x / max(1, width - 1)
        fill(x, 0, 1, 6, round(56 + t * 73), round(189 - t * 49), 248)

    pad = round(width * 0.055)
    badge = f"SLIDE {index:02d} / {total:02d}"
    fill(pad, 34, len(badge) * 12 + 24, 30, 30, 41, 59)
    draw_text(badge, pad + 12, 42, 2, (56, 189, 248))
    if presentation_title:
        draw_text(presentation_title[:56], pad + len(badge) * 12 + 44, 42, 2, (148, 163, 184))

    t_scale = 4 if width >= 1200 else 3
    t_lines = _wrap(title, (width - pad * 2) // (6 * t_scale))[:2]
    y = 92
    for ln in t_lines:
        draw_text(ln, pad, y, t_scale, (248, 250, 252))
        y += 9 * t_scale
    fill(pad, y + 6, width - pad * 2, 2, 51, 65, 85)
    y += 30

    has_code = bool(code_snippet and code_snippet.strip())
    body_w = int((width - pad * 2) * 0.52) if has_code else (width - pad * 2)
    b_scale = 3 if width >= 1200 else 2
    max_y = height - 76
    for b in bullets:
        if y + 10 * b_scale > max_y:
            break
        fill(pad + 4, y + int(2.5 * b_scale), b_scale * 2, b_scale * 2, 56, 189, 248)
        for ln in _wrap(b, (body_w - 32) // (6 * b_scale)):
            if y + 8 * b_scale > max_y:
                break
            draw_text(ln, pad + 28, y, b_scale, (226, 232, 240))
            y += 9 * b_scale
        y += 10

    if has_code:
        cx = pad + body_w + 24
        cw = width - pad - cx
        cy = 92 + len(t_lines) * 9 * t_scale + 36
        ch = max(120, max_y - cy)
        fill(cx, cy, cw, ch, 17, 24, 39)
        fill(cx, cy, cw, 3, 56, 189, 248)
        ty = cy + 18
        max_cc = max(10, (cw - 28) // 12)
        for raw_ln in _sanitize_ascii(code_snippet).splitlines():
            if ty + 16 > cy + ch - 12:
                break
            draw_text(raw_ln[:max_cc], cx + 14, ty, 2, (165, 243, 252))
            ty += 20

    fill(pad, height - 38, width - pad * 2, 6, 30, 41, 59)
    pct = max(0.05, min(1.0, index / max(1, total)))
    fill(pad, height - 38, round((width - pad * 2) * pct), 6, 56, 189, 248)
    if subtitle_hint:
        draw_text(subtitle_hint[:72], pad, height - 24, 2, (148, 163, 184))

    stride = width * 3
    raw = bytearray()
    for row_idx in range(height):
        raw.append(0)
        start = row_idx * stride
        raw.extend(buf[start : start + stride])
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + _png_chunk(b"IEND", b"")


def chunk_speakable_text(text: str, max_chars: int = 280) -> list[str]:
    clean = re.sub(r"```[\s\S]*?```", " ", text)
    clean = re.sub(r"[*_`#>|]", "", clean)
    clean = re.sub(r"\s+", " ", clean).strip()
    if not clean:
        return []
    sentences = [s.strip() for s in re.findall(r"[^.!?…]+(?:[.!?…]+|$)", clean) if s.strip()] or [clean]
    out: list[str] = []
    cur = ""
    for s in sentences:
        if len(s) > max_chars:
            if cur:
                out.append(cur)
                cur = ""
            rest = s
            while len(rest) > max_chars:
                cut = rest.rfind(" ", 0, max_chars)
                if cut <= 0:
                    cut = max_chars
                out.append(rest[:cut].strip())
                rest = rest[cut:].strip()
            cur = rest
        elif len(f"{cur} {s}".strip()) > max_chars:
            out.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        out.append(cur)
    return out
