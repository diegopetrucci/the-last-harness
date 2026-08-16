# Local development

Run these commands from the repository root with Node.js >=22.19.0. Prefer temporary isolated profile directories so local testing does not touch a real `tlh` or normal Pi profile.

## Direct dependency pin decisions

Direct dependency, devDependency, and peerDependency specs remain exact. The refresh selected the latest stable registry releases for the compatible direct pins: Pi `0.84.2`, Oxlint `1.78.0`, `@oxlint/plugins` `1.78.0`, Oxfmt `0.63.0`, and `@types/node` `26.2.0`; the other unchanged direct pins (`@tailwindcss/browser` `4.3.3`, `glimpseui` `0.8.1`, `monaco-editor` `0.56.0`, `jiti` `2.7.0`, and `shellcheck` `4.1.0`) were already current.

Two older latest releases are intentional holds: `typebox` stays at `1.3.7` because Pi `0.84.2` declares that exact transitive pin, and `typescript` stays at `6.0.3` because registry latest `7.0.2` does not export `typescript/bin/tsc`, which TLH's runtime TypeScript freshness check resolves, and also removes the `ts.ScriptTarget.Latest` API used by the extension static tests. Both holds are therefore compatibility requirements, not stale version metadata.

## Run validation

Run the aggregate validation script, which covers the main TypeScript `tsc --noEmit` check, the runtime TypeScript check for `scripts/**/*.mts` and authoritative `extensions/**/*.ts`, the generated-output freshness check for `scripts/**/*.mjs` plus same-layout `extensions/**/*.js`, installer smoke checks, test suite, Oxlint linting, Oxfmt formatting checks, ShellCheck linting, settings merge dry-run, and package dry-run:

```sh
npm run validate
```

Oxlint retains its built-in default rule selection and registers the vendored anti-slop plugin through `.oxlintrc.json`. Anti-slop adoption is deliberately per-rule: `anti-slop/no-module-mocking` and `anti-slop/no-unknown-type-aliases` are active at error severity, while the other 13 rule entries remain visibly commented out. Oxlint still runs with `--deny-warnings` through `npm run lint`; any warning or error fails validation. CI invokes that same npm script rather than duplicating the Oxlint command. This validation path stays deterministic and repo-local. Its `npm test` step uses the quiet dot reporter for passing runs.

When you need the full Node test reporter for diagnostics, rerun:

```sh
npm run test:verbose
```

If you are iterating on runtime TypeScript sources under `scripts/` or `extensions/`, you can run the focused commands directly:

```sh
npm run typecheck:runtime
npm run check:runtime
npm run lint
npm run format:check
npm run build
```

Use `npm run typecheck` for the main repository TypeScript check, `npm run typecheck:runtime` for the focused runtime TypeScript check covering `scripts/**/*.mts` and authoritative `extensions/**/*.ts`, `npm run check:runtime` to verify the generated `scripts/**/*.mjs` and same-layout `extensions/**/*.js` outputs are already fresh without rewriting them, and `npm run build` only when you intentionally want to refresh those generated runtime files. Review and edit the TypeScript sources rather than the generated `.mjs`/`.js` mirrors.

## Develop the first-party subagent runtime

`extensions/subagents/src/**/*.ts` is authoritative runtime source; same-layout `.js` files are generated. The runtime entrypoint is `extensions/subagents/src/extension/index.js`, declared directly in the root package's `pi.extensions`. It is not a standalone package dependency and must not be released, published, pinned, or upstream-synced separately from TLH. Historical standalone metadata under `docs/subagents-history/source/` is evidence, not contributor instruction; never launch a task with `cwd` beneath that archive because its preserved `AGENTS.md`/`CLAUDE.md` names can be loaded as project context.

Use the narrow imported suites while iterating, then the full repository validation before handoff:

```sh
npm run typecheck:runtime
npm run test:subagents:unit
npm run test:subagents:integration
npm run test:subagents:e2e
npm run check:runtime
npm run validate
```

If TypeScript changes intentionally affect generated runtime output, run `npm run build`, inspect both the source and generated diff, and rerun `npm run check:runtime`. Do not hand-edit the JavaScript mirror. The tests under `extensions/subagents/test/` are contributor-only and excluded from the published package; the runtime and Nico Bailon's notice at `extensions/subagents/LICENSE` are shipped.

