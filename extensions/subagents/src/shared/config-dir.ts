import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInstalledPiPackageRoot, resolvePiPackageRoot } from "../runs/shared/pi-spawn.ts";

const DEFAULT_CONFIG_DIR_NAME = ".pi";

// Detached async runners cannot peer-import the Pi runtime; the parent forwards
// its resolved Pi package root through this env var so config-dir resolution
// still works without importing @earendil-works/pi-coding-agent.
export const PI_CODING_AGENT_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";

let cachedRuntimeConfigDirName: string | null | undefined;

interface RuntimeConfigDirDeps {
  readFileSync?: (filePath: string, encoding: "utf-8") => string;
  resolveRuntimePackageRoot?: () => string | undefined;
  resolveInstalledPackageRoot?: () => string | undefined;
  env?: NodeJS.ProcessEnv;
  useCache?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeConfigDirName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function resolveConfigDirNameFromSource(source: unknown): string | undefined {
  if (!isRecord(source)) return undefined;
  const piConfig = source.piConfig;
  return (
    normalizeConfigDirName(source.CONFIG_DIR_NAME) ??
    normalizeConfigDirName(source.configDir) ??
    normalizeConfigDirName(isRecord(piConfig) ? piConfig.configDir : undefined)
  );
}

function readConfigDirNameFromPackageRoot(
  packageRoot: string | undefined,
  deps: RuntimeConfigDirDeps,
): string | undefined {
  if (!packageRoot) return undefined;

  try {
    const readFileSync =
      deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
    const packageJsonPath = path.join(packageRoot, "package.json");
    const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    return resolveConfigDirNameFromSource(packageJson);
  } catch {
    return undefined;
  }
}

function safeResolvePackageRoot(resolvePackageRoot: () => string | undefined): string | undefined {
  try {
    return resolvePackageRoot();
  } catch {
    return undefined;
  }
}

export function resolveRuntimeConfigDirName(deps: RuntimeConfigDirDeps = {}): string | undefined {
  const useCache =
    deps.useCache ??
    (deps.readFileSync === undefined &&
      deps.resolveRuntimePackageRoot === undefined &&
      deps.resolveInstalledPackageRoot === undefined &&
      deps.env === undefined);
  if (useCache && cachedRuntimeConfigDirName !== undefined) {
    return cachedRuntimeConfigDirName ?? undefined;
  }

  const env = deps.env ?? process.env;
  const resolveRuntimePackageRoot = deps.resolveRuntimePackageRoot ?? resolvePiPackageRoot;
  const resolveInstalledPackageRoot =
    deps.resolveInstalledPackageRoot ?? resolveInstalledPiPackageRoot;

  const forwardedRoot = env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]?.trim();
  let value = forwardedRoot ? readConfigDirNameFromPackageRoot(forwardedRoot, deps) : undefined;
  if (value === undefined) {
    value = readConfigDirNameFromPackageRoot(
      safeResolvePackageRoot(resolveRuntimePackageRoot),
      deps,
    );
  }
  if (value === undefined) {
    value = readConfigDirNameFromPackageRoot(
      safeResolvePackageRoot(resolveInstalledPackageRoot),
      deps,
    );
  }

  if (useCache) cachedRuntimeConfigDirName = value ?? null;
  return value;
}

/** Active Pi config directory name, from the resolved runtime package root. */
export function resolveConfigDirName(): string {
  return resolveRuntimeConfigDirName() ?? DEFAULT_CONFIG_DIR_NAME;
}

export function getConfigDirName(): string {
  return resolveConfigDirName();
}

export function getProjectConfigDir(projectRoot: string): string {
  return path.join(projectRoot, getConfigDirName());
}
