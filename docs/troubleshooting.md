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

For ordinary interactive TLH launches, current managed wrappers export `PI_CODING_AGENT_DIR` for the isolated TLH profile, validate the private runtime, and then exec the pinned absolute runtime path. A `pi` earlier on `PATH` cannot shadow that ordinary managed launch. Installer-owned helper subcommands such as `tlh update`, `tlh defaults`, `tlh tickets`, and `tlh doctor` dispatch through their helper scripts first, so their pre-runtime behavior is different. A direct `pi` launch still does not use the managed TLH wrapper path automatically.

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

### Symptom

Install or update fails with a wrapper error like:

```text
... already exists and is not managed by this installer; use --force or --bin-dir
```

Dry runs warn with:

```text
would not overwrite unmanaged existing wrapper: ...
```

### Diagnosis

TLH only overwrites wrapper files it manages itself unless you pass `--force`. This protects unrelated files at the target path. Installer-wide `--force` also permits scalar isolated-default overwrites; it is not limited to the wrapper, and TLH does not automatically back up an unmanaged wrapper before replacing it.

### Fix

Prefer a conservative path:

- preserve the existing file and install/update with a different `--bin-dir` or `--wrapper-name`, or
- back up the existing file yourself, then rerun with `--force` only if you accept both the unmanaged-wrapper replacement and scalar isolated-default overwrite behavior.

### Undo / avoid

- Restore your backup if you overwrote the wrong wrapper.
- Keep custom scripts and TLH wrappers at different paths/names.
- Use `--dry-run` first when changing wrapper destinations.

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

#### Symptom

Install stops because Node.js is unavailable or does not meet the required version.

#### Diagnosis

TLH requires Node.js >=22.19.0 on `PATH`. Check the command and version the installer will resolve:

```sh
command -v node
node --version
```

#### Fix

Install or select a supported Node.js version using your normal Node/version-manager workflow, ensure it resolves on `PATH`, then rerun the installer. Do not work around the check by pointing the installer at normal `~/.pi/agent`.

#### Undo / avoid

If you temporarily changed Node versions, return your version manager to its previous default after installation only if TLH will still resolve Node.js >=22.19.0 when it runs.

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

#### Symptom

You installed from `main`, but `tlh` does not start the expected install.

#### Diagnosis

A `main` ref install defaults to `tlh-main` and `~/.the-last-harness-main/agent` so it does not collide with the release install.

#### Fix

Run `tlh-main`, or reinstall/update with explicit `--wrapper-name` and `--agent-dir` values if you want release-style names instead.

#### Undo / avoid

Keep release-track and main-track installs separate unless you intentionally override both paths.

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

#### Symptom

`tlh update` fails with:

```text
PI_OFFLINE is set; refusing to run a network update.
```

#### Diagnosis

The environment explicitly told TLH not to perform networked update work.

#### Fix

Unset `PI_OFFLINE` for that update attempt, then rerun `tlh update`.

#### Undo / avoid

Keep `PI_OFFLINE=1` for sessions where you want that protection, but remember it also blocks TLH update/recovery downloads.

## Uninstall edge cases

### Main-track uninstall needs matching paths

#### Symptom

The default uninstaller leaves a `tlh-main` install in place or targets the release-profile defaults instead.

#### Diagnosis

The uninstaller does not infer a prior `main` ref. A main-track install defaults to wrapper `tlh-main` and agent dir `~/.the-last-harness-main/agent`, while uninstall defaults to the release paths.

#### Fix

Preview and then run the uninstaller with matching flags:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/uninstall.sh | bash -s -- \
  --dry-run --wrapper-name tlh-main --agent-dir "$HOME/.the-last-harness-main/agent"
```

Remove `--dry-run` only after the plan shows the intended main-track wrapper, profile, and runtime. If the install used custom values, pass the same custom `--wrapper-name`, `--agent-dir`, and `--bin-dir` values.

#### Undo / avoid

Always preview uninstall when multiple TLH tracks are installed. The script proceeds without a confirmation prompt once `--dry-run` is removed.

### Unmanaged wrapper is left in place

#### Symptom

The uninstaller says:

```text
Skip wrapper removal: ...
(existing file is not managed by The Last Harness installer)
```

#### Diagnosis

The wrapper path exists, but the file is not marked as installer-managed TLH content.

#### Fix

Delete that wrapper manually only if you know it is safe to remove.

#### Undo / avoid

Keep non-TLH scripts at different paths or names than the TLH wrapper.

### Private runtime is skipped during uninstall

#### Symptom

The uninstaller reports that pi/runtime removal was skipped because the runtime marker is missing, invalid, symlinked, or the runtime contains unexpected top-level entries.

#### Diagnosis

TLH removes the private runtime only when it can prove ownership conservatively from `.tlh-runtime-owned` and the expected runtime layout.

#### Fix

- If you want a normal managed uninstall path, repair/update TLH first and then rerun uninstall.
- If you are certain the directory is only TLH's abandoned private runtime, follow the printed manual `rm -rf` hint exactly.

#### Undo / avoid

Do not copy unrelated files into TLH's runtime directory, and do not remove the ownership marker unless you are intentionally taking over that directory yourself.

### `--force-include-pi` and `--keep-pi` conflict

#### Symptom

Uninstall exits with:

```text
--force-include-pi and --keep-pi are mutually exclusive; pass only one
```

#### Diagnosis

Those flags request opposite behaviors.

#### Fix

Rerun uninstall with only one of them.

#### Undo / avoid

Use `--dry-run` first if you are unsure which uninstall plan you want.

## Related docs

- [Install, update, and uninstall](install.md)
- [Slash commands and bundled command surface](commands.md)
- [Project overview](../README.md)
