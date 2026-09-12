import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

export const REPOSITORY = "diegopetrucci/the-last-harness";
export const BENCHMARK_ROOT_PREFIX = "tlh-installer-performance-";
const DEFAULT_REF = "main";

export interface BenchmarkWorkspace {
  root: string;
  home: string;
  agentDir: string;
  binDir: string;
  cwd: string;
  npmCache: string;
  npmUserConfig: string;
  npmGlobalConfig: string;
  gitConfig: string;
  gitSystemConfig: string;
  xdgConfigHome: string;
  xdgDataHome: string;
  xdgCacheHome: string;
  xdgStateHome: string;
  tmp: string;
  wrapperName: string;
  wrapperPath: string;
}

interface EnvironmentOptions {
  ref?: string;
}

function safeTemporaryRoot(path: string): boolean {
  const resolvedPath = resolve(path);
  const tempRoot = resolve(tmpdir());
  const relativePath = relative(tempRoot, resolvedPath);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath))
    return false;
  const first = relativePath.split(sep)[0] || "";
  return first.startsWith(BENCHMARK_ROOT_PREFIX);
}

export function assertOwnedWorkspacePath(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const relativePath = relative(resolvedRoot, resolvedPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`refusing to access path outside benchmark workspace: ${path}`);
  }
}

export function removeOwnedWorkspace(root: string): void {
  if (!safeTemporaryRoot(root)) {
    throw new Error(`refusing to remove unowned benchmark path: ${root}`);
  }
  rmSync(root, { recursive: true, force: true });
}

function writeEmptyConfig(path: string): void {
  writeFileSync(path, "# Isolated TLH benchmark configuration.\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

function initializeWorkspace(root: string): BenchmarkWorkspace {
  const workspace: BenchmarkWorkspace = {
    root,
    home: join(root, "home"),
    agentDir: join(root, "agent"),
    binDir: join(root, "bin"),
    cwd: join(root, "cwd"),
    npmCache: join(root, "npm-cache"),
    npmUserConfig: join(root, "npmrc-user"),
    npmGlobalConfig: join(root, "npmrc-global"),
    gitConfig: join(root, "gitconfig"),
    gitSystemConfig: join(root, "gitconfig-system"),
    xdgConfigHome: join(root, "xdg-config"),
    xdgDataHome: join(root, "xdg-data"),
    xdgCacheHome: join(root, "xdg-cache"),
    xdgStateHome: join(root, "xdg-state"),
    tmp: join(root, "tmp"),
    wrapperName: "tlh-benchmark",
    wrapperPath: join(root, "bin", "tlh-benchmark"),
  };
  for (const directory of [
    workspace.home,
    workspace.agentDir,
    workspace.binDir,
    workspace.cwd,
    workspace.npmCache,
    workspace.xdgConfigHome,
    workspace.xdgDataHome,
    workspace.xdgCacheHome,
    workspace.xdgStateHome,
    workspace.tmp,
  ]) {
    assertOwnedWorkspacePath(root, directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  assertOwnedWorkspacePath(root, workspace.npmUserConfig);
  assertOwnedWorkspacePath(root, workspace.npmGlobalConfig);
  assertOwnedWorkspacePath(root, workspace.gitConfig);
  assertOwnedWorkspacePath(root, workspace.gitSystemConfig);
  writeEmptyConfig(workspace.npmUserConfig);
  writeEmptyConfig(workspace.npmGlobalConfig);
  writeEmptyConfig(workspace.gitConfig);
  writeEmptyConfig(workspace.gitSystemConfig);
  return workspace;
}

export function createBenchmarkWorkspace(parentRoot?: string): BenchmarkWorkspace {
  const root = parentRoot
    ? mkdtempSync(join(parentRoot, "sample-"))
    : mkdtempSync(join(tmpdir(), BENCHMARK_ROOT_PREFIX));
  return initializeWorkspace(root);
}

function inheritedSafeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  const explicitKeys = new Set([
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "TERM",
    "COLORTERM",
    "USER",
    "LOGNAME",
    "SHELL",
  ]);
  for (const key of explicitKeys) {
    if (source[key] !== undefined) safe[key] = source[key];
  }
  return safe;
}

export function buildChildEnvironment(
  workspace: BenchmarkWorkspace,
  source: NodeJS.ProcessEnv = process.env,
  { ref = DEFAULT_REF }: EnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const environment = inheritedSafeEnvironment(source);
  environment.PATH =
    environment.PATH || `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
  environment.HOME = workspace.home;
  environment.TMPDIR = workspace.tmp;
  environment.TMP = workspace.tmp;
  environment.TEMP = workspace.tmp;
  environment.XDG_CONFIG_HOME = workspace.xdgConfigHome;
  environment.XDG_DATA_HOME = workspace.xdgDataHome;
  environment.XDG_CACHE_HOME = workspace.xdgCacheHome;
  environment.XDG_STATE_HOME = workspace.xdgStateHome;
  environment.PI_CODING_AGENT_DIR = workspace.agentDir;
  environment.TLH_AGENT_DIR = workspace.agentDir;
  environment.TLH_BIN_DIR = workspace.binDir;
  environment.TLH_WRAPPER_NAME = workspace.wrapperName;
  environment.TLH_REPO = REPOSITORY;
  environment.TLH_REF = ref;
  environment.TLH_SKIP_UPDATE_CHECK = "1";
  environment.TLH_SKIP_TELEMETRY = "1";
  environment.TLH_TELEMETRY_DISABLED = "1";
  environment.TLH_INSTALL_RECONCILIATION_TRACE = "1";
  environment.PI_SKIP_VERSION_CHECK = "1";
  environment.PI_TELEMETRY = "0";
  environment.NO_COLOR = "1";
  environment.GIT_CONFIG_GLOBAL = workspace.gitConfig;
  environment.GIT_CONFIG_SYSTEM = workspace.gitSystemConfig;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.NPM_CONFIG_USERCONFIG = workspace.npmUserConfig;
  environment.npm_config_userconfig = workspace.npmUserConfig;
  environment.NPM_CONFIG_GLOBALCONFIG = workspace.npmGlobalConfig;
  environment.npm_config_globalconfig = workspace.npmGlobalConfig;
  environment.NPM_CONFIG_CACHE = workspace.npmCache;
  environment.npm_config_cache = workspace.npmCache;
  environment.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  environment.npm_config_update_notifier = "false";
  environment.NPM_CONFIG_FUND = "false";
  environment.npm_config_fund = "false";
  environment.NPM_CONFIG_AUDIT = "false";
  environment.npm_config_audit = "false";
  environment.NPM_CONFIG_YES = "true";
  environment.npm_config_yes = "true";
  environment.COREPACK_HOME = join(workspace.root, "corepack");
  delete environment.PI_OFFLINE;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  delete environment.NPM_TOKEN;
  delete environment.npm_token;
  delete environment.GITHUB_TOKEN;
  delete environment.GH_TOKEN;
  delete environment.AWS_ACCESS_KEY_ID;
  delete environment.AWS_SECRET_ACCESS_KEY;
  delete environment.AWS_SESSION_TOKEN;
  delete environment.SSH_AUTH_SOCK;
  delete environment.GIT_SSH_COMMAND;
  return environment;
}
export function writeCredentialFreeTrustMetadata(workspace: BenchmarkWorkspace): string {
  const trustPath = join(workspace.agentDir, "trust.json");
  assertOwnedWorkspacePath(workspace.root, trustPath);
  const trustedCwd = realpathSync(workspace.cwd);
  writeFileSync(trustPath, `${JSON.stringify({ [trustedCwd]: true }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return trustPath;
}
