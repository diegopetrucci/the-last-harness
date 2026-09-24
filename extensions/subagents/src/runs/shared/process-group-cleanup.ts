import type {
  ChildProcessCleanupResult,
  ChildProcessCleanupSkippedReason,
} from "../../shared/types.ts";
const INT_GRACE_MS = 1000;
const TERM_GRACE_MS = 2000;
const KILL_GRACE_MS = 1000;
const POLL_MS = 100;
const MAX_WARNINGS = 4;
const MAX_WARNING_BYTES = 512;
const POSIX_PLATFORMS = new Set<NodeJS.Platform>([
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
type CleanupSignal = "SIGINT" | "SIGTERM" | "SIGKILL";
type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;
export interface OwnedProcessGroupChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}
export interface OwnedProcessGroupOwner {
  readonly processGroupId: number;
  readonly isLive: () => boolean;
  readonly observeExit: (pid?: number) => boolean;
}
interface OwnerRecord {
  readonly child: OwnedProcessGroupChild;
  observedExit: boolean;
  consumed: boolean;
}
const ownerRecords = new WeakMap<object, OwnerRecord>();
export function createOwnedProcessGroupOwner(
  child: OwnedProcessGroupChild,
): OwnedProcessGroupOwner | undefined {
  const processGroupId = child.pid;
  if (!positivePid(processGroupId)) return undefined;
  const owner = {
    processGroupId,
    isLive: () =>
      child.pid === processGroupId && child.exitCode === null && child.signalCode === null,
    observeExit: (observedPid = child.pid): boolean => {
      const record = ownerRecords.get(owner);
      if (
        !record ||
        record.consumed ||
        observedPid !== processGroupId ||
        child.pid !== processGroupId ||
        (child.exitCode === null && child.signalCode === null)
      )
        return false;
      record.observedExit = true;
      return true;
    },
  } satisfies OwnedProcessGroupOwner;
  ownerRecords.set(owner, { child, observedExit: false, consumed: false });
  return Object.freeze(owner);
}
interface CleanupDeps {
  kill?: KillFn;
  sleep?: (ms: number) => Promise<void>;
  intWaitMs?: number;
  termWaitMs?: number;
  killWaitMs?: number;
  pollMs?: number;
  now?: () => number;
  platform?: NodeJS.Platform;
  owner?: OwnedProcessGroupOwner;
  firstSignal?: "SIGTERM";
}
const positivePid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
function warning(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_WARNING_BYTES) return value;
  const suffix = "…";
  let result = Buffer.from(value, "utf8")
    .subarray(0, MAX_WARNING_BYTES - Buffer.byteLength(suffix, "utf8"))
    .toString("utf8");
  while (Buffer.byteLength(result, "utf8") + Buffer.byteLength(suffix, "utf8") > MAX_WARNING_BYTES)
    result = result.slice(0, -1);
  return `${result}${suffix}`;
}
function addWarning(warnings: string[], value: string): void {
  if (warnings.length < MAX_WARNINGS) warnings.push(value);
  else warnings[warnings.length - 1] = value;
}
function ownerRecord(
  pid: number,
  owner: OwnedProcessGroupOwner | undefined,
): OwnerRecord | undefined {
  const record = owner && owner.processGroupId === pid ? ownerRecords.get(owner) : undefined;
  return record?.child.pid === pid ? record : undefined;
}
function claimOwner(pid: number, owner: OwnedProcessGroupOwner | undefined): boolean {
  const record = ownerRecord(pid, owner);
  if (!owner || !record || record.consumed) return false;
  try {
    if (!owner.isLive() && !record.observedExit) return false;
    record.consumed = true;
    return true;
  } catch {
    return false;
  }
}
const hasClaimedOwner = (pid: number, owner: OwnedProcessGroupOwner | undefined): boolean =>
  ownerRecord(pid, owner)?.consumed === true;
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
type Probe = "alive" | "dead" | "unknown";
function probe(pid: number, kill: KillFn, owner: OwnedProcessGroupOwner): Probe {
  if (!hasClaimedOwner(pid, owner)) return "unknown";
  try {
    kill(-pid, 0);
    return "alive";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return "dead";
    return code === "EPERM" ? "alive" : "unknown";
  }
}
function directOwnerChildIsLive(pid: number, owner: OwnedProcessGroupOwner): boolean {
  if (!hasClaimedOwner(pid, owner)) return false;
  try {
    // The owner proof binds this exact live ChildProcess to the process-group
    // id. A positive-pid fallback is safe only while that direct child is still
    // the current owner; it must not become a persisted-pid kill primitive.
    return owner.isLive();
  } catch {
    return false;
  }
}
function send(
  pid: number,
  signal: CleanupSignal,
  kill: KillFn,
  owner: OwnedProcessGroupOwner,
  platform: NodeJS.Platform,
): { sent: boolean; alreadyGone?: boolean; warning?: string } {
  if (!hasClaimedOwner(pid, owner))
    return { sent: false, warning: `Could not verify ownership before sending ${signal}.` };
  try {
    return { sent: kill(-pid, signal) };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return { sent: false, alreadyGone: true };
    if (code === "EPERM" && platform === "darwin" && directOwnerChildIsLive(pid, owner)) {
      try {
        if (kill(pid, signal)) {
          return {
            sent: true,
            warning: `Failed to send ${signal} to the owned child process group; sent ${signal} directly to the live owned child.`,
          };
        }
      } catch {
        // The group probe below remains authoritative. A direct-child race is
        // not evidence that descendants have stopped.
      }
      return {
        sent: false,
        warning: `Failed to send ${signal} to the owned child process group and its live owned child.`,
      };
    }
    return { sent: false, warning: `Failed to send ${signal} to the owned child process group.` };
  }
}
async function waitForExit(
  pid: number,
  waitMs: number,
  deps: CleanupDeps,
  owner: OwnedProcessGroupOwner,
): Promise<Probe> {
  const kill = deps.kill ?? process.kill.bind(process);
  const now = deps.now ?? Date.now;
  const deadline = now() + Math.max(0, waitMs);
  while (now() < deadline) {
    const state = probe(pid, kill, owner);
    if (state !== "alive") return state;
    await (deps.sleep ?? sleep)(Math.max(1, Math.min(deps.pollMs ?? POLL_MS, deadline - now())));
  }
  return probe(pid, kill, owner);
}
export function supportsOwnedProcessGroupCleanup(platform = process.platform): boolean {
  return POSIX_PLATFORMS.has(platform);
}
export function normalizeChildProcessCleanup(
  value: unknown,
): ChildProcessCleanupResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !(["supported", "attempted", "terminated"] as const).every(
      (key) => typeof record[key] === "boolean",
    )
  )
    return undefined;
  const processGroupId = record.processGroupId;
  if (processGroupId !== undefined && !positivePid(processGroupId)) return undefined;
  const optionalBoolean = (candidate: unknown) =>
    candidate === undefined || typeof candidate === "boolean";
  if (!optionalBoolean(record.liveProcessesDetected) || !optionalBoolean(record.escalatedToSigkill))
    return undefined;
  const signals = record.signals;
  if (
    signals !== undefined &&
    (!Array.isArray(signals) ||
      signals.length > 3 ||
      !signals.every((signal) => ["SIGINT", "SIGTERM", "SIGKILL"].includes(String(signal))))
  )
    return undefined;
  const skippedReason = record.skippedReason;
  if (
    skippedReason !== undefined &&
    !["soft_pause", "unsupported_platform", "process_group_unavailable"].includes(
      String(skippedReason),
    )
  )
    return undefined;
  const warnings = record.warnings;
  if (
    warnings !== undefined &&
    (!Array.isArray(warnings) ||
      warnings.length > MAX_WARNINGS ||
      !warnings.every((item) => typeof item === "string"))
  )
    return undefined;
  return {
    supported: record.supported as boolean,
    attempted: record.attempted as boolean,
    terminated: record.terminated as boolean,
    ...(processGroupId !== undefined ? { processGroupId: processGroupId as number } : {}),
    ...(record.liveProcessesDetected !== undefined
      ? { liveProcessesDetected: record.liveProcessesDetected as boolean }
      : {}),
    ...(record.escalatedToSigkill !== undefined
      ? { escalatedToSigkill: record.escalatedToSigkill as boolean }
      : {}),
    ...(signals !== undefined
      ? { signals: [...signals] as ChildProcessCleanupResult["signals"] }
      : {}),
    ...(skippedReason !== undefined
      ? { skippedReason: skippedReason as ChildProcessCleanupSkippedReason }
      : {}),
    ...(warnings !== undefined
      ? { warnings: warnings.map((item) => warning(item as string)) }
      : {}),
  };
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
    ...(positivePid(processGroupId) ? { processGroupId } : {}),
    skippedReason: reason,
  };
}
function unavailable(processGroupId: number): ChildProcessCleanupResult {
  return {
    supported: true,
    attempted: false,
    processGroupId,
    terminated: false,
    skippedReason: "process_group_unavailable",
    warnings: ["Could not verify ownership of the child process group; no signal was sent."],
  };
}
export async function cleanupOwnedProcessGroup(
  processGroupId: number,
  deps: CleanupDeps = {},
): Promise<ChildProcessCleanupResult> {
  const platform = deps.platform ?? process.platform;
  if (!supportsOwnedProcessGroupCleanup(platform))
    return skipOwnedProcessGroupCleanup("unsupported_platform", processGroupId, false);
  if (!positivePid(processGroupId))
    return skipOwnedProcessGroupCleanup("process_group_unavailable", undefined, true);
  const owner = deps.owner;
  if (!owner || !claimOwner(processGroupId, owner)) return unavailable(processGroupId);
  const phases: Array<[CleanupSignal, number]> = [
    ["SIGINT", deps.intWaitMs ?? INT_GRACE_MS],
    ["SIGTERM", deps.termWaitMs ?? TERM_GRACE_MS],
    ["SIGKILL", deps.killWaitMs ?? KILL_GRACE_MS],
  ];
  const signals: CleanupSignal[] = [];
  const warnings: string[] = [];
  let liveProcessesDetected = false;
  let escalatedToSigkill = false;
  const kill = deps.kill ?? process.kill.bind(process);
  const result = (terminated: boolean): ChildProcessCleanupResult => ({
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
  if (initial === "dead") return result(true);
  if (initial === "unknown") return unavailable(processGroupId);
  for (const [signal, waitMs] of phases.slice(deps.firstSignal === "SIGTERM" ? 1 : 0)) {
    if (signal === "SIGKILL") escalatedToSigkill = true;
    const sent = send(processGroupId, signal, kill, owner, platform);
    if (sent.sent) signals.push(signal);
    if (sent.warning) addWarning(warnings, sent.warning);
    if (sent.alreadyGone) return result(true);
    const state = sent.sent
      ? await waitForExit(processGroupId, waitMs, deps, owner)
      : probe(processGroupId, kill, owner);
    if (state === "dead") return result(true);
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
export function formatOwnedProcessGroupCleanup(cleanup: ChildProcessCleanupResult): string {
  if (cleanup.skippedReason === "soft_pause") return "Process cleanup skipped for soft-paused run.";
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
  if (cleanup.terminated) return "Cleaned up the owned child process group with SIGINT.";
  if (cleanup.escalatedToSigkill)
    return "Cleanup escalated through SIGKILL, but owned child process exit could not be confirmed.";
  return "Owned child process cleanup could not be confirmed.";
}
