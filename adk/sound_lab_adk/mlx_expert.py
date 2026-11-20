"""Google ADK expert agent for mlx-audio containers, models, voice cloning, and slide/video overlay."""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from google.adk.agents import LlmAgent
from google.adk.tools import ToolContext

from .media_tools import (
    CONSENT_STATEMENT,
    CONTAINER_VOICES,
    build_reference_ffmpeg,
    check_take_ffmpeg,
    chunk_speakable_text,
    default_voices_dir,
    ffmpeg_bins,
    find_bin,
    mlx_http_json,
    mlx_transcribe,
    probe_duration,
    render_slide_png,
    run_cmd,
    slugify,
    to_server_ref_path,
    write_transcript_sidecars,
)
from .models_catalog import CONTAINER_SPEC, MODELS_CATALOG

DEFAULT_GEMINI_MODEL = os.environ.get("SOUND_LAB_GEMINI_MODEL", "gemini-4-hydrogen")


def _resolved_mode(mode: str) -> str:
    if mode and mode != "auto":
        return mode
    return "native" if (platform.system() == "Darwin" and platform.machine() in ("arm64", "aarch64")) else "docker"


def _base_url(port: int = 8000, url: str = "") -> str:
    return (url or f"http://127.0.0.1:{port}").rstrip("/").removesuffix("/v1")


def inspect_mlx_environment(mode: str = "auto", port: int = 8000, url: str = "") -> dict[str, Any]:
    """Inspect host hardware, mlx_audio.server binary, container runtimes, and mlx-audio server health.

    Args:
        mode: Runtime mode (`auto`, `native`, `docker`, `podman`, `apple-container`, `external`).
        port: Expected server port (default 8000).
        url: Optional external server URL.
    """
    eff_mode = _resolved_mode(mode)
    base = _base_url(port, url)
    apple_silicon = platform.system() == "Darwin" and platform.machine() in ("arm64", "aarch64")
    native_bin = find_bin("mlx_audio.server")
    runtimes = {
        "docker": find_bin("docker"),
        "podman": find_bin("podman"),
        "apple_container": find_bin("container"),
    }
    health: dict[str, Any] = {"reachable": False, "url": base, "loaded_models": []}
    try:
        j = mlx_http_json(base, "/v1/models", timeout=3)
        health = {
            "reachable": True,
            "url": base,
            "loaded_models": [m.get("id", str(m)) for m in (j.get("data") or [])],
        }
    except Exception as exc:
        health["error"] = str(exc)

    recommendations: list[str] = []
    if apple_silicon:
        recommendations.append("Apple Silicon detected: prefer mode='native' for Apple Metal GPU acceleration; Docker/Podman/Apple container run CPU-only Linux VMs without Metal.")
        if not native_bin:
            recommendations.append("Install native mlx-audio: `brew tap cloud-fronts-group/sound-lab https://github.com/cloud-fronts-group/sound-lab && brew install mlx-audio`.")
    elif platform.system() == "Linux":
        recommendations.append("Linux host: use docker/podman with gpu='nvidia' (:cuda12 image) on NVIDIA GPUs, or :cpu image otherwise.")

    return {
        "status": "success",
        "platform": platform.system(),
        "machine": platform.machine(),
        "apple_silicon": apple_silicon,
        "effective_mode": eff_mode,
        "native_server_bin": native_bin,
        "container_runtimes": runtimes,
        "health": health,
        "container_spec": CONTAINER_SPEC,
        "recommendations": recommendations,
    }


