#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
cd "${ROOT_DIR}"

TMP_ROOT="$(mktemp -d)"
EXTRA_CLEANUP_PATHS=()
cleanup() {
  rm -rf "${TMP_ROOT}"
  if [[ "${#EXTRA_CLEANUP_PATHS[@]}" -gt 0 ]]; then
    rm -rf "${EXTRA_CLEANUP_PATHS[@]}"
  fi
}
trap cleanup EXIT

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

run_scrubbed_installer_env() {
  local -a env_cmd=(env -u PI_CODING_AGENT_DIR)
  local name
  while IFS='=' read -r name _; do
    if [[ "${name}" == TLH_* ]]; then
      env_cmd+=(-u "${name}")
    fi
  done < <(env)
  "${env_cmd[@]}" "$@"
}

assert_absent() {
  local path="$1"
  if [[ -e "${path}" || -L "${path}" ]]; then
    fail "expected path to be absent: ${path}"
  fi
}

assert_present() {
  local path="$1"
  if [[ ! -e "${path}" && ! -L "${path}" ]]; then
    fail "expected path to be present: ${path}"
  fi
}

assert_under_tmp_root() {
  local path="$1"
  case "${path}" in
    "${TMP_ROOT}" | "${TMP_ROOT}"/*) ;;
    *) fail "unsafe test path outside TMP_ROOT: ${path}" ;;
  esac
}

assert_safe_uninstall_smoke_paths() {
  local agent_dir="$1"
  local bin_dir="$2"

  assert_under_tmp_root "${agent_dir}"
  assert_under_tmp_root "${bin_dir}"
}

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -F -- "${expected}" "${file}" >/dev/null; then
    printf '%s\n' "---- ${file} ----" >&2
    cat "${file}" >&2 || true
    printf '%s\n' '---- end ----' >&2
    fail "expected output to contain: ${expected}"
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -F -- "${unexpected}" "${file}" >/dev/null; then
    printf '%s\n' "---- ${file} ----" >&2
    cat "${file}" >&2 || true
    printf '%s\n' '---- end ----' >&2
    fail "expected output not to contain: ${unexpected}"
  fi
}

write_tlh_install_state() {
  local agent_dir="$1"
  local pi_installed_by_tlh="${2:-false}"

  mkdir -p "${agent_dir}/tlh"
  cat >"${agent_dir}/tlh/install-state.json" <<EOF_INSTALL_STATE
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness",
  "piInstalledByTlh": ${pi_installed_by_tlh}
}
EOF_INSTALL_STATE
}

write_managed_wrapper() {
  local wrapper_path="$1"

  mkdir -p "$(dirname "${wrapper_path}")"
  cat >"${wrapper_path}" <<'EOF_MANAGED_WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
# Managed by The Last Harness installer
EOF_MANAGED_WRAPPER
  chmod +x "${wrapper_path}"
}

assert_pi_commands_isolated() {
  local file="$1"
  local agent_dir="$2"
  local bad_file="${file}.unisolated-pi"

  assert_contains "${file}" "PI_CODING_AGENT_DIR=${agent_dir}"
  : >"${bad_file}"
  grep -E '(^\+|^Would).*(^|[[:space:]])pi[[:space:]]+(install|update)([[:space:]]|$)' "${file}" \
    | grep -F -v -- "PI_CODING_AGENT_DIR=${agent_dir}" >"${bad_file}" || true
  if [[ -s "${bad_file}" ]]; then
    printf '%s\n' "---- unisolated pi commands in ${file} ----" >&2
    cat "${bad_file}" >&2 || true
    printf '%s\n' '---- end ----' >&2
    fail "dry-run output contained an unisolated pi command"
  fi
}

combine_output() {
  local stdout_file="$1"
  local stderr_file="$2"
  local combined_file="$3"
  cat "${stdout_file}" "${stderr_file}" >"${combined_file}"
}

extract_stage0_support_manifest() {
  local no_settings="$1"
  node - "${no_settings}" <<'NODE_STAGE0_MANIFEST'
const fs = require('node:fs');

const noSettings = process.argv[2] === 'true';
const source = fs.readFileSync('install.sh', 'utf8');

function readHeredoc(label) {
  const start = `cat <<'${label}'`;
  const startIndex = source.indexOf(start);
  if (startIndex === -1) throw new Error(`missing stage-0 support manifest heredoc: ${label}`);
  const bodyStart = source.indexOf('\n', startIndex);
  if (bodyStart === -1) throw new Error(`malformed stage-0 support manifest heredoc: ${label}`);
  const endIndex = source.indexOf(`\n${label}`, bodyStart + 1);
  if (endIndex === -1) throw new Error(`unterminated stage-0 support manifest heredoc: ${label}`);
  return source.slice(bodyStart + 1, endIndex).split(/\r?\n/).filter(Boolean);
}

const lines = readHeredoc('EOF_SUPPORT_FILES');
if (!noSettings) lines.push(...readHeredoc('EOF_SETTINGS_SUPPORT_FILES'));
process.stdout.write(`${lines.join('\n')}\n`);
NODE_STAGE0_MANIFEST
}

stage1_support_manifest_projection() {
  local no_settings="$1"
  if [[ "${no_settings}" == "true" ]]; then
    run_scrubbed_installer_env node scripts/tlh-install.mjs --no-settings --print-support-manifest
  else
    run_scrubbed_installer_env node scripts/tlh-install.mjs --print-support-manifest
  fi | awk -F'|' '{ print $2 "|" $3 }'
}

run_support_manifest_smoke() {
  log "Running stage-0/stage-1 support manifest smoke check..."
  local case_dir="${TMP_ROOT}/support-manifest"
  mkdir -p "${case_dir}"

  local mode no_settings stage0_file stage1_file
  for mode in with-settings no-settings; do
    no_settings=false
    if [[ "${mode}" == "no-settings" ]]; then
      no_settings=true
    fi
    stage0_file="${case_dir}/stage0-${mode}.txt"
    stage1_file="${case_dir}/stage1-${mode}.txt"
    extract_stage0_support_manifest "${no_settings}" >"${stage0_file}"
    stage1_support_manifest_projection "${no_settings}" >"${stage1_file}"
    if ! diff -u "${stage0_file}" "${stage1_file}"; then
      fail "stage-0 bootstrap support manifest does not match stage-1 manifest (${mode})"
    fi
  done
}

run_install_query_smoke() {
  log "Running installer query smoke check..."
  local case_dir="${TMP_ROOT}/install-query"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${case_dir}"

  set +e
  (
    export TLH_AGENT_DIR="${case_dir}/poisoned-agent" PI_CODING_AGENT_DIR="${case_dir}/poisoned-pi-agent"
    run_scrubbed_installer_env node scripts/tlh-install-query.mjs normalize-path
  ) >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "normalize-path without --path unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "error: normalize-path requires --path"
}

make_failing_curl() {
  local fakebin="$1"
  mkdir -p "${fakebin}"
  cat >"${fakebin}/curl" <<'EOF_FAKE_CURL'
#!/usr/bin/env bash
printf 'fake curl was invoked\n' >&2
exit 99
EOF_FAKE_CURL
  chmod +x "${fakebin}/curl"
}

make_fake_node_version() {
  local fakebin="$1"
  local version="$2"
  mkdir -p "${fakebin}"
  cat >"${fakebin}/node" <<EOF_FAKE_NODE
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\n' '${version}'
  exit 0
fi
printf 'fake node was invoked unexpectedly: %s\n' "\$*" >&2
exit 99
EOF_FAKE_NODE
  chmod +x "${fakebin}/node"
}

make_support_copy_curl() {
  local fakebin="$1"
  mkdir -p "${fakebin}"
  cat >"${fakebin}/curl" <<'EOF_SUPPORT_COPY_CURL'
#!/usr/bin/env bash
url=""
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      out="${2:-}"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
if [[ -z "${url}" || -z "${out}" || -z "${FAKE_RAW_BASE:-}" || -z "${FAKE_SUPPORT_ROOT:-}" ]]; then
  printf 'fake support curl missing url, output, or support env\n' >&2
  exit 2
fi
base="${FAKE_RAW_BASE%/}/"
if [[ "${url}" != "${base}"* ]]; then
  printf 'fake support curl received unexpected url: %s\n' "${url}" >&2
  exit 2
fi
relative="${url#"${base}"}"
source_path="${FAKE_SUPPORT_ROOT}/${relative}"
if [[ ! -f "${source_path}" ]]; then
  printf 'fake support curl missing source: %s\n' "${relative}" >&2
  exit 22
fi
mkdir -p "$(dirname "${out}")"
cp "${source_path}" "${out}"
EOF_SUPPORT_COPY_CURL
  chmod +x "${fakebin}/curl"
}

make_legacy_support_curl() {
  local fakebin="$1"
  mkdir -p "${fakebin}"
  cat >"${fakebin}/curl" <<'EOF_LEGACY_SUPPORT_CURL'
#!/usr/bin/env bash
url=""
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      out="${2:-}"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
if [[ -z "${url}" || -z "${out}" ]]; then
  printf 'fake legacy curl missing url or output path\n' >&2
  exit 2
fi
relative="${url#https://example.invalid/legacy-ref/}"
if [[ "${relative}" == "${url}" ]]; then
  relative="${url#https://example.invalid/no-wrapper-ref/}"
fi
if [[ "${relative}" == "${url}" ]]; then
  printf 'fake legacy curl received unexpected url: %s\n' "${url}" >&2
  exit 2
fi
case "${LEGACY_SUPPORT_MODE:-missing-runtime}:${relative}" in
  missing-runtime:scripts/tlh-wrapper.mjs|missing-runtime:scripts/tlh-install-state.mjs|missing-wrapper-only:scripts/tlh-wrapper.mjs)
    printf 'fake legacy ref missing %s\n' "${url}" >&2
    exit 22
    ;;
esac
mkdir -p "$(dirname "${out}")"
source_path="${FAKE_SUPPORT_ROOT:-}/${relative}"
if [[ -n "${FAKE_SUPPORT_ROOT:-}" && -f "${source_path}" ]]; then
  cp "${source_path}" "${out}"
else
  printf '{}\n' >"${out}"
fi
EOF_LEGACY_SUPPORT_CURL
  chmod +x "${fakebin}/curl"
}

make_failing_pi() {
  local fakebin="$1"
  mkdir -p "${fakebin}"
  cat >"${fakebin}/pi" <<'EOF_FAKE_PI'
#!/usr/bin/env bash
printf 'fake pi was invoked\n' >&2
if [[ -n "${PI_SENTINEL:-}" ]]; then
  printf 'fake pi was invoked\n' >"${PI_SENTINEL}"
fi
exit 99
EOF_FAKE_PI
  chmod +x "${fakebin}/pi"
}

make_fake_present_pi() {
  local fakebin="$1"
  mkdir -p "${fakebin}"
  cat >"${fakebin}/pi" <<'EOF_FAKE_PRESENT_PI'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  printf '0.75.3\n'
  exit 0
fi
printf 'fake pi should only be invoked with --version during dry-run; got: %s\n' "$*" >&2
exit 98
EOF_FAKE_PRESENT_PI
  chmod +x "${fakebin}/pi"
}

make_fake_stage1_support_root() {
  local root="$1"
  local manifest_file="${root}/.fake-stage1-support-manifest"
  local requirement relative_path
  mkdir -p "${root}"
  extract_stage0_support_manifest false >"${manifest_file}"
  while IFS='|' read -r requirement relative_path; do
    [[ -n "${relative_path}" ]] || continue
    mkdir -p "${root}/$(dirname "${relative_path}")"
    : >"${root}/${relative_path}"
  done <"${manifest_file}"
  cat >"${root}/scripts/tlh-install.mjs" <<'EOF_FAKE_STAGE1'
#!/usr/bin/env node
console.log("BUG: fake local stage-1 was invoked");
EOF_FAKE_STAGE1
}

run_static_checks() {
  log "Running installer static checks..."
  bash -n install.sh
  bash -n uninstall.sh
  node --check scripts/merge-settings.mjs
  node --check scripts/merge-keybindings.mjs
  node --check scripts/tlh-defaults.mjs
  node --check scripts/tlh-gnosis.mjs
  node --check scripts/tlh-tickets.mjs
  node --check scripts/tlh-update.mjs
  node --check scripts/tlh-wrapper.mjs
  node --check scripts/tlh-install-state.mjs
  node --check scripts/tlh-install.mjs
  node --check scripts/tlh-install-query.mjs
  node --check scripts/lib/tlh-install-package-source.mjs
  node --check scripts/lib/tlh-install-paths.mjs
  node --check scripts/lib/tlh-install-utils.mjs
  node --check scripts/lib/tlh-install-git.mjs
  node --check scripts/lib/tlh-install-subagents.mjs
  node --check scripts/lib/tlh-install-support-files.mjs
  node --check scripts/lib/tlh-install-support-manifest.mjs
  node --check scripts/release-notes.mjs
  check_extension_load_syntax
}

check_extension_load_syntax() {
  local jiti_path
  jiti_path="$(node <<'NODE_RESOLVE_JITI'
const candidates = [
  () => require.resolve('jiti', { paths: [process.cwd()] }),
  () => '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti',
];
for (const candidate of candidates) {
  try {
    const resolved = candidate();
    require.resolve(resolved);
    console.log(resolved);
    process.exit(0);
  } catch {}
}
process.exit(1);
NODE_RESOLVE_JITI
)" || {
    log "Skipping extension load syntax check; install dev dependency 'jiti' or Pi's bundled jiti to enable it."
    return 0
  }

  local mock_root="${TMP_ROOT}/extension-load-mocks"
  mkdir -p \
    "${mock_root}/node_modules/@earendil-works/pi-tui" \
    "${mock_root}/node_modules/@earendil-works/pi-coding-agent"
  cat >"${mock_root}/node_modules/@earendil-works/pi-tui/index.js" <<'EOF_MOCK_PI_TUI'
exports.truncateToWidth = (value) => String(value ?? '');
exports.visibleWidth = (value) => String(value ?? '').length;
EOF_MOCK_PI_TUI
  cat >"${mock_root}/node_modules/@earendil-works/pi-coding-agent/index.js" <<'EOF_MOCK_PI_AGENT'
exports.DefaultPackageManager = class {};
exports.SettingsManager = class {};
exports.getAgentDir = () => process.cwd();
exports.keyText = String;
exports.loadProjectContextFiles = () => [];
EOF_MOCK_PI_AGENT

  NODE_PATH="${mock_root}/node_modules" node - "${jiti_path}" <<'NODE_EXTENSION_CHECK'
require('node:module').Module._initPaths();
const { createJiti } = require(process.argv[2]);
const jiti = createJiti(`${process.cwd()}/`);
jiti('./extensions/the-last-harness.ts');
NODE_EXTENSION_CHECK
}

run_stage1_dry_run_smoke() {
  log "Running stage-1 dry-run smoke check..."
  local case_dir="${TMP_ROOT}/stage1-dry-run"
  local agent_dir="${case_dir}/agent"
  local bin_dir="${case_dir}/bin"
  local fakebin="${case_dir}/fakebin"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local node_cmd
  node_cmd="$(command -v node)"
  mkdir -p "${fakebin}"
  cat >"${fakebin}/sh" <<'EOF_FAKE_SH'
#!/bin/sh
exec /bin/sh "$@"
EOF_FAKE_SH
  cat >"${fakebin}/npm" <<'EOF_FAKE_NPM'
#!/bin/sh
printf 'fake npm should not run during dry-run\n' >&2
exit 98
EOF_FAKE_NPM
  cat >"${fakebin}/git" <<'EOF_FAKE_GIT'
#!/bin/sh
printf 'fake git should not run during dry-run\n' >&2
exit 98
EOF_FAKE_GIT
  chmod +x "${fakebin}/sh" "${fakebin}/npm" "${fakebin}/git"

  run_scrubbed_installer_env PATH="${fakebin}" TLH_SKIP_GNOSIS_INSTALL=1 "${node_cmd}" scripts/tlh-install.mjs --dry-run --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  assert_absent "${agent_dir}"
  assert_absent "${bin_dir}"
  assert_pi_commands_isolated "${combined_file}" "${agent_dir}"
  assert_contains "${combined_file}" "Would install tk into isolated profile: ${agent_dir}/bin/tk"
  assert_contains "${combined_file}" "Would download pinned wedow/ticket source:"
  assert_contains "${combined_file}" "Would verify SHA256:"
  assert_contains "${combined_file}" "Ticket CLI integration: enabled (${agent_dir}/bin/tk)"
}

run_stage1_relative_path_canonicalization_smoke() {
  log "Running stage-1 relative path canonicalization smoke check..."
  local case_dir="${TMP_ROOT}/stage1-relative-paths"
  local home_dir="${case_dir}/home"
  local cwd_dir="${case_dir}/workspace"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local run_dir
  mkdir -p "${home_dir}" "${cwd_dir}"
  run_dir="$(cd "${cwd_dir}" >/dev/null 2>&1 && pwd -P)"

  (cd "${run_dir}" && \
    export PI_CODING_AGENT_DIR="${home_dir}/.pi/agent" TLH_AGENT_DIR="${home_dir}/.pi/agent" TLH_BIN_DIR="${home_dir}/.pi/agent" TLH_PACKAGE_SOURCE="~/poisoned-package" TLH_REPO="poisoned/repo" TLH_REF="poisoned-ref" TLH_UPDATE_TRACK="custom" && \
    run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" node "${ROOT_DIR}/scripts/tlh-install.mjs" --dry-run --agent-dir .pi/agent --bin-dir bin >"${stdout_file}" 2>"${stderr_file}")
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  local agent_dir="${run_dir}/.pi/agent"
  local bin_dir="${run_dir}/bin"
  assert_absent "${agent_dir}"
  assert_absent "${bin_dir}"
  assert_pi_commands_isolated "${combined_file}" "${agent_dir}"
  assert_contains "${combined_file}" "Isolated profile: ${agent_dir}"
  assert_contains "${combined_file}" "Would write tlh update metadata: ${agent_dir}/tlh/install-state.json"
  assert_contains "${combined_file}" "Installing wrapper command: ${bin_dir}/tlh"
  assert_contains "${combined_file}" "+ mkdir -p ${bin_dir}"
  assert_not_contains "${combined_file}" "poisoned"
  assert_not_contains "${combined_file}" "PI_CODING_AGENT_DIR=.pi/agent"
  assert_absent "${home_dir}/.pi"
}

run_stage1_staged_cwd_isolation_smoke() {
  log "Running staged stage-1 cwd isolation smoke check..."
  local case_dir="${TMP_ROOT}/stage1-cwd-isolation"
  local stage_root="${case_dir}/stage-root"
  local stage_scripts_dir="${stage_root}/scripts"
  local agent_dir="${case_dir}/agent"
  local bin_dir="${case_dir}/bin"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  mkdir -p "${stage_scripts_dir}/lib"
  cp scripts/tlh-install.mjs "${stage_scripts_dir}/tlh-install.mjs"
  cp scripts/tlh-install-query.mjs "${stage_scripts_dir}/tlh-install-query.mjs"
  cp scripts/lib/tlh-install-package-source.mjs "${stage_scripts_dir}/lib/tlh-install-package-source.mjs"
  cp scripts/lib/tlh-install-paths.mjs "${stage_scripts_dir}/lib/tlh-install-paths.mjs"
  cp scripts/lib/tlh-install-utils.mjs "${stage_scripts_dir}/lib/tlh-install-utils.mjs"
  cp scripts/lib/tlh-install-git.mjs "${stage_scripts_dir}/lib/tlh-install-git.mjs"
  cp scripts/lib/tlh-install-subagents.mjs "${stage_scripts_dir}/lib/tlh-install-subagents.mjs"
  cp scripts/lib/tlh-install-support-files.mjs "${stage_scripts_dir}/lib/tlh-install-support-files.mjs"
  cp scripts/lib/tlh-install-support-manifest.mjs "${stage_scripts_dir}/lib/tlh-install-support-manifest.mjs"

  local stage_script
  stage_script="$(cd "${stage_scripts_dir}" >/dev/null 2>&1 && pwd -P)/tlh-install.mjs"
  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 node "${stage_script}" --dry-run --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  assert_absent "${agent_dir}"
  assert_absent "${bin_dir}"
  assert_contains "${combined_file}" "Dry run only; no support files were downloaded."
  assert_not_contains "${combined_file}" "Applying isolated settings..."
  assert_pi_commands_isolated "${combined_file}" "${agent_dir}"
}

run_local_dry_run_smoke() {
  log "Running local dry-run smoke check..."
  local case_dir="${TMP_ROOT}/local-dry-run"
  local agent_dir="${case_dir}/agent"
  local bin_dir="${case_dir}/bin"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  mkdir -p "${case_dir}"

  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 bash install.sh --dry-run --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  assert_absent "${agent_dir}"
  assert_absent "${bin_dir}"
  assert_pi_commands_isolated "${combined_file}" "${agent_dir}"
  assert_contains "${combined_file}" "Installing wrapper command: ${bin_dir}/tlh"
  assert_not_contains "${combined_file}" "Would fetch installer support files from"
}

run_stdin_no_arg_smoke() {
  log "Running stdin no-argument smoke check..."
  local case_dir="${TMP_ROOT}/stdin-no-arg"
  local support_root="${case_dir}/support"
  local fakebin="${case_dir}/fakebin"
  local home_dir="${case_dir}/home"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local raw_base="https://example.invalid/no-arg-ref"
  mkdir -p "${case_dir}" "${home_dir}"
  make_support_copy_curl "${fakebin}"
  make_fake_stage1_support_root "${support_root}"
  cat >"${support_root}/scripts/tlh-install.mjs" <<'EOF_FAKE_NO_ARG_STAGE1'
#!/usr/bin/env node
console.log(`argv_count=${process.argv.slice(2).length}`);
console.log(`TLH_REF=${process.env.TLH_REF || ""}`);
console.log(`TLH_RAW_BASE=${process.env.TLH_RAW_BASE || ""}`);
console.log(`TLH_UPDATE_TRACK=${process.env.TLH_UPDATE_TRACK || ""}`);
EOF_FAKE_NO_ARG_STAGE1

  (cd "${case_dir}" && run_scrubbed_installer_env HOME="${home_dir}" PATH="${fakebin}:${PATH}" FAKE_SUPPORT_ROOT="${support_root}" FAKE_RAW_BASE="${raw_base}" TLH_REF="no-arg-ref" TLH_RAW_BASE="${raw_base}" bash -s -- < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  assert_absent "${home_dir}/.the-last-harness"
  assert_absent "${home_dir}/.local"
  assert_contains "${combined_file}" "argv_count=0"
  assert_contains "${combined_file}" "TLH_REF=no-arg-ref"
  assert_contains "${combined_file}" "TLH_RAW_BASE=${raw_base}"
  assert_contains "${combined_file}" "TLH_UPDATE_TRACK="
  assert_not_contains "${combined_file}" "unbound variable"
}

run_stdin_dry_run_smoke() {
  log "Running stdin dry-run smoke check..."
  local case_dir="${TMP_ROOT}/stdin-dry-run"
  local agent_dir="${case_dir}/agent"
  local bin_dir="${case_dir}/bin"
  local fakebin="${case_dir}/fakebin"
  local home_dir="${case_dir}/home"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${case_dir}"
  make_failing_curl "${fakebin}"
  make_fake_stage1_support_root "${case_dir}"

  (cd "${case_dir}" && run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 PATH="${fakebin}:${PATH}" bash -s -- --dry-run --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  assert_absent "${agent_dir}"
  assert_absent "${bin_dir}"
  assert_contains "${combined_file}" "Would fetch installer support files from"
  assert_contains "${combined_file}" "Dry run only; no support files were downloaded."
  assert_not_contains "${combined_file}" "BUG: fake local stage-1 was invoked"
  assert_not_contains "${combined_file}" "fake curl was invoked"

  mkdir -p "${home_dir}"

  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
  (cd "${case_dir}" && run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" PATH="${fakebin}:${PATH}" bash -s -- --dry-run --track nope --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "stdin dry-run invalid --track unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "--track must be one of: latest-release, pinned-tag, ref, custom"
  assert_not_contains "${combined_file}" "Done. The Last Harness dry run completed without downloads or writes."
  assert_not_contains "${combined_file}" "fake curl was invoked"
  assert_absent "${agent_dir}"
  assert_absent "${bin_dir}"

  local relative_cwd="${case_dir}/relative-cwd"
  local run_dir relative_agent_dir relative_bin_dir
  mkdir -p "${relative_cwd}"
  run_dir="$(cd "${relative_cwd}" >/dev/null 2>&1 && pwd -P)"
  relative_agent_dir="${run_dir}/.pi/agent"
  relative_bin_dir="${run_dir}/bin"
  : >"${stdout_file}"
  : >"${stderr_file}"
  (cd "${run_dir}" && run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" PATH="${fakebin}:${PATH}" bash -s -- --dry-run --agent-dir .pi/agent --bin-dir bin < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  assert_absent "${relative_agent_dir}"
  assert_absent "${relative_bin_dir}"
  assert_contains "${combined_file}" "Isolated profile: ${relative_agent_dir}"
  assert_contains "${combined_file}" "Would merge settings defaults into: ${relative_agent_dir}/settings.json"
  assert_contains "${combined_file}" "Would merge keybinding defaults into: ${relative_agent_dir}/keybindings.json"
  assert_contains "${combined_file}" "Start with: PI_CODING_AGENT_DIR=\"${relative_agent_dir}\" pi"
  assert_contains "${combined_file}" "Wrapper path would be: ${relative_bin_dir}/tlh"
  assert_not_contains "${combined_file}" 'PI_CODING_AGENT_DIR=".pi/agent"'
  assert_not_contains "${combined_file}" "Isolated profile: .pi/agent"
  assert_not_contains "${combined_file}" "Would merge settings defaults into: .pi/agent/settings.json"
  assert_not_contains "${combined_file}" "Wrapper path would be: bin/tlh"
  assert_not_contains "${combined_file}" "BUG: fake local stage-1 was invoked"
  assert_not_contains "${combined_file}" "fake curl was invoked"

  local default_agent_dir="${home_dir}/.the-last-harness/agent"
  local default_bin_dir="${home_dir}/.local/bin"
  : >"${stdout_file}"
  : >"${stderr_file}"
  (cd "${case_dir}" && run_scrubbed_installer_env HOME="${home_dir}" PATH="${fakebin}:${PATH}" bash -s -- --dry-run --no-wrapper < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  assert_absent "${default_agent_dir}"
  assert_absent "${default_bin_dir}"
  assert_contains "${combined_file}" "Bootstrap-level/no-stage1 dry-run approximation"
  assert_contains "${combined_file}" "Wrapper creation would be skipped (--no-wrapper)."
  assert_contains "${combined_file}" "Dry run only; no support files were downloaded."
  assert_not_contains "${combined_file}" "Wrapper path would be:"
  assert_not_contains "${combined_file}" "BUG: fake local stage-1 was invoked"
  assert_not_contains "${combined_file}" "fake curl was invoked"

  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
  (cd "${case_dir}" && run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" PATH="${fakebin}:${PATH}" bash -s -- --dry-run --agent-dir "~/.pi/agent" --bin-dir "${bin_dir}" < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "stdin dry-run normal Pi guard unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing to place The Last Harness agent dir under normal Pi config root"
  assert_not_contains "${combined_file}" "Dry run only; no support files were downloaded."
  assert_not_contains "${combined_file}" "fake curl was invoked"
  assert_absent "${home_dir}/.pi"

  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
  (cd "${case_dir}" && run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" PATH="${fakebin}:${PATH}" bash -s -- --agent-dir "~/.pi/agent" --bin-dir "${bin_dir}" < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "stdin normal Pi guard unexpectedly succeeded before remote fetch"
  fi
  assert_contains "${combined_file}" "refusing to place The Last Harness agent dir under normal Pi config root"
  assert_not_contains "${combined_file}" "fake curl was invoked"
  assert_not_contains "${combined_file}" "BUG: fake local stage-1 was invoked"
  assert_absent "${home_dir}/.pi"
}

run_stage0_node_preflight_smoke() {
  log "Running stage-0 Node version preflight smoke check..."
  local case_dir="${TMP_ROOT}/stage0-node-preflight"
  local agent_dir="${case_dir}/agent"
  local bin_dir="${case_dir}/bin"
  local fakebin="${case_dir}/fakebin"
  local home_dir="${case_dir}/home"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${case_dir}" "${home_dir}"
  make_failing_curl "${fakebin}"
  make_fake_node_version "${fakebin}" "v22.18.9"

  set +e
  (cd "${case_dir}" && run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" PATH="${fakebin}:${PATH}" bash -s -- --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "stage-0 old Node remote preflight unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "Node.js >= 22.19.0 is required (found v22.18.9). Install or upgrade Node.js, then rerun the installer."
  assert_not_contains "${combined_file}" "fake curl was invoked"
  assert_absent "${agent_dir}"
  assert_absent "${bin_dir}"

  local stage_root="${case_dir}/stage-root"
  mkdir -p "${stage_root}"
  cp install.sh "${stage_root}/install.sh"
  make_fake_stage1_support_root "${stage_root}"
  : >"${stdout_file}"
  : >"${stderr_file}"

  set +e
  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" PATH="${fakebin}:${PATH}" bash "${stage_root}/install.sh" --dry-run --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "stage-0 old Node local preflight unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "Node.js >= 22.19.0 is required (found v22.18.9). Install or upgrade Node.js, then rerun the installer."
  assert_not_contains "${combined_file}" "BUG: fake local stage-1 was invoked"
  assert_absent "${agent_dir}"
  assert_absent "${bin_dir}"
}

run_stage0_alias_guard_smoke() {
  log "Running stage-0 alias normal Pi guard smoke check..."
  local case_dir="${TMP_ROOT}/stage0-alias-guard"
  local fakebin="${case_dir}/fakebin"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local home_physical=""
  local home_alias=""
  local alias_label=""
  local status=0
  mkdir -p "${case_dir}"
  make_failing_curl "${fakebin}"
  make_fake_stage1_support_root "${case_dir}"

  local physical_case_dir
  physical_case_dir="$(cd "${case_dir}" >/dev/null 2>&1 && pwd -P)"
  if [[ -d /var && -d /private/var ]]; then
    local var_real private_var_real logical_case_dir
    var_real="$(cd /var >/dev/null 2>&1 && pwd -P || true)"
    private_var_real="$(cd /private/var >/dev/null 2>&1 && pwd -P || true)"
    if [[ -n "${var_real}" && "${var_real}" == "${private_var_real}" && "${physical_case_dir}" == /private/var/* ]]; then
      logical_case_dir="/var/${physical_case_dir#/private/var/}"
      if [[ -d "${logical_case_dir}" ]]; then
        home_physical="${physical_case_dir}/home"
        home_alias="${logical_case_dir}/home"
        alias_label="/var-vs-/private/var"
      fi
    fi
  fi

  if [[ -z "${home_alias}" ]]; then
    local physical_parent="${case_dir}/physical-root"
    local logical_parent="${case_dir}/logical-root"
    mkdir -p "${physical_parent}"
    if ln -s "${physical_parent}" "${logical_parent}" 2>/dev/null; then
      home_physical="${physical_parent}/home"
      home_alias="${logical_parent}/home"
      alias_label="synthetic-symlink"
    else
      log "Skipping stage-0 alias normal Pi guard smoke check; symlinks are unavailable."
      return 0
    fi
  fi

  mkdir -p "${home_physical}"
  set +e
  (cd "${case_dir}" && run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_alias}" PATH="${fakebin}:${PATH}" bash -s -- --dry-run --agent-dir "${home_physical}/.pi/agent" --bin-dir "${case_dir}/bin" < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "stage-0 alias normal Pi guard smoke unexpectedly succeeded (${alias_label})"
  fi
  assert_contains "${combined_file}" "refusing to place The Last Harness agent dir under normal Pi config root"
  assert_not_contains "${combined_file}" "Dry run only; no support files were downloaded."
  assert_not_contains "${combined_file}" "fake curl was invoked"
  assert_not_contains "${combined_file}" "BUG: fake local stage-1 was invoked"
  assert_absent "${home_physical}/.pi"
  assert_absent "${home_alias}/.pi"
}

run_stage0_validation_precedes_local_support_smoke() {
  log "Running stage-0 validation ordering smoke check..."
  local case_dir="${TMP_ROOT}/stage0-validation-order"
  local stage_root="${case_dir}/stage-root"
  local home_dir="${case_dir}/home"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${stage_root}" "${home_dir}"
  cp install.sh "${stage_root}/install.sh"
  make_fake_stage1_support_root "${stage_root}"

  set +e
  run_scrubbed_installer_env HOME="${home_dir}" bash "${stage_root}/install.sh" --dry-run --agent-dir "~/.pi/agent" --bin-dir "${case_dir}/bin" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "stage-0 validation ordering smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing to place The Last Harness agent dir under normal Pi config root"
  assert_not_contains "${combined_file}" "BUG: fake local stage-1 was invoked"
  assert_absent "${home_dir}/.pi"
}

run_normal_pi_guard_smoke() {
  log "Running normal Pi config guard smoke check..."
  local case_dir="${TMP_ROOT}/normal-pi-guard"
  local home_dir="${case_dir}/home"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${home_dir}"

  set +e
  run_scrubbed_installer_env HOME="${home_dir}" bash install.sh --dry-run --agent-dir "${home_dir}/.pi/agent" --bin-dir "${case_dir}/bin" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "normal Pi config guard smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing to place The Last Harness agent dir under normal Pi config root"
  assert_absent "${home_dir}/.pi"

  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
  run_scrubbed_installer_env HOME="${home_dir}" bash install.sh --dry-run --agent-dir "${case_dir}/agent" --bin-dir "${home_dir}/.pi/agent" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "normal Pi wrapper dir guard smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing to place The Last Harness wrapper dir under normal Pi config root"
  assert_absent "${home_dir}/.pi"
}

run_gnosis_managed_normal_pi_guard_smoke() {
  log "Running managed Gnosis normal Pi guard smoke check..."
  local case_dir="${TMP_ROOT}/gnosis-managed-guard"
  local home_dir="${case_dir}/home"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${home_dir}"

  set +e
  HOME="${home_dir}" node scripts/tlh-gnosis.mjs --agent-dir "${home_dir}/.pi/agent" --target "${case_dir}/target/gn" --dry-run install-managed >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "managed Gnosis agent-dir guard smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "Refusing to modify normal Pi config from The Last Harness gnosis command (agent dir)"
  assert_absent "${home_dir}/.pi"

  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
  HOME="${home_dir}" node scripts/tlh-gnosis.mjs --agent-dir "${case_dir}/agent" --target "${home_dir}/.pi/agent/bin/gn" --dry-run install-managed >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "managed Gnosis target guard smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "Refusing to modify normal Pi config from The Last Harness gnosis command (managed gn target)"
  assert_absent "${home_dir}/.pi"
}

run_tickets_managed_normal_pi_guard_smoke() {
  log "Running managed tk normal Pi guard smoke check..."
  local case_dir="${TMP_ROOT}/tickets-managed-guard"
  local home_dir="${case_dir}/home"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${home_dir}"

  set +e
  HOME="${home_dir}" node scripts/tlh-tickets.mjs --agent-dir "${home_dir}/.pi/agent" --target "${case_dir}/target/tk" --dry-run install-managed >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "managed tk agent-dir guard smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "Refusing to modify normal Pi config from The Last Harness tickets command (agent dir)"
  assert_absent "${home_dir}/.pi"

  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
  HOME="${home_dir}" node scripts/tlh-tickets.mjs --agent-dir "${case_dir}/agent" --target "${home_dir}/.pi/agent/bin/tk" --dry-run install-managed >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "managed tk target guard smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "Refusing to modify normal Pi config from The Last Harness tickets command (managed tk target)"
  assert_absent "${home_dir}/.pi"
}

run_missing_required_helper_preflight_smoke() {
  log "Running missing required helper preflight smoke check..."
  local case_dir="${TMP_ROOT}/missing-helper-preflight"
  local agent_dir="${case_dir}/agent"
  local bin_dir="${case_dir}/bin"
  local fakebin="${case_dir}/fakebin"
  local pi_sentinel="${case_dir}/pi-invoked"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${case_dir}"
  make_legacy_support_curl "${fakebin}"
  make_failing_pi "${fakebin}"

  set +e
  (cd "${case_dir}" && run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 PATH="${fakebin}:${PATH}" FAKE_SUPPORT_ROOT="${ROOT_DIR}" PI_SENTINEL="${pi_sentinel}" TLH_RAW_BASE="https://example.invalid/legacy-ref" bash -s -- --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "missing required helper preflight smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "required installer support files not found for ref"
  assert_contains "${combined_file}" "scripts/tlh-wrapper.mjs"
  assert_contains "${combined_file}" "scripts/tlh-install-state.mjs"
  assert_not_contains "${combined_file}" "fake pi was invoked"
  assert_absent "${agent_dir}"
  assert_absent "${bin_dir}"
  assert_absent "${pi_sentinel}"

  local no_wrapper_case_dir="${TMP_ROOT}/no-wrapper-preflight"
  local no_wrapper_agent_dir="${no_wrapper_case_dir}/agent"
  local no_wrapper_bin_dir="${no_wrapper_case_dir}/bin"
  local no_wrapper_fakebin="${no_wrapper_case_dir}/fakebin"
  local no_wrapper_pi_sentinel="${no_wrapper_case_dir}/pi-invoked"
  mkdir -p "${no_wrapper_case_dir}"
  make_legacy_support_curl "${no_wrapper_fakebin}"
  make_failing_pi "${no_wrapper_fakebin}"
  : >"${stdout_file}"
  : >"${stderr_file}"

  set +e
  (cd "${no_wrapper_case_dir}" && run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 PATH="${no_wrapper_fakebin}:${PATH}" FAKE_SUPPORT_ROOT="${ROOT_DIR}" LEGACY_SUPPORT_MODE="missing-wrapper-only" PI_SENTINEL="${no_wrapper_pi_sentinel}" TLH_RAW_BASE="https://example.invalid/no-wrapper-ref" bash -s -- --agent-dir "${no_wrapper_agent_dir}" --bin-dir "${no_wrapper_bin_dir}" --no-wrapper < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "missing wrapper --no-wrapper preflight smoke unexpectedly succeeded"
  fi
  assert_not_contains "${combined_file}" "required installer support files not found for ref"
  assert_contains "${combined_file}" "fake pi was invoked"
  if [[ ! -f "${no_wrapper_pi_sentinel}" ]]; then
    cat "${combined_file}" >&2
    fail "expected fake pi to be invoked after --no-wrapper preflight passed"
  fi
}

run_wrapper_install_state_normal_pi_guard_smoke() {
  log "Running wrapper/install-state normal Pi guard smoke check..."
  local case_dir="${TMP_ROOT}/wrapper-state-guard"
  local home_dir="${case_dir}/home"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${home_dir}"

  set +e
  HOME="${home_dir}" node scripts/tlh-wrapper.mjs --agent-dir "${case_dir}/agent" --bin-dir "${home_dir}/.pi/agent" --wrapper-name tlh --package-root "${case_dir}/package" --dry-run >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "wrapper helper normal Pi bin-dir guard smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing to modify normal Pi config from The Last Harness wrapper command (wrapper install dir)"
  assert_absent "${home_dir}/.pi"

  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
  HOME="${home_dir}" node scripts/tlh-wrapper.mjs --agent-dir "${case_dir}/agent" --bin-dir "${case_dir}/bin" --wrapper-name "../home/.pi/agent/tlh" --package-root "${case_dir}/package" --dry-run >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "wrapper helper normal Pi wrapper-path guard smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing to modify normal Pi config from The Last Harness wrapper command (wrapper path)"
  assert_absent "${home_dir}/.pi"

  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
  HOME="${home_dir}" node scripts/tlh-install-state.mjs --state-path "${home_dir}/.pi/agent/tlh/install-state.json" --repo diegopetrucci/the-last-harness --ref main --track ref --package-source git:github.com/diegopetrucci/the-last-harness@main --package-source-is-default true --raw-base https://example.invalid/raw --agent-dir "${case_dir}/agent" --bin-dir "${case_dir}/bin" --wrapper-name tlh --dry-run >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "install-state helper normal Pi state-path guard smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing to modify normal Pi config from The Last Harness install-state command (state path)"
  assert_absent "${home_dir}/.pi"
}

run_release_pinning_smoke() {
  log "Running release installer defaults smoke check..."
  local case_dir="${TMP_ROOT}/release-pinning"
  local dist_dir="${case_dir}/dist"
  local home_dir="${case_dir}/home"
  local tag="v9.9.9"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  mkdir -p "${dist_dir}" "${home_dir}"

  TAG="${tag}" DIST_DIR="${dist_dir}" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const tag = process.env.TAG;
const distDir = process.env.DIST_DIR;
const source = fs.readFileSync('install.sh', 'utf8');
const replacements = [
  ['REF="${TLH_REF:-main}"', `REF="\${TLH_REF:-${tag}}"`],
  ['UPDATE_TRACK_INPUT="${TLH_UPDATE_TRACK:-}"', 'UPDATE_TRACK_INPUT="${TLH_UPDATE_TRACK:-latest-release}"'],
];
let output = source;
for (const [oldText, newText] of replacements) {
  if (!output.includes(oldText)) {
    throw new Error(`Expected installer default line not found: ${oldText}`);
  }
  output = output.replace(oldText, newText);
}
fs.writeFileSync(path.join(distDir, 'install.sh'), output, 'utf8');
NODE
  chmod +x "${dist_dir}/install.sh"
  bash -n "${dist_dir}/install.sh"
  assert_contains "${dist_dir}/install.sh" "REF=\"\${TLH_REF:-${tag}}\""
  assert_contains "${dist_dir}/install.sh" 'UPDATE_TRACK_INPUT="${TLH_UPDATE_TRACK:-latest-release}"'
  assert_not_contains "${dist_dir}/install.sh" 'REF="${TLH_REF:-main}"'
  assert_not_contains "${dist_dir}/install.sh" 'UPDATE_TRACK_INPUT="${TLH_UPDATE_TRACK:-}"'

  local manifest_file="${case_dir}/stage0-manifest.txt"
  local requirement relative_path
  extract_stage0_support_manifest false >"${manifest_file}"
  while IFS='|' read -r requirement relative_path; do
    [[ -n "${relative_path}" ]] || continue
    mkdir -p "${dist_dir}/$(dirname "${relative_path}")"
    : >"${dist_dir}/${relative_path}"
  done <"${manifest_file}"
  cat >"${dist_dir}/scripts/tlh-install.mjs" <<'EOF_FAKE_RELEASE_STAGE1'
#!/usr/bin/env node
console.log(`TLH_UPDATE_TRACK=${process.env.TLH_UPDATE_TRACK || ""}`);
EOF_FAKE_RELEASE_STAGE1

  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" bash "${dist_dir}/install.sh" --agent-dir "${case_dir}/agent" --bin-dir "${case_dir}/bin" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "TLH_UPDATE_TRACK=latest-release"

  : >"${stdout_file}"
  : >"${stderr_file}"
  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" TLH_UPDATE_TRACK="pinned-tag" bash "${dist_dir}/install.sh" --agent-dir "${case_dir}/agent" --bin-dir "${case_dir}/bin" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "TLH_UPDATE_TRACK=pinned-tag"

  : >"${stdout_file}"
  : >"${stderr_file}"
  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" bash "${dist_dir}/install.sh" --agent-dir "${case_dir}/agent" --bin-dir "${case_dir}/bin" --track ref >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "TLH_UPDATE_TRACK=ref"
}

# ── piInstalledByTlh smoke tests ───────────────────────────────────────────────

run_install_state_pi_field_smoke() {
  log "Running install-state piInstalledByTlh field smoke check..."
  local case_dir="${TMP_ROOT}/install-state-pi-field"
  local agent_dir="${case_dir}/agent"
  local bin_dir="${case_dir}/bin"
  local state_file="${case_dir}/state.json"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${agent_dir}" "${bin_dir}"

  local -a common_args=(
    --state-path "${state_file}"
    --repo diegopetrucci/the-last-harness
    --ref main
    --track ref
    --package-source "git:github.com/diegopetrucci/the-last-harness@main"
    --package-source-is-default true
    --raw-base "https://example.invalid/raw"
    --agent-dir "${agent_dir}"
    --bin-dir "${bin_dir}"
    --wrapper-name tlh
  )

  # --pi-installed-by-tlh true persists the field
  node scripts/tlh-install-state.mjs "${common_args[@]}" --pi-installed-by-tlh true
  assert_contains "${state_file}" '"piInstalledByTlh": true'
  rm -f "${state_file}"

  # --pi-installed-by-tlh false persists the field
  node scripts/tlh-install-state.mjs "${common_args[@]}" --pi-installed-by-tlh false
  assert_contains "${state_file}" '"piInstalledByTlh": false'
  rm -f "${state_file}"

  # omitting --pi-installed-by-tlh leaves the field absent
  node scripts/tlh-install-state.mjs "${common_args[@]}"
  assert_not_contains "${state_file}" 'piInstalledByTlh'
  rm -f "${state_file}"

  # invalid value fails with a clear error
  set +e
  node scripts/tlh-install-state.mjs "${common_args[@]}" --pi-installed-by-tlh maybe >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "install-state --pi-installed-by-tlh=maybe unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "--pi-installed-by-tlh must be true or false"
}

run_install_dry_run_pi_field_smoke() {
  log "Running install dry-run piInstalledByTlh field smoke check..."
  local case_dir="${TMP_ROOT}/install-dry-run-pi-field"
  local node_cmd
  node_cmd="$(command -v node)"
  mkdir -p "${case_dir}"

  # ── pi absent: TLH would install pi → piInstalledByTlh: true ──────────────
  local absent_dir="${case_dir}/pi-absent"
  local absent_agent="${absent_dir}/agent"
  local absent_bin="${absent_dir}/bin"
  local absent_fakebin="${absent_dir}/fakebin"
  local absent_stdout="${absent_dir}/stdout.log"
  local absent_stderr="${absent_dir}/stderr.log"
  local absent_combined="${absent_dir}/combined.log"
  mkdir -p "${absent_fakebin}"
  cat >"${absent_fakebin}/sh" <<'EOF_ABSENT_SH'
#!/bin/sh
exec /bin/sh "$@"
EOF_ABSENT_SH
  cat >"${absent_fakebin}/npm" <<'EOF_ABSENT_NPM'
#!/bin/sh
printf 'fake npm should not run during dry-run\n' >&2
exit 98
EOF_ABSENT_NPM
  cat >"${absent_fakebin}/git" <<'EOF_ABSENT_GIT'
#!/bin/sh
printf 'fake git should not run during dry-run\n' >&2
exit 98
EOF_ABSENT_GIT
  chmod +x "${absent_fakebin}/sh" "${absent_fakebin}/npm" "${absent_fakebin}/git"

  run_scrubbed_installer_env PATH="${absent_fakebin}" TLH_SKIP_GNOSIS_INSTALL=1 "${node_cmd}" scripts/tlh-install.mjs --dry-run --agent-dir "${absent_agent}" --bin-dir "${absent_bin}" >"${absent_stdout}" 2>"${absent_stderr}"
  combine_output "${absent_stdout}" "${absent_stderr}" "${absent_combined}"
  assert_contains "${absent_combined}" "(piInstalledByTlh: true)"

  # ── pi present: TLH did NOT install pi → piInstalledByTlh: false ──────────
  local present_dir="${case_dir}/pi-present"
  local present_agent="${present_dir}/agent"
  local present_bin="${present_dir}/bin"
  local present_fakebin="${present_dir}/fakebin"
  local present_stdout="${present_dir}/stdout.log"
  local present_stderr="${present_dir}/stderr.log"
  local present_combined="${present_dir}/combined.log"
  mkdir -p "${present_fakebin}"
  cat >"${present_fakebin}/sh" <<'EOF_PRESENT_SH'
#!/bin/sh
exec /bin/sh "$@"
EOF_PRESENT_SH
  cat >"${present_fakebin}/npm" <<'EOF_PRESENT_NPM'
#!/bin/sh
printf 'fake npm should not run during dry-run\n' >&2
exit 98
EOF_PRESENT_NPM
  cat >"${present_fakebin}/git" <<'EOF_PRESENT_GIT'
#!/bin/sh
printf 'fake git should not run during dry-run\n' >&2
exit 98
EOF_PRESENT_GIT
  chmod +x "${present_fakebin}/sh" "${present_fakebin}/npm" "${present_fakebin}/git"
  make_fake_present_pi "${present_fakebin}"

  run_scrubbed_installer_env PATH="${present_fakebin}" TLH_SKIP_GNOSIS_INSTALL=1 "${node_cmd}" scripts/tlh-install.mjs --dry-run --agent-dir "${present_agent}" --bin-dir "${present_bin}" >"${present_stdout}" 2>"${present_stderr}"
  combine_output "${present_stdout}" "${present_stderr}" "${present_combined}"
  assert_contains "${present_combined}" "(piInstalledByTlh: false)"
}

run_update_pi_field_threading_smoke() {
  log "Running tlh-update.mjs piInstalledByTlh threading smoke check..."
  local case_dir="${TMP_ROOT}/update-pi-field-threading"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  mkdir -p "${case_dir}"

  # ── state with piInstalledByTlh:true threads the flag into installer args ──
  local with_field_dir="${case_dir}/with-field"
  mkdir -p "${with_field_dir}/tlh"
  cat >"${with_field_dir}/tlh/install-state.json" <<'EOF_STATE_WITH_FIELD'
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness",
  "ref": "main",
  "track": "ref",
  "packageSource": "git:github.com/diegopetrucci/the-last-harness@main",
  "packageSourceIsDefault": true,
  "piInstalledByTlh": true
}
EOF_STATE_WITH_FIELD

  run_scrubbed_installer_env node scripts/tlh-update.mjs --dry-run --agent-dir "${with_field_dir}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "--pi-installed-by-tlh"

  # ── state without piInstalledByTlh omits the flag from installer args ──────
  local without_field_dir="${case_dir}/without-field"
  mkdir -p "${without_field_dir}/tlh"
  cat >"${without_field_dir}/tlh/install-state.json" <<'EOF_STATE_WITHOUT_FIELD'
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness",
  "ref": "main",
  "track": "ref",
  "packageSource": "git:github.com/diegopetrucci/the-last-harness@main",
  "packageSourceIsDefault": true
}
EOF_STATE_WITHOUT_FIELD

  : >"${stdout_file}"
  : >"${stderr_file}"
  run_scrubbed_installer_env node scripts/tlh-update.mjs --dry-run --agent-dir "${without_field_dir}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_not_contains "${combined_file}" "--pi-installed-by-tlh"
}

run_install_sh_pi_installed_by_tlh_passthrough_smoke() {
  log "Running install.sh --pi-installed-by-tlh passthrough smoke check..."
  local case_dir="${TMP_ROOT}/install-sh-pi-flag-passthrough"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${case_dir}"

  # ── space-separated form: stage-0 accepts, stage-1 validates → exit 0 ─────
  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 bash install.sh \
    --pi-installed-by-tlh true \
    --dry-run \
    --agent-dir "${case_dir}/space/agent" \
    --bin-dir "${case_dir}/space/bin" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_not_contains "${combined_file}" "unknown option"

  # ── equals form: stage-0 accepts, stage-1 validates → exit 0 ──────────────
  : >"${stdout_file}"
  : >"${stderr_file}"
  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 bash install.sh \
    --pi-installed-by-tlh=true \
    --dry-run \
    --agent-dir "${case_dir}/eq/agent" \
    --bin-dir "${case_dir}/eq/bin" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_not_contains "${combined_file}" "unknown option"

  # ── invalid boolean: stage-1 validation error (not stage-0 unknown option) ─
  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 bash install.sh \
    --pi-installed-by-tlh maybe \
    --dry-run \
    --agent-dir "${case_dir}/bad/agent" \
    --bin-dir "${case_dir}/bad/bin" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "expected --pi-installed-by-tlh maybe to fail but exited 0"
  fi
  assert_contains "${combined_file}" "--pi-installed-by-tlh must be true or false"
  assert_not_contains "${combined_file}" "unknown option"
}

run_uninstall_dry_run_pi_smoke() {
  log "Running uninstall.sh --dry-run piInstalledByTlh smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-dry-run-pi"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  mkdir -p "${case_dir}"

  # ── piInstalledByTlh:true → plan shows npm uninstall ──────────────────────
  local true_agent="${case_dir}/pi-true/agent"
  mkdir -p "${true_agent}/tlh"
  cat >"${true_agent}/tlh/install-state.json" <<'EOF_UNINSTALL_STATE_TRUE'
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness",
  "piInstalledByTlh": true
}
EOF_UNINSTALL_STATE_TRUE

  bash uninstall.sh --dry-run --agent-dir "${true_agent}" --bin-dir "${case_dir}/bin-true" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would npm uninstall pi: npm uninstall -g --prefix \"${HOME}/.local\" @earendil-works/pi-coding-agent"

  # ── piInstalledByTlh:false → plan shows skip ──────────────────────────────
  local false_agent="${case_dir}/pi-false/agent"
  mkdir -p "${false_agent}/tlh"
  cat >"${false_agent}/tlh/install-state.json" <<'EOF_UNINSTALL_STATE_FALSE'
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness",
  "piInstalledByTlh": false
}
EOF_UNINSTALL_STATE_FALSE

  : >"${stdout_file}"
  : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${false_agent}" --bin-dir "${case_dir}/bin-false" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi removal (install-state: piInstalledByTlh=false)"

  # ── install-state field missing → plan shows skip ────────────────────────
  local absent_agent="${case_dir}/pi-absent/agent"
  mkdir -p "${absent_agent}/tlh"
  cat >"${absent_agent}/tlh/install-state.json" <<'EOF_UNINSTALL_STATE_ABSENT'
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness"
}
EOF_UNINSTALL_STATE_ABSENT

  : >"${stdout_file}"
  : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${absent_agent}" --bin-dir "${case_dir}/bin-absent" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi removal (install-state absent or piInstalledByTlh field missing)"
}

run_uninstall_flag_override_smoke() {
  log "Running uninstall.sh flag override smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-flag-override"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${case_dir}"

  # ── --force-include-pi overrides piInstalledByTlh=false → removes pi ──────
  local force_agent="${case_dir}/force-include/agent"
  mkdir -p "${force_agent}/tlh"
  cat >"${force_agent}/tlh/install-state.json" <<'EOF_FORCE_STATE'
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness",
  "piInstalledByTlh": false
}
EOF_FORCE_STATE

  bash uninstall.sh --dry-run --force-include-pi --agent-dir "${force_agent}" --bin-dir "${case_dir}/bin-force" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would npm uninstall pi: npm uninstall -g --prefix \"${HOME}/.local\" @earendil-works/pi-coding-agent"

  # ── --keep-pi overrides piInstalledByTlh=true → skips pi ─────────────────
  local keep_agent="${case_dir}/keep-pi/agent"
  mkdir -p "${keep_agent}/tlh"
  cat >"${keep_agent}/tlh/install-state.json" <<'EOF_KEEP_STATE'
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness",
  "piInstalledByTlh": true
}
EOF_KEEP_STATE

  : >"${stdout_file}"
  : >"${stderr_file}"
  bash uninstall.sh --dry-run --keep-pi --agent-dir "${keep_agent}" --bin-dir "${case_dir}/bin-keep" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi removal (--keep-pi flag)"

  # ── both flags together → exit 2 with conflict message ───────────────────
  local conflict_agent="${case_dir}/conflict/agent"
  mkdir -p "${conflict_agent}"
  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
  bash uninstall.sh --dry-run --force-include-pi --keep-pi --agent-dir "${conflict_agent}" --bin-dir "${case_dir}/bin-conflict" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  if [[ "${status}" -ne 2 ]]; then
    cat "${combined_file}" >&2
    fail "mutually exclusive flags did not exit with code 2 (got ${status})"
  fi
  assert_contains "${combined_file}" "--force-include-pi and --keep-pi are mutually exclusive"
}

run_uninstall_normal_pi_guard_smoke() {
  log "Running uninstall.sh normal Pi config guard smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-normal-pi-guard"
  local home_dir="${case_dir}/home"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${home_dir}"

  # Case: --agent-dir inside ~/.pi
  set +e
  HOME="${home_dir}" bash uninstall.sh --dry-run --agent-dir "${home_dir}/.pi/agent" --bin-dir "${case_dir}/bin" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "uninstall.sh --agent-dir guard unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing to operate: --agent-dir is inside normal Pi config root"
  assert_absent "${home_dir}/.pi"

  # Case: --bin-dir inside ~/.pi
  set +e
  HOME="${home_dir}" bash uninstall.sh --dry-run --agent-dir "${case_dir}/agent" --bin-dir "${home_dir}/.pi/agent" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "uninstall.sh --bin-dir guard unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing to operate: --bin-dir is inside normal Pi config root"
  assert_absent "${home_dir}/.pi"

  # Case: --wrapper-name with path traversal resolving inside ~/.pi
  # BIN_DIR is set to home_dir/bin (not inside ~/.pi); WRAPPER_NAME contains
  # '../' so that BIN_DIR/WRAPPER_NAME resolves to home_dir/.pi/agent/settings.json.
  set +e
  HOME="${home_dir}" bash uninstall.sh --dry-run --agent-dir "${case_dir}/agent" --bin-dir "${home_dir}/bin" --wrapper-name "../.pi/agent/settings.json" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "uninstall.sh wrapper-path traversal guard unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing to operate: resolved wrapper path is inside normal Pi config root"
  assert_absent "${home_dir}/.pi"
}

run_uninstall_dangerous_agent_dir_smoke() {
  log "Running uninstall.sh dangerous-agent-dir smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-dangerous-agent-dir"
  local home_dir="${case_dir}/home"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${home_dir}"

  set +e
  HOME="${home_dir}" bash uninstall.sh --dry-run --agent-dir / --bin-dir "${case_dir}/bin-root" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "uninstall.sh dangerous / --agent-dir smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing dangerous recursive --agent-dir target: /"
  assert_not_contains "${combined_file}" "would run: rm -rf /"

  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
  HOME="${home_dir}" bash uninstall.sh --dry-run --agent-dir "${home_dir}" --bin-dir "${case_dir}/bin-home" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "uninstall.sh dangerous HOME --agent-dir smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing dangerous recursive --agent-dir target: ${home_dir}"
  assert_not_contains "${combined_file}" "would run: rm -rf ${home_dir}"
}

run_uninstall_home_alias_guard_smoke() {
  log "Running uninstall.sh HOME alias dangerous-agent-dir smoke check..."
  local tmp_real=""
  local private_tmp_real=""
  tmp_real="$(cd /tmp >/dev/null 2>&1 && pwd -P || true)"
  private_tmp_real="$(cd /private/tmp >/dev/null 2>&1 && pwd -P || true)"

  if [[ -z "${tmp_real}" || "${tmp_real}" != "${private_tmp_real}" ]]; then
    log "Skipping uninstall HOME alias dangerous-agent-dir smoke check; /tmp alias is unavailable."
    return 0
  fi

  local case_dir_path=""
  local case_dir_physical=""
  local case_dir_alias=""
  local home_physical=""
  local home_alias=""
  local bin_dir=""
  local stdout_file=""
  local stderr_file=""
  local combined_file=""
  local status=0

  case_dir_path="$(mktemp -d /tmp/tlh-uninstall-home-alias.XXXXXX)"
  case_dir_physical="$(cd "${case_dir_path}" >/dev/null 2>&1 && pwd -P)"
  case_dir_alias="/tmp/${case_dir_physical#/private/tmp/}"
  EXTRA_CLEANUP_PATHS+=("${case_dir_physical}")

  if [[ ! -d "${case_dir_alias}" ]]; then
    log "Skipping uninstall HOME alias dangerous-agent-dir smoke check; /tmp alias path was not created."
    return 0
  fi

  home_physical="${case_dir_physical}/home"
  home_alias="${case_dir_alias}/home"
  bin_dir="${case_dir_physical}/bin"
  stdout_file="${case_dir_physical}/stdout.log"
  stderr_file="${case_dir_physical}/stderr.log"
  combined_file="${case_dir_physical}/combined.log"

  mkdir -p "${home_physical}" "${bin_dir}"
  write_tlh_install_state "${home_physical}" false

  set +e
  HOME="${home_physical}" bash uninstall.sh --dry-run --agent-dir "${home_alias}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "uninstall.sh HOME alias dangerous-agent-dir smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing dangerous recursive --agent-dir target: ${home_alias}"
  assert_not_contains "${combined_file}" "would run: rm -rf ${home_alias}"
  assert_present "${home_physical}/tlh/install-state.json"
}

run_uninstall_symlinked_agent_dir_smoke() {
  log "Running uninstall.sh symlinked-agent-dir smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-symlinked-agent-dir"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  local real_agent_dir="${case_dir}/real-agent"
  local agent_symlink="${case_dir}/agent-link"
  local real_profile_root="${case_dir}/real-profile"
  local profile_symlink="${case_dir}/profile-link"
  mkdir -p "${case_dir}"

  write_tlh_install_state "${real_agent_dir}" false
  ln -s "${real_agent_dir}" "${agent_symlink}"

  set +e
  bash uninstall.sh --dry-run --agent-dir "${agent_symlink}" --bin-dir "${case_dir}/bin-agent-link" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "uninstall.sh symlinked --agent-dir smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing to remove symlinked --agent-dir: ${agent_symlink}"
  assert_present "${agent_symlink}"

  mkdir -p "${real_profile_root}"
  ln -s "${real_profile_root}" "${profile_symlink}"

  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
  bash uninstall.sh --dry-run --agent-dir "${profile_symlink}/agent" --bin-dir "${case_dir}/bin-parent-link" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "uninstall.sh symlinked parent component smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing to operate: --agent-dir traverses symlinked parent component (${profile_symlink})"
}

run_uninstall_missing_marker_smoke() {
  log "Running uninstall.sh missing-marker smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-missing-marker"
  local agent_dir="${case_dir}/profile/agent"
  local bin_dir="${case_dir}/bin"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  assert_safe_uninstall_smoke_paths "${agent_dir}" "${bin_dir}"
  mkdir -p "${agent_dir}" "${bin_dir}"

  set +e
  bash uninstall.sh --dry-run --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "uninstall.sh missing ownership marker smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing to remove existing --agent-dir without TLH ownership marker: ${agent_dir}/tlh/install-state.json"
  assert_not_contains "${combined_file}" "would run: rm -rf ${agent_dir}"
  assert_present "${agent_dir}"
}

run_uninstall_valid_marked_removal_smoke() {
  log "Running uninstall.sh valid-marked-removal smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-valid-marked-removal"
  local profile_root="${case_dir}/profile"
  local agent_dir="${profile_root}/agent"
  local bin_dir="${case_dir}/bin"
  local wrapper_path
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  assert_safe_uninstall_smoke_paths "${agent_dir}" "${bin_dir}"
  mkdir -p "${bin_dir}"
  write_tlh_install_state "${agent_dir}" false
  wrapper_path="$(cd "${bin_dir}" >/dev/null 2>&1 && pwd -P)/tlh"
  write_managed_wrapper "${wrapper_path}"

  set +e
  bash uninstall.sh --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -ne 0 ]]; then
    cat "${combined_file}" >&2
    fail "uninstall valid marked removal smoke exited with non-zero status: ${status}"
  fi
  assert_contains "${combined_file}" "Remove wrapper:      ${wrapper_path}"
  assert_contains "${combined_file}" "Remove agent dir:    ${agent_dir}"
  assert_absent "${wrapper_path}"
  assert_absent "${profile_root}"
}

run_uninstall_wrapper_ownership_smoke() {
  log "Running uninstall.sh wrapper-ownership smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-wrapper-ownership"
  local profile_root="${case_dir}/profile"
  local agent_dir="${profile_root}/agent"
  local bin_dir="${case_dir}/bin"
  local wrapper_path
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  assert_safe_uninstall_smoke_paths "${agent_dir}" "${bin_dir}"
  mkdir -p "${bin_dir}"
  write_tlh_install_state "${agent_dir}" false
  wrapper_path="$(cd "${bin_dir}" >/dev/null 2>&1 && pwd -P)/tlh"
  printf '#!/usr/bin/env bash\nprintf "unmanaged wrapper\n"\n' >"${wrapper_path}"
  chmod +x "${wrapper_path}"

  set +e
  bash uninstall.sh --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -ne 0 ]]; then
    cat "${combined_file}" >&2
    fail "uninstall unmanaged wrapper smoke exited with non-zero status: ${status}"
  fi
  assert_contains "${combined_file}" "Skip wrapper removal: ${wrapper_path}"
  assert_contains "${combined_file}" "(existing file is not managed by The Last Harness installer)"
  assert_contains "${combined_file}" "warning: skipping wrapper removal for ${wrapper_path}; existing file is not managed by The Last Harness installer"
  assert_contains "${combined_file}" "Remove agent dir:    ${agent_dir}"
  assert_present "${wrapper_path}"
  assert_absent "${profile_root}"
}

run_uninstall_dangling_profile_wrapper_symlink_smoke() {
  log "Running uninstall.sh dangling-profile-wrapper-symlink smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-dangling-profile-wrapper-symlink"
  local profile_root="${case_dir}/profile"
  local agent_dir="${profile_root}/agent"
  local bin_dir="${case_dir}/bin"
  local wrapper_path
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  assert_safe_uninstall_smoke_paths "${agent_dir}" "${bin_dir}"
  mkdir -p "${bin_dir}"
  write_tlh_install_state "${agent_dir}" false
  wrapper_path="$(cd "${bin_dir}" >/dev/null 2>&1 && pwd -P)/tlh"
  ln -s "${profile_root}/missing-wrapper-target" "${wrapper_path}"

  set +e
  bash uninstall.sh --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -ne 0 ]]; then
    cat "${combined_file}" >&2
    fail "uninstall dangling profile wrapper symlink smoke exited with non-zero status: ${status}"
  fi
  assert_contains "${combined_file}" "Remove wrapper:      ${wrapper_path}"
  assert_absent "${wrapper_path}"
  assert_absent "${profile_root}"
}

run_uninstall_unrelated_wrapper_symlink_smoke() {
  log "Running uninstall.sh unrelated-wrapper-symlink smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-unrelated-wrapper-symlink"
  local profile_root="${case_dir}/profile"
  local agent_dir="${profile_root}/agent"
  local bin_dir="${case_dir}/bin"
  local wrapper_path
  local unrelated_target="${case_dir}/outside/missing-wrapper-target"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  assert_safe_uninstall_smoke_paths "${agent_dir}" "${bin_dir}"
  mkdir -p "${bin_dir}"
  write_tlh_install_state "${agent_dir}" false
  wrapper_path="$(cd "${bin_dir}" >/dev/null 2>&1 && pwd -P)/tlh"
  ln -s "${unrelated_target}" "${wrapper_path}"

  set +e
  bash uninstall.sh --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -ne 0 ]]; then
    cat "${combined_file}" >&2
    fail "uninstall unrelated wrapper symlink smoke exited with non-zero status: ${status}"
  fi
  assert_contains "${combined_file}" "Skip wrapper removal: ${wrapper_path}"
  assert_contains "${combined_file}" "(existing symlink target is outside the TLH profile (${unrelated_target}))"
  assert_contains "${combined_file}" "warning: skipping wrapper removal for ${wrapper_path}; existing symlink target is outside the TLH profile (${unrelated_target})"
  assert_contains "${combined_file}" "Remove agent dir:    ${agent_dir}"
  assert_present "${wrapper_path}"
  assert_absent "${profile_root}"
}

run_uninstall_piped_smoke() {
  log "Running uninstall.sh piped-stdin end-to-end smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-piped"
  local profile_root="${case_dir}/profile"
  local agent_dir="${profile_root}/agent"
  local bin_dir="${case_dir}/bin"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  assert_safe_uninstall_smoke_paths "${agent_dir}" "${bin_dir}"
  mkdir -p "${agent_dir}/tlh" "${bin_dir}"
  cat >"${agent_dir}/tlh/install-state.json" <<'EOF_PIPED_UNINSTALL_STATE'
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness",
  "piInstalledByTlh": false
}
EOF_PIPED_UNINSTALL_STATE
  write_managed_wrapper "${bin_dir}/tlh"

  set +e
  cat uninstall.sh | bash -s -- --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -ne 0 ]]; then
    cat "${combined_file}" >&2
    fail "uninstall piped-stdin smoke exited with non-zero status: ${status}"
  fi
  assert_absent "${bin_dir}/tlh"
  assert_absent "${profile_root}"
}

run_uninstall_sibling_preservation_smoke() {
  log "Running uninstall.sh sibling-preservation regression smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-sibling-preservation"
  local profile_root="${case_dir}/profile"
  local agent_dir="${profile_root}/agent"
  local bin_dir="${case_dir}/bin"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  assert_safe_uninstall_smoke_paths "${agent_dir}" "${bin_dir}"
  mkdir -p "${agent_dir}/tlh" "${bin_dir}"
  cat >"${agent_dir}/tlh/install-state.json" <<'EOF_SIBLING_UNINSTALL_STATE'
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness",
  "piInstalledByTlh": false
}
EOF_SIBLING_UNINSTALL_STATE
  # Sibling file under profile root — must survive uninstall (regression guard).
  printf 'sibling file — must survive uninstall\n' >"${profile_root}/sibling_keep.txt"
  write_managed_wrapper "${bin_dir}/tlh"

  set +e
  cat uninstall.sh | bash -s -- --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -ne 0 ]]; then
    cat "${combined_file}" >&2
    fail "uninstall sibling-preservation smoke exited with non-zero status: ${status}"
  fi
  assert_absent "${bin_dir}/tlh"
  assert_absent "${agent_dir}"
  # Regression assertion: sibling and non-empty parent must survive.
  assert_present "${profile_root}/sibling_keep.txt"
  assert_present "${profile_root}"
}

run_static_checks
run_support_manifest_smoke
run_install_state_pi_field_smoke
run_install_dry_run_pi_field_smoke
run_update_pi_field_threading_smoke
run_install_sh_pi_installed_by_tlh_passthrough_smoke
run_uninstall_dry_run_pi_smoke
run_uninstall_flag_override_smoke
run_uninstall_normal_pi_guard_smoke
run_uninstall_dangerous_agent_dir_smoke
run_uninstall_home_alias_guard_smoke
run_uninstall_symlinked_agent_dir_smoke
run_uninstall_missing_marker_smoke
run_uninstall_valid_marked_removal_smoke
run_uninstall_wrapper_ownership_smoke
run_uninstall_dangling_profile_wrapper_symlink_smoke
run_uninstall_unrelated_wrapper_symlink_smoke
run_uninstall_piped_smoke
run_uninstall_sibling_preservation_smoke
run_install_query_smoke
run_stage1_dry_run_smoke
run_stage1_relative_path_canonicalization_smoke
run_stage1_staged_cwd_isolation_smoke
run_local_dry_run_smoke
run_stdin_no_arg_smoke
run_stdin_dry_run_smoke
run_stage0_node_preflight_smoke
run_stage0_alias_guard_smoke
run_stage0_validation_precedes_local_support_smoke
run_normal_pi_guard_smoke
run_gnosis_managed_normal_pi_guard_smoke
run_tickets_managed_normal_pi_guard_smoke
run_missing_required_helper_preflight_smoke
run_wrapper_install_state_normal_pi_guard_smoke
run_release_pinning_smoke

log "Installer smoke checks passed."
