#!/usr/bin/env bash
set -euo pipefail

REPO="${TLH_REPO:-diegopetrucci/the-last-harness}"
REF="${TLH_REF:-main}"
# Keep in sync with MIN_NODE_VERSION and PINNED_PI_VERSION in scripts/tlh-install.mjs.
TLH_MIN_NODE_VERSION="22.19.0"
TLH_PINNED_PI_VERSION="0.84.2"

# Keep stage-0 remote support downloads bounded so an unavailable raw-file
# request cannot hold up the installer indefinitely, especially in parallel.
TLH_STAGE0_FETCH_CONCURRENCY=8
TLH_STAGE0_CURL_RETRIES=2
TLH_STAGE0_CURL_RETRY_DELAY_SECONDS=1
TLH_STAGE0_CURL_RETRY_MAX_TIME_SECONDS=20
TLH_STAGE0_CURL_CONNECT_TIMEOUT_SECONDS=5
TLH_STAGE0_CURL_MAX_TIME_SECONDS=30

DRY_RUN=false
NO_SETTINGS=false
NO_WRAPPER=false
QUIET=false
VERBOSE=false
# Track whether AGENT_DIR_INPUT and WRAPPER_NAME were explicitly set (env or CLI).
# Explicit values always win over ref-derived defaults (mirrors tlh-install.mjs).
if [[ -n "${TLH_AGENT_DIR:-}" ]]; then
  AGENT_DIR_INPUT="${TLH_AGENT_DIR}"
  AGENT_DIR_EXPLICIT=true
else
  AGENT_DIR_INPUT="$HOME/.the-last-harness/agent"
  AGENT_DIR_EXPLICIT=false
fi
BIN_DIR_INPUT="${TLH_BIN_DIR:-$HOME/.local/bin}"
if [[ -n "${TLH_WRAPPER_NAME:-}" ]]; then
  WRAPPER_NAME="${TLH_WRAPPER_NAME}"
  WRAPPER_NAME_EXPLICIT=true
else
  WRAPPER_NAME="tlh"
  WRAPPER_NAME_EXPLICIT=false
fi
UPDATE_TRACK_INPUT="${TLH_UPDATE_TRACK:-}"
RAW_BASE_INPUT="${TLH_RAW_BASE:-}"
TMP_DIR=""
ORIGINAL_ARGS=("$@")
TLH_SUBAGENT_PROMPTS=(developer.md code-reviewer.md repo-scout.md diff-summarizer.md librarian.md oracle.md contrarian.md web-scout.md)

usage() {
  cat <<USAGE
Usage: install.sh [options]

Install upstream Pi and The Last Harness as a separate tlh command. Normal Pi
config under ~/.pi/agent is not modified.

Requirements:
  Node.js >= ${TLH_MIN_NODE_VERSION} on PATH
  Upstream Pi ${TLH_PINNED_PI_VERSION} (installed into a private TLH runtime at ~/.the-last-harness/runtime;
  a global pi is never used or modified; install or repair failures stop with an actionable error)
USAGE
  cat <<'USAGE'

Options:
  --dry-run        Print actions and settings/keybinding changes without writing
  --force          Allow scalar isolated defaults and installer wrapper overwrite
  --no-settings     Install the package but skip isolated settings/keybinding merge
  --no-wrapper      Skip creating the tlh wrapper command
  --agent-dir DIR   Isolated Pi agent dir
                    (default for main: ~/.the-last-harness-main/agent;
                     default for release tags: ~/.the-last-harness/agent)
  --bin-dir DIR     Wrapper install dir (default: ~/.local/bin)
  --wrapper-name N  Wrapper command name
                    (default for main: tlh-main; default for release tags: tlh)
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
  TLH_GNOSIS_VERSION   Gnosis version to install (default: 0.5.4)
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
  # literal '~/' in case arms is intentional; these arms detect unexpanded tildes passed as path arguments
  # shellcheck disable=SC2088
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
    --force)
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
      AGENT_DIR_EXPLICIT=true
      shift 2
      ;;
    --agent-dir=*)
      AGENT_DIR_INPUT="${1#--agent-dir=}"
      [[ -n "${AGENT_DIR_INPUT}" ]] || die "--agent-dir requires a value"
      AGENT_DIR_EXPLICIT=true
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
      WRAPPER_NAME_EXPLICIT=true
      shift 2
      ;;
    --wrapper-name=*)
      WRAPPER_NAME="${1#--wrapper-name=}"
      [[ -n "${WRAPPER_NAME}" ]] || die "--wrapper-name requires a value"
      WRAPPER_NAME_EXPLICIT=true
      shift
      ;;
    --pi-installed-by-tlh)
      # Accept and pass through to stage-1, which owns boolean validation.
      need_value "$1" "${2:-}" >/dev/null
      shift 2
      ;;
    --pi-installed-by-tlh=*)
      [[ -n "${1#--pi-installed-by-tlh=}" ]] || die "--pi-installed-by-tlh requires a value"
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

