---
id: tlha-73sw
status: closed
deps: []
links: []
created: 2026-05-17T20:07:37Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [installer, performance]
---
# Batch default extension installs

Change scripts/tlh-install.mjs so non-critical bundled default extensions are installed with one isolated 'pi update --extensions' call after settings merge, while critical git defaults keep their current per-source install/ref-validation path.

## Design

Use the already-merged settings as the source of truth for pi update --extensions. Split enabled sources into critical and non-critical sets using tlh-defaults sources/critical-sources. Preserve failure semantics: critical failures remain fatal; non-critical batch failure degrades to best-effort fallback.

## Acceptance Criteria

Critical default sources are still installed and validated individually. Non-critical enabled default sources are no longer looped through as individual pi update --extension calls on the success path. The batch command runs with PI_CODING_AGENT_DIR set to the isolated agent dir. If the batch command fails, the installer falls back to the previous best-effort per-source non-critical loop and warns per failed source. Dry-run output remains clear and representative.


## Notes

**2026-05-17T20:47:44Z**

Validation found smoke failure: dry-run prose line starts with 'Would ... pi update' and is detected as an unisolated Pi command. Fix wording while preserving isolated dry-run command output.
