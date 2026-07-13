#!/usr/bin/env bash

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
