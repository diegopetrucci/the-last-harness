#!/usr/bin/env bash

sanitize_smoke_path() {
  # npm run scripts prepend repo-local node_modules/.bin, which can leave validation
  # using a stale upstream pi runtime after package.json bumps. Strip only the
  # repo-local shim so smoke checks exercise the ambient/global runtime unless a
  # test intentionally overrides PATH.
  if [[ -z "${PATH:-}" ]]; then
    return 0
  fi

  IFS=':' read -r -a _tlh_smoke_path_entries <<<"${PATH}"
  local -a _tlh_smoke_sanitized_path=()
  local _tlh_smoke_path_entry
  for _tlh_smoke_path_entry in "${_tlh_smoke_path_entries[@]}"; do
    if [[ "${_tlh_smoke_path_entry}" == "${ROOT_DIR}/node_modules/.bin" ]]; then
      continue
    fi
    _tlh_smoke_sanitized_path+=("${_tlh_smoke_path_entry}")
  done

  if [[ "${#_tlh_smoke_sanitized_path[@]}" -gt 0 ]]; then
    PATH="$(IFS=:; printf '%s' "${_tlh_smoke_sanitized_path[*]}")"
    export PATH
  fi
}

cleanup() {
  rm -rf "${TMP_ROOT}"
  if [[ "${#EXTRA_CLEANUP_PATHS[@]}" -gt 0 ]]; then
    rm -rf "${EXTRA_CLEANUP_PATHS[@]}"
  fi
}

installer_smoke_setup() {
  sanitize_smoke_path
  TMP_ROOT="$(mktemp -d)"
  EXTRA_CLEANUP_PATHS=()
  trap cleanup EXIT
}

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
  if [[ -e "${path}" || -L "${path}" ]]; then
    fail "expected path to be absent: ${path}"
  fi
}

assert_present() {
  local path="$1"
  if [[ ! -e "${path}" && ! -L "${path}" ]]; then
    fail "expected path to be present: ${path}"
  fi
}

