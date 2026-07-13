import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const runtimeTypescriptScript = join(repoRoot, "scripts/runtime-typescript.mjs");

function readPackageJson() {
	return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
}

function createRuntimeFixture(sourceContent) {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "tlh-runtime-typescript-fixture-"));
	const scriptsRoot = join(fixtureRoot, "scripts");
	const scriptsDir = join(scriptsRoot, "lib");
	const tempDir = join(fixtureRoot, "tmp");
	const sourcePath = join(scriptsDir, "fixture.mts");
	const outputPath = join(scriptsDir, "fixture.mjs");
	const tsconfigPath = join(fixtureRoot, "tsconfig.runtime-scripts.json");

	mkdirSync(scriptsDir, { recursive: true });
	mkdirSync(tempDir, { recursive: true });
	writeFileSync(
		tsconfigPath,
		`${JSON.stringify(
			{
				compilerOptions: {
					target: "ES2024",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					isolatedModules: true,
					verbatimModuleSyntax: true,
					skipLibCheck: true,
				},
				include: ["scripts/**/*.mts"],
				exclude: ["node_modules/**"],
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(sourcePath, sourceContent);

	return {
		fixtureRoot,
		scriptsRoot,
		tempDir,
		sourcePath,
		outputPath,
		tsconfigPath,
		cleanup() {
			rmSync(fixtureRoot, { recursive: true, force: true });
		},
	};
}

function runRuntimeTypescript(mode, fixtureRoot, scriptsRoot, tsconfigPath, tempDir) {
	return spawnSync(process.execPath, [runtimeTypescriptScript, mode], {
		cwd: fixtureRoot,
		encoding: "utf8",
		env: {
			...process.env,
			TLH_RUNTIME_TYPESCRIPT_REPO_ROOT: fixtureRoot,
			TLH_RUNTIME_TYPESCRIPT_SCRIPTS_DIR: scriptsRoot,
			TLH_RUNTIME_TYPESCRIPT_TSCONFIG: tsconfigPath,
			TLH_RUNTIME_TYPESCRIPT_TMPDIR: tempDir,
		},
	});
}

function assertNoTemporaryCheckOutputs(tempDir) {
	assert.deepEqual(readdirSync(tempDir), []);
}

test("runtime TypeScript package scripts stay wired into validation before tests and pack", () => {
	const pkg = readPackageJson();
	assert.equal(pkg.scripts.build, "npm run build:runtime");
	assert.equal(pkg.scripts.typecheck, "tsc --noEmit");
	assert.equal(pkg.scripts["build:runtime"], "node scripts/runtime-typescript.mjs build");
	assert.equal(pkg.scripts["check:runtime"], "node scripts/runtime-typescript.mjs check");
	assert.equal(pkg.scripts["typecheck:runtime"], "node scripts/runtime-typescript.mjs typecheck");
	assert.equal(pkg.scripts.test, 'node --test --test-reporter=dot "tests/**/*.test.mjs"');
	assert.equal(pkg.scripts["test:verbose"], 'node --test "tests/**/*.test.mjs"');

	const validate = pkg.scripts.validate;
	assert.match(validate, /npm run typecheck/);
	assert.match(validate, /npm run typecheck:runtime/);
	assert.match(validate, /npm run check:runtime/);
	assert.match(validate, /npm test/);
	assert.match(validate, /npm pack --dry-run/);
	assert.ok(validate.indexOf("npm run typecheck") < validate.indexOf("npm run typecheck:runtime"));
	assert.ok(validate.indexOf("npm run typecheck:runtime") < validate.indexOf("npm run check:runtime"));
	assert.ok(validate.indexOf("npm run check:runtime") < validate.indexOf("npm test"));
	assert.ok(validate.indexOf("npm run check:runtime") < validate.indexOf("npm pack --dry-run"));
});

test("runtime TypeScript helper covers converted installer libraries", () => {
	const convertedLibraries = [
		"scripts/lib/default-extensions",
		"scripts/lib/tlh-install-git",
		"scripts/lib/tlh-install-package-source",
		"scripts/lib/tlh-install-paths",
		"scripts/lib/tlh-install-subagents",
		"scripts/lib/tlh-install-support-files",
		"scripts/lib/tlh-install-support-manifest",
		"scripts/lib/tlh-install-utils",
		"scripts/lib/tlh-safe-profile-write",
	];

	for (const path of convertedLibraries) {
		assert.equal(existsSync(join(repoRoot, `${path}.mts`)), true, `${path}.mts should exist`);
		assert.equal(existsSync(join(repoRoot, `${path}.mjs`)), true, `${path}.mjs should exist`);
	}
});

test("runtime TypeScript helper tracks converted top-level CLIs", () => {
	const convertedCliScripts = [
		"scripts/merge-keybindings",
		"scripts/merge-settings",
		"scripts/tlh-defaults",
		"scripts/tlh-doctor",
		"scripts/tlh-gh",
		"scripts/tlh-gnosis",
		"scripts/tlh-install",
		"scripts/tlh-recover-update",
		"scripts/tlh-rtk",
		"scripts/tlh-tickets",
		"scripts/tlh-update",
		"scripts/tlh-wrapper",
	];

	for (const path of convertedCliScripts) {
		assert.equal(existsSync(join(repoRoot, `${path}.mts`)), true, `${path}.mts should exist`);
		assert.equal(existsSync(join(repoRoot, `${path}.mjs`)), true, `${path}.mjs should exist`);
	}
});

test("runtime TypeScript helper builds, checks, and typechecks temporary fixtures", () => {
	const fixture = createRuntimeFixture('export function greet(name: string) {\n\treturn `hello ${name}`;\n}\n');

	try {
		assert.equal(existsSync(fixture.outputPath), false);

		const buildResult = runRuntimeTypescript(
			"build",
			fixture.fixtureRoot,
			fixture.scriptsRoot,
			fixture.tsconfigPath,
			fixture.tempDir,
		);
		assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout);
		assert.equal(existsSync(fixture.outputPath), true);
		assert.match(readFileSync(fixture.outputPath, "utf8"), /export function greet\(name\)/);

		const checkResult = runRuntimeTypescript(
			"check",
			fixture.fixtureRoot,
			fixture.scriptsRoot,
			fixture.tsconfigPath,
			fixture.tempDir,
		);
		assert.equal(checkResult.status, 0, checkResult.stderr || checkResult.stdout);
		assert.match(checkResult.stdout, /Runtime TypeScript generated outputs are fresh/);
		assertNoTemporaryCheckOutputs(fixture.tempDir);

		const typecheckResult = runRuntimeTypescript(
			"typecheck",
			fixture.fixtureRoot,
			fixture.scriptsRoot,
			fixture.tsconfigPath,
			fixture.tempDir,
		);
		assert.equal(typecheckResult.status, 0, typecheckResult.stderr || typecheckResult.stdout);
	} finally {
		fixture.cleanup();
	}
});

test("runtime TypeScript freshness check fails on stale fixture output without rewriting it", () => {
	const fixture = createRuntimeFixture("export const answer = 42;\n");

	try {
		const buildResult = runRuntimeTypescript(
			"build",
			fixture.fixtureRoot,
			fixture.scriptsRoot,
			fixture.tsconfigPath,
			fixture.tempDir,
		);
		assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout);

		const staleContent = `// stale test fixture\n${readFileSync(fixture.outputPath, "utf8")}`;
		writeFileSync(fixture.outputPath, staleContent);

		const checkResult = runRuntimeTypescript(
			"check",
			fixture.fixtureRoot,
			fixture.scriptsRoot,
			fixture.tsconfigPath,
			fixture.tempDir,
		);
		assert.equal(checkResult.status, 1, checkResult.stderr || checkResult.stdout);
		assert.match(checkResult.stderr, /Runtime TypeScript generated outputs are not fresh\./);
		assert.match(checkResult.stderr, /scripts\/lib\/fixture\.mjs/);
		assert.match(checkResult.stderr, /npm run build/);
		assert.equal(readFileSync(fixture.outputPath, "utf8"), staleContent);
		assertNoTemporaryCheckOutputs(fixture.tempDir);
	} finally {
		fixture.cleanup();
	}
});

