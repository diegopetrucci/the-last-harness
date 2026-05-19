---
id: tlht-bh98
status: closed
deps: []
links: []
created: 2026-05-19T12:44:14Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Add CONTRIBUTING.md

Create a concise contributor guide for The Last Harness. Cover project invariants, development setup, Node >=22.19.0, validation commands, installer safety rules, code style, docs/changelog expectations, PR checklist, CI behavior, and release-process pointer. Prefer links to existing docs instead of duplicating long instructions.

## Acceptance Criteria

CONTRIBUTING.md exists at repo root; it clearly states TLH isolation/safety invariants; it documents Node >=22.19.0 and the main validation commands; it says CI runs on pull_request and push to main but required-merge enforcement is controlled by repo rules/settings; it links to docs/local-development.md and docs/releasing.md; it keeps guidance concise and avoids changing source code.


## Notes

**2026-05-19T13:00:52Z**

Supervisor update before implementation: GitHub repository rulesets now protect the default branch/main and require the CI status check named 'Repository validation'. CONTRIBUTING should mention CI runs on pull_request and push to main, and that current repo rulesets require that validation before merge.
