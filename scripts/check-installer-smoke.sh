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

run_scrubbed_installer_env() {
  local -a env_cmd=(env -u PI_CODING_AGENT_DIR)
  local name
  while IFS='=' read -r name _; do
    if [[ "${name}" == TLH_* ]]; then
      env_cmd+=(-u "${name}")
    fi
  done < <(env)
  "${env_cmd[@]}" "$@"
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

assert_pi_commands_isolated() {
  local file="$1"
  local agent_dir="$2"
  local bad_file="${file}.unisolated-pi"

  assert_contains "${file}" "PI_CODING_AGENT_DIR=${agent_dir}"
  : >"${bad_file}"
  grep -E '(^\+|^Would).*(^|[[:space:]])pi[[:space:]]+(install|update)([[:space:]]|$)' "${file}" \
    | grep -F -v -- "PI_CODING_AGENT_DIR=${agent_dir}" >"${bad_file}" || true
  if [[ -s "${bad_file}" ]]; then
    printf '%s\n' "---- unisolated pi commands in ${file} ----" >&2
    cat "${bad_file}" >&2 || true
    printf '%s\n' '---- end ----' >&2
    fail "dry-run output contained an unisolated pi command"
  fi
}

combine_output() {
  local stdout_file="$1"
  local stderr_file="$2"
  local combined_file="$3"
  cat "${stdout_file}" "${stderr_file}" >"${combined_file}"
}

stage1_support_manifest() {
  local no_settings="$1"
  if [[ "${no_settings}" == "true" ]]; then
    run_scrubbed_installer_env node scripts/tlh-install.mjs --no-settings --print-support-manifest
  else
    run_scrubbed_installer_env node scripts/tlh-install.mjs --print-support-manifest
  fi
}

copy_stage1_support_tree() {
  local dest="$1"
  local no_settings="$2"
  local variable requirement relative_path temp_path install_name

  mkdir -p "${dest}"
  while IFS='|' read -r variable requirement relative_path temp_path install_name; do
    [[ -n "${relative_path}" ]] || continue
    mkdir -p "${dest}/$(dirname "${relative_path}")"
    cp "${ROOT_DIR}/${relative_path}" "${dest}/${relative_path}"
  done < <(stage1_support_manifest "${no_settings}")
}

pack_archive_tree() {
  local source_parent="$1"
  local entry_name="$2"
  local archive_path="$3"
  tar -czf "${archive_path}" -C "${source_parent}" "${entry_name}"
}

run_install_query_smoke() {
  log "Running installer query smoke check..."
  local case_dir="${TMP_ROOT}/install-query"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${case_dir}"

  set +e
  (
    export TLH_AGENT_DIR="${case_dir}/poisoned-agent" PI_CODING_AGENT_DIR="${case_dir}/poisoned-pi-agent"
    run_scrubbed_installer_env node scripts/tlh-install-query.mjs normalize-path
  ) >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "normalize-path without --path unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "error: normalize-path requires --path"
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

make_fake_node_version() {
  local fakebin="$1"
  local version="$2"
  mkdir -p "${fakebin}"
  cat >"${fakebin}/node" <<EOF_FAKE_NODE
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\n' '${version}'
  exit 0
fi
printf 'fake node was invoked unexpectedly: %s\n' "\$*" >&2
exit 99
EOF_FAKE_NODE
  chmod +x "${fakebin}/node"
}

make_archive_copy_curl() {
  local fakebin="$1"
  mkdir -p "${fakebin}"
  cat >"${fakebin}/curl" <<'EOF_ARCHIVE_COPY_CURL'
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
if [[ -z "${url}" || -z "${out}" || -z "${FAKE_ARCHIVE_PATH:-}" ]]; then
  printf 'fake archive curl missing url, output, or archive path\n' >&2
  exit 2
fi
if [[ -n "${FAKE_ARCHIVE_URL:-}" && "${url}" != "${FAKE_ARCHIVE_URL}" ]]; then
  printf 'fake archive curl received unexpected url: %s\n' "${url}" >&2
  exit 2
fi
if [[ -n "${FAKE_CURL_LOG:-}" ]]; then
  printf '%s\n' "${url}" >>"${FAKE_CURL_LOG}"
fi
mkdir -p "$(dirname "${out}")"
cp "${FAKE_ARCHIVE_PATH}" "${out}"
EOF_ARCHIVE_COPY_CURL
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

make_fake_stage1_support_root() {
  local root="$1"
  mkdir -p "${root}/scripts"
  cat >"${root}/scripts/tlh-install.mjs" <<'EOF_FAKE_STAGE1'
#!/usr/bin/env node
console.log("BUG: fake local stage-1 was invoked");
EOF_FAKE_STAGE1
}

write_fake_release_stage1() {
  local path="$1"
  cat >"${path}" <<'EOF_FAKE_RELEASE_STAGE1'
#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(rootDir, "support-manifest.txt");
const sentinelPath = process.env.RELEASE_STAGE1_SENTINEL || "";

if (process.argv.includes("--print-support-manifest")) {
  process.stdout.write(readFileSync(manifestPath, "utf8"));
  process.exit(0);
}

if (sentinelPath) writeFileSync(sentinelPath, "invoked\n");
console.log(`TLH_UPDATE_TRACK=${process.env.TLH_UPDATE_TRACK || ""}`);
EOF_FAKE_RELEASE_STAGE1
  chmod +x "${path}"
}

run_static_checks() {
  log "Running installer static checks..."
  bash -n install.sh
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

run_stage1_dry_run_smoke() {
  log "Running stage-1 dry-run smoke check..."
  local case_dir="${TMP_ROOT}/stage1-dry-run"
  local agent_dir="${case_dir}/agent"
  local bin_dir="${case_dir}/bin"
  local fakebin="${case_dir}/fakebin"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local node_cmd
  node_cmd="$(command -v node)"
  mkdir -p "${fakebin}"
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

  run_scrubbed_installer_env PATH="${fakebin}" TLH_SKIP_GNOSIS_INSTALL=1 "${node_cmd}" scripts/tlh-install.mjs --dry-run --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
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
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local run_dir
  mkdir -p "${home_dir}" "${cwd_dir}"
  run_dir="$(cd "${cwd_dir}" >/dev/null 2>&1 && pwd -P)"

  (cd "${run_dir}" && \
    export PI_CODING_AGENT_DIR="${home_dir}/.pi/agent" TLH_AGENT_DIR="${home_dir}/.pi/agent" TLH_BIN_DIR="${home_dir}/.pi/agent" TLH_PACKAGE_SOURCE="~/poisoned-package" TLH_REPO="poisoned/repo" TLH_REF="poisoned-ref" TLH_UPDATE_TRACK="custom" && \
    run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" node "${ROOT_DIR}/scripts/tlh-install.mjs" --dry-run --agent-dir .pi/agent --bin-dir bin >"${stdout_file}" 2>"${stderr_file}")
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
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  mkdir -p "${stage_scripts_dir}/lib"
  cp scripts/tlh-install.mjs "${stage_scripts_dir}/tlh-install.mjs"
  cp scripts/tlh-install-query.mjs "${stage_scripts_dir}/tlh-install-query.mjs"
  cp scripts/lib/tlh-install-package-source.mjs "${stage_scripts_dir}/lib/tlh-install-package-source.mjs"
  cp scripts/lib/tlh-install-paths.mjs "${stage_scripts_dir}/lib/tlh-install-paths.mjs"
  cp scripts/lib/tlh-install-utils.mjs "${stage_scripts_dir}/lib/tlh-install-utils.mjs"
  cp scripts/lib/tlh-install-git.mjs "${stage_scripts_dir}/lib/tlh-install-git.mjs"
  cp scripts/lib/tlh-install-subagents.mjs "${stage_scripts_dir}/lib/tlh-install-subagents.mjs"
  cp scripts/lib/tlh-install-support-files.mjs "${stage_scripts_dir}/lib/tlh-install-support-files.mjs"
  cp scripts/lib/tlh-install-support-manifest.mjs "${stage_scripts_dir}/lib/tlh-install-support-manifest.mjs"

  local stage_script
  stage_script="$(cd "${stage_scripts_dir}" >/dev/null 2>&1 && pwd -P)/tlh-install.mjs"
  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 node "${stage_script}" --dry-run --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
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
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  mkdir -p "${case_dir}"

  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 bash install.sh --dry-run --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" >"${stdout_file}" 2>"${stderr_file}"
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
  local fakebin="${case_dir}/fakebin"
  local home_dir="${case_dir}/home"
  local archive_parent="${case_dir}/archive-parent"
  local archive_root="the-last-harness-no-arg-ref"
  local archive_path="${case_dir}/installer.tar.gz"
  local archive_url="https://codeload.github.com/diegopetrucci/the-last-harness/tar.gz/no-arg-ref"
  local curl_log="${case_dir}/curl.log"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local raw_base="https://example.invalid/no-arg-ref"
  mkdir -p "${case_dir}" "${home_dir}" "${archive_parent}/${archive_root}"
  make_archive_copy_curl "${fakebin}"
  copy_stage1_support_tree "${archive_parent}/${archive_root}" false
  stage1_support_manifest false >"${archive_parent}/${archive_root}/support-manifest.txt"
  cat >"${archive_parent}/${archive_root}/scripts/tlh-install.mjs" <<'EOF_FAKE_NO_ARG_STAGE1'
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.includes("--print-support-manifest")) {
  process.stdout.write(readFileSync(resolve(rootDir, "support-manifest.txt"), "utf8"));
  process.exit(0);
}

console.log(`argv_count=${process.argv.slice(2).length}`);
console.log(`SCRIPT_PATH=${process.argv[1] || ""}`);
console.log(`TLH_REF=${process.env.TLH_REF || ""}`);
console.log(`TLH_RAW_BASE=${process.env.TLH_RAW_BASE || ""}`);
console.log(`TLH_UPDATE_TRACK=${process.env.TLH_UPDATE_TRACK || ""}`);
EOF_FAKE_NO_ARG_STAGE1
  pack_archive_tree "${archive_parent}" "${archive_root}" "${archive_path}"

  (cd "${case_dir}" && run_scrubbed_installer_env HOME="${home_dir}" PATH="${fakebin}:${PATH}" FAKE_ARCHIVE_PATH="${archive_path}" FAKE_ARCHIVE_URL="${archive_url}" FAKE_CURL_LOG="${curl_log}" TLH_REF="no-arg-ref" TLH_RAW_BASE="${raw_base}" bash -s -- < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  local stage1_script_path=""
  stage1_script_path="$(grep '^SCRIPT_PATH=' "${combined_file}" | tail -n 1 | cut -d= -f2-)"
  if [[ -z "${stage1_script_path}" ]]; then
    fail "stdin no-argument smoke did not report extracted stage-1 path"
  fi

  assert_absent "${home_dir}/.the-last-harness"
  assert_absent "${home_dir}/.local"
  assert_contains "${combined_file}" "argv_count=0"
  assert_contains "${combined_file}" "TLH_REF=no-arg-ref"
  assert_contains "${combined_file}" "TLH_RAW_BASE=${raw_base}"
  assert_contains "${combined_file}" "TLH_UPDATE_TRACK="
  assert_contains "${curl_log}" "${archive_url}"
  assert_not_contains "${combined_file}" "unbound variable"
  assert_absent "${stage1_script_path}"

  : >"${stdout_file}"
  : >"${stderr_file}"
  : >"${curl_log}"

  (cd "${case_dir}" && run_scrubbed_installer_env HOME="${home_dir}" PATH="${fakebin}:${PATH}" FAKE_ARCHIVE_PATH="${archive_path}" FAKE_ARCHIVE_URL="${archive_url}" FAKE_CURL_LOG="${curl_log}" TLH_REF="no-arg-ref" TLH_RAW_BASE="${raw_base}" bash -s -- --verbose < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  stage1_script_path="$(grep '^SCRIPT_PATH=' "${combined_file}" | tail -n 1 | cut -d= -f2-)"
  if [[ -z "${stage1_script_path}" ]]; then
    fail "stdin verbose smoke did not report extracted stage-1 path"
  fi

  assert_contains "${combined_file}" "Downloading installer archive from ${archive_url}"
  assert_contains "${combined_file}" "argv_count=1"
  assert_contains "${combined_file}" "TLH_REF=no-arg-ref"
  assert_contains "${curl_log}" "${archive_url}"
  assert_absent "${stage1_script_path}"
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
  assert_contains "${combined_file}" "Would download installer archive from"
  assert_contains "${combined_file}" "Dry run only; no installer archive was downloaded."
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
  assert_contains "${combined_file}" "Start with: PI_CODING_AGENT_DIR=\"${relative_agent_dir}\" pi"
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
  assert_contains "${combined_file}" "Dry run only; no installer archive was downloaded."
  assert_not_contains "${combined_file}" "Wrapper path would be:"
  assert_not_contains "${combined_file}" "BUG: fake local stage-1 was invoked"
  assert_not_contains "${combined_file}" "fake curl was invoked"

  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
  (cd "${case_dir}" && run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" PATH="${fakebin}:${PATH}" bash -s -- --dry-run --agent-dir "~/.pi/agent" --bin-dir "${bin_dir}" < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "stdin dry-run normal Pi guard unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "refusing to place The Last Harness agent dir under normal Pi config root"
  assert_not_contains "${combined_file}" "Dry run only; no installer archive was downloaded."
  assert_not_contains "${combined_file}" "fake curl was invoked"
  assert_absent "${home_dir}/.pi"

  : >"${stdout_file}"
  : >"${stderr_file}"
  set +e
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
  local status=0
  mkdir -p "${case_dir}" "${home_dir}"
  make_failing_curl "${fakebin}"
  make_fake_node_version "${fakebin}" "v22.18.9"

  set +e
  (cd "${case_dir}" && run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" PATH="${fakebin}:${PATH}" bash -s -- --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "stage-0 old Node remote preflight unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "Node.js >= 22.19.0 is required (found v22.18.9). Install or upgrade Node.js, then rerun the installer."
  assert_not_contains "${combined_file}" "fake curl was invoked"
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
  assert_not_contains "${combined_file}" "Dry run only; no installer archive was downloaded."
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

run_missing_required_helper_preflight_smoke() {
  log "Running missing required helper preflight smoke check..."
  local case_dir="${TMP_ROOT}/missing-helper-preflight"
  local agent_dir="${case_dir}/agent"
  local bin_dir="${case_dir}/bin"
  local fakebin="${case_dir}/fakebin"
  local archive_parent="${case_dir}/archive-parent"
  local archive_root="the-last-harness-legacy-ref"
  local archive_path="${case_dir}/installer.tar.gz"
  local archive_url="https://codeload.github.com/diegopetrucci/the-last-harness/tar.gz/legacy-ref"
  local curl_log="${case_dir}/curl.log"
  local pi_sentinel="${case_dir}/pi-invoked"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${case_dir}"
  make_archive_copy_curl "${fakebin}"
  make_failing_pi "${fakebin}"
  copy_stage1_support_tree "${archive_parent}/${archive_root}" false
  rm -f "${archive_parent}/${archive_root}/scripts/tlh-wrapper.mjs" "${archive_parent}/${archive_root}/scripts/tlh-install-state.mjs"
  pack_archive_tree "${archive_parent}" "${archive_root}" "${archive_path}"

  set +e
  (cd "${case_dir}" && run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 PATH="${fakebin}:${PATH}" FAKE_ARCHIVE_PATH="${archive_path}" FAKE_ARCHIVE_URL="${archive_url}" FAKE_CURL_LOG="${curl_log}" PI_SENTINEL="${pi_sentinel}" TLH_REF="legacy-ref" TLH_RAW_BASE="https://example.invalid/legacy-ref" bash -s -- --agent-dir "${agent_dir}" --bin-dir "${bin_dir}" < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
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
  assert_contains "${curl_log}" "${archive_url}"
  assert_not_contains "${combined_file}" "fake pi was invoked"
  assert_absent "${agent_dir}"
  assert_absent "${bin_dir}"
  assert_absent "${pi_sentinel}"

  local no_wrapper_case_dir="${TMP_ROOT}/no-wrapper-preflight"
  local no_wrapper_agent_dir="${no_wrapper_case_dir}/agent"
  local no_wrapper_bin_dir="${no_wrapper_case_dir}/bin"
  local no_wrapper_fakebin="${no_wrapper_case_dir}/fakebin"
  local no_wrapper_archive_parent="${no_wrapper_case_dir}/archive-parent"
  local no_wrapper_archive_root="the-last-harness-no-wrapper-ref"
  local no_wrapper_archive_path="${no_wrapper_case_dir}/installer.tar.gz"
  local no_wrapper_archive_url="https://codeload.github.com/diegopetrucci/the-last-harness/tar.gz/no-wrapper-ref"
  local no_wrapper_curl_log="${no_wrapper_case_dir}/curl.log"
  local no_wrapper_pi_sentinel="${no_wrapper_case_dir}/pi-invoked"
  mkdir -p "${no_wrapper_case_dir}"
  make_archive_copy_curl "${no_wrapper_fakebin}"
  make_failing_pi "${no_wrapper_fakebin}"
  copy_stage1_support_tree "${no_wrapper_archive_parent}/${no_wrapper_archive_root}" false
  rm -f "${no_wrapper_archive_parent}/${no_wrapper_archive_root}/scripts/tlh-wrapper.mjs"
  pack_archive_tree "${no_wrapper_archive_parent}" "${no_wrapper_archive_root}" "${no_wrapper_archive_path}"
  : >"${stdout_file}"
  : >"${stderr_file}"

  set +e
  (cd "${no_wrapper_case_dir}" && run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 PATH="${no_wrapper_fakebin}:${PATH}" FAKE_ARCHIVE_PATH="${no_wrapper_archive_path}" FAKE_ARCHIVE_URL="${no_wrapper_archive_url}" FAKE_CURL_LOG="${no_wrapper_curl_log}" PI_SENTINEL="${no_wrapper_pi_sentinel}" TLH_REF="no-wrapper-ref" TLH_RAW_BASE="https://example.invalid/no-wrapper-ref" bash -s -- --agent-dir "${no_wrapper_agent_dir}" --bin-dir "${no_wrapper_bin_dir}" --no-wrapper < "${ROOT_DIR}/install.sh") >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"

  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "missing wrapper --no-wrapper preflight smoke unexpectedly succeeded"
  fi
  assert_contains "${no_wrapper_curl_log}" "${no_wrapper_archive_url}"
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
  log "Running release installer defaults smoke check..."
  local case_dir="${TMP_ROOT}/release-pinning"
  local dist_dir="${case_dir}/dist"
  local home_dir="${case_dir}/home"
  local fakebin="${case_dir}/fakebin"
  local archive_parent="${case_dir}/archive-parent"
  local archive_path="${case_dir}/the-last-harness-9.9.9.tgz"
  local incomplete_archive_parent="${case_dir}/archive-parent-incomplete"
  local incomplete_archive_path="${case_dir}/the-last-harness-9.9.9-incomplete.tgz"
  local archive_url="https://github.com/diegopetrucci/the-last-harness/releases/download/v9.9.9/the-last-harness-9.9.9.tgz"
  local curl_log="${case_dir}/curl.log"
  local stage1_sentinel="${case_dir}/stage1-invoked"
  local tag="v9.9.9"
  local stdout_file="${case_dir}/stdout.log"
  local stderr_file="${case_dir}/stderr.log"
  local combined_file="${case_dir}/combined.log"
  local status=0
  mkdir -p "${dist_dir}" "${home_dir}" "${archive_parent}/package"
  make_archive_copy_curl "${fakebin}"

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

  copy_stage1_support_tree "${archive_parent}/package" false
  stage1_support_manifest false >"${archive_parent}/package/support-manifest.txt"
  write_fake_release_stage1 "${archive_parent}/package/scripts/tlh-install.mjs"
  pack_archive_tree "${archive_parent}" package "${archive_path}"

  mkdir -p "${incomplete_archive_parent}"
  cp -R "${archive_parent}/package" "${incomplete_archive_parent}/package"
  rm -f "${incomplete_archive_parent}/package/config/default-extensions.json"
  pack_archive_tree "${incomplete_archive_parent}" package "${incomplete_archive_path}"

  : >"${stdout_file}"
  : >"${stderr_file}"
  : >"${curl_log}"
  rm -f "${stage1_sentinel}"
  set +e
  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" PATH="${fakebin}:${PATH}" FAKE_ARCHIVE_PATH="${incomplete_archive_path}" FAKE_ARCHIVE_URL="${archive_url}" FAKE_CURL_LOG="${curl_log}" RELEASE_STAGE1_SENTINEL="${stage1_sentinel}" bash -s -- --agent-dir "${case_dir}/agent" --bin-dir "${case_dir}/bin" < "${dist_dir}/install.sh" >"${stdout_file}" 2>"${stderr_file}"
  status=$?
  set -e
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  if [[ "${status}" -eq 0 ]]; then
    cat "${combined_file}" >&2
    fail "incomplete release archive smoke unexpectedly succeeded"
  fi
  assert_contains "${combined_file}" "installer archive for ref ${tag} did not contain the required stage-1 support files"
  assert_contains "${curl_log}" "${archive_url}"
  assert_absent "${stage1_sentinel}"
  assert_not_contains "${combined_file}" "TLH_UPDATE_TRACK="

  : >"${stdout_file}"
  : >"${stderr_file}"
  : >"${curl_log}"
  rm -f "${stage1_sentinel}"
  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" PATH="${fakebin}:${PATH}" FAKE_ARCHIVE_PATH="${archive_path}" FAKE_ARCHIVE_URL="${archive_url}" FAKE_CURL_LOG="${curl_log}" RELEASE_STAGE1_SENTINEL="${stage1_sentinel}" bash -s -- --agent-dir "${case_dir}/agent" --bin-dir "${case_dir}/bin" < "${dist_dir}/install.sh" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "TLH_UPDATE_TRACK=latest-release"
  assert_contains "${curl_log}" "${archive_url}"
  if [[ ! -f "${stage1_sentinel}" ]]; then
    cat "${combined_file}" >&2
    fail "release archive smoke did not invoke stage-1 installer"
  fi

  : >"${stdout_file}"
  : >"${stderr_file}"
  : >"${curl_log}"
  rm -f "${stage1_sentinel}"
  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" PATH="${fakebin}:${PATH}" FAKE_ARCHIVE_PATH="${archive_path}" FAKE_ARCHIVE_URL="${archive_url}" FAKE_CURL_LOG="${curl_log}" RELEASE_STAGE1_SENTINEL="${stage1_sentinel}" TLH_UPDATE_TRACK="pinned-tag" bash -s -- --agent-dir "${case_dir}/agent" --bin-dir "${case_dir}/bin" < "${dist_dir}/install.sh" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "TLH_UPDATE_TRACK=pinned-tag"
  assert_contains "${curl_log}" "${archive_url}"
  if [[ ! -f "${stage1_sentinel}" ]]; then
    cat "${combined_file}" >&2
    fail "release archive pinned-tag smoke did not invoke stage-1 installer"
  fi

  : >"${stdout_file}"
  : >"${stderr_file}"
  : >"${curl_log}"
  rm -f "${stage1_sentinel}"
  run_scrubbed_installer_env TLH_SKIP_GNOSIS_INSTALL=1 HOME="${home_dir}" PATH="${fakebin}:${PATH}" FAKE_ARCHIVE_PATH="${archive_path}" FAKE_ARCHIVE_URL="${archive_url}" FAKE_CURL_LOG="${curl_log}" RELEASE_STAGE1_SENTINEL="${stage1_sentinel}" bash -s -- --agent-dir "${case_dir}/agent" --bin-dir "${case_dir}/bin" --track ref < "${dist_dir}/install.sh" >"${stdout_file}" 2>"${stderr_file}"
  combine_output "${stdout_file}" "${stderr_file}" "${combined_file}"
  assert_contains "${combined_file}" "TLH_UPDATE_TRACK=ref"
  assert_contains "${curl_log}" "${archive_url}"
  if [[ ! -f "${stage1_sentinel}" ]]; then
    cat "${combined_file}" >&2
    fail "release archive ref-track smoke did not invoke stage-1 installer"
  fi
}

run_static_checks
run_install_query_smoke
run_stage1_dry_run_smoke
run_stage1_relative_path_canonicalization_smoke
run_stage1_staged_cwd_isolation_smoke
run_local_dry_run_smoke
run_stdin_no_arg_smoke
run_stdin_dry_run_smoke
run_stage0_node_preflight_smoke
run_stage0_alias_guard_smoke
run_stage0_validation_precedes_local_support_smoke
run_normal_pi_guard_smoke
run_gnosis_managed_normal_pi_guard_smoke
run_tickets_managed_normal_pi_guard_smoke
run_missing_required_helper_preflight_smoke
run_wrapper_install_state_normal_pi_guard_smoke
run_release_pinning_smoke

log "Installer smoke checks passed."
