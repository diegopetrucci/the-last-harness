---
id: tlhf-z53p
status: closed
deps: []
links: [tlhf-dn7h]
created: 2026-05-30T16:04:48Z
type: task
priority: 1
assignee: Diego Petrucci
tags: [token-optimization, subagents, prompt]
---
# Default follow-up code reviews to delta scope

Split from tlhf-dn7h. Tighten TLH orchestration and reviewer guidance so follow-up reviews after developer fix rounds are scoped to the delta since the previous review/checkpoint instead of rereading the full branch diff, unless safety or correctness requires broader targeted review.

## Design

Likely touchpoints: agents/primary/architect.md and packaged code-reviewer/primary-agent guidance. The architect should pass previous findings, the fix ticket/task, and an exact baseline/range or changed-file list for the follow-up review. Preserve carve-outs for high-risk installer/destructive-path, trust-boundary, auth/execution, unresolved disagreement, or cases where the delta cannot be validated without wider context.

## Acceptance Criteria

- Follow-up review guidance defaults to delta-only scope after fixes.
- Review requests include prior finding context plus the exact delta range, checkpoint, or changed files to review.
- Code-reviewer guidance supports delta-scoped follow-up review without assuming it always has the full branch diff, while allowing targeted context reads when needed.
- Safety carve-outs document when targeted or full re-review remains appropriate.
- Validation confirms the packaged guidance/prompts include the new behavior.


## Notes

**2026-05-30T16:08:28Z**

Investigation: prompt source of truth is agents/*.md, loaded directly by extensions/the-last-harness/prompts.ts; no generated prompt mirror found. Current architect guidance uses code-reviewer checkpoints for high-risk changes and final review against full VCS diff, but has no follow-up delta rule. Current code-reviewer prompt treats ticket/diff as inputs and has no delta-follow-up contract. Likely change files: agents/primary/architect.md, agents/subagents/code-reviewer.md, tests/agent-prompt-contracts.test.mjs, tests/architect-prompt-routing.test.mjs. Minimal validation: node --test tests/agent-prompt-contracts.test.mjs tests/architect-prompt-routing.test.mjs; npm run validate.
