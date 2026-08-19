# Changelog

All notable changes to The Last Harness will be documented in this file.

## Unreleased

### Added

- **`.claude/skills` discovery.** TLH now reads skills from `~/.claude/skills` (user root, always active) and `.claude/skills` inside your project (project root). These roots are lower priority than every other skill location (profile skills, package-installed skills, `.pi/skills/`, `.agents/skills/`, and settings-listed paths), so same-named skills from any of those sources always win. On the primary agent, project roots require the project to be trusted (`/trust`) before they are read; the subagent resolver reads `<cwd>/.claude/skills` without trust gating, matching the existing `.pi/.agents` convention. Disable the feature entirely by setting `"tlh": { "claudeSkills": { "disabled": true } }` in `~/.the-last-harness/agent/settings.json` (isolated profile global settings only; project-level `.pi/settings.json` is not checked for this flag). To undo, remove the `claudeSkills` key or set `"disabled": false` and restart.

### Changed

- **Removed the footer ticket status line.** TLH no longer renders a `ticket: <title> (/tickets)` line in the footer for in-progress tickets. Use `/tickets` to see ready, blocked, in-progress, active, and total counts with ID/title details.
- **The startup header context hint is now inline.** The standalone "Press Ctrl+Shift+E to show loaded context files, skills, prompts, and extensions" header line has been removed. Its replacement is a `(run /context to see a breakdown)` suffix appended directly to the `Context at launch:` allocation line. Ctrl+Shift+E still works and still appears in `/hotkeys`.
- **Startup tip spacing.** When a startup tip is shown in the collapsed header, it is now separated from the context line by a blank line for readability.

## [0.38.1] - 2026-08-18

### Fixed

- Fixed async subagent widgets that could show stale activity or health warnings after continuing a run.
- Update-available warnings now reappear on every interactive launch until the release is installed.

## [0.38.0] - 2026-08-17

### Added

- At launch, TLH now shows what’s eating up your context.
- TLH now warns you if a provider you've logged in with needs you to re-authenticate.
- The `/annotate-last-message` window is now prettier because it renders Markdown and includes other niceties.
- Changing `/model`, `/thinking`, or `/effort` now asks you whether it should apply to only that session, or to all sessions.
- TLH now bundles skills for using Herdr, Cmux, and Tmux.

### Changed

- `/fast` now supports both OpenAI and Anthropic models.
- Bumped the pinned Pi runtime to `0.84.2`.
- Various improvements to how subagents look in the TUI, and how they report issues to the primary agents.
- The installer's default output is now more concise.

## [0.37.0] - 2026-08-11

### Model defaults

- `repo-scout`, `web-scout`, `librarian`, and `diff-summarizer` now use `gpt-5.6-luna medium`, instead of `gpt-5.4-mini high`.

## [0.36.0] - 2026-08-11

### Added

- When TLH ships changes in the default models/thinking levels, it now offers the user to `/reconcile` them.
- Bumped Pi to `0.84.1`.

### Removed

- Removed a lot of dead schemas, tools, code, etc. TLH is now using even fewer tokens per run.

## [0.35.0] - 2026-08-09

### Added

- While a subagent is reasoning (no active tool), the live-progress display now shows a whimsical phrase from a pool of ~200 entries.

### Fixed

- I believe Pi has a bug causing some unnecessary cache missed. We can't fix it, but we can work around it with a tiny fake message from subagents to the primary agent.

## [0.34.0] - 2026-08-07

### Added

- You can now more easily edit subagent models/effort via the built-in `/subagent-settings` command. I believe TLH offers the best defaults, but you should be able to tweak them as you wish.
- TLH now sends provider/model/effort of the session's primary + secondary agents in a single, anonymous, event at launch. Opt-out.

## [0.33.0] - 2026-08-05

### Added

- Subagent orchestration is now first-party TLH functionality: the runtime entrypoint, bundled agents, user/maintainer documentation, immutable source provenance, and Nico Bailon's exact MIT notice ship with the root package. Imported test suites live in this repository and run in CI, but are excluded from the published package.

### Changed

- Install and update now migrate TLH-managed legacy `pi-subagents` npm/git entries to the first-party runtime, preserve failed npm-cleanup ownership evidence for retry, perform guarded best-effort git-checkout cleanup, preserve provably manual entries, and refuse duplicate runtime registration when a recognized external npm/git copy remains. Local/path copies require manual removal or disabling because migration and coexistence detection cannot identify them. The first-party runtime updates with TLH rather than through `config/default-extensions.json`. The automatic disk-reclaim step (see Minor details below) handles any residual npm artefacts.

### Fixed

- Removed stale `/subagents-profiles`, `/subagents-check-profile`, and `/subagents-models` references after those commands left the imported runtime. `/subagents-fleet` is documented with the visible first-party commands, while `/subagent-cost` remains hidden from autocomplete because `/tokens` is TLH's native token report.
- Architect steering of async child runs now actually works at runtime. The 0.32.0 changelog entry claimed steering support, but `steer` was missing from the allowed action set at that time; it is now included. Steer calls require an explicit `id` and `message`; execution fields (`agent`, `tasks`, `chain`, `context`, `agentScope`) and non-integer `index` values are rejected. `rush` is blocked from `steer` outright because an opaque steer carries no `agent` field, so TLH cannot verify the steered child is not a `developer` subagent. `product` and `bug-hunter` can steer already-started runs — see the accepted issue #330 note in `docs/embedded-subagents.md`.
- The `librarian` subagent tool budget was raised from soft 20 / hard 30 to soft 30 / hard 60 so external GitHub research tasks are less likely to end early on budget exhaustion.
- The architect cleanup guidance now spells out how to delete `tk` tickets: `tk` has no delete subcommand, so ticket files are removed directly with `rm .tickets/<id>.md` after checking for dangling dependency references.

### Minor details