def manage_mlx_service(
    action: str,
    mode: str = "auto",
    model_name: str = "",
    port: int = 8000,
    gpu: str = "none",
    voices_dir: str = "",
    image: str = "",
) -> dict[str, Any]:
    """Plan, start, stop, inspect logs, or load/unload models on the mlx-audio server or container.

    Args:
        action: One of `plan`, `status`, `start`, `stop`, `logs`, `load_model`, `unload_model`.
        mode: `auto`, `native`, `docker`, `podman`, `apple-container`, or `external`.
        model_name: Hugging Face model ID when `action` is `load_model` or `unload_model`.
        port: Local server port (default 8000).
        gpu: `none` (`:cpu` image) or `nvidia` (`:cuda12` image with GPU passthrough).
        voices_dir: Host voice profile directory mounted read-only at `/soundlab/voices` in container modes.
        image: Optional container image override.
    """
    eff = _resolved_mode(mode)
    base = _base_url(port)
    hf_cache = str(Path.home() / ".cache" / "huggingface")
    vdir = voices_dir or default_voices_dir()
    img = image or CONTAINER_SPEC["images"]["cuda12" if gpu == "nvidia" else "cpu"]

    def build_plan() -> list[str] | None:
        if eff == "external":
            return None
        if eff == "native":
            exe = find_bin("mlx_audio.server")
            if exe:
                return [exe, "--host", "127.0.0.1", "--port", str(port)]
            return [find_bin("python3") or "python3", "-m", "mlx_audio.server", "--host", "127.0.0.1", "--port", str(port)]
        cli = "container" if eff == "apple-container" else eff
        args = [cli, "run", "-d", "--rm", "--name", CONTAINER_SPEC["name"], "-p", f"127.0.0.1:{port}:8000", "-v", f"{hf_cache}:/root/.cache/huggingface", "-v", f"{vdir}:{CONTAINER_VOICES}:ro"]
        if eff == "docker" and gpu == "nvidia":
            args.extend(["--gpus", "all"])
        elif eff == "podman" and gpu == "nvidia":
            args.extend(["--device", "nvidia.com/gpu=all"])
        args.append(img)
        return args

    if action == "plan":
        cmd = build_plan()
        return {"status": "success", "mode": eff, "url": base, "command": " ".join(cmd) if cmd else "(external)", "voices_mount": f"{vdir}:{CONTAINER_VOICES}:ro"}
    if action == "status":
        return inspect_mlx_environment(eff, port=port)
    if action == "load_model":
        if not model_name:
            return {"status": "error", "error": "model_name is required for load_model"}
        resp = mlx_http_json(base, f"/v1/models?model_name={model_name}", method="POST", timeout=1800)
        return {"status": "success", "loaded": model_name, "response": resp}
    if action == "unload_model":
        if not model_name:
            return {"status": "error", "error": "model_name is required for unload_model"}
        resp = mlx_http_json(base, f"/v1/models?model_name={model_name}", method="DELETE", timeout=60)
        return {"status": "success", "unloaded": model_name, "response": resp}
    if action == "logs":
        if eff in ("docker", "podman", "apple-container"):
            cli = "container" if eff == "apple-container" else eff
            proc = subprocess.run([cli, "logs", CONTAINER_SPEC["name"]], capture_output=True, text=True, timeout=15)
            return {"status": "success", "logs": (proc.stdout + proc.stderr)[-4000:]}
        return {"status": "success", "logs": "Check Sound Lab native log or launchd log."}
    if action == "stop":
        if eff in ("docker", "podman", "apple-container"):
            cli = "container" if eff == "apple-container" else eff
            proc = subprocess.run([cli, "stop", CONTAINER_SPEC["name"]], capture_output=True, text=True, timeout=60)
            return {"status": "success" if proc.returncode == 0 else "error", "detail": (proc.stdout + proc.stderr).strip()}
        return {"status": "error", "error": "Stop native/external servers using their PID or `brew services stop mlx-audio`."}
    if action == "start":
        try:
            mlx_http_json(base, "/v1/models", timeout=2)
            return {"status": "success", "started": False, "already_running": True, "url": base}
        except Exception:
            pass
        cmd = build_plan()
        if not cmd:
            return {"status": "error", "error": f"No server at {base} and mode is external."}
        Path(vdir).mkdir(parents=True, exist_ok=True)
        Path(hf_cache).mkdir(parents=True, exist_ok=True)
        if eff == "native":
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        else:
            cli = cmd[0]
            subprocess.run([cli, "delete" if eff == "apple-container" else "rm", "--force" if eff == "apple-container" else "-f", CONTAINER_SPEC["name"]], capture_output=True, timeout=20)
            run_cmd(cmd, timeout=600)
        for _ in range(90):
            try:
                h = mlx_http_json(base, "/v1/models", timeout=2)
                return {"status": "success", "started": True, "url": base, "loaded_models": [m.get("id") for m in (h.get("data") or [])]}
            except Exception:
                time.sleep(1)
        return {"status": "error", "error": f"Server did not become ready at {base}"}
    return {"status": "error", "error": f"Unknown action: {action}"}


