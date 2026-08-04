#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
	disabledDefaultExtensionIds,
	packageIdentity,
	readDefaultExtensions,
	type DefaultExtensionEntry,
} from "./lib/default-extensions.mjs";
import {
	captureManagedRetiredSubagentPackages,
	cleanupManagedRetiredSubagentPackages,
	copyTlhSubagentPrompts,
	missingTlhSubagentPrompts,
	restoreNeededTlhSubagentPrompts,
	settingsRequireTlhSubagentPrompts,
} from "./lib/tlh-install-subagents.mjs";
import {
	pathWithinOrEqual,
	realpathForCompare,
} from "./lib/tlh-install-paths.mjs";
import {
	assignOptionValue,
	defaultTlhSettingsPath,
	expandHomePath,
	pathIsInNormalPiConfig,
	readJsonFile,
	resolveTlhAgentDir,
} from "./lib/tlh-install-utils.mjs";

type CheckLevel = "OK" | "WARN" | "FAIL";

type CheckResult = {
	level: CheckLevel;
	label: string;
	detail: string;
};

type CliArgs = {
	agentDir?: string;
	settingsPath?: string;
	packageRoot?: string;
	repair: boolean;
	help: boolean;
};

type SettingsState = {
	settingsPath: string;
	settings: Record<string, unknown> | undefined;
};

type JsonObject = Record<string, unknown>;

type CommandResult = ReturnType<typeof spawnSync>;

type McpConfigSummary = {
	validCount: number;
	invalidCount: number;
	examples: string[];
};

type RepairLevel = "OK" | "WARN" | "FAIL" | "SKIP";

