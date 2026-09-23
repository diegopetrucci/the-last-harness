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
    return undefined;
  }
}
