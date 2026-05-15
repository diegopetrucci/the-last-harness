---
id: tlha-race
status: closed
deps: []
links: []
created: 2026-05-15T19:10:35Z
type: task
priority: 3
assignee: Diego Petrucci
---
# Fix low-risk review nits

Address remaining nits from review: config/default-extensions.json indentation and duplicated install.sh git-source parsing if the refactor is small and safe.

## Design

Fix the JSON indentation directly. For install.sh, reduce duplicate parser code only if it can be done with a small behavior-preserving helper; otherwise leave it unchanged and report the deferral rationale.

## Acceptance Criteria

dirty-repo-guard indentation is fixed. Installer validation still passes. If git-source parser duplication is refactored, both package_source_install_dir and critical_git_source_spec behavior remain covered by existing smoke/dry-run checks; if deferred, no risky partial refactor is left behind.

