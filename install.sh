#!/usr/bin/env bash
set -euo pipefail

REPO="${TLH_REPO:-diegopetrucci/the-last-harness}"
REF="${TLH_REF:-main}"

DRY_RUN=false
FORCE=false
NO_PI_INSTALL=false
NO_SETTINGS=false
NO_WRAPPER=false
QUIET=false
VERBOSE=false
GNOSIS_MODE="auto"
GNOSIS_SUMMARY=""
TMP_DIR=""
PACKAGE_SOURCE="${TLH_PACKAGE_SOURCE:-}"
UPDATE_TRACK_INPUT="${TLH_UPDATE_TRACK:-}"
GNOSIS_REPO="${TLH_GNOSIS_REPO:-skorokithakis/gnosis}"
GNOSIS_VERSION="${TLH_GNOSIS_VERSION:-latest}"
AGENT_DIR_INPUT="${TLH_AGENT_DIR:-$HOME/.the-last-harness/agent}"
BIN_DIR_INPUT="${TLH_BIN_DIR:-$HOME/.local/bin}"
WRAPPER_NAME="${TLH_WRAPPER_NAME:-tlh}"
TLH_SUBAGENT_PROMPTS=(developer.md code-reviewer.md repo-scout.md diff-summarizer.md bug-hunter.md bug-catcher.md librarian.md oracle.md)

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

Install upstream Pi and The Last Harness as a separate `tlh` command. Normal Pi
config under ~/.pi/agent is not modified.

Options:
  --dry-run        Print actions and settings/keybinding changes without writing
  --force          Allow scalar isolated defaults and installer wrapper overwrite
  --no-pi-install  Fail instead of installing Pi when the `pi` command is missing
  --no-settings     Install the package but skip isolated settings/keybinding merge
  --no-wrapper      Skip creating the tlh wrapper command
  --with-gnosis     Force install/re-enable Gnosis (`gn`) integration
  --without-gnosis  Opt out of Gnosis integration and keep it disabled
  --no-gnosis       Alias for --without-gnosis
  --agent-dir DIR   Isolated Pi agent dir (default: ~/.the-last-harness/agent)
  --bin-dir DIR     Wrapper install dir (default: ~/.local/bin)
  --wrapper-name N  Wrapper command name (default: tlh)
  --ref REF         Install The Last Harness from a branch, tag, or commit
  --track TRACK     Update track for future tlh update: latest-release, pinned-tag, ref, custom
  --quiet           Suppress installer progress output
  --verbose         Show underlying pi, npm, and git output
  -h, --help        Show this help

Environment overrides:
  TLH_AGENT_DIR        Isolated Pi agent dir
  TLH_BIN_DIR          Wrapper install dir
  TLH_WRAPPER_NAME     Wrapper command name
  TLH_REPO             GitHub repo, owner/name (default: diegopetrucci/the-last-harness)
  TLH_REF              Raw-file ref and package ref (default: main in source; release assets pin this to their tag)
  TLH_UPDATE_TRACK     Update track for future tlh update
  TLH_PACKAGE_SOURCE   Package source passed to `pi install`
  TLH_RAW_BASE         Base URL for installer support files
  TLH_GNOSIS_VERSION   Gnosis version to install (default: latest)
  TLH_GNOSIS_REPO      Gnosis GitHub repo, owner/name (default: skorokithakis/gnosis)

Examples:
  curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | TLH_UPDATE_TRACK=latest-release bash -s --
  curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | TLH_UPDATE_TRACK=latest-release bash -s -- --dry-run
  bash install.sh --agent-dir ~/.tlh/agent --bin-dir ~/.local/bin

Test any pushed branch by fetching that branch's installer and matching --ref:
  curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/subagents/install.sh | bash -s -- --ref subagents --track ref
USAGE
}

log() {
  if [[ "${QUIET}" != "true" ]]; then
    printf '%s\n' "$*"
  fi
}

log_stderr() {
  if [[ "${QUIET}" != "true" ]]; then
    printf '%s\n' "$*" >&2
  fi
}

verbose_log() {
  if [[ "${VERBOSE}" == "true" && "${QUIET}" != "true" ]]; then
    printf '%s\n' "$*"
  fi
}

detail_log() {
  if [[ "${QUIET}" != "true" && ( "${VERBOSE}" == "true" || "${DRY_RUN}" == "true" ) ]]; then
    printf '%s\n' "$*"
  fi
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "${TMP_DIR}" && -d "${TMP_DIR}" ]]; then
    rm -rf "${TMP_DIR}"
  fi
}
trap cleanup EXIT

need_value() {
  local flag="$1"
  local value="${2:-}"
  if [[ -z "${value}" || "${value}" == -* ]]; then
    die "${flag} requires a value"
  fi
  printf '%s\n' "${value}"
}

expand_path() {
  local path="$1"
  case "${path}" in
    '~')
      printf '%s\n' "${HOME}"
      ;;
    '~/'*)
      printf '%s/%s\n' "${HOME}" "${path#~/}"
      ;;
    *)
      printf '%s\n' "${path}"
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --force)
      FORCE=true
      shift
      ;;
    --no-pi-install)
      NO_PI_INSTALL=true
      shift
      ;;
    --no-settings)
      NO_SETTINGS=true
      shift
      ;;
    --no-wrapper)
      NO_WRAPPER=true
      shift
      ;;
    --with-gnosis)
      GNOSIS_MODE="with"
      shift
      ;;
    --without-gnosis|--no-gnosis)
      GNOSIS_MODE="without"
      shift
      ;;
    --agent-dir)
      AGENT_DIR_INPUT="$(need_value "$1" "${2:-}")"
      shift 2
      ;;
    --agent-dir=*)
      AGENT_DIR_INPUT="${1#--agent-dir=}"
      [[ -n "${AGENT_DIR_INPUT}" ]] || die "--agent-dir requires a value"
      shift
      ;;
    --bin-dir)
      BIN_DIR_INPUT="$(need_value "$1" "${2:-}")"
      shift 2
      ;;
    --bin-dir=*)
      BIN_DIR_INPUT="${1#--bin-dir=}"
      [[ -n "${BIN_DIR_INPUT}" ]] || die "--bin-dir requires a value"
      shift
      ;;
    --wrapper-name)
      WRAPPER_NAME="$(need_value "$1" "${2:-}")"
      shift 2
      ;;
    --wrapper-name=*)
      WRAPPER_NAME="${1#--wrapper-name=}"
      [[ -n "${WRAPPER_NAME}" ]] || die "--wrapper-name requires a value"
      shift
      ;;
    --quiet)
      QUIET=true
      VERBOSE=false
      shift
      ;;
    --verbose)
      VERBOSE=true
      QUIET=false
      shift
      ;;
    --ref)
      REF="$(need_value "$1" "${2:-}")"
      shift 2
      ;;
    --ref=*)
      REF="${1#--ref=}"
      [[ -n "${REF}" ]] || die "--ref requires a value"
      shift
      ;;
    --track)
      UPDATE_TRACK_INPUT="$(need_value "$1" "${2:-}")"
      shift 2
      ;;
    --track=*)
      UPDATE_TRACK_INPUT="${1#--track=}"
      [[ -n "${UPDATE_TRACK_INPUT}" ]] || die "--track requires a value"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

AGENT_DIR="$(expand_path "${AGENT_DIR_INPUT}")"
BIN_DIR="$(expand_path "${BIN_DIR_INPUT}")"
SETTINGS_PATH="${AGENT_DIR}/settings.json"
KEYBINDINGS_PATH="${AGENT_DIR}/keybindings.json"
WRAPPER_MARKER="Managed by The Last Harness installer"
MERGE_SCRIPT=""
DEFAULTS_FILE=""
KEYBINDINGS_MERGE_SCRIPT=""
KEYBINDINGS_DEFAULTS_FILE=""
DEFAULT_EXTENSIONS_FILE=""
TLH_DEFAULTS_SCRIPT=""
TLH_GNOSIS_SCRIPT=""
TLH_UPDATE_SCRIPT=""
TLH_WRAPPER_SCRIPT=""
TLH_INSTALL_STATE_SCRIPT=""
SUPPORT_FILES_DRY_RUN_SKIPPED=false

strip_trailing_slashes() {
  local path="$1"
  while [[ "${path}" != "/" && "${path}" == */ ]]; do
    path="${path%/}"
  done
  printf '%s\n' "${path}"
}

normalize_path_for_compare() {
  local path
  path="$(strip_trailing_slashes "$1")"
  node -e '
const fs = require("node:fs");
const path = require("node:path");
function realpathForCompare(input) {
  const resolved = path.resolve(input);
  if (fs.existsSync(resolved)) return fs.realpathSync.native(resolved);
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(realpathForCompare(parent), path.basename(resolved));
}
console.log(realpathForCompare(process.argv[1]));
' "${path}"
}

