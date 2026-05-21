---
id: tlht-lsaq
status: closed
deps: []
links: []
created: 2026-05-21T19:57:18Z
type: task
priority: 1
assignee: Diego Petrucci
parent: tlht-41ov
tags: [simplification, installer]
---
# Simplify installer bootstrap transport

Replace or substantially reduce the support-file manifest/raw-file bootstrap machinery. Prefer release tarball download/extract before running the stage-1 Node installer, or document why the current manifest approach must remain and reduce drift another way.

## Design

Preserve pipe-to-bash install, Node version preflight, dry-run behavior, pinned release assets, and isolated PI_CODING_AGENT_DIR execution.

## Acceptance Criteria

Stage-0 no longer maintains a hand-copied multi-file support manifest, or the remaining manifest is generated from one source; installer smoke tests prove self-contained release installs, stdin dry-runs, and no normal Pi mutation.

