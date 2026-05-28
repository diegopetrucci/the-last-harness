---
id: tlhf-dn7h
status: open
deps: []
links: []
created: 2026-05-28T05:45:05Z
type: task
priority: 1
assignee: Diego Petrucci
tags: [token-optimization, subagents, prompt]
---
# Reduce redundant review and oracle fan-out

Tighten TLH orchestration guidance to reduce redundant review/oracle fan-out while preserving safety. Investigation tlhf-obvs found classified child review/oracle spend was $15.176 (74.2% of classified child spend), with conservative reducible overlap of about $4.5 (22%) from repeated full-branch rereads and duplicate oracle/reviewer scopes. The goal is not to reduce high-risk installer or trust-boundary safety review; it is to make follow-ups delta-only and avoid multiple agents reviewing the same full diff without disjoint scope.

## Design

Likely touchpoints: agents/primary/architect.md and any packaged primary-agent guidance. Preserve explicit carve-outs for destructive installer/path deletion, trust-boundary, execution, auth, or unresolved disagreement cases. Parallel reviewers should be allowed only with disjoint scopes. Oracle should remain available for high-uncertainty/high-blast-radius work, but default to one oracle per branch unless the threat model materially changes.

## Acceptance Criteria

- Architect/orchestration guidance defaults to one reviewer for normal code changes.
- Oracle use is reserved for trust-boundary, destructive-path, auth/execution, unresolved disagreement, or durable uncertainty cases, with one oracle per branch by default.
- Follow-up reviews after fixes default to delta-only scope.
- Guidance preserves targeted safety re-reviews and one final whole-branch review for high-risk installer/destructive-path work when warranted.
- Guidance discourages multiple reviewers/oracles over the same full `main...HEAD` diff unless scopes are explicitly disjoint.

