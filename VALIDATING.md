# Validating TLH changes

Use this document as the repository reference for final validation.

## Standard full validation

Before considering changes ready, run:

```sh
npm run validate
```

This is the standard full validation flow. It checks managed version pins and package contents; runs the main and runtime TypeScript targets (the main target covers subagent test sources directly); verifies generated runtime JavaScript freshness; runs installer smoke tests; executes the root and imported subagent test suites; runs JavaScript/TypeScript lint via Oxlint, formatting checks via Oxfmt, and shell lint via ShellCheck; exercises the settings merge dry-run; and finishes with `npm pack --dry-run`.

The validation scripts retain Oxlint's built-in default rule selection while `.oxlintrc.json` registers the vendored anti-slop plugin for deliberate per-rule adoption. The current rollout enables `anti-slop/no-module-mocking`, `anti-slop/no-object-parameters`, `anti-slop/no-reflect-apply`, `anti-slop/no-reflect-get`, `anti-slop/no-shape-in-symbol-names`, `anti-slop/no-unknown-type-aliases`, and `anti-slop/no-widen-then-assert` at error severity; the other 8 anti-slop rule entries remain visibly commented out. `npm run lint` runs `oxlint --deny-warnings scripts tests extensions`, so any warning or error fails validation. The same npm script is used by the CI validation lane; CI does not duplicate the Oxlint flag. The enforcing formatting gate is `npm run format:check`, which only selects Oxfmt check mode. The default root tests use Node's dot reporter. Imported subagent suites capture TAP so the runner can enforce their counts and print one concise success line; on any failure or invalid summary it relays the full TAP and stderr diagnostics.

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

CI runs the suites on Linux and macOS with Node 22.19.0. Its unit and integration shards must each execute at least one test and retain the same zero-non-pass requirement; together they cover the full counts.

For expanded output from the root Node tests, use:

```sh
npm run test:verbose
```

Subagent successes remain concise in that aggregate command. Subagent failures automatically include their full TAP output.

## TypeScript scope

`npm run typecheck` covers production subagent sources and all subagent test files under `extensions/subagents/test` (the exclusion that previously omitted that subtree has been removed). `npm run typecheck:runtime` covers runtime-specific sources. All 114 subagent test files pass strict typechecking with zero errors; the `ScaledMs` branded type enforces that wait helpers receive a scaled timeout rather than a raw literal. `npm run typecheck:subagents-test` provides a developer-convenience target for running the subagents-test typecheck in isolation.

For runtime TypeScript changes under `scripts/` or `extensions/`, use `npm run typecheck:runtime` for the focused runtime-only typecheck, `npm run check:runtime` to confirm the generated `scripts/**/*.mjs` and same-layout `extensions/**/*.js` files are fresh without mutating the worktree, and `npm run build` only when you intentionally want to refresh those generated outputs. Review and edit the TypeScript sources rather than the generated `.mjs`/`.js` mirrors.

`npm run check:lazy-import-boundaries` runs as part of `npm run validate` and enforces that a dynamically imported extension module's static graph contains no bare specifiers and no module already reachable from the eager entry graph. This check exists because Pi's extension loader injects the `@earendil-works/pi-coding-agent` package alias only inside the jiti-loaded graph; a dynamic `import()` crosses into native ESM where that alias is absent, causing `ERR_MODULE_NOT_FOUND` at command-execution time. The check analyses generated `.js` files. If you need to add an entry to `SHARED_MODULE_ALLOWLIST`, first verify that the module is stateless — modules carrying mutable singleton state must not be shared across the jiti and native ESM graphs.

## First-party subagent packaging and provenance

The subagent runtime is part of the root TLH package, not a separately pinned default extension. `npm run check:package-contents` verifies that the declared first-party runtime entrypoint and `extensions/subagents/LICENSE` are present in `npm pack --dry-run`, while contributor-only imported tests remain excluded.

The source-history comparison is intentionally a separate, checkout-dependent verification:

```sh
node docs/subagents-history/verify-import.mjs /absolute/path/to/a-verified-pi-subagents-checkout
```

It verifies the exact source repository commit/tree, include/exclude partition, source and imported blob identities, current historical archive bytes/modes, full-tree tar checksum, ledger counts, import ancestry, and absence of grafted source ancestry. It is not part of `npm run validate` because routine clones do not carry the external repository's Git objects. See [docs/subagents-history/HISTORY.md](docs/subagents-history/HISTORY.md) for the pinned values and independent history-inspection commands.

No standalone subagent publish, release, pin-bump, or upstream-sync check is current TLH validation. Those workflows survive only as historical evidence under `docs/subagents-history/source/`; never use that archive as a task `cwd`.

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

## Release-tier manual validation

Run this checker during release preparation, not as part of routine local validation:

```sh
npm run check:startup-performance
```

This is intentionally separate from `npm run validate`. It launches TLH in a PTY and measures timing, so results are sensitive to the current machine and system load.

Ticket `tlh-2ej0` also owns the remaining first-party subagent live-session smoke. `npm run validate` does not replace these checks: against the packaged release candidate, verify the compact parent-facing tool description (including invalid-mode fallback), native `contact_supervisor` coordination, a supported `:max` thinking badge, and delegation to the eight supported TLH minor agents with non-allowlisted blocking, user-scope/fresh-context enforcement, and an async `status`/`resume` cycle. Record the candidate, profile, session evidence, and outcomes on the ticket. The current checkbox form lives in [docs/pin-bump-verification.md](docs/pin-bump-verification.md); its pin/release workflow is retired even though this live-session debt remains.

Release objective: keep the steady-state first TLH header mean below `1000ms`.

For the current investigation methodology, candidate ranking, and Pi `0.80.6` source/doc evidence behind the packaging recommendation, see [docs/pi-startup-investigation-2026-07-15.md](docs/pi-startup-investigation-2026-07-15.md).

If the checker fails, investigate before release instead of treating it like a normal unit-test failure. The output is a release signal to understand and address, not a standard deterministic test gate.

## Final validation guidance

Final validation should use this document as the reference for which repository checks to run.

After pushing changes that rely on CI or GitHub Actions, monitor the relevant checks until they are green. Do not stop at `git push`; investigate and fix CI failures before considering the work complete.
