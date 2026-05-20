---
id: tlh-rmjqd
status: closed
deps: [tlh-qiovm]
links: []
created: 2026-05-20T12:59:47Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Wire bug-hunter into the primary-agent set and cycle

Add bug-hunter as a selectable primary agent.

- extensions/the-last-harness-primary-agent.mjs: add 'bug-hunter' to SELECTABLE_PRIMARY_AGENTS and to PRIMARY_AGENT_CYCLE so the cycle is architect -> product -> bug-hunter -> disabled.
- extensions/the-last-harness/types.ts: extend TlhPrimaryAgentSelection union with 'bug-hunter'.
- Verify extensions/the-last-harness/prompts.ts loadPrimaryAgents() and extensions/the-last-harness/primary-agent-runtime.ts pick up bug-hunter without further edits. If selection labels, default-label maps, or /agent parsing have a hardcoded list that excludes bug-hunter, extend them.
- Check the /agent command parser surfaces bug-hunter in 'status' output and accepts 'bug-hunter' and 'default bug-hunter' / 'default reset' equivalents.

Do NOT touch /architect compat command — it stays architect/disabled only.

ready for implementation

## Design

The primary set is a closed enum today. Treat 'bug-hunter' as a peer of 'architect' and 'product' everywhere they appear. Keep DEFAULT_PRIMARY_AGENT as 'architect'.

