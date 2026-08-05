import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";

export function findPiPackageRootFromEntry(
	entryPoint: string,
): string | undefined {
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
				name?: unknown;
			};
			if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

export function resolveInstalledPiPackageRoot(): string | undefined {
	return findPiPackageRootFromEntry(
		fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE)),
	);
}

export function resolvePiPackageRoot(): string | undefined {
	try {
		const entry = process.argv[1];
		return entry
			? findPiPackageRootFromEntry(fs.realpathSync(entry))
			: undefined;
	} catch {
		// process.argv[1] probing is best-effort; callers can fall back to PATH/package resolution.
		return undefined;
	}
}

export interface PiSpawnDeps {
	platform?: NodeJS.Platform;
	execPath?: string;
	argv1?: string;
	existsSync?: (filePath: string) => boolean;
	readFileSync?: (filePath: string, encoding: "utf-8") => string;
	realpathSync?: (filePath: string) => string;
	resolvePackageJson?: () => string;
	resolvePackageEntry?: () => string;
	resolveInstalledPackageRoot?: () => string | undefined;
	piPackageRoot?: string;
	env?: NodeJS.ProcessEnv;
}

interface PiSpawnCommand {
	command: string;
	args: string[];
}

interface PiPackageRootResolution {
	rootPath: string;
	source: string;
}

interface PiCliScriptResolution {
	cliPath?: string;
	packageRoot?: PiPackageRootResolution;
	error?: string;
}

function isRunnableNodeScript(filePath: string, existsSync: (filePath: string) => boolean): boolean {
	if (!existsSync(filePath)) return false;
	return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function normalizePath(filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

function resolveArgvPiCliScript(deps: PiSpawnDeps = {}): string | undefined {
	const existsSync = deps.existsSync ?? fs.existsSync;
	const realpathSync = deps.realpathSync ?? fs.realpathSync;
	const argv1 = deps.argv1 ?? process.argv[1];
	if (!argv1) return undefined;

	try {
		const argvPath = normalizePath(argv1);
		const realArgvPath = realpathSync(argvPath);
		if (!isRunnableNodeScript(realArgvPath, existsSync)) return undefined;
		return findPiPackageRootFromEntry(realArgvPath) ? realArgvPath : undefined;
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

function resolvePiCliPackageRoot(deps: PiSpawnDeps = {}): PiPackageRootResolution | undefined {
	if (deps.piPackageRoot) return { rootPath: deps.piPackageRoot, source: "piPackageRoot" };

	const runtimeRoot = resolvePiPackageRoot();
	if (runtimeRoot) return { rootPath: runtimeRoot, source: "current runtime root" };

	if (deps.resolvePackageEntry) {
		const packageRoot = safeResolvePackageRoot(() => findPiPackageRootFromEntry(deps.resolvePackageEntry!()));
		if (packageRoot) return { rootPath: packageRoot, source: "package entry root" };
	}

	const resolveInstalledPackageRoot = deps.resolveInstalledPackageRoot ?? resolveInstalledPiPackageRoot;
	const packageRoot = safeResolvePackageRoot(resolveInstalledPackageRoot);
	return packageRoot ? { rootPath: packageRoot, source: "installed package root" } : undefined;
}

function resolvePiCliScriptFromPackageJson(
	deps: PiSpawnDeps,
	packageRoot?: PiPackageRootResolution,
): PiCliScriptResolution {
	const existsSync = deps.existsSync ?? fs.existsSync;
	const readFileSync = deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));

	try {
		const resolvePackageJson = deps.resolvePackageJson ?? (() => {
			if (!packageRoot) throw new Error(`Could not resolve ${PI_CODING_AGENT_PACKAGE} package root`);
			return path.join(packageRoot.rootPath, "package.json");
		});
		const packageJsonPath = resolvePackageJson();
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
			bin?: string | Record<string, string>;
		};
		const binField = packageJson.bin;
		const binPath = typeof binField === "string"
			? binField
			: binField?.pi ?? Object.values(binField ?? {})[0];
		if (!binPath) {
			return packageRoot ? { packageRoot, error: `No Pi CLI bin entry found in ${packageJsonPath}` } : {};
		}
		const candidate = path.resolve(path.dirname(packageJsonPath), binPath);
		if (isRunnableNodeScript(candidate, existsSync)) {
			return { cliPath: candidate, packageRoot };
		}
		return packageRoot ? { packageRoot, error: `Resolved Pi CLI script is not runnable: ${candidate}` } : {};
	} catch (error) {
		return packageRoot
			? { packageRoot, error: error instanceof Error ? error.message : String(error) }
			: {};
	}
}

function resolvePiCliScriptWithStatus(deps: PiSpawnDeps = {}): PiCliScriptResolution {
	if (deps.piPackageRoot) {
		return resolvePiCliScriptFromPackageJson(deps, { rootPath: deps.piPackageRoot, source: "piPackageRoot" });
	}

	const argvCliScript = resolveArgvPiCliScript(deps);
	if (argvCliScript) return { cliPath: argvCliScript };

	return resolvePiCliScriptFromPackageJson(deps, resolvePiCliPackageRoot(deps));
}

export function resolvePiCliScript(deps: PiSpawnDeps = {}): string | undefined {
	return resolvePiCliScriptWithStatus(deps).cliPath;
}

export function resolveWindowsPiCliScript(deps: PiSpawnDeps = {}): string | undefined {
	return resolvePiCliScript(deps);
}

function getPiCliResolutionFailureSpawnCommand(
	resolution: PiCliScriptResolution & { packageRoot: PiPackageRootResolution },
	deps: PiSpawnDeps,
): PiSpawnCommand {
	const message = resolution.error
		? `Resolved Pi package root from ${resolution.packageRoot.source} is unusable (${resolution.packageRoot.rootPath}): ${resolution.error}. Refusing ambient pi fallback.`
		: `Resolved Pi package root from ${resolution.packageRoot.source} is unusable (${resolution.packageRoot.rootPath}). Refusing ambient pi fallback.`;
	return {
		command: deps.execPath ?? process.execPath,
		args: ["-e", `process.stderr.write(${JSON.stringify(`${message}\n`)}); process.exit(1);`],
	};
}

/**
 * Precedence for resolving the command used to spawn a child Pi process:
 *   1. An explicit `PI_SUBAGENT_PI_BINARY` env override always wins, on any
 *      platform, so wrappers/CI can force a specific binary.
 *   2. Otherwise, resolve the parent/private Pi runtime (argv1, an explicit
 *      `piPackageRoot`, or the installed `@earendil-works/pi-coding-agent`
 *      package) and spawn that resolved CLI script via node. This keeps
 *      child subagents on the same Pi runtime as their parent (e.g. TLH's
 *      private runtime under `~/.the-last-harness/runtime/bin/pi`) instead
 *      of silently falling through to a different `pi` found on PATH.
 *   3. If a package root was found but its CLI script could not be resolved
 *      or run, refuse the ambient `pi` fallback and fail loudly instead of
 *      possibly running the wrong Pi binary.
 *   4. Only when no package root could be resolved at all do we fall back
 *      to plain `pi` (relying on PATH), matching upstream's simplest case.
 */
export function getPiSpawnCommand(args: string[], deps: PiSpawnDeps = {}): PiSpawnCommand {
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
		return getPiCliResolutionFailureSpawnCommand(
			resolution as PiCliScriptResolution & { packageRoot: PiPackageRootResolution },
			deps,
		);
	}

	return { command: "pi", args };
}
