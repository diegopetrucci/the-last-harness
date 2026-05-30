---
id: tlh-6cko
status: open
deps: []
links: []
created: 2026-05-30T08:27:13Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Harden GitHub PR automation against field drift and rate limits

TLH sessions repeatedly hit GitHub GraphQL rate limits and unsupported gh --json fields while checking PR comments/status. Add a small documented helper or playbook that uses known-good fields and REST/GraphQL fallbacks so future review automation fails less often.

## Acceptance Criteria

There is a documented or scripted path for fetching/updating PR review comments and checks that avoids known unsupported gh fields, handles GraphQL rate-limit failures with an actionable fallback, and is referenced from repo workflow docs or agent guidance where PR automation is used.

