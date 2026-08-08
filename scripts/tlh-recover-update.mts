#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import process from "node:process";

type ValidTrack = "latest-release" | "pinned-tag" | "ref" | "custom";
type InstallerTrack = Exclude<ValidTrack, "custom">;
type StringOptionKey = "agentDir" | "binDir" | "wrapperName" | "repo" | "track" | "ref" | "packageSource";
type ProcessEnvMap = NodeJS.ProcessEnv;

interface CliArgs {
	agentDir: string;
	binDir: string;
	wrapperName: string;
	repo?: string;
	track?: string;
	ref?: string;
	packageSource?: string;
	explicitOptions: Set<string>;
	dryRun: boolean;
	extensions: boolean;
	force: boolean;
	noSettings: boolean;
	noWrapper: boolean;
	quiet: boolean;
	verbose: boolean;
	help: boolean;
}

interface NormalizedInstallState {
	schemaVersion?: number;
	repo: string;
	track: ValidTrack;
	ref?: string;
	packageSource?: string;
	packageSourceIsDefault: boolean;
	piInstalledByTlh?: boolean;
}

interface UpdatePlan {
	repo: string;
	track: InstallerTrack;
	ref?: string;
	packageSource?: string;
	packageSourceIsDefault: boolean;
	url: string;
}

interface DownloadedInstaller {
	dir: string;
	installerPath: string;
}

const DEFAULT_REPO = "diegopetrucci/the-last-harness";
const DEFAULT_WRAPPER_NAME = "tlh";
const DOWNLOAD_TIMEOUT_MS = 30_000;
const PACKAGE_UPDATE_ARGS = ["update", "--extensions"] as const;
const PACKAGE_UPDATE_UNSUPPORTED_OPTIONS = [
	["track", "--track"],
	["ref", "--ref"],
	["repo", "--repo"],
	["packageSource", "--package-source"],
	["force", "--force"],
	["noSettings", "--no-settings"],
	["noWrapper", "--no-wrapper"],
] as const;

function usage(): string {
	return `Usage: tlh update [options]

Run The Last Harness update recovery flow for the current isolated profile.
Upstream Pi is installed into a private TLH runtime at ~/.the-last-harness/runtime by the installer when needed.

Options:
  --agent-dir DIR       Isolated profile dir (default: ~/.the-last-harness/agent)
  --bin-dir DIR         Wrapper install dir (default: ~/.local/bin)
  --wrapper-name NAME   Wrapper command name (default: tlh)
  --extensions          Update isolated extensions/packages only via pi update --extensions
  --track TRACK         Override update track: latest-release, pinned-tag, ref, custom
  --ref REF             Override git ref/tag for pinned-tag or ref tracks
  --repo OWNER/REPO     Override GitHub repository
  --package-source SRC  Preserve a custom package source via TLH_PACKAGE_SOURCE
  --dry-run             Print the update plan without downloading or running installer
  --force               Pass --force to the installer
  --no-settings         Pass --no-settings to the installer
  --no-wrapper          Pass --no-wrapper to the installer
  --quiet               Suppress installer progress output
  --verbose             Show underlying installer output
  -h, --help            Show this help
`;
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
	const value = argv[index];
	if (!value || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function assignOptionValue(
	target: CliArgs,
	key: StringOptionKey,
	argv: readonly string[],
	index: number,
	flags: string | readonly string[],
): number | undefined {
	const arg = argv[index];
	for (const flag of Array.isArray(flags) ? flags : [flags]) {
		if (arg === flag) {
			target[key] = requiredValue(argv, index + 1, flag);
			return index + 1;
		}
		const prefix = `${flag}=`;
		if (!arg.startsWith(prefix)) {
			continue;
		}
		const value = arg.slice(prefix.length);
		if (!value) {
			throw new Error(`${flag} requires a value`);
		}
		target[key] = value;
		return index;
	}
	return undefined;
}

function expandHomePath(pathValue: string | undefined, options: { homeDir?: string } = {}): string | undefined {
	const homeDir = options.homeDir ?? process.env.HOME ?? homedir();
	if (typeof pathValue !== "string") {
		return pathValue;
	}
	if (pathValue === "~") {
		return homeDir;
	}
	if (pathValue.startsWith("~/")) {
		return join(homeDir, pathValue.slice(2));
	}
	return pathValue;
}

function firstConfiguredValue(...values: Array<string | undefined>): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value) {
			return value;
		}
	}
	return undefined;
}

