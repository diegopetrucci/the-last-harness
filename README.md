# The last harness you'll ever need.

`tlh` (the last harness) is a highly opinionated — albeit still simple — version of [pi](https://github.com/earendil-works/pi). Think of it, if you wish, as the macOS of harnesses. No bloat, no BS, but a strong direction.

Install one-liner:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash
```

## Features

- **Context discipline.** The context-cap extension helps keep long sessions under control.
- **Project memory.** Gnosis integration can record project decisions, constraints, rejected alternatives, and lessons in repo-local memory.
- **Safety rails for agent work.** Bundled permission and destructive-action confirmations add checkpoints before sensitive commands or file changes.
- **Cleaner sessions.** An update-aware startup header, custom footer, contextual steering/follow-up key hints, quieter tool output, completion notifications, and `/tlh` status keep the UI focused without hiding model-visible results.
- **Reasoning controls.** Use `/effort` to quickly change model thinking level from the TUI or command line.
- **Second opinions built in.** The Oracle extension can consult a separate read-only reasoning process for deeper review, debugging, and planning.
- **Opinionated defaults, conservative updates.** TLH installs a curated theme, prompt guidance, commands, and default extensions while preserving your custom settings and opt-outs across updates.
- **Isolated Pi profile.** `tlh` runs upstream `pi` with its own profile at `~/.the-last-harness/agent`, leaving your normal `~/.pi/agent` config untouched.

## Bundled extensions

The installer enables these standalone external Pi packages by default in the isolated `tlh` profile:

- `npm:@diegopetrucci/pi-permission-gate`
- `npm:@diegopetrucci/pi-oracle`
- `npm:@diegopetrucci/pi-notify`
- `npm:@diegopetrucci/pi-context-cap`
- `npm:@diegopetrucci/pi-context-inspector`
- `npm:@diegopetrucci/pi-quiet-tools`
- `npm:@diegopetrucci/pi-confirm-destructive`

Manage persistent opt-outs after install:

```sh
tlh defaults list
tlh defaults disable notify
tlh defaults enable notify
```

Opt-outs are written to `~/.the-last-harness/agent/settings.json` and survive `tlh update`, `pi update --extensions`, and installer reruns.

## Gnosis integration

[Gnosis](https://github.com/skorokithakis/gnosis) is a small `gn` CLI for recording project decisions, constraints, rejected alternatives, and lessons that are not obvious from code alone. During install, TLH asks whether to install and enable it because `tlh` works better when agents can consult and update that project memory.

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

Gnosis project data lives in repo-local `.gnosis` directories.

## Install

Run the one-liner:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash
```

It will ask you whether you want to use [gnosis](https://github.com/skorokithakis/gnosis) for memory-management. Not required, but recommended.

Once the installation is finished, start `tlh` by running… you guessed it, `tlh`.

Note: if you already have `pi` installed, `tlh` does not replace it — you can keep both, as it uses its own isolated config in `~/.the-last-harness/`.

### Update

You can just run the install script again `curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash`.

The updating process is intentionally conservative, and won't replace your custom extensions, themes, and so on. If you spot anything that was overridden, please open an issue.

## Isolation model

For normal agent commands, `tlh` is a thin wrapper around upstream Pi:

```sh
PI_CODING_AGENT_DIR="$HOME/.the-last-harness/agent" pi "$@"
```

It also intercepts installer-owned helper commands:

- `tlh defaults ...` manages TLH default-extension opt-outs in the isolated settings file.
- `tlh gnosis ...` manages optional Gnosis prompt integration in the isolated settings file.

So:

- `tlh` uses `~/.the-last-harness/agent/settings.json`
- normal `pi` uses `~/.pi/agent/settings.json`
- the installer does not write normal Pi settings or auth files
- if TLH installs Gnosis, the managed `gn` lives at `~/.the-last-harness/agent/bin/gn` and the wrapper prepends that directory to `PATH` only for `tlh`

Caveat: Pi project settings such as `.pi/settings.json` can still apply when running `tlh` inside a project, because that is core Pi behavior. The isolation is for the global Pi profile.

## Included Pi resources

- `extensions/the-last-harness.ts` adds the custom `tlh` startup header, lightweight default guidance, optional Gnosis prompt instructions, `/tlh` status, and `/effort` reasoning-effort picker commands.
- `skills/harness-setup/SKILL.md` documents safe setup/update/uninstall workflows.
- `prompts/harness-plan.md` provides `/harness-plan` for reviewable implementation planning.
- `themes/the-last-harness.json` provides the default isolated theme.

## Releases

For a pinned install, use that release's installer asset:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/download/v0.3.0/install.sh | bash
```

For development builds from `main`, pass `--ref main`:

```sh
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main/install.sh | bash -s -- --ref main
```

Release notes are sourced from the matching `CHANGELOG.md` section. Release instructions live in [`docs/releasing.md`](docs/releasing.md).

## Local testing

Test the extension directly from this checkout without installing it:

```sh
pi --no-extensions -e ./extensions/the-last-harness.ts
```

Then run the effort picker in the interactive UI:

```text
/effort
```

You can also test direct arguments and validation:

```text
/effort off
/effort low
/effort high
/effort xhigh
/effort nope
```

To test with an isolated temporary Pi profile:

```sh
tmp="$(mktemp -d)"
PI_CODING_AGENT_DIR="$tmp/agent" pi --no-extensions -e ./extensions/the-last-harness.ts
```

To test the package install flow locally:

```sh
tmp="$(mktemp -d)"
PI_CODING_AGENT_DIR="$tmp/agent" pi install "file:$PWD"
PI_CODING_AGENT_DIR="$tmp/agent" pi
```

Then run:

```text
/effort
```

To test the defaults manager without installing:

```sh
tmp="$(mktemp -d)"
node scripts/merge-settings.mjs config/settings.defaults.json \
  --settings "$tmp/settings.json" \
  --default-extensions config/default-extensions.json
node scripts/tlh-defaults.mjs \
  --settings "$tmp/settings.json" \
  --defaults config/default-extensions.json \
  disable notify
```

To test the Gnosis manager without installing:

```sh
tmp="$(mktemp -d)"
node scripts/tlh-gnosis.mjs --settings "$tmp/settings.json" status
node scripts/tlh-gnosis.mjs --settings "$tmp/settings.json" enable
node scripts/tlh-gnosis.mjs --settings "$tmp/settings.json" disable
```

To test installer wrapper behavior, dry-run first with temporary paths:

```sh
bash install.sh --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
```

## Manual install

```sh
npm install -g @earendil-works/pi-coding-agent
mkdir -p "$HOME/.the-last-harness/agent"
PI_CODING_AGENT_DIR="$HOME/.the-last-harness/agent" \
  pi install git:github.com/diegopetrucci/the-last-harness@v0.3.0
node scripts/merge-settings.mjs \
  config/settings.defaults.json \
  --settings "$HOME/.the-last-harness/agent/settings.json" \
  --package-source git:github.com/diegopetrucci/the-last-harness@v0.3.0 \
  --default-extensions config/default-extensions.json
PI_CODING_AGENT_DIR="$HOME/.the-last-harness/agent" \
  pi update --extensions
```

Run without the wrapper:

```sh
PI_CODING_AGENT_DIR="$HOME/.the-last-harness/agent" pi
```

## Installer options

```text
--dry-run        Print actions and settings changes without writing
--force          Allow scalar isolated defaults and installer wrapper overwrite
--no-pi-install  Fail instead of installing Pi when the `pi` command is missing
--no-settings     Install the package but skip isolated settings merge
--no-wrapper      Skip creating the tlh wrapper command
--with-gnosis     Install/enable optional Gnosis (`gn`) integration
--without-gnosis  Disable optional Gnosis integration without prompting
--no-gnosis       Alias for --without-gnosis
--agent-dir DIR   Isolated Pi agent dir, default ~/.the-last-harness/agent
--bin-dir DIR     Wrapper install dir, default ~/.local/bin
--wrapper-name N  Wrapper command name, default tlh
--ref REF         Install from a branch, tag, or commit
```

Example custom install:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | \
  bash -s -- --agent-dir ~/.tlh/agent --bin-dir ~/.local/bin
```

Example pinned install:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/download/v0.3.0/install.sh | bash
```

## Update

Re-run the latest release installer. This refreshes the isolated checkout to the latest release tag and re-merges installer defaults:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash
```

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

## Security note

The one-line installer runs shell commands on your machine, may install global npm packages for Pi and bundled default extensions, may download an optional Gnosis binary into the isolated TLH profile if you accept, creates an isolated Pi profile, and writes a wrapper command. Review `install.sh` before piping it to `bash` if you prefer. This repo does not create, read, or modify API keys or auth files.