type RepairAction = {
	level: RepairLevel;
	label: string;
	detail: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_ROOT = resolve(__dirname, "..");
const DEFAULT_RUNTIME_MARKER = ".tlh-runtime-owned";
const DEFAULT_PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const COMMAND_TIMEOUT_MS = 5_000;
const REPAIR_HELPER_TIMEOUT_MS = 120_000;
const MAX_DETAIL_ITEMS = 3;

function usage(): string {
	return `Usage: tlh doctor [options]\n\nRead-only diagnostics for the active isolated tlh profile.\n\nOptions:\n  --agent-dir DIR     Isolated tlh agent dir (default: PI_CODING_AGENT_DIR or ~/.the-last-harness/agent)\n  --settings PATH     Isolated settings path (default: <agent-dir>/settings.json)\n  --package-root DIR  Installed The Last Harness package root\n  --repair            Explicit guarded repair mode for TLH-owned isolated-profile drift\n  -h, --help          Show this help\n`;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		agentDir: undefined,
		settingsPath: undefined,
		packageRoot: undefined,
		repair: false,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") {
			args.help = true;
			continue;
		}
		if (arg === "--repair") {
			args.repair = true;
			continue;
		}
		const agentDirIndex = assignOptionValue(args, "agentDir", argv, index, "--agent-dir") as number | undefined;
		if (agentDirIndex !== undefined) {
			index = agentDirIndex;
			continue;
		}
		const settingsIndex = assignOptionValue(args, "settingsPath", argv, index, "--settings") as number | undefined;
		if (settingsIndex !== undefined) {
			index = settingsIndex;
			continue;
		}
		const packageRootIndex = assignOptionValue(args, "packageRoot", argv, index, "--package-root") as number | undefined;
		if (packageRootIndex !== undefined) {
			index = packageRootIndex;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return args;
}

function loadExpectedPiVersion(packageRoot: string): string {
	try {
		const installSh = readFileSync(join(packageRoot, "install.sh"), "utf8");
		const pinnedVersion = installSh.match(/^TLH_PINNED_PI_VERSION="([^"]+)"$/m)?.[1]?.trim();
		if (pinnedVersion) return pinnedVersion;
	} catch {
		// Fall through to package metadata.
	}
	try {
		const packageJson = readJsonFile<JsonObject>(join(packageRoot, "package.json"));
		const devDependencies = isPlainObject(packageJson.devDependencies)
			? packageJson.devDependencies as Record<string, unknown>
			: undefined;
		const configured = devDependencies?.[DEFAULT_PI_PACKAGE_NAME];
		return typeof configured === "string" && configured.trim() ? configured.trim() : "unknown";
	} catch {
		return "unknown";
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordCheck(results: CheckResult[], level: CheckLevel, label: string, detail: string): void {
	results.push({ level, label, detail });
}

function highestLevel(levels: CheckLevel[]): CheckLevel {
	if (levels.includes("FAIL")) return "FAIL";
	if (levels.includes("WARN")) return "WARN";
	return "OK";
}

function summarizeLevels(results: CheckResult[]): string {
	const counts = { OK: 0, WARN: 0, FAIL: 0 };
	for (const result of results) counts[result.level] += 1;
	return `${counts.OK} OK, ${counts.WARN} WARN, ${counts.FAIL} FAIL`;
}

function summarizeItems(items: string[], maxItems = MAX_DETAIL_ITEMS): string {
	if (items.length <= maxItems) return items.join(", ");
	return `${items.slice(0, maxItems).join(", ")}, +${items.length - maxItems} more`;
}

function summarizeCountsByCategory(entries: string[]): string {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		counts.set(entry, (counts.get(entry) ?? 0) + 1);
	}
	return summarizeItems([...counts.entries()].map(([label, count]) => `${label} ${count}`));
}

function categorizeSettingsDriftLine(change: string): { category: string; countsAsPendingChange: boolean } {
	const normalized = change.trim().toLowerCase();
	if (normalized.startsWith("back up existing settings before writing")) {
		return { category: "backup", countsAsPendingChange: false };
	}
	for (const category of ["set", "overwrite", "append", "replace", "update", "remove", "reorder"]) {
		if (normalized.startsWith(`${category} `)) {
			return { category, countsAsPendingChange: true };
		}
	}
	if (normalized.startsWith("force-remove ")) {
		return { category: "remove", countsAsPendingChange: true };
	}
	return { category: "other", countsAsPendingChange: true };
}

function runCommand(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): CommandResult {
	return spawnSync(command, args, {
		encoding: "utf8",
		timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
		maxBuffer: 1024 * 1024,
		env: options.env,
	});
}

function commandFailureSummary(result: CommandResult): string {
	if (result.error) return result.error.message;
	if (result.signal) return `terminated by ${result.signal}`;
	return `exit ${result.status ?? "unknown"}`;
}

function loadSettings(settingsPath: string): SettingsState {
	const raw = readJsonFile<JsonObject>(settingsPath);
	if (!isPlainObject(raw)) {
		throw new Error("settings must be a JSON object");
	}
	return { settingsPath, settings: raw };
}

function defaultExtensionsPath(packageRoot: string): string {
	return join(packageRoot, "config", "default-extensions.json");
}

function defaultsPath(packageRoot: string): string {
	return join(packageRoot, "config", "settings.defaults.json");
}

function mergeSettingsScript(packageRoot: string): string {
	return join(packageRoot, "scripts", "merge-settings.mjs");
}

function gnosisScript(packageRoot: string): string {
	return join(packageRoot, "scripts", "tlh-gnosis.mjs");
}

function ticketsScript(packageRoot: string): string {
	return join(packageRoot, "scripts", "tlh-tickets.mjs");
}

function runtimeDirForAgent(agentDir: string): string {
	return join(dirname(agentDir), "runtime");
}

function addProfileChecks(results: CheckResult[], agentDir: string, settingsState: SettingsState): void {
	const levels: CheckLevel[] = [];
	const details: string[] = [];
	if (pathIsInNormalPiConfig(agentDir)) {
		levels.push("FAIL");
		details.push("agent dir is inside ~/.pi");
	} else {
		levels.push("OK");
		details.push("isolated agent dir");
	}
	levels.push("OK");
	details.push(`settings parsed (${settingsState.settingsPath})`);
	recordCheck(results, highestLevel(levels), "profile isolation/settings", details.join("; "));
}

function addProtectedAgentDirCheck(results: CheckResult[], agentDir: string): void {
	recordCheck(results, "FAIL", "profile isolation/settings", `agent dir is inside ~/.pi; profile not inspected (${agentDir})`);
}

function addUnsafeSettingsPathCheck(results: CheckResult[], agentDir: string, settingsPath: string): void {
	const details = [];
	if (pathIsInNormalPiConfig(agentDir)) {
		details.push("agent dir is inside ~/.pi");
	} else {
		details.push("isolated agent dir");
	}
	details.push("settings path is inside ~/.pi");
	details.push(`settings not read (${settingsPath})`);
	recordCheck(results, "FAIL", "profile isolation/settings", details.join("; "));
}

function addSettingsDriftCheck(results: CheckResult[], packageRoot: string, settingsPath: string, env: NodeJS.ProcessEnv): void {
	const result = runCommand(process.execPath, [
		mergeSettingsScript(packageRoot),
		defaultsPath(packageRoot),
		"--settings", settingsPath,
		"--default-extensions", defaultExtensionsPath(packageRoot),
		"--dry-run",
	], { env });
	if (result.status !== 0) {
		recordCheck(results, "FAIL", "settings drift", `could not evaluate packaged drift (${commandFailureSummary(result)})`);
		return;
	}

	const lines = `${result.stdout || ""}\n${result.stderr || ""}`
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.some((line) => line === "No settings changes needed.")) {
		recordCheck(results, "OK", "settings drift", "packaged defaults already match the isolated profile");
		return;
	}

	const dryRunActions = lines
		.filter((line) => line.startsWith("Would "))
		.map((line) => categorizeSettingsDriftLine(line.replace(/^Would\s+/, "")));
	const pendingChanges = dryRunActions.filter((action) => action.countsAsPendingChange);
	const backupPlanned = dryRunActions.some((action) => action.category === "backup");
	const detail = pendingChanges.length > 0
		? `${pendingChanges.length} pending packaged change(s) (${summarizeCountsByCategory(pendingChanges.map((action) => action.category))})${backupPlanned ? "; repair would also back up existing settings" : ""}`
		: "packaged defaults would change the isolated profile";
	recordCheck(results, "WARN", "settings drift", detail);
}

