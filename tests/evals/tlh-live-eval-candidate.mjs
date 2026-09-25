#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRepo = "diegopetrucci/the-last-harness";
const candidateRootPrefix = "tlh-live-eval-candidate-";
const candidateMetadataFilename = "candidate-metadata.json";
const candidateCommandTimeoutMs = 10 * 60 * 1000;
const gitResolveTimeoutMs = 15 * 1000;
const semverPattern = /\b(?:v?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/;
const fullObjectIdPattern = /^[0-9a-f]{40,64}$/i;
const credentialEnvNamePattern =
  /(API[_-]?(?:KEY|TOKEN)|ACCESS[_-]?KEY|AUTH|BEARER|COOKIE|CREDENTIAL|PASSWORD|PRIVATE[_-]?KEY|SECRET|SESSION|TOKEN)/i;
const fixedEnvironmentNames = new Set([
  "APPDATA",
  "AWS_CONFIG_FILE",
  "AZURE_CONFIG_DIR",
  "BASH_ENV",
  "CDPATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "CLOUDSDK_CONFIG",
  "COREPACK_HOME",
  "CURL_HOME",
  "DENO_DIR",
  "DOCKER_CONFIG",
  "ENV",
  "GNUPGHOME",
  "HOME",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "INIT_CWD",
  "KUBECONFIG",
  "LOCALAPPDATA",
  "NETRC",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NVM_DIR",
  "OLDPWD",
  "PERL5OPT",
  "POSIXLY_CORRECT",
  "PWD",
  "PYTHONHOME",
  "PYTHONPATH",
  "RUSTUP_HOME",
  "RUBYOPT",
  "SSH_CONFIG",
  "TAR_OPTIONS",
  "TMP",
  "TEMP",
  "TMPDIR",
  "USERPROFILE",
  "BUN_INSTALL",
]);
const fixedGitEnvironmentNames = new Set([
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_WORK_TREE",
  "SSH_AUTH_SOCK",
]);

const moduleRepoRoot = fileURLToPath(new URL("../..", import.meta.url));

export class CandidateSetupError extends Error {
  constructor(message, { phase = "candidate setup", cleanupPath = "", cause } = {}) {
    super(message, { cause });
    this.name = "CandidateSetupError";
    this.phase = phase;
    this.cleanupPath = cleanupPath;
  }
}

function isTruthy(value) {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function quoteShellWord(value) {
  const text = String(value ?? "");
  if (text === "") return "''";
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`private candidate path is not a regular directory: ${path}`);
  }
  chmodSync(path, 0o700);
  return path;
}

function ensurePrivateFile(path, content) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`refusing to write candidate metadata through a symlink: ${path}`);
  }
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function pathIsWithinRoot(path, root) {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !relativePath.startsWith(sep))
  );
}

function assertPathWithinRoot(path, root, label) {
  if (!pathIsWithinRoot(path, root)) {
    throw new CandidateSetupError(`${label} must remain inside the owned candidate root: ${path}`, {
      phase: "candidate isolation",
      cleanupPath: root,
    });
  }
}

function physicalPathIsWithinRoot(path, root) {
  try {
    return pathIsWithinRoot(path, realpathSync(root));
  } catch {
    return false;
  }
}

function assertNoSymlinkComponents(path, root, label) {
  assertPathWithinRoot(path, root, label);
  const resolvedRoot = resolve(root);
  const relativePath = relative(resolvedRoot, resolve(path));
  let current = resolvedRoot;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) {
      throw new CandidateSetupError(`${label} cannot contain a symlink component: ${current}`, {
        phase: "candidate isolation",
        cleanupPath: root,
      });
    }
  }
}

function assertRegularDirectory(path, label, cleanupPath) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    throw new CandidateSetupError(`${label} is unavailable: ${path}`, {
      phase: "candidate isolation",
      cleanupPath,
      cause: error,
    });
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new CandidateSetupError(`${label} must be a private regular directory: ${path}`, {
      phase: "candidate isolation",
      cleanupPath,
    });
  }
}

function createCandidateLayout(rootDir) {
  const ownedRoot = resolve(rootDir || mkdtempSync(join(tmpdir(), candidateRootPrefix)));
  ensurePrivateDirectory(ownedRoot);
  const candidateRoot = mkdtempSync(join(ownedRoot, "candidate-"));
  ensurePrivateDirectory(candidateRoot);
  const paths = {
    ownedRoot,
    candidateRoot,
    archivePath: join(candidateRoot, "source.tar"),
    sourceRoot: join(candidateRoot, "source"),
    packDir: join(candidateRoot, "pack"),
    extractDir: join(candidateRoot, "extract"),
    packageRoot: join(candidateRoot, "extract", "package"),
    metadataPath: join(ownedRoot, candidateMetadataFilename),
  };
  for (const path of [paths.sourceRoot, paths.packDir, paths.extractDir])
    ensurePrivateDirectory(path);
  return paths;
}

