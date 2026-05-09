---
name: harness-setup
description: Use when installing, updating, auditing, or uninstalling The Last Harness isolated Pi package or one-line installer. Covers the tlh wrapper, isolated Pi profile, settings merges, and rollback documentation.
---

# Harness Setup

Use this workflow when changing this repository's Pi package, one-line installer, isolated `tlh` wrapper, or persistent settings behavior.

## Checklist

1. Keep upstream Pi as the runtime unless the user explicitly asks for a forked/rebranded binary.
2. Keep The Last Harness isolated from normal Pi:
   - normal Pi uses `~/.pi/agent`
   - `tlh` uses `~/.the-last-harness/agent` by default
   - installer Pi commands must set `PI_CODING_AGENT_DIR` to the isolated agent dir
3. Put shareable Pi resources in package directories:
   - `extensions/`
   - `skills/`
   - `prompts/`
   - `themes/`
4. Put installer-owned default settings in `config/settings.defaults.json`.
5. Merge settings conservatively into the isolated settings file only:
   - append missing `packages` entries
   - preserve existing isolated user values by default
   - require `--force` before overwriting scalar values
   - back up existing isolated settings before writing
6. Keep the installer idempotent. Running it twice should not duplicate package entries or clobber user settings.
7. Document every persistent change and the uninstall path.

## Validation

Before release, run:

```bash
bash -n install.sh
node --check scripts/merge-settings.mjs
node scripts/merge-settings.mjs --dry-run
npm pack --dry-run
```

For install behavior, test with temporary isolated paths:

```bash
agent_dir="$(mktemp -d)/agent"
bin_dir="$(mktemp -d)"
bash install.sh --dry-run --agent-dir "$agent_dir" --bin-dir "$bin_dir"
```

Verify dry runs do not write:

```bash
test ! -e "$agent_dir/settings.json"
test ! -e "$bin_dir/tlh"
```

## Rollback guidance

Tell users they can remove the isolated wrapper and profile with:

```bash
rm -f ~/.local/bin/tlh
rm -rf ~/.the-last-harness
```

Normal `~/.pi/agent` settings are intentionally not modified by this installer.
