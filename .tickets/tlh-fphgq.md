---
id: tlh-fphgq
status: closed
deps: [tlh-yinmw]
links: []
created: 2026-05-20T12:59:55Z
type: task
priority: 2
assignee: Stavros Korokithakis
---
# Remove bug-hunter/bug-catcher from subagent install and allowlists

Remove the two old subagents from every subagent registry:

- install.sh: remove bug-hunter.md and bug-catcher.md from TLH_SUBAGENT_PROMPTS.
- scripts/lib/tlh-install-subagents.mjs: remove both filenames from the prompt list.
- extensions/the-last-harness-subagent-safety.mjs: remove 'bug-hunter' and 'bug-catcher' from ALLOWED_SUBAGENTS.
- tests/tlh-subagent-safety.test.mjs: drop the bug-hunter/bug-catcher cases (the two name entries in the allowed list test, the bug-hunter and bug-catcher subagent-call examples, and the agentScope/context assertions referencing them). Replace them with equivalent assertions against a remaining allowed agent only if removal would leave a test without coverage; otherwise just delete.

ready for implementation

