"""Unit and integration tests for Sound Lab Google ADK agents, Deep Research, and mlx-audio overlay."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

ADK_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ADK_ROOT.parent
if str(ADK_ROOT) not in sys.path:
    sys.path.insert(0, str(ADK_ROOT))

from sound_lab_adk import (  # noqa: E402
    deep_research_agent,
    mlx_voice_clone_expert,
    presentation_workflow_agent,
    root_agent,
)
from sound_lab_adk.deep_research import (  # noqa: E402
    inspect_presentation_folder,
    run_gemini_deep_research,
    scaffold_instructional_presentation,
)
from sound_lab_adk.media_tools import to_server_ref_path  # noqa: E402
from sound_lab_adk.mlx_expert import (  # noqa: E402
    clone_user_voice,
    inspect_mlx_environment,
    list_mlx_models,
    manage_mlx_service,
    overlay_presentation_with_cloned_voice,
    transcribe_and_overlay_recording,
)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-v", "error", "-y", *args], check=True)


def _ffprobe_json(path: str) -> dict:
    p = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
        capture_output=True, text=True, check=True,
    )
    return json.loads(p.stdout)


def test_adk_agent_hierarchy_and_models():
    assert root_agent.name == "sound_lab_presentation_coordinator"
    assert root_agent.model == "gemini-4-hydrogen"
    sub_names = [a.name for a in root_agent.sub_agents]
    assert "mlx_voice_clone_expert" in sub_names
    assert "deep_research_agent" in sub_names
    assert presentation_workflow_agent.name == "presentation_workflow_agent"
    assert deep_research_agent.model == "gemini-4-hydrogen"
    assert mlx_voice_clone_expert.model == "gemini-4-hydrogen"


def test_mlx_container_expertise_and_path_mapping(tmp_path: Path):
    voices = tmp_path / "voices"
    ref = voices / "ada" / "reference.wav"
    ref.parent.mkdir(parents=True)
    ref.write_bytes(b"x")

    assert to_server_ref_path(str(ref), str(voices), "native") == str(ref.resolve())
    assert to_server_ref_path(str(ref), str(voices), "docker") == "/soundlab/voices/ada/reference.wav"
    assert to_server_ref_path(str(ref), str(voices), "podman") == "/soundlab/voices/ada/reference.wav"
    assert to_server_ref_path(str(ref), str(voices), "apple-container") == "/soundlab/voices/ada/reference.wav"

    with pytest.raises(ValueError):
        to_server_ref_path(str(tmp_path / "outside.wav"), str(voices), "docker")

    plan = manage_mlx_service("plan", mode="docker", gpu="nvidia", port=8011, voices_dir=str(voices))
    assert ":cuda12" in plan["command"]
    assert "--gpus all" in plan["command"]
    assert f"{voices}:/soundlab/voices:ro" in plan["command"]

    catalog = list_mlx_models()
    clone_ids = [m["id"] for m in catalog["catalog"]["voice_cloning_tts"]]
    assert "mlx-community/chatterbox-turbo-4bit" in clone_ids
    assert "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit" in clone_ids

    env = inspect_mlx_environment("native", port=8000)
    assert env["status"] == "success"
    assert "container_spec" in env


def test_folder_inspection_and_5_to_10_min_scaffolding(tmp_path: Path):
    sample_dir = tmp_path / "demo_repo"
    (sample_dir / "src").mkdir(parents=True)
    (sample_dir / "README.md").write_text("# Demo Project\nAn audio toolkit demo.", encoding="utf-8")
    (sample_dir / "src" / "main.py").write_text("def run_pipeline(x: str) -> str:\n    return x\n", encoding="utf-8")

    fc = inspect_presentation_folder(str(sample_dir))
    assert fc["status"] == "success"
    assert fc["file_count"] == 2
    assert "README.md" in fc["files"]

    out_dir = tmp_path / "pres"
    scaf = scaffold_instructional_presentation(
        output_dir=str(out_dir),
        title="Demo Walkthrough",
        topic="How Demo Project Works",
        folder_path=str(sample_dir),
        target_minutes=7.0,
        research_report="# Research\n- Modular design improves testability.\n- Clear error boundaries reduce failures.",
    )
    assert scaf["status"] == "success"
    assert scaf["within_5_to_10_min"] is True
    assert 300 <= scaf["spec"]["estimatedSeconds"] <= 600
    for f in scaf["files"].values():
        assert Path(f).is_file()
    assert "Demo Walkthrough" in Path(scaf["files"]["html"]).read_text(encoding="utf-8")


def test_deep_research_interactions_polling(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    calls = {"get": 0}

    def fake_create(**kwargs):
        assert kwargs["agent"] == "deep-research-preview-04-2026"
        assert kwargs["background"] is True
        return SimpleNamespace(id="int_123")

    def fake_get(interaction_id):
        assert interaction_id == "int_123"
        calls["get"] += 1
        if calls["get"] == 1:
            return SimpleNamespace(
                id="int_123",
                status="in_progress",
                steps=[SimpleNamespace(type="thought", summary="Searching primary documentation...")],
                output_text=None,
            )
        return SimpleNamespace(
            id="int_123",
            status="completed",
            steps=[
                SimpleNamespace(
                    type="model_output",
                    content=[SimpleNamespace(type="text", text="# Deep Research Report\nDetailed synthesis with citations.")],
                )
            ],
            output_text="# Deep Research Report\nDetailed synthesis with citations.",
        )

    fake_client = MagicMock()
    fake_client.interactions.create.side_effect = fake_create
    fake_client.interactions.get.side_effect = fake_get

    with patch("sound_lab_adk.deep_research.genai.Client", return_value=fake_client), patch("sound_lab_adk.deep_research.time.sleep", return_value=None):
        res = run_gemini_deep_research(
            topic="Audio pipelines",
            folder_context_summary="src/main.py",
            output_dir=str(tmp_path),
        )
    assert res["status"] == "completed"
    assert res["interaction_id"] == "int_123"
    assert "Detailed synthesis" in res["report"]


def test_end_to_end_clone_and_overlay_against_mock_mlx_and_real_ffmpeg(tmp_path: Path):
    port = _free_port()
    mock_script = REPO_ROOT / "test" / "fixtures" / "mock-mlx-audio.js"
    log_file = tmp_path / "mlx.log"
    env = {**os.environ, "MOCK_MLX_LOG": str(log_file)}
    node_bin = os.environ.get("NODE_BIN") or "/opt/homebrew/bin/node"
    if not Path(node_bin).is_file():
        import shutil
        node_bin = shutil.which("node") or "node"
    proc = subprocess.Popen([node_bin, str(mock_script), str(port)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    mlx_url = f"http://127.0.0.1:{port}"
    try:
        # Wait for mock server
        for _ in range(40):
            try:
                if inspect_mlx_environment("external", url=mlx_url)["health"]["reachable"]:
                    break
            except Exception:
                pass
            time.sleep(0.15)

        take = tmp_path / "take.wav"
        _ffmpeg("-f", "lavfi", "-i", "aevalsrc='0.3*sin(2*PI*180*t)*lt(mod(t,0.6),0.45)*between(t,0.3,2.8)':s=48000:d=3.2", str(take))

        voices_dir = tmp_path / "voices"
        # Consent gate check
        denied = clone_user_voice(name="Test Voice", audio_paths=[str(take)], voices_dir=str(voices_dir), consent_confirmed=False, mlx_url=mlx_url)
        assert denied["status"] == "error"

        cloned = clone_user_voice(
            name="Presenter Voice",
            audio_paths=[str(take)],
            voices_dir=str(voices_dir),
            consent_confirmed=True,
            mlx_url=mlx_url,
        )
        assert cloned["status"] == "success"
        prof_id = cloned["profile"]["id"]
        assert Path(cloned["preview_wav"]).is_file()

        # Scaffold short 3-slide presentation for fast video overlay test
        src_folder = tmp_path / "proj"
        src_folder.mkdir()
        (src_folder / "README.md").write_text("# Sample Repo", encoding="utf-8")
        pres_dir = tmp_path / "presentation"
        slides = [
            {"title": "Slide One", "durationSec": 3, "bullets": ["Point A", "Point B"], "narration": "Welcome to slide one."},
            {"title": "Slide Two", "durationSec": 3, "bullets": ["Code check"], "codeSnippet": "print('hello')", "narration": "Here is slide two."},
        ]
        scaffold_instructional_presentation(
            output_dir=str(pres_dir),
            title="Presenter Tutorial",
            topic="Sample Repo",
            folder_path=str(src_folder),
            slides_json=json.dumps(slides),
            voice_profile_id=prof_id,
        )

        overlaid = overlay_presentation_with_cloned_voice(
            presentation_dir=str(pres_dir),
            voice_profile_id=prof_id,
            voices_dir=str(voices_dir),
            mlx_url=mlx_url,
        )
        assert overlaid["status"] == "success"
        assert Path(overlaid["video"]).is_file()
        assert any(p.endswith(".srt") for p in overlaid["transcripts"])
        assert any(p.endswith(".vtt") for p in overlaid["transcripts"])
        assert len(overlaid["slide_images"]) == 2

        info = _ffprobe_json(overlaid["video"])
        streams = info["streams"]
        assert any(s["codec_type"] == "video" and s["codec_name"] == "h264" for s in streams)
        aud = [s for s in streams if s["codec_type"] == "audio"]
        assert len(aud) == 1
        assert aud[0]["disposition"]["default"] == 1
        subs = [s for s in streams if s["codec_type"] == "subtitle"]
        assert len(subs) == 1
        assert subs[0]["codec_name"] == "mov_text"

        # Also test transcribe_and_overlay_recording on a recorded screen video
        rec_mp4 = tmp_path / "screen.mp4"
        _ffmpeg("-f", "lavfi", "-i", "testsrc=d=3:s=320x240:r=15", "-f", "lavfi", "-i", "sine=f=300:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(rec_mp4))
        dubbed = transcribe_and_overlay_recording(
            video_path=str(rec_mp4),
            voice_profile_id=prof_id,
            voices_dir=str(voices_dir),
            output_dir=str(tmp_path / "dubbed"),
            mlx_url=mlx_url,
        )
        assert dubbed["status"] == "success"
        d_streams = _ffprobe_json(dubbed["video"])["streams"]
        assert len([s for s in d_streams if s["codec_type"] == "audio"]) == 2
        assert len([s for s in d_streams if s["codec_type"] == "subtitle" and s["codec_name"] == "mov_text"]) == 1
    finally:
        proc.terminate()
        proc.wait(timeout=5)