path_within_or_equal() {
  local root child
  root="$(strip_trailing_slashes "$1")"
  child="$(strip_trailing_slashes "$2")"
  if [[ "${root}" == "/" ]]; then
    [[ "${child}" == /* ]]
    return $?
  fi
  [[ "${child}" == "${root}" || "${child}" == "${root}/"* ]]
}

path_is_protected_pi_config() {
  local normalized_path="$1"
  local normal_pi_root normal_pi_agent_root

  normal_pi_root="$(normalize_path_for_compare "${HOME}/.pi")" || die "failed to resolve normal Pi config path"
  normal_pi_agent_root="$(normalize_path_for_compare "${HOME}/.pi/agent")" || die "failed to resolve normal Pi agent config path"
  path_within_or_equal "${normal_pi_root}" "${normalized_path}" || path_within_or_equal "${normal_pi_agent_root}" "${normalized_path}"
}

validate_inputs() {
  if [[ ! "${WRAPPER_NAME}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    die "--wrapper-name must be a simple command name containing only letters, numbers, dot, underscore, or dash"
  fi
  case "${UPDATE_TRACK}" in
    latest-release|pinned-tag|ref|custom) ;;
    *) die "--track must be one of: latest-release, pinned-tag, ref, custom" ;;
  esac

  local normalized_agent normalized_bin normalized_wrapper
  normalized_agent="$(normalize_path_for_compare "${AGENT_DIR}")" || die "failed to resolve The Last Harness agent dir"
  normalized_bin="$(normalize_path_for_compare "${BIN_DIR}")" || die "failed to resolve The Last Harness wrapper dir"
  normalized_wrapper="$(normalize_path_for_compare "${WRAPPER_PATH}")" || die "failed to resolve The Last Harness wrapper path"
  if path_is_protected_pi_config "${normalized_agent}"; then
    die "refusing to place The Last Harness agent dir under normal Pi config root: ${AGENT_DIR}"
  fi
  if path_is_protected_pi_config "${normalized_bin}"; then
    die "refusing to place The Last Harness wrapper dir under normal Pi config root: ${BIN_DIR}"
  fi
  if path_is_protected_pi_config "${normalized_wrapper}"; then
    die "refusing to place The Last Harness wrapper under normal Pi config root: ${WRAPPER_PATH}"
  fi
}
validate_profile_relative_path() {
  local relative="$1"
  local label="${2:-TLH profile path}"
  local components=()
  local component

  if [[ -z "${relative}" || "${relative}" == /* || "${relative}" == */ ]]; then
    die "refusing unsafe ${label}: ${relative}"
  fi

  IFS='/' read -r -a components <<< "${relative}"
  for component in "${components[@]}"; do
    if [[ -z "${component}" || "${component}" == "." || "${component}" == ".." ]]; then
      die "refusing unsafe ${label}: ${relative}"
    fi
  done
}

assert_profile_path_within_agent() {
  local path="$1"
  local label="${2:-TLH profile path}"
  local normalized_agent normalized_path

  normalized_agent="$(normalize_path_for_compare "${AGENT_DIR}")" || return $?
  normalized_path="$(normalize_path_for_compare "${path}")" || return $?
  if ! path_within_or_equal "${normalized_agent}" "${normalized_path}"; then
    die "refusing to write ${label} outside the isolated TLH profile: ${path}"
  fi

  if path_is_protected_pi_config "${normalized_path}"; then
    die "refusing to write ${label} under normal Pi config root: ${path}"
  fi
}

ensure_safe_profile_dir() {
  local relative="$1"
  local label="${2:-TLH profile directory}"
  local root cursor component
  local components=()

  validate_profile_relative_path "${relative}" "${label}"
  root="$(normalize_path_for_compare "${AGENT_DIR}")" || return $?
  if [[ -e "${root}" && ! -d "${root}" ]]; then
    die "refusing to use non-directory TLH profile root for ${label}: ${AGENT_DIR}"
  fi
  if [[ ! -d "${root}" ]]; then
    mkdir -p "${root}" || return $?
  fi
  assert_profile_path_within_agent "${root}" "${label}" || return $?

  cursor="${root}"
  IFS='/' read -r -a components <<< "${relative}"
  for component in "${components[@]}"; do
    cursor="${cursor}/${component}"
    if [[ -L "${cursor}" ]]; then
      die "refusing to write ${label} through symlinked TLH profile path: ${cursor}"
    fi
    if [[ -e "${cursor}" && ! -d "${cursor}" ]]; then
      die "refusing to use non-directory TLH profile path for ${label}: ${cursor}"
    fi
    if [[ ! -e "${cursor}" ]]; then
      mkdir "${cursor}" || return $?
    fi
    assert_profile_path_within_agent "${cursor}" "${label}" || return $?
  done

  printf '%s\n' "${cursor}"
}

safe_profile_file_target() {
  local relative="$1"
  local label="${2:-TLH profile file}"
  local parent_relative base parent target

  validate_profile_relative_path "${relative}" "${label}"
  parent_relative="${relative%/*}"
  base="${relative##*/}"
  if [[ "${parent_relative}" == "${relative}" || -z "${base}" ]]; then
    die "refusing unsafe ${label}: ${relative}"
  fi

  parent="$(ensure_safe_profile_dir "${parent_relative}" "${label} parent directory")" || return $?
  target="${parent}/${base}"
  if [[ -L "${target}" ]]; then
    die "refusing to replace symlinked ${label}: ${target}"
  fi
  if [[ -e "${target}" && ! -f "${target}" ]]; then
    die "refusing to replace non-file ${label}: ${target}"
  fi
  assert_profile_path_within_agent "${target}" "${label}" || return $?
  printf '%s\n' "${target}"
}

copy_safe_profile_file() {
  local source="$1"
  local relative="$2"
  local label="${3:-TLH profile file}"
  local target target_dir target_base temp_target

  target="$(safe_profile_file_target "${relative}" "${label}")" || return $?
  target_dir="${target%/*}"
  target_base="${target##*/}"
  temp_target="$(mktemp "${target_dir}/.${target_base}.tmp.XXXXXX")" || return $?
  if ! cp "${source}" "${temp_target}"; then
    rm -f "${temp_target}"
    return 1
  fi
  if ! mv "${temp_target}" "${target}"; then
    rm -f "${temp_target}"
    return 1
  fi
}

file_link_count() {
  local path="$1"
  node -e 'console.log(require("node:fs").lstatSync(process.argv[1]).nlink)' "${path}"
}

assert_safe_settings_target() {
  local settings_dir settings_base link_count
  settings_dir="${SETTINGS_PATH%/*}"
  settings_base="${SETTINGS_PATH##*/}"

  assert_profile_path_within_agent "${settings_dir}" "Pi settings directory" || return $?
  if [[ -L "${SETTINGS_PATH}" ]]; then
    die "refusing to let Pi write through symlinked isolated settings file: ${SETTINGS_PATH}"
  fi
  if [[ -e "${SETTINGS_PATH}" && ! -f "${SETTINGS_PATH}" ]]; then
    die "refusing to let Pi replace non-file isolated settings path: ${SETTINGS_PATH}"
  fi
  assert_profile_path_within_agent "${SETTINGS_PATH}" "Pi settings file" || return $?

  if [[ -f "${SETTINGS_PATH}" ]]; then
    link_count="$(file_link_count "${SETTINGS_PATH}")" || die "failed to inspect isolated settings link count: ${SETTINGS_PATH}"
    if [[ "${link_count}" != "1" ]]; then
      die "refusing to let Pi mutate hard-linked isolated settings file: ${SETTINGS_PATH}"
    fi
  fi
  [[ "${settings_base}" == "settings.json" ]] || die "unexpected Pi settings filename: ${SETTINGS_PATH}"
}

WRAPPER_PATH="${BIN_DIR}/${WRAPPER_NAME}"
PACKAGE_SOURCE_IS_DEFAULT=false

if [[ -z "${PACKAGE_SOURCE}" ]]; then
  PACKAGE_SOURCE="git:github.com/${REPO}@${REF}"
  PACKAGE_SOURCE_IS_DEFAULT=true
fi

RAW_BASE="${TLH_RAW_BASE:-https://raw.githubusercontent.com/${REPO}/${REF}}"

if [[ -n "${UPDATE_TRACK_INPUT}" ]]; then
  UPDATE_TRACK="${UPDATE_TRACK_INPUT}"
elif [[ "${PACKAGE_SOURCE_IS_DEFAULT}" != "true" ]]; then
  UPDATE_TRACK="custom"
