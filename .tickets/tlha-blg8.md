---
id: tlha-blg8
status: open
deps: []
links: []
created: 2026-06-05T09:35:41Z
type: chore
priority: 3
assignee: Diego Petrucci
---
# Post-release: remove unconditional confirmation-extension purge

After the next TLH release that includes the forced removal of permission-gate and confirm-destructive has shipped, remove the temporary unconditional identity-based purge for npm:@diegopetrucci/pi-permission-gate and npm:@diegopetrucci/pi-confirm-destructive. The replacement behavior should rely on provenance-aware retired-default cleanup so manually re-added packages are respected.

## Acceptance Criteria

Do not implement until after the first release containing the force-removal ships; unconditional identity-based removal for these two packages is gone; cleanup respects tlh.defaultExtensionProvenance/managed TLH defaults; tests cover preserving manually re-added package identities after provenance exists.

