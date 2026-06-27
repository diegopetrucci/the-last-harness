---
id: tlha-akfh
status: closed
deps: []
links: []
created: 2026-06-27T07:37:14Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [typescript, migration, extensions]
---
# Plan migration of remaining extension-side MJS helpers to TypeScript

Future work: migrate remaining extension-side .mjs helpers where compatible with TLH extension loading, especially extensions/the-last-harness/footer-git.mjs and extensions/the-last-harness/subscription-usage.mjs; assess primary-agent/tool/safety shims separately before converting.

## Acceptance Criteria

A safe migration path is documented or implemented for the listed extension helpers; extension import/loading behavior is preserved; typecheck/lint and relevant extension tests pass; browser web/app.js files are intentionally out of scope unless a browser build story is added.

