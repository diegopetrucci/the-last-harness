# Acceptance-report false negative: evidence destroyed, reason withheld (2026-08-20)

Status: **investigated, not fixed.** Written for pickup.

A `developer` subagent completed a 45-minute task correctly, emitted a complete
acceptance report, and was rejected. The supervisor was shown a 3-byte output
artifact and the bare string `acceptance: rejected`, with no reason. Every piece
of evidence needed to diagnose it was computed by the runtime and then discarded
before reaching the supervisor.

The proximate trigger was one invalid enum value written by the child. The
interesting part is what the runtime did with it: the harness turned a
recoverable "your report has a typo" into an unexplained rejection with the
evidence deleted.

Two independent defects, one contributing factor. All three are in scope for a
fix; **D1 and D2 are the real bugs.**

---

## 1. TL;DR

The child's final message was `---` followed by a fenced ` ```acceptance-report `
JSON block. In that JSON:

```json
{
  "command": ".scripts/test-package Numan (with seeding line REMOVED — failure proof)",
  "result": "failed as expected",
  "summary": "..."
}
```

`commandsRun[].result` is a closed enum: `"passed" | "failed" | "not-run"`.
`"failed as expected"` fails validation. From that single string:

| # | Defect | Effect |
|---|--------|--------|
| **D1** | `stripAcceptanceReport()` removes the fence by regex with **no validation**, but the compensating digest is appended **only if the report validated**. | Report present-but-invalid ⇒ block deleted, nothing put back. Artifact collapsed to 3 bytes. |
| **D2** | `childReportParseError` is written to `status.json` but **never rendered** into the supervisor-facing status summary. | Supervisor saw `acceptance: rejected` with no reason. |
| **C3** | Child wrote zero prose — only `---` + the fenced block. | Nothing survived D1's strip. Contributing, not causal. |

Net result: a **false negative**. The work was correct and is intact in the
worktree. The supervisor spent a full re-verification cycle (re-reading the diff,
re-running the package test suite) rebuilding evidence the child had already
produced and the runtime had already parsed.

**This is not a one-off.** A historical scan (§6) found that **9 of 11 observable
acceptance rejections were report-parse failures rather than rejections on the
merits**, 6 of them the identical `commandsRun[].result` enum violation. Three
rejected runs had *passing* work. Treat the severity accordingly: the acceptance
gate is currently rejecting mostly-correct work most of the time it fires.

---

## 2. What the supervisor actually experienced

Session: `tlh-main`, working in `~/Developer/ios-armadillo` on branch
`fix-launch-screen-flash`, ticket `ia-z6ai`.

The async status surface reported:

```
Step 1: developer complete (claude-sonnet-4-6 · thinking medium), acceptance: rejected
  Exit code: 0
  Cleanup: The owned child process group had no live processes to clean up.
```

That is the *entire* signal. No criterion name, no parse error, no hint that a
report existed at all. The architect then read the output artifact and found
three bytes.

Its reasoning, verbatim from the session transcript:

> The output artifact is empty, which explains the rejection, but the worktree
> itself looks correct — the reducer diff is clean, the temp comment is gone, and
> the test file was modified with no stray files left behind. Since I can't trust
> a missing report, I should verify the new tests myself by checking the diff and
> actually running them.

It reached the right conclusion by the expensive route, and recorded a partly
wrong diagnosis — it inferred "the harness wrote the artifact empty," which
mislabels the cause (the harness *stripped a present-but-invalid* report) and
misses D2 entirely. It then told the human:

> Ignore it — the output artifact was written empty by the harness while the full
> JSON report sat in the run log. A reporting glitch, not a work problem.

That is the failure mode that matters: **the harness taught a supervisor to
distrust its own acceptance gate.** A gate that misfires without explanation
trains its consumer to route around it.

---

## 3. Root cause chain

### 3.1 The enum rejection

(Consumption analysis in §8 — the short version is that this field is
display-only and is never branched on.)

`extensions/subagents/src/runs/shared/acceptance.ts:1046-1057`

```ts
if (
  command.result !== "passed" &&
  command.result !== "failed" &&
  command.result !== "not-run"
) {
  pushTypeError(
    errors,
    `${itemPath}.result`,
    'one of "passed", "failed", "not-run"',
    command.result,
  );
}
```

