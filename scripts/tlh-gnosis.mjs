#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import process from "node:process";

const VALIDATION_TIMEOUT_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_GNOSIS_REPO = "skorokithakis/gnosis";

function usage() {
	return `Usage: tlh gnosis <command>

Manage Gnosis integration in the isolated tlh profile.

Commands:
  status               Show integration status and detected gn binary
  enable               Enable Gnosis prompt integration
  disable              Disable Gnosis prompt integration
  state                Print enabled, disabled, or unset (installer internal)
  validate [path]      Validate a gnosis binary, or print the first valid one
  install-managed      Install managed gn binary (installer internal)
  configure-install    Configure installer-time Gnosis integration (installer internal)

Options:
  --settings <path>    Settings file to update (default: ~/.the-last-harness/agent/settings.json, or PI_CODING_AGENT_DIR/settings.json)
  --agent-dir <dir>    Isolated Pi agent dir (default: ~/.the-last-harness/agent, or PI_CODING_AGENT_DIR)
  --install-path <p>   Store this gn binary path when enabling
  --target <path>      Managed gn install target (default: <agent-dir>/bin/gn)
  --gnosis-repo <r>    Gnosis GitHub repo, owner/name (default: skorokithakis/gnosis)
  --gnosis-version <v> Gnosis version to install (default: latest)
  --mode <mode>        Installer Gnosis mode: auto, with, or without
  --wrapper-name <n>   Wrapper command name for user-facing guidance
  --detail             Print verbose/dry-run installer details
  --dry-run            Print intended changes without writing
  --quiet              Only print errors
  -h, --help           Show this help
`;
}

function parseArgs(argv) {
	const args = {
		settingsPath: undefined,
		agentDir: undefined,
		installPath: undefined,
		target: undefined,
		gnosisRepo: process.env.TLH_GNOSIS_REPO || DEFAULT_GNOSIS_REPO,
		gnosisVersion: process.env.TLH_GNOSIS_VERSION || "latest",
		mode: "auto",
		wrapperName: "tlh",
		command: undefined,
		commandArgs: [],
		dryRun: false,
		detail: false,
		quiet: false,
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
			continue;
		}
		if (arg === "--detail") {
			args.detail = true;
			continue;
		}
		if (arg === "--quiet") {
			args.quiet = true;
			continue;
		}
		if (arg === "--settings") {
			args.settingsPath = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--settings=")) {
			args.settingsPath = arg.slice("--settings=".length);
			continue;
		}
		if (arg === "--agent-dir") {
			args.agentDir = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--agent-dir=")) {
			args.agentDir = arg.slice("--agent-dir=".length);
			continue;
		}
		if (arg === "--install-path") {
			args.installPath = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--install-path=")) {
			args.installPath = arg.slice("--install-path=".length);
			continue;
		}
		if (arg === "--target") {
			args.target = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--target=")) {
			args.target = arg.slice("--target=".length);
			continue;
		}
		if (arg === "--gnosis-repo") {
			args.gnosisRepo = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--gnosis-repo=")) {
			args.gnosisRepo = arg.slice("--gnosis-repo=".length);
			continue;
		}
		if (arg === "--gnosis-version") {
			args.gnosisVersion = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--gnosis-version=")) {
			args.gnosisVersion = arg.slice("--gnosis-version=".length);
			continue;
		}
		if (arg === "--mode") {
			args.mode = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--mode=")) {
			args.mode = arg.slice("--mode=".length);
			continue;
		}
		if (arg === "--wrapper-name") {
			args.wrapperName = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--wrapper-name=")) {
			args.wrapperName = arg.slice("--wrapper-name=".length);
			continue;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		}
		if (!args.command) {
			args.command = arg;
		} else {
			args.commandArgs.push(arg);
		}
	}

	return args;
}

