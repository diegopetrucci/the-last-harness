---
id: tlha-sstb
status: open
deps: [tlha-1kv8, tlha-4nzm, tlha-ubji, tlha-viuk, tlha-ck1z, tlha-ilp6]
links: []
created: 2026-05-20T14:45:36Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Update docs and CHANGELOG to reflect mandatory Gnosis

Rewrite user-facing docs to describe Gnosis as required. Files: README.md (Project memory bullet, Gnosis integration section, slash-command list), docs/install.md (drop --with-gnosis/--without-gnosis/--no-gnosis and the curl opt-out example; note the platform requirement), docs/local-development.md (replace tlh gnosis enable|disable|status with node scripts/tlh-gnosis.mjs validate or drop the section), CONTRIBUTING.md (drop 'tlh gnosis' exception), AGENTS.md (drop 'tlh gnosis' from wrapper exceptions), agents/primary/product.md (remove 'when Gnosis is available' / 'gracefully fall back' language; describe Gnosis as required), CHANGELOG.md (add top entry describing the breaking removal of opt-outs and the new platform requirement).

## Acceptance Criteria

1) grep -i 'without-gnosis' returns no matches outside CHANGELOG.md historical entries. 2) README no longer lists /gnosis in the slash-command section and does not mention tlh gnosis status/enable/disable. 3) README clearly states Gnosis is required and lists supported platforms (linux/darwin x amd64/arm64). 4) docs/install.md no longer documents the three Gnosis flags. 5) CHANGELOG.md has a new entry summarizing the breaking change. 6) npm run lint, bash scripts/check-installer-smoke.sh, and npm pack --dry-run all pass.

