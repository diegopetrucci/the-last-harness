# Fork pin-bump verification tally

Running checklist of behaviors that could **only be unit-tested / statically verified**
during the `@diegopetrucci/pi-subagents` v0.34.0 intake and its follow-ups, and therefore
still need a **live-session runtime check after the fork pin is bumped**.

The pin currently lives at `config/default-extensions.json` (`npm:@diegopetrucci/pi-subagents@<version>`)
with mirroring assertions in `tests/default-extensions.test.mjs`. Bumping the pin to the newly
published fork release is the trigger for working through this list.

Mark each item `[x]` once verified in a real TLH session on the bumped pin.

## Pending post-pin verification

- [ ] **Compact subagent tool description (`ps-fo50`)** — a live session shows the parent-facing
  subagent tool description in **compact** form while retaining safety-critical delegation
  guidance; an invalid/unknown `toolDescriptionMode` value falls back to `full`.
  _Static status:_ installer provisioning idempotent + user-override-preserving; unit-tested in
  `tests/install-libs.test.mjs`. Runtime rendering deferred (requires the >= v0.33.0 fork build).

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

- [ ] **General intake smoke** — core TLH subagent flows still work on the new version:
  delegation to the 8 allowed minor agents; a non-allow-listed target is blocked; forced
  `agentScope: user` + `context: fresh`; async run + `status`/`resume`.

## Notes

- Slash / prompt-template executor-path bypass was audited (`ps-azwi`) and **accepted, not gated**
  (low/zero real exposure); documented in the fork's `docs/tlh-patch-inventory.md`. Re-evaluate
  only if a new slash command delegates a user-supplied `agent`/`task`, or `pi-prompt-template-model`
  is installed.
- Windows-only behaviors (e.g. the fork's win32 E2E skip) are out of scope — TLH targets macOS/Linux.
