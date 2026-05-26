---
id: tlhf-22d6
status: closed
deps: []
links: []
created: 2026-05-26T17:23:54Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Fix uninstall PR review comments

Address the two still-valid PR #57 review comments in uninstall.sh: uninstall Pi from the same TLH npm prefix used by install, and detect dangling wrapper symlinks as removable. Keep changes minimal.

## Acceptance Criteria

uninstall.sh plan/execution/manual warning use npm uninstall -g --prefix "/Users/diegopetrucci/.local" @earendil-works/pi-coding-agent or equivalent shared prefix; wrapper existence check treats dangling symlinks as existing; targeted smoke/validation passes

