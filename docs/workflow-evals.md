# Workflow evals

This page describes the contributor-facing workflow eval suite for TLH repository work. It follows the issue #241 decisions: keep evals deterministic-first, keep live evals opt-in, do not add a primary-agent auto-switching gate, and do not use an LLM-as-judge gate.

These evals are repository contributor tooling only. They are not part of the packaged TLH install surface.

## Eval tiers

Use the lightest tier that answers the question you have:

| Tier | Default path | What it covers | Commands |
| --- | --- | --- | --- |
| Deterministic repo-local validation | Yes | Normal contributor and CI validation | `npm run validate` |
| Deterministic workflow evals | Yes, through targeted `node --test` commands | Trace-policy fixtures, incident coverage, prompt contracts, and live-runner/result contracts | `node --test tests/evals/trace-policy/trace-policy-evals.test.mjs tests/evals/trace-policy/trace-policy-incident-matrix.test.mjs tests/agent-prompt-contracts.test.mjs tests/evals/tlh-live-evals.test.mjs tests/evals/tlh-live-eval-results.test.mjs` |
| Live isolated evals | No; opt-in only | Real model, network, install, and interactive smoke coverage | `node tests/evals/tlh-live-evals.mjs --list`<br>`node tests/evals/tlh-live-evals.mjs --run --scenario install-update-smoke`<br>`TLH_RUN_LIVE_EVALS=1 node tests/evals/tlh-live-evals.mjs --scenario architect-e2e` |
| Release-tier published-asset checks | No; manual only | Tag/release install verification | See [`docs/releasing.md`](./releasing.md#install-checks) |

## Deterministic workflow evals

The deterministic workflow suite is the main contributor-facing guardrail for workflow behavior.

### Trace-policy fixtures

`tests/evals/trace-policy/trace-policy-evals.test.mjs` replays curated transcript fixtures against deterministic policy assertions. Use it when changing agent prompts, workflow rules, transcript interpretation, or policy-sensitive docs.

The fixtures are designed to stay reviewable:

- explicit actor/tool/output sequences;
- stable fixture IDs and expected outcomes;
- deterministic assertions instead of model scoring;
- coverage for architect, developer, code-reviewer, product, Rush, bug-hunter, web-scout, and oracle boundaries.

### Incident matrix

`tests/evals/trace-policy/trace-policy-incident-matrix.test.mjs` keeps milestone and incident coverage explicit. It complements the fixture tests by asserting that the tracked workflow incidents remain represented and well-formed.

Use the incident matrix when you need to answer: "do we still cover the concrete regressions that motivated this workflow rule?"

### Related contract tests

The deterministic workflow tier also includes:

- `tests/agent-prompt-contracts.test.mjs` for required prompt/tool contract anchors.
- `tests/evals/tlh-live-evals.test.mjs` for live runner behavior, scenario inventory, and repo-only command-surface guardrails.
- `tests/evals/tlh-live-eval-results.test.mjs` for the structured `results.json` schema and external results-file rules.

## Live eval runner

Use live evals only when you explicitly need real runtime behavior that deterministic tests cannot provide. They are opt-in, contributor-invoked, and release-tier/manual by default.

List scenarios and prerequisites:

```sh
node tests/evals/tlh-live-evals.mjs --list
```

Run specific scenarios:

```sh
node tests/evals/tlh-live-evals.mjs --run --scenario install-update-smoke
TLH_RUN_LIVE_EVALS=1 node tests/evals/tlh-live-evals.mjs --scenario architect-e2e
```

### Safety and cleanup

The live runner is intentionally conservative:

- Nothing runs unless you pass `--run` or set `TLH_RUN_LIVE_EVALS=1`.
- Each run uses an isolated temp root with its own `home/`, `agent/`, `bin/`, `workspace/`, `artifacts/`, top-level `README.md`, and top-level `results.json`.
- `--artifacts-dir DIR` creates a fresh `tlh-live-evals-*` child workspace under `DIR` instead of writing directly into `DIR`.
- Automated-only success removes the temp workspace unless you pass `--keep-artifacts`.
- Manual scenarios keep the workspace so a human can inspect it.
- Cleanup is the printed `rm -rf ...` command. Removing that temp root fully undoes the live eval.
- Keep all live evals pointed at temp paths; never reuse real `~/.the-last-harness/agent`, `~/.pi/agent`, or normal shell wrapper paths.
- Keep secrets in environment variables or isolated config only. Do not paste them into fixture files or checked-in docs.

### Scenario modes

Current scenarios are split on purpose:

| Scenario | Mode | What it checks |
| --- | --- | --- |
| `architect-e2e` | Manual scaffold | Ticketed architect-to-developer flow and orchestration-only behavior |
| `rush-product-bug-hunter` | Manual scaffold | Primary boundary checks for Rush, product, and bug-hunter |
| `web-scout-network-research` | Manual scaffold | Real network research flow, citations, and secret-safe artifact handling |
| `dirty-repo-guard` | Manual scaffold | Startup warning behavior for dirty repos |
| `install-update-smoke` | Automated | Isolated install, `tlh defaults list`, and `tlh update` smoke coverage |

The model/TUI scenarios remain manual because automating live provider behavior and interactive transcripts would be brittle and unsafe for normal CI.

## Results schema and scoring

Workflow eval scoring stays reviewable.

- Deterministic workflow evals are binary pass/fail from command exit status.
- Live automated scenarios are also binary pass/fail, but they additionally record detailed check results in `results.json`.
- Live manual scenarios do not pretend the runner can judge quality. They use pending rubric items and remain `prepared` until a human reviews the artifacts.

The live runner writes:

- a top-level `results.json` inside the temp workspace;
- a top-level `README.md` summarizing the run;
- per-scenario artifacts under `artifacts/<scenario>/`.

The structured result schema includes:

- one result entry per selected scenario;
- scenario status values such as `passed`, `prepared`, or `failed`;
- per-check details and artifact paths;
- suite-level aggregate counts for automated and manual checks.

Use `--results-file /path/to/results.json` only when you explicitly want a redacted copy outside the temp workspace. Do not commit `results.json`, temp workspaces, or per-run score snapshots.

If a live result matters for a release or high-confidence workflow decision, rerun the same scenario and compare artifacts instead of treating one live run as definitive.

## Commands by common intent

- Normal contributor validation: `npm run validate`
- Workflow-specific deterministic checks: `node --test tests/evals/trace-policy/trace-policy-evals.test.mjs tests/evals/trace-policy/trace-policy-incident-matrix.test.mjs tests/agent-prompt-contracts.test.mjs tests/evals/tlh-live-evals.test.mjs tests/evals/tlh-live-eval-results.test.mjs`
- Discover live scenarios: `node tests/evals/tlh-live-evals.mjs --list`
- Run automated install/update smoke: `node tests/evals/tlh-live-evals.mjs --run --scenario install-update-smoke`
- Prepare a manual architect workflow eval: `TLH_RUN_LIVE_EVALS=1 node tests/evals/tlh-live-evals.mjs --scenario architect-e2e`

## Boundaries and non-goals

Keep workflow evals scoped to stable, reviewable signals:

- Deterministic incident regressions come first.
- Live evals are opt-in and release-tier/manual, not part of normal `npm run validate` or default CI.
- No primary-agent auto-switching gate: launch the intended primary explicitly for a scenario and evaluate that run as-is.
- No LLM-as-judge gate: pass/fail comes from deterministic checks or a human reviewer reading prepared artifacts.
- Workflow evals are for contributor confidence, not for changing packaged TLH behavior or adding hidden runtime routing.

## Future real-session trace normalization

Future coverage may add curated real-session regressions derived from exported TLH or upstream Pi session JSONL files, but only after they are normalized into a stable and reviewable fixture shape.

That future work should:

- start only from incidents worth preserving;
- redact secrets, user-specific paths, and repo-specific noise before traces leave the repro workspace;
- normalize volatile fields such as timestamps, IDs, temp roots, and environment-specific command paths;
- preserve the concrete actor/tool/output sequence needed for deterministic assertions;
- avoid introducing model judging.

Until that normalization path exists, treat real-session trace collection as an opt-in release/debugging aid rather than a required contributor workflow.
