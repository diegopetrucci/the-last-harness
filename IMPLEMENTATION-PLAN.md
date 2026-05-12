# `tlh update` Implementation Plan

## Goal

Make `tlh update` run the The Last Harness installer/update flow instead of falling through to upstream `pi update`, while preserving the user's intended update track:

- **latest release** installs move to the newest GitHub Release.
- **pinned tag** installs stay on the pinned release tag.
- **ref/main** installs keep tracking the configured git ref, such as `main`.
- **custom** installs fail safely with clear manual instructions unless enough metadata is available.

## Current Constraints

- The generated `tlh` wrapper currently intercepts only `defaults` and `gnosis`; `update` is passed to upstream `pi`.
- Upstream `pi update` does not rerun TLH's installer-owned maintenance steps: settings merge, support-file copy, wrapper regeneration, default-extension handling, or Gnosis settings preservation.
- The installed package source alone cannot distinguish "installed from latest release URL" from "pinned to this tag" because both resolve to a tag such as `v0.4.0`.
- Existing installs lack update-track metadata, so migrations must be conservative.

## Design

1. **Persist installer-owned update state**
   - Write `~/.the-last-harness/agent/tlh/install-state.json` on each installer run.
   - Record schema version, repo, track, ref, package source, wrapper name, bin dir, and install timestamp.
   - Write this metadata independently of `--no-settings` because it belongs to the installer/wrapper, not user settings.

2. **Add explicit track selection**
   - Add installer option `--track latest-release|pinned-tag|ref|custom`.
   - Default conservatively:
     - default package source + semver tag => `pinned-tag`
     - default package source + `main` or other ref => `ref`
     - custom package source => `custom`
   - Document that the recommended latest-release install sets `TLH_UPDATE_TRACK=latest-release` (backward-compatible with older installers) or passes `--track latest-release`.

3. **Add an update helper**
   - Add `scripts/tlh-update.mjs` and copy it into the isolated support directory.
   - The helper reads `install-state.json`, accepts override flags, resolves the proper installer URL, downloads it to a temp file, and executes it with preserved `--agent-dir`, `--bin-dir`, and `--wrapper-name`.
   - It supports `--dry-run`, `--quiet`, `--verbose`, `--force`, and Gnosis mode flags by passing them through to `install.sh`.

4. **Intercept `tlh update` in the wrapper**
   - Generated wrappers should route `tlh update ...` to the update helper.
   - Other commands continue to exec upstream `pi` with the isolated `PI_CODING_AGENT_DIR`.

5. **Migration behavior**
   - If install state is missing, infer from isolated `settings.json`:
     - `@main` => `ref/main`
     - semver tag => `pinned-tag`
     - other ref => `ref`
   - If inference fails or the install is custom, refuse to update automatically and print the manual installer command pattern.

## Validation

- `bash -n install.sh`
- `node --check scripts/merge-settings.mjs`
- `node --check scripts/tlh-defaults.mjs`
- `node --check scripts/tlh-gnosis.mjs`
- `node --check scripts/tlh-update.mjs`
- `node scripts/merge-settings.mjs --dry-run`
- `bash install.sh --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"`
- Targeted `scripts/tlh-update.mjs --dry-run` checks for latest-release, pinned-tag, ref/main, and missing metadata cases.
- `npm pack --dry-run`
