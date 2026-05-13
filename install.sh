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

find_local_repo_dir() {
  local source_path="${BASH_SOURCE[0]:-}"
  if [[ -z "${source_path}" || ! -f "${source_path}" ]]; then
    return 1
  fi

  local dir
  dir="$(cd "$(dirname "${source_path}")" >/dev/null 2>&1 && pwd -P)" || return 1
  if [[ -f "${dir}/scripts/merge-settings.mjs" && -f "${dir}/scripts/tlh-defaults.mjs" && -f "${dir}/config/settings.defaults.json" && -f "${dir}/config/default-extensions.json" ]]; then
    printf '%s\n' "${dir}"
    return 0
  fi
  return 1
}

prepare_merge_files() {
  local local_dir=""
  TLH_GNOSIS_SCRIPT=""
  TLH_UPDATE_SCRIPT=""
  if local_dir="$(find_local_repo_dir)"; then
    MERGE_SCRIPT="${local_dir}/scripts/merge-settings.mjs"
    TLH_DEFAULTS_SCRIPT="${local_dir}/scripts/tlh-defaults.mjs"
    if [[ -f "${local_dir}/scripts/tlh-gnosis.mjs" ]]; then
      TLH_GNOSIS_SCRIPT="${local_dir}/scripts/tlh-gnosis.mjs"
    fi
    if [[ -f "${local_dir}/scripts/tlh-update.mjs" ]]; then
      TLH_UPDATE_SCRIPT="${local_dir}/scripts/tlh-update.mjs"
    fi
    DEFAULTS_FILE="${local_dir}/config/settings.defaults.json"
    DEFAULT_EXTENSIONS_FILE="${local_dir}/config/default-extensions.json"
    return 0
  fi

  require_command curl
  TMP_DIR="$(mktemp -d)"
  MERGE_SCRIPT="${TMP_DIR}/merge-settings.mjs"
  TLH_DEFAULTS_SCRIPT="${TMP_DIR}/tlh-defaults.mjs"
  TLH_GNOSIS_SCRIPT="${TMP_DIR}/tlh-gnosis.mjs"
  TLH_UPDATE_SCRIPT="${TMP_DIR}/tlh-update.mjs"
  DEFAULTS_FILE="${TMP_DIR}/settings.defaults.json"
  DEFAULT_EXTENSIONS_FILE="${TMP_DIR}/default-extensions.json"

  verbose_log "Fetching installer support files from ${RAW_BASE}"
  curl -fsSL "${RAW_BASE}/scripts/merge-settings.mjs" -o "${MERGE_SCRIPT}"
  curl -fsSL "${RAW_BASE}/scripts/tlh-defaults.mjs" -o "${TLH_DEFAULTS_SCRIPT}"
  if ! curl -fsSL "${RAW_BASE}/scripts/tlh-gnosis.mjs" -o "${TLH_GNOSIS_SCRIPT}"; then
    warn "Gnosis support script not found for ref ${REF}; continuing without tlh gnosis helper"
    TLH_GNOSIS_SCRIPT=""
  fi
  if ! curl -fsSL "${RAW_BASE}/scripts/tlh-update.mjs" -o "${TLH_UPDATE_SCRIPT}"; then
    warn "tlh update support script not found for ref ${REF}; the wrapper update helper will be unavailable"
    TLH_UPDATE_SCRIPT=""
  fi
  curl -fsSL "${RAW_BASE}/config/settings.defaults.json" -o "${DEFAULTS_FILE}"
  curl -fsSL "${RAW_BASE}/config/default-extensions.json" -o "${DEFAULT_EXTENSIONS_FILE}"
}

prepare_merge_files_for_dry_run() {
  local local_dir=""
  TLH_GNOSIS_SCRIPT=""
  TLH_UPDATE_SCRIPT=""
  if local_dir="$(find_local_repo_dir)"; then
    MERGE_SCRIPT="${local_dir}/scripts/merge-settings.mjs"
    TLH_DEFAULTS_SCRIPT="${local_dir}/scripts/tlh-defaults.mjs"
    if [[ -f "${local_dir}/scripts/tlh-gnosis.mjs" ]]; then
      TLH_GNOSIS_SCRIPT="${local_dir}/scripts/tlh-gnosis.mjs"
    fi
    if [[ -f "${local_dir}/scripts/tlh-update.mjs" ]]; then
      TLH_UPDATE_SCRIPT="${local_dir}/scripts/tlh-update.mjs"
    fi
    DEFAULTS_FILE="${local_dir}/config/settings.defaults.json"
    DEFAULT_EXTENSIONS_FILE="${local_dir}/config/default-extensions.json"
    return 0
  fi

  log "Would fetch installer support files from ${RAW_BASE}"
  log "Would merge settings defaults into: ${SETTINGS_PATH}"
  log "Would install bundled default extension packages after settings merge."
  log "Would fetch Gnosis integration support files."
  log "Would fetch tlh update support files."
  log "Dry run only; no support files were downloaded."
  return 1
}

