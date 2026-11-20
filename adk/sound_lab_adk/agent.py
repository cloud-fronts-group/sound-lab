"""Root Google ADK Coordinator & Graph Workflow for Sound Lab Instructional Presentations."""

from __future__ import annotations

import os

from google.adk import Workflow
from google.adk.agents import LlmAgent

from .deep_research import create_deep_research_agent
from .mlx_expert import create_mlx_voice_clone_expert

DEFAULT_GEMINI_MODEL = os.environ.get("SOUND_LAB_GEMINI_MODEL", "gemini-4-hydrogen")

presentation_workflow_agent = Workflow(
    name="presentation_workflow_agent",
    edges=[("START", create_deep_research_agent(), create_mlx_voice_clone_expert())],
)

root_agent = LlmAgent(
    name="sound_lab_presentation_coordinator",
    model=DEFAULT_GEMINI_MODEL,
    description=(
        "Coordinates Sound Lab instructional presentation creation: initializes by cloning the user's voice, "
        "asks what the presentation will be about and which folder to use, runs Deep Research to scaffold a "
        "5-10 minute instructional presentation, and overlays slides or screen recordings with cloned audio & transcript."
    ),
    instruction="""You are the Sound Lab Presentation & Video Tutorial Coordinator.

Follow this exact initialization and execution sequence:
1. **Initialize by cloning the user's voice**:
   - First check/prepare the mlx-audio runtime and clone (or select) the user's voice by delegating to `mlx_voice_clone_expert`.
   - Confirm explicit voice-cloning consent before creating a profile.
2. **Ask what the presentation will be about**:
   - Once the voice profile is initialized (or selected), ask the user:
     a) What will the presentation be about (topic & target audience)?
     b) Which folder should the instructional presentation be grounded in?
     c) Desired duration in the 5-10 minute window (default 7.5 minutes)?
3. **Inspect folder, run Deep Research, and scaffold 5-10 min presentation**:
   - Delegate to `deep_research_agent` to inspect the folder, run Gemini Deep Research (`deep-research-preview-04-2026`), and scaffold the 5-10 minute instructional presentation (`presentation.json`, `slides.md`, `slides.html`, `narration-script.txt`, `research-report.md`).
4. **Overlay slides or screen recording with cloned audio & transcript**:
   - Delegate to `mlx_voice_clone_expert` to overlay the scaffolded slide deck (or recorded screen/slide talk) with cloned narration audio and synchronized `.srt`/`.vtt`/`.txt`/`.json` + embedded `mov_text` transcript subtitles in `.mp4`.""",
    sub_agents=[create_mlx_voice_clone_expert(), create_deep_research_agent()],
)
