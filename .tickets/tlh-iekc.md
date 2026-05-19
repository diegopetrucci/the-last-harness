---
id: tlh-iekc
status: closed
deps: [tlh-xve7]
links: []
created: 2026-05-19T04:56:07Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Run FFF embedding benchmark

Use the generalized harness to run the approved 10-run cold-cache and 10-run warm-cache control-vs-treatment benchmark for @ff-labs/pi-fff.

## Acceptance Criteria

Produces artifacts with 10 cold control/treatment and 10 warm control/treatment timed runs, fresh temp agent/bin dirs for each run, failure accounting, package size delta, and treatment validation for embedded FFF resources.


## Notes

**2026-05-19T07:42:45Z**

Benchmark artifacts captured at /var/folders/nq/fkrbfck57y91r169_934fxb80000gn/T/tlh-fff-benchmark-output-20260519T064143Z-91923 after running:
node scripts/benchmark-context-cap-embedding.mjs --extension-id fff --runs 10 --cache-mode both --keep-temp --output-dir /var/folders/nq/fkrbfck57y91r169_934fxb80000gn/T/tlh-fff-benchmark-output-20260519T064143Z-91923

Work root kept by harness: /var/folders/nq/fkrbfck57y91r169_934fxb80000gn/T/tlh-default-extension-benchmark-work-pnuCuq
Artifacts: results.json, summary.txt, logs/ (84 per-run stdout/stderr logs).

Run validation: 42 total runs (2 warmups + 40 timed), 40/40 timed ok, 0 failures. Fresh timed agent/bin dirs: 40/40 each; cold cache dirs are per-run and warm cache is the shared temp cache by design. Treatment validation ok; embedded resources: extension ./extensions/embedded/fff/src/index.ts; FFF removed from default-extension manifest.

Timing summary:
- cold/control: ok 10/10, median 89,905.78 ms, mean 92,220.16 ms, min 84,168.83 ms, max 105,828.12 ms
- cold/treatment: ok 10/10, median 88,236.82 ms, mean 90,953.47 ms, min 79,584.36 ms, max 107,984.77 ms
- warm/control: ok 10/10, median 84,150.74 ms, mean 83,762.95 ms, min 73,035.00 ms, max 93,103.13 ms
- warm/treatment: ok 10/10, median 72,530.04 ms, mean 73,075.55 ms, min 65,748.67 ms, max 82,287.24 ms

Median treatment delta: cold -1.67s (-1.86%), warm -11.62s (-13.81%).
Package size delta: treatment +13,769 packed bytes, +45,178 unpacked bytes, +4 entries/files.
Dependency/runtime caveat: @ff-labs/pi-fff@0.8.1 declares dependency @ff-labs/fff-node and peer dependencies @earendil-works/pi-coding-agent, @earendil-works/pi-tui, and @sinclair/typebox. Harness embeds pi resource paths only and does not merge selected package dependencies, so runtime equivalence is not guaranteed.
