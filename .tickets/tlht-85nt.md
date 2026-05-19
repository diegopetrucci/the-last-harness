---
id: tlht-85nt
status: closed
deps: []
links: []
created: 2026-05-19T09:27:17Z
type: task
priority: 2
assignee: Diego Petrucci
parent: tlht-16fm
---
# Add TLH extension discovery layout regression test

Add a low-brittleness test for the refactored extension layout: only the top-level TLH extension entrypoint should be discoverable and the nested helper directory must not contain index.ts, index.js, or package.json.

## Acceptance Criteria

Test fails if extensions/the-last-harness/index.ts, index.js, or package.json appears, or if nested helper files would be considered top-level extension entrypoints by the documented current discovery rules.
