#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import process from "node:process";

const DEFAULT_MARKER = "Managed by The Last Harness installer";

function usage() {
	return `Usage: tlh-wrapper.mjs [options]

Render or dry-run the managed tlh wrapper command.

Options:
  --agent-dir DIR      Isolated Pi agent dir
  --bin-dir DIR        Wrapper install dir
  --wrapper-name NAME  Wrapper command name
  --package-root DIR   Installed The Last Harness package checkout
  --dry-run            Print intended changes without writing
  --force              Allow overwriting an unmanaged existing wrapper
  --quiet              Suppress non-essential output
  -h, --help           Show this help
`;
}

function requiredValue(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function parseArgs(argv) {
	const args = {
		agentDir: undefined,
		binDir: undefined,
		wrapperName: undefined,
		packageRoot: undefined,
		dryRun: false,
		force: false,
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
		if (arg === "--force") {
			args.force = true;
			continue;
		}
		if (arg === "--quiet") {
			args.quiet = true;
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
		if (arg === "--bin-dir") {
			args.binDir = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--bin-dir=")) {
			args.binDir = arg.slice("--bin-dir=".length);
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
		if (arg === "--package-root") {
			args.packageRoot = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--package-root=")) {
			args.packageRoot = arg.slice("--package-root=".length);
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return args;
}

function validateArgs(args) {
	for (const [key, flag] of [
		["agentDir", "--agent-dir"],
		["binDir", "--bin-dir"],
		["wrapperName", "--wrapper-name"],
		["packageRoot", "--package-root"],
	]) {
		if (!args[key]) throw new Error(`${flag} is required`);
	}
}

function log(args, message) {
	if (!args.quiet) console.log(message);
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

function wrapperPath(args) {
	return join(args.binDir, args.wrapperName);
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

function assertNotNormalPiPath(path, label) {
	if (isUnderNormalPiConfig(path)) {
		throw new Error(`refusing to modify normal Pi config from The Last Harness wrapper command (${label}): ${path}`);
	}
}

function wrapperIsManaged(path, marker = DEFAULT_MARKER) {
	if (!existsSync(path)) return false;
	try {
		const line = readFileSync(path, "utf8").split(/\r?\n/)[2] || "";
		return line === `# ${marker}`;
	} catch {
		return false;
	}
}

function renderWrapper(args) {
	const lines = [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		`# ${DEFAULT_MARKER}`,
		`default_agent_dir=${shellQuote(args.agentDir)}`,
		`default_tlh_package_root=${shellQuote(args.packageRoot)}`,
		`default_bin_dir=${shellQuote(args.binDir)}`,
		`default_wrapper_name=${shellQuote(args.wrapperName)}`,
		'export PI_CODING_AGENT_DIR="${default_agent_dir}"',
		"",
		'if [[ "${1:-}" == "update" ]]; then',
		"  shift",
		'  tlh_update_script=""',
		"  for candidate in \\",
		'    "${default_agent_dir}/tlh/tlh-update.mjs" \\',
		'    "${default_tlh_package_root}/scripts/tlh-update.mjs"; do',
		'    if [[ -f "${candidate}" ]]; then',
		'      tlh_update_script="${candidate}"',
		"      break",
		"    fi",
		"  done",
		'  if [[ -z "${tlh_update_script}" ]]; then',
		"    printf 'error: tlh update support files not found; re-run the installer.\\n' >&2",
		"    exit 1",
		"  fi",
		'  exec node "${tlh_update_script}" --agent-dir "${default_agent_dir}" --bin-dir "${default_bin_dir}" --wrapper-name "${default_wrapper_name}" "$@"',
		"fi",
		"",
		'if [[ "${1:-}" == "defaults" ]]; then',
		"  shift",
		'  tlh_defaults_script=""',
		'  tlh_default_extensions=""',
		"  for candidate in \\",
		'    "${default_agent_dir}/tlh/tlh-defaults.mjs" \\',
		'    "${default_tlh_package_root}/scripts/tlh-defaults.mjs"; do',
		'    if [[ -f "${candidate}" ]]; then',
		'      tlh_defaults_script="${candidate}"',
		"      break",
		"    fi",
		"  done",
		"  for candidate in \\",
		'    "${default_agent_dir}/tlh/default-extensions.json" \\',
		'    "${default_tlh_package_root}/config/default-extensions.json"; do',
		'    if [[ -f "${candidate}" ]]; then',
		'      tlh_default_extensions="${candidate}"',
		"      break",
		"    fi",
		"  done",
		'  if [[ -z "${tlh_defaults_script}" || -z "${tlh_default_extensions}" ]]; then',
		"    printf 'error: tlh defaults support files not found; re-run the installer.\\n' >&2",
		"    exit 1",
		"  fi",
		'  exec node "${tlh_defaults_script}" --settings "${default_agent_dir}/settings.json" --defaults "${tlh_default_extensions}" "$@"',
		"fi",
		"",
		'if [[ "${1:-}" == "gnosis" ]]; then',
		"  shift",
		'  tlh_gnosis_script=""',
		"  for candidate in \\",
		'    "${default_agent_dir}/tlh/tlh-gnosis.mjs" \\',
		'    "${default_tlh_package_root}/scripts/tlh-gnosis.mjs"; do',
		'    if [[ -f "${candidate}" ]]; then',
		'      tlh_gnosis_script="${candidate}"',
		"      break",
		"    fi",
		"  done",
		'  if [[ -z "${tlh_gnosis_script}" ]]; then',
		"    printf 'error: tlh gnosis support files not found; re-run the installer.\\n' >&2",
		"    exit 1",
		"  fi",
		'  exec node "${tlh_gnosis_script}" --settings "${default_agent_dir}/settings.json" --agent-dir "${default_agent_dir}" "$@"',
		"fi",
		"",
		'pi_cmd="$(command -v pi || true)"',
		'if [[ -z "${pi_cmd}" ]]; then',
		"  printf 'error: pi command not found on PATH.\\n' >&2",
		"  exit 1",
		"fi",
		'export PATH="${default_agent_dir}/bin${PATH:+:${PATH}}"',
		'exec "${pi_cmd}" "$@"',
	];
	return `${lines.join("\n")}\n`;
}

function dryRun(args, path) {
	if (existsSync(path) && !wrapperIsManaged(path) && !args.force) {
		warn(`would not overwrite unmanaged existing wrapper: ${path}`);
		return;
	}
	printCommand(["mkdir", "-p", args.binDir]);
	if (existsSync(path)) {
		log(args, `Would overwrite wrapper: ${path}`);
	} else {
		log(args, `Would create wrapper: ${path}`);
	}
}

function writeWrapper(args, path) {
	if (existsSync(path) && !wrapperIsManaged(path) && !args.force) {
		throw new Error(`${path} already exists and is not managed by this installer; use --force or --bin-dir`);
	}

	mkdirSync(args.binDir, { recursive: true });
	const tmpPath = `${path}.tmp.${process.pid}`;
	try {
		writeFileSync(tmpPath, renderWrapper(args), "utf8");
		chmodSync(tmpPath, 0o755);
		renameSync(tmpPath, path);
	} catch (error) {
		rmSync(tmpPath, { force: true });
		throw error;
	}
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(usage());
		return;
	}
	validateArgs(args);

	const path = wrapperPath(args);
	assertNotNormalPiPath(args.agentDir, "agent dir");
	assertNotNormalPiPath(args.binDir, "wrapper install dir");
	assertNotNormalPiPath(path, "wrapper path");
	if (args.dryRun) {
		dryRun(args, path);
		return;
	}
	writeWrapper(args, path);
}

try {
	main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`error: ${message}`);
	process.exitCode = 1;
}