elif [[ "${REF}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  UPDATE_TRACK="pinned-tag"
else
  UPDATE_TRACK="ref"
fi

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  local cmd="$1"
  command_exists "${cmd}" || die "required command not found: ${cmd}"
}

print_command() {
  printf '+ '
  printf '%q ' "$@"
  printf '\n'
}

print_command_failure() {
  local status="$1"
  local log_file="$2"
  shift 2

  printf 'command failed (exit %s): ' "${status}" >&2
  printf '%q ' "$@" >&2
  printf '\n' >&2
  if [[ -s "${log_file}" ]]; then
    printf '%s\n' '---- output (last 80 lines) ----' >&2
    tail -n 80 "${log_file}" >&2 || true
    printf '%s\n' '---- end output ----' >&2
  fi
  printf '%s\n' 'Re-run the installer with --verbose to show full command output.' >&2
}

run_captured() {
  local log_file status
  log_file="$(mktemp)"
  if env GIT_TERMINAL_PROMPT=0 NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false NPM_CONFIG_LOGLEVEL=error "$@" </dev/null >"${log_file}" 2>&1; then
    rm -f "${log_file}"
    return 0
  else
    status=$?
  fi

  print_command_failure "${status}" "${log_file}" "$@"
  rm -f "${log_file}"
  return "${status}"
}

run_captured_in_dir() {
  local dir="$1"
  shift

  local log_file status
  log_file="$(mktemp)"
  if (cd "${dir}" && env GIT_TERMINAL_PROMPT=0 NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false NPM_CONFIG_LOGLEVEL=error "$@") </dev/null >"${log_file}" 2>&1; then
    rm -f "${log_file}"
    return 0
  else
    status=$?
  fi

  printf 'command failed (exit %s, cwd %s): ' "${status}" "${dir}" >&2
  printf '%q ' "$@" >&2
  printf '\n' >&2
  if [[ -s "${log_file}" ]]; then
    printf '%s\n' '---- output (last 80 lines) ----' >&2
    tail -n 80 "${log_file}" >&2 || true
    printf '%s\n' '---- end output ----' >&2
  fi
  printf '%s\n' 'Re-run the installer with --verbose to show full command output.' >&2
  rm -f "${log_file}"
  return "${status}"
}

run() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    print_command "$@"
  elif [[ "${VERBOSE}" == "true" ]]; then
    "$@"
  else
    run_captured "$@"
  fi
}

run_in_dir() {
  local dir="$1"
  shift

  if [[ "${DRY_RUN}" == "true" ]]; then
    print_command bash -c "cd $(printf '%q' "${dir}") && $(printf '%q ' "$@")"
  elif [[ "${VERBOSE}" == "true" ]]; then
    (cd "${dir}" && "$@")
  else
    run_captured_in_dir "${dir}" "$@"
  fi
}

run_isolated_pi() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    print_command env "PI_CODING_AGENT_DIR=${AGENT_DIR}" "$@"
  elif [[ "${VERBOSE}" == "true" ]]; then
    assert_safe_settings_target
    (cd "${AGENT_DIR}" && PI_CODING_AGENT_DIR="${AGENT_DIR}" "$@")
  else
    assert_safe_settings_target
    run_captured_in_dir "${AGENT_DIR}" env "PI_CODING_AGENT_DIR=${AGENT_DIR}" "$@"
  fi
}

support_file_manifest() {
  # Fields: variable|required|relative path|temp filename|installed filename.
  # Leave installed filename empty for installer-only support files.
  cat <<'EOF_SUPPORT_FILES'
MERGE_SCRIPT|required|scripts/merge-settings.mjs|merge-settings.mjs|
TLH_DEFAULTS_SCRIPT|required|scripts/tlh-defaults.mjs|tlh-defaults.mjs|tlh-defaults.mjs
TLH_GNOSIS_SCRIPT|optional|scripts/tlh-gnosis.mjs|tlh-gnosis.mjs|tlh-gnosis.mjs
TLH_UPDATE_SCRIPT|optional|scripts/tlh-update.mjs|tlh-update.mjs|tlh-update.mjs
TLH_WRAPPER_SCRIPT|optional|scripts/tlh-wrapper.mjs|tlh-wrapper.mjs|tlh-wrapper.mjs
TLH_INSTALL_STATE_SCRIPT|optional|scripts/tlh-install-state.mjs|tlh-install-state.mjs|tlh-install-state.mjs
DEFAULTS_FILE|required|config/settings.defaults.json|settings.defaults.json|
DEFAULT_EXTENSIONS_FILE|required|config/default-extensions.json|default-extensions.json|default-extensions.json
EOF_SUPPORT_FILES
  if [[ "${NO_SETTINGS}" != "true" ]]; then
    cat <<'EOF_KEYBINDING_SUPPORT_FILES'
KEYBINDINGS_MERGE_SCRIPT|required|scripts/merge-keybindings.mjs|merge-keybindings.mjs|
KEYBINDINGS_DEFAULTS_FILE|required|config/keybindings.defaults.json|keybindings.defaults.json|
EOF_KEYBINDING_SUPPORT_FILES
  fi
}

support_file_dry_run_message() {
  case "$1" in
    TLH_GNOSIS_SCRIPT)
      printf '%s\n' "Would fetch Gnosis integration support files."
      ;;
    TLH_UPDATE_SCRIPT)
      printf '%s\n' "Would fetch tlh update support files."
      ;;
    TLH_WRAPPER_SCRIPT)
      printf '%s\n' "Would fetch tlh wrapper support files."
      ;;
    TLH_INSTALL_STATE_SCRIPT)
      printf '%s\n' "Would fetch tlh install-state support files."
      ;;
  esac
}

warn_missing_optional_support_file() {
  local var_name="$1"
  local relative_path="$2"
  case "${var_name}" in
    TLH_GNOSIS_SCRIPT)
      warn "Gnosis support script not found for ref ${REF}; continuing without tlh gnosis helper"
      ;;
    TLH_UPDATE_SCRIPT)
      warn "tlh update support script not found for ref ${REF}; the wrapper update helper will be unavailable"
      ;;
    TLH_WRAPPER_SCRIPT)
      warn "tlh wrapper support script not found for ref ${REF}; wrapper creation will be unavailable"
      ;;
    TLH_INSTALL_STATE_SCRIPT)
      warn "tlh install-state support script not found for ref ${REF}; update metadata helper will be unavailable"
      ;;
    *)
      warn "optional installer support file not found for ref ${REF}: ${relative_path}"
      ;;
  esac
}

reset_support_file_paths() {
  local var_name requirement relative_path tmp_name install_name
  while IFS='|' read -r var_name requirement relative_path tmp_name install_name; do
    [[ -n "${var_name}" ]] || continue
    printf -v "${var_name}" '%s' ""
  done <<< "$(support_file_manifest)"
}

support_file_paths_are_prepared() {
  local var_name requirement relative_path tmp_name install_name current_path
  while IFS='|' read -r var_name requirement relative_path tmp_name install_name; do
    [[ -n "${var_name}" ]] || continue
    current_path="${!var_name}"
    if [[ -n "${current_path}" ]]; then
      return 0
    fi
  done <<< "$(support_file_manifest)"
  return 1
}

installable_support_files_are_prepared() {
  local var_name requirement relative_path tmp_name install_name current_path
  while IFS='|' read -r var_name requirement relative_path tmp_name install_name; do
    [[ -n "${var_name}" && -n "${install_name}" ]] || continue
    current_path="${!var_name}"
    if [[ -n "${current_path}" ]]; then
      return 0
    fi
  done <<< "$(support_file_manifest)"
  return 1
}

local_repo_has_required_support_files() {
  local dir="$1"
  local var_name requirement relative_path tmp_name install_name
  while IFS='|' read -r var_name requirement relative_path tmp_name install_name; do
    [[ -n "${var_name}" ]] || continue
    if [[ "${requirement}" == "required" && ! -f "${dir}/${relative_path}" ]]; then
      return 1
    fi
  done <<< "$(support_file_manifest)"
  return 0
}

find_local_repo_dir() {
  local source_path="${BASH_SOURCE[0]:-}"
  if [[ -z "${source_path}" || ! -f "${source_path}" ]]; then
    return 1
  fi

  local dir
  dir="$(cd "$(dirname "${source_path}")" >/dev/null 2>&1 && pwd -P)" || return 1
  if local_repo_has_required_support_files "${dir}"; then
    printf '%s\n' "${dir}"
    return 0
  fi
  return 1
}

prepare_support_files_from_local_repo() {
  local local_dir="$1"
  local var_name requirement relative_path tmp_name install_name source_path
  while IFS='|' read -r var_name requirement relative_path tmp_name install_name; do
    [[ -n "${var_name}" ]] || continue
    source_path="${local_dir}/${relative_path}"
    if [[ -f "${source_path}" ]]; then
      printf -v "${var_name}" '%s' "${source_path}"
    elif [[ "${requirement}" == "required" ]]; then
      return 1
    else
      printf -v "${var_name}" '%s' ""
    fi
  done <<< "$(support_file_manifest)"
}

