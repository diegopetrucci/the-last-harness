---
id: tlha-ilp6
status: open
deps: [tlha-ck1z]
links: []
created: 2026-05-20T14:45:26Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Scrub tlh.gnosis from existing user settings on next merge

Update scripts/merge-settings.mjs so that any tlh.gnosis subtree present in existing isolated settings is removed during the next merge (one-time cleanup). Preserve backups. Add a unit test in tests/merge-settings.test.mjs covering both presence and absence of the subtree.

## Acceptance Criteria

1) Given input settings with tlh.gnosis.{enabled,installPath}, the merge writes settings without that subtree; if tlh becomes empty, the empty tlh object is left alone (or also removed if that's consistent with other tlh.* handling — match existing convention). 2) Settings without tlh.gnosis are unchanged. 3) A new test case in tests/merge-settings.test.mjs verifies the scrub. 4) node --test tests/merge-settings.test.mjs passes; node scripts/merge-settings.mjs --dry-run on a fixture file shows the scrub.