def list_mlx_models(category: str = "all") -> dict[str, Any]:
    """List supported mlx-audio voice cloning, TTS, speech-to-text, and separation models.

    Args:
        category: `all`, `voice_cloning_tts`, `standard_tts`, `speech_to_text`, or `separation`.
    """
    if category != "all" and category in MODELS_CATALOG:
        return {"status": "success", "category": category, "models": MODELS_CATALOG[category]}
    return {"status": "success", "catalog": MODELS_CATALOG}


def _list_profiles(voices_dir: str) -> list[dict[str, Any]]:
    vd = Path(voices_dir)
    if not vd.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for sub in sorted(vd.iterdir()):
        pf = sub / "profile.json"
        if pf.is_file():
            try:
                data = json.loads(pf.read_text(encoding="utf-8"))
                if data.get("reference") and Path(data["reference"]).is_file():
                    out.append(data)
            except Exception:
                pass
    return sorted(out, key=lambda x: str(x.get("createdAt", "")), reverse=True)


def clone_user_voice(
    name: str,
    audio_paths: list[str],
    purpose: str = "presentation",
    model: str = "mlx-community/chatterbox-turbo-4bit",
    voices_dir: str = "",
    consent_confirmed: bool = False,
    mlx_url: str = "http://127.0.0.1:8000",
    container_mode: str = "native",
    stt_model: str = "mlx-community/whisper-large-v3-turbo",
    reference_text_override: str = "",
    tool_context: Optional[ToolContext] = None,
) -> dict[str, Any]:
    """Validate audio takes, build a cleaned 24 kHz mono cloning reference, transcribe `ref_text`, and save the voice profile.

    Args:
        name: Human name for the cloned voice profile (e.g. "Speaker Voice").
        audio_paths: One or more WAV/MP3/M4A take recordings (5-30 seconds of clean speech total).
        purpose: `presentation`, `audiobook`, or `vocals`.
        model: Cloning-capable mlx-audio model ID (default `mlx-community/chatterbox-turbo-4bit`).
        voices_dir: Folder storing saved voice profiles (mounted at `/soundlab/voices` for containers).
        consent_confirmed: Must be True confirming the user owns or has explicit permission to clone the voice.
        mlx_url: Base URL of running mlx-audio server.
        container_mode: `native`, `docker`, `podman`, `apple-container`, or `external`.
        stt_model: STT model used to transcribe the reference audio for `ref_text`.
        reference_text_override: Optional verbatim transcript if STT is unavailable or needs override.
    """
    if not consent_confirmed:
        return {"status": "error", "error": f"Explicit consent required: {CONSENT_STATEMENT}"}
    if not audio_paths:
        return {"status": "error", "error": "Provide at least one speech recording path in audio_paths."}

    ff, _ = ffmpeg_bins()
    reports = []
    for ap in audio_paths:
        if not Path(ap).is_file():
            return {"status": "error", "error": f"Audio take not found: {ap}"}
        rep = check_take_ffmpeg(ff, ap)
        reports.append({"path": ap, **rep})
        if not rep["ok"]:
            return {"status": "error", "error": f"Take failed QC ({ap}): {'; '.join(rep['warnings'])}", "reports": reports}

    vdir = Path(voices_dir or default_voices_dir()).resolve()
    vdir.mkdir(parents=True, exist_ok=True)
    base_id = slugify(name)
    prof_id = base_id
    idx = 2
    while (vdir / prof_id / "profile.json").exists():
        prof_id = f"{base_id}-{idx}"
        idx += 1

    prof_dir = vdir / prof_id
    prof_dir.mkdir(parents=True, exist_ok=True)
    ref_wav = str(prof_dir / "reference.wav")
    build_reference_ffmpeg(ff, audio_paths, ref_wav)

    ref_text = reference_text_override.strip()
    if not ref_text:
        try:
            tr = mlx_transcribe(mlx_url, ref_wav, model=stt_model)
            ref_text = tr.get("text", "").strip()
        except Exception:
            ref_text = ""

    (prof_dir / "reference.txt").write_text(ref_text + "\n", encoding="utf-8")
    profile = {
        "id": prof_id,
        "name": name,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "purpose": purpose,
        "reference": ref_wav,
        "referenceText": ref_text,
        "model": model,
        "consent": {
            "confirmed": True,
            "statement": CONSENT_STATEMENT,
            "at": datetime.now(timezone.utc).isoformat(),
        },
    }
    (prof_dir / "profile.json").write_text(json.dumps(profile, indent=2), encoding="utf-8")

    # Smoke-test preview synthesis via mlx-audio using server-side path mapping.
    server_ref = to_server_ref_path(ref_wav, str(vdir), container_mode)
    preview_wav = str(prof_dir / "preview.wav")
    preview_bytes = mlx_http_json(
        mlx_url,
        "/v1/audio/speech",
        method="POST",
        payload={
            "model": model,
            "input": "Hello, this is my Sound Lab voice ready to narrate the presentation.",
            "response_format": "wav",
            "ref_audio": server_ref,
            **({"ref_text": ref_text} if ref_text else {}),
        },
    )
    if isinstance(preview_bytes, (bytes, bytearray)) and preview_bytes:
        Path(preview_wav).write_bytes(preview_bytes)

    if tool_context is not None:
        tool_context.state["user_voice_profile"] = profile
    return {
        "status": "success",
        "profile": profile,
        "server_ref_path": server_ref,
        "preview_wav": preview_wav if Path(preview_wav).is_file() else None,
        "take_reports": reports,
    }