assert_under_tmp_root() {
  local path="$1"
  case "${path}" in
    "${TMP_ROOT}" | "${TMP_ROOT}"/*) ;;
    *) fail "unsafe test path outside TMP_ROOT: ${path}" ;;
  esac
}

assert_safe_uninstall_smoke_paths() {
  local agent_dir="$1"
  local bin_dir="$2"

  assert_under_tmp_root "${agent_dir}"
  assert_under_tmp_root "${bin_dir}"
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

write_tlh_install_state() {
  local agent_dir="$1"
  local pi_installed_by_tlh="${2:-false}"

  mkdir -p "${agent_dir}/tlh"
  cat >"${agent_dir}/tlh/install-state.json" <<EOF_INSTALL_STATE
{
  "schemaVersion": 1,
  "repo": "diegopetrucci/the-last-harness",
  "piInstalledByTlh": ${pi_installed_by_tlh}
}
EOF_INSTALL_STATE
}

write_managed_wrapper() {
  local wrapper_path="$1"

  mkdir -p "$(dirname "${wrapper_path}")"
  cat >"${wrapper_path}" <<'EOF_MANAGED_WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
# Managed by The Last Harness installer
EOF_MANAGED_WRAPPER
  chmod +x "${wrapper_path}"
}

write_tlh_pi_runtime() {
  # Seed the TLH pi runtime layout produced by:
  #   npm install -g --ignore-scripts --prefix <runtime_dir> @earendil-works/pi-coding-agent
  # Presence of both runtime_dir/bin/pi and
  # runtime_dir/lib/node_modules/@earendil-works/pi-coding-agent is the base
  # ownership/layout predicate checked by the uninstaller.
  local runtime_dir="$1"
  mkdir -p "${runtime_dir}/bin" "${runtime_dir}/lib/node_modules/@earendil-works/pi-coding-agent"
  printf '#!/bin/sh\n' >"${runtime_dir}/bin/pi"
  chmod +x "${runtime_dir}/bin/pi"
}

write_tlh_runtime_marker() {
  local runtime_dir="$1"
  local origin="$2"
  local marker_abs

  marker_abs="$(cd "${runtime_dir}" >/dev/null 2>&1 && pwd -P)"
  printf '{"schemaVersion":1,"packageName":"@earendil-works/pi-coding-agent","runtimeAbsPath":"%s","origin":"%s"}' \
    "${marker_abs}" "${origin}" >"${runtime_dir}/.tlh-runtime-owned"
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

extract_stage0_support_manifest() {
  local no_settings="$1"
  node - "${no_settings}" <<'NODE_STAGE0_MANIFEST'
const fs = require('node:fs');

const noSettings = process.argv[2] === 'true';
const source = fs.readFileSync('install.sh', 'utf8');

function readHeredoc(label) {
  const start = `cat <<'${label}'`;
  const startIndex = source.indexOf(start);
  if (startIndex === -1) throw new Error(`missing stage-0 support manifest heredoc: ${label}`);
  const bodyStart = source.indexOf('\n', startIndex);
  if (bodyStart === -1) throw new Error(`malformed stage-0 support manifest heredoc: ${label}`);
  const endIndex = source.indexOf(`\n${label}`, bodyStart + 1);
  if (endIndex === -1) throw new Error(`unterminated stage-0 support manifest heredoc: ${label}`);
  return source.slice(bodyStart + 1, endIndex).split(/\r?\n/).filter(Boolean);
}

const lines = readHeredoc('EOF_SUPPORT_FILES');
if (!noSettings) lines.push(...readHeredoc('EOF_SETTINGS_SUPPORT_FILES'));
process.stdout.write(`${lines.join('\n')}\n`);
NODE_STAGE0_MANIFEST
}

stage1_support_manifest_projection() {
  local no_settings="$1"
  if [[ "${no_settings}" == "true" ]]; then
    run_scrubbed_installer_env node scripts/tlh-install.mjs --no-settings --print-support-manifest
  else
    run_scrubbed_installer_env node scripts/tlh-install.mjs --print-support-manifest
  fi | awk -F'|' '{ print $2 "|" $3 }'
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

make_support_copy_curl() {
  local fakebin="$1"
  mkdir -p "${fakebin}"
  cat >"${fakebin}/curl" <<'EOF_SUPPORT_COPY_CURL'
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
if [[ -z "${url}" || -z "${out}" || -z "${FAKE_RAW_BASE:-}" || -z "${FAKE_SUPPORT_ROOT:-}" ]]; then
  printf 'fake support curl missing url, output, or support env\n' >&2
  exit 2
fi
base="${FAKE_RAW_BASE%/}/"
if [[ "${url}" != "${base}"* ]]; then
  printf 'fake support curl received unexpected url: %s\n' "${url}" >&2
  exit 2
fi
relative="${url#"${base}"}"
source_path="${FAKE_SUPPORT_ROOT}/${relative}"
if [[ ! -f "${source_path}" ]]; then
  printf 'fake support curl missing source: %s\n' "${relative}" >&2
  exit 22
fi
mkdir -p "$(dirname "${out}")"
cp "${source_path}" "${out}"
EOF_SUPPORT_COPY_CURL
  chmod +x "${fakebin}/curl"
}

make_legacy_support_curl() {
  local fakebin="$1"
  mkdir -p "${fakebin}"
  cat >"${fakebin}/curl" <<'EOF_LEGACY_SUPPORT_CURL'
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
if [[ -z "${url}" || -z "${out}" ]]; then
  printf 'fake legacy curl missing url or output path\n' >&2
  exit 2
fi
relative="${url#https://example.invalid/legacy-ref/}"
if [[ "${relative}" == "${url}" ]]; then
  relative="${url#https://example.invalid/no-wrapper-ref/}"
fi
if [[ "${relative}" == "${url}" ]]; then
  printf 'fake legacy curl received unexpected url: %s\n' "${url}" >&2
  exit 2
fi
case "${LEGACY_SUPPORT_MODE:-missing-runtime}:${relative}" in
  missing-runtime:scripts/tlh-wrapper.mjs|missing-runtime:scripts/tlh-install-state.mjs|missing-wrapper-only:scripts/tlh-wrapper.mjs)
    printf 'fake legacy ref missing %s\n' "${url}" >&2
    exit 22
    ;;
esac
mkdir -p "$(dirname "${out}")"
source_path="${FAKE_SUPPORT_ROOT:-}/${relative}"
if [[ -n "${FAKE_SUPPORT_ROOT:-}" && -f "${source_path}" ]]; then
  cp "${source_path}" "${out}"
else
  printf '{}\n' >"${out}"
fi
EOF_LEGACY_SUPPORT_CURL
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

make_failing_npm() {
  local fakebin="$1"
  mkdir -p "${fakebin}"
  cat >"${fakebin}/npm" <<'EOF_FAKE_NPM'
#!/usr/bin/env bash
printf 'fake npm: private runtime install blocked for smoke test\n' >&2
exit 1
EOF_FAKE_NPM
  chmod +x "${fakebin}/npm"
}

make_fake_present_pi() {
  local fakebin="$1"
  mkdir -p "${fakebin}"
  cat >"${fakebin}/pi" <<'EOF_FAKE_PRESENT_PI'
#!/bin/sh
if [ "${1:-}" = "--version" ]; then
  printf '0.80.1\n'
  exit 0
fi
printf 'fake pi should only be invoked with --version during dry-run; got: %s\n' "$*" >&2
exit 98
EOF_FAKE_PRESENT_PI
  chmod +x "${fakebin}/pi"
}

make_fake_stage1_support_root() {
  local root="$1"
  local manifest_file="${root}/.fake-stage1-support-manifest"
  local requirement relative_path
  mkdir -p "${root}"
  cp "${ROOT_DIR}/install.sh" "${root}/install.sh"
  chmod +x "${root}/install.sh"
  extract_stage0_support_manifest false >"${manifest_file}"
  while IFS='|' read -r requirement relative_path; do
    [[ -n "${relative_path}" ]] || continue
    mkdir -p "${root}/$(dirname "${relative_path}")"
    : >"${root}/${relative_path}"
  done <"${manifest_file}"
  cat >"${root}/scripts/tlh-install.mjs" <<'EOF_FAKE_STAGE1'
#!/usr/bin/env node
console.log("BUG: fake local stage-1 was invoked");
EOF_FAKE_STAGE1
}

write_stage0_manifest_variant() {
  local dest="$1"
  local extra_manifest="$2"
  INSTALLER_DEST="${dest}" STAGE0_EXTRA_MANIFEST="${extra_manifest}" node <<'NODE_STAGE0_VARIANT'
const fs = require('node:fs');

const dest = process.env.INSTALLER_DEST;
const extraManifest = (process.env.STAGE0_EXTRA_MANIFEST || '').split(/\r?\n/).filter(Boolean);
const source = fs.readFileSync('install.sh', 'utf8');
const startToken = "cat <<'EOF_SUPPORT_FILES'\n";
const startIndex = source.indexOf(startToken);
if (startIndex === -1) throw new Error('missing EOF_SUPPORT_FILES heredoc');
const bodyStart = startIndex + startToken.length;
const endMarker = '\nEOF_SUPPORT_FILES';
const endIndex = source.indexOf(endMarker, bodyStart);
if (endIndex === -1) throw new Error('unterminated EOF_SUPPORT_FILES heredoc');
const output = extraManifest.length === 0
  ? source
  : `${source.slice(0, endIndex)}\n${extraManifest.join('\n')}${source.slice(endIndex)}`;
fs.writeFileSync(dest, output, 'utf8');
NODE_STAGE0_VARIANT
  chmod +x "${dest}"
}

make_fake_remote_stage1_support_root() {
  local root="$1"
  local manifest_file="${root}/.fake-remote-stage1-support-manifest"
  local requirement relative_path
  local -a compatibility_paths=(
    "config/librarian.defaults.json"
    "scripts/tlh-install-query.mjs"
    "scripts/lib/tlh-profile-writes.mjs"
  )

  mkdir -p "${root}"
  cp "${ROOT_DIR}/install.sh" "${root}/install.sh"
  chmod +x "${root}/install.sh"

  extract_stage0_support_manifest false >"${manifest_file}"
  while IFS='|' read -r requirement relative_path; do
    [[ -n "${relative_path}" ]] || continue
    mkdir -p "${root}/$(dirname "${relative_path}")"
    cp "${ROOT_DIR}/${relative_path}" "${root}/${relative_path}"
  done <"${manifest_file}"

  local compatibility_path
  for compatibility_path in "${compatibility_paths[@]}"; do
    mkdir -p "${root}/$(dirname "${compatibility_path}")"
    cp "${ROOT_DIR}/${compatibility_path}" "${root}/${compatibility_path}"
  done

  cat >"${root}/scripts/tlh-install.mjs" <<'EOF_FAKE_REMOTE_STAGE1'
#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
for (const [label, targetPath] of [
  ["compat_librarian_present", join(repoRoot, "config", "librarian.defaults.json")],
  ["compat_query_present", join(scriptDir, "tlh-install-query.mjs")],
  ["compat_profile_writes_present", join(scriptDir, "lib", "tlh-profile-writes.mjs")],
  ["stale_poison_present", join(repoRoot, "poison", "stale-stage0-only.txt")],
]) {
  console.log(`${label}=${existsSync(targetPath)}`);
}
console.log("fake_stage1=ok");
EOF_FAKE_REMOTE_STAGE1
  chmod +x "${root}/scripts/tlh-install.mjs"
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
