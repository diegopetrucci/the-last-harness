---
id: tlha-d265
status: open
deps: [tlha-1kv8]
links: []
created: 2026-05-20T14:44:46Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Switch smoke checks, benchmark, and tests to TLH_SKIP_GNOSIS_INSTALL=1

Update every test/smoke/bench call site that currently passes --without-gnosis to instead set TLH_SKIP_GNOSIS_INSTALL=1 in the environment. Affects: scripts/check-installer-smoke.sh, scripts/benchmark-context-cap-embedding.mjs, tests/context-cap-benchmark.test.mjs.

## Acceptance Criteria

1) bash scripts/check-installer-smoke.sh passes end-to-end. 2) node --test tests/context-cap-benchmark.test.mjs passes; its assertion now checks for the env var rather than the flag. 3) grep --without-gnosis returns no matches outside CHANGELOG.md. 4) The skip env is used in both --dry-run and live-install smoke paths.

