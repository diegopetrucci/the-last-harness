# Changelog

All notable changes to The Last Harness will be documented in this file.

## [Unreleased]

### Added

- Bundled TLH-profile-aware forks of `pi-subagents` and `pi-intercom` as default extensions, including git-package intercom bridge detection and scoped `get` detail inspection for the subagent fork.
- Added the default `architect` primary-agent prompt and TLH minor subagent prompts for `developer`, `code-reviewer`, `repo-scout`, and `diff-summarizer`.
- Added `/architect` session and persistent controls to enable, disable, toggle, or reset the TLH architect primary-agent persona.
- Copy TLH minor subagent prompts into the isolated profile during install and expose them through `subagents.agentDirs`.

### Changed

- Disable `pi-subagents` built-in agents by default in the isolated TLH profile.
- The TLH extension now injects only the active primary-agent prompt plus compact allowed-subagent metadata into the main session.
- Gnosis planning/review instructions are now injected only into the main session by the conditional Gnosis prompt, rather than being baked into the architect prompt; child subagents are told to report memory-worthy findings to the parent instead of writing to Gnosis directly.
- TLH subagent execution plus `list` and `get` detail inspection are forced to the isolated user scope and fresh child context so project agents cannot shadow bundled minor agents and parent architect/Gnosis history is not forked into children, while async/background control actions such as `status` and `interrupt` remain available to the architect; `resume` is blocked in architect mode because persisted runs do not prove their original agent scope.
- The architect/developer/reviewer prompts now use `tk` when available but fall back to self-contained numbered tasks, so fresh installs do not require an external ticket command.
- TLH no longer switches the saved model or reasoning effort on startup unless `tlh.primaryAgent.applyModel` or `tlh.primaryAgent.applyThinking` is explicitly enabled.
- Default-extension source migrations, replacement-package appends, and replaced-package cleanup now require installer `--force`, preserving user-pinned or user-managed package entries by default and avoiding duplicate or mismatched replaced/default extension update loads; disabling a bundled default now also removes any configured package identities it replaces. Isolation-critical `pi-subagents`/`pi-intercom` replacements are migrated to the bundled TLH forks by default unless disabled.
- Manual install docs now use the installed TLH package checkout for helper scripts and bundled subagent prompts, verify/copy prompts before settings merge, avoid symlink-following support-directory removal/copy commands, and use current pinned-release examples.
- The installer now copies and verifies bundled subagent prompts before merging settings, prefers the explicit package source for prompts and fetches prompt files with other one-line-installer support assets for custom package sources, fails normal installs instead of enabling undiscoverable TLH subagents when prompts are missing or incomplete, fails installer runs when critical subagents/intercom default-extension installs or refreshes fail, and refuses to write installer-owned support files or git package refreshes through symlinked paths outside the isolated profile. Runtime startup/update state also refuses symlinked TLH support paths that resolve outside the isolated profile.

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
