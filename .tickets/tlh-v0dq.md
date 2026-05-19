---
id: tlh-v0dq
status: closed
deps: [tlh-xve7]
links: []
created: 2026-05-19T04:56:07Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Run Plannotator embedding benchmark

Use the generalized harness to run the approved 10-run cold-cache and 10-run warm-cache control-vs-treatment benchmark for @plannotator/pi-extension.

## Acceptance Criteria

Produces artifacts with 10 cold control/treatment and 10 warm control/treatment timed runs, fresh temp agent/bin dirs for each run, failure accounting, package size delta, and treatment validation for embedded Plannotator resources.


## Notes

**2026-05-19T06:39:48Z**

Benchmark artifacts captured at /var/folders/nq/fkrbfck57y91r169_934fxb80000gn/T/tlh-plannotator-benchmark-output-20260519T054225Z-47424 after running:
node scripts/benchmark-context-cap-embedding.mjs --extension-id plannotator --runs 10 --cache-mode both --keep-temp --output-dir /var/folders/nq/fkrbfck57y91r169_934fxb80000gn/T/tlh-plannotator-benchmark-output-20260519T054225Z-47424

Work root kept by harness: /var/folders/nq/fkrbfck57y91r169_934fxb80000gn/T/tlh-default-extension-benchmark-work-vLCDHd
Artifacts: results.json, summary.txt, logs/ (84 per-run stdout/stderr logs).

Run validation: 42 total runs (2 warmups + 40 timed), 40/40 timed ok, 0 failures. Treatment validation ok; embedded resources: extensions ./extensions/embedded/plannotator and skills ./extensions/embedded/plannotator/skills; Plannotator removed from default-extension manifest; context-cap preserved in manifest.

Timing summary:
- cold/control: ok 10/10, median 85,750.17 ms, mean 89,290.04 ms, min 81,423.56 ms, max 127,338.28 ms
- cold/treatment: ok 10/10, median 75,000.19 ms, mean 76,523.81 ms, min 68,585.33 ms, max 92,443.88 ms
- warm/control: ok 10/10, median 76,077.54 ms, mean 83,762.62 ms, min 70,839.47 ms, max 104,894.46 ms
- warm/treatment: ok 10/10, median 63,550.70 ms, mean 67,821.11 ms, min 54,497.90 ms, max 95,638.27 ms

Median treatment delta: cold -10.75s (-12.54%), warm -12.53s (-16.47%).
Package size delta: treatment +8,093,840 packed bytes, +31,469,132 unpacked bytes, +98 entries/files.
Dependency/runtime caveat: @plannotator/pi-extension declares runtime dependencies @joplin/turndown-plugin-gfm, @pierre/diffs, and turndown plus peer dependency @earendil-works/pi-coding-agent. Harness embeds pi resource paths only and does not merge selected package dependencies, so runtime equivalence is not guaranteed.