ensure_support_files_prepared() {
  if [[ -n "${MERGE_SCRIPT}" || -n "${TLH_DEFAULTS_SCRIPT}" || -n "${TLH_GNOSIS_SCRIPT}" || -n "${TLH_UPDATE_SCRIPT}" || -n "${DEFAULTS_FILE}" || -n "${DEFAULT_EXTENSIONS_FILE}" ]]; then
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
  if [[ -z "${TLH_DEFAULTS_SCRIPT}" && -z "${DEFAULT_EXTENSIONS_FILE}" && -z "${TLH_GNOSIS_SCRIPT}" && -z "${TLH_UPDATE_SCRIPT}" ]]; then
    ensure_support_files_prepared || return 0
  fi
  if [[ -z "${TLH_DEFAULTS_SCRIPT}" && -z "${DEFAULT_EXTENSIONS_FILE}" && -z "${TLH_GNOSIS_SCRIPT}" && -z "${TLH_UPDATE_SCRIPT}" ]]; then
    return 0
  fi

  local support_dir="${AGENT_DIR}/tlh"
  if [[ "${DRY_RUN}" == "true" ]]; then
    print_command mkdir -p "${support_dir}"
    if [[ -n "${TLH_DEFAULTS_SCRIPT}" ]]; then
      print_command cp "${TLH_DEFAULTS_SCRIPT}" "${support_dir}/tlh-defaults.mjs"
    fi
    if [[ -n "${TLH_GNOSIS_SCRIPT}" ]]; then
      print_command cp "${TLH_GNOSIS_SCRIPT}" "${support_dir}/tlh-gnosis.mjs"
    fi
    if [[ -n "${TLH_UPDATE_SCRIPT}" ]]; then
      print_command cp "${TLH_UPDATE_SCRIPT}" "${support_dir}/tlh-update.mjs"
    fi
    if [[ -n "${DEFAULT_EXTENSIONS_FILE}" ]]; then
      print_command cp "${DEFAULT_EXTENSIONS_FILE}" "${support_dir}/default-extensions.json"
    fi
    return 0
  fi

  mkdir -p "${support_dir}"
  if [[ -n "${TLH_DEFAULTS_SCRIPT}" ]]; then
    cp "${TLH_DEFAULTS_SCRIPT}" "${support_dir}/tlh-defaults.mjs"
  fi
  if [[ -n "${TLH_GNOSIS_SCRIPT}" ]]; then
    cp "${TLH_GNOSIS_SCRIPT}" "${support_dir}/tlh-gnosis.mjs"
  fi
  if [[ -n "${TLH_UPDATE_SCRIPT}" ]]; then
    cp "${TLH_UPDATE_SCRIPT}" "${support_dir}/tlh-update.mjs"
  fi
  if [[ -n "${DEFAULT_EXTENSIONS_FILE}" ]]; then
    cp "${DEFAULT_EXTENSIONS_FILE}" "${support_dir}/default-extensions.json"
  fi
}

