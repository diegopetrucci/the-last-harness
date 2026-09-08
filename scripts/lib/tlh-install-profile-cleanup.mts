import { copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  FORCE_REMOVED_RETIRED_DEFAULT_EXTENSION_SOURCES,
  packageIdentity,
  RETIRED_TLH_DEFAULT_PACKAGE_SOURCES,
} from "./default-extensions.mjs";
import { parseGitSource } from "./tlh-install-package-source.mjs";
import type { InstallerPathConfig } from "./tlh-install-paths.mjs";
import {
  assertProfilePathWithinAgent,
  assertSafeSettingsTarget,
  isSymlink,
  validateProfileRelativePath,
} from "./tlh-install-paths.mjs";
import {
  backupPathWithTimestamp,
  isTlhOwnedBackupFilename,
  selectExpiredBackups,
} from "./tlh-install-utils.mjs";

export interface ProfileCleanupConfig extends InstallerPathConfig {
  agentDir: string;
  dryRun: boolean;
  quiet: boolean;
  verbose: boolean;
}

export interface RetiredExtensionCleanupConfig extends ProfileCleanupConfig {
  settingsPath: string;
}

export interface ProfileCleanupIo {
  log(message: string): void;
  detailLog(message: string): void;
  warn(message: string): void;
  absolutePiCmd(): string;
  runPiRemove(commandArgs: readonly string[]): void;
}

// Retired files that TLH seeded in older isolated profiles.
// Each path is relative to config.agentDir and must not contain '..' components.
// The cleanup is idempotent: absent files are silently skipped.
export const LEGACY_MANAGED_PROFILE_ARTIFACTS = Object.freeze(["bin/rtk", "tlh/tlh-rtk.mjs"]);

export const RETIRED_PROFILE_FILES = Object.freeze(["extensions/librarian.json"]);

// Retired state directories left by retired default extensions.
// Each path is relative to config.agentDir and must not contain '..' components.
// The cleanup is idempotent: absent directories are silently skipped.
export const RETIRED_PROFILE_DIRECTORIES = Object.freeze(["intercom"]);

/**
 * Walk agentDir → relativePath, guarding against symlinks at agentDir and at
 * every existing intermediate directory component.
 *
 * Returns the resolved target path when safe, or null when blocked:
 *   - agentDir is a symlink → null with a warning
 *   - agentDir exists but is not a directory → null with a warning
 *   - an intermediate component is a symlink → null with a warning
 *   - an intermediate component does not exist → null (silent; target absent)
 *
 * The caller is responsible for any assertProfilePathWithinAgent call on the
 * returned target and for any type / existence check on the target itself.
 */
function resolveGuardedProfilePath(
  agentDir: string,
  relativePath: string,
  label: string,
  io: ProfileCleanupIo,
): string | null {
  if (isSymlink(agentDir)) {
    io.warn(`Skipping ${label}: agentDir is a symlink: ${agentDir}`);
    return null;
  }
  if (existsSync(agentDir) && !lstatSync(agentDir).isDirectory()) {
    io.warn(`Skipping ${label}: agentDir is not a directory: ${agentDir}`);
    return null;
  }
  const components = relativePath.split("/");
  const parentComponents = components.slice(0, -1);
  const lastName = components[components.length - 1];
  let cursor = agentDir;
  for (const component of parentComponents) {
    cursor = join(cursor, component);
    if (isSymlink(cursor)) {
      io.warn(`Skipping ${label} through symlinked parent: ${cursor}`);
      return null;
    }
    if (!existsSync(cursor)) {
      return null; // silent: target simply does not exist
    }
    if (!lstatSync(cursor).isDirectory()) {
      return null; // non-directory intermediate: treat as absent, never descend
    }
  }
  return join(cursor, lastName);
}