prepare_support_files_from_remote() {
  require_command curl
  TMP_DIR="$(mktemp -d)"

  local var_name requirement relative_path tmp_name install_name target_path
  verbose_log "Fetching installer support files from ${RAW_BASE}"
  while IFS='|' read -r var_name requirement relative_path tmp_name install_name; do
    [[ -n "${var_name}" ]] || continue
    target_path="${TMP_DIR}/${tmp_name}"
    printf -v "${var_name}" '%s' "${target_path}"
    if [[ "${requirement}" == "required" ]]; then
      if ! curl -fsSL "${RAW_BASE}/${relative_path}" -o "${target_path}"; then
        die "required installer support file not found for ref ${REF}: ${relative_path}"
      fi
    elif ! curl -fsSL "${RAW_BASE}/${relative_path}" -o "${target_path}"; then
      rm -f "${target_path}"
      printf -v "${var_name}" '%s' ""
      warn_missing_optional_support_file "${var_name}" "${relative_path}"
    fi
  done <<< "$(support_file_manifest)"

  if settings_require_tlh_subagent_prompts; then
    mkdir -p "${TMP_DIR}/agents/subagents"
    local prompt
    for prompt in "${TLH_SUBAGENT_PROMPTS[@]}"; do
      if ! curl -fsSL "${RAW_BASE}/agents/subagents/${prompt}" -o "${TMP_DIR}/agents/subagents/${prompt}"; then
        warn "TLH subagent prompt not found in raw support files: ${prompt}; will try the installed package checkout."
        rm -f "${TMP_DIR}/agents/subagents/${prompt}"
      fi
    done
  fi
}

prepare_merge_files() {
  local local_dir=""
  reset_support_file_paths
  if local_dir="$(find_local_repo_dir)"; then
    prepare_support_files_from_local_repo "${local_dir}"
    return $?
  fi

  prepare_support_files_from_remote
}

prepare_merge_files_for_dry_run() {
  local local_dir=""
  reset_support_file_paths
  if local_dir="$(find_local_repo_dir)"; then
    prepare_support_files_from_local_repo "${local_dir}"
    return $?
  fi

  if [[ "${SUPPORT_FILES_DRY_RUN_SKIPPED}" == "true" ]]; then
    return 1
  fi
  SUPPORT_FILES_DRY_RUN_SKIPPED=true

  log "Would fetch installer support files from ${RAW_BASE}"
  if [[ "${NO_SETTINGS}" == "true" ]]; then
    log "Would skip settings and keybinding defaults merge (--no-settings)."
    log "Would skip bundled default extension packages (--no-settings)."
  else
    log "Would merge settings defaults into: ${SETTINGS_PATH}"
    log "Would merge keybinding defaults into: ${KEYBINDINGS_PATH}"
    log "Would install bundled default extension packages after settings merge."
  fi
  local var_name requirement relative_path tmp_name install_name dry_run_message
  while IFS='|' read -r var_name requirement relative_path tmp_name install_name; do
    [[ -n "${var_name}" ]] || continue
    dry_run_message="$(support_file_dry_run_message "${var_name}")"
    if [[ -n "${dry_run_message}" ]]; then
      log "${dry_run_message}"
    fi
  done <<< "$(support_file_manifest)"
  log "Dry run only; no support files were downloaded."
  return 1
}

ensure_support_files_prepared() {
  if support_file_paths_are_prepared; then
    return 0
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    prepare_merge_files_for_dry_run
    return $?
  fi
  prepare_merge_files
}

preflight_runtime_support_files() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    return 0
  fi

  ensure_support_files_prepared || die "installer support files are unavailable for ref ${REF}"

  local missing=()
  if [[ -z "${TLH_INSTALL_STATE_SCRIPT}" || ! -f "${TLH_INSTALL_STATE_SCRIPT}" ]]; then
    missing+=("scripts/tlh-install-state.mjs")
  fi
  if [[ "${NO_WRAPPER}" != "true" && ( -z "${TLH_WRAPPER_SCRIPT}" || ! -f "${TLH_WRAPPER_SCRIPT}" ) ]]; then
    missing+=("scripts/tlh-wrapper.mjs")
  fi

  if (( ${#missing[@]} > 0 )); then
    die "required installer support files not found for ref ${REF}: ${missing[*]}"
  fi
}

install_pi_if_needed() {
  if command_exists pi; then
    verbose_log "Pi is already installed: $(command -v pi)"
    return 0
  fi

  if [[ "${NO_PI_INSTALL}" == "true" ]]; then
    die "pi is not installed and --no-pi-install was provided"
  fi

  log "Installing Pi runtime..."
  run npm install -g @earendil-works/pi-coding-agent
  hash -r || true

  if [[ "${DRY_RUN}" != "true" ]] && ! command_exists pi; then
    die "Pi install completed, but the pi command is still not on PATH"
  fi
}

backup_existing_settings_before_pi_install() {
  assert_safe_settings_target
  if [[ ! -f "${SETTINGS_PATH}" ]]; then
    return 0
  fi

  local backup_path="${SETTINGS_PATH}.backup-before-install-$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "Would back up existing isolated settings to: ${backup_path}"
    return 0
  fi

  if [[ -e "${backup_path}" || -L "${backup_path}" ]]; then
    die "refusing to overwrite existing settings backup: ${backup_path}"
  fi
  cp -p "${SETTINGS_PATH}" "${backup_path}"
  detail_log "Backed up existing isolated settings to: ${backup_path}"
}

refresh_harness_package_checkout() {
  local package_root="${AGENT_DIR}/git/github.com/${REPO}"
  local package_repo=""
  local package_ref="${REF}"
  local package_spec parsed_package_root
  package_spec="$(critical_git_source_spec "${PACKAGE_SOURCE}")" || return $?
  if [[ -n "${package_spec}" ]]; then
    IFS=$'\t' read -r parsed_package_root package_repo package_ref <<< "${package_spec}"
    package_root="${parsed_package_root}"
  fi
  if [[ "${PACKAGE_SOURCE_IS_DEFAULT}" == "true" ]]; then
    package_ref="${package_ref:-${REF}}"
  elif [[ -z "${package_spec}" || -z "${package_ref}" ]]; then
    return 0
  fi

  verbose_log "Checking out The Last Harness git ref: ${package_ref}"
  if [[ "${DRY_RUN}" == "true" ]]; then
    if [[ -n "${package_repo}" ]]; then
      print_command git -C "${package_root}" remote set-url origin "${package_repo}"
    fi
    print_command git -C "${package_root}" fetch --prune --tags origin
    log "Would prefer tag ${package_ref}, then origin/${package_ref}, then ${package_ref}."
    print_command git -C "${package_root}" checkout --detach "<resolved-ref>"
    print_command git -C "${package_root}" reset --hard "<resolved-ref>"
    print_command git -C "${package_root}" clean -fdx
    log "Would run npm install --omit=dev --legacy-peer-deps --package-lock=false if package.json is present."
    return 0
  fi

  if ! safe_git_checkout_dir_for_mutation "${package_root}" "The Last Harness package checkout"; then
    die "expected installed package checkout not found or invalid: ${package_root}"
  fi

  if [[ -n "${package_repo}" ]]; then
    if git -C "${package_root}" remote get-url origin >/dev/null 2>&1; then
      run git -C "${package_root}" remote set-url origin "${package_repo}"
    else
      run git -C "${package_root}" remote add origin "${package_repo}"
    fi
  fi
  run git -C "${package_root}" fetch --prune --tags origin

  local target_ref="${package_ref}"
  if git -C "${package_root}" rev-parse --verify --quiet "refs/tags/${package_ref}^{commit}" >/dev/null; then
    target_ref="refs/tags/${package_ref}^{commit}"
  elif git -C "${package_root}" rev-parse --verify --quiet "refs/remotes/origin/${package_ref}^{commit}" >/dev/null; then
    target_ref="refs/remotes/origin/${package_ref}"
  fi

  run git -C "${package_root}" checkout --detach "${target_ref}"
  run git -C "${package_root}" reset --hard "${target_ref}"
  run git -C "${package_root}" clean -fdx

  if [[ -f "${package_root}/package.json" ]]; then
    run_in_dir "${package_root}" npm install --omit=dev --legacy-peer-deps --package-lock=false
  fi
}

install_harness_package() {
  verbose_log "Using isolated Pi agent dir: ${AGENT_DIR}"
  run mkdir -p "${AGENT_DIR}"
  backup_existing_settings_before_pi_install

  log "Installing The Last Harness package..."
  verbose_log "Package source: ${PACKAGE_SOURCE}"
  local install_source
  install_source="$(git_source_install_source "${PACKAGE_SOURCE}")" || return $?
  assert_git_source_target_safe "${PACKAGE_SOURCE}" "The Last Harness package checkout"
  run_isolated_pi pi install "${install_source}"
  refresh_harness_package_checkout

  if [[ "${PACKAGE_SOURCE_IS_DEFAULT}" == "true" ]]; then
    return 0
  fi

  local package_spec package_root package_repo package_ref
  package_spec="$(critical_git_source_spec "${PACKAGE_SOURCE}")" || return $?
  if [[ -n "${package_spec}" ]]; then
    IFS=$'\t' read -r package_root package_repo package_ref <<< "${package_spec}"
    if [[ -n "${package_ref}" ]]; then
      verbose_log "Pinned custom git package source was refreshed directly; skipping pi update."
      return 0
    fi
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    log "Would refresh custom package source if it is already installed: PI_CODING_AGENT_DIR=${AGENT_DIR} pi update ${PACKAGE_SOURCE}"
    return 0
  fi

  if ! run_isolated_pi pi update "${PACKAGE_SOURCE}"; then
    die "package update failed for custom package source: ${PACKAGE_SOURCE}"
  fi
}

merge_settings() {
  if [[ "${NO_SETTINGS}" == "true" ]]; then
    log "Skipping settings/keybinding merge (--no-settings)."
    return 0
  fi

  if ! ensure_support_files_prepared; then
    return 0
  fi

  local args=(
    "${MERGE_SCRIPT}"
    "${DEFAULTS_FILE}"
    "--settings"
    "${SETTINGS_PATH}"
    "--package-source"
    "${PACKAGE_SOURCE}"
  )
  if [[ -n "${DEFAULT_EXTENSIONS_FILE}" ]]; then
    args+=("--default-extensions" "${DEFAULT_EXTENSIONS_FILE}")
  fi
  if [[ "${DRY_RUN}" == "true" ]]; then
    args+=("--dry-run")
  fi
  if [[ "${FORCE}" == "true" ]]; then
    args+=("--force")
  fi
  if [[ "${QUIET}" == "true" ]]; then
    args+=("--quiet")
  elif [[ "${VERBOSE}" != "true" && "${DRY_RUN}" != "true" ]]; then
    args+=("--quiet")
  fi

  log "Applying isolated settings..."
  verbose_log "Settings path: ${SETTINGS_PATH}"
  node "${args[@]}"

  if [[ -z "${KEYBINDINGS_MERGE_SCRIPT}" || -z "${KEYBINDINGS_DEFAULTS_FILE}" ]]; then
    return 0
  fi

  local keybinding_args=(
    "${KEYBINDINGS_MERGE_SCRIPT}"
    "${KEYBINDINGS_DEFAULTS_FILE}"
    "--keybindings"
    "${KEYBINDINGS_PATH}"
  )
  if [[ "${DRY_RUN}" == "true" ]]; then
    keybinding_args+=("--dry-run")
  fi
  if [[ "${QUIET}" == "true" ]]; then
    keybinding_args+=("--quiet")
  elif [[ "${VERBOSE}" != "true" && "${DRY_RUN}" != "true" ]]; then
    keybinding_args+=("--quiet")
  fi

  log "Applying isolated keybindings..."
  verbose_log "Keybindings path: ${KEYBINDINGS_PATH}"
  node "${keybinding_args[@]}"
}

package_source_install_dir() {
  local spec target_dir repo ref
  spec="$(critical_git_source_spec "${PACKAGE_SOURCE}")" || return $?
  if [[ -n "${spec}" ]]; then
    IFS=$'\t' read -r target_dir repo ref <<< "${spec}"
    printf '%s\n' "${target_dir}"
    return 0
  fi

  TLH_AGENT_DIR="${AGENT_DIR}" TLH_PACKAGE_SOURCE_VALUE="${PACKAGE_SOURCE}" node <<'NODE'
const path = require('node:path');

function splitRef(url) {
  const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    const refSeparator = (scpLikeMatch[2] || '').indexOf('@');
    if (refSeparator < 0) return { repo: url };
    const repoPath = (scpLikeMatch[2] || '').slice(0, refSeparator);
    const ref = (scpLikeMatch[2] || '').slice(refSeparator + 1);
    if (!repoPath || !ref) return { repo: url };
    return { repo: `git@${scpLikeMatch[1] || ''}:${repoPath}`, ref };
  }
  if (url.includes('://')) {
    try {
      const parsed = new URL(url);
      const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, '');
      const refSeparator = pathWithMaybeRef.indexOf('@');
      if (refSeparator < 0) return { repo: url };
      const repoPath = pathWithMaybeRef.slice(0, refSeparator);
      const ref = pathWithMaybeRef.slice(refSeparator + 1);
      if (!repoPath || !ref) return { repo: url };
      parsed.pathname = `/${repoPath}`;
      return { repo: parsed.toString().replace(/\/$/, ''), ref };
    } catch {
      return { repo: url };
    }
  }
  const slashIndex = url.indexOf('/');
  if (slashIndex < 0) return { repo: url };
  const host = url.slice(0, slashIndex);
  const pathWithMaybeRef = url.slice(slashIndex + 1);
  const refSeparator = pathWithMaybeRef.indexOf('@');
  if (refSeparator < 0) return { repo: url };
  const repoPath = pathWithMaybeRef.slice(0, refSeparator);
  const ref = pathWithMaybeRef.slice(refSeparator + 1);
  if (!repoPath || !ref) return { repo: url };
  return { repo: `${host}/${repoPath}`, ref };
}

function parseGitSource(source) {
  const trimmed = source.trim();
  const hasGitPrefix = trimmed.startsWith('git:');
  const url = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;
  if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url) && !url.startsWith('git@')) return undefined;

  const { repo: repoWithoutRef } = splitRef(url);
  let host = '';
  let repoPath = '';
  const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    host = scpLikeMatch[1] || '';
    repoPath = scpLikeMatch[2] || '';
  } else if (/^(https?|ssh|git):\/\//i.test(repoWithoutRef)) {
    try {
      const parsed = new URL(repoWithoutRef);
      host = parsed.hostname;
      repoPath = parsed.pathname.replace(/^\/+/, '');
    } catch {
      return undefined;
    }
  } else {
    const slashIndex = repoWithoutRef.indexOf('/');
    if (slashIndex < 0) return undefined;
    host = repoWithoutRef.slice(0, slashIndex);
    repoPath = repoWithoutRef.slice(slashIndex + 1);
    if (!host.includes('.') && host !== 'localhost') return undefined;
  }

  const normalizedPath = repoPath.replace(/\.git$/, '').replace(/^\/+/, '');
  if (!host || !normalizedPath || normalizedPath.split('/').length < 2) return undefined;
  return { host, path: normalizedPath };
}

