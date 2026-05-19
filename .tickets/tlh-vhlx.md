---
id: tlh-vhlx
status: closed
deps: [tlh-v0dq, tlh-iekc]
links: []
created: 2026-05-19T04:56:07Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Compare npm embedding benchmark candidates

Compare context-cap, Plannotator, and FFF benchmark results and recommend next install-time optimization work.

## Acceptance Criteria

Reports median/mean/min/max and deltas for each candidate, packed/unpacked size cost, dependency/runtime caveats, opt-out/update-cadence risks, and a clear recommendation on whether to embed any default, test additional candidates, or investigate another bottleneck.


## Notes

**2026-05-19T07:47:35Z**

Benchmark comparison complete (delta = treatment - control; negative is faster). All timed runs succeeded 10/10; runs were separate artifacts, so compare within-candidate deltas more than cross-candidate absolutes.

Timing / size:
- context-cap: +2,327 B packed / +7,883 B unpacked / +3 entries. Cold med/mean/min/max: +3.19s / -0.98s / -2.34s / -7.41s. Warm: -8.88s / -7.95s / -4.06s / -6.49s.
- Plannotator: +8,093,840 B packed / +31,469,132 B unpacked / +98 entries. Cold: -10.75s / -12.77s / -12.84s / -34.89s. Warm: -12.53s / -15.94s / -16.34s / -9.26s.
- FFF: +13,769 B packed / +45,178 B unpacked / +4 entries. Cold: -1.67s / -1.27s / -4.58s / +2.16s. Warm: -11.62s / -10.69s / -7.29s / -10.82s.

Dependency/runtime caveats:
- context-cap@0.1.0 has no normal/optional deps; peers are @earendil-works/pi-ai and @earendil-works/pi-coding-agent; no lifecycle scripts observed via npm metadata. Runtime equivalence is the least risky of the three.
- Plannotator@0.19.18 depends on @joplin/turndown-plugin-gfm, @pierre/diffs, and turndown. Benchmark treatment embedded declared Pi resource paths only and did not merge deps, so it is not runtime-equivalent; the large package size alone makes it unattractive.
- FFF@0.8.1 depends on @ff-labs/fff-node, which pulls ffi-rs and optional platform binary packages; treatment also did not merge deps, so the warm win likely overstates a real embedding. A dependency-complete benchmark is required before using this result for FFF.

Opt-out/update-cadence risks: moving any default from config/default-extensions.json into the TLH package would bypass current `tlh defaults disable <id>` package-removal semantics unless new opt-out/filtering plumbing is added. It also couples updates to TLH releases instead of independent npm package updates. This is especially risky for active external packages (Plannotator: 66 versions, latest 2026-05-18; FFF: 50 versions/nightlies, latest metadata 2026-05-15). Context-cap is owner-controlled and has only one version, but still needs opt-out preservation.

Recommendation: do not embed Plannotator or FFF from these artifacts. Do not embed any default as-is until opt-out semantics are preserved. If product accepts that follow-up, context-cap is the only plausible embed candidate (tiny size cost, no runtime deps, meaningful warm-cache improvement despite noisy cold median). Otherwise, stop testing more embed candidates for now and investigate the common install bottleneck/per-package npm-extension resolution, plus make future embedding benchmarks dependency-complete before evaluating dependency-heavy defaults.
