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
  --force-include-pi     Remove pi via npm even when install-state says
                           piInstalledByTlh=false or the field is absent.
  --keep-pi              Skip pi removal even when install-state says
                           piInstalledByTlh=true.
  --agent-dir DIR        Override isolated agent dir (default: ~/.the-last-harness/agent).
                           The profile root (parent dir) is what gets removed.
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

AGENT_DIR="$(realpath_for_compare "${AGENT_DIR_INPUT}")"
PROFILE_ROOT="$(dirname "${AGENT_DIR}")"
BIN_DIR="$(realpath_for_compare "${BIN_DIR_INPUT}")"
WRAPPER_PATH="${BIN_DIR}/${WRAPPER_NAME}"
INSTALL_STATE="${AGENT_DIR}/tlh/install-state.json"

# ── safety guard: refuse any path under normal Pi config (~/.pi) ───────────────
# Runs before wrapper-name character validation so that traversal via ".." in
# WRAPPER_NAME (e.g. "../.pi/agent/foo") is caught here rather than by the
# simpler character-class check below.

if path_is_protected_pi_config "${AGENT_DIR}"; then
  die "refusing to operate: --agent-dir is inside normal Pi config root (${AGENT_DIR_INPUT})"
fi
if path_is_protected_pi_config "${PROFILE_ROOT}"; then
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

# ── parse install-state; compute pi-removal decision ──────────────────────────
#
# Decision matrix:
#   --keep-pi                             → skip pi (regardless of state)
#   --force-include-pi                    → remove pi (regardless of state)
#   state absent OR file missing          → skip pi
#   piInstalledByTlh = true               → remove pi
#   piInstalledByTlh = false              → skip pi

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

# ── detect what exists ────────────────────────────────────────────────────────
# Use the agent dir (not the profile root) as the presence signal for TLH
# content. An empty parent directory created by e.g. mktemp is not a signal.

WRAPPER_EXISTS=false
AGENT_DIR_EXISTS=false
[[ -e "${WRAPPER_PATH}" ]] && WRAPPER_EXISTS=true
[[ -e "${AGENT_DIR}" ]]    && AGENT_DIR_EXISTS=true

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
  STEP=$(( STEP + 1 ))
  if [[ "${DRY_RUN}" == "true" ]]; then
    say "  ${STEP}. would run: rm -f ${WRAPPER_PATH}"
  else
    say "  ${STEP}. Remove wrapper:      ${WRAPPER_PATH}"
  fi
fi

if [[ "${AGENT_DIR_EXISTS}" == "true" ]]; then
  STEP=$(( STEP + 1 ))
  if [[ "${DRY_RUN}" == "true" ]]; then
    say "  ${STEP}. would run: rm -rf ${PROFILE_ROOT}"
  else
    say "  ${STEP}. Remove profile root: ${PROFILE_ROOT}"
  fi
fi

if [[ "${REMOVE_PI}" == "true" ]]; then
  STEP=$(( STEP + 1 ))
  if [[ "${DRY_RUN}" == "true" ]]; then
    say "  ${STEP}. would npm uninstall pi: npm uninstall -g @earendil-works/pi-coding-agent"
  else
    say "  ${STEP}. Remove pi (npm):     npm uninstall -g @earendil-works/pi-coding-agent"
  fi
else
  if [[ "${DRY_RUN}" == "true" ]]; then
    say "     would skip pi removal (${PI_SKIP_REASON})"
  else
    say "     Skip pi removal (${PI_SKIP_REASON})"
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
  log "Removing wrapper: ${WRAPPER_PATH}"
  removal_run rm -f "${WRAPPER_PATH}"
fi

if [[ "${AGENT_DIR_EXISTS}" == "true" ]]; then
  log "Removing profile root: ${PROFILE_ROOT}"
  removal_run rm -rf "${PROFILE_ROOT}"
fi

if [[ "${REMOVE_PI}" == "true" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    warn "npm not found on PATH; pi must be removed manually."
    warn "To remove pi: npm uninstall -g @earendil-works/pi-coding-agent"
  else
    log "Removing pi via npm..."
    removal_run npm uninstall -g @earendil-works/pi-coding-agent
  fi
fi

# ── done ───────────────────────────────────────────────────────────────────────

say ""
say "Done. The Last Harness has been uninstalled."

print_advisory
