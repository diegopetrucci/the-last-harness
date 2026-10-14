interface SessionIdentityManager {
  getSessionFile(): string | null | undefined;
  getSessionId(): string | null | undefined;
}

export function resolveCurrentSessionId(sessionManager: SessionIdentityManager): string {
  const sessionId = sessionManager.getSessionFile() ?? sessionManager.getSessionId();
  if (!sessionId) throw new Error("Current session identity is unavailable.");
  return sessionId;
}

// Project-agent snapshots are stamped with the session UUID (see sessionIdForContext in
// extensions/the-last-harness/primary-agent-runtime-boundaries.ts), so this must stay aligned
// with it. resolveCurrentSessionId remains the async-run ownership key.
export function resolveProjectAgentSessionId(
  sessionManager: Pick<SessionIdentityManager, "getSessionId">,
): string | null {
  try {
    const sessionId = sessionManager.getSessionId();
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
  } catch {
    return null;
  }
}
