/**
 * tlh-install-runtime — staged npm-ci runtime provisioning for the TLH private Pi runtime.
 *
 * Replaces the old `npm install -g --prefix` approach with a lockfile-pinned staged swap:
 *   1. Copy config/pi-runtime/{package.json,package-lock.json} into a staging dir.
 *   2. Run `npm ci --ignore-scripts --no-audit --no-fund` there.
 *   3. Validate the staged bin before the swap.
 *   4. Atomically swap: rename old lib aside, rename staging → lib, (re)create bin/pi symlink.
 *   5. Revalidate bin/pi, then remove the old lib.
 *   6. On any failure: restore previous lib/bin; remove staging so a working runtime survives.
 */
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, } from "node:fs";
import { hostname as osHostname } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
// ---------------------------------------------------------------------------
// Exported constants (used by uninstall and stale-dir cleanup)
// ---------------------------------------------------------------------------
/** Prefix for staging dirs created inside the runtime prefix. */
export const RUNTIME_STAGING_DIR_PREFIX = ".tlh-runtime-staging-";
/** Prefix for previous-lib backup dirs created during a staged swap. */
export const RUNTIME_PREVIOUS_DIR_PREFIX = ".tlh-runtime-previous-";
/** Prefix for failed-swap dirs left for manual recovery. */
export const RUNTIME_FAILED_DIR_PREFIX = ".tlh-runtime-failed-";
/** Relative symlink target from <runtime>/bin/pi → <runtime>/lib/node_modules/…/cli.js */
export const PI_BIN_SYMLINK_TARGET = "../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
/** Lock dir name created atomically inside the runtime prefix during install/update. */
export const RUNTIME_INSTALL_LOCK_NAME = ".tlh-runtime-install.lock";
/** Reclaim mutex dir name used to serialize stale-lock reclamation (sibling of the lock). */
export const RUNTIME_INSTALL_LOCK_RECLAIM_NAME = ".tlh-runtime-install.lock.reclaim";
// Relative symlink target from <staging>/bin/pi → <staging>/node_modules/…/cli.js
const PI_STAGED_BIN_SYMLINK_TARGET = "../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------
/**
 * Compare the runtime's lib/package-lock.json byte-for-byte with the shipped lock.
 * Returns false when either file is missing, unreadable, or differs.
 */
export function runtimeLockIsIdentical(prefix, shippedLockPath) {
    const runtimeLockPath = join(prefix, "lib", "package-lock.json");
    if (!existsSync(runtimeLockPath) || !existsSync(shippedLockPath))
        return false;
    try {
        const runtimeLock = readFileSync(runtimeLockPath);
        const shippedLock = readFileSync(shippedLockPath);
        return runtimeLock.equals(shippedLock);
    }
    catch {
        return false;
    }
}
/**
 * Return absolute paths of all stale runtime entries under `prefix`:
 *   - Top-level dirs matching staging/previous/failed prefixes.
 *   - Files under `<prefix>/bin/` matching the previous-bin-pi backup pattern.
 * Tolerant of a missing or unreadable `prefix` or `bin/` — returns [] in those cases.
 */
export function listStaleRuntimeEntries(prefix) {
    const result = [];
    try {
        for (const e of readdirSync(prefix)) {
            if (e.startsWith(RUNTIME_STAGING_DIR_PREFIX) ||
                e.startsWith(RUNTIME_PREVIOUS_DIR_PREFIX) ||
                e.startsWith(RUNTIME_FAILED_DIR_PREFIX)) {
                result.push(join(prefix, e));
            }
        }
    }
    catch {
        // prefix missing or unreadable — nothing to list
    }
    const binDir = join(prefix, "bin");
    try {
        for (const e of readdirSync(binDir)) {
            if (e.startsWith(RUNTIME_PREVIOUS_DIR_PREFIX) && e.endsWith("-bin-pi")) {
                result.push(join(binDir, e));
            }
        }
    }
    catch {
        // bin/ missing or unreadable — nothing to list
    }
    return result;
}
/**
 * Remove stale staging/previous dirs left by previously crashed runs.
 * Safe to call only when the prefix is TLH-owned (caller verified).
 */
