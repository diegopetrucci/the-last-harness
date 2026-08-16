import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import {
  RETIRED_TLH_SUBAGENTS_DEFAULT_PACKAGE_SOURCES,
  packageIdentity,
  packageSourceOf,
  readDefaultExtensionProvenance,
  withLegacyRetiredDefaultPackageIdentities,
} from "./default-extensions.mjs";
import { criticalGitSourceSpec, packageSourceInstallDir } from "./tlh-install-package-source.mjs";
import {
  assertProfilePathWithinAgent,
  copySafeProfileFile,
  ensureSafeProfileDir,
  isSymlink,
} from "./tlh-install-paths.mjs";
import { readJsonFile } from "./tlh-install-utils.mjs";
import { writeSafeProfileFile } from "./tlh-safe-profile-write.mjs";

interface PlainObject {
  [key: string]: unknown;
}

interface SubagentConfig {
  agentDir: string;
  packageSource: string;
  packageSourceIsDefault: boolean;
  tmpDir?: string;
  repo: string;
}

const TLH_SUBAGENT_PROMPTS = Object.freeze([
  "developer.md",
  "code-reviewer.md",
  "repo-scout.md",
  "diff-summarizer.md",
  "librarian.md",
  "oracle.md",
  "contrarian.md",
  "web-scout.md",
]);

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export { TLH_SUBAGENT_PROMPTS };

export interface RetiredSubagentPackageCandidate {
  source: string;
  identity: string;
}

interface PackageManagerRunResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

interface PackageManagerRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface RetiredSubagentCleanupConfig {
  agentDir: string;
  settingsPath?: string;
  npmCommand?: readonly string[];
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  quiet?: boolean;
  runPackageManager?: (
    command: string,
    args: readonly string[],
    options: PackageManagerRunOptions,
  ) => PackageManagerRunResult;
}

export interface RetiredSubagentCleanupResult {
  uninstalledNpmPackages: string[];
  removedGitPaths: string[];
  plannedNpmPackages: string[];
  plannedGitPaths: string[];
}

function logRetiredSubagentCleanup(config: RetiredSubagentCleanupConfig, message: string): void {
  if (!config.quiet) console.log(message);
}

function warnRetiredSubagentCleanup(message: string): void {
  console.error(`warning: ${message}`);
}

function packageNameFromNpmSource(source: string): string | undefined {
  const spec = source.trim().slice("npm:".length).trim();
  if (!spec) return undefined;
  if (spec.startsWith("@")) {
    const separator = spec.indexOf("@", 1);
    return separator === -1 ? spec : spec.slice(0, separator);
  }
  const separator = spec.indexOf("@");
  return separator === -1 ? spec : spec.slice(0, separator);
}

type RetiredSubagentInstall =
  | { kind: "npm"; path: string; packageName: string }
  | { kind: "git"; path: string };

function sourceInstallPath(agentDir: string, source: string): RetiredSubagentInstall | undefined {
  const trimmed = source.trim();
  if (trimmed.startsWith("npm:")) {
    const packageName = packageNameFromNpmSource(trimmed);
    if (!packageName) return undefined;
    return { path: join(agentDir, "npm"), kind: "npm", packageName };
  }
  const spec = criticalGitSourceSpec(trimmed, { agentDir });
  if (!spec) return undefined;
  return { path: spec.targetDir, kind: "git" };
}

