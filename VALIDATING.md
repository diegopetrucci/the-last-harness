# Validating TLH changes

Use this document as the repository reference for final validation.

## Standard full validation

Before considering changes ready, run:

```sh
npm run validate
```

**Dependency precondition:** `npm run validate` runs against whatever is in `node_modules`. The first `check:package-versions` step checks installed versions for direct exact registry dependencies in `dependencies` and `devDependencies`, using the corresponding `packages["node_modules/<name>"].version` entries in `package-lock.json` as the expected resolved versions. It intentionally does not audit the full transitive lock snapshot or check peer-only, ranged, or non-registry specs. Missing or stale direct packages are reported with this remediation. Run `npm ci` only in response to that dependency-check remediation; it is not a routine pre-validation step:

```sh
npm ci
```

This is also how CI (`.github/workflows/ci.yml`, `release.yml`) and `.symphony/setup` install dependencies — always from the lockfile, never from a loose install.

This is the standard full validation flow. It checks managed version pins and package contents; runs the main and runtime TypeScript targets (the main target covers subagent test sources directly); verifies generated runtime JavaScript freshness; runs installer smoke tests; executes the root and imported subagent test suites; runs JavaScript/TypeScript lint via Oxlint, formatting checks via Oxfmt, and shell lint via ShellCheck; and finishes with the settings merge dry-run.

Local gitleaks scans consume `.gitleaks.toml` as the allowlist for reviewed synthetic fixture values. That scan stays outside `npm run validate` and CI.

The validation scripts retain Oxlint's built-in default rule selection while `.oxlintrc.json` registers the vendored anti-slop plugin for deliberate per-rule adoption. The global `max-lines` rule is enabled at error severity with a 2,000 physical-line ceiling (including blank lines and comments) for every file under `scripts/`, `tests/`, and `extensions/`, and for `protocol/` except `protocol/session-mirror/v1/conformance.ts`, which turns `max-lines` off and keeps the other rules. Source, test, and generated mirror files share this limit without further exemptions. The current rollout enables `anti-slop/no-chained-type-assertions`, `anti-slop/no-module-mocking`, `anti-slop/no-object-parameters`, `anti-slop/no-reflect-apply`, `anti-slop/no-reflect-get`, `anti-slop/no-shape-in-symbol-names`, `anti-slop/no-unknown-returns`, `anti-slop/no-unknown-type-aliases`, and `anti-slop/no-widen-then-assert` at error severity; the other 6 anti-slop rule entries remain visibly commented out. `npm run lint` runs `oxlint --deny-warnings scripts tests extensions protocol`, so any warning or error fails validation. The same npm script is used by the CI validation lane; CI does not duplicate the Oxlint flag. The enforcing formatting gate is `npm run format:check` (Oxfmt check mode over `scripts/`, `tests/`, `extensions/`, and `protocol/`). The default root tests use Node's dot reporter. Imported subagent suites capture TAP so the runner can enforce their counts and print one concise success line; on any failure or invalid summary it relays the full TAP and stderr diagnostics.

## Fast checks for agents

`npm run validate` typically takes about 2-4 minutes locally (observed median ~2 min, p90 ~3.5 min, max ~7 min), so set tool timeouts to at least 600 seconds.

Single root test file (diagnostic only; it bypasses the `TMPDIR` leak guard that `npm test` uses, so it is not validation):

```sh
node --test tests/<name>.test.mjs
```

Single subagents test file from the repo root, optionally narrowed by test name (also diagnostic only):

```sh
node --experimental-strip-types --import ./extensions/subagents/test/support/register-loader.mjs --test extensions/subagents/test/unit/<name>.test.ts
node --experimental-strip-types --import ./extensions/subagents/test/support/register-loader.mjs --test --test-name-pattern='<pattern>' extensions/subagents/test/unit/<name>.test.ts
```

## Test-runner concurrency policy

