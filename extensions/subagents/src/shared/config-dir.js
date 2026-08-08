import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInstalledPiPackageRoot, resolvePiPackageRoot } from "../runs/shared/pi-spawn.js";
const DEFAULT_CONFIG_DIR_NAME = ".pi";
const RUNTIME_CONFIG_DIR = Symbol("runtime-config-dir");
export const PI_CODING_AGENT_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";
let cachedRuntimeConfigDirName;
function normalizeConfigDirName(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
function resolveConfigDirNameFromSource(source) {
    if (!source || typeof source !== "object")
        return undefined;
    const direct = source;
    return (normalizeConfigDirName(direct.CONFIG_DIR_NAME) ??
        normalizeConfigDirName(direct.configDir) ??
        normalizeConfigDirName(direct.piConfig?.configDir));
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
function resolveConfigDirNameFromEntryPoint(entryPoint, packageRoot, deps) {
    const explicitRootValue = readConfigDirNameFromPackageRoot(packageRoot, deps);
    if (explicitRootValue !== undefined)
        return explicitRootValue;
    if (!entryPoint)
        return undefined;
    try {
        let dir = path.dirname(fs.realpathSync(entryPoint));
        while (dir !== path.dirname(dir)) {
            const value = readConfigDirNameFromPackageRoot(dir, deps);
            if (value !== undefined)
                return value;
            dir = path.dirname(dir);
        }
    }
    catch {
    }
    return undefined;
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
export function resolveConfigDirName(codingAgentModule = RUNTIME_CONFIG_DIR, entryPointOrDeps, packageRoot) {
    if (codingAgentModule !== RUNTIME_CONFIG_DIR) {
        return resolveConfigDirNameFromSource(codingAgentModule) ?? DEFAULT_CONFIG_DIR_NAME;
    }
    if (typeof entryPointOrDeps === "string" || packageRoot !== undefined) {
        const value = resolveConfigDirNameFromEntryPoint(entryPointOrDeps, packageRoot, {});
        return value ?? DEFAULT_CONFIG_DIR_NAME;
    }
    const deps = entryPointOrDeps ?? {};
    return resolveRuntimeConfigDirName(deps) ?? DEFAULT_CONFIG_DIR_NAME;
}
export function getConfigDirName() {
    return resolveConfigDirName();
}
export function getProjectConfigDir(projectRoot) {
    return path.join(projectRoot, getConfigDirName());
}
