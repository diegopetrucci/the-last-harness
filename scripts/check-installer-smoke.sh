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

run_static_checks() {
  log "Running installer static checks..."
  bash -n install.sh
  node --check scripts/merge-settings.mjs
  node --check scripts/tlh-defaults.mjs
  node --check scripts/tlh-gnosis.mjs
  node --check scripts/tlh-update.mjs
  node --check scripts/tlh-wrapper.mjs
  node --check scripts/tlh-install-state.mjs
  node --check scripts/release-notes.mjs
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
run_release_pinning_smoke

log "Installer smoke checks passed."
