# Install, update, and uninstall

## Install

Requires Node.js >=22.19.0 on `PATH`. TLH always installs its own pinned Pi 0.84.1 into a private runtime at `~/.the-last-harness/runtime` — a sibling of the isolated agent dir. A global or pre-installed `pi` on your PATH is never used or modified; tlh and any existing `pi` are fully decoupled. Install or repair failures stop with an actionable error.

Run the one-liner:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash -s --
```

On supported platforms (linux/darwin × x64/arm64), it installs [Gnosis](https://github.com/skorokithakis/gnosis) automatically. TLH currently pins the managed default to Gnosis `v0.5.4`; installer-owned `TLH_GNOSIS_VERSION` and `TLH_GNOSIS_REPO` overrides can still point at another release or repository when needed. Installs on unsupported platforms hard-fail. TLH also requires `tk` ticket integration; if no valid configured/existing `tk` is found, TLH installs a managed copy at `~/.the-last-harness/agent/bin/tk`. If TLH cannot validate or install `tk`, install fails with an actionable error instead of creating an incomplete workflow. Once the installation is finished, start `tlh` by running… you guessed it, `tlh`.

Note: if you already have `pi` installed, `tlh` does not replace it — you can keep both, as it uses its own isolated config in `~/.the-last-harness/` and never mutates normal `~/.pi/agent` settings. The subagent orchestration runtime is first-party TLH code declared by this package, not a separate extension package that users must install or pin.

The installer is split into a stage-0 Bash bootstrapper (`install.sh`) and a stage-1 Node helper (`scripts/tlh-install.mjs`). Stage 0 parses the initial flags, preserves stdin `--dry-run` without downloads, and finds or fetches the matching stage-1 helper/support files from the selected release/ref; stage 1 runs the normal isolated install, settings merge, first-party resource provisioning, default-extension install, Gnosis and ticket setup, update metadata, and wrapper creation.

## More ways to install

- Pinned to a release tag for future updates:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/download/v0.35.0/install.sh | bash -s -- --track pinned-tag
```
- Any remote branch, eg `main`:

```sh
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main/install.sh | bash -s -- --ref main --track ref
```

  When installing from `main`, the installer automatically uses separate defaults so that a main-track install does not collide with a stable-release install: the wrapper command defaults to **`tlh-main`** (instead of `tlh`) and the isolated agent dir defaults to **`~/.the-last-harness-main/agent`** (with a private runtime at `~/.the-last-harness-main/runtime`). You can override either default back to the release values by passing explicit flags:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main/install.sh | bash -s -- \
    --ref main --track ref \
    --wrapper-name tlh --agent-dir ~/.the-last-harness/agent
  ```

  Or set the equivalent environment variables on the `bash` side of the pipe so the installer process inherits them (assigning them before `curl` would scope them to `curl` only, not to `install.sh`):

  ```sh
  curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main/install.sh | \
    TLH_WRAPPER_NAME=tlh TLH_AGENT_DIR=~/.the-last-harness/agent bash -s -- --ref main --track ref
  ```

These alternatives keep TLH isolated, but they are not the official latest stable install path. On interactive startup, TLH shows a header warning only for those installs. It appears above `Context:` and reads `Warning: running TLH from {name} track` (for example `Warning: running TLH from v0.35.0 track`, `Warning: running TLH from main track`, `Warning: running TLH from local track`, or `Warning: running TLH from unknown track`). Official latest-release installs skip that warning, though interactive starts may still show a quiet startup tip.

## Installer options

```text
--dry-run        Print actions and settings/keybinding changes without writing
--force          Allow scalar isolated defaults and installer wrapper overwrite
--no-settings     Install the package but skip isolated settings/keybinding merge
--no-wrapper      Skip creating the tlh wrapper command
--agent-dir DIR   Isolated Pi agent dir
                  (default for release tags: ~/.the-last-harness/agent;
                   default for main ref:     ~/.the-last-harness-main/agent)
--bin-dir DIR     Wrapper install dir, default ~/.local/bin
--wrapper-name N  Wrapper command name
                  (default for release tags: tlh;
                   default for main ref:     tlh-main)
