"""Google ADK Deep Research Agent for topic research, folder analysis, and 5-10 min presentation scaffolding."""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from google import genai
from google.adk.agents import LlmAgent
from google.adk.tools import ToolContext

from .media_tools import slugify

SKIP_DIRS = {".git", "node_modules", "out", "dist", "build", ".venv", "venv", "__pycache__", ".colabsync", ".next", ".claude", ".anchor"}
MEDIA_EXT = {".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aiff", ".mp4", ".mov", ".mkv", ".webm"}
DEFAULT_GEMINI_MODEL = os.environ.get("SOUND_LAB_GEMINI_MODEL", "gemini-4-hydrogen")
DEFAULT_DEEP_RESEARCH_AGENT = os.environ.get("SOUND_LAB_DEEP_RESEARCH_AGENT", "deep-research-preview-04-2026")


def _extract_interaction_text(interaction: Any) -> str:
    txt = getattr(interaction, "output_text", None)
    if isinstance(txt, str) and txt.strip():
        return txt.strip()
    parts: list[str] = []
    for step in getattr(interaction, "steps", None) or []:
        if getattr(step, "type", None) == "model_output":
            for item in getattr(step, "content", None) or []:
                if getattr(item, "type", None) == "text" and getattr(item, "text", None):
                    parts.append(str(item.text))
    return "\n".join(parts).strip()


def _save_interaction_images(interaction: Any, output_dir: str) -> list[str]:
    saved: list[str] = []
    if not output_dir:
        return saved
    img_dir = Path(output_dir) / "research-visuals"
    idx = 0
    for step in getattr(interaction, "steps", None) or []:
        if getattr(step, "type", None) == "model_output":
            for item in getattr(step, "content", None) or []:
                if getattr(item, "type", None) == "image" and getattr(item, "data", None):
                    idx += 1
                    img_dir.mkdir(parents=True, exist_ok=True)
                    mime = getattr(item, "mime_type", None) or "image/png"
                    ext = "jpg" if "jpeg" in mime else "png"
                    out = img_dir / f"figure_{idx:02d}.{ext}"
                    out.write_bytes(base64.b64decode(item.data))
                    saved.append(str(out))
    return saved


def inspect_presentation_folder(folder_path: str, tool_context: Optional[ToolContext] = None) -> dict[str, Any]:
    """Scan a workspace folder to extract architecture, manifests, docs, source highlights, and media files.

    Args:
        folder_path: Absolute or relative path to the folder the presentation should be based on.
    """
    root = Path(folder_path).resolve()
    if not root.is_dir():
        return {"status": "error", "error": f"Folder not found: {root}"}

    files: list[str] = []
    dirs: list[str] = []
    ext_counts: dict[str, int] = {}
    media: list[str] = []

    def walk(cur: Path, depth: int) -> None:
        if depth > 4 or len(files) >= 250:
            return
        try:
            entries = sorted(cur.iterdir(), key=lambda p: p.name)
        except OSError:
            return
        for entry in entries:
            if len(files) >= 250:
                break
            if entry.name.startswith(".") and entry.name != ".env.example":
                continue
            if entry.name in SKIP_DIRS:
                continue
            rel = str(entry.relative_to(root))
            if entry.is_dir():
                dirs.append(rel)
                walk(entry, depth + 1)
            elif entry.is_file():
                files.append(rel)
                ext = entry.suffix.lower() or "(no-ext)"
                ext_counts[ext] = ext_counts.get(ext, 0) + 1
                if ext in MEDIA_EXT:
                    media.append(rel)

    walk(root, 0)

    def read_excerpt(rel: str, limit: int = 1400) -> str:
        try:
            return (root / rel).read_text(encoding="utf-8", errors="ignore")[:limit].strip()
        except OSError:
            return ""

    manifests = [
        {"file": m, "excerpt": read_excerpt(m, 900)}
        for m in ("package.json", "pyproject.toml", "Cargo.toml", "go.mod")
        if m in files
    ]
    doc_files = [f for f in files if re.match(r"^(readme|changelog|claude|architecture|getting-started)", Path(f).name, re.I) or re.match(r"^docs/.*\.md$", f, re.I)][:6]
    docs = [{"file": f, "excerpt": read_excerpt(f, 1200)} for f in doc_files]

    code_files = [f for f in files if re.search(r"\.(ts|js|py|go|rs|java|kt)$", f, re.I) and not re.search(r"\.(test|spec)\.", f, re.I)][:12]
    highlights: list[dict[str, Any]] = []
    for cf in code_files:
        ex = read_excerpt(cf, 1200)
        syms = re.findall(r"(?:export\s+(?:async\s+)?(?:function|class|const|interface|type)\s+|def\s+|class\s+)([A-Za-z_]\w*)", ex)[:10]
        highlights.append({"file": cf, "symbols": syms, "excerpt": ex[:500]})

    top_exts = ", ".join(f"{k} ({v})" for k, v in sorted(ext_counts.items(), key=lambda kv: -kv[1])[:8])
    summary = "\n\n".join(filter(None, [
        f"Folder: {root.name} ({root})",
        f"Files scanned: {len(files)} across {len(dirs)} subdirectories",
        f"File types: {top_exts}" if top_exts else "",
        f"Top directories: {', '.join(d for d in dirs if os.sep not in d)[:15]}" if dirs else "",
        ("Manifests:\n" + "\n".join(f"--- {m['file']} ---\n{m['excerpt']}" for m in manifests)) if manifests else "",
        ("Documentation:\n" + "\n".join(f"--- {d['file']} ---\n{d['excerpt'][:700]}" for d in docs)) if docs else "",
        ("Key Modules:\n" + "\n".join(f"- {h['file']}" + (f" [{', '.join(h['symbols'])}]" if h['symbols'] else "") for h in highlights)) if highlights else "",
        f"Media assets ({len(media)}): {', '.join(media[:10])}" if media else "",
    ]))

    result = {
        "status": "success",
        "name": root.name,
        "root_path": str(root),
        "file_count": len(files),
        "directories": dirs,
        "files": files,
        "extensions": ext_counts,
        "manifests": manifests,
        "docs": docs,
        "highlights": highlights,
        "media_files": media,
        "summary_text": summary,
    }
    if tool_context is not None:
        tool_context.state["folder_context"] = result
    return result


