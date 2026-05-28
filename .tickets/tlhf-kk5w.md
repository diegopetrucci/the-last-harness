---
id: tlhf-kk5w
status: open
deps: []
links: []
created: 2026-05-28T05:45:05Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [rtk, docs, sessions]
---
# Document RTK reporting limits for TLH sessions

Clarify RTK reporting boundaries for TLH sessions. Investigation tlhf-2820 found `rtk session` / `rtk discover` are built around Claude Code session files under `~/.claude/projects` and hook-success metadata, not TLH/Pi session JSONL under `~/.the-last-harness/agent/sessions`. Path-remapping TLH sessions into a fake Claude root still yielded 0 bash commands and risks exposing isolated transcripts. `rtk gain --project --history` already captures local RTK savings for TLH usage via RTK history.

## Design

This can be a docs-only ticket unless the sessions audit helper adds its own RTK note. Do not recommend symlinking/copying TLH sessions into `~/.claude/projects`; that is inaccurate and weakens isolation. Position `rtk gain --project --history` as the current savings/adoption evidence source, and position `tlh sessions audit` as the future transcript aggregate surface.

## Acceptance Criteria

- TLH docs explain that `rtk session` / `rtk discover` are Claude-session oriented and do not currently provide trustworthy TLH session reporting.
- Docs recommend `rtk gain --project --history` for local TLH RTK savings evidence.
- Docs explicitly avoid recommending symlinking/copying TLH sessions into Claude session directories.
- If `tlh sessions audit` exists by implementation time, docs explain how it complements RTK gain reporting.

