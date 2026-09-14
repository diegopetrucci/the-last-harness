#!/usr/bin/env bash

make_node_options_compatibility_wrapper() {
  local fakebin="$1"
  local real_node
  real_node="$(command -v node)"
  cat >"${fakebin}/node" <<EOF_NODE_OPTIONS_WRAPPER
#!/usr/bin/env bash
if [[ "\${1:-}" == "--input-type=commonjs" && "\${NODE_OPTIONS:-}" == "--input-type=module" ]]; then
  printf 'ambient_node_options_verifier=commonjs\n'
fi
if [[ "\${1:-}" == "--input-type=commonjs" ]]; then
  exec "${real_node}" "\$@"
fi
exec env NODE_OPTIONS= "${real_node}" "\$@"
EOF_NODE_OPTIONS_WRAPPER
  chmod +x "${fakebin}/node"
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

  node scripts/generate-release-installer.mjs --tag "${tag}" --output "${dist_dir}/install.sh"
  chmod +x "${dist_dir}/install.sh"
  bash -n "${dist_dir}/install.sh"
  assert_contains "${dist_dir}/install.sh" "REF=\"\${TLH_REF:-${tag}}\""
  assert_contains "${dist_dir}/install.sh" "TLH_RELEASE_INTEGRITY_REPO=\"diegopetrucci/the-last-harness\""
  assert_contains "${dist_dir}/install.sh" "TLH_RELEASE_INTEGRITY_REF=\"${tag}\""
  assert_contains "${dist_dir}/install.sh" "agents/subagents/developer.md|"
  # single-quoted strings below are literal content assertions on install.sh text, not bash expansions
  # shellcheck disable=SC2016
  assert_contains "${dist_dir}/install.sh" 'UPDATE_TRACK_INPUT="${TLH_UPDATE_TRACK:-latest-release}"'
  # shellcheck disable=SC2016
  assert_not_contains "${dist_dir}/install.sh" 'REF="${TLH_REF:-main}"'
  # shellcheck disable=SC2016
  assert_not_contains "${dist_dir}/install.sh" 'UPDATE_TRACK_INPUT="${TLH_UPDATE_TRACK:-}"'

  local manifest_file="${case_dir}/stage0-manifest.txt"
  local _ relative_path
  extract_stage0_support_manifest false >"${manifest_file}"
  while IFS='|' read -r _ relative_path; do
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

run_release_integrity_asset_case() {
  local label="$1"
  local support_root="$2"
  local asset_path="$3"
  local raw_base="$4"
  local expected_status="$5"
  local ref_override="$6"
  local raw_base_override="$7"
  shift 7

  local case_dir="${TMP_ROOT}/release-integrity"
  local home_dir="${case_dir}/home-${label}"
  local stdout_file="${case_dir}/${label}.stdout.log"
  local stderr_file="${case_dir}/${label}.stderr.log"
  local combined_file="${case_dir}/${label}.combined.log"
  local agent_dir="${case_dir}/agent-${label}"
  local bin_dir="${case_dir}/bin-${label}"
  local status
  local -a env_args=(
    "TLH_SKIP_GNOSIS_INSTALL=1"
    "HOME=${home_dir}"
    "FAKE_RAW_BASE=${raw_base}"
    "FAKE_SUPPORT_ROOT=${support_root}"
    "PATH=${RELEASE_INTEGRITY_FAKEBIN}:${PATH}"
  )
  if [[ -n "${RELEASE_INTEGRITY_NODE_OPTIONS:-}" ]]; then
    env_args+=("NODE_OPTIONS=${RELEASE_INTEGRITY_NODE_OPTIONS}")
  fi
  if [[ -n "${ref_override}" ]]; then
    env_args+=("TLH_REF=${ref_override}")
  fi
  if [[ -n "${raw_base_override}" ]]; then
    env_args+=("TLH_RAW_BASE=${raw_base_override}")
  fi

  : >"${stdout_file}"
  : >"${stderr_file}"
  if run_scrubbed_installer_env "${env_args[@]}" bash "${asset_path}" \
    --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" "$@" >"${stdout_file}" 2>"${stderr_file}"; then
    status=0
  else
    status=$?
  fi
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  if [[ "${status}" != "${expected_status}" ]]; then
    cat "${combined_file}" >&2 || true
    fail "release integrity smoke case ${label} exited ${status}, expected ${expected_status}"
  fi
  printf '%s\n' "${combined_file}"
}

run_release_integrity_smoke() {
  log "Running release installer integrity smoke check..."
  local case_dir="${TMP_ROOT}/release-integrity"
  local release_source_root="${case_dir}/release-source"
  local asset_path="${case_dir}/install.sh"
  local tag="v9.9.9"
  local official_base="https://raw.githubusercontent.com/diegopetrucci/the-last-harness/${tag}"
  local custom_base="https://raw.githubusercontent.com/diegopetrucci/the-last-harness/custom-ref"
  local custom_ref_root="${case_dir}/custom-ref-support"
  local clean_root="${release_source_root}"
  local optional_missing_root="${case_dir}/optional-missing"
  local optional_tamper_root="${case_dir}/optional-tamper"
  local required_tamper_root="${case_dir}/required-tamper"
  local explicit_cli_tamper_root="${case_dir}/explicit-cli-tamper"
  local explicit_env_tamper_root="${case_dir}/explicit-env-tamper"
  local duplicate_root="${case_dir}/duplicate-manifest"
  local incomplete_root="${case_dir}/incomplete-manifest"
  local unsafe_root="${case_dir}/unsafe-manifest"
  local symlink_root="${case_dir}/symlink-source"
  local target_manifest_root="${case_dir}/target-manifest-boundary"
  local output_file
  mkdir -p "${case_dir}" "${release_source_root}"
  RELEASE_INTEGRITY_FAKEBIN="${case_dir}/fakebin"
  make_support_copy_curl "${RELEASE_INTEGRITY_FAKEBIN}"
  make_fake_remote_stage1_support_root "${release_source_root}"

  node scripts/generate-release-installer.mjs \
    --tag "${tag}" \
    --root "${release_source_root}" \
    --output "${asset_path}"
  chmod +x "${asset_path}"
  bash -n "${asset_path}"
  assert_contains "${asset_path}" "TLH_RELEASE_INTEGRITY_REF=\"${tag}\""
  assert_contains "${asset_path}" "agents/subagents/developer.md|"

  cp -R "${release_source_root}" "${target_manifest_root}"
  TARGET_SUPPORT_MANIFEST="${target_manifest_root}/scripts/lib/tlh-install-support-manifest.mjs" node <<'NODE_RELEASE_TARGET_BOUNDARY'
const fs = require('node:fs');
const path = process.env.TARGET_SUPPORT_MANIFEST;
const source = fs.readFileSync(path, 'utf8');
const row = '        requirement: REQUIRED,\n        relativePath: "scripts/tlh-install.mjs",';
if (source.split(row).length - 1 !== 1) throw new Error(`missing expected target row: ${row}`);
fs.writeFileSync(path, source.replace(row, row.replace('REQUIRED', 'OPTIONAL')), 'utf8');
NODE_RELEASE_TARGET_BOUNDARY
  if node scripts/generate-release-installer.mjs --tag "${tag}" --root "${target_manifest_root}" --output "${case_dir}/target-boundary.sh" >"${case_dir}/target-boundary.log" 2>&1; then
    fail "release generator used the invoking checkout instead of the --root target manifest"
  fi
  assert_contains "${case_dir}/target-boundary.log" "incomplete or out of sync"

  output_file="$(run_release_integrity_asset_case clean "${clean_root}" "${asset_path}" "${official_base}" 0 "" "")"
  assert_contains "${output_file}" "fake_stage1=ok"
  assert_contains "${output_file}" "optional_update_present=true"
  assert_contains "${output_file}" "developer_prompt_present=true"
  assert_not_contains "${output_file}" "integrity not enforced"
  assert_not_contains "${output_file}" "Refreshing installer"

  make_node_options_compatibility_wrapper "${RELEASE_INTEGRITY_FAKEBIN}"
  RELEASE_INTEGRITY_NODE_OPTIONS="--input-type=module"
  output_file="$(run_release_integrity_asset_case ambient-node-options "${clean_root}" "${asset_path}" "${official_base}" 0 "" "")"
  unset RELEASE_INTEGRITY_NODE_OPTIONS
  rm -f "${RELEASE_INTEGRITY_FAKEBIN}/node"
  assert_contains "${output_file}" "ambient_node_options_verifier=commonjs"
  assert_contains "${output_file}" "fake_stage1=ok"
  assert_contains "${output_file}" "optional_update_present=true"
  assert_not_contains "${output_file}" "integrity not enforced"
  assert_not_contains "${output_file}" "error:"

  output_file="$(run_release_integrity_asset_case no-settings "${clean_root}" "${asset_path}" "${official_base}" 0 "" "" --no-settings)"
  assert_contains "${output_file}" "fake_stage1=ok"
  assert_contains "${output_file}" "developer_prompt_present=false"
  assert_not_contains "${output_file}" "integrity not enforced"

  output_file="$(run_release_integrity_asset_case explicit-cli "${clean_root}" "${asset_path}" "${official_base}" 0 "" "" --ref "${tag}")"
  assert_contains "${output_file}" "fake_stage1=ok"
  assert_contains "${output_file}" "developer_prompt_present=true"
  assert_not_contains "${output_file}" "integrity not enforced"

  output_file="$(run_release_integrity_asset_case explicit-env "${clean_root}" "${asset_path}" "${official_base}" 0 "${tag}" "")"
  assert_contains "${output_file}" "fake_stage1=ok"
  assert_contains "${output_file}" "developer_prompt_present=true"
  assert_not_contains "${output_file}" "integrity not enforced"

  cp -R "${release_source_root}" "${explicit_cli_tamper_root}"
  printf '\ntampered explicit-cli support\n' >>"${explicit_cli_tamper_root}/scripts/tlh-install.mjs"
  output_file="$(run_release_integrity_asset_case explicit-cli-tamper "${explicit_cli_tamper_root}" "${asset_path}" "${official_base}" 1 "" "" --ref "${tag}")"
  assert_contains "${output_file}" "required installer support file failed SHA-256 integrity check and was removed: scripts/tlh-install.mjs"
  assert_not_contains "${output_file}" "fake_stage1=ok"

  cp -R "${release_source_root}" "${explicit_env_tamper_root}"
  printf '\ntampered explicit-env support\n' >>"${explicit_env_tamper_root}/scripts/tlh-install.mjs"
  output_file="$(run_release_integrity_asset_case explicit-env-tamper "${explicit_env_tamper_root}" "${asset_path}" "${official_base}" 1 "${tag}" "")"
  assert_contains "${output_file}" "required installer support file failed SHA-256 integrity check and was removed: scripts/tlh-install.mjs"
  assert_not_contains "${output_file}" "fake_stage1=ok"

  cp -R "${release_source_root}" "${optional_missing_root}"
  rm -f "${optional_missing_root}/scripts/tlh-update.mjs"
  output_file="$(run_release_integrity_asset_case optional-missing "${optional_missing_root}" "${asset_path}" "${official_base}" 0 "" "")"
  assert_contains "${output_file}" "tlh update support script not found"
  assert_contains "${output_file}" "optional_update_present=false"
  assert_not_contains "${output_file}" "integrity not enforced"

  cp -R "${release_source_root}" "${optional_tamper_root}"
  printf '\ntampered optional support\n' >>"${optional_tamper_root}/scripts/tlh-update.mjs"
  printf '\ntampered bundled prompt\n' >>"${optional_tamper_root}/agents/subagents/developer.md"
  output_file="$(run_release_integrity_asset_case optional-tamper "${optional_tamper_root}" "${asset_path}" "${official_base}" 0 "" "")"
  assert_contains "${output_file}" "failed SHA-256 integrity check and was removed: scripts/tlh-update.mjs"
  assert_contains "${output_file}" "failed SHA-256 integrity check and was removed: agents/subagents/developer.md"
  assert_contains "${output_file}" "optional_update_present=false"
  assert_contains "${output_file}" "developer_prompt_present=false"

  cp -R "${release_source_root}" "${required_tamper_root}"
  printf '\ntampered required support\n' >>"${required_tamper_root}/scripts/tlh-install.mjs"
  output_file="$(run_release_integrity_asset_case required-tamper "${required_tamper_root}" "${asset_path}" "${official_base}" 1 "" "")"
  assert_contains "${output_file}" "required installer support file failed SHA-256 integrity check and was removed: scripts/tlh-install.mjs"
  assert_not_contains "${output_file}" "fake_stage1=ok"

  cp -R "${release_source_root}" "${custom_ref_root}"
  printf '\nconsole.log("custom stage1 modified=true");\n' >>"${custom_ref_root}/scripts/tlh-install.mjs"
  output_file="$(run_release_integrity_asset_case custom-ref "${custom_ref_root}" "${asset_path}" "${custom_base}" 0 "" "" --ref custom-ref)"
  assert_contains "${output_file}" "integrity not enforced for ref custom-ref"
  assert_contains "${output_file}" "Refreshing installer"
  assert_contains "${output_file}" "custom stage1 modified=true"
  assert_contains "${output_file}" "fake_stage1=ok"
  assert_not_contains "${output_file}" "failed SHA-256 integrity check"

  output_file="$(run_release_integrity_asset_case custom-base "${clean_root}" "${asset_path}" "${official_base}" 0 "" "${official_base}")"
  assert_contains "${output_file}" "integrity not enforced for ref ${tag}"
  assert_contains "${output_file}" "fake_stage1=ok"
  assert_not_contains "${output_file}" "failed SHA-256 integrity check"

  cp -R "${release_source_root}" "${duplicate_root}"
  write_stage0_manifest_variant "${duplicate_root}/install.sh" "required|scripts/tlh-install.mjs"
  if node scripts/generate-release-installer.mjs --tag "${tag}" --root "${duplicate_root}" --output "${case_dir}/duplicate.sh" >"${case_dir}/duplicate.log" 2>&1; then
    fail "release generator accepted a duplicate support path"
  fi
  assert_contains "${case_dir}/duplicate.log" "Duplicate stage-0 support manifest path"

  cp -R "${release_source_root}" "${incomplete_root}"
  INCOMPLETE_INSTALL="${incomplete_root}/install.sh" node <<'NODE_RELEASE_INCOMPLETE'
const fs = require('node:fs');
const path = process.env.INCOMPLETE_INSTALL;
const source = fs.readFileSync(path, 'utf8');
const row = 'required|config/settings.defaults.json';
if (source.split(row).length - 1 !== 1) throw new Error(`missing expected source row: ${row}`);
fs.writeFileSync(path, source.replace(`${row}\n`, ''), 'utf8');
NODE_RELEASE_INCOMPLETE
  if node scripts/generate-release-installer.mjs --tag "${tag}" --root "${incomplete_root}" --output "${case_dir}/incomplete.sh" >"${case_dir}/incomplete.log" 2>&1; then
    fail "release generator accepted an incomplete support path inventory"
  fi
  assert_contains "${case_dir}/incomplete.log" "incomplete or out of sync"

  cp -R "${release_source_root}" "${unsafe_root}"
  write_stage0_manifest_variant "${unsafe_root}/install.sh" "required|../unsafe-support.mjs"
  if node scripts/generate-release-installer.mjs --tag "${tag}" --root "${unsafe_root}" --output "${case_dir}/unsafe.sh" >"${case_dir}/unsafe.log" 2>&1; then
    fail "release generator accepted an unsafe support path"
  fi
  assert_contains "${case_dir}/unsafe.log" "Unsafe release support stage-0 manifest path"

  cp -R "${release_source_root}" "${symlink_root}"
  rm -f "${symlink_root}/scripts/tlh-update.mjs"
  ln -s "tlh-install.mjs" "${symlink_root}/scripts/tlh-update.mjs"
  if node scripts/generate-release-installer.mjs --tag "${tag}" --root "${symlink_root}" --output "${case_dir}/symlink.sh" >"${case_dir}/symlink.log" 2>&1; then
    fail "release generator accepted a symlinked support file"
  fi
  assert_contains "${case_dir}/symlink.log" "regular checkout file"
}

# ── piInstalledByTlh smoke tests ───────────────────────────────────────────────