def run_gemini_deep_research(
    topic: str,
    folder_context_summary: str = "",
    mode: str = "fast",
    collaborative_planning: bool = False,
    previous_interaction_id: str = "",
    output_dir: str = "",
    tool_context: Optional[ToolContext] = None,
) -> dict[str, Any]:
    """Run Gemini Deep Research (`deep-research-preview-04-2026` or `deep-research-max-preview-04-2026`) via Interactions API.

    Args:
        topic: What the instructional presentation will be about.
        folder_context_summary: Summary of files/docs/architecture from `inspect_presentation_folder`.
        mode: `"fast"` (`deep-research-preview-04-2026`) or `"max"` (`deep-research-max-preview-04-2026`).
        collaborative_planning: When True, returns a proposed research plan before full execution.
        previous_interaction_id: Interaction ID from a prior collaborative planning turn.
        output_dir: Optional directory where generated visualization charts should be saved.
    """
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        return {"status": "error", "error": "GEMINI_API_KEY or GOOGLE_API_KEY is not set in environment."}

    if not folder_context_summary and tool_context is not None:
        fc = tool_context.state.get("folder_context")
        if isinstance(fc, dict):
            folder_context_summary = str(fc.get("summary_text", ""))

    agent_id = "deep-research-max-preview-04-2026" if mode == "max" else DEFAULT_DEEP_RESEARCH_AGENT
    client = genai.Client(api_key=api_key, http_options={"api_version": "v1beta"})

    if previous_interaction_id and not collaborative_planning:
        prompt = "Plan looks good! Please execute the full research report and include cited sources."
    else:
        prompt = "\n".join([
            f"Research the following topic to build a comprehensive, accurate 5-10 minute instructional presentation:",
            f"Topic: {topic}",
            "",
            "Local Workspace Context (ground your instructional examples and architecture explanations in these files):",
            folder_context_summary[:9000] if folder_context_summary else "(No folder context provided)",
            "",
            "Deliver a structured report covering:",
            "1. Technical Foundations & Key Concepts",
            "2. Architecture, Tradeoffs & Implementation Patterns",
            "3. Recommended 5-10 Minute Instructional Slide Flow & Code Examples",
            "4. Common Pitfalls, Verification Checklist & Sources",
        ])

    kwargs: dict[str, Any] = {
        "agent": agent_id,
        "input": prompt,
        "background": True,
        "agent_config": {
            "type": "deep-research",
            "thinking_summaries": "auto",
            "visualization": "auto",
            "collaborative_planning": bool(collaborative_planning),
        },
    }
    if previous_interaction_id:
        kwargs["previous_interaction_id"] = previous_interaction_id

    print(f"[adk] Starting Deep Research ({agent_id}) for: {topic}", file=sys.stderr, flush=True)
    interaction = client.interactions.create(**kwargs)
    seen_thoughts: set[str] = set()
    deadline = time.time() + 25 * 60

    while True:
        cur = client.interactions.get(interaction.id)
        for st in getattr(cur, "steps", None) or []:
            if getattr(st, "type", None) == "thought":
                summary = getattr(st, "summary", None)
                if summary and str(summary) not in seen_thoughts:
                    seen_thoughts.add(str(summary))
                    print(f"[adk] Thought: {str(summary)[:140]}", file=sys.stderr, flush=True)
        status = getattr(cur, "status", None)
        if status == "completed":
            report = _extract_interaction_text(cur)
            visuals = _save_interaction_images(cur, output_dir)
            res = {
                "status": "plan_ready" if collaborative_planning else "completed",
                "interaction_id": cur.id,
                "agent": agent_id,
                "report": report,
                "visuals": visuals,
            }
            if tool_context is not None:
                tool_context.state["research_report"] = report
                tool_context.state["research_interaction_id"] = cur.id
            return res
        if status in ("failed", "cancelled", "incomplete"):
            return {
                "status": "error",
                "interaction_id": cur.id,
                "error": f"Deep Research ended with status={status}: {getattr(cur, 'error', None) or getattr(cur, 'errors', None)}",
            }
        if time.time() > deadline:
            return {"status": "error", "interaction_id": cur.id, "error": "Deep Research timed out."}
        time.sleep(5)