`validateAcceptanceReport()` (`:980`) collects the error, so
`parseAcceptanceReport()` (`:822`) returns `{ error }` with **no** `report`.

Worth noting *why* the child tripped on this: the task explicitly asked it to
prove the new tests were falsifiable by deleting the production line and
observing failure. So it had a command whose expected outcome was failure, and
`"failed"` alone reads as "something went wrong." `"failed as expected"` was a
reasonable attempt to express intent in a field with no room for it. The schema
has no vocabulary for an intentional negative control.

### 3.2 D1 — strip-vs-append asymmetry

`extensions/subagents/src/runs/shared/acceptance.ts:870-893`

```ts
export function stripAcceptanceReport(output: string): string {
  ...
  if (trailingFence) {
    if (trailingFence.tag === "acceptance-report")
      return output.slice(0, trailingFence.index).trimEnd();   // ← unconditional
    try {
      if (parseGenericJsonAcceptanceReportBody(trailingFence.body))
        return output.slice(0, trailingFence.index).trimEnd();  // ← validated
    } catch {
      // Leave unrelated or malformed generic JSON fences visible.
    }
  }
  ...
}
```

Note the asymmetry *within this function*: a malformed **generic JSON** fence is
deliberately left visible (`catch` comment says so), but a malformed
**`acceptance-report`-tagged** fence is stripped unconditionally on the strength
of its tag alone. The tag is trusted; the contents are not checked.

Meanwhile the compensating append is gated on successful validation.

`extensions/subagents/src/runs/background/subagent-runner.ts:1607-1609`

```ts
const rawOutput = finalResult?.finalOutput ?? "";
const outputForPersistence = stripAcceptanceReport(rawOutput);          // strips regardless
const { report: rawAcceptanceReport } = parseAcceptanceReport(rawOutput); // undefined here
```

`extensions/subagents/src/runs/background/subagent-runner.ts:1793-1797`

```ts
const artifactOutput =
  rawAcceptanceReport && !resolvedOutput.savedPath
    ? appendAcceptanceReportDigest(artifactBaseOutput, rawAcceptanceReport)
    : artifactBaseOutput;
fs.writeFileSync(artifactPaths.outputPath, artifactOutput, "utf-8");
```

`rawAcceptanceReport` is `undefined`, so no digest. `artifactBaseOutput` is the
stripped output — `"---"`.

The foreground path has the identical shape at
`extensions/subagents/src/runs/foreground/execution.ts:1625-1626` and `:1700-1702`,
so **this is not async-specific.**

There is also a truncating variant at `subagent-runner.ts:3225`
(`stripAcceptanceReport(...).split("\n").slice(-10)`) which will exhibit the same
blindness when feeding progress summaries.

The invariant that should hold and does not:

> Stripping the report and appending its digest must be gated on the **same**
> predicate. If the report cannot be validated, either keep the raw block or
> substitute the parse error — never remove it and substitute nothing.

### 3.3 D2 — the reason is computed, stored, and then withheld

The diagnostic exists. `evaluateAcceptance()` records it at
`extensions/subagents/src/runs/shared/acceptance.ts:1342-1351`:

```ts
const parsed = input.report ? { report: input.report } : parseAcceptanceReport(input.output);
...
ledger.childReportParseError = parsed.error;
...
message: parsed.error ?? "Structured acceptance report missing.",
```

And it landed on disk. From
`<tmpdir>/pi-subagents-uid-<uid>/async-subagent-runs/930a3978/status.json`,
at `.steps[0].acceptance`:

```json
{
  "status": "rejected",
  "explicit": false,
  "childReportParseError": "Failed to parse acceptance-report: Invalid acceptance-report: commandsRun[1].result: expected one of \"passed\", \"failed\", \"not-run\"; got \"failed as expected\"",
  "runtimeChecks": [
    { "id": "attestation", "status": "failed", "message": "Failed to parse acceptance-rep..." }
  ]
}
```

That string is a perfect, actionable diagnosis. It was one field away from the
supervisor and never rendered. Confirmed by grepping the parent session
transcript — **zero** occurrences of `childReportParseError`,
`commandsRun[1]`, `Structured acceptance report`, or `failed as expected`:

```
$ grep -c 'childReportParseError' \
    2026-08-19T12-00-48-578Z_01a019e5-3bc2-7ee3-87db-6ab484ce8548.jsonl
0
```

(Non-zero counts in the sibling `2026-08-20T09-36-39-809Z_...` session are this
investigation writing those strings, not the original run.)

Also note `"explicit": false` and
`"inferredReason": ["async write-capable or risky run"]` — the acceptance
contract was **inferred**, not requested by the architect. An inferred gate that
can hard-reject without explanation is a bad trade: the supervisor never opted
in, so it has no prior for interpreting the failure.

### 3.4 C3 — no prose fallback

The child's entire final message (3,532 bytes) was `---\n\n` + the fenced block.
`getFinalOutput()` (`extensions/subagents/src/shared/utils.ts:203`) correctly
returned all of it; there was simply no prose for D1's strip to leave behind.
Had the child written even one summary sentence, D1 would have degraded to
"digest missing" instead of "artifact empty," and the architect would likely not
have concluded the harness was broken.

---

## 4. Reproduction

Deterministic, no subagent run needed. Against the real compiled module:

```bash
cd ~/Developer/the-last-harness-mine/extensions/subagents/src/runs/shared
node -e '
const m = require("./acceptance.js");
const text = [
  "---", "",
  "```acceptance-report",
  JSON.stringify({
    criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "x" }],
    commandsRun: [{ command: "test", result: "failed as expected", summary: "y" }]
  }, null, 2),
  "```"
].join("\n");
console.log("parsed:", m.parseAcceptanceReport(text));
console.log("stripped:", JSON.stringify(m.stripAcceptanceReport(text)));
'
```

The minimal case above reports `commandsRun[0]` because it has one command. Run
against the real transcript text (`930a3978_developer_transcript.jsonl`, last
record, where the bad entry is second) it reports `commandsRun[1]`:

```
parseAcceptanceReport → report present: false
  error: Failed to parse acceptance-report: Invalid acceptance-report:
         commandsRun[1].result: expected one of "passed", "failed", "not-run";
         got "failed as expected"
stripAcceptanceReport → "---"
```

Change `result` to `"failed"` and both the parse and the artifact are fine. That
one-token delta is the whole incident.

---

## 5. Evidence trail

Paths on this machine. The installed copy under `~/.the-last-harness-main/` was
verified **byte-identical** (`diff -q`) to the dev checkout for both
`acceptance.ts` and `subagent-runner.ts`, so the analysis applies to the repo as
it stands.

Durable:

```
~/.the-last-harness-main/agent/sessions/--Users-<user>-Developer-<project>--/
  subagent-artifacts/930a3978_developer_output.md       ← 3 bytes: "---"
  subagent-artifacts/930a3978_developer_meta.json       ← exit 0, completed, 18 turns
  subagent-artifacts/930a3978_developer_transcript.jsonl ← full report in last record
  subagent-artifacts/930a3978_developer_input.md        ← the task, incl. inferred contract
  2026-08-19T12-00-48-578Z_01a019e5-3bc2-7ee3-87db-6ab484ce8548.jsonl ← parent session
```

Ephemeral — **in `<tmpdir>`, will be reaped; copy before relying on it:**

```
<tmpdir>/pi-subagents-uid-<uid>/async-subagent-runs/930a3978/
  status.json       ← childReportParseError (quoted in §3.3 above)
  output-0.log      ← the full report the architect eventually found
  events.jsonl
  subagent-log-930a3978.md