function environmentPaths({ ownedRoot, homeDir, agentDir, binDir }) {
  const paths = {
    homeDir: resolve(homeDir || join(ownedRoot, "home")),
    agentDir: resolve(agentDir || join(ownedRoot, "agent")),
    binDir: resolve(binDir || join(ownedRoot, "bin")),
    sessionDir: join(ownedRoot, "session"),
    tempDir: join(ownedRoot, "tmp"),
    npmCacheDir: join(ownedRoot, "npm", "cache"),
    npmConfigDir: join(ownedRoot, "npm", "config"),
    npmUserConfigPath: join(ownedRoot, "npm", "config", "user.npmrc"),
    npmGlobalConfigPath: join(ownedRoot, "npm", "config", "global.npmrc"),
    xdgConfigHome: join(ownedRoot, "xdg", "config"),
    xdgCacheHome: join(ownedRoot, "xdg", "cache"),
    xdgDataHome: join(ownedRoot, "xdg", "data"),
    xdgStateHome: join(ownedRoot, "xdg", "state"),
    xdgRuntimeDir: join(ownedRoot, "xdg", "runtime"),
    appDataDir: join(ownedRoot, "appdata"),
    localAppDataDir: join(ownedRoot, "localappdata"),
    gitConfigPath: join(ownedRoot, "gitconfig"),
    gitSystemConfigPath: join(ownedRoot, "gitconfig-system"),
  };
  for (const [label, path] of Object.entries(paths)) {
    assertNoSymlinkComponents(path, ownedRoot, label);
  }
  for (const path of [
    paths.homeDir,
    paths.agentDir,
    paths.binDir,
    paths.sessionDir,
    paths.tempDir,
    paths.npmCacheDir,
    paths.npmConfigDir,
    paths.xdgConfigHome,
    paths.xdgCacheHome,
    paths.xdgDataHome,
    paths.xdgStateHome,
    paths.xdgRuntimeDir,
    paths.appDataDir,
    paths.localAppDataDir,
  ]) {
    ensurePrivateDirectory(path);
  }
  return paths;
}

function removeInheritedEnvironmentOverrides(environment) {
  const preservedOffline = environment.PI_OFFLINE;
  for (const name of Object.keys(environment)) {
    const upperName = name.toUpperCase();
    if (
      fixedEnvironmentNames.has(upperName) ||
      fixedGitEnvironmentNames.has(upperName) ||
      upperName.startsWith("GIT_CONFIG_") ||
      upperName.startsWith("GIT_") ||
      upperName.startsWith("SSH_") ||
      upperName.startsWith("PI_") ||
      upperName.startsWith("TLH_") ||
      upperName.startsWith("XDG_") ||
      upperName.startsWith("NPM_CONFIG_") ||
      upperName.startsWith("npm_config_".toUpperCase()) ||
      credentialEnvNamePattern.test(name)
    ) {
      delete environment[name];
    }
  }
  return preservedOffline;
}

