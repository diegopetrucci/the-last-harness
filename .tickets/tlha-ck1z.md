---
id: tlha-ck1z
status: open
deps: [tlha-viuk]
links: []
created: 2026-05-20T14:45:19Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Simplify shouldAppendGnosisPrompt to binary-presence only

Drop the settings.tlh.gnosis.enabled and installPath dependency from the runtime gate. shouldAppendGnosisPrompt(cwd) returns true whenever findValidGnosisCommand() returns a binary; otherwise false. Files: extensions/the-last-harness/gnosis.ts. Remove configuredGnosisPath / getTlhGnosisConfig / findEnabledGnosisCommand helpers; candidates collapse to [<agent-dir>/bin/gn, 'gn'].

## Acceptance Criteria

1) shouldAppendGnosisPrompt does not import SettingsManager or read any settings. 2) findValidGnosisCommand probes only <agent-dir>/bin/gn and gn on PATH. 3) When the managed gn binary validates, the prompt is appended; when it is absent or fails validation, the prompt is omitted. 4) npm run lint passes; static tests reflect the smaller module surface.

