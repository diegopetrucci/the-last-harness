#!/usr/bin/env bash

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
  node --check scripts/lib/tlh-profile-writes.mjs
  node --check scripts/release-notes.mjs
  node -e 'JSON.parse(require("node:fs").readFileSync("config/librarian.defaults.json", "utf8"))'
  check_extension_load_syntax
}
