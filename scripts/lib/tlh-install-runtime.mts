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
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
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
export const PI_BIN_SYMLINK_TARGET =
  "../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";

// Relative symlink target from <staging>/bin/pi → <staging>/node_modules/…/cli.js
const PI_STAGED_BIN_SYMLINK_TARGET =
  "../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface RuntimeProvisionConfig {
  /** Runtime prefix path (<agentDir>/../runtime). */
  prefix: string;
  /** Absolute path to the shipped package.json (e.g. config/pi-runtime/package.json
   *  when running from local repo, or config.supportFilePaths.PI_RUNTIME_PACKAGE_JSON
   *  when fetched to tmpDir with a tempPath name). */
  shippedPackageJsonPath: string;
  /** Absolute path to the shipped package-lock.json. */
  shippedLockPath: string;
  /** Expected Pi version (PINNED_PI_VERSION). */
  pinnedVersion: string;
  /** Whether to only log planned actions without writing anything. */
  dryRun: boolean;
  /** Ownership origin from assertRuntimePrefixOwnedOrEmpty. */
  origin: "created" | "migrated";
}

export interface RuntimeProvisionIo {
  log: (message: string) => void;
  verboseLog: (message: string) => void;
  /** Print a planned command (used in dry-run and verbose paths). */
  printCommand: (args: Iterable<unknown>) => void;
  /**
   * Run a command (throws on failure; only prints in dry-run —
   * the caller is responsible for the dry-run guard).
   */
  runCommand: (args: readonly string[], options?: { cwd?: string }) => void;
  /**
   * Validate the pi binary at the given path reports the pinned version.
   * Throws with an actionable message if the version does not match or the
   * binary is unrunnable.  Must NOT be called in dry-run.
   */
  checkVersion: (piCommand: string, sourceDescription: string) => void;
}

