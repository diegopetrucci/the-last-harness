import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInstalledPiPackageRoot, resolvePiPackageRoot } from "../runs/shared/pi-spawn.js";
const DEFAULT_CONFIG_DIR_NAME = ".pi";
export const PI_CODING_AGENT_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";
let cachedRuntimeConfigDirName;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeConfigDirName(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
function resolveConfigDirNameFromSource(source) {
    if (!isRecord(source))
        return undefined;
    const piConfig = source.piConfig;
    return (normalizeConfigDirName(source.CONFIG_DIR_NAME) ??
        normalizeConfigDirName(source.configDir) ??
        normalizeConfigDirName(isRecord(piConfig) ? piConfig.configDir : undefined));
}
function readConfigDirNameFromPackageRoot(packageRoot, deps) {
    if (!packageRoot)
        return undefined;
    try {
        const readFileSync = deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
        const packageJsonPath = path.join(packageRoot, "package.json");
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
        return resolveConfigDirNameFromSource(packageJson);
    }
    catch {
        return undefined;
    }
}
function safeResolvePackageRoot(resolvePackageRoot) {
    try {
        return resolvePackageRoot();
    }
    catch {
        return undefined;
    }
}
export function resolveRuntimeConfigDirName(deps = {}) {
    const useCache = deps.useCache ??
        (deps.readFileSync === undefined &&
            deps.resolveRuntimePackageRoot === undefined &&
            deps.resolveInstalledPackageRoot === undefined &&
            deps.env === undefined);
    if (useCache && cachedRuntimeConfigDirName !== undefined) {
        return cachedRuntimeConfigDirName ?? undefined;
    }
    const env = deps.env ?? process.env;
    const resolveRuntimePackageRoot = deps.resolveRuntimePackageRoot ?? resolvePiPackageRoot;
    const resolveInstalledPackageRoot = deps.resolveInstalledPackageRoot ?? resolveInstalledPiPackageRoot;
    const forwardedRoot = env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]?.trim();
    let value = forwardedRoot ? readConfigDirNameFromPackageRoot(forwardedRoot, deps) : undefined;
    if (value === undefined) {
        value = readConfigDirNameFromPackageRoot(safeResolvePackageRoot(resolveRuntimePackageRoot), deps);
    }
    if (value === undefined) {
        value = readConfigDirNameFromPackageRoot(safeResolvePackageRoot(resolveInstalledPackageRoot), deps);
    }
    if (useCache)
        cachedRuntimeConfigDirName = value ?? null;
    return value;
}
export function resolveConfigDirName() {
    return resolveRuntimeConfigDirName() ?? DEFAULT_CONFIG_DIR_NAME;
}
export function getConfigDirName() {
    return resolveConfigDirName();
}
export function getProjectConfigDir(projectRoot) {
    return path.join(projectRoot, getConfigDirName());
}
