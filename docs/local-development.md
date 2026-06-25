# Local development

Run these commands from the repository root with Node.js >=22.19.0. Prefer temporary isolated profile directories so local testing does not touch a real `tlh` or normal Pi profile.

## Run validation

Run the aggregate validation script, which covers the runtime TypeScript typecheck and generated-output freshness check, installer smoke checks, test suite, lint, settings merge dry-run, and package dry-run:

```sh
npm run validate
```

This default validation path stays deterministic and repo-local. Its `npm test` step uses the quiet dot reporter for passing runs.

When you need the full Node test reporter for diagnostics, rerun:

```sh
npm run test:verbose
```

If you are iterating on runtime `.mts` sources under `scripts/`, you can run the focused commands directly:

```sh
npm run typecheck
npm run check:runtime
npm run build
```

Use `npm run check:runtime` to verify the generated `scripts/**/*.mjs` outputs are already fresh without rewriting them. Run `npm run build` only when you intentionally want to refresh those generated runtime files.

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

Test the extension directly from this checkout without installing it:

```sh
pi --no-extensions -e ./extensions/the-last-harness.ts
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
PI_CODING_AGENT_DIR="$tmp/agent" pi --no-extensions -e ./extensions/the-last-harness.ts
```

## Test the package install flow locally

```sh
tmp="$(mktemp -d)"
PI_CODING_AGENT_DIR="$tmp/agent" pi install "file:$PWD"
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
  disable notify
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

You can also test any pushed branch through GitHub. Push the branch, then fetch
that branch's installer and pass the same branch name as `--ref`:

```sh
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/subagents/install.sh |
  bash -s -- --ref subagents --track ref
```

For temporary branch testing without touching your real `tlh` profile or wrapper:

```sh
tmp="$(mktemp -d)"
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/subagents/install.sh |
  bash -s -- \
    --ref subagents \
    --track ref \
    --agent-dir "$tmp/agent" \
    --bin-dir "$tmp/bin"
"$tmp/bin/tlh"
```

Replace `subagents` in both places with the pushed branch you want to test.
