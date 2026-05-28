---
id: tlhf-drxp
status: open
deps: []
links: []
created: 2026-05-28T05:45:05Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [rtk, tools, correctness]
---
# Guard pi-rtk complex find rewrites

Prevent TLH pi-rtk from rewriting complex native `find` expressions into unsupported `rtk find` commands. Investigation tlhf-45se reproduced real failures where grouped predicates, negation, actions, and control flags were rewritten and then failed or silently drifted (for example `-quit` ignored). Simple `find` rewrites can still be valuable; complex native forms should pass through unchanged. This is primarily a correctness fix that also prevents retries and extra transcript churn.

## Design

The change likely belongs in the TLH pi-rtk fork first, then TLH should update its bundled default extension source/tag if needed. Do not rely on `rtk rewrite` exit code alone; supported rewrites returned mixed exit codes in investigation. Prefer a conservative guard that special-cases original commands beginning with native `find` and skips rewrite when known-unsafe tokens/patterns appear: grouping, `-o`, `-or`, `-not`, `!`, `-exec`, `-print0`, `-prune`, `-quit`, and similar behavior-changing actions/control flags. Preserve `/usr/bin/find ...` and `RTK_DISABLED=1 find ...` bypasses.

## Acceptance Criteria

- Simple supported native `find` forms still rewrite through RTK and run successfully.
- Complex native `find` forms with grouped predicates, boolean operators, negation, actions, print0/prune/quit/control flags are left as native `find`.
- `/usr/bin/find ...` and `RTK_DISABLED=1 find ...` remain passthrough/bypass-safe.
- Tests or a documented rewrite matrix cover at least one positive rewrite and several complex passthrough cases.
- If the pi-rtk fork tag changes, TLH default-extension configuration and release notes/docs are updated accordingly.

