---
id: tlha-ubji
status: open
deps: [tlha-4nzm]
links: []
created: 2026-05-20T14:45:02Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Hard-fail installs when prebuilt gn is unavailable; mark TLH_GNOSIS_SCRIPT REQUIRED

On unsupported platforms (anything other than darwin/linux × amd64/arm64), the installer must fail rather than warn-and-continue. Mark TLH_GNOSIS_SCRIPT as REQUIRED in the support-file manifest and remove the optional-fallback warning path. Affects: scripts/tlh-gnosis.mjs (installManagedGnosis), scripts/lib/tlh-install-support-manifest.mjs, scripts/lib/tlh-install-support-files.mjs, scripts/tlh-install.mjs (surface helper failure as fatal unless TLH_SKIP_GNOSIS_INSTALL=1).

## Acceptance Criteria

1) supportFileManifest() returns TLH_GNOSIS_SCRIPT with requirement=REQUIRED; supporting library no longer special-cases it as optional. 2) installManagedGnosis exits non-zero with a clear platform-unsupported message instead of warning when gnosisPlatform() reports no asset. 3) configureGnosis in scripts/tlh-install.mjs propagates a non-zero helper exit as a fatal install error unless TLH_SKIP_GNOSIS_INSTALL is set. 4) bash scripts/check-installer-smoke.sh (with the env escape) still passes on darwin/linux. 5) A simulated unsupported-platform path produces the new error string.


## Notes

**2026-05-20T15:11:30Z**

Architect note: now that scripts/tlh-gnosis.mjs configure-install no longer reads/writes settings, scripts/tlh-install.mjs configureGnosis should not be gated by --no-settings. Remove that early return in this ticket; TLH_SKIP_GNOSIS_INSTALL remains the only installer escape for tests/benchmarks.
