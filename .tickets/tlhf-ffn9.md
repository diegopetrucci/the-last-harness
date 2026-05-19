---
id: tlhf-ffn9
status: open
deps: []
links: []
created: 2026-05-19T20:37:35Z
type: task
priority: 3
assignee: Diego Petrucci
parent: tlhf-hkxd
---
# Add high-risk design escalation guidance

Update TLH workflow guidance so filesystem/PATH/temp-file/security-sensitive changes get an explicit design checkpoint before implementation, preferably using oracle only when the user agrees.

## Acceptance Criteria

Guidance identifies high-risk triggers such as symlink/TOCTOU, PATH resolution, installer profile isolation, and temp file writes; it asks for a short design review before implementation; it preserves the rule that oracle is only used with user consent.

