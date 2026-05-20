#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	criticalGitSourceSpec,
	gitSourceInstallSource,
	packageSourceInstallDir,
} from "./lib/tlh-install-package-source.mjs";
import {
	assertSafeSettingsTarget,
	copySafeProfileFile,
	ensureSafeProfileDir,
	isSymlink,
	validateInstallerTargets,
} from "./lib/tlh-install-paths.mjs";
import {
	TLH_SUBAGENT_PROMPTS,
	copyTlhSubagentPrompts,
	defaultExtensionsRequireCriticalInstall as defaultExtensionsFileRequiresCriticalInstall,
	findTlhSubagentsDir as findTlhSubagentsDirFromSources,
	missingTlhSubagentPrompts,
	settingsRequireTlhSubagentPrompts as settingsFileRequiresTlhSubagentPrompts,
} from "./lib/tlh-install-subagents.mjs";
import {
	assertGitSourceTargetSafe,
	refreshGitCheckout,
} from "./lib/tlh-install-git.mjs";
import {
	findLocalRepoDir,
	ensureSupportFilesPrepared,
	installableSupportFilesArePrepared,
	preflightRuntimeSupportFiles,
} from "./lib/tlh-install-support-files.mjs";
import {
	formatSupportFileManifest,
	installableSupportFiles,
	supportFileManifest,
} from "./lib/tlh-install-support-manifest.mjs";

const DEFAULT_REPO = "diegopetrucci/the-last-harness";
const DEFAULT_REF = "main";
// Keep in sync with TLH_MIN_NODE_VERSION in install.sh.
const MIN_NODE_VERSION = "22.19.0";
const MIN_PI_VERSION = "0.75.3";
const DEFAULT_GNOSIS_REPO = "skorokithakis/gnosis";
const DEFAULT_GNOSIS_VERSION = "latest";
const DEFAULT_WRAPPER_NAME = "tlh";
const VALID_UPDATE_TRACKS = new Set(["latest-release", "pinned-tag", "ref", "custom"]);
const COMMAND_MAX_BUFFER = 20 * 1024 * 1024;

function parseNodeVersion(version) {
	const match = String(version).trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) return null;
	return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function nodeVersionMeetsMinimum(currentVersion, minimumVersion = MIN_NODE_VERSION) {
	const current = parseNodeVersion(currentVersion);
	const minimum = parseNodeVersion(minimumVersion);
	if (!current || !minimum) return false;
	for (let index = 0; index < minimum.length; index += 1) {
		if (current[index] > minimum[index]) return true;
		if (current[index] < minimum[index]) return false;
	}
	return true;
}

function formatNodeVersion(version) {
	const text = String(version || "").trim();
	if (!text) return "unknown";
	return text.startsWith("v") ? text : `v${text}`;
}

function assertSupportedNodeRuntime(currentVersion = process.versions.node) {
	if (!parseNodeVersion(currentVersion)) {
		throw new Error(`unable to determine Node.js version; The Last Harness requires Node.js >= ${MIN_NODE_VERSION}.`);
	}
	if (!nodeVersionMeetsMinimum(currentVersion)) {
		throw new Error(`Node.js >= ${MIN_NODE_VERSION} is required (found ${formatNodeVersion(currentVersion)}). Install or upgrade Node.js, then rerun the installer.`);
	}
}

function usage() {
	return `Usage: tlh-install.mjs [options]

Stage-1 The Last Harness installer helper. It runs the normal install flow using
an isolated Pi profile and installer-owned helper commands.

Options:
  --dry-run                  Print actions and settings/keybinding changes without writing
  --force                    Allow scalar isolated defaults and installer wrapper overwrite
  --no-pi-install            Fail instead of installing Pi when the \`pi\` command is missing
  --no-settings              Install the package but skip isolated settings/keybinding merge
  --no-wrapper               Skip creating the tlh wrapper command
  --agent-dir DIR            Isolated Pi agent dir (default: ~/.the-last-harness/agent)
  --bin-dir DIR              Wrapper install dir (default: ~/.local/bin)
  --wrapper-name N           Wrapper command name (default: tlh)
  --ref REF                  Install The Last Harness from a branch, tag, or commit
  --track TRACK              Update track for future tlh update: latest-release, pinned-tag, ref, custom
  --quiet                    Suppress installer progress output
  --verbose                  Show underlying pi, npm, and git output
  --print-support-manifest   Print pipe-delimited bootstrap support-file manifest and exit
  -h, --help                 Show this help

Environment overrides:
  TLH_AGENT_DIR        Isolated Pi agent dir
  TLH_BIN_DIR          Wrapper install dir
  TLH_WRAPPER_NAME     Wrapper command name
  TLH_REPO             GitHub repo, owner/name (default: diegopetrucci/the-last-harness)
  TLH_REF              Raw-file ref and package ref (default: main in source; release assets pin this to their tag)
  TLH_UPDATE_TRACK     Update track for future tlh update
  TLH_PACKAGE_SOURCE   Package source passed to \`pi install\`
  TLH_RAW_BASE         Base URL for installer support files
  TLH_GNOSIS_VERSION   Gnosis version to install (default: latest)
  TLH_GNOSIS_REPO      Gnosis GitHub repo, owner/name (default: skorokithakis/gnosis)
`;
}

