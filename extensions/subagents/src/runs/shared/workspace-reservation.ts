import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { CANONICAL_AGENT_MAX_EXECUTION_TIME_MS } from "../../agents/execution-ceiling.ts";
import { ASYNC_DIR, TEMP_ROOT_DIR } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { checkPidLiveness, isTerminalLifecycleState } from "./lifecycle-state.ts";

/**
 * Exclusive per-workspace writer reservation (epic contract C4). It only
 * coordinates TLH children; it is not a sandbox.
 */

const CANONICAL_WRITER_ROLES: ReadonlySet<string> = new Set(["developer", "test-runner"]);
/** A holder without lifecycle status older than this is treated as never started. */
const MISSING_LIFECYCLE_GRACE_MS = 2 * 60_000;
const RECLAIM_LOCK_STALE_MS = 10_000;

export interface WorkspaceReservationHolder {
  version: 1;
  key: string;
  runId: string;
  childIndex: number;
  agent: string;
  pid: number;
  sessionId: string | null;
  createdAt: number;
}

export interface WorkspaceReservationRequest {
  agent: string;
  childIndex: number;
  cwd: string;
}

export interface WorkspaceReservationOptions {
  dir?: string;
  asyncDir?: string;
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  now?: () => number;
  pid?: number;
  /** Test seam: runs while release holds the file lock, before it inspects the holder. */
  afterReleaseLock?: (file: string) => void;
}

export type WorkspaceReservationResult =
  | { ok: true; release: () => void }
  | { ok: false; message: string; holderRunId?: string };

/** Writers: developer, test-runner, and every agent outside the canonical packaged roles. */
export function isWorkspaceWriterAgent(agent: string): boolean {
  return (
    CANONICAL_WRITER_ROLES.has(agent) ||
    !Object.prototype.hasOwnProperty.call(CANONICAL_AGENT_MAX_EXECUTION_TIME_MS, agent)
  );
}

function realpathOrResolve(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** Canonical git worktree root of `cwd`, else its realpath. Linked worktrees stay distinct. */
export function canonicalWorkspaceKey(cwd: string): string {
  const real = realpathOrResolve(cwd);
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: real,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return top ? realpathOrResolve(top) : real;
  } catch {
    return real;
  }
}

function reservationsDir(options: WorkspaceReservationOptions): string {
  return options.dir ?? path.join(TEMP_ROOT_DIR, "workspace-reservations");
}

function reservationPath(dir: string, key: string): string {
  return path.join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
}

function readHolder(file: string): WorkspaceReservationHolder | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WorkspaceReservationHolder>;
    if (typeof parsed.runId !== "string" || typeof parsed.pid !== "number") return null;
    return parsed as WorkspaceReservationHolder;
  } catch {
    return null;
  }
}

/** True only when evidence shows the holder is gone; unknown evidence keeps the hold. */
function holderIsGone(
  holder: WorkspaceReservationHolder | null,
  file: string,
  options: WorkspaceReservationOptions,
): boolean {
  const now = options.now?.() ?? Date.now();
  if (!holder) {
    // Atomic link publication means unparseable content is corruption, not a race.
    try {
      return now - fs.statSync(file).mtimeMs > MISSING_LIFECYCLE_GRACE_MS;
    } catch {
      return true;
    }
  }
  let status = null;
  try {
    status = readStatus(path.join(options.asyncDir ?? ASYNC_DIR, holder.runId), { cache: false });
  } catch {
    return false;
  }
  if (status) {
    if (isTerminalLifecycleState(status.state)) return true;
    const pid = typeof status.pid === "number" && status.pid > 0 ? status.pid : holder.pid;
    return checkPidLiveness(pid, options.kill) === "dead";
  }
  // No lifecycle yet: the launcher may still be spawning. A live launcher is
  // never reclaimed; unknown liveness is reclaimed only once the hold is overdue.
  const liveness = checkPidLiveness(holder.pid, options.kill);
  if (liveness === "dead") return true;
  return liveness === "unknown" && now - holder.createdAt > MISSING_LIFECYCLE_GRACE_MS;
}

function conflictMessage(holder: WorkspaceReservationHolder | null, key: string): string {
  const who = holder
    ? `writer run ${holder.runId} (agent ${holder.agent}, child ${holder.childIndex}${holder.sessionId ? `, session ${holder.sessionId}` : ""})`
    : "another writer run (holder unknown)";
  const stop = holder
    ? ` Wait for it to finish, or stop it with subagent action="interrupt" id="${holder.runId}".`
    : " Wait for it to finish.";
  return `Workspace '${key}' is reserved by ${who}.${stop} Readers (code-reviewer, oracle, repo-scout, …) are unaffected; writers must use a separate git worktree to run concurrently.`;
}

