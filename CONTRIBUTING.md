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

Use Node.js >=22.19.0 from the repository root. Install dependencies with:

```sh
npm ci
```

Prefer temporary directories for installer and wrapper checks so local testing does not touch a real `tlh` profile or normal Pi profile.

## Validation

Main repository validation:

```sh
npm run validate
```

That path inherits the default quiet `npm test` dot reporter. If you need the full Node test reporter while diagnosing a failure, rerun tests with:

```sh
npm run test:verbose
```

For installer-specific checks, use temporary paths, for example:

```sh
bash install.sh --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
```

For vendored/adapted upstream code and Pi-sensitive compatibility shims, see [docs/upstream-sync-inventory.md](docs/upstream-sync-inventory.md) before editing those areas.

Docs-only changes may use narrower validation, but inspect the rendered/content shape and review the diff before opening a PR.

## Formatting

`npm run format` (Oxfmt over `scripts/`, `tests/`, and `extensions/`) is the formatter fixer; run it after editing those sources. Validation enforces the result via the `format:check` step inside `npm run validate`, so unformatted code fails CI.

## Packaged vs contributor-only files

The `files` allowlist in `package.json` defines what ships in the published npm package. `tools/` is excluded by omission because it is contributor-only tooling that never ships. The negated `docs/*` entries (for example `!docs/subagents-history`, `!docs/brand`, `!docs/local-development.md`) keep contributor-only documentation out of the tarball while still publishing the core end-user docs.

## Refresh the Understand Anything graph when needed

If your change materially affects repository architecture, repository structure, or documented contributor workflows, refresh the tracked Understand Anything graph before opening a PR. From the repository root, start an interactive TLH or upstream Pi session, then enable the Understand Anything skill/extension in that session before running `/understand`. TLH does not expose `/understand` by default. Use `/understand --full` only when an incremental refresh is not enough.

Review the resulting `.understand-anything/knowledge-graph.json`, `.understand-anything/meta.json`, `.understand-anything/fingerprints.json`, and `.understand-anything/intermediate/scan-result.json` changes before committing them. Only commit those generated updates when the graph refresh is warranted by the change; skip incidental churn for unrelated work.

## Repo-only eval workflows

These workflows are contributor tooling for this repository only. They are not part of the packaged TLH install surface.

For the full workflow-eval guide, including scenario details, scoring, and boundaries, see [docs/workflow-evals.md](docs/workflow-evals.md).

Quick reference:

- Default contributor/CI path: `npm run validate`
- Workflow-specific deterministic checks: `node --test tests/hermetic-core-workflow.test.mjs tests/evals/trace-policy/trace-policy-evals.test.mjs tests/evals/tlh-live-evals.test.mjs tests/evals/tlh-live-eval-results.test.mjs`
- Discover live scenarios: `node tests/evals/tlh-live-evals.mjs --list`
- Run automated install/update smoke: `node tests/evals/tlh-live-evals.mjs --run --scenario install-update-smoke`
- Prepare a manual architect workflow eval: `TLH_RUN_LIVE_EVALS=1 node tests/evals/tlh-live-evals.mjs --scenario architect-e2e`

Guardrails to remember:

- Keep the stack deterministic-first and use the lightest tier that answers your question.
- The hermetic core-workflow integration test is deterministic and included in normal `npm test` / `npm run validate`.
- Live evals are opt-in and not part of normal `npm run validate` or default CI.
- Keep all live evals pointed at temp paths; never reuse real `~/.the-last-harness/agent`, `~/.pi/agent`, or normal shell wrapper paths.
- Do not commit `results.json`, temp workspaces, or per-run score snapshots.

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

Every PR description should end with an `Install this branch` command using the branch name in both the raw URL and `--ref` value:

```sh
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/<branch>/install.sh | bash -s -- --ref <branch> --track ref
```

**Pin PRs** — PRs that update a still-external component's `config/default-extensions.json` fork tag (e.g. `tlh-vX.Y.Z-N`) — are manually authored. Use a consistent title and body:

- **Title:** `Pin <component> to <tag> (<brief note>)`
- **Body checklist:**
  - What the new fork tag/pin includes
  - Link to the merged fork PR
  - Before → after pin (e.g. `tlh-vX.Y.Z-M` → `tlh-vX.Y.Z-N`)
  - Validation: `npm run validate` result

The `Install this branch` command above applies to pin PRs too. Subagents are first-party TLH code under `extensions/subagents/`, so do not open standalone subagent pin, publish, release, or fork-sync PRs; develop and validate that runtime as part of the root package per [docs/local-development.md](docs/local-development.md).

CI runs on `pull_request` and on `push` to `main`. The CI workflow has three jobs: `Linting and formatting` (ubuntu-only, runs lint/format/shellcheck), `Non-test validation` (ubuntu + macOS, runs all other non-test checks), and `Tests` (ubuntu + macOS, two shards). Which status checks are required for merge is configured in GitHub repository rulesets — that is the source of truth, not this file.

## Releases

Releases are tag based and do not use a `stable` branch. Follow [docs/releasing.md](docs/releasing.md) for version preparation, validation, tag publishing, and release asset checks.
