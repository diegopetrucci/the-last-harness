export function registerForegroundInterrupt(control, key, interrupt) {
    if (!control)
        return;
    control.activeInterrupts ??= new Map();
    control.activeInterrupts.set(key, interrupt);
    control.interrupt = () => {
        const activeInterrupts = Array.from(control.activeInterrupts?.values() ?? []);
        if (activeInterrupts.length === 0)
            return false;
        let interrupted = false;
        for (const callback of activeInterrupts)
            interrupted = callback() || interrupted;
        if (interrupted) {
            control.currentActivityState = undefined;
            control.updatedAt = Date.now();
        }
        return interrupted;
    };
}
export function clearForegroundInterrupt(control, key) {
    if (!control?.activeInterrupts)
        return;
    control.activeInterrupts.delete(key);
    if (control.activeInterrupts.size > 0)
        return;
    control.activeInterrupts = undefined;
    control.interrupt = undefined;
}