function tryLink(dir: string, file: string, holder: WorkspaceReservationHolder): boolean {
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomUUID()}`);
  fs.writeFileSync(tmp, JSON.stringify(holder), { mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(tmp, file); // atomic, fails with EEXIST when already held
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

type AcquireOne = { ok: true } | { ok: false; holder: WorkspaceReservationHolder | null };

function acquireOne(
  dir: string,
  holder: WorkspaceReservationHolder,
  options: WorkspaceReservationOptions,
): AcquireOne {
  const file = reservationPath(dir, holder.key);
  if (tryLink(dir, file, holder)) return { ok: true };
  const current = readHolder(file);
  if (current?.runId === holder.runId && current.childIndex === holder.childIndex)
    return { ok: true };
  if (!holderIsGone(current, file, options)) return { ok: false, holder: current };

  // Reclaim under the same per-file lock that release uses, so a reclaimer and a
  // releaser can never interleave their read/unlink steps.
  const outcome = withFileLock(file, false, () => {
    const recheck = readHolder(file);
    if (recheck?.runId !== current?.runId || !holderIsGone(recheck, file, options))
      return { ok: false, holder: recheck } as AcquireOne;
    fs.rmSync(file, { force: true });
    if (tryLink(dir, file, holder)) return { ok: true } as AcquireOne;
    return { ok: false, holder: readHolder(file) } as AcquireOne;
  });
  return outcome ?? { ok: false, holder: current };
}

/**
 * Run `fn` holding `<file>.lock` (an mkdir lock). Returns undefined when the lock
 * could not be taken; `wait` retries briefly instead of failing immediately.
 */
function withFileLock<T>(file: string, wait: boolean, fn: () => T): T | undefined {
  const lock = `${file}.lock`;
  const deadline = Date.now() + (wait ? 1000 : 0);
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > RECLAIM_LOCK_STALE_MS)
          fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        /* lock vanished */
      }
      if (Date.now() >= deadline) return undefined;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Unlink only when the file still names this run (and child, when given), checked under the lock. */
function releaseFile(
  file: string,
  runId: string,
  childIndex: number | undefined,
  options: WorkspaceReservationOptions,
): void {
  withFileLock(file, true, () => {
    options.afterReleaseLock?.(file);
    const holder = readHolder(file);
    if (holder?.runId === runId && (childIndex === undefined || holder.childIndex === childIndex))
      fs.rmSync(file, { force: true });
  });
  // An unobtainable lock leaves the hold to stale-evidence recovery.
}

/**
 * Acquire every writer reservation a launch needs, all-or-nothing, before any
 * spawn. Read-only roles are skipped. Two writers on one workspace in the same
 * batch are a conflict.
 */
export function acquireWorkspaceReservations(
  runId: string,
  sessionId: string | null | undefined,
  requests: readonly WorkspaceReservationRequest[],
  options: WorkspaceReservationOptions = {},
): WorkspaceReservationResult {
  const writers = requests.filter((request) => isWorkspaceWriterAgent(request.agent));
  if (writers.length === 0) return { ok: true, release: () => undefined };

  const keyed = writers.map((request) => ({ request, key: canonicalWorkspaceKey(request.cwd) }));
  const seen = new Map<string, WorkspaceReservationRequest>();
  for (const { request, key } of keyed) {
    const first = seen.get(key);
    if (first)
      return {
        ok: false,
        message: `Tasks ${first.childIndex} (${first.agent}) and ${request.childIndex} (${request.agent}) would both write to workspace '${key}'. Run them sequentially, or give each writer its own git worktree.`,
      };
    seen.set(key, request);
  }

  const dir = reservationsDir(options);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      ok: false,
      message: `Failed to prepare workspace reservation directory '${dir}': ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const acquired: Array<{ file: string; childIndex: number }> = [];
  const release = () => {
    for (const entry of acquired.splice(0))
      releaseFile(entry.file, runId, entry.childIndex, options);
  };
  for (const { request, key } of keyed) {
    const holder: WorkspaceReservationHolder = {
      version: 1,
      key,
      runId,
      childIndex: request.childIndex,
      agent: request.agent,
      pid: options.pid ?? process.pid,
      sessionId: sessionId ?? null,
      createdAt: options.now?.() ?? Date.now(),
    };
    let outcome: AcquireOne;
    try {
      outcome = acquireOne(dir, holder, options);
    } catch (error) {
      release();
      return {
        ok: false,
        message: `Failed to acquire workspace reservation for '${key}': ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!outcome.ok) {
      release();
      return {
        ok: false,
        message: conflictMessage(outcome.holder, key),
        ...(outcome.holder ? { holderRunId: outcome.holder.runId } : {}),
      };
    }
    acquired.push({ file: reservationPath(dir, key), childIndex: request.childIndex });
  }
  return { ok: true, release };
}

/** Release every reservation held by a run (terminal or durable pause). Best effort. */
export function releaseWorkspaceReservationsForRun(
  runId: string,
  options: WorkspaceReservationOptions = {},
): void {
  const dir = reservationsDir(options);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      releaseFile(path.join(dir, name), runId, undefined, options);
    } catch {
      /* stale-evidence recovery covers anything left behind */
    }
  }
}
