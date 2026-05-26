# Install, update, and uninstall

## Install

Requires Node.js >=22.19.0 on `PATH`. The installer checks this before downloading support files or invoking upstream Pi/npm.

Run the one-liner:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash -s --
```

On supported platforms (linux/darwin × x64/arm64), it installs [Gnosis](https://github.com/skorokithakis/gnosis) automatically. Installs on unsupported platforms hard-fail. TLH also requires `tk` ticket integration; if no valid configured/existing `tk` is found, TLH installs a managed copy at `~/.the-last-harness/agent/bin/tk`. If TLH cannot validate or install `tk`, install fails with an actionable error instead of creating an incomplete workflow. Once the installation is finished, start `tlh` by running… you guessed it, `tlh`.

Note: if you already have `pi` installed, `tlh` does not replace it — you can keep both, as it uses its own isolated config in `~/.the-last-harness/` and never mutates normal `~/.pi/agent` settings.

The installer is split into a stage-0 Bash bootstrapper (`install.sh`) and a stage-1 Node helper (`scripts/tlh-install.mjs`). Stage 0 parses the initial flags, preserves stdin `--dry-run` without downloads, and finds or fetches the matching stage-1 helper/support files from the selected release/ref; stage 1 runs the normal isolated install, settings merge, default-extension install, Gnosis and ticket setup, update metadata, and wrapper creation.

## More ways to install

- Pinned to a release tag for future updates:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/download/v0.6.0/install.sh | bash -s -- --track pinned-tag
```
- Any remote branch, eg `main`:

```sh
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main/install.sh | bash -s -- --ref main --track ref
```

These alternatives keep TLH isolated, but they are not the official latest stable install path. On interactive startup, TLH shows a header warning only for those installs. It appears above `Context:` and reads `Warning: running TLH from {name} track` (for example `Warning: running TLH from v0.6.0 track`, `Warning: running TLH from main track`, `Warning: running TLH from local track`, or `Warning: running TLH from unknown track`). Official latest-release installs stay silent.

## Installer options

```text
--dry-run        Print actions and settings/keybinding changes without writing
--force          Allow scalar isolated defaults and installer wrapper overwrite
--no-pi-install  Fail instead of installing Pi when the `pi` command is missing
--no-settings     Install the package but skip isolated settings/keybinding merge
--no-wrapper      Skip creating the tlh wrapper command
--agent-dir DIR   Isolated Pi agent dir, default ~/.the-last-harness/agent
--bin-dir DIR     Wrapper install dir, default ~/.local/bin
--wrapper-name N  Wrapper command name, default tlh
--ref REF         Install from a branch, tag, or commit
--track TRACK     Update track: latest-release, pinned-tag, ref, custom
--quiet          Suppress installer progress output
--verbose        Show underlying pi, npm, and git output
```

Example pinned-tag install:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/download/v0.6.0/install.sh | bash -s -- --track pinned-tag
```

## Update

You can just run `tlh update`.

This refreshes the isolated checkout according to your update track and re-merges installer defaults. Latest-release installs move to the newest GitHub Release, pinned-tag installs stay on their pinned tag, and `main`/ref installs keep following that ref. If you are updating from an older install without `tlh update`, rerun the latest-release installer once.

At launch, TLH also shows that `Warning: running TLH from {name} track` header warning above `Context:` when your install metadata says you are not on the official latest stable path, or when it cannot verify that metadata. The warning is informational only; it does not change your isolated install or auto-update anything.

- If you installed from a pinned release tag, a non-stable git ref, or another custom update track while still using the default TLH repo/package source, return to the official latest stable release track with:

```sh
tlh update --track latest-release
```

- If you installed from a custom package source, a non-default repo/fork, or TLH reports missing/invalid install metadata, return to the official latest stable release path by rerunning the official latest-release installer:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash -s --
```

Normal updates keep Gnosis and ticket integration enabled. They install or refresh the managed isolated `gn` binary when needed, re-enable legacy `settings.tlh.tickets.enabled=false` values, reuse a valid configured/existing `tk` when possible, and install or refresh the managed isolated copy at `~/.the-last-harness/agent/bin/tk` when needed. If no valid `tk` is available and the managed install fails, `tlh update` fails with an actionable error; provide a valid command with `tlh tickets enable --install-path /path/to/tk` or rerun the update once the managed download can succeed. Existing repo-local `.gnosis` and `.tickets` data is left in place.

The updating process is intentionally conservative, and won't replace your custom extensions, themes, and so on. If you spot anything that was overridden, [please open an issue](https://github.com/diegopetrucci/the-last-harness/issues).

Bundled default-extension opt-outs apply only to non-critical defaults. The TLH subagents/intercom defaults are protected because architect delegation and supervisor escalation depend on them: `tlh defaults disable` rejects those IDs and aliases, and stale manual critical opt-outs are ignored or cleaned. If a critical package install or checkout refresh fails, fix that install/checkout and rerun `tlh update` instead of disabling the default.

