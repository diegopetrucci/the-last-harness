# Embedded default extension pilot

Pilot goal: cut TLH install/update time without changing opt-out semantics or bundling higher-risk defaults.

## Benchmark takeaway

From Gnosis entry `ukmwpd`:

- Current bundled default-extension install cost was about **19.5s fresh / 7.5s warm**.
- An empty default-extension manifest proxy was about **1.5s fresh / 1.5s warm**.
- Repointing defaults at already-installed local package dirs was still about **4.5s fresh / 4.2s warm**.

Conclusion: most overhead is separate default-extension acquisition/update work, so a small embedded pilot is worth trying.

## Five pilot candidates

Embed only these five non-critical, small, no-extra-package-dependency defaults:

1. `confirm-destructive` — self-contained safety rail; no aliases, replacements, or critical-install requirements.
2. `dirty-repo-guard` — self-contained repo-state prompt; no aliases, replacements, or critical-install requirements.
3. `inline-bash` — self-contained prompt preprocessor; no aliases, replacements, or critical-install requirements.
4. `context-cap` — tiny self-contained context guard; no aliases, replacements, or critical-install requirements.
5. `notify` — self-contained turn-end notifier; no aliases, replacements, or critical-install requirements.

Do **not** include dependency-heavy or higher-risk defaults in this pilot (`plannotator`, `fff`, `pi-web-access`, `rtk`, etc.), and do **not** embed critical defaults (`subagents`, `intercom`).

## Proposed mechanism

- Keep `config/default-extensions.json` as the control-plane manifest for default IDs, descriptions, and upstream provenance.
- Add embedded metadata for the five pilot IDs in a follow-up implementation (for example an `embeddedEntry` path) so installer/defaults tooling can distinguish embedded defaults from separately installed package sources.
- Vendor each embedded extension under a TLH-owned layout such as:
  - `extensions/embedded-defaults/<id>/index.ts`
  - optional helper files under the same directory
- Load embedded defaults from the main TLH package instead of adding five separate package sources to `settings.packages`.

## Preserving opt-outs and idempotency

- Keep `tlh defaults disable <id>` and `tlh.disabledDefaultExtensions` as the source of truth.
- For embedded IDs, disable by adding an exact TLH package extension filter like `-extensions/embedded-defaults/<id>/index.ts` on the TLH package entry instead of removing a separate package source.
- Re-enable by removing that exact exclusion.
- Canonicalize filter order and dedupe exclusions so installer reruns stay idempotent.
- Preserve unrelated user-owned package fields/filters on the TLH package entry; only touch the embedded-default exclusion paths.
- If no embedded-default exclusions remain and no object wrapper is otherwise needed, collapse the TLH package entry back to its plain string form to avoid settings churn.

## Update cadence expectation

- Embedded pilot defaults update on the **TLH release cadence**, not their old per-package cadence.
- `tlh update` refreshes them indirectly by updating TLH itself.
- `pi update --extensions` no longer needs to fetch/update these five separately.
- These five are TLH package resources now, not separate default package sources to preserve across merges.
- Keep the manifest/documentation pointing at the upstream source/version used to vendor each embedded copy so release bumps remain reviewable.

## Post-pilot benchmark results

- Normal installer temp-dir reruns after embedding the five pilot defaults measured **17.48s fresh / 6.97s warm**.
- Versus the pre-pilot normal baseline (**19.5s fresh / 7.5s warm**), that is about **2.02s faster fresh** and **0.53s faster warm**.
- The empty-manifest upper bound is still much lower at **1.5s fresh / 1.5s warm**, so this pilot only recovers part of the separate default-extension overhead.
- In `--dev-install-timings` confirmation runs, the per-source bundled default-extension package/timing table no longer listed `inline-bash`, `notify`, `context-cap`, `confirm-destructive`, or `dirty-repo-guard`; those five still keep manifest provenance metadata, but they no longer appear as separate default-extension package sources during install.
- Treat timing-mode totals as confirmatory only: enabling per-source profiling changes installer behavior slightly, so the authoritative post-pilot numbers above are the normal installer timings.

## Focused future validation / benchmark commands

```sh
node scripts/merge-settings.mjs config/settings.defaults.json \
  --settings "$(mktemp -d)/settings.json" \
  --default-extensions config/default-extensions.json \
  --dry-run

node scripts/tlh-defaults.mjs \
  --settings "$(mktemp -d)/settings.json" \
  --defaults config/default-extensions.json \
  list

agent_dir="$(mktemp -d)/agent"
bin_dir="$(mktemp -d)/bin"
TLH_PACKAGE_SOURCE="$PWD" bash install.sh \
  --dev-install-timings \
  --quiet \
  --agent-dir "$agent_dir" \
  --bin-dir "$bin_dir"
TLH_PACKAGE_SOURCE="$PWD" bash install.sh \
  --dev-install-timings \
  --quiet \
  --agent-dir "$agent_dir" \
  --bin-dir "$bin_dir"
rm -rf "$agent_dir" "$bin_dir"
```
