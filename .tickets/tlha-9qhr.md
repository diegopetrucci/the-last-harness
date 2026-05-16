---
id: tlha-9qhr
status: closed
deps: []
links: []
created: 2026-05-16T08:41:44Z
type: bug
priority: 1
assignee: Diego Petrucci
---
# Confine managed Gnosis install target

Managed Gnosis installation must write only inside the resolved The Last Harness agent profile. Harden tlh-gnosis install-managed/configure-install target validation against symlinked bin directories or target files.

## Acceptance Criteria

install-managed resolves agent dir and target safely; rejects targets whose resolved path is outside the resolved agent dir; rejects symlinked target parent components, symlinked target file, and non-file targets before network or writes including dry-run; manual external binaries remain configurable via enable --install-path; regression/smoke test covers agent/bin symlinked outside.


## Notes

**2026-05-16T10:21:56Z**

Final review found predictable managed Gnosis temp path can follow pre-existing symlink outside profile; fix before considering ticket complete.
