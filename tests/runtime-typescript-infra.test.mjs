import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const runtimeTypescriptScript = join(repoRoot, "scripts/runtime-typescript.mjs");

function readPackageJson() {
	return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
}

test("runtime TypeScript package scripts stay wired into validation before tests and pack", () => {
	const pkg = readPackageJson();
	assert.equal(pkg.scripts.build, "npm run build:runtime");
	assert.equal(pkg.scripts.typecheck, "npm run typecheck:runtime");
	assert.equal(pkg.scripts["build:runtime"], "node scripts/runtime-typescript.mjs build");
	assert.equal(pkg.scripts["check:runtime"], "node scripts/runtime-typescript.mjs check");
	assert.equal(pkg.scripts["typecheck:runtime"], "node scripts/runtime-typescript.mjs typecheck");

	const validate = pkg.scripts.validate;
	assert.match(validate, /npm run typecheck/);
	assert.match(validate, /npm run check:runtime/);
	assert.match(validate, /npm test/);
	assert.match(validate, /npm pack --dry-run/);
	assert.ok(validate.indexOf("npm run typecheck") < validate.indexOf("npm test"));
	assert.ok(validate.indexOf("npm run check:runtime") < validate.indexOf("npm test"));
	assert.ok(validate.indexOf("npm run check:runtime") < validate.indexOf("npm pack --dry-run"));
});

test("runtime TypeScript helper covers converted installer libraries and keeps generated outputs fresh", () => {
	const convertedLibraries = [
		"scripts/lib/default-extensions",
		"scripts/lib/tlh-install-git",
		"scripts/lib/tlh-install-package-source",
		"scripts/lib/tlh-install-paths",
		"scripts/lib/tlh-install-subagents",
		"scripts/lib/tlh-install-support-files",
		"scripts/lib/tlh-install-support-manifest",
		"scripts/lib/tlh-install-utils",
	];

	for (const path of convertedLibraries) {
		assert.equal(existsSync(join(repoRoot, `${path}.mts`)), true, `${path}.mts should exist`);
		assert.equal(existsSync(join(repoRoot, `${path}.mjs`)), true, `${path}.mjs should exist`);
	}

	for (const mode of ["typecheck", "check", "build"]) {
		const result = spawnSync(process.execPath, [runtimeTypescriptScript, mode], {
			cwd: repoRoot,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.doesNotMatch(result.stdout, /No runtime TypeScript sources found/);
	}
});

test("runtime TypeScript freshness check fails on stale generated output without rewriting it", () => {
	const targetPath = join(repoRoot, "scripts/lib/tlh-install-support-manifest.mjs");
	const originalContent = readFileSync(targetPath, "utf8");
	const staleContent = `// stale test fixture\n${originalContent}`;

	try {
		writeFileSync(targetPath, staleContent);

		const result = spawnSync(process.execPath, [runtimeTypescriptScript, "check"], {
			cwd: repoRoot,
			encoding: "utf8",
		});

		assert.equal(result.status, 1, result.stderr || result.stdout);
		assert.match(result.stderr, /Runtime TypeScript generated outputs are not fresh\./);
		assert.match(result.stderr, /scripts\/lib\/tlh-install-support-manifest\.mjs/);
		assert.match(result.stderr, /npm run build/);
		assert.equal(readFileSync(targetPath, "utf8"), staleContent);
	} finally {
		writeFileSync(targetPath, originalContent);
	}
});
