# Install and update

## Install

Run the one-liner:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | TLH_UPDATE_TRACK=latest-release bash
```

It will ask you whether you want to use [gnosis](https://github.com/skorokithakis/gnosis) for memory-management. Not required, but recommended.

Once the installation is finished, start `tlh` by running… you guessed it, `tlh`.

Note: if you already have `pi` installed, `tlh` does not replace it — you can keep both, as it uses its own isolated config in `~/.the-last-harness/`.

## More ways to install

- Pinned, eg `curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/download/v0.3.0/install.sh | bash`
- Main (unstable): `curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main/install.sh | bash -s -- --ref main --track ref`

## Update

You can just run `tlh update`.

The updating process is intentionally conservative, and won't replace your custom extensions, themes, and so on. If you spot anything that was overridden, [please open an issue](https://github.com/diegopetrucci/the-last-harness/issues).

Release notes are sourced from the matching [`CHANGELOG.md`](../CHANGELOG.md) section. Release instructions live in [`docs/releasing.md`](releasing.md).
