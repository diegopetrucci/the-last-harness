#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
cd "${ROOT_DIR}"

# shellcheck source=scripts/installer-smoke/helpers.sh
source "${ROOT_DIR}/scripts/installer-smoke/helpers.sh"
# shellcheck source=scripts/installer-smoke/static-and-manifest.sh
source "${ROOT_DIR}/scripts/installer-smoke/static-and-manifest.sh"
# shellcheck source=scripts/installer-smoke/install-state-pi.sh
source "${ROOT_DIR}/scripts/installer-smoke/install-state-pi.sh"
# shellcheck source=scripts/installer-smoke/stage1.sh
source "${ROOT_DIR}/scripts/installer-smoke/stage1.sh"
# shellcheck source=scripts/installer-smoke/stage0.sh
source "${ROOT_DIR}/scripts/installer-smoke/stage0.sh"
# shellcheck source=scripts/installer-smoke/guards.sh
source "${ROOT_DIR}/scripts/installer-smoke/guards.sh"
# shellcheck source=scripts/installer-smoke/release-pinning.sh
source "${ROOT_DIR}/scripts/installer-smoke/release-pinning.sh"
# shellcheck source=scripts/installer-smoke/uninstall-runtime.sh
source "${ROOT_DIR}/scripts/installer-smoke/uninstall-runtime.sh"

installer_smoke_setup

run_static_checks
run_support_manifest_smoke
run_install_state_pi_field_smoke
run_install_dry_run_pi_field_smoke
run_update_pi_field_threading_smoke
run_install_sh_pi_installed_by_tlh_passthrough_smoke
run_uninstall_dry_run_pi_smoke
run_uninstall_flag_override_smoke
run_uninstall_normal_pi_guard_smoke
run_uninstall_dangerous_agent_dir_smoke
run_uninstall_home_alias_guard_smoke
run_uninstall_symlinked_agent_dir_smoke
run_uninstall_missing_marker_smoke
run_uninstall_valid_marked_removal_smoke
run_uninstall_marker_authoritative_smoke
run_uninstall_wrapper_ownership_smoke
run_uninstall_dangling_profile_wrapper_symlink_smoke
run_uninstall_unrelated_wrapper_symlink_smoke
run_uninstall_piped_smoke
run_uninstall_runtime_ownership_smoke
run_uninstall_sibling_preservation_smoke
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
run_stale_stage0_manifest_compatibility_smoke
run_stage0_canonical_handoff_smoke
run_wrapper_install_state_normal_pi_guard_smoke
run_release_pinning_smoke

log "Installer smoke checks passed."
