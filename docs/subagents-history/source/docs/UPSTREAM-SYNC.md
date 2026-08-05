> **Historical document.** The intake-based sync model described here was retired on 2026-08-03. Upstream is now monitored only as a source of bug fixes and feature ideas; adoption is selective and per-change. See the _Fork Sync Policy_ section of `AGENTS.md` for the current approach.

# Upstream Sync Playbook (non-rebase model)

This document described how the fork
(`diegopetrucci/pi-subagents`, hereafter "the fork") was intended to integrate
changes from `nicobailon/pi-subagents` (hereafter "upstream") under the
now-retired intake-based sync model. It was a design/spec doc: the ledger,
patch inventory, and reporting helper it defined were implemented by separate
tickets (`ps-a10f`, `ps-f6se`, `ps-cjog`).

**This doc is now historical.** Current governing policy is in `AGENTS.md`
(Fork Sync Policy section). The still-correct point preserved here is that the
fork does not use a perpetual rebase of TLH deltas on top of `upstream/main`;
that model was explicitly rejected and remains rejected.

## 1. Intake unit: release/tag or feature cluster, never a single commit

The unit of upstream integration is one of:

- an upstream **release/tag** (e.g. `v0.32.0`), or
- a **coherent feature cluster** — a set of upstream commits that implement
  one feature or fix and depend on each other, even if it doesn't line up
  with a tagged release.

Per-commit (per-SHA) triage is explicitly rejected as a workflow. Reasons:

- Upstream regularly ships **coupled commits** (e.g. a refactor commit
  followed by commits that depend on it). Evaluating and merging commits one
  at a time risks adopting a commit whose prerequisite was skipped, silently
  breaking the fork.
- Per-commit triage queues rot into a **pending graveyard**: an ever-growing
  backlog of "still need to look at this" commits that never gets resolved,
  because there's no natural batch boundary to declare "done."
- A release or feature cluster gives a natural, auditable boundary: "as of
  intake X, the fork is caught up to upstream Y except for the recorded
  exceptions."

## 2. Integration mechanism: explicit merge/squash-import PRs, never perpetual rebase

Each intake (release or feature cluster) is integrated via one of:

