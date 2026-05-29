# Embedded default extension pilot

Pilot goal: cut TLH install/update time without changing opt-out semantics or bundling higher-risk defaults.

As of the second pass, TLH embeds these seven low-risk defaults in the main package:

- `openai-fast` (`@diegopetrucci/pi-openai-fast@0.1.2`)
- `inline-bash` (`@diegopetrucci/pi-inline-bash@0.1.1`)
- `notify` (`@diegopetrucci/pi-notify@0.1.4`)
- `context-cap` (`@diegopetrucci/pi-context-cap@0.1.1`)
- `confirm-destructive` (`@diegopetrucci/pi-confirm-destructive@0.1.2`)
- `quiet-tools` (`@diegopetrucci/pi-quiet-tools@0.1.2`)
- `dirty-repo-guard` (`@diegopetrucci/pi-dirty-repo-guard@0.1.1`)

## Benchmark takeaway

From Gnosis entry `ukmwpd`:

- Current bundled default-extension install cost was about **19.5s fresh / 7.5s warm**.
- An empty default-extension manifest proxy was about **1.5s fresh / 1.5s warm**.
- Repointing defaults at already-installed local package dirs was still about **4.5s fresh / 4.2s warm**.

Conclusion: most overhead is separate default-extension acquisition/update work, so a small embedded pilot is worth trying.

## First-pass pilot set

The initial batch embedded these five non-critical, small, no-extra-package-dependency defaults:

1. `confirm-destructive`
2. `dirty-repo-guard`
3. `inline-bash`
4. `context-cap`
5. `notify`

Do **not** include dependency-heavy or higher-risk defaults in this pilot (`plannotator`, `fff`, `pi-web-access`, `rtk`, etc.), and do **not** embed critical defaults (`subagents`, `intercom`).

## Proposed mechanism

- Keep `config/default-extensions.json` as the control-plane manifest for default IDs, descriptions, and upstream provenance.
- Add embedded metadata for embedded IDs (`embeddedEntry`, `embeddedVersion`) so installer/defaults tooling can distinguish embedded defaults from separately installed package sources.
- Vendor each embedded extension under a TLH-owned layout such as `extensions/embedded-defaults/<id>/index.ts`.
- Load embedded defaults from the main TLH package instead of adding one separate package source per embedded default to `settings.packages`.

## Preserving opt-outs and idempotency

- Keep `tlh defaults disable <id>` and `tlh.disabledDefaultExtensions` as the source of truth.
- For embedded IDs, disable by adding an exact TLH package extension filter like `-extensions/embedded-defaults/<id>/index.ts` on the TLH package entry instead of removing a separate package source.
- Re-enable by removing that exact exclusion.
- Canonicalize filter order and dedupe exclusions so installer reruns stay idempotent.
- Preserve unrelated user-owned package fields/filters on the TLH package entry; only touch the embedded-default exclusion paths.
- If no embedded-default exclusions remain and no object wrapper is otherwise needed, collapse the TLH package entry back to its plain string form to avoid settings churn.

## Update cadence expectation

- Embedded defaults update on the **TLH release cadence**, not their old per-package cadence.
- `tlh update` refreshes them indirectly by updating TLH itself.
- `pi update --extensions` no longer needs to fetch/update these embedded defaults separately.
- These IDs are TLH package resources now, not separate default package sources to preserve across merges.
- Keep the manifest/documentation pointing at the upstream source/version used to vendor each embedded copy so release bumps remain reviewable.

## First-pass benchmark results

- Normal installer temp-dir reruns after embedding the first five defaults measured **17.48s fresh / 6.97s warm**.
- Versus the pre-pilot normal baseline (**19.5s fresh / 7.5s warm**), that was about **2.02s faster fresh** and **0.53s faster warm**.
- The empty-manifest upper bound is still much lower at **1.5s fresh / 1.5s warm**, so the first pass only recovered part of the separate default-extension overhead.
- In `--dev-install-timings` confirmation runs, the per-source bundled default-extension table no longer listed `inline-bash`, `notify`, `context-cap`, `confirm-destructive`, or `dirty-repo-guard`.
- Treat timing-mode totals as confirmatory only: enabling per-source profiling changes installer behavior slightly, so the authoritative numbers above were the normal installer timings.

