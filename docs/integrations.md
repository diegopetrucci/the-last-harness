# Integrations

TLH includes managed integrations for project memory, ticketed workflows, and native RTK shell-command rewriting. Gnosis project memory and `tk` ticket support are required for standard architect/product workflows; Rush keeps that tooling available but handles small bounded tasks with direct edits instead of the default `tk` loop. RTK is also installer-managed now: the old `pi-rtk` package and `/rtk` slash-command UI are gone.

## Gnosis integration

[Gnosis](https://github.com/skorokithakis/gnosis) is a small `gn` CLI for recording project decisions, constraints, rejected alternatives, and lessons that are not obvious from code alone. On supported platforms (linux/darwin × x64/arm64), TLH installs it automatically because `tlh` works better when agents can consult and update repo-local project memory. TLH currently pins the managed default to Gnosis `v0.5.3`, while installer-owned `TLH_GNOSIS_VERSION` and `TLH_GNOSIS_REPO` overrides still let maintainers point at a different release or repository when needed. Installs and updates on unsupported platforms hard-fail.

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

If TLH cannot validate a configured/existing `tk` and cannot install the managed copy, install or update fails with an actionable error instead of starting with an incomplete workflow. To recover, provide a valid `tk` command and run `tlh tickets enable --install-path /path/to/tk`, or rerun the installer/update once the managed download can succeed.

Removing `~/.the-last-harness` removes any managed `tk` copy. To remove only the managed `tk` binary while keeping the rest of the profile, delete `~/.the-last-harness/agent/bin/tk`; the next install/update will recreate it if no other valid `tk` is configured. Running `tlh tickets enable` without a managed reinstall clears the recorded SHA-256, so the next install/update refreshes the managed binary when the managed path is in use.

Managed installs download the pinned `wedow/ticket` source tarball (`v0.3.2`) and verify its SHA-256 before extracting the `ticket` script; inherited environment variables cannot override those installer-owned source pins. TLH also records the SHA-256 of the managed binary in `settings.tlh.tickets.installedSha256`. When a future TLH release bumps the pinned SHA, the next `tlh update` or installer rerun reinstalls the managed binary and refreshes the recorded value. Custom (non-managed) `installPath` values are unaffected by this check.

## Native RTK integration

TLH now bundles RTK as a managed native rewrite integration rather than a separately managed `pi-rtk` extension. There is no `/rtk` command surface anymore: `/rtk enable`, `/rtk disable`, and `/rtk status` are gone.

On supported darwin/linux x64/arm64 platforms, install and update place the pinned managed RTK binary at `~/.the-last-harness/agent/bin/rtk`. The wrapper adds `<agent>/bin` to `PATH` for the wrapped upstream Pi process, so TLH sessions and child shells can find that managed binary normally. If TLH cannot install and validate the pinned RTK binary, install or update fails with an actionable error instead of continuing without rewrite support.

To disable RTK rewriting for a single launch, set `RTK_DISABLED=1` before starting TLH:

```sh
RTK_DISABLED=1 tlh
```

To disable it persistently for the isolated profile, set `tlh.rtk.disabled` in `~/.the-last-harness/agent/settings.json`:

```json
{
  "tlh": {
    "rtk": {
      "disabled": true
    }
  }
}
```

To re-enable rewriting, unset `RTK_DISABLED`, remove `tlh.rtk.disabled`, or set it back to `false`.

Removing `~/.the-last-harness` removes the managed RTK copy along with the rest of the isolated profile. To remove only the managed binary while keeping the rest of TLH, delete `~/.the-last-harness/agent/bin/rtk`; the next install or `tlh update` recreates it. The old `tlh.disabledDefaultExtensions` RTK markers and `tlh defaults disable rtk` flow no longer control RTK after this migration.
