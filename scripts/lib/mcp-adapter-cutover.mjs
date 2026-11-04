#!/usr/bin/env node
// Generated from scripts/lib/mcp-adapter-cutover.mts by scripts/runtime-typescript.mjs; edit the source, not this file.
// Compatibility stub; intentionally a no-op.
//
// The MCP adapter cutover machinery was retired when TLH moved to Pi's native
// MCP support. Wrappers rendered by earlier releases still run
// `mcp-adapter-cutover.mjs --startup-guard ...` before every launch and fail
// closed when this file is missing, so it stays in the package until those
// wrappers have been re-rendered by `tlh update`. Newly rendered wrappers never
// call it.
//
// Remove this file (and its support-manifest, check-package-contents,
// installer-smoke, .oxfmtrc/.oxlintrc/.gitattributes entries) only after a
// Tlh.App.version telemetry check shows old wrappers are no longer in use; see
// CONTRIBUTING.md "Retiring installer migrations".
//
// Accepts and ignores any arguments (--startup-guard, --agent-dir, ...) and
// always exits 0 so legacy wrappers continue to launch.
process.exitCode = 0;
export {};