# Apply ref-conditional defaults (mirrors buildInstallConfig in scripts/tlh-install.mjs).
# When REF == main and the user did NOT explicitly set wrapper name or agent dir
# (via env var or CLI flag), use tlh-main / ~/.the-last-harness-main/agent so that
# main-track installs don't collide with release-tag installs.
# Explicit values (WRAPPER_NAME_EXPLICIT / AGENT_DIR_EXPLICIT) always win.
if [[ "${REF}" == "main" ]]; then
  if [[ "${WRAPPER_NAME_EXPLICIT}" != "true" ]]; then
    WRAPPER_NAME="tlh-main"
  fi
  if [[ "${AGENT_DIR_EXPLICIT}" != "true" ]]; then
    AGENT_DIR_INPUT="$HOME/.the-last-harness-main/agent"
  fi
fi

RAW_BASE="${RAW_BASE_INPUT:-https://raw.githubusercontent.com/${REPO}/${REF}}"

bootstrap_support_manifest() {
  cat <<'EOF_SUPPORT_FILES'
required|scripts/tlh-install.mjs
required|scripts/lib/tlh-install-support-manifest.mjs
required|scripts/lib/tlh-install-package-source.mjs
required|scripts/lib/tlh-install-paths.mjs
required|scripts/lib/tlh-safe-profile-write.mjs
required|scripts/lib/tlh-install-utils.mjs
required|scripts/lib/tlh-install-git.mjs
required|scripts/lib/tlh-install-subagents.mjs
required|scripts/lib/tlh-install-support-files.mjs
required|scripts/merge-settings.mjs
required|scripts/tlh-defaults.mjs
required|scripts/lib/default-extensions.mjs
required|scripts/tlh-gnosis.mjs
required|scripts/tlh-tickets.mjs
required|scripts/tlh-recover-update.mjs
optional|scripts/tlh-update.mjs
optional|scripts/tlh-wrapper.mjs
optional|scripts/tlh-install-state.mjs
required|config/settings.defaults.json
required|config/default-extensions.json
EOF_SUPPORT_FILES
  if [[ "${NO_SETTINGS}" != "true" ]]; then
    cat <<'EOF_SETTINGS_SUPPORT_FILES'
required|scripts/merge-keybindings.mjs
required|config/keybindings.defaults.json
EOF_SETTINGS_SUPPORT_FILES
  fi
}

local_support_root_ready() {
  local root="$1"
  local requirement relative_path
  [[ -f "${root}/scripts/tlh-install.mjs" ]] || return 1
  while IFS='|' read -r requirement relative_path; do
    [[ -n "${relative_path}" ]] || continue
    if [[ "${requirement}" == "required" && ! -f "${root}/${relative_path}" ]]; then
      return 1
    fi
  done <<< "$(bootstrap_support_manifest)"
  return 0
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
  if local_support_root_ready "${dir}"; then
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

warn_missing_optional_support_file() {
  local relative_path="$1"
  case "${relative_path}" in
    scripts/tlh-update.mjs)
      warn "tlh update support script not found for ref ${REF}; the wrapper update helper will be unavailable"
      ;;
    scripts/tlh-wrapper.mjs)
      warn "tlh wrapper support script not found for ref ${REF}; wrapper creation will be unavailable"
      ;;
    scripts/tlh-install-state.mjs)
      warn "tlh install-state support script not found for ref ${REF}; update metadata helper will be unavailable"
      ;;
    *)
      warn "optional installer support file not found for ref ${REF}: ${relative_path}"
      ;;
  esac
}