function addBundledSubagentCheck(results: CheckResult[], packageRoot: string, agentDir: string): void {
	const packagedDefaultsPath = defaultsPath(packageRoot);
	if (!settingsRequireTlhSubagentPrompts(packagedDefaultsPath)) {
		recordCheck(results, "OK", "bundled subagent resources", "packaged defaults do not require copied subagent prompts");
		return;
	}

	const sourceDir = join(packageRoot, "agents", "subagents");
	const sourceMissing = missingTlhSubagentPrompts(sourceDir);
	if (sourceMissing.length > 0) {
		recordCheck(results, "FAIL", "bundled subagent resources", `packaged prompts are incomplete; run \`tlh update\` (${summarizeItems(sourceMissing)})`);
		return;
	}
	const subagentDir = join(agentDir, "tlh", "agents", "subagents");
	const restoreNeeded = restoreNeededTlhSubagentPrompts(sourceDir, subagentDir);
	if (restoreNeeded.length === 0) {
		recordCheck(results, "OK", "bundled subagent resources", `found current prompt bundle at ${subagentDir}`);
		return;
	}
	recordCheck(results, "FAIL", "bundled subagent resources", `restoration needed for ${restoreNeeded.length} prompt(s): ${summarizeItems(restoreNeeded)}`);
}

