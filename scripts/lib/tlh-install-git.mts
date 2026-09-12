import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import { criticalGitSourceSpec } from "./tlh-install-package-source.mjs";
import {
  assertProfilePathWithinAgent,
  isSymlink,
  pathWithinOrEqual,
  realpathForCompare,
} from "./tlh-install-paths.mjs";
import { readRegularFileForBackup } from "./tlh-install-utils.mjs";
export { readConfiguredNpmCommand } from "./tlh-install-utils.mjs";

const COMMAND_MAX_BUFFER = 20 * 1024 * 1024;
// Keep the completion marker in the checkout's resolved Git metadata so it
// neither dirties the worktree nor depends on node_modules being ignored.
// Format: JSON {
//   schemaVersion: 2,
//   head: <full installed checkout HEAD>,
//   dependencyInputs: { dependencies, optionalDependencies, peerDependencies,
//                       peerDependenciesMeta }
// }.
// A marker from schema 1 is intentionally not reusable: HEAD alone cannot
// prove that the installed dependency tree matches the checkout manifest.
const NPM_INSTALL_MARKER_FILENAME = "tlh-npm-install-complete.json";
const NPM_INSTALL_MARKER_SCHEMA_VERSION = 2;
const READ_ONLY_GIT_ENV = { GIT_OPTIONAL_LOCKS: "0" };
const ROOT_NODE_MODULES_PATHSPEC = ":(top,exclude)node_modules";
const BACKUP_CHECKOUT_PATHSPEC = ":(top,glob)**/*";
const ROOT_NODE_MODULES_CLEAN_EXCLUDE = "/node_modules/";

export interface GitInstallConfig {
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  /**
   * The configured package-manager command, when one is present in isolated
   * settings. An empty/undefined value means the normal npm fallback.
   */
  npmCommand?: readonly string[];
  dryRun?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

/**
 * Safe, path-free lifecycle events for deterministic installer observations.
 * These events are emitted only when a caller supplies an observer; they are
 * not part of normal installer output unless the stage-1 installer opts in.
 */
export type GitCheckoutInstrumentationEvent =
  | { type: "pi-reconciliation"; phase: "start" | "failed" }
  | { type: "pi-reconciliation"; phase: "complete"; headChanged: boolean }
  | {
      type: "tlh-repair";
      phase: "start" | "complete" | "failed" | "skipped";
      reason: "invalid-marker-or-dependencies" | "pi-repaired-dependencies";
    }
  | {
      type: "managed-checkout-summary";
      tlhGitFetches: number;
      tlhPackageManagerInstalls: number;
    };

interface SpawnCaptureOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
}

interface GitIo {
  runCommand?: (
    config: GitInstallConfig,
    commandArgs: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => void;
  runInDir?: (config: GitInstallConfig, dir: string, commandArgs: string[]) => void;
  printCommand?: (commandArgs: string[]) => void;
  log?: (config: GitInstallConfig, message: string) => void;
  warn?: (message: string) => void;
  onInstrumentationEvent?: (event: GitCheckoutInstrumentationEvent) => void;
  spawnCapture?: (
    config: GitInstallConfig,
    commandArgs: string[],
    options?: SpawnCaptureOptions,
  ) => SpawnSyncReturns<string>;
}

type DependencyMap = Record<string, unknown>;
type StableJsonValue =
  | null
  | boolean
  | number
  | string
  | StableJsonValue[]
  | { [key: string]: StableJsonValue };

interface DependencyInputs {
  dependencies: DependencyMap;
  optionalDependencies: DependencyMap;
  peerDependencies: DependencyMap;
  peerDependenciesMeta: DependencyMap;
}

export type GitCheckoutPreparationStatus = "missing" | "clean" | "dirty" | "malformed" | "dry-run";

interface GitIndexSnapshot {
  path: string;
  exists: boolean;
  content?: Buffer;
  mode?: number;
}

/**
 * State captured before Pi operates on a managed checkout.
 *
 * Existing checkouts use an alternate index for TLH-owned preparation and
 * finalization Git operations without overwriting the caller's real index.
 * Pi and package-manager children never receive that alternate path. The
 * exact caller-owned index state is restored after Pi and on every normal
 * lifecycle failure. A preparation is single-use; after cleanup, `consumed`
 * prevents a second finalization from reaching Git with a missing temporary
 * index.
 */
export interface GitCheckoutPreparation {
  targetDir: string;
  status: GitCheckoutPreparationStatus;
  /** HEAD and marker/dependency state observed before Pi ran. */
  head?: string;
  markerPath?: string;
  markerValid?: boolean;
  directDependenciesPresent?: boolean;
  indexFile?: string;
  gitDir?: string;
  /** Exact pre-Pi real-index state, including a missing index and mode. */
  realIndexSnapshot?: GitIndexSnapshot;
  realIndexRestored?: boolean;
  realIndexSynchronized?: boolean;
  consumed?: boolean;
}

export interface GitCheckoutOptions {
  targetDir: string;
  repo?: string;
  label: string;
  missingMessage: string;
  warnOnMissing?: boolean;
}

function commandDisplay(commandArgs: readonly string[]): string {
  return commandArgs.map(String).join(" ");
}

function inheritedCommandEnv(
  config: GitInstallConfig,
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = { ...(config.env || process.env), ...extraEnv };
  // An alternate index is opt-in for a specific TLH Git operation. Never let
  // an ambient value reach package-manager commands or foreign child tools.
  if (!extraEnv.GIT_INDEX_FILE) delete env.GIT_INDEX_FILE;
  return env;
}

function defaultSpawnCapture(
  config: GitInstallConfig,
  commandArgs: string[],
  { cwd, env = {}, allowFailure = false }: SpawnCaptureOptions = {},
): SpawnSyncReturns<string> {
  const [command, ...args] = commandArgs;
  const result = spawnSync(command, args, {
    cwd,
    env: inheritedCommandEnv(config, env),
    encoding: "utf8",
    maxBuffer: COMMAND_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    throw new Error(
      output || result.error?.message || `command failed: ${commandDisplay(commandArgs)}`,
    );
  }
  return result;
}

function requireRunCommand(io: GitIo): NonNullable<GitIo["runCommand"]> {
  if (typeof io.runCommand !== "function") {
    throw new Error("runCommand callback is required to refresh git checkouts");
  }
  return io.runCommand;
}

function runGitCommand(
  config: GitInstallConfig,
  commandArgs: string[],
  io: GitIo,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  requireRunCommand(io)(config, commandArgs, {
    ...options,
    env: gitEnvironment(options.env),
  });
}

function runCommandInDir(
  config: GitInstallConfig,
  dir: string,
  commandArgs: string[],
  io: GitIo,
): void {
  if (typeof io.runInDir === "function") {
    io.runInDir(config, dir, commandArgs);
    return;
  }
  requireRunCommand(io)(config, commandArgs, { cwd: dir });
}

function printDryRunCommand(commandArgs: string[], io: GitIo): void {
  if (typeof io.printCommand === "function") io.printCommand(commandArgs);
}

function logDryRun(config: GitInstallConfig, message: string, io: GitIo): void {
  if (typeof io.log === "function") io.log(config, message);
}

function logVerbose(config: GitInstallConfig, message: string, io: GitIo): void {
  if (config.verbose && !config.quiet && typeof io.log === "function") io.log(config, message);
}

function warn(message: string, io: GitIo): void {
  if (typeof io.warn === "function") io.warn(message);
  else console.error(`warning: ${message}`);
}

function emitInstrumentationEvent(io: GitIo, event: GitCheckoutInstrumentationEvent): void {
  try {
    io.onInstrumentationEvent?.(event);
  } catch {
    // Instrumentation must never change installer behavior.
  }
}

function npmInstallMarkerPath(
  config: GitInstallConfig,
  targetDir: string,
  label: string,
  io: GitIo,
): string {
  const gitDir = gitOutput(config, targetDir, ["rev-parse", "--absolute-git-dir"], io);
  if (!gitDir) throw new Error(`could not resolve ${label} git metadata directory`);
  const confinedGitDir = realpathForCompare(gitDir);
  assertProfilePathWithinAgent(config, confinedGitDir, `${label} npm install marker`);
  return join(confinedGitDir, NPM_INSTALL_MARKER_FILENAME);
}

function isRegularDirectory(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJsonValue(value: unknown): StableJsonValue {
  if (Array.isArray(value)) return value.map((item) => stableJsonValue(item));
  if (!isJsonRecord(value)) return value as StableJsonValue;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])]),
  ) as { [key: string]: StableJsonValue };
}