function isLocalSource(source) {
  const trimmed = source.trim();
  return !trimmed.startsWith('npm:') && !trimmed.startsWith('git:') && !trimmed.startsWith('github:') && !trimmed.startsWith('http:') && !trimmed.startsWith('https:') && !trimmed.startsWith('ssh:');
}

function resolveLocalSource(source, agentDir) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (source === '~' && home) return home;
  if (source.startsWith('~/') && home) return path.join(home, source.slice(2));
  if (source.startsWith('~') && home) return path.join(home, source.slice(1));
  return path.resolve(agentDir, source);
}

const source = process.env.TLH_PACKAGE_SOURCE_VALUE || '';
const agentDir = process.env.TLH_AGENT_DIR || '';
const parsed = parseGitSource(source);
if (parsed) {
  console.log(path.join(agentDir, 'git', parsed.host, parsed.path));
} else if (source.trim() && isLocalSource(source)) {
  console.log(resolveLocalSource(source.trim(), agentDir));
}
NODE
}

tlh_subagent_prompts_complete() {
  local dir="$1"
  local missing=""
  [[ -d "${dir}" ]] || return 1
  missing="$(missing_tlh_subagent_prompts "${dir}")"
  [[ -z "${missing}" ]]
}

settings_require_tlh_subagent_prompts() {
  [[ "${NO_SETTINGS}" != "true" ]] || return 1
  [[ -n "${DEFAULTS_FILE}" && -f "${DEFAULTS_FILE}" ]] || return 1
  TLH_DEFAULTS_FILE="${DEFAULTS_FILE}" node <<'NODE'
const fs = require('node:fs');

try {
  const settings = JSON.parse(fs.readFileSync(process.env.TLH_DEFAULTS_FILE, 'utf8'));
  const agentDirs = settings?.subagents?.agentDirs;
  if (Array.isArray(agentDirs) && agentDirs.includes('tlh/agents/subagents')) {
    process.exit(0);
  }
} catch {
  // Invalid defaults are handled later by the settings merge.
}
process.exit(1);
NODE
}

default_extensions_require_critical_install() {
  [[ "${NO_SETTINGS}" != "true" ]] || return 1
  [[ -n "${DEFAULT_EXTENSIONS_FILE}" && -f "${DEFAULT_EXTENSIONS_FILE}" ]] || return 1
  TLH_DEFAULT_EXTENSIONS_FILE="${DEFAULT_EXTENSIONS_FILE}" node <<'NODE'
const fs = require('node:fs');

try {
  const defaults = JSON.parse(fs.readFileSync(process.env.TLH_DEFAULT_EXTENSIONS_FILE, 'utf8'));
  if (Array.isArray(defaults) && defaults.some((extension) => extension && extension.critical === true)) {
    process.exit(0);
  }
} catch {
  // Invalid defaults are handled later by the settings/default-extension commands.
}
process.exit(1);
NODE
}

