#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import {
	assertNotInNormalPiConfig,
	assignOptionValue,
	renderShellWords,
	shellQuote,
} from "./lib/tlh-install-utils.mjs";

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
		const agentDirIndex = assignOptionValue(args, "agentDir", argv, index, "--agent-dir");
		if (agentDirIndex !== undefined) {
			index = agentDirIndex;
			continue;
		}
		const binDirIndex = assignOptionValue(args, "binDir", argv, index, "--bin-dir");
		if (binDirIndex !== undefined) {
			index = binDirIndex;
			continue;
		}
		const wrapperNameIndex = assignOptionValue(args, "wrapperName", argv, index, "--wrapper-name");
		if (wrapperNameIndex !== undefined) {
			index = wrapperNameIndex;
			continue;
		}
		const packageRootIndex = assignOptionValue(args, "packageRoot", argv, index, "--package-root");
		if (packageRootIndex !== undefined) {
			index = packageRootIndex;
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

function printCommand(commandArgs) {
	console.log(`+ ${renderShellWords(commandArgs)} `);
}

function wrapperPath(args) {
	return join(args.binDir, args.wrapperName);
}

function assertNotNormalPiPath(path, label) {
	assertNotInNormalPiConfig(
		path,
		`refusing to modify normal Pi config from The Last Harness wrapper command (${label}): ${path}`,
	);
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
		'tlh_original_path="${PATH:-}"',
		'tlh_managed_bin="${default_agent_dir}/bin"',
		'tlh_wrapper_cwd_physical="$(pwd -P)"',
		'tlh_clean_abs_path() {',
		'  local tlh_path="$1"',
		'  local tlh_part',
		'  local tlh_old_ifs',
		'  local tlh_result',
		'  local tlh_clean_count=0',
		'  local tlh_index',
		'  local -a tlh_parts=()',
		'  local -a tlh_clean_parts=()',
		'  if [[ "${tlh_path}" != /* ]]; then',
		'    tlh_path="${tlh_wrapper_cwd_physical}/${tlh_path}"',
		'  fi',
		'  tlh_old_ifs="${IFS}"',
		'  IFS="/"',
		'  read -r -a tlh_parts <<< "${tlh_path}"',
		'  IFS="${tlh_old_ifs}"',
		'  for tlh_part in "${tlh_parts[@]}"; do',
		'    if [[ -z "${tlh_part}" || "${tlh_part}" == "." ]]; then',
		'      continue',
		'    fi',
		'    if [[ "${tlh_part}" == ".." ]]; then',
		'      if ((tlh_clean_count > 0)); then',
		'        tlh_clean_count=$((tlh_clean_count - 1))',
		'        unset "tlh_clean_parts[${tlh_clean_count}]"',
		'      fi',
		'      continue',
		'    fi',
		'    tlh_clean_parts[${tlh_clean_count}]="${tlh_part}"',
		'    tlh_clean_count=$((tlh_clean_count + 1))',
		'  done',
		'  if ((tlh_clean_count == 0)); then',
		"    printf '/\\n'",
		'    return',
		'  fi',
		'  tlh_result=""',
		'  tlh_index=0',
		'  while ((tlh_index < tlh_clean_count)); do',
		'    tlh_result="${tlh_result}/${tlh_clean_parts[${tlh_index}]}"',
		'    tlh_index=$((tlh_index + 1))',
		'  done',
		'  printf \'%s\\n\' "${tlh_result}"',
		'}',
		'tlh_realpath_dir() {',
		'  local tlh_path="$1"',
		'  (cd -P -- "${tlh_path}" >/dev/null 2>&1 && pwd -P)',
		'}',
		'tlh_managed_bin_abs="$(tlh_clean_abs_path "${tlh_managed_bin}")"',
		'tlh_managed_bin_real=""',
		'if tlh_managed_bin_real="$(tlh_realpath_dir "${tlh_managed_bin}")"; then',
		'  :',
		'else',
		'  tlh_managed_bin_real=""',
		'fi',
		'tlh_wrapper_cwd_abs="$(tlh_clean_abs_path "${tlh_wrapper_cwd_physical}")"',
		'tlh_wrapper_cwd_real="${tlh_wrapper_cwd_physical}"',
		'tlh_path_entry_should_drop() {',
		'  local tlh_path_entry="$1"',
		'  local tlh_entry_abs',
		'  local tlh_entry_real',
		'  if [[ -z "${tlh_path_entry}" ]]; then',
		'    return 0',
		'  fi',
		'  tlh_entry_abs="$(tlh_clean_abs_path "${tlh_path_entry}")"',
		'  if [[ "${tlh_entry_abs}" == "${tlh_wrapper_cwd_abs}" || "${tlh_entry_abs}" == "${tlh_managed_bin_abs}" ]]; then',
		'    return 0',
		'  fi',
		'  if tlh_entry_real="$(tlh_realpath_dir "${tlh_path_entry}")"; then',
		'    if [[ "${tlh_entry_real}" == "${tlh_wrapper_cwd_real}" ]]; then',
		'      return 0',
		'    fi',
		'    if [[ -n "${tlh_managed_bin_real}" && "${tlh_entry_real}" == "${tlh_managed_bin_real}" ]]; then',
		'      return 0',
		'    fi',
		'  fi',
		'  return 1',
		'}',
		'tlh_sanitized_path=""',
		'tlh_path_prefix=""',
		'tlh_remaining_path="${tlh_original_path}:"',
		'while [[ -n "${tlh_remaining_path}" ]]; do',
		'  tlh_path_entry="${tlh_remaining_path%%:*}"',
		'  tlh_remaining_path="${tlh_remaining_path#*:}"',
		'  if tlh_path_entry_should_drop "${tlh_path_entry}"; then',
		'    continue',
		'  fi',
		'  tlh_sanitized_path="${tlh_sanitized_path}${tlh_path_prefix}${tlh_path_entry}"',
		'  tlh_path_prefix=":"',
		'done',
		'tlh_isolated_path="${tlh_managed_bin}${tlh_sanitized_path:+:${tlh_sanitized_path}}"',
		'tlh_node_cmd=""',
		'tlh_resolve_node() {',
		'  if [[ -n "${tlh_node_cmd}" ]]; then',
		'    return',
		'  fi',
		'  tlh_node_cmd="$(PATH="${tlh_sanitized_path}" type -P node || true)"',
		'  if [[ -z "${tlh_node_cmd}" ]]; then',
		"    printf 'error: node command not found on PATH.\\n' >&2",
		'    exit 1',
		'  fi',
		'  if [[ "${tlh_node_cmd}" != /* ]]; then',
		'    tlh_node_dir="${tlh_node_cmd%/*}"',
		'    if [[ "${tlh_node_dir}" == "${tlh_node_cmd}" ]]; then',
		'      tlh_node_dir="."',
		'    fi',
		'    tlh_node_base="${tlh_node_cmd##*/}"',
		'    if ! tlh_node_dir="$(cd "${tlh_node_dir}" >/dev/null 2>&1 && pwd -P)"; then',
		"      printf 'error: could not resolve node command path.\\n' >&2",
		'      exit 1',
		'    fi',
		'    tlh_node_cmd="${tlh_node_dir}/${tlh_node_base}"',
		'  fi',
		'}',
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
		'  tlh_resolve_node',
		'  PATH="${tlh_sanitized_path}" exec "${tlh_node_cmd}" "${tlh_update_script}" --agent-dir "${default_agent_dir}" --bin-dir "${default_bin_dir}" --wrapper-name "${default_wrapper_name}" "$@"',
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
		'  tlh_resolve_node',
		'  PATH="${tlh_sanitized_path}" exec "${tlh_node_cmd}" "${tlh_defaults_script}" --settings "${default_agent_dir}/settings.json" --defaults "${tlh_default_extensions}" "$@"',
		"fi",
		"",
		'if [[ "${1:-}" == "tickets" ]]; then',
		"  shift",
		'  tlh_tickets_script=""',
		"  for candidate in \\",
		'    "${default_agent_dir}/tlh/tlh-tickets.mjs" \\',
		'    "${default_tlh_package_root}/scripts/tlh-tickets.mjs"; do',
		'    if [[ -f "${candidate}" ]]; then',
		'      tlh_tickets_script="${candidate}"',
		"      break",
		"    fi",
		"  done",
		'  if [[ -z "${tlh_tickets_script}" ]]; then',
		"    printf 'error: tlh tickets support files not found; re-run the installer.\\n' >&2",
		"    exit 1",
		"  fi",
		'  tlh_resolve_node',
		'  PATH="${tlh_isolated_path}" exec "${tlh_node_cmd}" "${tlh_tickets_script}" --settings "${default_agent_dir}/settings.json" --agent-dir "${default_agent_dir}" --wrapper-name "${default_wrapper_name}" "$@"',
		"fi",
		"",
		'pi_cmd="$(PATH="${tlh_sanitized_path}" type -P pi || true)"',
		'if [[ -z "${pi_cmd}" ]]; then',
		"  printf 'error: pi command not found on PATH.\\n' >&2",
		"  exit 1",
		"fi",
		'if [[ "${pi_cmd}" != /* ]]; then',
		'  pi_cmd_dir="${pi_cmd%/*}"',
		'  if [[ "${pi_cmd_dir}" == "${pi_cmd}" ]]; then',
		'    pi_cmd_dir="."',
		'  fi',
		'  pi_cmd_base="${pi_cmd##*/}"',
		'  if ! pi_cmd_dir="$(cd -P -- "${pi_cmd_dir}" >/dev/null 2>&1 && pwd -P)"; then',
		"    printf 'error: could not resolve pi command path.\\n' >&2",
		"    exit 1",
		"  fi",
		'  pi_cmd="${pi_cmd_dir}/${pi_cmd_base}"',
		"fi",
		'export PATH="${tlh_isolated_path}"',
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
