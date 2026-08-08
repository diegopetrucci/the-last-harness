export const MAX_NODE_TIMEOUT_DELAY_MS = 2_147_483_647;
function unrefTimeout(handle) {
    if (!handle || typeof handle !== "object" || !("unref" in handle))
        return;
    handle.unref();
}
export function scheduleDeadline(deadlineAt, onDeadline, options = {}) {
    const now = options.now ?? Date.now;
    const schedule = options.setTimeout ?? ((handler, delayMs) => setTimeout(handler, delayMs));
    const clear = options.clearTimeout ?? clearTimeout;
    let handle;
    let cancelled = false;
    let fired = false;
    const arm = () => {
        if (cancelled || fired)
            return;
        const remainingMs = deadlineAt - now();
        if (remainingMs <= 0) {
            handle = schedule(() => {
                handle = undefined;
                if (cancelled || fired)
                    return;
                fired = true;
                onDeadline();
            }, 0);
            unrefTimeout(handle);
            return;
        }
        handle = schedule(() => {
            handle = undefined;
            arm();
        }, Math.min(remainingMs, MAX_NODE_TIMEOUT_DELAY_MS));
        unrefTimeout(handle);
    };
    arm();
    return {
        cancel() {
            if (cancelled)
                return;
            cancelled = true;
            if (handle !== undefined) {
                clear(handle);
                handle = undefined;
            }
        },
    };
}