export function cleanupStaleRuntimeDirs(prefix) {
    for (const entry of listStaleRuntimeEntries(prefix)) {
        // Dirs use recursive; files use force-only. recursive+force covers both.
        rmSync(entry, { recursive: true, force: true });
    }
}
/**
 * Try to determine whether a process with `pid` is alive on this host.
 * Returns true on EPERM (process exists but we can't signal it) and for any
 * unexpected error (fail-closed: assume alive).
 * Returns false only on ESRCH (no such process).
 */
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        if (e.code === "ESRCH")
            return false;
        return true; // EPERM or unexpected — treat as alive
    }
}
/**
 * Parse owner.json inside `lockDir` and return the owner fields when valid.
 * Returns null on any I/O error, JSON parse error, or missing required fields
 * (pid: number, hostname: string).  The optional token field is included when
 * present and string-typed.
 */
function readLockOwner(lockDir) {
    try {
        const raw = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
        if (typeof raw === "object" &&
            raw !== null &&
            typeof raw.pid === "number" &&
            typeof raw.hostname === "string") {
            const r = raw;
            return {
                pid: r.pid,
                hostname: r.hostname,
                ...(typeof r.token === "string" ? { token: r.token } : {}),
            };
        }
    }
    catch {
        // missing, unreadable, or malformed owner.json
    }
    return null;
}
/**
 * Read the existing lock and return the observed owner if the lock appears
 * stale.  Throws with an actionable message if the lock is actively held
 * (live pid, different host, or recent malformed owner.json).
 *
 * Returns null when owner.json is missing/malformed AND old enough (> 10 min).
 * Returns an owner object when the lock has a dead pid on this host.
 */
function readStaleLockOwner(lockDir) {
    const owner = readLockOwner(lockDir);
    if (owner === null) {
        // Malformed / missing owner.json: stale only if lock dir mtime > 10 minutes.
        let lockMtimeMs = 0;
        try {
            lockMtimeMs = statSync(lockDir).mtimeMs;
        }
        catch {
            // unreadable — treat as stale
        }
        const ageMs = Date.now() - lockMtimeMs;
        if (ageMs > 10 * 60 * 1000) {
            return null; // stale, missing/malformed owner
        }
        throw new Error(`Another TLH install or update may be using this prefix ` +
            `(lock at ${lockDir} has missing or malformed owner.json and is less than 10 minutes old). ` +
            `Wait for it to finish; if none is running, remove ${lockDir} and rerun.`);
    }
    if (owner.hostname === osHostname() && !isPidAlive(owner.pid)) {
        return owner; // stale: same host, dead pid
    }
    // Live process (same host) or different host or EPERM → refuse.
    throw new Error(`Another TLH install or update is using this prefix ` +
        `(pid ${owner.pid} on host ${owner.hostname}). ` +
        `Wait for it to finish; if none is running, remove ${lockDir} and rerun.`);
}
/**
 * Reclaim a stale install lock under a short-lived reclaim mutex dir so that
 * two concurrent processes that both observed the same stale lock cannot both
 * delete it.
 *
 * The reclaim mutex dir (`<lockDir>.reclaim`) is created atomically:
 *   - EEXIST → another reclaimer is active; throws an actionable message and
 *     does NOT remove the reclaim dir (we did not create it).
 *   - Any other error → rethrown.
 *
 * While holding the mutex, re-reads owner.json and removes the lock only when
 * it is still in exactly the same stale state that was observed:
 *   - observedOwner non-null (dead-pid case): current token, pid, and hostname
 *     must all match the observed values (token match is skipped for old locks
 *     that have no token field, falling back to pid+hostname).
 *   - observedOwner null (missing/malformed case): owner.json must still be
 *     missing/malformed AND the lock dir mtime must still be > 10 minutes old.
 *
 * Always removes the reclaim dir in finally — but only if this call created it.
 */
