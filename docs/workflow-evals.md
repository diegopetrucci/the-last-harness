# Workflow evals

This page describes the contributor-facing workflow eval suite for TLH repository work. It follows the issue #241 decisions: keep evals deterministic-first, keep live evals opt-in, do not add a primary-agent auto-switching gate, and do not use an LLM-as-judge gate.

These evals are repository contributor tooling only. They are not part of the packaged TLH install surface.

## Eval tiers

Use the lightest tier that answers the question you have:

| Tier                                | Default path                                                                                     | What it covers                                                                                                               | Commands                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deterministic repo-local validation | Yes                                                                                              | Normal contributor and CI validation                                                                                         | `npm run validate`                                                                                                                                                                                                 |
| Deterministic workflow evals        | Yes, through targeted `node --test` commands and the normal `npm test` / `npm run validate` path | Hermetic core-workflow integration, trace-policy fixtures, live-runner and isolated-workspace behavior, and result contracts | `node --test tests/hermetic-core-workflow.test.mjs tests/evals/trace-policy/trace-policy-evals.test.mjs tests/evals/tlh-live-evals.test.mjs tests/evals/tlh-live-eval-results.test.mjs`                            |
| Live isolated evals                 | No; opt-in only                                                                                  | Real model, network, install, and interactive smoke coverage                                                                 | `node tests/evals/tlh-live-evals.mjs --list`<br>`node tests/evals/tlh-live-evals.mjs --run --scenario install-update-smoke`<br>`TLH_RUN_LIVE_EVALS=1 node tests/evals/tlh-live-evals.mjs --scenario architect-e2e` |
| Release-tier published-asset checks | No; manual only                                                                                  | Tag/release install verification                                                                                             | See [`docs/releasing.md`](./releasing.md#install-checks)                                                                                                                                                           |

## Deterministic workflow evals

The deterministic workflow suite is the main contributor-facing guardrail for workflow behavior.

`tests/hermetic-core-workflow.test.mjs` is the highest-level automated workflow integration check in that suite. It runs as part of the normal `npm test` and `npm run validate` path, using a fake provider plus isolated temp HOME/profile/workspace state so contributors can exercise the architect-to-developer core workflow without model credentials, network access, or manual review.

Use the targeted command below when you are working specifically on workflow behavior and want the deterministic workflow subset without the rest of the repository validation:

```sh
node --test tests/hermetic-core-workflow.test.mjs tests/evals/trace-policy/trace-policy-evals.test.mjs tests/evals/tlh-live-evals.test.mjs tests/evals/tlh-live-eval-results.test.mjs
```

The reusable acceptance-evidence evaluator has its own offline regression set. Run these files without providers, authentication, or installation:

```sh
node --test \
  tests/evals/tlh-acceptance-evidence.test.mjs \
  tests/evals/tlh-acceptance-scenarios.test.mjs \
  tests/evals/tlh-live-eval-candidate.test.mjs \
  tests/evals/tlh-live-evals.test.mjs \
  tests/evals/tlh-live-eval-results.test.mjs \
  tests/evals/trace-policy/trace-policy-evals.test.mjs
```

Deterministic boundaries for the hermetic integration test:

- fake provider only; no real model/provider credentials;
- isolated temp HOME, agent profile, wrapper/bin, and workspace paths;
- no network dependency;
- asserts orchestration boundaries and repository-visible outputs, not subjective model quality.

### Trace-policy fixtures

`tests/evals/trace-policy/trace-policy-evals.test.mjs` replays curated transcript fixtures against deterministic policy assertions. Use it when changing agent prompts, workflow rules, transcript interpretation, or policy-sensitive docs. Architect implementation tickets route to `developer`; final-validation tickets must carry exact commands and route to the command-only `test-runner`, whose policy allows `tk show` and non-mutating validation commands while rejecting edits, mutating shell/package/ticket commands, and delegation.

The fixtures are designed to stay reviewable:

- explicit actor/tool/output sequences;
- stable fixture IDs and expected outcomes;
- deterministic assertions instead of model scoring;
- direct deterministic trace-policy coverage for architect, developer, test-runner, code-reviewer, product, Rush, bug-hunter, web-scout, oracle, contrarian, diff-summarizer, librarian, and repo-scout boundaries, including final-validation routing and the test-runner's command-only policy.

### Incident-to-fixture loop

Use this contributor workflow when a real TLH workflow run exposes a prompt, policy, or runtime regression. This is repo-local contributor tooling only; it does not change packaged TLH runtime behavior.

1. Capture or export the failing trace into a temp or other local-only path.
2. Normalize it with the importer.
3. Review the redacted skeleton before anything reaches the repo.
4. Add or update deterministic trace-policy fixtures.
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

- fixture/importer-only changes: `node --test tests/evals/trace-policy/trace-policy-fixture-importer.test.mjs tests/evals/trace-policy/trace-policy-evals.test.mjs`
- architect/test-runner routing or trace-policy changes: `node --test tests/evals/trace-policy/trace-policy-evals.test.mjs tests/the-last-harness-primary-agent-runtime-prompt-guidance.test.mjs tests/the-last-harness-primary-agent-runtime-delegation.test.mjs`
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
- avoid embedding raw exports, score snapshots, or unrelated tool chatter.

A fixture should read like a small deterministic regression, not like a full session dump.

### Related contract tests

The deterministic workflow tier also includes:

- `tests/evals/tlh-live-evals.test.mjs` for live-runner and isolated-workspace behavior coverage.
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

### Offline acceptance-evidence evaluation

The prepared packaged scenarios can be scored later without launching a provider. The evaluator is intentionally offline: it reads only an owned workspace, never executes commands found in a manifest/transcript, never refreshes credentials, and never starts a model/provider. It writes `acceptance-results.json` inside that workspace.

Use a frozen packaged candidate for evidence that is meant to say anything about a release candidate. A checkout-only scaffold is useful for prompt/fixture development, but it has no frozen candidate identity and must remain pending/blocked rather than being reported as release evidence.

A repeatable preparation and capture outline is:

```sh
candidate_ref="$(git rev-parse HEAD)"
acceptance_model="PROVIDER/MODEL:medium" # choose the exact approved model; do not substitute it later
run_parent="$(mktemp -d)"

# Live preparation/capture step, only with explicit operator approval. This is
# the only step below that can launch the installed runtime or contact a provider.
TLH_RUN_LIVE_EVALS=1 node tests/evals/tlh-live-evals.mjs \
  --run --scenario architect-e2e,subagent-acceptance \
  --candidate-ref "$candidate_ref" \
  --acceptance-model "$acceptance_model" \
  --artifacts-dir "$run_parent" --keep-artifacts

# The runner prints `Live eval workspace: <run-root>`. Pass that printed
# run root (the directory containing artifacts/), not its nested workspace/.
# Complete only the capture instructions in artifacts/<scenario>/README.md.
workspace="<printed-live-eval-run-root>"
node tests/evals/tlh-acceptance-evidence.mjs --workspace "$workspace"
status=$?
printf 'offline acceptance evaluator exit: %s\n' "$status"

# Remove the temporary profile, fixture, captures, and report after review.
rm -rf "$run_parent"
```

Authentication must happen only through the human-controlled login/configuration flow in the isolated candidate profile described by the generated README. Candidate-mode launch commands intentionally use `env -i` with an allowlisted environment, so host auth variables and host profile files are not inherited; complete the isolated login/configuration flow before launching and do not replace `env -i` with a normal host environment. Do not copy host auth files, refresh credentials automatically, put credentials in evidence, or use a fallback provider/model. If auth, capability metadata, or a requested role is unavailable, preserve the generated `blocked`/`pending` result. The evaluator accepts structured allowlisted records in the manifest capture locations (or `artifacts/<scenario>/evidence/evidence-records.jsonl`); each record must carry the relevant check ID and candidate/run/session identity. Manual compact-description and max-rendering records additionally require `reviewerType: "human"`, an explicit approving decision, capture reference, candidate commit, and observed run ID. An AI may collect a capture but cannot award that manual pass.

### Evidence capture contract

All paths below are relative to the printed live-eval run root. Keep raw sessions private; records contain only redacted fields needed for correlation. Every JSONL record carries `kind`, `checkId`, and the frozen `candidateCommit`.

- Parent session: `sessions/<parent-session-id>.jsonl`; the active entry is identified by `parentSessionId`, `parentSessionPath`, `parentEntryId`, and `toolCallId`.
- Child session: `sessions/<child-session-id>.jsonl`; native job artifacts are `jobs/<run-id>/status.json`, `jobs/<run-id>/result.json`, and `jobs/<run-id>/events.jsonl`. Status/result must agree on `runId` and role; their `sessionFile` references must resolve to the captured child session identity.
- Successful dispatch record (one JSONL object, abbreviated native payload):

  ```json
  {"kind":"dispatch","checkId":"subagent-acceptance-developer-dispatch","candidateCommit":"<candidate-commit>","agent":"developer","parentSessionId":"<parent-session-id>","parentSessionPath":"sessions/<parent-session-id>.jsonl","parentEntryId":"<active-entry-id>","toolCallId":"<tool-call-id>","runId":"<run-id>","childSessionId":"<child-session-id>","resolvedScope":"user","childScope":"user","toolCall":{"id":"<tool-call-id>","name":"subagent","input":{"agent":"developer","cwd":"workspace/fixture","agentScope":"user","context":"fresh","model":"PROVIDER/MODEL:medium"}},"toolResult":{"content":[{"type":"text","text":"<redacted result>"}],"details":{"mode":"single","runId":"<run-id>","results":[{"agent":"developer","sessionFile":"sessions/<child-session-id>.jsonl","model":"PROVIDER/MODEL","thinking":"medium","modelIdentity":{"provider":"PROVIDER","model":"MODEL","thinking":"medium"},"attemptedModels":["PROVIDER/MODEL"],"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0,"turns":0}}]}}}
  ```

  The parent session must contain the same native `subagent` call and completed tool result. Requested `toolCall.input.model` is not execution evidence: the observed model must be present on the correlated `result.results[i]` and/or `status.steps[i]` entries. More than one attempted model, a fallback resolution, or disagreeing role/step identity fails; missing observed identity remains pending. `resolvedScope` and `childScope` are required for the user-scope check; record them only from observed parent/child runtime evidence. If either value is unavailable, omit it and leave the check pending rather than inventing an observation.
- Job record: `{"kind":"job","checkId":"<check-id>","candidateCommit":"<candidate-commit>","runId":"<run-id>","childSessionId":"<child-session-id>","statusPath":"jobs/<run-id>/status.json","resultPath":"jobs/<run-id>/result.json","eventsPath":"jobs/<run-id>/events.jsonl"}`. Lifecycle events use `runId`; child projections use `subagentRunId`; identity-less `subagent.control` and truncation diagnostics are tolerated but never prove lifecycle completion. A `subagent.events.truncated` marker leaves trace-dependent checks incomplete.
- Denied-target record: use the active parent `subagent` call/result and the native error result `{"content":[{"type":"text","text":"<redacted error>"}],"isError":true,"details":{"mode":"single","results":[]}}`. Do not substitute `blocked:true`; a denied result must have no run identity and no matching child job.
- Fixture test record: `{"kind":"fixture-test","checkId":"architect-independent-function-behavior","candidateCommit":"<candidate-commit>","fixturePath":"workspace/fixture","resultPath":"artifacts/architect-e2e/evidence/function-behavior.json"}`. The referenced JSON result must contain `candidateCommit`, `command`, `cwd`, integer `exitCode`, string `stdout`/`stderr`, `independent:true`, and `expectedBehaviorChecked:true`; record-level booleans without this capture remain pending.
- Human TUI attestation: `{"kind":"human-review","checkId":"<manual-check-id>","candidateCommit":"<candidate-commit>","reviewerType":"human","decision":"passed","runId":"<observed-run-id>","captureReference":"artifacts/<scenario>/evidence/<capture>"}`. The capture file must exist inside the run root; an AI reviewer cannot award this status.

The report is idempotent for the same evidence references and includes suite/candidate identity, references, separate deterministic/manual counts, and limitations. A local report is not a tamper-proof attestation and fixture git diff does not establish a sandbox guarantee. Do not copy raw transcripts, credentials, or provider output into repository fixtures/docs.

If the operator must undo a run, remove the printed temporary parent (`rm -rf "$run_parent"`) and any separately chosen isolated credential/profile directory. No normal `~/.pi/agent`, `~/.the-last-harness/agent`, wrapper, or repository state is part of this workflow.

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

| Scenario                     | Mode            | What it checks                                                           |
| ---------------------------- | --------------- | ------------------------------------------------------------------------ |
| `architect-e2e`              | Manual scaffold | Ticketed architect-to-developer flow and orchestration-only behavior     |
| `rush-product-bug-hunter`    | Manual scaffold | Primary boundary checks for Rush, product, and bug-hunter                |
| `web-scout-network-research` | Manual scaffold | Real network research flow, citations, and secret-safe artifact handling |
| `dirty-repo-guard`           | Manual scaffold | Startup warning behavior for dirty repos                                 |
| `install-update-smoke`       | Automated       | Isolated install, `tlh defaults list`, and `tlh update` smoke coverage   |

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

The offline evaluator writes a separate top-level `acceptance-results.json`. `results.json` describes preparation/live-runner state; it is not proof that a prepared manual scenario passed. Run the evaluator only after native job/session records and any human TUI attestations have been captured.

The structured result schema includes:

- one result entry per selected scenario;
- scenario status values such as `passed`, `prepared`, or `failed`;
- per-check details and artifact paths;
- suite-level aggregate counts for automated and manual checks.

Use `--results-file /path/to/results.json` only when you explicitly want a redacted copy outside the temp workspace. Do not commit `results.json`, temp workspaces, or per-run score snapshots.

If a live result matters for a release or high-confidence workflow decision, rerun the same scenario and compare artifacts instead of treating one live run as definitive.

## Commands by common intent

- Normal contributor validation: `npm run validate`
- Workflow-specific deterministic checks: `node --test tests/hermetic-core-workflow.test.mjs tests/evals/trace-policy/trace-policy-evals.test.mjs tests/evals/tlh-live-evals.test.mjs tests/evals/tlh-live-eval-results.test.mjs`
- Acceptance-evidence offline checks: `node --test tests/evals/tlh-acceptance-evidence.test.mjs tests/evals/tlh-acceptance-scenarios.test.mjs tests/evals/tlh-live-eval-candidate.test.mjs tests/evals/tlh-live-evals.test.mjs tests/evals/tlh-live-eval-results.test.mjs tests/evals/trace-policy/trace-policy-evals.test.mjs`
- Discover live scenarios: `node tests/evals/tlh-live-evals.mjs --list`
- Run automated install/update smoke: `node tests/evals/tlh-live-evals.mjs --run --scenario install-update-smoke`
- Prepare a packaged manual architect workflow eval: `TLH_RUN_LIVE_EVALS=1 node tests/evals/tlh-live-evals.mjs --run --scenario architect-e2e --candidate-ref "$candidate_ref" --acceptance-model "$acceptance_model" --keep-artifacts`
- Evaluate an owned prepared run offline: `node tests/evals/tlh-acceptance-evidence.mjs --workspace "$workspace"`

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
