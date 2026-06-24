---
id: tlh-2plr
status: open
deps: []
links: []
created: 2026-06-24T19:17:28Z
type: task
priority: 2
assignee: Diego Petrucci
external-ref: gh-187
tags: [stress-test, default-extensions, pi-web-access]
---
# Fix pi-web-access dirty checkout after default-extension install

Stress testing PR #187 found that a fresh isolated TLH install succeeds but leaves the bundled git checkout github.com/diegopetrucci/pi-web-access dirty: package-lock.json is rewritten from version 0.10.7 to 0.10.7-tlh.1. This appears to come from fork package metadata/lockfile drift rather than the dependency-update branch itself, but it creates noisy local diffs in the installed profile after install/update.

## Acceptance Criteria

Fresh isolated install/update of bundled defaults leaves the pi-web-access checkout clean; package.json and package-lock.json versions in the pinned fork/tag are aligned; web-scout smoke still fetches a simple page; if the fork tag changes, config/default-extensions.json is updated to the reviewed reachable tag.

