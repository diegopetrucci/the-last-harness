# Installer performance baseline

This is a contributor-only, opt-in benchmark for installer work. It performs
real network downloads, package-manager installs, and first launches, so it is
not part of `npm run validate` or ordinary CI. Run it only from a disposable
working context and never point it at a real `tlh` profile, normal Pi profile,
wrapper directory, credentials, or user cache.

## Reproduce the baseline

Use Node.js >=22.19.0 from the repository root on a Unix-like system with
network access and a PTY. The benchmark creates a temporary `HOME`, isolated
profile/bin/cwd, npm cache, npm user/global configuration, Git configuration,
XDG directories, and `TMPDIR`. It runs the installer and package manager in
those paths, removes inherited credentials, disables telemetry/update checks,
and intentionally leaves `PI_OFFLINE` unset for the measured first launch.

Inspect the current CLI without creating a workspace:

```sh
node scripts/check-installer-performance.mjs --help
```

The release baseline commands were:

```sh
node scripts/check-installer-performance.mjs --mode remote --ref v0.40.0 --upgrade-from v0.39.0 --runs 3 --scenarios all
node scripts/check-installer-performance.mjs --mode checkout --ref v0.40.0 --runs 1 --scenarios cold
```

`checkout` mode is intentionally cold-only. `remote` mode is the only mode that
supports `--scenarios all`, including the changed-pin upgrade; use
`--upgrade-from` only with that remote all-scenario run. `remote` downloads the
selected ref's installer and uses network-backed installation. `checkout` uses
this checkout's `install.sh` and records its support-code revision separately.
`all` runs cold-cache fresh, warm-cache fresh, unchanged reinstall, and
changed-pin upgrade. Each cold sample gets a new npm cache; warm-cache samples
copy a cache from a fully launched seed; reinstall and upgrade samples start
from fully launched profiles. `--json` can be added when a credential-free
machine-readable result is needed.

The original ticket's checkout command also contained
`--upgrade-from v0.39.0`; that flag is invalid and unused for `--scenarios
cold`. The corrected command above removes only that flag.

## Measurement scope

- **Installer wall time** starts when the isolated installer process starts and
  ends when it exits. It includes unclassified child work.
- **Phase timings** are approximate observations from installer progress
  markers. A phase without both markers is `unavailable`, not zero. The
  `defaults` phase can include managed-tool work that has no separate output
  boundary; `managed-tools` is therefore reported as unavailable here.
- **Ref identity**: `selected ref (... resolved ...)` is the requested package
  ref and its resolved commit. `observed installed revision` is the installed
  package checkout's post-install `HEAD`; keep it separate so mismatches remain
  visible. `support-code revision` identifies the installer/support checkout and
  is separate from both.
- **First usable launch** runs the generated wrapper in a PTY without a prompt
  or model request. Readiness requires both a TLH header and footer marker;
  first output or the installer's `Done` line alone is not readiness.
- Seed installs, warm-cache seeding, trust metadata, and the outer download of
  a remote installer are setup work and are excluded from measured sample
  timings. Setup provenance and cache conditions must remain visible when
  comparing results.
- Samples with non-empty failure diagnostics remain visible individually but are
  excluded from aggregate, phase, and per-scenario timing summaries.

## Recorded attempts and incidents

All dates below are 2026-09-09, in chronological order.

1. The first authorized remote attempt,
   `node scripts/check-installer-performance.mjs --mode remote --ref v0.40.0 --upgrade-from v0.39.0 --runs 3 --scenarios all`,
   stopped before samples because the benchmark used the same npmrc for npm's
   user and global configuration. The cleanup was confirmed; this is
   harness-validation evidence, not a performance sample. The benchmark was
   corrected to use distinct owned configuration files before the retry.
2. The exact remote command was retried and completed all 12 requested samples.
   Its selected-ref identity was the peeled `v0.40.0` commit
   `f7bfee92e0e56b28b325fdd1e455fe5affe5040c`, but the separate pre-fix
   support-code revision result field reported the annotated `v0.40.0` tag
   object `a17d7346bf0d0ede0bdc330d7801949634faec44`. It also initially
   reported the annotated `v0.39.0` tag object as
   `09199db96f4824df4f53e83b72dd7c14b4a827c9`. The required peeled
   `v0.39.0` commit is `1b1913b0ded829e529f7f45a2657c100755900f5`. The
   annotated-tag metadata bug was corrected and reviewed in the benchmark
   implementation ticket after this run. The installation/ref content remained
   correct, and the completed samples remain valid per the ticket. Per
   instruction, they were retained and not rerun; the metadata incident is
   documented separately from timing failures below.
3. The original exact checkout command (with the unused upgrade flag) failed
   argument validation before creating a workspace:
   `--upgrade-from is only valid when --scenarios is all`. It produced no
   performance sample and required no cleanup.
4. The corrected checkout cold command completed one ready sample. Its
   comparison is explicitly limited: it uses the current, dirty local
   support-file checkout rather than an identical released-installer A/B.