function cleanupRelativeProfileDirs(
  config: ProfileCleanupConfig,
  relativePaths: readonly string[],
  io: ProfileCleanupIo,
): void {
  for (const relativePath of relativePaths) {
    try {
      validateProfileRelativePath(relativePath, "retired profile directory path");
    } catch {
      io.warn(`Skipping invalid retired profile directory path: ${relativePath}`);
      continue;
    }

    const target = resolveGuardedProfilePath(
      config.agentDir,
      relativePath,
      "retired profile directory cleanup",
      io,
    );
    if (target === null) continue;

    try {
      assertProfilePathWithinAgent(config, target, "retired profile directory");
    } catch (error) {
      io.warn(
        `Skipping retired profile directory cleanup (unsafe path): ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (isSymlink(target)) continue;
    if (!existsSync(target)) continue;
    if (!lstatSync(target).isDirectory()) continue;
    if (config.dryRun) {
      io.log(`Would remove retired profile directory: ${target}`);
      continue;
    }
    try {
      rmSync(target, { recursive: true });
      io.detailLog(`Removed retired profile directory: ${target}`);
    } catch (error) {
      io.warn(
        `failed to remove retired profile directory ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function cleanupRetiredProfileDirectories(
  config: ProfileCleanupConfig,
  io: ProfileCleanupIo,
): void {
  cleanupRelativeProfileDirs(config, RETIRED_PROFILE_DIRECTORIES, io);
}

function cleanupRelativeProfileFiles(
  config: ProfileCleanupConfig,
  relativePaths: readonly string[],
  io: ProfileCleanupIo,
): void {
  for (const relativePath of relativePaths) {
    try {
      validateProfileRelativePath(relativePath, "retired profile path");
    } catch {
      io.warn(`Skipping invalid retired profile path: ${relativePath}`);
      continue;
    }

    const target = resolveGuardedProfilePath(
      config.agentDir,
      relativePath,
      "retired profile file cleanup",
      io,
    );
    if (target === null) continue;

    try {
      assertProfilePathWithinAgent(config, target, "retired profile file");
    } catch (error) {
      io.warn(
        `Skipping retired profile file cleanup (unsafe path): ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (isSymlink(target)) continue;
    if (!existsSync(target)) continue;
    if (!lstatSync(target).isFile()) continue;
    if (config.dryRun) {
      io.log(`Would remove retired profile file: ${target}`);
      continue;
    }
    try {
      rmSync(target);
      io.detailLog(`Removed retired profile file: ${target}`);
    } catch (error) {
      io.warn(
        `failed to remove retired profile file ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function cleanupLegacyManagedProfileArtifacts(
  config: ProfileCleanupConfig,
  io: ProfileCleanupIo,
): void {
  cleanupRelativeProfileFiles(config, LEGACY_MANAGED_PROFILE_ARTIFACTS, io);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cleanupRetiredProfileFiles(
  config: ProfileCleanupConfig,
  io: ProfileCleanupIo,
): void {
  // FIX 2: Read post-merge settings to decide whether to keep managed files.
  // Fail safe: if settings cannot be read, skip file removal rather than risk wrong deletion.
  let postMergePackages: unknown[] | null = []; // default empty → proceed with removal when no settings present
  if (config.settingsPath && existsSync(config.settingsPath)) {
    try {
      const raw = readFileSync(config.settingsPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isJsonRecord(parsed) && Array.isArray(parsed.packages)) {
        postMergePackages = parsed.packages;
      }
    } catch {
      postMergePackages = null; // fail safe: unreadable settings → skip removal
    }
  }

  for (const relativePath of RETIRED_PROFILE_FILES) {
    if (relativePath === "extensions/librarian.json") {
      if (postMergePackages === null) {
        if (config.dryRun)
          io.log(
            `Would skip removal of retired profile file (settings unreadable, fail safe): ${join(config.agentDir, relativePath)}`,
          );
        continue;
      }
      const librarianIdentity = packageIdentity("npm:@diegopetrucci/pi-librarian");
      const librarianPresent = postMergePackages.some(
        (entry: unknown) => packageIdentity(entry) === librarianIdentity,
      );
      if (librarianPresent) {
        if (config.dryRun)
          io.log(
            `Skipping retired profile file removal (user-added package preserved): ${join(config.agentDir, relativePath)}`,
          );
        continue;
      }
    }
    cleanupRelativeProfileFiles(config, [relativePath], io);
  }
}

export function cleanupOldSettingsBackups(
  config: ProfileCleanupConfig,
  io: ProfileCleanupIo,
): void {
  // Skip entirely when agentDir itself is a symlink — same safety posture as cleanupRetiredProfileFiles.
  if (isSymlink(config.agentDir)) {
    io.warn(`Skipping stale settings backup cleanup: agentDir is a symlink: ${config.agentDir}`);
    return;
  }

  // Gather candidate filenames from the agent-dir root (non-recursive).
  if (!existsSync(config.agentDir)) return;
  let entries: string[];
  try {
    entries = readdirSync(config.agentDir);
  } catch (error) {
    io.warn(
      `Skipping stale settings backup cleanup: cannot read agentDir: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  // Keep only filenames that match TLH backup patterns AND carry a parseable
  // TLH timestamp. Files like `settings.json.backup-mynotes` share the prefix
  // but have no timestamp, so they must never be treated as deletion candidates.
  const settingsCandidates = entries.filter((name) =>
    isTlhOwnedBackupFilename(name, "settings.json"),
  );
  const keybindingsCandidates = entries.filter((name) =>
    isTlhOwnedBackupFilename(name, "keybindings.json"),
  );

  if (settingsCandidates.length === 0 && keybindingsCandidates.length === 0) return;

  // Determine which candidates are eligible for removal.
  // Each file type (settings vs keybindings) gets its own independent keepNewest:2
  // floor so that two recent settings backups cannot consume the floor and cause
  // the only keybindings backup (however old) to be deleted.
  // All candidates have a parseable timestamp, so mtimeFallback is a defensive
  // safety net only — it should never be reached in normal operation.
  const mtimeFallback = (filename: string): number | undefined => {
    try {
      const stat = lstatSync(join(config.agentDir, filename));
      return stat.mtimeMs;
    } catch {
      return undefined;
    }
  };
  const toDelete = [
    ...selectExpiredBackups(settingsCandidates, { mtimeFallback }),
    ...selectExpiredBackups(keybindingsCandidates, { mtimeFallback }),
  ];

  for (const filename of toDelete) {
    const target = join(config.agentDir, filename);

    // Assert target stays within the isolated agent dir and outside ~/.pi.
    try {
      assertProfilePathWithinAgent(config, target, "stale settings backup");
    } catch (error) {
      io.warn(
        `Skipping stale settings backup cleanup (unsafe path): ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (isSymlink(target)) continue; // Conservative: never remove or follow symlinks
    if (!existsSync(target)) continue; // Idempotent: absent is fine
    if (!lstatSync(target).isFile()) continue; // Conservative: only regular files

    if (config.dryRun) {
      io.log(`Would remove stale settings backup: ${target}`);
      continue;
    }
    try {
      rmSync(target);
      io.detailLog(`Removed stale settings backup: ${target}`);
    } catch (error) {
      io.warn(
        `failed to remove stale settings backup ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function backupExistingSettingsBeforePiInstall(
  config: ProfileCleanupConfig & { settingsPath: string },
  io: ProfileCleanupIo,
): void {
  assertSafeSettingsTarget(config);
  if (!existsSync(config.settingsPath)) return;
  const backupPath = backupPathWithTimestamp(config.settingsPath, {
    marker: "before-install",
    includeMilliseconds: false,
  });
  if (config.dryRun) {
    io.log(`Would back up existing isolated settings to: ${backupPath}`);
    return;
  }
  if (existsSync(backupPath) || isSymlink(backupPath)) {
    throw new Error(`refusing to overwrite existing settings backup: ${backupPath}`);
  }
  copyFileSync(config.settingsPath, backupPath);
  io.detailLog(`Backed up existing isolated settings to: ${backupPath}`);
}

function retiredSourceIsOnDisk(source: string, agentDir: string, io: ProfileCleanupIo): boolean {
  const trimmed = source.trim();
  let relativePath: string;
  if (trimmed.startsWith("npm:")) {
    const identity = packageIdentity(trimmed);
    if (!identity || !identity.startsWith("npm:")) return false;
    const pkgName = identity.slice("npm:".length);
    if (!pkgName) return false;
    relativePath = `npm/node_modules/${pkgName}`;
  } else {
    const parsed = parseGitSource(trimmed);
    if (!parsed) return false;
    relativePath = `git/${parsed.host}/${parsed.path}`;
  }
  const target = resolveGuardedProfilePath(
    agentDir,
    relativePath,
    "retired extension residue probe",
    io,
  );
  if (target === null) return false;
  if (isSymlink(target)) return false;
  if (!existsSync(target)) return false;
  if (!lstatSync(target).isDirectory()) return false;
  return true;
}

export function reclaimRetiredExtensionResidues(
  config: RetiredExtensionCleanupConfig,
  io: ProfileCleanupIo,
): void {
  // Read post-merge settings. Fail-safe: if settings are unreadable or have
  // an invalid schema, skip all removals rather than risk removing a user-owned
  // package. Valid JSON with a non-object root (null, array, etc.) or a present
  // non-array packages field is treated as an invalid schema.
  let postMergePackages: unknown[];
  if (existsSync(config.settingsPath)) {
    try {
      const raw = readFileSync(config.settingsPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isJsonRecord(parsed)) {
        io.warn("skipping retired extension disk reclaim: settings file has invalid schema");
        return;
      }
      if ("packages" in parsed && !Array.isArray(parsed.packages)) {
        io.warn("skipping retired extension disk reclaim: settings file has invalid schema");
        return;
      }
      postMergePackages = Array.isArray(parsed.packages) ? parsed.packages : [];
    } catch {
      io.warn("skipping retired extension disk reclaim: settings file is unreadable");
      return;
    }
  } else {
    postMergePackages = [];
  }

  // FORCE_REMOVED sources are unconditionally removed from settings by the
  // merge step, so we do not gate on the pre-merge settings file for them —
  // the settings check would yield a false preserve in dry-run (where the
  // merge step prints changes without writing).
  for (const source of FORCE_REMOVED_RETIRED_DEFAULT_EXTENSION_SOURCES) {
    if (!retiredSourceIsOnDisk(source, config.agentDir, io)) continue;
    io.runPiRemove([io.absolutePiCmd(), "remove", source]);
    if (!config.dryRun) {
      // Determine success by verifying the residue is gone, not by exit code:
      // Pi exits 1 when no settings entry remains (already removed by merge),
      // but it deletes the files first, so a missing residue means success.
      if (retiredSourceIsOnDisk(source, config.agentDir, io)) {
        io.warn(
          `failed to remove retired extension residue ${source}: residue still present after pi remove`,
        );
      } else {
        io.detailLog(`Removed retired extension residue: ${source}`);
      }
    }
  }

  // RETIRED_TLH_DEFAULT_PACKAGE_SOURCES may be kept by users; skip removal
  // when the identity is still in the post-merge settings file.
  //
  // Known dry-run limitation: these sources are provenance-gated, so we cannot
  // tell whether the merge WOULD have removed the entry without replicating the
  // merge's provenance decision here. In --dry-run the merge does not write, so
  // this gate reads pre-merge settings and a TLH-managed copy still listed there
  // is treated as preserved, omitting a `pi remove` line that a real run would
  // print. This under-reports (never over-reports) and was accepted over
  // duplicating provenance logic in the installer, which would risk diverging
  // from merge-settings. FORCE_REMOVED sources above are unaffected because
  // their removal is unconditional and needs no settings gate.
  for (const source of RETIRED_TLH_DEFAULT_PACKAGE_SOURCES) {
    const identity = packageIdentity(source);
    if (!identity) continue;
    // Skip when user has this identity in the post-merge settings.
    if (postMergePackages.some((entry) => packageIdentity(entry) === identity)) continue;
    if (!retiredSourceIsOnDisk(source, config.agentDir, io)) continue;
    io.runPiRemove([io.absolutePiCmd(), "remove", source]);
    if (!config.dryRun) {
      if (retiredSourceIsOnDisk(source, config.agentDir, io)) {
        io.warn(
          `failed to remove retired extension residue ${source}: residue still present after pi remove`,
        );
      } else {
        io.detailLog(`Removed retired extension residue: ${source}`);
      }
    }
  }
}
