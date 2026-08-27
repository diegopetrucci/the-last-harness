import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import type { InstallerPathConfig, InstallerPathOptions } from "./tlh-install-paths.mjs";
import {
  assertProfilePathWithinAgent,
  ensureSafeProfileDir,
  realpathForCompare,
  validateProfileRelativePath,
  isSymlink,
} from "./tlh-install-paths.mjs";

type ProfileWriteContent = string | NodeJS.ArrayBufferView;

interface TempArtifactIdentity {
  dev: number;
  ino: number;
}

interface CleanupAncestryEntry {
  path: string;
  identity: TempArtifactIdentity;
  realpath: string;
}

interface BeforeCommitContext {
  parent: string;
  target: string;
  tempDir: string;
  tempTarget: string;
}

interface SafeProfileWriteOptions extends InstallerPathOptions {
  mode?: number;
  encoding?: BufferEncoding;
  beforeCommit?: (context: BeforeCommitContext) => void;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function ensureSafeProfileRoot(
  config: InstallerPathConfig,
  label: string,
  options: InstallerPathOptions,
): string {
  if (isSymlink(config.agentDir)) {
    throw new Error(
      `refusing to write ${label} through symlinked TLH profile path: ${config.agentDir}`,
    );
  }
  const root = realpathForCompare(config.agentDir);
  assertProfilePathWithinAgent(config, root, label, options);
  if (existsSync(root) && !lstatSync(root).isDirectory()) {
    throw new Error(
      `refusing to use non-directory TLH profile root for ${label}: ${config.agentDir}`,
    );
  }
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

function safeProfileWriteTarget(
  config: InstallerPathConfig,
  relativePath: string,
  label: string,
  options: InstallerPathOptions,
): string {
  validateProfileRelativePath(relativePath, label);
  const base = basename(relativePath);
  const parentRelative = dirname(relativePath);
  const parent =
    parentRelative === "."
      ? ensureSafeProfileRoot(config, `${label} parent directory`, options)
      : ensureSafeProfileDir(config, parentRelative, `${label} parent directory`, options);
  const target = join(parent, base);
  if (isSymlink(target)) {
    throw new Error(`refusing to replace symlinked ${label}: ${target}`);
  }
  if (existsSync(target) && !lstatSync(target).isFile()) {
    throw new Error(`refusing to replace non-file ${label}: ${target}`);
  }
  assertProfilePathWithinAgent(config, target, label, options);
  return target;
}

function writeOptionsFor(
  content: ProfileWriteContent,
  mode: number | undefined,
  encoding: BufferEncoding | undefined,
): { mode?: number; encoding?: BufferEncoding } {
  const options: { mode?: number; encoding?: BufferEncoding } = {};
  if (mode !== undefined) options.mode = mode;
  if (typeof content === "string") options.encoding = encoding || "utf8";
  return options;
}

function tempDirIdentity(tempDir: string, action = "clean up"): TempArtifactIdentity {
  let stats;
  try {
    stats = lstatSync(tempDir);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      throw new Error(`refusing to ${action} missing temp directory: ${tempDir}`, { cause: error });
    }
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`refusing to ${action} unexpected temp directory type: ${tempDir}`);
  }
  return { dev: stats.dev, ino: stats.ino };
}

function tempFileIdentity(tempTarget: string, action = "commit"): TempArtifactIdentity {
  let stats;
  try {
    stats = lstatSync(tempTarget);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      throw new Error(`refusing to ${action} missing temp file: ${tempTarget}`, { cause: error });
    }
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`refusing to ${action} unexpected temp file type: ${tempTarget}`);
  }
  return { dev: stats.dev, ino: stats.ino };
}

function assertTempArtifactIdentity(
  path: string,
  expectedIdentity: TempArtifactIdentity,
  actualIdentity: TempArtifactIdentity,
  label: string,
  action = "commit",
): void {
  if (actualIdentity.dev !== expectedIdentity.dev || actualIdentity.ino !== expectedIdentity.ino) {
    throw new Error(`refusing to ${action} replaced ${label}: ${path}`);
  }
}

function sameIdentity(
  actualIdentity: TempArtifactIdentity,
  expectedIdentity: TempArtifactIdentity,
): boolean {
  return actualIdentity.dev === expectedIdentity.dev && actualIdentity.ino === expectedIdentity.ino;
}

