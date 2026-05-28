---
id: tlhf-oxgl
status: open
deps: []
links: []
created: 2026-05-28T05:45:04Z
type: task
priority: 1
assignee: Diego Petrucci
tags: [token-optimization, gnosis, prompt]
---
# Embed concise Gnosis workflow guidance

Replace the current unconditional full-output Gnosis help workflow with concise TLH-owned guidance plus an explicit full-help fallback. Investigation tlhf-jl51 found repeated `gn help plan` / `gn help review` output was the clearest single token waste source: about 46k direct tokens and about 1.90M recirculated/context tokens in observed TLH sessions. Suppressed historical calls (`gn help ... >/dev/null && echo ok`) reduced visible payload by ~99.9%, but suppression is safe only if the required guidance is already summarized in context.

## Design

Likely touchpoints: AGENTS.md repo guidance and packaged primary-agent/system guidance where TLH currently requires full `gn help plan` / `gn help review` every task. Preserve the intent: agents must still use Gnosis for relevant memory search/recording and must be able to read the full doctrine when uncertain, missing, or stale. Avoid making the full Gnosis text an always-on prompt dump. Do not weaken the Gnosis requirement itself.

## Acceptance Criteria

- TLH repo/agent guidance includes a concise authoritative summary of required Gnosis plan/review behavior.
- Unconditional instructions that dump full `gn help plan` / `gn help review` output every session are removed or narrowed.
- Guidance explicitly keeps full `gn help ...` as a fallback when uncertain, when the summary is missing, or when Gnosis behavior changes.
- If a bookkeeping command is still required, guidance uses a bounded/suppressed form rather than adding the full help text to transcript context.
- Tests or targeted prompt checks cover the updated wording.

