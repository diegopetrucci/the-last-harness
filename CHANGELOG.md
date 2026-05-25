# Changelog

All notable changes to The Last Harness will be documented in this file.

## [Unreleased]

### Added

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
