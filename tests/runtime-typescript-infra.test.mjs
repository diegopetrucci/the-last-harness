import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	globSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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

function createRuntimeFixture({
	targetId,
	sourceRootName,
	sourceRelativePath,
	sourceContent,
	tsconfigFileName,
	includeGlob,
	sourceExtension,
	outputExtension,
	generatedRegistryEntries,
	compilerOptions = {},
}) {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "tlh-runtime-typescript-fixture-"));
	const sourceRoot = join(fixtureRoot, sourceRootName);
	const sourcePath = join(sourceRoot, sourceRelativePath);
	const outputPath = join(sourceRoot, sourceRelativePath.slice(0, -sourceExtension.length) + outputExtension);
	const tempDir = join(fixtureRoot, "tmp");
	const tsconfigPath = join(fixtureRoot, tsconfigFileName);

	mkdirSync(dirname(sourcePath), { recursive: true });
	mkdirSync(tempDir, { recursive: true });
	writeFileSync(join(fixtureRoot, "package.json"), '{\n  "type": "module"\n}\n');
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
					...compilerOptions,
				},
				include: [includeGlob],
				exclude: ["node_modules/**"],
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(sourcePath, sourceContent);
	writeFileSync(
		join(fixtureRoot, ".gitattributes"),
		`${(
			generatedRegistryEntries ?? [
				join(sourceRootName, sourceRelativePath.slice(0, -sourceExtension.length) + outputExtension).replaceAll(
					"\\",
					"/",
				),
			]
		)
			.map((path) => `${path} linguist-generated=true`)
			.join("\n")}\n`,
	);

	return {
		targetId,
		fixtureRoot,
		sourceRoot,
		tempDir,
		sourcePath,
		outputPath,
		tsconfigPath,
		cleanup() {
			rmSync(fixtureRoot, { recursive: true, force: true });
		},
	};
}

function createScriptsFixture(sourceContent) {
	return createRuntimeFixture({
		targetId: "scripts",
		sourceRootName: "scripts",
		sourceRelativePath: "lib/fixture.mts",
		sourceContent,
		tsconfigFileName: "tsconfig.runtime-scripts.json",
		includeGlob: "scripts/**/*.mts",
		sourceExtension: ".mts",
		outputExtension: ".mjs",
	});
}

function createExtensionsFixture(sourceContent, options = {}) {
	return createRuntimeFixture({
		targetId: "extensions",
		sourceRootName: "extensions",
		sourceRelativePath: "fixture/index.ts",
		sourceContent,
		tsconfigFileName: "tsconfig.runtime-extensions.json",
		includeGlob: "extensions/**/*.ts",
		sourceExtension: ".ts",
		outputExtension: ".js",
		generatedRegistryEntries: options.generatedRegistryEntries,
		compilerOptions: options.compilerOptions,
	});
}

function createSubagentsFixture(sourceContent, options = {}) {
	return createRuntimeFixture({
		targetId: "subagents",
		sourceRootName: "extensions/subagents/src",
		sourceRelativePath: "fixture/index.ts",
		sourceContent,
		tsconfigFileName: "tsconfig.runtime-subagents.json",
		includeGlob: "extensions/subagents/src/**/*.ts",
		sourceExtension: ".ts",
		outputExtension: ".js",
		generatedRegistryEntries: options.generatedRegistryEntries,
		compilerOptions: { removeComments: true, rewriteRelativeImportExtensions: true, ...options.compilerOptions },
	});
}

