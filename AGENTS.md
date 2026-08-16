# Repository Guidelines

## Project Purpose

This repository packages **The Last Harness** as an isolated profile for the upstream Pi coding agent. The installer must provide a `tlh` command without modifying a user's normal Pi configuration under `~/.pi/agent`.

## Project Structure

- Installer entrypoints: `install.sh` performs install/update bootstrap work and creates the `tlh` wrapper; `uninstall.sh` removes the isolated profile and managed wrapper artifacts.
- Installer/runtime scripts: `scripts/` contains installer, update, doctor, wrapper, merge, runtime-TypeScript, release-notes, ticket helpers, and legacy-profile cleanup support; `scripts/lib/` holds shared installer modules; `scripts/installer-smoke/` contains staged smoke-test helpers; `scripts/check-installer-smoke.sh`, `scripts/check-package-versions.mjs`, `scripts/check-startup-performance.mjs`, and `scripts/check-lazy-import-boundaries.mjs` are contributor-facing validation checks.
- Packaged profile defaults: `config/` contains installer-owned settings, keybindings, librarian defaults, bundled extension manifests, and appended system prompt text for the isolated profile.
- Packaged resources: `extensions/`, `prompts/`, and `themes/` are published package resources. First-party subagent orchestration lives under `extensions/subagents/`; its `.ts` files are authoritative and same-layout `.js` files are generated, while imported tests stay in the repository/CI and are excluded from publication. `skills/` is an intentional future package placeholder and is not currently present in this repository (per Gnosis `zeqwga`).
- Agent definitions: `agents/primary/` and `agents/subagents/` hold packaged primary-agent and subagent prompt specs used by tlh.
- Tests and evals: `tests/` contains the automated test suite and fixture helpers, while `tests/evals/` contains deterministic workflow/trace-policy checks plus opt-in live-eval tooling.
- Contributor automation: `.github/workflows/` defines CI, release, startup-performance, and Claude automation; `.github/PULL_REQUEST_TEMPLATE.md` provides PR guidance.
- Contributor-local tooling: `.pi/` stores repo-local prompts and skills for contributors, `.gnosis/entries.jsonl` stores repo-local Gnosis memory, and `.symphony/setup` contains local dependency setup automation.
- Repository illustrations: `assets/` stores documentation and workflow illustrations used in the repository and is not shipped in the npm package.
- Contributor docs: `README.md` covers install/update/uninstall and security, `CONTRIBUTING.md` explains contribution workflow, `VALIDATING.md` and `npm run validate` define the standard validation pass, `CHANGELOG.md` tracks releases, and `VISION.md` captures product direction.
- Extended docs: `docs/` contains install, integration, MCP, telemetry, local-development, release, workflow-eval, and web-search reference material. `docs/subagents.md` documents the first-party runtime; `docs/subagents-history/` preserves its provenance, including an immutable archive whose directories must never be used as a task working directory.
- Package/tooling manifests: `package.json`, `package-lock.json`, `.oxfmtrc.json`, `tsconfig.json`, and `tsconfig.runtime-scripts.json` define the Node package, Oxlint/Oxfmt linting and formatting, and TypeScript settings used by contributors and validation.

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

Run this before considering changes ready:

```sh
npm run validate
```

Useful targeted checks:

```sh
bash -n install.sh
node --check scripts/tlh-gnosis.mjs
bash install.sh --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
bash -s -- --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)" < install.sh
npm run lint:sh
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

## Github issues and projects

- Every GitHub issue should carry a type label (`bug`/`enhancement`/`documentation`) plus an `area/*` label, and be tracked in the TLH Roadmap project.
- If a Github issue is picked up, move it to `In Progress` in the [TLH Roadmap](https://github.com/users/diegopetrucci/projects/1/views/1?layout=board). Once work is merged, move it to `Ready for release`. If released, tag it with the release it went out with, and move it to `Done`.

## Memory

- At the start of any task, run `gn help plan` and follow its instructions.
- After finishing a task, run `gn help review`.
- Always commit gnosis entries with the relevant work.
- Always merge gnosis conflicts as a union, keeping both sides.

## Miscellaneous

- Before final handoff or review for TLH repository work, load and apply the repo-local hygiene skill at `.pi/skills/tlh-dev-hygiene/SKILL.md`.
- The `tlh-dev-hygiene` checklist is for TLH repository contributors only; it is not part of the packaged end-user tlh workflow.
- For TypeScript boundary parsing or open-object decisions, load `.pi/skills/tlh-typescript-boundaries/SKILL.md`.
- This project uses a CLI ticket system for task management. Run `tk help` when you need to use it.
- If the human links you a PR comments, or pastes you one, do not take it at face value — instead, investigate if valid and report back first. Do not start fixing it immediately.
- If the human asks you to open a PR, after creating it check CI/status checks and investigate PR comments/review comments. Address valid findings; resolve or dismiss invalid or non-actionable comments with rationale.
