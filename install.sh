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
TMP_DIR=""
PACKAGE_SOURCE="${TLH_PACKAGE_SOURCE:-}"
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
  --no-settings    Install the package but skip isolated settings merge
  --no-wrapper     Skip creating the tlh wrapper command
  --agent-dir DIR  Isolated Pi agent dir (default: ~/.the-last-harness/agent)
  --bin-dir DIR    Wrapper install dir (default: ~/.local/bin)
  --wrapper-name N Wrapper command name (default: tlh)
  --ref REF        Install The Last Harness from a branch, tag, or commit
  -h, --help       Show this help

Environment overrides:
  TLH_AGENT_DIR        Isolated Pi agent dir
  TLH_BIN_DIR          Wrapper install dir
  TLH_WRAPPER_NAME     Wrapper command name
  TLH_REPO             GitHub repo, owner/name (default: diegopetrucci/the-last-harness)
  TLH_REF              Raw-file ref and package ref (default: main in source; release assets pin this to their tag)
  TLH_PACKAGE_SOURCE   Package source passed to `pi install`
  TLH_RAW_BASE         Base URL for installer support files

Examples:
  curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash
  curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash -s -- --dry-run
  bash install.sh --agent-dir ~/.tlh/agent --bin-dir ~/.local/bin
USAGE
}

log() {
  if [[ "${QUIET}" != "true" ]]; then
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

run() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    print_command "$@"
  else
    "$@"
  fi
}

run_isolated_pi() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    print_command env "PI_CODING_AGENT_DIR=${AGENT_DIR}" "$@"
  else
    (cd "${AGENT_DIR}" && PI_CODING_AGENT_DIR="${AGENT_DIR}" "$@")
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
  if local_dir="$(find_local_repo_dir)"; then
    MERGE_SCRIPT="${local_dir}/scripts/merge-settings.mjs"
    TLH_DEFAULTS_SCRIPT="${local_dir}/scripts/tlh-defaults.mjs"
    DEFAULTS_FILE="${local_dir}/config/settings.defaults.json"
    DEFAULT_EXTENSIONS_FILE="${local_dir}/config/default-extensions.json"
    return 0
  fi

  require_command curl
  TMP_DIR="$(mktemp -d)"
  MERGE_SCRIPT="${TMP_DIR}/merge-settings.mjs"
  TLH_DEFAULTS_SCRIPT="${TMP_DIR}/tlh-defaults.mjs"
  DEFAULTS_FILE="${TMP_DIR}/settings.defaults.json"
  DEFAULT_EXTENSIONS_FILE="${TMP_DIR}/default-extensions.json"

  log "Fetching installer support files from ${RAW_BASE}"
  curl -fsSL "${RAW_BASE}/scripts/merge-settings.mjs" -o "${MERGE_SCRIPT}"
  curl -fsSL "${RAW_BASE}/scripts/tlh-defaults.mjs" -o "${TLH_DEFAULTS_SCRIPT}"
  curl -fsSL "${RAW_BASE}/config/settings.defaults.json" -o "${DEFAULTS_FILE}"
  curl -fsSL "${RAW_BASE}/config/default-extensions.json" -o "${DEFAULT_EXTENSIONS_FILE}"
}

prepare_merge_files_for_dry_run() {
  local local_dir=""
  if local_dir="$(find_local_repo_dir)"; then
    MERGE_SCRIPT="${local_dir}/scripts/merge-settings.mjs"
    TLH_DEFAULTS_SCRIPT="${local_dir}/scripts/tlh-defaults.mjs"
    DEFAULTS_FILE="${local_dir}/config/settings.defaults.json"
    DEFAULT_EXTENSIONS_FILE="${local_dir}/config/default-extensions.json"
    return 0
  fi

  log "Would fetch installer support files from ${RAW_BASE}"
  log "Would merge settings defaults into: ${SETTINGS_PATH}"
  log "Would install bundled default extension packages after settings merge."
  log "Dry run only; no support files were downloaded."
  return 1
}

install_pi_if_needed() {
  if command_exists pi; then
    log "Pi is already installed: $(command -v pi)"
    return 0
  fi

  if [[ "${NO_PI_INSTALL}" == "true" ]]; then
    die "pi is not installed and --no-pi-install was provided"
  fi

  log "Pi is not installed. Installing @earendil-works/pi-coding-agent globally..."
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
  log "Backed up existing isolated settings to: ${backup_path}"
}

