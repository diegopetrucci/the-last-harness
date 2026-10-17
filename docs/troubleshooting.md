# Troubleshooting

This page covers common TLH recovery paths without touching normal `~/.pi/agent`.

## Quick triage

1. Confirm you are launching TLH, not a different command: `command -v tlh` and `type -a tlh pi`.
2. If `tlh` starts at all, run `tlh doctor` and note any `FAIL` or `WARN` lines.
3. For subagent problems, also run `/subagents-doctor` inside TLH.
4. Prefer `tlh update` for installer-owned drift; use `tlh doctor --repair` only for the narrower doctor repair path.
5. If the wrapper itself will not start, rerun the official installer from [`docs/install.md`](install.md).

`tlh doctor` only runs after the managed wrapper starts, so it cannot diagnose shell resolution problems before `tlh` launches.

## Wrong or stale shell command resolution

### Symptom

- `tlh` runs an old install, the wrong wrapper name, or no TLH wrapper at all.
- Running `pi` behaves differently from `tlh`.
- A shell says `command not found: tlh` even though TLH is installed.

### Diagnosis

Run:

```sh
command -v tlh
type -a tlh pi
```

For ordinary interactive TLH launches, current managed wrappers export `PI_CODING_AGENT_DIR` for the isolated TLH profile, validate the private runtime, and then exec the pinned absolute runtime path. A `pi` earlier on `PATH` cannot shadow that ordinary managed launch. Installer-owned helper subcommands such as `tlh update`, `tlh defaults`, `tlh tickets`, `tlh doctor`, and `tlh version` dispatch through their helper scripts first, so their pre-runtime behavior is different. A direct `pi` launch still does not use the managed TLH wrapper path automatically.

Common causes:

- your shell cached an old command location,
- `PATH` resolves a different wrapper first,
- you installed on `main` and should be using `tlh-main`, or
- you launched `pi` directly instead of the managed TLH wrapper.

### Fix

- Run the wrapper command that matches your install (`tlh`, `tlh-main`, or your custom `--wrapper-name`).
- If needed, run the wrapper by absolute path, for example `~/.local/bin/tlh`.
- Refresh shell command lookup with `hash -r` or by opening a new shell.
- If you intentionally installed without a wrapper (`--no-wrapper`), launch the default profile and pinned runtime directly:

  ```sh
  PI_CODING_AGENT_DIR="$HOME/.the-last-harness/agent" "$HOME/.the-last-harness/runtime/bin/pi"
  ```

  For a custom `--agent-dir`, set `PI_CODING_AGENT_DIR` to that exact directory and run `runtime/bin/pi` from its parent profile directory. For example, an agent dir of `/path/to/profile/agent` uses `/path/to/profile/runtime/bin/pi`.

### Undo / avoid

- Keep the chosen wrapper directory ahead of conflicting entries on `PATH`.
- Avoid treating direct `pi` as equivalent to `tlh`.
- If you need multiple installs, give them distinct wrapper names instead of reusing one command.

## Private runtime drift or missing runtime

### Symptom

- `tlh` prints `error: private pi runtime not found at ...; run \`tlh update\`.`
- `tlh doctor` reports `FAIL private runtime marker/version hints`.
- `tlh doctor` reports a version mismatch warning for `private runtime marker/version hints`.

### Diagnosis

Run:

```sh
tlh doctor
```

Relevant doctor signal:

- `private runtime marker/version hints`

That check validates the private runtime under `~/.the-last-harness/runtime` (or the sibling runtime for a custom agent dir), inspects the ownership marker, and compares the runtime version with TLH's pinned expectation.

### Fix

Start with:

```sh
tlh update
```

If the normal update helper is missing or the package checkout is too damaged to recover in place, rerun the installer from [`docs/install.md`](install.md).

### Undo / avoid

- Do not delete or replace files inside TLH's private runtime manually.
- If you need to remove TLH completely, use the uninstall flow from [`docs/install.md`](install.md) instead of deleting partial runtime contents.

