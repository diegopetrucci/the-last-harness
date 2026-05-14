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

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

Install upstream Pi and The Last Harness as a separate `tlh` command. Normal Pi
config under ~/.pi/agent is not modified.

Options:
  --dry-run        Print actions and settings changes without writing
  --force          Allow scalar isolated defaults and installer wrapper overwrite
  --no-pi-install  Fail instead of installing Pi when the `pi` command is missing
  --no-settings     Install the package but skip isolated settings merge
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
WRAPPER_MARKER="Managed by The Last Harness installer"
MERGE_SCRIPT=""
DEFAULTS_FILE=""
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

validate_inputs() {
  if [[ ! "${WRAPPER_NAME}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    die "--wrapper-name must be a simple command name containing only letters, numbers, dot, underscore, or dash"
  fi
  case "${UPDATE_TRACK}" in
    latest-release|pinned-tag|ref|custom) ;;
    *) die "--track must be one of: latest-release, pinned-tag, ref, custom" ;;
  esac

  local normal_pi_root normalized_agent
  normal_pi_root="$(normalize_path_for_compare "${HOME}/.pi")"
  normalized_agent="$(normalize_path_for_compare "${AGENT_DIR}")"
  if [[ "${normalized_agent}" == "${normal_pi_root}" || "${normalized_agent}" == "${normal_pi_root}/"* ]]; then
    die "refusing to place The Last Harness agent dir under normal Pi config root: ${AGENT_DIR}"
  fi
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
    (cd "${AGENT_DIR}" && PI_CODING_AGENT_DIR="${AGENT_DIR}" "$@")
  else
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
  log "Would merge settings defaults into: ${SETTINGS_PATH}"
  log "Would install bundled default extension packages after settings merge."
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
  if [[ ! -f "${SETTINGS_PATH}" ]]; then
    return 0
  fi

  local backup_path="${SETTINGS_PATH}.backup-before-install-$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "Would back up existing isolated settings to: ${backup_path}"
    return 0
  fi

  cp -p "${SETTINGS_PATH}" "${backup_path}"
  detail_log "Backed up existing isolated settings to: ${backup_path}"
}

refresh_harness_package_checkout() {
  if [[ "${PACKAGE_SOURCE_IS_DEFAULT}" != "true" ]]; then
    return 0
  fi

  local package_root="${AGENT_DIR}/git/github.com/${REPO}"
  verbose_log "Checking out The Last Harness git ref: ${REF}"
  if [[ "${DRY_RUN}" == "true" ]]; then
    print_command git -C "${package_root}" fetch --prune --tags origin
    log "Would prefer tag ${REF}, then origin/${REF}, then ${REF}."
    print_command git -C "${package_root}" checkout --detach "<resolved-ref>"
    print_command git -C "${package_root}" reset --hard "<resolved-ref>"
    print_command git -C "${package_root}" clean -fdx
    log "Would run npm install --omit=dev --legacy-peer-deps --package-lock=false if package.json is present."
    return 0
  fi

  if [[ ! -d "${package_root}/.git" ]]; then
    warn "expected installed package checkout not found, skipping git refresh: ${package_root}"
    return 0
  fi

  run git -C "${package_root}" fetch --prune --tags origin

  local target_ref="${REF}"
  if git -C "${package_root}" rev-parse --verify --quiet "refs/tags/${REF}^{commit}" >/dev/null; then
    target_ref="refs/tags/${REF}^{commit}"
  elif git -C "${package_root}" rev-parse --verify --quiet "refs/remotes/origin/${REF}^{commit}" >/dev/null; then
    target_ref="refs/remotes/origin/${REF}"
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
  run_isolated_pi pi install "${PACKAGE_SOURCE}"
  refresh_harness_package_checkout

  if [[ "${PACKAGE_SOURCE_IS_DEFAULT}" == "true" ]]; then
    return 0
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
    log "Skipping settings merge (--no-settings)."
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
}

install_support_files() {
  if ! installable_support_files_are_prepared; then
    ensure_support_files_prepared || return 0
  fi
  if ! installable_support_files_are_prepared; then
    return 0
  fi

  local support_dir="${AGENT_DIR}/tlh"
  local var_name requirement relative_path tmp_name install_name source_path
  if [[ "${DRY_RUN}" == "true" ]]; then
    print_command mkdir -p "${support_dir}"
    while IFS='|' read -r var_name requirement relative_path tmp_name install_name; do
      [[ -n "${var_name}" && -n "${install_name}" ]] || continue
      source_path="${!var_name}"
      [[ -n "${source_path}" ]] || continue
      print_command cp "${source_path}" "${support_dir}/${install_name}"
    done <<< "$(support_file_manifest)"
    return 0
  fi

  mkdir -p "${support_dir}"
  while IFS='|' read -r var_name requirement relative_path tmp_name install_name; do
    [[ -n "${var_name}" && -n "${install_name}" ]] || continue
    source_path="${!var_name}"
    [[ -n "${source_path}" ]] || continue
    cp "${source_path}" "${support_dir}/${install_name}"
  done <<< "$(support_file_manifest)"
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

  local sources_output
  if ! sources_output="$(node "${TLH_DEFAULTS_SCRIPT}" --settings "${SETTINGS_PATH}" --defaults "${DEFAULT_EXTENSIONS_FILE}" sources)"; then
    die "failed to read bundled default extension sources"
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

  install_pi_if_needed
  install_harness_package
  merge_settings
  install_support_files
  write_install_state
  install_default_extensions
  configure_gnosis
  write_wrapper
  print_summary
}

main "$@"
