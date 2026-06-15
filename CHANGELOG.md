# Changelog

All notable changes to The Last Harness will be documented in this file.

## [Unreleased]

- Bundled the updated `pi-subagents` tag with the completion-guard fix for VCS/PR false positives.

## [0.20.0] - 2026-06-15

### Changed

- The TLH git commit footer is now coauthor-only: `Co-authored-by: The Last Harness <hi@thelastharness.com>`. The decorative `🤖 Generated with …` heading line has been removed. GitHub and git log co-authorship attribution is unchanged. The attribution guard now requires a blank line before the coauthor trailer (or a footer-only message) to match git trailer parsing rules; commit messages with only a single newline before the trailer are rejected.
- TLH now requires upstream Pi >=0.79.1. Installer checks, wrapper defaults, package metadata, and current install/update docs all use the raised runtime floor.
- The compact (non-expanded) subagent view now hides the artifact-path line — press Ctrl+O for the expanded view that still shows it — and renders the current tool command (e.g. long `bash` invocations) in full, wrapped to terminal width and capped at 3 lines with `…` on overflow instead of mid-flag `...` truncation.
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
- Context cap is now a built-in TLH feature (no longer a bundled default extension). The bundled `@diegopetrucci/pi-context-cap` default extension has been removed and will be force-uninstalled from existing isolated profiles on the next `tlh` install or update. Previous `tlh.disabledDefaultExtensions: ["context-cap"]` opt-outs are intentionally **not** preserved — those entries are silently pruned on upgrade. To opt out of the cap again, run `/toggle-context-cap` or set `tlh.contextCap.disabled: true` in your isolated settings.
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
- Footer restructured into three logical lines: working directory/git (unchanged), a single flowing `agent: … • model • thinking • context` line, and an optional session-stats line showing cost and/or subscription usage. Empty lines are omitted entirely.
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
