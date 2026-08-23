#!/usr/bin/env bash

# ── piInstalledByTlh smoke tests ───────────────────────────────────────────────

run_install_state_pi_field_smoke() {
  log "Running install-state piInstalledByTlh field smoke check..."
  local case_dir="${TMP_ROOT}/install-state-pi-field"
  local agent_dir="${case_dir}/agent"
  local bin_dir="${case_dir}/bin"
  local state_file="${agent_dir}/tlh/install-state.json"
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
  mkdir -p "${absent_fakebin}" "${absent_dir}/home"
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

  run_scrubbed_installer_env HOME="${absent_dir}/home" PATH="${absent_fakebin}" TLH_SKIP_GNOSIS_INSTALL=1 "${node_cmd}" scripts/tlh-install.mjs --dry-run --agent-dir "${absent_agent}" --bin-dir "${absent_bin}" >"${absent_stdout}" 2>"${absent_stderr}"
  combine_output "${absent_stdout}" "${absent_stderr}" "${absent_combined}"
  assert_contains "${absent_combined}" "(piInstalledByTlh: true)"

  # ── pi present: private runtime binary already exists → piInstalledByTlh: false ──
  # In the private runtime model, TLH ignores pi on PATH and always uses its own
  # runtime at <agentDir>/../runtime/bin/pi. Seeding that path simulates a run where
  # the runtime is already there; the installer skips install → installed: false.
  # With no prior state file, piInstalledByTlhPreference is undefined, so
  # config.piInstalledByTlh falls back to false.
  local present_dir="${case_dir}/pi-present"
  local present_agent="${present_dir}/agent"
  local present_bin="${present_dir}/bin"
  local present_fakebin="${present_dir}/fakebin"
  local present_runtime_bin="${present_dir}/runtime/bin"
  local present_stdout="${present_dir}/stdout.log"
  local present_stderr="${present_dir}/stderr.log"
  local present_combined="${present_dir}/combined.log"
  mkdir -p "${present_fakebin}" "${present_dir}/home" "${present_runtime_bin}"
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
  # Write a valid ownership marker for the pre-seeded runtime so the installer's
  # assertRuntimePrefixOwnedOrEmpty gate passes and the reuse path runs.
  # runtimeAbsPath uses pwd -P so macOS /var -> /private/var matches Node.js realpathSync.
  write_tlh_runtime_marker "${present_dir}/runtime" created
  # Seed a valid private runtime pi (pinned version) at the expected location.
  cat >"${present_runtime_bin}/pi" <<'EOF_PRESENT_RUNTIME_PI'
#!/bin/sh
if [ "${1:-}" = "--version" ]; then printf '0.84.2\n'; exit 0; fi
printf 'fake private runtime pi invoked unexpectedly\n' >&2; exit 98
EOF_PRESENT_RUNTIME_PI
  chmod +x "${present_runtime_bin}/pi"

  run_scrubbed_installer_env HOME="${present_dir}/home" PATH="${present_fakebin}" TLH_SKIP_GNOSIS_INSTALL=1 "${node_cmd}" scripts/tlh-install.mjs --dry-run --agent-dir "${present_agent}" --bin-dir "${present_bin}" >"${present_stdout}" 2>"${present_stderr}"
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
  local fakebin="${case_dir}/fakebin"
  local home_dir="${case_dir}/home"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${case_dir}" "${fakebin}" "${home_dir}"

  cat >"${fakebin}/sh" <<'EOF_FAKE_PASSTHROUGH_SH'
#!/bin/sh
exec /bin/sh "$@"
EOF_FAKE_PASSTHROUGH_SH
  cat >"${fakebin}/npm" <<'EOF_FAKE_PASSTHROUGH_NPM'
#!/bin/sh
printf 'fake npm should not run during dry-run\n' >&2
exit 98
EOF_FAKE_PASSTHROUGH_NPM
  cat >"${fakebin}/git" <<'EOF_FAKE_PASSTHROUGH_GIT'
#!/bin/sh
printf 'fake git should not run during dry-run\n' >&2
exit 98
EOF_FAKE_PASSTHROUGH_GIT
  chmod +x "${fakebin}/sh" "${fakebin}/npm" "${fakebin}/git"
  make_fake_present_pi "${fakebin}"

  # ── space-separated form: stage-0 accepts, stage-1 validates → exit 0 ─────
  run_scrubbed_installer_env HOME="${home_dir}" PATH="${fakebin}:${PATH}" TLH_SKIP_GNOSIS_INSTALL=1 bash install.sh \
    --pi-installed-by-tlh true \
    --dry-run \
    --agent-dir "${case_dir}/space/agent" \
    --bin-dir "${case_dir}/space/bin" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_not_contains "${combined_file}" "unknown option"

  # ── equals form: stage-0 accepts, stage-1 validates → exit 0 ──────────────
  : >"${stdout_file}"
  : >"${stderr_file}"
  run_scrubbed_installer_env HOME="${home_dir}" PATH="${fakebin}:${PATH}" TLH_SKIP_GNOSIS_INSTALL=1 bash install.sh \
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
  run_scrubbed_installer_env HOME="${home_dir}" PATH="${fakebin}:${PATH}" TLH_SKIP_GNOSIS_INSTALL=1 bash install.sh \
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