write_install_state() {
  local support_dir="${AGENT_DIR}/tlh"
  local state_path="${support_dir}/install-state.json"

  if [[ "${DRY_RUN}" == "true" ]]; then
    log "Would write tlh update metadata: ${state_path}"
    return 0
  fi

  mkdir -p "${support_dir}"
  TLH_INSTALL_STATE_PATH="${state_path}" \
  TLH_INSTALL_REPO="${REPO}" \
  TLH_INSTALL_REF="${REF}" \
  TLH_INSTALL_TRACK="${UPDATE_TRACK}" \
  TLH_INSTALL_PACKAGE_SOURCE="${PACKAGE_SOURCE}" \
  TLH_INSTALL_PACKAGE_SOURCE_IS_DEFAULT="${PACKAGE_SOURCE_IS_DEFAULT}" \
  TLH_INSTALL_RAW_BASE="${RAW_BASE}" \
  TLH_INSTALL_AGENT_DIR="${AGENT_DIR}" \
  TLH_INSTALL_BIN_DIR="${BIN_DIR}" \
  TLH_INSTALL_WRAPPER_NAME="${WRAPPER_NAME}" \
  node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const statePath = process.env.TLH_INSTALL_STATE_PATH;
const state = {
  schemaVersion: 1,
  repo: process.env.TLH_INSTALL_REPO,
  ref: process.env.TLH_INSTALL_REF,
  track: process.env.TLH_INSTALL_TRACK,
  packageSource: process.env.TLH_INSTALL_PACKAGE_SOURCE,
  packageSourceIsDefault: process.env.TLH_INSTALL_PACKAGE_SOURCE_IS_DEFAULT === 'true',
  rawBase: process.env.TLH_INSTALL_RAW_BASE,
  agentDir: process.env.TLH_INSTALL_AGENT_DIR,
  binDir: process.env.TLH_INSTALL_BIN_DIR,
  wrapperName: process.env.TLH_INSTALL_WRAPPER_NAME,
  installedAt: new Date().toISOString(),
};
const tmpPath = `${statePath}.tmp.${process.pid}`;
fs.mkdirSync(path.dirname(statePath), { recursive: true });
fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
fs.renameSync(tmpPath, statePath);
NODE
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

validate_gnosis_command() {
  local candidate="$1"
  if [[ -n "${TLH_GNOSIS_SCRIPT}" ]]; then
    node "${TLH_GNOSIS_SCRIPT}" --settings "${SETTINGS_PATH}" --agent-dir "${AGENT_DIR}" --quiet validate "${candidate}" >/dev/null 2>&1
    return $?
  fi
  "${candidate}" help plan >/dev/null 2>&1 && "${candidate}" help review >/dev/null 2>&1
}

find_valid_gnosis_command() {
  local candidate=""
  if [[ -n "${TLH_GNOSIS_SCRIPT}" ]]; then
    if candidate="$(node "${TLH_GNOSIS_SCRIPT}" --settings "${SETTINGS_PATH}" --agent-dir "${AGENT_DIR}" --quiet validate 2>/dev/null)" && [[ -n "${candidate}" ]]; then
      if [[ "${candidate}" == "gn" ]] && command_exists gn; then
        command -v gn
      else
        printf '%s\n' "${candidate}"
      fi
      return 0
    fi
  fi

  candidate="${AGENT_DIR}/bin/gn"
  if [[ -x "${candidate}" ]] && validate_gnosis_command "${candidate}"; then
    printf '%s\n' "${candidate}"
    return 0
  fi

  if command_exists gn; then
    candidate="$(command -v gn)"
    if validate_gnosis_command "${candidate}"; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  fi

  return 1
}

gnosis_state() {
  if [[ -z "${TLH_GNOSIS_SCRIPT}" ]]; then
    printf 'unset\n'
    return 0
  fi
  node "${TLH_GNOSIS_SCRIPT}" --settings "${SETTINGS_PATH}" --agent-dir "${AGENT_DIR}" state 2>/dev/null || printf 'unset\n'
}

set_gnosis_enabled() {
  local install_path="${1:-}"
  if [[ -z "${TLH_GNOSIS_SCRIPT}" ]]; then
    warn "Gnosis support script not found; cannot update isolated settings"
    return 1
  fi

  local args=(
    "${TLH_GNOSIS_SCRIPT}"
    "--settings"
    "${SETTINGS_PATH}"
    "--agent-dir"
    "${AGENT_DIR}"
  )
  if [[ "${DRY_RUN}" == "true" ]]; then
    args+=("--dry-run")
  fi
  if [[ "${QUIET}" == "true" ]]; then
    args+=("--quiet")
  elif [[ "${VERBOSE}" != "true" && "${DRY_RUN}" != "true" ]]; then
    args+=("--quiet")
  fi
  if [[ -n "${install_path}" ]]; then
    args+=("--install-path" "${install_path}")
  fi
  args+=("enable")

  node "${args[@]}"
}

set_gnosis_disabled() {
  if [[ -z "${TLH_GNOSIS_SCRIPT}" ]]; then
    warn "Gnosis support script not found; cannot update isolated settings"
    return 1
  fi

  local args=(
    "${TLH_GNOSIS_SCRIPT}"
    "--settings"
    "${SETTINGS_PATH}"
    "--agent-dir"
    "${AGENT_DIR}"
    "disable"
  )
  if [[ "${DRY_RUN}" == "true" ]]; then
    args+=("--dry-run")
  fi
  if [[ "${QUIET}" == "true" ]]; then
    args+=("--quiet")
  elif [[ "${VERBOSE}" != "true" && "${DRY_RUN}" != "true" ]]; then
    args+=("--quiet")
  fi

  node "${args[@]}"
}

gnosis_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) return 1 ;;
  esac

  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="amd64" ;;
    *) return 1 ;;
  esac

  printf '%s %s\n' "${os}" "${arch}"
}

