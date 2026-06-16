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
const MIN_PI_VERSION = "0.79.1";

function usage() {
	return `Usage: tlh-wrapper.mjs [options]

Render or dry-run the managed tlh wrapper command.

Options:
  --agent-dir DIR      Isolated Pi agent dir
  --bin-dir DIR        Wrapper install dir
  --wrapper-name NAME  Wrapper command name
  --package-root DIR   Installed The Last Harness package checkout
  --pi-cmd PATH        Absolute path to the pi binary to pin (optional)
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
		piCmd: undefined,
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
		const piCmdIndex = assignOptionValue(args, "piCmd", argv, index, "--pi-cmd");
		if (piCmdIndex !== undefined) {
			index = piCmdIndex;
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
	]) {
		if (!args[key]) throw new Error(`${flag} is required`);
	}
	if (args.packageRoot === undefined) throw new Error("--package-root is required");
}

function log(args, message) {
	if (!args.quiet) console.log(message);
}

function warn(message) {
	console.error(`warning: ${message}`);
}

function normalizePiCmd(args) {
	if (!args.piCmd) return "";
	if (!args.piCmd.startsWith("/")) {
		warn(`--pi-cmd value is not an absolute path (${args.piCmd}); treating as no pin`);
		return "";
	}
	return args.piCmd;
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
		`default_min_pi_version=${shellQuote(MIN_PI_VERSION)}`,
		`default_pi_cmd=${shellQuote(args.piCmd ?? "")}`,
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
		'tlh_pi_version_meets_minimum() {',
		'  local tlh_current="$1"',
		'  local tlh_minimum="$2"',
		'  local tlh_current_major tlh_current_minor tlh_current_patch',
		'  local tlh_minimum_major tlh_minimum_minor tlh_minimum_patch',
		'  if [[ ! "${tlh_current}" =~ ^v?([0-9]+)\\.([0-9]+)\\.([0-9]+)([-+][0-9A-Za-z.-]+)?$ ]]; then',
		'    return 1',
		'  fi',
		'  tlh_current_major="${BASH_REMATCH[1]}"',
		'  tlh_current_minor="${BASH_REMATCH[2]}"',
		'  tlh_current_patch="${BASH_REMATCH[3]}"',
		'  if [[ ! "${tlh_minimum}" =~ ^v?([0-9]+)\\.([0-9]+)\\.([0-9]+)([-+][0-9A-Za-z.-]+)?$ ]]; then',
		'    return 1',
		'  fi',
		'  tlh_minimum_major="${BASH_REMATCH[1]}"',
		'  tlh_minimum_minor="${BASH_REMATCH[2]}"',
		'  tlh_minimum_patch="${BASH_REMATCH[3]}"',
		'  if ((10#${tlh_current_major} > 10#${tlh_minimum_major})); then',
		'    return 0',
		'  fi',
		'  if ((10#${tlh_current_major} < 10#${tlh_minimum_major})); then',
		'    return 1',
		'  fi',
		'  if ((10#${tlh_current_minor} > 10#${tlh_minimum_minor})); then',
		'    return 0',
		'  fi',
		'  if ((10#${tlh_current_minor} < 10#${tlh_minimum_minor})); then',
		'    return 1',
		'  fi',
		'  if ((10#${tlh_current_patch} >= 10#${tlh_minimum_patch})); then',
		'    return 0',
		'  fi',
		'  return 1',
		'}',
		'tlh_candidate_pi_is_supported() {',
		'  local tlh_candidate_dir="$1"',
		'  local tlh_candidate_pi="${tlh_candidate_dir}/pi"',
		'  local tlh_version_output',
		'  local tlh_version',
		'  [[ -n "${tlh_candidate_dir}" && -x "${tlh_candidate_pi}" ]] || return 1',
		'  if ! tlh_version_output="$(PATH="${tlh_sanitized_path}" "${tlh_candidate_pi}" --version 2>&1)"; then',
		'    return 1',
		'  fi',
		'  if [[ ! "${tlh_version_output}" =~ ([0-9]+\\.[0-9]+\\.[0-9]+) ]]; then',
		'    return 1',
		'  fi',
		'  tlh_version="${BASH_REMATCH[1]}"',
		'  tlh_pi_version_meets_minimum "${tlh_version}" "${default_min_pi_version}"',
		'}',
		'tlh_pinned_dir=""',
		'if [[ -n "${default_pi_cmd}" && -x "${default_pi_cmd}" ]]; then',
		'  tlh_pinned_dir="${default_pi_cmd%/*}"',
		'  if [[ "${tlh_pinned_dir}" == "${default_pi_cmd}" ]]; then',
		'    tlh_pinned_dir="."',
		'  fi',
		'fi',
		'tlh_managed_helper_path="${tlh_managed_bin}${tlh_sanitized_path:+:${tlh_sanitized_path}}"',
		'tlh_pi_search_path=""',
		'tlh_pi_search_path_resolved=0',
		'tlh_resolve_pi_search_path() {',
		'  local tlh_path_pi_cmd',
		'  local tlh_path_pi_bin',
		'  local tlh_path_pi_is_supported=0',
		'  local tlh_home_dir',
		'  local tlh_candidate_pi_bin',
		'  local tlh_preferred_pi_bin=""',
		'  if [[ "${tlh_pi_search_path_resolved}" == "1" ]]; then',
		'    return',
		'  fi',
		'  tlh_pi_search_path="${tlh_sanitized_path}"',
		'  tlh_path_pi_cmd="$(PATH="${tlh_sanitized_path}" type -P pi || true)"',
		'  if [[ -n "${tlh_path_pi_cmd}" ]]; then',
		'    tlh_path_pi_bin="${tlh_path_pi_cmd%/*}"',
		'    if [[ "${tlh_path_pi_bin}" == "${tlh_path_pi_cmd}" ]]; then',
		'      tlh_path_pi_bin="."',
		'    fi',
		'    if tlh_candidate_pi_is_supported "${tlh_path_pi_bin}"; then',
		'      tlh_path_pi_is_supported=1',
		'    fi',
		'  fi',
		'  tlh_home_dir="${HOME:-}"',
		'  if [[ "${tlh_path_pi_is_supported}" != "1" && -n "${tlh_home_dir}" ]]; then',
		'    tlh_candidate_pi_bin="${tlh_home_dir}/.local/bin"',
		'    if tlh_candidate_pi_is_supported "${tlh_candidate_pi_bin}"; then',
		'      tlh_preferred_pi_bin="${tlh_candidate_pi_bin}"',
		'    fi',
		'  fi',
		'  if [[ -n "${tlh_preferred_pi_bin}" ]]; then',
		'    tlh_pi_search_path="${tlh_preferred_pi_bin}${tlh_pi_search_path:+:${tlh_pi_search_path}}"',
		'  fi',
		'  tlh_pi_search_path_resolved=1',
		'}',
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
		'  if [[ -n "${default_tlh_package_root}" && -f "${default_tlh_package_root}/scripts/tlh-update.mjs" ]]; then',
		'    tlh_update_script="${default_tlh_package_root}/scripts/tlh-update.mjs"',
		'  elif [[ -f "${default_agent_dir}/tlh/tlh-update.mjs" ]]; then',
		'    tlh_update_script="${default_agent_dir}/tlh/tlh-update.mjs"',
		"  fi",
		'  if [[ -z "${tlh_update_script}" ]]; then',
		"    printf 'error: tlh update support files not found; re-run the installer.\\n' >&2",
		"    exit 1",
		"  fi",
		'  tlh_resolve_node',
		'  tlh_update_extensions=0',
		'  for tlh_update_arg in "$@"; do',
		'    if [[ "${tlh_update_arg}" == "--extensions" ]]; then',
		'      tlh_update_extensions=1',
		'      break',
		'    fi',
		'  done',
		'  tlh_resolve_pi_search_path',
		'  tlh_update_helper_path="${tlh_pi_search_path}"',
		'  if [[ "${tlh_update_extensions}" == "1" && -n "${tlh_pinned_dir}" ]]; then',
		'    tlh_update_helper_path="${tlh_pinned_dir}${tlh_update_helper_path:+:${tlh_update_helper_path}}"',
		'  fi',
		'  PATH="${tlh_update_helper_path}" exec "${tlh_node_cmd}" "${tlh_update_script}" --agent-dir "${default_agent_dir}" --bin-dir "${default_bin_dir}" --wrapper-name "${default_wrapper_name}" "$@"',
		"fi",
		"",
		'if [[ "${1:-}" == "defaults" ]]; then',
		"  shift",
		'  tlh_defaults_script=""',
		'  tlh_default_extensions=""',
		'  tlh_package_defaults_script="${default_tlh_package_root}/scripts/tlh-defaults.mjs"',
		'  tlh_package_default_extensions="${default_tlh_package_root}/config/default-extensions.json"',
		'  tlh_profile_defaults_script="${default_agent_dir}/tlh/tlh-defaults.mjs"',
		'  tlh_profile_default_extensions="${default_agent_dir}/tlh/default-extensions.json"',
		'  if [[ -n "${default_tlh_package_root}" && -f "${tlh_package_defaults_script}" && -f "${tlh_package_default_extensions}" ]]; then',
		'    tlh_defaults_script="${tlh_package_defaults_script}"',
		'    tlh_default_extensions="${tlh_package_default_extensions}"',
		'  elif [[ -f "${tlh_profile_defaults_script}" && -f "${tlh_profile_default_extensions}" ]]; then',
		'    tlh_defaults_script="${tlh_profile_defaults_script}"',
		'    tlh_default_extensions="${tlh_profile_default_extensions}"',
		"  fi",
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
		'  if [[ -n "${default_tlh_package_root}" && -f "${default_tlh_package_root}/scripts/tlh-tickets.mjs" ]]; then',
		'    tlh_tickets_script="${default_tlh_package_root}/scripts/tlh-tickets.mjs"',
		'  elif [[ -f "${default_agent_dir}/tlh/tlh-tickets.mjs" ]]; then',
		'    tlh_tickets_script="${default_agent_dir}/tlh/tlh-tickets.mjs"',
		"  fi",
		'  if [[ -z "${tlh_tickets_script}" ]]; then',
		"    printf 'error: tlh tickets support files not found; re-run the installer.\\n' >&2",
		"    exit 1",
		"  fi",
		'  tlh_resolve_node',
		'  PATH="${tlh_managed_helper_path}" exec "${tlh_node_cmd}" "${tlh_tickets_script}" --settings "${default_agent_dir}/settings.json" --agent-dir "${default_agent_dir}" --wrapper-name "${default_wrapper_name}" "$@"',
		"fi",
		"",
		'if [[ -n "${default_pi_cmd}" && -x "${default_pi_cmd}" ]]; then',
		'  export PATH="${tlh_managed_bin}:${tlh_pinned_dir}${tlh_sanitized_path:+:${tlh_sanitized_path}}"',
		'  exec "${default_pi_cmd}" "$@"',
		'fi',
		'tlh_resolve_pi_search_path',
		'tlh_isolated_path="${tlh_managed_bin}${tlh_pi_search_path:+:${tlh_pi_search_path}}"',
		'pi_cmd="$(PATH="${tlh_pi_search_path}" type -P pi || true)"',
		'if [[ -z "${pi_cmd}" ]]; then',
		"  printf 'error: pi command not found on PATH; run `tlh update`.\\n' >&2",
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
	args.piCmd = normalizePiCmd(args);

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
