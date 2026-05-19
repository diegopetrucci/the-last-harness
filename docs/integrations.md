# Integrations

TLH includes managed integrations for project memory and ticketed workflows. They are enabled by default and can be disabled without deleting repo-local data.

## Gnosis integration

[Gnosis](https://github.com/skorokithakis/gnosis) is a small `gn` CLI for recording project decisions, constraints, rejected alternatives, and lessons that are not obvious from code alone. On supported platforms, TLH installs and enables it by default because `tlh` works better when agents can consult and update that project memory.

Opt out during install or update with `--without-gnosis` / `--no-gnosis`, or disable it later with `tlh gnosis disable` or `/gnosis` inside an interactive session. For pipe-to-bash installs, pass installer flags after `bash -s --`:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash -s -- --without-gnosis
```

The opt-out is written to `~/.the-last-harness/agent/settings.json` and survives `tlh update`; use `tlh update --with-gnosis` to install/re-enable it automatically, or install `gn` manually and run `tlh gnosis enable` or `/gnosis`.

If enabled and a valid Gnosis `gn` binary is present, TLH appends these instructions to the system prompt:

```text
At the start of any task, run `gn help plan` and follow its instructions.
After finishing a task, run `gn help review`.
```

Manage the integration after install:

```sh
tlh gnosis status
tlh gnosis enable
tlh gnosis disable
```

Inside an interactive `tlh` session, use `/gnosis` to toggle the integration or `/gnosis status` to inspect it. Disabling Gnosis stops TLH from adding the prompt instructions; it does not delete existing repo-local memory or any managed `gn` binary. Gnosis project data lives in repo-local `.gnosis` directories.

## Ticket integration

TLH enables the `tk` ticket CLI by default for architect and product workflows. If no valid configured/existing `tk` is found, install and update place a managed copy at `~/.the-last-harness/agent/bin/tk`; TLH does not install `tk` globally or through Homebrew, and it never writes normal `~/.pi/agent` config.

Opt out during install or update with `--without-tickets` / `--no-tickets`, or force it back on with `--with-tickets`:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash -s -- --without-tickets
```

Manage it after install:

```sh
tlh tickets status
tlh tickets enable
tlh tickets disable
```

The opt-out is written to `~/.the-last-harness/agent/settings.json` and survives `tlh update`. Disabling ticket integration stops TLH primary agents from using `tk` and makes architect/product workflows fall back to conversation-based plans or non-ticket handoff material. It does not delete repo-local `.tickets` data or any managed `tk`; removing `~/.the-last-harness` removes the managed copy. Managed installs download the pinned `wedow/ticket` source tarball (`v0.3.2`) and verify its SHA-256 before extracting the `ticket` script; inherited environment variables cannot override those installer-owned source pins.