function defaultTlhAgentDir(env: ProcessEnvMap = process.env, options: { homeDir?: string } = {}): string | undefined {
	const homeDir = options.homeDir ?? env.HOME ?? homedir();
	return expandHomePath(
		firstConfiguredValue(env.TLH_AGENT_DIR, env.PI_CODING_AGENT_DIR) || join(homeDir, ".the-last-harness", "agent"),
		{ homeDir },
	);
}

function defaultTlhBinDir(env: ProcessEnvMap = process.env, options: { homeDir?: string } = {}): string | undefined {
	const homeDir = options.homeDir ?? env.HOME ?? homedir();
	return expandHomePath(env.TLH_BIN_DIR || join(homeDir, ".local", "bin"), { homeDir });
}

function parseArgs(argv: readonly string[]): CliArgs {
	const args: CliArgs = {
		agentDir: defaultTlhAgentDir(process.env) ?? join(homedir(), ".the-last-harness", "agent"),
		binDir: defaultTlhBinDir(process.env) ?? join(homedir(), ".local", "bin"),
		wrapperName: process.env.TLH_WRAPPER_NAME || DEFAULT_WRAPPER_NAME,
		repo: process.env.TLH_REPO,
		track: undefined,
		ref: undefined,
		packageSource: process.env.TLH_PACKAGE_SOURCE,
		explicitOptions: new Set(),
		dryRun: false,
		extensions: false,
		force: false,
		noSettings: false,
		noWrapper: false,
		quiet: false,
		verbose: false,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") {
			args.help = true;
			continue;
		}
		if (arg === "--dry-run") {
			args.dryRun = true;
			args.explicitOptions.add("dryRun");
			continue;
		}
		if (arg === "--extensions") {
			args.extensions = true;
			args.explicitOptions.add("extensions");
			continue;
		}
		if (arg === "--force") {
			args.force = true;
			args.explicitOptions.add("force");
			continue;
		}
		if (arg === "--no-settings") {
			args.noSettings = true;
			args.explicitOptions.add("noSettings");
			continue;
		}
		if (arg === "--no-wrapper") {
			args.noWrapper = true;
			args.explicitOptions.add("noWrapper");
			continue;
		}
		if (arg === "--quiet") {
			args.quiet = true;
			args.verbose = false;
			continue;
		}
		if (arg === "--verbose") {
			args.verbose = true;
			args.quiet = false;
			continue;
		}
		const agentDirIndex = assignOptionValue(args, "agentDir", argv, index, "--agent-dir");
		if (agentDirIndex !== undefined) {
			args.explicitOptions.add("agentDir");
			index = agentDirIndex;
			continue;
		}
		const binDirIndex = assignOptionValue(args, "binDir", argv, index, "--bin-dir");
		if (binDirIndex !== undefined) {
			args.explicitOptions.add("binDir");
			index = binDirIndex;
			continue;
		}
		const wrapperNameIndex = assignOptionValue(args, "wrapperName", argv, index, "--wrapper-name");
		if (wrapperNameIndex !== undefined) {
			args.explicitOptions.add("wrapperName");
			index = wrapperNameIndex;
			continue;
		}
		const trackIndex = assignOptionValue(args, "track", argv, index, "--track");
		if (trackIndex !== undefined) {
			args.explicitOptions.add("track");
			index = trackIndex;
			continue;
		}
		const refIndex = assignOptionValue(args, "ref", argv, index, "--ref");
		if (refIndex !== undefined) {
			args.explicitOptions.add("ref");
			index = refIndex;
			continue;
		}
		const repoIndex = assignOptionValue(args, "repo", argv, index, "--repo");
		if (repoIndex !== undefined) {
			args.explicitOptions.add("repo");
			index = repoIndex;
			continue;
		}
		const packageSourceIndex = assignOptionValue(args, "packageSource", argv, index, "--package-source");
		if (packageSourceIndex !== undefined) {
			args.explicitOptions.add("packageSource");
			index = packageSourceIndex;
			continue;
		}
		throw new Error(`Unknown option for tlh update: ${arg}`);
	}

	args.agentDir = expandHomePath(args.agentDir) ?? args.agentDir;
	args.binDir = expandHomePath(args.binDir) ?? args.binDir;
	return args;
}

