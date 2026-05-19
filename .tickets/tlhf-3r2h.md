---
id: tlhf-3r2h
status: closed
deps: [tlhf-2wzl]
links: []
created: 2026-05-19T14:55:49Z
type: chore
priority: 2
assignee: Diego Petrucci
---
# Document and run ESLint in repo validation

Wire the new development-only lint check into repository validation surfaces. Add npm run lint to CI and update development/contributing validation docs. Do not add ESLint to installer smoke scripts or end-user tlh install paths.

## Acceptance Criteria

.github/workflows/ci.yml runs npm run lint as part of repository validation. CONTRIBUTING.md and docs/local-development.md list npm run lint with the other validation commands. No installer runtime behavior changes.

