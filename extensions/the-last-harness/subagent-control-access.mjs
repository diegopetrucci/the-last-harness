/**
 * Process-private read-only bridge for subagent control-target metadata.
 *
 * The subagent extension owns lifecycle state and persistence.  The primary
 * runtime may ask for the role(s) selected by a resume/steer target, but it
 * must not receive the extension state, control inboxes, or nested capability
 * tokens.  A symbol-keyed provider keeps this seam private to the current
 * process and avoids a persisted or public extension context contract.
 */

const CONTROL_TARGET_ACCESS_KEY = Symbol.for("tlh.subagents.control-target-access");

/**
 * @typedef {{ action?: string; id?: string; dir?: string; index?: number }}
 *   SubagentControlTargetRequest
 * @typedef {{ status: "found"; runId?: string; agents: string[] } |
 *   { status: "missing" | "ambiguous" | "opaque" }}
 *   SubagentControlTargetAccess
 * @typedef {(request: SubagentControlTargetRequest) => SubagentControlTargetAccess}
 *   SubagentControlTargetAccessProvider
 */

/**
 * Install the current subagent extension's read-only target lookup provider.
 * Passing undefined removes the provider.
 *
 * @param {SubagentControlTargetAccessProvider | undefined} provider
 * @returns {SubagentControlTargetAccessProvider | undefined}
 */
export function setTlhSubagentControlTargetAccessProvider(provider) {
  if (provider !== undefined && typeof provider !== "function") {
    throw new TypeError("Subagent control-target access provider must be a function.");
  }
  if (provider === undefined) {
    delete globalThis[CONTROL_TARGET_ACCESS_KEY];
  } else {
    globalThis[CONTROL_TARGET_ACCESS_KEY] = provider;
  }
  return provider;
}

/**
 * Remove a provider only when it is still the active provider.  This prevents
 * an older extension reload cleanup from clearing a newer registration.
 *
 * @param {SubagentControlTargetAccessProvider} provider
 */
export function clearTlhSubagentControlTargetAccessProvider(provider) {
  if (globalThis[CONTROL_TARGET_ACCESS_KEY] === provider) {
    delete globalThis[CONTROL_TARGET_ACCESS_KEY];
  }
}

/**
 * Read target metadata from the active subagent extension, if one is present.
 * Provider failures are intentionally opaque: the primary runtime must retain
 * existing behavior when no authoritative role metadata is available.
 *
 * @param {SubagentControlTargetRequest} request
 * @returns {SubagentControlTargetAccess | undefined}
 */
export function getTlhSubagentControlTargetAccess(request) {
  const provider = globalThis[CONTROL_TARGET_ACCESS_KEY];
  if (typeof provider !== "function") return undefined;
  try {
    return provider(request);
  } catch {
    return undefined;
  }
}
