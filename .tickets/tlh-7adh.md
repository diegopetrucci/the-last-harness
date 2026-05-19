---
id: tlh-7adh
status: closed
deps: [tlh-cl1y]
links: []
created: 2026-05-18T18:51:31Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Analyze context-cap embedding benchmark

Analyze the benchmark output and recommend whether embedding npm defaults is likely worth pursuing beyond context-cap.

## Acceptance Criteria

Reports median/mean/min/max for each case, the observed packed/unpacked size delta, risks such as opt-out behavior and update cadence, and a clear recommendation for whether to proceed with embedding more npm defaults, test more extensions, or investigate a different install-time bottleneck.


## Notes

**2026-05-18T21:22:34Z**

Benchmark analysis based on /tmp/tlh-context-cap-benchmark-output-6Itmbd/results.json and summary.txt.

Observed deltas:
- Package size: +2,327 packed bytes, +7,883 unpacked bytes, +3 entries/files.
- Cold install: treatment median +3.19s slower, mean 0.98s faster; cold result is noisy/inconclusive.
- Warm install: treatment median 8.88s faster, mean 7.95s faster; clear cached-install improvement for context-cap.

Recommendation:
- Do not broadly embed more npm defaults yet.
- The warm-cache result is promising enough to test more representative npm extensions, especially larger/dependency-heavy ones.
- Before shipping embedded defaults, resolve tradeoffs:
  - preserve current tlh defaults disable / tlh.disabledDefaultExtensions opt-out behavior;
  - accept or design around embedded defaults updating only with TLH releases instead of independent npm package cadence;
  - broaden measurement because this benchmark excluded wrapper creation, Gnosis, upstream Pi install, and real release download, so full install time may still be dominated elsewhere.