function readRuntimeMarker(markerPath: string): { detail: string; level: CheckLevel } {
	if (!existsSync(markerPath)) {
		return { level: "WARN", detail: `missing ${DEFAULT_RUNTIME_MARKER}` };
	}
	try {
		const marker = readJsonFile<JsonObject>(markerPath);
		const packageName = typeof marker.packageName === "string" ? marker.packageName : "unknown";
		const origin = typeof marker.origin === "string" ? marker.origin : "unknown";
		const runtimeAbsPath = typeof marker.runtimeAbsPath === "string" ? marker.runtimeAbsPath : "unknown";
		return {
			level: packageName === DEFAULT_PI_PACKAGE_NAME ? "OK" : "WARN",
			detail: `marker origin=${origin}, package=${packageName}, runtime=${runtimeAbsPath}`,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { level: "WARN", detail: `invalid ${DEFAULT_RUNTIME_MARKER} (${message})` };
	}
}

function readInstallStateHint(agentDir: string): string {
	const path = join(agentDir, "tlh", "install-state.json");
	if (!existsSync(path)) return "install-state missing";
	try {
		const state = readJsonFile<JsonObject>(path);
		const parts = [];
		if (typeof state.track === "string" && state.track) parts.push(`track=${state.track}`);
		if (typeof state.ref === "string" && state.ref) parts.push(`ref=${state.ref}`);
		if (typeof state.repo === "string" && state.repo) parts.push(`repo=${state.repo}`);
		return parts.length > 0 ? parts.join(", ") : "install-state present";
	} catch {
		return "install-state invalid";
	}
}

function addRuntimeCheck(results: CheckResult[], agentDir: string, expectedPiVersion: string): void {
	const runtimeDir = runtimeDirForAgent(agentDir);
	const markerPath = join(runtimeDir, DEFAULT_RUNTIME_MARKER);
	const piPath = join(runtimeDir, "bin", "pi");
	if (!existsSync(piPath)) {
		recordCheck(results, "FAIL", "private runtime marker/version hints", `private runtime pi missing at ${piPath}`);
		return;
	}
	try {
		if (!statSync(piPath).isFile()) {
			recordCheck(results, "FAIL", "private runtime marker/version hints", `private runtime pi is not a regular file: ${piPath}`);
			return;
		}
	} catch (error) {
		recordCheck(results, "FAIL", "private runtime marker/version hints", `could not stat private runtime pi (${String(error)})`);
		return;
	}

	const piVersionResult = runCommand(piPath, ["--version"]);
	if (piVersionResult.status !== 0) {
		recordCheck(results, "FAIL", "private runtime marker/version hints", `private runtime pi did not validate (${commandFailureSummary(piVersionResult)})`);
		return;
	}

	const runtimeVersion = String(piVersionResult.stdout || "").trim().replace(/^pi\s+/, "");
	const marker = readRuntimeMarker(markerPath);
	const installHint = readInstallStateHint(agentDir);
	const levels: CheckLevel[] = [marker.level];
	if (expectedPiVersion !== "unknown" && runtimeVersion !== expectedPiVersion) {
		levels.push("WARN");
	}
	const versionDetail = expectedPiVersion === "unknown"
		? `pi ${runtimeVersion}`
		: runtimeVersion === expectedPiVersion
			? `pi ${runtimeVersion}`
			: `pi ${runtimeVersion} (expected ${expectedPiVersion})`;
	recordCheck(results, highestLevel(levels), "private runtime marker/version hints", `${versionDetail}; ${marker.detail}; ${installHint}`);
}

function addGnosisCheck(results: CheckResult[], packageRoot: string, agentDir: string, env: NodeJS.ProcessEnv): void {
	const result = runCommand(process.execPath, [gnosisScript(packageRoot), "validate", "--agent-dir", agentDir], { env });
	if (result.status === 0) {
		recordCheck(results, "OK", "managed gn validation", `validated ${(String(result.stdout || "").trim() || "gn")}`);
		return;
	}
	recordCheck(results, "WARN", "managed gn validation", `no valid gn command found (${commandFailureSummary(result)})`);
}

function parseStatusLine(output: string, label: string): string | undefined {
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith(`${label}:`)) continue;
		return trimmed.slice(label.length + 1).trim();
	}
	return undefined;
}

function addTicketsCheck(results: CheckResult[], packageRoot: string, agentDir: string, settingsPath: string, env: NodeJS.ProcessEnv): void {
	const result = runCommand(process.execPath, [ticketsScript(packageRoot), "status", "--agent-dir", agentDir, "--settings", settingsPath], { env });
	if (result.status !== 0) {
		recordCheck(results, "WARN", "managed tk validation", `could not inspect ticket integration (${commandFailureSummary(result)})`);
		return;
	}
	const output = `${result.stdout || ""}\n${result.stderr || ""}`;
	const active = parseStatusLine(output, "active");
	const command = parseStatusLine(output, "command");
	if (active === "yes" && command && command !== "not found") {
		recordCheck(results, "OK", "managed tk validation", `validated ${command}`);
		return;
	}
	recordCheck(results, "WARN", "managed tk validation", `ticket integration inactive (${command || "not found"})`);
}

function addGhCheck(results: CheckResult[], env: NodeJS.ProcessEnv): void {
	const result = runCommand("gh", ["auth", "status"], { env });
	if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
		recordCheck(results, "WARN", "gh availability/auth", "gh is not installed on PATH");
		return;
	}
	if (result.status === 0) {
		recordCheck(results, "OK", "gh availability/auth", "gh is installed and authenticated");
		return;
	}
	recordCheck(results, "WARN", "gh availability/auth", "gh is installed but not authenticated");
}

function extensionById(defaultExtensions: readonly DefaultExtensionEntry[], id: string): DefaultExtensionEntry | undefined {
	return defaultExtensions.find((entry) => entry.id === id);
}

