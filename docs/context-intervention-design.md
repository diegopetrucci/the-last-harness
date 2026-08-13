# Safe child context intervention

**Status:** design investigation only. No automatic compaction or interruption is enabled by this note.

## Decision

Defer production automatic compaction and interruption. The smallest defensible next step is a **separately approved, explicitly opt-in RPC-child prototype**. The prototype would be an experiment, not a change to the default TLH child path, and is not implemented by this ticket.

This recommendation is based on the upstream persistence and tool-boundary risks below, not on an assumption that context pressure is common.

## What ships today

TLH already records per-response context diagnostics, effective context windows, restored-token measurements, pressure thresholds, termination reasons, model identity/resolution, and crossed warning bands in its run artifacts. `detectContextPressureCrossing` uses measured totals only and warns at 80% (`warning`) and 95% (`critical`); the foreground and background paths emit a `needs_attention` event with measured usage and recommend preserving progress rather than intervening. See [`context-diagnostics.ts`](../extensions/subagents/src/shared/context-diagnostics.ts), [`execution.ts`](../extensions/subagents/src/runs/foreground/execution.ts), [`subagent-runner.ts`](../extensions/subagents/src/runs/background/subagent-runner.ts), and [`subagent-control.ts`](../extensions/subagents/src/runs/shared/subagent-control.ts).

Durable resume has a gate: it compares the latest persisted `contextTokens` with the effective context window before claiming the paused lifecycle. At or above 80%, it preserves the paused run and returns measured used tokens, window, percentage, and remaining headroom with a recommendation to dispatch a fresh narrow child. Missing measurements are intentionally not guessed and currently do not block. Model selection and effective-window resolution are part of the gate. See [`context-diagnostics.ts`](../extensions/subagents/src/shared/context-diagnostics.ts) and [`subagent-executor.ts`](../extensions/subagents/src/runs/foreground/subagent-executor.ts). The live warning explicitly says: “Do not interrupt or compact automatically; inspect status and preserve the child’s progress.”