function runRuntimeTypescript(mode, fixture) {
	const env = {
		...process.env,
		TLH_RUNTIME_TYPESCRIPT_REPO_ROOT: fixture.fixtureRoot,
		TLH_RUNTIME_TYPESCRIPT_TARGETS: fixture.targetId,
		TLH_RUNTIME_TYPESCRIPT_TMPDIR: fixture.tempDir,
	};
	if (fixture.targetId === "scripts") {
		env.TLH_RUNTIME_TYPESCRIPT_SCRIPTS_DIR = fixture.sourceRoot;
		env.TLH_RUNTIME_TYPESCRIPT_SCRIPTS_TSCONFIG = fixture.tsconfigPath;
	} else if (fixture.targetId === "subagents") {
		env.TLH_RUNTIME_TYPESCRIPT_SUBAGENTS_DIR = fixture.sourceRoot;
		env.TLH_RUNTIME_TYPESCRIPT_SUBAGENTS_TSCONFIG = fixture.tsconfigPath;
	} else {
		env.TLH_RUNTIME_TYPESCRIPT_EXTENSIONS_DIR = fixture.sourceRoot;
		env.TLH_RUNTIME_TYPESCRIPT_EXTENSIONS_TSCONFIG = fixture.tsconfigPath;
	}

	return spawnSync(process.execPath, [runtimeTypescriptScript, mode], {
		cwd: fixture.fixtureRoot,
		encoding: "utf8",
		env,
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
	assert.equal(
		pkg.scripts["typecheck:subagents-test-support"],
		"tsc --noEmit --project tsconfig.subagents-test-support.json",
	);
	assert.equal(
		pkg.scripts["test:subagents"],
		"npm run test:subagents:unit && npm run test:subagents:integration && npm run test:subagents:e2e",
	);
	assert.equal(pkg.scripts["check:package-contents"], "node scripts/check-package-contents.mjs");
	assert.equal(pkg.scripts.test, 'node --test --test-reporter=dot "tests/**/*.test.mjs" && npm run test:subagents');
	assert.equal(pkg.scripts["test:verbose"], 'node --test "tests/**/*.test.mjs" && npm run test:subagents');

	const validate = pkg.scripts.validate;
	assert.match(validate, /npm run check:package-contents/);
	assert.match(validate, /npm run typecheck/);
	assert.match(validate, /npm run typecheck:subagents-test-support/);
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
		"scripts/tlh-gnosis",
		"scripts/tlh-install",
		"scripts/tlh-recover-update",
		"scripts/tlh-tickets",
		"scripts/tlh-update",
		"scripts/tlh-wrapper",
	];

	for (const path of convertedCliScripts) {
		assert.equal(existsSync(join(repoRoot, `${path}.mts`)), true, `${path}.mts should exist`);
		assert.equal(existsSync(join(repoRoot, `${path}.mjs`)), true, `${path}.mjs should exist`);
	}
});

test("runtime TypeScript helper tracks generated extension runtime modules", () => {
	const extensionSources = globSync("extensions/**/*.ts", { cwd: repoRoot }).filter(
		(path) => !path.endsWith(".d.ts") && !path.startsWith("extensions/subagents/"),
	);
	assert.equal(extensionSources.length, 73);

	for (const sourcePath of extensionSources) {
		const outputPath = sourcePath.replace(/\.ts$/, ".js");
		assert.equal(existsSync(join(repoRoot, outputPath)), true, `${outputPath} should exist`);
	}
});

test("dedicated subagents runtime target compiles all production modules and rewrites relative TypeScript imports", () => {
	const sourcePaths = globSync("extensions/subagents/src/**/*.ts", { cwd: repoRoot }).filter(
		(path) => !path.endsWith(".d.ts"),
	);
	assert.equal(sourcePaths.length, 92);
	for (const sourcePath of sourcePaths) {
		const outputPath = sourcePath.replace(/\.ts$/, ".js");
		assert.equal(existsSync(join(repoRoot, outputPath)), true, `${outputPath} should exist`);
	}
	const entrypoint = readFileSync(join(repoRoot, "extensions/subagents/src/extension/index.js"), "utf8");
	assert.match(entrypoint, /from ["'][^"']+\.js["']/);
	assert.doesNotMatch(entrypoint, /from ["'][^"']+\.ts["']/);
});

