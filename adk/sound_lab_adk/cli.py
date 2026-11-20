"""CLI entry point for invoking Sound Lab Google ADK agents from VS Code or terminal."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from google import genai

from .deep_research import (
    DEFAULT_DEEP_RESEARCH_AGENT,
    DEFAULT_GEMINI_MODEL,
    _extract_interaction_text,
    inspect_presentation_folder,
    run_gemini_deep_research,
    scaffold_instructional_presentation,
)
from .mlx_expert import (
    clone_user_voice,
    inspect_mlx_environment,
    list_mlx_models,
    manage_mlx_service,
    overlay_presentation_with_cloned_voice,
    transcribe_and_overlay_recording,
)


def _synthesize_slides_with_gemini(
    topic: str,
    folder_summary: str,
    research_report: str,
    target_minutes: float,
    audience: str,
    model: str,
) -> tuple[str, list[dict[str, Any]]]:
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        return topic, []
    client = genai.Client(api_key=api_key, http_options={"api_version": "v1beta"})
    schema = {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "slides": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "durationSec": {"type": "number"},
                        "bullets": {"type": "array", "items": {"type": "string"}},
                        "narration": {"type": "string"},
                        "codeSnippet": {"type": "string"},
                        "codeLang": {"type": "string"},
                        "speakerNotes": {"type": "string"},
                    },
                    "required": ["title", "durationSec", "bullets", "narration"],
                },
            },
        },
        "required": ["title", "slides"],
    }
    prompt = "\n".join([
        f'Scaffold a {target_minutes:.1f}-minute ({round(target_minutes * 60)}s, strictly 300-600s) instructional presentation on "{topic}" for {audience}.',
        "Create 8-12 slides with concise bullets, relevant code snippets from the folder, and natural speakable narration (~140 WPM, no markdown formatting in narration).",
        "",
        "FOLDER CONTEXT:",
        folder_summary[:6000],
        "",
        "DEEP RESEARCH REPORT:",
        research_report[:14000],
    ])
    print(f"[adk] Synthesizing {target_minutes:.1f}-min instructional slides with {model}...", file=sys.stderr, flush=True)
    interaction = client.interactions.create(
        model=model,
        input=prompt,
        response_format={"type": "text", "mime_type": "application/json", "schema": schema},
        store=False,
    )
    txt = _extract_interaction_text(interaction)
    try:
        parsed = json.loads(txt)
        return str(parsed.get("title") or topic), list(parsed.get("slides") or [])
    except Exception:
        return topic, []


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Sound Lab Google ADK workflow CLI")
    p.add_argument("--action", required=True, choices=[
        "check", "inspect-folder", "research-and-scaffold", "clone-voice", "overlay", "transcribe-overlay", "mlx-env", "mlx-models",
    ])
    p.add_argument("--topic", default="")
    p.add_argument("--title", default="")
    p.add_argument("--folder", default=".")
    p.add_argument("--out", default="")
    p.add_argument("--minutes", type=float, default=7.5)
    p.add_argument("--audience", default="Developers & technical learners")
    p.add_argument("--deep-research-agent", default=DEFAULT_DEEP_RESEARCH_AGENT)
    p.add_argument("--model", default=DEFAULT_GEMINI_MODEL)
    p.add_argument("--voice-profile", default="")
    p.add_argument("--voices-dir", default="")
    p.add_argument("--mlx-url", default="http://127.0.0.1:8000")
    p.add_argument("--container-mode", default="native")
    p.add_argument("--name", default="My voice")
    p.add_argument("--audio", action="append", default=[])
    p.add_argument("--consent", action="store_true")
    p.add_argument("--video", default="")
    p.add_argument("--mode", default="fast")
    args = p.parse_args(argv)

    if args.action == "check":
        import google.adk
        print(json.dumps({
            "status": "ok",
            "google_adk": google.adk.__version__,
            "google_genai": genai.__version__,
            "agents": ["sound_lab_presentation_coordinator", "deep_research_agent", "mlx_voice_clone_expert"],
        }))
        return 0

    if args.action == "mlx-env":
        print(json.dumps(inspect_mlx_environment(args.container_mode, url=args.mlx_url), indent=2))
        return 0

    if args.action == "mlx-models":
        print(json.dumps(list_mlx_models(), indent=2))
        return 0

    if args.action == "inspect-folder":
        print(json.dumps(inspect_presentation_folder(args.folder), indent=2))
        return 0

    if args.action == "research-and-scaffold":
        if not args.topic:
            print(json.dumps({"status": "error", "error": "--topic is required"}))
            return 2
        out_dir = args.out or str(Path(args.folder).resolve() / "presentations" / "latest")
        fc = inspect_presentation_folder(args.folder)
        if fc.get("status") != "success":
            print(json.dumps(fc))
            return 1
        dr_mode = "max" if "max" in args.deep_research_agent else args.mode
        os.environ["SOUND_LAB_DEEP_RESEARCH_AGENT"] = args.deep_research_agent
        dr = run_gemini_deep_research(
            topic=args.topic,
            folder_context_summary=fc["summary_text"],
            mode=dr_mode,
            output_dir=out_dir,
        )
        if dr.get("status") == "error":
            print(json.dumps(dr), file=sys.stderr)
            return 1
        report = dr["report"]
        title, slides = _synthesize_slides_with_gemini(
            topic=args.topic,
            folder_summary=fc["summary_text"],
            research_report=report,
            target_minutes=args.minutes,
            audience=args.audience,
            model=args.model,
        )
        scaf = scaffold_instructional_presentation(
            output_dir=out_dir,
            title=args.title or title,
            topic=args.topic,
            folder_path=args.folder,
            slides_json=json.dumps(slides) if slides else "",
            research_report=report,
            target_minutes=args.minutes,
            audience=args.audience,
            voice_profile_id=args.voice_profile,
        )
        print(json.dumps({
            "dir": scaf["dir"],
            "spec": scaf["spec"],
            "files": scaf["files"],
            "researchReport": report,
            "interactionId": dr.get("interaction_id"),
        }))
        return 0

    if args.action == "clone-voice":
        res = clone_user_voice(
            name=args.name,
            audio_paths=args.audio,
            voices_dir=args.voices_dir,
            consent_confirmed=args.consent,
            mlx_url=args.mlx_url,
            container_mode=args.container_mode,
        )
        print(json.dumps(res, indent=2))
        return 0 if res.get("status") == "success" else 1

    if args.action == "overlay":
        res = overlay_presentation_with_cloned_voice(
            presentation_dir=args.folder,
            voice_profile_id=args.voice_profile,
            voices_dir=args.voices_dir,
            output_video=args.out,
            mlx_url=args.mlx_url,
            container_mode=args.container_mode,
        )
        print(json.dumps(res, indent=2))
        return 0 if res.get("status") == "success" else 1

    if args.action == "transcribe-overlay":
        res = transcribe_and_overlay_recording(
            video_path=args.video,
            voice_profile_id=args.voice_profile,
            voices_dir=args.voices_dir,
            output_dir=args.out,
            mlx_url=args.mlx_url,
            container_mode=args.container_mode,
        )
        print(json.dumps(res, indent=2))
        return 0 if res.get("status") == "success" else 1

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