resolve_gnosis_version() {
  if [[ -n "${GNOSIS_VERSION}" && "${GNOSIS_VERSION}" != "latest" ]]; then
    printf '%s\n' "${GNOSIS_VERSION#v}"
    return 0
  fi

  local latest_url version
  latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${GNOSIS_REPO}/releases/latest")" || return 1
  version="${latest_url##*/}"
  version="${version#v}"
  [[ -n "${version}" && "${version}" != "latest" ]] || return 1
  printf '%s\n' "${version}"
}

sha256_file() {
  local path="$1" output
  if command_exists sha256sum; then
    output="$(sha256sum "${path}")" || return 1
    printf '%s\n' "${output%% *}"
    return 0
  fi
  if command_exists shasum; then
    output="$(shasum -a 256 "${path}")" || return 1
    printf '%s\n' "${output%% *}"
    return 0
  fi
  return 1
}

checksum_for_asset() {
  local checksums_file="$1"
  local asset_name="$2"
  local checksum filename rest
  while read -r checksum filename rest; do
    [[ -n "${checksum}" && -n "${filename}" ]] || continue
    filename="${filename#./}"
    if [[ "${filename}" == "${asset_name}" ]]; then
      printf '%s\n' "${checksum}"
      return 0
    fi
  done <"${checksums_file}"
  return 1
}

verify_gnosis_archive() {
  local archive="$1"
  local asset_name="$2"
  local version="$3"
  local checksums_url="https://github.com/${GNOSIS_REPO}/releases/download/v${version}/checksums.txt"
  local checksums_file="${archive}.checksums"
  local expected actual

  if ! curl -fsSL "${checksums_url}" -o "${checksums_file}"; then
    warn "failed to download Gnosis checksums: ${checksums_url}"
    return 1
  fi
  if ! expected="$(checksum_for_asset "${checksums_file}" "${asset_name}")"; then
    warn "Gnosis checksums did not include ${asset_name}"
    return 1
  fi
  if ! actual="$(sha256_file "${archive}")"; then
    warn "required checksum command not found: sha256sum or shasum"
    return 1
  fi
  if [[ "${actual}" != "${expected}" ]]; then
    warn "Gnosis checksum verification failed for ${asset_name}"
    return 1
  fi
}