test("runtime TypeScript helper builds, checks, and typechecks temporary script fixtures", () => {
	const fixture = createScriptsFixture(
		"// script fixture comment should remain\nexport function greet(name: string) {\n\treturn `hello ${name}`;\n}\n",
	);

	try {
		assert.equal(existsSync(fixture.outputPath), false);

		const buildResult = runRuntimeTypescript("build", fixture);
		assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout);
		assert.equal(existsSync(fixture.outputPath), true);
		const outputContent = readFileSync(fixture.outputPath, "utf8");
		assert.match(outputContent, /script fixture comment should remain/);
		assert.match(outputContent, /export function greet\(name\)/);

		const checkResult = runRuntimeTypescript("check", fixture);
		assert.equal(checkResult.status, 0, checkResult.stderr || checkResult.stdout);
		assert.match(checkResult.stdout, /Generated runtime outputs are fresh/);
		assertNoTemporaryCheckOutputs(fixture.tempDir);

		const typecheckResult = runRuntimeTypescript("typecheck", fixture);
		assert.equal(typecheckResult.status, 0, typecheckResult.stderr || typecheckResult.stdout);
	} finally {
		fixture.cleanup();
	}
});

test("runtime TypeScript helper builds and checks temporary extension fixtures while omitting comments", () => {
	const fixture = createExtensionsFixture(
		'// extension fixture comment should be removed\nexport function assetHref() {\n\treturn new URL("./note.txt", import.meta.url).href;\n}\n',
		{
			compilerOptions: { removeComments: true },
		},
	);
	writeFileSync(join(fixture.sourceRoot, "fixture/note.txt"), "hello from asset\n");

	try {
		assert.equal(existsSync(fixture.outputPath), false);

		const buildResult = runRuntimeTypescript("build", fixture);
		assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout);
		assert.equal(existsSync(fixture.outputPath), true);
		const outputContent = readFileSync(fixture.outputPath, "utf8");
		assert.doesNotMatch(outputContent, /extension fixture comment should be removed/);
		assert.match(outputContent, /import\.meta\.url/);

		const checkResult = runRuntimeTypescript("check", fixture);
		assert.equal(checkResult.status, 0, checkResult.stderr || checkResult.stdout);
		assert.match(checkResult.stdout, /Generated runtime outputs are fresh/);
		assertNoTemporaryCheckOutputs(fixture.tempDir);
	} finally {
		fixture.cleanup();
	}
});

test("generic extension target realpath-normalizes a subagents exclusion beneath a symlinked source root", () => {
	const fixture = createRuntimeFixture({
		targetId: "extensions",
		sourceRootName: "extensions-real",
		sourceRelativePath: "fixture/index.ts",
		sourceContent: "export const included = true;\n",
		tsconfigFileName: "tsconfig.runtime-extensions.json",
		includeGlob: "extensions-real/**/*.ts",
		sourceExtension: ".ts",
		outputExtension: ".js",
	});
	const excludedSourcePath = join(fixture.fixtureRoot, "extensions-real/subagents/should-not-build.ts");
	const excludedOutputPath = excludedSourcePath.replace(/\.ts$/, ".js");
	mkdirSync(dirname(excludedSourcePath), { recursive: true });
	writeFileSync(excludedSourcePath, "export const excluded = true;\n");
	const logicalExtensionsRoot = join(fixture.fixtureRoot, "extensions");
	symlinkSync(fixture.sourceRoot, logicalExtensionsRoot, process.platform === "win32" ? "junction" : "dir");
	fixture.sourceRoot = logicalExtensionsRoot;

	try {
		const buildResult = runRuntimeTypescript("build", fixture);
		assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout);
		assert.equal(existsSync(fixture.outputPath), true);
		assert.equal(existsSync(excludedOutputPath), false);
	} finally {
		fixture.cleanup();
	}
});

test("dedicated subagents runtime target builds same-layout JavaScript and rewrites relative TypeScript imports", () => {
	const fixture = createSubagentsFixture('import { answer } from "./answer.ts";\nexport const result = answer;\n', {
		generatedRegistryEntries: [
			"extensions/subagents/src/fixture/index.js",
			"extensions/subagents/src/fixture/answer.js",
		],
	});
	writeFileSync(join(fixture.sourceRoot, "fixture/answer.ts"), "export const answer = 42;\n");

	try {
		const buildResult = runRuntimeTypescript("build", fixture);
		assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout);
		assert.equal(existsSync(fixture.outputPath), true);
		assert.equal(readFileSync(fixture.outputPath, "utf8").includes("./answer.js"), true);
		const checkResult = runRuntimeTypescript("check", fixture);
		assert.equal(checkResult.status, 0, checkResult.stderr || checkResult.stdout);
		assertNoTemporaryCheckOutputs(fixture.tempDir);
	} finally {
		fixture.cleanup();
	}
});

