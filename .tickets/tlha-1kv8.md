---
id: tlha-1kv8
status: closed
deps: []
links: []
created: 2026-05-20T14:44:40Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Remove Gnosis opt-out flags; add TLH_SKIP_GNOSIS_INSTALL env escape

Strip --with-gnosis, --without-gnosis, --no-gnosis from the installer entrypoints and update flow. Replace them with an internal env escape used only by tests and benchmarks. Affects: install.sh, scripts/tlh-install.mjs, scripts/tlh-update.mjs, scripts/tlh-gnosis.mjs (honor env in configure-install).

## Acceptance Criteria

1) install.sh, scripts/tlh-install.mjs, scripts/tlh-update.mjs no longer parse or document --with-gnosis/--without-gnosis/--no-gnosis. 2) Passing any of those flags yields an unknown-option error. 3) Help text in all three entrypoints no longer mentions Gnosis flags. 4) Setting TLH_SKIP_GNOSIS_INSTALL=1 in the installer environment skips the gnosis configure step cleanly with a log line; unset behavior is unchanged. 5) Running install.sh --dry-run on a supported platform still produces the same gnosis configure output (without flags).

