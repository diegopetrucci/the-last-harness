const defaultTimerApi = {
    setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
};
export function createFileCoalescer(handler, defaultDelayMs, timerApi = defaultTimerApi) {
    const pending = new Map();
    return {
        schedule(file, delayMs = defaultDelayMs) {
            if (pending.has(file))
                return false;
            const timer = timerApi.setTimeout(() => {
                pending.delete(file);
                handler(file);
            }, delayMs);
            pending.set(file, timer);
            return true;
        },
        clear() {
            for (const timer of pending.values()) {
                timerApi.clearTimeout(timer);
            }
            pending.clear();
        },
    };
}
