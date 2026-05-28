---
id: tlhf-ncoz
status: open
deps: []
links: []
created: 2026-05-28T05:45:04Z
type: task
priority: 1
assignee: Diego Petrucci
tags: [token-optimization, tools, prompt]
---
# Add TLH tool-budget guardrails

Add explicit TLH tool-budget guardrails for investigation and review workflows. Investigation tlhf-sn9r found tool results were 98.3% of visible transcript chars, and `bash` + `read` + `grep` produced 98.3% of tool-output chars. The largest waste patterns were broad `grep` (`path='.'`, no glob, `limit=200`, context), whole-file/long-line `read` (especially session JSONL), and raw `bash` diffs/log/API dumps. Investigation tlhf-oz75 also found session analysis should be aggregate-first.

## Design

Likely touchpoints: config/APPEND_SYSTEM.md, extensions/the-last-harness/constants.ts, prompts/analyse-tlh-sessions.md, and any agent prompts that steer repository investigation. Prefer guidance and safer TLH-native surfaces before changing upstream-style tool transport caps. Include proactive temp-file summary patterns for commands expected to produce large output.

## Acceptance Criteria

- Guidance gives numeric starting defaults: `grep` with explicit path+glob, `limit<=20`, `context<=1`; `read` with explicit offset and `limit<=120`; `bash` favoring summaries/counts/stats over raw bodies.
- `/analyse-tlh-sessions` tells agents to prefer streaming JSONL parsers/aggregate summaries over raw transcript `read`/`grep`.
- Guidance warns that TLH session JSONL has long lines and should not be broadly read by default.
- Guidance includes a proactive temp-file-first shell pattern for large outputs and cleanup/privacy notes.
- Validation confirms updated prompts/docs contain the guardrails and examples.