find_tlh_subagents_dir() {
  local local_dir=""
  local package_root=""

  if [[ "${PACKAGE_SOURCE_IS_DEFAULT}" != "true" ]]; then
    package_root="$(package_source_install_dir || true)"
    if [[ -n "${package_root}" ]] && tlh_subagent_prompts_complete "${package_root}/agents/subagents"; then
      printf '%s\n' "${package_root}/agents/subagents"
      return 0
    fi
  fi

  if local_dir="$(find_local_repo_dir)" && tlh_subagent_prompts_complete "${local_dir}/agents/subagents"; then
    printf '%s\n' "${local_dir}/agents/subagents"
    return 0
  fi

  if [[ "${PACKAGE_SOURCE_IS_DEFAULT}" == "true" ]]; then
    package_root="$(package_source_install_dir || true)"
    if [[ -n "${package_root}" ]] && tlh_subagent_prompts_complete "${package_root}/agents/subagents"; then
      printf '%s\n' "${package_root}/agents/subagents"
      return 0
    fi
  fi

  if [[ -n "${TMP_DIR}" ]] && tlh_subagent_prompts_complete "${TMP_DIR}/agents/subagents"; then
    printf '%s\n' "${TMP_DIR}/agents/subagents"
    return 0
  fi

  package_root="${AGENT_DIR}/git/github.com/${REPO}"
  if tlh_subagent_prompts_complete "${package_root}/agents/subagents"; then
    printf '%s\n' "${package_root}/agents/subagents"
    return 0
  fi

  return 1
}

missing_tlh_subagent_prompts() {
  local dir="$1"
  local prompt
  local missing=()

  for prompt in "${TLH_SUBAGENT_PROMPTS[@]}"; do
    if [[ ! -f "${dir}/${prompt}" ]]; then
      missing+=("${prompt}")
    fi
  done

  if [[ "${#missing[@]}" -gt 0 ]]; then
    printf '%s' "${missing[*]}"
  fi
}

copy_tlh_subagent_prompts() {
  local source_dir="$1"
  local prompt
  local support_subagents_dir

  support_subagents_dir="$(ensure_safe_profile_dir "tlh/agents/subagents" "TLH subagent prompt directory")" || return $?
  for prompt in "${TLH_SUBAGENT_PROMPTS[@]}"; do
    copy_safe_profile_file "${source_dir}/${prompt}" "tlh/agents/subagents/${prompt}" "TLH subagent prompt ${prompt}" || return $?
  done
  printf '%s\n' "${support_subagents_dir}"
}

install_support_files() {
  if ! installable_support_files_are_prepared; then
    ensure_support_files_prepared || return 0
  fi
  if ! installable_support_files_are_prepared; then
    return 0
  fi

  local support_dir="${AGENT_DIR}/tlh"
  local support_subagents_dir="${support_dir}/agents/subagents"
  local subagents_src=""
  local var_name requirement relative_path tmp_name install_name source_path
  local require_subagent_prompts="false"
  if settings_require_tlh_subagent_prompts; then
    require_subagent_prompts="true"
    subagents_src="$(find_tlh_subagents_dir || true)"
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    print_command mkdir -p "${support_dir}"
    while IFS='|' read -r var_name requirement relative_path tmp_name install_name; do
      [[ -n "${var_name}" && -n "${install_name}" ]] || continue
      source_path="${!var_name}"
      [[ -n "${source_path}" ]] || continue
      print_command cp "${source_path}" "${support_dir}/${install_name}"
    done <<< "$(support_file_manifest)"
    if [[ "${require_subagent_prompts}" == "true" ]]; then
      if [[ -n "${subagents_src}" ]]; then
        local prompt
        print_command mkdir -p "${support_subagents_dir}"
        for prompt in "${TLH_SUBAGENT_PROMPTS[@]}"; do
          print_command cp "${subagents_src}/${prompt}" "${support_subagents_dir}/${prompt}"
        done
      else
        log "Would require TLH subagent prompts before enabling bundled subagents in settings."
      fi
    else
      log "Would skip TLH subagent prompts because this ref does not enable bundled subagents in settings."
    fi
    return 0
  fi

  support_dir="$(ensure_safe_profile_dir "tlh" "TLH support directory")" || return $?
  while IFS='|' read -r var_name requirement relative_path tmp_name install_name; do
    [[ -n "${var_name}" && -n "${install_name}" ]] || continue
    source_path="${!var_name}"
    [[ -n "${source_path}" ]] || continue
    copy_safe_profile_file "${source_path}" "tlh/${install_name}" "TLH support file ${install_name}"
  done <<< "$(support_file_manifest)"
  if [[ "${require_subagent_prompts}" != "true" ]]; then
    return 0
  fi

  if [[ -n "${subagents_src}" ]]; then
    local missing_prompts=""
    missing_prompts="$(missing_tlh_subagent_prompts "${subagents_src}")"
    if [[ -n "${missing_prompts}" ]]; then
      die "TLH subagent prompts are incomplete (${missing_prompts}); re-run installer from a complete checkout or package."
    fi

    support_subagents_dir="$(copy_tlh_subagent_prompts "${subagents_src}")" || return $?

    missing_prompts="$(missing_tlh_subagent_prompts "${support_subagents_dir}")"
    if [[ -n "${missing_prompts}" ]]; then
      die "failed to install TLH subagent prompts (${missing_prompts}); re-run installer from a complete checkout or package."
    fi
  else
    die "TLH subagent prompts not found; re-run installer from a complete checkout or package."
  fi
}

write_install_state() {
  local support_dir="${AGENT_DIR}/tlh"
  local state_path="${support_dir}/install-state.json"

  if [[ -z "${TLH_INSTALL_STATE_SCRIPT}" || ! -f "${TLH_INSTALL_STATE_SCRIPT}" ]]; then
    if ! ensure_support_files_prepared; then
      if [[ "${DRY_RUN}" == "true" ]]; then
        log "Would write tlh update metadata: ${state_path}"
        return 0
      fi
      die "install-state support files are unavailable for ref ${REF}"
    fi
  fi

  if [[ -z "${TLH_INSTALL_STATE_SCRIPT}" || ! -f "${TLH_INSTALL_STATE_SCRIPT}" ]]; then
    if [[ "${DRY_RUN}" == "true" ]]; then
      log "Would write tlh update metadata: ${state_path}"
      return 0
    fi
    die "install-state support script not found for ref ${REF}; re-run the installer from a release that includes scripts/tlh-install-state.mjs"
  fi

  local args=(
    "${TLH_INSTALL_STATE_SCRIPT}"
    "--state-path"
    "${state_path}"
    "--repo"
    "${REPO}"
    "--ref"
    "${REF}"
    "--track"
    "${UPDATE_TRACK}"
    "--package-source"
    "${PACKAGE_SOURCE}"
    "--package-source-is-default"
    "${PACKAGE_SOURCE_IS_DEFAULT}"
    "--raw-base"
    "${RAW_BASE}"
    "--agent-dir"
    "${AGENT_DIR}"
    "--bin-dir"
    "${BIN_DIR}"
    "--wrapper-name"
    "${WRAPPER_NAME}"
  )
  if [[ "${DRY_RUN}" == "true" ]]; then
    args+=("--dry-run")
  fi
  if [[ "${QUIET}" == "true" ]]; then
    args+=("--quiet")
  fi

  node "${args[@]}"
}

line_in_output() {
  local candidate="$1"
  local output="$2"
  [[ -n "${output}" ]] && grep -Fxq -- "${candidate}" <<< "${output}"
}

critical_git_source_spec() {
  TLH_CRITICAL_SOURCE="$1" TLH_AGENT_DIR="${AGENT_DIR}" node <<'NODE'
const path = require('node:path');

function splitRef(url) {
  const hashSeparator = url.lastIndexOf('#');
  if (hashSeparator >= 0) {
    const repo = url.slice(0, hashSeparator);
    const ref = url.slice(hashSeparator + 1);
    if (repo && ref) return { repo, ref };
  }

  const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    const pathWithMaybeRef = scpLikeMatch[2] || '';
    const refSeparator = pathWithMaybeRef.indexOf('@');
    if (refSeparator < 0) return { repo: url };
    const repoPath = pathWithMaybeRef.slice(0, refSeparator);
    const ref = pathWithMaybeRef.slice(refSeparator + 1);
    if (!repoPath || !ref) return { repo: url };
    return { repo: `git@${scpLikeMatch[1] || ''}:${repoPath}`, ref };
  }

  if (url.includes('://')) {
    try {
      const parsed = new URL(url);
      const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, '');
      const refSeparator = pathWithMaybeRef.indexOf('@');
      if (refSeparator < 0) return { repo: url };
      const repoPath = pathWithMaybeRef.slice(0, refSeparator);
      const ref = pathWithMaybeRef.slice(refSeparator + 1);
      if (!repoPath || !ref) return { repo: url };
      parsed.pathname = `/${repoPath}`;
      return { repo: parsed.toString().replace(/\/$/, ''), ref };
    } catch {
      return { repo: url };
    }
  }

  const slashIndex = url.indexOf('/');
  if (slashIndex < 0) return { repo: url };
  const host = url.slice(0, slashIndex);
  const pathWithMaybeRef = url.slice(slashIndex + 1);
  const refSeparator = pathWithMaybeRef.indexOf('@');
  if (refSeparator < 0) return { repo: url };
  const repoPath = pathWithMaybeRef.slice(0, refSeparator);
  const ref = pathWithMaybeRef.slice(refSeparator + 1);
  if (!repoPath || !ref) return { repo: url };
  return { repo: `${host}/${repoPath}`, ref };
}