export function buildCandidateEnvironment({
  baseEnv = process.env,
  ownedRoot,
  homeDir,
  agentDir,
  binDir,
  repo = defaultRepo,
  commit = "",
  packageSource = "",
  rawBase = "",
} = {}) {
  if (!ownedRoot) throw new Error("ownedRoot is required to build a candidate environment");
  const root = resolve(ownedRoot);
  const paths = environmentPaths({ ownedRoot: root, homeDir, agentDir, binDir });
  for (const [label, path] of Object.entries(paths)) {
    assertNoSymlinkComponents(path, root, label);
  }
  const environment = { ...baseEnv };
  const preservedOffline = removeInheritedEnvironmentOverrides(environment);
  environment.HOME = paths.homeDir;
  environment.USERPROFILE = paths.homeDir;
  environment.APPDATA = paths.appDataDir;
  environment.LOCALAPPDATA = paths.localAppDataDir;
  environment.TMPDIR = paths.tempDir;
  environment.TMP = paths.tempDir;
  environment.TEMP = paths.tempDir;
  environment.XDG_CONFIG_HOME = paths.xdgConfigHome;
  environment.XDG_CACHE_HOME = paths.xdgCacheHome;
  environment.XDG_DATA_HOME = paths.xdgDataHome;
  environment.XDG_STATE_HOME = paths.xdgStateHome;
  environment.XDG_RUNTIME_DIR = paths.xdgRuntimeDir;
  environment.PI_CODING_AGENT_DIR = paths.agentDir;
  environment.PI_CODING_AGENT_SESSION_DIR = paths.sessionDir;
  environment.TLH_AGENT_DIR = paths.agentDir;
  environment.TLH_BIN_DIR = paths.binDir;
  environment.TLH_SKIP_TELEMETRY = "1";
  environment.TLH_TELEMETRY_DISABLED = "1";
  environment.TLH_SKIP_UPDATE_CHECK = "1";
  environment.PI_TELEMETRY = "0";
  environment.PI_SKIP_VERSION_CHECK = "1";
  if (isTruthy(preservedOffline)) environment.PI_OFFLINE = preservedOffline;
  environment.NPM_CONFIG_CACHE = paths.npmCacheDir;
  environment.npm_config_cache = paths.npmCacheDir;
  environment.NPM_CONFIG_USERCONFIG = paths.npmUserConfigPath;
  environment.npm_config_userconfig = paths.npmUserConfigPath;
  environment.NPM_CONFIG_GLOBALCONFIG = paths.npmGlobalConfigPath;
  environment.npm_config_globalconfig = paths.npmGlobalConfigPath;
  environment.NPM_CONFIG_AUDIT = "false";
  environment.NPM_CONFIG_FUND = "false";
  environment.NPM_CONFIG_LOGLEVEL = "error";
  environment.npm_config_audit = "false";
  environment.npm_config_fund = "false";
  environment.npm_config_loglevel = "error";
  environment.GIT_CONFIG_GLOBAL = paths.gitConfigPath;
  environment.GIT_CONFIG_SYSTEM = paths.gitSystemConfigPath;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  if (repo) environment.TLH_REPO = repo;
  if (commit) environment.TLH_REF = commit;
  if (packageSource) environment.TLH_PACKAGE_SOURCE = packageSource;
  if (rawBase) environment.TLH_RAW_BASE = rawBase;
  return { environment, paths };
}

function defaultCommandRunner({
  command,
  args = [],
  cwd,
  env,
  timeoutMs = candidateCommandTimeoutMs,
}) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function formatCommandCause(error) {
  if (!error) return "";
  const code = typeof error?.code === "string" ? error.code.replace(/[^A-Za-z0-9_.-]/g, "_") : "";
  const message = String(error?.message || error || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .trim()
    .slice(0, 512);
  return [code ? `code=${code}` : "", message ? `cause=${message}` : ""].filter(Boolean).join("; ");
}

function runRequiredCommand(commandRunner, { phase, command, args = [], cwd, env, timeoutMs }) {
  let result;
  try {
    result = commandRunner({ phase, command, args, cwd, env, timeoutMs });
  } catch (error) {
    const cause = formatCommandCause(error);
    throw new CandidateSetupError(`${phase} could not run${cause ? ` (${cause})` : ""}`, {
      phase,
      cause: error,
    });
  }
  if (!result || result.error || result.status !== 0) {
    const status = result?.status ?? result?.signal ?? result?.error?.code ?? "unknown";
    const cause = formatCommandCause(result?.error || result?.stderr);
    throw new CandidateSetupError(`${phase} failed (exit ${status})${cause ? ` (${cause})` : ""}`, {
      phase,
      cause: result?.error,
    });
  }
  return result;
}

function resolveCommit({ candidateRef, repoRoot, commandRunner, env }) {
  const ref = String(candidateRef ?? "").trim();
  if (!ref)
    throw new CandidateSetupError("--candidate-ref requires a local commit or commit ref", {
      phase: "candidate ref",
    });
  if (/[\r\n]/.test(ref)) {
    throw new CandidateSetupError(
      "--candidate-ref must be a single-line local commit or commit ref",
      {
        phase: "candidate ref",
      },
    );
  }
  const result = runRequiredCommand(commandRunner, {
    phase: "resolve candidate commit",
    command: "git",
    args: ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    cwd: repoRoot,
    env,
    timeoutMs: gitResolveTimeoutMs,
  });
  const commit = String(result.stdout || "").trim();
  if (!fullObjectIdPattern.test(commit)) {
    throw new CandidateSetupError(
      `local candidate ref did not resolve to a full commit object id: ${ref}`,
      {
        phase: "resolve candidate commit",
      },
    );
  }
  return { ref, commit: commit.toLowerCase() };
}

function extractDeclaredVersion(text, pattern) {
  const match = text.match(pattern);
  return match?.[1]?.trim() || "";
}

function readExpectedRuntimeVersion(sourceRoot, override = "") {
  if (override) return normalizeVersion(override, "expected upstream runtime version");
  const installScriptPath = join(sourceRoot, "install.sh");
  const installScript = readFileSync(installScriptPath, "utf8");
  const shellVersion = extractDeclaredVersion(
    installScript,
    /^\s*TLH_PINNED_PI_VERSION\s*=\s*["']([^"']+)["']/m,
  );
  const installModulePath = join(sourceRoot, "scripts", "tlh-install.mjs");
  const moduleVersion = existsSync(installModulePath)
    ? extractDeclaredVersion(
        readFileSync(installModulePath, "utf8"),
        /\b(?:const|let)\s+PINNED_PI_VERSION\s*=\s*["']([^"']+)["']/,
      )
    : "";
  if (
    shellVersion &&
    moduleVersion &&
    normalizeVersion(shellVersion) !== normalizeVersion(moduleVersion)
  ) {
    throw new CandidateSetupError(
      `candidate installer runtime versions disagree (${shellVersion} versus ${moduleVersion})`,
      { phase: "candidate runtime expectation" },
    );
  }
  if (!shellVersion && !moduleVersion) {
    throw new CandidateSetupError(
      "candidate installer does not declare an expected upstream runtime version; supply expectedRuntimeVersion explicitly",
      { phase: "candidate runtime expectation" },
    );
  }
  const declared = shellVersion || moduleVersion;
  return normalizeVersion(declared, "expected upstream runtime version");
}

function normalizeVersion(value, label = "runtime version") {
  const text = String(value ?? "")
    .trim()
    .replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(text)) {
    throw new CandidateSetupError(`${label} is not a semantic version: ${value}`, {
      phase: "candidate runtime expectation",
    });
  }
  return text;
}