--ref REF         Install from a branch, tag, or commit
--track TRACK     Update track: latest-release, pinned-tag, ref, custom
--quiet          Suppress installer progress output
--verbose        Show underlying pi, npm, and git output
```

Example pinned-tag install:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/download/v0.35.0/install.sh | bash -s -- --track pinned-tag
```

## Update

You can just run `tlh update`.

This refreshes the isolated checkout according to your update track and re-merges installer defaults. Latest-release installs move to the newest GitHub Release, pinned-tag installs stay on their pinned tag, and `main`/ref installs keep following that ref. `tlh update` also repairs the private Pi runtime at `~/.the-last-harness/runtime` back to the pinned 0.84.1 when needed. If you are updating from an older install without `tlh update`, rerun the latest-release installer once.

If TLH starts with the notice ``TLH extension updates are available. Run `tlh update --extensions` to update them.``, that notice refers to isolated extension/package updates only. `tlh update --extensions` runs the upstream package refresh against the TLH profile without changing installer-managed checkout state, wrapper files, or update-track metadata. Installer-track and installer-owned options such as `--track`, `--ref`, `--repo`, `--package-source`, `--force`, `--no-settings`, and `--no-wrapper` require plain `tlh update` instead.

At launch, TLH also shows that `Warning: running TLH from {name} track` header warning above `Context:` when your install metadata says you are not on the official latest stable path, or when it cannot verify that metadata. The warning is informational only; it does not change your isolated install or auto-update anything.

- If you installed from a pinned release tag, a non-stable git ref, or another custom update track while still using the default TLH repo/package source, return to the official latest stable release track with:

```sh
tlh update --track latest-release
```

- If you installed from a custom package source, a non-default repo/fork, or TLH reports missing/invalid install metadata, return to the official latest stable release path by rerunning the official latest-release installer:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash -s --
```

Normal updates keep Gnosis and ticket integration enabled. They install or refresh the managed isolated `gn` binary when needed, re-enable legacy `settings.tlh.tickets.enabled=false` values, reuse a valid configured/existing `tk` when possible, and install or refresh the managed isolated copy at `~/.the-last-harness/agent/bin/tk` when needed. If no valid `tk` is available and the managed install fails, `tlh update` fails with an actionable error; provide a valid command with `tlh tickets enable --install-path /path/to/tk` for tickets, or rerun the update once the managed download can succeed. Existing repo-local `.gnosis` and `.tickets` data is left in place.

The updating process is intentionally conservative, and won't replace your custom extensions, themes, and so on. If you spot anything that was overridden, [please open an issue](https://github.com/diegopetrucci/the-last-harness/issues).

TLH now records installer-owned bundled-extension provenance in the isolated settings at `tlh.defaultExtensionProvenance.managedPackageIdentities`. Older installs that do not have this metadata migrate it on the next installer run or `tlh update`: matching legacy bundled defaults are treated as TLH-managed once so retired defaults can still be cleaned up. After that metadata exists, retired-default cleanup only removes package identities still marked as TLH-managed, so a package you later re-add manually with the same source is left alone.

### Migration from the retired external subagent package

Subagent orchestration now ships inside TLH. During install/update, stage 1 captures any retired external subagent entry that TLH owns before settings merge, attempts to remove its npm dependency or guarded git checkout, removes the settings/provenance entry, provisions the first-party config and copied minor-agent definitions, and then refreshes the remaining extensions. Retry-preserved ownership evidence applies specifically to the npm uninstall path: a failed uninstall or remaining npm declaration/install stops before merge so the next run can retry.

Git checkout cleanup is guarded and best-effort. An unsafe path, symlink, non-directory, or removal failure emits a warning but does not stop settings merge; settings/provenance can therefore converge while an inert checkout remains beneath `<agent-dir>/git`. Inspect only the exact path printed in the warning—for example with `git -C "<exact-checkout-path>" remote -v`—and, after confirming it is the retired checkout, remove that exact directory manually. Do not broadly delete `<agent-dir>/git`, which can contain unrelated user-owned packages.

Ownership stays conservative. On a profile with `tlh.defaultExtensionProvenance`, only a matching identity listed there is auto-removed. A pre-provenance profile is treated as a legacy TLH profile for the old default npm/git identities. A matching entry that is provably manual is preserved. Local/path packages are recognized by neither the ownership migration nor the runtime coexistence guard; remove or disable an external local/path subagent resource in its original scope before a normal TLH launch, or duplicate tools may register. Stale `subagents` or `pi-subagents` values are removed from `tlh.disabledDefaultExtensions` because the first-party runtime is no longer a default-extension opt-out.

If a recognized external npm/git subagent entry remains in user or project settings, the first-party runtime refuses to register duplicate tools and warns with the scope it found. Remove that manually owned source with `tlh remove <source>` (user scope) or `tlh remove <source> -l` (project scope), run `tlh update`, and restart. Back up and inspect unfamiliar files first.

There is no `tlh defaults disable subagents` path. For a one-run diagnostic, `tlh --no-extensions` disables **all** extensions without changing settings. The upstream resource selector exposed by `tlh config` can persistently disable the root-package resource `./extensions/subagents/src/extension/index.js`, but doing so breaks architect delegation and is not a supported steady state; reopen `tlh config` and re-enable that same resource to recover. Use the full uninstall flow below to remove TLH persistently. See [subagents.md](subagents.md) for runtime behavior and diagnostic details.

At launch, TLH checks GitHub Releases in the background at most once per day and warns once when a newer release is available. It never auto-updates. Set `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `TLH_SKIP_UPDATE_CHECK=1`, or `"tlh": { "updateCheck": { "enabled": false } }` in the isolated settings to disable the check.

