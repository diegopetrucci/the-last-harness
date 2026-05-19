---
id: tlhf-gsew
status: closed
deps: [tlhf-etnw]
links: []
created: 2026-05-19T21:26:47Z
type: task
priority: 1
assignee: Diego Petrucci
parent: tlhf-oxht
---
# Migrate high-risk script profile writes to helper

Adopt the shared profile write helper for the first-scope script-side writes: merge-settings, merge-keybindings, tlh-defaults, tlh-gnosis settings writes only, tlh-install-state, tlh-install settings pre-install backup, and copySafeProfileFile support copies.

## Design

Do not change merge semantics, opt-out behavior, Gnosis binary install behavior, wrapper/bin writes, or runtime extension writes. Ensure installed helper scripts can import any shared lib they need from the isolated profile.

## Acceptance Criteria

Listed scripts use the helper or have an explicit in-code reason they do not; existing backups remain conservative/non-overwriting; support manifest/package install includes required helper lib files; direct CLI use such as --settings remains compatible or fails closed with a clear error; no normal ~/.pi/agent mutation path is introduced.

