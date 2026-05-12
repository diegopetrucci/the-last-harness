# The last harness you'll ever need.

`tlh` (the last harness) is a highly opinionated — albeit still simple — version of [pi](https://github.com/earendil-works/pi). Think of it, if you wish, as the macOS of harnesses. No bloat, no BS, but a strong direction.

Install one-liner:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | TLH_UPDATE_TRACK=latest-release bash
```

## Core features

- **Context discipline.** The context-cap extension helps keep long sessions under control.
- **Project memory.** Gnosis integration can record project decisions, constraints, rejected alternatives, and lessons in repo-local memory.
- **Safety rails for agent work.** Bundled permission and destructive-action confirmations add checkpoints before sensitive commands or file changes.
- **Cleaner sessions.** An update-aware startup header, new-release launch warnings, custom footer, contextual steering/follow-up key hints, quieter tool output, completion notifications, and `/tlh` status keep the UI focused without hiding model-visible results.
- **Reasoning controls.** Use `/effort` to quickly change model thinking level from the TUI or command line.
- **Fast-mode controls.** The bundled OpenAI Fast extension adds `/fast` commands for eligible ChatGPT-auth GPT-5.4/GPT-5.5 sessions while defaulting Fast mode off.
- **Second opinions built in.** The Oracle extension can consult a separate read-only reasoning process for deeper review, debugging, and planning.
- **Repository research.** The Librarian extension can scout GitHub repositories and optionally cache local checkouts.
- **Opinionated defaults, conservative updates.** TLH installs a curated theme, prompt guidance, commands, and default extensions while preserving your custom settings and opt-outs across updates.
- **Isolated Pi profile.** `tlh` runs upstream `pi` with its own profile at `~/.the-last-harness/agent`, leaving your normal `~/.pi/agent` config untouched.

## Custom commands

The following slash commands are available in interactive `tlh` sessions:

- `/effort [off|minimal|low|medium|high|xhigh]` — pick or set model reasoning effort. Available levels depend on the current model; run `/effort` without an argument for the picker.
- `/fast on|off|auto|toggle|status` — manage OpenAI Fast mode for eligible ChatGPT-auth GPT-5.4/GPT-5.5 sessions.
- `/context [--no-open] [--keep] [--redact] [--full|--current]` — generate a local HTML breakdown of where the session context is going.

### Included Pi resources

- `extensions/the-last-harness.ts` adds the custom `tlh` startup header and footer, lightweight default guidance, optional Gnosis prompt instructions, `/tlh` status, `/effort` reasoning-effort picker commands, and the 200k-token `DUMB ZONE` footer warning.
- `skills/harness-setup/SKILL.md` documents safe setup/update/uninstall workflows.
- `prompts/harness-plan.md` provides `/harness-plan` for reviewable implementation planning.
- `themes/the-last-harness.json` provides the default isolated theme.

## Bundled extensions

The installer enables these standalone external Pi packages by default in the isolated `tlh` profile:

- [`npm:@diegopetrucci/pi-permission-gate`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/permission-gate) — asks for confirmation before sensitive tool calls.
- [`npm:@diegopetrucci/pi-oracle`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/oracle) — consults a separate read-only reasoning process for second opinions.
- [`npm:@diegopetrucci/pi-openai-fast`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/openai-fast) — adds optional `/fast` commands for eligible ChatGPT-auth GPT-5.4/GPT-5.5 sessions.
- [`npm:@diegopetrucci/pi-librarian`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/librarian) — scouts GitHub repositories and optionally caches local checkouts.
- [`npm:@diegopetrucci/pi-notify`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/notify) — sends a notification when an agent turn finishes.
- [`npm:@diegopetrucci/pi-context-cap`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/context-cap) — keeps context usage under a configured cap.
- [`npm:@diegopetrucci/pi-context-inspector`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/context-inspector) — opens a local HTML dashboard showing where session context is going.
- [`npm:@diegopetrucci/pi-quiet-tools`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/quiet-tools) — compacts collapsed built-in tool output without changing model-visible results.
- [`npm:@diegopetrucci/pi-confirm-destructive`](https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/confirm-destructive) — confirms destructive shell and file operations before they run.

Manage persistent opt-outs after install:

```sh
tlh defaults list
tlh defaults disable notify
tlh defaults enable notify
```

Opt-outs are written to `~/.the-last-harness/agent/settings.json` and survive `tlh update`, `pi update --extensions`, and installer reruns.

### Gnosis integration

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
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | TLH_UPDATE_TRACK=latest-release bash
```

It will ask you whether you want to use [gnosis](https://github.com/skorokithakis/gnosis) for memory-management. Not required, but recommended.

Once the installation is finished, start `tlh` by running… you guessed it, `tlh`.

Note: if you already have `pi` installed, `tlh` does not replace it — you can keep both, as it uses its own isolated config in `~/.the-last-harness/`.

### More ways to install

- Pinned, eg `curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/download/v0.3.0/install.sh | bash`
- Main (unstable): `curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main/install.sh | bash -s -- --ref main --track ref`

### Update

You can just run `tlh update`.

The updating process is intentionally conservative, and won't replace your custom extensions, themes, and so on. If you spot anything that was overridden, [please open an issue](https://github.com/diegopetrucci/the-last-harness/issues).

Release notes are sourced from the matching `CHANGELOG.md` section. Release instructions live in [`docs/releasing.md`](docs/releasing.md).

## Miscellaneous

### Local testing

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
--track TRACK     Update track: latest-release, pinned-tag, ref, custom
--quiet          Suppress installer progress output
--verbose        Show underlying pi, npm, and git output
```

Example custom install:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | \
  TLH_UPDATE_TRACK=latest-release bash -s -- --agent-dir ~/.tlh/agent --bin-dir ~/.local/bin
```

Example pinned install:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/download/v0.3.0/install.sh | bash
```

## Update

Run the TLH update helper. This refreshes the isolated checkout according to your update track and re-merges installer defaults:

```sh
tlh update
```

Latest-release installs move to the newest GitHub Release, pinned-tag installs stay on their pinned tag, and `main`/ref installs keep following that ref. If you are updating from an older install without `tlh update`, rerun the latest-release installer once with `TLH_UPDATE_TRACK=latest-release`.

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

## Security note

The one-line installer and `tlh update` run shell commands on your machine, may install global npm packages for Pi and bundled default extensions, may download an optional Gnosis binary into the isolated TLH profile if you accept, creates an isolated Pi profile, and writes a wrapper command. Review `install.sh` before piping it to `bash` if you prefer. At launch, TLH may contact GitHub Releases to check for new TLH versions unless disabled with the update-check opt-outs above. This repo does not create, read, or modify API keys or auth files.