fetch_support_file() {
  local url="$1"
  local target_path="$2"
  mkdir -p "$(dirname "${target_path}")"
  curl -fsSL \
    --retry "${TLH_STAGE0_CURL_RETRIES}" \
    --retry-delay "${TLH_STAGE0_CURL_RETRY_DELAY_SECONDS}" \
    --retry-max-time "${TLH_STAGE0_CURL_RETRY_MAX_TIME_SECONDS}" \
    --connect-timeout "${TLH_STAGE0_CURL_CONNECT_TIMEOUT_SECONDS}" \
    --max-time "${TLH_STAGE0_CURL_MAX_TIME_SECONDS}" \
    -o "${target_path}" "${url}"
}

fetch_remote_support_root() {
  # Bash 3.2 has no wait -n, so fetch in bounded batches and wait for every
  # worker before inspecting results. Status files keep background failures
  # from triggering the parent shell's set -e trap prematurely.
  local status_dir requirement relative_path prompt pid
  local i batch_start batch_end total req rel_path target_path status_file exit_status
  local -a all_requirements all_paths batch_pids
  all_requirements=()
  all_paths=()

  require_command curl
  TMP_DIR="$(mktemp -d)"
  TMP_DIR="$(cd "${TMP_DIR}" >/dev/null 2>&1 && pwd -P)"
  verbose_log "Fetching installer support files from ${RAW_BASE}"

  # Keep status files inside the existing temporary root so cleanup removes
  # them on success and on any required-file failure.
  status_dir="${TMP_DIR}/.fetch-status"
  mkdir -p "${status_dir}"

  # Build one ordered work list from the manifest, then add the non-fatal
  # subagent prompt downloads. Results are processed in this same order below.
  while IFS='|' read -r requirement relative_path; do
    [[ -n "${relative_path}" ]] || continue
    all_requirements+=("${requirement}")
    all_paths+=("${relative_path}")
  done <<< "$(bootstrap_support_manifest)"

  if [[ "${NO_SETTINGS}" != "true" ]]; then
    mkdir -p "${TMP_DIR}/agents/subagents"
    for prompt in "${TLH_SUBAGENT_PROMPTS[@]}"; do
      all_requirements+=("subagent")
      all_paths+=("agents/subagents/${prompt}")
    done
  fi

  total=${#all_paths[@]}
  batch_start=0
  while [[ "${batch_start}" -lt "${total}" ]]; do
    batch_end=$((batch_start + TLH_STAGE0_FETCH_CONCURRENCY))
    if [[ "${batch_end}" -gt "${total}" ]]; then
      batch_end="${total}"
    fi

    batch_pids=()
    for ((i = batch_start; i < batch_end; i++)); do
      rel_path="${all_paths[$i]}"
      target_path="${TMP_DIR}/${rel_path}"
      status_file="${status_dir}/${i}"
      mkdir -p "$(dirname "${target_path}")"
      (
        # Keep a worker from ever running the parent cleanup trap.
        trap - EXIT
        if fetch_support_file "${RAW_BASE}/${rel_path}" "${target_path}" && [[ -f "${target_path}" ]]; then
          printf '0\n' >"${status_file}"
        else
          printf '1\n' >"${status_file}"
        fi
      ) &
      batch_pids+=("$!")
    done

    # Always await each PID, including failed workers, before starting another
    # batch. This prevents cleanup or result handling from racing active curl.
    if [[ "${#batch_pids[@]}" -gt 0 ]]; then
      for pid in "${batch_pids[@]}"; do
        wait "${pid}" || true
      done
    fi
    batch_start="${batch_end}"
  done

  # Process failures in manifest order so required/optional behavior and error
  # messages remain identical to the sequential bootstrap implementation.
  for ((i = 0; i < total; i++)); do
    req="${all_requirements[$i]}"
    rel_path="${all_paths[$i]}"
    target_path="${TMP_DIR}/${rel_path}"
    status_file="${status_dir}/${i}"
    exit_status=1
    if [[ -f "${status_file}" ]]; then
      exit_status="$(cat "${status_file}")"
    fi

    if [[ "${exit_status}" != "0" ]]; then
      rm -f "${target_path}"
      if [[ "${req}" == "required" ]]; then
        die "required installer support file not found for ref ${REF}: ${rel_path}"
      elif [[ "${req}" != "subagent" ]]; then
        warn_missing_optional_support_file "${rel_path}"
      fi
    fi
  done
}

# Remote/stale stage-0 installers cannot reliably tell whether their embedded
# support manifest still matches the requested ref, so refresh install.sh once
# before any manifest-driven fetches. Local checkouts and dry runs bypass this.
canonicalize_stage0_installer() {
  require_command curl
  TMP_DIR="$(mktemp -d)"
  TMP_DIR="$(cd "${TMP_DIR}" >/dev/null 2>&1 && pwd -P)"

  local canonical_installer="${TMP_DIR}/install.sh"
  log "Refreshing installer..."
  verbose_log "Refreshing installer stage-0 from ${RAW_BASE}/install.sh before fetching support files."
  if ! fetch_support_file "${RAW_BASE}/install.sh" "${canonical_installer}"; then
    rm -f "${canonical_installer}"
    die "unable to refresh installer stage-0 from ${RAW_BASE}/install.sh for ref ${REF}"
  fi

  if [[ "${#ORIGINAL_ARGS[@]}" -eq 0 ]]; then
    TLH_REPO="${REPO}" TLH_REF="${REF}" TLH_RAW_BASE="${RAW_BASE}" TLH_UPDATE_TRACK="${UPDATE_TRACK_INPUT}" \
      _TLH_STAGE0_CANONICALIZED=1 bash "${canonical_installer}"
  else
    TLH_REPO="${REPO}" TLH_REF="${REF}" TLH_RAW_BASE="${RAW_BASE}" TLH_UPDATE_TRACK="${UPDATE_TRACK_INPUT}" \
      _TLH_STAGE0_CANONICALIZED=1 bash "${canonical_installer}" "${ORIGINAL_ARGS[@]}"
  fi
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
  log "Would fetch installer support files from ${RAW_BASE}"
  if [[ "${NO_SETTINGS}" == "true" ]]; then
    log "Would skip settings and keybinding defaults merge (--no-settings)."
    log "Would skip bundled default extension packages (--no-settings)."
  else
    log "Would merge settings defaults into: ${settings_path}"
    log "Would merge keybinding defaults into: ${keybindings_path}"
    log "Would install bundled default extension packages after settings merge."
  fi
  log "Would fetch Gnosis integration support files."
  log "Would fetch tlh tickets support files."
  log "Would fetch tlh update support files."
  log "Would fetch tlh wrapper support files."
  log "Would fetch tlh install-state support files."
  log "Dry run only; no support files were downloaded."
  log ""
  log "Done. The Last Harness dry run completed without downloads or writes."
  if [[ "${NO_WRAPPER}" == "true" ]]; then
    log "Wrapper creation would be skipped (--no-wrapper)."
    log "Start with: PI_CODING_AGENT_DIR=\"${agent_dir}\" \"${agent_dir%/*}/runtime/bin/pi\""
  else
    log "Wrapper path would be: ${bin_dir}/${WRAPPER_NAME}"
    log "Start with: ${WRAPPER_NAME}"
  fi
  log "Normal Pi config was not modified: ~/.pi/agent"
}

validate_stage0_fallback_targets

LOCAL_SUPPORT_ROOT=""
if LOCAL_SUPPORT_ROOT="$(find_local_support_root)"; then
  require_supported_node_stage0
  run_stage1 "${LOCAL_SUPPORT_ROOT}"
  exit $?
fi

if [[ "${DRY_RUN}" == "true" ]]; then
  require_supported_node_stage0
  dry_run_without_stage1
  exit 0
fi

if [[ "${_TLH_STAGE0_CANONICALIZED:-}" != "1" ]]; then
  require_command node
  canonicalize_stage0_installer
  exit $?
fi

require_supported_node_stage0
require_command node
fetch_remote_support_root
run_stage1 "${TMP_DIR}"