function parseObservedRuntimeVersion(output) {
  const match = String(output ?? "").match(semverPattern);
  return match ? normalizeVersion(match[1], "observed upstream runtime version") : "";
}

function hardenTree(root) {
  const stats = lstatSync(root);
  if (stats.isSymbolicLink()) {
    throw new CandidateSetupError(`candidate snapshot contains a symlink: ${root}`, {
      phase: "candidate snapshot",
    });
  }
  if (!stats.isDirectory()) {
    chmodSync(root, 0o600);
    return;
  }
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new CandidateSetupError(`candidate snapshot contains a symlink: ${child}`, {
        phase: "candidate snapshot",
      });
    }
    if (entry.isDirectory()) hardenTree(child);
    else chmodSync(child, (lstatSync(child).mode & 0o111) !== 0 ? 0o700 : 0o600);
  }
}

function assertPathExistsAsRegularFile(path, label, cleanupPath) {
  if (!existsSync(path)) {
    throw new CandidateSetupError(`${label} is missing: ${path}`, { phase: label, cleanupPath });
  }
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new CandidateSetupError(`${label} must be a regular file: ${path}`, {
      phase: label,
      cleanupPath,
    });
  }
}

function assertContainedFile(path, label, cleanupPath) {
  if (!existsSync(path)) {
    throw new CandidateSetupError(`${label} is missing: ${path}`, { phase: label, cleanupPath });
  }
  let target = path;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    try {
      target = realpathSync(path);
    } catch (error) {
      throw new CandidateSetupError(`${label} is a broken symlink: ${path}`, {
        phase: label,
        cleanupPath,
        cause: error,
      });
    }
    if (!physicalPathIsWithinRoot(target, cleanupPath)) {
      throw new CandidateSetupError(`${label} points outside the owned candidate root: ${path}`, {
        phase: label,
        cleanupPath,
      });
    }
  }
  if (!lstatSync(target).isFile()) {
    throw new CandidateSetupError(`${label} must resolve to a regular file: ${path}`, {
      phase: label,
      cleanupPath,
    });
  }
}

function hardenPrivateTree(root, cleanupPath = root) {
  const stats = lstatSync(root);
  if (stats.isSymbolicLink()) {
    let target;
    try {
      target = realpathSync(root);
    } catch (error) {
      throw new CandidateSetupError(`candidate private tree contains a broken symlink: ${root}`, {
        phase: "candidate isolation",
        cleanupPath,
        cause: error,
      });
    }
    if (!physicalPathIsWithinRoot(target, cleanupPath)) {
      throw new CandidateSetupError(`candidate private tree symlink escapes its root: ${root}`, {
        phase: "candidate isolation",
        cleanupPath,
      });
    }
    return;
  }
  if (stats.isDirectory()) {
    chmodSync(root, 0o700);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      hardenPrivateTree(join(root, entry.name), cleanupPath);
    }
    return;
  }
  chmodSync(root, (stats.mode & 0o111) !== 0 ? 0o700 : 0o600);
}

