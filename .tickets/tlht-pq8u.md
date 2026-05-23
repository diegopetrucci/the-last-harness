---
id: tlht-pq8u
status: open
deps: []
links: []
created: 2026-05-23T14:59:22Z
type: bug
priority: 1
assignee: Diego Petrucci
tags: [primary-agents, subagent-safety, role-boundaries]
---
# Enforce per-primary subagent delegation allowlists

Branch review found that TLH primary-agent role constraints are prompt-only for some modes. The global subagent safety allowlist currently permits developer, code-reviewer, repo-scout, diff-summarizer, librarian, web-scout, and oracle for every enabled primary. Only Rush has a special runtime block for developer. As a result, product or bug-hunter can call subagent({ agent: \"developer\" }) and launch a write-capable implementation subagent even though product must not implement source changes and bug-hunter is read-only.

Relevant evidence from branch review:
- agents/primary/product.md says product never implements source changes, may edit only product docs/tickets/AGENTS/Gnosis/KNOWLEDGEBASE, and delegates scoped help only to repo-scout or librarian.
- agents/primary/bug-hunter.md says bug-hunter is read-only and never implements fixes.
- agents/primary/architect.md is the primary that delegates implementation to developer.
- agents/primary/rush.md edits directly and must not delegate implementation to developer.
- extensions/the-last-harness-subagent-safety.mjs exports one ALLOWED_SUBAGENTS list and validateSubagentToolInput() checks targets only against that global list.
- extensions/the-last-harness/primary-agent-runtime.ts blocks developer only when selection === \"rush\".
- extensions/the-last-harness/prompts.ts formats the same allowed-subagents prompt section for every primary, which can advertise developer/code-reviewer to modes whose own prompt forbids implementation/review delegation.

Risk: product and bug-hunter have an implementation escape hatch through developer, undermining the advertised TLH safety model and making role-specific constraints dependent on prompt obedience instead of runtime enforcement.

## Design

Introduce per-primary allowed subagent policy and use it consistently in runtime validation and generated prompt text. Preserve the existing generic safety constraints: safe management actions only, isolated user agentScope, fresh context, and nested context validation.

Expected policy should follow primary prompt contracts unless the prompts are intentionally changed in the same work:
- architect: developer, code-reviewer, repo-scout, diff-summarizer, librarian, web-scout, oracle.
- rush: no developer; allow only investigation/review/second-opinion agents that Rush prompt permits.
- product: repo-scout and librarian only, unless product prompt is deliberately updated with a broader non-writing policy.
- bug-hunter: repo-scout, librarian, and oracle; no developer or code-reviewer unless bug-hunter prompt is deliberately changed.

Avoid hard-coding a one-off Rush-only check if a shared per-primary validator can express all role boundaries. Error messages should name the active primary and list its allowed targets. Nested tasks, chain steps, and parallel steps must be checked against the active primary's policy.

## Acceptance Criteria

- Runtime blocks developer delegation from product and bug-hunter, including top-level agent, tasks[], chain[] steps, and chain[].parallel[] tasks.
- Runtime still allows architect to delegate to developer when the generic safety constraints are satisfied.
- Runtime still blocks Rush developer delegation and preserves existing fresh-context and user-scope protections.
- Generated TLH allowed-subagents prompt section reflects the active primary's allowed subagents instead of a global list.
- Tests cover product, bug-hunter, Rush, and architect behavior, including at least one nested delegation shape.
- `npm run validate` passes.