export function reclaimStaleLock(lockDir, observedOwner, log) {
    const reclaimDir = join(dirname(lockDir), RUNTIME_INSTALL_LOCK_RECLAIM_NAME);
    let reclaimCreated = false;
    try {
        try {
            mkdirSync(reclaimDir); // throws EEXIST if another reclaimer holds the mutex
            reclaimCreated = true;
        }
        catch (e) {
            if (e.code === "EEXIST") {
                throw new Error(`Another TLH install or update is using this prefix ` +
                    `(reclaim mutex at ${reclaimDir} is already held). ` +
                    `If none is running, remove ${lockDir} and ${reclaimDir} and rerun.`);
            }
            throw e;
        }
        // Re-read the lock state to verify it has not changed since observation.
        if (observedOwner === null) {
            // Missing/malformed case: verify still missing/malformed and still old.
            const currentOwner = readLockOwner(lockDir);
            if (currentOwner !== null) {
                // Lock was re-acquired with a valid owner while we waited — do not remove.
                return;
            }
            let lockMtimeMs = 0;
            try {
                lockMtimeMs = statSync(lockDir).mtimeMs;
            }
            catch {
                return; // lock gone; nothing to remove
            }
            if (Date.now() - lockMtimeMs <= 10 * 60 * 1000) {
                // Lock has been refreshed or is a new lock — do not remove.
                return;
            }
            log(`TLH installer: reclaiming stale lock with missing/malformed owner at ${lockDir} ` +
                `(age ${Math.round((Date.now() - lockMtimeMs) / 1000)}s)`);
            rmSync(lockDir, { recursive: true, force: true });
        }
        else {
            // Dead-pid case: verify the lock still holds the same observed owner.
            // readLockOwner returns null on any read/parse error or malformed JSON,
            // covering both "lock gone" and "now malformed" — neither removes.
            const currentOwner = readLockOwner(lockDir);
            if (currentOwner === null) {
                return; // lock gone or now malformed — do not touch
            }
            // Token-aware match: if the observed owner had a token, require an exact
            // token match; otherwise fall back to pid+hostname (old-format lock).
            const tokenMatch = observedOwner.token !== undefined
                ? currentOwner.token === observedOwner.token
                : currentOwner.pid === observedOwner.pid &&
                    currentOwner.hostname === observedOwner.hostname;
            if (!tokenMatch) {
                // The lock has been replaced by a new owner — do not remove.
                return;
            }
            log(`TLH installer: reclaiming stale lock at ${lockDir} ` +
                `(pid ${observedOwner.pid} on ${observedOwner.hostname} is no longer running)`);
            rmSync(lockDir, { recursive: true, force: true });
        }
    }
    finally {
        if (reclaimCreated) {
            try {
                rmSync(reclaimDir, { recursive: true, force: true });
            }
            catch {
                // best-effort
            }
        }
    }
}
/**
 * Atomically acquire the per-runtime install lock at `lockDir`.  Retries once
 * after reclaiming a confirmed-stale lock.  Throws with an actionable message
 * if the lock is actively held.
 *
 * Returns the token written into owner.json; callers must pass it to
 * releaseInstallLock so that only the true owner can release the lock.
 */