function parsePackResult(result, packDir, cleanupPath) {
  let entries;
  try {
    entries = JSON.parse(String(result.stdout || "").trim());
  } catch (error) {
    throw new CandidateSetupError("npm pack returned invalid JSON metadata", {
      phase: "pack candidate",
      cleanupPath,
      cause: error,
    });
  }
  const entry = Array.isArray(entries) ? entries[0] : undefined;
  const filename = typeof entry?.filename === "string" ? entry.filename.trim() : "";
  if (
    !filename ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".."
  ) {
    throw new CandidateSetupError("npm pack did not return a safe package filename", {
      phase: "pack candidate",
      cleanupPath,
    });
  }
  const tarballPath = resolve(packDir, filename);
  if (!pathIsWithinRoot(tarballPath, packDir)) {
    throw new CandidateSetupError(
      "npm pack returned a package path outside its private destination",
      {
        phase: "pack candidate",
        cleanupPath,
      },
    );
  }
  assertPathExistsAsRegularFile(tarballPath, "packed candidate tarball", cleanupPath);
  return { entry, filename, tarballPath };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function packageSourcePath(source, { agentDir, cleanupPath }) {
  const text = String(source ?? "").trim();
  let path = text;
  if (text.startsWith("file:")) {
    try {
      path = text.startsWith("file://") ? fileURLToPath(new URL(text)) : text.slice(5);
    } catch (error) {
      throw new CandidateSetupError(
        `installed package source is not a valid file path: ${source}`,
        {
          phase: "validate installed package",
          cleanupPath,
          cause: error,
        },
      );
    }
  }
  return resolve(agentDir, path);
}

function packageSourceOf(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof entry.source === "string") return entry.source;
  return "";
}

function validateInstalledPackage({
  packageRoot,
  packageManifest,
  agentDir,
  settingsPath,
  cleanupPath,
}) {
  assertPathExistsAsRegularFile(settingsPath, "installed settings", cleanupPath);
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new CandidateSetupError(`installed settings are not valid JSON: ${settingsPath}`, {
      phase: "validate installed package",
      cleanupPath,
      cause: error,
    });
  }
  if (!settings || typeof settings !== "object" || !Array.isArray(settings.packages)) {
    throw new CandidateSetupError(
      `installed settings do not contain a packages array: ${settingsPath}`,
      {
        phase: "validate installed package",
        cleanupPath,
      },
    );
  }
  const packageRootReal = resolve(packageRoot);
  const matchingEntry = settings.packages.find((entry) => {
    const source = packageSourceOf(entry);
    if (!source) return false;
    try {
      return resolve(packageSourcePath(source, { agentDir, cleanupPath })) === packageRootReal;
    } catch {
      return false;
    }
  });
  if (!matchingEntry) {
    throw new CandidateSetupError(
      `installed settings do not reference the unpacked candidate package: ${packageRoot}`,
      { phase: "validate installed package", cleanupPath },
    );
  }
  const actualSource = packageSourceOf(matchingEntry);
  const actualPath = packageSourcePath(actualSource, { agentDir, cleanupPath });
  if (!pathIsWithinRoot(actualPath, cleanupPath)) {
    throw new CandidateSetupError(
      `installed package source escaped the owned candidate root: ${actualSource}`,
      {
        phase: "validate installed package",
        cleanupPath,
      },
    );
  }
  const packageIdentity = `local:${packageRootReal}`;
  return {
    identity: packageIdentity,
    source: actualSource,
    path: packageRootReal,
    name: packageManifest.name,
    version: packageManifest.version,
  };
}

