#!/usr/bin/env bash

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