```

Run facts from `meta.json`:

| Field | Value |
|---|---|
| runId | `930a3978` (async revival of `796b3663-ce4b-4d7b-810e-685dee4919a8`) |
| agent / model | `developer` / `anthropic/claude-sonnet-4-6:medium` |
| exitCode | `0` |
| terminationReason | `completed` |
| turns | 18 |
| activeRuntimeMs | 2,720,559 (~45.3 min) |
| cost | $0.71 |
| finished | 2026-08-20T09:36:10Z |

---

## 6. Historical prevalence — this is not a one-off

Two scans, run 2026-08-20. Method is reproducible; commands in §6.3.

### 6.1 Acceptance outcomes (`status.json`, 34 async runs)

Covers only runs still present in the current `<tmpdir>` temp root, so this is
a recent-history sample, not all time.

| Acceptance status | Count |
|---|---|
| `attested` | 8 |
| `checked` | 9 |
| `skipped` | 6 |
| **`rejected`** | **11** |

Of those 11 rejections:

| Cause | Count |
|---|---|
| `commandsRun[].result` enum violation | **6** |
| `Structured acceptance report not found.` | 3 |
| Rejected on the merits | **2** |

**82% of rejections were reporting failures, not work failures.** Every single one
was `agent=developer`.

### 6.2 The values agents actually wrote

Every rejected value is an attempt to *qualify* an outcome the enum cannot express:

```
"failed as expected"                                    ← negative control
"failed (pre-fix)"                                  ×2  ← negative control
"failed (expected: 77, actual: 79)"                     ← negative control w/ detail
"failed (expected: 171, actual: 173)"                   ← negative control w/ detail
"failed (pre-existing)"                                 ← not-my-fault marker
"no output (exit 1 = no matches)"                        ← exit code needs prose
"passed (third attempt)"                                ← flake disclosure
"passed (anomaly documented)"                           ← caveat disclosure
"partial — metadata_whenNoMetadata passed; unrelated
 AuthProvider keychain failures are pre-existing"       ← mixed result
```

This is not sloppiness; it is a **schema-ergonomics failure**. The field is named
`result` and sits next to a free-text `summary`, yet agents consistently reach for
the enum to carry nuance. Three of these are `passed (...)` or `partial` — **work
that succeeded, rejected for annotating its success.** A field that punishes
honesty about flakes and pre-existing failures is actively selecting for less
informative reports.

### 6.3 D1 artifact damage (durable, full history)

Scanned all 324 `*_output.md` artifacts across all three harness roots
(`~/.the-last-harness-main`, `~/.tlh-numan`, `~/.the-last-harnessBACK`) for
artifacts that are empty or contain nothing but a horizontal rule:

| Artifact | Bytes | Content | Report in transcript? | Payload destroyed |
|---|---|---|---|---|
| `4c7fe721_developer_0_output.md` | 0 | `''` | yes | 5,229 B |
| `306d6322-...-855a54cdbf0d_developer_output.md` | 3 | `'---'` | yes | 4,414 B |
| `930a3978_developer_output.md` | 3 | `'---'` | yes | 3,532 B |
| `52d3dca6_developer_output.md` | 3 | `'---'` | yes | 2,206 B |

**4 confirmed D1 victims. All 4 caused by the same `commandsRun[].result` enum.**
All 4 had a complete report in the transcript. ~15 KB of validation evidence
deleted from the surface the supervisor reads.

The D1 count (4) is lower than the parse-failure count (9) because D1 only guts
the artifact when the child wrote no prose before the fence. The other 5 kept
their prose, so the damage was limited to a missing digest plus an unexplained
rejection (D2 only). That is the correct way to read the two numbers: **D2 hit
all 9; D1 hit the 4 that happened to write prose-free finals.**

Reproduce:

```bash
# D2 / cause breakdown (ephemeral — only extant temp runs)
cd <tmpdir>/pi-subagents-uid-<uid>/async-subagent-runs
python3 -c 'import json,glob
for f in sorted(glob.glob("*/status.json")):
    for s in (json.load(open(f)).get("steps") or []):
        a = s.get("acceptance") or {}
        if a.get("childReportParseError"):
            print(f.split("/")[0], a["status"], a["childReportParseError"][:160])'

# D1 victims (durable, full history)
find ~/.the-last-harness*/agent/sessions/*/subagent-artifacts \
     ~/.tlh-numan/agent/sessions/*/subagent-artifacts \
     -name '*_output.md' -size -1k 2>/dev/null \
  | while read f; do
      [ "$(tr -d '\-[:space:]' < "$f" | wc -c)" -eq 0 ] && \
        echo "$(wc -c < "$f") $f"
    done
```

---

## 7. The work was correct (this was a false negative)

Verified directly in `~/Developer/ios-armadillo`, nothing staged:

`Numan/Sources/App/Sources/App/Sources/App.Reducer.swift` — the intended
one-liner, no leftover scaffolding:

```swift
 case .didFinishLaunching:
     analyticsProvider.track(.didLaunchApp)
+    state.isUserLoggedIn = authProvider.isLoggedIn()
     return .send(.runBootLoader)