At launch, TLH checks GitHub Releases in the background at most once per day and warns once when a newer release is available. It never auto-updates. Set `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `TLH_SKIP_UPDATE_CHECK=1`, or `"tlh": { "updateCheck": { "enabled": false } }` in the isolated settings to disable the check.

Release builds with TelemetryDeck identifiers configured also send at most one pseudonymous launch event when an interactive `tlh` process starts. The event includes a hashed random install ID, event type, TLH version, privacy-filtered model value, OS name/version, and OS architecture. It does not include prompts, cwd, command arguments, repo names, hostname, username, file contents, settings contents, full environment variables, extension/package lists, API keys, provider base URLs, auth state, headers, or account identifiers. TelemetryDeck receives normal network metadata such as source IP address and request time.

To opt out persistently, set `"tlh": { "telemetry": { "enabled": false } }` in `~/.the-last-harness/agent/settings.json`. This opt-out is user-owned and survives `tlh update` and installer reruns. Per-run opt-outs are `PI_OFFLINE=1`, `TLH_SKIP_TELEMETRY=1`, `TLH_TELEMETRY_DISABLED=1`, or `PI_TELEMETRY=0`. To reset only the pseudonymous install ID, remove `~/.the-last-harness/agent/tlh/telemetry-state.json`.

To update bundled default extension packages too, run `tlh update`; it refreshes pinned critical defaults safely before updating other enabled defaults.

## Uninstall

Run the one-liner from the release asset:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/uninstall.sh | bash -s --
```

The script removes the isolated agent dir under `~/.the-last-harness` (and the now-empty parent dir, if any), the `tlh` wrapper, and (when install-state indicates it) the global pi package. Normal Pi config at `~/.pi/agent` is never touched.

### Uninstaller flags

The uninstaller prints its plan and then proceeds immediately — there is no confirmation prompt. Use `--dry-run` to preview what would be removed without performing any removals.

| Flag | Description |
|---|---|
| `--dry-run` | Print planned actions without performing any removals. |
| `--force-include-pi` | Remove pi via npm even when install-state says `piInstalledByTlh=false` or the field is absent. |
| `--keep-pi` | Skip pi removal even when install-state says `piInstalledByTlh=true`. |
| `--agent-dir DIR` | Override isolated agent dir (default: `~/.the-last-harness/agent`). Only the agent dir is removed; the parent dir is cleaned up only if empty. |
| `--bin-dir DIR` | Override wrapper install dir (default: `~/.local/bin`). |
| `--wrapper-name NAME` | Override wrapper command basename (default: `tlh`). |
| `--quiet` | Suppress non-essential output (errors and summary always shown). |
| `--verbose` | Print each removal command before executing it. |
| `-h`, `--help` | Show help. |

`--force-include-pi` and `--keep-pi` are mutually exclusive.

### Pi removal decision

At install time, TLH records `piInstalledByTlh` in `~/.the-last-harness/agent/tlh/install-state.json`. The uninstaller uses this field to decide whether to remove the global pi package, so a shared or pre-existing pi install is not accidentally removed. This field was added in this release; older installs that lack it default to leaving pi in place.

| Condition | pi removal |
|---|---|
| `piInstalledByTlh = true` | removed via npm |
| `piInstalledByTlh = false` | kept |
| field absent (older install) | kept |
| `--force-include-pi` flag | removed (overrides state) |
| `--keep-pi` flag | kept (overrides state) |

### What stays behind

The uninstaller never auto-removes:

- **`~/.pi`** — Pi's own user config directory. To remove it manually: `rm -rf ~/.pi`
- **Separately-installed pi binary** — if pi was installed before or independently of TLH, it is left in place. To remove it: `npm uninstall -g @earendil-works/pi-coding-agent`
- **Repo-local `.gnosis/` and `.tickets/` data** — per-repository and managed separately. To remove from a repo: `rm -rf .gnosis .tickets`

### Manual removal

If you prefer to skip the script entirely:

```sh
rm -f ~/.local/bin/tlh
rm -rf ~/.the-last-harness
```

This also removes the managed `tk` copy under the TLH profile if one was installed. To also remove the global pi package (only if you installed it solely for The Last Harness):

```sh
npm uninstall -g --prefix "$HOME/.local" @earendil-works/pi-coding-agent
```

TLH installs Pi per-user under `~/.local` (the binary lives at `~/.local/bin/pi`). If you previously installed Pi globally with sudo from older instructions, use `sudo npm uninstall -g @earendil-works/pi-coding-agent` instead.

## Security note

The one-line installer and `tlh update` run shell commands on your machine, may install global npm packages for Pi and bundled default extensions, install managed Gnosis and `tk` binaries into the isolated TLH profile when needed, create an isolated Pi profile, and write a wrapper command. Managed `tk` is copied from the pinned `wedow/ticket` source tarball (`v0.3.2`) only after SHA-256 verification; TLH does not install `tk` globally or through Homebrew. Review `install.sh` and the stage-1 helper it fetches (`scripts/tlh-install.mjs`) before piping to `bash` if you prefer. At launch, TLH may contact GitHub Releases to check for new TLH versions unless disabled with the update-check opt-outs above. This repo does not create, read, or modify API keys or auth files.
