#!/usr/bin/env bash

run_stage1_dry_run_smoke() {
  log "Running stage-1 dry-run smoke check..."
  local case_dir="${TMP_ROOT}/stage1-dry-run"
  local agent_dir="${case_dir}/agent"
  local bin_dir="${case_dir}/bin"
  local fakebin="${case_dir}/fakebin"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local home_dir="${case_dir}/home"
  local node_cmd
  node_cmd="$(command -v node)"
  mkdir -p "${fakebin}" "${home_dir}"
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

  run_scrubbed_installer_env HOME="${home_dir}" PATH="${fakebin}" TLH_SKIP_GNOSIS_INSTALL=1 "${node_cmd}" scripts/tlh-install.mjs --dry-run --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
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
  local fakebin="${case_dir}/fakebin"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local run_dir
  mkdir -p "${home_dir}" "${cwd_dir}" "${fakebin}"
  run_dir="$(cd "${cwd_dir}" >/dev/null 2>&1 && pwd -P)"

  cat >"${fakebin}/sh" <<'EOF_FAKE_RELATIVE_SH'
#!/bin/sh
exec /bin/sh "$@"
EOF_FAKE_RELATIVE_SH
  cat >"${fakebin}/npm" <<'EOF_FAKE_RELATIVE_NPM'
#!/bin/sh
printf 'fake npm should not run during dry-run\n' >&2
exit 98
EOF_FAKE_RELATIVE_NPM
  cat >"${fakebin}/git" <<'EOF_FAKE_RELATIVE_GIT'
#!/bin/sh
printf 'fake git should not run during dry-run\n' >&2
exit 98
EOF_FAKE_RELATIVE_GIT
  chmod +x "${fakebin}/sh" "${fakebin}/npm" "${fakebin}/git"
  make_fake_present_pi "${fakebin}"

  # literal '~/poisoned-package' is intentional; smoke test verifies the installer rejects unexpanded tilde package sources
  # shellcheck disable=SC2088
  (cd "${run_dir}" && \
    export PI_CODING_AGENT_DIR="${home_dir}/.pi/agent" TLH_AGENT_DIR="${home_dir}/.pi/agent" TLH_BIN_DIR="${home_dir}/.pi/agent" TLH_PACKAGE_SOURCE="~/poisoned-package" TLH_REPO="poisoned/repo" TLH_REF="poisoned-ref" TLH_UPDATE_TRACK="custom" && \
    run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" PATH="${fakebin}:${PATH}" node "${ROOT_DIR}/scripts/tlh-install.mjs" --dry-run --agent-dir .pi/agent --bin-dir bin >"${stdout_file}" 2>"${stderr_file}")
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
  local fakebin="${case_dir}/fakebin"
  local home_dir="${case_dir}/home"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  mkdir -p "${stage_scripts_dir}/lib" "${fakebin}" "${home_dir}"
  cp scripts/tlh-install.mjs "${stage_scripts_dir}/tlh-install.mjs"
  cp scripts/lib/tlh-install-package-source.mjs "${stage_scripts_dir}/lib/tlh-install-package-source.mjs"
  cp scripts/lib/tlh-install-paths.mjs "${stage_scripts_dir}/lib/tlh-install-paths.mjs"
  cp scripts/lib/tlh-install-utils.mjs "${stage_scripts_dir}/lib/tlh-install-utils.mjs"
  cp scripts/lib/tlh-install-git.mjs "${stage_scripts_dir}/lib/tlh-install-git.mjs"
  cp scripts/lib/tlh-install-subagents.mjs "${stage_scripts_dir}/lib/tlh-install-subagents.mjs"
  cp scripts/lib/tlh-safe-profile-write.mjs "${stage_scripts_dir}/lib/tlh-safe-profile-write.mjs"
  cp scripts/lib/tlh-install-support-files.mjs "${stage_scripts_dir}/lib/tlh-install-support-files.mjs"
  cp scripts/lib/tlh-install-support-manifest.mjs "${stage_scripts_dir}/lib/tlh-install-support-manifest.mjs"
  cp scripts/lib/default-extensions.mjs "${stage_scripts_dir}/lib/default-extensions.mjs"

  cat >"${fakebin}/sh" <<'EOF_FAKE_STAGED_SH'
#!/bin/sh
exec /bin/sh "$@"
EOF_FAKE_STAGED_SH
  cat >"${fakebin}/npm" <<'EOF_FAKE_STAGED_NPM'
#!/bin/sh
printf 'fake npm should not run during dry-run\n' >&2
exit 98
EOF_FAKE_STAGED_NPM
  cat >"${fakebin}/git" <<'EOF_FAKE_STAGED_GIT'
#!/bin/sh
printf 'fake git should not run during dry-run\n' >&2
exit 98
EOF_FAKE_STAGED_GIT
  chmod +x "${fakebin}/sh" "${fakebin}/npm" "${fakebin}/git"
  make_fake_present_pi "${fakebin}"

  local stage_script
  stage_script="$(cd "${stage_scripts_dir}" >/dev/null 2>&1 && pwd -P)/tlh-install.mjs"
  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" PATH="${fakebin}:${PATH}" node "${stage_script}" --dry-run --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
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
  local fakebin="${case_dir}/fakebin"
  local home_dir="${case_dir}/home"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  mkdir -p "${case_dir}" "${fakebin}" "${home_dir}"

  cat >"${fakebin}/sh" <<'EOF_FAKE_LOCAL_SH'
#!/bin/sh
exec /bin/sh "$@"
EOF_FAKE_LOCAL_SH
  cat >"${fakebin}/npm" <<'EOF_FAKE_LOCAL_NPM'
#!/bin/sh
printf 'fake npm should not run during dry-run\n' >&2
exit 98
EOF_FAKE_LOCAL_NPM
  cat >"${fakebin}/git" <<'EOF_FAKE_LOCAL_GIT'
#!/bin/sh
printf 'fake git should not run during dry-run\n' >&2
exit 98
EOF_FAKE_LOCAL_GIT
  chmod +x "${fakebin}/sh" "${fakebin}/npm" "${fakebin}/git"
  make_fake_present_pi "${fakebin}"

  run_scrubbed_installer_env HOME="${home_dir}" PATH="${fakebin}:${PATH}" TLH_SKIP_GNOSIS_INSTALL=1 bash install.sh --dry-run --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
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

  : >"${stdout_file}"
  : >"${stderr_file}"
  (cd "${case_dir}" && run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 PATH="${fakebin}:${PATH}" bash -s -- --dry-run --no-settings --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  assert_absent "${agent_dir}"
  assert_absent "${bin_dir}"
  assert_contains "${combined_file}" "Would skip settings and keybinding defaults merge (--no-settings)."
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
  assert_contains "${combined_file}" "Start with: tlh"
  assert_not_contains "${combined_file}" "Start with: PI_CODING_AGENT_DIR="
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
  # literal '~/.pi/agent' is intentional; smoke test exercises the alias guard that rejects unexpanded tildes
  # shellcheck disable=SC2088
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
  # literal '~/.pi/agent' is intentional; smoke test exercises the alias guard that rejects unexpanded tildes
  # shellcheck disable=SC2088
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
