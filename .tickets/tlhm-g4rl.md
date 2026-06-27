---
id: tlhm-g4rl
status: closed
deps: []
links: []
created: 2026-06-27T19:54:30Z
type: feature
priority: 2
assignee: Diego Petrucci
---
# Wire NODE_COMPILE_CACHE into the tlh pi launch path

The generated tlh wrapper execs the pinned private Pi (a Node script) but never sets NODE_COMPILE_CACHE, even though 'node-compile-cache' is already reserved in RUNTIME_OWNED_TOPLEVEL (scripts/tlh-install.mjs) and the uninstall allow-list. Set NODE_COMPILE_CACHE to a stable dir under the private runtime prefix so Node's on-disk V8 code cache persists across launches. Measured warm effect is modest (~40ms) because jiti-evaluated .ts bypasses V8 code cache, but it is low-risk, the infra already exists, and it complements the cold-launch jiti fix (and benefits Pi's own native bundle, especially cold).

## Design

Set the env in scripts/tlh-wrapper.mjs renderWrapper just before the exec "${default_pi_cmd}" line. Derive the cache dir from the pinned runtime: prefix = dirname(dirname(default_pi_cmd)) (i.e. .../runtime), cache = <prefix>/node-compile-cache; export NODE_COMPILE_CACHE with that absolute path. Node auto-creates the dir, but install may pre-create it for ownership clarity. Keep scope to the interactive pi exec path; do not change the update/defaults/tickets helper branches. Confirm node-compile-cache remains covered by RUNTIME_OWNED_TOPLEVEL and uninstall cleanup. Update the wrapper-render tests/snapshots accordingly. Do not re-introduce any per-launch probe (gnosis ruxvtf).

## Acceptance Criteria

Rendered wrapper exports NODE_COMPILE_CACHE=<runtime-prefix>/node-compile-cache before exec of the pinned pi; helper subcommand branches unchanged; cache dir is runtime-owned and removed on uninstall; wrapper-render tests updated and passing; bash -n install.sh and node --check pass for touched scripts. Defer full validate + startup checks to the final-validation ticket.

