# Workflow evals

This page describes the contributor-facing workflow eval suite for TLH repository work. It follows the issue #241 decisions: keep evals deterministic-first, keep live evals opt-in, do not add a primary-agent auto-switching gate, and do not use an LLM-as-judge gate.

These evals are repository contributor tooling only. They are not part of the packaged TLH install surface.

## Eval tiers

Use the lightest tier that answers the question you have:

| Tier | Default path | What it covers | Commands |
| --- | --- | --- | --- |
| Deterministic repo-local validation | Yes | Normal contributor and CI validation | `npm run validate` |
| Deterministic workflow evals | Yes, through targeted `node --test` commands and the normal `npm test` / `npm run validate` path | Hermetic core-workflow integration, trace-policy fixtures, incident coverage, prompt contracts, and live-runner/result contracts | `node --test tests/hermetic-core-workflow.test.mjs tests/evals/trace-policy/trace-policy-evals.test.mjs tests/evals/trace-policy/trace-policy-incident-matrix.test.mjs tests/agent-prompt-contracts.test.mjs tests/evals/tlh-live-evals.test.mjs tests/evals/tlh-live-eval-results.test.mjs` |
| Live isolated evals | No; opt-in only | Real model, network, install, and interactive smoke coverage | `node tests/evals/tlh-live-evals.mjs --list`<br>`node tests/evals/tlh-live-evals.mjs --run --scenario install-update-smoke`<br>`TLH_RUN_LIVE_EVALS=1 node tests/evals/tlh-live-evals.mjs --scenario architect-e2e` |
| Release-tier published-asset checks | No; manual only | Tag/release install verification | See [`docs/releasing.md`](./releasing.md#install-checks) |

## Deterministic workflow evals

The deterministic workflow suite is the main contributor-facing guardrail for workflow behavior.

`tests/hermetic-core-workflow.test.mjs` is the highest-level automated workflow integration check in that suite. It runs as part of the normal `npm test` and `npm run validate` path, using a fake provider plus isolated temp HOME/profile/workspace state so contributors can exercise the architect-to-developer core workflow without model credentials, network access, or manual review.

Use the targeted command below when you are working specifically on workflow behavior and want the deterministic workflow subset without the rest of the repository validation:

```sh
node --test tests/hermetic-core-workflow.test.mjs tests/evals/trace-policy/trace-policy-evals.test.mjs tests/evals/trace-policy/trace-policy-incident-matrix.test.mjs tests/agent-prompt-contracts.test.mjs tests/evals/tlh-live-evals.test.mjs tests/evals/tlh-live-eval-results.test.mjs
```

Deterministic boundaries for the hermetic integration test:

- fake provider only; no real model/provider credentials;
- isolated temp HOME, agent profile, wrapper/bin, and workspace paths;
- no network dependency;
- asserts orchestration boundaries and repository-visible outputs, not subjective model quality.

### Trace-policy fixtures

`tests/evals/trace-policy/trace-policy-evals.test.mjs` replays curated transcript fixtures against deterministic policy assertions. Use it when changing agent prompts, workflow rules, transcript interpretation, or policy-sensitive docs.

The fixtures are designed to stay reviewable:

- explicit actor/tool/output sequences;
- stable fixture IDs and expected outcomes;
- deterministic assertions instead of model scoring;
- coverage for architect, developer, code-reviewer, product, Rush, bug-hunter, web-scout, and oracle boundaries.

### Incident-to-fixture loop

Use this contributor workflow when a real TLH workflow run exposes a prompt, policy, or runtime regression. This is repo-local contributor tooling only; it does not change packaged TLH runtime behavior.

1. Capture or export the failing trace into a temp or other local-only path.
2. Normalize it with the importer.
3. Review the redacted skeleton before anything reaches the repo.
4. Add or update deterministic trace-policy fixtures and incident-matrix coverage.
5. Fix the underlying prompt, policy, or runtime issue.
6. Run the narrow targeted validation for the files you changed. `npm run validate` remains the full-repo check documented in [`VALIDATING.md`](../VALIDATING.md), but do not use it for every incident-loop iteration.

Example temp/local flow:

```sh
trace_dir="$(mktemp -d)"
trace_jsonl="$trace_dir/failing-trace.jsonl"
fixture_preview="$trace_dir/failing-trace.fixture.txt"

# External/local step: save or export the trace into $trace_jsonl first.
node tests/evals/trace-policy/trace-policy-fixture-importer.mjs \
  "$trace_jsonl" \
  --agent architect \
  --reject \
  > "$fixture_preview"
```

Treat the importer output as a reviewable starting point, not an auto-commit artifact.

Typical targeted validation after an incident-loop change:

- fixture/importer-only changes: `node --test tests/evals/trace-policy/trace-policy-fixture-importer.test.mjs tests/evals/trace-policy/trace-policy-evals.test.mjs tests/evals/trace-policy/trace-policy-incident-matrix.test.mjs`
- prompt-contract changes that affect workflow rules: add `tests/agent-prompt-contracts.test.mjs`
- live-runner/result-schema changes: run the relevant `tests/evals/tlh-live-evals*.test.mjs` file alongside the trace-policy tests

### Importer and redaction expectations

`tests/evals/trace-policy/trace-policy-fixture-importer.mjs` accepts exported JSON or JSONL traces and prints a fixture skeleton for `tests/evals/trace-policy/trace-policy-fixtures.mjs`.

- Run it only on local or temp trace exports, never on checked-in raw incident traces.
- Review the output before pasting it into the fixture file.
- Expect it to normalize volatile IDs, timestamps, temp roots, home-directory paths, and generated request/session IDs.
- Expect it to redact obvious secrets and sensitive fields, but do not assume the importer caught everything; manually remove any remaining sensitive or irrelevant detail.
- Keep examples and scratch artifacts under temp/local paths such as `$(mktemp -d)`; do not document or rely on real home-directory installs.

If the imported skeleton still contains secrets, user-identifying content, or unrelated transcript noise, stop and clean that up before the fixture enters review.

### Fixture review standards

Before committing a new or updated trace-policy fixture:

- keep only the minimum actor/tool/output sequence needed to reproduce the policy decision;
- preserve the exact failure signal the deterministic assertion depends on;
- prefer stable local/temp paths and already-normalized placeholders such as `<HOME>`, `<TMP>`, `<TIMESTAMP>`, `<ID>`, and `<REDACTED>`;
- add or update `incidentMatrixIds` when the fixture represents a tracked incident boundary;
- avoid embedding raw exports, score snapshots, or unrelated tool chatter.

A fixture should read like a small deterministic regression, not like a full session dump.

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
- Workflow-specific deterministic checks: `node --test tests/hermetic-core-workflow.test.mjs tests/evals/trace-policy/trace-policy-evals.test.mjs tests/evals/trace-policy/trace-policy-incident-matrix.test.mjs tests/agent-prompt-contracts.test.mjs tests/evals/tlh-live-evals.test.mjs tests/evals/tlh-live-eval-results.test.mjs`
- Discover live scenarios: `node tests/evals/tlh-live-evals.mjs --list`
- Run automated install/update smoke: `node tests/evals/tlh-live-evals.mjs --run --scenario install-update-smoke`
- Prepare a manual architect workflow eval: `TLH_RUN_LIVE_EVALS=1 node tests/evals/tlh-live-evals.mjs --scenario architect-e2e`

## Boundaries and non-goals

Keep workflow evals scoped to stable, reviewable signals:

- Deterministic incident regressions come first.
- The hermetic core-workflow integration test is deterministic and part of normal `npm test` / `npm run validate`; live evals remain opt-in and release-tier/manual, not part of normal `npm run validate` or default CI.
- No primary-agent auto-switching gate: launch the intended primary explicitly for a scenario and evaluate that run as-is.
- No LLM-as-judge gate: pass/fail comes from deterministic checks or a human reviewer reading prepared artifacts.
- Workflow evals are for contributor confidence, not for changing packaged TLH behavior or adding hidden runtime routing.

## Imported incident traces

When a real TLH or upstream Pi session is worth preserving, use the importer-backed incident-to-fixture loop above instead of checking in raw exports.

Contributor review for imported incidents should still confirm that the fixture:

- starts from an incident worth preserving;
- redacts secrets, user-specific paths, and repo-specific noise before anything lands in the repo;
- preserves the concrete actor/tool/output sequence needed for deterministic assertions; and
- avoids expanding scope into model judging or full-session archival.