def overlay_presentation_with_cloned_voice(
    presentation_dir: str,
    voice_profile_id: str = "",
    voices_dir: str = "",
    output_video: str = "",
    mlx_url: str = "http://127.0.0.1:8000",
    container_mode: str = "native",
    lang: str = "eng",
    tool_context: Optional[ToolContext] = None,
) -> dict[str, Any]:
    """Synthesize cloned narration for every slide in `presentation.json`, write transcripts, and overlay into an MP4 tutorial.

    Args:
        presentation_dir: Folder containing `presentation.json` scaffolded by `deep_research_agent`.
        voice_profile_id: Saved voice profile ID (or uses `user_voice_profile` in session state / latest saved profile).
        voices_dir: Directory containing saved voice profiles.
        output_video: Optional output `.mp4` path (default `<presentation_dir>/<slug> (tutorial).mp4`).
        mlx_url: Base URL of running mlx-audio server.
        container_mode: `native`, `docker`, `podman`, `apple-container`, or `external`.
        lang: ISO 639-2 track language tag (default `eng`).
    """
    pdir = Path(presentation_dir).resolve()
    pres_file = pdir / "presentation.json"
    if not pres_file.is_file():
        return {"status": "error", "error": f"presentation.json not found in {pdir}"}
    spec = json.loads(pres_file.read_text(encoding="utf-8"))
    slides = spec.get("slides") or []
    if not slides:
        return {"status": "error", "error": "Presentation contains no slides."}

    vdir = Path(voices_dir or default_voices_dir()).resolve()
    profile: dict[str, Any] | None = None
    if voice_profile_id:
        profile = next((p for p in _list_profiles(str(vdir)) if p.get("id") == voice_profile_id), None)
    if not profile and tool_context is not None:
        vp = tool_context.state.get("user_voice_profile")
        if isinstance(vp, dict):
            profile = vp
    if not profile:
        profs = _list_profiles(str(vdir))
        profile = profs[0] if profs else None
    if not profile:
        return {"status": "error", "error": f"No cloned voice profile found in {vdir}. Run clone_user_voice first."}

    server_ref = to_server_ref_path(profile["reference"], str(vdir), container_mode)
    ff, fp = ffmpeg_bins()
    base_name = slugify(spec.get("title") or "presentation")
    work = pdir / f".{base_name}-adk-work"
    frames_dir = pdir / "slides-frames"
    work.mkdir(parents=True, exist_ok=True)
    frames_dir.mkdir(parents=True, exist_ok=True)

    chunk_meta: list[dict[str, Any]] = []
    for si, s in enumerate(slides):
        chunks = chunk_speakable_text(str(s.get("narration") or s.get("title") or "")) or [str(s.get("title") or f"Slide {si+1}")]
        for ci, txt in enumerate(chunks):
            chunk_meta.append({"slide_idx": si, "text": txt, "first": ci == 0})

    audio_files: list[str] = []
    for i, item in enumerate(chunk_meta):
        out_wav = work / f"chunk_{i + 1:04d}.wav"
        payload: dict[str, Any] = {
            "model": profile["model"],
            "input": item["text"],
            "response_format": "wav",
            "ref_audio": server_ref,
        }
        if profile.get("referenceText"):
            payload["ref_text"] = profile["referenceText"]
        wav_bytes = mlx_http_json(mlx_url, "/v1/audio/speech", method="POST", payload=payload)
        if not isinstance(wav_bytes, (bytes, bytearray)) or not wav_bytes:
            return {"status": "error", "error": f"mlx-audio returned empty speech for chunk {i+1}"}
        out_wav.write_bytes(wav_bytes)
        audio_files.append(str(out_wav))

    timeline: list[dict[str, Any]] = []
    slide_start = [0.0] * len(slides)
    cursor = 0.4
    slide_pause = 0.65
    for i, fpath in enumerate(audio_files):
        meta = chunk_meta[i]
        if meta["first"] and i > 0:
            cursor += slide_pause
        if meta["first"]:
            slide_start[meta["slide_idx"]] = 0.0 if i == 0 else cursor - slide_pause * 0.4
        dur = probe_duration(fp, fpath) or 1.0
        timeline.append({"start": cursor, "end": cursor + dur, "text": meta["text"]})
        cursor += dur + 0.25
    total_dur = cursor + 0.6

    narration_wav = str(pdir / f"{base_name} (narration).wav")
    mix_args = [ff, "-hide_banner", "-nostdin", "-y"]
    for af in audio_files:
        mix_args.extend(["-i", af])
    parts = [f"[{i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono,adelay={round(timeline[i]['start'] * 1000)}:all=1[n{i}]" for i in range(len(audio_files))]
    ins = "".join(f"[n{i}]" for i in range(len(audio_files)))
    graph = f"{';'.join(parts)};{ins}amix=inputs={len(audio_files)}:duration=longest:normalize=0,apad=whole_dur={total_dur:.3f},highpass=f=70,acompressor=threshold=0.12:ratio=2.5:attack=8:release=120,loudnorm=I=-16:TP=-1.5:LRA=9,aresample=48000[out]"
    run_cmd([*mix_args, "-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_s24le", narration_wav])

    sidecars = write_transcript_sidecars(str(pdir / f"{base_name} (transcript)"), timeline, source=spec.get("title", base_name), language=lang)
    srt_path = next(p for p in sidecars if p.endswith(".srt"))

    slide_pngs: list[str] = []
    for si, s in enumerate(slides):
        png_path = frames_dir / f"slide_{si + 1:03d}.png"
        png_bytes = render_slide_png(
            index=si + 1,
            total=len(slides),
            title=str(s.get("title") or f"Slide {si + 1}"),
            bullets=[str(b) for b in (s.get("bullets") or [])],
            code_snippet=str(s.get("codeSnippet") or ""),
            presentation_title=str(spec.get("title") or ""),
            subtitle_hint=f"Slide {si + 1}/{len(slides)} · {spec.get('topic', '')}",
        )
        png_path.write_bytes(png_bytes)
        slide_pngs.append(str(png_path))

    concat_path = work / "slides.ffconcat"
    concat_lines = ["ffconcat version 1.0"]
    for si, png in enumerate(slide_pngs):
        end_t = total_dur if si == len(slide_pngs) - 1 else slide_start[si + 1]
        dur = max(0.5, end_t - slide_start[si])
        esc = png.replace("'", "'\\''")
        concat_lines.append(f"file '{esc}'")
        concat_lines.append(f"duration {dur:.3f}")
    concat_lines.append(f"file '{slide_pngs[-1].replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'")
    concat_path.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")

    out_mp4 = str(Path(output_video).resolve()) if output_video else str(pdir / f"{base_name} (tutorial).mp4")
    run_cmd([
        ff, "-hide_banner", "-nostdin", "-y",
        "-f", "concat", "-safe", "0", "-i", str(concat_path),
        "-i", narration_wav,
        "-i", srt_path,
        "-map", "0:v:0", "-map", "1:a:0", "-map", "2:0",
        "-vf", "fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
        "-c:v", "libx264", "-tune", "stillimage", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-metadata:s:a:0", f"language={lang}",
        "-metadata:s:a:0", "title=Narration (cloned voice)",
        "-metadata:s:a:0", "handler_name=Narration (cloned voice)",
        "-disposition:a:0", "default",
        "-c:s", "mov_text",
        "-metadata:s:s:0", f"language={lang}",
        "-metadata:s:s:0", "title=Transcript",
        "-metadata:s:s:0", "handler_name=Transcript",
        "-disposition:s:0", "default",
        "-movflags", "+faststart", "-shortest", out_mp4,
    ])
    shutil.rmtree(work, ignore_errors=True)
    res = {
        "status": "success",
        "video": out_mp4,
        "narration": narration_wav,
        "transcripts": sidecars,
        "slide_images": slide_pngs,
        "voice_profile_id": profile["id"],
        "server_ref_path": server_ref,
        "duration_sec": round(total_dur, 2),
    }
    if tool_context is not None:
        tool_context.state["tutorial_video_result"] = res
    return res


