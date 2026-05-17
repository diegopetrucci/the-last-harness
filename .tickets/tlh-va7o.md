---
id: tlh-va7o
status: closed
deps: []
links: []
created: 2026-05-16T13:54:01Z
type: epic
priority: 2
assignee: Diego Petrucci
---
# Decompose installer into stage-0 Bash and stage-1 Node

Move normal The Last Harness install logic out of install.sh while preserving one-line installer behavior, isolated profile safety, dry-run behavior, and release/update compatibility.

## Design

install.sh should remain a small bootstrapper: parse flags/env, guard obvious unsafe paths, discover/fetch support files, preserve stdin --dry-run with no downloads, preflight required helpers, then invoke scripts/tlh-install.mjs. Stage-1 Node owns normal install orchestration and can share tested modules with helper CLIs.

## Acceptance Criteria

install.sh is substantially smaller and no longer owns package-source parsing, git checkout mutation, profile file copy, subagent prompt copy, or default-extension install policy; existing documented installer flows still pass.

