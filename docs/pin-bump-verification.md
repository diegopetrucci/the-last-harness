# Retired subagent pin-bump checklist

> **Historical status:** the standalone package pin checklist is retired now that the subagent runtime is first-party TLH code. It must not be used to publish, release, or pin a subagent package.

Older TLH releases installed and pinned a separate `@diegopetrucci/pi-subagents` package. The former live-session checklist and GitHub issue [#346](https://github.com/diegopetrucci/the-last-harness/issues/346) tracked that package's pin bumps. `config/default-extensions.json` no longer contains a subagent package pin, and current TLH install/update does not publish or fetch a standalone subagent release.

## Current validation boundary

The imported unit/integration/E2E suites, focused TLH regressions, package assertions, and provenance checks now run through the root repository. They cover the compact parent-facing description, the closed action surface, bundled-agent safety, async status, steering, and resume mechanics.

`npm run validate` does **not** replace the former live-session checks. Rendering and real parent/child coordination still require release-tier validation in an installed TLH session. This durable checklist and the release-tier section in [VALIDATING.md](../VALIDATING.md) are the live owners; issue #346 and the historical identifier `tlh-2ej0` are retained only as historical context for the old delivery mechanism.

## Current release-tier live checklist

Run these checks against the packaged TLH release candidate, without creating or changing any standalone subagent pin:

- [x] **Compact parent-facing description:** the live `subagent` tool description always renders in compact form while retaining its safety-critical delegation guidance. Passed in the packaged `v0.43.0` candidate on 2026-09-25 (`tlhf-u2gu`).
- [x] **Native supervisor coordination:** a minor agent's `contact_supervisor` request reaches the architect through the native supervisor channel and the pause/resume choice is delivered correctly. Passed in the packaged `v0.43.0` candidate on 2026-09-25 (`tlhf-u2gu`).
- [x] **Maximum-thinking badge:** a supported `:max` model renders the expected `max` thinking badge in a live child run. Passed in the packaged `v0.43.0` candidate on 2026-09-25 (`tlhf-u2gu`).
- [x] **Delegation and lifecycle smoke:** delegate to the nine supported TLH minor agents, including the execution-only shell/MCP `test-runner`, confirm a non-allowlisted target is blocked, confirm primary delegation uses user scope plus fresh context, and exercise an async run through `status` and `resume`. Passed in the packaged `v0.43.0` candidate on 2026-09-25 (`tlhf-u2gu`).
- [x] **Pi 0.87.1 model/thinking validation:** with a real provider, verify model-selection persistence and provider-backed thinking levels (including the supported maximum-thinking badge). Passed in the packaged `v0.43.0` candidate on 2026-09-25 (`tlhf-u2gu`).
- [x] **Pi 0.87.1 native cache validation:** with a real provider, verify native streaming and idle cache warming, cache-miss notices, and `cache_warm` usage/accounting. Passed in the packaged `v0.43.0` candidate on 2026-09-25 (`tlhf-u2gu`).
- [x] **Pi 0.87.1 saved-session lifecycle:** with a saved assistant response, verify session resume, branch/fork, and meaningful compaction behavior. Passed in the packaged `v0.43.0` candidate on 2026-09-25 (`tlhf-u2gu`).
- [x] **Pi 0.87.1 provider-backed subagent flow:** verify a live parent/child subagent turn through the installed release candidate. Passed in the packaged `v0.43.0` candidate on 2026-09-25 (`tlhf-u2gu`).
- [ ] **Pi 0.87.1 published-ref update convergence:** once the release ref advertises Pi `0.87.1`, verify update convergence from the published ref. Deferred to post-publication verification because no published ref currently advertises Pi `0.87.1`.

The first eight checklist items were verified against the packaged `v0.43.0` candidate on 2026-09-25 in the `tlhf-u2gu` run, including the live-provider checks. Only published-ref update convergence remains deferred until post-publication verification because no published ref currently advertises Pi `0.87.1`. Record the release candidate, profile, session evidence, and outcomes in the release validation notes/current release tracking.

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

This record covers the temporary-prefix acceptance run for ticket `tlhf-i8ly`. It appends evidence to the historical records above; it does not change the retired pin-bump procedure and records that release-tier live validation was not complete at the time of that run.

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
- A live provider turn was intentionally not attempted. The observed boundary was `Error: No API key found for the selected model` / `No models available`, so model-catalogue persistence, provider-backed thinking levels, the max-thinking badge, native streaming and idle cache warming, cache-miss notices, and `cache_warm` usage/accounting were still release-tier checks. At the time of this `tlhf-i8ly` run, those live-provider checks were deferred because that ticket excluded paid-provider runs; the later `tlhf-u2gu` record below supplies the current live evidence.

### Session and subagent lifecycle

The isolated Pi RPC process in `/tmp/tlhf-i8ly-pack2-LpTPy5` successfully handled `get_state`, `new_session`, a second `get_state`, and `get_entries`; the new session ID and session file changed as expected. Manual `compact` on the empty session emitted the expected `Nothing to compact (session too small)` response. `clone` on an unsaved session was rejected safely with `This session has not been saved yet. Wait for the first assistant response before cloning or forking it.`

A saved assistant response is required to make resume/branch/fork and meaningful compaction assertions. At the time of this `tlhf-i8ly` run, with no provider credentials, those post-response paths were not faked and were still release-tier validation. Together with the provider-dependent model/cache checks above, they were owned by the release-tier manual validation/checklist in [VALIDATING.md](../VALIDATING.md) and were still required during release preparation because that ticket excluded paid-provider runs. The deterministic first-party child path was nevertheless exercised by:

```sh
env -u PI_SUBAGENT_CHILD npm run test:subagents:e2e
# subagents e2e: 1/1 passed (1 file)
```

That E2E uses a real parent session, a real first-party child process, and a faux provider to verify the child result returns through the parent tool path without an API key. A provider-backed subagent launch from the installed offline profile was deferred at that time with the other release-tier live checks.

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

Finally, before deletion each exact cleanup target was verified as a non-symlink directory under physical `/private/tmp`, owned by this ticket's user, with ticket-specific install-state, runtime-marker, or prior-uninstall evidence. The uninstaller dry-run showed only the matching temporary wrapper, agent, and marked runtime; the real temporary uninstall then removed those managed artifacts where present (the previously uninstalled `pack2` root was a no-op). The four ticket-owned roots `/tmp/tlhf-i8ly-prep-nsWj4t`, `/tmp/tlhf-i8ly-pack-WElLNC`, `/tmp/tlhf-i8ly-pack2-LpTPy5`, and `/tmp/tlhf-i8ly-packprobe-maKDbG` were then removed, and no other path was deleted. The normal Pi configuration and separately installed `pi` remained untouched. The cleanup scope for these temporary artifacts is exactly those four roots. At the time of the `tlhf-i8ly` run, the live-provider, saved-session resume/branch/compaction, and provider-backed subagent items were deferred because of that ticket's paid-provider exclusion; published-ref update convergence was deferred because no published ref advertised Pi `0.87.1`. The subsequent `tlhf-u2gu` record below supersedes the live-provider status; only published-ref update convergence remains deferred.

## Pi 0.87.1 packaged live-provider verification record — `tlhf-u2gu` replacement (2026-09-25 UTC)

This replacement run was explicitly authorized to use the configured Anthropic provider. It supplements the historical offline record above without changing its scope. All commands used the candidate root `/tmp/tlhf-u2gu-replacement-fZdZuM` for `HOME`, XDG directories, `PI_CODING_AGENT_DIR`, runtime, wrapper bin, package, and sessions; the normal `~/.pi/agent` profile was read only for provider metadata and was not written.

#### Candidate and authentication

- `npm run build` and `npm pack` passed. The packed candidate was `the-last-harness-0.43.0.tgz`; it was unpacked and installed with `--track custom` into the isolated paths. The wrapper and private runtime reported Pi `0.87.1`. `tlh doctor` reported `5 OK, 3 WARN, 0 FAIL`; the warnings were the expected pending packaged settings append, MCP/web-search prerequisites, and `gh` authentication.
- **API-backed:** isolated Anthropic model discovery returned five models. The minimum required Anthropic OAuth fields were copied from the macOS keychain-derived `claude auth status` material into isolated `auth.json` with mode `600`; no credential values were printed or recorded. The normal profile's provider metadata was inspected but not changed.
- **Deterministic:** the packaged source registers the compact `subagent` description from `extensions/subagents/src/extension/tool-description.js`, including list-first, single/parallel, async, safety, and lifecycle guidance. A live direct `subagent` invocation also confirmed that the installed candidate exposed the tool; the description-length claim is based on the packaged source, not a fabricated provider response.

#### Model, streaming, and cache

- **API-backed:** RPC model selection used Anthropic `claude-fable-5-1` with `:max`; state before and after the request, and a later `--session` resume, retained the selected provider/model and `max` thinking level. A PTY rendered the live badge `claude-fable-5-1 • max`. A separate real model switch to `claude-opus-5-5` completed at maximum thinking.
- **API-backed:** native RPC streaming emitted `message_update` and `message_end` events. The large-context request wrote `80,750` cache tokens; after the idle safety delay, a persisted `cache_warm` usage entry read `80,750` cache tokens with one output token. The saved accounting entry identified provider `anthropic` and model `claude-fable-5-1`.
- **API-backed:** the real model switch produced `cacheRead: 0` and `cacheWrite: 80,803` on the Anthropic response. The interactive PTY rendered one `Cache miss after model switch` notice, proving both provider miss accounting and the user-facing notice. No credential or transcript value was recorded.

#### Saved sessions and compaction

- **API-backed/deterministic boundary:** a saved assistant response was reopened in a new RPC process and continued with the same isolated session, provider, model, and thinking selection. The saved session's fork operation returned success and a new branch; `get_fork_messages` returned the saved user-message choices. The session lifecycle assertions themselves are deterministic RPC/session evidence, while the response being resumed was provider-backed.
- **API-backed:** after a second large real turn, manual compaction succeeded with `compaction_start`/`compaction_end`, `tokensBefore: 126031`, a non-empty summary, and a persisted compaction entry. The visible message count fell from `7` to `4`, so this was meaningful compaction rather than the empty-session “nothing to compact” path.

#### Subagents, delegation, and supervisor lifecycle

- **API-backed:** a clean parent process used the installed direct `subagent` tool with Anthropic `claude-fable-5-1:high`; a `repo-scout` child made its own Anthropic request in a fresh isolated child session and returned through the parent. The child session path was under the isolated agent sessions root and did not inherit the parent transcript.
- **API-backed:** the nine canonical minor agents were delegated in two foreground batches because the runtime correctly rejects more than eight parallel tasks. `developer`, `test-runner`, `code-reviewer`, `repo-scout`, `diff-summarizer`, `librarian`, `web-scout`, `oracle`, and `contrarian` all completed with exit code `0` using isolated Anthropic child sessions. `test-runner` ran `tk show tlhf-u2gu` followed by its exact `printf` validation step. A non-allowlisted target was rejected before launch. The result paths demonstrated user-scoped agent discovery and fresh per-child sessions.
- **API-backed:** a child `repo-scout` issued a native `contact_supervisor` decision request. The parent received one pending request through `subagent_supervisor({ action: "pending" })`, resumed the same run with guided approval, and then used `subagent({ action: "status" })`; the persisted resumed run reached `complete`. This covers the native pause/resume/delegation channel. The first unchanged-resume probe repeated the intentionally unconditional child request, so the accepted evidence uses the guided-resume path.
- **Deterministic:** the compact description, nine-agent allowlist, user-scope/fresh-session policy, and supervisor tool schemas are packaged-runtime/source contracts. The provider-backed turns above verify that those contracts are reachable in the installed candidate.

#### Cleanup and remaining scope

A pre-cleanup scan found 15 ticket-owned `/tmp/tlhf-u2gu-*` scripts and two ticket-owned temporary roots, including opaque authentication material. All 17 top-level matches were owned by the ticket user, were non-symlink regular files/directories, and were removed after evidence extraction; the candidate root and old replacement-worker root were recursively removed. A scoped credential-pattern scan of the tracked diff and newly created ticket-owned logs/reports (excluding intentional test fixtures) found no credential values. `git diff --check` passed and no commit, tag, push, publish, or normal-profile install was performed.

Published-ref update convergence remains **deferred until post-publication verification**: no published ref in this checkout advertises Pi `0.87.1`, so it cannot be verified from this candidate-only run. The ticket's release-validation dependency remains the owner of that check.
