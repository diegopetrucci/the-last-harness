---
id: tlhf-hc2q
status: open
deps: []
links: []
created: 2026-05-28T05:45:05Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [token-optimization, sessions, feature]
---
# Add read-only tlh sessions audit helper

Add a read-only TLH-native session audit helper so session analysis can start from compact aggregates instead of raw JSONL transcript reads. Investigation tlhf-oz75 recommended `tlh sessions audit` after measuring a current corpus of 62 session JSONLs, ~74.8M recorded total tokens, and ~8.58M chars of tool-result text. Tool output dominated visible text, and raw session JSONL is expensive because each line is a large JSON object. RTK session/discover is not the right surface because it is Claude-format oriented.

## Design

Likely implementation: a new script such as scripts/tlh-sessions.mjs exposed by the wrapper as `tlh sessions audit`. Parse session JSONL streaming line-by-line from the isolated agent dir. Group a logical session tree as the root `<timestamp>_<id>.jsonl` plus child `run-*/session.jsonl` files. Defaults should be privacy-safe: current cwd/recent window when possible, aggregate-only, no prompts/prose/tool bodies/thinking/signatures/compaction summaries. Support text and JSON output.

## Acceptance Criteria

- `tlh sessions audit` (or equivalent approved subcommand) is read-only and operates on the isolated TLH profile, never normal Pi config.
- Default output summarizes session trees rather than treating nested child run files as independent top-level sessions.
- Default scope is bounded and privacy-safe (for example current cwd and recent window) and prints aggregate-only metrics.
- Output includes token/cost totals, provider/model mix if available, top tools, tool-result char counts, and optional child-run summaries.
- JSON mode is supported and omits transcript content by default.
- Tests/fixtures cover session-tree grouping, aggregate fields, text output, JSON output, and no-content defaults.