def _estimate_seconds(text: str, wpm: int = 140) -> float:
    words = len(str(text or "").split())
    return max(4.0, round((words / max(80, wpm)) * 60.0 + 1.5, 1))


def scaffold_instructional_presentation(
    output_dir: str,
    title: str,
    topic: str,
    folder_path: str,
    slides_json: str = "",
    research_report: str = "",
    target_minutes: float = 7.5,
    audience: str = "Developers & technical learners",
    voice_profile_id: str = "",
    tool_context: Optional[ToolContext] = None,
) -> dict[str, Any]:
    """Scaffold a 5-10 minute instructional presentation (`presentation.json`, `slides.md`, `slides.html`, `narration-script.txt`, `research-report.md`).

    Args:
        output_dir: Target folder to write scaffolded presentation artifacts.
        title: Presentation title.
        topic: Presentation topic requested by the user.
        folder_path: Source workspace folder the presentation is grounded in.
        slides_json: Optional JSON array of slides with `title`, `durationSec`, `bullets`, `narration`, `codeSnippet`, `codeLang`.
        research_report: Markdown report from Deep Research.
        target_minutes: Target length clamped to 5.0-10.0 minutes (default 7.5).
        audience: Target audience description.
        voice_profile_id: Selected cloned voice profile ID (if already enrolled).
    """
    target_min = max(5.0, min(10.0, float(target_minutes or 7.5)))
    target_sec = round(target_min * 60)

    fc: dict[str, Any] = {}
    if tool_context is not None:
        fc = tool_context.state.get("folder_context") or {}
        if not research_report:
            research_report = str(tool_context.state.get("research_report") or "")
        if not voice_profile_id:
            vp = tool_context.state.get("user_voice_profile") or {}
            if isinstance(vp, dict):
                voice_profile_id = str(vp.get("id") or "")
    if not fc and Path(folder_path).is_dir():
        fc = inspect_presentation_folder(folder_path)

    if not research_report:
        research_report = f"# Deep Research Report: {topic}\n\nGrounded in `{folder_path}`.\n"

    parsed_slides: list[dict[str, Any]] = []
    if slides_json:
        try:
            raw = json.loads(slides_json)
            if isinstance(raw, dict) and isinstance(raw.get("slides"), list):
                raw = raw["slides"]
            if isinstance(raw, list):
                parsed_slides = [x for x in raw if isinstance(x, dict)]
        except json.JSONDecodeError:
            parsed_slides = []

    if not parsed_slides:
        folder_name = fc.get("name") or Path(folder_path).name
        file_count = int(fc.get("file_count") or 0)
        dirs = [d for d in (fc.get("directories") or []) if os.sep not in d][:5]
        docs = [d.get("file") for d in (fc.get("docs") or []) if d.get("file")][:4]
        mods = (fc.get("highlights") or [])[:4]
        r_lines = [
            re.sub(r"^[#*\-\d.\s]+", "", ln).strip()
            for ln in research_report.splitlines()
            if len(ln.strip()) > 30 and not ln.strip().startswith(("http", "#", ">"))
        ]
        templates = [
            {
                "title": title or topic,
                "bullets": [
                    f"Workspace: {folder_name} ({file_count} files)",
                    f"Topic: {topic}",
                    f"Target pacing: {target_min:.1f} minutes",
                ],
                "narration": f"Welcome everyone. In this {target_min:.0f}-minute instructional tutorial, we are diving into {topic} inside the {folder_name} folder. We will connect findings from Deep Research directly to the files and architecture in this repository so you understand how everything works together end to end.",
            },
            {
                "title": "Agenda & Learning Objectives",
                "bullets": [
                    "Research background & core concepts",
                    f"Architecture & layout of {folder_name}",
                    "Deep dive into core implementation modules",
                    "Hands-on workflow & verification steps",
                ],
                "narration": f"Here is what we will cover today. First, we will establish the technical foundations for {topic} from our research report. Second, we will tour {folder_name} across its {file_count} files. Third, we will examine the key code modules and interfaces. Finally, we will walk through running and verifying the workflow yourself.",
            },
            {
                "title": "Deep Research Insights",
                "bullets": (r_lines[:3] or [
                    f"Key technical principles for {topic}",
                    "Architecture & hardware tradeoffs",
                    "Reliability and verification best practices",
                ]),
                "narration": f"Let us review the core findings from Deep Research on {topic}. " + (" ".join(r_lines[:4]) if r_lines else f"Understanding these architectural tradeoffs clarifies why {folder_name} structures its workflows around clean pure-logic boundaries, deterministic checks, and non-destructive outputs."),
            },
            {
                "title": f"Folder Architecture: {folder_name}",
                "bullets": [
                    f"Top directories: {', '.join(dirs) if dirs else 'root'}",
                    f"Documentation: {', '.join(docs) if docs else 'inline docs'}",
                    f"Files analyzed: {file_count}",
                ],
                "codeSnippet": "\n".join(f"  {f}" for f in (fc.get("files") or [])[:10]),
                "codeLang": "text",
                "narration": f"Taking a look at the folder layout of {folder_name}, responsibilities are organized cleanly across subdirectories" + (f" such as {', '.join(dirs)}" if dirs else "") + ". Keeping documentation and tests right alongside source modules ensures changes stay easy to navigate and verify.",
            },
            {
                "title": f"Core Module: {mods[0]['file']}" if mods else "Core Implementation",
                "bullets": [
                    f"Module: {mods[0]['file']}" if mods else "Modular pure-logic core",
                    f"Exports: {', '.join(mods[0].get('symbols', [])[:5])}" if mods and mods[0].get("symbols") else "Focused APIs & typed contracts",
                    "Testable independently from UI or transport layers",
                ],
                "codeSnippet": (mods[0].get("excerpt", "").splitlines()[:8] if mods else []),
                "narration": f"Let us zoom into {mods[0]['file']}. " + (f"Its key exports include {', '.join(mods[0].get('symbols', [])[:4])}. " if mods and mods[0].get("symbols") else "") + "Isolating core logic here keeps behavior predictable and straightforward to unit-test." if mods else "In the core layer, deterministic functions handle processing without coupling directly to UI state, making automated integration tests fast and reliable.",
            },
            {
                "title": f"Integration Flow: {mods[1]['file']}" if len(mods) > 1 else "Orchestration & Safety",
                "bullets": [
                    f"Module: {mods[1]['file']}" if len(mods) > 1 else "End-to-end execution orchestration",
                    "Progress reporting & cancellation",
                    "Non-destructive output naming",
                ],
                "codeSnippet": (mods[1].get("excerpt", "").splitlines()[:8] if len(mods) > 1 else []),
                "narration": f"Next, {mods[1]['file']} wires the core pieces into the user-facing workflow, reporting progress, honoring cancellation signals, and ensuring original files are never overwritten." if len(mods) > 1 else "At the orchestration layer, long-running operations report progress incrementally, handle cancellation cleanly, and always write outputs to unique new paths.",
            },
            {
                "title": "Practical Walkthrough",
                "bullets": [
                    "Prepare local dependencies & configuration",
                    "Execute the workflow against workspace files",
                    "Inspect generated artifacts & media metadata",
                ],
                "narration": "Now let us trace a hands-on run from start to finish. After checking prerequisites and credentials, launch the workflow against your target folder, monitor live progress events, and inspect the resulting output artifacts directly.",
            },
            {
                "title": "Verification & Next Steps",
                "bullets": [
                    "Run automated tests after edits",
                    "Verify media & artifacts programmatically",
                    f"Explore further inside {folder_name}",
                ],
                "narration": f"To wrap up this tutorial on {topic}, always run the automated test suite and verify outputs after changes. Thank you for following along through {folder_name}, and enjoy building your own presentations and workflows.",
            },
        ]
        for t in templates:
            if isinstance(t.get("codeSnippet"), list):
                t["codeSnippet"] = "\n".join(t["codeSnippet"])
        parsed_slides = templates

    # Normalize slide structure and calibrate 5-10 min pacing (300-600 s).
    slides: list[dict[str, Any]] = []
    raw_total = sum(float(s.get("durationSec") or _estimate_seconds(str(s.get("narration") or ""))) for s in parsed_slides)
    scale = (target_sec / raw_total) if raw_total > 0 and not (300 <= raw_total <= 600) else 1.0
    for i, s in enumerate(parsed_slides):
        nar = str(s.get("narration") or s.get("title") or "").strip()
        base_dur = float(s.get("durationSec") or _estimate_seconds(nar))
        slides.append({
            "index": i + 1,
            "title": str(s.get("title") or f"Slide {i + 1}"),
            "durationSec": max(20, round(base_dur * scale)),
            "bullets": [str(b) for b in (s.get("bullets") or [])],
            "narration": nar,
            **({"codeSnippet": str(s["codeSnippet"])} if s.get("codeSnippet") else {}),
            **({"codeLang": str(s["codeLang"])} if s.get("codeLang") else {}),
            **({"speakerNotes": str(s["speakerNotes"])} if s.get("speakerNotes") else {}),
        })

    est_sec = sum(s["durationSec"] for s in slides)
    interaction_id = tool_context.state.get("research_interaction_id") if tool_context is not None else None
    spec: dict[str, Any] = {
        "title": title or topic,
        "topic": topic,
        "folderPath": str(Path(folder_path).resolve()),
        "targetMinutes": target_min,
        "estimatedSeconds": est_sec,
        "audience": audience,
        **({"voiceProfileId": voice_profile_id} if voice_profile_id else {}),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        **({"researchInteractionId": interaction_id} if interaction_id else {}),
        "slides": slides,
    }

    out_path = Path(output_dir).resolve()
    out_path.mkdir(parents=True, exist_ok=True)
    json_path = out_path / "presentation.json"
    md_path = out_path / "slides.md"
    html_path = out_path / "slides.html"
    script_path = out_path / "narration-script.txt"
    research_path = out_path / "research-report.md"

    json_path.write_text(json.dumps(spec, indent=2), encoding="utf-8")

    md_parts = [
        f"---\ntitle: {spec['title']}\ntopic: {spec['topic']}\nduration: {est_sec / 60:.1f} min\n---\n",
        f"# {spec['title']}\n> Instructional presentation ({est_sec / 60:.1f} min) · Source: `{spec['folderPath']}`\n",
    ]
    for s in slides:
        md_parts.append(f"---\n\n## {s['index']}. {s['title']}\n")
        for b in s["bullets"]:
            md_parts.append(f"- {b}")
        if s.get("codeSnippet"):
            md_parts.append(f"\n```{s.get('codeLang', '')}\n{s['codeSnippet']}\n```")
        md_parts.append(f"\n<!-- Narration (~{s['durationSec']}s): {s['narration']} -->\n")
    md_path.write_text("\n".join(md_parts), encoding="utf-8")

    spec_json_escaped = json.dumps(spec).replace("<", "\\u003c")
    html_doc = f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>{spec['title']}</title>
