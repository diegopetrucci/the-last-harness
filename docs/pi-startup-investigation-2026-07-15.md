# Pi startup investigation (2026-07-15)

This contributor note records the 2026-07-15 TLH startup study against upstream Pi `0.80.6`.

## Claim labels used here

- **Documented**: stated in Pi `0.80.6` docs.
- **Source-observed**: verified in the published Pi `0.80.6` package source/runtime files.
- **Empirical**: measured locally on the stated machine and workload.

## Scope and non-goals

Question: which startup optimization has the best payoff for TLH with the lowest product and maintenance risk?

Conclusion: **conditional GO for same-layout generated JavaScript entrypoints under Node**, but only if TLH stops using Pi directory discovery and instead lists the exact generated JS entrypoints in `package.json`. **Bun stays deferred** as a separate investigation/decision.

## Immutable Pi `0.80.6` evidence

### Documented contracts

- Pi extensions are loaded through Jiti, so TypeScript works without ahead-of-time compilation. Pi also documents that an async extension factory is awaited before startup continues.
  - Citation: [Pi `0.80.6` extension loading contract, commit `2b3fda9`, lines 178-180](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/extensions.md#L178-L180)
- Pi documents three relevant extension entry styles: single file, directory with `index.ts`, and package-manifest-declared entries.
  - Citation: [Pi `0.80.6` extension styles, commit `2b3fda9`, lines 225-270](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/extensions.md#L225-L270)

### Source-observed behavior

- `loadExtensionModule()` constructs a Jiti loader with `moduleCache: false` and imports each extension entrypoint through it.
  - Citation: [Pi `0.80.6` `loader.ts`, commit `2b3fda9`, lines 381-405](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/extensions/loader.ts#L381-L405)
- `loadExtensionsInternal()` awaits each `loadExtension()` inside a `for` loop, so extension entrypoints load sequentially.
  - Citation: [Pi `0.80.6` `loader.ts`, commit `2b3fda9`, lines 487-518](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/extensions/loader.ts#L487-L518)
- `resolveExtensionEntries()` checks `package.json` `pi.extensions` first, then `index.ts`, then `index.js`.
  - Citation: [Pi `0.80.6` `package-manager.ts`, commit `2b3fda9`, lines 546-574](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/package-manager.ts#L546-L574)
- `collectAutoExtensionEntries()` treats a directory with no root manifest/index as a discovery root, adds direct `*.ts` and `*.js` files, and resolves subdirectories with `resolveExtensionEntries()`.
  - Citation: [Pi `0.80.6` `package-manager.ts`, commit `2b3fda9`, lines 576-628](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/package-manager.ts#L576-L628)

## Controlled environment

**Empirical**

- Date: `2026-07-15`
- Machine: `Mac16,10`
- Upstream runtime under test: Pi `0.80.6`
- Node runtime for the active baseline: `Node 26.4.0`
- Profile source: active `tlh-main` isolated profile, copied into a disposable temporary workspace for each sample set
- Environment flags for all controlled runs: `PI_OFFLINE=1`, `TLH_SKIP_UPDATE_CHECK=1`, `TLH_SKIP_TELEMETRY=1`
- All temporary clones/prototypes were deleted after measurement

## Methodology

**Empirical**

1. Use TLH's PTY startup checker so each sample waits for first visible TLH header/footer rather than only process start.
2. Keep real user state out of the test by cloning an existing isolated TLH profile into a temporary workspace.
3. Compare four configurations against the exact same profile shape and environment flags.
4. Use warm-launch samples for the ranking decision.
5. Use `PI_TIMING=1` and `PI_STARTUP_BENCHMARK=1` spot checks to attribute internal startup cost.

The checker itself documents the same temp-profile/offline behavior:

- `scripts/check-startup-performance.mjs`
- `npm run check:startup-performance`

## Benchmark configurations and exact results

**Empirical**

| Rank by product fit | Configuration | Warm sample size | Mean first header | Delta vs baseline | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| control | Node + current TypeScript extension loading | 20 | `984.4ms` | baseline | VALIDATING.md `<1000ms` repository-wide startup checker objective passes narrowly |
| 1 | Node + same-layout generated first-party JS entrypoints | 15 | `745.6ms` | `-238.8ms` (`-24.3%`) | lowest-blast-radius improvement |
| 2 | Bun standalone + current TypeScript profile | 15 | `731.9ms` | `-252.5ms` (`-25.7%`) | comparable gain, much wider runtime/install surface |
| 3 | Bun standalone + same-layout generated first-party JS | 15 | `604.8ms` | `-379.6ms` (`-38.6%`) | best raw speed, but combines two decisions |

Additional measured baseline details:

- Warm baseline first-header summary over 20 runs: mean `984.4ms`, median `972.3ms`, min `958.4ms`, p90 `992.1ms`, max `1108.7ms`.
- `18/20` warm runs were below `1000ms` and averaged `973.0ms`.
- Two transient spikes at `1064.5ms` and `1108.7ms` consumed most remaining headroom.

Internal timing spot checks for the baseline:

- `createAgentSessionRuntime`: about `471-476ms`
- `interactiveMode.init`: about `163ms`
- total extension timing: about `458-463ms`
- largest labeled extension buckets: TLH main about `211-212ms`, `annotate-git-diff` about `83-86ms`, `subagents` about `82-89ms`, MCP about `29-30ms`, intercom about `21-23ms`

Internal timing spot checks for Node + generated JS:

- `createAgentSessionRuntime` dropped from about `475ms` to about `270ms`
- TLH main labeled import dropped from about `212ms` to about `17ms`
- generated output size for the 63 first-party extension TypeScript files: `632KB`

## Jiti attribution caveat

**Empirical**, informed by the documented/source-observed Jiti loader behavior above.

Do not over-trust the first per-extension import label.

The first extension import in a process absorbs roughly `65-70ms` of one-time Jiti startup cost. In the prototype traces, disabling `annotate-git-diff` reduced total warm extension time by only about `10-17ms` even though its labeled bucket was about `81ms`. Treat extension labels as directionally useful, but optimize total startup time rather than chasing the first bucket literally.

## Why directory discovery is unsafe for adjacent generated JS

**Source-observed** Pi behavior + **source-observed** current TLH tree shape.

Before TLH switched to generated-JS manifest entries, `package.json` declared:

```json
"pi": {
  "extensions": ["./extensions"]
}
```

That worked for the TypeScript-only tree, because Pi discovered:

- direct files such as `extensions/rtk.ts` and `extensions/the-last-harness.ts`
- nested `index.ts` such as `extensions/annotate-git-diff/index.ts`

If TLH adds adjacent generated `.js` files and keeps `"./extensions"` as the manifest entry, Pi `0.80.6` discovery would also see the top-level generated `*.js` files. That creates duplicate top-level TS/JS loads. For nested directories, Pi's `resolveExtensionEntries()` checks `index.ts` before `index.js`, so `annotate-git-diff/index.ts` would still win over adjacent generated `index.js`.

Result: mixed TS/JS directory discovery is not a safe packaging mode for TLH.

### Required safeguard

If TLH ships generated JS, `package.json` must stop pointing at the directory and must instead list the exact ordered JS entrypoints:

```json
"pi": {
  "extensions": [
    "./extensions/annotate-git-diff/index.js",
    "./extensions/rtk.js",
    "./extensions/the-last-harness.js"
  ]
}
```

This keeps same-layout asset resolution intact while preventing mixed-tree duplicate discovery.

## Candidate ranking

### 1. Conditional GO: generated first-party JS under Node

Why it wins:

- **Empirical**: recovers `238.8ms` mean warm first-header time, bringing the measured mean to `745.6ms`.
- **Documented/source-observed**: fits Pi's existing extension model because Pi already accepts explicit manifest entrypoints and loads `.js` files through the same extension loader.
- **Product fit**: preserves the current TLH installer/runtime/update/uninstall model and avoids changing end-user runtime assumptions.

Required safeguards:

- keep `extensions/**/*.ts` authoritative
- generate same-layout ESM `.js` alongside runtime-reachable first-party extension sources
- replace directory discovery with exact JS manifest entries
- add freshness validation so stale/missing generated outputs fail fast

### 2. Deferred: Bun with the current TypeScript profile

Why not first:

- **Empirical**: slightly faster than Node + generated JS (`731.9ms` vs `745.6ms`), but only by `13.7ms`
- **Tradeoff**: adopting Bun changes runtime, installer, update, uninstall, and platform-support assumptions instead of only changing package contents

### 3. Deferred: Bun + generated JS

Why deferred despite the best raw result:

- **Empirical**: fastest measured mean at `604.8ms`
- **Tradeoff**: combines two independent decisions, so it is a poor first landing if the goal is low-blast-radius startup improvement

## Recommendation

Ship the packaging-only optimization first:

1. generate first-party same-layout JS runtime files
2. point `package.json` at the exact JS entrypoints
3. keep Node as the runtime for TLH
4. re-run the startup checker and `PI_TIMING` after implementation

This is the narrowest path that materially improves startup while preserving the current TLH product contract.

## Reproduction guidance

Use placeholders such as `<profile-source>`, `<managed-pi-command>`, and `<bun-pi-command>`; do not run against a real personal profile in place.

### Current baseline reproduction

```sh
npm run check:startup-performance -- --runs 20 --profile-source "<profile-source>"
```

Where `<profile-source>` is a disposable copy or clone source for an existing isolated TLH profile. The checker already clones that profile into its own temporary workspace and forces:

```text
PI_OFFLINE=1
TLH_SKIP_UPDATE_CHECK=1
TLH_SKIP_TELEMETRY=1
```

### Internal timing spot check

```sh
workdir="$(mktemp -d)"
cp -R "<profile-source>" "$workdir/agent"
PI_CODING_AGENT_DIR="$workdir/agent" \
PI_OFFLINE=1 \
TLH_SKIP_UPDATE_CHECK=1 \
TLH_SKIP_TELEMETRY=1 \
PI_TIMING=1 \
PI_STARTUP_BENCHMARK=1 \
"<managed-pi-command>"
rm -rf "$workdir"
```

### Generated-JS prototype reproduction

In a disposable checkout:

1. generate same-layout `.js` files for the first-party extension tree
2. change `package.json` `pi.extensions` to the exact JS entrypoints shown above
3. run the same startup checker command against the disposable profile/worktree

### Bun prototype reproduction

Use the same disposable profile method, but replace the launched runtime with a checksum-verified official Pi `0.80.6` Bun standalone command for the target platform. Keep the same `PI_OFFLINE`, update-check, and telemetry skips.

## Limitations

- **Empirical** results are single-machine (`Mac16,10`) measurements, not a cross-platform guarantee.
- Sample sizes differed: `20` warm runs for the active baseline, `15` warm runs for each disposable prototype.
- These measurements describe startup to first visible TLH header, not end-to-end task latency.
- Bun compatibility, installer changes, updater behavior, and uninstall/recovery behavior were intentionally out of scope here.

## Residual risks

- Even the baseline pass was close to the `1000ms` release objective; transient load spikes can still push individual runs over budget.
- Generated JS introduces a freshness/packaging maintenance burden if validation is not strict.
- If exact JS manifest entries drift from the real generated files, TLH could silently regress to missing or duplicate extensions.
- Existing user/custom package filters or exclusions that explicitly reference `.ts` entrypoints may stop matching after the manifest moves to `.js`; implementation and migration validation must audit and preserve those filters deliberately.
- Pi sets Jiti's entrypoint `moduleCache` to false, but `/reload` behavior for native transitive JavaScript imports can still be affected by Node's module cache. This is source-observed/empirical behavior rather than a documented Pi contract, so reload correctness needs explicit regression coverage.
- Bun may still be worthwhile later, but it needs its own compatibility matrix and product decision rather than being bundled into the packaging fix.

## Final implementation validation (2026-07-15)

**Empirical**

Validation used only disposable temp profiles plus the managed Node Pi runtime and wrapper from the active `tlh-main` install. No real profile or normal Pi config was modified.

### Final check set

- `npm run validate`: passed before the documentation-only correction below.
- `git diff --check`: passed.
- Local checkout install/startup smoke with explicit temp `PI_CODING_AGENT_DIR`: passed. The loaded first-party entrypoints were exactly `extensions/annotate-git-diff/index.js`, `extensions/rtk.js`, and `extensions/the-last-harness.js`, with no first-party `.ts` entrypoint loaded.
- The local-development package-install example was corrected to use Pi `0.80.6`'s supported direct checkout path, `pi install "$PWD"`. The installer-specific `TLH_PACKAGE_SOURCE="file:$PWD"` example remains unchanged.
- A direct managed-Pi sample against a disposable clone of the active `tlh-main` profile passed `17` controlled launches (`16` warm) below `800ms`, but that sample omitted wrapper overhead.
- VALIDATING.md keeps the repository-wide startup checker objective at a steady-state first-header mean below `1000ms`. This workflow/ticket kept its deliberately stricter unchanged target below `800ms` for the wrapper-inclusive warm first-header mean.
- Three corrected `17`-launch samples used a temporary PATH entry named `tlh` pointing at the active managed `tlh-main` wrapper, allowing the checker to generate its own temporary managed wrapper and use the wrapper's stable `NODE_COMPILE_CACHE`. All three measured the development-checkout package path. Their warm first-header means averaged approximately `806.1ms`, improving `178.3ms` (`18.1%`) from the documented `984.4ms` baseline while still missing this ticket's stricter `<800ms` target.
- An initial attempted packed-artifact sample reported a `878.9ms` warm first-header mean, but it was discarded: installing the tarball into the cloned profile reported `changed 228 packages`, mutating unrelated extension dependencies and invalidating the fixture. It is not used as pass/fail evidence.
- One corrected release-shaped `17`-launch sample packed the current checkout with `npm pack`, installed that tarball offline into a separate otherwise-empty staging prefix, and cloned the active profile without running npm inside it. A recursive comparison confirmed that the clone's `npm` prefix remained unchanged. Only the clone settings' first TLH package source was changed, pointing it to the absolute staged `the-last-harness` directory. Before launch, package resolution verified `the-last-harness@0.29.0` and exactly the three generated JS manifest entrypoints. A temporary PATH `tlh` pointed to the active managed `tlh-main` wrapper, and the checker ran once in its default managed-wrapper mode with `--approve` passed through to Pi. This corrected release-shaped sample missed the unchanged `800ms` gate, and that miss stays explicit in the final evidence rather than being reported as a pass.
- A warmed `PI_TIMING=1 PI_STARTUP_BENCHMARK=1` spot check used the same disposable local-checkout profile and explicitly set `NODE_COMPILE_CACHE` to the active private runtime's cache. It confirmed that all three first-party entrypoints loaded from `.js` files.

### Measured startup results

| Validation target | Runs | Cold first header | Warm first header mean | Warm median | Warm min | Warm max | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Temp local-checkout install/startup smoke | 2 total / 1 warm | `402.3ms` | `400.1ms` | `400.1ms` | `400.1ms` | `400.1ms` | pass |
| Direct managed Pi, disposable cloned profile | 17 total / 16 warm | `2484.4ms` | `779.7ms` | `773.8ms` | `764.6ms` | `824.5ms` | pass, but excludes wrapper overhead |
| Managed wrapper sample 1 | 17 total / 16 warm | `3466.0ms` | `800.7ms` | `800.7ms` | `775.5ms` | `830.6ms` | fail |
| Managed wrapper sample 2 | 17 total / 16 warm | `3427.4ms` | `800.1ms` | `799.7ms` | `789.6ms` | `821.0ms` | fail |
| Managed wrapper sample 3 | 17 total / 16 warm | `3669.3ms` | `817.4ms` | `813.8ms` | `800.1ms` | `866.0ms` | fail |
| Corrected packed npm artifact, managed wrapper | 17 total / 16 warm | `3394.9ms` | `857.8ms` | `855.7ms` | `847.8ms` | `868.1ms` | fail |

The three development-checkout managed-wrapper warm footer means were `826.6ms`, `824.7ms`, and `842.7ms`, respectively. The distinct corrected release-shaped packed-artifact sample had a warm footer mean of `880.3ms` (median `880.8ms`, min `866.0ms`, max `899.9ms`). Its warm first-output mean was `837.0ms` (median `835.5ms`, min `827.8ms`, max `847.7ms`). Its warm first-header mean of `857.8ms` improved `126.6ms` (`12.9%`) from the documented `984.4ms` baseline but still missed this ticket's unchanged `<800ms` target. The packed tarball was `598190` bytes (`2567968` bytes unpacked) and resolved as `the-last-harness@0.29.0` from the separate staging prefix. The disposable profile's existing npm dependencies were unchanged.

### Warm `PI_TIMING` spot-check details

Startup timing summary from the warmed disposable cloned profile with the active private runtime's stable `NODE_COMPILE_CACHE`:

- `createAgentSessionRuntime`: `974ms`
- `interactiveMode.init`: `145ms`
- main startup `TOTAL`: `1124ms`
- extension startup `TOTAL`: `961ms`

First-party entrypoints confirmed as generated JavaScript during that timed run:

- `extensions/annotate-git-diff/index.js`: module import `95ms`, factory `0ms`
- `extensions/rtk.js`: module import `650ms`, factory `5ms`
- `extensions/the-last-harness.js`: module import `29ms`, factory `0ms`

The first labeled entrypoint still includes one-time Jiti attribution cost, and this spot check was slower than the preceding controlled launch samples; it is diagnostic evidence rather than the release-budget measurement.

### Final residual risk readout

- The three development-checkout wrapper-inclusive warm first-header means were `0.7ms`, `0.1ms`, and `17.4ms` over the strict `800ms` requirement. Those probes remain a startup-sensitivity signal, not release-shaped package evidence.
- The corrected release-shaped packed-artifact wrapper sample was `57.8ms` over this ticket's strict `<800ms` requirement, with a warm first-header mean of `857.8ms`. That still sits below VALIDATING.md's broader `<1000ms` repository-wide startup checker objective, but it did not establish that the shipped layout meets this workflow's stricter target. The budget was not weakened, the `857.8ms` miss remains explicit, and the release-shaped sample was run only once.
- The direct managed-Pi pass demonstrates the generated-JS improvement but is not sufficient release evidence because it excludes wrapper startup overhead.
- The user accepted the material generated-JS improvement for this change, despite the unchanged ticket-specific `<800ms` target remaining unmet in the corrected wrapper-inclusive package sample.
- Broader eager-import or lazy-loading work was considered and explicitly declined here as out of scope for this ticket.
- Warm startup remains sensitive to transient machine load and cache state on this single tested machine.
