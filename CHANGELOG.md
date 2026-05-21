# Changelog

All notable changes to The Last Harness will be documented in this file.

## [Unreleased]

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

### Added

- Added footer subscription usage for supported OpenAI/Codex and Anthropic OAuth subscription sessions; weekly usage remains hidden by default and is controlled with `/usage`.
- Subscription usage footer relies on undocumented vendor endpoints (`https://chatgpt.com/backend-api/wham/usage` and `https://api.anthropic.com/api/oauth/usage` with the `oauth-2025-04-20` beta flag) called with the session's existing OAuth bearer; the footer segment is hidden when those fetches fail.

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