<style>body{{margin:0;font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;display:flex;flex-direction:column;height:100vh}}main{{flex:1;padding:40px 7vw;overflow:auto}}footer{{background:#1e293b;padding:14px 24px;border-top:1px solid #334155}}pre{{background:#020617;padding:16px;border-radius:8px;color:#a5f3fc;overflow:auto}}button{{background:#0284c7;color:#fff;border:0;border-radius:6px;padding:7px 14px;cursor:pointer}}</style>
</head><body><main><div id="badge" style="color:#38bdf8;font-weight:700"></div><h1 id="t"></h1><ul id="b"></ul><pre id="c" hidden></pre></main>
<footer><div id="n" style="margin-bottom:8px;color:#cbd5e1"></div><button id="prev">Prev</button> <button id="next">Next</button></footer>
<script id="d" type="application/json">{spec_json_escaped}</script><script>
const d=JSON.parse(document.getElementById('d').textContent);let i=0;
function show(k){{i=Math.max(0,Math.min(d.slides.length-1,k));const s=d.slides[i];document.getElementById('badge').textContent='Slide '+s.index+' / '+d.slides.length;document.getElementById('t').textContent=s.title;document.getElementById('b').innerHTML=s.bullets.map(x=>'<li>'+x.replace(/[<>&]/g,m=>({{'<':'&lt;','>':'&gt;','&':'&amp;'}}[m]))+'</li>').join('');const c=document.getElementById('c');c.hidden=!s.codeSnippet;c.textContent=s.codeSnippet||'';document.getElementById('n').textContent=s.narration;}}
document.getElementById('prev').onclick=()=>show(i-1);document.getElementById('next').onclick=()=>show(i+1);show(0);
</script></body></html>"""
    html_path.write_text(html_doc, encoding="utf-8")
    script_path.write_text("\n\n".join(f"## Slide {s['index']}: {s['title']} (~{s['durationSec']}s)\n{s['narration']}" for s in slides) + "\n", encoding="utf-8")
    research_path.write_text(research_report.strip() + "\n", encoding="utf-8")

    result = {
        "status": "success",
        "dir": str(out_path),
        "spec": spec,
        "estimated_minutes": round(est_sec / 60, 2),
        "within_5_to_10_min": 300 <= est_sec <= 600,
        "files": {
            "json": str(json_path),
            "markdown": str(md_path),
            "html": str(html_path),
            "script": str(script_path),
            "research": str(research_path),
        },
    }
    if tool_context is not None:
        tool_context.state["presentation_scaffold"] = result
    return result


def create_deep_research_agent() -> LlmAgent:
    """Create a Google ADK Deep Research & 5-10 min presentation scaffolding agent."""
    return LlmAgent(
        name="deep_research_agent",
        model=DEFAULT_GEMINI_MODEL,
        description=(
            "Researches the user's presentation topic using Gemini Deep Research and folder context, "
            "then scaffolds a 5-10 minute instructional presentation (slides, speaker script, research report)."
        ),
        instruction="""You are the Sound Lab Deep Research & Instructional Presentation Designer agent.

When given a presentation topic and a target folder:
1. Call `inspect_presentation_folder(folder_path)` first so your research and slides are grounded in the real codebase, docs, and media inside the folder.
2. Call `run_gemini_deep_research(topic=..., folder_context_summary=...)` to conduct deep multi-step web & technical research on the topic using Gemini Deep Research (`deep-research-preview-04-2026` or `deep-research-max-preview-04-2026`).
3. Synthesize a 5-10 minute (300-600 seconds, ~700-1400 spoken words at ~140 WPM) instructional slide deck of 8-12 slides. Each slide must have:
   - concise title and 3-5 clear bullet points,
   - natural, speakable narration (plain prose without markdown markup, because a voice-cloned TTS model will speak it aloud),
   - real code snippets or file trees from the inspected folder where helpful,
   - realistic `durationSec` summing to 300-600 seconds.
4. Call `scaffold_instructional_presentation(...)` to write `presentation.json`, `slides.md`, `slides.html`, `narration-script.txt`, and `research-report.md`.
5. Report the scaffolded directory path, total estimated duration, and slide outline clearly.""",
        tools=[inspect_presentation_folder, run_gemini_deep_research, scaffold_instructional_presentation],
        output_key="presentation_scaffold",
    )


deep_research_agent = create_deep_research_agent()