Release builds with TelemetryDeck identifiers configured send pseudonymous telemetry from interactive `tlh` runs. `Tlh.launched` is sent at most once per interactive process start. The hashed random install ID means TelemetryDeck unique-user aggregation continues to represent installations rather than people or individual runs. Runtime provider and model values are privacy-filtered, only registered TLH experimental feature IDs are reported, and sensitive fields such as prompts, cwd, command arguments, repo names, file contents, settings contents, API keys, provider base URLs, auth state, headers, and account identifiers are omitted. See [`docs/telemetry.md`](telemetry.md) for the exact signal names, dimensions, filters, and semantics.

To opt out persistently, set `"tlh": { "telemetry": { "enabled": false } }` in `~/.the-last-harness/agent/settings.json`. This opt-out is user-owned and survives `tlh update` and installer reruns. Per-run opt-outs are `PI_OFFLINE=1`, `TLH_SKIP_TELEMETRY=1`, `TLH_TELEMETRY_DISABLED=1`, or `PI_TELEMETRY=0`. To reset only the pseudonymous install ID, remove `~/.the-last-harness/agent/tlh/telemetry-state.json`.

Plain `tlh update` also refreshes bundled default extension packages. Bundled npm defaults are installer-pinned to explicit versions from `config/default-extensions.json`, while any remaining TLH git-fork defaults stay pinned to their tagged refs; TLH only changes those managed versions when a TLH release updates the bundle. The first-party subagent runtime is refreshed with the TLH package itself rather than through this default-extension update path.

## Doctor

Run `tlh doctor` to inspect the active isolated TLH profile. It is read-only by default: it reports settings drift, missing bundled subagent prompt copies, managed-helper/runtime hints, and prerequisite issues without modifying the profile, creating backups, or touching normal `~/.pi/agent`.

Use `tlh doctor --repair` only when you want the narrow guarded repair path for TLH-owned isolated-profile drift. It can reapply packaged settings defaults, restore bundled subagent prompts, and reinstall managed `gn` and `tk` helpers. It does **not** replace the private runtime or configure user-owned prerequisites such as `gh` auth, EXA keys, or MCP config.

When `--repair` updates `settings.json`, TLH keeps the existing backup behavior and writes a `settings.json.backup-*` file first. To undo a repair, restore the backup you want or rerun `tlh update` to bring the isolated profile back to installer-managed defaults.

## Uninstall