function pathWithin(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return (
    normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`)
  );
}

function hasSymlinkedParent(root: string, target: string): boolean {
  let current = dirname(target);
  const resolvedRoot = resolve(root);
  while (pathWithin(resolvedRoot, current) && current !== resolvedRoot) {
    if (isSymlink(current)) return true;
    current = dirname(current);
  }
  return false;
}

function gitInstallationIsOwned(path: string): boolean {
  try {
    return lstatSync(path).isDirectory() && existsSync(join(path, ".git"));
  } catch {
    return false;
  }
}

function configuredNpmCommand(settings: unknown): string[] | undefined {
  if (!isPlainObject(settings) || settings.npmCommand === undefined) return undefined;
  if (
    !Array.isArray(settings.npmCommand) ||
    settings.npmCommand.some((value) => typeof value !== "string")
  ) {
    throw new Error("invalid npmCommand in isolated settings: expected an array of strings");
  }
  if (settings.npmCommand.length === 0) return undefined;
  const command = settings.npmCommand as string[];
  if (!command[0])
    throw new Error(
      "invalid npmCommand in isolated settings: first entry must be a non-empty command",
    );
  return [...command];
}

/** Read the package-manager command that was active before settings migration. */
export function captureRetiredSubagentNpmCommand(settingsPath: string): string[] | undefined {
  if (!settingsPath || !existsSync(settingsPath)) return undefined;
  try {
    return configuredNpmCommand(readJsonFile(settingsPath));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function packageManagerCommand(config: RetiredSubagentCleanupConfig): {
  command: string;
  args: string[];
  name: string;
} {
  const configured =
    config.npmCommand ??
    (config.settingsPath ? captureRetiredSubagentNpmCommand(config.settingsPath) : undefined);
  const values = configured && configured.length > 0 ? [...configured] : ["npm"];
  const [command, ...args] = values;
  if (!command) throw new Error("invalid npmCommand: first entry must be a non-empty command");
  const separatorIndex = values.lastIndexOf("--");
  const packageManagerExecutable = separatorIndex >= 0 ? values[separatorIndex + 1] : command;
  const name = packageManagerExecutable
    ? basename(packageManagerExecutable).replace(/\.(cmd|exe)$/i, "")
    : "";
  return { command, args, name };
}

function packageManagerUninstallArgs(
  packageName: string,
  installRoot: string,
  packageManagerName: string,
): string[] {
  if (packageManagerName === "bun") {
    return ["uninstall", packageName, "--cwd", installRoot];
  }
  const args = ["uninstall", packageName, "--prefix", installRoot];
  if (packageManagerName !== "pnpm") args.push("--legacy-peer-deps");
  return args;
}

function defaultPackageManagerRunner(
  command: string,
  args: readonly string[],
  options: PackageManagerRunOptions,
): PackageManagerRunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
  };
}

function commandFailureSummary(result: PackageManagerRunResult): string {
  if (result.error) return result.error.message;
  const lines = `${result.stderr || ""}\n${result.stdout || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const conciseLines = lines.length > 8 ? [...lines.slice(0, 4), ...lines.slice(-4)] : lines;
  return conciseLines.join(" | ") || `exit ${result.status ?? "unknown"}`;
}

function npmPackageStillDeclared(installRoot: string, packageName: string): boolean {
  const packageJsonPath = join(installRoot, "package.json");
  if (!existsSync(packageJsonPath)) return false;
  try {
    const packageJson = readJsonFile<Record<string, unknown>>(packageJsonPath);
    return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some(
      (field) => {
        const dependencies = packageJson[field];
        return isPlainObject(dependencies) && Object.hasOwn(dependencies, packageName);
      },
    );
  } catch {
    return true;
  }
}

function npmPackageStillInstalled(installRoot: string, packageName: string): boolean {
  const packagePath = join(installRoot, "node_modules", packageName);
  if (!existsSync(packagePath)) return false;
  try {
    return readJsonFile<{ name?: unknown }>(join(packagePath, "package.json")).name === packageName;
  } catch {
    return true;
  }
}

/**
 * Capture package entries that the old TLH default owned before settings merge.
 * A profile without provenance is treated as a pre-provenance TLH profile, as
 * with the other retired defaults; a provenance block makes manual ownership
 * explicit and therefore keeps unlisted external entries safe.
 */
export function managedRetiredSubagentPackages(
  settings: unknown,
): RetiredSubagentPackageCandidate[] {
  if (!isPlainObject(settings) || !Array.isArray(settings.packages)) return [];
  const provenance = readDefaultExtensionProvenance(settings).managedPackageIdentities;
  const managed = withLegacyRetiredDefaultPackageIdentities(
    settings,
    provenance,
    RETIRED_TLH_SUBAGENTS_DEFAULT_PACKAGE_SOURCES,
  );
  const candidates: RetiredSubagentPackageCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of settings.packages) {
    const source = packageSourceOf(entry);
    const identity = packageIdentity(entry);
    if (!source || !identity || !managed.has(identity) || seen.has(identity)) continue;
    if (
      !RETIRED_TLH_SUBAGENTS_DEFAULT_PACKAGE_SOURCES.some(
        (known) => packageIdentity(known) === identity,
      )
    )
      continue;
    seen.add(identity);
    candidates.push({ source, identity });
  }
  return candidates;
}

/** Read and capture managed retired subagent entries before merge removes them. */
export function captureManagedRetiredSubagentPackages(
  settingsPath: string,
): RetiredSubagentPackageCandidate[] {
  if (!settingsPath || !existsSync(settingsPath)) return [];
  try {
    return managedRetiredSubagentPackages(readJsonFile(settingsPath));
  } catch {
    return [];
  }
}

/**
 * Physically remove entries captured from settings before merging those settings.
 * This preserves package ownership evidence when npm uninstall fails, so a later
 * installer or doctor run can retry. npm entries use the same configured package-
 * manager semantics as Pi so package.json, lockfiles, and node_modules converge
 * together. Git entries retain guarded filesystem cleanup because their package-
 * manager state lives in settings.json.
 */
export function cleanupManagedRetiredSubagentPackages(
  config: RetiredSubagentCleanupConfig,
  candidates: readonly RetiredSubagentPackageCandidate[],
): RetiredSubagentCleanupResult {
  const cleanupResult: RetiredSubagentCleanupResult = {
    uninstalledNpmPackages: [],
    removedGitPaths: [],
    plannedNpmPackages: [],
    plannedGitPaths: [],
  };
  if (!config.agentDir || isSymlink(config.agentDir)) {
    if (candidates.length > 0)
      warnRetiredSubagentCleanup(
        `skipping retired subagent package cleanup for unsafe agent dir: ${config.agentDir}`,
      );
    return cleanupResult;
  }

  for (const candidate of candidates) {
    const install = sourceInstallPath(config.agentDir, candidate.source);
    if (!install) continue;
    if (
      !pathWithin(config.agentDir, install.path) ||
      hasSymlinkedParent(config.agentDir, install.path) ||
      isSymlink(install.path)
    ) {
      warnRetiredSubagentCleanup(
        `skipping retired subagent package cleanup for unsafe path: ${install.path}`,
      );
      continue;
    }
    if (!existsSync(install.path)) continue;
    try {
      if (!lstatSync(install.path).isDirectory()) {
        warnRetiredSubagentCleanup(
          `skipping retired subagent package cleanup for non-directory path: ${install.path}`,
        );
        continue;
      }
      assertProfilePathWithinAgent(
        { agentDir: config.agentDir },
        install.path,
        "retired subagent package",
      );
    } catch (error) {
      warnRetiredSubagentCleanup(
        `skipping retired subagent package cleanup for unsafe path: ${install.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (install.kind === "npm") {
      if (
        !npmPackageStillDeclared(install.path, install.packageName) &&
        !npmPackageStillInstalled(install.path, install.packageName)
      ) {
        continue;
      }
      if (config.dryRun) {
        cleanupResult.plannedNpmPackages.push(install.packageName);
        logRetiredSubagentCleanup(
          config,
          `Would uninstall retired TLH subagent npm package: ${install.packageName} from ${install.path}`,
        );
        continue;
      }

      const npmCommand = packageManagerCommand(config);
      const args = [
        ...npmCommand.args,
        ...packageManagerUninstallArgs(install.packageName, install.path, npmCommand.name),
      ];
      const runner = config.runPackageManager ?? defaultPackageManagerRunner;
      const commandResult = runner(npmCommand.command, args, {
        cwd: config.agentDir,
        env: {
          ...process.env,
          ...config.env,
          NPM_CONFIG_AUDIT: "false",
          NPM_CONFIG_FUND: "false",
          NPM_CONFIG_LOGLEVEL: "error",
        },
      });
      if (commandResult.status !== 0) {
        throw new Error(
          `failed to uninstall retired TLH subagent npm package ${install.packageName}: ${commandFailureSummary(commandResult)}`,
        );
      }
      if (
        npmPackageStillDeclared(install.path, install.packageName) ||
        npmPackageStillInstalled(install.path, install.packageName)
      ) {
        throw new Error(
          `package manager reported success but retired TLH subagent npm package remains installed: ${install.packageName}`,
        );
      }
      cleanupResult.uninstalledNpmPackages.push(install.packageName);
      logRetiredSubagentCleanup(
        config,
        `Uninstalled retired TLH subagent npm package: ${install.packageName} from ${install.path}`,
      );
      continue;
    }

    if (!gitInstallationIsOwned(install.path)) continue;
    if (config.dryRun) {
      cleanupResult.plannedGitPaths.push(install.path);
      logRetiredSubagentCleanup(
        config,
        `Would remove retired TLH subagent git package installation: ${install.path}`,
      );
      continue;
    }
    try {
      rmSync(install.path, { recursive: true, force: true });
      cleanupResult.removedGitPaths.push(install.path);
      logRetiredSubagentCleanup(
        config,
        `Removed retired TLH subagent git package installation: ${install.path}`,
      );
    } catch (error) {
      warnRetiredSubagentCleanup(
        `failed to remove retired subagent git package installation ${install.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const gitRoot = join(config.agentDir, "git");
    let parent = dirname(install.path);
    while (pathWithin(gitRoot, parent) && parent !== gitRoot) {
      if (isSymlink(parent)) break;
      try {
        if (readdirSync(parent).length !== 0) break;
        // rmdirSync removes empty directories atomically and fails with
        // ENOTEMPTY if the directory becomes non-empty concurrently.
        rmdirSync(parent);
      } catch {
        break;
      }
      parent = dirname(parent);
    }
  }
  return cleanupResult;
}

export function settingsRequireTlhSubagentPrompts(
  defaultsFile: string,
  { noSettings = false }: { noSettings?: boolean } = {},
): boolean {
  if (noSettings || !defaultsFile || !existsSync(defaultsFile)) return false;
  try {
    const settings = readJsonFile(defaultsFile);
    if (!isPlainObject(settings)) return false;
    const subagents = isPlainObject(settings.subagents) ? settings.subagents : undefined;
    const agentDirs = subagents?.agentDirs;
    return Array.isArray(agentDirs) && agentDirs.includes("tlh/agents/subagents");
  } catch {
    return false;
  }
}

export function defaultExtensionsRequireCriticalInstall(
  defaultExtensionsFile: string,
  { noSettings = false }: { noSettings?: boolean } = {},
): boolean {
  if (noSettings || !defaultExtensionsFile || !existsSync(defaultExtensionsFile)) return false;
  try {
    const defaults = readJsonFile(defaultExtensionsFile);
    return (
      Array.isArray(defaults) &&
      defaults.some((extension) => isPlainObject(extension) && extension.critical === true)
    );
  } catch {
    return false;
  }
}

export function missingTlhSubagentPrompts(
  dir: string,
  { prompts = TLH_SUBAGENT_PROMPTS }: { prompts?: readonly string[] } = {},
): string[] {
  return prompts.filter((prompt) => !existsSync(join(dir, prompt)));
}

export function restoreNeededTlhSubagentPrompts(
  sourceDir: string,
  targetDir: string,
  { prompts = TLH_SUBAGENT_PROMPTS }: { prompts?: readonly string[] } = {},
): string[] {
  return prompts.filter((prompt) => {
    const sourcePath = join(sourceDir, prompt);
    const targetPath = join(targetDir, prompt);
    if (!existsSync(targetPath)) {
      return true;
    }
    try {
      return readFileSync(targetPath, "utf8") !== readFileSync(sourcePath, "utf8");
    } catch {
      return true;
    }
  });
}

function tlhSubagentPromptsComplete(
  dir: string,
  options: { prompts?: readonly string[] } = {},
): boolean {
  return existsSync(dir) && missingTlhSubagentPrompts(dir, options).length === 0;
}

export function findTlhSubagentsDir(
  config: SubagentConfig,
  {
    localRepoDir = "",
    prompts = TLH_SUBAGENT_PROMPTS,
  }: { localRepoDir?: string; prompts?: readonly string[] } = {},
): string {
  const options = { prompts };
  if (!config.packageSourceIsDefault) {
    const packageRoot = packageSourceInstallDir(config.packageSource, {
      agentDir: config.agentDir,
    });
    if (
      packageRoot &&
      tlhSubagentPromptsComplete(join(packageRoot, "agents", "subagents"), options)
    ) {
      return join(packageRoot, "agents", "subagents");
    }
  }

  if (
    localRepoDir &&
    tlhSubagentPromptsComplete(join(localRepoDir, "agents", "subagents"), options)
  ) {
    return join(localRepoDir, "agents", "subagents");
  }

  if (config.packageSourceIsDefault) {
    const packageRoot = packageSourceInstallDir(config.packageSource, {
      agentDir: config.agentDir,
    });
    if (
      packageRoot &&
      tlhSubagentPromptsComplete(join(packageRoot, "agents", "subagents"), options)
    ) {
      return join(packageRoot, "agents", "subagents");
    }
  }

  if (
    config.tmpDir &&
    tlhSubagentPromptsComplete(join(config.tmpDir, "agents", "subagents"), options)
  ) {
    return join(config.tmpDir, "agents", "subagents");
  }

  const fallbackPackageRoot = join(config.agentDir, "git", "github.com", config.repo);
  if (tlhSubagentPromptsComplete(join(fallbackPackageRoot, "agents", "subagents"), options)) {
    return join(fallbackPackageRoot, "agents", "subagents");
  }
  return "";
}

export function copyTlhSubagentPrompts(
  config: { agentDir: string },
  sourceDir: string,
  { prompts = TLH_SUBAGENT_PROMPTS }: { prompts?: readonly string[] } = {},
): string {
  const supportSubagentsDir = ensureSafeProfileDir(
    config,
    "tlh/agents/subagents",
    "TLH subagent prompt directory",
  );
  for (const prompt of prompts) {
    copySafeProfileFile(
      config,
      join(sourceDir, prompt),
      `tlh/agents/subagents/${prompt}`,
      `TLH subagent prompt ${prompt}`,
    );
  }
  return supportSubagentsDir;
}

/**
 * Provision the subagent extension config at extensions/subagent/config.json
 * with TLH-preferred defaults: compact tool descriptions and a first active
 * long-running notice after 270000ms (4m30).
 *
 * Each default is added independently when its setting is missing. Existing
 * user values, including a user-chosen toolDescriptionMode such as "full" or
 * an activeNoticeAfterMs override, are left untouched. Re-running the
 * installer is therefore safe and will not clobber user edits.
 *
 * Revert path: open <agentDir>/extensions/subagent/config.json and set either
 * "toolDescriptionMode" or "control.activeNoticeAfterMs" to the value you
 * want. Existing values are preserved on subsequent installer runs. To return
 * a setting to the managed default, remove that key and rerun install or
 * update; missing defaults are re-provisioned. Valid non-object or unreadable
 * config files are preserved untouched.
 *
 * Runtime note: toolDescriptionMode is consumed by TLH's first-party
 * subagent runtime. Retired external builds may ignore the unknown key.
 */
const TLH_TOOL_DESCRIPTION_MODE = "compact";
const TLH_ACTIVE_NOTICE_AFTER_MS = 270000;

function activeNoticeCanBeProvisioned(existing: PlainObject): boolean {
  return !("control" in existing) || isPlainObject(existing.control);
}

function activeNoticeIsMissing(existing: PlainObject): boolean {
  return (
    activeNoticeCanBeProvisioned(existing) &&
    (!isPlainObject(existing.control) || !("activeNoticeAfterMs" in existing.control))
  );
}

function readExistingSubagentExtensionConfig(config: { agentDir: string }): PlainObject | null {
  const configPath = join(config.agentDir, "extensions/subagent/config.json");
  if (!existsSync(configPath)) return {};
  try {
    const parsed = readJsonFile<unknown>(configPath, { missingValue: {} as unknown });
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function missingSubagentExtensionDefaultLabels(existing: PlainObject): string[] {
  const missingDefaults: string[] = [];
  if (!("toolDescriptionMode" in existing))
    missingDefaults.push(`toolDescriptionMode: ${TLH_TOOL_DESCRIPTION_MODE}`);
  if (activeNoticeIsMissing(existing)) {
    missingDefaults.push(`control.activeNoticeAfterMs: ${TLH_ACTIVE_NOTICE_AFTER_MS} (4m30)`);
  }
  return missingDefaults;
}

/**
 * Returns the display labels for defaults that provisionSubagentExtensionConfig
 * can write. An empty result means the existing config is complete, a valid
 * non-object JSON value, or unreadable.
 */
export function subagentExtensionConfigMissingDefaults(config: { agentDir: string }): string[] {
  const existing = readExistingSubagentExtensionConfig(config);
  return existing ? missingSubagentExtensionDefaultLabels(existing) : [];
}

/**
 * Returns true when provisionSubagentExtensionConfig would write to disk,
 * false when it would leave the existing file untouched (all writable defaults
 * are present, the config has a non-object JSON value, or it is unreadable).
 */
export function subagentExtensionConfigNeedsProvisioning(config: { agentDir: string }): boolean {
  return subagentExtensionConfigMissingDefaults(config).length > 0;
}

export function provisionSubagentExtensionConfig(config: { agentDir: string }): void {
  const relativePath = "extensions/subagent/config.json";
  const existing = readExistingSubagentExtensionConfig(config);
  if (!existing) return;

  const missingToolDescriptionMode = !("toolDescriptionMode" in existing);
  const missingActiveNotice = activeNoticeIsMissing(existing);
  if (!missingToolDescriptionMode && !missingActiveNotice) return;

  ensureSafeProfileDir(config, "extensions/subagent", "TLH subagent extension config directory");
  const updated: PlainObject = { ...existing };
  if (missingToolDescriptionMode) updated.toolDescriptionMode = TLH_TOOL_DESCRIPTION_MODE;
  if (missingActiveNotice) {
    const existingControl = isPlainObject(existing.control) ? existing.control : {};
    updated.control = { activeNoticeAfterMs: TLH_ACTIVE_NOTICE_AFTER_MS, ...existingControl };
  }
  writeSafeProfileFile(
    config,
    relativePath,
    JSON.stringify(updated, null, 2) + "\n",
    "TLH subagent extension config",
  );
}
