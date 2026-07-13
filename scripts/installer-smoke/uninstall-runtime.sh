#!/usr/bin/env bash

run_uninstall_dry_run_pi_smoke() {
  log "Running uninstall.sh --dry-run piInstalledByTlh smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-dry-run-pi"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  mkdir -p "${case_dir}"

  # ── piInstalledByTlh:true + origin=created marker → rm -rf plan ──────────
  local true_agent="${case_dir}/pi-true/agent"
  local true_runtime="${case_dir}/pi-true/runtime"
  mkdir -p "${true_agent}/tlh"
  write_tlh_pi_runtime "${true_runtime}"
  write_tlh_runtime_marker "${true_runtime}" created
  cat >"${true_agent}/tlh/install-state.json" <<'EOF_UNINSTALL_STATE_TRUE'
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness",
  "piInstalledByTlh": true
}
EOF_UNINSTALL_STATE_TRUE

  bash uninstall.sh --dry-run --agent-dir "${true_agent}" --bin-dir "${case_dir}/bin-true" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would remove private runtime: rm -rf ${true_runtime}"

  # ── piInstalledByTlh:true + origin=migrated marker → npm uninstall plan ──
  local migrated_agent="${case_dir}/pi-migrated/agent"
  local migrated_runtime="${case_dir}/pi-migrated/runtime"
  mkdir -p "${migrated_agent}/tlh"
  write_tlh_pi_runtime "${migrated_runtime}"
  write_tlh_runtime_marker "${migrated_runtime}" migrated
  cat >"${migrated_agent}/tlh/install-state.json" <<'EOF_UNINSTALL_STATE_MIGRATED'
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness",
  "piInstalledByTlh": true
}
EOF_UNINSTALL_STATE_MIGRATED

  : >"${stdout_file}"
  : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${migrated_agent}" --bin-dir "${case_dir}/bin-migrated" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would remove migrated TLH pi from shared runtime (npm): npm uninstall -g --ignore-scripts --prefix \"${migrated_runtime}\" @earendil-works/pi-coding-agent"
  assert_not_contains "${combined_file}" "would remove private runtime: rm -rf ${migrated_runtime}"

  # ── piInstalledByTlh:true + unmarked runtime → plan shows skip ────────────
  local unmarked_agent="${case_dir}/pi-unmarked/agent"
  local unmarked_runtime="${case_dir}/pi-unmarked/runtime"
  mkdir -p "${unmarked_agent}/tlh"
  write_tlh_pi_runtime "${unmarked_runtime}"
  cat >"${unmarked_agent}/tlh/install-state.json" <<'EOF_UNINSTALL_STATE_UNMARKED'
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness",
  "piInstalledByTlh": true
}
EOF_UNINSTALL_STATE_UNMARKED

  : >"${stdout_file}"
  : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${unmarked_agent}" --bin-dir "${case_dir}/bin-unmarked" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_contains "${combined_file}" "${unmarked_runtime} looks like a TLH pi runtime but has no valid TLH runtime ownership marker"

  # ── origin=migrated marker overrides piInstalledByTlh:false → npm uninstall plan ──
  local migrated_false_agent="${case_dir}/pi-migrated-false/agent"
  local migrated_false_runtime="${case_dir}/pi-migrated-false/runtime"
  mkdir -p "${migrated_false_agent}/tlh"
  write_tlh_pi_runtime "${migrated_false_runtime}"
  write_tlh_runtime_marker "${migrated_false_runtime}" migrated
  cat >"${migrated_false_agent}/tlh/install-state.json" <<'EOF_UNINSTALL_STATE_MIGRATED_FALSE'
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness",
  "piInstalledByTlh": false
}
EOF_UNINSTALL_STATE_MIGRATED_FALSE

  : >"${stdout_file}"
  : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${migrated_false_agent}" --bin-dir "${case_dir}/bin-migrated-false" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would remove migrated TLH pi from shared runtime (npm): npm uninstall -g --ignore-scripts --prefix \"${migrated_false_runtime}\" @earendil-works/pi-coding-agent"
  assert_not_contains "${combined_file}" "would skip pi/runtime removal (install-state: piInstalledByTlh=false)"
  assert_not_contains "${combined_file}" "would remove private runtime: rm -rf ${migrated_false_runtime}"

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
  assert_contains "${combined_file}" "would skip pi/runtime removal (install-state: piInstalledByTlh=false)"

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
  assert_contains "${combined_file}" "would skip pi/runtime removal (install-state absent or piInstalledByTlh field missing)"
}

run_uninstall_flag_override_smoke() {
  log "Running uninstall.sh flag override smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-flag-override"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${case_dir}"

  # ── valid-marker runtime with piInstalledByTlh=false and --force-include-pi ────
  # The marker is now authoritative; --force-include-pi is redundant for a marked
  # runtime but must not conflict.  Runtime removal is planned in both cases.
  local force_agent="${case_dir}/force-include/agent"
  local force_runtime="${case_dir}/force-include/runtime"
  mkdir -p "${force_agent}/tlh"
  # Seed the TLH pi layout and origin=created marker so the runtime-removal path is eligible.
  write_tlh_pi_runtime "${force_runtime}"
  write_tlh_runtime_marker "${force_runtime}" created
  cat >"${force_agent}/tlh/install-state.json" <<'EOF_FORCE_STATE'
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness",
  "piInstalledByTlh": false
}
EOF_FORCE_STATE

  bash uninstall.sh --dry-run --force-include-pi --agent-dir "${force_agent}" --bin-dir "${case_dir}/bin-force" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would remove private runtime: rm -rf ${force_runtime}"

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
  assert_contains "${combined_file}" "would skip pi/runtime removal (--keep-pi flag)"

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