The benchmark reported no failed samples or readiness failures in the 12
remote samples or the one checkout sample. Successful runs completed their
owned temporary-root cleanup; no bounded leftovers were reported. If a run is
interrupted before cleanup, inspect the system temp directory and remove only
benchmark-owned directories whose names begin with
`tlh-installer-performance-`, after confirming ownership. The benchmark also
terminates registered child process trees on failure, timeout, and signal.

## Results

Observed environment for both successful runs: `darwin/arm64`, Node `26.8.1`,
npm `11.19.0`, and Pi `0.85.1`. Neither successful benchmark made a model/API
request. The selected package pin transition was `anthropic-auth 2.0.3` ->
`2.0.8`.

The pre-fix remote result field reported support-code revision
`a17d7346bf0d0ede0bdc330d7801949634faec44`, which is the annotated
`v0.40.0` tag object rather than its commit. The actual v0.40.0
support/package content was the peeled commit
`f7bfee92e0e56b28b325fdd1e455fe5affe5040c`; corrected metadata now resolves
v0.40.0 to that peeled commit for future runs. The pre-fix v0.39.0 field
reported tag object `09199db96f4824df4f53e83b72dd7c14b4a827c9`; its required
peeled commit is `1b1913b0ded829e529f7f45a2657c100755900f5` as noted above.

The three values in each samples column are run 1, run 2, and run 3. All
values are milliseconds. Summary values are median, mean, and min-max range.

### Remote: 3 runs per scenario

| Scenario and cache condition | Installer samples | First usable launch samples | Summary; readiness |
| --- | ---: | ---: | --- |
| `cold-cache-fresh`; new npm cache per sample | 31671.1 / 24890.2 / 25666.3 | 1653.4 / 1583.3 / 1628.4 | Installer median 25666.3, mean 27409.2, range 24890.2-31671.1; launch median 1628.4, mean 1621.7, range 1583.3-1653.4; 3/3 ready |
| `warm-cache-fresh`; copied cache from a fully launched seed | 18404.0 / 17128.2 / 18013.3 | 1666.2 / 1650.3 / 1740.4 | Installer median 18013.3, mean 17848.5, range 17128.2-18404.0; launch median 1666.2, mean 1685.6, range 1650.3-1740.4; 3/3 ready |
| `unchanged-reinstall`; existing fully launched profile and cache | 2677.4 / 2480.7 / 4097.6 | 662.7 / 607.9 / 819.5 | Installer median 2677.4, mean 3085.2, range 2480.7-4097.6; launch median 662.7, mean 696.7, range 607.9-819.5; 3/3 ready |
| `changed-pin-upgrade`; existing fully launched old-ref profile and cache | 16202.6 / 16291.0 / 14768.5 | 21633.8 / 21908.5 / 23474.0 | Installer median 16202.6, mean 15754.0, range 14768.5-16291.0; launch median 21908.5, mean 22338.8, range 21633.8-23474.0; 3/3 ready |

Across all 12 remote samples, the benchmark printed an installer median of
`16709.6ms` and a first-usable-launch median of `1651.8ms`. The phase medians
were approximate progress observations:

| Phase | Median |
| --- | ---: |
| bootstrap | 649.1ms |
| runtime | 5166.6ms |
| package reconciliation | 9031.4ms |
| defaults | 2683.6ms |
| managed tools | unavailable |
| wrapper | 28.8ms |

### Checkout: one limited cold comparison

| Scenario and cache condition | Installer | First usable launch | Readiness |
| --- | ---: | ---: | --- |
| `cold-cache-fresh`; new npm cache | 31305.8ms | 1660.8ms | ready |

The checkout selected ref resolved to
`f7bfee92e0e56b28b325fdd1e455fe5affe5040c`, with support-code revision
`73f501666f1b6f4de0b4dca88e693da9dad33286`. The worktree was dirty because
benchmark implementation changes were already present, so this is not an
identical released-installer A/B comparison. Its approximate phase timings
were bootstrap `88.5ms`, runtime `5887.0ms`, package reconciliation
`14914.4ms`, defaults `10384.7ms`, managed tools unavailable, and wrapper
`28.5ms`.

## Follow-up ranking

Rank **#631 before #630** for the next measured investigation. The
`changed-pin-upgrade` first usable launch is the clear outlier at a median of
`21908.5ms` (mean `22338.8ms`), versus `1628.4ms` cold-cache fresh,
`1666.2ms` warm-cache fresh, and `662.7ms` unchanged reinstall. Its installer
median is also `16202.6ms`. This is a prioritization based on the observed
outlier only; no optimization was implemented by this baseline ticket.

## Limits

Results are single-machine observations, not pass/fail budgets. Network
latency, registry availability, remote GitHub content, npm cache state, disk
load, PTY behavior, and other machine load can change timings. The checkout
sample additionally reflects the current local support files and must not be
presented as a released-installer A/B comparison. Repeat the exact commands
when a new baseline is needed rather than comparing samples across machines
without recording environment, refs, cache conditions, and phase availability.