test("runtime TypeScript freshness check fails on stale script fixture output without rewriting it", () => {
	const fixture = createScriptsFixture("export const answer = 42;\n");

	try {
		const buildResult = runRuntimeTypescript("build", fixture);
		assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout);

		const staleContent = `// stale test fixture\n${readFileSync(fixture.outputPath, "utf8")}`;
		writeFileSync(fixture.outputPath, staleContent);

		const checkResult = runRuntimeTypescript("check", fixture);
		assert.equal(checkResult.status, 1, checkResult.stderr || checkResult.stdout);
		assert.match(checkResult.stderr, /Generated runtime outputs are not fresh for scripts\/\*\*\/\*\.mts\./);
		assert.match(checkResult.stderr, /scripts\/lib\/fixture\.mjs/);
		assert.match(checkResult.stderr, /npm run build/);
		assert.equal(readFileSync(fixture.outputPath, "utf8"), staleContent);
		assertNoTemporaryCheckOutputs(fixture.tempDir);
	} finally {
		fixture.cleanup();
	}
});

test("runtime TypeScript freshness check fails on missing extension output without rewriting sources", () => {
	const fixture = createExtensionsFixture("export const answer = 42;\n");

	try {
		const buildResult = runRuntimeTypescript("build", fixture);
		assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout);
		rmSync(fixture.outputPath, { force: true });

		const checkResult = runRuntimeTypescript("check", fixture);
		assert.equal(checkResult.status, 1, checkResult.stderr || checkResult.stdout);
		assert.match(checkResult.stderr, /Generated runtime outputs are not fresh for extensions\/\*\*\/\*\.ts\./);
		assert.match(checkResult.stderr, /extensions\/fixture\/index\.js/);
		assert.match(checkResult.stderr, /npm run build/);
		assert.equal(existsSync(fixture.sourcePath), true);
		assertNoTemporaryCheckOutputs(fixture.tempDir);
	} finally {
		fixture.cleanup();
	}
});

test("runtime TypeScript normalizes Windows-style generated-output registry paths for extensions", () => {
	const fixture = createExtensionsFixture("export const answer = 42;\n", {
		generatedRegistryEntries: ["extensions\\fixture\\index.js"],
	});

	try {
		const buildResult = runRuntimeTypescript("build", fixture);
		assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout);
		assert.equal(existsSync(fixture.outputPath), true);

		const checkResult = runRuntimeTypescript("check", fixture);
		assert.equal(checkResult.status, 0, checkResult.stderr || checkResult.stdout);
		assert.match(checkResult.stdout, /Generated runtime outputs are fresh/);
		assertNoTemporaryCheckOutputs(fixture.tempDir);
	} finally {
		fixture.cleanup();
	}
});

test("runtime TypeScript build removes orphan generated extension output that is explicitly registered", () => {
	const fixture = createExtensionsFixture("export const answer = 42;\n", {
		generatedRegistryEntries: ["extensions/fixture/index.js", "extensions/fixture/orphan.js"],
	});
	const orphanOutputPath = join(fixture.sourceRoot, "fixture/orphan.js");
	const handAuthoredWebAssetPath = join(fixture.sourceRoot, "fixture/web/app.js");
	mkdirSync(dirname(handAuthoredWebAssetPath), { recursive: true });
	writeFileSync(orphanOutputPath, "// orphan generated output\n");
	writeFileSync(handAuthoredWebAssetPath, "// hand authored asset\n");

	try {
		const checkResult = runRuntimeTypescript("check", fixture);
		assert.equal(checkResult.status, 1, checkResult.stderr || checkResult.stdout);
		assert.match(checkResult.stderr, /Orphan generated runtime outputs would still ship:/);
		assert.match(checkResult.stderr, /extensions\/fixture\/orphan\.js/);
		assert.equal(readFileSync(orphanOutputPath, "utf8"), "// orphan generated output\n");
		assert.equal(readFileSync(handAuthoredWebAssetPath, "utf8"), "// hand authored asset\n");
		assertNoTemporaryCheckOutputs(fixture.tempDir);

		const buildResult = runRuntimeTypescript("build", fixture);
		assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout);
		assert.equal(existsSync(orphanOutputPath), false);
		assert.equal(readFileSync(handAuthoredWebAssetPath, "utf8"), "// hand authored asset\n");
		assert.match(buildResult.stdout, /Removed orphan generated runtime outputs/);
	} finally {
		fixture.cleanup();
	}
});

