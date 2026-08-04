import type { ChildProcessCleanupResult, ChildProcessCleanupSkippedReason } from "../../shared/types.ts";

const PROCESS_GROUP_INT_GRACE_MS = 1000;
const PROCESS_GROUP_TERM_GRACE_MS = 2000;
const PROCESS_GROUP_KILL_GRACE_MS = 1000;
const PROCESS_GROUP_POLL_MS = 100;

type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

interface CleanupOwnedProcessGroupDeps {
	kill?: KillFn;
	sleep?: (ms: number) => Promise<void>;
	intWaitMs?: number;
	termWaitMs?: number;
	killWaitMs?: number;
	pollMs?: number;
	now?: () => number;
}

function isMissingProcessError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ESRCH";
}

function isPermissionError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "EPERM";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

function probeProcessGroup(processGroupId: number, kill: KillFn): boolean {
	try {
		kill(-processGroupId, 0);
		return true;
	} catch (error) {
		if (isMissingProcessError(error)) return false;
		// EPERM means the group is still present but cannot safely be controlled.
		if (isPermissionError(error)) return true;
		// Unknown probe failures must fail closed rather than claim cleanup.
		return true;
	}
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals, kill: KillFn): { sent: boolean; warning?: string } {
	try {
		return { sent: kill(-processGroupId, signal) };
	} catch (error) {
		if (isMissingProcessError(error)) return { sent: false };
		return { sent: false, warning: `Failed to send ${signal} to the owned child process group.` };
	}
}

async function waitForProcessGroupExit(
	processGroupId: number,
	waitMs: number,
	deps: CleanupOwnedProcessGroupDeps,
): Promise<boolean> {
	const kill = deps.kill ?? process.kill.bind(process);
	const pollMs = deps.pollMs ?? PROCESS_GROUP_POLL_MS;
	const wait = deps.sleep ?? sleep;
	const now = deps.now ?? Date.now;
	const deadline = now() + Math.max(0, waitMs);
	while (now() < deadline) {
		if (!probeProcessGroup(processGroupId, kill)) return true;
		await wait(Math.min(pollMs, Math.max(1, deadline - now())));
	}
	return !probeProcessGroup(processGroupId, kill);
}

export function supportsOwnedProcessGroupCleanup(platform = process.platform): boolean {
	return platform !== "win32";
}

export function skipOwnedProcessGroupCleanup(
	reason: ChildProcessCleanupSkippedReason,
	processGroupId?: number,
	supported = supportsOwnedProcessGroupCleanup(),
): ChildProcessCleanupResult {
	return {
		supported,
		attempted: false,
		terminated: false,
		...(processGroupId ? { processGroupId } : {}),
		skippedReason: reason,
	};
}

/**
 * Stops a process group created by this execution. Callers must never pass a
 * persisted or otherwise unverified pid: the group id must come directly from
 * the detached child returned by spawn().
 */
export async function cleanupOwnedProcessGroup(
	processGroupId: number,
	deps: CleanupOwnedProcessGroupDeps = {},
): Promise<ChildProcessCleanupResult> {
	const kill = deps.kill ?? process.kill.bind(process);
	const warnings: string[] = [];
	const signals: Array<"SIGINT" | "SIGTERM" | "SIGKILL"> = [];
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
		{ signal: "SIGINT" as const, waitMs: deps.intWaitMs ?? PROCESS_GROUP_INT_GRACE_MS },
		{ signal: "SIGTERM" as const, waitMs: deps.termWaitMs ?? PROCESS_GROUP_TERM_GRACE_MS },
		{ signal: "SIGKILL" as const, waitMs: deps.killWaitMs ?? PROCESS_GROUP_KILL_GRACE_MS },
	]) {
		const sent = signalProcessGroup(processGroupId, phase.signal, kill);
		if (sent.sent) signals.push(phase.signal);
		if (sent.warning) warnings.push(sent.warning);
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
		if (phase.signal !== "SIGKILL") warnings.push(`Owned child processes remained after ${phase.signal}; escalating cleanup.`);
	}

	warnings.push("Owned child process cleanup could not be confirmed after SIGKILL.");
	return {
		supported: true,
		attempted: true,
		// Do not persist an unconfirmed process identifier. The caller retains
		// ownership only in-memory for this cleanup attempt and must not retry it
		// later from lifecycle state.
		liveProcessesDetected: true,
		terminated: false,
		escalatedToSigkill: true,
		...(signals.length ? { signals } : {}),
		warnings,
	};
}

export function formatOwnedProcessGroupCleanup(cleanup: ChildProcessCleanupResult): string {
	if (cleanup.skippedReason === "soft_pause") return "Process cleanup skipped for soft-paused run.";
	if (cleanup.skippedReason === "unsupported_platform") return "Owned process cleanup is unavailable on this platform.";
	if (cleanup.skippedReason === "process_group_unavailable") return "Owned process cleanup is unavailable because no verified child process group was tracked.";
	if (cleanup.terminated && cleanup.liveProcessesDetected === false) return "The owned child process group had no live processes to clean up.";
	if (cleanup.terminated && cleanup.escalatedToSigkill) return "Cleaned up the owned child process group after escalating through SIGKILL.";
	if (cleanup.terminated && cleanup.signals?.includes("SIGTERM")) return "Cleaned up the owned child process group after escalating through SIGTERM.";
	if (cleanup.terminated) return "Cleaned up the owned child process group with SIGINT.";
	if (cleanup.escalatedToSigkill) return "Cleanup escalated through SIGKILL, but owned child process exit could not be confirmed.";
	return "Owned child process cleanup could not be confirmed.";
}