To verify import provenance against a checkout containing the source commit:

```sh
node docs/subagents-history/verify-import.mjs /absolute/path/to/a-verified-pi-subagents-checkout
```

That verifier compares source Git objects with the immutable import checkpoint and current historical archive. It is separate from routine `npm run validate` because the external history checkout is not a repository dependency. See [subagents-history/HISTORY.md](subagents-history/HISTORY.md) for the repository URL, exact commits/tree, checksum command, and history-inspection commands.

## Refresh the Understand Anything graph

When a change materially affects architecture, repository structure, or documented workflows, refresh the tracked Understand Anything graph from the repository root. Launch an interactive TLH or upstream Pi session, then enable the Understand Anything skill/extension in that same session before using `/understand`. TLH does not expose `/understand` by default.

For example, start a TLH session with:

```sh
tlh
```

Then, after the Understand Anything skill/extension is enabled in that session, run the refresh command:

```text
/understand
```

Use a full refresh only when the incremental update is insufficient:

```text
/understand --full
```

Review the resulting `.understand-anything/knowledge-graph.json`, `.understand-anything/meta.json`, `.understand-anything/fingerprints.json`, and `.understand-anything/intermediate/scan-result.json` diff before committing it. Commit those generated updates only when the graph refresh is actually warranted by the change.

## Test the extension directly

Test the extension directly from this checkout without installing it. After TypeScript edits, run `npm run build` first so the generated JS entrypoint matches the authoritative source:

```sh
pi --no-extensions -e ./extensions/the-last-harness.js
```

Then run the thinking picker in the interactive UI (or the supported `/effort` alias):

```text
/thinking
```

You can also test direct arguments, validation, and the alias:

```text
/thinking off
/thinking low
/thinking high
/thinking xhigh
/thinking nope
/effort low
```

## Test with an isolated temporary profile

```sh
tmp="$(mktemp -d)"
PI_CODING_AGENT_DIR="$tmp/agent" pi --no-extensions -e ./extensions/the-last-harness.js
```

## Test the package install flow locally

```sh
tmp="$(mktemp -d)"
PI_CODING_AGENT_DIR="$tmp/agent" pi install "$PWD"
PI_CODING_AGENT_DIR="$tmp/agent" pi
```

Then run:

```text
/thinking
```

## Test the defaults manager

```sh
tmp="$(mktemp -d)"
node scripts/merge-settings.mjs config/settings.defaults.json \
  --settings "$tmp/settings.json" \
  --default-extensions config/default-extensions.json
node scripts/tlh-defaults.mjs \
  --settings "$tmp/settings.json" \
  --defaults config/default-extensions.json \
  disable context-inspector
```

## Test the Gnosis manager

Validate Gnosis setup without a full install:

```sh
tmp="$(mktemp -d)"
node scripts/tlh-gnosis.mjs --agent-dir "$tmp/agent" validate
```

## Test installer bootstrap and wrapper behavior

Dry-run the stage-0 bootstrapper with temporary paths. From a complete local checkout, `install.sh` should discover the local stage-1 helper instead of downloading support files:

```sh
bash install.sh --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
```

You can also run the stage-1 helper directly when iterating on Node-side installer orchestration:

```sh
node scripts/tlh-install.mjs --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
```

Test the local checkout without pushing it:

```sh
tmp="$(mktemp -d)"
TLH_PACKAGE_SOURCE="file:$PWD" bash install.sh \
  --track custom \
  --agent-dir "$tmp/agent" \
  --bin-dir "$tmp/bin"
"$tmp/bin/tlh"
```

You can also test any pushed TLH branch through GitHub. Fetch that branch's installer and pass the same branch name as `--ref`:

```sh
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/my-feature-branch/install.sh |
  bash -s -- --ref my-feature-branch --track ref
```

For temporary branch testing without touching your real `tlh` profile or wrapper:

```sh
tmp="$(mktemp -d)"
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/my-feature-branch/install.sh |
  bash -s -- \
    --ref my-feature-branch \
    --track ref \
    --agent-dir "$tmp/agent" \
    --bin-dir "$tmp/bin"
"$tmp/bin/tlh"
```

Replace `my-feature-branch` in both places with the pushed TLH branch you want to test. This is a TLH installer test, not a standalone subagent release flow.