function captureCleanupAncestry(
  profileRoot: string,
  parentRelative: string,
): CleanupAncestryEntry[] {
  const ancestry: CleanupAncestryEntry[] = [];
  let cursor = profileRoot;
  ancestry.push({
    path: cursor,
    identity: tempDirIdentity(cursor, "verify cleanup ancestry for"),
    realpath: realpathForCompare(cursor),
  });
  if (parentRelative === ".") return ancestry;
  for (const component of parentRelative.split("/")) {
    cursor = join(cursor, component);
    ancestry.push({
      path: cursor,
      identity: tempDirIdentity(cursor, "verify cleanup ancestry for"),
      realpath: realpathForCompare(cursor),
    });
  }
  return ancestry;
}

function cleanupAncestryUnchanged(ancestry: readonly CleanupAncestryEntry[]): boolean {
  for (const entry of ancestry) {
    let stats;
    try {
      stats = lstatSync(entry.path);
    } catch {
      return false;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    if (!sameIdentity(stats, entry.identity)) return false;
    let currentRealpath;
    try {
      currentRealpath = realpathForCompare(entry.path);
    } catch {
      return false;
    }
    if (currentRealpath !== entry.realpath) return false;
  }
  return true;
}

function cleanupTempDir(
  tempDir: string,
  expectedTempDirIdentity: TempArtifactIdentity,
  tempTarget: string,
  expectedTempTargetIdentity: TempArtifactIdentity | undefined,
  committed: boolean,
  cleanupAncestry: readonly CleanupAncestryEntry[],
): void {
  if (!cleanupAncestryUnchanged(cleanupAncestry)) return;

  let tempDirStats;
  try {
    tempDirStats = lstatSync(tempDir);
  } catch {
    return;
  }
  if (!tempDirStats.isDirectory() || tempDirStats.isSymbolicLink()) return;
  if (!sameIdentity(tempDirStats, expectedTempDirIdentity)) return;

  if (!committed && expectedTempTargetIdentity) {
    let tempTargetStats;
    try {
      tempTargetStats = lstatSync(tempTarget);
    } catch {
      return;
    }
    if (!tempTargetStats.isFile() || tempTargetStats.isSymbolicLink()) return;
    if (!sameIdentity(tempTargetStats, expectedTempTargetIdentity)) return;
    try {
      unlinkSync(tempTarget);
    } catch {
      return;
    }
  }

  let entries;
  try {
    entries = readdirSync(tempDir);
  } catch {
    return;
  }
  if (entries.length !== 0) return;
  try {
    rmdirSync(tempDir);
  } catch {
    // Best-effort cleanup only; leave the temp directory behind if anything changed.
  }
}

export function writeSafeProfileFile(
  config: InstallerPathConfig,
  relativePath: string,
  content: ProfileWriteContent,
  label = "TLH profile file",
  options: SafeProfileWriteOptions = {},
): string {
  const target = safeProfileWriteTarget(config, relativePath, label, options);
  const resolvedMode =
    options.mode ?? (existsSync(target) ? lstatSync(target).mode & 0o777 : undefined);
  const parent = dirname(target);
  const parentRelative = dirname(relativePath);
  const cleanupAncestry = captureCleanupAncestry(
    realpathForCompare(config.agentDir),
    parentRelative,
  );
  const base = basename(target);
  const tempDir = mkdtempSync(join(parent, `.${base}.tmp.`));
  const expectedTempDirIdentity = tempDirIdentity(tempDir);
  const tempTarget = join(tempDir, base);
  let expectedTempTargetIdentity: TempArtifactIdentity | undefined;
  let committed = false;

  try {
    writeFileSync(tempTarget, content, writeOptionsFor(content, resolvedMode, options.encoding));
    if (resolvedMode !== undefined) chmodSync(tempTarget, resolvedMode);
    expectedTempTargetIdentity = tempFileIdentity(tempTarget);
    if (typeof options.beforeCommit === "function") {
      options.beforeCommit({ parent, target, tempDir, tempTarget });
    }
    const verifiedTarget = safeProfileWriteTarget(config, relativePath, label, options);
    if (verifiedTarget !== target) {
      throw new Error(`refusing to replace moved ${label}: ${target}`);
    }
    assertTempArtifactIdentity(
      tempDir,
      expectedTempDirIdentity,
      tempDirIdentity(tempDir, "commit"),
      "temp directory",
    );
    assertTempArtifactIdentity(
      tempTarget,
      expectedTempTargetIdentity,
      tempFileIdentity(tempTarget),
      "temp file",
    );
    renameSync(tempTarget, target);
    committed = true;
  } finally {
    cleanupTempDir(
      tempDir,
      expectedTempDirIdentity,
      tempTarget,
      expectedTempTargetIdentity,
      committed,
      cleanupAncestry,
    );
  }

  return target;
}
