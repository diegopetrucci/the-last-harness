---
id: tlht-g3uj
status: open
deps: []
links: []
created: 2026-05-30T10:09:26Z
type: bug
priority: 2
assignee: Diego Petrucci
tags: [subagents, primary-agents, ergonomics]
---
# Smooth TLH subagent list scope ergonomics

Recent TLH session review found a small but recurring ergonomics mismatch around `subagent({ action: "list", agentScope: "both" })`. In the last 7 days of `~/.the-last-harness/agent/sessions`, there were 31 subagent list calls and 2 failed explicit `agentScope:"both"` list calls. Both were assistant/model-originated, not user-originated, and immediately retried successfully with omitted scope.

The source of the stumble appears to be the generic pi-subagents tool schema/default: `agentScope` supports `user|project|both` and advertises/defaults discovery to `both`. TLH primary-agent safety intentionally forces TLH minor subagent management/execution to the isolated user profile and rejects explicit non-user scopes. This is safe, but it trips agents following the upstream schema.

Observed direct waste was low: 2 extra retry turns, about 22,135 extra API tokens processed by retries (mostly cache-read), roughly $0.0178 billed. The issue is primarily agent friction and avoidable failed tool turns, not cost.

## Design

Prefer a narrow compatibility shim for safe management inspection only: normalize explicit `agentScope:"both"` on `action:"list"` (and likely `action:"get"` if safe and appropriate) to TLH's required `agentScope:"user"`, while preserving strict rejection of `both`/`project` for execution. Do not make TLH list or run project-scoped minor agents by default.

Also consider prompt/test guidance so TLH primaries know to omit `agentScope` or use `user` when listing minor agents. If per-primary subagent allowlists land first, make list output/guidance consistent with the active primary's allowed targets.

## Acceptance Criteria

- `subagent({ action: "list", agentScope: "both" })` from an enabled TLH primary no longer fails only because the scope is `both`; it is treated as isolated user-scope listing.
- If `action:"get"` is changed, explicit `agentScope:"both"` is likewise safely normalized or there is a documented reason not to change it.
- Execution calls with `agentScope:"both"` or `agentScope:"project"` are still rejected for TLH primaries.
- `agentScope:"project"`/invalid scopes still fail for management list/get where appropriate.
- Tests cover the normalization and the unchanged execution safety boundary.
- Prompt or docs guidance tells TLH primaries to omit `agentScope` or use `user` for subagent list/get.

