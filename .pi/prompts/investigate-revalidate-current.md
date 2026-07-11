---
description: Investigate recent issues, cluster findings, and revalidate each claim against current states
argument-hint: "[scope or time window override, optional]"
---
Investigate recent issues within the requested scope. If no time window is provided, default to the past 14 days.

Investigation-only defaults:

- Do not make code, config, ticket, or release changes.
- Prefer read-only inspection, targeted searches, and concise evidence capture.
- Treat unverified prior claims as hypotheses until revalidated.
- If the requested scope is ambiguous, state the assumption you used.

Recent issue discovery:

1. Identify recent issues, regressions, failures, review findings, support reports, changelog items, commits, tickets, session notes, or local artifacts from the past 14 days unless the caller overrides the window.
2. Cluster related findings by theme, symptom, or affected surface area.
3. For each cluster, extract the concrete claim to revalidate and note the original evidence source.

Revalidate every claim against current state as relevant:

1. Current checkout: inspect the working tree and current branch contents.
2. `origin/main`: compare whether the claim still reproduces or has already been fixed upstream.
3. Latest release: check whether the latest released version still contains the issue or behavior.
4. Installed/runtime state: when relevant, inspect the locally installed profile, generated artifacts, wrappers, or runtime behavior without making persistent changes.
5. If a source is unavailable, say so explicitly and continue with the sources you can verify.

Classification outcomes for each claim:

- confirmed-current: reproducible or still true in the current checkout.
- confirmed-upstream-only: present on `origin/main` or latest release but not in the current checkout.
- fixed-current: previously reported, now resolved in the current checkout.
- fixed-everywhere: resolved in current checkout, `origin/main`, and latest release or installed/runtime state as relevant.
- not-reproducible: insufficient evidence or unable to reproduce after revalidation.
- needs-follow-up: partially validated, blocked by environment gaps, or needs a narrower reproduction path.

Evidence expectations:

- Cite exact files, commands, diffs, versions, release tags, timestamps, or runtime observations used for revalidation.
- Separate historical evidence from current verification.
- Call out assumptions, environment limitations, and any mismatch between source, release, and installed/runtime state.
- Keep notes concise, but include enough detail for an independent reviewer to repeat the checks.

Output format:

- Scope used: requested scope and effective time window.
- Cluster summary: short bullet list of the grouped findings.
- Revalidation results: one subsection per claim with status, evidence, and any delta across current checkout, `origin/main`, latest release, and installed/runtime state.
- Follow-ups: brief list of unresolved items, if any.