refresh_harness_package_checkout() {
  if [[ "${PACKAGE_SOURCE_IS_DEFAULT}" != "true" ]]; then
    return 0
  fi

  local package_root="${AGENT_DIR}/git/github.com/${REPO}"
  log "Checking out The Last Harness git ref: ${REF}"
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

  git -C "${package_root}" fetch --prune --tags origin

  local target_ref="${REF}"
  if git -C "${package_root}" rev-parse --verify --quiet "refs/tags/${REF}^{commit}" >/dev/null; then
    target_ref="refs/tags/${REF}^{commit}"
  elif git -C "${package_root}" rev-parse --verify --quiet "refs/remotes/origin/${REF}^{commit}" >/dev/null; then
    target_ref="refs/remotes/origin/${REF}"
  fi

  git -C "${package_root}" checkout --detach "${target_ref}"
  git -C "${package_root}" reset --hard "${target_ref}"
  git -C "${package_root}" clean -fdx

  if [[ -f "${package_root}/package.json" ]]; then
    (cd "${package_root}" && npm install --omit=dev --legacy-peer-deps --package-lock=false)
  fi
}

install_harness_package() {
  log "Using isolated Pi agent dir: ${AGENT_DIR}"
  run mkdir -p "${AGENT_DIR}"
  backup_existing_settings_before_pi_install

  log "Installing The Last Harness Pi package into isolated profile: ${PACKAGE_SOURCE}"
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
    warn "package update failed; continuing because install step completed"
  fi
}

merge_settings() {
  if [[ "${NO_SETTINGS}" == "true" ]]; then
    log "Skipping settings merge (--no-settings)."
    return 0
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    prepare_merge_files_for_dry_run || return 0
  else
    prepare_merge_files
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
  fi

  log "Merging isolated Pi settings defaults: ${SETTINGS_PATH}"
  node "${args[@]}"
}

install_support_files() {
  if [[ -z "${TLH_DEFAULTS_SCRIPT}" || -z "${DEFAULT_EXTENSIONS_FILE}" ]]; then
    return 0
  fi

  local support_dir="${AGENT_DIR}/tlh"
  if [[ "${DRY_RUN}" == "true" ]]; then
    print_command mkdir -p "${support_dir}"
    print_command cp "${TLH_DEFAULTS_SCRIPT}" "${support_dir}/tlh-defaults.mjs"
    print_command cp "${DEFAULT_EXTENSIONS_FILE}" "${support_dir}/default-extensions.json"
    return 0
  fi

  mkdir -p "${support_dir}"
  cp "${TLH_DEFAULTS_SCRIPT}" "${support_dir}/tlh-defaults.mjs"
  cp "${DEFAULT_EXTENSIONS_FILE}" "${support_dir}/default-extensions.json"
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

  local source
  while IFS= read -r source; do
    [[ -n "${source}" ]] || continue
    log "Installing bundled default extension package: ${source}"
    if ! run_isolated_pi pi update --extension "${source}"; then
      warn "default extension package update failed; continuing: ${source}"
    fi
  done <<EOF_SOURCES
${sources_output}
EOF_SOURCES
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

  log "Installing wrapper command: ${WRAPPER_PATH}"

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
  local escaped_agent_dir escaped_package_root
  escaped_agent_dir="$(printf '%q' "${AGENT_DIR}")"
  escaped_package_root="$(printf '%q' "${AGENT_DIR}/git/github.com/${REPO}")"

  cat >"${tmp_path}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
# ${WRAPPER_MARKER}
default_agent_dir=${escaped_agent_dir}
default_tlh_package_root=${escaped_package_root}
export PI_CODING_AGENT_DIR="\${default_agent_dir}"

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

exec pi "\$@"
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
  log "Done. The Last Harness is installed as an isolated Pi profile."
  log "Isolated settings: ${SETTINGS_PATH}"
  if [[ "${NO_WRAPPER}" != "true" ]]; then
    log "Wrapper: ${WRAPPER_PATH}"
    if path_contains_bin_dir; then
      log "Start with: ${WRAPPER_NAME}"
      log "Manage bundled default extensions with: ${WRAPPER_NAME} defaults list"
    else
      warn "${BIN_DIR} is not on PATH. Add it with: export PATH=\"${BIN_DIR}:\$PATH\""
      log "Until then, start with: PI_CODING_AGENT_DIR=\"${AGENT_DIR}\" pi"
    fi
  else
    log "Start with: PI_CODING_AGENT_DIR=\"${AGENT_DIR}\" pi"
  fi
  log "Normal Pi config was not modified: ~/.pi/agent"
  if [[ "${NO_WRAPPER}" != "true" ]]; then
    log "Uninstall this profile with: rm -f \"${WRAPPER_PATH}\" && rm -rf \"${AGENT_DIR}\""
  else
    log "Uninstall this profile with: rm -rf \"${AGENT_DIR}\""
  fi
}

main() {
  log "The Last Harness installer"
  log "Repository: ${REPO}"
  log "Package source: ${PACKAGE_SOURCE}"
  log "Isolated agent dir: ${AGENT_DIR}"

  require_command node
  validate_inputs
  require_command npm
  require_command git

  install_pi_if_needed
  install_harness_package
  merge_settings
  install_support_files
  install_default_extensions
  write_wrapper
  print_summary
}

main "$@"