function settingsPackageIdentities(settings: JsonObject): Set<string> {
	const identities = new Set<string>();
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	for (const entry of packages) {
		const identity = packageIdentity(entry);
		if (identity) identities.add(identity);
	}
	return identities;
}

function extensionEnabled(settings: JsonObject, defaultExtensions: readonly DefaultExtensionEntry[], id: string): boolean {
	return !disabledDefaultExtensionIds(settings, defaultExtensions).has(id);
}

function extensionPresent(settings: JsonObject, extension: DefaultExtensionEntry | undefined): boolean {
	if (!extension) return false;
	const identity = packageIdentity(extension.source);
	if (!identity) return false;
	return settingsPackageIdentities(settings).has(identity);
}

function summarizeMcpConfigs(agentDir: string): McpConfigSummary {
	const candidates = [
		join(agentDir, "mcp.json"),
		join(process.cwd(), ".mcp.json"),
		join(process.cwd(), ".pi", "mcp.json"),
		join(homedir(), ".config", "mcp", "mcp.json"),
	];
	const unique = [...new Set(candidates.map((candidate) => resolve(candidate)))];
	const summary: McpConfigSummary = { validCount: 0, invalidCount: 0, examples: [] };
	for (const candidate of unique) {
		if (!existsSync(candidate)) continue;
		try {
			const parsed = readJsonFile<JsonObject>(candidate);
			if (isPlainObject(parsed.mcpServers)) {
				summary.validCount += 1;
				if (summary.examples.length < MAX_DETAIL_ITEMS) summary.examples.push(candidate);
			} else {
				summary.invalidCount += 1;
			}
		} catch {
			summary.invalidCount += 1;
		}
	}
	return summary;
}

function readWebSearchSettings(agentDir: string): { hasStoredKey: boolean; invalid: boolean } {
	const settingsPath = join(agentDir, "extensions", "pi-web-access", "settings.json");
	if (!existsSync(settingsPath)) return { hasStoredKey: false, invalid: false };
	try {
		const parsed = readJsonFile<JsonObject>(settingsPath);
		return {
			hasStoredKey: typeof parsed.exaApiKey === "string" && parsed.exaApiKey.trim().length > 0,
			invalid: false,
		};
	} catch {
		return { hasStoredKey: false, invalid: true };
	}
}

function addMcpAndWebSearchCheck(results: CheckResult[], packageRoot: string, agentDir: string, settings: JsonObject): void {
	const defaultExtensions = readDefaultExtensions(defaultExtensionsPath(packageRoot), { allowMissing: false });
	const mcporter = extensionById(defaultExtensions, "mcporter");
	const webAccess = extensionById(defaultExtensions, "pi-web-access");
	const mcpEnabled = extensionEnabled(settings, defaultExtensions, "mcporter");
	const webEnabled = extensionEnabled(settings, defaultExtensions, "pi-web-access");
	const mcpPresent = extensionPresent(settings, mcporter);
	const webPresent = extensionPresent(settings, webAccess);
	const webSettings = readWebSearchSettings(agentDir);
	const mcpConfigs = summarizeMcpConfigs(agentDir);
	const hasExaEnvKey = typeof process.env.EXA_API_KEY === "string" && process.env.EXA_API_KEY.trim().length > 0;
	const details: string[] = [];
	const levels: CheckLevel[] = [];

	if (mcpEnabled) {
		if (mcpPresent) {
			details.push("mcporter enabled");
		} else {
			levels.push("WARN");
			details.push("mcporter not installed in isolated settings");
		}
		if (mcpConfigs.validCount > 0) {
			details.push(`MCP config present (${mcpConfigs.validCount})`);
		} else {
			levels.push("WARN");
			details.push("no valid MCP config found");
		}
		if (mcpConfigs.invalidCount > 0) {
			levels.push("WARN");
			details.push(`${mcpConfigs.invalidCount} invalid MCP config file(s)`);
		}
	} else {
		levels.push("WARN");
		details.push("mcporter opted out");
	}

	if (webEnabled) {
		if (webPresent) {
			details.push("pi-web-access enabled");
		} else {
			levels.push("WARN");
			details.push("pi-web-access not installed in isolated settings");
		}
		if (webSettings.invalid) {
			levels.push("WARN");
			details.push("pi-web-access settings are invalid JSON");
		} else if (webSettings.hasStoredKey || hasExaEnvKey) {
			details.push("EXA auth configured");
		} else {
			levels.push("WARN");
			details.push("no explicit EXA key detected (shared fallback only)");
		}
	} else {
		levels.push("WARN");
		details.push("pi-web-access opted out");
	}

	if (levels.length === 0) levels.push("OK");
	recordCheck(results, highestLevel(levels), "MCP/web-search prerequisites", details.join("; "));
}