function makeMetadata({
  status,
  candidateRef,
  commit,
  paths,
  environmentPaths = {},
  packageSource = "",
  packageVersion = "",
  packageName = "",
  packageSha256 = "",
  expectedRuntimeVersion = "",
  observedRuntimeVersion = "",
  installedPackage,
  error,
}) {
  const metadata = {
    schemaVersion: 1,
    status,
    validationKind: "local-packed-commit",
    releasedArtifactValidation: false,
    candidateRef,
    commit,
    candidateCommit: commit,
    packageSha256,
    packageVersion,
    packageName,
    packageSource,
    environmentPaths: environmentPaths || {},
    expectedRuntimeVersion,
    expectedUpstreamRuntimeVersion: expectedRuntimeVersion,
    observedRuntimeVersion,
    observedUpstreamRuntimeVersion: observedRuntimeVersion,
    installedPackageIdentity: installedPackage?.identity || "",
    installedPackage: installedPackage || null,
    package: {
      name: packageName,
      version: packageVersion,
      sha256: packageSha256,
      source: packageSource,
    },
    paths: {
      sourceSnapshot: paths.sourceRoot,
      packedPackage: paths.tarballPath || "",
      unpackedPackage: paths.packageRoot,
      wrapper: paths.wrapperPath || "",
      runtime: paths.runtimePath || "",
      metadata: paths.metadataPath,
      environment: environmentPaths || {},
    },
    cleanupPath: paths.ownedRoot,
    cleanupCommand: `rm -rf ${quoteShellWord(paths.ownedRoot)}`,
  };
  if (error) metadata.error = String(error);
  return metadata;
}