install_managed_gnosis() {
  local target="${AGENT_DIR}/bin/gn"
  local platform os arch version asset_name url gn_tmp archive extract_dir extracted temp_target
  if ! platform="$(gnosis_platform)"; then
    warn "Gnosis prebuilt binary is not available for this platform; install manually from https://github.com/${GNOSIS_REPO}"
    return 1
  fi
  os="${platform%% *}"
  arch="${platform##* }"

  if [[ "${DRY_RUN}" == "true" ]]; then
    log_stderr "Would install Gnosis into isolated profile: ${target}"
    log_stderr "Would download latest compatible release from https://github.com/${GNOSIS_REPO}"
    printf '%s\n' "${target}"
    return 0
  fi

  require_command curl
  require_command tar

  if ! version="$(resolve_gnosis_version)"; then
    warn "could not resolve latest Gnosis release; install manually from https://github.com/${GNOSIS_REPO}"
    return 1
  fi

  asset_name="gnosis_${version}_${os}_${arch}.tar.gz"
  url="https://github.com/${GNOSIS_REPO}/releases/download/v${version}/${asset_name}"
  gn_tmp="$(mktemp -d)"
  archive="${gn_tmp}/gnosis.tar.gz"
  extract_dir="${gn_tmp}/extract"
  mkdir -p "${extract_dir}"

  log_stderr "Installing Gnosis ${version} into isolated profile: ${target}"
  if ! curl -fsSL "${url}" -o "${archive}"; then
    rm -rf "${gn_tmp}"
    warn "failed to download Gnosis release archive: ${url}"
    return 1
  fi
  if ! verify_gnosis_archive "${archive}" "${asset_name}" "${version}"; then
    rm -rf "${gn_tmp}"
    return 1
  fi
  if ! tar -xzf "${archive}" -C "${extract_dir}"; then
    rm -rf "${gn_tmp}"
    warn "failed to extract Gnosis release archive"
    return 1
  fi

  extracted="$(find "${extract_dir}" -type f -name gn | head -n 1 || true)"
  if [[ -z "${extracted}" ]]; then
    rm -rf "${gn_tmp}"
    warn "Gnosis release archive did not contain a gn binary"
    return 1
  fi

  mkdir -p "${AGENT_DIR}/bin"
  temp_target="${target}.tmp.$$"
  cp "${extracted}" "${temp_target}"
  chmod 0755 "${temp_target}"

  if ! validate_gnosis_command "${temp_target}"; then
    rm -f "${temp_target}"
    rm -rf "${gn_tmp}"
    warn "downloaded Gnosis binary did not validate"
    return 1
  fi

  mv "${temp_target}" "${target}"
  rm -rf "${gn_tmp}"
  printf '%s\n' "${target}"
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

  local current_state requested valid_path managed_path
  current_state="$(gnosis_state)"
  requested="${GNOSIS_MODE}"

  if [[ "${requested}" == "without" ]]; then
    verbose_log "Disabling Gnosis integration for tlh."
    set_gnosis_disabled
    GNOSIS_SUMMARY="Gnosis integration: disabled"
    return 0
  fi

  if [[ "${requested}" == "auto" ]]; then
    if [[ "${current_state}" == "disabled" ]]; then
      # Treat enabled=false as a deliberate opt-out. Normal installer reruns and
      # tlh update must not undo it; only --with-gnosis should re-enable.
      verbose_log "Keeping existing Gnosis opt-out."
      GNOSIS_SUMMARY="Gnosis integration: disabled"
      return 0
    fi

    if [[ "${current_state}" == "enabled" ]]; then
      verbose_log "Keeping existing Gnosis integration setting: enabled."
      if valid_path="$(find_valid_gnosis_command)"; then
        GNOSIS_SUMMARY="Gnosis integration: enabled (${valid_path})"
        return 0
      fi

      warn "Gnosis integration is enabled, but no valid gn binary was found. Attempting to install it."
      if managed_path="$(install_managed_gnosis)"; then
        set_gnosis_enabled "${managed_path}"
        GNOSIS_SUMMARY="Gnosis integration: enabled (${managed_path})"
        return 0
      fi

      warn "Gnosis integration remains enabled, but Gnosis could not be installed automatically. Install Gnosis manually and run: ${WRAPPER_NAME} gnosis enable"
      GNOSIS_SUMMARY="Gnosis integration: enabled, but no valid gn binary was found"
      return 0
    fi

    verbose_log "Installing and enabling Gnosis integration by default."
    requested="with"
  fi

  if [[ "${requested}" != "with" ]]; then
    return 0
  fi

  valid_path=""
  if valid_path="$(find_valid_gnosis_command)"; then
    verbose_log "Found valid Gnosis binary: ${valid_path}"
    set_gnosis_enabled "${valid_path}"
    GNOSIS_SUMMARY="Gnosis integration: enabled (${valid_path})"
    return 0
  fi

  if managed_path="$(install_managed_gnosis)"; then
    set_gnosis_enabled "${managed_path}"
    GNOSIS_SUMMARY="Gnosis integration: enabled (${managed_path})"
    return 0
  fi

  warn "Gnosis integration could not be installed automatically."
  warn "Leaving Gnosis integration unchanged; install Gnosis manually and run: ${WRAPPER_NAME} gnosis enable"
  GNOSIS_SUMMARY="Gnosis integration: not enabled (gn was not installed)"
}