test("runtime TypeScript check cleans temporary outputs when TypeScript compilation fails", () => {
	const fixture = createRuntimeFixture("export const broken = ;\n");

	try {
		const checkResult = runRuntimeTypescript(
			"check",
			fixture.fixtureRoot,
			fixture.scriptsRoot,
			fixture.tsconfigPath,
			fixture.tempDir,
		);
		assert.notEqual(checkResult.status, 0);
		assert.doesNotMatch(`${checkResult.stdout}\n${checkResult.stderr}`, /Runtime TypeScript generated outputs are not fresh\./);
		assertNoTemporaryCheckOutputs(fixture.tempDir);
	} finally {
		fixture.cleanup();
	}
});

test(".gitattributes linguist-generated entries are in sync with scripts/**/*.mts sources", () => {
	const gitattributesPath = join(repoRoot, ".gitattributes");
	assert.ok(existsSync(gitattributesPath), ".gitattributes must exist at repo root");

	// Derive expected generated .mjs paths from all .mts sources.
	const mtsFiles = globSync("scripts/**/*.mts", { cwd: repoRoot }).filter((f) => !f.endsWith(".d.mts"));
	const expectedPaths = new Set(
		mtsFiles.map((f) => f.replace(/\.mts$/, ".mjs")),
	);

	// Parse .gitattributes for linguist-generated=true entries.
	const gitattributesContent = readFileSync(gitattributesPath, "utf8");
	const generatedEntries = new Set(
		gitattributesContent
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => !line.startsWith("#") && line.includes("linguist-generated=true"))
			.map((line) => line.split(/\s+/)[0]),
	);

	// Every .mts source must have a corresponding entry.
	for (const expectedPath of expectedPaths) {
		assert.ok(
			generatedEntries.has(expectedPath),
			`Missing .gitattributes linguist-generated entry for generated file: ${expectedPath}`,
		);
	}

	// Every linguist-generated entry must correspond to an existing .mts source.
	for (const entry of generatedEntries) {
		const mtsPath = entry.replace(/\.mjs$/, ".mts");
		assert.ok(
			existsSync(join(repoRoot, mtsPath)),
			`Stale .gitattributes linguist-generated entry — no corresponding .mts source: ${entry}`,
		);
	}
});