- an explicit **merge PR** (`git merge upstream/main` or a specific upstream
  tag/branch into a fork integration branch, opened as a PR against the
  fork's `main`), or
- a **squash-import PR** (upstream range squashed into one or a small number
  of commits, applied on top of the fork, opened as a PR).

The fork's history is **never** repeatedly rebased onto `upstream/main`. The
maintainer has explicitly rejected the rebase-on-top model: it rewrites
fork-only commit SHAs on every sync, breaks any external references to those
SHAs (tags, ledger rows, patch-id history), and turns every sync into a
force-push. Do not reintroduce it in this doc, in `AGENTS.md`, or in tooling.

Each intake produces:

- one PR (merge or squash-import) into the fork's `main`,
- one ledger entry (see §3) recording what was adopted and what was rejected,
- updates to the patch inventory (see §4) if the intake required re-adapting
  any TLH-only delta.

### Release identity

- Never adopt upstream release identity: `package.json` `name` stays
  `@diegopetrucci/pi-subagents`; `version` is set by TLH release decisions,
  never taken from upstream version bumps.
- `package-lock.json`: regenerate via `npm install` against the resolved
  `package.json`; never hand-merge it.
- Upstream `v*` tags: keep locally as intake anchors (they are the ledger's
  `upstream_ref` and the merge target) but never push them to `origin`. Fork
  releases use `tlh-v*` tags.
- `CHANGELOG.md` conflicts: keep **both** sides — upstream sections document
  adopted content; TLH release entries stay.
- GitHub release notes are triage-only input; nothing in them is adopted or
  tracked directly.

## 3. Exception-only ledger

**Path:** `.upstream-ledger.jsonl` (repo root)

**Format:** JSONL (one JSON object per line), append-only (newest entries at
the bottom), one entry per **intake**, not per commit. JSONL was chosen over
a markdown table for consistency with `.gnosis/entries.jsonl` (this repo's
other append-only log) and because it's:

- **append-only friendly** — new entries are pure line additions, so two
  concurrent intakes touching the ledger essentially never produce a real
  merge conflict, unlike a markdown table where adjacent rows fight over
  shared separator lines;
- **machine-readable** — `scripts/upstream-report.sh` or future tooling can
  parse the ledger directly with `jq` (which handles newline-delimited JSON
  natively, e.g. `jq -s '.' .upstream-ledger.jsonl` or plain `jq .`) and/or
  a per-line `python3` loop, without scraping a markdown table;
- **still human-reviewable** — each line is a self-contained, greppable
  record, and a PR diff for a new intake is exactly one added line.

Field schema (each line is one JSON object with these fields):

| Field | Meaning |
| --- | --- |
| `date` | ISO date the intake was integrated (`YYYY-MM-DD`). |
| `upstream_ref` | The upstream tag or commit range covered by this intake (e.g. `v0.34.0`, or `abc123..def456` for a feature cluster with no tag), including any relevant ahead/behind or version detail. |
| `intake_type` | `release`, `cluster`, or `hotfix`. |
| `integration_pr` | Link/number of the fork PR that performed the merge or squash-import. |
| `status` | `adopted`, `adopted-with-exceptions`, `rejected`, or `baseline`. `baseline` is a one-time starting-point marker recorded when this workflow was introduced; it does **not** assert that any upstream range has been adopted, and the upstream backlog it references remains **unreviewed** until real intake entries record adoption. |
| `exceptions` | Array of excluded commits/files/behaviors, empty (`[]`) if `adopted`. Each item is an object `{"ref": "<upstream-sha-or-area>", "reason": "..."}`. |
| `notes` | Free text for high-risk decisions, follow-ups, or context a future maintainer needs. |

Example line:

```
{"date":"2026-08-01","upstream_ref":"v0.34.0","intake_type":"release","integration_pr":"#123","status":"adopted-with-exceptions","exceptions":[{"ref":"a1b2c3d (spawn via ambient PATH)","reason":"conflicts with TLH pi-spawn.ts resolved-parent-runtime behavior"},{"ref":"f00d1e (telemetry opt-out default flip)","reason":"rejected, changes TLH default UX"}],"notes":"Re-verify pi-spawn.ts behavior next release"}
```

The ledger records **only**:

- one entry per intake baseline (what upstream state the fork is caught up to),
- explicit **rejections** (commits/behaviors deliberately not adopted),
- high-risk decisions worth a permanent record.

It does **not** record routine, uneventful commit-by-commit adoption. If an
intake was adopted cleanly with no exceptions, it still gets exactly one
entry/line with `status = "adopted"` and an empty `exceptions` array — this
is what lets readers confirm the fork's sync history is complete without a
graveyard of noise. Because it's JSONL, the file itself cannot carry an
explanatory preamble (a non-JSON comment line would break parsing); that
guidance lives here in `UPSTREAM-SYNC.md` instead.

A `baseline` entry must never be read as adoption of its `upstream_ref`;
only merge/squash-import intake entries assert adoption.

## 4. TLH patch inventory

**Path:** `docs/tlh-patch-inventory.md`

**Format:** a single markdown table, one row per deliberate fork-only delta
(a piece of behavior that intentionally diverges from upstream and must
survive every future intake).

Columns:

| Column | Meaning |
| --- | --- |
| `Delta` | Short name for the deliberate fork behavior (e.g. "resolved parent/private Pi runtime for child spawn"). |
| `Why` | One or two sentences on why the fork needs this and upstream doesn't have it. |
| `Key files` | Path(s) implementing the delta (e.g. `src/runs/shared/pi-spawn.ts`). |
| `Tests` | Path(s) of focused tests covering the delta (e.g. `test/unit/pi-spawn.test.ts`). |
| `Re-verify on intake?` | `yes` if every intake must manually re-check this delta still holds (e.g. because it touches an area upstream also changes often), `no` if it's isolated/stable. |

This table is the checklist a maintainer walks through after any merge or
squash-import PR to confirm no deliberate fork behavior was silently
overwritten by the incoming upstream changes. It is expected to start with
at least the `pi-spawn.ts` delta already documented in `AGENTS.md`.

## 5. `git cherry` / `git patch-id`: signal only, never source of truth

`git cherry` and `git patch-id` (and any reporting helper built on them, see
§7) may be used to **estimate** which upstream commits already have an
equivalent applied in the fork. They must never be treated as an adoption
invariant or as proof that a commit has (or hasn't) been integrated.

Reason: `patch-id` matching breaks down in exactly the cases that matter most
for a real fork:

- **Squashed** upstream commits (or fork-side squash-imports) produce a diff
  that doesn't patch-id-match any single upstream commit.
- **Split** commits (one upstream commit re-applied as several fork commits,
  or vice versa) don't match either.
- **Conflict-edited** cherry-picks — the normal case whenever a cherry-pick
  needed manual conflict resolution — produce a different diff and therefore
  a different patch-id, even though the change was genuinely adopted.
- **Refactored** cherry-picks (adapted to fit fork-specific code shape, e.g.
  around the `pi-spawn.ts` delta) likewise don't match.

The **git DAG is authoritative**: a commit is considered adopted if and only
if the corresponding change history says so — i.e. it's reachable via the
fork's merge/squash-import PR history and recorded (or intentionally omitted
as an exception) in `.upstream-ledger.jsonl`. Any disagreement between a
patch-id/`git cherry` signal and the ledger/DAG is resolved in favor of the
ledger/DAG, always.

## 6. Cherry-pick: reserved for urgent hotfixes between intakes

Individual `git cherry-pick`s from upstream are permitted **only** for
urgent, isolated hotfixes needed before the next scheduled intake (e.g. a
security fix or a crash fix that can't wait). Every such cherry-pick must:

- be genuinely isolated (not part of a larger coupled feature cluster —
  otherwise it belongs in the next intake instead), and
- get a ledger entry (`.upstream-ledger.jsonl`) with `intake_type` set
  to `hotfix`, and the `notes` field explaining the urgency and that it will
  be superseded/reconciled by the next full intake covering that commit's
  range.

Cherry-pick is not a substitute for the intake workflow in §1–§2. It exists
purely to bridge urgent fixes across the gap between scheduled intakes.

## 7. Reporting helper (non-authoritative)

`scripts/upstream-report.*` (built in `ps-cjog`) is a read-only reporting
tool. It prints, for operator awareness only:

- ahead/behind commit counts between the fork's `main` and `upstream/main`,
- the latest upstream version/tag seen,
- a `git cherry`/`patch-id` based signal of which upstream commits look
  already-applied.

Its output is a **hint to a human deciding when to schedule the next
intake**, and nothing else. Per §5, its cherry/patch-id signal must never be
used to mark a commit as adopted, to skip ledger bookkeeping, or to justify
skipping review of a commit during an intake. The ledger and the git DAG
always win over this tool's output.