- **`tlh update` now automatically reclaims disk space left behind by retired bundled extensions** ([#438](https://github.com/diegopetrucci/the-last-harness/issues/438)). After each settings merge, TLH drives the isolated Pi runtime's own `pi remove` command to uninstall each retired default extension that is absent from the merged settings and still installed on disk. This covers residue from all previously retired defaults — fff, intercom, rtk, oracle, context-cap, plannotator, librarian, and triage-comments — which together account for roughly 35 MB in a typical profile. Cleanup is always owner-driven (Pi performs the npm uninstall and computes the safe transitive-dep closure; TLH never deletes npm files by hand). A package that still appears in your settings — either because you added it manually or because a provenance check found a user-owned copy — keeps its installed files untouched. The operation is skipped entirely when settings are unreadable and is a no-op under `--dry-run`. Retired profile state directories (such as `agent/intercom/`) are also removed on update. This backfills all existing profiles on the next `tlh update` run.

### Removed

- Removed the `wait` tool (`extensions/subagents/src/runs/background/wait.ts`, 390 LOC) and all wiring: `WaitParamsSchema`/`WaitParams` from `schemas.ts`, `WaitToolConfigObject`/`WaitToolConfig`/`waitTool` config field from `types.ts`, and the `waitToolConfig` const plus `pi.registerTool(waitTool)` call from `index.ts`. Removed the `wait` section from `docs/subagents.md`. This is a user-visible removal for any non-TLH consumer; TLH could not reach the tool (TLH's primary-agent tool allowlist excludes it, no TLH agent declares it, TLH never sets `config.waitTool` or `PI_SUBAGENT_WAIT_TOOL_ENABLED`). Test deletions: `wait.test.ts` (whole file) and exactly one `it()` in `index-child-registration.test.ts`.
- Removed the `mcpDirectTools` allowlist resolver (`extensions/subagents/src/runs/shared/mcp-direct-tool-allowlist.ts`, 365 LOC) and the `mcpDirectTools?: string[]` frontmatter field threading from all call-site files: no TLH agent declares the field. **Kept**: `env.MCP_DIRECT_TOOLS = "__none__"` is still set unconditionally in `pi-args.ts`; the sentinel tells `@diegopetrucci/pi-mcp-adapter` (bundled in TLH) not to bootstrap direct MCP tools in child subagents — an unset var means "bootstrap everything configured" and would silently widen every child's tool surface. This sentinel must not be removed by a future cleanup pass.
- Removed the `agent-memory` module (`extensions/subagents/src/agents/agent-memory.ts`) and its test (`extensions/subagents/test/unit/agent-memory.test.ts`): no TLH agent declares the `memory` frontmatter field, and TLH is the only consumer. The `AgentMemoryScope` type, `AgentMemoryConfig` interface, and `memory` field are removed from `AgentConfig`; the `buildAgentMemoryInjection` call sites are removed from `execution.ts` and `async-execution.ts`.
- Removed the subagent RPC bridge (`extensions/subagents/src/extension/rpc.ts`, 384 LOC) and its tests (`rpc.test.ts`, `rpc-gate.test.ts`). The bridge let a co-installed Pi extension drive subagents over the in-process event bus via ping/status/spawn/interrupt/stop. Its `spawn` path called `executor.execute()` directly, bypassing TLH's tool-call allow-list guard — which is exactly why it shipped default-off. Nothing in this monorepo enables or references it. Removing it eliminates the possibility of a stray `PI_SUBAGENTS_RPC_ENABLED=1` or config typo silently reopening that bypass. `RpcBridgeConfig` and the `rpc?` member of `ExtensionConfig` are also removed from `types.ts`.
- Removed the per-execution `Tlh.Agent.used` signal; `Tlh.launched` now answers the same questions at lower event volume.
- The **fff (`npm:@ff-labs/pi-fff`)** extension has been removed.

## [0.32.0] - 2026-08-03

### Added

- In the footer, TLH now shows how much context MCPs are consuming.

### Changed

- Bumped the bundled critical `pi-subagents` default extension pin from `npm:@diegopetrucci/pi-subagents@0.31.12` to `npm:@diegopetrucci/pi-subagents@0.31.14`, delivering the max thinking level fix so the `:max` thinking badge renders correctly.

### Model defaults

- The `developer` subagent now defaults to `gpt-5.6-luna max` for OpenAI, `sonnet-4-6 medium` for Anthropic.
- The Architect, Product, Bug-hunter, `code-reviewer`, `oracle`, and `contrarian` now use `opus-5.0 high` for Anthropic, `gpt-5.6-sol high` for OpenAI.
- All 12 bundled agents now declare thinking levels independently per provider instead of sharing a single level.

### Removed

- Removed RTK from TLH (see [this analysis as to why](https://www.stet.sh/blog/gpt-56-token-saving-modes)).
- Removed the pi-intercom dependency. The little we used of it is now folded into pi-subagents. This also reduces how many tokens TLH consumes.

### Fixed

- Installing TLH from `main` no longer fails npm peer-dependency resolution; repository tooling now consistently uses the TypeScript version supported by `typescript-eslint`.
- Subagents now have two timeout caps: a soft one at ~4m30s where the architect checks on them, and a hard one with a bigger timeout that pauses them. They also support steering, and have tighter system prompts. This should make them much more responsive.
- TLH now works a bit better with Herdr.

### Other minor things

- `/tokens` now reports median observed wall-clock latency per tool alongside the existing cost and token data. Latency is the interval between the recorded call and result events and includes any queueing or paused-run time.
- `/annotate-last-message` now sends submitted feedback directly to the agent as a follow-up message instead of appending it to the TLH editor buffer.
- `/annotate-git-diff` now sends review feedback to the agent when you click Submit. Closing the review window with unsent comments still appends a recovery draft to the editor instead of sending, so an accidental close cannot trigger an agent turn.
- Bumped the bundled Pi to `0.83.0`.

## [0.31.0] - 2026-07-27

### Changed

- The currently worked on `tk` ticket now shows in the footer.
- Bumped Pi to 0.82.1.

## [0.30.0] - 2026-07-24

### Added

- [Experimental] TLH can now run trusted custom embedded subagents from user-owned markdown definitions after you opt into the `embedded-subagents` experimental flag.
- New `/what-consumed-my-session-limit-and-tokens` command that generates and opens a local, private HTML report attributing token consumption across all TLH sessions (including subagent child sessions, across every project) within the current provider session-limit window (Anthropic 5-hour or OpenAI Codex session window, resolved from the subscription usage snapshot with a trailing-5h fallback). The report ranks sessions by in-window usage with per-provider totals and privacy/accuracy caveats, and embeds no transcript text or tool payloads.
- Added a troubleshooting guide with conservative recovery steps for common wrapper, private-runtime, subagent, install, update, and integration failures without touching normal `~/.pi/agent` configuration.

### Changed

- TLH now renders its initial startup header before slower resource collection, update-check, and usage-refresh work completes, then fills in those details asynchronously for a more responsive startup experience.
- TLH ticket workflows now scope `tk` to the current worktree by default (`<git-worktree-root>/.tickets`, or `<session-cwd>/.tickets` outside Git), keeping architect sessions, child sessions, `/tk-status`, and Bash-launched `tk` commands on the same repo-local ticket store. Interleaved ticket UI actions now restore that scope correctly instead of accidentally drifting to another store.
- The installer now provisions `extensions/subagent/config.json` with `toolDescriptionMode: "compact"` during install and update. This reduces token overhead in subagent tool descriptions while preserving any existing user override such as `"full"`.
- Non-latest-release installs now keep a visible track warning naming the active install track, instead of only surfacing that state transiently during startup.
- Refreshed bundled default-extension pins, including the managed subagent stack (`pi-subagents` 0.31.9 and `pi-intercom` 0.8.0) plus the bundled optional OpenAI/Auth/MCP/search defaults, so fresh installs and managed updates pick up newer upstream fixes and compatibility updates.
- Release telemetry now reports only the `on`/`off` state of registered TLH experimental flags; unknown or custom experimental values remain ignored and unsent.
- TLH's architect/developer ticket workflow guidance now explicitly protects pre-existing user-owned worktree and index changes from being overwritten or discarded during scoped implementation tasks.

### Fixed

- Restored Anthropic and OpenAI Codex subscription usage in the footer, which disappeared under Pi 0.81 when upstream removed the auth-storage API the usage service depended on.
- OpenAI weekly/daily usage now shows days, not just hours.
- Provider totals in `/what-consumed-my-session-limit-and-tokens` now stay provider-scoped instead of repeating model attribution in the totals row.
- Installer backup cleanup now only removes backups it created (exact TLH filename forms with an empty/`tlh-tickets`/`tlh-defaults`/`before-install` marker and a TLH timestamp), so a user-created file such as `settings.json.backup-my-personal-copy-<timestamp>` is no longer eligible for automatic deletion.

## [0.29.0] - 2026-07-12

### Added

- Support for `max` thinking.
- Support for `pi`'s cache missing alerts. Enabled by default.
- Reworked the report generated by `/tokens`:
  - It now splits subagents usage by type (developer, reviewer, etc.) and provider (Anthropic, OpenAI).
  - It attempts to show `cache misses` and explain what they are.
  - Usage by tools and MCPs is now more clear.
- (Beta) TLH should now report its status better when working within terminals like Herdr and Cmux. Before, it was showing as `idle` when the primary agent was idle but subagents were still running.
- Bumped `gnosis`' version: it now defaults to citing the person that added an entry.

## [0.28.0] - 2026-07-09

### Removed

- Removed the bundled `pi-triage-comments` extension. Existing TLH-managed `pi-triage-comments` installs are force-removed on the next `tlh` install or update; packages added manually to that isolated profile are preserved.

### Changed

- Bumped TLH's pinned upstream Pi runtime from 0.80.3 to 0.80.5 for the private runtime installed under `~/.the-last-harness/runtime`.
- Weekly subscription usage now appears by default only when less than 25% remains; explicit `/usage weekly on` or `/usage weekly off` preferences still override that auto-show behavior.
- The bundled `developer` subagent now uses `anthropic/claude-sonnet-5` with `thinking: medium` on the Anthropic path. The OpenAI-Codex model (`openai-codex/gpt-5.4`) is unchanged.
- Switched the bundled critical `pi-subagents` default from the reviewed TLH git tag to the published scoped npm package `npm:@diegopetrucci/pi-subagents@0.31.1`, while preserving migration from existing upstream and TLH git installs so the isolated profile lands on one canonical bundled source without duplicates.
- Bumped the bundled managed `pi-web-access` default extension pin from `npm:@diegopetrucci/pi-web-access@0.10.8` to `npm:@diegopetrucci/pi-web-access@0.10.10`, while keeping migration coverage for upstream and prior TLH git replacement sources intact.
- Bumped the bundled critical `pi-subagents` default extension pin from `npm:@diegopetrucci/pi-subagents@0.31.2` to `npm:@diegopetrucci/pi-subagents@0.31.3`.
- Bumped the bundled critical `pi-intercom` default extension pin from `npm:@diegopetrucci/pi-intercom@0.6.2` to `npm:@diegopetrucci/pi-intercom@0.7.0`.
- The generated `tlh` wrapper now exports `NODE_COMPILE_CACHE` pointing at a stable directory under the pinned private runtime (`<runtime-prefix>/node-compile-cache`) on the interactive `pi` launch path, so Node's on-disk compile cache persists across launches for a modestly faster warm startup. Helper subcommands (`update`/`defaults`/`tickets`) are unchanged, and the cache directory remains runtime-owned and is removed on uninstall.

### Fixed

- TLH autocomplete now hides `/scoped-models`, `/subagents-profiles`, `/subagents-check-profile`, `/subagents-models`, `/skill:pi-subagents`, `/skill:librarian`, `/skill:pi-intercom`, `/websearch`, `/curator`, and `/search` in slash-command-name completion.
- The librarian subagent now explicitly permits `git remote get-url` for required local-checkout remote identity verification before trusting a bounded local checkout or temporary clone during read-only repository research.
- Fixed managed RTK install validation to accept `rtk rewrite` exit code 3 in addition to 0, since rtk >= 0.35.0 intentionally exits 3 for a rewrite plus ask/default permission verdict while still printing the rewritten command. Previously TLH's installer rejected the authentic pinned rtk 0.42.4 binary with "downloaded RTK binary did not validate", breaking install/update at the RTK step.

## [0.27.0] - 2026-07-01

### Removed

- Removed the bundled `pi-librarian` extension. Existing TLH-managed `pi-librarian` installs are force-removed on the next `tlh` install or update; packages added manually to that isolated profile are preserved. The leftover `extensions/librarian.json` file in the isolated profile is also cleaned up during migration.
- Removed the old `/rtk` command UI; `/rtk enable`, `/rtk disable`, and `/rtk status` are no longer available.

### Changed

- Updated the bundled main-track `pi-subagents` default extension pin to reviewed upstream-main commit `a7e76d212dfa788c59538e44afddad326c074b86` so TLH main/ref users can test the issue #30 async-start chat result body suppression fix while keeping the live widget, without a TLH release.
- Promoted `contrarian` from an experimental opt-in to a bundled default minor subagent. README and command docs now describe it as a sparing adversarial stress-test path rather than a `/experimental` enable/disable toggle.
- The `librarian` subagent now performs read-only GitHub repository research directly via the `gh` CLI and `git` through `bash`, without a separately managed extension package. **Prerequisite:** `gh` must be installed and authenticated (`gh auth login` / `gh auth status`). Without it, librarian reports what it could not verify rather than silently failing.
- Migrated TLH away from the old bundled `pi-rtk` fork to a managed pinned native RTK integration. TLH now installs `rtk-ai/rtk` `v0.42.4` at `~/.the-last-harness/agent/bin/rtk`, hard-fails install/update if that managed binary cannot be installed and validated, and uses `RTK_DISABLED=1` or `tlh.rtk.disabled` instead of the old default-extension opt-out flow.
- Updated the bundled `mcporter` pin to `npm:@diegopetrucci/pi-mcp-adapter@2.10.1` instead of the previous fork git tag, reducing installer checkout work while preserving the existing MCP adapter behavior.
- Moved the bundled `pi-web-access` default from the previous Diego git tag to `npm:@diegopetrucci/pi-web-access@0.10.8` and now migrates prior/customized replacement sources to the scoped TLH npm package.

## [0.26.0] - 2026-06-25

### Changed

- Refreshed pinned TLH package dependencies and bundled extension references across package metadata, installer validation, and docs.
- Added a GitHub downloads badge to `README.md` for quicker release-install visibility.
- Added CI/status-check monitoring guidance for post-PR TLH workflows, plus an opt-in `ci-failure-investigation` experimental path for read-only investigation before asking whether to proceed.

## [0.25.0] - 2026-06-24

### Added

- TLH now bundles a first-party experimental `contrarian` subagent, kept default-off behind `/experimental enable contrarian`, with opt-in guidance across TLH experimental primary-agent prompts and README docs. When enabled, `contrarian` is intended mainly for sparing pre-ticket adversarial stress-tests of plans, assumptions, product directions, bug hypotheses, and review conclusions — not the routine `code-reviewer` diff pass and not a replacement for the broader `oracle` second opinion.

### Changed

- Replaced the bundled `pi-oracle` extension (`npm:@diegopetrucci/pi-oracle`) with a first-party oracle subagent that performs direct high-reasoning read-only analysis. The subagent uses the opposite-provider model pattern (mirroring `code-reviewer`) with high thinking, so it reasons independently from the primary session. No external extension is required.
- Updated the bundled `pi-subagents` pin and TLH provider-aware review defaults: when TLH injects an opposite-provider model for `code-reviewer` or `oracle`, it now also supplies a same/current-provider fallback plus a warning notice that review independence is reduced if the fallback is used.
- TLH now instructs agents never to create a git commit on their own; all commits require explicit user approval before proceeding.

## [0.24.0] - 2026-06-22

### Changed

- Removed the per-launch `pi --version` probe from the `tlh` wrapper. The version check ran on every invocation to validate the pinned runtime; it is now replaced with a lighter-weight check, making `tlh` start faster.

### Fixed

- Fixed uninstall safety for runtimes that were migrated from a legacy TLH install: a `migrated`-origin ownership marker now causes `tlh uninstall` to use a surgical `npm uninstall` rather than `rm -rf`, so any packages co-located in a shared prefix are preserved.
- Tightened private-runtime ownership gating: the installer and uninstaller now require an affirmative `.tlh-runtime-owned` marker (with schema-version, package name, and a realpath-matched path) before treating a runtime prefix as TLH-owned. An unmarked or path-mismatched prefix is refused at install time and skipped at uninstall time, with a manual-removal hint printed instead. Existing installs receive the marker automatically on the next `tlh update` or installer rerun.

## [0.23.0] - 2026-06-20

### Changed

- TLH now runs a self-contained pinned Pi runtime at `~/.the-last-harness/runtime`, exec'd by absolute path and isolated from any global `~/.local` Pi install. The installer and uninstaller never auto-remove `~/.local/bin/pi`; the uninstaller removes the private runtime when it is TLH-owned, and only touches a `~/.local` Pi under the explicit `--force-include-pi` flag.
- Bundled installer-managed runtime dependencies outside `package.json` are now explicitly pinned too: bundled npm default extensions in `config/default-extensions.json` use concrete versions, existing TLH git-fork defaults stay tag-pinned, and managed Gnosis now defaults to the pinned `v0.5.3` release instead of resolving `latest` unless you override it.
- TLH now suppresses the upstream Pi "Update Available — Run `pi update`" launch banner. Because TLH pins Pi to a supported version window, the upstream update prompt is misleading noise — `tlh update` is the correct update path. TLH's own update notifications are unaffected.

## [0.22.2] - 2026-06-19

### Changed

- Temporarily pinned TLH package metadata, peer-compatibility guidance, and install/update docs to upstream Pi 0.79.7 while the upstream 0.79.8 breakage is active.

## [0.22.1] - 2026-06-18

### Fixed

- Fixed the tracked package-lock release metadata inconsistency that shipped in 0.22.0.

## [0.22.0] - 2026-06-18

### Changed

- Switched the bundled `mcporter` default extension from `npm:pi-mcp-adapter` to a TLH fork pinned to `git:github.com/diegopetrucci/pi-mcp-adapter@tlh-v2.10.0-1`. The fork's only behavior change is the MCP status-bar footer: it now uses the dim style (matching the other footer lines) and lists actively-connected server names after the count when one or more servers are connected (e.g. `MCP: 1/1 servers, atlassian`).

## [0.21.0] - 2026-06-16

- Active non-locked primary agents now respect user `/model` choices and persist them per primary under `tlh.primaryAgent.modelOverrides.<primary>`; reset with `/switch-primary-agent model reset`. Locked primaries such as Rush keep fixed defaults.
- `code-reviewer` continues to prefer the opposite available provider for review independence, without forcing unavailable Codex-only defaults.
- Bundled the updated `pi-subagents` tag with the completion-guard fix for VCS/PR false positives.

## [0.20.0] - 2026-06-15

### Changed

- The TLH git commit footer is now coauthor-only: `Co-authored-by: The Last Harness <hi@thelastharness.com>`. The decorative `🤖 Generated with ...` heading line has been removed. GitHub and git log co-authorship attribution is unchanged. The attribution guard now requires a blank line before the coauthor trailer (or a footer-only message) to match git trailer parsing rules; commit messages with only a single newline before the trailer are rejected.
- TLH now requires upstream Pi >=0.79.1. Installer checks, wrapper defaults, package metadata, and current install/update docs all use the raised runtime floor.
- The compact (non-expanded) subagent view now hides the artifact-path line - press Ctrl+O for the expanded view that still shows it - and renders the current tool command (e.g. long `bash` invocations) in full, wrapped to terminal width and capped at 3 lines with `...` on overflow instead of mid-flag `...` truncation.
- `code-reviewer` now prefers an available opposite provider for review independence: Anthropic sessions try the OpenAI Codex subscription provider when it is available, OpenAI/OpenAI-Codex sessions try Anthropic Opus when it is available, and OpenAI API-only setups are not forced onto unavailable Codex-only defaults.

### Fixed

- The TLH startup header now mirrors upstream Pi 0.79.1 project-trust behavior. It keeps `AGENTS.md` and `CLAUDE.md` visible as context even when trust is unresolved, hides trust-gated project `.pi` and `.agents/skills` resources until the project is trusted, and honors the nearest saved trust decision inherited from parent folders in the isolated TLH profile.
- Bundled the updated `pi-subagents` tag with the observability fix for non-zero child exits and SIGTERM-like failures.
- Bundled `pi-subagents` now cleans up run-owned background processes when terminal child runs finish, while soft pause and resume remain non-destructive.

## [0.19.0] - 2026-06-09

### Fixed

- Fixed the `/annotate-git-diff` review window failing to load Monaco in environments where the WebView could not load packaged editor files from disk (e.g. WKWebView with a null origin). Monaco editor, syntax-highlighting tokenizers, and the worker source are all inlined into the review window's HTML at build time, so the window works from any WebView origin without runtime file-system fetches.
- Primary-agent thinking is now asserted on every primary switch. Previously, switching back to architect after a Rush session could leave thinking at Rush's low level instead of reapplying architect's default when Rush had left the session below architect's medium floor.

### Changed

- Rush, product, and bug-hunter now run at fixed thinking levels. Attempting to change thinking under these primaries with `/thinking` or `/effort` returns a clear error: `Thinking is locked at "<level>" for the <name> primary agent.` The locked levels are: rush → low (off on the OpenAI Codex subscription provider), product → high, bug-hunter → high.
- Architect now enforces a minimum thinking floor of medium. `/thinking` and `/effort` cannot set architect thinking below medium. Any session currently running architect below medium will be bumped to architect's default thinking on the next primary apply (session start or primary switch).

## [0.18.0] - 2026-06-08

### Added

- The Architect (the primary TLH subagent) can now use MCP tools via the `mcp` tool grant, enabling MCP-backed workflows from the architect role.

### Changed

- The TLH update-available notification has been reworded for clarity and is now install-track aware. The suggested command now matches the install track (`latest-release`, `pinned-tag`, `ref`, or `custom`); `custom`-track installs no longer receive a misleading plain `tlh update` suggestion.
- Documentation refresh: `README.md`, `docs/commands.md`, and `docs/install.md` updated so the documented `tlh` command and update references match current behavior.

## [0.17.0] - 2026-06-06

### Changed

- Bundled `pi-subagents` now pins `git:github.com/diegopetrucci/pi-subagents@tlh-v0.26.0-5`.
- The `tlh` wrapper now pins the absolute `pi` path at install/update time for faster launch; the minimum Pi version (>=0.76.0) is enforced at install/update time rather than on every `tlh` invocation. If the pinned binary is later moved away or removed, the wrapper falls back to PATH discovery automatically; if it is replaced in place with an unsupported version, run `tlh update` to re-validate and repin.
- The footer no longer shows the model provider name; the provider prefix is always hidden.
- Context cap is now a built-in TLH feature (no longer a bundled default extension). The bundled `@diegopetrucci/pi-context-cap` default extension has been removed and will be force-uninstalled from existing isolated profiles on the next `tlh` install or update. Previous `tlh.disabledDefaultExtensions: ["context-cap"]` opt-outs are intentionally **not** preserved - those entries are silently pruned on upgrade. To opt out of the cap again, run `/toggle-context-cap` or set `tlh.contextCap.disabled: true` in your isolated settings.
- TLH now records bundled default-extension provenance in `tlh.defaultExtensionProvenance.managedPackageIdentities` so retired-default cleanup can distinguish TLH-managed packages from later manual re-adds. Older installs migrate this metadata on update; legacy Plannotator is still cleaned up once during that migration.
- `tlh` install/update now force-removes the retired bundled `permission-gate` and `confirm-destructive` confirmation packages from existing isolated TLH profiles. New installs already omit both packages, and this cleanup only touches the isolated TLH profile (for example `~/.the-last-harness/agent/settings.json`), not normal Pi config under `~/.pi/agent`.
- Renamed the first-party git-diff review command/docs/UI copy to `/annotate-git-diff` and the packaged extension name to `annotate-git-diff`; historical attribution still references the upstream `pi-extension-diff-review` and `pi-diff-review` packages.

### Added

- Added `/toggle-context-cap` slash command: toggles the 200k effective context-window cap for auto-compaction.

### Removed

- Removed Plannotator from the bundled default-extension manifest and TLH command reference. TLH updates/settings merges now remove the old `npm:@plannotator/pi-extension` package only when it is still tracked as a retired TLH-managed default; if you still want Plannotator after updating, manually re-add it.

## [0.16.0] - 2026-06-03

### Added

- Added `docs/commands.md`: a command reference listing all slash commands available in a TLH session, grouped into upstream Pi built-ins, TLH commands, and visible bundled extension commands, with a separate section for autocomplete-hidden bundled commands.
- Added `/version` slash command that reports the installed TLH version and the upstream Pi runtime version in concise plain text.
- Added TLH commit attribution for agent-created git commits: the isolated TLH profile now defaults to a TLH-branded commit footer, `/toggle-tlh-git-attribution` persistently disables or re-enables it by managing boolean `tlh.attribution.commit` settings, and git push behavior is unchanged.

### Removed

- Removed the bundled `confirm-destructive` default extension. New installs no longer ship destructive-action confirmation prompts. Existing installs were initially unaffected by the 0.16.0 upgrade, but a later `tlh` install/update now force-removes that retired package from the isolated `~/.the-last-harness/agent/settings.json` `packages` array. Normal Pi config under `~/.pi/agent` is unchanged.

## [0.15.0] - 2026-06-01

### Added

- Added `/review` slash command: interactive mode picker plus `uncommitted`, `branch`, `commit`, `pr`, and `folder` modes; branch mode prompts for its base branch (defaulting to `main` but allowing stacked bases), PR mode integrates with the `gh` CLI and prompts before switching branches, and review runs in an isolated `code-reviewer` subagent while the architect presents a digested summary.

### Breaking

- Removed `--no-pi-install` from install and update flows. When `pi` is missing, TLH now always attempts the managed per-user install under `~/.local`, and install/update stop with an actionable error if that install cannot complete.

### Changed

- TLH now requires upstream Pi >=0.76.0. When `pi` is missing, the installer continues to add a compatible per-user Pi runtime under `~/.local`.
- Installer and update flows now hard-fail when an existing `pi` on `PATH` cannot be version-verified, with actionable upgrade guidance, instead of continuing past an unverifiable runtime.

## [0.14.0] - 2026-05-27

### Added

- Added `uninstall.sh` and the `curl -fsSL .../uninstall.sh | bash -s --` one-liner for removing the isolated TLH profile, `tlh` wrapper, and (conditionally) the global pi package. Flags cover dry-run, path overrides, pi-removal overrides (`--force-include-pi`, `--keep-pi`), quiet, and verbose.
- Added `piInstalledByTlh` field to `install-state.json`, written at install time so the uninstaller can decide whether to remove the global pi package without touching a shared or pre-existing install. The field is additive: older installs that lack it are unaffected and default to leaving pi in place.

### Changed

- The uninstaller no longer prompts for confirmation. It prints the removal plan and proceeds immediately. Use `--dry-run` to preview what would be removed without making any changes.

## [0.13.0] - 2026-05-26

### Added

- TLH now bundles the upstream `pi-mcp-adapter` as the non-critical default extension `mcporter`, making it easier to connect TLH to MCP servers out of the box. See `docs/mcp.md` for setup, OAuth, config locations, and opt-out guidance.

### Changed

- Managed git-checkout refreshes now keep dirty-checkout backup output concise by default while still preserving local changes; verbose diff details remain available in verbose mode.

## [0.12.0] - 2026-05-26

### Changed

- TLH installs and updates now place the bundled Pi runtime per-user under `~/.local` (so `pi` lands at `~/.local/bin/pi`) instead of using a global `npm install -g`. This removes the need for `sudo`, matches Pi's own install guidance, and is consistent with the default TLH bin dir (`~/.local/bin`). When the per-user prefix is not yet on `PATH`, the installer prepends it for the current process and prints a one-time hint to add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile.
- The Pi version-too-old upgrade hint now points at the same per-user `npm install -g --ignore-scripts --prefix "$HOME/.local" @earendil-works/pi-coding-agent` invocation that the installer uses, so the suggested fix matches the install layout.

## [0.11.0] - 2026-05-26

### Added

- Added `/analyse-tlh-sessions` TLH session-analysis prompt.
- `/tlh-changelog` now shows TLH release notes from the packaged `CHANGELOG.md` while leaving manual upstream `/changelog` available.
- Bundled the patched TLH `pi-rtk` fork as a non-critical default extension, with quiet-tools-compatible load ordering and a documented `tlh defaults disable rtk` opt-out.
- Suppressed the upstream Pi Anthropic extra-usage startup warning by default (`warnings.anthropicExtraUsage: false`); re-enable it by setting `"warnings": { "anthropicExtraUsage": true }` in `~/.the-last-harness/agent/settings.json`.
- `pi-web-access` (Exa-only fork at `tlh-v0.10.7-1`) bundled as a non-critical default extension; supplies `web_search`, `fetch_content`, and `get_search_content` tools used by the `web-scout` subagent.
- `web-scout` minor subagent (read-only, isolated fresh context, Exa-backed) for general web research; delegated freely by the architect.
- Rush selectable primary-agent support for small bounded implementation tasks, with direct edits and narrow validation outside the default architect `tk`/developer/review loop.
- Provider-aware TLH model/thinking defaults: OpenAI/OpenAI-Codex sessions prefer GPT-5.5, and Rush switches thinking off there while Anthropic keeps Opus with low thinking.

### Changed

- TLH now hides upstream Pi automatic changelog/update notices in the isolated profile by default to reduce startup noise.
- Couple `tlh defaults disable/enable anthropic-auth` with `warnings.anthropicExtraUsage` so the upstream extra-usage warning reappears when the compatibility layer is off; installer reruns also stop re-introducing the suppression for users who have opted out.
- Bundled TLH `pi-rtk` default now points at the no-footer fork tag, preserving `/rtk` repo-tooling behavior without adding a persistent footer indicator.
- Bundled `pi-web-access` now defers to existing upstream/manual `pi-web-access` installs during normal merges and updates, avoiding duplicate `web_search`/`fetch_content`/`get_search_content` providers unless you explicitly switch to the TLH fork.
- Bundled critical `pi-subagents` now pins `git:github.com/diegopetrucci/pi-subagents@tlh-v0.26.0-1`, matching the merged fork tag and the reduced bundled slash-command surface (`/subagents-doctor` only).
- Footer restructured into three logical lines: working directory/git (unchanged), a single flowing `agent: ... • model • thinking • context` line, and an optional session-stats line showing cost and/or subscription usage. Empty lines are omitted entirely.
- Subscription usage session label now reads e.g. `5h session 27% used` (was `5h 27% used`).
- Removed the `/tlh`, `/harness`, `/agent`, and `/architect` TLH slash commands. Use `/switch-primary-agent` for explicit primary-agent status/default controls, or `Shift+Tab` to cycle the active primary.
- Non-stable-install track warning is now rendered in the TLH header instead of as a standalone launch notice, and the launch notice copy was simplified.
- Trimmed the README power-user bundled-extension command list to match the reduced default-extension surface (no `/context-cap`, `/quiet-tools`, `/fff-*`, `/oracle-model`, `/intercom`, `/plannotator-*` in the list).

## [0.10.0] - 2026-05-21

### Added

- Added TLH footer git and pull request segments, including cached branch/status/PR rendering on the footer first line.
- Added OAuth subscription usage footer support for supported OpenAI/Codex and Anthropic sessions; weekly usage remains hidden by default and is controlled with `/usage`.
- Added `npm run validate` as the aggregate local, CI, and release validation command.

### Changed

- Architect primary agent sessions can now write and edit files directly.
- Default-extension and installer utility logic now use shared helper modules while preserving existing isolated-profile behavior.
- CI, release, contributor, and local-development docs now point at the aggregate validation command.

### Fixed

- Fixed staged installer and release-smoke support manifests to include shared helper modules required by the installer and default-extension tools.

## [0.9.0] - 2026-05-20

### Breaking

- **Gnosis is now mandatory** on supported platforms (linux/darwin × x64/arm64). The installer hard-fails on unsupported platforms instead of falling back gracefully.
- Removed installer flags `--with-gnosis`, `--without-gnosis`, and `--no-gnosis`. Passing these flags is now an error.
- Removed `tlh gnosis` wrapper subcommand (`status`, `enable`, `disable`). Use `node scripts/tlh-gnosis.mjs validate` for local validation.
- Removed `/gnosis` slash command. Gnosis prompt integration is always active when `gn` is available.
- Settings key `tlh.gnosis` is ignored and scrubbed on the next settings merge.
- `tlh update` now hard-fails on unsupported platforms (linux/darwin × x64/arm64). Existing installs on other platforms must stop using `tlh update`.
- Installs and updates require a reachable `github.com` to fetch the `gn` release binary; network failures abort the operation rather than silently skipping Gnosis.
- Any existing `tlh.gnosis.enabled = false` setting is scrubbed on the next merge and a managed `gn` binary will be installed into the isolated profile, regardless of prior opt-outs.

> **Internal note:** `TLH_SKIP_GNOSIS_INSTALL=1` exists as a test/benchmark escape hatch only; it is not a supported user opt-out.

### Changed

- `tk` ticket integration is now mandatory: TLH documents the `tlh tickets ...` helper, rejects legacy ticket opt-outs, re-enables legacy disabled ticket settings, provisions the pinned `wedow/ticket` v0.3.2 managed `<agent>/bin/tk` with SHA-256 verification and sanitized helper-tool handling when needed, keeps `<agent>/bin` on `PATH` for sessions, fails install/update if no valid `tk` can be found or installed, and records managed install SHA-256 for future pinned-source reinstalls.

## [0.8.1] - 2026-05-19

### Added

- Added a full validation GitHub Actions workflow for installer smoke checks, tests, settings-merge dry-runs, and package dry-runs.
- Added contributor guidance for local development and release-prep validation.
- Added tested helpers for parsing Git porcelain-v2 status and formatting TLH footer git/PR segments.

### Changed

- The installer, package metadata, and release workflow now require Node.js >=22.19.0 to match upstream Pi 0.75+.
- Non-critical default-extension fallback updates now use the old Pi-compatible positional `pi update <source>` form when the settings-wide refresh fails.

## [0.8.0] - 2026-05-19

### Added

- Added the product primary agent for strategy, product docs, and implementation-ticket shaping without source implementation.
- Added multi-primary switching across architect, product, and disabled modes via `Shift+Tab` and `/agent`, while keeping `/architect` compatibility.
- Bundled `npm:@gotgenes/pi-anthropic-auth` as a default extension to improve Anthropic Claude Pro/Max OAuth compatibility while preserving normal API-key behavior.
- Added `scripts/benchmark-context-cap-embedding.mjs` to compare default-extension install performance and package-size tradeoffs when embedding bundled defaults.

### Changed

- Bundled intercom now collapses incoming intercom/subagent result cards by default while leaving expanded content unchanged.
- Installer default-extension updates now run one settings-wide refresh for non-critical defaults with per-source fallback retries, while critical subagents/intercom packages are still installed and validated separately.
- Split the bundled TLH extension into focused modules to keep primary-agent, header/footer, Gnosis, telemetry, and update-check behavior maintainable without changing user-facing commands.

### Fixed

- Fixed latest-release installer assets and no-argument pipe-to-bash installs so they default to the latest-release update track without requiring `TLH_UPDATE_TRACK`, and avoid stage-0 Bash argument-forwarding failures.

## [0.7.0] - 2026-05-17

### Added

- Added the TLH architect workflow with bundled specialist subagents and safer setup/update handling for the isolated profile.

### Changed

- TLH-owned default settings now collapse upstream Pi changelog notices to the supported condensed one-line notice by default.

## [0.6.0] - 2026-05-13

### Added

- Added one pseudonymous TelemetryDeck launch event for interactive `tlh` session startup, with persistent settings/env opt-outs.
- Bundled `npm:@diegopetrucci/pi-dirty-repo-guard` as a default extension.
- Bundled `npm:@ff-labs/pi-fff` as a default extension.
- Added `/gnosis` to toggle Gnosis prompt integration from an interactive `tlh` session, with `/gnosis status|enable|disable|toggle` for explicit actions.

### Changed

- Gnosis is now installed and enabled by default on supported platforms for profiles without an existing preference; `--without-gnosis`, `tlh gnosis disable`, and `/gnosis` disable remain persistent opt-outs across `tlh update`.

## [0.5.0] - 2026-05-12

### Added

- `tlh update` now reruns the installer update flow while preserving latest-release, pinned-tag, or ref/main update tracks.
- TLH now checks GitHub Releases in the background at startup and warns once when a newer release is available.
- Bundled `npm:@diegopetrucci/pi-openai-fast` as a default extension.
- Bundled `npm:@plannotator/pi-extension` as a default extension.

### Changed

- Expanded install and local-development guidance now lives in focused docs linked from the README.

## [0.4.0] - 2026-05-11

### Added

- Bundled `npm:@diegopetrucci/pi-context-inspector` as a default extension.
- Bundled `npm:@diegopetrucci/pi-librarian` as a default extension.
- Added a `DUMB ZONE` footer warning after context usage when context exceeds 200k tokens.

### Changed

- The TLH footer no longer shows token counters, subscription cost estimates, or the auto-compaction indicator.
- The default editor horizontal padding is now set to 1.
- README bundled-extension entries now link to their upstream package source.
- The startup header now shows context files on a single `Context:` line.
- The startup header now omits the keybinding hint line.
- The startup header now omits the upstream Pi version and shows the TLH version plus releases link only on the first launch after a TLH version change.

## [0.3.0] - 2026-05-11

### Added

- The TLH footer now shows steering and follow-up queue key hints while the user is typing during active agent work.
- README now includes a concise features overview.
- Added `scripts/release-notes.mjs` for tag-specific release notes sourced from `CHANGELOG.md`.

### Changed

- GitHub Releases now use the matching `CHANGELOG.md` section as release notes instead of generated commit summaries.
- Refined README install and update guidance.
- Release documentation now covers changelog-backed GitHub Release notes.

## [0.2.0] - 2026-05-10

### Added

- Optional Gnosis (`gn`) integration with install-time opt-in, `tlh gnosis` management commands, isolated managed binary support, and conditional system-prompt guidance.
- Added `tlh gnosis status`, `tlh gnosis enable`, and `tlh gnosis disable` helper commands for the isolated profile.
- Added Gnosis installer flags (`--with-gnosis`, `--without-gnosis`, and `--no-gnosis`) and managed-binary `PATH` handling in the wrapper.
- Added a custom TLH footer showing working directory, git branch, session name, token/cost/context stats, model/thinking state, and extension statuses.

### Changed

- The footer suppresses zero-cost estimates for subscription-backed usage.
- README and release checks now document and validate the Gnosis helper script.

## [0.1.1] - 2026-05-09

### Changed

- Replaced the bundled `pi-compact-bash` default extension with `pi-quiet-tools`.
- Default-extension opt-outs now recognize `compact-bash` as an alias for `quiet-tools`.
- Settings merges remove replaced default-extension package sources when upgrading.

## [0.1.0] - 2026-05-09

### Added

- Isolated `tlh` installer and wrapper around upstream Pi.
- Conservative isolated settings merge for `~/.the-last-harness/agent`.
- Bundled Pi extension, skill, prompt, and theme resources.
- Bundled default-extension opt-out management via `tlh defaults`.
- Bundled default external extensions for permissions, Oracle review, notifications, context caps, quieter bash output, and destructive-action confirmations.
- Custom TLH startup header, default prompt guidance, `/tlh` and `/harness` status commands, and `/effort` reasoning-effort picker.
- Tag-based GitHub Releases with generated pinned installer assets.
