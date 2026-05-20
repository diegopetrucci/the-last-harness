---
id: tlha-viuk
status: open
deps: [tlha-4nzm]
links: []
created: 2026-05-20T14:45:12Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Drop /gnosis slash command, autocomplete special-case, and Gnosis types

Remove the runtime opt-out surface in the extension. Files: extensions/the-last-harness.ts (drop registerGnosisCommand wiring + import), extensions/the-last-harness/gnosis.ts (remove registerGnosisCommand, formatGnosisToggleDescription, parseGnosisSlashAction, formatGnosisStatus, notifyGnosisWriteResult, writeTlhSettings, gnosisState, currentGnosisState, readTlhSettingsForWrite, ensureMutableGnosisSettings, validateTlhSettings; keep shouldAppendGnosisPrompt and its binary-validation helpers), extensions/the-last-harness/autocomplete.ts (drop gnosis special-case + import), extensions/the-last-harness/types.ts (remove TlhGnosisConfig, TlhGnosisState, TlhGnosisSlashAction, and the gnosis slot under TlhSettings.tlh), tests/the-last-harness-extension-static.test.mjs (update import assertions), tests/tlh-subagent-safety.test.mjs (drop the gnosis registerCommand stub).

## Acceptance Criteria

1) /gnosis is no longer registered with pi.registerCommand. 2) Autocomplete no longer special-cases the gnosis item. 3) TlhGnosisConfig, TlhGnosisState, and TlhGnosisSlashAction are gone from types.ts; TlhSettings.tlh no longer carries a gnosis field. 4) npm run lint passes. 5) node --test tests/the-last-harness-extension-static.test.mjs and tests/tlh-subagent-safety.test.mjs pass against the new layout.

