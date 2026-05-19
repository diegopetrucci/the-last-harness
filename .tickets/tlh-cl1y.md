---
id: tlh-cl1y
status: closed
deps: [tlh-lzt9]
links: []
created: 2026-05-18T18:51:31Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Run context-cap npm-vs-embedded install benchmark

Run the approved benchmark using the harness for 10 runs per variant, covering both cold-cache and warm-cache cases, and capture raw timing artifacts.

## Acceptance Criteria

Produces timing data for control npm context-cap and treatment embedded context-cap: 10 cold-cache runs each and 10 warm-cache runs each. Each run uses fresh temporary agent/bin directories. Captures failures, wall-clock durations, package size delta, and validation that the treatment exposes the context-cap command/resource.


## Notes

**2026-05-18T21:22:34Z**

Benchmark artifacts captured at /tmp/tlh-context-cap-benchmark-output-6Itmbd after running:
node scripts/benchmark-context-cap-embedding.mjs --runs 10 --cache-mode both --output-dir /tmp/tlh-context-cap-benchmark-output-6Itmbd

Artifacts:
- results.json
- summary.txt
- command.log
- logs/ (84 per-run stdout/stderr logs)

Run validation: 42 total runs (2 warmups + 40 timed), 40/40 timed ok, 0 failures. Treatment validation ok; embedded extension ./extensions/embedded/context-cap/index.ts; context-cap removed from default-extension manifest and registers /context-cap.

Timing summary:
- cold/control: ok 10/10, median 83,311.34 ms, mean 86,364.17 ms, min 80,026.91 ms, max 101,236.33 ms
- cold/treatment: ok 10/10, median 86,500.83 ms, mean 85,384.97 ms, min 77,685.67 ms, max 93,831.21 ms
- warm/control: ok 10/10, median 74,134.26 ms, mean 75,284.19 ms, min 66,705.71 ms, max 84,546.85 ms
- warm/treatment: ok 10/10, median 65,255.79 ms, mean 67,335.60 ms, min 62,650.34 ms, max 78,061.58 ms

Package size delta: treatment +2,327 packed bytes, +7,883 unpacked bytes, +3 entries/files.
