export const DEFAULT_COMPLETION_BATCH_CONFIG = {
    enabled: true,
    debounceMs: 150,
    maxWaitMs: 1000,
    stragglerDebounceMs: 75,
    stragglerMaxWaitMs: 400,
    stragglerWindowMs: 2000,
};
function parsePositiveInt(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1)
        return undefined;
    return value;
}
export function resolveCompletionBatchConfig(config) {
    const enabled = typeof config?.enabled === "boolean" ? config.enabled : DEFAULT_COMPLETION_BATCH_CONFIG.enabled;
    return {
        enabled,
        debounceMs: parsePositiveInt(config?.debounceMs) ?? DEFAULT_COMPLETION_BATCH_CONFIG.debounceMs,
        maxWaitMs: parsePositiveInt(config?.maxWaitMs) ?? DEFAULT_COMPLETION_BATCH_CONFIG.maxWaitMs,
        stragglerDebounceMs: parsePositiveInt(config?.stragglerDebounceMs) ??
            DEFAULT_COMPLETION_BATCH_CONFIG.stragglerDebounceMs,
        stragglerMaxWaitMs: parsePositiveInt(config?.stragglerMaxWaitMs) ??
            DEFAULT_COMPLETION_BATCH_CONFIG.stragglerMaxWaitMs,
        stragglerWindowMs: parsePositiveInt(config?.stragglerWindowMs) ??
            DEFAULT_COMPLETION_BATCH_CONFIG.stragglerWindowMs,
    };
}
const defaultTimers = {
    setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
};
function unrefHandle(handle) {
    if (handle &&
        typeof handle === "object" &&
        "unref" in handle &&
        typeof handle.unref === "function") {
        handle.unref();
    }
}
export function createCompletionBatcher(options) {
    const timers = options.timers ?? defaultTimers;
    const now = options.now ?? Date.now;
    const config = options.config;
    if (!config.enabled) {
        return {
            push(item) {
                options.emit([item]);
            },
            flush() { },
            dispose() { },
        };
    }
    let pending = [];
    let debounceTimer = null;
    let maxWaitTimer = null;
    let straggler = false;
    let lastEmitAt = null;
    const clearTimers = () => {
        if (debounceTimer) {
            timers.clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        if (maxWaitTimer) {
            timers.clearTimeout(maxWaitTimer);
            maxWaitTimer = null;
        }
    };
    const emitGroup = () => {
        clearTimers();
        if (pending.length === 0)
            return;
        const items = pending;
        pending = [];
        lastEmitAt = now();
        options.emit(items);
    };
    return {
        push(item) {
            if (pending.length === 0) {
                straggler = lastEmitAt !== null && now() - lastEmitAt < config.stragglerWindowMs;
            }
            pending.push(item);
            if (debounceTimer)
                timers.clearTimeout(debounceTimer);
            const debounceDelay = straggler ? config.stragglerDebounceMs : config.debounceMs;
            debounceTimer = timers.setTimeout(emitGroup, debounceDelay);
            unrefHandle(debounceTimer);
            if (!maxWaitTimer) {
                const maxWaitDelay = straggler ? config.stragglerMaxWaitMs : config.maxWaitMs;
                maxWaitTimer = timers.setTimeout(emitGroup, maxWaitDelay);
                unrefHandle(maxWaitTimer);
            }
        },
        flush: emitGroup,
        dispose() {
            clearTimers();
            pending = [];
        },
    };
}
