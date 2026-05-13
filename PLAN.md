# Installer Decomposition Plan

`install.sh` has grown into a large pipe-to-bash installer. The safe direction is to keep it as a small bootstrap/orchestrator and move self-contained behavior into versioned helper scripts that the installer can fetch from the same release/ref.

## Current status

- Phase 1 is implemented: wrapper rendering lives in `scripts/tlh-wrapper.mjs`, and `install.sh` now calls that helper while retaining a stdin `--dry-run` fallback.
- Phase 2 is implemented in this branch: install-state metadata writing lives in `scripts/tlh-install-state.mjs`, and `install.sh` now calls that helper while retaining a stdin `--dry-run` fallback.
- Later phases remain planned and should be handled as separate, behavior-preserving changes.

## Constraints to preserve

- `tlh` must remain isolated from normal Pi configuration under `~/.pi/agent`.
- Every installer-owned Pi command must set `PI_CODING_AGENT_DIR` to the isolated agent dir.
- Pipe-to-bash installs must keep working:
  - GitHub Release asset installs
  - raw ref installs
  - stdin dry-runs
- Release installer assets must stay pinned to the release tag.
- `--dry-run` must remain non-mutating, including when the installer is run from stdin.
- Settings merges must stay conservative and preserve isolated user values and opt-outs.
- Wrapper writes must remain atomic and must not overwrite unmanaged files unless `--force` is provided.

## Phase 1: Extract wrapper generation

Move the generated `tlh` wrapper rendering and managed-wrapper overwrite checks out of `install.sh` and into `scripts/tlh-wrapper.mjs`.

Preserve:

- managed marker detection
- `--force` requirement before overwriting unmanaged wrappers
- atomic temp-file + rename writes
- `PI_CODING_AGENT_DIR` export in the generated wrapper
- `tlh update`, `tlh defaults`, and `tlh gnosis` helper dispatch
- prepending the isolated profile `bin` dir to `PATH` before executing upstream `pi`
- stdin `--dry-run` behavior without fetching support files

Installer changes:

- add the wrapper helper to support-file discovery/fetch/copy plumbing
- have `install.sh` call the helper for real wrapper writes
- keep a small Bash dry-run fallback for stdin runs where support files are intentionally not fetched
- add `node --check scripts/tlh-wrapper.mjs` to release checks and docs

## Phase 2: Extract install-state writer

Move the inline Node heredoc that writes `tlh/install-state.json` into a helper script, for example `scripts/tlh-install-state.mjs`.

Preserve:

- schema/version fields
- atomic write behavior
- exact metadata used by `tlh update`
- `--dry-run` no-write behavior

## Phase 3: Move managed Gnosis install/configure logic

Move the large managed Gnosis binary install and integration configure flow into `scripts/tlh-gnosis.mjs` behind installer-oriented commands.

Preserve:

- default enablement on supported platforms
- persistent opt-out semantics
- `--with-gnosis` override behavior
- dry-run avoiding downloads/version resolution
- checksum verification before installing downloaded binaries
- validation of the `gn` binary before storing/enabling it

## Phase 4: Reassess the remaining Bash orchestrator

After the low-risk extractions, reassess whether the remaining installer should stay Bash or become a thin Bash bootstrap that downloads/runs a Node installer entrypoint.

Only consider that after pipe-to-bash, release asset pinning, and isolated `PI_CODING_AGENT_DIR` behavior are covered by tests or reliable smoke checks.

## Validation checklist

Run before considering installer refactors ready:

```sh
bash -n install.sh
node --check scripts/merge-settings.mjs
node --check scripts/tlh-defaults.mjs
node --check scripts/tlh-gnosis.mjs
node --check scripts/tlh-update.mjs
node --check scripts/tlh-wrapper.mjs
node --check scripts/tlh-install-state.mjs
npm pack --dry-run
```

Installer smoke checks should use temporary paths:

```sh
agent_dir="$(mktemp -d)/agent"
bin_dir="$(mktemp -d)"
bash install.sh --dry-run --agent-dir "$agent_dir" --bin-dir "$bin_dir"
test ! -e "$agent_dir/settings.json"
test ! -e "$bin_dir/tlh"

agent_dir="$(mktemp -d)/agent"
bin_dir="$(mktemp -d)"
bash -s -- --dry-run --agent-dir "$agent_dir" --bin-dir "$bin_dir" < install.sh
test ! -e "$agent_dir/settings.json"
test ! -e "$bin_dir/tlh"
```
