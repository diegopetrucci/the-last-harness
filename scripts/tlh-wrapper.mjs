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
const MAX_PI_VERSION = "0.79.7";

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
		`default_max_pi_version=${shellQuote(MAX_PI_VERSION)}`,
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
		// bash 3.2-safe empty-array guard: ${arr[@]+"${arr[@]}"} avoids 'set -u'
		// "unbound variable" when the array is empty; "${arr[@]}" alone crashes on bash 3.2.
		'  for tlh_part in ${tlh_parts[@]+"${tlh_parts[@]}"}; do',
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
		'tlh_pi_version_at_most() {',
		'  local tlh_current="$1"',
		'  local tlh_maximum="$2"',
		'  local tlh_current_major tlh_current_minor tlh_current_patch',
		'  local tlh_maximum_major tlh_maximum_minor tlh_maximum_patch',
		'  if [[ ! "${tlh_current}" =~ ^v?([0-9]+)\\.([0-9]+)\\.([0-9]+)([-+][0-9A-Za-z.-]+)?$ ]]; then',
		'    return 1',
		'  fi',
		'  tlh_current_major="${BASH_REMATCH[1]}"',
		'  tlh_current_minor="${BASH_REMATCH[2]}"',
		'  tlh_current_patch="${BASH_REMATCH[3]}"',
		'  if [[ ! "${tlh_maximum}" =~ ^v?([0-9]+)\\.([0-9]+)\\.([0-9]+)([-+][0-9A-Za-z.-]+)?$ ]]; then',
		'    return 1',
		'  fi',
		'  tlh_maximum_major="${BASH_REMATCH[1]}"',
		'  tlh_maximum_minor="${BASH_REMATCH[2]}"',
		'  tlh_maximum_patch="${BASH_REMATCH[3]}"',
		'  if ((10#${tlh_current_major} < 10#${tlh_maximum_major})); then',
		'    return 0',
		'  fi',
		'  if ((10#${tlh_current_major} > 10#${tlh_maximum_major})); then',
		'    return 1',
		'  fi',
		'  if ((10#${tlh_current_minor} < 10#${tlh_maximum_minor})); then',
		'    return 0',
		'  fi',
		'  if ((10#${tlh_current_minor} > 10#${tlh_maximum_minor})); then',
		'    return 1',
		'  fi',
		'  if ((10#${tlh_current_patch} <= 10#${tlh_maximum_patch})); then',
		'    return 0',
		'  fi',
		'  return 1',
		'}',
		'tlh_pi_binary_is_supported() {',
		'  local tlh_candidate_pi="$1"',
		'  local tlh_version_output',
		'  local tlh_version',
		'  [[ -n "${tlh_candidate_pi}" && -x "${tlh_candidate_pi}" ]] || return 1',
		'  if ! tlh_version_output="$(PATH="${tlh_sanitized_path}" "${tlh_candidate_pi}" --version 2>&1)"; then',
		'    return 1',
		'  fi',
		'  if [[ ! "${tlh_version_output}" =~ ([0-9]+\\.[0-9]+\\.[0-9]+) ]]; then',
		'    return 1',
		'  fi',
		'  tlh_version="${BASH_REMATCH[1]}"',
		'  tlh_pi_version_meets_minimum "${tlh_version}" "${default_min_pi_version}" && tlh_pi_version_at_most "${tlh_version}" "${default_max_pi_version}"',
		'}',
		'tlh_candidate_pi_is_supported() {',
		'  local tlh_candidate_dir="$1"',
		'  local tlh_candidate_pi="${tlh_candidate_dir}/pi"',
		'  [[ -n "${tlh_candidate_dir}" ]] || return 1',
		'  tlh_pi_binary_is_supported "${tlh_candidate_pi}"',
		'}',
		'tlh_find_supported_pi_dir_on_path() {',
		'  local tlh_search_path="$1"',
		'  local tlh_remaining_path="${tlh_search_path}:"',
		'  local tlh_path_entry',
		'  while [[ -n "${tlh_remaining_path}" ]]; do',
		'    tlh_path_entry="${tlh_remaining_path%%:*}"',
		'    tlh_remaining_path="${tlh_remaining_path#*:}"',
		'    if tlh_candidate_pi_is_supported "${tlh_path_entry}"; then',
		'      printf "%s\\n" "${tlh_path_entry}"',
		'      return 0',
		'    fi',
		'  done',
		'  return 1',
		'}',
		'tlh_pinned_dir=""',
		'tlh_pinned_dir_resolved=0',
		'tlh_resolve_pinned_dir() {',
		'  if [[ "${tlh_pinned_dir_resolved}" == "1" ]]; then',
		'    return',
		'  fi',
		'  tlh_pinned_dir=""',
		'  if tlh_pi_binary_is_supported "${default_pi_cmd}"; then',
		'    tlh_pinned_dir="${default_pi_cmd%/*}"',
		'    if [[ "${tlh_pinned_dir}" == "${default_pi_cmd}" ]]; then',
		'      tlh_pinned_dir="."',
		'    fi',
		'  fi',
		'  tlh_pinned_dir_resolved=1',
		'}',
		'tlh_managed_helper_path="${tlh_managed_bin}${tlh_sanitized_path:+:${tlh_sanitized_path}}"',
		'tlh_pi_search_path=""',
		'tlh_pi_search_path_resolved=0',
		'tlh_resolve_pi_search_path() {',
		'  local tlh_path_pi_bin=""',
		'  local tlh_path_pi_is_supported=0',
		'  local tlh_home_dir',
		'  local tlh_candidate_pi_bin',
		'  local tlh_preferred_pi_bin=""',
		'  if [[ "${tlh_pi_search_path_resolved}" == "1" ]]; then',
		'    return',
		'  fi',
		'  tlh_pi_search_path="${tlh_sanitized_path}"',
		'  tlh_path_pi_bin="$(tlh_find_supported_pi_dir_on_path "${tlh_sanitized_path}" || true)"',
		'  if [[ -n "${tlh_path_pi_bin}" ]]; then',
		'    tlh_path_pi_is_supported=1',
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
		'tlh_js_import_target_path() {',
		'  local tlh_script_path="$1"',
		'  local tlh_import_spec="$2"',
		'  local tlh_script_dir="${tlh_script_path%/*}"',
		'  if [[ "${tlh_script_dir}" == "${tlh_script_path}" ]]; then',
		'    tlh_script_dir="."',
		'  fi',
		'  tlh_clean_abs_path "${tlh_script_dir}/${tlh_import_spec}"',
		'}',
		'tlh_js_relative_imports_exist() {',
		'  local tlh_script_path="$1"',
		'  local tlh_import_line',
		'  local tlh_import_spec=""',
		'  local tlh_import_target',
		'  local tlh_current_script',
		'  local tlh_checked_script',
		'  local tlh_pending_script',
		'  local tlh_already_checked',
		'  local tlh_already_pending',
		"  local tlh_double_quote='\"'",
		"  local tlh_single_quote=\"'\"",
		'  local tlh_pending_index=0',
		'  local tlh_pending_count=1',
		'  local -a tlh_pending_scripts=()',
		'  local -a tlh_checked_scripts=()',
		'  tlh_script_path="$(tlh_clean_abs_path "${tlh_script_path}")"',
		'  [[ -f "${tlh_script_path}" ]] || return 1',
		'  tlh_pending_scripts[0]="${tlh_script_path}"',
		'  while ((tlh_pending_index < tlh_pending_count)); do',
		'    tlh_current_script="${tlh_pending_scripts[${tlh_pending_index}]}"',
		'    tlh_pending_index=$((tlh_pending_index + 1))',
		'    tlh_already_checked=0',
		// bash 3.2-safe empty-array guard (see comment near tlh_parts loop above)
		'    for tlh_checked_script in ${tlh_checked_scripts[@]+"${tlh_checked_scripts[@]}"}; do',
		'      if [[ "${tlh_checked_script}" == "${tlh_current_script}" ]]; then',
		'        tlh_already_checked=1',
		'        break',
		'      fi',
		'    done',
		'    if [[ "${tlh_already_checked}" == "1" ]]; then',
		'      continue',
		'    fi',
		'    tlh_checked_scripts[${#tlh_checked_scripts[@]}]="${tlh_current_script}"',
		'    [[ -f "${tlh_current_script}" ]] || return 1',
		'    while IFS= read -r tlh_import_line || [[ -n "${tlh_import_line}" ]]; do',
		'      tlh_import_spec=""',
		'      if [[ "${tlh_import_line}" == *"from ${tlh_double_quote}"* ]]; then',
		'        tlh_import_spec="${tlh_import_line#*from ${tlh_double_quote}}"',
		'        tlh_import_spec="${tlh_import_spec%%${tlh_double_quote}*}"',
		'      elif [[ "${tlh_import_line}" == *"from ${tlh_single_quote}"* ]]; then',
		'        tlh_import_spec="${tlh_import_line#*from ${tlh_single_quote}}"',
		'        tlh_import_spec="${tlh_import_spec%%${tlh_single_quote}*}"',
		'      elif [[ "${tlh_import_line}" == *"import ${tlh_double_quote}"* ]]; then',
		'        tlh_import_spec="${tlh_import_line#*import ${tlh_double_quote}}"',
		'        tlh_import_spec="${tlh_import_spec%%${tlh_double_quote}*}"',
		'      elif [[ "${tlh_import_line}" == *"import ${tlh_single_quote}"* ]]; then',
		'        tlh_import_spec="${tlh_import_line#*import ${tlh_single_quote}}"',
		'        tlh_import_spec="${tlh_import_spec%%${tlh_single_quote}*}"',
		'      fi',
		'      if [[ -z "${tlh_import_spec}" || ("${tlh_import_spec}" != ./* && "${tlh_import_spec}" != ../*) ]]; then',
		'        continue',
		'      fi',
		'      tlh_import_target="$(tlh_js_import_target_path "${tlh_current_script}" "${tlh_import_spec}")"',
		'      [[ -f "${tlh_import_target}" ]] || return 1',
		'      tlh_already_pending=0',
		// bash 3.2-safe empty-array guard (see comment near tlh_parts loop above)
		'      for tlh_pending_script in ${tlh_pending_scripts[@]+"${tlh_pending_scripts[@]}"}; do',
		'        if [[ "${tlh_pending_script}" == "${tlh_import_target}" ]]; then',
		'          tlh_already_pending=1',
		'          break',
		'        fi',
		'      done',
		'      if [[ "${tlh_already_pending}" != "1" ]]; then',
		'        tlh_pending_scripts[${tlh_pending_count}]="${tlh_import_target}"',
		'        tlh_pending_count=$((tlh_pending_count + 1))',
		'      fi',
		'    done < "${tlh_current_script}"',
		'  done',
		'  return 0',
		'}',
		'tlh_package_script_is_usable() {',
		'  local tlh_script_path="$1"',
		'  [[ -n "${default_tlh_package_root}" ]] || return 1',
		'  tlh_js_relative_imports_exist "${tlh_script_path}"',
		'}',
		'tlh_package_update_script_is_usable() {',
		'  tlh_package_script_is_usable "${default_tlh_package_root}/scripts/tlh-update.mjs"',
		'}',
		'tlh_package_defaults_are_usable() {',
		'  local tlh_defaults_script="${default_tlh_package_root}/scripts/tlh-defaults.mjs"',
		'  local tlh_default_extensions="${default_tlh_package_root}/config/default-extensions.json"',
		'  [[ -f "${tlh_default_extensions}" ]] || return 1',
		'  tlh_package_script_is_usable "${tlh_defaults_script}"',
		'}',
		'tlh_package_tickets_script_is_usable() {',
		'  tlh_package_script_is_usable "${default_tlh_package_root}/scripts/tlh-tickets.mjs"',
		'}',
		'export PI_CODING_AGENT_DIR="${default_agent_dir}"',
		"",
		'if [[ "${1:-}" == "update" ]]; then',
		"  shift",
		'  tlh_update_script=""',
		'  if tlh_package_update_script_is_usable; then',
		'    tlh_update_script="${default_tlh_package_root}/scripts/tlh-update.mjs"',
		'  elif [[ -f "${default_agent_dir}/tlh/recover-update.mjs" ]]; then',
		'    tlh_update_script="${default_agent_dir}/tlh/recover-update.mjs"',
		"  fi",
		'  if [[ -z "${tlh_update_script}" ]]; then',
		"    printf 'error: tlh update support files are missing; re-run the installer to restore recovery support.\\n' >&2",
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
		'  if [[ "${tlh_update_extensions}" == "1" ]]; then',
		'    tlh_resolve_pinned_dir',
		'    tlh_update_pi_dir="${tlh_pinned_dir}"',
		'    if [[ -z "${tlh_update_pi_dir}" ]]; then',
		'      tlh_update_pi_dir="$(tlh_find_supported_pi_dir_on_path "${tlh_pi_search_path}" || true)"',
		'    fi',
		'    if [[ -z "${tlh_update_pi_dir}" ]]; then',
		"      printf 'error: supported pi command not found on PATH; run `tlh update`.\\n' >&2",
		'      exit 1',
		'    fi',
		'    if [[ "${tlh_sanitized_path}" == "${tlh_update_pi_dir}" ]]; then',
		'      tlh_update_helper_path="${tlh_update_pi_dir}"',
		'    elif [[ "${tlh_sanitized_path}" == "${tlh_update_pi_dir}:"* ]]; then',
		'      tlh_update_helper_path="${tlh_update_pi_dir}:${tlh_sanitized_path#${tlh_update_pi_dir}:}"',
		'    else',
		'      tlh_update_helper_path="${tlh_update_pi_dir}${tlh_sanitized_path:+:${tlh_sanitized_path}}"',
		'    fi',
		'  fi',
		'  PATH="${tlh_update_helper_path}" exec "${tlh_node_cmd}" "${tlh_update_script}" --agent-dir "${default_agent_dir}" --bin-dir "${default_bin_dir}" --wrapper-name "${default_wrapper_name}" "$@"',
		"fi",
		"",
		'if [[ "${1:-}" == "defaults" ]]; then',
		"  shift",
		'  if ! tlh_package_defaults_are_usable; then',
		"    printf 'error: tlh defaults package support files are missing or corrupt; run `tlh update` to recover.\\n' >&2",
		"    exit 1",
		"  fi",
		'  tlh_resolve_node',
		'  PATH="${tlh_sanitized_path}" exec "${tlh_node_cmd}" "${default_tlh_package_root}/scripts/tlh-defaults.mjs" --settings "${default_agent_dir}/settings.json" --defaults "${default_tlh_package_root}/config/default-extensions.json" "$@"',
		"fi",
		"",
		'if [[ "${1:-}" == "tickets" ]]; then',
		"  shift",
		'  if ! tlh_package_tickets_script_is_usable; then',
		"    printf 'error: tlh tickets package support files are missing or corrupt; run `tlh update` to recover.\\n' >&2",
		"    exit 1",
		"  fi",
		'  tlh_resolve_node',
		'  PATH="${tlh_managed_helper_path}" exec "${tlh_node_cmd}" "${default_tlh_package_root}/scripts/tlh-tickets.mjs" --settings "${default_agent_dir}/settings.json" --agent-dir "${default_agent_dir}" --wrapper-name "${default_wrapper_name}" "$@"',
		"fi",
		"",
		'tlh_resolve_pinned_dir',
		'if [[ -n "${tlh_pinned_dir}" ]]; then',
		'  export PATH="${tlh_managed_bin}:${tlh_pinned_dir}${tlh_sanitized_path:+:${tlh_sanitized_path}}"',
		'  exec "${default_pi_cmd}" "$@"',
		'fi',
		'tlh_resolve_pi_search_path',
		'tlh_isolated_path="${tlh_managed_bin}${tlh_pi_search_path:+:${tlh_pi_search_path}}"',
		'tlh_supported_pi_dir="$(tlh_find_supported_pi_dir_on_path "${tlh_pi_search_path}" || true)"',
		'if [[ -z "${tlh_supported_pi_dir}" ]]; then',
		"  printf 'error: supported pi command not found on PATH; run `tlh update`.\\n' >&2",
		"  exit 1",
		"fi",
		'pi_cmd="${tlh_supported_pi_dir}/pi"',
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