export function acquireInstallLock(lockDir, log) {
    const token = randomUUID();
    const ownerJson = JSON.stringify({
        pid: process.pid,
        hostname: osHostname(),
        startedAt: new Date().toISOString(),
        token,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
        let dirCreated = false;
        try {
            mkdirSync(lockDir); // EEXIST = already held; no recursive — parent must exist
            dirCreated = true;
            writeFileSync(join(lockDir, "owner.json"), ownerJson);
            return token; // acquired
        }
        catch (e) {
            const code = e.code;
            if (code !== "EEXIST") {
                // Non-EEXIST: if mkdirSync succeeded but writeFileSync failed, the lock
                // dir is ownerless and would block installs for 10 minutes — remove it.
                if (dirCreated) {
                    try {
                        rmSync(lockDir, { recursive: true, force: true });
                    }
                    catch {
                        // best-effort
                    }
                }
                throw e;
            }
            // EEXIST on the retry: throw actionable message instead of the raw EEXIST
            // error (another process reclaimed and re-acquired the lock between attempts).
            if (attempt === 1) {
                throw new Error(`Another TLH install or update is using this prefix ` +
                    `(lock at ${lockDir} reappeared after reclaiming a stale lock). ` +
                    `Wait for it to finish; if none is running, remove ${lockDir} and rerun.`);
            }
        }
        // First EEXIST: observe the stale state then reclaim under the mutex.
        const observedOwner = readStaleLockOwner(lockDir); // throws if actively held
        reclaimStaleLock(lockDir, observedOwner, log);
    }
    // Unreachable: the loop always returns or throws before exhaustion.
    /* c8 ignore next */
    throw new Error("Unexpected: acquireInstallLock loop exhausted");
}
/**
 * Release the per-runtime install lock only when its owner.json token matches
 * the token returned by acquireInstallLock.  Safe to call even when the lock
 * does not exist; does nothing if a different owner holds the lock.
 */
export function releaseInstallLock(lockDir, token) {
    const owner = readLockOwner(lockDir);
    if (owner !== null && owner.token === token) {
        rmSync(lockDir, { recursive: true, force: true });
    }
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
 * Returns true when the path exists OR is a (possibly dangling) symlink.
 * lstatSync does not throw on dangling symlinks, unlike existsSync.
 */
function pathExistsOrIsSymlink(p) {
    try {
        lstatSync(p);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The npm package name used in the shipped package.json / package-lock.json.
 * package.json/package-lock.json in lib/ are only TLH-owned when their "name"
 * field matches this constant.
 */
const TLH_RUNTIME_MANIFEST_NAME = "tlh-pi-runtime";
/**
 * Check whether lib/ contains only TLH-owned content.  Fails closed on any
 * read/parse error so we never accidentally grant access to an unknown prefix.
 *
 * Allowed set:
 *   lib/ top-level ⊆ {node_modules, package.json, package-lock.json}
 *     where package.json/package-lock.json are only allowed when
 *     package.json["name"] === TLH_RUNTIME_MANIFEST_NAME.
 *   lib/node_modules/ top-level ⊆ {.bin, .package-lock.json, @earendil-works}
 *   lib/node_modules/@earendil-works/ ⊆ {pi-coding-agent}
 */
function isTlhOnlyLib(libDir) {
    // ── lib/ top-level ───────────────────────────────────────────────────────
    let libEntries;
    try {
        libEntries = readdirSync(libDir);
    }
    catch {
        return { ok: false, foreignEntries: ["<unreadable lib dir>"] }; // fail closed
    }
    // Check package.json name before accepting it as TLH-owned.
    let packageJsonName;
    if (libEntries.includes("package.json")) {
        try {
            const raw = JSON.parse(readFileSync(join(libDir, "package.json"), "utf8"));
            packageJsonName = typeof raw.name === "string" ? raw.name : undefined;
        }
        catch {
            return { ok: false, foreignEntries: ["<unreadable lib/package.json>"] }; // fail closed
        }
    }
    const ALLOWED_LIB_TOPLEVEL = new Set(["node_modules", "package.json", "package-lock.json"]);
    const libForeign = libEntries.filter((e) => {
        if (!ALLOWED_LIB_TOPLEVEL.has(e))
            return true; // unexpected entry
        if (e === "package.json" || e === "package-lock.json") {
            // Only allowed when the package.json has the expected name.
            if (packageJsonName !== TLH_RUNTIME_MANIFEST_NAME)
                return true;
        }
        return false;
    });
    if (libForeign.length > 0)
        return { ok: false, foreignEntries: libForeign };
    // ── lib/node_modules/ top-level ──────────────────────────────────────────
    const nmDir = join(libDir, "node_modules");
    if (!existsSync(nmDir))
        return { ok: true };
    let nmEntries;
    try {
        nmEntries = readdirSync(nmDir);
    }
    catch {
        return { ok: false, foreignEntries: ["<unreadable lib/node_modules>"] }; // fail closed
    }
    const ALLOWED_NM_TOPLEVEL = new Set([".bin", ".package-lock.json", "@earendil-works"]);
    const nmForeign = nmEntries.filter((e) => !ALLOWED_NM_TOPLEVEL.has(e));
    if (nmForeign.length > 0)
        return { ok: false, foreignEntries: nmForeign };
    // ── lib/node_modules/@earendil-works/ ────────────────────────────────────
    const ewDir = join(nmDir, "@earendil-works");
    if (!existsSync(ewDir))
        return { ok: true };
    let ewEntries;
    try {
        ewEntries = readdirSync(ewDir);
    }
    catch {
        return { ok: false, foreignEntries: ["<unreadable lib/node_modules/@earendil-works>"] }; // fail closed
    }
    const ALLOWED_EW = new Set(["pi-coding-agent"]);
    const ewForeign = ewEntries.filter((e) => !ALLOWED_EW.has(e));
    if (ewForeign.length > 0)
        return { ok: false, foreignEntries: ewForeign.map((e) => `@earendil-works/${e}`) };
    return { ok: true };
}
/**
 * Best-effort rollback: restore previous lib and previous bin/pi entry;
 * remove the failed new lib.  Called from both the symlink-creation and
 * post-swap-validation failure paths so there is one clear transaction path.
 *
 * @param prevPiBin  Path where the old bin/pi was renamed aside before the
 *   swap (RUNTIME_PREVIOUS_DIR_PREFIX + pid + "-bin-pi" inside piBinDir).
 *   Empty string when there was no previous bin/pi to preserve.
 */
function rollbackSwap(libDir, previousDir, piBin, prevPiBin) {
    // ── Restore lib ──────────────────────────────────────────────────────────
    if (!existsSync(previousDir)) {
        // Fresh install — no previous lib to restore; just remove the new lib.
        rmSync(libDir, { recursive: true, force: true });
    }
    else {
        // Rename the new (failed) lib to a temp name, then restore previous.
        const failedDir = join(dirname(libDir), `${RUNTIME_FAILED_DIR_PREFIX}${process.pid}`);
        try {
            if (existsSync(libDir))
                renameSync(libDir, failedDir);
            renameSync(previousDir, libDir);
            rmSync(failedDir, { recursive: true, force: true });
        }
        catch {
            // best-effort; leave the state for manual recovery
        }
    }
    // ── Restore bin/pi ───────────────────────────────────────────────────────
    // Restore the exact previous entry (regular file or symlink) from the
    // rename-aside backup; remove the new symlink if present.
    try {
        if (pathExistsOrIsSymlink(piBin))
            unlinkSync(piBin);
        if (prevPiBin && pathExistsOrIsSymlink(prevPiBin))
            renameSync(prevPiBin, piBin);
    }
    catch {
        // best-effort
    }
}
/**
 * Find the newest previous-lib backup in the prefix (for interrupted-swap
 * recovery).  Returns the absolute path of the newest dir that starts with
 * RUNTIME_PREVIOUS_DIR_PREFIX and does NOT end with "-bin-pi" (those are
 * bin/pi backups, not lib backups).  Returns null if none found.
 */
function findNewestPreviousDir(prefix) {
    if (!existsSync(prefix))
        return null;
    let entries;
    try {
        entries = readdirSync(prefix);
    }
    catch {
        return null;
    }
    const prevEntries = entries.filter((e) => e.startsWith(RUNTIME_PREVIOUS_DIR_PREFIX) && !e.endsWith("-bin-pi"));
    if (prevEntries.length === 0)
        return null;
    // Pick the newest by mtime (last modification time).
    let newestPath = null;
    let newestMtime = -1;
    for (const e of prevEntries) {
        const p = join(prefix, e);
        try {
            const mt = lstatSync(p).mtimeMs;
            if (mt > newestMtime) {
                newestMtime = mt;
                newestPath = p;
            }
        }
        catch {
            // skip unreadable entries
        }
    }
    return newestPath;
}
// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
/**
 * Provision the private Pi runtime from the TLH lockfile via staged swap.
 *
 * Reuse condition: piBin exists AND version matches pinned AND lib/package-lock.json
 * is byte-identical to the shipped lock.  If either differs, reinstall.
 *
 * For origin=migrated with foreign lib content: fail with an actionable message
 * without touching anything (ownership stays marker/provenance-based).
 */
export function provisionPiRuntime(config, io) {
    const { prefix, shippedPackageJsonPath, shippedLockPath, pinnedVersion, dryRun, origin } = config;
    const piBin = join(prefix, "bin", "pi");
    const piBinDir = join(prefix, "bin");
    const libDir = join(prefix, "lib");
    // ── Symlink safety (before any read or mutation) ────────────────────────
    // If bin/ or lib/ is a symlink (even dangling), refuse immediately so we
    // never read into or rename through an external directory.  This guard must
    // run before recovery, reuse-check, and every other branch.
    for (const [childName, childDir] of [
        ["bin", piBinDir],
        ["lib", libDir],
    ]) {
        let _symlinkSt;
        try {
            _symlinkSt = lstatSync(childDir);
        }
        catch (e) {
            const code = e.code;
            if (code === "ENOENT")
                continue; // dir absent — not a symlink; safe to proceed
            throw e; // fail closed on any unexpected lstat error
        }
        if (_symlinkSt.isSymbolicLink()) {
            throw new Error(`TLH installer: ${prefix}/${childName} is a symlink. ` +
                `TLH will not mutate a symlinked child directory (dangling or otherwise). ` +
                `Remove or replace the symlink and rerun the installer.`);
        }
    }
    // ── Acquire per-runtime install lock (skip in dry-run; prefix may not exist yet) ──
    // Held from here through the completed swap / rollback / reuse cleanup;
    // released in finally only when this process created the lock.
    const lockDir = join(prefix, RUNTIME_INSTALL_LOCK_NAME);
    let lockAcquired = false;
    let lockToken = null;
    if (!dryRun) {
        mkdirSync(prefix, { recursive: true }); // ensure prefix exists before lock dir
        lockToken = acquireInstallLock(lockDir, io.log);
        lockAcquired = true;
    }
    try {
        // lock-guarded block — released in finally
        // ── Interrupted-swap recovery (before reuse check) ────────────────────────
        // Safety net for a crashed swap: if lib is absent but a previous-lib backup
        // exists inside the prefix, restore the newest backup so the reuse check can
        // find a working runtime.  Also restores the paired bin/pi backup (named
        // RUNTIME_PREVIOUS_DIR_PREFIX + <name> + "-bin-pi" inside piBinDir) when
        // bin/pi is absent.  Basename-based matching is safe because TLH-namespaced
        // dot-dirs are the only entries with this prefix inside a marker-owned prefix.
        // Real run: restores the dirs; dry-run: logs the planned recovery only.
        if (!existsSync(libDir)) {
            const newestPrev = findNewestPreviousDir(prefix);
            if (newestPrev !== null) {
                if (dryRun) {
                    io.verboseLog(`[dry-run] Would recover interrupted swap: ${newestPrev} → ${libDir}`);
                }
                else {
                    io.verboseLog(`Recovering from interrupted swap: ${newestPrev} → ${libDir}`);
                    try {
                        renameSync(newestPrev, libDir);
                        // Restore paired bin/pi backup if bin/pi is absent.
                        if (!pathExistsOrIsSymlink(piBin)) {
                            const pairedPiBinName = `${basename(newestPrev)}-bin-pi`;
                            const pairedPiBin = join(piBinDir, pairedPiBinName);
                            if (pathExistsOrIsSymlink(pairedPiBin)) {
                                mkdirSync(piBinDir, { recursive: true });
                                renameSync(pairedPiBin, piBin);
                            }
                        }
                    }
                    catch {
                        // best-effort; continue so the reuse check and stale cleanup can run
                    }
                }
            }
        }
        // ── Reuse check ──────────────────────────────────────────────────────────
        if (existsSync(piBin)) {
            let versionOk = false;
            try {
                io.checkVersion(piBin, `TLH private runtime at ${piBin}`);
                versionOk = true;
            }
            catch (versionError) {
                io.verboseLog(`TLH private Pi runtime needs repair: ${versionError instanceof Error ? versionError.message : String(versionError)}`);
            }
            const lockOk = runtimeLockIsIdentical(prefix, shippedLockPath);
            if (versionOk && lockOk) {
                io.verboseLog(`TLH private Pi runtime is valid: ${piBin}`);
                if (!dryRun) {
                    // Clean up any stale staging/previous/failed dirs and bin/pi backups left
                    // by a previously crashed install so they are not retained indefinitely on
                    // the reuse path.
                    cleanupStaleRuntimeDirs(prefix);
                }
                else {
                    // dry-run: log what would be removed without mutating.
                    for (const entry of listStaleRuntimeEntries(prefix)) {
                        io.verboseLog(`[dry-run] Would remove stale runtime entry: ${entry}`);
                    }
                }
                return { installed: false }; // lock released in finally
            }
            if (versionOk && !lockOk) {
                io.verboseLog(`TLH private Pi runtime lock mismatch — reinstalling from lockfile: ${piBin}`);
            }
            io.log(`Pinning local Pi runtime to ${pinnedVersion}...`);
            io.verboseLog(`${versionOk ? "Refreshing" : "Repairing"} TLH private Pi runtime to pinned ${pinnedVersion} at ${prefix} (per-user, no sudo)...`);
        }
        else {
            io.log(`Pinning local Pi runtime to ${pinnedVersion}...`);
            io.verboseLog(`Installing TLH private Pi runtime to ${prefix} (per-user, no sudo)...`);
        }
        // ── migrated origin: guard against foreign lib content ───────────────────
        // Refusal only — never grants ownership (marker/provenance-based).
        if (origin === "migrated" && existsSync(libDir)) {
            const check = isTlhOnlyLib(libDir);
            if (!check.ok) {
                throw new Error(`Runtime prefix ${prefix} contains entries TLH does not own: ` +
                    `${check.foreignEntries.join(", ")}. ` +
                    `TLH left the prefix unchanged. ` +
                    `Move or remove those entries first — for npm packages: ` +
                    `\`npm uninstall -g --prefix "${prefix}" <package>\` — ` +
                    `then rerun the installer, or use a dedicated profile directory ` +
                    `(e.g. ~/.the-last-harness/agent) and rerun.`);
            }
        }
        // ── Dry-run: log planned actions and return ───────────────────────────────
        if (dryRun) {
            const stagingDir = join(prefix, `${RUNTIME_STAGING_DIR_PREFIX}${process.pid}`);
            io.verboseLog(`[dry-run] Would create staging dir: ${stagingDir}`);
            io.printCommand(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
            io.verboseLog(`[dry-run] Would swap ${stagingDir} → ${libDir}`);
            io.printCommand(["ln", "-sf", PI_BIN_SYMLINK_TARGET, join(prefix, "bin", "pi")]);
            return { installed: true };
        }
        // ── Validate shipped support files are present (real run only) ───────────
        if (!shippedPackageJsonPath || !existsSync(shippedPackageJsonPath)) {
            throw new Error(`TLH installer: shipped package.json not found at ${shippedPackageJsonPath || "(empty path)"}. Re-run the installer or check that config/pi-runtime/package.json is present.`);
        }
        if (!shippedLockPath || !existsSync(shippedLockPath)) {
            throw new Error(`TLH installer: shipped package-lock.json not found at ${shippedLockPath || "(empty path)"}. Re-run the installer or check that config/pi-runtime/package-lock.json is present.`);
        }
        // ── Stale dir cleanup (TLH-owned prefix, real run only) ──────────────────
        cleanupStaleRuntimeDirs(prefix);
        // ── Create staging dir and copy shipped manifest ──────────────────────────
        mkdirSync(prefix, { recursive: true });
        const stagingDir = join(prefix, `${RUNTIME_STAGING_DIR_PREFIX}${process.pid}`);
        mkdirSync(stagingDir, { recursive: true });
        cpSync(shippedPackageJsonPath, join(stagingDir, "package.json"));
        cpSync(shippedLockPath, join(stagingDir, "package-lock.json"));
        // ── npm ci in staging dir ─────────────────────────────────────────────────
        try {
            io.runCommand(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
                cwd: stagingDir,
            });
        }
        catch (npmError) {
            rmSync(stagingDir, { recursive: true, force: true });
            throw npmError;
        }
        // ── Pre-swap validation ───────────────────────────────────────────────────
        // Create a temporary bin/pi symlink inside the staging dir so it can be
        // validated via the same mechanism used for the real bin/pi.
        const stagedBinDir = join(stagingDir, "bin");
        const stagedPiBin = join(stagedBinDir, "pi");
        mkdirSync(stagedBinDir, { recursive: true });
        symlinkSync(PI_STAGED_BIN_SYMLINK_TARGET, stagedPiBin);
        try {
            io.checkVersion(stagedPiBin, `staged TLH private runtime at ${stagingDir}`);
        }
        catch (stagedValidationError) {
            rmSync(stagingDir, { recursive: true, force: true });
            throw stagedValidationError;
        }
        // Remove the temporary staged bin dir before the swap so it does not end up
        // as <runtime>/lib/bin after the rename.
        rmSync(stagedBinDir, { recursive: true, force: true });
        // ── Swap: lib → previous, staging → lib ──────────────────────────────────
        const previousDir = join(prefix, `${RUNTIME_PREVIOUS_DIR_PREFIX}${process.pid}`);
        let renamedLibToPrevious = false;
        try {
            if (existsSync(libDir)) {
                renameSync(libDir, previousDir);
                renamedLibToPrevious = true;
            }
            renameSync(stagingDir, libDir);
        }
        catch (swapError) {
            if (renamedLibToPrevious) {
                try {
                    renameSync(previousDir, libDir);
                }
                catch {
                    // best-effort
                }
            }
            rmSync(stagingDir, { recursive: true, force: true });
            throw swapError;
        }
        // ── (Re)create bin/pi symlink ─────────────────────────────────────────────
        // Rename the previous bin/pi aside instead of deleting it so it can be
        // restored byte-identically on rollback (whether it was a regular file or a
        // symlink).  The backup name uses RUNTIME_PREVIOUS_DIR_PREFIX so that the
        // stale-cleanup and uninstall patterns already cover it.
        // mkdirSync, rename-aside, and symlinkSync are all inside the rollback-
        // protected block so any failure there also triggers lib restore.
        const prevPiBinName = `${RUNTIME_PREVIOUS_DIR_PREFIX}${process.pid}-bin-pi`;
        const prevPiBin = join(piBinDir, prevPiBinName);
        try {
            mkdirSync(piBinDir, { recursive: true });
            if (pathExistsOrIsSymlink(piBin)) {
                renameSync(piBin, prevPiBin);
            }
            symlinkSync(PI_BIN_SYMLINK_TARGET, piBin);
        }
        catch (binSetupError) {
            rollbackSwap(libDir, previousDir, piBin, prevPiBin);
            throw binSetupError;
        }
        // ── Post-swap validation ──────────────────────────────────────────────────
        try {
            io.checkVersion(piBin, `freshly installed TLH private runtime at ${piBin}`);
        }
        catch (postValidationError) {
            rollbackSwap(libDir, previousDir, piBin, prevPiBin);
            throw postValidationError;
        }
        // ── Remove backups now that the new runtime is validated ────────────────────
        if (renamedLibToPrevious && existsSync(previousDir)) {
            rmSync(previousDir, { recursive: true, force: true });
        }
        // Remove bin/pi backup only after post-swap validation succeeds.
        if (pathExistsOrIsSymlink(prevPiBin)) {
            try {
                unlinkSync(prevPiBin);
            }
            catch {
                // best-effort
            }
        }
        return { installed: true };
    }
    finally {
        if (lockAcquired && lockToken !== null) {
            releaseInstallLock(lockDir, lockToken);
        }
    }
}
