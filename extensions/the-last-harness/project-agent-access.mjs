import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Process-local bridge for host-owned project-agent authorization.
 *
 * The executor resolves the fixed project-agent file itself. This bridge only
 * supplies the current primary-agent role and persisted trust-store factory;
 * no prompt snapshot or run-control state crosses this boundary.
 */

let activeProjectAgentAccessProvider;

/** @param {((request: unknown) => unknown) | undefined} provider */
export function setTlhProjectAgentAccessProvider(provider) {
  activeProjectAgentAccessProvider = typeof provider === "function" ? provider : undefined;
}

/** @param {unknown} request @returns {unknown} */
export function getTlhProjectAgentAccess(request) {
  const provider = activeProjectAgentAccessProvider;
  if (!provider) return undefined;
  try {
    return provider(request);
  } catch {
    // An unavailable bridge is never permission to execute a project agent.
    // Return a restricted deny (not undefined) so executor-enforced Rush
    // resume/steer restrictions cannot read a broken bridge as "no bridge".
    return {
      architect: false,
      canManage: false,
      canInitiate: false,
      controlRestrictedToEmbedded: true,
    };
  }
}

/**
 * Invocation-bound embedded-only restriction (Rush resume/steer).
 *
 * The primary-agent hook marks the tool call; the subagent tool captures the
 * mark at execute start and carries it in async-local scope, so no later
 * provider read can lift it. Restriction is evaluated from the primary
 * selection at hook time (main parity: a selection switch before the hook runs
 * is accepted, tracked as a follow-up).
 *
 * Providers may repeat a toolCallId, so state is per-id START/END accounting
 * for EVERY subagent call, not per-mark. Invariant: pi-agent-core emits one
 * `tool_execution_start` (before validation and any hook) and exactly one
 * `tool_execution_end` (executed, blocked, invalid, errored or aborted) per
 * call. An id's mark is cleared only when every started same-id execution has
 * ended (ended >= started), at which point all state for the id is deleted.
 * A same-id sibling ending early (blocked by any earlier/later extension,
 * schema failure, capacity refusal) therefore cannot lift a pending call's
 * restriction. A mark for an id with no recorded start is kept until a
 * matching end arrives. An unmarked call sharing an id with a marked one is
 * over-restricted (fail closed). The number of marked ids is bounded and never
 * evicted; at capacity marking fails and the hook blocks the call. Unmarked
 * entries exist only while a call is in flight.
 */
const MAX_EMBEDDED_ONLY_MARKED_IDS = 256;
/** @type {Map<string, {started: number, ended: number, marked: boolean}>} */
const subagentExecutions = new Map();
let markedIds = 0;
const invocationScope = new AsyncLocalStorage();

/** @param {string} id */
function executionEntry(id) {
  let entry = subagentExecutions.get(id);
  if (!entry) {
    entry = { started: 0, ended: 0, marked: false };
    subagentExecutions.set(id, entry);
  }
  return entry;
}

/** Record `tool_execution_start` for a subagent call. @param {unknown} toolCallId */
export function noteSubagentToolExecutionStart(toolCallId) {
  if (typeof toolCallId !== "string") return;
  executionEntry(toolCallId).started += 1;
}

/**
 * Record `tool_execution_end` for a subagent call; clears the id's state once
 * no same-id execution is outstanding. @param {unknown} toolCallId
 */
export function noteSubagentToolExecutionEnd(toolCallId) {
  if (typeof toolCallId !== "string") return;
  const entry = subagentExecutions.get(toolCallId);
  if (!entry) return;
  entry.ended += 1;
  if (entry.ended < entry.started) return;
  if (entry.marked) markedIds -= 1;
  subagentExecutions.delete(toolCallId);
}

/** @param {unknown} toolCallId @returns {boolean} false when the id is unusable or the registry is full */
export function markEmbeddedOnlyToolCall(toolCallId) {
  if (typeof toolCallId !== "string" || toolCallId === "") return false;
  const existing = subagentExecutions.get(toolCallId);
  if (existing?.marked) return true;
  // Fail closed: never evict an outstanding mark (that would lift its
  // restriction); the caller must block the call instead.
  if (markedIds >= MAX_EMBEDDED_ONLY_MARKED_IDS) return false;
  executionEntry(toolCallId).marked = true;
  markedIds += 1;
  return true;
}

/** @param {unknown} toolCallId */
export function isEmbeddedOnlyToolCall(toolCallId) {
  return typeof toolCallId === "string" && subagentExecutions.get(toolCallId)?.marked === true;
}

/** Number of ids with live accounting state (0 once every call has ended). */
export function subagentExecutionAccountingSize() {
  return subagentExecutions.size;
}

/**
 * Run `fn` bound to one tool invocation: the restriction is captured now from
 * the registry. It is NOT released here; `tool_execution_end` accounting owns release.
 * @template T
 * @param {unknown} toolCallId @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export function runBoundToToolCall(toolCallId, fn) {
  const embeddedOnly = isEmbeddedOnlyToolCall(toolCallId);
  return invocationScope.run({ embeddedOnly }, fn);
}

/** True when the current invocation was marked embedded-only by the hook. */
export function isCurrentInvocationEmbeddedOnly() {
  return invocationScope.getStore()?.embeddedOnly === true;
}
