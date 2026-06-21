#!/usr/bin/env bash
# uninstall.sh — Remove The Last Harness isolated profile and optional pi package.
# Self-contained: no node, no support-file fetches.
# See: https://github.com/diegopetrucci/the-last-harness
set -euo pipefail

# ── defaults ───────────────────────────────────────────────────────────────────

AGENT_DIR_INPUT="${HOME}/.the-last-harness/agent"
BIN_DIR_INPUT="${HOME}/.local/bin"
WRAPPER_NAME="tlh"
DRY_RUN=false
FORCE_INCLUDE_PI=false
KEEP_PI=false
QUIET=false
VERBOSE=false
PI_PACKAGE_NAME="@earendil-works/pi-coding-agent"
PINNED_PI_VERSION="0.79.7"
RUNTIME_MARKER_FILENAME=".tlh-runtime-owned"
TLH_WRAPPER_MARKER_LINE="# Managed by The Last Harness installer"

# ── output helpers ─────────────────────────────────────────────────────────────

# say: always print (ignores --quiet) — for essential output, plan, advisory.
say() {
  printf '%s\n' "$*"
}

# log: suppressed by --quiet — for progress/informational lines.
log() {
  if [[ "${QUIET}" != "true" ]]; then
    printf '%s\n' "$*"
  fi
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

die() {
  local message="$1"
  local code="${2:-1}"
  printf 'error: %s\n' "${message}" >&2
  exit "${code}"
}

# ── path helpers (mirrors install.sh / scripts/lib/tlh-install-paths.mjs) ──────

expand_path() {
  local path="$1"
  case "${path}" in
    '~')    printf '%s\n' "${HOME}" ;;
    '~/'*)  printf '%s/%s\n' "${HOME}" "${path#\~/}" ;;
    *)      printf '%s\n' "${path}" ;;
  esac
}

normalize_path() {
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
      ''|.) ;;
      ..)
        if [[ "${#components[@]}" -gt 0 ]]; then
          last_index=$(( ${#components[@]} - 1 ))
          components=("${components[@]:0:${last_index}}")
        fi
        ;;
      *) components+=("${part}") ;;
    esac
  done

  if [[ "${#components[@]}" -eq 0 ]]; then
    printf '/\n'
  else
    local IFS='/'
    printf '/%s\n' "${components[*]}"
  fi
}

realpath_for_compare() {
  local path="$1"
  local normalized candidate parent base tail physical_prefix

  normalized="$(normalize_path "${path}")"
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

symlinked_parent_component_is_allowed_root_alias() {
  local path="$1"
  local expected_target=""

  case "${path}" in
    /var) expected_target="/private/var" ;;
    /tmp) expected_target="/private/tmp" ;;
    /etc) expected_target="/private/etc" ;;
    *) return 1 ;;
  esac

  [[ "$(realpath_for_compare "${path}")" == "$(normalize_path "${expected_target}")" ]]
}

