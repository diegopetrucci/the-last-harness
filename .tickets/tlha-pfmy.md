---
id: tlha-pfmy
status: open
deps: []
links: []
created: 2026-05-20T12:38:54Z
type: task
priority: 3
assignee: Diego Petrucci
---
# Prune lastAccessTokenAttempts map in subscription-usage service

extensions/the-last-harness/subscription-usage.mjs adds lastAccessTokenAttempts (SHA-256 of access token → last fetch timestamp) as a secondary throttle in tlha-0qw3. The map is intentionally not cleared by clearProvider() (so it survives credential rotation), and only fully reset by clear(). In practice it grows by one entry per OAuth refresh (~hourly), so the leak is ~24 entries/day at ~80B each — tiny but unbounded. Add a one-line eviction when inserting: drop entries older than 2 × minFetchIntervalMs, since they can no longer satisfy the throttle anyway.

## Acceptance Criteria

1) lastAccessTokenAttempts evicts entries older than 2 × minFetchIntervalMs on each insert (or via equivalent sweep). 2) Existing throttle/dedupe/rotation tests still pass. 3) Optional: a test seeding many fingerprints with old timestamps confirms eviction.
