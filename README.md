# The last harness you'll ever need.

This repo is a [Pi](https://github.com/earendil-works/pi) package plus a one-line installer. It installs upstream Pi if needed, creates a separate The Last Harness Pi profile, and adds a `tlh` wrapper command.

Normal `pi` config under `~/.pi/agent` is not modified.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main/install.sh | bash
```

And start it with: `tlh`.

## What the installer does

1. Checks for `node`, `npm`, and `git`.
2. Installs upstream Pi if `pi` is missing:

   ```sh
   npm install -g @earendil-works/pi-coding-agent
   ```

3. Creates an isolated Pi agent directory:

   ```text
   ~/.the-last-harness/agent
   ```

4. Installs this repo as a Pi package inside that isolated profile:

   ```sh
   PI_CODING_AGENT_DIR="$HOME/.the-last-harness/agent" \
     pi install git:github.com/diegopetrucci/the-last-harness
   ```

5. Merges defaults from `config/settings.defaults.json` into:

   ```text
   ~/.the-last-harness/agent/settings.json
   ```

6. Creates a wrapper command:

   ```text
   ~/.local/bin/tlh
   ```

The settings merge is intentionally conservative:

- appends this package to isolated `packages` if missing
- sets `theme` only when no theme is already configured in the isolated profile
- preserves existing isolated user values by default
- creates a timestamped backup before modifying an existing isolated settings file

## Isolation model

`tlh` is a thin wrapper around upstream Pi:

```sh
PI_CODING_AGENT_DIR="$HOME/.the-last-harness/agent" pi "$@"
```

So:

- `tlh` uses `~/.the-last-harness/agent/settings.json`
- normal `pi` uses `~/.pi/agent/settings.json`
- the installer does not write normal Pi settings or auth files

Caveat: Pi project settings such as `.pi/settings.json` can still apply when running `tlh` inside a project, because that is core Pi behavior. The isolation is for the global Pi profile.

## Included Pi resources

- `extensions/the-last-harness.ts` adds the custom `tlh` startup header, lightweight default guidance, `/tlh` status, and `/effort` reasoning-effort picker commands.
- `skills/harness-setup/SKILL.md` documents safe setup/update/uninstall workflows.
- `prompts/harness-plan.md` provides `/harness-plan` for reviewable implementation planning.
- `themes/the-last-harness.json` provides the default isolated theme.

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

To test installer wrapper behavior, dry-run first with temporary paths:

```sh
bash install.sh --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
```

## Manual install

```sh
npm install -g @earendil-works/pi-coding-agent
mkdir -p "$HOME/.the-last-harness/agent"
PI_CODING_AGENT_DIR="$HOME/.the-last-harness/agent" \
  pi install git:github.com/diegopetrucci/the-last-harness
node scripts/merge-settings.mjs \
  config/settings.defaults.json \
  --settings "$HOME/.the-last-harness/agent/settings.json"
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
--no-settings    Install the package but skip isolated settings merge
--no-wrapper     Skip creating the tlh wrapper command
--agent-dir DIR  Isolated Pi agent dir, default ~/.the-last-harness/agent
--bin-dir DIR    Wrapper install dir, default ~/.local/bin
--wrapper-name N Wrapper command name, default tlh
--ref REF        Install from a branch, tag, or commit
```

Example custom install:

```sh
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main/install.sh | \
  bash -s -- --agent-dir ~/.tlh/agent --bin-dir ~/.local/bin
```

Example pinned install:

```sh
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main/install.sh | bash -s -- --ref v0.1.0
```

## Update

Re-run the installer, or run:

```sh
PI_CODING_AGENT_DIR="$HOME/.the-last-harness/agent" \
  pi update git:github.com/diegopetrucci/the-last-harness
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

The one-line installer runs shell commands on your machine, may install a global npm package, creates an isolated Pi profile, and writes a wrapper command. Review `install.sh` before piping it to `bash` if you prefer. This repo does not create, read, or modify API keys or auth files.
