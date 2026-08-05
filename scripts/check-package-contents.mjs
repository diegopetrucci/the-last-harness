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
const forbiddenPrefixes = ["extensions/subagents/test/", "tests/"];
const forbiddenExactPaths = [
	"scripts/check-package-contents.mjs",
	"scripts/run-subagents-tests.mjs",
];
const forbiddenFiles = [...files].filter((file) =>
	forbiddenExactPaths.includes(file)
	|| forbiddenPrefixes.some((prefix) => file.startsWith(prefix)));
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
	"extensions/subagents/LICENSE",
	"agents/primary/architect.md",
	"agents/subagents/developer.md",
	"config/APPEND_SYSTEM.md",
	"config/settings.defaults.json",
	"docs/subagents.md",
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

console.log(`Package contents verified (${files.size} files; tests and contributor scripts excluded).`);
