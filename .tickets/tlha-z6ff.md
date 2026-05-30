---
id: tlha-z6ff
status: open
deps: []
links: []
created: 2026-05-30T16:05:25Z
type: bug
priority: 2
assignee: Diego Petrucci
tags: [update, evals, installer]
---
# Separate repo-only file package-source eval path from user update flow

Review of the /review branch found the repo-only live eval path invokes `tlh update --track custom --package-source file:$PWD`, while `tlh update` is a user-facing command whose help exposes custom tracks/package sources. If `file:` package sources are intended only for repository evals/internal installer reruns, the public update surface and docs should make that boundary explicit and prevent users from relying on unsupported custom/file update behavior.

## Design

Prefer keeping arbitrary `file:`/custom package-source update behavior out of the public `tlh update` contract unless explicitly designed. Repo-only evals can rerun the local installer directly or use a private/internal flag/path; public help/docs should not advertise unsupported `custom` update flows. If custom update support is intentionally kept, define safety/path/trust semantics before enabling it.

## Acceptance Criteria

Repo-only live evals no longer require public `tlh update --track custom --package-source file:...` support; user-facing `tlh update` help/docs do not advertise unsupported custom/file update behavior, or custom update support is deliberately implemented with documented safety semantics; tests cover the chosen boundary so `file:` eval-only behavior is not accidentally exposed as a supported user workflow.

