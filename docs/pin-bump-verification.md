# Retired subagent pin-bump checklist

> **Historical status:** the standalone package pin checklist is retired now that the subagent runtime is first-party TLH code. It must not be used to publish, release, or pin a subagent package.

Older TLH releases installed and pinned a separate `@diegopetrucci/pi-subagents` package. The former live-session checklist and GitHub issue [#346](https://github.com/diegopetrucci/the-last-harness/issues/346) tracked that package's pin bumps. `config/default-extensions.json` no longer contains a subagent package pin, and current TLH install/update does not publish or fetch a standalone subagent release.

## Current validation boundary

The imported unit/integration/E2E suites, focused TLH regressions, package assertions, and provenance checks now run through the root repository. They cover the compact parent-facing description, the closed action surface, bundled-agent safety, async status, steering, and resume mechanics.

`npm run validate` does **not** replace the former live-session checks. Rendering and real parent/child coordination still require release-tier validation in an installed TLH session. This durable checklist and the release-tier section in [VALIDATING.md](../VALIDATING.md) are the live owners; issue #346 and the historical identifier `tlh-2ej0` are retained only as historical context for the old delivery mechanism.

## Current release-tier live checklist

Run these checks against the packaged TLH release candidate, without creating or changing any standalone subagent pin:

- [ ] **Compact parent-facing description:** the live `subagent` tool description always renders in compact form while retaining its safety-critical delegation guidance.
- [ ] **Native supervisor coordination:** a minor agent's `contact_supervisor` request reaches the architect through the native supervisor channel and the pause/resume choice is delivered correctly.
- [ ] **Maximum-thinking badge:** a supported `:max` model renders the expected `max` thinking badge in a live child run.
- [ ] **Delegation and lifecycle smoke:** delegate to the nine supported TLH minor agents, including the execution-only shell/MCP `test-runner`, confirm a non-allowlisted target is blocked, confirm primary delegation uses user scope plus fresh context, and exercise an async run through `status` and `resume`.
- [ ] **Pi 0.87.1 model/thinking validation:** with a real provider, verify model-selection persistence and provider-backed thinking levels (including the supported maximum-thinking badge).
- [ ] **Pi 0.87.1 native cache validation:** with a real provider, verify native streaming and idle cache warming, cache-miss notices, and `cache_warm` usage/accounting.
- [ ] **Pi 0.87.1 saved-session lifecycle:** with a saved assistant response, verify session resume, branch/fork, and meaningful compaction behavior.
- [ ] **Pi 0.87.1 provider-backed subagent flow:** verify a live parent/child subagent turn through the installed release candidate.
- [ ] **Pi 0.87.1 published-ref update convergence:** once the release ref advertises Pi `0.87.1`, verify update convergence from the published ref.

These five Pi 0.87.1 checks are required release-preparation work. The live-provider items remain deferred because this ticket excludes paid-provider execution and does not treat faux-provider or offline seams as substitutes. Published-ref update convergence is deferred separately because no published ref currently advertises Pi `0.87.1`. Record the release candidate, profile, session evidence, and outcomes in the release validation notes/current release tracking; do not mark these checks complete from static validation alone.

## Pi 0.84.4 isolated verification record

The 0.84.4 model/effort persistence seams were smoke-tested without a home-directory install. Both runs used isolated `HOME`, XDG, agent, and wrapper-bin directories and a PTY:

- **File-source layout:** install with `TLH_PACKAGE_SOURCE=file:<checkout>` and run the isolated `tlh` wrapper. Pi 0.84.4 startup, one-picker Enter (session-only), Ctrl+S (future-session persistence), active-primary model overrides, native `/thinking` cancellation, and `/effort` Enter/Ctrl+S/Esc behavior passed.
- **Unpacked-package layout:** create an `npm pack` tarball, unpack it into an isolated directory, install with `TLH_PACKAGE_SOURCE=file:<unpacked-package>`, and repeat the same PTY assertions. The checks passed, including bundled-runtime loading and `reconcile-state.json`/primary-agent status evidence.

A reproducible outline is:

```sh
root="$(mktemp -d)"
mkdir -p "$root/home" "$root/xdg" "$root/agent" "$root/bin"
TLH_PACKAGE_SOURCE="file:<checkout-or-unpacked-package>" \
  HOME="$root/home" XDG_CONFIG_HOME="$root/xdg" \
  bash install.sh --agent-dir "$root/agent" --bin-dir "$root/bin"
# Drive "$root/bin/tlh" (or the ref-derived wrapper name) through a PTY with --approve and assert the outcomes above.
rm -rf "$root"
```

These are offline interaction checks; no credentialed provider turn or release-tier live check was performed. A fake provider key was tried separately and returned HTTP 401, so that result is not evidence of a successful live check. The valid candidate-layout startup observation was a **636.1 ms warm first-header mean**. A later direct custom-command candidate-layout run using `--budget-ms 3000 -- --approve` measured **798.7 ms** warm first-header mean; these numbers are environment-sensitive and are not a regression claim. `scripts/check-startup-performance.mjs` measures the launched command and its temporary profile clone, not the working tree by itself. Earlier PATH-discovered installed-wrapper runs reported 1104.0 ms and 1683.3 ms but were inconclusive old-profile observations, not candidate startup measurements.

## Pi 0.85.1 isolated verification record

The 0.85.1 runtime structure and effort-picker seams were smoke-tested without a home-directory install on macOS (Mac16,10-class, tmux 3.7c). Both runs used isolated `HOME`, `XDG_CONFIG_HOME`, agent, and wrapper-bin directories under `mktemp` and a tmux PTY; `~/.pi/agent` was confirmed unmodified with zero files changed in the last 60 minutes.

- **File-source layout:** install with `TLH_PACKAGE_SOURCE=file:<checkout>`. The installer completed and startup rendered the TLH profile. A keybinding caveat specific to this layout was discovered: the `/effort` picker renders an empty key where `Ctrl+S` should appear, and pressing Ctrl+S does nothing. This is documented in [local-development.md](local-development.md) and does not affect packaged installs.
- **Unpacked-package layout (the layout that matches a real user install):** create an `npm pack` tarball, unpack it into an isolated directory, and install with `TLH_PACKAGE_SOURCE=file:<unpacked-package>`. The following was verified:
  - Installed runtime reports `0.85.1`; the runtime prefix top level is exactly `bin` and `lib`, and `lib/node_modules/@earendil-works` contains only `pi-coding-agent`, so `uninstall.sh`'s `RUNTIME_OWNED_TOPLEVEL` advisory tripwire still holds.
  - Startup renders the TLH profile with no provider configured.
  - The `/effort` picker renders `Enter to select | Ctrl+S to set as default | Escape/Ctrl+C to cancel`. The cancel hint is 0.85.1 configurable-binding text; on 0.84.4 the same hint read `Esc to cancel`.
  - Enter selects for the session only: notification `Thinking level set to off for this session.`
  - Ctrl+S saves a future-session default: a notification confirming the save, `settings.json` gains `defaultThinkingLevel`, and a timestamped `settings.json.bak-*` backup is written.
  - Escape cancels and closes the picker with no notification and no settings change.
  - Pi's native model picker renders `Enter to select | Ctrl+S to set as default | Escape/Ctrl+C to cancel`.
  - Only the `off` thinking level was available because no provider was configured.

The isolation method is the same as the 0.84.4 record:

```sh
root="$(mktemp -d)"
mkdir -p "$root/home" "$root/xdg" "$root/agent" "$root/bin"
TLH_PACKAGE_SOURCE="file:<checkout-or-unpacked-package>" \
  HOME="$root/home" XDG_CONFIG_HOME="$root/xdg" \
  bash install.sh --agent-dir "$root/agent" --bin-dir "$root/bin"
# Drive "$root/bin/tlh" (or the ref-derived wrapper name) through a PTY with --approve and assert the outcomes above.
rm -rf "$root"
```

These are offline interaction checks. No credentialed provider turn, no model-catalogue persistence check with real models, and no max-thinking-badge check were performed. Only the `off` thinking level was available in the picker because no provider was configured.

## Current sources

- [subagents.md](subagents.md) for user-visible runtime, migration, diagnostics, and undo behavior;
- [VALIDATING.md](../VALIDATING.md) for automated checks and the current release-tier live checklist;
- [subagents-history/HISTORY.md](subagents-history/HISTORY.md) for the exact source checkpoint and integration history;
- `npm run validate` for the standard repository gate.

The old package-release, pin-bump, and fork-sync procedures are preserved only in the immutable archive under `docs/subagents-history/source/`. They are historical evidence and must not be followed as current TLH instructions. This retirement makes no claim about deprecating or unpublishing any npm package, changing repository hosting state, deleting source, or archiving a GitHub repository.

## Pi 0.87.1 isolated verification record — `tlhf-i8ly` (2026-09-23 UTC)

This record covers the temporary-prefix acceptance run for ticket `tlhf-i8ly`. It appends evidence to the historical records above; it does not change the retired pin-bump procedure or claim that release-tier live validation is complete.

### Scope and install layouts

- All install, update, repair, PTY, RPC, and uninstall work used temporary `HOME`, XDG, agent, runtime, wrapper-bin, and session paths. The source-install evidence came from `/tmp/tlhf-i8ly-prep-nsWj4t`; the accepted packed lifecycle, repair, update, PTY, and RPC evidence came from `/tmp/tlhf-i8ly-pack2-LpTPy5`; and the accepted fresh packaged cache/constructor evidence came from `/tmp/tlhf-i8ly-packprobe-maKDbG`. The earlier `/tmp/tlhf-i8ly-pack-WElLNC` install/probe was superseded and is documented only as cleanup context; it contributes no accepted claim here. No real home-directory install, paid provider, fake provider credential, commit, or remote branch/tag mutation was used.
- **Source layout:** the current checkout was installed with `TLH_PACKAGE_SOURCE=file:<checkout>`, `PI_OFFLINE=1`, update/telemetry/Gnosis skips, and explicit `--agent-dir`/`--bin-dir` values. The wrapper and private runtime both reported Pi `0.87.1`.
- **Packaged layout:** `npm pack` produced `the-last-harness-0.42.1.tgz`; the extracted package used by the accepted lifecycle/PTY/RPC run was under `/tmp/tlhf-i8ly-pack2-LpTPy5/unpacked/package`, while the accepted fresh cache/constructor probe used `/tmp/tlhf-i8ly-packprobe-maKDbG/unpacked/package`. Their wrappers and private runtimes reported Pi `0.87.1`. The extracted directories, rather than the `.tgz` itself, were used because Pi cannot load a compressed archive as an extension source.

### Runtime ownership, repair, and profile safety

The packaged evidence came from separate temporary roots and is not one combined topology/repair claim:

- **Fresh cache-topology probe (`/tmp/tlhf-i8ly-packprobe-maKDbG`):** immediately after installation and before launching the wrapper, the runtime top level was `.tlh-runtime-owned`, `bin`, and `lib`; `node-compile-cache` was absent. The first `bin/tlh-main --version` launch created `node-compile-cache` with 1,471 files, after which the top level was `.tlh-runtime-owned`, `bin`, `lib`, and `node-compile-cache`. Its `bin/pi` and wrapper reported `0.87.1`, and `lib/node_modules/@earendil-works` contained the private `@earendil-works/pi-coding-agent` package.
- **Lifecycle/repair root (`/tmp/tlhf-i8ly-pack2-LpTPy5`):** this separate packed run supplied the marker, private-runtime update/repair, doctor, lifecycle, and pre-uninstall evidence. Its pre-uninstall runtime top level was `.tlh-runtime-owned`, `bin`, `lib`, and `node-compile-cache`, and its ownership marker was:

```json
{"schemaVersion":1,"packageName":"@earendil-works/pi-coding-agent","runtimeAbsPath":"/private/tmp/tlhf-i8ly-pack2-LpTPy5/runtime","origin":"created"}
```

The four top-level entries observed in the packaged runs are exactly the entries permitted by the private-runtime uninstall allow-list (`.tlh-runtime-owned`, `bin`, `lib`, and `node-compile-cache`). The older 0.85.1 record's `bin`/`lib`-only wording is a separate historical snapshot that did not capture the lazy post-launch cache entry; it does not contradict the direct 0.87.1 timing probe.

The following repair paths were exercised in temporary profiles. The source root `/tmp/tlhf-i8ly-prep-nsWj4t` supplied the missing-runtime/user-state staged repair, while the packed lifecycle root `/tmp/tlhf-i8ly-pack2-LpTPy5` supplied the private-runtime update/repair and doctor checks:

- deleting `runtime/bin/pi` and rerunning the current local installer restored Pi `0.87.1` while retaining the marker and runtime path;
- adding a user sentinel (`userUpdateSentinel: {"ticket":"tlhf-i8ly","value":"preserve-me"}`), changing the thinking-level state, and rerunning the installer preserved the user state while converging the missing runtime; and
- `tlh doctor` reported `5 OK, 3 WARN, 0 FAIL`, identifying one pending packaged settings append. `tlh doctor --repair` applied the settings repair and reported `6 OK, 2 WARN, 0 FAIL`; the remaining warnings were manual MCP/EXA and `gh` authentication prerequisites, not repair failures.

A temporary uncaught-exception probe in the source-install root `/tmp/tlhf-i8ly-prep-nsWj4t/source` wrote `/tmp/tlhf-i8ly-prep-nsWj4t/source/agent/crashes.json` with Pi version `0.87.1`. For the real normal `~/.pi/agent` profile, the baseline and after snapshots were file-content/path SHA-256 manifests produced with:

```sh
find -P "$HOME/.pi/agent" -mindepth 1 -print0 |
  sort -z | xargs -0 shasum -a 256 2>/dev/null > normal-before.paths.sha256
# after the temporary run, repeat the same command to normal-after.paths.sha256
```

The two manifests each contained 23,219 file-hash lines, neither contained a `crashes.json` path, and `cmp -s` returned 0. This pair brackets the **source-install window only**; it was not a before/after manifest for the later packaged, update, repair, PTY/RPC, or constructor/cache-probe phases. Those later phases used explicit temporary paths and environment variables and have only the separate post-run normal `~/.pi/agent/crashes.json` absence check, not a bracketing normal-profile manifest proof. The precise conclusion for the source-install pair is **no observed net change in the compared snapshot**. This file-content/path comparison does not cover metadata or prove that no transient write occurred. A later full recursive scan was not used as the acceptance signal because the existing normal profile is large and that scan timed out.

### Constructor patch and interactive seams

The earlier compile-cache launcher probe is explicitly **source-layout** evidence. It emitted:

```text
TLH_CONSTRUCTOR_PROBE {"piVersion":"0.87.1","entrypoint":"/tmp/tlhf-i8ly-prep-nsWj4t/source/runtime/bin/pi","installed":true,"modularPatched":true,"bundledPatched":true,"sharedOwner":true,"modularSetterWrapped":true,"bundledSetterWrapped":true,"cacheDir":"/tmp/tlhf-i8ly-prep-nsWj4t/source/runtime/node-compile-cache","profile":"/tmp/tlhf-i8ly-prep-nsWj4t/source/agent"}
```

A fresh **unpacked-package-layout** probe under `/tmp/tlhf-i8ly-packprobe-maKDbG` supplied three explicit inputs to the single-process probe: the **modular** input was `/tmp/tlhf-i8ly-packprobe-maKDbG/runtime/lib/node_modules/@earendil-works/pi-coding-agent`, the **runtime** input was `/tmp/tlhf-i8ly-packprobe-maKDbG/runtime` (used to resolve its bundled constructor), and the **package** input was `/tmp/tlhf-i8ly-packprobe-maKDbG/unpacked/package` (used to load the packaged TLH seam). It was preloaded with `NODE_OPTIONS=--import=/tmp/tlhf-i8ly-packprobe-maKDbG/constructor-probe.mjs` and invoked through the packaged compile-cache-aware wrapper `/tmp/tlhf-i8ly-packprobe-maKDbG/bin/tlh-main --version`, not by invoking `node` directly; that wrapper launched the private Pi entrypoint `/tmp/tlhf-i8ly-packprobe-maKDbG/runtime/bin/pi`, and the probe record reported `cacheDir=/tmp/tlhf-i8ly-packprobe-maKDbG/runtime/node-compile-cache`. It emitted:

```text
TLH_CONSTRUCTOR_PROBE {"piVersion":"0.87.1","entrypoint":"/tmp/tlhf-i8ly-packprobe-maKDbG/runtime/bin/pi","installed":true,"modularPatched":true,"bundledPatched":true,"sharedOwner":true,"modularSetterWrapped":true,"bundledSetterWrapped":true,"cacheDir":"/tmp/tlhf-i8ly-packprobe-maKDbG/runtime/node-compile-cache","profile":"/tmp/tlhf-i8ly-packprobe-maKDbG/agent"}
```

The direct packaged single-process result confirms that both the modular and bundled `AgentSession` constructors were patched under Pi `0.87.1`, with one shared owner and wrapped model/thinking setters in both forms; it is not inferred from the source-layout probe.

Offline PTY checks on the accepted packaged lifecycle profile `/tmp/tlhf-i8ly-pack2-LpTPy5` also passed the useful no-provider seams:

- `/model` opened the native picker and rendered the expected select/default/cancel controls; with no credentials it correctly showed no matching models.
- `/effort` registered and opened the TLH picker. Enter selected `off` for the current session, Ctrl+S saved the future-session default and created a timestamped `settings.json.bak-*`, and Escape cancelled without a settings change.
- A live provider turn was intentionally not attempted. The observed boundary was `Error: No API key found for the selected model` / `No models available`, so model-catalogue persistence, provider-backed thinking levels, the max-thinking badge, native streaming and idle cache warming, cache-miss notices, and `cache_warm` usage/accounting remain release-tier checks. These live-provider checks are deferred because this approved ticket excludes paid-provider runs; their owning process is the durable release-preparation checklist in [VALIDATING.md](../VALIDATING.md) and this checklist, with outcomes recorded in release validation notes/current release tracking.

### Session and subagent lifecycle

The isolated Pi RPC process in `/tmp/tlhf-i8ly-pack2-LpTPy5` successfully handled `get_state`, `new_session`, a second `get_state`, and `get_entries`; the new session ID and session file changed as expected. Manual `compact` on the empty session emitted the expected `Nothing to compact (session too small)` response. `clone` on an unsaved session was rejected safely with `This session has not been saved yet. Wait for the first assistant response before cloning or forking it.`

A saved assistant response is required to make resume/branch/fork and meaningful compaction assertions. With no provider credentials, those post-response paths were not faked and remain release-tier validation. Together with the provider-dependent model/cache checks above, they are owned by the release-tier manual validation/checklist in [VALIDATING.md](../VALIDATING.md) and remain required during release preparation because this approved ticket excludes paid-provider runs. The deterministic first-party child path was nevertheless exercised by:

```sh
env -u PI_SUBAGENT_CHILD npm run test:subagents:e2e
# subagents e2e: 1/1 passed (1 file)
```

That E2E uses a real parent session, a real first-party child process, and a faux provider to verify the child result returns through the parent tool path without an API key. A provider-backed subagent launch from the installed offline profile remains deferred with the other release-tier live checks.

### Startup, update, and rollback evidence

`scripts/check-startup-performance.mjs` was run with the same isolated wrapper/profile inputs within each run, four runs, `PI_OFFLINE=1`, `TLH_SKIP_UPDATE_CHECK=1`, and `TLH_SKIP_TELEMETRY=1`. The documented objective is a warm first-header mean below `1000 ms`:

| layout/run | cold first header | warm first-header mean | result |
| --- | ---: | ---: | --- |
| source | `1723.5 ms` | `810.9 ms` | pass |
| source rerun | `1702.0 ms` | `860.3 ms` | pass |
| unpacked package | `1118.6 ms` | `591.5 ms` | pass |

These are environment- and layout-sensitive observations: the source and unpacked-package runs used different package layouts and separate temporary wrapper/profile clones, and cold/warm state (including Node/module cache state) was not a controlled cross-layout variable. The source rerun also demonstrates ordinary run-to-run variation. These numbers are therefore **not a source-versus-package regression comparison**; the acceptance signal is only that each run set's warm first-header mean remained below the `1000 ms` budget. Cold values are first-run observations, not the release objective.

A real temporary `tlh update --verbose` was also run using the recorded `track=ref`, `ref=main` state. The fetched remote `main` installer still required Pi `0.85.1` and reported `Pi 0.85.1 is required (found 0.87.1)`. The immediate post-update observations were: runtime `bin/pi` `0.85.1`; install state `track=ref`, `ref=main`, `packageSource=file:/tmp/tlhf-i8ly-pack2-LpTPy5/unpacked/package`, `packageSourceIsDefault=false`, `wrapperName=tlh`, `agentDir=/tmp/tlhf-i8ly-pack2-LpTPy5/agent`, `binDir=/tmp/tlhf-i8ly-pack2-LpTPy5/bin`, and `piInstalledByTlh=true`; the wrapper was recreated at the recorded `bin/tlh` path; and the installer reported that it backed up existing isolated settings and then made no settings changes. The update log did not include a separate post-update marker-content or settings-content dump, so those values are not inferred here. This run refreshed installer/package support and profile handling as well as changing the private Pi version; the evidence does not justify saying that the runtime was the only changed component.

The local restore then used `TLH_PACKAGE_SOURCE=file:/tmp/tlhf-i8ly-pack2-LpTPy5/unpacked/package`, `PI_OFFLINE=1`, explicit temporary agent/bin paths, and the current installer with `--track ref --ref main`. Its log directly shows pinning the private Pi package back to `0.87.1`, reinstalling the unpacked TLH package, applying isolated settings and keybindings, installing bundled default extensions, and recreating the wrapper. The subsequent temporary checks observed wrapper/runtime `0.87.1`, the path-matched `origin=created` ownership marker, and the allow-listed runtime top level before uninstall; the staged source-layout repair separately verified preservation of the user sentinel, install-state target, and settings/profile paths. True published-ref update convergence is separately deferred because no published ref currently advertises Pi `0.87.1`; the remote-main result is an unpublished-branch limitation, not a TLH regression.

Finally, before deletion each exact cleanup target was verified as a non-symlink directory under physical `/private/tmp`, owned by this ticket's user, with ticket-specific install-state, runtime-marker, or prior-uninstall evidence. The uninstaller dry-run showed only the matching temporary wrapper, agent, and marked runtime; the real temporary uninstall then removed those managed artifacts where present (the previously uninstalled `pack2` root was a no-op). The four ticket-owned roots `/tmp/tlhf-i8ly-prep-nsWj4t`, `/tmp/tlhf-i8ly-pack-WElLNC`, `/tmp/tlhf-i8ly-pack2-LpTPy5`, and `/tmp/tlhf-i8ly-packprobe-maKDbG` were then removed, and no other path was deleted. The normal Pi configuration and separately installed `pi` remained untouched. The cleanup scope for these temporary artifacts is exactly those four roots. The live-provider, saved-session resume/branch/compaction, and provider-backed subagent items remain deferred because of the paid-provider exclusion; published-ref update convergence remains deferred because no published ref advertises Pi `0.87.1`.
