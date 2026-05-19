---
id: tlht-ayh8
status: closed
deps: []
links: []
created: 2026-05-19T10:45:59Z
type: bug
priority: 2
assignee: Diego Petrucci
tags: [installer, macos]
---
# Fix stage-0 no-arg install on macOS Bash

Stage-0 install.sh fails on macOS Bash 3.2 with set -u when invoked via stdin with no installer arguments because it expands an empty ORIGINAL_ARGS array. Make no-argument invocation safe while preserving argument forwarding when args are present.

## Acceptance Criteria

curl-piped/no-argument stage-0 path reaches stage-1 on Bash 3.2 without ORIGINAL_ARGS unbound-variable errors; invocations with args such as --dry-run and --agent-dir still forward exactly as before; existing installer safety checks remain intact.
