const PROCESS_GROUP_INT_GRACE_MS = 1000;
const PROCESS_GROUP_TERM_GRACE_MS = 2000;
const PROCESS_GROUP_KILL_GRACE_MS = 1000;
const PROCESS_GROUP_POLL_MS = 100;
function isMissingProcessError(error) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH");
}
function isPermissionError(error) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EPERM");
}
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
function probeProcessGroup(processGroupId, kill) {
    try {
        kill(-processGroupId, 0);
        return true;
    }
    catch (error) {
        if (isMissingProcessError(error))
            return false;
        if (isPermissionError(error))
            return true;
        return true;
    }
}
function signalProcessGroup(processGroupId, signal, kill) {
    try {
        return { sent: kill(-processGroupId, signal) };
    }
    catch (error) {
        if (isMissingProcessError(error))
            return { sent: false };
        return { sent: false, warning: `Failed to send ${signal} to the owned child process group.` };
    }
}
async function waitForProcessGroupExit(processGroupId, waitMs, deps) {
    const kill = deps.kill ?? process.kill.bind(process);
    const pollMs = deps.pollMs ?? PROCESS_GROUP_POLL_MS;
    const wait = deps.sleep ?? sleep;
    const now = deps.now ?? Date.now;
    const deadline = now() + Math.max(0, waitMs);
    while (now() < deadline) {
        if (!probeProcessGroup(processGroupId, kill))
            return true;
        await wait(Math.min(pollMs, Math.max(1, deadline - now())));
    }
    return !probeProcessGroup(processGroupId, kill);
}
export function supportsOwnedProcessGroupCleanup(platform = process.platform) {
    return platform !== "win32";
}
export function skipOwnedProcessGroupCleanup(reason, processGroupId, supported = supportsOwnedProcessGroupCleanup()) {
    return {
        supported,
        attempted: false,
        terminated: false,
        ...(processGroupId ? { processGroupId } : {}),
        skippedReason: reason,
    };
}
export async function cleanupOwnedProcessGroup(processGroupId, deps = {}) {
    const kill = deps.kill ?? process.kill.bind(process);
    const warnings = [];
    const signals = [];
    const liveProcessesDetected = probeProcessGroup(processGroupId, kill);
    if (!liveProcessesDetected) {
        return {
            supported: true,
            attempted: true,
            processGroupId,
            liveProcessesDetected: false,
            terminated: true,
        };
    }
    for (const phase of [
        { signal: "SIGINT", waitMs: deps.intWaitMs ?? PROCESS_GROUP_INT_GRACE_MS },
        { signal: "SIGTERM", waitMs: deps.termWaitMs ?? PROCESS_GROUP_TERM_GRACE_MS },
        { signal: "SIGKILL", waitMs: deps.killWaitMs ?? PROCESS_GROUP_KILL_GRACE_MS },
    ]) {
        const sent = signalProcessGroup(processGroupId, phase.signal, kill);
        if (sent.sent)
            signals.push(phase.signal);
        if (sent.warning)
            warnings.push(sent.warning);
        const terminated = sent.sent
            ? await waitForProcessGroupExit(processGroupId, phase.waitMs, { ...deps, kill })
            : !probeProcessGroup(processGroupId, kill);
        if (terminated) {
            return {
                supported: true,
                attempted: true,
                processGroupId,
                liveProcessesDetected: true,
                terminated: true,
                ...(phase.signal === "SIGKILL" ? { escalatedToSigkill: true } : {}),
                ...(signals.length ? { signals } : {}),
                ...(warnings.length ? { warnings } : {}),
            };
        }
        if (phase.signal !== "SIGKILL")
            warnings.push(`Owned child processes remained after ${phase.signal}; escalating cleanup.`);
    }
    warnings.push("Owned child process cleanup could not be confirmed after SIGKILL.");
    return {
        supported: true,
        attempted: true,
        liveProcessesDetected: true,
        terminated: false,
        escalatedToSigkill: true,
        ...(signals.length ? { signals } : {}),
        warnings,
    };
}
export function formatOwnedProcessGroupCleanup(cleanup) {
    if (cleanup.skippedReason === "soft_pause")
        return "Process cleanup skipped for soft-paused run.";
    if (cleanup.skippedReason === "unsupported_platform")
        return "Owned process cleanup is unavailable on this platform.";
    if (cleanup.skippedReason === "process_group_unavailable")
        return "Owned process cleanup is unavailable because no verified child process group was tracked.";
    if (cleanup.terminated && cleanup.liveProcessesDetected === false)
        return "The owned child process group had no live processes to clean up.";
    if (cleanup.terminated && cleanup.escalatedToSigkill)
        return "Cleaned up the owned child process group after escalating through SIGKILL.";
    if (cleanup.terminated && cleanup.signals?.includes("SIGTERM"))
        return "Cleaned up the owned child process group after escalating through SIGTERM.";
    if (cleanup.terminated)
        return "Cleaned up the owned child process group with SIGINT.";
    if (cleanup.escalatedToSigkill)
        return "Cleanup escalated through SIGKILL, but owned child process exit could not be confirmed.";
    return "Owned child process cleanup could not be confirmed.";
}
