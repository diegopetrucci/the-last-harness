---
id: tlha-9vfw
status: open
deps: []
links: []
created: 2026-05-17T12:08:25Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Explore suppressing upstream Pi changelog in tlh wrapper

Investigate whether the generated tlh wrapper should pre-sync the isolated settings.json lastChangelogVersion to the installed upstream Pi version before launching interactive Pi, so tlh does not display upstream Pi release notes automatically while keeping /changelog available. Must only touch the isolated tlh profile and must not mutate normal ~/.pi/agent config.

## Design

Candidate approach: wrapper detects interactive launch, resolves installed pi version, updates only ${PI_CODING_AGENT_DIR}/settings.json if lastChangelogVersion differs or is missing, and preserves JSON/user settings. Consider that upstream Pi install/update telemetry is tied to Pi writing lastChangelogVersion.

## Acceptance Criteria

Document the safest implementation approach, validation plan, telemetry/user-setting tradeoffs, and rollback behavior; do not implement wrapper changes in this ticket.

