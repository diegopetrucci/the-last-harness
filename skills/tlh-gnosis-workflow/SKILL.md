---
name: tlh-gnosis-workflow
description: Use for concise TLH Gnosis workflow guidance before implementation and during review.
---

# TLH Gnosis Workflow

Use this summary when Gnosis is available and your role is allowed to run `gn`. If your role forbids Gnosis commands, do not use `gn`; report durable findings to the parent agent or supervisor instead.

## Before implementation

1. Search existing memory first with 2-5 relevant keywords joined by `OR`; start broad, then refine.
2. Read the most relevant hits before coding.
3. Surface conflicts early when memory disagrees with the ticket, repo state, or other trusted instructions.

## Write memory only when it is

- human-origin knowledge that will not be obvious from code later,
- durable enough to matter across future tasks,
- cross-cutting rationale, constraints, decisions, rejected options, process rules, or non-obvious gotchas.

## Do not write memory for

- secrets, tokens, PII, or private incident details,
- transient task status, scratch notes, or one-off debugging steps,
- facts already clear from code, tests, or docs,
- speculative ideas that were not actually adopted.

## Review / handoff

- Re-check whether the work created or invalidated durable knowledge.
- If code or docs now conflict with existing memory, update memory or flag the conflict in handoff.
- Use review-time memory writes only for durable follow-up knowledge, not for restating the diff.

## Read full help when

- you are uncertain how to search, read, or write safely,
- this summary is missing,
- Gnosis behavior or policy seems stale or has changed,
- instructions conflict and you need the source doctrine.

Then read `gn help plan` before implementation and `gn help review` before final review or handoff.
