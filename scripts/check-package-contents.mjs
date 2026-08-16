#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmCommand, ["pack", "--dry-run", "--json"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (result.error) {
  console.error("Could not run npm pack --dry-run:", result.error);
  process.exit(1);
}
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

let packResult;
try {
  packResult = JSON.parse(result.stdout);
} catch (error) {
  console.error("Could not parse npm pack --dry-run --json output.");
  console.error(result.stdout);
  throw error;
}

const files = new Set(packResult.flatMap((entry) => entry.files ?? []).map((entry) => entry.path));

// Exact set of public docs shipped to end users. Update this list (and the
// package.json files negations) when adding or removing a public doc.
const PUBLIC_DOCS = [
  "docs/commands.md",
  "docs/embedded-subagents.md",
  "docs/git-attribution.md",
  "docs/install.md",
  "docs/integrations.md",
  "docs/mcp.md",
  "docs/models.md",
  "docs/subagents.md",
  "docs/telemetry.md",
  "docs/troubleshooting.md",
  "docs/web-search.md",
];

// Fail if any packed docs/ path is not on the allowlist (fail-closed guard).
const unknownDocs = [...files].filter((f) => f.startsWith("docs/") && !PUBLIC_DOCS.includes(f));
if (unknownDocs.length > 0) {
  console.error(
    "Published package contains unexpected docs/ files not on the PUBLIC_DOCS allowlist.",
  );
  console.error(
    "Add them to PUBLIC_DOCS in scripts/check-package-contents.mjs, or exclude them via the package.json files negations.",
  );
  for (const file of unknownDocs.sort()) console.error(`  - ${file}`);
  process.exit(1);
}

// Fail if any allowlisted public doc is missing from the pack.
const missingDocs = PUBLIC_DOCS.filter((f) => !files.has(f));
if (missingDocs.length > 0) {
  console.error(
    "Published package is missing expected public docs/ files from the PUBLIC_DOCS allowlist.",
  );
  console.error(
    "Restore missing entries via the package.json files negations or ensure the file exists.",
  );
  for (const file of missingDocs) console.error(`  - ${file}`);
  process.exit(1);
}

const forbiddenPrefixes = ["extensions/subagents/test/", "tests/"];
const forbiddenExactPaths = [
  "scripts/check-package-contents.mjs",
  "scripts/run-subagents-tests.mjs",
  "scripts/run-lane.mjs",
  "scripts/run-ci-test-shard.mjs",
  "scripts/run-ci-validation.mjs",
];
const forbiddenFiles = [...files].filter(
  (file) =>
    forbiddenExactPaths.includes(file) ||
    forbiddenPrefixes.some((prefix) => file.startsWith(prefix)),
);
if (forbiddenFiles.length > 0) {
  console.error("Published package contains contributor-only files:");
  for (const file of forbiddenFiles.sort()) console.error(`  - ${file}`);
  process.exit(1);
}

const configuredPiEntrypoints = packageJson.pi?.extensions;
if (!Array.isArray(configuredPiEntrypoints) || configuredPiEntrypoints.length === 0) {
  console.error("package.json must declare at least one pi.extensions entrypoint.");
  process.exit(1);
}
const piEntrypoints = configuredPiEntrypoints.map((entrypoint) => entrypoint.replace(/^\.\//, ""));
const requiredFiles = [
  ...piEntrypoints,
  "extensions/the-last-harness.ts",
  // Model/effort reconcile feature (ts-c1nw, ts-tr52, ts-d5vi, ts-x0p7)
  "extensions/the-last-harness/model-effort-reconcile.js",
  "extensions/the-last-harness/model-effort-notice.js",
  "extensions/the-last-harness/reconcile-command.js",
  "extensions/subagents/LICENSE",
  "agents/primary/architect.md",
  "agents/subagents/developer.md",
  "config/APPEND_SYSTEM.md",
  "config/settings.defaults.json",
  "prompts/analyse-tlh-sessions.md",
  "themes/the-last-harness.json",
  "install.sh",
  "uninstall.sh",
  "README.md",
  "CHANGELOG.md",
];
const missingFiles = requiredFiles.filter((file) => !files.has(file));
if (missingFiles.length > 0) {
  console.error("Published package is missing required TLH runtime/profile files:");
  for (const file of missingFiles) console.error(`  - ${file}`);
  process.exit(1);
}

console.log(
  `Package contents verified (${files.size} files; tests and contributor scripts excluded).`,
);
