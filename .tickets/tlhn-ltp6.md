---
id: tlhn-ltp6
status: closed
deps: []
links: []
created: 2026-05-20T13:31:33Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Persist installed tk SHA256 and reinstall on pin mismatch

After a successful managed-tk install, record settings.tlh.tickets.installedSha256 = DEFAULT_TICKET_SHA256. In commandConfigureInstall / findValidTkForConfigure (scripts/tlh-tickets.mjs), when the target is the managed install path AND the recorded installedSha256 does not match DEFAULT_TICKET_SHA256 (or is absent), force reinstall and update the field. Custom (non-managed) install paths must not write or read installedSha256. If extensions/the-last-harness/types.ts encodes the tickets settings shape, add the optional installedSha256 field. Runtime extension consumers should ignore unknown fields.

## Design

Legacy installs (no recorded SHA, managed binary already present) trigger a one-time reinstall to populate the field. The reinstall short-circuits to no-op if the existing on-disk binary's content already matches DEFAULT_TICKET_SHA256 byte-for-byte (optional optimization; acceptable to just always reinstall in the legacy case).

## Acceptance Criteria

Fresh managed install records settings.tlh.tickets.installedSha256 === DEFAULT_TICKET_SHA256. Simulating a pin bump (modify the recorded value to a different hex) followed by 'tlh tickets install' triggers reinstall and updates the field. Legacy install (recorded SHA absent, managed binary present) triggers reinstall once and populates the field. Custom installPath does not write installedSha256. New tests cover all three cases. Existing tests still pass. CHANGELOG note (handled in docs ticket) reflects the behavior.