The root test guard, imported subagent runner, and CI shard entrypoint share `TLH_TEST_CONCURRENCY`. When it is unset outside GitHub Actions, they pass Node an adaptive limit of `max(1, floor(availableParallelism / 2))`, which keeps local runs near half of the available CPUs. On GitHub Actions, an unset variable preserves the existing deliberate runner concurrency; a positive-integer override applies in both environments. Invalid values fail fast with a concise error and exit code 2.

## Opt-in CI shard timing reports

The CI shard runner keeps its normal commands, output, scheduling, coverage, and
failure gates when timing is disabled. Contributor-only timing reports are
opt-in: set `TLH_CI_TIMINGS_DIR` to an absolute directory owned for the run,
and keep that directory outside `HOME`, `TMPDIR`, `TMP`, and `TEMP` (the runner
rejects guarded locations before spawning tests). For example, on a local
POSIX checkout use a runner-owned path such as:

```sh
TIMING_DIR="/var/tmp/tlh-ci-timings-$$"
mkdir -p "$TIMING_DIR"
TLH_CI_TIMINGS_DIR="$TIMING_DIR" node scripts/run-ci-test-shard.mjs 1/2
```

The same setting can be used for shard `2/2`; use a distinct directory or
preserve the generated report names when collecting both shards. Each bounded
JSON report includes the shard, Node version, platform/architecture, available
CPU count, effective concurrency, selected lane layout, command and lane
wall-clock durations, and per-file durations for root, unit, integration, and
e2e suites. File names are
repository-relative. `elapsedWallMs` measures process wall time, while
`cumulativeFileTimeMs` sums Node's per-file durations and can be larger when
files run concurrently. The effective concurrency is per Node test-runner
process; baseline lanes A and B and experimental root/unit/integration lanes
run their own runner processes. Failed or cancelled
runs retain a status and any complete file observations available before
termination; they are not successful benchmark samples.

The report directory is deliberately explicit and is not the guarded temporary
root; raw event files are removed after report creation. To disable collection,
unset the variable (or do not set it); no report arguments are then added and
there is no timing-report filesystem activity. Remove old opt-in reports from
the explicitly chosen directory when they are no longer needed. This helper is
contributor-only and is excluded from the published package. Timing samples are
an investigation aid, not a full-shard benchmark loop or a stable p90 claim.

## Manual macOS shard benchmark

`.github/workflows/macos-ci-benchmark.yml` is a manual-only workflow. It uses
`macos-latest`, Node `22.19.0`, read-only repository access, the normal npm and
`node_modules` cache conventions, and exactly one shard-runner invocation in
each of its two matrix jobs (`1/2` and `2/2`). The unchanged two-lane
`baseline` layout remains the default; `experimental` uses separate `HOME`
directories for concurrent root, unit/e2e, and integration lanes. The workflow
accepts a layout and either the existing default concurrency policy or a
positive-integer `TLH_TEST_CONCURRENCY` override. Invalid values fail before
any test child is spawned.

Use a controlled same-commit protocol for comparisons:

1. Select one commit and keep the checkout, Node version, runner image, and test
   inputs fixed for the full comparison. Do not overlap dispatches.
2. Alternate `baseline`/default and `experimental`/default runs, with at least
   three successful samples for each layout. Label every sample consistently as
   warm or cold cache; do not mix cache conditions in one summary.
3. Only after the layout comparison, repeat at least three successful samples
   for an explicit positive concurrency value against the matching layout.
4. Compare the timing report's test execution separately from setup and runner
   start delays. Do not claim a stable p90 from these tiny sample sets.

Each artifact includes bounded timing reports and metadata identifying the
commit, layout, requested concurrency, cache result, shard, and completion
status. Failed, cancelled, unreadable, or otherwise incomplete reports are
labeled `INCOMPLETE-BENCHMARK.txt`, marked in metadata as ineligible, and must
never be presented as speedups. Actual hosted execution is deferred until a
separate publication/dispatch authorization exists and the workflow is
available on the default branch; local timings are not a substitute. To
disable or roll back the experiment, stop dispatching it or remove/revert only
`.github/workflows/macos-ci-benchmark.yml`; `.github/workflows/ci.yml` and its
required job names remain unchanged.