function isTruthyEnv(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function stripTrailingSlashes(pathValue: string): string {
	let result = pathValue;
	while (result !== sep && result.endsWith(sep)) {
		result = result.slice(0, -1);
	}
	return result;
}

function realpathForCompare(pathValue: string): string {
	const resolved = resolve(pathValue);
	if (existsSync(resolved)) {
		return realpathSync.native(resolved);
	}
	const parent = dirname(resolved);
	if (parent === resolved) {
		return resolved;
	}
	return join(realpathForCompare(parent), basename(resolved));
}

function pathWithinOrEqual(root: string, child: string): boolean {
	const normalizedRoot = stripTrailingSlashes(root);
	const normalizedChild = stripTrailingSlashes(child);
	if (normalizedRoot === sep) {
		return normalizedChild.startsWith(sep);
	}
	return normalizedChild === normalizedRoot || normalizedChild.startsWith(`${normalizedRoot}${sep}`);
}

function pathIsProtectedPiConfig(
	pathValue: string,
	options: { homeDir?: string; alreadyNormalized?: boolean } = {},
): boolean {
	const homeDir = options.homeDir ?? process.env.HOME ?? homedir();
	const normalizedPath = options.alreadyNormalized ? stripTrailingSlashes(pathValue) : realpathForCompare(pathValue);
	const normalPiRoot = realpathForCompare(join(homeDir, ".pi"));
	const normalPiAgentRoot = realpathForCompare(join(homeDir, ".pi", "agent"));
	return pathWithinOrEqual(normalPiRoot, normalizedPath) || pathWithinOrEqual(normalPiAgentRoot, normalizedPath);
}

function installStatePath(agentDir: string): string {
	return join(agentDir, "tlh", "install-state.json");
}

function readJson(pathValue: string): unknown {
	const content = readFileSync(pathValue, "utf8").replace(/^\uFEFF/, "");
	return JSON.parse(content);
}

function hasObjectShape(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function readTrimmedStringProperty(value: object, key: string): string | undefined {
	const propertyValue = Reflect.get(value, key);
	return typeof propertyValue === "string" && propertyValue.trim() ? propertyValue.trim() : undefined;
}

function readBooleanProperty(value: object, key: string): boolean | undefined {
	const propertyValue = Reflect.get(value, key);
	return typeof propertyValue === "boolean" ? propertyValue : undefined;
}

function readIntegerProperty(value: object, key: string): number | undefined {
	const propertyValue = Reflect.get(value, key);
	return Number.isInteger(propertyValue) ? propertyValue : undefined;
}

function isValidTrack(value: string | undefined): value is ValidTrack {
	switch (value) {
		case "latest-release":
		case "pinned-tag":
		case "ref":
		case "custom":
			return true;
		default:
			return false;
	}
}

function normalizeState(raw: unknown): NormalizedInstallState | undefined {
	if (!hasObjectShape(raw)) {
		return undefined;
	}
	const repo = readTrimmedStringProperty(raw, "repo");
	const track = readTrimmedStringProperty(raw, "track");
	const ref = readTrimmedStringProperty(raw, "ref");
	const packageSource = readTrimmedStringProperty(raw, "packageSource");
	if (!repo || !track || !isValidTrack(track)) {
		return undefined;
	}
	return {
		schemaVersion: readIntegerProperty(raw, "schemaVersion"),
		repo,
		track,
		ref,
		packageSource,
		packageSourceIsDefault: readBooleanProperty(raw, "packageSourceIsDefault") === true,
		...(typeof readBooleanProperty(raw, "piInstalledByTlh") === "boolean"
			? { piInstalledByTlh: readBooleanProperty(raw, "piInstalledByTlh") }
			: {}),
	};
}

function loadState(args: CliArgs): NormalizedInstallState | undefined {
	const pathValue = installStatePath(args.agentDir);
	if (!existsSync(pathValue)) {
		return undefined;
	}
	try {
		const state = normalizeState(readJson(pathValue));
		if (state) {
			return state;
		}
		if (!args.quiet) {
			console.error(`warning: ${pathValue} does not contain usable The Last Harness update metadata; ignoring it`);
		}
	} catch (error) {
		if (!args.quiet) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`warning: could not read ${pathValue}: ${message}`);
		}
	}
	return undefined;
}

