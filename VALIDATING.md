# Validating TLH changes

Use this document as the repository reference for final validation.

## Standard full validation

Before considering changes ready, run:

```sh
npm run validate
```

**Dependency precondition:** `npm run validate` runs against whatever is in `node_modules`. If your installed tree is stale or was installed with a different lock snapshot, type errors and runtime checks can fail in ways that look like source bugs but are purely a dependency drift. The `check:package-versions` step (the first step in `validate`) detects this and reports an actionable error. If you see a stale-dependency message, run:

```sh
npm ci
```

This is also how CI (`.github/workflows/ci.yml`, `release.yml`) and `.symphony/setup` install dependencies — always from the lockfile, never from a loose install.

This is the standard full validation flow. It checks managed version pins and package contents; runs the main, subagent-test-support, and runtime TypeScript targets; verifies generated runtime JavaScript freshness; runs installer smoke tests; executes the root and imported subagent test suites; runs JavaScript/TypeScript lint and formatting checks via Biome and shell lint via ShellCheck; exercises the settings merge dry-run; and finishes with `npm pack --dry-run`.

The default root tests use Node's dot reporter. Imported subagent suites capture TAP so the runner can enforce their counts and print one concise success line; on any failure or invalid summary it relays the full TAP and stderr diagnostics.

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

`npm run typecheck` and `npm run typecheck:runtime` cover production subagent sources. `npm run typecheck:subagents-test-support` deliberately covers only typed support modules and focused TLH adaptation regressions. It does **not** claim full imported-test type coverage: legacy fixture mocks are not strict-compatible. The review-time full-tree probe reported 320 TypeScript errors (319 after the required-dependency adaptations in this port). Runtime execution remains authoritative for the rest of the imported fixtures.

For runtime TypeScript changes under `scripts/` or `extensions/`, use `npm run typecheck:runtime` for the focused runtime-only typecheck, `npm run check:runtime` to confirm the generated `scripts/**/*.mjs` and same-layout `extensions/**/*.js` files are fresh without mutating the worktree, and `npm run build` only when you intentionally want to refresh those generated outputs. Review and edit the TypeScript sources rather than the generated `.mjs`/`.js` mirrors.

## First-party subagent packaging and provenance

The subagent runtime is part of the root TLH package, not a separately pinned default extension. `npm run check:package-contents` verifies that the declared first-party runtime entrypoint and `extensions/subagents/LICENSE` are present in `npm pack --dry-run`, while contributor-only imported tests remain excluded. Root tests also verify that `config/default-extensions.json` has no active external subagent default, Nico Bailon's notice is exact, and all 17 files in the immutable historical archive still match the import manifest (including the 29-entry archived Gnosis ledger).

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

To lint all tracked shell scripts for ShellCheck findings:

```sh
npm run lint:sh
```

This runs ShellCheck over every `*.sh` file tracked by git. It is also included in `npm run validate`.

For installer tests, prefer temporary `--agent-dir` and `--bin-dir` values. Do not run a real install into home directories unless explicitly requested.

### Installer verification recipe

**Stage-0 vs stage-1 behaviour — what a plain temp-dir install actually exercises:**

Running `bash install.sh` from inside the repo checkout takes the `find_local_support_root` path (install.sh ~line 730): stage 1 runs directly from local files and `fetch_remote_support_root` is **never** called. This means:

- No remote support-file fetching is exercised.
- `TLH_RAW_BASE` has no effect.
- Changes to stage-0 fetching can appear verified when they were never executed.

A second trap: running a locally-modified `install.sh` **without** `_TLH_STAGE0_CANONICALIZED=1` causes `canonicalize_stage0_installer` to re-download `install.sh` from `RAW_BASE` and exec that copy, discarding your local edits.

**Stage-1-only changes** (e.g. edits to `scripts/tlh-install.mjs`) do run from a repo checkout via `find_local_support_root`, so the plain temp-dir install is sufficient for them:

```sh
bash install.sh --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
```

**To exercise stage-0 remote support-file fetching**, copy `install.sh` to a temp directory outside the repo and set `_TLH_STAGE0_CANONICALIZED=1` to bypass the re-download:

```sh
T=$(mktemp -d); cp install.sh "$T/"; cd "$T"
_TLH_STAGE0_CANONICALIZED=1 bash install.sh --verbose --agent-dir "$T/base/agent" --bin-dir "$T/bin"
```

From outside the repo checkout the installer cannot find `find_local_support_root`, so it exercises the real remote fetch path (`fetch_remote_support_root` → `TLH_RAW_BASE`).

**To verify the required-file abort path** (expects exit 1 and the message `required installer support file not found for ref ...`):

```sh
_TLH_STAGE0_CANONICALIZED=1 TLH_RAW_BASE="https://raw.githubusercontent.com/diegopetrucci/the-last-harness/no-such-ref-xyz" bash install.sh --agent-dir "$T/a/agent" --bin-dir "$T/a/bin"
```

**First-launch pi output:** when checking first-launch behaviour of a freshly installed profile, redirect pi output to a file rather than piping to `head` or `tail`. A `SIGPIPE` from an early-closing pipe kills pi mid-install and produces misleading partial results:

```sh
# Do this:
tlh > /tmp/tlh-first-launch.log 2>&1
# Not this (SIGPIPE risk):
tlh | head -20
```

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