test("runtime TypeScript check cleans temporary outputs when TypeScript compilation fails", () => {
	const fixture = createScriptsFixture("export const broken = ;\n");

	try {
		const checkResult = runRuntimeTypescript("check", fixture);
		assert.notEqual(checkResult.status, 0);
		assert.doesNotMatch(`${checkResult.stdout}\n${checkResult.stderr}`, /Generated runtime outputs are not fresh/);
		assertNoTemporaryCheckOutputs(fixture.tempDir);
	} finally {
		fixture.cleanup();
	}
});

test("generated extension outputs omit empty Pi runtime imports for type-only entrypoint dependencies", () => {
	for (const path of [
		"extensions/the-last-harness.js",
		"extensions/the-last-harness/effort.js",
		"extensions/the-last-harness/effort-command.js",
	]) {
		assert.doesNotMatch(
			readFileSync(join(repoRoot, path), "utf8"),
			/import\s*\{\s*\}\s*from\s*"@earendil-works\/pi-coding-agent";/,
			`${path} should not contain an empty Pi runtime import`,
		);
	}
});

test("package manifest lists only the ordered generated JS extension entrypoints to avoid duplicate TS and JS discovery", () => {
	const pkg = readPackageJson();
	assert.deepEqual(pkg.pi.extensions, [
		"./extensions/annotate-git-diff/index.js",
		"./extensions/the-last-harness.js",
		"./extensions/subagents/src/extension/index.js",
	]);
});

test(".gitattributes linguist-generated entries are in sync with runtime TypeScript sources", () => {
	const gitattributesPath = join(repoRoot, ".gitattributes");
	assert.ok(existsSync(gitattributesPath), ".gitattributes must exist at repo root");

	const mtsFiles = globSync("scripts/**/*.mts", { cwd: repoRoot }).filter((path) => !path.endsWith(".d.mts"));
	const tsFiles = globSync("extensions/**/*.ts", { cwd: repoRoot }).filter(
		(path) => !path.endsWith(".d.ts") && !path.startsWith("extensions/subagents/"),
	);
	const subagentsFiles = globSync("extensions/subagents/src/**/*.ts", { cwd: repoRoot }).filter(
		(path) => !path.endsWith(".d.ts"),
	);
	const expectedPaths = new Set([
		...mtsFiles.map((path) => path.replace(/\.mts$/, ".mjs")),
		...subagentsFiles.map((path) => path.replace(/\.ts$/, ".js")),
		...tsFiles.map((path) => path.replace(/\.ts$/, ".js")),
	]);

	const gitattributesContent = readFileSync(gitattributesPath, "utf8");
	const generatedEntries = new Set(
		gitattributesContent
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => !line.startsWith("#") && line.includes("linguist-generated=true"))
			.map((line) => line.split(/\s+/)[0]),
	);

	for (const expectedPath of expectedPaths) {
		assert.ok(
			generatedEntries.has(expectedPath),
			`Missing .gitattributes linguist-generated entry for generated file: ${expectedPath}`,
		);
	}

	for (const entry of generatedEntries) {
		const sourcePath = entry.endsWith(".mjs") ? entry.replace(/\.mjs$/, ".mts") : entry.replace(/\.js$/, ".ts");
		assert.ok(
			existsSync(join(repoRoot, sourcePath)),
			`Stale .gitattributes linguist-generated entry — no corresponding source: ${entry}`,
		);
	}
});