function encodePathRef(ref: string): string {
	return ref
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
}

function resolvePlan(state: NormalizedInstallState | undefined, args: CliArgs): UpdatePlan {
	const repo = args.repo || state?.repo || DEFAULT_REPO;
	const track = args.track || state?.track;
	const ref = args.ref || state?.ref;
	const packageSource = args.packageSource || state?.packageSource;
	const packageSourceIsDefault = args.packageSource ? false : state?.packageSourceIsDefault === true;
	const changesStoredCustomTarget =
		state?.packageSourceIsDefault === false &&
		!args.packageSource &&
		((args.ref && args.ref !== state.ref) ||
			(args.repo && args.repo !== state.repo) ||
			(args.track && args.track !== state.track));
	if (changesStoredCustomTarget) {
		throw new Error(
			"This install uses a custom package source. Pass --package-source with any --track, --repo, or --ref override so package code and update metadata stay aligned.",
		);
	}

	if (!track || !isValidTrack(track)) {
		throw new Error(
			`Could not determine update track from ${installStatePath(args.agentDir)}. Re-run the installer from a working The Last Harness checkout, or pass --track latest-release, --track pinned-tag, or --track ref.`,
		);
	}
	if (track === "custom") {
		throw new Error(
			"This install is marked as a custom update track. Re-run the appropriate installer command manually, or run tlh update with --track, --ref, and --package-source overrides.",
		);
	}
	if ((track === "pinned-tag" || track === "ref") && !ref) {
		throw new Error(`Update track '${track}' requires a ref. Pass --ref <ref>.`);
	}
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
		throw new Error(`Unsupported GitHub repo value: ${repo}`);
	}

	if (track === "latest-release") {
		return {
			repo,
			track,
			ref: undefined,
			packageSource,
			packageSourceIsDefault,
			url: `https://github.com/${repo}/releases/latest/download/install.sh`,
		};
	}
	if (!ref) {
		throw new Error(`Update track '${track}' requires a ref. Pass --ref <ref>.`);
	}
	const requiredRef = ref;
	if (track === "pinned-tag") {
		return {
			repo,
			track,
			ref: requiredRef,
			packageSource,
			packageSourceIsDefault,
			url: `https://github.com/${repo}/releases/download/${encodeURIComponent(requiredRef)}/install.sh`,
		};
	}
	return {
		repo,
		track,
		ref: requiredRef,
		packageSource,
		packageSourceIsDefault,
		url: `https://raw.githubusercontent.com/${repo}/${encodePathRef(requiredRef)}/install.sh`,
	};
}

function buildInstallerArgs(plan: UpdatePlan, args: CliArgs, state: NormalizedInstallState | undefined): string[] {
	const installerArgs = [
		"--agent-dir",
		args.agentDir,
		"--bin-dir",
		args.binDir,
		"--wrapper-name",
		args.wrapperName,
		"--track",
		plan.track,
	];

	if (plan.track === "pinned-tag" || plan.track === "ref") {
		const { ref } = plan;
		if (!ref) {
			throw new Error(`Update track '${plan.track}' requires a ref. Pass --ref <ref>.`);
		}
		installerArgs.push("--ref", ref);
	}
	if (args.force) {
		installerArgs.push("--force");
	}
	if (args.noSettings) {
		installerArgs.push("--no-settings");
	}
	if (args.noWrapper) {
		installerArgs.push("--no-wrapper");
	}
	if (args.quiet) {
		installerArgs.push("--quiet");
	}
	if (args.verbose) {
		installerArgs.push("--verbose");
	}
	if (typeof state?.piInstalledByTlh === "boolean") {
		installerArgs.push("--pi-installed-by-tlh", String(state.piInstalledByTlh));
	}
	return installerArgs;
}

