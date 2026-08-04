export function resolveCurrentSessionId(sessionManager) {
    const sessionId = sessionManager.getSessionFile() ?? sessionManager.getSessionId();
    if (!sessionId)
        throw new Error("Current session identity is unavailable.");
    return sessionId;
}
