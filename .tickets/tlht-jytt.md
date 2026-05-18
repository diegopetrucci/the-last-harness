---
id: tlht-jytt
status: closed
deps: []
links: []
created: 2026-05-17T18:35:08Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Add converted product primary prompt

Add agents/primary/product.md as a TLH-format primary prompt. Convert the product-agent behavior from opencode-style frontmatter/body into the simple scalar frontmatter used by agents/primary/architect.md. Role: product director for strategy, decisions, product docs, and tk tickets handed to architect/developer later; never implement source changes. Writable outputs are limited to product strategy docs (docs/PRODUCT_STRATEGY.md and related docs), tk tickets after user signoff, AGENTS.md for critical invariants, Gnosis for durable rationale when available, and existing KNOWLEDGEBASE.md only if present. Orientation should read AGENTS.md, ARCHITECTURE.md only when present, docs/PRODUCT_STRATEGY.md when present, and use repo-scout for unfamiliar repos. Replace stale @explore references with direct read/grep/find/ls or scoped repo-scout/bug-hunter/librarian delegation. Use TLH terminology.

## Design

Use scalar frontmatter only: name product, model anthropic/claude-opus-4-6, thinking high, comma-separated tools, systemPromptMode append, inheritProjectContext true, inheritSkills false. Include write/edit because the product agent owns docs/tickets, but the body must restrict them to allowed docs/ticket outputs and forbid source implementation.

## Acceptance Criteria

Product prompt parses with the existing simple frontmatter parser; no opencode mode/temperature/tool-map fields remain; prompt mentions graceful ARCHITECTURE/Gnosis/KNOWLEDGEBASE fallback and no @explore; prompt does not grant implementation authority.