function shellQuote(value: unknown): string {
	return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function printDryRun(plan: UpdatePlan, installerArgs: readonly string[], env: ProcessEnvMap): void {
	console.log("The Last Harness update plan");
	console.log(`Track: ${plan.track}${plan.ref ? ` (${plan.ref})` : ""}`);
	console.log(`Installer: ${plan.url}`);
	if (env.TLH_PACKAGE_SOURCE) {
		console.log(`Package source: ${env.TLH_PACKAGE_SOURCE}`);
	}
	const envParts: string[] = [];
	if (env.TLH_REPO) {
		envParts.push(`TLH_REPO=${shellQuote(env.TLH_REPO)}`);
	}
	if (env.TLH_PACKAGE_SOURCE) {
		envParts.push(`TLH_PACKAGE_SOURCE=${shellQuote(env.TLH_PACKAGE_SOURCE)}`);
	}
	const prefix = envParts.length > 0 ? `${envParts.join(" ")} ` : "";
	console.log(`Would run: ${prefix}bash <downloaded install.sh> ${installerArgs.map(shellQuote).join(" ")}`);
}

function assertRecoveryTargetSafe(agentDir: string): void {
	if (pathIsProtectedPiConfig(agentDir)) {
		throw new Error(`refusing to recover The Last Harness update against normal Pi config root: ${agentDir}`);
	}
}

function assertPackageUpdateTargetSafe(agentDir: string): void {
	if (pathIsProtectedPiConfig(agentDir)) {
		throw new Error(`refusing to run The Last Harness extension update against normal Pi config root: ${agentDir}`);
	}
}

function assertPackageUpdateArgs(args: CliArgs): void {
	const unsupported = PACKAGE_UPDATE_UNSUPPORTED_OPTIONS.filter(([key]) => args.explicitOptions.has(key)).map(
		([, flag]) => flag,
	);
	if (unsupported.length > 0) {
		throw new Error(
			`--extensions does not support ${unsupported.join(", ")}. Run plain tlh update for installer updates.`,
		);
	}
}

function realpathIfPossible(pathValue: string): string | undefined {
	try {
		return realpathSync(pathValue);
	} catch {
		return undefined;
	}
}

function sanitizedPath(pathValue: string | undefined, agentDir: string): string {
	if (pathValue === undefined) {
		return "";
	}
	const cwd = resolve(process.cwd());
	const cwdRealpath = realpathIfPossible(cwd);
	const managedBin = resolve(agentDir, "bin");
	const managedBinRealpath = realpathIfPossible(managedBin);
	return String(pathValue)
		.split(delimiter)
		.filter((entry) => {
			if (!entry) {
				return false;
			}
			const resolvedEntry = resolve(entry);
			if (resolvedEntry === cwd || resolvedEntry === managedBin) {
				return false;
			}
			const entryRealpath = realpathIfPossible(resolvedEntry);
			if (entryRealpath && cwdRealpath && entryRealpath === cwdRealpath) {
				return false;
			}
			if (entryRealpath && managedBinRealpath && entryRealpath === managedBinRealpath) {
				return false;
			}
			return true;
		})
		.join(delimiter);
}

function envWithSanitizedPath(baseEnv: ProcessEnvMap, agentDir: string): ProcessEnvMap {
	return {
		...baseEnv,
		PATH: sanitizedPath(baseEnv.PATH, agentDir),
	};
}

function isExecutable(pathValue: string): boolean {
	try {
		if (!statSync(pathValue).isFile()) {
			return false;
		}
		accessSync(pathValue, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveCommand(command: string, env: ProcessEnvMap): string {
	for (const entry of String(env.PATH || "").split(delimiter)) {
		if (!entry) {
			continue;
		}
		const candidate = resolve(entry, command);
		if (isExecutable(candidate)) {
			return candidate;
		}
	}
	throw new Error(`required command not found on sanitized PATH: ${command}`);
}

function printPackageUpdateDryRun(piCommand: string, args: CliArgs): void {
	console.log("The Last Harness extension update plan");
	console.log(`Agent dir: ${args.agentDir}`);
	console.log(
		`Would run: PI_CODING_AGENT_DIR=${shellQuote(args.agentDir)} ${shellQuote(piCommand)} ${PACKAGE_UPDATE_ARGS.map(shellQuote).join(" ")}`,
	);
}

function runPackageUpdate(args: CliArgs): void {
	assertPackageUpdateTargetSafe(args.agentDir);
	assertPackageUpdateArgs(args);
	const sanitizedEnv = envWithSanitizedPath(process.env, args.agentDir);
	// Always use the absolute private TLH runtime pi binary rather than resolving
	// "pi" by name from PATH — identical logic to tlh-recover-update.mjs.
	const piCommand = join(dirname(args.agentDir), "runtime", "bin", "pi");
	if (args.dryRun) {
		printPackageUpdateDryRun(piCommand, args);
		return;
	}
	if (!existsSync(piCommand)) {
		throw new Error(
			`The Last Harness private runtime pi not found at ${piCommand}. Run \`tlh update\` (without --extensions) to repair the private runtime.`,
		);
	}
	if (isTruthyEnv(process.env.PI_OFFLINE)) {
		throw new Error("PI_OFFLINE is set; refusing to run a network update.");
	}
	if (!args.quiet) {
		console.log("Updating The Last Harness isolated extensions...");
		if (args.verbose) {
			console.log(`Pi: ${piCommand}`);
		}
	}
	const result = spawnSync(piCommand, PACKAGE_UPDATE_ARGS, {
		stdio: "inherit",
		env: {
			...sanitizedEnv,
			PI_CODING_AGENT_DIR: args.agentDir,
		},
	});
	if (result.error) {
		throw result.error;
	}
	const exitCode = result.status ?? (result.signal ? 1 : 0);
	if (exitCode !== 0) {
		process.exitCode = exitCode;
		return;
	}
	process.exitCode = 0;
}

async function downloadInstaller(url: string): Promise<DownloadedInstaller> {
	const response = await fetch(url, {
		headers: {
			Accept: "text/x-shellscript,text/plain,*/*",
			"User-Agent": "tlh-recover-update",
		},
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`failed to download installer (${response.status} ${response.statusText}): ${url}`);
	}
	const content = await response.text();
	if (!content.trim()) {
		throw new Error(`downloaded installer was empty: ${url}`);
	}
	const dir = mkdtempSync(join(tmpdir(), "tlh-update-recovery-"));
	const installerPath = join(dir, "install.sh");
	writeFileSync(installerPath, content, "utf8");
	chmodSync(installerPath, 0o700);
	return { dir, installerPath };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(usage());
		return;
	}
	if (args.extensions) {
		runPackageUpdate(args);
		return;
	}
	assertRecoveryTargetSafe(args.agentDir);
	if (args.track && !isValidTrack(args.track)) {
		throw new Error(`Invalid --track value: ${args.track}`);
	}

	const state = loadState(args);
	const plan = resolvePlan(state, args);
	const installerArgs = buildInstallerArgs(plan, args, state);
	const sanitizedEnv = envWithSanitizedPath(process.env, args.agentDir);
	const childEnv: ProcessEnvMap = {
		...sanitizedEnv,
		TLH_REPO: plan.repo,
	};
	delete childEnv.TLH_REF;
	delete childEnv.TLH_RAW_BASE;
	delete childEnv.TLH_UPDATE_TRACK;
	if (plan.packageSource && !plan.packageSourceIsDefault) {
		childEnv.TLH_PACKAGE_SOURCE = plan.packageSource;
	} else if (args.packageSource) {
		childEnv.TLH_PACKAGE_SOURCE = args.packageSource;
	} else {
		delete childEnv.TLH_PACKAGE_SOURCE;
	}

	if (args.dryRun) {
		printDryRun(plan, installerArgs, childEnv);
		return;
	}
	if (isTruthyEnv(process.env.PI_OFFLINE)) {
		throw new Error("PI_OFFLINE is set; refusing to run a network update.");
	}

	if (!args.quiet) {
		const refLabel = plan.ref ? ` (${plan.ref})` : "";
		console.log(`Recovering The Last Harness update via ${plan.track}${refLabel}...`);
		if (args.verbose) {
			console.log(`Installer: ${plan.url}`);
		}
	}

	let temp: DownloadedInstaller | undefined;
	try {
		temp = await downloadInstaller(plan.url);
		const bashCommand = resolveCommand("bash", sanitizedEnv);
		const result = spawnSync(bashCommand, [temp.installerPath, ...installerArgs], {
			stdio: "inherit",
			env: childEnv,
		});
		if (result.error) {
			throw result.error;
		}
		process.exitCode = result.status ?? (result.signal ? 1 : 0);
	} finally {
		if (temp?.dir) {
			rmSync(temp.dir, { recursive: true, force: true });
		}
	}
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`error: ${message}`);
	process.exitCode = 1;
});
