# Fork pin-bump verification tally

> **Live tracker:** completion is tracked in GitHub issue
> [#346](https://github.com/diegopetrucci/the-last-harness/issues/346).
> This doc is the reference detail; tick items off in the issue.

Running checklist of behaviors that could **only be unit-tested / statically verified**
during the `@diegopetrucci/pi-subagents` v0.34.0 intake and its follow-ups, and therefore
still need a **live-session runtime check** on the bumped pin.

The pin lives at `config/default-extensions.json` (`npm:@diegopetrucci/pi-subagents@0.31.9`)
with manifest-consistency/migration assertions in `tests/default-extensions.test.mjs` (the test derives its expected value from the manifest, so it would still pass if only the manifest changed). Previous pin bumps landed in
PRs #347 → 0.31.5, #367 → 0.31.7, and #370 → 0.31.8. The current checkout advances the pin to 0.31.9; the live-session pass is what remains.

Mark each item `[x]` once verified in a real TLH session on the bumped pin.

## Pending post-pin verification

- [ ] **Compact subagent tool description (`ps-fo50`)** — a live session shows the parent-facing
  subagent tool description in **compact** form while retaining safety-critical delegation
  guidance; an invalid/unknown `toolDescriptionMode` value falls back to `full`.
  _Static status:_ installer provisioning in PR #374; unit-tested in
  `tests/install-libs.test.mjs`. Runtime rendering deferred (requires the bumped pin).

- [ ] **RPC bridge default-off (`ps-5n7r`, fork PR #59)** — confirm the subagent RPC bridge is
  **not active** by default: no `subagents:rpc:v1:ready` emitted, and an RPC `spawn` request is
  ignored. TLH must leave `rpc.enabled` off.
  _Static status:_ gated + unit-tested in the fork (`test/unit/rpc-gate.test.ts`).

- [ ] **Native supervisor coordination (v0.34.0 Option A)** — `contact_supervisor` escalations
  from minor agents reach the architect via the **native supervisor channel** (the fork's
  pi-intercom discovery delta was retired). This is a behavioral cutover worth a live check.

- [ ] **New management verbs blocked at runtime (`ps-c901`)** — `eject`, `disable`, `enable`,
  `reset` are rejected for primary agents in a live session.
  _Static status:_ pinned by `validateSubagentToolInput` regression test in
  `tests/tlh-subagent-safety.test.mjs` (tool_call path). RPC path covered by the default-off gate.
  Phase-2a in 0.31.8 additionally fail-closes the executor for all callers (fork
  `test/unit/executor-action-trim.test.ts` trims `SUBAGENT_ACTIONS` to the 8 supported actions),
  strengthening the original tool_call-path-only coverage.

- [ ] **General intake smoke** — core TLH subagent flows still work on the new version:
  delegation to the 8 allowed minor agents; a non-allow-listed target is blocked; forced
  `agentScope: user` + `context: fresh`; async run + `status`/`resume`.

## Notes

- Slash / prompt-template executor-path bypass was audited (`ps-azwi`) and **accepted, not gated**
  (low/zero real exposure); documented in the fork's `docs/tlh-patch-inventory.md`. Re-evaluate
  only if a new slash command delegates a user-supplied `agent`/`task`, or `pi-prompt-template-model`
  is installed.
- Windows-only behaviors (e.g. the fork's win32 E2E skip) are out of scope — TLH targets macOS/Linux.
