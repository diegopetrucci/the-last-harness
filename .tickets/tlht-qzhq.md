---
id: tlht-qzhq
status: closed
deps: []
links: []
created: 2026-05-19T14:50:08Z
type: chore
priority: 1
assignee: Diego Petrucci
---
# Prepare v0.8.1 release metadata

Prepare the repository for the v0.8.1 release from current main without touching user home configuration. Update package/changelog release metadata, include notable changes since v0.8.0, and run the documented release checks.

## Acceptance Criteria

package.json version is 0.8.1; CHANGELOG.md has a dated 0.8.1 section and a fresh Unreleased heading; release notes for v0.8.1 generate successfully; documented release checks pass or any blocker is reported with exact command output; release prep commit 'Release v0.8.1' is created on main.

