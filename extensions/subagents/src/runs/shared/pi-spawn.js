import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";
export function buildSubagentSpawnEnv(inheritedEnv, explicitEnv, depthEnv) {
    const filteredInheritedEnv = Object.fromEntries(Object.entries(inheritedEnv).filter(([key]) => !key.startsWith("HERDR_")));
    return { ...filteredInheritedEnv, ...explicitEnv, ...depthEnv };
}
function findPiPackageRootFromEntry(entryPoint) {
    let dir = path.dirname(entryPoint);
    while (dir !== path.dirname(dir)) {
        const packageJsonPath = path.join(dir, "package.json");
        if (fs.existsSync(packageJsonPath)) {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
            if (pkg.name === PI_CODING_AGENT_PACKAGE)
                return dir;
        }
        dir = path.dirname(dir);
    }
    return undefined;
}
export function resolveInstalledPiPackageRoot() {
    return findPiPackageRootFromEntry(fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE)));
}
export function resolvePiPackageRoot() {
    try {
        const entry = process.argv[1];
        return entry ? findPiPackageRootFromEntry(fs.realpathSync(entry)) : undefined;
    }
    catch {
        return undefined;
    }
}
function isRunnableNodeScript(filePath, existsSync) {
    if (!existsSync(filePath))
        return false;
    return /\.(?:mjs|cjs|js)$/i.test(filePath);
}
function normalizePath(filePath) {
    return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}
function resolveArgvPiCliScript(deps = {}) {
    const existsSync = deps.existsSync ?? fs.existsSync;
    const realpathSync = deps.realpathSync ?? fs.realpathSync;
    const argv1 = deps.argv1 ?? process.argv[1];
    if (!argv1)
        return undefined;
    try {
        const argvPath = normalizePath(argv1);
        const realArgvPath = realpathSync(argvPath);
        if (!isRunnableNodeScript(realArgvPath, existsSync))
            return undefined;
        return findPiPackageRootFromEntry(realArgvPath) ? realArgvPath : undefined;
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
function resolvePiCliPackageRoot(deps = {}) {
    if (deps.piPackageRoot)
        return { rootPath: deps.piPackageRoot, source: "piPackageRoot" };
    const runtimeRoot = resolvePiPackageRoot();
    if (runtimeRoot)
        return { rootPath: runtimeRoot, source: "current runtime root" };
    if (deps.resolvePackageEntry) {
        const packageRoot = safeResolvePackageRoot(() => findPiPackageRootFromEntry(deps.resolvePackageEntry()));
        if (packageRoot)
            return { rootPath: packageRoot, source: "package entry root" };
    }
    const resolveInstalledPackageRoot = deps.resolveInstalledPackageRoot ?? resolveInstalledPiPackageRoot;
    const packageRoot = safeResolvePackageRoot(resolveInstalledPackageRoot);
    return packageRoot ? { rootPath: packageRoot, source: "installed package root" } : undefined;
}
function resolvePiCliScriptFromPackageJson(deps, packageRoot) {
    const existsSync = deps.existsSync ?? fs.existsSync;
    const readFileSync = deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
    try {
        const resolvePackageJson = deps.resolvePackageJson ??
            (() => {
                if (!packageRoot)
                    throw new Error(`Could not resolve ${PI_CODING_AGENT_PACKAGE} package root`);
                return path.join(packageRoot.rootPath, "package.json");
            });
        const packageJsonPath = resolvePackageJson();
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
        const binField = packageJson.bin;
        const binPath = typeof binField === "string" ? binField : (binField?.pi ?? Object.values(binField ?? {})[0]);
        if (!binPath) {
            return packageRoot
                ? { packageRoot, error: `No Pi CLI bin entry found in ${packageJsonPath}` }
                : {};
        }
        const candidate = path.resolve(path.dirname(packageJsonPath), binPath);
        if (isRunnableNodeScript(candidate, existsSync)) {
            return { cliPath: candidate, packageRoot };
        }
        return packageRoot
            ? { packageRoot, error: `Resolved Pi CLI script is not runnable: ${candidate}` }
            : {};
    }
    catch (error) {
        return packageRoot
            ? { packageRoot, error: error instanceof Error ? error.message : String(error) }
            : {};
    }
}
function resolvePiCliScriptWithStatus(deps = {}) {
    if (deps.piPackageRoot) {
        return resolvePiCliScriptFromPackageJson(deps, {
            rootPath: deps.piPackageRoot,
            source: "piPackageRoot",
        });
    }
    const argvCliScript = resolveArgvPiCliScript(deps);
    if (argvCliScript)
        return { cliPath: argvCliScript };
    return resolvePiCliScriptFromPackageJson(deps, resolvePiCliPackageRoot(deps));
}
export function resolvePiCliScript(deps = {}) {
    return resolvePiCliScriptWithStatus(deps).cliPath;
}
function getPiCliResolutionFailureSpawnCommand(resolution, deps) {
    const message = resolution.error
        ? `Resolved Pi package root from ${resolution.packageRoot.source} is unusable (${resolution.packageRoot.rootPath}): ${resolution.error}. Refusing ambient pi fallback.`
        : `Resolved Pi package root from ${resolution.packageRoot.source} is unusable (${resolution.packageRoot.rootPath}). Refusing ambient pi fallback.`;
    return {
        command: deps.execPath ?? process.execPath,
        args: ["-e", `process.stderr.write(${JSON.stringify(`${message}\n`)}); process.exit(1);`],
    };
}
export function getPiSpawnCommand(args, deps = {}) {
    const env = deps.env ?? process.env;
    const piBinary = env[PI_SUBAGENT_PI_BINARY_ENV]?.trim();
    if (piBinary) {
        return { command: piBinary, args };
    }
    const resolution = resolvePiCliScriptWithStatus(deps);
    if (resolution.cliPath) {
        return {
            command: deps.execPath ?? process.execPath,
            args: [resolution.cliPath, ...args],
        };
    }
    if (resolution.packageRoot) {
        return getPiCliResolutionFailureSpawnCommand(resolution, deps);
    }
    return { command: "pi", args };
}
