---
id: tlha-aq3w
status: closed
deps: []
links: []
created: 2026-05-16T08:41:44Z
type: bug
priority: 0
assignee: Diego Petrucci
---
# Repair critical default package filters

Critical bundled defaults such as subagents and intercom must not be disabled by package resource filters. Update settings/default-extension handling so same-identity critical package entries are canonicalized to the bundled source and disabling extension filters cannot suppress critical install/refresh.

## Acceptance Criteria

merge-settings repairs critical same-identity package entries by using the bundled source and removing disabling extension filters; tlh-defaults critical-sources still emits critical sources when settings contain disabling filters; regression tests cover extensions: [], ['-*'], ['!*'], and allowlists that exclude the extension entrypoint; non-critical opt-outs and conservative merge behavior remain intact.

