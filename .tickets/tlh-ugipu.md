---
id: tlh-ugipu
status: closed
deps: [tlh-rmjqd, tlh-fphgq, tlh-vfkrm, tlh-lkfda]
links: []
created: 2026-05-20T13:00:10Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Run repo checks for bug-hunter promotion

Run the standard checks and fix any failures:

- npm run lint
- npm test
- bash scripts/check-installer-smoke.sh
- node scripts/merge-settings.mjs --dry-run
- npm pack --dry-run

If any check fails, report back with the failure rather than fixing on your own when the fix would touch areas outside the scope of the prior tickets.

ready for implementation

