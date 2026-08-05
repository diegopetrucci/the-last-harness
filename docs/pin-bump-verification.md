# Retired subagent pin-bump checklist

> **Historical status:** retired when the subagent runtime became first-party TLH code. This file is not an active release checklist.

Older TLH releases installed and pinned a separate `@diegopetrucci/pi-subagents` package. The former live-session checklist tracked that package's pin bumps and GitHub issue [#346](https://github.com/diegopetrucci/the-last-harness/issues/346). `config/default-extensions.json` no longer contains a subagent package pin, and current TLH install/update does not publish or fetch a standalone subagent release.

The behaviors formerly listed here now belong to the first-party runtime and its TLH validation:

- compact tool descriptions and invalid-mode fallback;
- default-off RPC behavior;
- native supervisor coordination;
- the closed management/action surface;
- bundled-agent allowlisting, fresh context, async status, steering, and resume.

Use these current sources instead:

- [subagents.md](subagents.md) for user-visible runtime, migration, and undo behavior;
- [VALIDATING.md](../VALIDATING.md) for the imported suites, package assertions, and provenance verification;
- [subagents-history/HISTORY.md](subagents-history/HISTORY.md) for the exact source checkpoint and integration history;
- `npm run validate` for the standard repository gate.

The old package-release, pin-bump, and fork-sync procedures are preserved only in the immutable archive under `docs/subagents-history/source/`. They are inert historical evidence and must not be followed as current TLH instructions. This retirement makes no claim about deprecating or unpublishing any npm package, changing repository hosting state, deleting source, or archiving a GitHub repository.
