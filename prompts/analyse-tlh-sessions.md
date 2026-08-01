---
description: Analyse the past week of tlh sessions for notable issues without changing files
---
Use the session analysis CLI as the primary path — it resolves the active profile automatically and avoids hand-rolling session parsing.

**Collect data:**

```sh
# Per-session summary (tool-pair statistics, coverage)
node scripts/tlh-sessions.mjs --mode per-session | jq '.'

# Last 7 days only — startedAt is ISO 8601, so string comparison is correct
node scripts/tlh-sessions.mjs --mode per-session | jq --arg cutoff "$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)" '[.sessions[] | select(.startedAt >= $cutoff)]'

# Per-tool aggregation across all sessions (not time-filtered)
node scripts/tlh-sessions.mjs --mode per-tool | jq '.'

# Add file references when concrete evidence is needed
node scripts/tlh-sessions.mjs --mode per-session --include-paths | jq '.'
```

Output is JSON with `schemaVersion`, `provenance`, and `coverage` fields. Default output omits raw paths; pass `--include-paths` when you need them to cite evidence. Raw session files remain readable directly when the CLI's fixed modes are insufficient — the CLI is the fast path, not a hard restriction.

**Latency caution:** `observedLatencyMs` is wall-clock time between recorded events and includes queueing, subprocess startup, streaming, and supervisor pauses. A large value typically indicates a paused run, not a slow tool — do not treat it as execution time.

**Provide a read-only analysis that:**

- identifies notable issues, risks, failures, or recurring friction,
- cites concrete evidence such as session references, timestamps, and relevant excerpts or summaries,
- states clearly when nothing concerning stands out,
- highlights any follow-up areas worth reviewing manually.

Do not modify any files during this analysis.