```

`Numan/Sources/App/Sources/App/Tests/AppReducer.Tests.swift` (+71/−28) — the
vacuous test the architect had flagged was genuinely fixed, using a locally
seeded store so the reducer's write is observable:

```swift
let store = TestStore(AppReducer.State(isUserLoggedIn: true), reducer: AppReducer.init)
store.dependencies.authProvider.isLoggedIn = { false }
await store.send(.appLifeCycle(.didFinishLaunching)) {
    $0.isUserLoggedIn = false
}
```

The child had even done the falsifiability proof it was asked for, capturing both
failure messages with the production line removed. All of that was in the report
the gate threw away.

---

## 8. Proposed fixes

Prioritisation given §6: **D2 first** (affected all 9, cheapest). Then **strip
`result` of its power to reject** (causes 6 of 9 and all 4 D1 victims, and is a
near-trivial diff). Then **D1's structural fix** — worst per incident, smallest
share of volume.

### D1 — make strip and append share one predicate

Options, roughly in increasing order of intrusiveness:

1. **Preferred: parse before stripping.** Have `stripAcceptanceReport()` take the
   parse result (or return a discriminated result) so callers cannot strip what
   they could not validate. On parse failure, leave the raw fence in the artifact
   and append the parse error. Touch points:
   `subagent-runner.ts:1607-1609` / `:1793-1797`,
   `execution.ts:1625-1626` / `:1700-1702`, `subagent-runner.ts:3225`.
2. **Minimal: symmetric fallback at the two artifact sites.** Where
   `rawAcceptanceReport` is falsy, append the parse error instead of nothing.
   Smaller diff, leaves the trap in place for future callers.
3. **Belt-and-braces, independent of the above:** never let the artifact go
   effectively empty when the raw output was non-empty. If the post-strip
   artifact is shorter than some floor (or the strip removed everything but
   whitespace/rules), write the raw output instead. This is the invariant the
   supervisor actually depends on.

Option 1 + 3 is the recommendation. 3 alone would have prevented the incident;
1 alone prevents the class.

### D2 — render the rejection reason

Surface `childReportParseError` (and failed `runtimeChecks[].message`) in the
supervisor-facing status line. Today:

```
Step 1: developer complete (...), acceptance: rejected
```

Wanted:

```
Step 1: developer complete (...), acceptance: rejected
  Reason: acceptance-report failed to parse — commandsRun[1].result:
          expected one of "passed", "failed", "not-run"; got "failed as expected"
