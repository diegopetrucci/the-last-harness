---
id: tlht-h7vq
status: open
deps: []
links: []
created: 2026-06-21T08:43:10Z
type: bug
priority: 2
assignee: Diego Petrucci
---
# Migration path can mark a shared npm prefix as TLH-owned (rm -rf data-loss residual)

Residual data-loss edge in the runtime-ownership marker model (PR #176 follow-up). The provenance-gated migration branch in scripts/tlh-install.mjs (~line 744) writes an origin=migrated .tlh-runtime-owned marker onto a pre-existing runtime prefix whenever install-state records piInstalledByTlh=true, WITHOUT proving the prefix is exclusively TLH's. If that prefix is a shared npm --prefix containing TLH's pi PLUS a foreign package nested under lib/node_modules, the migrated marker makes uninstall pass the ownership gate, and the top-level exclusivity tripwire (which only inspects {bin, lib, node-compile-cache, marker}) cannot see the nested foreign package -> uninstall rm -rf deletes the shared prefix including the foreign package.

Why not fixed in PR #176: the exposure is pre-existing (the same shared-prefix-with-piInstalledByTlh=true case loses data on today's shape-based uninstall too), and it CANNOT be robustly closed by inspection because npm hoists pi's own transitive deps into lib/node_modules, so directory contents cannot distinguish a dependency from a foreign package. This is precisely why the marker model was chosen over shape inference.

Candidate fixes (needs design decision):
- (A) For legacy/migrated runtimes, uninstall via surgical 'npm uninstall -g --ignore-scripts --prefix <runtime> @earendil-works/pi-coding-agent' (removes only TLH's package + now-unused deps) instead of rm -rf, so co-located packages survive regardless of nesting.
- (B) Refuse migration entirely: never write a marker onto an unverified pre-existing prefix; require legacy users to reinstall into a dedicated runtime.
- (C) Record provenance richer than a boolean at install time (e.g. store the exact prefix TLH created and whether it was created-by-us vs reused) so migration only fires for prefixes TLH itself created.

Recommendation leaning (A): surgical uninstall is safe under hoisting and least disruptive. Decide before implementing.

## Design

Tracked as a follow-up to PR #176 (runtime ownership marker). Linked context: gnosis acaqvx. Core constraint: npm dep hoisting makes lib/node_modules contents unable to distinguish TLH deps from foreign packages.

## Acceptance Criteria

A migrated/legacy runtime that is actually a shared npm prefix is NOT subject to rm -rf of co-located packages on 'tlh uninstall'. Chosen approach (A/B/C) implemented with tests proving a shared prefix's foreign package survives uninstall of a migrated runtime. npm run validate passes.