function dependencyInputsFromPackageJson(pkgJson: unknown): DependencyInputs | undefined {
  if (!isJsonRecord(pkgJson)) return undefined;
  const inputs = {} as DependencyInputs;
  for (const key of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
  ] as const) {
    const value = pkgJson[key];
    if (value === undefined) {
      inputs[key] = {};
      continue;
    }
    if (!isJsonRecord(value)) return undefined;
    inputs[key] = stableJsonValue(value) as DependencyMap;
  }
  return inputs;
}

function readDependencyInputs(targetDir: string): DependencyInputs | undefined {
  try {
    return dependencyInputsFromPackageJson(
      JSON.parse(readFileSync(join(targetDir, "package.json"), "utf8")),
    );
  } catch {
    return undefined;
  }
}

function dependencyInputsEqual(left: unknown, right: DependencyInputs): boolean {
  if (!isJsonRecord(left)) return false;
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

function readNpmInstallMarker(
  markerPath: string,
  head: string,
  dependencyInputs: DependencyInputs | undefined,
): boolean {
  if (!dependencyInputs) return false;
  try {
    const stats = lstatSync(markerPath);
    if (stats.isSymbolicLink() || !stats.isFile()) return false;
    const parsed: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
    if (!isJsonRecord(parsed)) return false;
    return (
      parsed.schemaVersion === NPM_INSTALL_MARKER_SCHEMA_VERSION &&
      parsed.head === head &&
      dependencyInputsEqual(parsed.dependencyInputs, dependencyInputs)
    );
  } catch {
    return false;
  }
}

/**
 * Returns true when every key of the checkout's `dependencies` map resolves to
 * an existing directory under `<targetDir>/node_modules/<name>`. Only direct
 * production dependencies are checked because the checkout installs with
 * `--omit=dev`, and `optionalDependencies` can legitimately be absent.
 * Transitive packages are not verified because the install uses
 * `--package-lock=false`. Fails toward correctness: a missing, unreadable, or
 * malformed package.json forces reinstall; an absent or empty `dependencies`
 * map may still reuse when the other gates pass.
 */
function isSafeDependencyDirectory(nodeModulesDir: string, dependencyPath: string): boolean {
  try {
    const stats = lstatSync(dependencyPath);
    if (stats.isDirectory() && !stats.isSymbolicLink()) return true;
    if (!stats.isSymbolicLink()) return false;

    // pnpm links direct dependencies into node_modules/.pnpm. Resolve the
    // link, but only accept a real directory that remains inside this
    // checkout's dependency tree; arbitrary links outside node_modules are
    // not evidence of a complete install.
    const resolvedNodeModulesDir = realpathForCompare(nodeModulesDir);
    const resolvedDependencyPath = realpathForCompare(dependencyPath);
    return (
      pathWithinOrEqual(resolvedNodeModulesDir, resolvedDependencyPath) &&
      isRegularDirectory(resolvedDependencyPath)
    );
  } catch {
    return false;
  }
}

function allDirectDepsPresent(targetDir: string): boolean {
  const inputs = readDependencyInputs(targetDir);
  if (!inputs) return false;
  const dependencyNames = Object.keys(inputs.dependencies);
  // npm does not create node_modules for a package with no direct
  // dependencies. That is still a complete production dependency tree.
  if (dependencyNames.length === 0) return true;
  const nodeModulesDir = resolve(targetDir, "node_modules");
  if (!isRegularDirectory(nodeModulesDir)) return false;
  for (const name of dependencyNames) {
    // Scoped names (e.g. "@scope/pkg") resolve naturally through path joining.
    // Refuse malformed/traversing package names rather than checking outside
    // the node_modules root.
    if (
      !name ||
      name.includes("\0") ||
      name
        .split(/[\\\\/]/)
        .some((component) => component === "" || component === "." || component === "..")
    ) {
      return false;
    }
    const dependencyPath = resolve(nodeModulesDir, name);
    const relativeDependencyPath = relative(nodeModulesDir, dependencyPath);
    if (
      !relativeDependencyPath ||
      relativeDependencyPath.startsWith("..") ||
      resolve(nodeModulesDir, relativeDependencyPath) !== dependencyPath ||
      !isSafeDependencyDirectory(nodeModulesDir, dependencyPath)
    ) {
      return false;
    }
  }
  return true;
}

function directDependencyCount(targetDir: string): number {
  const inputs = readDependencyInputs(targetDir);
  return inputs ? Object.keys(inputs.dependencies).length : 0;
}

function symlinkedMarkerError(action: string, markerPath: string): Error {
  return new Error(
    `refusing to ${action} symlinked npm install marker: ${markerPath}; remove the symlink (not its target) and rerun the installer`,
  );
}

function invalidateNpmInstallMarker(markerPath: string): void {
  try {
    const stats = lstatSync(markerPath);
    if (stats.isSymbolicLink()) {
      // Never remove or follow an attacker-controlled marker link. Leaving it
      // in place makes the failed-safe state visible and causes the next run
      // to stop rather than silently replacing a path that may be user-owned.
      throw symlinkedMarkerError("invalidate", markerPath);
    }
    if (!stats.isFile()) {
      // An unexpected directory or special file cannot validate as a marker.
      // Leave it untouched; marker persistence will warn and the next refresh
      // will retry rather than treating it as a successful install.
      return;
    }
    unlinkSync(markerPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function writeNpmInstallMarker(
  markerPath: string,
  head: string,
  dependencyInputs: DependencyInputs,
): void {
  if (isSymlink(markerPath)) {
    throw symlinkedMarkerError("replace", markerPath);
  }

  const tempPath = join(dirname(markerPath), `.${basename(markerPath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(
      tempPath,
      `${JSON.stringify({
        schemaVersion: NPM_INSTALL_MARKER_SCHEMA_VERSION,
        head,
        dependencyInputs,
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    if (isSymlink(markerPath)) {
      throw symlinkedMarkerError("replace", markerPath);
    }
    renameSync(tempPath, markerPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function gitEnvironment(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // Keep the explicit undefined value so test/custom runners also scrub an
  // ambient index. Only callers of a specific Git operation may opt in to one.
  return { GIT_INDEX_FILE: undefined, ...READ_ONLY_GIT_ENV, ...extraEnv };
}

function indexPathForCheckout(
  config: GitInstallConfig,
  targetDir: string,
  label: string,
  io: GitIo,
): string {
  const rawPath = gitOutput(config, targetDir, ["rev-parse", "--git-path", "index"], io);
  if (!rawPath) throw new Error(`could not resolve ${label} Git index path`);
  const candidatePath = resolve(targetDir, rawPath);
  // Git may print a path using a non-canonical /var vs /private/var spelling
  // on macOS. Canonicalize only the existing parent, never the final index
  // entry, so a symlinked index is still detected and refused.
  const indexPath = join(realpathForCompare(dirname(candidatePath)), basename(candidatePath));
  assertProfilePathWithinAgent(config, indexPath, `${label} Git index`);
  return indexPath;
}

function snapshotRealIndex(
  config: GitInstallConfig,
  targetDir: string,
  label: string,
  io: GitIo,
): GitIndexSnapshot {
  const indexPath = indexPathForCheckout(config, targetDir, label, io);
  try {
    const { content, mode } = readRegularFileForBackup(indexPath, `${label} Git index`);
    return { path: indexPath, exists: true, content, mode };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { path: indexPath, exists: false };
    }
    throw error;
  }
}

function assertSafeIndexParent(config: GitInstallConfig, indexPath: string, label: string): string {
  assertProfilePathWithinAgent(config, indexPath, `${label} Git index`);
  const agentRoot = realpathForCompare(config.agentDir);
  const parentDir = dirname(indexPath);
  let current = parentDir;
  while (pathWithinOrEqual(agentRoot, current)) {
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `refusing to restore ${label} Git index through a symlinked directory: ${current}`,
      );
    }
    if (!stats.isDirectory()) {
      throw new Error(`refusing to restore ${label} Git index through a non-directory: ${current}`);
    }
    if (current === agentRoot) return parentDir;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`refusing to restore ${label} Git index outside the isolated profile`);
}

function restoreRealIndex(
  config: GitInstallConfig,
  preparation: GitCheckoutPreparation | undefined,
  force = false,
): void {
  if (!preparation) return;
  const snapshot = preparation.realIndexSnapshot;
  if (!snapshot || preparation.realIndexRestored || (preparation.realIndexSynchronized && !force))
    return;
  const parentDir = assertSafeIndexParent(config, snapshot.path, preparation.targetDir);
  const restoreTempPath = join(
    parentDir,
    `.${basename(snapshot.path)}.tlh-restore-${randomUUID()}.tmp`,
  );
  try {
    if (snapshot.exists) {
      if (!snapshot.content || snapshot.mode === undefined) {
        throw new Error(`invalid saved Git index state for ${preparation.targetDir}`);
      }
      writeFileSync(restoreTempPath, snapshot.content, { flag: "wx", mode: snapshot.mode });
      chmodSync(restoreTempPath, snapshot.mode);
      renameSync(restoreTempPath, snapshot.path);
      const restoredStats = lstatSync(snapshot.path);
      if (
        restoredStats.isSymbolicLink() ||
        !restoredStats.isFile() ||
        (restoredStats.mode & 0o777) !== snapshot.mode ||
        !readFileSync(snapshot.path).equals(snapshot.content)
      ) {
        throw new Error(`restored Git index did not match its pre-Pi state: ${snapshot.path}`);
      }
    } else {
      try {
        const currentStats = lstatSync(snapshot.path);
        if (
          currentStats.isDirectory() ||
          (!currentStats.isFile() && !currentStats.isSymbolicLink())
        ) {
          throw new Error(`refusing to remove non-regular Git index: ${snapshot.path}`);
        }
        unlinkSync(snapshot.path);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          // The index is already in its pre-Pi absent state.
        } else {
          throw error;
        }
      }
      if (existsSync(snapshot.path) || isSymlink(snapshot.path)) {
        throw new Error(`restored Git index should be absent: ${snapshot.path}`);
      }
    }
    preparation.realIndexRestored = true;
  } finally {
    rmSync(restoreTempPath, { force: true });
  }
}

function gitOutput(
  config: GitInstallConfig,
  targetDir: string,
  args: string[],
  io: GitIo = {},
  env: NodeJS.ProcessEnv = {},
): string {
  const spawnCapture = io.spawnCapture || defaultSpawnCapture;
  return spawnCapture(config, ["git", "-C", targetDir, ...args], {
    env: gitEnvironment(env),
  }).stdout.trim();
}

function gitSucceeds(
  config: GitInstallConfig,
  targetDir: string,
  args: string[],
  io: GitIo = {},
  env: NodeJS.ProcessEnv = {},
): boolean {
  const spawnCapture = io.spawnCapture || defaultSpawnCapture;
  const result = spawnCapture(config, ["git", "-C", targetDir, ...args], {
    allowFailure: true,
    env: gitEnvironment(env),
  });
  return !result.error && result.status === 0;
}

function checkoutStatus(
  config: GitInstallConfig,
  targetDir: string,
  io: GitIo,
  env: NodeJS.ProcessEnv = {},
): string {
  return gitOutput(
    config,
    targetDir,
    ["status", "--porcelain", "--untracked-files=all", "--", ".", ROOT_NODE_MODULES_PATHSPEC],
    io,
    env,
  );
}

function cleanCheckout(
  config: GitInstallConfig,
  targetDir: string,
  io: GitIo,
  env: NodeJS.ProcessEnv = {},
): void {
  runGitCommand(
    config,
    ["git", "-C", targetDir, "clean", "-fd", "-e", ROOT_NODE_MODULES_CLEAN_EXCLUDE],
    io,
    { env },
  );
}

function backupRefs(config: GitInstallConfig, targetDir: string, io: GitIo = {}): string[] {
  const spawnCapture = io.spawnCapture || defaultSpawnCapture;
  const result = spawnCapture(
    config,
    ["git", "-C", targetDir, "for-each-ref", "refs/tlh-backup", "--format=%(refname)"],
    { allowFailure: true, env: gitEnvironment() },
  );
  if (result.error || result.status !== 0) return [];
  return (result.stdout || "").trim() === ""
    ? []
    : (result.stdout || "").trim().split("\n").filter(Boolean);
}

function collisionSafeBackupRef(
  config: GitInstallConfig,
  targetDir: string,
  kind: "worktree" | "index",
  io: GitIo,
): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ref = `refs/tlh-backup/${kind}/${timestamp}-${randomUUID()}`;
    if (!gitSucceeds(config, targetDir, ["show-ref", "--verify", "--quiet", ref], io)) {
      return ref;
    }
  }
  throw new Error(`could not allocate a collision-safe TLH ${kind} backup ref`);
}

function malformedCheckoutError(targetDir: string, label: string, refs: string[]): Error {
  if (refs.length > 0) {
    return new Error(
      `refusing destructive repair of malformed ${label}: ${targetDir}; preserve existing TLH backup refs (${refs.join(", ")}) and repair it manually; no checkout changes were made`,
    );
  }
  return new Error(
    `unable to safely prepare malformed ${label}: ${targetDir}; no TLH backup refs were found. Repair the Git index or checkout manually, then rerun; no checkout changes were made`,
  );
}

function malformedCheckoutPreparation(
  config: GitInstallConfig,
  targetDir: string,
  label: string,
  io: GitIo,
): GitCheckoutPreparation {
  const refs = backupRefs(config, targetDir, io);
  if (refs.length > 0) throw malformedCheckoutError(targetDir, label, refs);
  if (!config.quiet) {
    warn(
      `unable to safely prepare malformed ${label}: ${targetDir}; no TLH backup refs were found. Repair the Git index or checkout manually, then rerun; no checkout changes were made`,
      io,
    );
  }
  return { targetDir, status: "malformed" };
}

function assertGitRepositoryConfined(
  config: GitInstallConfig,
  targetDir: string,
  label = "git package checkout",
  io: GitIo = {},
): void {
  const topLevel = gitOutput(config, targetDir, ["rev-parse", "--show-toplevel"], io);
  const gitDir = gitOutput(config, targetDir, ["rev-parse", "--absolute-git-dir"], io);
  let commonGitDir = gitOutput(config, targetDir, ["rev-parse", "--git-common-dir"], io);
  if (!commonGitDir.startsWith("/")) commonGitDir = join(targetDir, commonGitDir);

  const normalizedTarget = realpathForCompare(targetDir);
  const normalizedTop = realpathForCompare(topLevel);
  if (normalizedTop !== normalizedTarget) {
    throw new Error(
      `refusing to use ${label} with worktree outside the package path: ${targetDir}`,
    );
  }
  assertProfilePathWithinAgent(config, gitDir, `${label} git metadata`);
  assertProfilePathWithinAgent(config, commonGitDir, `${label} common git metadata`);
}

export function assertGitSourceTargetSafe(
  config: GitInstallConfig,
  source: string,
  label = "git package checkout",
  io: GitIo = {},
): void {
  const spec = criticalGitSourceSpec(source, { agentDir: config.agentDir });
  if (!spec) return;
  const targetDir = spec.targetDir;
  const gitMetadata = join(targetDir, ".git");
  assertProfilePathWithinAgent(config, targetDir, label);
  if (isSymlink(targetDir)) throw new Error(`refusing to use symlinked ${label}: ${targetDir}`);
  if (existsSync(targetDir) && !lstatSync(targetDir).isDirectory()) {
    throw new Error(`refusing to use non-directory ${label}: ${targetDir}`);
  }
  if (existsSync(targetDir) && !existsSync(gitMetadata)) {
    throw new Error(`refusing to use existing non-git ${label}: ${targetDir}`);
  }
  if (isSymlink(gitMetadata))
    throw new Error(`refusing to use ${label} with symlinked git metadata: ${gitMetadata}`);
  if (
    existsSync(gitMetadata) &&
    !lstatSync(gitMetadata).isDirectory() &&
    !lstatSync(gitMetadata).isFile()
  ) {
    throw new Error(`refusing to use ${label} with unsupported git metadata: ${gitMetadata}`);
  }
  if (existsSync(gitMetadata)) {
    assertProfilePathWithinAgent(config, gitMetadata, `${label} git metadata`);
    assertGitRepositoryConfined(config, targetDir, label, io);
  }
}

function safeGitCheckoutDirForMutation(
  config: GitInstallConfig,
  targetDir: string,
  label = "git package checkout",
  io: GitIo = {},
): boolean {
  assertProfilePathWithinAgent(config, targetDir, label);
  if (isSymlink(targetDir)) throw new Error(`refusing to mutate symlinked ${label}: ${targetDir}`);
  if (!existsSync(targetDir) || !lstatSync(targetDir).isDirectory()) return false;
  const gitMetadata = join(targetDir, ".git");
  if (isSymlink(gitMetadata))
    throw new Error(`refusing to mutate ${label} with symlinked git metadata: ${gitMetadata}`);
  if (!existsSync(gitMetadata)) return false;
  if (!lstatSync(gitMetadata).isDirectory() && !lstatSync(gitMetadata).isFile()) return false;
  assertProfilePathWithinAgent(config, gitMetadata, `${label} git metadata`);
  assertGitRepositoryConfined(config, targetDir, label, io);
  return true;
}

function normalizeGitOrigin(
  config: GitInstallConfig,
  targetDir: string,
  repo: string | undefined,
  io: GitIo,
): void {
  if (!repo) return;
  if (gitSucceeds(config, targetDir, ["remote", "get-url", "origin"], io)) {
    runGitCommand(config, ["git", "-C", targetDir, "remote", "set-url", "origin", repo], io);
  } else {
    runGitCommand(config, ["git", "-C", targetDir, "remote", "add", "origin", repo], io);
  }
}

function createAlternateIndex(
  config: GitInstallConfig,
  targetDir: string,
  label: string,
  head: string,
  io: GitIo,
): { indexFile: string; tempDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "tlh-git-index-"));
  const indexFile = join(tempDir, "index");
  try {
    runGitCommand(config, ["git", "-C", targetDir, "read-tree", head], io, {
      env: { GIT_INDEX_FILE: indexFile },
    });
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`could not prepare alternate index for ${label}: ${String(error)}`, {
      cause: error,
    });
  }
  return { indexFile, tempDir };
}

function backupDirtyCheckout(
  config: GitInstallConfig,
  targetDir: string,
  head: string,
  indexFile: string,
  io: GitIo,
): void {
  const indexEnv = { GIT_INDEX_FILE: indexFile };
  runGitCommand(config, ["git", "-C", targetDir, "add", "-A", "--", BACKUP_CHECKOUT_PATHSPEC], io, {
    env: indexEnv,
  });
  // The positive glob avoids Git's ignored-path error while still collecting
  // all other changes. Remove any unignored root node_modules entries from the
  // alternate index before writing the backup tree.
  runGitCommand(config, ["git", "-C", targetDir, "reset", "--", "node_modules"], io, {
    env: indexEnv,
  });
  const tree = gitOutput(config, targetDir, ["write-tree"], io, indexEnv);
  const timestamp = new Date().toISOString();
  const backupRef = collisionSafeBackupRef(config, targetDir, "worktree", io);
  const commit = gitOutput(
    config,
    targetDir,
    [
      "-c",
      "user.name=tlh-backup",
      "-c",
      "user.email=tlh-backup@local",
      "commit-tree",
      tree,
      "-p",
      head,
      "-m",
      `tlh worktree backup ${timestamp}`,
    ],
    io,
    indexEnv,
  );
  runGitCommand(config, ["git", "-C", targetDir, "update-ref", backupRef, commit], io, {
    env: indexEnv,
  });

  if (!config.quiet) {
    warn(`dirty checkout at ${targetDir} — worktree changes backed up to ${backupRef}`, io);
    warn(`  inspect: git -C ${targetDir} show ${backupRef}`, io);
    warn(
      `  recover worktree changes: git -C ${targetDir} diff ${head} ${backupRef} | git -C ${targetDir} apply`,
      io,
    );
  }
  if (config.verbose && !config.quiet) {
    const diffBody = gitOutput(config, targetDir, ["diff", head, backupRef], io);
    const diffLines = diffBody.split("\n");
    const truncated = diffLines.length > 200;
    warn(diffLines.slice(0, 200).join("\n"), io);
    if (truncated) warn("... truncated, use the diff command above for full content", io);
  }
}

function backupPrePiIndex(
  config: GitInstallConfig,
  targetDir: string,
  head: string,
  snapshot: GitIndexSnapshot | undefined,
  label: string,
  io: GitIo,
): string | undefined {
  if (!snapshot?.exists || !snapshot.content || snapshot.mode === undefined) return undefined;

  const tempDir = mkdtempSync(join(tmpdir(), "tlh-git-index-backup-"));
  const indexFile = join(tempDir, "index");
  const indexEnv = { GIT_INDEX_FILE: indexFile };
  try {
    writeFileSync(indexFile, snapshot.content, { flag: "wx", mode: snapshot.mode });
    chmodSync(indexFile, snapshot.mode);
    const indexTree = gitOutput(config, targetDir, ["write-tree"], io, indexEnv);
    const headTree = gitOutput(config, targetDir, ["rev-parse", `${head}^{tree}`], io);
    if (indexTree === headTree) return undefined;

    const timestamp = new Date().toISOString();
    const backupRef = collisionSafeBackupRef(config, targetDir, "index", io);
    const commit = gitOutput(
      config,
      targetDir,
      [
        "-c",
        "user.name=tlh-backup",
        "-c",
        "user.email=tlh-backup@local",
        "commit-tree",
        indexTree,
        "-p",
        head,
        "-m",
        `tlh staged index backup ${timestamp}`,
      ],
      io,
      indexEnv,
    );
    runGitCommand(config, ["git", "-C", targetDir, "update-ref", backupRef, commit], io, {
      env: indexEnv,
    });

    if (!config.quiet) {
      warn(
        `pre-Pi staged index for ${targetDir} differed from ${head}; backed up to ${backupRef}`,
        io,
      );
      warn(`  inspect: git -C ${targetDir} show ${backupRef}`, io);
      warn(`  recover staged index: git -C ${targetDir} read-tree ${backupRef}^{tree}`, io);
    }
    return backupRef;
  } catch (error) {
    throw new Error(`could not preserve the pre-Pi staged index for ${label}: ${String(error)}`, {
      cause: error,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function checkoutEnvironment(preparation: GitCheckoutPreparation | undefined): NodeJS.ProcessEnv {
  return preparation?.indexFile ? { GIT_INDEX_FILE: preparation.indexFile } : {};
}

function currentCheckoutHead(
  config: GitInstallConfig,
  targetDir: string,
  io: GitIo,
): string | undefined {
  if (!gitSucceeds(config, targetDir, ["rev-parse", "--verify", "HEAD^{commit}"], io)) {
    return undefined;
  }
  return gitOutput(config, targetDir, ["rev-parse", "--verify", "HEAD^{commit}"], io);
}

function synchronizeRealIndexToHead(
  config: GitInstallConfig,
  targetDir: string,
  head: string,
  label: string,
  io: GitIo,
): void {
  const indexPath = indexPathForCheckout(config, targetDir, label, io);
  assertSafeIndexParent(config, indexPath, label);
  try {
    const stats = lstatSync(indexPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`refusing to synchronize non-regular ${label} Git index: ${indexPath}`);
    }
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }

  // This is intentionally the one changed-HEAD path that writes the real
  // index. Pi never receives this environment, and same-HEAD/failure paths
  // restore the original bytes instead.
  runGitCommand(config, ["git", "-C", targetDir, "read-tree", head], io);
  const indexTree = gitOutput(config, targetDir, ["write-tree"], io);
  const headTree = gitOutput(config, targetDir, ["rev-parse", `${head}^{tree}`], io);
  if (indexTree !== headTree) {
    throw new Error(`synchronized ${label} Git index does not match finalized HEAD`);
  }
}

/**
 * Prepare an existing managed checkout for Pi.
 *
 * No network operation is performed here. A valid checkout gets a temporary
 * alternate index, dirty content is committed under refs/tlh-backup, and only
 * that alternate index is reset/cleaned. The real index is never written.
 */
export function prepareGitCheckout(
  config: GitInstallConfig,
  options: GitCheckoutOptions,
  io: GitIo = {},
): GitCheckoutPreparation {
  const { targetDir, repo, label } = options;
  if (config.dryRun) {
    if (repo) printDryRunCommand(["git", "-C", targetDir, "remote", "set-url", "origin", repo], io);
    printDryRunCommand(
      [
        "git",
        "-C",
        targetDir,
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ".",
        ROOT_NODE_MODULES_PATHSPEC,
      ],
      io,
    );
    printDryRunCommand(["git", "-C", targetDir, "read-tree", "HEAD"], io);
    printDryRunCommand(["git", "-C", targetDir, "reset", "--hard", "HEAD"], io);
    printDryRunCommand(
      ["git", "-C", targetDir, "clean", "-fd", "-e", ROOT_NODE_MODULES_CLEAN_EXCLUDE],
      io,
    );
    logDryRun(config, "Would preserve the real Git index with an alternate index during Pi.", io);
    return { targetDir, status: "dry-run" };
  }

  if (!safeGitCheckoutDirForMutation(config, targetDir, label, io)) {
    return { targetDir, status: "missing" };
  }

  let gitDir: string;
  try {
    gitDir = realpathForCompare(
      gitOutput(config, targetDir, ["rev-parse", "--absolute-git-dir"], io),
    );
  } catch {
    return malformedCheckoutPreparation(config, targetDir, label, io);
  }
  // Capture the real index before status or any other checkout preparation
  // command can inspect it. Pi and package-manager children never receive
  // this path; it is restored byte-for-byte after their work.
  const realIndexSnapshot = snapshotRealIndex(config, targetDir, label, io);

  try {
    // Probe the real index without allowing Git to refresh or repair it. A
    // malformed real index is not safe to overwrite when TLH backup refs may
    // be the only recoverable copy of the checkout.
    gitOutput(config, targetDir, ["status", "--porcelain", "--untracked-files=all"], io);
  } catch {
    return malformedCheckoutPreparation(config, targetDir, label, io);
  }

  let head: string;
  try {
    head = gitOutput(config, targetDir, ["rev-parse", "--verify", "HEAD^{commit}"], io);
  } catch {
    return malformedCheckoutPreparation(config, targetDir, label, io);
  }

  normalizeGitOrigin(config, targetDir, repo, io);
  const { indexFile, tempDir } = createAlternateIndex(config, targetDir, label, head, io);
  let statusOutput: string;
  try {
    const indexEnv = { GIT_INDEX_FILE: indexFile };
    statusOutput = checkoutStatus(config, targetDir, io, indexEnv);
    if (statusOutput !== "") {
      backupDirtyCheckout(config, targetDir, head, indexFile, io);
    }
    runGitCommand(config, ["git", "-C", targetDir, "reset", "--hard", "HEAD"], io, {
      env: indexEnv,
    });
    cleanCheckout(config, targetDir, io, indexEnv);
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }

  const markerPath = join(gitDir, NPM_INSTALL_MARKER_FILENAME);
  const dependencyInputs = readDependencyInputs(targetDir);
  const directDependenciesPresent = allDirectDepsPresent(targetDir);
  return {
    targetDir,
    status: statusOutput === "" ? "clean" : "dirty",
    head,
    markerPath,
    markerValid:
      readNpmInstallMarker(markerPath, head, dependencyInputs) && directDependenciesPresent,
    directDependenciesPresent,
    indexFile,
    gitDir,
    realIndexSnapshot,
  };
}

function assertPreparationStillTargetsSameRepository(
  config: GitInstallConfig,
  preparation: GitCheckoutPreparation | undefined,
  targetDir: string,
  label: string,
  io: GitIo,
): void {
  if (!preparation) return;
  if (realpathForCompare(preparation.targetDir) !== realpathForCompare(targetDir)) {
    throw new Error(`refusing to finalize ${label} for a different checkout target`);
  }
  if (!preparation.gitDir) return;
  const currentGitDir = realpathForCompare(
    gitOutput(config, targetDir, ["rev-parse", "--absolute-git-dir"], io),
  );
  if (currentGitDir !== preparation.gitDir) {
    throw new Error(`refusing to finalize ${label} after its Git metadata directory changed`);
  }
}

/**
 * Finalize the checkout Pi successfully produced.
 *
 * This deliberately resolves only HEAD. It does not fetch, consult local
 * tags, read FETCH_HEAD, or run npm. The Pi-selected commit remains
 * authoritative; finalization only detaches, resets, cleans, and validates it.
 */
export function finalizeGitCheckout(
  config: GitInstallConfig,
  options: GitCheckoutOptions,
  preparation?: GitCheckoutPreparation,
  io: GitIo = {},
): boolean {
  const { targetDir, repo, label, missingMessage, warnOnMissing = false } = options;
  if (preparation?.consumed) {
    throw new Error(
      `checkout preparation for ${label} has already been consumed; call prepareGitCheckout again before finalizing`,
    );
  }
  if (preparation?.indexFile) {
    let indexExists = false;
    let indexIsSafe = false;
    try {
      const stats = lstatSync(preparation.indexFile);
      indexExists = true;
      indexIsSafe = stats.isFile() && !stats.isSymbolicLink();
    } catch {
      // Treat an unreadable or removed temporary index as unavailable.
    }
    if (!indexIsSafe) {
      preparation.consumed = true;
      throw new Error(
        indexExists
          ? `checkout preparation for ${label} is no longer safe because its temporary index changed; call prepareGitCheckout again before finalizing`
          : `checkout preparation for ${label} is no longer available because its temporary index is missing; call prepareGitCheckout again before finalizing`,
      );
    }
  }
  try {
    if (!config.dryRun && preparation?.status === "malformed") {
      throw new Error(
        `refusing to finalize malformed ${label}: ${targetDir}; repair the Git index or checkout manually, then rerun; no checkout changes were made`,
      );
    }
    if (config.dryRun) {
      printDryRunCommand(["git", "-C", targetDir, "rev-parse", "HEAD^{commit}"], io);
      printDryRunCommand(["git", "-C", targetDir, "checkout", "--force", "--detach", "HEAD"], io);
      printDryRunCommand(["git", "-C", targetDir, "reset", "--hard", "HEAD"], io);
      printDryRunCommand(
        ["git", "-C", targetDir, "clean", "-fd", "-e", ROOT_NODE_MODULES_CLEAN_EXCLUDE],
        io,
      );
      logDryRun(
        config,
        "Would validate the Pi-selected HEAD and expected origin while preserving root node_modules.",
        io,
      );
      return true;
    }

    if (!safeGitCheckoutDirForMutation(config, targetDir, label, io)) {
      if (warnOnMissing) {
        warn(missingMessage, io);
        return false;
      }
      throw new Error(missingMessage);
    }
    assertPreparationStillTargetsSameRepository(config, preparation, targetDir, label, io);

    const indexEnv = checkoutEnvironment(preparation);
    const head = gitOutput(
      config,
      targetDir,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      io,
      indexEnv,
    );
    if (repo) {
      const actualOrigin = gitOutput(config, targetDir, ["remote", "get-url", "origin"], io);
      if (actualOrigin !== repo) {
        throw new Error(
          `refusing to finalize ${label} with unexpected origin ${actualOrigin}; expected ${repo}`,
        );
      }
    }

    runGitCommand(config, ["git", "-C", targetDir, "checkout", "--force", "--detach", "HEAD"], io, {
      env: indexEnv,
    });
    runGitCommand(config, ["git", "-C", targetDir, "reset", "--hard", "HEAD"], io, {
      env: indexEnv,
    });
    cleanCheckout(config, targetDir, io, indexEnv);

    const finalHead = gitOutput(
      config,
      targetDir,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      io,
      indexEnv,
    );
    if (finalHead !== head) {
      throw new Error(`Pi-selected HEAD changed while finalizing ${label}`);
    }
    const finalStatus = checkoutStatus(config, targetDir, io, indexEnv);
    if (finalStatus !== "") {
      throw new Error(`finalized ${label} is still dirty: ${targetDir}`);
    }
    return true;
  } finally {
    cleanupGitCheckoutPreparation(preparation);
  }
}

export function cleanupGitCheckoutPreparation(
  preparation: GitCheckoutPreparation | undefined,
): void {
  if (!preparation) return;
  preparation.consumed = true;
  if (!preparation.indexFile) return;
  const tempDir = dirname(preparation.indexFile);
  if (
    basename(preparation.indexFile) !== "index" ||
    !basename(tempDir).startsWith("tlh-git-index-") ||
    dirname(tempDir) !== tmpdir()
  )
    return;
  try {
    if (lstatSync(tempDir).isSymbolicLink() || !lstatSync(tempDir).isDirectory()) return;
  } catch {
    return;
  }
  rmSync(tempDir, { recursive: true, force: true });
}

function dependencyInstallCommand(config: GitInstallConfig): string[] {
  const configured = config.npmCommand;
  if (configured && configured.length > 0) {
    if (!configured[0]) {
      throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
    }
    return [...configured, "install"];
  }
  return ["npm", "install", "--omit=dev", "--legacy-peer-deps", "--package-lock=false"];
}

function runDependencyInstall(config: GitInstallConfig, targetDir: string, io: GitIo): void {
  runCommandInDir(config, targetDir, dependencyInstallCommand(config), io);
}

function persistNpmInstallMarker(
  config: GitInstallConfig,
  targetDir: string,
  label: string,
  head: string,
  io: GitIo,
): void {
  const dependencyInputs = readDependencyInputs(targetDir);
  if (!dependencyInputs) {
    throw new Error(`cannot record npm install completion for ${label}: invalid package.json`);
  }
  const markerPath = npmInstallMarkerPath(config, targetDir, label, io);
  writeNpmInstallMarker(markerPath, head, dependencyInputs);
}

interface ManagedCheckoutCommandCounts {
  tlhGitFetches: number;
  tlhPackageManagerInstalls: number;
}

function instrumentManagedCheckoutIo(io: GitIo, counts: ManagedCheckoutCommandCounts): GitIo {
  const originalRunCommand = io.runCommand;
  const originalRunInDir = io.runInDir;
  return {
    ...io,
    runCommand: (config, commandArgs, options) => {
      if (commandArgs[0] === "git" && commandArgs.includes("fetch")) counts.tlhGitFetches += 1;
      if (commandArgs[0] !== "git") counts.tlhPackageManagerInstalls += 1;
      if (typeof originalRunCommand !== "function") {
        throw new Error("runCommand callback is required for managed checkout operations");
      }
      originalRunCommand(config, commandArgs, options);
    },
    runInDir: (config, dir, commandArgs) => {
      counts.tlhPackageManagerInstalls += 1;
      if (typeof originalRunInDir === "function") {
        originalRunInDir(config, dir, commandArgs);
        return;
      }
      if (typeof originalRunCommand !== "function") {
        throw new Error("runCommand callback is required for managed checkout operations");
      }
      originalRunCommand(config, commandArgs, { cwd: dir });
    },
  };
}

/**
 * Complete a managed checkout after Pi has installed or reconciled it.
 *
 * Pi owns the ordinary fetch/ref/package-manager pass. This function only
 * repairs an ambiguous same-HEAD state that Pi cannot identify from TLH's
 * dependency-aware marker, then records the resulting local state. A missing
 * direct dependency is allowed to count as a Pi repair when Pi was given a
 * same-HEAD checkout and the dependency was already absent before Pi ran.
 */
export function installManagedGitCheckout(
  config: GitInstallConfig,
  options: GitCheckoutOptions,
  runPi: () => void,
  io: GitIo = {},
): void {
  let preparation: GitCheckoutPreparation | undefined;
  let failure: unknown;
  const commandCounts: ManagedCheckoutCommandCounts = {
    tlhGitFetches: 0,
    tlhPackageManagerInstalls: 0,
  };
  const managedIo = instrumentManagedCheckoutIo(io, commandCounts);
  try {
    preparation = prepareGitCheckout(config, options, managedIo);
    if (preparation.status === "malformed") {
      throw new Error(
        `refusing to install into malformed ${options.label}: ${options.targetDir}; repair the Git index or checkout manually, then rerun`,
      );
    }

    let piFailure: unknown;
    emitInstrumentationEvent(managedIo, { type: "pi-reconciliation", phase: "start" });
    try {
      // Deliberately pass no alternate-index environment to Pi. Pi may invoke
      // npm, hooks, or a foreign Git clone, all of which must use their own
      // normal index namespace.
      runPi();
    } catch (error) {
      piFailure = error;
      emitInstrumentationEvent(managedIo, { type: "pi-reconciliation", phase: "failed" });
    }

    if (piFailure) {
      // A failed Pi run is never finalized. Restore the exact pre-Pi index for
      // an existing checkout; a fresh checkout has no caller-owned index to
      // restore and is left for the caller to inspect.
      restoreRealIndex(config, preparation, true);
      throw piFailure;
    }

    const piHead = currentCheckoutHead(config, options.targetDir, managedIo);
    const priorHead = preparation.head;
    const headChanged = priorHead !== undefined && piHead !== undefined && priorHead !== piHead;
    emitInstrumentationEvent(managedIo, {
      type: "pi-reconciliation",
      phase: "complete",
      headChanged,
    });

    if (headChanged) {
      if (!priorHead) throw new Error(`could not resolve pre-Pi HEAD for ${options.label}`);
      // Preserve the caller's staged tree before any changed-HEAD finalization
      // can make the real index consistent with Pi's newly selected commit.
      backupPrePiIndex(
        config,
        options.targetDir,
        priorHead,
        preparation.realIndexSnapshot,
        options.label,
        managedIo,
      );
      finalizeGitCheckout(config, options, preparation, managedIo);
      reconcileGitCheckoutDependencies(config, options, preparation, managedIo);
      const finalizedHead = currentCheckoutHead(config, options.targetDir, managedIo);
      if (!finalizedHead) {
        throw new Error(`could not resolve finalized HEAD for ${options.label}`);
      }
      synchronizeRealIndexToHead(
        config,
        options.targetDir,
        finalizedHead,
        options.label,
        managedIo,
      );
      preparation.realIndexSynchronized = true;
    } else {
      // Keep the caller's real index untouched while finalization and any
      // conservative package-manager repair run against their scoped state.
      finalizeGitCheckout(config, options, preparation, managedIo);
      reconcileGitCheckoutDependencies(config, options, preparation, managedIo);
      // Same-HEAD success must preserve every byte and mode of the caller's
      // real index, including an originally missing index.
      restoreRealIndex(config, preparation, true);
    }
    emitInstrumentationEvent(managedIo, {
      type: "managed-checkout-summary",
      ...commandCounts,
    });
  } catch (error) {
    failure = error;
  }

  if (failure) {
    try {
      // Restore on every failed lifecycle path, including finalization and
      // dependency-repair failures after Pi has returned. This is a no-op for
      // a fresh checkout and after a successful exact restoration.
      restoreRealIndex(config, preparation, true);
    } catch (error) {
      failure = new Error(
        `${String(failure)}; additionally failed to restore the real Git index: ${String(error)}`,
        { cause: new AggregateError([failure, error]) },
      );
    }
  }
  cleanupGitCheckoutPreparation(preparation);
  if (failure) throw failure;
}

export function reconcileGitCheckoutDependencies(
  config: GitInstallConfig,
  options: GitCheckoutOptions,
  preparation: GitCheckoutPreparation | undefined,
  io: GitIo = {},
): boolean {
  const { targetDir, label, missingMessage, warnOnMissing = false } = options;
  if (config.dryRun) {
    logDryRun(
      config,
      `Would run ${dependencyInstallCommand(config).join(" ")} when the managed checkout dependency marker is invalid.`,
      io,
    );
    return true;
  }
  if (!safeGitCheckoutDirForMutation(config, targetDir, label, io)) {
    if (warnOnMissing) {
      warn(missingMessage, io);
      return false;
    }
    throw new Error(missingMessage);
  }

  const packageJsonPath = join(targetDir, "package.json");
  if (!existsSync(packageJsonPath)) return true;

  const head = gitOutput(config, targetDir, ["rev-parse", "--verify", "HEAD^{commit}"], io);
  const dependencyInputs = readDependencyInputs(targetDir);
  const directDependenciesPresent = allDirectDepsPresent(targetDir);
  const markerPath = preparation?.markerPath || npmInstallMarkerPath(config, targetDir, label, io);
  const currentMarkerValid =
    readNpmInstallMarker(markerPath, head, dependencyInputs) && directDependenciesPresent;
  const headChanged = preparation?.head !== undefined && preparation.head !== head;
  const freshCheckout = preparation?.status === "missing";
  const sameHead = !freshCheckout && !headChanged;
  const configuredCustomManager = Boolean(config.npmCommand && config.npmCommand.length > 0);

  // When Pi sees a same-HEAD checkout with missing direct dependencies it
  // already invokes its own repair path. Avoid invoking a second package
  // manager pass if that repair left the direct dependency tree complete.
  const piCouldHaveRepaired =
    sameHead &&
    preparation?.directDependenciesPresent === false &&
    directDependenciesPresent &&
    directDependencyCount(targetDir) > 0;

  let needsRepair = !dependencyInputs || !directDependenciesPresent;
  if (sameHead && !currentMarkerValid) needsRepair = true;
  if (sameHead && configuredCustomManager && !piCouldHaveRepaired) needsRepair = true;
  if (piCouldHaveRepaired) {
    needsRepair = false;
    emitInstrumentationEvent(io, {
      type: "tlh-repair",
      phase: "skipped",
      reason: "pi-repaired-dependencies",
    });
    logVerbose(
      config,
      `${label}: Pi repaired the missing direct dependencies; skipping a duplicate package-manager pass`,
      io,
    );
  }

  if (needsRepair) {
    emitInstrumentationEvent(io, {
      type: "tlh-repair",
      phase: "start",
      reason: "invalid-marker-or-dependencies",
    });
    logVerbose(
      config,
      `${label}: dependency marker or direct dependency state is incomplete; running ${dependencyInstallCommand(config).join(" ")}`,
      io,
    );
    try {
      // Invalidate before the package manager starts. A successful-looking old
      // marker must never survive an interrupted repair.
      invalidateNpmInstallMarker(markerPath);
      runDependencyInstall(config, targetDir, io);
    } catch (error) {
      emitInstrumentationEvent(io, {
        type: "tlh-repair",
        phase: "failed",
        reason: "invalid-marker-or-dependencies",
      });
      throw error;
    }
    emitInstrumentationEvent(io, {
      type: "tlh-repair",
      phase: "complete",
      reason: "invalid-marker-or-dependencies",
    });
  }

  const finalInputs = readDependencyInputs(targetDir);
  if (!finalInputs || !allDirectDepsPresent(targetDir)) {
    throw new Error(
      `package-manager install did not produce a complete ${label} dependency tree; rerun the installer with --verbose`,
    );
  }
  try {
    persistNpmInstallMarker(config, targetDir, label, head, io);
  } catch (error) {
    if (String(error).includes("symlinked npm install marker")) throw error;
    // A marker is an optimization only. Keep a successful package install
    // successful, but explain why future runs will conservatively repair.
    warn(`could not write ${label} npm install completion marker: ${String(error)}`, io);
  }
  return true;
}

export function refreshGitPackageSource(
  config: GitInstallConfig,
  {
    packageSource,
    packageRoot,
    ref,
    packageSourceIsDefault,
  }: {
    packageSource: string;
    packageRoot: string;
    ref: string;
    packageSourceIsDefault: boolean;
  },
  io: GitIo = {},
): boolean {
  let targetDir = packageRoot;
  let repo = "";
  let packageRef = ref;
  const packageSpec = criticalGitSourceSpec(packageSource, { agentDir: config.agentDir });
  if (packageSpec) {
    targetDir = packageSpec.targetDir;
    repo = packageSpec.repo;
    packageRef = packageSpec.ref;
  }
  if (packageSourceIsDefault) packageRef ||= ref;
  else if (!packageSpec || !packageRef) return false;
  refreshGitCheckout(
    config,
    {
      targetDir,
      repo,
      ref: packageRef,
      label: "The Last Harness package checkout",
      missingMessage: `expected installed package checkout not found or invalid: ${targetDir}`,
    },
    io,
  );
  if (!packageSourceIsDefault && packageSpec?.ref) {
    logVerbose(
      config,
      "Pinned custom git package source was refreshed directly; skipping pi update.",
      io,
    );
  }
  return true;
}

export function refreshGitCheckout(
  config: GitInstallConfig,
  {
    targetDir,
    repo,
    ref,
    label,
    missingMessage,
    warnOnMissing = false,
  }: {
    targetDir: string;
    repo?: string;
    ref: string;
    label: string;
    missingMessage: string;
    warnOnMissing?: boolean;
  },
  io: GitIo = {},
): boolean {
  if (config.dryRun) {
    if (repo) printDryRunCommand(["git", "-C", targetDir, "remote", "set-url", "origin", repo], io);
    printDryRunCommand(["git", "-C", targetDir, "fetch", "--prune", "--tags", "origin"], io);
    logDryRun(config, `Would prefer tag ${ref}, then origin/${ref}, then ${ref}.`, io);
    printDryRunCommand(["git", "-C", targetDir, "checkout", "--detach", "<resolved-ref>"], io);
    printDryRunCommand(["git", "-C", targetDir, "reset", "--hard", "<resolved-ref>"], io);
    printDryRunCommand(["git", "-C", targetDir, "clean", "-fd"], io);
    logDryRun(
      config,
      `Would run ${dependencyInstallCommand(config).join(" ")} if package.json is present and the clean unchanged-checkout marker is not valid.`,
      io,
    );
    return true;
  }

  if (!safeGitCheckoutDirForMutation(config, targetDir, label, io)) {
    if (warnOnMissing) {
      warn(missingMessage, io);
      return false;
    }
    throw new Error(missingMessage);
  }

  const markerPath = npmInstallMarkerPath(config, targetDir, label, io);
  let priorHead: string | null = null;
  if (gitSucceeds(config, targetDir, ["rev-parse", "HEAD"], io)) {
    priorHead = gitOutput(config, targetDir, ["rev-parse", "HEAD"], io);
  }

  if (repo) {
    if (gitSucceeds(config, targetDir, ["remote", "get-url", "origin"], io)) {
      runGitCommand(config, ["git", "-C", targetDir, "remote", "set-url", "origin", repo], io);
    } else {
      runGitCommand(config, ["git", "-C", targetDir, "remote", "add", "origin", repo], io);
    }
  }
  runGitCommand(config, ["git", "-C", targetDir, "fetch", "--prune", "--tags", "origin"], io);

  const statusOutput = gitOutput(config, targetDir, ["status", "--porcelain"], io);
  const wasClean = statusOutput === "";
  if (statusOutput !== "") {
    const timestamp = new Date().toISOString();
    const backupRef = collisionSafeBackupRef(config, targetDir, "worktree", io);

    runGitCommand(config, ["git", "-C", targetDir, "add", "-A"], io);

    const tree = gitOutput(config, targetDir, ["write-tree"], io);
    let parent: string | null = null;
    if (gitSucceeds(config, targetDir, ["rev-parse", "HEAD"], io)) {
      parent = gitOutput(config, targetDir, ["rev-parse", "HEAD"], io);
    }

    const commitTreeArgs = [
      "-c",
      "user.name=tlh-backup",
      "-c",
      "user.email=tlh-backup@local",
      "commit-tree",
      tree,
    ];
    if (parent) commitTreeArgs.push("-p", parent);
    commitTreeArgs.push("-m", `tlh worktree backup ${timestamp}`);
    const commit = gitOutput(config, targetDir, commitTreeArgs, io);

    runGitCommand(config, ["git", "-C", targetDir, "update-ref", backupRef, commit], io);

    const parentOrEmpty = parent ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    if (!config.quiet) {
      warn(`dirty checkout at ${targetDir} — worktree changes backed up to ${backupRef}`, io);
      warn(`  inspect: git -C ${targetDir} show ${backupRef}`, io);
      warn(
        `  recover worktree changes: git -C ${targetDir} diff ${parentOrEmpty} ${backupRef} | git -C ${targetDir} apply`,
        io,
      );
    }

    if (config.verbose && !config.quiet) {
      const diffBody = gitOutput(config, targetDir, ["diff", parentOrEmpty, backupRef], io);
      const diffLines = diffBody.split("\n");
      const truncated = diffLines.length > 200;
      warn(diffLines.slice(0, 200).join("\n"), io);
      if (truncated) {
        warn("... truncated, use the diff command above for full content", io);
      }
    }
  }

  let targetRef = ref;
  if (
    gitSucceeds(
      config,
      targetDir,
      ["rev-parse", "--verify", "--quiet", `refs/tags/${ref}^{commit}`],
      io,
    )
  ) {
    targetRef = `refs/tags/${ref}^{commit}`;
  } else if (
    gitSucceeds(
      config,
      targetDir,
      ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${ref}^{commit}`],
      io,
    )
  ) {
    targetRef = `refs/remotes/origin/${ref}`;
  }

  runGitCommand(config, ["git", "-C", targetDir, "checkout", "-f", "--detach", targetRef], io);
  runGitCommand(config, ["git", "-C", targetDir, "reset", "--hard", targetRef], io);
  runGitCommand(config, ["git", "-C", targetDir, "clean", "-fd"], io);
  if (existsSync(join(targetDir, "package.json"))) {
    let newHead: string | null = null;
    if (gitSucceeds(config, targetDir, ["rev-parse", "HEAD"], io)) {
      newHead = gitOutput(config, targetDir, ["rev-parse", "HEAD"], io);
    }
    const dependencyInputs = readDependencyInputs(targetDir);
    const canReuseNpmInstall =
      wasClean &&
      priorHead !== null &&
      newHead !== null &&
      priorHead === newHead &&
      readNpmInstallMarker(markerPath, newHead, dependencyInputs) &&
      allDirectDepsPresent(targetDir);

    if (!canReuseNpmInstall) {
      // Remove any previous success claim before npm starts. If npm is
      // interrupted or fails, a stale matching marker must not authorize reuse.
      invalidateNpmInstallMarker(markerPath);
      runDependencyInstall(config, targetDir, io);
      if (newHead === null) {
        warn(
          `could not resolve installed checkout HEAD for npm install marker at ${markerPath}`,
          io,
        );
      } else {
        try {
          const finalDependencyInputs = readDependencyInputs(targetDir);
          if (!finalDependencyInputs) {
            throw new Error("package.json is invalid after package-manager install");
          }
          writeNpmInstallMarker(markerPath, newHead, finalDependencyInputs);
        } catch (error) {
          warn(
            `could not persist npm install completion marker at ${markerPath}: ${String(error)}`,
            io,
          );
        }
      }
    }
  }
  return true;
}