function requiredValue(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function getAgentDir(argAgentDir) {
	return expandHome(argAgentDir || process.env.PI_CODING_AGENT_DIR || process.env.TLH_AGENT_DIR || join(homedir(), ".the-last-harness", "agent"));
}

function defaultSettingsPath(agentDir) {
	return join(agentDir, "settings.json");
}

function readJson(path, { missingValue } = {}) {
	if (!existsSync(path)) {
		if (missingValue !== undefined) return missingValue;
		throw new Error(`File does not exist: ${path}`);
	}
	const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}: ${error.message}`);
	}
}

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateSettings(settings) {
	if (!isPlainObject(settings)) {
		throw new Error("Settings must be a JSON object");
	}
	if (settings.tlh !== undefined && !isPlainObject(settings.tlh)) {
		throw new Error("Settings field 'tlh' must be an object if present");
	}
	if (settings.tlh?.gnosis !== undefined && !isPlainObject(settings.tlh.gnosis)) {
		throw new Error("Settings field 'tlh.gnosis' must be an object if present");
	}
}

function ensureMutableSettings(settings) {
	validateSettings(settings);
	settings.tlh ??= {};
	settings.tlh.gnosis ??= {};
}

function loadSettings(settingsPath) {
	const previousRaw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "") : "";
	const settings = readJson(settingsPath, { missingValue: {} });
	validateSettings(settings);
	return { settings, previousRaw };
}

function gnosisState(settings) {
	const enabled = settings.tlh?.gnosis?.enabled;
	if (enabled === true) return "enabled";
	if (enabled === false) return "disabled";
	return "unset";
}

function normalizedInstallPath(path) {
	if (!path) return undefined;
	return resolve(expandHome(path));
}

function configuredInstallPath(settings) {
	const path = settings.tlh?.gnosis?.installPath;
	return typeof path === "string" && path.trim() ? normalizedInstallPath(path.trim()) : undefined;
}

function candidateCommands(settings, agentDir) {
	const candidates = [configuredInstallPath(settings), join(agentDir, "bin", "gn"), "gn"].filter(Boolean);
	const seen = new Set();
	const unique = [];
	for (const candidate of candidates) {
		const key = candidate === "gn" ? candidate : resolve(candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(candidate);
	}
	return unique;
}

function validateGnosisCommand(command) {
	for (const args of [["help", "plan"], ["help", "review"]]) {
		const result = spawnSync(command, args, { stdio: "ignore", timeout: VALIDATION_TIMEOUT_MS });
		if (result.error || result.status !== 0) return false;
	}
	return true;
}

function commandPath(command) {
	const result = spawnSync("sh", ["-c", "command -v -- \"$1\"", "sh", command], { encoding: "utf8" });
	if (result.error || result.status !== 0) return undefined;
	return result.stdout.trim().split(/\r?\n/)[0] || undefined;
}

function normalizeValidCandidate(candidate) {
	if (candidate === "gn") return commandPath("gn") || candidate;
	return candidate;
}

function findValidGnosis(settings, agentDir) {
	for (const candidate of candidateCommands(settings, agentDir)) {
		if (validateGnosisCommand(candidate)) return normalizeValidCandidate(candidate);
	}
	return undefined;
}

function logStderr(args, message) {
	if (!args.quiet) console.error(message);
}

function warnStderr(message) {
	console.error(`warning: ${message}`);
}

function gnosisPlatform() {
	let os;
	if (process.platform === "darwin") os = "darwin";
	else if (process.platform === "linux") os = "linux";
	else return undefined;

	let arch;
	if (process.arch === "arm64") arch = "arm64";
	else if (process.arch === "x64") arch = "amd64";
	else return undefined;

	return { os, arch };
}

async function fetchWithTimeout(url, options = {}) {
	const response = await fetch(url, {
		...options,
		headers: {
			"User-Agent": "tlh-gnosis-installer",
			...(options.headers || {}),
		},
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}`);
	}
	return response;
}

async function resolveGnosisVersion(args) {
	if (args.gnosisVersion && args.gnosisVersion !== "latest") {
		return args.gnosisVersion.replace(/^v/, "");
	}

	const response = await fetchWithTimeout(`https://github.com/${args.gnosisRepo}/releases/latest`, { method: "HEAD", redirect: "follow" });
	const latestUrl = response.url || "";
	const version = latestUrl.split("/").pop()?.replace(/^v/, "");
	if (!version || version === "latest") {
		throw new Error("latest release redirect did not include a version");
	}
	return version;
}

async function downloadToFile(url, path) {
	const response = await fetchWithTimeout(url);
	const content = Buffer.from(await response.arrayBuffer());
	writeFileSync(path, content);
}

async function fetchText(url) {
	const response = await fetchWithTimeout(url);
	return response.text();
}

function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

