#!/usr/bin/env bash

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
  local raw_base="https://example.invalid/node-preflight-ref"
  local status=0
  mkdir -p "${case_dir}" "${home_dir}"
  make_support_copy_curl "${fakebin}"
  make_fake_stage1_support_root "${case_dir}/support-root"
  make_fake_node_version "${fakebin}" "v22.18.9"

  set +e
  (cd "${case_dir}" && run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" PATH="${fakebin}:${PATH}" FAKE_SUPPORT_ROOT="${case_dir}/support-root" FAKE_RAW_BASE="${raw_base}" TLH_RAW_BASE="${raw_base}" bash -s -- --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "stage-0 old Node remote preflight unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "Refreshing installer..."
  assert_contains "${combined_file}" "Node.js >= 22.19.0 is required (found v22.18.9). Install or upgrade Node.js, then rerun the installer."
  assert_not_contains "${combined_file}" "BUG: fake local stage-1 was invoked"
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
  # literal '~/.pi/agent' is intentional; smoke test exercises the alias guard that rejects unexpanded tildes
  # shellcheck disable=SC2088
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
  local no_wrapper_home="${no_wrapper_case_dir}/home"
  mkdir -p "${no_wrapper_case_dir}" "${no_wrapper_home}"
  make_legacy_support_curl "${no_wrapper_fakebin}"
  # Under the private-runtime model, the installer ignores PATH pi and uses npm to
  # install its own runtime. Seed a fake failing npm to exercise the preflight-passes-
  # but-runtime-install-fails path without making real network requests.
  make_failing_npm "${no_wrapper_fakebin}"
  : >"${stdout_file}"
  : >"${stderr_file}"

  set +e
  (cd "${no_wrapper_case_dir}" && run_scrubbed_installer_env HOME="${no_wrapper_home}" TLH_SKIP_GNOSIS_INSTALL=1 PATH="${no_wrapper_fakebin}:${PATH}" FAKE_SUPPORT_ROOT="${ROOT_DIR}" LEGACY_SUPPORT_MODE="missing-wrapper-only" TLH_RAW_BASE="https://example.invalid/no-wrapper-ref" bash -s -- --agent-dir "${no_wrapper_agent_dir}" --bin-dir "${no_wrapper_bin_dir}" --no-wrapper < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "missing wrapper --no-wrapper preflight smoke unexpectedly succeeded"
  fi
  assert_not_contains "${combined_file}" "required installer support files not found for ref"
  # Confirm the install step was reached (preflight passed) and the runtime provision failed.
  assert_contains "${combined_file}" "Pinning local Pi runtime to"
}

run_stage0_remote_support_fetch_smoke() {
  log "Running stage-0 remote support fetch smoke check..."
  local case_dir="${TMP_ROOT}/stage0-remote-support-fetch"
  local required_case_dir="${case_dir}/required"
  local optional_case_dir="${case_dir}/optional"
  local raw_base="https://example.invalid/stage0-fetch-ref"
  local missing_required="scripts/lib/tlh-install-utils.mjs"
  local expected_count actual_count max_active target_dir status
  local stage_root support_root fakebin home_dir track_dir stdout_file stderr_file combined_file
  mkdir -p "${required_case_dir}" "${optional_case_dir}"

  stage_root="${required_case_dir}/stage-root"
  support_root="${required_case_dir}/support-root"
  fakebin="${required_case_dir}/fakebin"
  home_dir="${required_case_dir}/home"
  track_dir="${required_case_dir}/curl-tracking"
  stdout_file="${required_case_dir}/stdout.log"
  stderr_file="${required_case_dir}/stderr.log"
  combined_file="${required_case_dir}/combined.log"
  mkdir -p "${stage_root}" "${home_dir}"
  cp install.sh "${stage_root}/install.sh"
  make_tracking_support_curl "${fakebin}"
  make_fake_remote_stage1_support_root "${support_root}"
  rm -f "${support_root}/${missing_required}"

  set +e
  run_scrubbed_installer_env HOME="${home_dir}" PATH="${fakebin}:${PATH}" FAKE_CURL_DELAY=0.02 FAKE_CURL_TRACK_DIR="${track_dir}" FAKE_RAW_BASE="${raw_base}" FAKE_SUPPORT_ROOT="${support_root}" TLH_REF="stage0-fetch-ref" TLH_RAW_BASE="${raw_base}" _TLH_STAGE0_CANONICALIZED=1 bash "${stage_root}/install.sh" --no-settings --agent-dir "${required_case_dir}/agent" --bin-dir "${required_case_dir}/bin" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "stage-0 required remote support failure unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "required installer support file not found for ref stage0-fetch-ref: ${missing_required}"
  assert_not_contains "${combined_file}" "fake_stage1=ok"
  expected_count="$(extract_stage0_support_manifest true | wc -l | tr -d '[:space:]')"
  actual_count="$(wc -l <"${track_dir}/completed.log" | tr -d '[:space:]')"
  if [[ "${actual_count}" -ne "${expected_count}" ]]; then
    fail "stage-0 required remote support fetch did not await every worker (expected ${expected_count}, got ${actual_count})"
  fi
  max_active="$(cat "${track_dir}/max-active")"
  if [[ "${max_active}" -gt 8 || "${max_active}" -lt 2 ]]; then
    fail "stage-0 remote support fetch concurrency was not bounded as expected (max active: ${max_active})"
  fi
  if [[ "$(cat "${track_dir}/active")" -ne 0 ]]; then
    fail "stage-0 remote support fetch left an active worker"
  fi
  assert_contains "${track_dir}/args.log" "--retry 2"
  assert_contains "${track_dir}/args.log" "--retry-delay 1"
  assert_contains "${track_dir}/args.log" "--retry-max-time 20"
  assert_contains "${track_dir}/args.log" "--connect-timeout 5"
  assert_contains "${track_dir}/args.log" "--max-time 30"
  target_dir="$(dirname "$(head -n 1 "${track_dir}/started.log")")"
  assert_absent "${target_dir}"

  stage_root="${optional_case_dir}/stage-root"
  support_root="${optional_case_dir}/support-root"
  fakebin="${optional_case_dir}/fakebin"
  home_dir="${optional_case_dir}/home"
  track_dir="${optional_case_dir}/curl-tracking"
  stdout_file="${optional_case_dir}/stdout.log"
  stderr_file="${optional_case_dir}/stderr.log"
  combined_file="${optional_case_dir}/combined.log"
  mkdir -p "${stage_root}" "${home_dir}"
  cp install.sh "${stage_root}/install.sh"
  make_tracking_support_curl "${fakebin}"
  make_fake_remote_stage1_support_root "${support_root}"
  rm -f "${support_root}/scripts/tlh-update.mjs"

  set +e
  run_scrubbed_installer_env HOME="${home_dir}" PATH="${fakebin}:${PATH}" FAKE_CURL_DELAY=0.01 FAKE_CURL_TRACK_DIR="${track_dir}" FAKE_RAW_BASE="${raw_base}" FAKE_SUPPORT_ROOT="${support_root}" TLH_REF="stage0-fetch-ref" TLH_RAW_BASE="${raw_base}" _TLH_STAGE0_CANONICALIZED=1 bash "${stage_root}/install.sh" --no-settings --agent-dir "${optional_case_dir}/agent" --bin-dir "${optional_case_dir}/bin" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -ne 0 ]]; then
    cat "${combined_file}" >&2
    fail "stage-0 optional remote support miss unexpectedly failed"
  fi
  assert_contains "${combined_file}" "tlh update support script not found for ref stage0-fetch-ref; the wrapper update helper will be unavailable"
  assert_contains "${combined_file}" "fake_stage1=ok"
  assert_absent "${optional_case_dir}/agent"
  assert_absent "${optional_case_dir}/bin"
}