find_symlinked_existing_parent_component() {
  local path="$1"
  local current remainder part parent_path

  path="$(normalize_path "${path}")"
  parent_path="$(dirname "${path}")"
  [[ "${parent_path}" == "/" ]] && return 1

  current="/"
  remainder="${parent_path#/}"

  while [[ -n "${remainder}" ]]; do
    if [[ "${remainder}" == */* ]]; then
      part="${remainder%%/*}"
      remainder="${remainder#*/}"
    else
      part="${remainder}"
      remainder=""
    fi

    if [[ "${current}" == "/" ]]; then
      current="/${part}"
    else
      current="${current}/${part}"
    fi

    if [[ -L "${current}" ]]; then
      if ! symlinked_parent_component_is_allowed_root_alias "${current}"; then
        printf '%s\n' "${current}"
        return 0
      fi
    fi
    if [[ ! -e "${current}" ]]; then
      return 1
    fi
  done

  return 1
}

path_within_or_equal() {
  local root="$1" path="$2"
  [[ "${path}" == "${root}" || "${path}" == "${root}/"* ]]
}

# Returns 0 (true) if path is inside or equal to the normal Pi config root (~/.pi).
# Mirrors pathIsProtectedPiConfig from scripts/lib/tlh-install-paths.mjs.
path_is_protected_pi_config() {
  local path="$1"
  local pi_root pi_agent_root
  pi_root="$(realpath_for_compare "${HOME}/.pi")"
  pi_agent_root="$(realpath_for_compare "${HOME}/.pi/agent")"
  path_within_or_equal "${pi_root}" "${path}" || path_within_or_equal "${pi_agent_root}" "${path}"
}

path_is_dangerous_recursive_target() {
  local path="$1"
  local compare_path="${2:-$1}"
  local home_normalized home_compare candidate cursor root home_path
  local -a system_roots=(
    "/Applications"
    "/Library"
    "/System"
    "/Users"
    "/Volumes"
    "/bin"
    "/boot"
    "/dev"
    "/etc"
    "/home"
    "/lib"
    "/lib64"
    "/media"
    "/mnt"
    "/opt"
    "/private"
    "/private/etc"
    "/private/tmp"
    "/private/var"
    "/private/var/tmp"
    "/proc"
    "/root"
    "/run"
    "/sbin"
    "/srv"
    "/tmp"
    "/usr"
    "/var"
    "/var/tmp"
  )
  local -a candidate_paths=("${path}")
  local -a home_paths=()

  if [[ "${compare_path}" != "${path}" ]]; then
    candidate_paths+=("${compare_path}")
  fi

  home_normalized="$(normalize_path "${HOME}")"
  home_compare="$(realpath_for_compare "${HOME}")"
  home_paths+=("${home_normalized}")
  if [[ "${home_compare}" != "${home_normalized}" ]]; then
    home_paths+=("${home_compare}")
  fi

  for candidate in "${candidate_paths[@]}"; do
    [[ "${candidate}" == "/" ]] && return 0

    for home_path in "${home_paths[@]}"; do
      [[ "${candidate}" == "${home_path}" ]] && return 0

      cursor="${home_path}"
      while [[ "${cursor}" != "/" ]]; do
        cursor="$(dirname "${cursor}")"
        [[ "${candidate}" == "${cursor}" ]] && return 0
      done
    done

    for root in "${system_roots[@]}"; do
      [[ "${candidate}" == "${root}" ]] && return 0
    done
  done

  return 1
}

tlh_ownership_marker_path() {
  printf '%s/tlh/install-state.json\n' "$1"
}

has_tlh_ownership_marker() {
  local agent_dir="$1"
  local marker marker_dir agent_dir_physical marker_physical

  marker="$(tlh_ownership_marker_path "${agent_dir}")"
  marker_dir="$(dirname "${marker}")"

  [[ -d "${marker_dir}" ]] || return 1
  [[ -f "${marker}" ]] || return 1
  [[ ! -L "${marker_dir}" ]] || return 1
  [[ ! -L "${marker}" ]] || return 1

  agent_dir_physical="$(realpath_for_compare "${agent_dir}")"
  marker_physical="$(realpath_for_compare "${marker}")"
  path_within_or_equal "${agent_dir_physical}" "${marker_physical}"
}

wrapper_file_has_tlh_marker() {
  local path="$1"
  local marker_line=""

  [[ -f "${path}" ]] || return 1
  marker_line="$(awk 'NR == 3 { sub(/\r$/, ""); print; exit }' "${path}" 2>/dev/null || true)"
  [[ "${marker_line}" == "${TLH_WRAPPER_MARKER_LINE}" ]]
}

wrapper_symlink_target_path() {
  local path="$1"
  local target=""

  target="$(readlink "${path}")" || return 1
  if [[ "${target}" == /* ]]; then
    normalize_path "${target}"
  else
    normalize_path "$(dirname "${path}")/${target}"
  fi
}

wrapper_symlink_is_tlh_owned() {
  local path="$1" profile_root="$2" profile_root_compare="$3"
  local target_path=""

  target_path="$(wrapper_symlink_target_path "${path}")" || return 1
  path_within_or_equal "${profile_root}" "${target_path}" || path_within_or_equal "${profile_root_compare}" "${target_path}"
}

need_value() {
  local flag="$1" value="${2:-}"
  if [[ -z "${value}" || "${value}" == -* ]]; then
    die "${flag} requires a value"
  fi
  printf '%s\n' "${value}"
}

# ── install-state parser ───────────────────────────────────────────────────────
# Reads piInstalledByTlh from install-state.json without node.
# Returns "true", "false", or "absent" (file missing, field missing, malformed).
# Handles CRLF line endings, trailing commas, and varying whitespace.

read_pi_installed_by_tlh() {
  local state_file="$1"
  if [[ ! -f "${state_file}" ]]; then
    printf 'absent\n'
    return 0
  fi
  # Strip CRLF before grepping; pattern tolerates any whitespace around the colon.
  if tr -d '\r' < "${state_file}" | grep -qE '"piInstalledByTlh"[[:space:]]*:[[:space:]]*true'; then
    printf 'true\n'
    return 0
  fi
  if tr -d '\r' < "${state_file}" | grep -qE '"piInstalledByTlh"[[:space:]]*:[[:space:]]*false'; then
    printf 'false\n'
    return 0
  fi
  printf 'absent\n'
}

# ── removal helper ─────────────────────────────────────────────────────────────
# Prints "+ <cmd>" before running in --verbose mode. Never called in --dry-run.

removal_run() {
  if [[ "${VERBOSE}" == "true" ]]; then
    say "  + $*"
  fi
  "$@"
}

# ── advisory section ───────────────────────────────────────────────────────────
# Always printed at end, regardless of --quiet.

print_advisory() {
  say ""
  say "Advisory:"
  if [[ -e "${HOME}/.pi" ]]; then
    say "  ~/.pi still exists (normal Pi config — not removed by tlh uninstall)."
    say "  To remove it manually: rm -rf \"${HOME}/.pi\""
  fi
  local pi_path=""
  pi_path="$(command -v pi 2>/dev/null || true)"
  if [[ -n "${pi_path}" ]]; then
    say "  pi is on PATH: ${pi_path}"
    say "  A separately-installed pi was left in place (manage it independently)."
  fi
  say "  Repo-local .gnosis/ and .tickets/ data is per-repo and was not modified."
}

# ── usage ──────────────────────────────────────────────────────────────────────

usage() {
  cat <<'USAGE'
Usage: uninstall.sh [options]

Uninstall The Last Harness isolated profile, tlh wrapper command, and
optionally the global pi coding-agent package installed by the tlh installer.

Normal Pi config at ~/.pi/agent is never touched by this script.

Options:
  --dry-run              Print planned actions without performing any removals.
  --force-include-pi     Remove pi/runtime even when install-state says
                           piInstalledByTlh=false or the field is absent.
                           For legacy ~/.local pi: required to perform removal;
                           without this flag the pi is never auto-removed to
                           protect user-owned installations.
  --keep-pi              Skip pi/runtime removal even when install-state says
                           piInstalledByTlh=true.
  --agent-dir DIR        Override isolated agent dir (default: ~/.the-last-harness/agent).
                           Only the agent dir is removed; parent dir is cleaned up only if empty.
  --bin-dir DIR          Override wrapper install dir (default: ~/.local/bin).
  --wrapper-name NAME    Override wrapper command basename (default: tlh).
  --quiet                Suppress non-essential output (errors and summary always shown).
  --verbose              Print each removal command before executing it.
  -h, --help             Show this help.

Notes:
  --force-include-pi and --keep-pi are mutually exclusive.
  Any path under ~/.pi or ~/.pi/agent is refused (normal Pi config safety guard).
  Repo-local .gnosis/ and .tickets/ data is per-repo and is never removed.

One-line uninstall (from release asset):
  curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/uninstall.sh | bash
USAGE
}

# ── flag parsing ───────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --force-include-pi)
      FORCE_INCLUDE_PI=true
      shift
      ;;
    --keep-pi)
      KEEP_PI=true
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
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

# ── conflict check ─────────────────────────────────────────────────────────────

if [[ "${FORCE_INCLUDE_PI}" == "true" && "${KEEP_PI}" == "true" ]]; then
  die "--force-include-pi and --keep-pi are mutually exclusive; pass only one" 2
fi

# ── resolve paths ──────────────────────────────────────────────────────────────

AGENT_DIR="$(normalize_path "${AGENT_DIR_INPUT}")"
PROFILE_ROOT="$(normalize_path "$(dirname "${AGENT_DIR}")")"
SYMLINKED_AGENT_PARENT="$(find_symlinked_existing_parent_component "${AGENT_DIR}" || true)"
AGENT_DIR_COMPARE="$(realpath_for_compare "${AGENT_DIR_INPUT}")"
PROFILE_ROOT_COMPARE="$(realpath_for_compare "${PROFILE_ROOT}")"
BIN_DIR="$(realpath_for_compare "${BIN_DIR_INPUT}")"
WRAPPER_PATH="${BIN_DIR}/${WRAPPER_NAME}"
INSTALL_STATE="$(tlh_ownership_marker_path "${AGENT_DIR}")"
RUNTIME_DIR="${PROFILE_ROOT}/runtime"
RUNTIME_BIN="${RUNTIME_DIR}/bin/pi"

# ── safety guard: refuse any path under normal Pi config (~/.pi) ───────────────
# Runs before wrapper-name character validation so that traversal via ".." in
# WRAPPER_NAME (e.g. "../.pi/agent/foo") is caught here rather than by the
# simpler character-class check below.

if path_is_protected_pi_config "${AGENT_DIR_COMPARE}"; then
  die "refusing to operate: --agent-dir is inside normal Pi config root (${AGENT_DIR_INPUT})"
fi
if path_is_protected_pi_config "${PROFILE_ROOT_COMPARE}"; then
  die "refusing to operate: profile root is inside normal Pi config root (${PROFILE_ROOT})"
fi
if path_is_protected_pi_config "${BIN_DIR}"; then
  die "refusing to operate: --bin-dir is inside normal Pi config root (${BIN_DIR_INPUT})"
fi
if path_is_protected_pi_config "$(realpath_for_compare "${WRAPPER_PATH}")"; then
  die "refusing to operate: resolved wrapper path is inside normal Pi config root (${WRAPPER_PATH})"
fi

# ── wrapper name validation ────────────────────────────────────────────────────

if [[ ! "${WRAPPER_NAME}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  die "--wrapper-name must be a simple command name (letters, numbers, dot, underscore, dash)"
fi

# ── validate agent-dir removal target ─────────────────────────────────────────

if [[ -n "${SYMLINKED_AGENT_PARENT}" ]]; then
  die "refusing to operate: --agent-dir traverses symlinked parent component (${SYMLINKED_AGENT_PARENT})"
fi

if path_is_dangerous_recursive_target "${AGENT_DIR}" "${AGENT_DIR_COMPARE}"; then
  die "refusing dangerous recursive --agent-dir target: ${AGENT_DIR}"
fi

# ── detect what exists ────────────────────────────────────────────────────────
# Use the agent dir (not the profile root) as the presence signal for TLH
# content. An empty parent directory created by e.g. mktemp is not a signal.

WRAPPER_EXISTS=false
WRAPPER_REMOVE=false
WRAPPER_SKIP_REASON=""
WRAPPER_TARGET_LITERAL=""
AGENT_DIR_EXISTS=false
AGENT_DIR_PRESENT=false
[[ -e "${WRAPPER_PATH}" || -L "${WRAPPER_PATH}" ]] && WRAPPER_EXISTS=true
[[ -e "${AGENT_DIR}" || -L "${AGENT_DIR}" ]] && AGENT_DIR_PRESENT=true

if [[ "${WRAPPER_EXISTS}" == "true" ]]; then
  if [[ -L "${WRAPPER_PATH}" ]]; then
    WRAPPER_TARGET_LITERAL="$(readlink "${WRAPPER_PATH}" 2>/dev/null || true)"
    if wrapper_symlink_is_tlh_owned "${WRAPPER_PATH}" "${PROFILE_ROOT}" "${PROFILE_ROOT_COMPARE}"; then
      WRAPPER_REMOVE=true
    else
      WRAPPER_SKIP_REASON="existing symlink target is outside the TLH profile"
      if [[ -n "${WRAPPER_TARGET_LITERAL}" ]]; then
        WRAPPER_SKIP_REASON+=" (${WRAPPER_TARGET_LITERAL})"
      fi
    fi
  elif [[ -f "${WRAPPER_PATH}" ]]; then
    if wrapper_file_has_tlh_marker "${WRAPPER_PATH}"; then
      WRAPPER_REMOVE=true
    else
      WRAPPER_SKIP_REASON="existing file is not managed by The Last Harness installer"
    fi
  else
    WRAPPER_SKIP_REASON="existing path is not a regular file or symlink"
  fi
fi

if [[ "${AGENT_DIR_PRESENT}" == "true" ]]; then
  if [[ -L "${AGENT_DIR}" ]]; then
    die "refusing to remove symlinked --agent-dir: ${AGENT_DIR}"
  fi
  if [[ ! -d "${AGENT_DIR}" ]]; then
    die "refusing to remove non-directory --agent-dir: ${AGENT_DIR}"
  fi
  if ! has_tlh_ownership_marker "${AGENT_DIR}"; then
    die "refusing to remove existing --agent-dir without TLH ownership marker: ${INSTALL_STATE}"
  fi
  AGENT_DIR_EXISTS=true
fi

# ── parse install-state; compute pi-removal decision ──────────────────────────
#
# piInstalledByTlh=true now means TLH owns the PRIVATE runtime at
# PROFILE_ROOT/runtime, NOT a global package at ~/.local.
#
# Decision matrix (REMOVE_PI initial value; ownership gate may override below):
#   --keep-pi                             → skip pi/runtime (regardless of state)
#   --force-include-pi                    → REMOVE_PI=true (affects legacy path only;
#                                           private runtime removal requires a valid marker)
#   state absent OR file missing          → REMOVE_PI=false
#   piInstalledByTlh = true               → REMOVE_PI=true
#   piInstalledByTlh = false              → REMOVE_PI=false
#
# For private runtime (RUNTIME_DIR): the ownership gate below is authoritative.
# A valid path-matched marker authorizes removal even when REMOVE_PI=false.
# An unmarked/invalid runtime skips regardless of REMOVE_PI or --force-include-pi.

PI_STATE="$(read_pi_installed_by_tlh "${INSTALL_STATE}")"

REMOVE_PI=false
PI_SKIP_REASON=""

if [[ "${KEEP_PI}" == "true" ]]; then
  REMOVE_PI=false
  PI_SKIP_REASON="--keep-pi flag"
elif [[ "${FORCE_INCLUDE_PI}" == "true" ]]; then
  REMOVE_PI=true
elif [[ "${PI_STATE}" == "true" ]]; then
  REMOVE_PI=true
else
  REMOVE_PI=false
  if [[ "${PI_STATE}" == "false" ]]; then
    PI_SKIP_REASON="install-state: piInstalledByTlh=false"
  else
    PI_SKIP_REASON="install-state absent or piInstalledByTlh field missing"
  fi
fi

# ── disambiguate what pi/runtime removal means (new-model vs legacy) ───────────
#
#  private runtime — TLH-owned (valid marker + layout)  → rm -rf RUNTIME_DIR
#  private runtime — unowned / shared / symlinked       → skip with conditional hint
#  legacy ~/.local/bin/pi                               → npm uninstall (--force-include-pi only)
#  neither exists                                       → no-op (skip with reason)
#
# Safety invariant: never delete ~/.local/bin/pi without --force-include-pi.
# The uninstall script cannot snapshot pre-install state and therefore cannot
# know whether ~/.local/bin/pi belongs to TLH or the user.  It is always kept
# unless the operator explicitly passes --force-include-pi.
#
# Ownership gate for RUNTIME_DIR (ALL must hold to rm -rf):
#   1. Valid RUNTIME_MARKER_FILENAME marker: parseable JSON, schemaVersion=1,
#      packageName match, origin in {created, migrated}.  Fail-closed: any
#      missing / malformed / symlinked / unreadable / schema-mismatched state
#      → treat as no valid claim → SKIP.
#   2. Recorded runtimeAbsPath equals realpath of RUNTIME_DIR.  Defends
#      against marker-copied-into-foreign-dir and relocation.
#   3. Neither RUNTIME_DIR nor the marker file is a symlink.
#   4. Positive pi layout present: bin/pi and lib/node_modules/<PI_PACKAGE_NAME>.
#
# Exclusivity check (advisory defense-in-depth, DEMOTED from gate to tripwire):
#   Run after all four gate conditions pass.  Unexpected top-level entries can
#   only DOWNGRADE to SKIP — never upgrade a failed gate to delete.
#   RUNTIME_MARKER_FILENAME is in the allow-list so a properly marked runtime
#   is not wrongly tripped by the marker dotfile.

PI_REMOVE_MODE="none"   # "runtime" | "legacy" | "none"
PI_UNINSTALL_DISPLAY=""

if [[ -d "${RUNTIME_DIR}" && "${KEEP_PI}" != "true" ]]; then
  # ── ownership gate ──────────────────────────────────────────────────────────
  # Evaluated regardless of REMOVE_PI / install-state (piInstalledByTlh).
  # The marker is the authoritative ownership signal; install-state is
  # non-gating for the marked private-runtime path.
  _runtime_marker_file="${RUNTIME_DIR}/${RUNTIME_MARKER_FILENAME}"
  _runtime_marker_valid=false
  _runtime_gate_skip_reason=""

  if [[ -L "${RUNTIME_DIR}" ]]; then
    _runtime_gate_skip_reason="${RUNTIME_DIR} is a symlink; cannot verify TLH ownership"
  elif [[ -L "${_runtime_marker_file}" ]]; then
    _runtime_gate_skip_reason="ownership marker ${_runtime_marker_file} is a symlink; cannot verify TLH ownership"
  elif [[ ! -f "${_runtime_marker_file}" ]]; then
    _runtime_gate_skip_reason="no TLH ownership marker found at ${_runtime_marker_file}; ${RUNTIME_DIR} may not be TLH-owned"
  else
    # Parse marker JSON (fail-closed; no jq, no node — uninstaller is self-contained).
    # JSON.stringify() produces compact single-line output; each field is extracted by
    # a BRE sed pattern.  An empty result for any field means absent/malformed → SKIP.
    _marker_raw="$(cat "${_runtime_marker_file}" 2>/dev/null || true)"
    _mver="$(printf '%s\n' "${_marker_raw}" | sed -n 's/.*"schemaVersion"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1)"
    _mpkg="$(printf '%s\n' "${_marker_raw}" | sed -n 's/.*"packageName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    _mpath="$(printf '%s\n' "${_marker_raw}" | sed -n 's/.*"runtimeAbsPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    _morigin="$(printf '%s\n' "${_marker_raw}" | sed -n 's/.*"origin"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"

    if [[ "${_mver}" != "1" ]]; then
      _runtime_gate_skip_reason="ownership marker at ${_runtime_marker_file} has invalid or missing schemaVersion (expected 1, got '${_mver}')"
    elif [[ "${_mpkg}" != "${PI_PACKAGE_NAME}" ]]; then
      _runtime_gate_skip_reason="ownership marker at ${_runtime_marker_file} packageName mismatch (expected '${PI_PACKAGE_NAME}', got '${_mpkg}')"
    elif [[ "${_morigin}" != "created" && "${_morigin}" != "migrated" ]]; then
      _runtime_gate_skip_reason="ownership marker at ${_runtime_marker_file} has unrecognised origin '${_morigin}' (expected created or migrated)"
    elif [[ -z "${_mpath}" ]]; then
      _runtime_gate_skip_reason="ownership marker at ${_runtime_marker_file} has empty runtimeAbsPath"
    else
      _runtime_real="$(realpath_for_compare "${RUNTIME_DIR}")"
      if [[ "${_mpath}" != "${_runtime_real}" ]]; then
        _runtime_gate_skip_reason="ownership marker runtimeAbsPath '${_mpath}' does not match realpath '${_runtime_real}' of ${RUNTIME_DIR}"
      else
        _runtime_marker_valid=true
      fi
    fi
  fi

  # Build a safely shell-quoted removal hint once; printf '%q' handles any
  # special characters in RUNTIME_DIR (spaces, quotes, $, backticks, etc.).
  _runtime_rm_hint="$(printf 'rm -rf -- %q' "${RUNTIME_DIR}")"

  if [[ "${_runtime_marker_valid}" != "true" ]]; then
    # Ownership gate failed — SKIP with conditional manual-removal hint.
    REMOVE_PI=false
    PI_SKIP_REASON="${_runtime_gate_skip_reason}. If this is TLH's private runtime and you no longer need its contents, run: ${_runtime_rm_hint}; otherwise leave it"
  elif [[ ! -f "${RUNTIME_BIN}" || ! -d "${RUNTIME_DIR}/lib/node_modules/${PI_PACKAGE_NAME}" ]]; then
    # Marker valid but positive pi layout absent.
    REMOVE_PI=false
    PI_SKIP_REASON="${RUNTIME_DIR} has a valid TLH ownership marker but the expected pi layout is missing (expected ${RUNTIME_BIN} and ${RUNTIME_DIR}/lib/node_modules/${PI_PACKAGE_NAME}). If this is TLH's private runtime and you no longer need its contents, run: ${_runtime_rm_hint}; otherwise leave it"
  else
    # All four gate conditions passed.  Exclusivity check (advisory only):
    # unexpected top-level entries can DOWNGRADE to SKIP, never upgrade to delete.
    # Use shopt dotglob+nullglob so a single '*' matches ALL real entries —
    # including dotfiles — while never matching '.' or '..'.
    # Save and restore prior shopt state so we don't leak options into the rest
    # of the script; `eval "${_prev_shopt_state}"` is safe because shopt -p
    # output is always of the form 'shopt -s|-u <name>'.
    _prev_shopt_state="$(shopt -p dotglob nullglob || true)"
    shopt -s dotglob nullglob
    _runtime_exclusive=true
    _runtime_unexpected_entry=""
    for _runtime_entry in "${RUNTIME_DIR}"/*; do
      [[ -e "${_runtime_entry}" || -L "${_runtime_entry}" ]] || continue
      _runtime_basename="${_runtime_entry##*/}"
      case "${_runtime_basename}" in
        bin|lib|node-compile-cache|"${RUNTIME_MARKER_FILENAME}") ;;
        *)
          _runtime_exclusive=false
          _runtime_unexpected_entry="${_runtime_entry}"
          break
          ;;
      esac
    done
    eval "${_prev_shopt_state}"   # restore dotglob+nullglob to their prior state
    if [[ "${_runtime_exclusive}" == "true" ]]; then
      # Marker is authoritative: authorize removal regardless of install-state.
      REMOVE_PI=true
      PI_REMOVE_MODE="runtime"
      PI_UNINSTALL_DISPLAY="rm -rf \"${RUNTIME_DIR}\""
    else
      # Exclusivity tripwire fired (advisory): unexpected entry found.
      # Downgrade to SKIP to protect co-located files.
      REMOVE_PI=false
      PI_SKIP_REASON="${RUNTIME_DIR} contains unexpected top-level entries alongside the TLH pi layout (e.g. ${_runtime_unexpected_entry}); not removing to protect co-located files. If this is TLH's private runtime and you no longer need its contents, run: ${_runtime_rm_hint}; otherwise leave it"
    fi
  fi
elif [[ "${REMOVE_PI}" == "true" ]]; then
  # No private runtime at RUNTIME_DIR; fall through to legacy ~/.local/bin/pi
  # or absent-pi handling.
  if [[ -f "${HOME}/.local/bin/pi" ]]; then
    if [[ "${FORCE_INCLUDE_PI}" == "true" ]]; then
      PI_REMOVE_MODE="legacy"
      PI_UNINSTALL_DISPLAY="npm uninstall -g --ignore-scripts --prefix \"${HOME}/.local\" ${PI_PACKAGE_NAME}"
    else
      # Never auto-remove legacy ~/.local/bin/pi — the uninstall script cannot snapshot
      # pre-install state and therefore cannot determine whether this binary belongs to
      # TLH or to the user.  Require --force-include-pi for any legacy removal.
      REMOVE_PI=false
      PI_SKIP_REASON="legacy ~/.local/bin/pi was not removed automatically (pass --force-include-pi to remove it). To remove manually: npm uninstall -g --ignore-scripts --prefix \"${HOME}/.local\" ${PI_PACKAGE_NAME}"
    fi
  else
    # Neither the private runtime nor a legacy ~/.local pi is present.
    REMOVE_PI=false
    PI_SKIP_REASON="no pi installation found (neither private runtime at ${RUNTIME_DIR} nor legacy ~/.local/bin/pi)"
  fi
fi

# ── idempotency: nothing to remove ────────────────────────────────────────────

if [[ "${WRAPPER_EXISTS}" == "false" && "${AGENT_DIR_EXISTS}" == "false" && "${REMOVE_PI}" == "false" ]]; then
  say "Nothing to remove."
  print_advisory
  exit 0
fi

# ── print plan ─────────────────────────────────────────────────────────────────

log ""
log "The Last Harness uninstaller"
log "════════════════════════════"
say ""

if [[ "${DRY_RUN}" == "true" ]]; then
  say "Uninstall plan (dry run — no changes will be made):"
else
  say "Uninstall plan:"
fi

STEP=0

if [[ "${WRAPPER_EXISTS}" == "true" ]]; then
  if [[ "${WRAPPER_REMOVE}" == "true" ]]; then
    STEP=$(( STEP + 1 ))
    if [[ "${DRY_RUN}" == "true" ]]; then
      say "  ${STEP}. would run: rm -f ${WRAPPER_PATH}"
    else
      say "  ${STEP}. Remove wrapper:      ${WRAPPER_PATH}"
    fi
  else
    say "     Skip wrapper removal: ${WRAPPER_PATH}"
    say "        (${WRAPPER_SKIP_REASON})"
  fi
fi

if [[ "${AGENT_DIR_EXISTS}" == "true" ]]; then
  STEP=$(( STEP + 1 ))
  if [[ "${DRY_RUN}" == "true" ]]; then
    say "  ${STEP}. would run: rm -rf ${AGENT_DIR}"
    say "             and rmdir ${PROFILE_ROOT} if empty"
  else
    say "  ${STEP}. Remove agent dir:    ${AGENT_DIR}"
    say "             (parent ${PROFILE_ROOT} removed only if empty)"
  fi
fi

if [[ "${REMOVE_PI}" == "true" ]]; then
  STEP=$(( STEP + 1 ))
  if [[ "${PI_REMOVE_MODE}" == "runtime" ]]; then
    if [[ "${DRY_RUN}" == "true" ]]; then
      say "  ${STEP}. would remove private runtime: rm -rf ${RUNTIME_DIR}"
      say "             and rmdir ${PROFILE_ROOT} if empty"
    else
      say "  ${STEP}. Remove private runtime: ${RUNTIME_DIR}"
      say "             (parent ${PROFILE_ROOT} removed only if empty)"
    fi
  else
    if [[ "${DRY_RUN}" == "true" ]]; then
      say "  ${STEP}. would remove legacy pi (npm): ${PI_UNINSTALL_DISPLAY}"
    else
      say "  ${STEP}. Remove legacy pi (npm): ${PI_UNINSTALL_DISPLAY}"
    fi
  fi
else
  if [[ "${DRY_RUN}" == "true" ]]; then
    say "     would skip pi/runtime removal (${PI_SKIP_REASON})"
  else
    say "     Skip pi/runtime removal (${PI_SKIP_REASON})"
  fi
fi

say ""
say "Will NOT be removed:"
say "  - Normal Pi config at ~/.pi (if any)"
say "  - Repo-local .gnosis/ and .tickets/ data (per-repo, untouched)"

if [[ "${DRY_RUN}" == "true" ]]; then
  print_advisory
  exit 0
fi

# ── execute removals ───────────────────────────────────────────────────────────

say ""

if [[ "${WRAPPER_EXISTS}" == "true" ]]; then
  if [[ "${WRAPPER_REMOVE}" == "true" ]]; then
    log "Removing wrapper: ${WRAPPER_PATH}"
    removal_run rm -f "${WRAPPER_PATH}"
  else
    warn "skipping wrapper removal for ${WRAPPER_PATH}; ${WRAPPER_SKIP_REASON}"
  fi
fi

if [[ "${AGENT_DIR_EXISTS}" == "true" ]]; then
  log "Removing agent dir: ${AGENT_DIR}"
  removal_run rm -rf "${AGENT_DIR}"
  if [[ "${VERBOSE}" == "true" ]]; then
    say "  + rmdir ${PROFILE_ROOT}"
  fi
  rmdir "${PROFILE_ROOT}" 2>/dev/null || true
fi

if [[ "${REMOVE_PI}" == "true" ]]; then
  if [[ "${PI_REMOVE_MODE}" == "runtime" ]]; then
    log "Removing private runtime: ${RUNTIME_DIR}"
    removal_run rm -rf "${RUNTIME_DIR}"
    if [[ "${VERBOSE}" == "true" ]]; then
      say "  + rmdir ${PROFILE_ROOT}"
    fi
    rmdir "${PROFILE_ROOT}" 2>/dev/null || true
  elif [[ "${PI_REMOVE_MODE}" == "legacy" ]]; then
    if ! command -v npm >/dev/null 2>&1; then
      warn "npm not found on PATH; legacy pi must be removed manually."
      warn "To remove: ${PI_UNINSTALL_DISPLAY}"
    else
      log "Removing legacy pi from ~/.local via npm..."
      removal_run npm uninstall -g --ignore-scripts --prefix "${HOME}/.local" "${PI_PACKAGE_NAME}"
    fi
  fi
fi

# ── done ───────────────────────────────────────────────────────────────────────

say ""
say "Done. The Last Harness has been uninstalled."

print_advisory
