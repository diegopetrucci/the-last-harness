# Install, update, and uninstall

## Install

Run the one-liner:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | TLH_UPDATE_TRACK=latest-release bash -s --
```

On supported platforms, it installs and enables [gnosis](https://github.com/skorokithakis/gnosis) for project memory by default. To opt out during a pipe-to-bash install, pass the flag after `bash -s --`:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | TLH_UPDATE_TRACK=latest-release bash -s -- --without-gnosis
```

Once the installation is finished, start `tlh` by running… you guessed it, `tlh`. Inside an interactive session, `/gnosis` toggles Gnosis prompt integration.

Note: if you already have `pi` installed, `tlh` does not replace it — you can keep both, as it uses its own isolated config in `~/.the-last-harness/`.

## More ways to install

- Pinned:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/download/v0.6.0/install.sh | bash -s --
```
- Any remote branch, eg `main`:

```sh
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main/install.sh | bash -s -- --ref main --track ref
```

## Installer options

```text
--dry-run        Print actions and settings/keybinding changes without writing
--force          Allow scalar isolated defaults and installer wrapper overwrite
--no-pi-install  Fail instead of installing Pi when the `pi` command is missing
--no-settings     Install the package but skip isolated settings/keybinding merge
--no-wrapper      Skip creating the tlh wrapper command
--with-gnosis     Force install/re-enable Gnosis (`gn`) integration
--without-gnosis  Opt out of Gnosis integration and keep it disabled
--no-gnosis       Alias for --without-gnosis
--agent-dir DIR   Isolated Pi agent dir, default ~/.the-last-harness/agent
--bin-dir DIR     Wrapper install dir, default ~/.local/bin
--wrapper-name N  Wrapper command name, default tlh
--ref REF         Install from a branch, tag, or commit
--track TRACK     Update track: latest-release, pinned-tag, ref, custom
--quiet          Suppress installer progress output
--verbose        Show underlying pi, npm, and git output
```

Example pinned install:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/download/v0.6.0/install.sh | bash -s --
```

## Update

You can just run `tlh update`.

This refreshes the isolated checkout according to your update track and re-merges installer defaults. Latest-release installs move to the newest GitHub Release, pinned-tag installs stay on their pinned tag, and `main`/ref installs keep following that ref. If you are updating from an older install without `tlh update`, rerun the latest-release installer once with `TLH_UPDATE_TRACK=latest-release`.

Normal updates preserve your Gnosis setting. If you disabled it with `tlh gnosis disable`, toggled it off with `/gnosis`, or installed with `--without-gnosis`, it stays disabled across `tlh update`; use `tlh update --with-gnosis` to install/re-enable it automatically, or install `gn` manually and run `tlh gnosis enable` or `/gnosis`.

The updating process is intentionally conservative, and won't replace your custom extensions, themes, and so on. If you spot anything that was overridden, [please open an issue](https://github.com/diegopetrucci/the-last-harness/issues).

Bundled default-extension opt-outs apply only to non-critical defaults. The TLH subagents/intercom defaults are protected because architect delegation and supervisor escalation depend on them: `tlh defaults disable` rejects those IDs and aliases, and stale manual critical opt-outs are ignored or cleaned. If a critical package install or checkout refresh fails, fix that install/checkout and rerun `tlh update` instead of disabling the default.

At launch, TLH checks GitHub Releases in the background at most once per day and warns once when a newer release is available. It never auto-updates. Set `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `TLH_SKIP_UPDATE_CHECK=1`, or `"tlh": { "updateCheck": { "enabled": false } }` in the isolated settings to disable the check.

Release builds with TelemetryDeck identifiers configured also send at most one pseudonymous launch event when an interactive `tlh` process starts. The event includes a hashed random install ID, event type, TLH version, privacy-filtered model value, OS name/version, and OS architecture. It does not include prompts, cwd, command arguments, repo names, hostname, username, file contents, settings contents, full environment variables, extension/package lists, API keys, provider base URLs, auth state, headers, or account identifiers. TelemetryDeck receives normal network metadata such as source IP address and request time.

To opt out persistently, set `"tlh": { "telemetry": { "enabled": false } }` in `~/.the-last-harness/agent/settings.json`. This opt-out is user-owned and survives `tlh update` and installer reruns. Per-run opt-outs are `PI_OFFLINE=1`, `TLH_SKIP_TELEMETRY=1`, `TLH_TELEMETRY_DISABLED=1`, or `PI_TELEMETRY=0`. To reset only the pseudonymous install ID, remove `~/.the-last-harness/agent/tlh/telemetry-state.json`.

To update bundled default extension packages too, run `tlh update`; it refreshes pinned critical defaults safely before updating other enabled defaults.

## Uninstall

Remove the isolated wrapper and profile:

```sh
rm -f ~/.local/bin/tlh
rm -rf ~/.the-last-harness
```

This does not uninstall upstream Pi, because you may use normal `pi` separately.

To remove upstream Pi entirely, only if you installed it solely for The Last Harness:

```sh
npm uninstall -g @earendil-works/pi-coding-agent
```
