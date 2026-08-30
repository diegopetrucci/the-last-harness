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
- [ ] **Delegation and lifecycle smoke:** delegate to the nine supported TLH minor agents, including the command-only `test-runner`, confirm a non-allowlisted target is blocked, confirm primary delegation uses user scope plus fresh context, and exercise an async run through `status` and `resume`.

Record the release candidate, profile, session evidence, and outcomes on `tlh-2ej0`. Do not mark this debt complete from static validation alone.

## Current sources

- [subagents.md](subagents.md) for user-visible runtime, migration, diagnostics, and undo behavior;
- [VALIDATING.md](../VALIDATING.md) for automated checks and the current release-tier live checklist;
- [subagents-history/HISTORY.md](subagents-history/HISTORY.md) for the exact source checkpoint and integration history;
- `npm run validate` for the standard repository gate.

The old package-release, pin-bump, and fork-sync procedures are preserved only in the immutable archive under `docs/subagents-history/source/`. They are historical evidence and must not be followed as current TLH instructions. This retirement makes no claim about deprecating or unpublishing any npm package, changing repository hosting state, deleting source, or archiving a GitHub repository.
