---
id: tlht-5thm
status: closed
deps: []
links: []
created: 2026-05-19T11:28:14Z
type: task
priority: 2
assignee: Diego Petrucci
tags: [release, changelog]
---
# Prepare v0.8.0 release metadata

Prepare release metadata for v0.8.0 from current main: bump package.json version to 0.8.0 and move CHANGELOG.md Unreleased content into a dated 0.8.0 section, including the latest-release installer/no-arg Bash fix and other unreleased changes since v0.7.0.

## Acceptance Criteria

package.json version is 0.8.0; CHANGELOG.md has ## [0.8.0] - 2026-05-19 with accurate Added/Changed/Fixed notes; Unreleased remains present for future changes; node scripts/release-notes.mjs --tag v0.8.0 succeeds.

