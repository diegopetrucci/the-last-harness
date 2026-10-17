# Contributing to The Last Harness

Thanks for helping improve The Last Harness (`tlh`). Keep changes small, safe, and easy to review. For command examples and deeper local workflows, see [local development](docs/local-development.md). For releases, see [releasing](docs/releasing.md).

## Project invariants

- `tlh` is an isolated profile/package for the upstream Pi runtime. It must never mutate a user's normal Pi configuration, and installer and wrapper changes must keep the isolated profile, conservative settings merge, and no-clobber `--force` rules. The full list of safety invariants is in [AGENTS.md](AGENTS.md#safety-requirements).

## Development setup

Use the Node.js version required by `engines.node` in `package.json`, from the repository root. Install dependencies with:

```sh
npm ci
```

Prefer temporary directories for installer and wrapper checks so local testing does not touch a real `tlh` profile or normal Pi profile.

## Validation

Main repository validation:

```sh
npm run validate
```

That path inherits the default quiet `npm test` dot reporter. For diagnostics, the verbose reporter and the full list of what validate runs are in [VALIDATING.md](VALIDATING.md).

For installer-specific checks, use temporary paths, for example:

```sh
bash install.sh --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
```

For vendored/adapted upstream code and Pi-sensitive compatibility shims, see [docs/upstream-sync-inventory.md](docs/upstream-sync-inventory.md) before editing those areas.

Docs-only changes may use narrower validation, but inspect the rendered/content shape and review the diff before opening a PR.

## Formatting

`npm run format` (Oxfmt over `scripts/`, `tests/`, `extensions/`, and `protocol/`) is the formatter fixer; run it after editing those sources. Validation enforces the result via the `format:check` step inside `npm run validate`, so unformatted code fails CI.

## Packaged vs contributor-only files

The `files` allowlist in `package.json` defines what ships in the published npm package. `tools/` is excluded by omission because it is contributor-only tooling that never ships. The negated `docs/*` entries (for example `!docs/brand`, `!docs/local-development.md`) keep contributor-only documentation out of the tarball while still publishing the core end-user docs.

## Repo-only eval workflows

These workflows are contributor tooling for this repository only and are not part of the packaged TLH install surface. The commands, scenarios, scoring, and guardrails (live evals are opt-in and must use temp paths) are in [docs/workflow-evals.md](docs/workflow-evals.md).

## Documentation ownership

State each fact once, in its owner. Everywhere else keep at most one sentence plus a relative link to the owner's heading, and never restate values that live in code or config (versions, defaults, rosters, timeout ceilings, context caps) in prose: name the source file instead. Historical records (`CHANGELOG.md`, `release-notes/`, dated investigation docs) keep their original values.

| Topic | Owner |
| --- | --- |
| Safety invariants | [AGENTS.md](AGENTS.md#safety-requirements) |
| Install, update, uninstall, installer flags | [docs/install.md](docs/install.md) |
| Troubleshooting and recovery | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Slash commands and CLI subcommands | [docs/commands.md](docs/commands.md) |
| Subagent dispatch, supervision, skills | [docs/subagents.md](docs/subagents.md) |
| Timeout ceiling behavior | [docs/subagents.md](docs/subagents.md#timeout-ownership-and-execution-ceilings) |
| Timeout ceiling values | `extensions/subagents/src/agents/execution-ceiling.ts` |
| Project custom subagents | [docs/custom-subagents.md](docs/custom-subagents.md) |
| Model/effort behavior and project defaults | [docs/models.md](docs/models.md) |
| Per-role model/effort defaults, role roster | `agents/**/*.md` frontmatter |
| Node and dependency versions, Pi pin | `package.json`, `config/pi-runtime/package.json` ([why](docs/local-development.md#direct-dependency-pin-decisions)) |
| Bundled default extensions | `config/default-extensions.json` |
| MCP, web search, telemetry, git attribution | [docs/mcp.md](docs/mcp.md), [docs/web-search.md](docs/web-search.md), [docs/telemetry.md](docs/telemetry.md), [docs/git-attribution.md](docs/git-attribution.md) |
| Gnosis, `tk`, terminal bridge | [docs/integrations.md](docs/integrations.md) |
| Validation | [VALIDATING.md](VALIDATING.md) |
| Local development and testing | [docs/local-development.md](docs/local-development.md) |
| Workflow evals | [docs/workflow-evals.md](docs/workflow-evals.md) |
| Releases | [docs/releasing.md](docs/releasing.md) |

## Style and change expectations

- Follow the existing structure and naming in the repository.
- Shell should be Bash with `set -euo pipefail` and careful quoting.
- Node scripts are ESM and should use `node:` imports.
- Keep installer output clear and actionable.
- Update `README.md` or docs when a user-visible behavior change warrants it.
- Every PR adds a terse one-line `CHANGELOG.md` entry under `## Unreleased` with a PR link; contributor-only changes (CI, tests, docs tooling, agent instructions) go under `### Internal`.
- Avoid broad refactors or unrelated cleanup in focused changes.

### Retiring installer migrations

Migrations fall into two tiers with different removal rules:

1. **Inert migrations** (opt-out prunes, settings-key scrubs, cleanup of unread profile files) may be removed once they are at least 3 minor releases old (e.g. a migration introduced in v0.40 becomes removable in v0.43).
2. **Protective migrations** (force-removal of packages that conflict with first-party features, PATH-visible artifact cleanup, physical cleanup of retired subagent packages) require an aggregate `Tlh.App.version` telemetry check before removal to confirm adoption is negligible — see [docs/local-development.md#telemetrydeck-mcp-contributors-only](docs/local-development.md#telemetrydeck-mcp-contributors-only).

The provenance-gated and force-removal mechanisms themselves stay in place while any active source still uses them.

## Pull requests and CI

Before requesting review, work through the checklist in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md); it covers the safety invariants, tests, docs and `CHANGELOG.md`, and secret/path hygiene.

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
