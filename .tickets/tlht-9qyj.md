---
id: tlht-9qyj
status: closed
deps: [tlht-jytt]
links: []
created: 2026-05-17T18:35:08Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Generalize TLH primary-agent selection

Extend extensions/the-last-harness.ts from hardcoded architect on/off to selectable TLH primaries: architect, product, or disabled. Load primary prompts deterministically from agents/primary. Default remains architect. Preserve compatibility: existing tlh.primaryAgent.enabled false and old session {enabled:false} mean disabled; unset/true means architect unless a valid selected primary is configured. Add conservative persistent selected-primary support under tlh.primaryAgent. Shift+Tab cycles architect -> product -> disabled -> architect. /agent should show/select/reset current-session and persistent defaults. /architect remains a compatibility command for architect on/off/default. Apply tools/model/thinking for the active primary. Subagent safety should apply to any enabled TLH primary and use generic primary-agent wording instead of architect-only wording.

## Design

Settings writes must still target only the isolated TLH settings file and create backups. Invalid configured primary names should warn once and fall back to architect rather than breaking startup. Continue applying model/thinking only when applyModel/applyThinking are true.

## Acceptance Criteria

No tlh.primaryAgent settings defaults to architect; /architect default off still disables the primary for future sessions; product can be selected for the session and as persistent default; disabled restores pre-primary tools; tests cover multi-primary selection, compatibility, and generic subagent-safety wording.


## Notes

**2026-05-17T19:07:47Z**

Final review required fix: add behavioral test coverage that disabled primary mode restores pre-primary active tools. Current static/helper tests do not verify applyPrimaryTools/restorePrimaryToolsIfAppropriate semantics. Prefer a focused helper extraction or small extension harness test; keep runtime behavior unchanged unless test reveals a bug.
