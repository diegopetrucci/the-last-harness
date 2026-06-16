# Validating TLH changes

Use this document as the repository reference for final validation.

## Standard full validation

Before considering changes ready, run:

```sh
npm run validate
```

This is the standard full validation flow for this repository. Its test phase uses the quiet `npm test` dot reporter so passing runs stay concise.

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

For installer tests, prefer temporary `--agent-dir` and `--bin-dir` values. Do not run a real install into home directories unless explicitly requested.

## Final validation guidance

Final validation should use this document as the reference for which repository checks to run.

After pushing changes that rely on CI or GitHub Actions, monitor the relevant checks until they are green. Do not stop at `git push`; investigate and fix CI failures before considering the work complete.
