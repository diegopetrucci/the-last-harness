# Integrations

TLH includes managed integrations for project memory and ticketed workflows. Gnosis project memory and `tk` ticket support are required for standard architect/product workflows; Rush keeps that tooling available but handles small bounded tasks with direct edits instead of the default `tk` loop.

## Gnosis integration

[Gnosis](https://github.com/skorokithakis/gnosis) is a small `gn` CLI for recording project decisions, constraints, rejected alternatives, and lessons that are not obvious from code alone. On supported platforms (linux/darwin × x64/arm64), TLH installs it automatically because `tlh` works better when agents can consult and update repo-local project memory. TLH currently pins the managed default to Gnosis `v0.5.4`, while installer-owned `TLH_GNOSIS_VERSION` and `TLH_GNOSIS_REPO` overrides still let maintainers point at a different release or repository when needed. Installs and updates on unsupported platforms hard-fail.

When a valid Gnosis `gn` binary is present, TLH appends these instructions to the system prompt:

```text
At the start of any task, run `gn help plan` and follow its instructions.
After finishing a task, run `gn help review`.
```

Gnosis project data lives in repo-local `.gnosis` directories. Removing `~/.the-last-harness` removes only the managed `gn` binary under the isolated profile; it does not delete repo-local memory.

## Ticket integration

TLH requires the `tk` ticket CLI for architect and product workflows. Rush is the exception in day-to-day usage: it edits directly for small bounded work and does not start with the default ticket/developer/review loop, even though the managed `tk` command is still installed for the rest of TLH. Install and update first reuse a valid configured or existing `tk`; if none is available, they place a managed copy at `~/.the-last-harness/agent/bin/tk`. TLH does not install `tk` globally or through Homebrew, and it never writes normal `~/.pi/agent` config.

Inspect or reconfigure the command after install:

```sh
tlh tickets status
tlh tickets enable
```

Legacy `settings.tlh.tickets.enabled=false` values are re-enabled during install/update because ticket support is required. The wrapper includes the managed `<agent>/bin` directory on `PATH` for the wrapped upstream Pi process, so subagents and shells launched from inside TLH can find a managed `tk` when TLH supplied one.

At TLH session start, TLH also scopes `tk` to one ticket store for that session by exporting `TICKETS_DIR` before the ticket UI or agent prompts run. If `TICKETS_DIR` is already set, TLH preserves it. Otherwise TLH points `tk` at `<git-worktree-root>/.tickets`; outside Git it falls back to `<session-cwd>/.tickets`. This keeps architect sessions, child sessions, `/tickets`, and Bash-launched `tk` commands on the same repo-local ticket store without touching ancestor stores such as `~/Developer/.tickets`.

`/tickets` shows the workflow counts plus one ID/title detail line for a single in-progress ticket or an `In progress:` list for multiple tickets. TLH strips terminal control sequences from titles and falls back to the ticket ID when a title cannot be resolved or is empty after sanitization.

If TLH cannot validate a configured/existing `tk` and cannot install the managed copy, install or update fails with an actionable error instead of starting with an incomplete workflow. To recover, provide a valid `tk` command and run `tlh tickets enable --install-path /path/to/tk`, or rerun the installer/update once the managed download can succeed.

Removing `~/.the-last-harness` removes any managed `tk` copy. To remove only the managed `tk` binary while keeping the rest of the profile, delete `~/.the-last-harness/agent/bin/tk`; the next install/update will recreate it if no other valid `tk` is configured. Running `tlh tickets enable` without a managed reinstall clears the recorded SHA-256, so the next install/update refreshes the managed binary when the managed path is in use.

Managed installs download the pinned `wedow/ticket` source tarball (`v0.3.2`) and verify its SHA-256 before extracting the `ticket` script; inherited environment variables cannot override those installer-owned source pins. TLH also records the SHA-256 of the managed binary in `settings.tlh.tickets.installedSha256`. When a future TLH release bumps the pinned SHA, the next `tlh update` or installer rerun reinstalls the managed binary and refreshes the recorded value. Custom (non-managed) `installPath` values are unaffected by this check.

## Terminal activity bridge

If you already use a supported terminal integration such as Herdr or cmux, TLH reports an effective in-progress state that includes both the primary session and active async/background subagents. That means the integration may keep showing TLH as working even after the main prompt is ready for input, until those background jobs finish or clear.

This bridge is session-scoped only. TLH does not install, enable, or reconfigure Herdr, cmux, or any other external integration for you, and it does not write persistent external config as part of this bridge. If your terminal setup does not already support this status handoff, nothing new is installed.