function parseGitSource(source) {
  const trimmed = source.trim();
  const hasGitPrefix = trimmed.startsWith('git:');
  const url = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;
  if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url) && !url.startsWith('git@')) return undefined;

  const { repo: repoWithoutRef, ref } = splitRef(url);
  let repo = repoWithoutRef;
  let host = '';
  let repoPath = '';
  const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    host = scpLikeMatch[1] || '';
    repoPath = scpLikeMatch[2] || '';
  } else if (/^(https?|ssh|git):\/\//i.test(repoWithoutRef)) {
    try {
      const parsed = new URL(repoWithoutRef);
      host = parsed.hostname;
      repoPath = parsed.pathname.replace(/^\/+/, '');
    } catch {
      return undefined;
    }
  } else {
    const slashIndex = repoWithoutRef.indexOf('/');
    if (slashIndex < 0) return undefined;
    host = repoWithoutRef.slice(0, slashIndex);
    repoPath = repoWithoutRef.slice(slashIndex + 1);
    if (!host.includes('.') && host !== 'localhost') return undefined;
    repo = `https://${repoWithoutRef}`;
  }

  const normalizedPath = repoPath.replace(/\.git$/, '').replace(/^\/+/, '');
  if (!host || !normalizedPath || normalizedPath.split('/').length < 2) return undefined;
  return { repo, host, path: normalizedPath, ref };
}

const parsed = parseGitSource(process.env.TLH_CRITICAL_SOURCE || '');
if (!parsed) process.exit(0);
console.log(`${path.join(process.env.TLH_AGENT_DIR || '', 'git', parsed.host, parsed.path)}\t${parsed.repo}\t${parsed.ref || ''}`);
NODE
}

git_source_install_source() {
  local source="$1"
  local spec target_dir repo ref

  spec="$(critical_git_source_spec "${source}")" || return $?
  if [[ -n "${spec}" && "${source}" == *"#"* ]]; then
    IFS=$'\t' read -r target_dir repo ref <<< "${spec}"
    if [[ -n "${repo}" && -n "${ref}" ]]; then
      printf 'git:%s@%s\n' "${repo}" "${ref}"
      return 0
    fi
  fi

  printf '%s\n' "${source}"
}