## Routine local validation and failure handling

- Run one normal `npm run validate` pass for routine local final validation. It is sequential and fail-fast; do not repeat it or turn CI-shard commands into local stress loops.
- `node scripts/run-ci-test-shard.mjs <N>/2` is for CI-shaped diagnostics, not routine local final validation. It starts concurrent lanes, and each lane sets `HOME` to `<base HOME>/lane-a` or `<base HOME>/lane-b`, creating or reusing those lane directories for caches and state. Repeated runs can contend for local CPU and carry state across runs, so do not loop over shards or rerun them as a stress ritual.
- If a final-validation command fails, `test-runner` reports the failure and stops. An architect may separately authorize one named-test diagnostic rerun when more evidence is needed; without that authorization, do not rerun suites or shards.

## Test suites and output modes

Use the default aggregate command for normal local checks:

```sh
npm test
```

The imported suites can be targeted individually:

```sh
npm run test:subagents:unit
npm run test:subagents:integration
npm run test:subagents:e2e
```

On Node 22.19.0, full imported runs must report every discovered test as passed with zero failures, cancellations, skips, or todo tests.

CI runs the suites on Linux and macOS with Node 22.19.0. Its unit and integration shards must each execute at least one test and retain the same zero-non-pass requirement; together they cover the full counts. The CI `tests` job has a 30-minute job timeout; this is not a per-test or product deadline.

### Focused diagnostic runs

Use `--test-name-pattern` only for an explicitly labeled focused diagnostic, for example:

```sh
node scripts/run-subagents-tests.mjs integration --test-name-pattern='processes all items'
node scripts/run-subagents-tests.mjs integration --test-name-pattern 'processes all items'
```

The runner accepts those equals and separate forms only for this diagnostic mode. A selected passing test may pass below the full-suite minimum, but failures, cancellations, skips, todos, and a pattern with zero selected passing tests still fail. Node can report a file with no name match as a passing wrapper around an empty `1..0` plan; the runner removes only that narrow exclusion wrapper and does not remove real skip/cancel/todo results. Other reduced-selection options such as `--test-only`, `--test-skip-pattern`, rerun-failures, tag filters, and those selection filters inherited through `NODE_OPTIONS` are rejected rather than certified accidentally.

A focused diagnostic is not validation and an isolated pass is not proof of correctness or full-suite coverage. Full and sharded runs retain their existing minimum-count and zero-non-pass gates. A failed or cancelled child, signal termination, invalid TAP summary, or nonzero test result remains a failure. The direct focused runner uses synchronous `spawnSync` without signal handlers: Ctrl-C normally reaches the foreground process group, but a SIGTERM delivered only to the runner PID can leave its test child running and its `tlh-subagents-tests-*` root behind. The runner's guarantee is exit/TAP accounting, not descendant process or handle cleanup. To undo this behavior, revert this repository change only; it does not modify an installed profile or user configuration.

For expanded output from the root Node tests, use:

```sh
npm run test:verbose
```

Subagent successes remain concise in that aggregate command. Subagent failures automatically include their full TAP output.

Both `npm test` and `npm run test:verbose` run through `scripts/run-test-tmpdir-guard.mjs`, which creates an isolated per-run `TMPDIR`, runs the suites inside it, and reports any temp-directory entries that remain after the run (excluding the documented allowlist: `jiti` transform cache and `node-compile-cache`). After the owned process tree is gone, the guard removes the per-run root; if bounded teardown cannot prove that tree is gone, it retains the root for diagnosis and exits non-zero. A non-empty leak list also causes a non-zero exit code even when all tests pass. On POSIX, cancellation tears down the owned process group with the incoming SIGINT/SIGTERM/SIGHUP and escalates to SIGKILL after a bounded grace period; those signals return conventional exit codes 130/143/129. An uncatchable SIGKILL delivered to the guard or an owned group, including an agent timeout/abort group-kill, bypasses this cleanup and may leave detached suite groups and the per-run temporary root alive. On Windows, the guard can signal only the direct child, not its descendants. The CI shard runner (`scripts/run-ci-test-shard.mjs`) applies the same isolation and leak check at the shard level. These guards detect entries left under their owned temporary root; they do not certify process or handle cleanliness, and they do not certify short socket-root behavior on platforms with socket-path limits.

