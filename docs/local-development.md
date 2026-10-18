# Local development

Run these commands from the repository root with the Node.js version required by `engines.node` in `package.json`. Prefer temporary isolated profile directories so local testing does not touch a real `tlh` or normal Pi profile.

The deferred, contributor-only investigation of `anti-slop/no-unsafe-dictionary-type` is recorded in [Unsafe dictionary investigation (2026-08-18)](no-unsafe-dictionary-investigation-2026-08-18.md). It is evidence for a future decision only; do not enable the rule or apply cosmetic remediations from that note without a separately approved implementation slice.

## TelemetryDeck MCP (contributors only)

The project-local [`.mcp.json`](../.mcp.json) provides a lazy, OAuth-backed `telemetrydeck` MCP server for approved contributor investigations. It is not part of TLH runtime telemetry behavior. Authenticate only when needed with:

```text
/mcp-auth telemetrydeck
```

Treat TelemetryDeck data as sensitive and follow these mandatory constraints:

- Queries must be aggregate-only and must enforce at least 10 distinct `clientUser` values before a result is inspected or reported (for example, `COUNT(DISTINCT clientUser) >= 10`).
- Never call `Tlh.User.mark`.
- Never query, display, or retain individual identifiers, including individual `clientUser` values.
- Never perform cross-system linking: do not link TelemetryDeck data with another system, dataset, repository, session, or identifier.

Do not export or copy raw event data into issues, commits, tests, logs, or other project artifacts. Keep any approved findings at the aggregate level and use the MCP only for contributor work.

## Direct dependency pin decisions

Direct dependency and devDependency specs remain exact pins; the `typebox` peerDependency `'*'` is the only exception (see below). The managed Pi pin lives in `install.sh`, `scripts/tlh-install.mts`, `extensions/the-last-harness/model-selection-scope.ts`, `package.json`, and `config/pi-runtime/package.json`; the other exact pins are in `package.json` too, and `config/pi-runtime/package.json` keeps the internal Pi siblings at exact release pins. The pinned Pi runtime's dependency layout (including the ordinary `pi-ai`, `pi-tui`, and `pi-agent-core` dependencies) and the removed or absent Pi packages are whatever that file and its lockfile say.

TLH's `typebox` pin is a `devDependency` at an exact version (matching the pinned Pi's transitive `typebox` version) plus a deliberately unpinned `peerDependency` of `'*'`. Pi provides `typebox` to extensions at runtime and warns when packages bundle a host-provided dependency, so TLH declares it as a peer rather than a direct runtime dependency. The separate TypeScript compatibility hold remains at the `package.json` pin because `scripts/runtime-typescript.mjs` resolves `typescript/bin/tsc`, which TypeScript 7 no longer exports, and `scripts/check-lazy-import-boundaries.mjs` imports the TypeScript compiler API and calls `ts.createSourceFile`, while TypeScript 7's root export does not provide that compiler API.

## Package compatibility boundary

TLH is a packaged profile for the upstream Pi runtime, not a programmatic library. Shipped extension and script modules are implementation details unless a module, symbol, or path is explicitly documented as a supported API.

Files may be shipped so runtime discovery or installer workflows can find them; that fact does not stabilize every exported symbol or deep-import path. Contributors may change or remove undocumented exports and internal paths without treating that as a compatibility break. This policy does not narrow any separately documented `tlh` CLI, configuration, runtime entrypoint, or durable artifact contract.

## Run validation

Run the aggregate validation script. What it covers, the Oxlint configuration, the test reporters, and the full-validation rules are in [VALIDATING.md](../VALIDATING.md#standard-full-validation):

```sh
npm run validate
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

`extensions/subagents/src/**/*.ts` is authoritative runtime source; same-layout `.js` files are generated. The runtime entrypoint is `extensions/subagents/src/extension/index.js`, declared directly in the root package's `pi.extensions`. It is not a standalone package dependency and must not be released, published, pinned, or upstream-synced separately from TLH.

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

## Test the extension directly

Test the extension directly from this checkout without installing it. After TypeScript edits, run `npm run build` first so the generated JS entrypoint matches the authoritative source:

```sh
pi --no-extensions -e ./extensions/the-last-harness.js
```

Then run Pi's native thinking picker in the interactive UI (or TLH's supported `/effort` alias):

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

**File-source keybinding caveat (`/effort` picker, Ctrl+S):** under the `file:<checkout>` layout only, the `/effort` picker renders an empty key where `Ctrl+S` should appear, and pressing Ctrl+S does nothing—the picker stays open and no default is saved. Enter and Escape/Ctrl+C still work. This is not a TLH bug. Cause: the pinned Pi runtime renders selector hints from the global pi-tui keybindings registry via `keyDisplayText`/`getKeybindings`, and when TLH is installed from a checkout the checkout's own `node_modules/@earendil-works/pi-coding-agent` supplies a second `pi-coding-agent` (and nested `pi-tui`) module instance whose global keybindings registry is never initialised by the interactive app, so `app.*` binding ids resolve to no keys while `tui.*` ids still resolve from built-in defaults. The unpacked-package layout contains no `node_modules`, so a packaged install has a single module instance and behaves correctly. To verify Ctrl+S persistence, use the unpacked-package layout (npm pack, unpack, then `TLH_PACKAGE_SOURCE=file:<unpacked-package>`).

You can also test a pushed TLH branch through GitHub. The `Install this branch` command is in [CONTRIBUTING.md](../CONTRIBUTING.md#pull-requests-and-ci); for temporary testing without touching your real `tlh` profile or wrapper, add `--agent-dir "$tmp/agent" --bin-dir "$tmp/bin"` to it (with `tmp="$(mktemp -d)"`) and run `"$tmp/bin/tlh"`.

This is a TLH installer test, not a standalone subagent release flow.