The need is real but its frequency is not established here. The [#456 incident](https://github.com/diegopetrucci/the-last-harness/issues/456) measured about **80% context at restored start** and **99% at the empty turn**; those are measurements for that failure sequence, not a claim that 80% or 99% of runs behave this way. The durable local gate and regression evidence are [`context-diagnostics.ts`](../extensions/subagents/src/shared/context-diagnostics.ts), [`single-execution.test.ts`](../extensions/subagents/test/integration/single-execution.test.ts), and [`async-execution-supervisor.test.ts`](../extensions/subagents/test/integration/async-execution-supervisor.test.ts).

## Version and evidence scope

TLH pins `@earendil-works/pi-coding-agent` to **0.84.1** in [`package.json`](../package.json). The upstream evidence below is intentionally scoped to tag `v0.84.1`, commit [`53fa77ccd8a279eb87e92294ef3687b03ff80112`](https://github.com/earendil-works/pi/tree/53fa77ccd8a279eb87e92294ef3687b03ff80112). It must be re-verified if the pin changes.

### Controls available in that pin

Upstream's session-scoped `AgentSession` exposes `isStreaming` ([`agent-session.ts#L877-L880`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/agent-session.ts#L877-L880)), `isCompacting` ([`agent-session.ts#L945-L951`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/agent-session.ts#L945-L951)), `abort()` and `waitForIdle()` ([`agent-session.ts#L1547-L1561`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/agent-session.ts#L1547-L1561)), `compact(customInstructions?)` ([`agent-session.ts#L1785-L1793`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/agent-session.ts#L1785-L1793)), and `abortCompaction()` ([`agent-session.ts#L1935-L1941`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/agent-session.ts#L1935-L1941)). Extension code can request `ctx.compact({ customInstructions, onComplete, onError })`; the extension API defines compaction options and lifecycle events ([`extensions/types.ts#L296-L344`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/extensions/types.ts#L296-L344), [`extensions/types.ts#L591-L613`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/extensions/types.ts#L591-L613)). The implementation checks for cancellation before appending the compaction entry and emits the post-save hook after appending it ([`agent-session.ts#L1818-L1837`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/agent-session.ts#L1818-L1837), [`agent-session.ts#L1874-L1897`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/agent-session.ts#L1874-L1897)). The extension helper is fire-and-forget rather than an awaited transaction ([`agent-session.ts#L2431-L2442`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/agent-session.ts#L2431-L2442)).

RPC accepts `compact`, `abort`, and `set_auto_compaction` commands ([`rpc-types.ts#L20-L47`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/modes/rpc/rpc-types.ts#L20-L47), [`rpc-mode.ts#L428-L431`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L428-L431), [`rpc-mode.ts#L531-L539`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L531-L539)). RPC input is accepted concurrently: the JSONL reader invokes `void handleInputLine(line)` without awaiting the prior line's handler. A controller must therefore provide ordering, request/event correlation, and a state machine; `get_state` reports streaming/compacting state but not pending tool-call IDs ([`rpc-mode.ts#L748-L808`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L748-L808), [`rpc-mode.ts#L446-L461`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L446-L461), [`rpc-types.ts#L95-L108`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/modes/rpc/rpc-types.ts#L95-L108)).

### Why that does not control current TLH children

Current foreground and background children are launched with `--mode json -p`, not RPC; their stdin is ignored (`stdio: ["ignore", "pipe", "pipe"]`). See [`execution.ts`](../extensions/subagents/src/runs/foreground/execution.ts) and [`subagent-runner.ts`](../extensions/subagents/src/runs/background/subagent-runner.ts). Upstream print mode submits the initial and additional prompts, returns an exit code, and disposes the runtime/flushes output in `finally` ([`print-mode.ts#L121-L137`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/modes/print-mode.ts#L121-L137), [`print-mode.ts#L158-L168`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/modes/print-mode.ts#L158-L168)). Consequently, a parent cannot send a later RPC compaction request to today's child before or during its turn. A future prototype needs a dedicated RPC child/control channel or a deliberately loaded child extension; neither is enabled here.

## Safety boundaries

`AgentSession.abort()` is cooperative. It aborts the controller, waits for the active run/listeners, and passes the signal to the provider, `beforeToolCall`, `afterToolCall`, and tool `execute` ([`agent.ts#L313-L329`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/agent/src/agent.ts#L313-L329), [`agent.ts#L486-L535`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/agent/src/agent.ts#L486-L535), [`agent-loop.ts#L281-L312`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/agent/src/agent-loop.ts#L281-L312), [`agent-loop.ts#L600-L710`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/agent/src/agent-loop.ts#L600-L710), [`agent-loop.ts#L724-L736`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/agent/src/agent-loop.ts#L724-L736)). Parallel tool calls are awaited with `Promise.all` before their results are emitted ([`agent-loop.ts#L489-L553`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/agent/src/agent-loop.ts#L489-L553)). Therefore:

- signal-aware tools can stop cooperatively, but a custom tool that ignores `AbortSignal` can continue and make compaction wait;
- abort cannot undo side effects already performed by a tool;
- compaction or interruption must not be attempted across a pending mutation/tool boundary; and
- a force-kill fallback would be process cleanup, not a transactional undo.

## Model and context-cap correctness

The session's compaction checks read the active model's `contextWindow` ([`agent-session.ts#L1962-L1970`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/agent-session.ts#L1962-L1970), [`agent-session.ts#L2045-L2050`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/agent-session.ts#L2045-L2050)); immediately after compaction, context usage can be unknown until a valid post-compaction assistant response ([`agent-session.ts#L3174-L3207`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/agent-session.ts#L3174-L3207)). Resume restores model identity from session history and resolves it against the current registry/auth; missing model or credentials can produce a fallback warning ([`session-manager.ts#L362-L376`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/session-manager.ts#L362-L376), [`sdk.ts#L187-L220`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/sdk.ts#L187-L220), [`model-resolver.ts#L703-L774`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/model-resolver.ts#L703-L774)). A controller must verify the **effective** model, window, credentials, and resolution outcome before intervening.

TLH's 200k context cap is a wrapper-level mutation: it stores original windows in a `WeakMap`, applies on session start/model selection, and restores on shutdown ([`context-cap.ts`](../extensions/the-last-harness/context-cap.ts)). It is not persisted in upstream session JSONL and is not automatically propagated as a cap to separately spawned children. A prototype must independently verify the child’s effective model/window rather than assume the parent cap was inherited.

## Persistence and rollback risk

Upstream compaction is append-only at the logical session level: it appends a `compaction` entry and rebuilds active context from the summary plus retained entries ([`session-manager.ts#L844-L854`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/session-manager.ts#L844-L854), [`session-manager.ts#L1096-L1125`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/session-manager.ts#L1096-L1125), [`compaction.md#L39-L79`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/docs/compaction.md#L39-L79)). The 0.84.1 persistence implementation writes directly: `_rewriteFile()` opens the session with `"w"`, while `_persist()` uses `appendFileSync()` and `_appendEntry()` mutates in-memory indexes before calling it ([`session-manager.ts#L979-L989`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/session-manager.ts#L979-L989), [`session-manager.ts#L1015-L1049`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/session-manager.ts#L1015-L1049)). This path supplies no controller-owned backup, fsync, staged file, atomic rename, or rollback guarantee. A write failure can therefore leave memory ahead of disk or a partially rewritten JSONL file, with no restoration of the prior file shown here. `compaction_end` reports success/error/aborted outcome, but no rollback mechanism ([`agent-session.ts#L1907-L1928`](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/agent-session.ts#L1907-L1928)).

Any intervention prototype must therefore:

1. acquire an exclusive per-session lock and reject/abort on another writer;
2. copy the session file and record its cryptographic hash before any command;
3. write through a staged file, fsync file and directory, then atomically replace only after verification (or treat upstream append-only behavior as insufficient and keep the original untouched until a safe handoff exists);
4. on any failed, cancelled, timed-out, mismatched, or unverifiable result, restore from the backup and verify its hash; and
5. detect and report concurrent-writer changes rather than overwriting them.

## Feasible options

| Option | Benefits | Costs and hazards | Decision |
| --- | --- | --- | --- |
| Keep diagnostics, warnings, and resume gate only | No new child channel or persistence risk; preserves operator control | Does not recover an already-running child near exhaustion | **Current default; recommended now** |
| Opt-in RPC child prototype | Uses upstream session-scoped `compact`/`abort`; enables measured event correlation and controlled experiments | New lifecycle/channel; concurrent RPC races; no pending-tool IDs; needs backup/locking/atomic handoff and fault injection | **Recommend only as separately approved prototype** |
| Automatic compaction/interruption in the existing JSON child | No new mode | Impossible to send RPC through ignored stdin; abort is cooperative; risks mutation side effects and corrupt/partial session persistence | **Reject** |
| Child extension calling `ctx.compact()` | Could stay inside a child session | Fire-and-forget API, extension ordering/error complexity, same persistence and tool-boundary hazards; not an external transactional control | **Defer** |
| Force-kill then resume/fresh dispatch | Bounds a hung tool process | Loses in-flight work, cannot undo side effects, and may leave session/artifact state ambiguous | **Non-goal** |

## Prototype contract (not implemented here)

A separately approved prototype may enter only when all of these are true:

- the operator explicitly opts in and the child is a dedicated persisted `--mode rpc` child;
- the session backup exists and its pre-intervention hash verifies;
- an exclusive session lock proves there is no concurrent writer;
- the effective model, credentials/resolution, and context window are verified (no unexamined fallback);
- context usage is known and measured, not inferred from a peak, cumulative total, or `null` post-compaction value;
- the controller has observed a stable state and there is no pending tool or mutation boundary;
- every request, RPC response, `compaction_start`, `compaction_end`, and child exit is correlated to the same run/request ID; and
- the controller has a defined timeout and can verify the compaction result and session-file hash.

It may exit successfully only after compaction result verification, a valid post-compaction context measurement (or an explicitly recorded “measurement pending” state that cannot trigger another intervention), and durable event/exit recording. On failure, cancellation, timeout, unexpected tool activity, writer change, hash mismatch, malformed response, or child crash, it must restore from the backup, verify rollback, retain the original evidence, and refuse further automatic intervention. The prototype must include hermetic fault-injection tests for partial writes, fsync/rename failure, crash at each persistence phase, ignored `AbortSignal`, concurrent writer detection, RPC reordering, model fallback, and unknown context usage.

## Explicit non-goals

This ticket does not implement a prototype, change child mode, enable `set_auto_compaction`, compact a live or resumed TLH child, mutate session JSONL, add force interruption, promise tool cancellation/undo, infer context usage when it is unknown, propagate the parent cap implicitly, or claim a prevalence rate for #456-like failures. This ticket enables no runtime behavior; its requested artifact is this design note. Generated/runtime changes elsewhere in the approved workflow are outside this ticket and are not evaluated here.

## Recommendation

Keep the shipped diagnostics, live warnings, and durable resume gate as the production intervention boundary. Do not enable automatic compaction/interruption. If the product needs measured experimentation, separately approve a no-default RPC-child prototype that satisfies the entry/exit, backup/hash, lock, model/window, tool-boundary, correlation, rollback, and hermetic fault-injection requirements above before considering any broader automation.