```

Cheap, high value, and it alone converts this incident from a 45-minute
re-verification into a 30-second re-dispatch. **If only one thing gets fixed,
fix this.**

Consider also: a rejection caused solely by an unparseable report is
categorically different from a rejection on the merits. Reporting both as
`rejected` is what makes the flag untrustworthy. A distinct
`acceptance: unverified (report unparseable)` would let a supervisor react
correctly without being taught to ignore the gate.

### The `result` enum — remove its power, do not expand its vocabulary

**Correction to an earlier draft of this section, which recommended expanding the
schema (`partial`, `expected: true`).** That was written before confirming what
reads the field. It should not be expanded.

`commandsRun[].result` is **never branched on**. Its only three uses:

| Site | Use |
|---|---|
| `acceptance.ts:910` | interpolated into a display line: `` [${entry.result}] ${entry.command} — ${entry.summary} `` |
| `acceptance.ts:750-752` | type guard, *shape-sniffing* untagged JSON fences |
| `acceptance.ts:1047-1049` | the validator that hard-rejects |

The evidence gate does not consult it either — `commands-run` is satisfied by
`commandsRun.length > 0` (`:1141`). **A report where every command `failed`
satisfies the gate identically to one where all `passed`.**

So the field is validated strictly, can kill a 45-minute run, and is then merely
printed. That is the whole defect. Adding `partial` / `mixed` / `expected: true`
would invent taxonomy no code reads and no gate honours — a larger schema
carrying the same information with more surface to get wrong. The nuance agents
keep reaching for already has a home one field to the right: `summary` is free
text and renders on the same line.

Fix the power, not the vocabulary:

- **Drop `result` from validator rejection** (`:1047-1049`); accept any string.
  A display-only field must not be able to fail a run. This alone fixes 6 of 9
  historical failures and all 4 D1 victims.
- **Keep the strict triple in the sniffing guard** (`:750-752`), which genuinely
  consumes the literals — but note it only matters for *untagged* JSON fences.
  A properly tagged `acceptance-report` fence is detected by tag, so the guard is
  irrelevant there. Clean split: strict for detection, permissive for validation.
- **Normalize only where unambiguous**, and only for tidier rendering — a legal
  leading token (`"failed (pre-fix)"` → `failed`, parenthetical appended to
  `summary`). Do **not** force the residue: `"no output (exit 1 = no matches)"`
  has no legal leading token, and mapping it to `failed` would be *wrong* —
  `grep` exiting 1 means it successfully matched nothing. That case is precisely
  why normalize-or-reject is the wrong shape: it either corrupts meaning or
  throws away the report.

This is strictly smaller than either option previously drafted here, subsumes
both, and cannot silently change what a command result meant.

### C3 / prompt template — close the prose-free failure mode

Lowest priority, but both are one-line template changes and each independently
downgrades a future D1 to a cosmetic issue:

- Ask for a one-line prose summary *before* the fenced block, so the artifact is
  never prose-free even if the report is later stripped.
- State the preferred `result` tokens inline. The template currently shows
  `"result": "passed"` as a bare example, which does not signal that a specific
  set is expected. Worth doing for rendering consistency even after the field
  stops being able to reject.

---

## 9. Where tests go

Existing coverage lives in:

```
extensions/subagents/test/unit/acceptance.test.ts
extensions/subagents/test/unit/get-final-output.test.ts
extensions/subagents/test/integration/acceptance-digest-surfacing.test.ts
extensions/subagents/test/integration/async-digest-surfacing.test.ts
```

Regressions worth adding:

- **Unit:** `stripAcceptanceReport()` on a present-but-invalid
  `acceptance-report` fence must not silently delete it. (Fails today.)
- **Unit:** strip and `parseAcceptanceReport` agree on every fixture — no input
  where one strips and the other refuses to parse. This is the invariant; assert
  it directly.
- **Integration:** a child emitting an invalid report yields an artifact that
  still contains either the raw block or the parse error, and never an
  effectively-empty artifact when raw output was non-empty.
- **Integration:** the rejection reason appears in the supervisor-facing status
  summary, not only in `status.json`.
- **Unit:** a report whose `commandsRun[].result` is an unrecognized string still
  parses, and the raw string survives into the digest line. Seed the table from
  the nine real values in §6.2 — the best available corpus of how models actually
  write this field.
- **Unit:** `isCommandsRunArray` still requires the strict triple, so untagged
  JSON fence detection does not regress when the validator is loosened.

Validation commands (see `VALIDATING.md`):

```bash
npm run test:subagents:unit
npm run test:subagents:integration
npm run typecheck
```

---

## 10. Non-goals and open questions

Non-goals:

- Loosening the acceptance schema generally. Strictness is fine; **silent
  evidence destruction and unexplained rejection** are the bugs.
- Anything in `~/Developer/ios-armadillo`. That work is correct and unrelated
  beyond having been the victim.

Open questions for whoever picks this up:

1. Should an unparseable report reject at all, or downgrade to
   `unverified`/`needs-attention`? Rejecting correct work on a report typo has a
   worse cost profile than flagging it, especially when the contract was
   *inferred* rather than requested.
2. Should inferred (`explicit: false`) acceptance contracts be allowed to
   hard-reject? An opt-out the supervisor never opted into caused this.
3. Is there any caller that legitimately wants a stripped artifact with no
   digest and no error? If not, the asymmetry is pure defect and option 1 is
   safe.
4. ~~How many past `acceptance: rejected` results were this same false
   negative?~~ **Answered in §6: 9 of 11 observable rejections, 4 with gutted
   artifacts.** Follow-on: the sample covers only runs still in the temp root.
   Is there durable acceptance-outcome history anywhere? `meta.json` does not
   record the acceptance ledger — arguably it should, precisely so this question
   is answerable without racing temp reaping.
5. Given §6.1, is `rejected` load-bearing enough to keep as a hard gate today?
   At an 82% false-positive rate it is closer to noise than signal, and §2 shows
   it already trained one supervisor to ignore it.