## 2026-05 next-candidate audit

Audit inputs: `config/default-extensions.json`, `npm view`, and `npm pack` tarball inspection for the currently referenced package sources.

| ID | Current package | Size / shape | Dependency footprint | Runtime assets / behavior | Aliases / replacements | Update-cadence risk | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `openai-fast` | `@diegopetrucci/pi-openai-fast@0.1.2` | 3.9 KB tgz / 11.7 KB unpacked, 5 files, 302-line `index.ts` | No direct deps; peer `@earendil-works/pi-coding-agent` only (already in TLH) | Bundles one optional `openai-fast.example.json`; otherwise single-file logic that reads config and injects `service_tier=priority` for eligible OpenAI Codex OAuth sessions. No subprocesses or temp assets. | None in `config/default-extensions.json` | **Low-medium**: model/API allowlist can age, but breakage is isolated and easy to reason about. | **Embed** |
| `oracle` | `@diegopetrucci/pi-oracle@0.1.10` | 13.2 KB tgz / 47.9 KB unpacked, 4 files, 1,284-line `index.ts` | No direct deps, but peers include `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`; embedding would widen TLH's effective peer/runtime surface | Single-file package, but runtime behavior is heavy: spawns an oracle subprocess, persists `oracle.json`, maintains a large provider/model preference table, and renders UI status/widgets. Optional read-only bash path adds more moving parts. | None | **High**: six publishes between 2026-04-18 and 2026-05-28, with provider/model table churn likely to keep happening. | **Exclude for now** |
| `librarian` | `@diegopetrucci/pi-librarian@0.1.3` | 12.1 KB tgz / 37.8 KB unpacked, 4 files, 857-line `index.ts` | No direct deps, but peers include `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`; `typebox` is extra surface for TLH | No packaged assets, but runtime creates agent sessions and temp workspaces, manages an optional 7-day checkout cache, shells out through guarded `bash`, and relies on `gh`/`git` flows. | None | **High**: four publishes between 2026-05-10 and 2026-05-28, plus ongoing external-tool/cache-policy churn. | **Exclude for now** |
| `context-inspector` | `@diegopetrucci/pi-context-inspector@0.1.1` | 16.2 KB tgz / 58.3 KB unpacked, 4 files, 1,485-line `index.ts` | No direct deps; peer `@earendil-works/pi-coding-agent` only (already in TLH) | No packaged static files, but the extension inlines a full HTML/CSS/JS dashboard inside `index.ts`, writes temp HTML files with locked-down perms, and tries `open` / `xdg-open` at runtime. | None | **Medium-high**: only two publishes so far, but the token-attribution/dashboard logic is tightly coupled to upstream transcript/tool-schema shapes and is likely to need fast follow-ups. | **Exclude for now** |
| `quiet-tools` | `@diegopetrucci/pi-quiet-tools@0.1.2` | 4.7 KB tgz / 15.5 KB unpacked, 4 files, 371-line `index.ts` | No direct deps; peers `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` only (already in TLH) | Single-file renderer wrapper; no extra assets, temp files, or subprocesses. Rebuilds built-in tool definitions and swaps in quieter collapsed renderers without changing model-visible tool results. | Alias `compact-bash`; replaces `npm:@diegopetrucci/pi-compact-bash` | **Low-medium**: UI-render coupling still needs TLH release follow-through, but the package is small and behavior is localized. | **Embed** |

## Second-pass embed set

The approved second batch embedded these two additional defaults:

1. `openai-fast` (`@diegopetrucci/pi-openai-fast@0.1.2`)
2. `quiet-tools` (`@diegopetrucci/pi-quiet-tools@0.1.2`)