## TypeScript scope

`npm run typecheck` covers production subagent sources and all subagent test files under `extensions/subagents/test` (the exclusion that previously omitted that subtree has been removed). `npm run typecheck:runtime` covers runtime-specific sources. Discovered subagent test files pass strict typechecking with zero errors; the `ScaledMs` branded type enforces that wait helpers receive a scaled timeout rather than a raw literal. `npm run typecheck:subagents-test` provides a developer-convenience target for running the subagents-test typecheck in isolation.

For runtime TypeScript changes under `scripts/` or `extensions/`, use `npm run typecheck:runtime` for the focused runtime-only typecheck, `npm run check:runtime` to confirm the generated `scripts/**/*.mjs` and same-layout `extensions/**/*.js` files are fresh without mutating the worktree, and `npm run build` only when you intentionally want to refresh those generated outputs. Review and edit the TypeScript sources rather than the generated `.mjs`/`.js` mirrors.

`npm run check:lazy-import-boundaries` runs as part of `npm run validate` and enforces that a dynamically imported extension module's static graph contains no bare specifiers and no module already reachable from the eager entry graph. This check exists because Pi's extension loader injects the `@earendil-works/pi-coding-agent` package alias only inside the jiti-loaded graph; a dynamic `import()` crosses into native ESM where that alias is absent, causing `ERR_MODULE_NOT_FOUND` at command-execution time. The check analyses generated `.js` files. If you need to add an entry to `SHARED_MODULE_ALLOWLIST`, first verify that the module is stateless — modules carrying mutable singleton state must not be shared across the jiti and native ESM graphs.

## First-party subagent packaging and provenance

The subagent runtime is part of the root TLH package, not a separately pinned default extension. `npm run check:package-contents` verifies that the declared first-party runtime entrypoint and `extensions/subagents/LICENSE` are present in `npm pack --dry-run`, while contributor-only imported tests remain excluded.

No standalone subagent publish, release, pin-bump, or upstream-sync check is current TLH validation.

## Useful targeted checks

When narrowing down installer or script changes, these targeted checks are useful:

```sh
bash -n install.sh
node --check scripts/tlh-gnosis.mjs
bash install.sh --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
bash -s -- --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)" < install.sh
```

To run the focused Oxlint and Oxfmt checks:

```sh
npm run lint
npm run format:check
```

To lint all tracked shell scripts for ShellCheck findings:

```sh
npm run lint:sh
```

This runs ShellCheck over every `*.sh` file tracked by git. It is also included in `npm run validate`.

For installer tests, prefer temporary `--agent-dir` and `--bin-dir` values. Do not run a real install into home directories unless explicitly requested.

## Installer performance baseline

The opt-in installer benchmark and its recorded baseline are documented in
[docs/installer-performance.md](docs/installer-performance.md). Use the package
script as the preferred invocation, passing checker options after `--`:

```sh
npm run check:installer-performance -- --mode remote --ref v0.40.0 --upgrade-from v0.39.0 --runs 3 --scenarios all
npm run check:installer-performance -- --mode checkout --ref v0.40.0 --runs 1 --scenarios cold
```

It performs real network/package-manager work only in benchmark-owned temporary
paths and is not part of `npm run validate` or ordinary CI.

## Release-tier manual validation

Run this checker during release preparation, not as part of routine local validation:

```sh
npm run check:startup-performance
```

