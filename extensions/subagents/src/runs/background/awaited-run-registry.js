const awaitedRuns = new Map();
export function registerAwaitedRun(runId, onCompletion, generation, onDispose, onCompletionGuard, onSuperseded) {
    const previous = awaitedRuns.get(runId);
    const token = Symbol("awaited-run-registration");
    awaitedRuns.set(runId, {
        token,
        ...(generation !== undefined ? { generation } : {}),
        ...(onCompletion ? { onCompletion } : {}),
        ...(onCompletionGuard ? { onCompletionGuard } : {}),
        ...(onDispose ? { onDispose } : {}),
        ...(onSuperseded ? { onSuperseded } : {}),
    });
    if (previous?.onSuperseded) {
        try {
            previous.onSuperseded();
        }
        catch (error) {
            console.error(`[pi-subagents] awaited run owner supersession failed for '${runId}':`, error);
        }
    }
    return token;
}
export function isAwaitedRunOwner(runId, token) {
    return awaitedRuns.get(runId)?.token === token;
}
export function isAwaitedRun(runId) {
    return awaitedRuns.has(runId);
}
export function disposeAwaitedRuns() {
    const registrations = [];
    awaitedRuns.forEach((registration) => registrations.push(registration));
    for (const registration of registrations) {
        if (!registration.onDispose)
            continue;
        try {
            registration.onDispose();
        }
        catch (error) {
            console.error("[pi-subagents] awaited run owner disposal failed:", error);
        }
    }
}
function explicitGeneration(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const record = value;
    const direct = record.generation;
    if (typeof direct === "number" && Number.isSafeInteger(direct) && direct >= 0)
        return direct;
    const lifecycle = record.lifecycle;
    if (typeof lifecycle !== "object" || lifecycle === null || Array.isArray(lifecycle))
        return undefined;
    const nested = lifecycle.generation;
    return typeof nested === "number" && Number.isSafeInteger(nested) && nested >= 0
        ? nested
        : undefined;
}
export function dispatchAwaitedRunCompletion(runId, data) {
    const registration = awaitedRuns.get(runId);
    const handler = registration?.onCompletion;
    if (!handler)
        return false;
    try {
        const generation = explicitGeneration(data);
        if (generation === undefined)
            return false;
        const accepted = registration.onCompletionGuard
            ? registration.onCompletionGuard(data)
            : registration.generation !== undefined && generation === registration.generation;
        if (!accepted)
            return false;
        return handler(data) === true;
    }
    catch (error) {
        console.error(`[pi-subagents] awaited completion handler failed for '${runId}':`, error);
        return false;
    }
}
export function unregisterAwaitedRun(runId, generation, token) {
    const registration = awaitedRuns.get(runId);
    if (!registration)
        return;
    if (generation !== undefined && registration.generation !== generation)
        return;
    if (token !== undefined && registration.token !== token)
        return;
    awaitedRuns.delete(runId);
}
