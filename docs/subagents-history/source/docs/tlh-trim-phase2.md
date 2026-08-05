# TLH trim — phase 2 plan + handoff

Status: 2a SHIPPED (fork PR #70, release PR #74, tag tlh-v0.31.8, npm 0.31.8,
TLH pin PR the-last-harness#370); rider (ps-vn85) DELIVERED — no-pi-intercom
regression guard added, README native channel repositioned as primary; 2b
CANCELLED; 2c investigation COMPLETE, staged exit plan below.
Last updated: 2026-07-21. Owner: TLH architect session (fork checkout
`/Users/diegopetrucci/Developer/forks/pi-subagents`, branch `main`).

This document is self-contained on purpose: the `/tmp` investigation
artifacts referenced below are ephemeral, and tk tickets live outside the
repo (`/Users/diegopetrucci/Developer/.tickets/`). Everything needed to
resume or hand off the work is in this file plus
`docs/tlh-patch-inventory.md`.

## 1. Big picture

Goal: trim this pi-subagents fork down to what The Last Harness (TLH,
`/Users/diegopetrucci/Developer/the-last-harness-mine-fifth`) actually uses.
Priorities, in Diego's words: **token savings first, bug-surface reduction /
maintainability second.**

Phasing:

- **Phase 1 (DONE, released)** — fail-close the model-facing contract.
- **Phase 2 (this doc)** — three tracks:
  - 2a: remove remaining non-model entry points; restore `steer`.
  - 2b: pi-intercom description trim — cancelled.
  - 2c: plan and stage the full removal of pi-intercom from TLH.
- **Phase 3 (later, separate)** — delete now-unreachable runtime code once
  phase 2 has soaked (chain ~2 K LOC, scheduler ~250, agent mutations ~1 K,
  clarify TUI ~400, dead prompt-workflow module).

Phase-2 style rule (Diego): **remove entry points, keep runtime code.**
Mass deletion is phase 3.

## 2. Phase 1 — shipped (context)

PR #60 (`bb8ae34`, "Trim TLH model-facing subagent surface") + release
`07db444` = npm `@diegopetrucci/pi-subagents@0.31.6`, tag `tlh-v0.31.6`.

What it did:

- `src/extension/schemas.ts`: static fail-closed `SubagentParams` — 19
  top-level params, `additionalProperties: false` (root and `tasks[]`),
  action enum `list/get/models/status/interrupt/resume/doctor`. `chain`,
  `clarify`, `worktree`, `schedule*`, `view`, `config`, budgets, etc. are
  schema-rejected for the model.
- `src/extension/tool-description.ts`: FULL/COMPACT/SAFETY rewritten to the
  minimal contract; forbidden-vocabulary tests enforce it.
- `src/extension/rpc.ts` hardening: `clarify: false` injection removed,
  `runId`→`id` mapping, `dir` dropped, params validated as-is.
- Bundled skill (`skills/pi-subagents/SKILL.md`, 910 lines) removed;
  `pi.skills` manifest entry gone.
- Verified numbers: schema 12,666 → **3,068 B** (−76%); FULL description
  5,953 → **3,258** chars; COMPACT 2,059 → **1,448**; SAFETY 1,321 →
  **1,146**.

TLH-side follow-ups still pending from phase 1:

- Pin bump 0.31.5 → 0.31.6 in TLH `config/default-extensions.json`.
- TLH cleanups riding the bump: remove `/skill:pi-subagents` from TLH
  docs/autocomplete, update chain safety-tests, architect.md chain wording.
- `wait` tool adoption: diegopetrucci/the-last-harness#348.

## 3. Verified facts (architect-checked on `main` @ 0.31.6)

Scout reports contained errors; each item below was independently verified.

- The model-facing schema is fully fail-closed (see §2). Tests:
  `test/unit/schemas.test.ts` (contract snapshot, invalid-value table,
  4,600-byte ceiling), `test/unit/tool-description.test.ts`
  (FORBIDDEN_VOCABULARY incl. `/\bsteer\b/i` — 2a must relax this;
  FULL bound 2,500–3,500 chars; compact < 0.8 × full).
- **`/prompt-workflow` and `/chain-prompts` are already dead in this
  fork**: `registerPromptWorkflowCommands`
  (`src/slash/prompt-workflows.ts:263`) has no call site in `src/` and
  never had one in fork history (`git log -S` finds nothing in
  `extension/index.ts`). Only `test/unit/prompt-workflows.test.ts` invokes
  it. An earlier scout claim that these were "live chain entry points" was
  wrong. → No unregistration work needed in 2a; module deletion is phase 3.
  With the model schema closed, **no live chain entry point remains**.
- `SUBAGENT_ACTIONS` (`src/shared/types.ts:1189`) still lists all 20
  actions. The executor (`src/runs/foreground/subagent-executor.ts`)
  validates `action` against it at `:3486`, **but** inline handlers for
  `append-step` (~`:3437`) and `schedule|schedule-list|schedule-status|
  schedule-cancel` (~`:3440-3449`) run BEFORE that check — trimming the
  const alone does not disable them; the blocks must go too. Agent
  mutations (`create/update/delete/eject/disable/enable/reset`) run AFTER
  the check via `handleManagementAction`, so the const trim alone blocks
  them. `MUTATING_MANAGEMENT_ACTIONS` (`subagent-executor.ts:116`) becomes
  dead but stays (phase 3).
- Scheduler: created and wired in `src/extension/index.ts` — import `:34`,
  `stop()` `:306`, `createScheduledRunManager` `:318`,
  `handleScheduledRunAction` wiring `:336`, `bindSession` `:627`, `stop()`
  `:651`. Config-gated off (`scheduledRuns.enabled === true` required).
  `src/runs/background/scheduled-runs.ts` + its unit test stay (phase 3).
- Steer machinery is intact and dual-path: executor dispatch at `:3407`
  (`steerAsyncRun` for async, `steerNestedRun` for nested-async; plain
  foreground children return a friendly error). Child-side inbox watcher:
  `src/runs/shared/subagent-prompt-runtime.ts:193+` (env
  `PI_SUBAGENT_STEER_INBOX`, fs.watch + 250 ms poll, delivered
  `deliverAs: "steer"`). Steer request files:
  `src/runs/background/control-channel.ts:114-135`
  (`{asyncDir}/control/steer-requests/`). No pi-intercom involvement.
- RPC bridge is default-off (`config.rpc?.enabled === true`,
  `index.ts:448-451`) and validates params against the model schema —
  trimming/extending the schema automatically applies to RPC.
- TLH usage (audited): single + parallel dispatch, the 7 actions,
  `contact_supervisor`, async `status.json` tracking, and the retained
  read-only slash/status surfaces (`/subagents-doctor`, `/subagents-fleet`,
  `/subagent-cost`). TLH never sets
  `toolDescriptionMode` → pays FULL (~815 tokens) though COMPACT (~360)
  exists (see §7).
- pi-intercom per-session token cost (parent AND each child): ~600 tokens.

## 4. Track 2a — entry-point fail-close + steer restoration (IMPLEMENTED)

Approved by Diego 2026-07-16; implemented 2026-07-21 via tickets ps-d87p
(steer restoration), ps-519q (executor fail-close + scheduler unwire),
ps-xboc (bookkeeping + validation) — all closed with architect verification
notes. Changes live uncommitted in the worktree pending review + Diego's
commit/release call. Resulting sizes (architect-measured): schema **3,131 B**
(≤ 4,600), FULL **3,392** chars (≤ 3,500), COMPACT **1,507**, SAFETY 1,153.
Local gate: test:unit **1014/1016** (only the 2 documented env failures; +9
new tests across the phase — 7 in `test/unit/executor-action-trim.test.ts`,
plus a nested-steer routing test and a structural no-scheduler-in-index test
from the fix pass). Integration/e2e defer to PR CI (node 24) — local node 26
cannot launch them (documented convention in `docs/tlh-patch-inventory.md`).

**Measurement discipline (two incidents this phase):** test counts are only
valid from a normal parent shell. Any agent running *inside* a pi-subagents
child sees 4–6 extra env-artifact failures (ambient `SUBAGENT_CHILD_ENV`,
intercom session name, supervisor-channel and TLH agent-dir vars flip
env-sensitive tests in `pi-coding-agent-dir.test.ts` /
`subagent-prompt-runtime.test.ts`) — stash-and-rerun "proves" nothing since
the env persists. Both the ps-xboc developer and the 2a code-reviewer fell
into this. Sizes must be measured, not taken from reports (the ps-d87p
developer's size numbers were slightly off).

Post-review fix pass (ticket ps-*, 2026-07-21): review verdict was
request-changes — 3 findings confirmed (fanout-child description/test still
advertised 7 actions and asserted steer absent; README `scheduledRuns`
section + "runtime-only references" line still promised scheduling;
test-header/inventory overclaimed nested-steer + scheduler-wiring coverage),
1 downgraded (executor `single`/`parallel`/`tasks` execution-mode alias
normalization is pre-existing, grants no capability — wording fix in
CHANGELOG/inventory instead of behavior change; alias removal deferred to
phase 3), 1 partially wrong (reviewer's child-env test counts rejected, its
size corrections accepted).

Fix pass COMPLETE + GREEN (2026-07-21, ticket ps-poew): all 5 items landed.
The new positive nested-steer test initially failed on two fixture bugs
(dead `pid: 12345` tripped `reconcileAsyncRun`→`writeFailedRepair` forcing
state "failed"; a stale `RESULTS_DIR/nested/…` result file made
reconciliation terminal on rerun) — fixed with `process.pid` +
pre-clear/post-clean of the result file, preserving the strong positive
assertions (not-error + "Steering queued" + one queued steer request).
Architect parent-shell gate: **test:unit 1014/1016**, only the 2 documented
env failures. 2a is worktree-complete and PR-ready; nothing committed.

Rationale for steer: it becomes the supported parent→child guidance channel
so pi-intercom can be dropped (§6). This deliberately REVERSES phase 1's
removal of steer wording, and REVERSES an earlier phase-2 draft item that
would have removed the steer-inbox plumbing.

### Implementation spec

1. **Trim `SUBAGENT_ACTIONS` to 8** (`src/shared/types.ts:1189`):
   `list, get, models, status, interrupt, resume, steer, doctor`.
   Fail-closes the executor for ALL callers (model, RPC, internal).
2. **Delete the executor's inline `append-step` and `schedule-*` handler
   blocks** (`subagent-executor.ts` ~`:3437-3449`) — they precede the
   `SUBAGENT_ACTIONS` validity check and would otherwise stay live. Keep
   `appendStepToAsyncChain` / scheduler modules themselves (phase 3).
   Removed actions must uniformly return
   `Unknown action: X. Valid: list, get, models, status, interrupt,
   resume, steer, doctor`.
3. **Restore `steer` to the model contract**:
   - `src/extension/schemas.ts`: add `"steer"` to the action enum + action
     description; extend `id`/`message` descriptions to mention steer
     (message: "Follow-up message for action='resume' or guidance for
     action='steer'." or similar).
   - `src/extension/tool-description.ts`: add one steer bullet to FULL
     (after the resume bullet, ~`:45`), extend the COMPACT ACTIONS line
     (`:64`), extend the SAFETY action list (`:11`). Suggested wording:
     `{ action: "steer", id: "...", message: "...", index?: 0 } queues
     mid-run guidance for a live async child without pausing it.`
4. **Unwire the scheduler** in `src/extension/index.ts` (all six touch
   points in §3). Keep the `handleScheduledRunAction` field on the executor
   deps type (just stop wiring it); keep `scheduled-runs.ts` and its test.
5. **No slash work needed**: `/prompt-workflow` + `/chain-prompts` are
   already unregistered (§3). Keep `/subagents-fleet`, `/subagent-cost`,
   and `/subagents-doctor` (zero tokens, user-facing). Runtime/profile/model
   APIs stay available through `subagent(...)` and the existing modules.
   RPC bridge unchanged. Fanout-child machinery unchanged.
6. **Test updates** (only these; do not weaken unrelated tests):
   - `test/unit/tool-description.test.ts`: remove `/\bsteer\b/i` from
     `FORBIDDEN_VOCABULARY`; add `steer` to `ALLOWED_ACTIONS`.
   - `test/unit/schemas.test.ts`: move `{ action: "steer" }` from
     `invalidValues` to `validValues` (with id/message example); add
     `steer` to the contract-snapshot enum; remove `"steer"` from
     `removedActions`.
   - New focused coverage: executor returns Unknown-action for
     `append-step`, `schedule`, `create` (representative of each removed
     group) even from non-model callers; steer still routes to
     `steerAsyncRun`/`steerNestedRun`; index no longer wires the scheduler.
7. **Fork bookkeeping**: `docs/tlh-patch-inventory.md` rows (action trim,
   steer restoration, scheduler unwire) + CHANGELOG entry.

Validation: focused suites first (`schemas`, `tool-description`,
`subagent-executor`-related, `prompt-workflows`, `scheduled-runs`), then
`npm run test:unit`, then `npm run test:all`. See §10 for the 2 known
pre-existing env failures — only NEW failures count.

### Optional rider (from 2c step 2, may ship with 2a or right after)

- [x] No-pi-intercom regression test: async completion notice +
  `needs_attention` notice + native `contact_supervisor` round-trip with
  pi-intercom absent. (ps-vn85, `test/unit/no-pi-intercom-regression.test.ts`)
- [x] README note documenting the native supervisor channel as the primary
  mechanism (pi-intercom optional). (ps-vn85)

## 5. Track 2b — pi-intercom description trim: CANCELLED

Cancelled 2026-07-16: pointless polish on a package slated for removal
(would have saved ~300–450 tokens/session at ~10 h effort).

Also rejected (recorded for history): **merging pi-intercom into
pi-subagents** — ~140 h, high-risk broker refactor, breaks the intake-based
upstream sync of both forks. The exit (§6) supersedes the merge question.

## 6. Track 2c — pi-intercom exit (investigation COMPLETE)

Direction (Diego, 2026-07-16): TLH drops the pi-intercom extension and
relies on pi-subagents' native channels — file-based `contact_supervisor`
(child→parent), restored `steer` (parent→child), native event/async
completion paths.

Expected savings: parent stops paying pi-intercom's ~600 tokens; each child
swaps ~600-token pi-intercom tools for ~160-token native fallbacks
(net ≈ −440/child) — larger than the cancelled 2b trim.

### Findings (2026-07-16, two scouts, architect-digested)

All six open questions from the previous draft are answered:

1. **Proactive notifications: YES on both critical paths.**
   - Async completions: **as of #64 (`27d2065`, 2026-07-21) this is now
     native.** The result watcher emits only the internal
     `subagent:async-complete` event for the exact owning session and no
     longer sends completion payloads over `subagent:result-intercom`;
     `notify.ts` delivers one bounded native completion notice (child
     details/summaries/omission markers) that wakes one parent turn. (The
     original investigation below described the pre-#64
     `pi.sendMessage(customType: "subagent-notify")` + 500 ms
     `result-intercom` relay path; #64 replaced that leg.) Anchors:
     `src/runs/background/{result-watcher,notify}.ts`.
   - Child `contact_supervisor` asks: native channel parent side polls
     every 250 ms and **injects `subagent_supervisor_request` messages
     proactively** (`native-supervisor-channel.ts:629-642`). Escalations
     reach the architect unprompted; replies unblock the child ≤ ~250 ms.
2. **Cadences/timeouts**: 250 ms polls both sides (`CHANNEL_POLL_MS`);
   default ask timeout 10 min (`PI_INTERCOM_ASK_TIMEOUT_MS` override).
   UX parity with the broker for the blocking flow.
3. **Steer coverage**: async + nested-async ✓; plain foreground children
   not steerable (parent blocks on those anyway; TLH uses async for
   implementation work). Acceptable.
4. **Degradations without the broker** (all minor, accepted):
   - `active_long_running` control notices are not injected as messages
     (only `needs_attention` is — `control-notices.ts:72`); visible via
     status polling instead.
   - `SUBAGENT_RESULT_INTERCOM_EVENT` / `SUBAGENT_CONTROL_INTERCOM_EVENT`
     are emitted and discarded — no stalls, no silent failures.
   - **Sequencing trap**: env `PI_SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH`
     (`pi-args.ts:315`) is consumed ONLY by pi-intercom. It must NOT be
     removed from the fork while any TLH pin still ships pi-intercom — it
     is pi-intercom's capability signal. Remove it in phase 3 / post-exit.
     `PI_SUBAGENT_ORCHESTRATOR_TARGET` and `…_INTERCOM_SESSION_NAME` stay
     (child identity/diagnostics for the native channel).
5. **TLH exit surface is small (~200 lines, ~14 files, est. 2–4 h)**:
   - `config/default-extensions.json:69-75`: remove the `critical: true`
     intercom entry (`npm:@diegopetrucci/pi-intercom@0.7.0`).
   - Drop `intercom` from 4 primary-agent tool lists — architect, product,
     **rush, bug-hunter** — and from the runtime default allowlist
     (`extensions/the-last-harness/primary-agent-runtime.ts:230`).
   - Architect prompt: replace intercom-usage wording with steer guidance.
   - `extensions/the-last-harness/autocomplete.ts`: remove
     `skill:pi-intercom` + `intercom` hidden entries (2 lines).
   - Docs: `docs/commands.md` (2 rows), `docs/install.md` critical-defaults
     sentence, CHANGELOG entry.
   - Tests: delete 3 intercom-migration tests in
     `tests/default-extensions.test.mjs` (~160 lines) + bundled-sources map
     line; 6 autocomplete-test lines; `extension-usage-refresh` activeTools
     (1); trace-policy checker tool arrays (2).
   - **All 8 minor-agent prompts already use only `contact_supervisor` —
     zero subagent prompt changes.** `tokens-analyzer.ts` intercom tracking
     stays (read-only, historical sessions).
6. **No TLH flow or doc relies on cross-session peer messaging.**

User-facing losses (accepted per direction): `/intercom` overlay + Alt+M,
ad-hoc session↔session ask/reply between separate human-driven pi sessions,
intercom-rendered "📨" envelopes (replaced by native notify/control-notice
messages).

### Staged exit plan

> **Update 2026-07-21:** the child→parent **native async-completion slice
> already landed on `main` as #64** (`27d2065`) — the first reviewable native
> slice of this exit. 2a (steer restore, the **parent→child** slice) is now
> committed on top of #64 on branch `phase-2a-failclose-steer` and re-gated
> green (test:unit 1024/1026, merge conflict-free). So steps 1–2 below are
> partly done: #64 = child→parent completions native; 2a = parent→child steer
> native.

1. **Fork (2a)** lands steer restoration + entry-point fail-close; publish
   pin (next `tlh-v*` release). Merged on top of #64.
2. **Fork hardening** (rider on 2a or immediately after): no-pi-intercom
   regression test; README documents the native channel as primary.
3. **TLH pin bump** to the 2a release + pending 0.31.6 cleanups (§2).
4. **TLH exit PR** — the ~14-file checklist above; release notes call out
   the `/intercom` overlay removal and `contact_supervisor`/steer paths.
5. **Fork post-exit cleanup** (phase 3): remove
   `BLOCKING_SUPERVISOR_REPLY_PATH` emission + dead intercom relay events
   once no TLH pin ships pi-intercom.

## 7. Open decision — compact tool-description default

TLH pays FULL (~815 tokens) because it never sets `toolDescriptionMode`.
Options: (i) fork default flips to `compact` (~455 tokens/session saved,
reaches TLH at pin bump, affects all fork consumers — acceptable, TLH is
the only consumer); (ii) TLH installer writes
`toolDescriptionMode: "compact"` extension config; (iii) keep FULL.
Risk: compact has fewer usage examples → possible marginal
delegation-quality regression. **Not yet decided; can ship with any pin
bump.**

## 8. Sequencing

1. 2a in this fork (ticket tree → developer → review → Diego-approved
   commit/PR → `tlh-v*` release).
2. TLH pin bump + phase-1 cleanups + wait adoption (#348).
3. TLH exit PR (2c), then fork post-exit cleanup with phase 3.
4. Compact decision whenever (§7).
5. Phase 3 deletions after 2a soaks.

## 9. Decision log

- 2026-07-14 (Diego): tokens-first; fail-closed static allowlist; chain
  dropped from model contract; wait kept (TLH #348); skill removed.
  → shipped as PR #60 / `tlh-v0.31.6`. Gnosis `frzpgt`.
- 2026-07-16 (Diego): phase 2 = keep trimming what TLH doesn't use, prefer
  entry-point removal over deletion; investigate intercom consolidation.
- 2026-07-16 (Diego): **intercom endgame = remove pi-intercom**; restore
  `steer` as the parent→child channel. 2b cancelled; merge idea moot.
- 2026-07-16 (Diego): start 2a; this doc becomes the handoff artifact.
- 2026-07-21 (architect/ps-vn85): 2a rider delivered — no-pi-intercom regression
  guard (`test/unit/no-pi-intercom-regression.test.ts`) + README native channel
  repositioned as primary (steer documented as parent→child leg).

## 10. Handoff notes (how to resume this work cold)

- **Checkouts**: fork = `/Users/diegopetrucci/Developer/forks/pi-subagents`
  (branch `main`; `origin` = diegopetrucci fork, `upstream` = nicobailon).
  TLH = `/Users/diegopetrucci/Developer/the-last-harness-mine-fifth`.
- **Fork policy docs**: `AGENTS.md` (TLH-first, selective per-change sync),
  `docs/UPSTREAM-SYNC.md`, `docs/tlh-patch-inventory.md` (every deliberate
  delta needs a row + focused test), `.upstream-ledger.jsonl`.
- **Release flow** (as done for phase 1): feature PR into fork `main` →
  release commit bumping `package.json` (`chore: release TLH package
  vX.Y.Z`) → tag `tlh-vX.Y.Z` → npm `@diegopetrucci/pi-subagents` → TLH
  `config/default-extensions.json` pin bump.
- **Known env issue (do NOT chase)**: 2 pre-existing unit-test failures on
  Homebrew node 26.4.0 (`node: bad option:
  --experimental-transform-types` in subprocess spawns):
  `tool-description.test.ts` "registers full, compact, custom, and
  fallback descriptions from extension config" and
  `index-child-registration.test.ts` "honors waitTool disabled config".
  Reproduced on clean HEAD. Only NEW failures count.
- **Ticketing**: `tk` stores at `/Users/diegopetrucci/Developer/.tickets/`
  (parent-dir walk — outside this repo; never commit ticket state). `tk`
  has no `done` command: use `tk close` + `tk add-note`.
- **Gnosis**: `gn` entries in `.gnosis/entries.jsonl` are committed with
  related changes. Topics must be ≥7 chars normalized. Relevant existing
  entries: `qgjmjh` (intake-based sync), `frzpgt` (phase-1 trim decision).
- **Prior artifacts**: phase-1 handover `docs/HANDOVER-tlh-trim-phase1.md`
  on local branch `tlh-trim-phase1` (obsolete, superseded by PR #60).
  `/tmp/tlh-trim-investigation/*` and `/tmp/tlh-trim-phase2/*` scout
  reports are ephemeral; all load-bearing findings are inlined here.
- **Verification discipline**: scout reports have produced two materially
  wrong claims so far (schema leftovers; live prompt-workflow commands).
  Independently verify any load-bearing claim before acting on it.
