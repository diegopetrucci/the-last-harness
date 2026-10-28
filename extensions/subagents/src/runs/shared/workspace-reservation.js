// Generated from extensions/subagents/src/runs/shared/workspace-reservation.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { CANONICAL_AGENT_MAX_EXECUTION_TIME_MS } from "../../agents/execution-ceiling.js";
import { ASYNC_DIR, TEMP_ROOT_DIR } from "../../shared/types.js";
import { readStatus } from "../../shared/utils.js";
import { checkPidLiveness, isTerminalLifecycleState } from "./lifecycle-state.js";
const CANONICAL_WRITER_ROLES = new Set(["developer", "test-runner"]);
const MISSING_LIFECYCLE_GRACE_MS = 2 * 60_000;
const RECLAIM_LOCK_STALE_MS = 10_000;
export function isWorkspaceWriterAgent(agent) {
    return (CANONICAL_WRITER_ROLES.has(agent) ||
        !Object.prototype.hasOwnProperty.call(CANONICAL_AGENT_MAX_EXECUTION_TIME_MS, agent));
}
function realpathOrResolve(target) {
    try {
        return fs.realpathSync(target);
    }
    catch {
        return path.resolve(target);
    }
}
export function canonicalWorkspaceKey(cwd) {
    const real = realpathOrResolve(cwd);
    try {
        const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: real,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5000,
        }).trim();
        return top ? realpathOrResolve(top) : real;
    }
    catch {
        return real;
    }
}
function reservationsDir(options) {
    return options.dir ?? path.join(TEMP_ROOT_DIR, "workspace-reservations");
}
function reservationPath(dir, key) {
    return path.join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
}
function readHolder(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (typeof parsed.runId !== "string" || typeof parsed.pid !== "number")
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function holderIsGone(holder, file, options) {
    const now = options.now?.() ?? Date.now();
    if (!holder) {
        try {
            return now - fs.statSync(file).mtimeMs > MISSING_LIFECYCLE_GRACE_MS;
        }
        catch {
            return true;
        }
    }
    let status = null;
    try {
        status = readStatus(path.join(options.asyncDir ?? ASYNC_DIR, holder.runId), { cache: false });
    }
    catch {
        return false;
    }
    if (status) {
        if (isTerminalLifecycleState(status.state))
            return true;
        const pid = typeof status.pid === "number" && status.pid > 0 ? status.pid : holder.pid;
        return checkPidLiveness(pid, options.kill) === "dead";
    }
    const liveness = checkPidLiveness(holder.pid, options.kill);
    if (liveness === "dead")
        return true;
    return liveness === "unknown" && now - holder.createdAt > MISSING_LIFECYCLE_GRACE_MS;
}
function conflictMessage(holder, key) {
    const who = holder
        ? `writer run ${holder.runId} (agent ${holder.agent}, child ${holder.childIndex}${holder.sessionId ? `, session ${holder.sessionId}` : ""})`
        : "another writer run (holder unknown)";
    const stop = holder
        ? ` Wait for it to finish, or stop it with subagent action="interrupt" id="${holder.runId}".`
        : " Wait for it to finish.";
    return `Workspace '${key}' is reserved by ${who}.${stop} Readers (code-reviewer, oracle, repo-scout, …) are unaffected; writers must use a separate git worktree to run concurrently.`;
}
function tryLink(dir, file, holder) {
    const tmp = path.join(dir, `.tmp-${process.pid}-${randomUUID()}`);
    fs.writeFileSync(tmp, JSON.stringify(holder), { mode: 0o600, flag: "wx" });
    try {
        fs.linkSync(tmp, file);
        return true;
    }
    catch (error) {
        if (error.code === "EEXIST")
            return false;
        throw error;
    }
    finally {
        fs.rmSync(tmp, { force: true });
    }
}
function acquireOne(dir, holder, options) {
    const file = reservationPath(dir, holder.key);
    if (tryLink(dir, file, holder))
        return { ok: true };
    const current = readHolder(file);
    if (current?.runId === holder.runId && current.childIndex === holder.childIndex)
        return { ok: true };
    if (!holderIsGone(current, file, options))
        return { ok: false, holder: current };
    const outcome = withFileLock(file, false, () => {
        const recheck = readHolder(file);
        if (recheck?.runId !== current?.runId || !holderIsGone(recheck, file, options))
            return { ok: false, holder: recheck };
        fs.rmSync(file, { force: true });
        if (tryLink(dir, file, holder))
            return { ok: true };
        return { ok: false, holder: readHolder(file) };
    });
    return outcome ?? { ok: false, holder: current };
}
function withFileLock(file, wait, fn) {
    const lock = `${file}.lock`;
    const deadline = Date.now() + (wait ? 1000 : 0);
    for (;;) {
        try {
            fs.mkdirSync(lock, { mode: 0o700 });
            break;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            try {
                if (Date.now() - fs.statSync(lock).mtimeMs > RECLAIM_LOCK_STALE_MS)
                    fs.rmSync(lock, { recursive: true, force: true });
            }
            catch {
            }
            if (Date.now() >= deadline)
                return undefined;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
    }
    try {
        return fn();
    }
    finally {
        fs.rmSync(lock, { recursive: true, force: true });
    }
}
function releaseFile(file, runId, childIndex, options) {
    withFileLock(file, true, () => {
        options.afterReleaseLock?.(file);
        const holder = readHolder(file);
        if (holder?.runId === runId && (childIndex === undefined || holder.childIndex === childIndex))
            fs.rmSync(file, { force: true });
    });
}
export function acquireWorkspaceReservations(runId, sessionId, requests, options = {}) {
    const writers = requests.filter((request) => isWorkspaceWriterAgent(request.agent));
    if (writers.length === 0)
        return { ok: true, release: () => undefined };
    const keyed = writers.map((request) => ({ request, key: canonicalWorkspaceKey(request.cwd) }));
    const seen = new Map();
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
    }
    catch (error) {
        return {
            ok: false,
            message: `Failed to prepare workspace reservation directory '${dir}': ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    const acquired = [];
    const release = () => {
        for (const entry of acquired.splice(0))
            releaseFile(entry.file, runId, entry.childIndex, options);
    };
    for (const { request, key } of keyed) {
        const holder = {
            version: 1,
            key,
            runId,
            childIndex: request.childIndex,
            agent: request.agent,
            pid: options.pid ?? process.pid,
            sessionId: sessionId ?? null,
            createdAt: options.now?.() ?? Date.now(),
        };
        let outcome;
        try {
            outcome = acquireOne(dir, holder, options);
        }
        catch (error) {
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
export function releaseWorkspaceReservationsForRun(runId, options = {}) {
    const dir = reservationsDir(options);
    let names;
    try {
        names = fs.readdirSync(dir);
    }
    catch {
        return;
    }
    for (const name of names) {
        if (!name.endsWith(".json"))
            continue;
        try {
            releaseFile(path.join(dir, name), runId, undefined, options);
        }
        catch {
        }
    }
}
