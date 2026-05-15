# Installer Decomposition Plan

`install.sh` has grown into a large pipe-to-bash installer. The safe direction is to keep it as a small bootstrap/orchestrator and move self-contained behavior into versioned helper scripts that the installer can fetch from the same release/ref.

## Current status

- Phase 1 is implemented: wrapper rendering lives in `scripts/tlh-wrapper.mjs`, and `install.sh` now calls that helper while retaining a stdin `--dry-run` fallback.
- Phase 2 is implemented: install-state metadata writing lives in `scripts/tlh-install-state.mjs`, and `install.sh` now calls that helper while retaining a stdin `--dry-run` fallback.
- Phase 3a is implemented: managed Gnosis binary installation lives behind `tlh gnosis install-managed`.
- Phase 3b is implemented in this branch: installer-time Gnosis configuration lives behind `tlh gnosis configure-install`, and `install.sh` now delegates the Gnosis policy state machine to that helper.
- Phase 4 is implemented in this branch: support-file discovery, fetch, dry-run, and copy behavior now shares a centralized manifest in `install.sh`.
- Phase 5 is implemented in this branch: reliable installer smoke checks now cover pipe-to-bash dry-runs, release asset ref pinning, isolated `PI_CODING_AGENT_DIR` output, and the normal Pi config guard.
- Decision: keep `install.sh` as the Bash orchestrator for now; defer any Node bootstrap rewrite until the smoke coverage is expanded to cover real non-dry-run installs in a safe sandbox or CI fixture.

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

Move the large managed Gnosis binary install and integration configure flow into `scripts/tlh-gnosis.mjs` behind installer-oriented commands. This is intentionally split into two slices: first the mechanical binary installer, then the policy-heavy configure state machine.

Preserve:

- default enablement on supported platforms
- persistent opt-out semantics
- `--with-gnosis` override behavior
- dry-run avoiding downloads/version resolution
- checksum verification before installing downloaded binaries
- validation of the `gn` binary before storing/enabling it

## Phase 4: Consolidate support-file plumbing

Before considering a larger bootstrap rewrite, consolidate the repeated support-file discovery, fetch, dry-run, and copy plumbing. That code is now the main repetitive area in `install.sh` after the helper extractions.

Target a behavior-preserving cleanup that centralizes the support-file manifest:

- required files: `merge-settings.mjs`, `tlh-defaults.mjs`, `settings.defaults.json`, and `default-extensions.json`
- optional files: `tlh-gnosis.mjs`, `tlh-update.mjs`, `tlh-wrapper.mjs`, and `tlh-install-state.mjs`
- install destinations under `${AGENT_DIR}/tlh`
- stdin `--dry-run` messages for files that would be fetched, without downloading them

## Phase 5: Reassess the remaining Bash orchestrator

Implemented as a safety gate rather than a rewrite. The installer remains a Bash orchestrator because the most important remaining behaviors are shell-entrypoint behaviors: pipe-to-bash installs, stdin `--dry-run` without downloads, release asset ref pinning, and isolated environment propagation for upstream Pi commands.

Added `scripts/check-installer-smoke.sh` to cover:

- local dry-runs with temporary `--agent-dir` and `--bin-dir`
- stdin dry-runs with a failing fake `curl` to ensure no support files are downloaded
- refusal to use normal Pi config under `~/.pi/agent`
- release installer asset ref pinning from `main` to a tag
- static Bash/Node helper checks

Future Node bootstrap work should only proceed after these smoke checks are preserved and additional non-dry-run coverage exists for safe sandbox installs.

## Branch review follow-up

- Addressed in this branch: non-dry-run installs now preflight required runtime helpers before installing Pi, installing the package, or writing isolated profile files. A remote ref that lacks `tlh-install-state.mjs` or, unless `--no-wrapper` is used, `tlh-wrapper.mjs` fails early instead of partially mutating the isolated profile.

## Validation checklist

Run before considering installer refactors ready:

```sh
bash scripts/check-installer-smoke.sh
node scripts/merge-settings.mjs --dry-run
npm pack --dry-run
```

The smoke script uses temporary paths and includes local dry-run, stdin dry-run, normal Pi config guard, release ref pinning, and static helper checks.
