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

- Pinned, eg `curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/download/v0.3.0/install.sh | bash -s --`
- Main (unstable): `curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main/install.sh | bash -s -- --ref main --track ref`

## Installer options

```text
--dry-run        Print actions and settings changes without writing
--force          Allow scalar isolated defaults and installer wrapper overwrite
--no-pi-install  Fail instead of installing Pi when the `pi` command is missing
--no-settings     Install the package but skip isolated settings merge
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
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/download/v0.3.0/install.sh | bash -s --
```

## Update

You can just run `tlh update`.

This refreshes the isolated checkout according to your update track and re-merges installer defaults. Latest-release installs move to the newest GitHub Release, pinned-tag installs stay on their pinned tag, and `main`/ref installs keep following that ref. If you are updating from an older install without `tlh update`, rerun the latest-release installer once with `TLH_UPDATE_TRACK=latest-release`.

Normal updates preserve your Gnosis setting. If you disabled it with `tlh gnosis disable`, toggled it off with `/gnosis`, or installed with `--without-gnosis`, it stays disabled across `tlh update`; use `tlh update --with-gnosis` to install/re-enable it automatically, or install `gn` manually and run `tlh gnosis enable` or `/gnosis`.

The updating process is intentionally conservative, and won't replace your custom extensions, themes, and so on. If you spot anything that was overridden, [please open an issue](https://github.com/diegopetrucci/the-last-harness/issues).

At launch, TLH checks GitHub Releases in the background at most once per day and warns once when a newer release is available. It never auto-updates. Set `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `TLH_SKIP_UPDATE_CHECK=1`, or `"tlh": { "updateCheck": { "enabled": false } }` in the isolated settings to disable the check.

To update bundled default extension packages too:

```sh
PI_CODING_AGENT_DIR="$HOME/.the-last-harness/agent" \
  pi update --extensions
```

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