function expandPath(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function defaultAgentDir(env = process.env) {
	return env.TLH_AGENT_DIR || join(homedir(), ".the-last-harness", "agent");
}

function defaultBinDir(env = process.env) {
	return env.TLH_BIN_DIR || join(homedir(), ".local", "bin");
}

function requiredValue(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function assignEqualsValue(target, key, value, flag) {
	if (!value) throw new Error(`${flag} requires a value`);
	target[key] = value;
}

function parseArgs(argv, env = process.env) {
	const args = {
		repo: env.TLH_REPO || DEFAULT_REPO,
		ref: env.TLH_REF || DEFAULT_REF,
		dryRun: false,
		force: false,
		noPiInstall: false,
		noSettings: false,
		noWrapper: false,
		quiet: false,
		verbose: false,
		gnosisRepo: env.TLH_GNOSIS_REPO || DEFAULT_GNOSIS_REPO,
		gnosisVersion: env.TLH_GNOSIS_VERSION || DEFAULT_GNOSIS_VERSION,
		packageSourceInput: env.TLH_PACKAGE_SOURCE || "",
		updateTrackInput: env.TLH_UPDATE_TRACK || "",
		rawBaseInput: env.TLH_RAW_BASE || "",
		agentDirInput: defaultAgentDir(env),
		binDirInput: defaultBinDir(env),
		wrapperName: env.TLH_WRAPPER_NAME || DEFAULT_WRAPPER_NAME,
		printSupportManifest: false,
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
		if (arg === "--force") {
			args.force = true;
			continue;
		}
		if (arg === "--no-pi-install") {
			args.noPiInstall = true;
			continue;
		}
		if (arg === "--no-settings") {
			args.noSettings = true;
			continue;
		}
		if (arg === "--no-wrapper") {
			args.noWrapper = true;
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
		if (arg === "--print-support-manifest") {
			args.printSupportManifest = true;
			continue;
		}
		if (arg === "--agent-dir") {
			args.agentDirInput = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg === "--bin-dir") {
			args.binDirInput = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg === "--wrapper-name") {
			args.wrapperName = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg === "--ref") {
			args.ref = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg === "--track") {
			args.updateTrackInput = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--agent-dir=")) {
			assignEqualsValue(args, "agentDirInput", arg.slice("--agent-dir=".length), "--agent-dir");
			continue;
		}
		if (arg.startsWith("--bin-dir=")) {
			assignEqualsValue(args, "binDirInput", arg.slice("--bin-dir=".length), "--bin-dir");
			continue;
		}
		if (arg.startsWith("--wrapper-name=")) {
			assignEqualsValue(args, "wrapperName", arg.slice("--wrapper-name=".length), "--wrapper-name");
			continue;
		}
		if (arg.startsWith("--ref=")) {
			assignEqualsValue(args, "ref", arg.slice("--ref=".length), "--ref");
			continue;
		}
		if (arg.startsWith("--track=")) {
			assignEqualsValue(args, "updateTrackInput", arg.slice("--track=".length), "--track");
			continue;
		}
		throw new Error(`unknown option: ${arg}`);
	}

	return args;
}

function isSemverTag(ref) {
	return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(ref);
}

function buildInstallConfig(parsedArgs, env = process.env) {
	const agentDir = resolve(expandPath(parsedArgs.agentDirInput));
	const binDir = resolve(expandPath(parsedArgs.binDirInput));
	const wrapperPath = join(binDir, parsedArgs.wrapperName);
	let packageSource = parsedArgs.packageSourceInput;
	let packageSourceIsDefault = false;
	if (!packageSource) {
		packageSource = `git:github.com/${parsedArgs.repo}@${parsedArgs.ref}`;
		packageSourceIsDefault = true;
	}

	let updateTrack = parsedArgs.updateTrackInput;
	if (!updateTrack) {
		if (!packageSourceIsDefault) updateTrack = "custom";
		else if (isSemverTag(parsedArgs.ref)) updateTrack = "pinned-tag";
		else updateTrack = "ref";
	}

	const scriptPath = fileURLToPath(import.meta.url);
	const scriptDir = dirname(scriptPath);
	const supportFiles = supportFileManifest({ noSettings: parsedArgs.noSettings });
	const defaultPackageRoot = join(agentDir, "git", "github.com", parsedArgs.repo);
	const packageRoot = packageSourceInstallDir(packageSource, {
		agentDir,
		homeDir: env.HOME || homedir(),
	}) || defaultPackageRoot;

	return {
		...parsedArgs,
		env,
		agentDir,
		binDir,
		settingsPath: join(agentDir, "settings.json"),
		keybindingsPath: join(agentDir, "keybindings.json"),
		supportDir: join(agentDir, "tlh"),
		statePath: join(agentDir, "tlh", "install-state.json"),
		wrapperPath,
		packageRoot,
		packageSource,
		packageSourceIsDefault,
		rawBase: parsedArgs.rawBaseInput || `https://raw.githubusercontent.com/${parsedArgs.repo}/${parsedArgs.ref}`,
		updateTrack,
		subagentPrompts: [...TLH_SUBAGENT_PROMPTS],
		supportFiles,
		supportFilePaths: Object.fromEntries(supportFiles.map((file) => [file.variable, ""])),
		scriptPath,
		scriptDir,
		localRepoCandidate: resolve(scriptDir, ".."),
		tmpDir: "",
		supportFilesDryRunSkipped: false,
		gnosisSummary: "",
	};
}

function validateInputs(config) {
	validateInstallerTargets(config, { validUpdateTracks: VALID_UPDATE_TRACKS });
}

function log(config, message = "") {
	if (!config.quiet) console.log(message);
}

function verboseLog(config, message) {
	if (config.verbose && !config.quiet) console.log(message);
}

function detailLog(config, message) {
	if (!config.quiet && (config.verbose || config.dryRun)) console.log(message);
}

function warn(message) {
	console.error(`warning: ${message}`);
}

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellWord(value) {
	const text = String(value);
	if (/^[A-Za-z0-9_/:.,@%+=-]+$/.test(text)) return text;
	return shellQuote(text);
}

function printCommand(commandArgs) {
	console.log(`+ ${commandArgs.map(shellWord).join(" ")} `);
}

function commandDisplay(commandArgs) {
	return commandArgs.map(shellWord).join(" ");
}

function tailLines(text, count) {
	return text.split(/\r?\n/).slice(-count).join("\n");
}

function printCommandFailure({ status, output, displayArgs, cwd }) {
	const cwdText = cwd ? `, cwd ${cwd}` : "";
	console.error(`command failed (exit ${status}${cwdText}): ${commandDisplay(displayArgs)}`);
	if (output.trim()) {
		console.error("---- output (last 80 lines) ----");
		console.error(tailLines(output.trimEnd(), 80));
		console.error("---- end output ----");
	}
	console.error("Re-run the installer with --verbose to show full command output.");
}

function quietCommandEnv(config, extraEnv = {}) {
	return {
		...config.env,
		GIT_TERMINAL_PROMPT: "0",
		NPM_CONFIG_AUDIT: "false",
		NPM_CONFIG_FUND: "false",
		NPM_CONFIG_LOGLEVEL: "error",
		...extraEnv,
	};
}

function inheritedCommandEnv(config, extraEnv = {}) {
	return { ...config.env, ...extraEnv };
}

function runCommand(config, commandArgs, { cwd, env = {}, displayArgs = commandArgs } = {}) {
	if (config.dryRun) {
		if (cwd) {
			printCommand(["bash", "-c", `cd ${shellWord(cwd)} && ${commandDisplay(displayArgs)}`]);
		} else {
			printCommand(displayArgs);
		}
		return;
	}

	const [command, ...args] = commandArgs;
	const result = spawnSync(command, args, {
		cwd,
		env: config.verbose ? inheritedCommandEnv(config, env) : quietCommandEnv(config, env),
		encoding: "utf8",
		maxBuffer: COMMAND_MAX_BUFFER,
		stdio: config.verbose ? "inherit" : ["ignore", "pipe", "pipe"],
	});
	if (result.error || result.status !== 0) {
		const status = result.status ?? result.signal ?? result.error?.code ?? 1;
		const output = config.verbose ? (result.error?.message ?? "") : `${result.stdout || ""}${result.stderr || ""}`;
		printCommandFailure({ status, output, displayArgs, cwd });
		throw new Error(`command failed: ${commandDisplay(displayArgs)}`);
	}
}

function runInDir(config, dir, commandArgs) {
	runCommand(config, commandArgs, { cwd: dir });
}

function commandExists(config, command) {
	const result = spawnSync("sh", ["-c", "command -v -- \"$1\"", "sh", command], {
		env: inheritedCommandEnv(config),
		stdio: "ignore",
	});
	return !result.error && result.status === 0;
}

function requireCommand(config, command) {
	if (!commandExists(config, command)) throw new Error(`required command not found: ${command}`);
}

function spawnCapture(config, commandArgs, { cwd, env = {}, allowFailure = false } = {}) {
	const [command, ...args] = commandArgs;
	const result = spawnSync(command, args, {
		cwd,
		env: inheritedCommandEnv(config, env),
		encoding: "utf8",
		maxBuffer: COMMAND_MAX_BUFFER,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (!allowFailure && (result.error || result.status !== 0)) {
		const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
		throw new Error(output || result.error?.message || `command failed: ${commandDisplay(commandArgs)}`);
	}
	return result;
}

function runNodeScript(config, scriptPath, args, { captureStdout = false } = {}) {
	const commandArgs = [process.execPath, scriptPath, ...args];
	const result = spawnSync(process.execPath, [scriptPath, ...args], {
		env: inheritedCommandEnv(config, { PI_CODING_AGENT_DIR: config.agentDir }),
		encoding: "utf8",
		maxBuffer: COMMAND_MAX_BUFFER,
		stdio: captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
	});
	if (result.error || result.status !== 0) {
		const status = result.status ?? result.signal ?? result.error?.code ?? 1;
		throw new Error(`command failed (exit ${status}): ${commandDisplay(commandArgs)}`);
	}
	return captureStdout ? result.stdout : "";
}

function runIsolatedPi(config, commandArgs) {
	const displayArgs = ["env", `PI_CODING_AGENT_DIR=${config.agentDir}`, ...commandArgs];
	if (!config.dryRun) assertSafeSettingsTarget(config);
	runCommand(config, commandArgs, {
		cwd: config.agentDir,
		env: { PI_CODING_AGENT_DIR: config.agentDir },
		displayArgs,
	});
}

function supportFileIo() {
	return { log, verboseLog, warn, requireCommand };
}

function gitCheckoutIo() {
	return { spawnCapture, runCommand, runInDir, printCommand, log, warn };
}

function assertSupportedPiVersion(config) {
	// `pi --version` prints a bare semver (e.g. "0.75.3") on stdout. Older builds may
	// differ, so we extract the first semver-shaped substring rather than match strictly.
	const result = spawnCapture(config, ["pi", "--version"], { allowFailure: true });
	if (result.error || result.status !== 0) {
		warn(`unable to determine Pi version (pi --version exited with ${result.status ?? result.error?.code ?? "error"}); continuing without version check`);
		return;
	}
	const output = `${result.stdout || ""}${result.stderr || ""}`;
	const match = output.match(/\d+\.\d+\.\d+/);
	if (!match) {
		warn(`unable to parse Pi version from output: ${output.trim() || "<empty>"}; continuing without version check`);
		return;
	}
	const currentVersion = match[0];
	if (!nodeVersionMeetsMinimum(currentVersion, MIN_PI_VERSION)) {
		throw new Error(`Pi >= ${MIN_PI_VERSION} is required (found ${currentVersion}). Upgrade with: npm install -g @earendil-works/pi-coding-agent`);
	}
	verboseLog(config, `Pi version: ${currentVersion}`);
}

function installPiIfNeeded(config) {
	if (commandExists(config, "pi")) {
		const result = spawnCapture(config, ["sh", "-c", "command -v -- pi"], { allowFailure: true });
		verboseLog(config, `Pi is already installed: ${(result.stdout || "pi").trim() || "pi"}`);
		assertSupportedPiVersion(config);
		return;
	}
	if (config.noPiInstall) {
		throw new Error("pi is not installed and --no-pi-install was provided");
	}

	log(config, "Installing Pi runtime...");
	runCommand(config, ["npm", "install", "-g", "@earendil-works/pi-coding-agent"]);
	if (!config.dryRun && !commandExists(config, "pi")) {
		throw new Error("Pi install completed, but the pi command is still not on PATH");
	}
}

function backupExistingSettingsBeforePiInstall(config) {
	assertSafeSettingsTarget(config);
	if (!existsSync(config.settingsPath)) return;
	const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
	const backupPath = `${config.settingsPath}.backup-before-install-${stamp}`;
	if (config.dryRun) {
		log(config, `Would back up existing isolated settings to: ${backupPath}`);
		return;
	}
	if (existsSync(backupPath) || isSymlink(backupPath)) {
		throw new Error(`refusing to overwrite existing settings backup: ${backupPath}`);
	}
	copyFileSync(config.settingsPath, backupPath);
	detailLog(config, `Backed up existing isolated settings to: ${backupPath}`);
}

function refreshHarnessPackageCheckout(config) {
	let packageRoot = config.packageRoot;
	let packageRepo = "";
	let packageRef = config.ref;
	const packageSpec = criticalGitSourceSpec(config.packageSource, { agentDir: config.agentDir });
	if (packageSpec) {
		packageRoot = packageSpec.targetDir;
		packageRepo = packageSpec.repo;
		packageRef = packageSpec.ref;
	}
	if (config.packageSourceIsDefault) {
		packageRef = packageRef || config.ref;
	} else if (!packageSpec || !packageRef) {
		return;
	}

	verboseLog(config, `Checking out The Last Harness git ref: ${packageRef}`);
	refreshGitCheckout(config, {
		targetDir: packageRoot,
		repo: packageRepo,
		ref: packageRef,
		label: "The Last Harness package checkout",
		missingMessage: `expected installed package checkout not found or invalid: ${packageRoot}`,
	}, gitCheckoutIo());
}

function installHarnessPackage(config) {
	verboseLog(config, `Using isolated Pi agent dir: ${config.agentDir}`);
	if (config.dryRun) printCommand(["mkdir", "-p", config.agentDir]);
	else mkdirSync(config.agentDir, { recursive: true });
	backupExistingSettingsBeforePiInstall(config);

	log(config, "Installing The Last Harness package...");
	verboseLog(config, `Package source: ${config.packageSource}`);
	const installSource = gitSourceInstallSource(config.packageSource, { agentDir: config.agentDir });
	assertGitSourceTargetSafe(config, config.packageSource, "The Last Harness package checkout", gitCheckoutIo());
	runIsolatedPi(config, ["pi", "install", installSource]);
	refreshHarnessPackageCheckout(config);

	if (config.packageSourceIsDefault) return;

	const packageSpec = criticalGitSourceSpec(config.packageSource, { agentDir: config.agentDir });
	if (packageSpec?.ref) {
		verboseLog(config, "Pinned custom git package source was refreshed directly; skipping pi update.");
		return;
	}
	if (config.dryRun) {
		log(config, `Would refresh custom package source if it is already installed: PI_CODING_AGENT_DIR=${config.agentDir} pi update ${config.packageSource}`);
		return;
	}
	runIsolatedPi(config, ["pi", "update", config.packageSource]);
}

async function mergeSettings(config) {
	if (config.noSettings) {
		log(config, "Skipping settings/keybinding merge (--no-settings).");
		return;
	}
	if (!(await ensureSupportFilesPrepared(config, supportFileIo()))) return;

	const args = [
		config.supportFilePaths.MERGE_SCRIPT,
		config.supportFilePaths.DEFAULTS_FILE,
		"--settings",
		config.settingsPath,
		"--package-source",
		config.packageSource,
	];
	if (config.supportFilePaths.DEFAULT_EXTENSIONS_FILE) {
		args.push("--default-extensions", config.supportFilePaths.DEFAULT_EXTENSIONS_FILE);
	}
	if (config.dryRun) args.push("--dry-run");
	if (config.force) args.push("--force");
	if (config.quiet || (!config.verbose && !config.dryRun)) args.push("--quiet");

	log(config, "Applying isolated settings...");
	verboseLog(config, `Settings path: ${config.settingsPath}`);
	runNodeScript(config, args[0], args.slice(1));

	if (!config.supportFilePaths.KEYBINDINGS_MERGE_SCRIPT || !config.supportFilePaths.KEYBINDINGS_DEFAULTS_FILE) return;
	const keybindingArgs = [
		config.supportFilePaths.KEYBINDINGS_MERGE_SCRIPT,
		config.supportFilePaths.KEYBINDINGS_DEFAULTS_FILE,
		"--keybindings",
		config.keybindingsPath,
	];
	if (config.dryRun) keybindingArgs.push("--dry-run");
	if (config.quiet || (!config.verbose && !config.dryRun)) keybindingArgs.push("--quiet");

	log(config, "Applying isolated keybindings...");
	verboseLog(config, `Keybindings path: ${config.keybindingsPath}`);
	runNodeScript(config, keybindingArgs[0], keybindingArgs.slice(1));
}

function settingsRequireTlhSubagentPrompts(config) {
	return settingsFileRequiresTlhSubagentPrompts(config.supportFilePaths.DEFAULTS_FILE, { noSettings: config.noSettings });
}

function defaultExtensionsRequireCriticalInstall(config) {
	return defaultExtensionsFileRequiresCriticalInstall(config.supportFilePaths.DEFAULT_EXTENSIONS_FILE, { noSettings: config.noSettings });
}

function findTlhSubagentsDir(config) {
	return findTlhSubagentsDirFromSources(config, {
		localRepoDir: findLocalRepoDir(config) || "",
		prompts: config.subagentPrompts,
	});
}

async function installSupportFilesToProfile(config) {
	if (!installableSupportFilesArePrepared(config)) await ensureSupportFilesPrepared(config, supportFileIo());
	if (!installableSupportFilesArePrepared(config)) return;

	const requireSubagentPrompts = settingsRequireTlhSubagentPrompts(config);
	const subagentsSrc = requireSubagentPrompts ? findTlhSubagentsDir(config) : "";
	const supportSubagentsDir = join(config.supportDir, "agents", "subagents");

	if (config.dryRun) {
		printCommand(["mkdir", "-p", config.supportDir]);
		for (const file of installableSupportFiles({ noSettings: config.noSettings })) {
			const sourcePath = config.supportFilePaths[file.variable];
			if (sourcePath) printCommand(["cp", sourcePath, join(config.supportDir, file.installName)]);
		}
		if (requireSubagentPrompts) {
			if (subagentsSrc) {
				printCommand(["mkdir", "-p", supportSubagentsDir]);
				for (const prompt of config.subagentPrompts) {
					printCommand(["cp", join(subagentsSrc, prompt), join(supportSubagentsDir, prompt)]);
				}
			} else {
				log(config, "Would require TLH subagent prompts before enabling bundled subagents in settings.");
			}
		} else {
			log(config, "Would skip TLH subagent prompts because this ref does not enable bundled subagents in settings.");
		}
		return;
	}

	ensureSafeProfileDir(config, "tlh", "TLH support directory");
	for (const file of installableSupportFiles({ noSettings: config.noSettings })) {
		const sourcePath = config.supportFilePaths[file.variable];
		if (sourcePath) copySafeProfileFile(config, sourcePath, `tlh/${file.installName}`, `TLH support file ${file.installName}`);
	}
	if (!requireSubagentPrompts) return;
	if (!subagentsSrc) {
		throw new Error("TLH subagent prompts not found; re-run installer from a complete checkout or package.");
	}
	const missingPrompts = missingTlhSubagentPrompts(subagentsSrc, { prompts: config.subagentPrompts });
	if (missingPrompts.length > 0) {
		throw new Error(`TLH subagent prompts are incomplete (${missingPrompts.join(" ")}); re-run installer from a complete checkout or package.`);
	}
	const installedSubagentsDir = copyTlhSubagentPrompts(config, subagentsSrc, { prompts: config.subagentPrompts });
	const installedMissing = missingTlhSubagentPrompts(installedSubagentsDir, { prompts: config.subagentPrompts });
	if (installedMissing.length > 0) {
		throw new Error(`failed to install TLH subagent prompts (${installedMissing.join(" ")}); re-run installer from a complete checkout or package.`);
	}
}

async function writeInstallState(config) {
	if (!config.supportFilePaths.TLH_INSTALL_STATE_SCRIPT || !existsSync(config.supportFilePaths.TLH_INSTALL_STATE_SCRIPT)) {
		if (!(await ensureSupportFilesPrepared(config, supportFileIo()))) {
			if (config.dryRun) {
				log(config, `Would write tlh update metadata: ${config.statePath}`);
				return;
			}
			throw new Error(`install-state support files are unavailable for ref ${config.ref}`);
		}
	}
	if (!config.supportFilePaths.TLH_INSTALL_STATE_SCRIPT || !existsSync(config.supportFilePaths.TLH_INSTALL_STATE_SCRIPT)) {
		if (config.dryRun) {
			log(config, `Would write tlh update metadata: ${config.statePath}`);
			return;
		}
		throw new Error(`install-state support script not found for ref ${config.ref}; re-run the installer from a release that includes scripts/tlh-install-state.mjs`);
	}

	const args = [
		"--state-path",
		config.statePath,
		"--repo",
		config.repo,
		"--ref",
		config.ref,
		"--track",
		config.updateTrack,
		"--package-source",
		config.packageSource,
		"--package-source-is-default",
		String(config.packageSourceIsDefault),
		"--raw-base",
		config.rawBase,
		"--agent-dir",
		config.agentDir,
		"--bin-dir",
		config.binDir,
		"--wrapper-name",
		config.wrapperName,
	];
	if (config.dryRun) args.push("--dry-run");
	if (config.quiet) args.push("--quiet");

	runNodeScript(config, config.supportFilePaths.TLH_INSTALL_STATE_SCRIPT, args);
}

function outputLines(output) {
	return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function splitDefaultExtensionSources(sourcesOutput, criticalSourcesOutput) {
	const criticalSourceSet = new Set(outputLines(criticalSourcesOutput));
	const sources = outputLines(sourcesOutput);
	const criticalSources = [];
	const nonCriticalSources = [];
	for (const source of sources) {
		if (criticalSourceSet.has(source)) criticalSources.push(source);
		else nonCriticalSources.push(source);
	}
	return { sources, criticalSources, nonCriticalSources };
}

function ensureCriticalGitSourceCheckout(config, source) {
	const spec = criticalGitSourceSpec(source, { agentDir: config.agentDir });
	if (!spec) return true;
	assertGitSourceTargetSafe(config, source, "critical git extension checkout", gitCheckoutIo());
	if (!spec.ref) return true;
	return refreshGitCheckout(config, {
		targetDir: spec.targetDir,
		repo: spec.repo,
		ref: spec.ref,
		label: "critical git extension checkout",
		missingMessage: `critical git extension checkout is missing or invalid: ${spec.targetDir}`,
		warnOnMissing: true,
	}, gitCheckoutIo());
}

function criticalDefaultGitSources(config, sources) {
	return sources.filter((source) => criticalGitSourceSpec(source, { agentDir: config.agentDir }));
}

function preflightCriticalDefaultExtensionTargets(config, sources) {
	const gitSources = criticalDefaultGitSources(config, sources);
	if (gitSources.length === 0) return;
	detailLog(config, `${config.dryRun ? "Would preflight" : "Preflighting"} ${gitSources.length} critical bundled default git checkout target(s) before any settings-wide default extension update.`);
	for (const source of gitSources) {
		assertGitSourceTargetSafe(config, source, "critical default extension package checkout", gitCheckoutIo());
	}
}

function installCriticalDefaultExtension(config, source) {
	verboseLog(config, `Installing critical bundled default extension package: ${source}`);
	const installSource = gitSourceInstallSource(source, { agentDir: config.agentDir });
	assertGitSourceTargetSafe(config, source, "critical default extension package checkout", gitCheckoutIo());
	try {
		runIsolatedPi(config, ["pi", "install", installSource]);
	} catch {
		throw new Error(`critical default extension package install failed: ${source}. Fix the package install and rerun the installer; this isolation-critical default cannot be disabled.`);
	}
	if (!ensureCriticalGitSourceCheckout(config, source)) {
		throw new Error(`critical default extension package checkout validation failed: ${source}. Fix the package checkout and rerun the installer; this isolation-critical default cannot be disabled.`);
	}
}

function updateDefaultExtensionSourceBestEffort(config, source) {
	verboseLog(config, `Installing bundled default extension package: ${source}`);
	try {
		runIsolatedPi(config, ["pi", "update", source]);
		return true;
	} catch {
		warn(`default extension package update failed; continuing: ${source}`);
		return false;
	}
}

function updateDefaultExtensionSourcesBestEffort(config, sources) {
	let failures = 0;
	for (const source of sources) {
		if (!updateDefaultExtensionSourceBestEffort(config, source)) failures += 1;
	}
	return failures;
}

function updateNonCriticalDefaultExtensions(config, sources) {
	if (sources.length === 0) return 0;
	const fallbackDescription = `${sources.length} non-critical bundled default source(s)`;
	if (config.dryRun) {
		log(config, "Dry run: settings-wide extension refresh will run from merged settings.");
	} else {
		log(config, `Running settings-wide extension refresh from merged settings; fallback retries only ${fallbackDescription} individually.`);
	}

	try {
		runIsolatedPi(config, ["pi", "update", "--extensions"]);
	} catch {
		warn(`settings-wide extension refresh from merged settings failed; falling back to per-source updates for only ${fallbackDescription}`);
		return updateDefaultExtensionSourcesBestEffort(config, sources);
	}

	if (config.dryRun) {
		log(config, `If the settings-wide extension refresh fails, the installer would retry only ${fallbackDescription} individually.`);
	}
	return 0;
}

function installDefaultExtensions(config) {
	if (config.noSettings) {
		log(config, "Skipping bundled default extensions (--no-settings).");
		return;
	}
	if (!config.supportFilePaths.TLH_DEFAULTS_SCRIPT || !config.supportFilePaths.DEFAULT_EXTENSIONS_FILE) {
		if (config.dryRun) log(config, "Would install bundled default extension packages after settings merge.");
		return;
	}

	let sourcesOutput;
	let criticalSourcesOutput;
	try {
		sourcesOutput = runNodeScript(config, config.supportFilePaths.TLH_DEFAULTS_SCRIPT, [
			"--settings",
			config.settingsPath,
			"--defaults",
			config.supportFilePaths.DEFAULT_EXTENSIONS_FILE,
			"sources",
		], { captureStdout: true });
	} catch (error) {
		throw new Error(`failed to read bundled default extension sources: ${error.message}`);
	}
	try {
		criticalSourcesOutput = runNodeScript(config, config.supportFilePaths.TLH_DEFAULTS_SCRIPT, [
			"--settings",
			config.settingsPath,
			"--defaults",
			config.supportFilePaths.DEFAULT_EXTENSIONS_FILE,
			"critical-sources",
		], { captureStdout: true });
	} catch (error) {
		if (defaultExtensionsRequireCriticalInstall(config)) {
			throw new Error(`failed to read critical bundled default extension sources: ${error.message}`);
		}
		warn("installed default-extension helper does not support critical source queries; treating this ref as having no critical defaults.");
		criticalSourcesOutput = "";
	}

	const { sources, criticalSources, nonCriticalSources } = splitDefaultExtensionSources(sourcesOutput, criticalSourcesOutput);
	if (sources.length === 0) {
		log(config, "No bundled default extensions are enabled.");
		return;
	}

	log(config, `Installing bundled default extensions (${sources.length})...`);
	preflightCriticalDefaultExtensionTargets(config, criticalSources);
	const failures = updateNonCriticalDefaultExtensions(config, nonCriticalSources);
	if (failures !== 0) warn(`${failures} bundled default extension package(s) failed to update`);
	for (const source of criticalSources) installCriticalDefaultExtension(config, source);

	if (failures === 0) verboseLog(config, "Bundled default extensions installed.");
}

function gnosisInstallSkippedByEnv(config) {
	const value = config.env?.TLH_SKIP_GNOSIS_INSTALL;
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function configureGnosis(config) {
	if (config.noSettings) {
		log(config, "Skipping Gnosis integration (--no-settings).");
		return;
	}
	if (gnosisInstallSkippedByEnv(config)) {
		log(config, "Skipping Gnosis integration (TLH_SKIP_GNOSIS_INSTALL is set).");
		return;
	}
	if (!config.supportFilePaths.TLH_GNOSIS_SCRIPT) {
		log(config, "Skipping default Gnosis integration; support files are unavailable.");
		return;
	}

	const args = [
		"--agent-dir",
		config.agentDir,
		"--target",
		join(config.agentDir, "bin", "gn"),
		"--gnosis-repo",
		config.gnosisRepo,
		"--gnosis-version",
		config.gnosisVersion,
		"configure-install",
	];
	if (config.dryRun) args.push("--dry-run", "--detail");
	else if (config.verbose) args.push("--detail");
	if (config.quiet) args.push("--quiet");

	config.gnosisSummary = runNodeScript(config, config.supportFilePaths.TLH_GNOSIS_SCRIPT, args, { captureStdout: true }).trimEnd();
}

function wrapperIsManaged(config) {
	if (!existsSync(config.wrapperPath)) return false;
	try {
		const line = readFileSync(config.wrapperPath, "utf8").split(/\r?\n/)[2] || "";
		return line === "# Managed by The Last Harness installer";
	} catch {
		return false;
	}
}

function writeWrapperDryRunWithoutHelper(config) {
	if (existsSync(config.wrapperPath) && !wrapperIsManaged(config) && !config.force) {
		warn(`would not overwrite unmanaged existing wrapper: ${config.wrapperPath}`);
		return;
	}
	printCommand(["mkdir", "-p", config.binDir]);
	if (existsSync(config.wrapperPath)) log(config, `Would overwrite wrapper: ${config.wrapperPath}`);
	else log(config, `Would create wrapper: ${config.wrapperPath}`);
}

async function writeWrapper(config) {
	if (config.noWrapper) {
		log(config, "Skipping wrapper creation (--no-wrapper).");
		return;
	}

	if (config.dryRun || config.verbose) log(config, `Installing wrapper command: ${config.wrapperPath}`);
	else log(config, "Creating wrapper command...");

	if (!config.supportFilePaths.TLH_WRAPPER_SCRIPT || !existsSync(config.supportFilePaths.TLH_WRAPPER_SCRIPT)) {
		if (!(await ensureSupportFilesPrepared(config, supportFileIo()))) {
			if (config.dryRun) {
				writeWrapperDryRunWithoutHelper(config);
				return;
			}
			throw new Error(`wrapper support files are unavailable for ref ${config.ref}`);
		}
	}
	if (!config.supportFilePaths.TLH_WRAPPER_SCRIPT || !existsSync(config.supportFilePaths.TLH_WRAPPER_SCRIPT)) {
		if (config.dryRun) {
			writeWrapperDryRunWithoutHelper(config);
			return;
		}
		throw new Error(`wrapper support script not found for ref ${config.ref}; re-run the installer from a release that includes scripts/tlh-wrapper.mjs`);
	}

	const args = [
		"--agent-dir",
		config.agentDir,
		"--bin-dir",
		config.binDir,
		"--wrapper-name",
		config.wrapperName,
		"--package-root",
		config.packageRoot,
	];
	if (config.dryRun) args.push("--dry-run");
	if (config.force) args.push("--force");
	if (config.quiet) args.push("--quiet");
	runNodeScript(config, config.supportFilePaths.TLH_WRAPPER_SCRIPT, args);
}

function pathContainsBinDir(config) {
	return `:${config.env.PATH || ""}:`.includes(`:${config.binDir}:`);
}

function printSummary(config) {
	log(config, "");
	log(config, "Done. The Last Harness is ready.");
	if (!config.noWrapper) {
		if (pathContainsBinDir(config)) {
			log(config, `Start with: ${config.wrapperName}`);
		} else {
			warn(`${config.binDir} is not on PATH. Add it with: export PATH="${config.binDir}:$PATH"`);
			log(config, `Start with: PI_CODING_AGENT_DIR="${config.agentDir}" pi`);
		}
		detailLog(config, `Wrapper: ${config.wrapperPath}`);
	} else {
		log(config, `Start with: PI_CODING_AGENT_DIR="${config.agentDir}" pi`);
	}
	detailLog(config, `Settings: ${config.settingsPath}`);
	if (config.gnosisSummary) detailLog(config, config.gnosisSummary);
	detailLog(config, "Normal Pi config was not modified: ~/.pi/agent");
	if (!config.noWrapper) {
		detailLog(config, `Uninstall: rm -f "${config.wrapperPath}" && rm -rf "${config.agentDir}"`);
	} else {
		detailLog(config, `Uninstall: rm -rf "${config.agentDir}"`);
	}
}

async function runInstallFlow(config) {
	log(config, "The Last Harness installer");
	detailLog(config, `Isolated profile: ${config.agentDir}`);
	if (!config.packageSourceIsDefault || config.verbose) log(config, `Package source: ${config.packageSource}`);
	verboseLog(config, `Repository: ${config.repo}`);
	verboseLog(config, `Update track: ${config.updateTrack}`);

	validateInputs(config);
	requireCommand(config, "npm");
	requireCommand(config, "git");
	await preflightRuntimeSupportFiles(config, supportFileIo());

	installPiIfNeeded(config);
	installHarnessPackage(config);
	await installSupportFilesToProfile(config);
	await mergeSettings(config);
	await writeInstallState(config);
	installDefaultExtensions(config);
	configureGnosis(config);
	await writeWrapper(config);
	printSummary(config);
}

function printSupportManifest(config) {
	const manifest = formatSupportFileManifest({ noSettings: config.noSettings });
	process.stdout.write(`${manifest}\n`);
}

async function run(argv = process.argv.slice(2), env = process.env) {
	const parsedArgs = parseArgs(argv, env);
	if (parsedArgs.help) {
		process.stdout.write(usage());
		return;
	}

	assertSupportedNodeRuntime();
	const config = buildInstallConfig(parsedArgs, env);
	if (config.printSupportManifest) {
		printSupportManifest(config);
		return;
	}

	try {
		await runInstallFlow(config);
	} finally {
		if (config.tmpDir) rmSync(config.tmpDir, { recursive: true, force: true });
	}
}

function isMainModule() {
	if (!process.argv[1]) return false;
	try {
		const scriptPath = realpathSync.native(resolve(process.argv[1]));
		const modulePath = realpathSync.native(fileURLToPath(import.meta.url));
		return scriptPath === modulePath;
	} catch {
		return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
	}
}

if (isMainModule()) {
	run().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`error: ${message}`);
		process.exitCode = 1;
	});
}

export {
	MIN_NODE_VERSION,
	assertSupportedNodeRuntime,
	buildInstallConfig,
	expandPath,
	installDefaultExtensions,
	nodeVersionMeetsMinimum,
	parseArgs,
	run,
	usage,
	validateInputs,
};
