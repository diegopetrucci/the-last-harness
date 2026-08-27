import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { criticalGitSourceSpec } from "./tlh-install-package-source.mjs";
import {
  assertProfilePathWithinAgent,
  isSymlink,
  realpathForCompare,
} from "./tlh-install-paths.mjs";

const COMMAND_MAX_BUFFER = 20 * 1024 * 1024;
// Keep the completion marker in the checkout's resolved Git metadata so it
// neither dirties the worktree nor depends on node_modules being ignored.
// Format: JSON { schemaVersion: 1, head: <full installed checkout HEAD> }.
const NPM_INSTALL_MARKER_FILENAME = "tlh-npm-install-complete.json";
const NPM_INSTALL_MARKER_SCHEMA_VERSION = 1;

export interface GitInstallConfig {
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

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
  spawnCapture?: (
    config: GitInstallConfig,
    commandArgs: string[],
    options?: SpawnCaptureOptions,
  ) => SpawnSyncReturns<string>;
}

function commandDisplay(commandArgs: readonly string[]): string {
  return commandArgs.map(String).join(" ");
}

function inheritedCommandEnv(
  config: GitInstallConfig,
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return { ...(config.env || process.env), ...extraEnv };
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
  requireRunCommand(io)(config, commandArgs, options);
}

function runGitCommandInDir(
  config: GitInstallConfig,
  dir: string,
  commandArgs: string[],
  io: GitIo,
): void {
  if (typeof io.runInDir === "function") {
    io.runInDir(config, dir, commandArgs);
    return;
  }
  runGitCommand(config, commandArgs, io, { cwd: dir });
}

function printDryRunCommand(commandArgs: string[], io: GitIo): void {
  if (typeof io.printCommand === "function") io.printCommand(commandArgs);
}

function logDryRun(config: GitInstallConfig, message: string, io: GitIo): void {
  if (typeof io.log === "function") io.log(config, message);
}

function warn(message: string, io: GitIo): void {
  if (typeof io.warn === "function") io.warn(message);
  else console.error(`warning: ${message}`);
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

function readNpmInstallMarker(markerPath: string, head: string): boolean {
  try {
    const stats = lstatSync(markerPath);
    if (stats.isSymbolicLink() || !stats.isFile()) return false;
    const parsed: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const marker = parsed as Record<string, unknown>;
    return marker.schemaVersion === NPM_INSTALL_MARKER_SCHEMA_VERSION && marker.head === head;
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
function allDirectDepsPresent(targetDir: string): boolean {
  let pkgJson: unknown;
  try {
    pkgJson = JSON.parse(readFileSync(join(targetDir, "package.json"), "utf8"));
  } catch {
    // Missing or unreadable package.json — cannot reuse.
    return false;
  }
  if (typeof pkgJson !== "object" || pkgJson === null || Array.isArray(pkgJson)) {
    // Malformed package.json — cannot reuse.
    return false;
  }
  const pkg = pkgJson as Record<string, unknown>;
  const deps = pkg["dependencies"];
  // An absent or empty dependencies map is fine; nothing to verify.
  if (deps === undefined || deps === null) return true;
  if (typeof deps !== "object" || Array.isArray(deps)) {
    // Malformed dependencies field — cannot reuse.
    return false;
  }
  for (const name of Object.keys(deps as Record<string, unknown>)) {
    // Scoped names (e.g. "@scope/pkg") resolve naturally through path joining.
    if (!isRegularDirectory(join(targetDir, "node_modules", name))) {
      return false;
    }
  }
  return true;
}

function invalidateNpmInstallMarker(markerPath: string): void {
  try {
    const stats = lstatSync(markerPath);
    if (!stats.isSymbolicLink() && !stats.isFile()) {
      // An unexpected directory or special file cannot validate as a marker.
      // Leave it untouched; marker persistence will warn and the next refresh
      // will retry rather than treating it as a successful install.
      return;
    }
    // unlinkSync removes a symlink itself and never follows its target.
    unlinkSync(markerPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function writeNpmInstallMarker(markerPath: string, head: string): void {
  if (isSymlink(markerPath)) {
    throw new Error(`refusing to replace symlinked npm install marker: ${markerPath}`);
  }

  const tempPath = join(dirname(markerPath), `.${basename(markerPath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(
      tempPath,
      `${JSON.stringify({ schemaVersion: NPM_INSTALL_MARKER_SCHEMA_VERSION, head })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    if (isSymlink(markerPath)) {
      throw new Error(`refusing to replace symlinked npm install marker: ${markerPath}`);
    }
    renameSync(tempPath, markerPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function gitOutput(
  config: GitInstallConfig,
  targetDir: string,
  args: string[],
  io: GitIo = {},
): string {
  const spawnCapture = io.spawnCapture || defaultSpawnCapture;
  return spawnCapture(config, ["git", "-C", targetDir, ...args]).stdout.trim();
}

function gitSucceeds(
  config: GitInstallConfig,
  targetDir: string,
  args: string[],
  io: GitIo = {},
): boolean {
  const spawnCapture = io.spawnCapture || defaultSpawnCapture;
  const result = spawnCapture(config, ["git", "-C", targetDir, ...args], { allowFailure: true });
  return !result.error && result.status === 0;
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
      "Would run npm install --omit=dev --legacy-peer-deps --package-lock=false if package.json is present and the clean unchanged-checkout marker is not valid.",
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
    const refTimestamp = timestamp.replace(/:/g, "-");
    const backupRef = `refs/tlh-backup/${refTimestamp}`;

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
    commitTreeArgs.push("-m", `tlh backup ${timestamp}`);
    const commit = gitOutput(config, targetDir, commitTreeArgs, io);

    runGitCommand(config, ["git", "-C", targetDir, "update-ref", backupRef, commit], io);

    const parentOrEmpty = parent ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    if (!config.quiet) {
      warn(`dirty checkout at ${targetDir} — local changes backed up to ${backupRef}`, io);
      warn(`  git -C ${targetDir} show ${backupRef}`, io);
      warn(`  git -C ${targetDir} diff ${parentOrEmpty} ${backupRef}`, io);
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
    const canReuseNpmInstall =
      wasClean &&
      priorHead !== null &&
      newHead !== null &&
      priorHead === newHead &&
      isRegularDirectory(join(targetDir, "node_modules")) &&
      readNpmInstallMarker(markerPath, newHead) &&
      allDirectDepsPresent(targetDir);

    if (!canReuseNpmInstall) {
      // Remove any previous success claim before npm starts. If npm is
      // interrupted or fails, a stale matching marker must not authorize reuse.
      invalidateNpmInstallMarker(markerPath);
      runGitCommandInDir(
        config,
        targetDir,
        ["npm", "install", "--omit=dev", "--legacy-peer-deps", "--package-lock=false"],
        io,
      );
      if (newHead === null) {
        warn(
          `could not resolve installed checkout HEAD for npm install marker at ${markerPath}`,
          io,
        );
      } else {
        try {
          writeNpmInstallMarker(markerPath, newHead);
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