function writeMetadata(paths, metadata, onMetadata) {
  ensurePrivateFile(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  if (typeof onMetadata === "function") onMetadata(metadata);
}

function candidateError(error, paths, phase = "candidate setup") {
  if (error instanceof CandidateSetupError) {
    if (!error.cleanupPath) error.cleanupPath = paths.ownedRoot;
    return error;
  }
  return new CandidateSetupError(error instanceof Error ? error.message : String(error), {
    phase,
    cleanupPath: paths.ownedRoot,
    cause: error,
  });
}

export function setupPackagedCandidate({
  repoRoot = moduleRepoRoot,
  candidateRef,
  rootDir,
  homeDir,
  agentDir,
  binDir,
  repo = defaultRepo,
  baseEnv = process.env,
  expectedRuntimeVersion = "",
  commandRunner = defaultCommandRunner,
  runCommand = undefined,
  onMetadata,
} = {}) {
  const paths = createCandidateLayout(rootDir);
  const runner = runCommand || commandRunner;
  const initialMetadata = makeMetadata({
    status: "preparing",
    candidateRef: String(candidateRef ?? "").trim(),
    commit: "",
    paths,
    packageSource: "",
    packageVersion: "",
    packageName: "",
    packageSha256: "",
    expectedRuntimeVersion: "",
    observedRuntimeVersion: "",
    installedPackage: null,
  });
  writeMetadata(paths, initialMetadata, onMetadata);
  let metadata = initialMetadata;
  try {
    const environmentState = buildCandidateEnvironment({
      baseEnv,
      ownedRoot: paths.ownedRoot,
      homeDir,
      agentDir,
      binDir,
    });
    const candidateEnv = environmentState.environment;
    const envPaths = environmentState.paths;
    const resolved = resolveCommit({
      candidateRef,
      repoRoot: resolve(repoRoot),
      commandRunner: runner,
      env: candidateEnv,
    });
    metadata = makeMetadata({
      ...metadata,
      status: "snapshotting",
      candidateRef: resolved.ref,
      commit: resolved.commit,
      paths,
      environmentPaths: envPaths,
    });
    writeMetadata(paths, metadata, onMetadata);

    runRequiredCommand(runner, {
      phase: "create candidate source snapshot",
      command: "git",
      args: [
        "archive",
        "--format=tar",
        `--output=${paths.archivePath}`,
        "--prefix=source/",
        resolved.commit,
      ],
      cwd: resolve(repoRoot),
      env: candidateEnv,
      timeoutMs: gitResolveTimeoutMs,
    });
    chmodSync(paths.archivePath, 0o600);
    runRequiredCommand(runner, {
      phase: "extract candidate source snapshot",
      command: "tar",
      args: ["-xf", paths.archivePath, "-C", paths.candidateRoot],
      cwd: paths.candidateRoot,
      env: candidateEnv,
      timeoutMs: gitResolveTimeoutMs,
    });
    assertRegularDirectory(paths.sourceRoot, "candidate source snapshot", paths.ownedRoot);
    hardenTree(paths.sourceRoot);
    assertPathExistsAsRegularFile(
      join(paths.sourceRoot, "install.sh"),
      "candidate installer",
      paths.ownedRoot,
    );
    assertPathExistsAsRegularFile(
      join(paths.sourceRoot, "package.json"),
      "candidate package manifest",
      paths.ownedRoot,
    );

    let sourceManifest;
    try {
      sourceManifest = JSON.parse(readFileSync(join(paths.sourceRoot, "package.json"), "utf8"));
    } catch (error) {
      throw new CandidateSetupError(
        `candidate package manifest is not valid JSON: ${paths.sourceRoot}`,
        {
          phase: "candidate package manifest",
          cleanupPath: paths.ownedRoot,
          cause: error,
        },
      );
    }
    if (!sourceManifest || typeof sourceManifest.name !== "string" || !sourceManifest.name.trim()) {
      throw new CandidateSetupError("candidate package manifest has no package name", {
        phase: "candidate package manifest",
        cleanupPath: paths.ownedRoot,
      });
    }
    if (typeof sourceManifest.version !== "string" || !sourceManifest.version.trim()) {
      throw new CandidateSetupError("candidate package manifest has no package version", {
        phase: "candidate package manifest",
        cleanupPath: paths.ownedRoot,
      });
    }
    const expectedVersion = readExpectedRuntimeVersion(paths.sourceRoot, expectedRuntimeVersion);
    const packageSource = `file:${paths.packageRoot}`;
    metadata = makeMetadata({
      ...metadata,
      status: "packing",
      packageSource,
      packageVersion: sourceManifest.version,
      packageName: sourceManifest.name,
      expectedRuntimeVersion: expectedVersion,
      paths,
      environmentPaths: envPaths,
    });
    writeMetadata(paths, metadata, onMetadata);

    const packEnv = {
      ...candidateEnv,
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      npm_config_ignore_scripts: "true",
    };
    const packResult = runRequiredCommand(runner, {
      phase: "pack candidate",
      command: "npm",
      args: ["pack", "--ignore-scripts", "--json", "--pack-destination", paths.packDir],
      cwd: paths.sourceRoot,
      env: packEnv,
      timeoutMs: candidateCommandTimeoutMs,
    });
    hardenTree(paths.packDir);
    const packed = parsePackResult(packResult, paths.packDir, paths.ownedRoot);
    paths.tarballPath = packed.tarballPath;
    chmodSync(paths.tarballPath, 0o600);
    const packageSha256 = sha256File(paths.tarballPath);
    metadata = makeMetadata({
      ...metadata,
      status: "packed",
      packageSha256,
      packageSource,
      packageVersion: sourceManifest.version,
      packageName: sourceManifest.name,
      expectedRuntimeVersion: expectedVersion,
      paths,
      environmentPaths: envPaths,
    });
    writeMetadata(paths, metadata, onMetadata);
    runRequiredCommand(runner, {
      phase: "extract packed candidate package",
      command: "tar",
      args: ["-xzf", paths.tarballPath, "-C", paths.extractDir],
      cwd: paths.extractDir,
      env: candidateEnv,
      timeoutMs: gitResolveTimeoutMs,
    });
    hardenTree(paths.extractDir);
    assertRegularDirectory(paths.packageRoot, "unpacked candidate package", paths.ownedRoot);
    assertPathExistsAsRegularFile(
      join(paths.packageRoot, "package.json"),
      "unpacked package manifest",
      paths.ownedRoot,
    );
    let packedManifest;
    try {
      packedManifest = JSON.parse(readFileSync(join(paths.packageRoot, "package.json"), "utf8"));
    } catch (error) {
      throw new CandidateSetupError(
        `unpacked candidate package manifest is not valid JSON: ${paths.packageRoot}`,
        {
          phase: "unpacked package manifest",
          cleanupPath: paths.ownedRoot,
          cause: error,
        },
      );
    }
    if (
      packedManifest.name !== sourceManifest.name ||
      packedManifest.version !== sourceManifest.version
    ) {
      throw new CandidateSetupError("packed candidate package identity changed during npm pack", {
        phase: "packed package identity",
        cleanupPath: paths.ownedRoot,
      });
    }
    const installEnv = {
      ...candidateEnv,
      TLH_REPO: repo,
      TLH_REF: resolved.commit,
      TLH_UPDATE_TRACK: "custom",
      TLH_PACKAGE_SOURCE: packageSource,
      TLH_RAW_BASE: pathToFileURL(paths.sourceRoot).href,
      TLH_AGENT_DIR: envPaths.agentDir,
      TLH_BIN_DIR: envPaths.binDir,
      TLH_WRAPPER_NAME: "tlh",
    };
    paths.wrapperPath = join(envPaths.binDir, "tlh");
    paths.runtimePath = join(dirname(envPaths.agentDir), "runtime", "bin", "pi");
    for (const [label, path] of Object.entries({
      agentDir: envPaths.agentDir,
      binDir: envPaths.binDir,
      wrapperPath: paths.wrapperPath,
      runtimePath: paths.runtimePath,
      packageRoot: paths.packageRoot,
    })) {
      assertPathWithinRoot(path, paths.ownedRoot, label);
    }
    metadata = makeMetadata({
      ...metadata,
      status: "installing",
      packageSha256,
      packageSource,
      packageVersion: packedManifest.version,
      packageName: packedManifest.name,
      expectedRuntimeVersion: expectedVersion,
      paths,
      environmentPaths: envPaths,
    });
    writeMetadata(paths, metadata, onMetadata);

    runRequiredCommand(runner, {
      phase: "install packaged candidate",
      command: "bash",
      args: [
        join(paths.sourceRoot, "install.sh"),
        "--ref",
        resolved.commit,
        "--track",
        "custom",
        "--agent-dir",
        envPaths.agentDir,
        "--bin-dir",
        envPaths.binDir,
        "--wrapper-name",
        "tlh",
      ],
      cwd: paths.sourceRoot,
      env: installEnv,
      timeoutMs: candidateCommandTimeoutMs,
    });
    hardenPrivateTree(paths.ownedRoot);
    assertPathExistsAsRegularFile(paths.wrapperPath, "candidate wrapper", paths.ownedRoot);
    const settingsPath = join(envPaths.agentDir, "settings.json");
    const installedPackage = validateInstalledPackage({
      packageRoot: paths.packageRoot,
      packageManifest: packedManifest,
      agentDir: envPaths.agentDir,
      settingsPath,
      cleanupPath: paths.ownedRoot,
    });
    assertContainedFile(paths.runtimePath, "candidate runtime", paths.ownedRoot);
    const runtimeResult = runRequiredCommand(runner, {
      phase: "probe installed upstream runtime",
      command: paths.runtimePath,
      args: ["--version"],
      cwd: envPaths.agentDir,
      env: installEnv,
      timeoutMs: gitResolveTimeoutMs,
    });
    const observedRuntimeVersion = parseObservedRuntimeVersion(
      `${runtimeResult.stdout || ""}\n${runtimeResult.stderr || ""}`,
    );
    metadata = makeMetadata({
      ...metadata,
      observedRuntimeVersion,
      paths,
      environmentPaths: envPaths,
    });
    writeMetadata(paths, metadata, onMetadata);
    if (!observedRuntimeVersion) {
      throw new CandidateSetupError(
        "installed upstream runtime did not report a semantic version",
        {
          phase: "probe installed upstream runtime",
          cleanupPath: paths.ownedRoot,
        },
      );
    }
    if (observedRuntimeVersion !== expectedVersion) {
      throw new CandidateSetupError(
        `installed upstream runtime version ${observedRuntimeVersion} does not match expected ${expectedVersion}`,
        { phase: "validate installed upstream runtime", cleanupPath: paths.ownedRoot },
      );
    }
    metadata = makeMetadata({
      ...metadata,
      status: "ready",
      packageSha256,
      packageSource,
      packageVersion: packedManifest.version,
      packageName: packedManifest.name,
      expectedRuntimeVersion: expectedVersion,
      observedRuntimeVersion,
      installedPackage,
      paths,
      environmentPaths: envPaths,
    });
    writeMetadata(paths, metadata, onMetadata);
    return {
      ...paths,
      ...envPaths,
      env: installEnv,
      candidateRef: resolved.ref,
      commit: resolved.commit,
      candidateCommit: resolved.commit,
      packageName: packedManifest.name,
      packageVersion: packedManifest.version,
      packageSha256,
      packageSource,
      expectedRuntimeVersion: expectedVersion,
      expectedUpstreamRuntimeVersion: expectedVersion,
      observedRuntimeVersion,
      observedUpstreamRuntimeVersion: observedRuntimeVersion,
      installedPackage,
      metadata,
    };
  } catch (error) {
    const wrapped = candidateError(error, paths);
    const failedMetadata = makeMetadata({
      ...metadata,
      status: "failed",
      paths,
      error: `${wrapped.phase}: ${wrapped.message}`,
    });
    try {
      writeMetadata(paths, failedMetadata, onMetadata);
    } catch {
      // Preserve the original setup failure; the root path remains the cleanup contract.
    }
    wrapped.cleanupPath = paths.ownedRoot;
    wrapped.candidateMetadata = failedMetadata;
    throw wrapped;
  }
}

export const candidateMetadataFile = candidateMetadataFilename;
