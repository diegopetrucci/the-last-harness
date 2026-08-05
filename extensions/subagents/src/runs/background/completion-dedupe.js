function asNonEmptyString(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function asFiniteNumber(value) {
    if (typeof value !== "number")
        return undefined;
    return Number.isFinite(value) ? value : undefined;
}
export function buildCompletionKey(data, fallback) {
    const id = asNonEmptyString(data.id);
    if (id)
        return `id:${id}`;
    const sessionId = asNonEmptyString(data.sessionId) ?? "no-session";
    const agent = asNonEmptyString(data.agent) ?? "unknown";
    const timestamp = asFiniteNumber(data.timestamp);
    const taskIndex = asFiniteNumber(data.taskIndex);
    const totalTasks = asFiniteNumber(data.totalTasks);
    const success = typeof data.success === "boolean" ? (data.success ? "1" : "0") : "?";
    return [
        "meta",
        sessionId,
        agent,
        timestamp !== undefined ? String(timestamp) : "no-ts",
        taskIndex !== undefined ? String(taskIndex) : "-",
        totalTasks !== undefined ? String(totalTasks) : "-",
        success,
        fallback,
    ].join(":");
}
function pruneSeenMap(seen, now, ttlMs) {
    for (const [key, ts] of seen.entries()) {
        if (now - ts > ttlMs)
            seen.delete(key);
    }
}
export function markSeenWithTtl(seen, key, now, ttlMs) {
    pruneSeenMap(seen, now, ttlMs);
    if (seen.has(key))
        return true;
    seen.set(key, now);
    return false;
}
export function getGlobalSeenMap(storeKey) {
    const globalStore = globalThis;
    const existing = globalStore[storeKey];
    if (existing instanceof Map)
        return existing;
    const map = new Map();
    globalStore[storeKey] = map;
    return map;
}