wrapper_is_managed() {
  [[ -f "${WRAPPER_PATH}" ]] || return 1
  local marker_line
  marker_line="$(sed -n '3p' "${WRAPPER_PATH}" 2>/dev/null || true)"
  [[ "${marker_line}" == "# ${WRAPPER_MARKER}" ]]
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

  if [[ -e "${WRAPPER_PATH}" ]] && ! wrapper_is_managed && [[ "${FORCE}" != "true" ]]; then
    if [[ "${DRY_RUN}" == "true" ]]; then
      warn "would not overwrite unmanaged existing wrapper: ${WRAPPER_PATH}"
      return 0
    fi
    die "${WRAPPER_PATH} already exists and is not managed by this installer; use --force or --bin-dir"
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    print_command mkdir -p "${BIN_DIR}"
    if [[ -e "${WRAPPER_PATH}" ]]; then
      log "Would overwrite wrapper: ${WRAPPER_PATH}"
    else
      log "Would create wrapper: ${WRAPPER_PATH}"
    fi
    return 0
  fi

  mkdir -p "${BIN_DIR}"
  local tmp_path="${WRAPPER_PATH}.tmp.$$"
  local escaped_agent_dir escaped_package_root escaped_bin_dir escaped_wrapper_name
  escaped_agent_dir="$(printf '%q' "${AGENT_DIR}")"
  escaped_package_root="$(printf '%q' "${AGENT_DIR}/git/github.com/${REPO}")"
  escaped_bin_dir="$(printf '%q' "${BIN_DIR}")"
  escaped_wrapper_name="$(printf '%q' "${WRAPPER_NAME}")"

  cat >"${tmp_path}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
# ${WRAPPER_MARKER}
default_agent_dir=${escaped_agent_dir}
default_tlh_package_root=${escaped_package_root}
default_bin_dir=${escaped_bin_dir}
default_wrapper_name=${escaped_wrapper_name}
export PI_CODING_AGENT_DIR="\${default_agent_dir}"

if [[ "\${1:-}" == "update" ]]; then
  shift
  tlh_update_script=""
  for candidate in \
    "\${default_agent_dir}/tlh/tlh-update.mjs" \
    "\${default_tlh_package_root}/scripts/tlh-update.mjs"; do
    if [[ -f "\${candidate}" ]]; then
      tlh_update_script="\${candidate}"
      break
    fi
  done
  if [[ -z "\${tlh_update_script}" ]]; then
    printf 'error: tlh update support files not found; re-run the installer.\n' >&2
    exit 1
  fi
  exec node "\${tlh_update_script}" --agent-dir "\${default_agent_dir}" --bin-dir "\${default_bin_dir}" --wrapper-name "\${default_wrapper_name}" "\$@"
fi

if [[ "\${1:-}" == "defaults" ]]; then
  shift
  tlh_defaults_script=""
  tlh_default_extensions=""
  for candidate in \
    "\${default_agent_dir}/tlh/tlh-defaults.mjs" \
    "\${default_tlh_package_root}/scripts/tlh-defaults.mjs"; do
    if [[ -f "\${candidate}" ]]; then
      tlh_defaults_script="\${candidate}"
      break
    fi
  done
  for candidate in \
    "\${default_agent_dir}/tlh/default-extensions.json" \
    "\${default_tlh_package_root}/config/default-extensions.json"; do
    if [[ -f "\${candidate}" ]]; then
      tlh_default_extensions="\${candidate}"
      break
    fi
  done
  if [[ -z "\${tlh_defaults_script}" || -z "\${tlh_default_extensions}" ]]; then
    printf 'error: tlh defaults support files not found; re-run the installer.\n' >&2
    exit 1
  fi
  exec node "\${tlh_defaults_script}" --settings "\${default_agent_dir}/settings.json" --defaults "\${tlh_default_extensions}" "\$@"
fi

if [[ "\${1:-}" == "gnosis" ]]; then
  shift
  tlh_gnosis_script=""
  for candidate in \
    "\${default_agent_dir}/tlh/tlh-gnosis.mjs" \
    "\${default_tlh_package_root}/scripts/tlh-gnosis.mjs"; do
    if [[ -f "\${candidate}" ]]; then
      tlh_gnosis_script="\${candidate}"
      break
    fi
  done
  if [[ -z "\${tlh_gnosis_script}" ]]; then
    printf 'error: tlh gnosis support files not found; re-run the installer.\n' >&2
    exit 1
  fi
  exec node "\${tlh_gnosis_script}" --settings "\${default_agent_dir}/settings.json" --agent-dir "\${default_agent_dir}" "\$@"
fi

pi_cmd="\$(command -v pi || true)"
if [[ -z "\${pi_cmd}" ]]; then
  printf 'error: pi command not found on PATH.\n' >&2
  exit 1
fi
export PATH="\${default_agent_dir}/bin\${PATH:+:\${PATH}}"
exec "\${pi_cmd}" "\$@"
EOF
  chmod +x "${tmp_path}"
  mv "${tmp_path}" "${WRAPPER_PATH}"
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
