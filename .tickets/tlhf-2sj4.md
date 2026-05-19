---
id: tlhf-2sj4
status: open
deps: []
links: []
created: 2026-05-19T12:35:33Z
type: feature
priority: 2
assignee: Diego Petrucci
tags: [footer, git]
---
# Cache git status and PR metadata for the TLH footer

Add a small async cache/source for footer git metadata. It should refresh outside render(), use short timeout-bound git/gh commands, skip PR lookup when offline, fail silently when git/gh/PR data is unavailable, and expose disposal for timers/watchers.

## Design

Use git --no-optional-locks status --porcelain=v2 --branch for local status. Use gh pr view --json number,state,isDraft,url,title as best-effort PR detection only after a branch is known. Do not run subprocesses from footer render().

## Acceptance Criteria

Cached status refreshes on startup, on branch changes, and periodically or after stale intervals without blocking rendering. Git failures degrade to the existing cwd/session footer. PR lookup is optional and silent on no gh/auth/no PR/offline. Resources are disposed when the footer component is disposed.