function printResults(results: CheckResult[]): void {
	for (const result of results) {
		console.log(`${result.level.padEnd(4)} ${result.label}: ${result.detail}`);
	}
	console.log(`Summary: ${summarizeLevels(results)}`);
}

function printRepairActions(actions: RepairAction[]): void {
	console.log("Repair actions:");
	for (const action of actions) {
		console.log(`${action.level.padEnd(4)} ${action.label}: ${action.detail}`);
	}
}

function summarizeCommandOutput(result: CommandResult): string | undefined {
	const lines = `${result.stdout || ""}\n${result.stderr || ""}`
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.at(-1);
}

function repairAction(level: RepairLevel, label: string, detail: string): RepairAction {
	return { level, label, detail };
}

function repairSettings(packageRoot: string, agentDir: string, settingsPath: string, env: NodeJS.ProcessEnv): RepairAction {
	const retiredSubagentPackages = captureManagedRetiredSubagentPackages(settingsPath);
	const result = runCommand(process.execPath, [
		mergeSettingsScript(packageRoot),
		defaultsPath(packageRoot),
		"--settings", settingsPath,
		"--default-extensions", defaultExtensionsPath(packageRoot),
	], { env });
	if (result.status !== 0) {
		return repairAction("FAIL", "settings drift", `could not repair packaged settings drift (${commandFailureSummary(result)})`);
	}
	cleanupManagedRetiredSubagentPackages({ agentDir, dryRun: false, quiet: true }, retiredSubagentPackages);
	const output = summarizeCommandOutput(result);
	if (output === "No settings changes needed.") {
		return repairAction("OK", "settings drift", "packaged defaults already match the isolated profile");
	}
	return repairAction("OK", "settings drift", output || "reapplied packaged defaults with existing backup behavior");
}

function repairBundledSubagentPrompts(packageRoot: string, agentDir: string): RepairAction {
	const packagedDefaultsPath = defaultsPath(packageRoot);
	if (!settingsRequireTlhSubagentPrompts(packagedDefaultsPath)) {
		return repairAction("SKIP", "bundled subagent resources", "packaged defaults do not require copied subagent prompts");
	}
	const sourceDir = join(packageRoot, "agents", "subagents");
	const sourceMissing = missingTlhSubagentPrompts(sourceDir);
	if (sourceMissing.length > 0) {
		return repairAction("FAIL", "bundled subagent resources", `packaged prompts are incomplete; run \`tlh update\` (${summarizeItems(sourceMissing)})`);
	}
	const subagentDir = join(agentDir, "tlh", "agents", "subagents");
	const restoreNeeded = restoreNeededTlhSubagentPrompts(sourceDir, subagentDir);
	if (restoreNeeded.length === 0) {
		return repairAction("OK", "bundled subagent resources", `prompt bundle already current at ${subagentDir}`);
	}
	copyTlhSubagentPrompts({ agentDir }, sourceDir);
	const remainingNeeded = restoreNeededTlhSubagentPrompts(sourceDir, subagentDir);
	if (remainingNeeded.length > 0) {
		return repairAction("FAIL", "bundled subagent resources", `prompt restore incomplete (${summarizeItems(remainingNeeded)})`);
	}
	return repairAction("OK", "bundled subagent resources", `restored ${restoreNeeded.length} prompt(s) from packaged defaults`);
}

function repairManagedHelper(label: string, scriptPath: string, commandArgs: string[], env: NodeJS.ProcessEnv): RepairAction {
	const result = runCommand(process.execPath, [scriptPath, ...commandArgs], { env, timeout: REPAIR_HELPER_TIMEOUT_MS });
	if (result.status !== 0) {
		return repairAction("FAIL", label, `${commandArgs[0]} failed (${commandFailureSummary(result)})`);
	}
	return repairAction("OK", label, summarizeCommandOutput(result) || `${commandArgs[0]} completed`);
}

