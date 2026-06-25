---
id: tlh-wxuk
status: open
deps: []
links: []
created: 2026-06-22T06:38:18Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Fix noUncheckedIndexedAccess indexed-access debt

Follow-up from tlh-ntag investigation. Enable noUncheckedIndexedAccess only after targeted fixes for current indexed-access errors. Current probe: npm run typecheck -- --noUncheckedIndexedAccess true reports 42 errors across 8 files, with attribution.ts as the hotspot. Keep this separate from the strict: true ratchet.

## Acceptance Criteria

noUncheckedIndexedAccess is evaluated independently from strict mode; indexed-access errors are fixed without broad non-null assertion sweeps; npm run typecheck -- --noUncheckedIndexedAccess true passes; npm run validate passes before enabling the flag in tsconfig.