assert_git_repository_confined() {
  local target_dir="$1"
  local label="${2:-git package checkout}"
  local top_level git_dir common_git_dir
  local normalized_target normalized_top

  top_level="$(git -C "${target_dir}" rev-parse --show-toplevel 2>/dev/null)" || die "refusing to use invalid ${label}: ${target_dir}"
  git_dir="$(git -C "${target_dir}" rev-parse --absolute-git-dir 2>/dev/null)" || die "refusing to use invalid ${label} git metadata: ${target_dir}"
  common_git_dir="$(git -C "${target_dir}" rev-parse --git-common-dir 2>/dev/null)" || die "refusing to use invalid ${label} common git metadata: ${target_dir}"
  case "${common_git_dir}" in
    /*) ;;
    *) common_git_dir="${target_dir}/${common_git_dir}" ;;
  esac

  normalized_target="$(normalize_path_for_compare "${target_dir}")" || return $?
  normalized_top="$(normalize_path_for_compare "${top_level}")" || return $?
  if [[ "${normalized_top}" != "${normalized_target}" ]]; then
    die "refusing to use ${label} with worktree outside the package path: ${target_dir}"
  fi

  assert_profile_path_within_agent "${git_dir}" "${label} git metadata" || return $?
  assert_profile_path_within_agent "${common_git_dir}" "${label} common git metadata" || return $?
}

assert_git_source_target_safe() {
  local source="$1"
  local label="${2:-git package checkout}"
  local spec target_dir repo ref

  spec="$(critical_git_source_spec "${source}")" || return $?
  [[ -n "${spec}" ]] || return 0
  IFS=$'\t' read -r target_dir repo ref <<< "${spec}"

  assert_profile_path_within_agent "${target_dir}" "${label}" || return $?
  if [[ -L "${target_dir}" ]]; then
    die "refusing to use symlinked ${label}: ${target_dir}"
  fi
  if [[ -e "${target_dir}" && ! -d "${target_dir}" ]]; then
    die "refusing to use non-directory ${label}: ${target_dir}"
  fi
  if [[ -d "${target_dir}" && ! -e "${target_dir}/.git" ]]; then
    die "refusing to use existing non-git ${label}: ${target_dir}"
  fi
  if [[ -L "${target_dir}/.git" ]]; then
    die "refusing to use ${label} with symlinked git metadata: ${target_dir}/.git"
  fi
  if [[ -e "${target_dir}/.git" && ! -d "${target_dir}/.git" && ! -f "${target_dir}/.git" ]]; then
    die "refusing to use ${label} with unsupported git metadata: ${target_dir}/.git"
  fi
  if [[ -e "${target_dir}/.git" ]]; then
    assert_profile_path_within_agent "${target_dir}/.git" "${label} git metadata" || return $?
    assert_git_repository_confined "${target_dir}" "${label}" || return $?
  fi
}

safe_git_checkout_dir_for_mutation() {
  local target_dir="$1"
  local label="${2:-git package checkout}"

  assert_profile_path_within_agent "${target_dir}" "${label}" || return $?
  if [[ -L "${target_dir}" ]]; then
    die "refusing to mutate symlinked ${label}: ${target_dir}"
  fi
  if [[ ! -d "${target_dir}" ]]; then
    return 1
  fi
  if [[ -L "${target_dir}/.git" ]]; then
    die "refusing to mutate ${label} with symlinked git metadata: ${target_dir}/.git"
  fi
  if [[ ! -e "${target_dir}/.git" ]]; then
    return 1
  fi
  if [[ ! -d "${target_dir}/.git" && ! -f "${target_dir}/.git" ]]; then
    return 1
  fi
  assert_profile_path_within_agent "${target_dir}/.git" "${label} git metadata" || return $?
  assert_git_repository_confined "${target_dir}" "${label}" || return $?
}

ensure_critical_git_source_checkout() {
  local source="$1"
  local spec target_dir repo ref target_ref

  spec="$(critical_git_source_spec "${source}")" || return $?
  [[ -n "${spec}" ]] || return 0
  IFS=$'\t' read -r target_dir repo ref <<< "${spec}"
  assert_git_source_target_safe "${source}" "critical git extension checkout" || return $?
  [[ -n "${ref}" ]] || return 0

  if [[ "${DRY_RUN}" == "true" ]]; then
    print_command git -C "${target_dir}" remote set-url origin "${repo}"
    print_command git -C "${target_dir}" fetch --prune --tags origin
    log "Would prefer tag ${ref}, then origin/${ref}, then ${ref}."
    print_command git -C "${target_dir}" checkout --detach "<resolved-ref>"
    print_command git -C "${target_dir}" reset --hard "<resolved-ref>"
    print_command git -C "${target_dir}" clean -fdx
    log "Would run npm install --omit=dev --legacy-peer-deps --package-lock=false if package.json is present."
    return 0
  fi

  if ! safe_git_checkout_dir_for_mutation "${target_dir}" "critical git extension checkout"; then
    warn "critical git extension checkout is missing or invalid: ${target_dir}"
    return 1
  fi

  if git -C "${target_dir}" remote get-url origin >/dev/null 2>&1; then
    run git -C "${target_dir}" remote set-url origin "${repo}" || return $?
  else
    run git -C "${target_dir}" remote add origin "${repo}" || return $?
  fi
  run git -C "${target_dir}" fetch --prune --tags origin || return $?

  target_ref="${ref}"
  if git -C "${target_dir}" rev-parse --verify --quiet "refs/tags/${ref}^{commit}" >/dev/null; then
    target_ref="refs/tags/${ref}^{commit}"
  elif git -C "${target_dir}" rev-parse --verify --quiet "refs/remotes/origin/${ref}^{commit}" >/dev/null; then
    target_ref="refs/remotes/origin/${ref}"
  fi

  run git -C "${target_dir}" checkout --detach "${target_ref}" || return $?
  run git -C "${target_dir}" reset --hard "${target_ref}" || return $?
  run git -C "${target_dir}" clean -fdx || return $?
  if [[ -f "${target_dir}/package.json" ]]; then
    run_in_dir "${target_dir}" npm install --omit=dev --legacy-peer-deps --package-lock=false || return $?
  fi
  return 0
}

install_default_extensions() {
  if [[ "${NO_SETTINGS}" == "true" ]]; then
    log "Skipping bundled default extensions (--no-settings)."
    return 0
  fi
  if [[ -z "${TLH_DEFAULTS_SCRIPT}" || -z "${DEFAULT_EXTENSIONS_FILE}" ]]; then
    if [[ "${DRY_RUN}" == "true" ]]; then
      log "Would install bundled default extension packages after settings merge."
    fi
    return 0
  fi

  local sources_output critical_sources_output
  if ! sources_output="$(node "${TLH_DEFAULTS_SCRIPT}" --settings "${SETTINGS_PATH}" --defaults "${DEFAULT_EXTENSIONS_FILE}" sources)"; then
    die "failed to read bundled default extension sources"
  fi
  if ! critical_sources_output="$(node "${TLH_DEFAULTS_SCRIPT}" --settings "${SETTINGS_PATH}" --defaults "${DEFAULT_EXTENSIONS_FILE}" critical-sources)"; then
    if default_extensions_require_critical_install; then
      die "failed to read critical bundled default extension sources"
    fi
    warn "installed default-extension helper does not support critical source queries; treating this ref as having no critical defaults."
    critical_sources_output=""
  fi
  if [[ -z "${sources_output}" ]]; then
    log "No bundled default extensions are enabled."
    return 0
  fi

  local extension_count failures source
  extension_count="$(printf '%s\n' "${sources_output}" | grep -cve '^[[:space:]]*$' || true)"
  failures=0
  log "Installing bundled default extensions (${extension_count})..."
  while IFS= read -r source; do
    [[ -n "${source}" ]] || continue
    verbose_log "Installing bundled default extension package: ${source}"
    if line_in_output "${source}" "${critical_sources_output}"; then
      local install_source
      install_source="$(git_source_install_source "${source}")" || return $?
      assert_git_source_target_safe "${source}" "critical default extension package checkout"
      if ! run_isolated_pi pi install "${install_source}"; then
        die "critical default extension package install failed: ${source}. Fix the package install and rerun the installer; this isolation-critical default cannot be disabled."
      fi
      if ! ensure_critical_git_source_checkout "${source}"; then
        die "critical default extension package checkout validation failed: ${source}. Fix the package checkout and rerun the installer; this isolation-critical default cannot be disabled."
      fi
      continue
    fi
    if ! run_isolated_pi pi update --extension "${source}"; then
      warn "default extension package update failed; continuing: ${source}"
      failures=$((failures + 1))
    fi
  done <<EOF_SOURCES
${sources_output}
EOF_SOURCES

  if [[ "${failures}" -eq 0 ]]; then
    verbose_log "Bundled default extensions installed."
  else
    warn "${failures} bundled default extension package(s) failed to update"
  fi
}


configure_gnosis() {
  if [[ "${NO_SETTINGS}" == "true" ]]; then
    log "Skipping Gnosis integration (--no-settings)."
    return 0
  fi
  if [[ -z "${TLH_GNOSIS_SCRIPT}" ]]; then
    if [[ "${GNOSIS_MODE}" != "auto" ]]; then
      warn "Gnosis integration option was provided, but support files are unavailable for ref ${REF}; skipping"
    else
      log "Skipping default Gnosis integration; support files are unavailable."
    fi
    return 0
  fi

  local args=(
    "${TLH_GNOSIS_SCRIPT}"
    "--settings"
    "${SETTINGS_PATH}"
    "--agent-dir"
    "${AGENT_DIR}"
    "--target"
    "${AGENT_DIR}/bin/gn"
    "--gnosis-repo"
    "${GNOSIS_REPO}"
    "--gnosis-version"
    "${GNOSIS_VERSION}"
    "--mode"
    "${GNOSIS_MODE}"
    "--wrapper-name"
    "${WRAPPER_NAME}"
    "configure-install"
  )
  if [[ "${DRY_RUN}" == "true" ]]; then
    args+=("--dry-run" "--detail")
  elif [[ "${VERBOSE}" == "true" ]]; then
    args+=("--detail")
  fi
  if [[ "${QUIET}" == "true" ]]; then
    args+=("--quiet")
  fi

  GNOSIS_SUMMARY="$(node "${args[@]}")"
}

wrapper_is_managed() {
  [[ -f "${WRAPPER_PATH}" ]] || return 1
  local marker_line
  marker_line="$(sed -n '3p' "${WRAPPER_PATH}" 2>/dev/null || true)"
  [[ "${marker_line}" == "# ${WRAPPER_MARKER}" ]]
}

write_wrapper_dry_run_without_helper() {
  if [[ -e "${WRAPPER_PATH}" ]] && ! wrapper_is_managed && [[ "${FORCE}" != "true" ]]; then
    warn "would not overwrite unmanaged existing wrapper: ${WRAPPER_PATH}"
    return 0
  fi

  print_command mkdir -p "${BIN_DIR}"
  if [[ -e "${WRAPPER_PATH}" ]]; then
    log "Would overwrite wrapper: ${WRAPPER_PATH}"
  else
    log "Would create wrapper: ${WRAPPER_PATH}"
  fi
}

write_wrapper() {
  if [[ "${NO_WRAPPER}" == "true" ]]; then
    log "Skipping wrapper creation (--no-wrapper)."
    return 0
  fi

  if [[ "${DRY_RUN}" == "true" || "${VERBOSE}" == "true" ]]; then
    log "Installing wrapper command: ${WRAPPER_PATH}"
  else
    log "Creating wrapper command..."
  fi

  if [[ -z "${TLH_WRAPPER_SCRIPT}" || ! -f "${TLH_WRAPPER_SCRIPT}" ]]; then
    if ! ensure_support_files_prepared; then
      if [[ "${DRY_RUN}" == "true" ]]; then
        write_wrapper_dry_run_without_helper
        return 0
      fi
      die "wrapper support files are unavailable for ref ${REF}"
    fi
  fi

  if [[ -z "${TLH_WRAPPER_SCRIPT}" || ! -f "${TLH_WRAPPER_SCRIPT}" ]]; then
    if [[ "${DRY_RUN}" == "true" ]]; then
      write_wrapper_dry_run_without_helper
      return 0
    fi
    die "wrapper support script not found for ref ${REF}; re-run the installer from a release that includes scripts/tlh-wrapper.mjs"
  fi

  local args=(
    "${TLH_WRAPPER_SCRIPT}"
    "--agent-dir"
    "${AGENT_DIR}"
    "--bin-dir"
    "${BIN_DIR}"
    "--wrapper-name"
    "${WRAPPER_NAME}"
    "--package-root"
    "${AGENT_DIR}/git/github.com/${REPO}"
  )
  if [[ "${DRY_RUN}" == "true" ]]; then
    args+=("--dry-run")
  fi
  if [[ "${FORCE}" == "true" ]]; then
    args+=("--force")
  fi
  if [[ "${QUIET}" == "true" ]]; then
    args+=("--quiet")
  fi

  node "${args[@]}"
}

path_contains_bin_dir() {
  case ":${PATH:-}:" in
    *":${BIN_DIR}:"*) return 0 ;;
    *) return 1 ;;
  esac
}

print_summary() {
  log ""
  log "Done. The Last Harness is ready."
  if [[ "${NO_WRAPPER}" != "true" ]]; then
    if path_contains_bin_dir; then
      log "Start with: ${WRAPPER_NAME}"
    else
      warn "${BIN_DIR} is not on PATH. Add it with: export PATH=\"${BIN_DIR}:\$PATH\""
      log "Start with: PI_CODING_AGENT_DIR=\"${AGENT_DIR}\" pi"
    fi
    detail_log "Wrapper: ${WRAPPER_PATH}"
  else
    log "Start with: PI_CODING_AGENT_DIR=\"${AGENT_DIR}\" pi"
  fi
  detail_log "Settings: ${SETTINGS_PATH}"
  if [[ -n "${GNOSIS_SUMMARY}" ]]; then
    detail_log "${GNOSIS_SUMMARY}"
  fi
  detail_log "Normal Pi config was not modified: ~/.pi/agent"
  if [[ "${NO_WRAPPER}" != "true" ]]; then
    detail_log "Uninstall: rm -f \"${WRAPPER_PATH}\" && rm -rf \"${AGENT_DIR}\""
  else
    detail_log "Uninstall: rm -rf \"${AGENT_DIR}\""
  fi
}

main() {
  log "The Last Harness installer"
  detail_log "Isolated profile: ${AGENT_DIR}"
  if [[ "${PACKAGE_SOURCE_IS_DEFAULT}" != "true" || "${VERBOSE}" == "true" ]]; then
    log "Package source: ${PACKAGE_SOURCE}"
  fi
  verbose_log "Repository: ${REPO}"
  verbose_log "Update track: ${UPDATE_TRACK}"

  require_command node
  validate_inputs
  require_command npm
  require_command git
  preflight_runtime_support_files

  install_pi_if_needed
  install_harness_package
  install_support_files
  merge_settings
  write_install_state
  install_default_extensions
  configure_gnosis
  write_wrapper
  print_summary
}

main "$@"