function collectHealthResults(agentDir: string, packageRoot: string, settingsPath: string, env: NodeJS.ProcessEnv): CheckResult[] {
	const expectedPiVersion = loadExpectedPiVersion(packageRoot);
	const results: CheckResult[] = [];

	let settingsState: SettingsState | undefined;
	const agentDirIsProtected = pathIsInNormalPiConfig(agentDir);
	const settingsPathIsProtected = pathIsInNormalPiConfig(settingsPath);
	if (agentDirIsProtected) {
		addProtectedAgentDirCheck(results, agentDir);
	} else if (settingsPathIsProtected) {
		addUnsafeSettingsPathCheck(results, agentDir, settingsPath);
	} else {
		try {
			settingsState = loadSettings(settingsPath);
			addProfileChecks(results, agentDir, settingsState);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			recordCheck(results, "FAIL", "profile isolation/settings", message);
		}
	}

	if (!agentDirIsProtected && !settingsPathIsProtected && settingsState?.settings) {
		addSettingsDriftCheck(results, packageRoot, settingsPath, env);
		addBundledSubagentCheck(results, packageRoot, agentDir);
		addMcpAndWebSearchCheck(results, packageRoot, agentDir, settingsState.settings);
	}

	if (!agentDirIsProtected) {
		addRuntimeCheck(results, agentDir, expectedPiVersion);
		addGnosisCheck(results, packageRoot, agentDir, env);
		if (!settingsPathIsProtected) {
			addTicketsCheck(results, packageRoot, agentDir, settingsPath, env);
		}
	}
	if (!agentDirIsProtected) {
		addGhCheck(results, env);
	}
	return results;
}

function settingsPathIsWithinAgent(agentDir: string, settingsPath: string): boolean {
	return pathWithinOrEqual(realpathForCompare(agentDir), realpathForCompare(settingsPath));
}

function runRepairMode(agentDir: string, packageRoot: string, settingsPath: string, env: NodeJS.ProcessEnv): number {
	if (pathIsInNormalPiConfig(agentDir)) {
		console.error(`error: refusing repair for normal Pi agent dir inside ~/.pi: ${agentDir}`);
		return 1;
	}
	if (pathIsInNormalPiConfig(settingsPath)) {
		console.error(`error: refusing repair for normal Pi settings path inside ~/.pi: ${settingsPath}`);
		return 1;
	}
	if (!settingsPathIsWithinAgent(agentDir, settingsPath)) {
		console.error(`error: refusing repair for settings path outside isolated TLH profile: ${settingsPath}`);
		return 1;
	}

	const actions: RepairAction[] = [
		repairSettings(packageRoot, agentDir, settingsPath, env),
		repairBundledSubagentPrompts(packageRoot, agentDir),
		repairManagedHelper("managed gn install", gnosisScript(packageRoot), ["configure-install", "--agent-dir", agentDir], env),
		repairManagedHelper("managed tk install", ticketsScript(packageRoot), ["configure-install", "--agent-dir", agentDir, "--settings", settingsPath], env),
		repairAction("WARN", "private runtime", "runtime replacement stays manual; run `tlh update` if runtime drift remains"),
		repairAction("WARN", "user-owned prerequisites", "gh auth, EXA keys, and MCP config remain manual"),
	];
	printRepairActions(actions);
	console.log("");
	const results = collectHealthResults(agentDir, packageRoot, settingsPath, env);
	printResults(results);
	return actions.some((action) => action.level === "FAIL") || results.some((result) => result.level === "FAIL") ? 1 : 0;
}

function main(): number {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(usage());
		return 0;
	}

	const agentDir = resolve(resolveTlhAgentDir(args.agentDir));
	const packageRoot = resolve(expandHomePath(args.packageRoot || DEFAULT_PACKAGE_ROOT) || DEFAULT_PACKAGE_ROOT);
	const settingsPath = resolve(expandHomePath(args.settingsPath || defaultTlhSettingsPath({ agentDir })) || defaultTlhSettingsPath({ agentDir }));
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };

	if (args.repair) {
		return runRepairMode(agentDir, packageRoot, settingsPath, env);
	}

	const results = collectHealthResults(agentDir, packageRoot, settingsPath, env);
	printResults(results);
	return results.some((result) => result.level === "FAIL") ? 1 : 0;
}

try {
	process.exitCode = main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`error: ${message}`);
	process.exitCode = 2;
}
