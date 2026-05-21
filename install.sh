#!/usr/bin/env bash
set -euo pipefail

REPO="${TLH_REPO:-diegopetrucci/the-last-harness}"
REF="${TLH_REF:-main}"
# Keep in sync with MIN_NODE_VERSION in scripts/tlh-install.mjs.
TLH_MIN_NODE_VERSION="22.19.0"

DRY_RUN=false
NO_SETTINGS=false
NO_WRAPPER=false
QUIET=false
VERBOSE=false
AGENT_DIR_INPUT="${TLH_AGENT_DIR:-$HOME/.the-last-harness/agent}"
BIN_DIR_INPUT="${TLH_BIN_DIR:-$HOME/.local/bin}"
WRAPPER_NAME="${TLH_WRAPPER_NAME:-tlh}"
UPDATE_TRACK_INPUT="${TLH_UPDATE_TRACK:-}"
RAW_BASE_INPUT="${TLH_RAW_BASE:-}"
TMP_DIR=""
REMOTE_SUPPORT_ROOT=""
ORIGINAL_ARGS=("$@")

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
  TLH_RAW_BASE         Base URL for stage-1 installer support files
  TLH_GNOSIS_VERSION   Gnosis version to install (default: latest)
  TLH_GNOSIS_REPO      Gnosis GitHub repo, owner/name (default: skorokithakis/gnosis)

Examples:
  curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash -s --
  curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash -s -- --dry-run
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

verbose_log() {
  if [[ "${VERBOSE}" == "true" && "${QUIET}" != "true" ]]; then
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
      printf '%s/%s\n' "${HOME}" "${path#\~/}"
      ;;
    *)
      printf '%s\n' "${path}"
      ;;
  esac
}

