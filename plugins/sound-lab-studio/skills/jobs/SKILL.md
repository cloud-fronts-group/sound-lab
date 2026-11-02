---
name: jobs
description: Show, follow, cancel or resume Sound Lab background jobs (batch conversions, ffmpeg renders/stream captures, transcriptions, TTS, separations) — including jobs from earlier sessions.
argument-hint: "[job id] [cancel|resume|log]"
disable-model-invocation: true
---

# Background jobs

Request: $ARGUMENTS

- No id: `list_jobs { limit: 15 }`. Show a compact table (id, title, status, progress %, finished at).
- With an id: `job_status { job_id, include_log: <true if "log"> }`. Summarise the per-item progress, outputs and errors.
- `cancel` → `cancel_job`. `resume` → `resume_job` (re-queues failed, cancelled or interrupted items).
- "Interrupted" means the MCP server stopped (Claude Code quit, plugin reloaded) while the job was running. The outputs of the items that finished are kept, and `resume_job` re-runs the rest.
