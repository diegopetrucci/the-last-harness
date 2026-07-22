# Validating TLH changes

Use this document as the repository reference for final validation.

## Standard full validation

Before considering changes ready, run:

```sh
npm run validate
```

This is the standard full validation flow for this repository. It includes the main TypeScript `tsc --noEmit` check, the runtime TypeScript check for `scripts/**/*.mts` and authoritative `extensions/**/*.ts`, and the generated-output freshness check for `scripts/**/*.mjs` plus same-layout `extensions/**/*.js` before the installer smoke checks, tests, lint, and package dry-run. Its default `npm test` phase uses the quiet dot reporter so passing runs stay concise.

## Test output modes

Use the default test command for normal local checks:

```sh
npm test
```

If you need the full Node test reporter while diagnosing a failure, rerun with:

```sh
npm run test:verbose
```

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

For runtime TypeScript changes under `scripts/` or `extensions/`, use `npm run typecheck:runtime` for the focused runtime-only typecheck, `npm run check:runtime` to confirm the generated `scripts/**/*.mjs` and same-layout `extensions/**/*.js` files are fresh without mutating the worktree, and `npm run build` only when you intentionally want to refresh those generated outputs. Review and edit the TypeScript sources rather than the generated `.mjs`/`.js` mirrors.

For installer tests, prefer temporary `--agent-dir` and `--bin-dir` values. Do not run a real install into home directories unless explicitly requested.

## Release-tier manual validation

Run this checker during release preparation, not as part of routine local validation:

```sh
npm run check:startup-performance
```

This is intentionally separate from `npm run validate`. It launches TLH in a PTY and measures timing, so results are sensitive to the current machine and system load.

Release objective: keep the steady-state first TLH header mean below `1000ms`.

For the current investigation methodology, candidate ranking, and Pi `0.80.6` source/doc evidence behind the packaging recommendation, see [docs/pi-startup-investigation-2026-07-15.md](docs/pi-startup-investigation-2026-07-15.md).

If the checker fails, investigate before release instead of treating it like a normal unit-test failure. The output is a release signal to understand and address, not a standard deterministic test gate.

## Final validation guidance

Final validation should use this document as the reference for which repository checks to run.

After pushing changes that rely on CI or GitHub Actions, monitor the relevant checks until they are green. Do not stop at `git push`; investigate and fix CI failures before considering the work complete.