def transcribe_and_overlay_recording(
    video_path: str,
    voice_profile_id: str = "",
    voices_dir: str = "",
    output_dir: str = "",
    mlx_url: str = "http://127.0.0.1:8000",
    container_mode: str = "native",
    stt_model: str = "mlx-community/whisper-large-v3-turbo",
    lang: str = "eng",
    tool_context: Optional[ToolContext] = None,
) -> dict[str, Any]:
    """Transcribe a recorded screen/slide video with mlx-audio, re-narrate in cloned voice, and mux audio + transcript into MP4.

    Args:
        video_path: Recorded screen or slide video path.
        voice_profile_id: Saved voice profile ID.
        voices_dir: Directory containing saved voice profiles.
        output_dir: Destination folder (defaults beside `video_path`).
        mlx_url: Base URL of running mlx-audio server.
        container_mode: `native`, `docker`, `podman`, `apple-container`, or `external`.
        stt_model: Speech-to-text model ID on mlx-audio.
        lang: ISO 639-2 language tag.
    """
    src = Path(video_path).resolve()
    if not src.is_file():
        return {"status": "error", "error": f"Video not found: {src}"}

    vdir = Path(voices_dir or default_voices_dir()).resolve()
    profile = next((p for p in _list_profiles(str(vdir)) if not voice_profile_id or p.get("id") == voice_profile_id), None)
    if not profile:
        return {"status": "error", "error": f"No cloned voice profile found in {vdir}."}

    ff, fp = ffmpeg_bins()
    out_root = Path(output_dir).resolve() if output_dir else src.parent
    out_root.mkdir(parents=True, exist_ok=True)
    work = out_root / f".{src.stem}-dub-work"
    work.mkdir(parents=True, exist_ok=True)

    wav16 = str(work / "talk16k.wav")
    run_cmd([ff, "-hide_banner", "-nostdin", "-y", "-i", str(src), "-map", "0:a:0", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav16])
    tr = mlx_transcribe(mlx_url, wav16, model=stt_model)
    segs = tr.get("segments") or [{"start": 0.0, "end": probe_duration(fp, str(src)) or 5.0, "text": tr.get("text", "")}]
    segs = [s for s in segs if s.get("text")]
    if not segs:
        return {"status": "error", "error": "No speech detected in recording."}

    server_ref = to_server_ref_path(profile["reference"], str(vdir), container_mode)
    placed: list[dict[str, Any]] = []
    cursor = 0.0
    for i, s in enumerate(segs):
        c_wav = str(work / f"seg_{i + 1:04d}.wav")
        payload: dict[str, Any] = {
            "model": profile["model"],
            "input": s["text"],
            "response_format": "wav",
            "ref_audio": server_ref,
        }
        if profile.get("referenceText"):
            payload["ref_text"] = profile["referenceText"]
        b = mlx_http_json(mlx_url, "/v1/audio/speech", method="POST", payload=payload)
        Path(c_wav).write_bytes(b)
        d = probe_duration(fp, c_wav) or 1.0
        start = max(float(s["start"]), cursor + 0.15)
        placed.append({"file": c_wav, "start": start, "end": start + d, "text": s["text"]})
        cursor = start + d

    narration_wav = str(out_root / f"{src.stem} (narration).wav")
    mix_args = [ff, "-hide_banner", "-nostdin", "-y"]
    for p in placed:
        mix_args.extend(["-i", p["file"]])
    parts = [f"[{i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono,adelay={round(placed[i]['start'] * 1000)}:all=1[n{i}]" for i in range(len(placed))]
    ins = "".join(f"[n{i}]" for i in range(len(placed)))
    graph = f"{';'.join(parts)};{ins}amix=inputs={len(placed)}:duration=longest:normalize=0,highpass=f=70,acompressor=threshold=0.12:ratio=2.5:attack=8:release=120,loudnorm=I=-16:TP=-1.5:LRA=9,aresample=48000[out]"
    run_cmd([*mix_args, "-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_s24le", narration_wav])

    sidecars = write_transcript_sidecars(str(out_root / f"{src.stem} (transcript)"), [{"start": p["start"], "end": p["end"], "text": p["text"]} for p in placed], source=src.name, language=lang)
    srt_path = next(p for p in sidecars if p.endswith(".srt"))

    out_video = str(out_root / f"{src.stem} (narrated).mp4")
    run_cmd([
        ff, "-hide_banner", "-nostdin", "-y",
        "-i", str(src), "-i", narration_wav, "-i", srt_path,
        "-map", "0:v?", "-map", "1:a", "-map", "0:a?", "-map", "2:0",
        "-c:v", "copy",
        "-c:a:0", "aac", "-b:a:0", "192k",
        "-metadata:s:a:0", f"language={lang}",
        "-metadata:s:a:0", "title=Narration (cloned voice)",
        "-metadata:s:a:0", "handler_name=Narration (cloned voice)",
        "-disposition:a:0", "default",
        "-c:a:1", "copy", "-disposition:a:1", "0",
        "-c:s", "mov_text",
        "-metadata:s:s:0", f"language={lang}",
        "-metadata:s:s:0", "title=Transcript",
        "-metadata:s:s:0", "handler_name=Transcript",
        "-disposition:s:0", "default",
        "-movflags", "+faststart", out_video,
    ])
    shutil.rmtree(work, ignore_errors=True)
    return {"status": "success", "video": out_video, "narration": narration_wav, "transcripts": sidecars}


