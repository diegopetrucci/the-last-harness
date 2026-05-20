---
id: tlhn-qc9n
status: closed
deps: []
links: []
created: 2026-05-20T13:31:05Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Wrapper conditionally prepends managed_bin based on tickets.enabled

Modify scripts/tlh-wrapper.mjs so the generated bash wrapper reads tlh.tickets.enabled from ${default_agent_dir}/settings.json via the already-resolved tlh_node_cmd (a small node -e snippet). The final 'export PATH' before 'exec pi' includes ${default_agent_dir}/bin only when enabled. Default to enabled if settings.json is missing or the field is absent (preserve fresh-install behavior). The 'tlh tickets' subcommand keeps managed_bin on PATH unconditionally so the installer/validator can find its own binary. Other helper subcommands (update, defaults, gnosis) are unchanged - they already use the sanitized path.

## Acceptance Criteria

When settings.tlh.tickets.enabled === false, the final exported PATH before exec pi does NOT contain ${default_agent_dir}/bin. When enabled (default) or settings.json missing or field absent, behavior matches current branch. 'tlh tickets' subcommand still has managed_bin on PATH regardless of setting. No new external dependency (no jq); use tlh_resolve_node + node -e. New tests in tests/install-stage1.test.mjs cover: enabled=true PATH includes managed_bin, enabled=false PATH excludes it, missing settings.json defaults to enabled. bash scripts/check-installer-smoke.sh and existing test suite pass.