normalize_path_for_stage0() {
  local path="$1"
  local part remainder last_index
  local -a components=()

  path="$(expand_path "${path}")"
  if [[ "${path}" != /* ]]; then
    path="$(pwd -P)/${path}"
  fi

  remainder="${path#/}"
  while [[ -n "${remainder}" ]]; do
    if [[ "${remainder}" == */* ]]; then
      part="${remainder%%/*}"
      remainder="${remainder#*/}"
    else
      part="${remainder}"
      remainder=""
    fi

    case "${part}" in
      ''|.)
        ;;
      ..)
        if [[ "${#components[@]}" -gt 0 ]]; then
          last_index=$((${#components[@]} - 1))
          components=("${components[@]:0:${last_index}}")
        fi
        ;;
      *)
        components+=("${part}")
        ;;
    esac
  done

  if [[ "${#components[@]}" -eq 0 ]]; then
    printf '/\n'
  else
    local IFS='/'
    printf '/%s\n' "${components[*]}"
  fi
}

realpath_for_compare_stage0() {
  local path="$1"
  local normalized candidate parent base tail physical_prefix

  normalized="$(normalize_path_for_stage0 "${path}")"
  candidate="${normalized}"
  tail=""

  while [[ "${candidate}" != "/" && ! -e "${candidate}" && ! -L "${candidate}" ]]; do
    base="${candidate##*/}"
    parent="${candidate%/*}"
    if [[ -z "${parent}" || "${parent}" == "${candidate}" ]]; then
      parent="/"
    fi
    if [[ -n "${tail}" ]]; then
      tail="${base}/${tail}"
    else
      tail="${base}"
    fi
    candidate="${parent}"
  done

  if [[ -d "${candidate}" ]]; then
    physical_prefix="$(cd "${candidate}" >/dev/null 2>&1 && pwd -P)" || physical_prefix="${candidate}"
  elif [[ "${candidate}" == "/" ]]; then
    physical_prefix="/"
  else
    base="${candidate##*/}"
    parent="${candidate%/*}"
    if [[ -z "${parent}" || "${parent}" == "${candidate}" ]]; then
      parent="/"
    fi
    parent="$(cd "${parent}" >/dev/null 2>&1 && pwd -P)" || parent="${candidate%/*}"
    if [[ "${parent}" == "/" ]]; then
      physical_prefix="/${base}"
    else
      physical_prefix="${parent}/${base}"
    fi
  fi

  if [[ -n "${tail}" ]]; then
    if [[ "${physical_prefix}" == "/" ]]; then
      printf '/%s\n' "${tail}"
    else
      printf '%s/%s\n' "${physical_prefix}" "${tail}"
    fi
  else
    printf '%s\n' "${physical_prefix}"
  fi
}

path_within_or_equal_stage0() {
  local root="$1"
  local path="$2"
  [[ "${path}" == "${root}" || "${path}" == "${root}/"* ]]
}

path_is_protected_pi_config_stage0() {
  local path="$1"
  local normal_pi_root="${2:-}"
  local normal_pi_agent_root="${3:-}"

  if [[ -z "${normal_pi_root}" ]]; then
    normal_pi_root="$(realpath_for_compare_stage0 "${HOME}/.pi")"
  fi
  if [[ -z "${normal_pi_agent_root}" ]]; then
    normal_pi_agent_root="$(realpath_for_compare_stage0 "${HOME}/.pi/agent")"
  fi

  path_within_or_equal_stage0 "${normal_pi_root}" "${path}" || path_within_or_equal_stage0 "${normal_pi_agent_root}" "${path}"
}

validate_stage0_fallback_targets() {
  if [[ ! "${WRAPPER_NAME}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    die "--wrapper-name must be a simple command name containing only letters, numbers, dot, underscore, or dash"
  fi
  case "${UPDATE_TRACK_INPUT}" in
    ''|latest-release|pinned-tag|ref|custom)
      ;;
    *)
      die "--track must be one of: latest-release, pinned-tag, ref, custom"
      ;;
  esac

  local agent_dir bin_dir wrapper_path
  local compare_agent_dir compare_bin_dir compare_wrapper_path
  local compare_normal_pi_root compare_normal_pi_agent_root
  agent_dir="$(expand_path "${AGENT_DIR_INPUT}")"
  bin_dir="$(expand_path "${BIN_DIR_INPUT}")"
  wrapper_path="${bin_dir}/${WRAPPER_NAME}"
  compare_agent_dir="$(realpath_for_compare_stage0 "${agent_dir}")"
  compare_bin_dir="$(realpath_for_compare_stage0 "${bin_dir}")"
  compare_wrapper_path="$(realpath_for_compare_stage0 "${wrapper_path}")"
  compare_normal_pi_root="$(realpath_for_compare_stage0 "${HOME}/.pi")"
  compare_normal_pi_agent_root="$(realpath_for_compare_stage0 "${HOME}/.pi/agent")"

  if path_is_protected_pi_config_stage0 "${compare_agent_dir}" "${compare_normal_pi_root}" "${compare_normal_pi_agent_root}"; then
    die "refusing to place The Last Harness agent dir under normal Pi config root: ${agent_dir}"
  fi
  if path_is_protected_pi_config_stage0 "${compare_bin_dir}" "${compare_normal_pi_root}" "${compare_normal_pi_agent_root}"; then
    die "refusing to place The Last Harness wrapper dir under normal Pi config root: ${bin_dir}"
  fi
  if path_is_protected_pi_config_stage0 "${compare_wrapper_path}" "${compare_normal_pi_root}" "${compare_normal_pi_agent_root}"; then
    die "refusing to place The Last Harness wrapper under normal Pi config root: ${wrapper_path}"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --force|--no-pi-install)
      shift
      ;;
    --no-wrapper)
      NO_WRAPPER=true
      shift
      ;;
    --no-settings)
      NO_SETTINGS=true
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

RAW_BASE="${RAW_BASE_INPUT:-https://raw.githubusercontent.com/${REPO}/${REF}}"

print_support_manifest_for_root() {
  local root="$1"

  if [[ "${NO_SETTINGS}" == "true" ]]; then
    (cd "${root}" >/dev/null 2>&1 && node scripts/tlh-install.mjs --no-settings --print-support-manifest)
  else
    (cd "${root}" >/dev/null 2>&1 && node scripts/tlh-install.mjs --print-support-manifest)
  fi
}

support_root_ready() {
  local root="$1"
  local manifest variable requirement relative_path temp_path install_name
  local found_manifest=false

  [[ -f "${root}/scripts/tlh-install.mjs" ]] || return 1
  manifest="$(print_support_manifest_for_root "${root}" 2>/dev/null)" || return 1

  while IFS='|' read -r variable requirement relative_path temp_path install_name; do
    [[ -n "${relative_path}" ]] || continue
    found_manifest=true
    if [[ "${requirement}" == "required" && ! -f "${root}/${relative_path}" ]]; then
      return 1
    fi
  done <<< "${manifest}"

  [[ "${found_manifest}" == "true" ]]
}

