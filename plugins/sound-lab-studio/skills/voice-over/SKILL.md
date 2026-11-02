---
name: voice-over
description: Generate voice-overs, dubbing scratch tracks, announcer tags and station IDs from text with MLX text-to-speech (Kokoro and other mlx-audio TTS models) through the sound-lab-media MCP server — native on Apple Silicon or in a container. Use when the user has a script but no recording.
argument-hint: "\"<script text>\" [voice <name>] [speed <0.5-2>] [-> out.wav]"
---

# Voice-over with MLX TTS

Request: $ARGUMENTS

1. **Make sure the MLX audio service is up**: `mlx_service { action: "status" }`. If it isn't reachable, call `mlx_service { action: "start" }` (native on Apple Silicon = Metal GPU; Docker or Apple `container` elsewhere). First use downloads the model to the Hugging Face cache (Kokoro-82M is about 330 MB).
2. **Split long scripts** into sentences or cues (about 1–3 sentences each). Shorter requests sound more natural and are easier to place on a timeline.
3. **Synthesize** each cue in the background:
   ```text
   synthesize_speech { text: "Welcome back to Sound Lab radio.", output: "./vo/cue01.wav", voice: "af_heart", speed: 1.0 }
   wait_job { job_id: "tts-…" }
   ```
   Kokoro voices: `af_heart`, `af_bella`, `af_nicole`, `am_adam`, `am_michael` (US) · `bf_emma`, `bm_george` (UK). Language via `lang_code`: a (US), b (UK), e (es), f (fr), h (hi), i (it), j (ja), p (pt-br), z (zh). Other MLX TTS models (set `model`) may support `instruct` style prompts or voice cloning.
4. **Polish**: `highpass=f=70,acompressor=threshold=0.15:ratio=2.5,deesser,loudnorm=I=-16:TP=-1.5`. Add room tone if it will sit under picture.
5. **Assemble.** Join cues with gaps (`concat`, or `adelay` per cue), then hand the file to `dub-music`, `dub-video` or `dub-stream`.
6. Tell the user it is synthetic speech. Never imitate a real person's voice without their consent.
