import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInstalledPiPackageRoot, resolvePiPackageRoot } from "../runs/shared/pi-spawn.ts";

const DEFAULT_CONFIG_DIR_NAME = ".pi";
const RUNTIME_CONFIG_DIR = Symbol("runtime-config-dir");

// Detached async runners cannot peer-import the Pi runtime; the parent forwards
// its resolved Pi package root through this env var so config-dir resolution
// still works without importing @earendil-works/pi-coding-agent.
export const PI_CODING_AGENT_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";

let cachedRuntimeConfigDirName: string | null | undefined;

export interface RuntimeConfigDirDeps {
	readFileSync?: (filePath: string, encoding: "utf-8") => string;
	resolveRuntimePackageRoot?: () => string | undefined;
	resolveInstalledPackageRoot?: () => string | undefined;
	env?: NodeJS.ProcessEnv;
	useCache?: boolean;
}

function normalizeConfigDirName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function resolveConfigDirNameFromSource(source: unknown): string | undefined {
	if (!source || typeof source !== "object") return undefined;

	const direct = source as {
		CONFIG_DIR_NAME?: unknown;
		configDir?: unknown;
		piConfig?: { configDir?: unknown } | null;
	};
	return normalizeConfigDirName(direct.CONFIG_DIR_NAME)
		?? normalizeConfigDirName(direct.configDir)
		?? normalizeConfigDirName(direct.piConfig?.configDir);
}

function readConfigDirNameFromPackageRoot(packageRoot: string | undefined, deps: RuntimeConfigDirDeps): string | undefined {
	if (!packageRoot) return undefined;

	try {
		const readFileSync = deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
		const packageJsonPath = path.join(packageRoot, "package.json");
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			piConfig?: { configDir?: unknown } | null;
		};
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

function resolveConfigDirNameFromEntryPoint(entryPoint: string | undefined, packageRoot: string | undefined, deps: RuntimeConfigDirDeps): string | undefined {
	const explicitRootValue = readConfigDirNameFromPackageRoot(packageRoot, deps);
	if (explicitRootValue !== undefined) return explicitRootValue;
	if (!entryPoint) return undefined;

	try {
		let dir = path.dirname(fs.realpathSync(entryPoint));
		while (dir !== path.dirname(dir)) {
			const value = readConfigDirNameFromPackageRoot(dir, deps);
			if (value !== undefined) return value;
			dir = path.dirname(dir);
		}
	} catch {
		// Package metadata lookup is best-effort; detached runners must not fail here.
	}
	return undefined;
}

export function resolveRuntimeConfigDirName(deps: RuntimeConfigDirDeps = {}): string | undefined {
	const useCache = deps.useCache ?? (
		deps.readFileSync === undefined
		&& deps.resolveRuntimePackageRoot === undefined
		&& deps.resolveInstalledPackageRoot === undefined
		&& deps.env === undefined
	);
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

	if (useCache) cachedRuntimeConfigDirName = value ?? null;
	return value;
}

/**
 * Resolves the active Pi config directory name (e.g. ".pi").
 *
 * Supports two call shapes to stay compatible with both fork and upstream callers:
 *  - `resolveConfigDirName(codingAgentModule)` — fork-style: resolve from an explicit
 *    module-shaped source, or (when omitted) from the resolved parent/private Pi runtime.
 *  - `resolveConfigDirName(codingAgentModule, entryPoint, packageRoot)` — upstream-style:
 *    resolve by walking up from an explicit entrypoint path and/or reading an explicit
 *    package root directly, without needing runtime dependency injection.
 *  - `resolveConfigDirName(codingAgentModule, deps)` — fork test-injection style: pass a
 *    `RuntimeConfigDirDeps` object to override how the runtime package root is resolved.
 */
export function resolveConfigDirName(
	codingAgentModule: unknown = RUNTIME_CONFIG_DIR,
	entryPointOrDeps?: string | RuntimeConfigDirDeps,
	packageRoot?: string,
): string {
	if (codingAgentModule !== RUNTIME_CONFIG_DIR) {
		return resolveConfigDirNameFromSource(codingAgentModule) ?? DEFAULT_CONFIG_DIR_NAME;
	}

	if (typeof entryPointOrDeps === "string" || packageRoot !== undefined) {
		const value = resolveConfigDirNameFromEntryPoint(entryPointOrDeps as string | undefined, packageRoot, {});
		return value ?? DEFAULT_CONFIG_DIR_NAME;
	}

	const deps = (entryPointOrDeps as RuntimeConfigDirDeps | undefined) ?? {};
	return resolveRuntimeConfigDirName(deps) ?? DEFAULT_CONFIG_DIR_NAME;
}

export function getConfigDirName(): string {
	return resolveConfigDirName();
}

export function getProjectConfigDir(projectRoot: string): string {
	return path.join(projectRoot, getConfigDirName());
}