run_stale_stage0_manifest_compatibility_smoke() {
  log "Running stale stage-0 manifest compatibility smoke check..."
  local case_dir="${TMP_ROOT}/stale-stage0-manifest-compat"
  local home_dir="${case_dir}/home"
  local agent_dir="${case_dir}/agent"
  local bin_dir="${case_dir}/bin"
  local fakebin="${case_dir}/fakebin"
  local support_root="${case_dir}/support-root"
  local stale_installer="${case_dir}/stale-install.sh"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local raw_base="https://example.invalid/current-main"
  local stale_manifest=$'required|config/librarian.defaults.json\nrequired|scripts/tlh-install-query.mjs'
  mkdir -p "${case_dir}" "${home_dir}"

  make_support_copy_curl "${fakebin}"
  make_fake_remote_stage1_support_root "${support_root}"
  write_stage0_manifest_variant "${stale_installer}" "${stale_manifest}"

  run_scrubbed_installer_env HOME="${home_dir}" PATH="${fakebin}:${PATH}" FAKE_SUPPORT_ROOT="${support_root}" FAKE_RAW_BASE="${raw_base}" TLH_REF="main" TLH_RAW_BASE="${raw_base}" _TLH_STAGE0_CANONICALIZED=1 bash "${stale_installer}" --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  assert_contains "${combined_file}" "fake_stage1=ok"
  assert_contains "${combined_file}" "compat_librarian_present=true"
  assert_contains "${combined_file}" "compat_query_present=true"
  assert_contains "${combined_file}" "stale_poison_present=false"
  assert_absent "${agent_dir}"
  assert_absent "${bin_dir}"
  assert_absent "${home_dir}/.pi"
  assert_absent "${home_dir}/.the-last-harness"
}

run_stage0_canonical_handoff_smoke() {
  log "Running stale stage-0 canonical handoff smoke check..."
  local case_dir="${TMP_ROOT}/stage0-canonical-handoff"
  local home_dir="${case_dir}/home"
  local agent_dir="${case_dir}/agent"
  local bin_dir="${case_dir}/bin"
  local fakebin="${case_dir}/fakebin"
  local support_root="${case_dir}/support-root"
  local stale_installer="${case_dir}/stale-install.sh"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local raw_base="https://example.invalid/current-main"
  local stale_manifest=$'required|config/librarian.defaults.json\nrequired|scripts/tlh-install-query.mjs\nrequired|poison/stale-stage0-only.txt'
  mkdir -p "${case_dir}" "${home_dir}"

  make_support_copy_curl "${fakebin}"
  make_fake_remote_stage1_support_root "${support_root}"
  write_stage0_manifest_variant "${stale_installer}" "${stale_manifest}"

  run_scrubbed_installer_env HOME="${home_dir}" PATH="${fakebin}:${PATH}" FAKE_SUPPORT_ROOT="${support_root}" FAKE_RAW_BASE="${raw_base}" TLH_REF="main" TLH_RAW_BASE="${raw_base}" bash "${stale_installer}" --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  assert_contains "${combined_file}" "Refreshing installer..."
  assert_contains "${combined_file}" "fake_stage1=ok"
  assert_contains "${combined_file}" "compat_librarian_present=false"
  assert_contains "${combined_file}" "compat_query_present=false"
  assert_contains "${combined_file}" "stale_poison_present=false"
  assert_not_contains "${combined_file}" "stale-stage0-only.txt"
  assert_absent "${agent_dir}"
  assert_absent "${bin_dir}"
  assert_absent "${home_dir}/.pi"
  assert_absent "${home_dir}/.the-last-harness"
}
