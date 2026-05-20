---
id: tlha-4nzm
status: closed
deps: [tlha-1kv8]
links: []
created: 2026-05-20T14:44:54Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Drop user-facing tlh gnosis subcommands and the wrapper branch; simplify configure-install

Remove the enable, disable, status, and toggle paths from scripts/tlh-gnosis.mjs; remove the gnosis branch from scripts/tlh-wrapper.mjs so 'tlh gnosis ...' passes through to pi. Strip the --mode and --install-path flags. Simplify configure-install: always attempt install, never read or write tlh.gnosis settings (no enabled/installPath writes). Update the script's help text. Rewrite tests/tlh-gnosis.test.mjs to cover only the remaining installer-internal surface (install-managed safety + new configure-install).

## Acceptance Criteria

1) scripts/tlh-wrapper.mjs no longer special-cases 'gnosis'; running 'tlh gnosis whatever' goes through to pi. 2) node scripts/tlh-gnosis.mjs --help lists only install-managed, configure-install, validate (and state if kept) and no longer mentions --mode/--install-path. 3) configure-install never writes tlh.gnosis.enabled or tlh.gnosis.installPath. 4) Existing install-managed symlink/TOCTOU safety tests still pass after adaptation. 5) Tests for removed enable/disable/status paths are deleted, not skipped.