## Unmanaged wrapper overwrite refusal

**Symptom:** install or update fails with `... already exists and is not managed by this installer; use --force or --bin-dir` (dry runs warn `would not overwrite unmanaged existing wrapper`).

**Fix:** keep your file and use a different `--bin-dir` or `--wrapper-name`. `--force` replaces the wrapper but also overwrites scalar isolated defaults, so back the file up first. Details: [Installer options](install.md#installer-options).

## Subagent SIGTERM or exit 143

### Symptom

A child session or bundled subagent fails with `exit 143` or `terminated by SIGTERM`.

### Diagnosis

Exit status `143` is conventionally reported for termination associated with `SIGTERM` (`128 + 15`). The number alone is not proof that this particular child received a signal, and it does **not** identify a sender or cause.

Check the asynchronous run before retrying:

```text
subagent({ action: "status", id: "..." })
```

Inspect any artifact and runner log paths returned for that run, including partial output written before termination. Review the surrounding cancellation and timeout context: a user cancellation, parent/session shutdown, timeout, or external process supervisor can all coincide with a 143-style result, but the status alone cannot distinguish them.

Use `/subagents-doctor` inside TLH for subagent setup diagnostics. If packaged prompt setup may be stale, the relevant `tlh doctor` signal is `bundled subagent resources`.

### Fix

- If `tlh doctor` reports `bundled subagent resources` drift, run `tlh doctor --repair` or `tlh update`.
- Run `/subagents-doctor`, inspect the async status/artifact/log evidence, and address any reported setup problem before retrying.
- If no setup problem is reported, retry only after checking whether cancellation, timeout, parent shutdown, or an external supervisor explains the timing.

### Undo / avoid

- Do not treat `143` alone as proof of `SIGTERM` delivery or infer a specific sender.
- Preserve async run evidence before retrying or changing settings.

## Install edge cases

### `--no-wrapper` means there is no `tlh` command

#### Symptom

Install succeeded, but `tlh` is not found.

#### Diagnosis

The install was done with `--no-wrapper`, so TLH intentionally did not create the managed wrapper command.

#### Fix

Either rerun the installer without `--no-wrapper`, or launch the default profile and pinned runtime directly:

```sh
PI_CODING_AGENT_DIR="$HOME/.the-last-harness/agent" "$HOME/.the-last-harness/runtime/bin/pi"
```

For a custom `--agent-dir`, use that exact value for `PI_CODING_AGENT_DIR` and the sibling `runtime/bin/pi` under its parent profile directory. A main-track install uses `~/.the-last-harness-main/agent` and `~/.the-last-harness-main/runtime/bin/pi` by default.

#### Undo / avoid

Use `--no-wrapper` only when you really want manual launches, and keep the profile and runtime paths paired.

### Node.js is missing or too old

**Symptom:** install stops because Node.js is unavailable or too old.

**Fix:** check `command -v node` and `node --version`, install a version that satisfies `engines.node` in `package.json`, make sure it resolves on `PATH`, and rerun the installer.

### Non-empty unmarked private runtime prefix

#### Symptom

Install refuses to provision the private runtime because its target prefix is non-empty and TLH finds neither a valid `.tlh-runtime-owned` marker nor recorded install-state provenance showing `piInstalledByTlh=true`.

#### Diagnosis

The installer cannot safely assume an existing non-empty sibling `runtime/` directory belongs to TLH unless ownership is proven. The normal proof is a valid `.tlh-runtime-owned` marker. As a one-time migration gate, TLH also accepts recorded install-state provenance with `piInstalledByTlh=true`; when that path is used, the installer writes a replacement marker with `origin=migrated`. This is especially relevant with a custom `--agent-dir` whose parent profile directory may already contain another runtime.

#### Fix

Preserve and inspect the existing directory first. If this is an older TLH install and the recorded install state still shows `piInstalledByTlh=true`, rerun the installer/update path once and let TLH migrate that runtime to a fresh `origin=migrated` marker. Otherwise, prefer choosing a different `--agent-dir` (and therefore a different sibling runtime), or move the existing directory aside after making a backup if you own it and know it is safe to relocate. Remove it only after independently confirming its contents are disposable; then rerun the installer.

#### Undo / avoid

Restore the moved directory if you selected the wrong prefix. Keep unrelated runtimes outside the parent directory of a TLH agent dir, and do not fabricate an ownership marker.

### Main-track installs use different defaults

**Symptom:** you installed from `main`, but `tlh` does not start it.

**Fix:** run `tlh-main`. Main installs use separate wrapper and profile defaults; see [More ways to install](install.md#more-ways-to-install).

## Update edge cases

### Extension-only update does not repair the installation

#### Symptom

`tlh update --extensions` succeeds, but a missing private runtime, stale wrapper, or broken install-state metadata remains broken.

#### Diagnosis

`tlh update --extensions` only refreshes isolated extensions/packages through the upstream package update path. It does not repair the private runtime, wrapper files, installer checkout, or update-track/install-state metadata.

#### Fix

Run plain `tlh update` for installer-owned repair. If the wrapper/update support cannot run, rerun the matching installer from [`docs/install.md`](install.md).

#### Undo / avoid

Use `tlh update --extensions` only for extension/package refreshes; do not use it as a substitute for plain `tlh update`.

### Missing or incompatible update metadata

#### Symptom

`tlh update` fails with messages such as:

- `Could not determine update track...`
- `Update track '...' requires a ref...`
- `This install is marked as a custom update track...`

#### Diagnosis

TLH could not safely reconstruct how this install should be updated from its stored metadata.

#### Fix

- For ordinary installs, rerun the installer from [`docs/install.md`](install.md).
- For custom/ref installs, rerun with the explicit `--track`, `--ref`, and, when applicable, `--package-source` values that match the install you want to keep.

#### Undo / avoid

Avoid changing update-track details piecemeal without carrying over the matching package source for custom installs.

### Custom package source drift

#### Symptom

`tlh update` fails with:

```text
This install uses a custom package source. Pass --package-source with any --track, --repo, or --ref override so package code and update metadata stay aligned.
```

#### Diagnosis

The stored install points at a custom package source, and TLH is refusing to mix new track/ref metadata with old package code.

#### Fix

Rerun the update with the matching `--package-source`, or rerun the installer for the exact source you want.

#### Undo / avoid

Treat `--package-source`, `--repo`, `--ref`, and `--track` as one set for custom installs.

### Offline update refusal

**Symptom:** `tlh update` fails with `PI_OFFLINE is set; refusing to run a network update.`

**Fix:** unset `PI_OFFLINE` for that update and rerun `tlh update`. See [Update checks](install.md#update-checks-and-opt-outs).

## Uninstall edge cases

- **Main-track install not removed:** the uninstaller does not detect `main` installs. Pass `--wrapper-name tlh-main --agent-dir ~/.the-last-harness-main/agent`, preview with `--dry-run` first. See [Uninstall](install.md#uninstall).
- **`Skip wrapper removal: ... not managed by The Last Harness installer`:** the file at the wrapper path isn't TLH's. Delete it yourself only if you know it's safe.
- **Private runtime skipped:** the ownership marker is missing or invalid. Run `tlh update` once so it gets a marker, then uninstall again, or follow the printed manual-removal hint. See [Pi removal decision](install.md#pi-removal-decision).
- **`--force-include-pi and --keep-pi are mutually exclusive`:** pass only one. See [Uninstaller flags](install.md#uninstaller-flags).

## Related docs

- [Install, update, and uninstall](install.md)
- [Slash commands and bundled command surface](commands.md)
- [Provider auth-health warning (⚠ reauth)](subagents.md#provider-auth-health-warning)
- [Project overview](../README.md)