def _build_tools() -> list[Any]:
    tools: list[Any] = [
        inspect_mlx_environment,
        manage_mlx_service,
        list_mlx_models,
        clone_user_voice,
        overlay_presentation_with_cloned_voice,
        transcribe_and_overlay_recording,
    ]
    if os.environ.get("SOUND_LAB_ATTACH_MCP") == "1":
        try:
            from google.adk.tools import McpToolset
            from google.adk.tools.mcp_tool.mcp_session_manager import StdioConnectionParams
            from mcp import StdioServerParameters

            mcp_server = Path(__file__).resolve().parents[2] / "plugins" / "sound-lab-studio" / "mcp" / "server.js"
            if mcp_server.is_file():
                tools.append(
                    McpToolset(
                        connection_params=StdioConnectionParams(
                            server_params=StdioServerParameters(command="node", args=[str(mcp_server)])
                        )
                    )
                )
        except Exception:
            pass
    return tools


def create_mlx_voice_clone_expert() -> LlmAgent:
    """Create a Google ADK expert agent for mlx-audio containers, models, voice cloning, and video overlay."""
    return LlmAgent(
        name="mlx_voice_clone_expert",
        model=DEFAULT_GEMINI_MODEL,
        description=(
            "Expert on mlx-audio containers (:cpu / :cuda12 / native Metal), Speech/TTS/Cloning models, "
            "cloning the user's voice with consent, and overlaying slide presentations or screen recordings "
            "with cloned audio narration and synchronized mov_text/SRT transcripts."
        ),
        instruction="""You are the Sound Lab MLX-Audio Container, Model & Voice Cloning Expert.

Your expertise covers:
1. **mlx-audio containers & hardware modes**:
   - `native` on Apple Silicon macOS (Metal GPU via `mlx_audio.server`, Homebrew formula `cloud-fronts-group/sound-lab/mlx-audio`).
   - `docker` / `podman` (`ghcr.io/cloud-fronts-group/sound-lab-mlx-audio:cuda12` for Linux+NVIDIA with `--gpus all`, `:cpu` otherwise) and `apple-container` (macOS Linux micro-VM, CPU-only). Containers on macOS CANNOT reach Metal.
   - Voice reference mount rule: `mlx-audio` reads `ref_audio` from the server filesystem. In container modes, `voices_dir` is mounted read-only at `/soundlab/voices`, so host paths must be translated to `/soundlab/voices/<id>/reference.wav`.
2. **mlx-audio models**:
   - Voice cloning: `mlx-community/chatterbox-turbo-4bit` (default), `chatterbox-multilingual-v3`, `Qwen3-TTS-12Hz-1.7B-Base-8bit`, `Qwen3-TTS-12Hz-0.6B-Base-8bit`, `csm-1b-8bit`, `Spark-TTS-0.5B-bf16`, `Llama-OuteTTS-1.0-1B-4bit`. Always pair `ref_audio` with verbatim `ref_text`.
   - STT: `mlx-community/whisper-large-v3-turbo`, `parakeet-tdt-0.6b-v2`, `whisper-small-mlx`, `whisper-tiny`.
   - Separation: `mlx-community/sam-audio-large-fp16`.
3. **Voice cloning & Slide/Video Tutorial Overlay**:
   - Verify consent before cloning (`consent_confirmed=True`).
   - Use `clone_user_voice` to QC takes, clean & join into 24 kHz mono WAV, transcribe `ref_text`, preview, and save profile.
   - Use `overlay_presentation_with_cloned_voice` to synthesize slide narration in the cloned voice, render slide frames, write `.srt`/`.vtt`/`.txt`/`.json` transcripts, and mux cloned audio + embedded `mov_text` transcript into MP4.
   - Use `transcribe_and_overlay_recording` to transcribe screen/slide recordings, re-narrate in cloned voice, and mux cloned audio + `mov_text` transcript into MP4.""",
        tools=_build_tools(),
        output_key="tutorial_video_result",
    )


mlx_voice_clone_expert = create_mlx_voice_clone_expert()
