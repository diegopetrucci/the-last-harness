---
id: tlha-9ng1
status: open
deps: []
links: []
created: 2026-05-20T12:06:57Z
type: task
priority: 3
assignee: Diego Petrucci
---
# Test assertSafeTlhSettingsPath rejects symlink and hardlink settings

tests/the-last-harness-usage-limits.test.mjs covers the normal-Pi-path refusal but not the symlink/hardlink/non-file rejection paths in assertSafeTlhSettingsPath. Add at least one fixture that pre-creates a symlinked settings.json at the isolated TLH path and asserts /usage weekly on errors out without writing. Optionally add a hardlink (nlink > 1) fixture. Deferred from session-usage review.

## Acceptance Criteria

1) Test creates a symlink settings.json inside an isolated tmp TLH agent dir. 2) /usage weekly on rejects the write with the assertSafeTlhSettingsPath error. 3) Original file content is untouched. 4) Test passes.
