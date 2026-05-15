---
id: tlha-jk5w
status: closed
deps: []
links: []
created: 2026-05-15T18:39:58Z
type: bug
priority: 1
assignee: Diego Petrucci
---
# Protect critical default extensions

Update bundled default-extension handling so critical defaults such as subagents/intercom cannot be disabled through tlh defaults and stale/manual critical opt-outs do not suppress installer merge or source resolution.

## Design

Reject 'tlh defaults disable <id>' when the manifest entry has critical: true. Treat critical IDs/aliases in tlh.disabledDefaultExtensions as invalid opt-outs for both scripts; clean them from settings when a mutating helper run writes settings. Keep non-critical disable/enable behavior unchanged.

## Acceptance Criteria

'tlh defaults disable <critical-id-or-alias>' exits nonzero without changing settings; existing/manual critical IDs or aliases in tlh.disabledDefaultExtensions do not remove or omit critical packages during merge, sources, or critical-sources; non-critical opt-outs still work.

