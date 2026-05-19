---
id: tlh-gw9i
status: open
deps: []
links: []
created: 2026-05-19T10:34:55Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Design safe default-extension embedding path

Benchmark results show embedding can reduce TLH install time, especially with warm npm caches. Do not embed Plannotator or FFF from the current artifacts because the treatments skipped dependency installation and are not runtime-equivalent. Context-cap is the only plausible first candidate due tiny package size and no runtime dependencies, but no default should be embedded until tlh defaults disable <id> opt-out behavior and update-cadence implications are preserved.

## Acceptance Criteria

Documents the benchmark takeaway and candidate recommendation; defines how embedded defaults continue to honor tlh defaults disable <id>/tlh.disabledDefaultExtensions; identifies whether context-cap should be embedded, left on npm, or retested; requires dependency-complete benchmarking before considering dependency-heavy defaults such as Plannotator or FFF.