function checksumForAsset(checksumsText, assetName) {
	for (const line of checksumsText.split(/\r?\n/)) {
		const [checksum, filename] = line.trim().split(/\s+/);
		if (!checksum || !filename) continue;
		if (filename.replace(/^\.\//, "") === assetName) return checksum;
	}
	return undefined;
}

async function verifyGnosisArchive(args, archivePath, assetName, version) {
	const checksumsUrl = `https://github.com/${args.gnosisRepo}/releases/download/v${version}/checksums.txt`;
	const checksumsText = await fetchText(checksumsUrl);
	const expected = checksumForAsset(checksumsText, assetName);
	if (!expected) {
		throw new Error(`Gnosis checksums did not include ${assetName}`);
	}
	const actual = sha256File(archivePath);
	if (actual !== expected) {
		throw new Error(`Gnosis checksum verification failed for ${assetName}`);
	}
}

function extractTarGzip(archivePath, extractDir) {
	const result = spawnSync("tar", ["-xzf", archivePath, "-C", extractDir], { stdio: "ignore" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error("failed to extract Gnosis release archive");
}

function findFileNamed(root, name) {
	for (const entry of readdirSync(root)) {
		const path = join(root, entry);
		const stats = statSync(path);
		if (stats.isDirectory()) {
			const found = findFileNamed(path, name);
			if (found) return found;
		} else if (stats.isFile() && entry === name) {
			return path;
		}
	}
	return undefined;
}

async function installManagedGnosis(args, agentDir) {
	const target = resolve(expandHome(args.target || join(agentDir, "bin", "gn")));
	assertNotNormalPiPath(agentDir, "agent dir");
	assertNotNormalPiPath(target, "managed gn target");
	const platform = gnosisPlatform();
	if (!platform) {
		warnStderr(`Gnosis prebuilt binary is not available for this platform; install manually from https://github.com/${args.gnosisRepo}`);
		return undefined;
	}

	if (args.dryRun) {
		logStderr(args, `Would install Gnosis into isolated profile: ${target}`);
		logStderr(args, `Would download latest compatible release from https://github.com/${args.gnosisRepo}`);
		return target;
	}

	let version;
	try {
		version = await resolveGnosisVersion(args);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warnStderr(`could not resolve latest Gnosis release; install manually from https://github.com/${args.gnosisRepo} (${message})`);
		return undefined;
	}

	const assetName = `gnosis_${version}_${platform.os}_${platform.arch}.tar.gz`;
	const url = `https://github.com/${args.gnosisRepo}/releases/download/v${version}/${assetName}`;
	let tempDir;
	let tempTarget;

	try {
		tempDir = mkdtempSync(join(tmpdir(), "tlh-gnosis-"));
		const archivePath = join(tempDir, "gnosis.tar.gz");
		const extractDir = join(tempDir, "extract");
		mkdirSync(extractDir, { recursive: true });

		logStderr(args, `Installing Gnosis ${version} into isolated profile: ${target}`);
		await downloadToFile(url, archivePath);
		await verifyGnosisArchive(args, archivePath, assetName, version);
		extractTarGzip(archivePath, extractDir);

		const extracted = findFileNamed(extractDir, "gn");
		if (!extracted) throw new Error("Gnosis release archive did not contain a gn binary");

		mkdirSync(dirname(target), { recursive: true });
		tempTarget = `${target}.tmp.${process.pid}`;
		copyFileSync(extracted, tempTarget);
		chmodSync(tempTarget, 0o755);
		if (!validateGnosisCommand(tempTarget)) {
			rmSync(tempTarget, { force: true });
			throw new Error("downloaded Gnosis binary did not validate");
		}
		renameSync(tempTarget, target);
		return target;
	} catch (error) {
		if (tempTarget) rmSync(tempTarget, { force: true });
		const message = error instanceof Error ? error.message : String(error);
		warnStderr(message);
		return undefined;
	} finally {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	}
}

async function commandInstallManaged(args, agentDir) {
	const installedPath = await installManagedGnosis(args, agentDir);
	if (!installedPath) {
		process.exitCode = 1;
		return;
	}
	console.log(installedPath);
}

function backupPathFor(settingsPath) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${settingsPath}.backup-tlh-gnosis-${stamp}`;
}

function realpathForCompare(path) {
	const resolved = resolve(path);
	if (existsSync(resolved)) return realpathSync(resolved);
	const parent = dirname(resolved);
	if (parent === resolved) return resolved;
	return join(realpathForCompare(parent), basename(resolved));
}

function isUnderNormalPiConfig(path) {
	const normalPiRoot = realpathForCompare(join(homedir(), ".pi"));
	const resolvedPath = realpathForCompare(path);
	return resolvedPath === normalPiRoot || resolvedPath.startsWith(`${normalPiRoot}${sep}`);
}

function assertNotNormalPiSettings(settingsPath) {
	if (isUnderNormalPiConfig(settingsPath)) {
		throw new Error(`Refusing to modify normal Pi config from The Last Harness gnosis command: ${settingsPath}`);
	}
}

function assertNotNormalPiPath(path, label) {
	if (isUnderNormalPiConfig(path)) {
		throw new Error(`Refusing to modify normal Pi config from The Last Harness gnosis command (${label}): ${path}`);
	}
}

function writeSettings(settingsPath, value, previousRaw, { dryRun }) {
	const formatted = `${JSON.stringify(value, null, 2)}\n`;
	if (formatted === previousRaw) return "unchanged";
	if (dryRun) return "dry-run";

	mkdirSync(dirname(settingsPath), { recursive: true });
	let backupPath;
	if (existsSync(settingsPath)) {
		backupPath = backupPathFor(settingsPath);
		copyFileSync(settingsPath, backupPath);
	}

	const tempPath = `${settingsPath}.tmp-${process.pid}`;
	writeFileSync(tempPath, formatted, "utf8");
	renameSync(tempPath, settingsPath);
	return backupPath || "written";
}

function log(args, message) {
	if (!args.quiet) console.log(message);
}

function detailLog(args, message) {
	if (!args.quiet && args.detail) console.error(message);
}

function logWriteResult(args, writeResult) {
	if (!args.detail) return;
	if (writeResult && !["dry-run", "unchanged", "written"].includes(writeResult)) {
		detailLog(args, `Backed up previous settings to: ${writeResult}`);
	}
	if (writeResult === "unchanged") detailLog(args, "No settings changes were needed.");
}

function setGnosisEnabled(args, settingsPath, settings, previousRaw, installPath) {
	assertNotNormalPiSettings(settingsPath);
	ensureMutableSettings(settings);
	settings.tlh.gnosis.enabled = true;
	const normalized = normalizedInstallPath(installPath);
	if (normalized) settings.tlh.gnosis.installPath = normalized;
	const writeResult = writeSettings(settingsPath, settings, previousRaw, { dryRun: args.dryRun });
	detailLog(args, `${args.dryRun ? "Would enable" : "Enabled"} Gnosis integration for the tlh profile.`);
	logWriteResult(args, writeResult);
}

function setGnosisDisabled(args, settingsPath, settings, previousRaw) {
	assertNotNormalPiSettings(settingsPath);
	ensureMutableSettings(settings);
	settings.tlh.gnosis.enabled = false;
	const writeResult = writeSettings(settingsPath, settings, previousRaw, { dryRun: args.dryRun });
	detailLog(args, `${args.dryRun ? "Would disable" : "Disabled"} Gnosis integration for the tlh profile.`);
	logWriteResult(args, writeResult);
}

async function commandConfigureInstall(args, settingsPath, settings, previousRaw, agentDir) {
	if (!["auto", "with", "without"].includes(args.mode)) {
		throw new Error("--mode must be one of: auto, with, without");
	}
	assertNotNormalPiSettings(settingsPath);

	const currentState = gnosisState(settings);
	let requested = args.mode;

	if (requested === "without") {
		detailLog(args, "Disabling Gnosis integration for tlh.");
		setGnosisDisabled(args, settingsPath, settings, previousRaw);
		console.log("Gnosis integration: disabled");
		return;
	}

	if (requested === "auto") {
		if (currentState === "disabled") {
			detailLog(args, "Keeping existing Gnosis opt-out.");
			console.log("Gnosis integration: disabled");
			return;
		}

		if (currentState === "enabled") {
			detailLog(args, "Keeping existing Gnosis integration setting: enabled.");
			const validPath = findValidGnosis(settings, agentDir);
			if (validPath) {
				console.log(`Gnosis integration: enabled (${validPath})`);
				return;
			}

			warnStderr("Gnosis integration is enabled, but no valid gn binary was found. Attempting to install it.");
			const managedPath = await installManagedGnosis(args, agentDir);
			if (managedPath) {
				setGnosisEnabled(args, settingsPath, settings, previousRaw, managedPath);
				console.log(`Gnosis integration: enabled (${managedPath})`);
				return;
			}

			warnStderr(`Gnosis integration remains enabled, but Gnosis could not be installed automatically. Install Gnosis manually and run: ${args.wrapperName} gnosis enable`);
			console.log("Gnosis integration: enabled, but no valid gn binary was found");
			return;
		}

		detailLog(args, "Installing and enabling Gnosis integration by default.");
		requested = "with";
	}

	if (requested !== "with") return;

	const validPath = findValidGnosis(settings, agentDir);
	if (validPath) {
		detailLog(args, `Found valid Gnosis binary: ${validPath}`);
		setGnosisEnabled(args, settingsPath, settings, previousRaw, validPath);
		console.log(`Gnosis integration: enabled (${validPath})`);
		return;
	}

	const managedPath = await installManagedGnosis(args, agentDir);
	if (managedPath) {
		setGnosisEnabled(args, settingsPath, settings, previousRaw, managedPath);
		console.log(`Gnosis integration: enabled (${managedPath})`);
		return;
	}

	warnStderr("Gnosis integration could not be installed automatically.");
	warnStderr(`Leaving Gnosis integration unchanged; install Gnosis manually and run: ${args.wrapperName} gnosis enable`);
	console.log("Gnosis integration: not enabled (gn was not installed)");
}

function commandStatus(args, settings, agentDir) {
	const state = gnosisState(settings);
	const valid = findValidGnosis(settings, agentDir);
	const active = state === "enabled" && Boolean(valid);
	console.log("Gnosis integration for tlh:");
	console.log(`  setting: ${state}`);
	console.log(`  active: ${active ? "yes" : "no"}`);
	console.log(`  binary: ${valid || "not found"}`);
	if (state === "enabled" && !valid) {
		console.log("  note: integration is enabled, but no valid Gnosis `gn` binary was found.");
	}
	if (state !== "enabled" && valid) {
		console.log("  note: a valid `gn` binary exists; run `tlh gnosis enable` to enable prompt integration.");
	}
}

function commandState(settings) {
	console.log(gnosisState(settings));
}

function commandValidate(settings, agentDir, commandArgs) {
	const candidate = commandArgs[0];
	if (candidate) {
		if (!validateGnosisCommand(candidate)) {
			process.exitCode = 1;
			return;
		}
		console.log(candidate);
		return;
	}

	const valid = findValidGnosis(settings, agentDir);
	if (!valid) {
		process.exitCode = 1;
		return;
	}
	console.log(valid);
}

function commandEnable(args, settingsPath, settings, previousRaw) {
	assertNotNormalPiSettings(settingsPath);
	ensureMutableSettings(settings);
	settings.tlh.gnosis.enabled = true;
	const installPath = normalizedInstallPath(args.installPath || args.commandArgs[0]);
	if (installPath) settings.tlh.gnosis.installPath = installPath;
	const writeResult = writeSettings(settingsPath, settings, previousRaw, { dryRun: args.dryRun });
	log(args, `${args.dryRun ? "Would enable" : "Enabled"} Gnosis integration for the tlh profile.`);
	if (writeResult && !["dry-run", "unchanged", "written"].includes(writeResult)) log(args, `Backed up previous settings to: ${writeResult}`);
	if (writeResult === "unchanged") log(args, "No settings changes were needed.");
}

function commandDisable(args, settingsPath, settings, previousRaw) {
	assertNotNormalPiSettings(settingsPath);
	ensureMutableSettings(settings);
	settings.tlh.gnosis.enabled = false;
	const writeResult = writeSettings(settingsPath, settings, previousRaw, { dryRun: args.dryRun });
	log(args, `${args.dryRun ? "Would disable" : "Disabled"} Gnosis integration for the tlh profile.`);
	if (writeResult && !["dry-run", "unchanged", "written"].includes(writeResult)) log(args, `Backed up previous settings to: ${writeResult}`);
	if (writeResult === "unchanged") log(args, "No settings changes were needed.");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.command) {
		console.log(usage());
		return;
	}

	const agentDir = resolve(getAgentDir(args.agentDir));
	const settingsPath = resolve(expandHome(args.settingsPath || defaultSettingsPath(agentDir)));
	const { settings, previousRaw } = loadSettings(settingsPath);

	if (args.command === "status") {
		commandStatus(args, settings, agentDir);
		return;
	}
	if (args.command === "state") {
		commandState(settings);
		return;
	}
	if (args.command === "validate") {
		commandValidate(settings, agentDir, args.commandArgs);
		return;
	}
	if (args.command === "install-managed") {
		await commandInstallManaged(args, agentDir);
		return;
	}
	if (args.command === "configure-install") {
		await commandConfigureInstall(args, settingsPath, settings, previousRaw, agentDir);
		return;
	}
	if (args.command === "enable") {
		commandEnable(args, settingsPath, settings, previousRaw);
		return;
	}
	if (args.command === "disable") {
		commandDisable(args, settingsPath, settings, previousRaw);
		return;
	}

	throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`tlh gnosis: ${message}`);
	process.exit(1);
});