This is intentionally separate from `npm run validate`. It launches TLH in a PTY and measures timing, so results are sensitive to the current machine and system load. By default, the checker auto-detects the installed isolated profile and filters it into a fresh temporary profile; if no profile exists, it falls back to an empty profile. An explicit `--profile-source` overrides auto-detection. Measured runs within each invocation share one stable temporary profile path, with run 1 as the cold sample and later runs as warm samples. The clone omits top-level `sessions/`, `auth.json`, `mcp-oauth/`, and top-level `.bak`/`.backup` backup artifacts, plus unsafe, dangling, or cyclic symlinks and special filesystem entries; safe internal symlinks are materialized as regular files or directories while startup-relevant package and extension state is preserved.

The remaining first-party subagent live-session smoke is separate from `npm run validate`: against the packaged release candidate, verify the compact parent-facing tool description, native `contact_supervisor` coordination, a supported `:max` thinking badge, and delegation to the nine supported TLH minor agents with non-allowlisted blocking, user-scope/fresh-context enforcement, and an async `status`/`resume` cycle. This baseline scope remains part of the current Pi 1.3.0 release-candidate checks; the current Pi 1.3.0 checks are recorded below, and the historical Pi 1.1.0 and 1.2.0 comparison status lives in [docs/pin-bump-verification.md](docs/pin-bump-verification.md). [docs/pin-bump-verification.md](docs/pin-bump-verification.md) keeps the completed `v0.43.0` checkbox record. Record the candidate, profile, session evidence, and outcomes in the release validation notes/current release tracking.

Release objective: keep the steady-state first TLH header mean below `1000ms`. `.github/workflows/startup-performance.yml` runs on every pull request and on `main` as an informational check with `--budget-ms 2500`. That budget is slack above this release objective. The local checker default remains `1000ms`.

For the current investigation methodology, candidate ranking, and Pi `0.80.6` source/doc evidence behind the packaging recommendation, see [docs/pi-startup-investigation-2026-07-15.md](docs/pi-startup-investigation-2026-07-15.md).

If the checker fails, investigate before release instead of treating it like a normal unit-test failure. The output is a release signal to understand and address, not a standard deterministic test gate.

The following carried-forward checks are required Pi 1.3.0 release-preparation work (first listed for Pi 1.1.0; v0.44.0 and v0.45.0 shipped without running them), remain separate from `npm run validate`, and must be recorded against the packaged release candidate:

- **MCP adapter coexistence:** at startup verify that the persisted `-builtin:mcp` exclusion prevents Pi's built-in-extension replacement warning and that `/mcp` is functional via the TLH adapter. This is temporary compatibility behavior; if TLH migrates away from `mcporter`, verify that it removes only a TLH-owned exclusion marked by `tlh.builtinMcpExclusionManaged: true`, clears the marker, and preserves unmarked user exclusions before validating native MCP.
- **Default theme on fresh install:** verify that Pi's `system` theme (the Pi default since 0.99.0) renders correctly on a fresh isolated-profile install and that the terminal color scheme is respected; theme default behavior is tracked in tlha-epyp.
- **Interactive fullscreen TUI:** verify that TLH sessions start in Pi's fullscreen mode by default (Pi 1.0.0+); confirm the transcript scrolls within the window, the editor stays fixed, and subagent tool-call and status widgets render correctly; then set `tuiMode: "regular"` and verify the session falls back to normal terminal scrollback.
- **Adapter MCP connectivity:** with at least one configured MCP server, verify the adapter connects, the footer shows the server count, and the proxy `mcp` tool is accessible.
- **Session persistence after first user message:** send a first user message and interrupt before the assistant replies; verify the session file exists and resume works correctly.
- **Model and thinking:** with a real provider, verify model-selection persistence and provider-backed thinking levels, including the supported maximum-thinking badge.
- **Native cache behavior:** with a real provider, verify native streaming and idle cache warming, cache-miss notices, and `cache_warm` usage/accounting.
- **Saved-session lifecycle:** after a saved assistant response, verify resume, branch/fork, and meaningful compaction.
- **Provider-backed subagent flow:** verify a live parent/child subagent turn through the installed release candidate.
- **Published-ref update convergence:** once the release ref advertises Pi `1.3.0`, verify update convergence from that published ref.

### Pi 1.3.0 comparison status (reviewed 2026-10-15)