Run the one-liner from the release asset:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/uninstall.sh | bash -s --
```

If you installed from `main` (which defaults to the `tlh-main` wrapper and `~/.the-last-harness-main/agent`), the uninstaller has no `--ref` auto-detection, so you must supply the matching flags explicitly:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/uninstall.sh | bash -s -- \
  --wrapper-name tlh-main --agent-dir ~/.the-last-harness-main/agent
```

The script removes the isolated agent dir under `~/.the-last-harness/agent`, the `tlh` wrapper, and the private Pi runtime at `~/.the-last-harness/runtime` when a valid ownership marker (`.tlh-runtime-owned` inside the runtime directory) is present. An unmarked or pre-marker runtime is skipped and a manual-removal hint is printed instead. A legacy TLH-installed pi at `~/.local` is removed only when `--force-include-pi` is explicitly passed; without that flag the uninstaller leaves it in place and prints a manual-removal hint. The parent dir `~/.the-last-harness` is removed only when empty after the agent dir is gone. Normal Pi config at `~/.pi/agent` is never touched.

### Uninstaller flags

The uninstaller prints its plan and then proceeds immediately — there is no confirmation prompt. Use `--dry-run` to preview what would be removed without performing any removals.

| Flag | Description |
|---|---|
| `--dry-run` | Print planned actions without performing any removals. |
| `--force-include-pi` | Removes the private runtime when a valid ownership marker is present; if the runtime is unmarked, it is still skipped with a manual-removal hint. When the private runtime is absent and a legacy `~/.local/bin/pi` exists, removes that instead. This flag is **required** to remove a legacy `~/.local` pi — without it the uninstaller never auto-removes it, to protect user-owned installations. |
| `--keep-pi` | Skip runtime and pi removal even when install-state says `piInstalledByTlh=true`. |
| `--agent-dir DIR` | Override isolated agent dir (default: `~/.the-last-harness/agent`). Only the agent dir is removed; the parent dir is cleaned up only if empty. |
| `--bin-dir DIR` | Override wrapper install dir (default: `~/.local/bin`). |
| `--wrapper-name NAME` | Override wrapper command basename (default: `tlh`). |
| `--quiet` | Suppress non-essential output (errors and summary always shown). |
| `--verbose` | Print each removal command before executing it. |
| `-h`, `--help` | Show help. |

`--force-include-pi` and `--keep-pi` are mutually exclusive.

### Pi removal decision

TLH records ownership of the private Pi runtime via a marker file (`.tlh-runtime-owned`) written inside `~/.the-last-harness/runtime` at install time. The uninstaller validates this marker (fail-closed: verifies the recorded runtime path matches the resolved directory, the directory is not a symlink, and a positive Pi layout is present) before removing the runtime. Install-state `piInstalledByTlh=true` alone is no longer sufficient — without a valid marker, the runtime is skipped and a manual-removal hint is printed. Older installs without the marker gain it automatically on the next `tlh update` or installer rerun; after that, uninstall can auto-remove as normal. A legacy `~/.local` pi is never removed automatically — it is removed only when `--force-include-pi` is explicitly passed, because the uninstaller cannot determine whether that binary was installed by TLH or by the user.

| Condition | Effect |
|---|---|
| valid `.tlh-runtime-owned` marker present | private runtime (`~/.the-last-harness/runtime`) removed (`rm -rf`); legacy `~/.local` pi is **not** removed unless `--force-include-pi` is also passed |
| marker absent or invalid (unmarked or pre-marker runtime) | private runtime **skipped** — manual-removal hint printed; `piInstalledByTlh=true` alone does not override this |
| `--force-include-pi` flag | removes private runtime when a valid marker is present; runtime skipped with a hint if unmarked; removes legacy `~/.local/bin/pi` if present and private runtime is absent |
| `--keep-pi` flag | keeps everything — skips runtime and pi removal |

### What stays behind

The uninstaller never auto-removes:

- **`~/.pi`** — Pi's own user config directory. To remove it manually: `rm -rf ~/.pi`
- **Private TLH Pi runtime (when kept)** — if you pass `--keep-pi`, if the runtime has no valid ownership marker (unmarked or pre-marker install), or if install-state is `false`/absent, the runtime at `~/.the-last-harness/runtime` is left in place; remove it manually: `rm -rf ~/.the-last-harness/runtime`.
- **Separately-installed pi** — any `pi` you installed independently of TLH is left in place and never touched by tlh.
- **Legacy TLH-owned pi at `~/.local`** — the uninstaller never auto-removes this (to protect user-owned installations). To remove it, pass `--force-include-pi` to the uninstaller, or remove manually: `npm uninstall -g --ignore-scripts --prefix "$HOME/.local" @earendil-works/pi-coding-agent`.
- **Repo-local `.gnosis/`, `.tickets/`, and `.pi-subagents/` data** — per-repository and managed separately. `.pi-subagents/` can contain child artifacts worth inspecting after a failed run. To remove all three from a repo after reviewing them: `rm -rf .gnosis .tickets .pi-subagents`

### Manual removal

If you prefer to skip the script entirely:

```sh
rm -f ~/.local/bin/tlh
rm -rf ~/.the-last-harness
```

This removes the isolated agent dir, the private Pi runtime at `~/.the-last-harness/runtime`, and the managed `tk` copy under the TLH profile, along with any remaining TLH-owned legacy profile artifacts inside `~/.the-last-harness`. To also remove a TLH-managed legacy pi at `~/.local` (from an older install, only if TLH originally installed it):

```sh
npm uninstall -g --ignore-scripts --prefix "$HOME/.local" @earendil-works/pi-coding-agent
```

## Backup retention

Backup files at the isolated-profile root (`settings.json.backup-*`, `keybindings.json.backup-*`) are pruned automatically on install and update: any backup older than ~28 days is removed, but the two newest backups are always kept regardless of age. This pruning is scoped strictly to the isolated profile (`~/.the-last-harness/agent`) and never touches `~/.pi`. If you want to keep a particular backup indefinitely, copy it to a location outside the isolated profile before it ages out.

## First-party subagent configuration

The installer provisions the first-party runtime's isolated config at `~/.the-last-harness/agent/extensions/subagent/config.json` with missing TLH defaults: compact tool descriptions and `control.activeNoticeAfterMs: 270000` (4m30). To override the notice checkpoint, edit that file and set `control.activeNoticeAfterMs` to your preferred number of milliseconds; existing values and unrelated top-level or nested keys are preserved on later installs and updates. Setting `control.activeNoticeAfterMs` to `240000` restores the runtime's four-minute baseline and is preserved. Removing that key and rerunning `tlh update` (or the installer) restores TLH's managed `270000`/4m30 default. This only changes the isolated TLH profile and never the normal `~/.pi/agent` configuration. See [subagents.md](subagents.md) for dispatch, control, artifact, and acceptance semantics.

### Scout run timeout cap

TLH caps new execution-bearing `librarian`, `web-scout`, `repo-scout`, and `diff-summarizer` runs at six minutes (`360000` ms) unless the caller already set a stricter timeout. `resume` timeouts are left unchanged.

## gh CLI prerequisite (for librarian)

The `librarian` subagent performs read-only GitHub research using the `gh` CLI and `git`. Install `gh` from <https://cli.github.com/> and authenticate with `gh auth login` before using librarian. Run `gh auth status` to confirm. Without an authenticated `gh`, librarian reports what it could not verify rather than silently failing.

## Security note

The one-line installer and `tlh update` run shell commands on your machine, install the upstream Pi npm package per-user into a private runtime at `~/.the-last-harness/runtime` and bundled default extensions, install managed Gnosis and `tk` binaries into the isolated TLH profile when needed, create an isolated Pi profile, and write a wrapper command. Managed bundled npm extension sources are pinned to explicit versions in `config/default-extensions.json`; managed Gnosis defaults to the pinned `v0.5.4` release unless you override it. Managed `tk` is copied from the pinned `wedow/ticket` source tarball (`v0.3.2`) only after SHA-256 verification; TLH does not install `tk` globally or through Homebrew. Review `install.sh` and the stage-1 helper it fetches (`scripts/tlh-install.mjs`) before piping to `bash` if you prefer. At launch, TLH may contact GitHub Releases to check for new TLH versions unless disabled with the update-check opt-outs above. This repo does not create, read, or modify API keys or auth files.
