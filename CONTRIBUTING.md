# Contributing to The Last Harness

Thanks for helping improve The Last Harness (`tlh`). Keep changes small, safe, and easy to review. For command examples and deeper local workflows, see [local development](docs/local-development.md). For releases, see [releasing](docs/releasing.md).

## Project invariants

- `tlh` is an isolated profile/package for the upstream Pi runtime.
- Do not overwrite or mutate a user's normal Pi configuration at `~/.pi/agent`.
- The default isolated profile is `~/.the-last-harness/agent`; the default wrapper path is `~/.local/bin/tlh`.
- Installer-created Pi commands must set `PI_CODING_AGENT_DIR` to the isolated profile directory.
- The generated `tlh` wrapper should run upstream `pi` with that isolated profile, except for installer-owned helper subcommands such as `tlh defaults`.
- Preserve user-owned isolated-profile settings. Merge defaults conservatively, respect opt-outs, and back up existing settings before writes.
- Do not clobber unmanaged wrapper files unless the user explicitly passes `--force`.

## Development setup

Use Node.js >=22.19.0 from the repository root. Install dependencies with the committed lockfile:

```sh
npm install --legacy-peer-deps
```

That install runs the package `prepare` step, which installs the local Husky hooks for this clone.

Prefer temporary directories for installer and wrapper checks so local testing does not touch a real `tlh` profile or normal Pi profile.

## Validation

Main repository validation:

```sh
npm run validate
```

The installed Husky `pre-push` hook runs that same `npm run validate` command before `git push`. If you intentionally need to bypass local hooks for a specific push, use `git push --no-verify` and be explicit about why.

For installer-specific checks, use temporary paths, for example:

```sh
bash install.sh --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
```

Docs-only changes may use narrower validation, but inspect the rendered/content shape and review the diff before opening a PR.

## Style and change expectations

- Follow the existing structure and naming in the repository.
- Shell should be Bash with `set -euo pipefail` and careful quoting.
- Node scripts are ESM and should use `node:` imports.
- Keep installer output clear and actionable.
- Update `README.md`, docs, or `CHANGELOG.md` when a user-visible behavior change warrants it.
- Avoid broad refactors or unrelated cleanup in focused changes.

## Pull requests and CI

Before requesting review, check that:

- the change preserves the isolation and installer safety invariants above;
- relevant tests or smoke checks pass;
- docs and changelog updates are included when needed;
- the diff contains no secrets, local paths, or unintended generated files.

CI runs on `pull_request` and on `push` to `main`. The CI job/status name is `Repository validation`, and current GitHub repository rulesets protect the default branch/main and require that status check before merge. Required-merge enforcement is controlled by repository rules and settings, not by this file.

## Releases

Releases are tag based and do not use a `stable` branch. Follow [docs/releasing.md](docs/releasing.md) for version preparation, validation, tag publishing, and release asset checks.
