const INT_GRACE_MS = 1000;
const TERM_GRACE_MS = 2000;
const KILL_GRACE_MS = 1000;
const POLL_MS = 100;
const MAX_WARNINGS = 4;
const MAX_WARNING_BYTES = 512;
const POSIX_PLATFORMS = new Set([
    "aix",
    "android",
    "cygwin",
    "darwin",
    "freebsd",
    "haiku",
    "linux",
    "netbsd",
    "openbsd",
    "sunos",
]);
export const PROCESS_GROUP_CLEANUP_MAX_WAIT_MS = INT_GRACE_MS + TERM_GRACE_MS + KILL_GRACE_MS;
const ownerRecords = new WeakMap();
export function createOwnedProcessGroupOwner(child) {
    const processGroupId = child.pid;
    if (!positivePid(processGroupId))
        return undefined;
    const owner = {
        processGroupId,
        isLive: () => child.pid === processGroupId && child.exitCode === null && child.signalCode === null,
        observeExit: (observedPid = child.pid) => {
            const record = ownerRecords.get(owner);
            if (!record ||
                record.consumed ||
                observedPid !== processGroupId ||
                child.pid !== processGroupId ||
                (child.exitCode === null && child.signalCode === null))
                return false;
            record.observedExit = true;
            return true;
        },
    };
    ownerRecords.set(owner, { child, observedExit: false, consumed: false });
    return Object.freeze(owner);
}
const positivePid = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const errorCode = (error) => typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
function warning(value) {
    if (Buffer.byteLength(value, "utf8") <= MAX_WARNING_BYTES)
        return value;
    const suffix = "…";
    let result = Buffer.from(value, "utf8")
        .subarray(0, MAX_WARNING_BYTES - Buffer.byteLength(suffix, "utf8"))
        .toString("utf8");
    while (Buffer.byteLength(result, "utf8") + Buffer.byteLength(suffix, "utf8") > MAX_WARNING_BYTES)
        result = result.slice(0, -1);
    return `${result}${suffix}`;
}
function addWarning(warnings, value) {
    if (warnings.length < MAX_WARNINGS)
        warnings.push(value);
    else
        warnings[warnings.length - 1] = value;
}
function ownerRecord(pid, owner) {
    const record = owner && owner.processGroupId === pid ? ownerRecords.get(owner) : undefined;
    return record?.child.pid === pid ? record : undefined;
}
function claimOwner(pid, owner) {
    const record = ownerRecord(pid, owner);
    if (!owner || !record || record.consumed)
        return false;
    try {
        if (!owner.isLive() && !record.observedExit)
            return false;
        record.consumed = true;
        return true;
    }
    catch {
        return false;
    }
}
const hasClaimedOwner = (pid, owner) => ownerRecord(pid, owner)?.consumed === true;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function probe(pid, kill, owner) {
    if (!hasClaimedOwner(pid, owner))
        return "unknown";
    try {
        kill(-pid, 0);
        return "alive";
    }
    catch (error) {
        const code = errorCode(error);
        if (code === "ESRCH")
            return "dead";
        return code === "EPERM" ? "alive" : "unknown";
    }
}
function directOwnerChildIsLive(pid, owner) {
    if (!hasClaimedOwner(pid, owner))
        return false;
    try {
        return owner.isLive();
    }
    catch {
        return false;
    }
}
function send(pid, signal, kill, owner, platform) {
    if (!hasClaimedOwner(pid, owner))
        return { sent: false, warning: `Could not verify ownership before sending ${signal}.` };
    try {
        return { sent: kill(-pid, signal) };
    }
    catch (error) {
        const code = errorCode(error);
        if (code === "ESRCH")
            return { sent: false, alreadyGone: true };
        if (code === "EPERM" && platform === "darwin" && directOwnerChildIsLive(pid, owner)) {
            try {
                if (kill(pid, signal)) {
                    return {
                        sent: true,
                        warning: `Failed to send ${signal} to the owned child process group; sent ${signal} directly to the live owned child.`,
                    };
                }
            }
            catch {
            }
            return {
                sent: false,
                warning: `Failed to send ${signal} to the owned child process group and its live owned child.`,
            };
        }
        return { sent: false, warning: `Failed to send ${signal} to the owned child process group.` };
    }
}
async function waitForExit(pid, waitMs, deps, owner) {
    const kill = deps.kill ?? process.kill.bind(process);
    const now = deps.now ?? Date.now;
    const deadline = now() + Math.max(0, waitMs);
    while (now() < deadline) {
        const state = probe(pid, kill, owner);
        if (state !== "alive")
            return state;
        await (deps.sleep ?? sleep)(Math.max(1, Math.min(deps.pollMs ?? POLL_MS, deadline - now())));
    }
    return probe(pid, kill, owner);
}
export function supportsOwnedProcessGroupCleanup(platform = process.platform) {
    return POSIX_PLATFORMS.has(platform);
}
export function normalizeChildProcessCleanup(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const record = value;
    if (!["supported", "attempted", "terminated"].every((key) => typeof record[key] === "boolean"))
        return undefined;
    const processGroupId = record.processGroupId;
    if (processGroupId !== undefined && !positivePid(processGroupId))
        return undefined;
    const optionalBoolean = (candidate) => candidate === undefined || typeof candidate === "boolean";
    if (!optionalBoolean(record.liveProcessesDetected) || !optionalBoolean(record.escalatedToSigkill))
        return undefined;
    const signals = record.signals;
    if (signals !== undefined &&
        (!Array.isArray(signals) ||
            signals.length > 3 ||
            !signals.every((signal) => ["SIGINT", "SIGTERM", "SIGKILL"].includes(String(signal)))))
        return undefined;
    const skippedReason = record.skippedReason;
    if (skippedReason !== undefined &&
        !["soft_pause", "unsupported_platform", "process_group_unavailable"].includes(String(skippedReason)))
        return undefined;
    const warnings = record.warnings;
    if (warnings !== undefined &&
        (!Array.isArray(warnings) ||
            warnings.length > MAX_WARNINGS ||
            !warnings.every((item) => typeof item === "string")))
        return undefined;
    return {
        supported: record.supported,
        attempted: record.attempted,
        terminated: record.terminated,
        ...(processGroupId !== undefined ? { processGroupId: processGroupId } : {}),
        ...(record.liveProcessesDetected !== undefined
            ? { liveProcessesDetected: record.liveProcessesDetected }
            : {}),
        ...(record.escalatedToSigkill !== undefined
            ? { escalatedToSigkill: record.escalatedToSigkill }
            : {}),
        ...(signals !== undefined
            ? { signals: [...signals] }
            : {}),
        ...(skippedReason !== undefined
            ? { skippedReason: skippedReason }
            : {}),
        ...(warnings !== undefined
            ? { warnings: warnings.map((item) => warning(item)) }
            : {}),
    };
}
export function skipOwnedProcessGroupCleanup(reason, processGroupId, supported = supportsOwnedProcessGroupCleanup()) {
    return {
        supported,
        attempted: false,
        terminated: false,
        ...(positivePid(processGroupId) ? { processGroupId } : {}),
        skippedReason: reason,
    };
}
function unavailable(processGroupId) {
    return {
        supported: true,
        attempted: false,
        processGroupId,
        terminated: false,
        skippedReason: "process_group_unavailable",
        warnings: ["Could not verify ownership of the child process group; no signal was sent."],
    };
}
export async function cleanupOwnedProcessGroup(processGroupId, deps = {}) {
    const platform = deps.platform ?? process.platform;
    if (!supportsOwnedProcessGroupCleanup(platform))
        return skipOwnedProcessGroupCleanup("unsupported_platform", processGroupId, false);
    if (!positivePid(processGroupId))
        return skipOwnedProcessGroupCleanup("process_group_unavailable", undefined, true);
    const owner = deps.owner;
    if (!owner || !claimOwner(processGroupId, owner))
        return unavailable(processGroupId);
    const phases = [
        ["SIGINT", deps.intWaitMs ?? INT_GRACE_MS],
        ["SIGTERM", deps.termWaitMs ?? TERM_GRACE_MS],
        ["SIGKILL", deps.killWaitMs ?? KILL_GRACE_MS],
    ];
    const signals = [];
    const warnings = [];
    let liveProcessesDetected = false;
    let escalatedToSigkill = false;
    const kill = deps.kill ?? process.kill.bind(process);
    const result = (terminated) => ({
        supported: true,
        attempted: true,
        processGroupId,
        liveProcessesDetected,
        terminated,
        ...(escalatedToSigkill ? { escalatedToSigkill: true } : {}),
        ...(signals.length ? { signals } : {}),
        ...(warnings.length ? { warnings: warnings.map(warning) } : {}),
    });
    const initial = probe(processGroupId, kill, owner);
    liveProcessesDetected = initial === "alive";
    if (initial === "dead")
        return result(true);
    if (initial === "unknown")
        return unavailable(processGroupId);
    for (const [signal, waitMs] of phases.slice(deps.firstSignal === "SIGTERM" ? 1 : 0)) {
        if (signal === "SIGKILL")
            escalatedToSigkill = true;
        const sent = send(processGroupId, signal, kill, owner, platform);
        if (sent.sent)
            signals.push(signal);
        if (sent.warning)
            addWarning(warnings, sent.warning);
        if (sent.alreadyGone)
            return result(true);
        const state = sent.sent
            ? await waitForExit(processGroupId, waitMs, deps, owner)
            : probe(processGroupId, kill, owner);
        if (state === "dead")
            return result(true);
        if (state === "unknown") {
            addWarning(warnings, "Could not verify child process-group ownership; stopping escalation.");
            return result(false);
        }
        if (signal !== "SIGKILL")
            addWarning(warnings, `Owned child processes remained after ${signal}; escalating cleanup.`);
    }
    addWarning(warnings, "Owned child process cleanup could not be confirmed after SIGKILL.");
    return result(false);
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
