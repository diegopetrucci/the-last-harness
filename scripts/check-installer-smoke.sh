#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
cd "${ROOT_DIR}"

TMP_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_ROOT}"
}
trap cleanup EXIT

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

assert_absent() {
  local path="$1"
  if [[ -e "${path}" ]]; then
    fail "expected path to be absent: ${path}"
  fi
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

combine_output() {
  local stdout_file="$1"
  local stderr_file="$2"
  local combined_file="$3"
  cat "${stdout_file}" "${stderr_file}" >"${combined_file}"
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
case "${LEGACY_SUPPORT_MODE:-missing-runtime}:${url}" in
  missing-runtime:*/scripts/tlh-wrapper.mjs|missing-runtime:*/scripts/tlh-install-state.mjs|missing-wrapper-only:*/scripts/tlh-wrapper.mjs)
    printf 'fake legacy ref missing %s\n' "${url}" >&2
    exit 22
    ;;
esac
mkdir -p "$(dirname "${out}")"
printf '{}\n' >"${out}"
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

run_static_checks() {
  log "Running installer static checks..."
  bash -n install.sh
  node --check scripts/merge-settings.mjs
  node --check scripts/merge-keybindings.mjs
  node --check scripts/tlh-defaults.mjs
  node --check scripts/tlh-gnosis.mjs
  node --check scripts/tlh-update.mjs
  node --check scripts/tlh-wrapper.mjs
  node --check scripts/tlh-install-state.mjs
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

run_local_dry_run_smoke() {
  log "Running local dry-run smoke check..."
  local case_dir="${TMP_ROOT}/local-dry-run"
  local agent_dir="${case_dir}/agent"
  local bin_dir="${case_dir}/bin"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  mkdir -p "${case_dir}"

  bash install.sh --dry-run --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" --without-gnosis >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  assert_absent "${agent_dir}"
  assert_absent "${bin_dir}"
  assert_contains "${combined_file}" "PI_CODING_AGENT_DIR=${agent_dir}"
  if grep -E '^\+ pi (install|update)( |$)' "${combined_file}" >/dev/null; then
    cat "${combined_file}" >&2
    fail "dry-run output contained an unisolated pi command"
  fi
}

run_stdin_dry_run_smoke() {
  log "Running stdin dry-run smoke check..."
  local case_dir="${TMP_ROOT}/stdin-dry-run"
  local agent_dir="${case_dir}/agent"
  local bin_dir="${case_dir}/bin"
  local fakebin="${case_dir}/fakebin"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  mkdir -p "${case_dir}"
  make_failing_curl "${fakebin}"

  PATH="${fakebin}:${PATH}" bash -s -- --dry-run --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" --without-gnosis < install.sh >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  assert_absent "${agent_dir}"
  assert_absent "${bin_dir}"
  assert_contains "${combined_file}" "Dry run only; no support files were downloaded."
  assert_not_contains "${combined_file}" "fake curl was invoked"
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
  HOME="${home_dir}" bash install.sh --dry-run --agent-dir "${home_dir}/.pi/agent" --bin-dir "${case_dir}/bin" >"${stdout_file}" 2>"${stderr_file}"
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
  HOME="${home_dir}" bash install.sh --dry-run --agent-dir "${case_dir}/agent" --bin-dir "${home_dir}/.pi/agent" >"${stdout_file}" 2>"${stderr_file}"
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
  PATH="${fakebin}:${PATH}" PI_SENTINEL="${pi_sentinel}" TLH_RAW_BASE="https://example.invalid/legacy-ref" bash -s -- --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" --without-gnosis < install.sh >"${stdout_file}" 2>"${stderr_file}"
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
  PATH="${no_wrapper_fakebin}:${PATH}" LEGACY_SUPPORT_MODE="missing-wrapper-only" PI_SENTINEL="${no_wrapper_pi_sentinel}" TLH_RAW_BASE="https://example.invalid/no-wrapper-ref" bash -s -- --agent-dir "${no_wrapper_agent_dir}" --bin-dir "${no_wrapper_bin_dir}" --without-gnosis --no-wrapper < install.sh >"${stdout_file}" 2>"${stderr_file}"
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
  log "Running release installer pinning smoke check..."
  local case_dir="${TMP_ROOT}/release-pinning"
  local dist_dir="${case_dir}/dist"
  local tag="v9.9.9"
  mkdir -p "${dist_dir}"

  TAG="${tag}" DIST_DIR="${dist_dir}" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const tag = process.env.TAG;
const distDir = process.env.DIST_DIR;
const source = fs.readFileSync('install.sh', 'utf8');
const oldText = 'REF="${TLH_REF:-main}"';
const newText = `REF="\${TLH_REF:-${tag}}"`;
if (!source.includes(oldText)) {
  throw new Error(`Expected installer default ref line not found: ${oldText}`);
}
fs.writeFileSync(path.join(distDir, 'install.sh'), source.replace(oldText, newText), 'utf8');
NODE
  chmod +x "${dist_dir}/install.sh"
  bash -n "${dist_dir}/install.sh"
  assert_contains "${dist_dir}/install.sh" "REF=\"\${TLH_REF:-${tag}}\""
  assert_not_contains "${dist_dir}/install.sh" 'REF="${TLH_REF:-main}"'
}

run_static_checks
run_local_dry_run_smoke
run_stdin_dry_run_smoke
run_normal_pi_guard_smoke
run_gnosis_managed_normal_pi_guard_smoke
run_missing_required_helper_preflight_smoke
run_wrapper_install_state_normal_pi_guard_smoke
run_release_pinning_smoke

log "Installer smoke checks passed."
