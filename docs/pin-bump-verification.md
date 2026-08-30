# Retired subagent pin-bump checklist

> **Historical status:** the standalone package pin checklist is retired now that the subagent runtime is first-party TLH code. It must not be used to publish, release, or pin a subagent package.

Older TLH releases installed and pinned a separate `@diegopetrucci/pi-subagents` package. The former live-session checklist and GitHub issue [#346](https://github.com/diegopetrucci/the-last-harness/issues/346) tracked that package's pin bumps. `config/default-extensions.json` no longer contains a subagent package pin, and current TLH install/update does not publish or fetch a standalone subagent release.

## Current validation boundary

The imported unit/integration/E2E suites, focused TLH regressions, package assertions, and provenance checks now run through the root repository. They cover the compact parent-facing description, the closed action surface, bundled-agent safety, async status, steering, and resume mechanics.

`npm run validate` does **not** replace the former live-session checks. Rendering and real parent/child coordination still require release-tier validation in an installed TLH session. That remaining debt belongs to ticket `tlh-2ej0`, not to a package pin bump; issue #346 remains a historical tracker for the old delivery mechanism.

## Current release-tier live checklist (`tlh-2ej0`)

Run these checks against the packaged TLH release candidate, without creating or changing any standalone subagent pin:

- [ ] **Compact parent-facing description:** the live `subagent` tool description always renders in compact form while retaining its safety-critical delegation guidance.
- [ ] **Native supervisor coordination:** a minor agent's `contact_supervisor` request reaches the architect through the native supervisor channel and the pause/resume choice is delivered correctly.
- [ ] **Maximum-thinking badge:** a supported `:max` model renders the expected `max` thinking badge in a live child run.
- [ ] **Delegation and lifecycle smoke:** delegate to the eight supported TLH minor agents, confirm a non-allowlisted target is blocked, confirm primary delegation uses user scope plus fresh context, and exercise an async run through `status` and `resume`.

Record the release candidate, profile, session evidence, and outcomes on `tlh-2ej0`. Do not mark this debt complete from static validation alone.

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

## Current sources

- [subagents.md](subagents.md) for user-visible runtime, migration, diagnostics, and undo behavior;
- [VALIDATING.md](../VALIDATING.md) for automated checks and the current release-tier live checklist;
- [subagents-history/HISTORY.md](subagents-history/HISTORY.md) for the exact source checkpoint and integration history;
- `npm run validate` for the standard repository gate.

The old package-release, pin-bump, and fork-sync procedures are preserved only in the immutable archive under `docs/subagents-history/source/`. They are historical evidence and must not be followed as current TLH instructions. This retirement makes no claim about deprecating or unpublishing any npm package, changing repository hosting state, deleting source, or archiving a GitHub repository.