run_uninstall_runtime_ownership_smoke() {
  log "Running uninstall.sh runtime-ownership safety smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-runtime-ownership"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${case_dir}"

  # ── Case 1: unrelated runtime sibling (no TLH layout) → NOT deleted ─────────
  # piInstalledByTlh=true but RUNTIME_DIR lacks bin/pi and lib/node_modules.
  # The uninstaller must warn and skip rather than rm -rf the unrelated dir.
  local unrelated_dir="${case_dir}/unrelated"
  local unrelated_agent="${unrelated_dir}/agent"
  local unrelated_runtime="${unrelated_dir}/runtime"
  assert_safe_uninstall_smoke_paths "${unrelated_agent}" "${case_dir}/bin-unrelated"
  write_tlh_install_state "${unrelated_agent}" true
  # Create a pre-existing runtime sibling with unrelated content (no TLH pi layout).
  mkdir -p "${unrelated_runtime}"
  printf 'pre-existing unrelated file\n' >"${unrelated_runtime}/not-tlh.txt"

  # dry-run: plan must show skip, not removal.
  bash uninstall.sh --dry-run --agent-dir "${unrelated_agent}" --bin-dir "${case_dir}/bin-unrelated" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_contains "${combined_file}" "${unrelated_runtime}"
  assert_not_contains "${combined_file}" "would remove private runtime"

  # real run: agent dir is removed, but unrelated runtime must survive intact.
  : >"${stdout_file}"
  : >"${stderr_file}"
  bash uninstall.sh --agent-dir "${unrelated_agent}" --bin-dir "${case_dir}/bin-unrelated" >"${stdout_file}" 2>"${stderr_file}"
  assert_absent "${unrelated_agent}"
  assert_present "${unrelated_runtime}/not-tlh.txt"
  assert_present "${unrelated_runtime}"

  # ── Case 2: TLH-created runtime (proper layout + marker) → IS removed ─────
  # piInstalledByTlh=true, the runtime has the expected TLH pi layout, and the
  # origin=created ownership marker is present. The uninstaller must plan and
  # execute removal.
  local owned_dir="${case_dir}/owned"
  local owned_agent="${owned_dir}/agent"
  local owned_runtime="${owned_dir}/runtime"
  assert_safe_uninstall_smoke_paths "${owned_agent}" "${case_dir}/bin-owned"
  write_tlh_install_state "${owned_agent}" true
  write_tlh_pi_runtime "${owned_runtime}"
  write_tlh_runtime_marker "${owned_runtime}" created

  # dry-run: plan must show removal.
  : >"${stdout_file}"
  : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${owned_agent}" --bin-dir "${case_dir}/bin-owned" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would remove private runtime: rm -rf ${owned_runtime}"

  # real run: TLH runtime must be removed.
  : >"${stdout_file}"
  : >"${stderr_file}"
  bash uninstall.sh --agent-dir "${owned_agent}" --bin-dir "${case_dir}/bin-owned" >"${stdout_file}" 2>"${stderr_file}"
  assert_absent "${owned_runtime}"

  # ── Case 3: TLH layout + co-located sentinel → NOT deleted ───────────────
  # RUNTIME_DIR has both the TLH pi layout (bin/pi + lib/node_modules/...) AND
  # an unrelated top-level file (userdata.txt).  The exclusivity check must
  # detect the sentinel and skip removal to protect the user's co-located file.
  local mixed_dir="${case_dir}/mixed"
  local mixed_agent="${mixed_dir}/agent"
  local mixed_runtime="${mixed_dir}/runtime"
  local mixed_sentinel="${mixed_runtime}/userdata.txt"
  assert_safe_uninstall_smoke_paths "${mixed_agent}" "${case_dir}/bin-mixed"
  write_tlh_install_state "${mixed_agent}" true
  write_tlh_pi_runtime "${mixed_runtime}"
  write_tlh_runtime_marker "${mixed_runtime}" created
  # Seed the co-located sentinel alongside the TLH pi layout.
  printf 'user co-located data — must survive\n' >"${mixed_sentinel}"

  # dry-run: plan must show skip, not removal.
  : >"${stdout_file}"
  : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${mixed_agent}" --bin-dir "${case_dir}/bin-mixed" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_contains "${combined_file}" "${mixed_runtime}"
  assert_not_contains "${combined_file}" "would remove private runtime"

  # real run: agent dir is removed, but runtime dir and sentinel must survive.
  : >"${stdout_file}"
  : >"${stderr_file}"
  bash uninstall.sh --agent-dir "${mixed_agent}" --bin-dir "${case_dir}/bin-mixed" >"${stdout_file}" 2>"${stderr_file}"
  assert_absent "${mixed_agent}"
  assert_present "${mixed_sentinel}"
  assert_present "${mixed_runtime}"

  # ── Case 4: TLH layout + '..userdata' sentinel → NOT deleted ─────────────
  # Like Case 3 but the co-located file starts with '..', e.g. '..userdata'.
  # The old dual-glob '* .[!.]*' missed such names; the shopt dotglob fix must
  # catch them.  The exclusivity check must detect '..userdata' and skip removal.
  local dotdot_dir="${case_dir}/dotdot"
  local dotdot_agent="${dotdot_dir}/agent"
  local dotdot_runtime="${dotdot_dir}/runtime"
  local dotdot_sentinel="${dotdot_runtime}/..userdata"
  assert_safe_uninstall_smoke_paths "${dotdot_agent}" "${case_dir}/bin-dotdot"
  write_tlh_install_state "${dotdot_agent}" true
  write_tlh_pi_runtime "${dotdot_runtime}"
  write_tlh_runtime_marker "${dotdot_runtime}" created
  # Seed a '..userdata' sentinel alongside the TLH pi layout.
  printf 'user dotdot-named data — must survive\n' >"${dotdot_sentinel}"

  # dry-run: plan must show skip, not removal.
  : >"${stdout_file}"
  : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${dotdot_agent}" --bin-dir "${case_dir}/bin-dotdot" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_contains "${combined_file}" "${dotdot_runtime}"
  assert_not_contains "${combined_file}" "would remove private runtime"

  # real run: agent dir is removed, but runtime dir and '..userdata' sentinel must survive.
  : >"${stdout_file}"
  : >"${stderr_file}"
  bash uninstall.sh --agent-dir "${dotdot_agent}" --bin-dir "${case_dir}/bin-dotdot" >"${stdout_file}" 2>"${stderr_file}"
  assert_absent "${dotdot_agent}"
  assert_present "${dotdot_sentinel}"
  assert_present "${dotdot_runtime}"

  # ── Case 5: migrated runtime → surgical uninstall clears marker only ───────
  # origin=migrated must preserve the shared prefix and foreign packages while
  # clearing TLH's ownership marker after npm uninstall succeeds.
  local migrated_dir="${case_dir}/migrated"
  local migrated_agent="${migrated_dir}/agent"
  local migrated_runtime="${migrated_dir}/runtime"
  local migrated_fakebin="${migrated_dir}/fakebin"
  local migrated_npm_log="${migrated_dir}/npm.log"
  local foreign_package_dir="${migrated_runtime}/lib/node_modules/foreign-package"
  local foreign_package_file="${foreign_package_dir}/package.json"
  assert_safe_uninstall_smoke_paths "${migrated_agent}" "${case_dir}/bin-migrated"
  write_tlh_install_state "${migrated_agent}" true
  write_tlh_pi_runtime "${migrated_runtime}"
  write_tlh_runtime_marker "${migrated_runtime}" migrated
  mkdir -p "${migrated_fakebin}" "${foreign_package_dir}"
  printf '{"name":"foreign-package"}\n' >"${foreign_package_file}"
  cat >"${migrated_fakebin}/npm" <<EOF_MIGRATED_NPM
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >"${migrated_npm_log}"
if [[ "\$#" -ne 6 || "\$1" != "uninstall" || "\$2" != "-g" || "\$3" != "--ignore-scripts" || "\$4" != "--prefix" || "\$5" != "${migrated_runtime}" || "\$6" != "@earendil-works/pi-coding-agent" ]]; then
  printf 'unexpected npm args: %s\n' "\$*" >&2
  exit 97
fi
rm -rf "${migrated_runtime}/lib/node_modules/@earendil-works/pi-coding-agent"
rm -f "${migrated_runtime}/bin/pi"
EOF_MIGRATED_NPM
  chmod +x "${migrated_fakebin}/npm"

  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
  PATH="${migrated_fakebin}:${PATH}" bash uninstall.sh --agent-dir "${migrated_agent}" --bin-dir "${case_dir}/bin-migrated" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  if [[ "${status}" -ne 0 ]]; then
    cat "${combined_file}" >&2
    fail "migrated runtime uninstall smoke exited with non-zero status: ${status}"
  fi
  assert_contains "${migrated_npm_log}" "uninstall -g --ignore-scripts --prefix ${migrated_runtime} @earendil-works/pi-coding-agent"
  assert_absent "${migrated_runtime}/.tlh-runtime-owned"
  assert_absent "${migrated_runtime}/lib/node_modules/@earendil-works/pi-coding-agent"
  assert_absent "${migrated_runtime}/bin/pi"
  assert_present "${foreign_package_file}"
  assert_present "${migrated_runtime}"
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

run_uninstall_marker_authoritative_smoke() {
  log "Running uninstall.sh marker-authoritative removal smoke check..."
  # Regression (tlht-bfkx): a valid-marker runtime must be removed even when
  # piInstalledByTlh=false and --force-include-pi is NOT passed.  The ownership
  # marker is the authoritative signal; install-state is non-gating for the
  # marked private-runtime path.
  local case_dir="${TMP_ROOT}/uninstall-marker-authoritative"
  local profile_root="${case_dir}/profile"
  local agent_dir="${profile_root}/agent"
  local runtime_dir="${profile_root}/runtime"
  local bin_dir="${case_dir}/bin"
  local wrapper_path
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  assert_safe_uninstall_smoke_paths "${agent_dir}" "${bin_dir}"
  mkdir -p "${bin_dir}"
  # piInstalledByTlh=false: install-state does NOT authorize removal.
  write_tlh_install_state "${agent_dir}" false
  # Valid-marker runtime: seed bin/pi, lib/node_modules, and the ownership marker.
  write_tlh_pi_runtime "${runtime_dir}"
  write_tlh_runtime_marker "${runtime_dir}" created
  wrapper_path="$(cd "${bin_dir}" >/dev/null 2>&1 && pwd -P)/tlh"
  write_managed_wrapper "${wrapper_path}"

  # ── dry-run: plan must show private runtime removal (no --force-include-pi) ────
  bash uninstall.sh --dry-run --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would remove private runtime: rm -rf ${runtime_dir}"
  assert_not_contains "${combined_file}" "would skip pi/runtime removal"
  # dry-run must not actually remove the runtime
  assert_present "${runtime_dir}"

  # ── real run: runtime, agent dir, and wrapper are removed ───────────────────
  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
  bash uninstall.sh --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  if [[ "${status}" -ne 0 ]]; then
    cat "${combined_file}" >&2
    fail "marker-authoritative uninstall smoke exited with non-zero status: ${status}"
  fi
  assert_absent "${runtime_dir}"
  assert_absent "${agent_dir}"
  assert_absent "${wrapper_path}"
  assert_absent "${profile_root}"
}

run_uninstall_malformed_marker_json_smoke() {
  log "Running uninstall.sh malformed-marker-JSON ownership-marker adversarial smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-malformed-marker"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  mkdir -p "${case_dir}"

  # Each sub-case seeds a valid agent-dir (install-state piInstalledByTlh=true) and a
  # TLH pi runtime layout, then writes an adversarial or symlinked marker file.
  # The invariant is: unextractable OR field-VALUE invalid/mismatched marker → SKIP
  # (Cases 1-9 below).  Grammar-only defects that leave all ownership field VALUES
  # intact are a separate class: the sed-based parser extracts values leniently and
  # PLANS REMOVAL when all fields are valid and the path+pi-layout checks pass
  # (Case 10 below).  Do NOT read this function as "all malformed markers → skip".

  # ── Case 1: truncated JSON (packageName and other fields absent) ─────────────
  local truncated_agent="${case_dir}/truncated/agent"
  local truncated_runtime="${case_dir}/truncated/runtime"
  local truncated_bin="${case_dir}/bin-truncated"
  write_tlh_install_state "${truncated_agent}" true
  write_tlh_pi_runtime "${truncated_runtime}"
  printf '{"schemaVersion":1,' >"${truncated_runtime}/.tlh-runtime-owned"

  bash uninstall.sh --dry-run --agent-dir "${truncated_agent}" --bin-dir "${truncated_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_not_contains "${combined_file}" "would remove private runtime: rm -rf ${truncated_runtime}"

  # ── Case 2: garbage (not JSON) ───────────────────────────────────────────────
  local garbage_agent="${case_dir}/garbage/agent"
  local garbage_runtime="${case_dir}/garbage/runtime"
  local garbage_bin="${case_dir}/bin-garbage"
  write_tlh_install_state "${garbage_agent}" true
  write_tlh_pi_runtime "${garbage_runtime}"
  printf '!!NOT_JSON_AT_ALL!!' >"${garbage_runtime}/.tlh-runtime-owned"

  : >"${stdout_file}"; : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${garbage_agent}" --bin-dir "${garbage_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_not_contains "${combined_file}" "would remove private runtime: rm -rf ${garbage_runtime}"

  # ── Case 3: trailing comma inside origin value ("created," ≠ "created") ──────
  local trailcomma_origin_agent="${case_dir}/trailing-comma-origin/agent"
  local trailcomma_origin_runtime="${case_dir}/trailing-comma-origin/runtime"
  local trailcomma_origin_bin="${case_dir}/bin-trailing-comma-origin"
  local trailcomma_origin_real
  write_tlh_install_state "${trailcomma_origin_agent}" true
  write_tlh_pi_runtime "${trailcomma_origin_runtime}"
  trailcomma_origin_real="$(cd "${trailcomma_origin_runtime}" >/dev/null 2>&1 && pwd -P)"
  printf '{"schemaVersion":1,"packageName":"@earendil-works/pi-coding-agent","runtimeAbsPath":"%s","origin":"created,"}' \
    "${trailcomma_origin_real}" >"${trailcomma_origin_runtime}/.tlh-runtime-owned"

  : >"${stdout_file}"; : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${trailcomma_origin_agent}" --bin-dir "${trailcomma_origin_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_not_contains "${combined_file}" "would remove private runtime: rm -rf ${trailcomma_origin_runtime}"

  # ── Case 4: CRLF embedded in runtimeAbsPath value (\r taints path comparison) ─
  # The \r inside the JSON string value causes sed to extract PATH\r ≠ actual PATH.
  local crlf_agent="${case_dir}/crlf/agent"
  local crlf_runtime="${case_dir}/crlf/runtime"
  local crlf_bin="${case_dir}/bin-crlf"
  local crlf_real
  write_tlh_install_state "${crlf_agent}" true
  write_tlh_pi_runtime "${crlf_runtime}"
  crlf_real="$(cd "${crlf_runtime}" >/dev/null 2>&1 && pwd -P)"
  printf '{"schemaVersion":1,"packageName":"@earendil-works/pi-coding-agent","runtimeAbsPath":"%s\r","origin":"created"}' \
    "${crlf_real}" >"${crlf_runtime}/.tlh-runtime-owned"

  : >"${stdout_file}"; : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${crlf_agent}" --bin-dir "${crlf_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_not_contains "${combined_file}" "would remove private runtime: rm -rf ${crlf_runtime}"

  # ── Case 5: escaped quote in packageName (sed [^"]* stops early; wrong value) ─
  # The marker contains a literal backslash before the closing " of the packageName
  # value.  sed [^"]* captures the backslash and stops at ", extracting
  # @earendil-works/pi-coding-agent\ which ≠ the expected package name.
  local escquote_agent="${case_dir}/escaped-quote/agent"
  local escquote_runtime="${case_dir}/escaped-quote/runtime"
  local escquote_bin="${case_dir}/bin-escaped-quote"
  local escquote_real
  write_tlh_install_state "${escquote_agent}" true
  write_tlh_pi_runtime "${escquote_runtime}"
  escquote_real="$(cd "${escquote_runtime}" >/dev/null 2>&1 && pwd -P)"
  # In the heredoc body: \\ is a single backslash written to the file.
  # File content: ..."packageName":"@earendil-works/pi-coding-agent\",...
  # sed stops at the first " after the opening ", capturing the trailing \.
  cat >"${escquote_runtime}/.tlh-runtime-owned" <<EOF_ESCQUOTE
{"schemaVersion":1,"packageName":"@earendil-works/pi-coding-agent\\","runtimeAbsPath":"${escquote_real}","origin":"created"}
EOF_ESCQUOTE

  : >"${stdout_file}"; : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${escquote_agent}" --bin-dir "${escquote_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_not_contains "${combined_file}" "would remove private runtime: rm -rf ${escquote_runtime}"

  # ── Case 6: nested object as packageName value (no string → empty extraction) ─
  # The sed pattern requires '"' immediately after ':'; a '{' causes no match,
  # leaving _mpkg empty → fails packageName check.
  local nested_agent="${case_dir}/nested-object/agent"
  local nested_runtime="${case_dir}/nested-object/runtime"
  local nested_bin="${case_dir}/bin-nested-object"
  local nested_real
  write_tlh_install_state "${nested_agent}" true
  write_tlh_pi_runtime "${nested_runtime}"
  nested_real="$(cd "${nested_runtime}" >/dev/null 2>&1 && pwd -P)"
  printf '{"schemaVersion":1,"packageName":{"real":"@earendil-works/pi-coding-agent"},"runtimeAbsPath":"%s","origin":"created"}' \
    "${nested_real}" >"${nested_runtime}/.tlh-runtime-owned"

  : >"${stdout_file}"; : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${nested_agent}" --bin-dir "${nested_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_not_contains "${combined_file}" "would remove private runtime: rm -rf ${nested_runtime}"

  # ── Case 7: duplicate schemaVersion keys (last occurrence is wrong → SKIP) ───
  # sed uses greedy .* and picks the LAST match on the line; putting the wrong
  # schemaVersion last (=2) means _mver="2" ≠ "1" → fails schemaVersion check.
  local dupkey_agent="${case_dir}/duplicate-key/agent"
  local dupkey_runtime="${case_dir}/duplicate-key/runtime"
  local dupkey_bin="${case_dir}/bin-duplicate-key"
  local dupkey_real
  write_tlh_install_state "${dupkey_agent}" true
  write_tlh_pi_runtime "${dupkey_runtime}"
  dupkey_real="$(cd "${dupkey_runtime}" >/dev/null 2>&1 && pwd -P)"
  printf '{"schemaVersion":1,"packageName":"@earendil-works/pi-coding-agent","runtimeAbsPath":"%s","origin":"created","schemaVersion":2}' \
    "${dupkey_real}" >"${dupkey_runtime}/.tlh-runtime-owned"

  : >"${stdout_file}"; : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${dupkey_agent}" --bin-dir "${dupkey_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_not_contains "${combined_file}" "would remove private runtime: rm -rf ${dupkey_runtime}"

  # ── Case 8: symlinked RUNTIME_DIR → "is a symlink; cannot verify TLH ownership" ─
  local symlinkrt_agent="${case_dir}/symlinked-runtime-dir/agent"
  local symlinkrt_real_runtime="${case_dir}/symlinked-runtime-dir/real-runtime"
  local symlinkrt_runtime="${case_dir}/symlinked-runtime-dir/runtime"
  local symlinkrt_bin="${case_dir}/bin-symlinked-runtime-dir"
  write_tlh_install_state "${symlinkrt_agent}" true
  write_tlh_pi_runtime "${symlinkrt_real_runtime}"
  write_tlh_runtime_marker "${symlinkrt_real_runtime}" created
  ln -s "${symlinkrt_real_runtime}" "${symlinkrt_runtime}"

  : >"${stdout_file}"; : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${symlinkrt_agent}" --bin-dir "${symlinkrt_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_contains "${combined_file}" "${symlinkrt_runtime} is a symlink; cannot verify TLH ownership"
  assert_not_contains "${combined_file}" "would remove private runtime: rm -rf ${symlinkrt_runtime}"

  # ── Case 9: symlinked marker file → "ownership marker ... is a symlink" ────────
  local symlinkm_agent="${case_dir}/symlinked-marker/agent"
  local symlinkm_runtime="${case_dir}/symlinked-marker/runtime"
  local symlinkm_bin="${case_dir}/bin-symlinked-marker"
  local symlinkm_marker="${symlinkm_runtime}/.tlh-runtime-owned"
  local symlinkm_marker_target="${case_dir}/symlinked-marker/real-marker-content"
  local symlinkm_real
  write_tlh_install_state "${symlinkm_agent}" true
  write_tlh_pi_runtime "${symlinkm_runtime}"
  symlinkm_real="$(cd "${symlinkm_runtime}" >/dev/null 2>&1 && pwd -P)"
  printf '{"schemaVersion":1,"packageName":"@earendil-works/pi-coding-agent","runtimeAbsPath":"%s","origin":"created"}' \
    "${symlinkm_real}" >"${symlinkm_marker_target}"
  ln -s "${symlinkm_marker_target}" "${symlinkm_marker}"

  : >"${stdout_file}"; : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${symlinkm_agent}" --bin-dir "${symlinkm_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_contains "${combined_file}" "ownership marker ${symlinkm_marker} is a symlink; cannot verify TLH ownership"
  assert_not_contains "${combined_file}" "would remove private runtime: rm -rf ${symlinkm_runtime}"

  # ── Case 10: grammar-only-malformed marker (trailing comma after last field) → PLANS REMOVAL ──
  # The marker JSON is syntactically invalid (a trailing comma after the closing
  # "origin":"created" makes it unparseable by JSON.parse).  However, all ownership
  # field VALUES are valid and extractable by the bash sed-based parser: schemaVersion=1,
  # packageName=@earendil-works/pi-coding-agent, runtimeAbsPath matches, origin=created.
  # The pi layout is present and the runtime dir is real (not a symlink).
  # Per the intentional lenient value-extraction design (Option A), uninstall.sh PLANS
  # rm -rf removal: a grammar defect that does not corrupt any ownership field value does
  # not block removal when the runtime is provably TLH-owned.  This is correct behavior.
  local grammaronly_agent="${case_dir}/grammar-only/agent"
  local grammaronly_runtime="${case_dir}/grammar-only/runtime"
  local grammaronly_bin="${case_dir}/bin-grammar-only"
  local grammaronly_real
  write_tlh_install_state "${grammaronly_agent}" true
  write_tlh_pi_runtime "${grammaronly_runtime}"
  grammaronly_real="$(cd "${grammaronly_runtime}" >/dev/null 2>&1 && pwd -P)"
  # Trailing comma after "origin":"created" — invalid JSON grammar, valid extracted values.
  printf '{"schemaVersion":1,"packageName":"@earendil-works/pi-coding-agent","runtimeAbsPath":"%s","origin":"created",}' \
    "${grammaronly_real}" >"${grammaronly_runtime}/.tlh-runtime-owned"

  : >"${stdout_file}"; : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${grammaronly_agent}" --bin-dir "${grammaronly_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would remove private runtime: rm -rf ${grammaronly_runtime}"
  assert_not_contains "${combined_file}" "would skip pi/runtime removal"
}

run_uninstall_install_state_parser_smoke() {
  log "Running uninstall.sh install-state parser CRLF/trailing-comma/whitespace smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-install-state-parser"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local home_dir="${case_dir}/home"
  mkdir -p "${case_dir}" "${home_dir}"

  # The read_pi_installed_by_tlh function explicitly handles CRLF (tr -d '\r'),
  # trailing commas (grep pattern matches 'false'/'true' regardless of suffix),
  # and extra whitespace ([[:space:]]* around ':').  These cases prove each
  # variant is correctly parsed despite the malformation.

  # ── CRLF: piInstalledByTlh=false with CRLF line endings → read as false ───────
  local crlf_false_agent="${case_dir}/crlf-false/agent"
  local crlf_false_bin="${case_dir}/bin-crlf-false"
  mkdir -p "${crlf_false_agent}/tlh"
  printf '{\r\n  "schemaVersion": 1,\r\n  "piInstalledByTlh": false\r\n}\r\n' >"${crlf_false_agent}/tlh/install-state.json"

  bash uninstall.sh --dry-run --agent-dir "${crlf_false_agent}" --bin-dir "${crlf_false_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_contains "${combined_file}" "install-state: piInstalledByTlh=false"

  # ── Field followed by comma: "piInstalledByTlh": false, (valid JSON with a following field) ─
  local trailcomma_false_agent="${case_dir}/trailing-comma-false/agent"
  local trailcomma_false_bin="${case_dir}/bin-trailing-comma-false"
  mkdir -p "${trailcomma_false_agent}/tlh"
  cat >"${trailcomma_false_agent}/tlh/install-state.json" <<'EOF_TC_FALSE'
{
  "schemaVersion": 1,
  "piInstalledByTlh": false,
  "extra": "field"
}
EOF_TC_FALSE

  : >"${stdout_file}"; : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${trailcomma_false_agent}" --bin-dir "${trailcomma_false_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_contains "${combined_file}" "install-state: piInstalledByTlh=false"

  # ── Whitespace: extra spaces around : → read as false ────────────────────────
  local ws_false_agent="${case_dir}/whitespace-false/agent"
  local ws_false_bin="${case_dir}/bin-whitespace-false"
  mkdir -p "${ws_false_agent}/tlh"
  cat >"${ws_false_agent}/tlh/install-state.json" <<'EOF_WS_FALSE'
{
  "schemaVersion": 1,
  "piInstalledByTlh"  :  false
}
EOF_WS_FALSE

  : >"${stdout_file}"; : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${ws_false_agent}" --bin-dir "${ws_false_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_contains "${combined_file}" "install-state: piInstalledByTlh=false"

  # ── CRLF: piInstalledByTlh=true with CRLF → read as true (no private runtime → no-op skip) ─
  # Uses a scrubbed HOME so ~/.local/bin/pi from the host system does not interfere.
  local crlf_true_agent="${case_dir}/crlf-true/agent"
  local crlf_true_bin="${case_dir}/bin-crlf-true"
  mkdir -p "${crlf_true_agent}/tlh"
  printf '{\r\n  "schemaVersion": 1,\r\n  "piInstalledByTlh": true\r\n}\r\n' >"${crlf_true_agent}/tlh/install-state.json"

  : >"${stdout_file}"; : >"${stderr_file}"
  HOME="${home_dir}" bash uninstall.sh --dry-run --agent-dir "${crlf_true_agent}" --bin-dir "${crlf_true_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  # piInstalledByTlh parsed as true → REMOVE_PI=true; no private runtime present
  # → falls through to "no pi installation found" skip (not the false/absent path).
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_contains "${combined_file}" "no pi installation found"
  assert_not_contains "${combined_file}" "piInstalledByTlh=false"
  assert_not_contains "${combined_file}" "piInstalledByTlh field missing"

  # ── Field followed by comma: piInstalledByTlh=true, → read as true ─────────────
  local trailcomma_true_agent="${case_dir}/trailing-comma-true/agent"
  local trailcomma_true_bin="${case_dir}/bin-trailing-comma-true"
  mkdir -p "${trailcomma_true_agent}/tlh"
  cat >"${trailcomma_true_agent}/tlh/install-state.json" <<'EOF_TC_TRUE'
{
  "schemaVersion": 1,
  "piInstalledByTlh": true,
  "extra": "field"
}
EOF_TC_TRUE

  : >"${stdout_file}"; : >"${stderr_file}"
  HOME="${home_dir}" bash uninstall.sh --dry-run --agent-dir "${trailcomma_true_agent}" --bin-dir "${trailcomma_true_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_contains "${combined_file}" "no pi installation found"
  assert_not_contains "${combined_file}" "piInstalledByTlh=false"
  assert_not_contains "${combined_file}" "piInstalledByTlh field missing"

  # ── Whitespace: piInstalledByTlh  :  true → read as true ─────────────────────
  local ws_true_agent="${case_dir}/whitespace-true/agent"
  local ws_true_bin="${case_dir}/bin-whitespace-true"
  mkdir -p "${ws_true_agent}/tlh"
  cat >"${ws_true_agent}/tlh/install-state.json" <<'EOF_WS_TRUE'
{
  "schemaVersion": 1,
  "piInstalledByTlh"  :  true
}
EOF_WS_TRUE

  : >"${stdout_file}"; : >"${stderr_file}"
  HOME="${home_dir}" bash uninstall.sh --dry-run --agent-dir "${ws_true_agent}" --bin-dir "${ws_true_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would skip pi/runtime removal"
  assert_contains "${combined_file}" "no pi installation found"
  assert_not_contains "${combined_file}" "piInstalledByTlh=false"
  assert_not_contains "${combined_file}" "piInstalledByTlh field missing"
}

run_uninstall_special_char_paths_smoke() {
  log "Running uninstall.sh special-character paths smoke check..."
  local case_dir="${TMP_ROOT}/uninstall-special-char-paths"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  local sq dol bt
  sq="'"   # single quote
  dol='$'  # dollar sign
  bt='`'   # backtick
  mkdir -p "${case_dir}"

  # ── Dry-run: spaces in --agent-dir ──────────────────────────────────────
  local space_agent="${case_dir}/my agent dir/agent"
  local space_bin="${case_dir}/bin-space"
  assert_safe_uninstall_smoke_paths "${space_agent}" "${space_bin}"
  write_tlh_install_state "${space_agent}" false

  bash uninstall.sh --dry-run --agent-dir "${space_agent}" --bin-dir "${space_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would run: rm -rf ${space_agent}"

  # ── Dry-run: single quote in --agent-dir ────────────────────────────────
  local sq_agent="${case_dir}/agent${sq}s dir/agent"
  local sq_bin="${case_dir}/bin-sq"
  assert_safe_uninstall_smoke_paths "${sq_agent}" "${sq_bin}"
  write_tlh_install_state "${sq_agent}" false

  : >"${stdout_file}"; : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${sq_agent}" --bin-dir "${sq_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would run: rm -rf ${sq_agent}"

  # ── Dry-run: dollar sign in --agent-dir ─────────────────────────────────
  local dol_agent="${case_dir}/agent${dol}cost/agent"
  local dol_bin="${case_dir}/bin-dol"
  assert_safe_uninstall_smoke_paths "${dol_agent}" "${dol_bin}"
  write_tlh_install_state "${dol_agent}" false

  : >"${stdout_file}"; : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${dol_agent}" --bin-dir "${dol_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would run: rm -rf ${dol_agent}"

  # ── Dry-run: backtick in --agent-dir ────────────────────────────────────
  local bt_agent="${case_dir}/agent${bt}tick/agent"
  local bt_bin="${case_dir}/bin-bt"
  assert_safe_uninstall_smoke_paths "${bt_agent}" "${bt_bin}"
  write_tlh_install_state "${bt_agent}" false

  : >"${stdout_file}"; : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${bt_agent}" --bin-dir "${bt_bin}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would run: rm -rf ${bt_agent}"

  # ── Dry-run: spaces in --bin-dir with managed wrapper ───────────────────
  # BIN_DIR is resolved via realpath_for_compare in uninstall.sh, so resolve
  # the canonical path before asserting on the printed WRAPPER_PATH.
  local space_bindir_agent="${case_dir}/space-bindir agent/agent"
  local space_bin_dir="${case_dir}/my bin dir"
  assert_safe_uninstall_smoke_paths "${space_bindir_agent}" "${space_bin_dir}"
  write_tlh_install_state "${space_bindir_agent}" false
  mkdir -p "${space_bin_dir}"
  local space_bin_dir_real
  space_bin_dir_real="$(cd "${space_bin_dir}" >/dev/null 2>&1 && pwd -P)"
  local space_bindir_wrapper="${space_bin_dir_real}/tlh"
  write_managed_wrapper "${space_bindir_wrapper}"

  : >"${stdout_file}"; : >"${stderr_file}"
  bash uninstall.sh --dry-run --agent-dir "${space_bindir_agent}" --bin-dir "${space_bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "would run: rm -f ${space_bindir_wrapper}"
  assert_contains "${combined_file}" "would run: rm -rf ${space_bindir_agent}"

  # ── Dry-run: special chars in --wrapper-name are rejected by validator ─────
  # --wrapper-name is restricted to [A-Za-z0-9._-]; spaces, quotes, $, and
  # backticks must produce a clear validation error (not a word-split crash).
  local wn_agent="${case_dir}/wn-agent/agent"
  local wn_bin="${case_dir}/bin-wn"
  write_tlh_install_state "${wn_agent}" false
  local wn_status=0
  set +e
  bash uninstall.sh --dry-run --agent-dir "${wn_agent}" --bin-dir "${wn_bin}" --wrapper-name "bad name" >"${stdout_file}" 2>"${stderr_file}"
  wn_status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  if [[ "${wn_status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "--wrapper-name with space unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "--wrapper-name must be a simple command name"

  : >"${stdout_file}"; : >"${stderr_file}"
  wn_status=0
  set +e
  bash uninstall.sh --dry-run --agent-dir "${wn_agent}" --bin-dir "${wn_bin}" --wrapper-name "bad${dol}name" >"${stdout_file}" 2>"${stderr_file}"
  wn_status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  if [[ "${wn_status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "--wrapper-name with dollar sign unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "--wrapper-name must be a simple command name"

  : >"${stdout_file}"; : >"${stderr_file}"
  wn_status=0
  set +e
  bash uninstall.sh --dry-run --agent-dir "${wn_agent}" --bin-dir "${wn_bin}" --wrapper-name "bad${bt}name" >"${stdout_file}" 2>"${stderr_file}"
  wn_status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  if [[ "${wn_status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "--wrapper-name with backtick unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "--wrapper-name must be a simple command name"

  : >"${stdout_file}"; : >"${stderr_file}"
  wn_status=0
  set +e
  bash uninstall.sh --dry-run --agent-dir "${wn_agent}" --bin-dir "${wn_bin}" --wrapper-name "bad${sq}name" >"${stdout_file}" 2>"${stderr_file}"
  wn_status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  if [[ "${wn_status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "--wrapper-name with single quote unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "--wrapper-name must be a simple command name"

  # ── Non-dry-run: space+single-quote agent dir; sibling and parent preserved
  # Validates AGENT_DIR-only recursion (gnosis hggnmq): uninstall.sh must
  # rm -rf only AGENT_DIR and attempt rmdir PROFILE_ROOT, leaving sibling
  # content under PROFILE_ROOT untouched.
  local real_profile="${case_dir}/profile${dol}data"
  local real_agent="${real_profile}/agent${sq}s dir"
  local real_bin="${case_dir}/bin-real"
  local sibling_file="${real_profile}/sibling keep.txt"
  local sibling_subdir="${real_profile}/sibling dir"
  assert_safe_uninstall_smoke_paths "${real_agent}" "${real_bin}"
  write_tlh_install_state "${real_agent}" false
  write_managed_wrapper "${real_bin}/tlh"
  # Seed sibling file and directory next to agent dir at PROFILE_ROOT level.
  printf 'sibling — must survive special-char uninstall\n' >"${sibling_file}"
  mkdir -p "${sibling_subdir}"
  printf 'sibling dir content — must survive\n' >"${sibling_subdir}/content.txt"

  : >"${stdout_file}"; : >"${stderr_file}"
  set +e
  bash uninstall.sh --agent-dir "${real_agent}" --bin-dir "${real_bin}" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -ne 0 ]]; then
    cat "${combined_file}" >&2
    fail "special-char paths non-dry-run smoke exited with non-zero status: ${status}"
  fi

  # Agent dir must be removed.
  assert_absent "${real_agent}"

  # Siblings at PROFILE_ROOT level must be preserved (AGENT_DIR-only recursion).
  assert_present "${sibling_file}"
  assert_present "${sibling_subdir}/content.txt"
  assert_present "${real_profile}"
}