## Explicit exclusions for this batch

- `oracle` — too much provider/model churn and subprocess/UI surface for TLH-release-cadence embedding.
- `librarian` — external `gh`/`git` behavior, cache management, and guarded shell flows are still better updated independently.
- `context-inspector` — self-contained, but large and dashboard-heavy enough that separate package updates are safer while its transcript/token accounting logic is still settling.

## Second-pass benchmark methodology

- Normal installer timings are authoritative; `--dev-install-timings` runs are confirmatory only because they swap the normal settings-wide refresh for per-source profiling.
- Fresh timings used a new temp `--agent-dir` and `--bin-dir` with `TLH_PACKAGE_SOURCE="$PWD" bash install.sh --quiet ...`.
- Warm timings immediately reran the same command against the same temp dirs.
- Normal timings were collected by timing `bash install.sh` externally from a local `node` wrapper so the installer path stayed unchanged.
- Three fresh/warm cycles were recorded on the same development machine. These runs used fresh TLH profile/wrapper dirs, but they did **not** clear host-level npm/Pi/git caches between runs.

## Second-pass benchmark results

Authoritative normal installer timings after embedding `openai-fast` and `quiet-tools`:

- Run 1: **16.26s fresh / 6.86s warm**
- Run 2: **12.87s fresh / 6.52s warm**
- Run 3: **11.30s fresh / 6.86s warm**
- Mean: **13.48s fresh / 6.74s warm**

Impact relative to earlier checkpoints:

- Versus the first-pass embedded baseline (**17.48s fresh / 6.97s warm**), the three-run mean was about **4.00s faster fresh** and **0.23s faster warm**.
- Versus the pre-pilot baseline (**19.5s fresh / 7.5s warm**), the three-run mean was about **6.02s faster fresh** and **0.76s faster warm**.
- Fresh results varied more than warm results because temp-dir freshness does not reset host-level package caches.

Confirmatory `--dev-install-timings` runs measured **35.1s fresh / 10.9s warm** and no longer listed `openai-fast` or `quiet-tools` in the bundled default-extension per-source table. After the second pass, that table showed only 12 separately refreshed bundled sources: `oracle`, `plannotator`, `anthropic-auth`, `librarian`, `mcporter`, `pi-web-access`, `fff`, `context-inspector`, `rtk`, `triage-comments`, `subagents`, and `intercom`.

## Residual risks

- The normal fresh timing here is a fresh-profile measurement, not a cold-host measurement; npm/Pi/git cache state and network conditions can still move the number noticeably.
- `openai-fast` now rides TLH release cadence, so future upstream model/API allowlist changes need a TLH release instead of an independent package refresh.
- `quiet-tools` now rides TLH release cadence too; if upstream TUI renderer internals shift, TLH must ship the compatibility update.
- Most remaining installer cost now sits in the non-embedded/heavier defaults and the critical TLH forks, so any further speed wins will likely come with higher maintenance or correctness risk.

## Commands used for this pass

```sh
node scripts/merge-settings.mjs config/settings.defaults.json \
  --settings "$(mktemp -d)/settings.json" \
  --default-extensions config/default-extensions.json \
  --dry-run

node scripts/tlh-defaults.mjs \
  --settings "$(mktemp -d)/settings.json" \
  --defaults config/default-extensions.json \
  list

# Authoritative normal timings were collected by timing this command externally
# across three fresh/warm temp-dir cycles:
TLH_PACKAGE_SOURCE="$PWD" bash install.sh \
  --quiet \
  --agent-dir "$agent_dir" \
  --bin-dir "$bin_dir"

# Confirmatory per-source profiling:
TLH_PACKAGE_SOURCE="$PWD" bash install.sh \
  --dev-install-timings \
  --quiet \
  --agent-dir "$agent_dir" \
  --bin-dir "$bin_dir"
```