export interface RuntimeProvisionResult {
  /** true = npm ci was run (fresh install or version/lock mismatch); false = reused. */
  installed: boolean;
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Compare the runtime's lib/package-lock.json byte-for-byte with the shipped lock.
 * Returns false when either file is missing, unreadable, or differs.
 */
export function runtimeLockIsIdentical(prefix: string, shippedLockPath: string): boolean {
  const runtimeLockPath = join(prefix, "lib", "package-lock.json");
  if (!existsSync(runtimeLockPath) || !existsSync(shippedLockPath)) return false;
  try {
    const runtimeLock = readFileSync(runtimeLockPath);
    const shippedLock = readFileSync(shippedLockPath);
    return runtimeLock.equals(shippedLock);
  } catch {
    return false;
  }
}

/**
 * Remove stale staging/previous dirs left by previously crashed runs.
 * Safe to call only when the prefix is TLH-owned (caller verified).
 */
export function cleanupStaleRuntimeDirs(prefix: string): void {
  if (!existsSync(prefix)) return;
  let entries: string[];
  try {
    entries = readdirSync(prefix);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry.startsWith(RUNTIME_STAGING_DIR_PREFIX) ||
      entry.startsWith(RUNTIME_PREVIOUS_DIR_PREFIX) ||
      entry.startsWith(RUNTIME_FAILED_DIR_PREFIX)
    ) {
      rmSync(join(prefix, entry), { recursive: true, force: true });
    }
  }
  // Also remove bin/pi backups left by crashed swaps.  These are files named
  // RUNTIME_PREVIOUS_DIR_PREFIX + <pid> + "-bin-pi" inside <prefix>/bin/.
  // bin/ is guaranteed non-symlink by the symlink check that runs before
  // cleanupStaleRuntimeDirs in provisionPiRuntime.
  const binDir = join(prefix, "bin");
  if (!existsSync(binDir)) return;
  let binEntries: string[];
  try {
    binEntries = readdirSync(binDir);
  } catch {
    return;
  }
  for (const entry of binEntries) {
    if (entry.startsWith(RUNTIME_PREVIOUS_DIR_PREFIX) && entry.endsWith("-bin-pi")) {
      rmSync(join(binDir, entry), { force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the path exists OR is a (possibly dangling) symlink.
 * lstatSync does not throw on dangling symlinks, unlike existsSync.
 */
function pathExistsOrIsSymlink(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
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
function isTlhOnlyLib(libDir: string): { ok: true } | { ok: false; foreignEntries: string[] } {
  // ── lib/ top-level ───────────────────────────────────────────────────────
  let libEntries: string[];
  try {
    libEntries = readdirSync(libDir);
  } catch {
    return { ok: false, foreignEntries: ["<unreadable lib dir>"] }; // fail closed
  }

  // Check package.json name before accepting it as TLH-owned.
  let packageJsonName: string | undefined;
  if (libEntries.includes("package.json")) {
    try {
      const raw = JSON.parse(readFileSync(join(libDir, "package.json"), "utf8")) as {
        name?: unknown;
      };
      packageJsonName = typeof raw.name === "string" ? raw.name : undefined;
    } catch {
      return { ok: false, foreignEntries: ["<unreadable lib/package.json>"] }; // fail closed
    }
  }

  const ALLOWED_LIB_TOPLEVEL = new Set(["node_modules", "package.json", "package-lock.json"]);
  const libForeign = libEntries.filter((e) => {
    if (!ALLOWED_LIB_TOPLEVEL.has(e)) return true; // unexpected entry
    if (e === "package.json" || e === "package-lock.json") {
      // Only allowed when the package.json has the expected name.
      if (packageJsonName !== TLH_RUNTIME_MANIFEST_NAME) return true;
    }
    return false;
  });
  if (libForeign.length > 0) return { ok: false, foreignEntries: libForeign };

  // ── lib/node_modules/ top-level ──────────────────────────────────────────
  const nmDir = join(libDir, "node_modules");
  if (!existsSync(nmDir)) return { ok: true };
  let nmEntries: string[];
  try {
    nmEntries = readdirSync(nmDir);
  } catch {
    return { ok: false, foreignEntries: ["<unreadable lib/node_modules>"] }; // fail closed
  }
  const ALLOWED_NM_TOPLEVEL = new Set([".bin", ".package-lock.json", "@earendil-works"]);
  const nmForeign = nmEntries.filter((e) => !ALLOWED_NM_TOPLEVEL.has(e));
  if (nmForeign.length > 0) return { ok: false, foreignEntries: nmForeign };

  // ── lib/node_modules/@earendil-works/ ────────────────────────────────────
  const ewDir = join(nmDir, "@earendil-works");
  if (!existsSync(ewDir)) return { ok: true };
  let ewEntries: string[];
  try {
    ewEntries = readdirSync(ewDir);
  } catch {
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
function rollbackSwap(libDir: string, previousDir: string, piBin: string, prevPiBin: string): void {
  // ── Restore lib ──────────────────────────────────────────────────────────
  if (!existsSync(previousDir)) {
    // Fresh install — no previous lib to restore; just remove the new lib.
    rmSync(libDir, { recursive: true, force: true });
  } else {
    // Rename the new (failed) lib to a temp name, then restore previous.
    const failedDir = join(dirname(libDir), `${RUNTIME_FAILED_DIR_PREFIX}${process.pid}`);
    try {
      if (existsSync(libDir)) renameSync(libDir, failedDir);
      renameSync(previousDir, libDir);
      rmSync(failedDir, { recursive: true, force: true });
    } catch {
      // best-effort; leave the state for manual recovery
    }
  }
  // ── Restore bin/pi ───────────────────────────────────────────────────────
  // Restore the exact previous entry (regular file or symlink) from the
  // rename-aside backup; remove the new symlink if present.
  try {
    if (pathExistsOrIsSymlink(piBin)) unlinkSync(piBin);
    if (prevPiBin && pathExistsOrIsSymlink(prevPiBin)) renameSync(prevPiBin, piBin);
  } catch {
    // best-effort
  }
}

/**
 * Find the newest previous-lib backup in the prefix (for interrupted-swap
 * recovery).  Returns the absolute path of the newest dir that starts with
 * RUNTIME_PREVIOUS_DIR_PREFIX and does NOT end with "-bin-pi" (those are
 * bin/pi backups, not lib backups).  Returns null if none found.
 */
function findNewestPreviousDir(prefix: string): string | null {
  if (!existsSync(prefix)) return null;
  let entries: string[];
  try {
    entries = readdirSync(prefix);
  } catch {
    return null;
  }
  const prevEntries = entries.filter(
    (e) => e.startsWith(RUNTIME_PREVIOUS_DIR_PREFIX) && !e.endsWith("-bin-pi"),
  );
  if (prevEntries.length === 0) return null;
  // Pick the newest by mtime (last modification time).
  let newestPath: string | null = null;
  let newestMtime = -1;
  for (const e of prevEntries) {
    const p = join(prefix, e);
    try {
      const mt = lstatSync(p).mtimeMs;
      if (mt > newestMtime) {
        newestMtime = mt;
        newestPath = p;
      }
    } catch {
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
export function provisionPiRuntime(
  config: RuntimeProvisionConfig,
  io: RuntimeProvisionIo,
): RuntimeProvisionResult {
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
  ] as const) {
    let _symlinkSt;
    try {
      _symlinkSt = lstatSync(childDir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue; // dir absent — not a symlink; safe to proceed
      throw e; // fail closed on any unexpected lstat error
    }
    if (_symlinkSt.isSymbolicLink()) {
      throw new Error(
        `TLH installer: ${prefix}/${childName} is a symlink. ` +
          `TLH will not mutate a symlinked child directory (dangling or otherwise). ` +
          `Remove or replace the symlink and rerun the installer.`,
      );
    }
  }

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
      } else {
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
        } catch {
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
    } catch (versionError) {
      io.verboseLog(
        `TLH private Pi runtime needs repair: ${versionError instanceof Error ? versionError.message : String(versionError)}`,
      );
    }
    const lockOk = runtimeLockIsIdentical(prefix, shippedLockPath);
    if (versionOk && lockOk) {
      io.verboseLog(`TLH private Pi runtime is valid: ${piBin}`);
      return { installed: false };
    }
    if (versionOk && !lockOk) {
      io.verboseLog(`TLH private Pi runtime lock mismatch — reinstalling from lockfile: ${piBin}`);
    }
    io.log(`Pinning local Pi runtime to ${pinnedVersion}...`);
    io.verboseLog(
      `${versionOk ? "Refreshing" : "Repairing"} TLH private Pi runtime to pinned ${pinnedVersion} at ${prefix} (per-user, no sudo)...`,
    );
  } else {
    io.log(`Pinning local Pi runtime to ${pinnedVersion}...`);
    io.verboseLog(`Installing TLH private Pi runtime to ${prefix} (per-user, no sudo)...`);
  }

  // ── migrated origin: guard against foreign lib content ───────────────────
  // Refusal only — never grants ownership (marker/provenance-based).
  if (origin === "migrated" && existsSync(libDir)) {
    const check = isTlhOnlyLib(libDir);
    if (!check.ok) {
      throw new Error(
        `Runtime prefix ${prefix} contains entries TLH does not own: ` +
          `${check.foreignEntries.join(", ")}. ` +
          `TLH left the prefix unchanged. ` +
          `Move or remove those entries first — for npm packages: ` +
          `\`npm uninstall -g --prefix "${prefix}" <package>\` — ` +
          `then rerun the installer, or use a dedicated profile directory ` +
          `(e.g. ~/.the-last-harness/agent) and rerun.`,
      );
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
    throw new Error(
      `TLH installer: shipped package.json not found at ${
        shippedPackageJsonPath || "(empty path)"
      }. Re-run the installer or check that config/pi-runtime/package.json is present.`,
    );
  }
  if (!shippedLockPath || !existsSync(shippedLockPath)) {
    throw new Error(
      `TLH installer: shipped package-lock.json not found at ${
        shippedLockPath || "(empty path)"
      }. Re-run the installer or check that config/pi-runtime/package-lock.json is present.`,
    );
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
  } catch (npmError) {
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
  } catch (stagedValidationError) {
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
  } catch (swapError) {
    if (renamedLibToPrevious) {
      try {
        renameSync(previousDir, libDir);
      } catch {
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
  } catch (binSetupError) {
    rollbackSwap(libDir, previousDir, piBin, prevPiBin);
    throw binSetupError;
  }

  // ── Post-swap validation ──────────────────────────────────────────────────
  try {
    io.checkVersion(piBin, `freshly installed TLH private runtime at ${piBin}`);
  } catch (postValidationError) {
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
    } catch {
      // best-effort
    }
  }

  return { installed: true };
}
