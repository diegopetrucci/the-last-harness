# Repository Guidelines

## Project Purpose

This repository packages **The Last Harness** as an isolated profile for the upstream Pi coding agent. The installer must provide a `tlh` command without modifying a user's normal Pi configuration under `~/.pi/agent`.

## Project Structure

- `install.sh` — one-line installer and `tlh` wrapper creator.
- `scripts/merge-settings.mjs` — conservative settings merge helper for the isolated profile.
- `scripts/tlh-defaults.mjs` — manages persistent opt-outs for bundled default extensions.
- `scripts/tlh-gnosis.mjs` — manages Gnosis integration settings for the isolated profile.
- `config/settings.defaults.json` — installer-owned default Pi settings.
- `config/default-extensions.json` — bundled default extension package manifest.
- `config/APPEND_SYSTEM.md` — packaged system-prompt guidance.
- `extensions/` — Pi extensions exposed by `package.json`.
- `skills/` — Pi skills exposed by `package.json`.
- `prompts/` — Pi prompt templates exposed by `package.json`.
- `themes/` — Pi themes exposed by `package.json`.
- `README.md` — public install, update, uninstall, and security documentation.
- `CHANGELOG.md` — release notes for versioned releases.
- `docs/releasing.md` — tag-based release checklist and process.
- `.github/workflows/release.yml` — tag-triggered GitHub Release workflow.

## Safety Requirements

- Never overwrite or mutate normal Pi config at `~/.pi/agent`.
- Installer Pi commands must set `PI_CODING_AGENT_DIR` to the isolated profile directory.
- Default isolated profile path: `~/.the-last-harness/agent`.
- Default wrapper path: `~/.local/bin/tlh`.
- The generated `tlh` wrapper should run upstream `pi` with the isolated `PI_CODING_AGENT_DIR`, except for installer-owned helper subcommands such as `tlh defaults`.
- Keep settings merges conservative: append missing packages, respect `tlh.disabledDefaultExtensions`, preserve existing isolated user values, and back up existing isolated settings before writes.
- Public installs should use GitHub Release installer assets or explicit version tags; do not rely on a `stable` branch.
- Do not clobber unmanaged files when creating wrappers; require explicit `--force` for overwrites.

## Development Commands

Run these before considering changes ready:

```sh
bash scripts/check-installer-smoke.sh
npm run lint
node scripts/merge-settings.mjs --dry-run
npm pack --dry-run
```

Useful targeted checks:

```sh
bash -n install.sh
node --check scripts/tlh-gnosis.mjs
bash install.sh --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
bash -s -- --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)" < install.sh
```

For installer tests, prefer temporary `--agent-dir` and `--bin-dir` values. Do not run a real install into home directories unless the user explicitly asks.

## Coding Style

- Shell scripts should use Bash with `set -euo pipefail` and careful quoting.
- Node scripts are ESM (`type: module`) and should use `node:` imports.
- Keep installer output clear and actionable.
- Keep package resources small, reviewable, and documented in `README.md`.
- After implementing a feature or notable behavior change, consider whether `README.md` should be updated before calling the work complete.
- Prefer explicit paths over implicit environment defaults when writing settings.

## Commit Guidelines

- Use short imperative commit subjects, e.g. `Add isolated tlh installer`.
- Scope commits to one logical change.
- Before committing, review staged files with:

```sh
git diff --cached --stat
git diff --cached
```

## Miscellaneous

- At the start of any task, run `gn help plan` and follow its instructions.
- After finishing a task, run `gn help review`.
- This project uses a CLI ticket system for task management. Run `tk help` when you need to use it.