find_local_support_root() {
  local source_path=""
  local dir=""

  if [[ "${#BASH_SOURCE[@]}" -eq 0 ]]; then
    return 1
  fi

  source_path="${BASH_SOURCE[0]:-}"
  if [[ -z "${source_path}" || ! -f "${source_path}" ]]; then
    return 1
  fi

  # A real local checkout path either includes a directory component or is the
  # checkout's install.sh; stdin/pseudo names must not resolve against cwd.
  case "${source_path}" in
    */*|install.sh)
      ;;
    *)
      return 1
      ;;
  esac

  dir="$(cd "$(dirname "${source_path}")" >/dev/null 2>&1 && pwd -P)" || return 1
  if support_root_ready "${dir}"; then
    printf '%s\n' "${dir}"
    return 0
  fi

  return 1
}

require_command() {
  local command="$1"
  if ! command -v -- "${command}" >/dev/null 2>&1; then
    die "required command not found: ${command}"
  fi
}

version_at_least_stage0() {
  local current="$1"
  local minimum="$2"
  local current_major current_minor current_patch current_extra
  local minimum_major minimum_minor minimum_patch minimum_extra

  current="${current#v}"
  minimum="${minimum#v}"
  IFS='.' read -r current_major current_minor current_patch current_extra <<< "${current}"
  IFS='.' read -r minimum_major minimum_minor minimum_patch minimum_extra <<< "${minimum}"
  current_patch="${current_patch%%[^0-9]*}"
  minimum_patch="${minimum_patch%%[^0-9]*}"
  : "${current_extra:=}"
  : "${minimum_extra:=}"

  if [[ ! "${current_major}" =~ ^[0-9]+$ || ! "${current_minor}" =~ ^[0-9]+$ || ! "${current_patch}" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  if [[ ! "${minimum_major}" =~ ^[0-9]+$ || ! "${minimum_minor}" =~ ^[0-9]+$ || ! "${minimum_patch}" =~ ^[0-9]+$ ]]; then
    return 1
  fi

  if (( 10#${current_major} > 10#${minimum_major} )); then return 0; fi
  if (( 10#${current_major} < 10#${minimum_major} )); then return 1; fi
  if (( 10#${current_minor} > 10#${minimum_minor} )); then return 0; fi
  if (( 10#${current_minor} < 10#${minimum_minor} )); then return 1; fi
  (( 10#${current_patch} >= 10#${minimum_patch} ))
}

require_supported_node_stage0() {
  require_command node

  local current_version=""
  current_version="$(node --version 2>/dev/null || true)"
  current_version="${current_version//$'\r'/}"
  current_version="${current_version//$'\n'/}"
  if [[ -z "${current_version}" ]]; then
    die "unable to determine Node.js version; The Last Harness requires Node.js >= ${TLH_MIN_NODE_VERSION}."
  fi
  if ! version_at_least_stage0 "${current_version}" "${TLH_MIN_NODE_VERSION}"; then
    die "Node.js >= ${TLH_MIN_NODE_VERSION} is required (found ${current_version}). Install or upgrade Node.js, then rerun the installer."
  fi
}

stage0_uses_release_archive() {
  local ref="$1"
  [[ "${ref}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]
}

stage0_archive_url() {
  local ref="$1"

  if stage0_uses_release_archive "${ref}"; then
    printf 'https://github.com/%s/releases/download/%s/the-last-harness-%s.tgz\n' "${REPO}" "${ref}" "${ref#v}"
  else
    printf 'https://codeload.github.com/%s/tar.gz/%s\n' "${REPO}" "${ref}"
  fi
}

find_extracted_support_root() {
  local root="$1"
  local entry

  if support_root_ready "${root}"; then
    printf '%s\n' "${root}"
    return 0
  fi

  for entry in "${root}"/*; do
    [[ -d "${entry}" ]] || continue
    if support_root_ready "${entry}"; then
      printf '%s\n' "${entry}"
      return 0
    fi
  done

  return 1
}

fetch_remote_support_root() {
  local archive_url archive_path extract_dir support_root

  require_command curl
  require_command tar
  TMP_DIR="$(mktemp -d)"
  TMP_DIR="$(cd "${TMP_DIR}" >/dev/null 2>&1 && pwd -P)"
  extract_dir="${TMP_DIR}/extract"
  archive_path="${TMP_DIR}/tlh-stage1.tar.gz"
  archive_url="$(stage0_archive_url "${REF}")"
  mkdir -p "${extract_dir}"
  verbose_log "Downloading installer archive from ${archive_url}"

  if ! curl -fsSL "${archive_url}" -o "${archive_path}"; then
    die "failed to download installer archive for ref ${REF}: ${archive_url}"
  fi
  if ! tar -xzf "${archive_path}" -C "${extract_dir}"; then
    die "failed to extract installer archive for ref ${REF}: ${archive_url}"
  fi

  support_root="$(find_extracted_support_root "${extract_dir}")" || die "installer archive for ref ${REF} did not contain the required stage-1 support files"
  REMOTE_SUPPORT_ROOT="${support_root}"
}

run_stage1() {
  local support_root="$1"
  require_command node
  if [[ "${#ORIGINAL_ARGS[@]}" -eq 0 ]]; then
    TLH_REPO="${REPO}" TLH_REF="${REF}" TLH_RAW_BASE="${RAW_BASE}" TLH_UPDATE_TRACK="${UPDATE_TRACK_INPUT}" \
      node "${support_root}/scripts/tlh-install.mjs"
  else
    TLH_REPO="${REPO}" TLH_REF="${REF}" TLH_RAW_BASE="${RAW_BASE}" TLH_UPDATE_TRACK="${UPDATE_TRACK_INPUT}" \
      node "${support_root}/scripts/tlh-install.mjs" "${ORIGINAL_ARGS[@]}"
  fi
}

dry_run_without_stage1() {
  local agent_dir bin_dir settings_path keybindings_path package_source
  agent_dir="$(normalize_path_for_stage0 "${AGENT_DIR_INPUT}")"
  bin_dir="$(normalize_path_for_stage0 "${BIN_DIR_INPUT}")"
  settings_path="${agent_dir}/settings.json"
  keybindings_path="${agent_dir}/keybindings.json"
  package_source="${TLH_PACKAGE_SOURCE:-git:github.com/${REPO}@${REF}}"

  log "The Last Harness installer"
  log "Bootstrap-level/no-stage1 dry-run approximation (stage-1 was not downloaded or run)."
  log "Isolated profile: ${agent_dir}"
  if [[ -n "${package_source}" ]]; then
    log "Package source: ${package_source}"
  fi
  log "Would download installer archive from $(stage0_archive_url "${REF}")"
  log "Would run the stage-1 installer from the downloaded archive."
  if [[ "${NO_SETTINGS}" == "true" ]]; then
    log "Would skip settings and keybinding defaults merge (--no-settings)."
    log "Would skip bundled default extension packages (--no-settings)."
  else
    log "Would merge settings defaults into: ${settings_path}"
    log "Would merge keybinding defaults into: ${keybindings_path}"
    log "Would install bundled default extension packages after settings merge."
  fi
  log "Dry run only; no installer archive was downloaded."
  log ""
  log "Done. The Last Harness dry run completed without downloads or writes."
  log "Start with: PI_CODING_AGENT_DIR=\"${agent_dir}\" pi"
  if [[ "${NO_WRAPPER}" == "true" ]]; then
    log "Wrapper creation would be skipped (--no-wrapper)."
  else
    log "Wrapper path would be: ${bin_dir}/${WRAPPER_NAME}"
  fi
  log "Normal Pi config was not modified: ~/.pi/agent"
}

validate_stage0_fallback_targets
require_supported_node_stage0

LOCAL_SUPPORT_ROOT=""
if LOCAL_SUPPORT_ROOT="$(find_local_support_root)"; then
  run_stage1 "${LOCAL_SUPPORT_ROOT}"
  exit $?
fi

if [[ "${DRY_RUN}" == "true" ]]; then
  dry_run_without_stage1
  exit 0
fi

fetch_remote_support_root
run_stage1 "${REMOTE_SUPPORT_ROOT}"
