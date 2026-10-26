// Generated from extensions/subagents/src/shared/session-identity.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
export function resolveCurrentSessionId(sessionManager) {
    const sessionId = sessionManager.getSessionFile() ?? sessionManager.getSessionId();
    if (!sessionId)
        throw new Error("Current session identity is unavailable.");
    return sessionId;
}
export function resolveProjectAgentSessionId(sessionManager) {
    try {
        const sessionId = sessionManager.getSessionId();
        return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
    }
    catch {
        return null;
    }
}