The dated 1.2.0→1.3.0 package comparison is complete and recorded in [the upstream-sync inventory](docs/upstream-sync-inventory.md#pi-130-review-evidence). The original source/package inspection was not live release validation: it ran no provider, credential, installed-profile, or release-tier checks. Separately, a clean isolated unpacked-package installation on 2026-10-15 verified Pi 1.3.0 from both the private runtime and generated wrapper, verified the runtime and wrapper ownership markers and that the runtime lock matched the shipped lock, and observed the runtime top level `.tlh-runtime-owned`, `bin`, `lib`, and `node-compile-cache`; isolated doctor reported 7 OK / 3 WARN / 0 FAIL, with one unresolved packaged-settings append and expected missing EXA/gh auth prerequisites. No paid-provider, normal home-profile, or publication checks were run. The permanent deterministic/isolated regression suites — [resume](tests/the-last-harness-pi-1-3-resume-regressions.test.mjs) and [model resolution](tests/the-last-harness-pi-1-3-model-resolution-regressions.test.mjs) — pass with Pi 1.3.0 without live providers. The provider-backed and packaged release-candidate checks below remain pending:

- **Kimi Code transport and custom base URL:** with an authorized Kimi Code setup, verify Chat Completions behavior, tool additions during a session, prompt-cache retention, and that every custom `models.json` base URL includes `/v1`.
- **OpenAI GPT-6 cache retention:** with an OpenAI API-key model, verify a mid-session thinking-level change preserves the prompt cache. This check does not cover the OpenAI Codex subscription provider, where that cache benefit does not apply.
- **Provider/model ambiguity (deterministic isolated):** the [model-resolution regression](tests/the-last-harness-pi-1-3-model-resolution-regressions.test.mjs) passes credential-preferred, no-credential ambiguity, provider-qualified, and TLH child override → `buildPiArgs` → `parseArgs` → real `resolveCliModel` checks. Provider-backed release validation remains pending.
- **Resumed active tools (deterministic isolated):** the [resume regression](tests/the-last-harness-pi-1-3-resume-regressions.test.mjs) passes primary allowlist precedence at policy application and before provider execution, explicit child `--tools` precedence over transcript state, and omitted-child transcript restoration. It accepts upstream's transient late-tool activation after registration as non-security-boundary behavior while retaining late-tool registration, inactive control behavior, provider exclusion, rejected attempted execution with zero executor count, and allowed-read assertions. Provider-backed release validation remains pending.
- **Clean model switching:** verify thinking from the previous model is not presented to the next model as plain text.
- **TLH policy boundaries:** with the default cap enabled, `gpt-6.1-sol` has a native 500k window (272k → 500k), the non-child primary effective window is 300k (272k → 300k), non-developer children use native 500k, and canonical developer children use `min(native, 272k)`; `tlh.contextCap.disabled=true` follows native windows. Verify model defaults, MCP exclusion/adapter policy, OSC root ownership, and user settings remain unchanged.

Historical Pi 1.2.0 and 1.1.0 comparison status notes are in [docs/pin-bump-verification.md](docs/pin-bump-verification.md#historical-pi-120-comparison-status-reviewed-2026-10-13).

## Final validation guidance

Final validation should use this document as the reference for which repository checks to run. The architect must put the exact ordered shell/MCP validation steps into the final-validation `tk` ticket: each shell step includes its complete command and arguments, while each MCP step is exact adapter-shaped input for the generic gateway with only the fields required by the selected status, discovery, search, connect, or call operation. `server`, `tool`, and `args` are optional overall; use a JSON string for `args` on tool calls. Dispatch that ticket to `test-runner`; it runs `tk show <id>` first, executes only the listed steps, and reports outcomes without editing, installing dependencies, fixing failures, or changing tickets. Implementation tickets remain responsible for their own narrow, ticket-scoped developer validation; do not defer those checks to the final-validation ticket.

After pushing changes that rely on CI or GitHub Actions, monitor the relevant checks until they are green. Do not stop at `git push`; investigate and fix CI failures before considering the work complete.
