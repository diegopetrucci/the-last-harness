---
id: tlha-eedt
status: closed
deps: []
links: []
created: 2026-05-17T12:33:28Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Collapse upstream Pi changelog by default for tlh

Set the isolated TLH default settings to use upstream Pi's supported collapseChangelog behavior so automatic upstream release notes render as the condensed one-line changelog notice instead of the full notes. Keep the change limited to TLH-owned defaults and release notes; do not implement wrapper lastChangelogVersion pre-sync in this task.

## Acceptance Criteria

config/settings.defaults.json includes collapseChangelog true; CHANGELOG.md Unreleased documents that TLH now collapses upstream Pi changelog notices by default; existing isolated user values remain preserved by the conservative settings merge; targeted validation commands pass.

