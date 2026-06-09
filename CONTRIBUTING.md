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
npm install --no-package-lock --legacy-peer-deps
```

Prefer temporary directories for installer and wrapper checks so local testing does not touch a real `tlh` profile or normal Pi profile.

## Validation

Main repository validation:

```sh
npm run validate
```

For installer-specific checks, use temporary paths, for example:

```sh
bash install.sh --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
```

Docs-only changes may use narrower validation, but inspect the rendered/content shape and review the diff before opening a PR.

## Refresh the Understand Anything graph when needed

If your change materially affects repository architecture, repository structure, or documented contributor workflows, refresh the tracked Understand Anything graph before opening a PR. From the repository root, start an interactive TLH or upstream Pi session, then enable the Understand Anything skill/extension in that session before running `/understand`. TLH does not expose `/understand` by default. Use `/understand --full` only when an incremental refresh is not enough.

Review the resulting `.understand-anything/knowledge-graph.json`, `.understand-anything/meta.json`, `.understand-anything/fingerprints.json`, and `.understand-anything/intermediate/scan-result.json` changes before committing them. Only commit those generated updates when the graph refresh is warranted by the change; skip incidental churn for unrelated work.

## Repo-only eval workflows

These workflows are contributor tooling for this repository only. They are not part of the packaged TLH install surface.

Use the lightest tier that answers your question:

| Tier | Default path | When to use it | Commands |
| --- | --- | --- | --- |
| Deterministic repo-local validation | Yes; this is the normal CI/local path | Most changes | `npm run validate` |
| Simulated policy/contract evals | Included inside `npm test` | Editing agent prompts, transcript/policy logic, or live-eval docs/contracts | `node --test tests/trace-policy-evals.test.mjs tests/agent-prompt-contracts.test.mjs tests/tlh-live-evals.test.mjs tests/tlh-live-eval-results.test.mjs` |
| Live isolated smoke/manual scaffolds | No; opt-in only | You need real model, network, or install/update behavior | `node tests/evals/tlh-live-evals.mjs --list`<br>`node tests/evals/tlh-live-evals.mjs --run --scenario install-update-smoke`<br>`TLH_RUN_LIVE_EVALS=1 node tests/evals/tlh-live-evals.mjs --scenario architect-e2e` |
| Release/published-asset checks | No; manual only | Verifying a pushed tag or GitHub Release asset | See [`docs/releasing.md`](docs/releasing.md#install-checks) |

The simulated tier is still deterministic and repo-local. Today that means:

- `tests/trace-policy-evals.test.mjs` for transcript fixtures that exercise architect/Rush/product/bug-hunter/web-scout/oracle policy boundaries.
- `tests/agent-prompt-contracts.test.mjs` for prompt tool contracts and required workflow anchors.
- `tests/tlh-live-evals.test.mjs` for the live-eval runner contract, scenario list, repo-only command surface, and packaging guardrails.
- `tests/tlh-live-eval-results.test.mjs` for the structured score/result schema and external results-file behavior.

### Opt-in live eval runner

Use the live eval runner only when you explicitly want real model, network, or install/update smoke coverage. It is never part of `npm run validate`.

List the available scenarios and prerequisites:

```sh
node tests/evals/tlh-live-evals.mjs --list
```

Run one or more scenarios with a temp `HOME`, isolated agent dir, isolated bin dir, fixture repos, per-step timeouts, and redacted saved artifacts:

```sh
node tests/evals/tlh-live-evals.mjs --run --scenario install-update-smoke
TLH_RUN_LIVE_EVALS=1 node tests/evals/tlh-live-evals.mjs --scenario architect-e2e
```

Runner behavior and safety constraints:

- Running without `--run`, or with `--list`, only prints the scenario list and prerequisites.
- `--run` or `TLH_RUN_LIVE_EVALS=1` is required to execute anything.
- The runner creates an isolated temp root containing `home/`, `agent/`, `bin/`, `workspace/`, a top-level `README.md`, a top-level `results.json`, and per-scenario artifacts under `artifacts/<scenario>/`. If you pass `--artifacts-dir DIR`, TLH creates a fresh `tlh-live-evals-*` child workspace under that parent instead of writing those top-level files directly into `DIR`.
- Saved artifacts redact the temp paths plus environment values whose names look secret-bearing (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `COOKIE`, `SESSION`, `BEARER`). Review artifacts before sharing them.
- Per-run score results stay ephemeral by default. Use `--results-file /path/to/results.json` only when you explicitly want a redacted JSON artifact outside the temp workspace.
- Manual scenarios always keep the workspace. Automated-only success deletes it unless you pass `--keep-artifacts`; specifying `--artifacts-dir DIR` also keeps the fresh child workspace under that parent for inspection.
- Cleanup is always the printed `rm -rf ...` command. Removing that temp root fully undoes the live eval.
- Keep all live evals pointed at temp paths; do not reuse your real `~/.the-last-harness/agent`, `~/.pi/agent`, or normal shell wrapper paths.
- Keep secrets in environment variables or isolated config only. Do not paste keys into fixture files or committed docs.

### How TLH scores evals

- Deterministic repo-local validation and simulated policy/contract evals are binary pass/fail. Their score is the command exit status from `npm run validate` or the targeted `node --test ...` invocation, and they do not create or commit per-run `results.json` artifacts.
- The live runner writes one structured `results.json` at the temp workspace root plus a human-readable top-level `README.md`. The JSON stores one result per selected scenario, scenario status (`passed`, `prepared`, or `failed`), check/rubric details, artifact paths, and suite-wide aggregate counts.
- Automated live scenarios also score as binary pass/fail. For `install-update-smoke`, the scenario result aggregates bootstrap install, `tlh defaults list`, `tlh update`, and install-state verification. The scenario only passes when every automated check passes, and the suite summary rolls those counts up across all selected scenarios.
- Manual live scenarios use pending rubric items instead of pretending the runner knows the answer. The runner marks them `prepared`, records the rubric criteria in `results.json`, and expects a human to inspect `artifacts/<scenario>/README.md`, logs, and workspace state before assigning the final pass/fail judgment.
- Live model/network behavior can vary. If a live result matters for a PR or release call, run the same scenario more than once, compare `results.json` and artifacts across runs, and summarize any variance instead of treating one run as definitive.
- By default, live results stay inside the temp workspace and should remain local or CI-only artifacts. Use `--results-file /path/to/results.json` only when you need an external redacted copy, then delete the temp root with the printed `rm -rf ...` command when you are done.
- Never commit `results.json`, temp workspaces, or per-run score snapshots. Even with redaction in place, review artifacts before sharing them and keep secrets confined to isolated environment variables or isolated config.

Current scenarios cover:

| Scenario | Mode | Prerequisites | What it prepares or verifies |
| --- | --- | --- | --- |
| `architect-e2e` | Manual scaffold | `interactive terminal`; `model auth`; `bash`; `node`; `npm`; `git`; `network access when install/default-extension setup needs it` | Creates a tiny fixture repo plus `artifacts/architect-e2e/README.md`. Verify architect stays orchestration-only, uses ticket approval/developer flow, and keeps all edits inside the fixture repo. |
| `rush-product-bug-hunter` | Manual scaffold | `interactive terminal`; `model auth`; `bash`; `node`; `npm`; `git`; `network access when install/default-extension setup needs it` | Creates one fixture repo plus prompts for Rush, product, and bug-hunter boundary checks in `artifacts/rush-product-bug-hunter/README.md`. |
| `web-scout-network-research` | Manual scaffold | `interactive terminal`; `model auth`; `bash`; `node`; `npm`; `git`; `network access (required for research; install/default-extension setup may also need it)`; `EXA_API_KEY or equivalent isolated config` | Creates a research brief and `artifacts/web-scout-network-research/README.md`. Verify real network research, citations, and that saved artifacts stay free of secrets. |
| `dirty-repo-guard` | Manual scaffold | `interactive terminal`; `bash`; `node`; `npm`; `git`; `network access when install/default-extension setup needs it` | Creates an intentionally dirty fixture repo plus `artifacts/dirty-repo-guard/README.md`. Verify the startup warning/prompt appears before work that could hide the uncommitted change. |
| `install-update-smoke` | Automated | `bash`; `node`; `npm`; `git`; `network access when install/default-extension setup needs it` | Runs a real isolated install from `file:$PWD`, then `tlh defaults list` and `tlh update --track custom --package-source file:$PWD`. Logs land in `artifacts/install-update-smoke/defaults-list.log` and `artifacts/install-update-smoke/update.log`. |

The model/TUI scenarios stay manual on purpose: fully automating live provider behavior and interactive transcripts here would be brittle and unsafe for default CI.

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

CI runs on `pull_request` and on `push` to `main`. The CI job/status name is `Repository validation`, and current GitHub repository rulesets protect the default branch/main and require that status check before merge. Required-merge enforcement is controlled by repository rules and settings, not by this file.

## Releases

Releases are tag based and do not use a `stable` branch. Follow [docs/releasing.md](docs/releasing.md) for version preparation, validation, tag publishing, and release asset checks.
