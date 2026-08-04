export function trySignalChild(child, signal) {
    try {
        return child.kill(signal);
    }
    catch {
        return false;
    }
}
export function attachPostExitStdioGuard(child, options) {
    const { idleMs, hardMs } = options;
    let exited = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    let idleTimer;
    let hardTimer;
    const destroyUnendedStdio = () => {
        if (!stdoutEnded) {
            try {
                child.stdout?.destroy();
            }
            catch {
                void 0;
            }
        }
        if (!stderrEnded) {
            try {
                child.stderr?.destroy();
            }
            catch {
                void 0;
            }
        }
    };
    const clearTimers = () => {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = undefined;
        }
        if (hardTimer) {
            clearTimeout(hardTimer);
            hardTimer = undefined;
        }
    };
    const armIdleTimer = () => {
        if (!exited)
            return;
        if (idleTimer)
            clearTimeout(idleTimer);
        idleTimer = setTimeout(destroyUnendedStdio, idleMs);
        idleTimer.unref?.();
    };
    child.stdout?.on("data", armIdleTimer);
    child.stderr?.on("data", armIdleTimer);
    child.stdout?.on("end", () => {
        stdoutEnded = true;
        if (stdoutEnded && stderrEnded)
            clearTimers();
    });
    child.stderr?.on("end", () => {
        stderrEnded = true;
        if (stdoutEnded && stderrEnded)
            clearTimers();
    });
    child.on("exit", () => {
        exited = true;
        armIdleTimer();
        if (hardTimer)
            return;
        hardTimer = setTimeout(destroyUnendedStdio, hardMs);
        hardTimer.unref?.();
    });
    child.on("close", clearTimers);
    child.on("error", clearTimers);
    return clearTimers;
}
