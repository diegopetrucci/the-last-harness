---
id: tlhm-0c6s
status: open
deps: []
links: []
created: 2026-06-27T19:54:30Z
type: feature
priority: 1
assignee: Diego Petrucci
---
# Persist jiti transpile cache locally to fix cold launch (~1.3s)

Cold tlh launch is ~2.1-2.6s vs ~0.9s warm. Root cause (measured; gnosis njekqj): Pi loads extensions via jiti, which caches transpiled .ts to os.tmpdir()/jiti -- volatile, reaped by macOS after reboot / ~3 idle days -- forcing full re-transpile of ~191 boot modules (+1.2-1.7s). jiti derives its cache dir from Pi's extension LOADER path: if <loader-dir>/../node_modules exists it caches to <that>/.cache/jiti, otherwise it falls back to os.tmpdir(). Verified experimentally: creating a symlink at the loader-adjacent node_modules path pointing to a persistent dir under the TLH-owned runtime relocates the cache for ALL extensions; after wiping $TMPDIR/jiti, cold boot stayed ~893ms instead of ~2263ms. Implement this fix LOCALLY in the tlh repo (NOT as an upstream Pi change).

## Design

Hook into scripts/tlh-install.mjs after the private runtime is (re)installed (installPiIfNeeded), since pi update reinstalls dist/ and wipes the symlink -- it must be recreated idempotently every install/update. Steps: (1) locate the installed pi extension loader (<pi-pkg>/dist/core/extensions/loader.js) and compute loaderAdjacent = path.resolve(loader, "../node_modules"); (2) create a persistent cache dir under the runtime prefix, e.g. <prefix>/jiti-cache; (3) if loaderAdjacent does NOT already exist, create it as a symlink to <prefix>/jiti-cache (idempotent: if it already points there, no-op). SAFETY: never clobber a real existing node_modules at that path (if a future Pi ships one, skip and leave behavior as-is); if the loader path cannot be resolved, skip silently (degrades to current volatile-cache behavior -- no breakage). Add <prefix>/jiti-cache to RUNTIME_OWNED_TOPLEVEL and ensure uninstall removes it (the symlink lives under the runtime that uninstall already rm -rf's -- verify). Document the brittleness (depends on Pi loader path + jiti cache heuristic) and that it degrades safely. Note the upstream follow-up (have Pi pass an explicit jiti fsCache path) -- see gnosis njekqj.

## Acceptance Criteria

After install/update, the loader-adjacent node_modules symlink exists and points to the persistent runtime cache dir; jiti writes transpiled cache there (not $TMPDIR); cold launch after wiping $TMPDIR/jiti stays approximately warm (~0.9s, not ~2.3s); operation is idempotent across repeated installs; safe no-op fallback when the loader path is unresolvable or a real node_modules already exists; uninstall leaves no residue; new/updated install tests cover create + idempotency + safe-skip. Defer full validate + startup/cold measurement to the final-validation ticket.

