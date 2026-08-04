import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const sourceImportPattern = /from\s+["'](@earendil-works\/[^"']+)["']|import\s+["'](@earendil-works\/[^"']+)["']/g;
const oldPiScopePattern = /@mariozechner\/pi-/;
const piPackageJsonSubpathPattern = /@earendil-works\/pi-[^"']+\/package\.json/;
const cjsPiPackageResolutionPattern = /require(?:\.resolve)?\(\s*["']@earendil-works\/pi-/;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const scopedPackageName = "@diegopetrucci/pi-subagents";
const forkRepositoryUrl = "git+https://github.com/diegopetrucci/pi-subagents.git";
const forkHomepageUrl = "https://github.com/diegopetrucci/pi-subagents#readme";
const forkIssuesUrl = "https://github.com/diegopetrucci/pi-subagents/issues";
const removedSlashSurfaces = [
	{ label: "/run", pattern: /(^|[^\w-])\/run(?![\w-])/ },
	{ label: "/chain", pattern: /(^|[^\w-])\/chain(?![\w-])/ },
	{ label: "/parallel", pattern: /(^|[^\w-])\/parallel(?![\w-])/ },
	{ label: "/run-chain", pattern: /(^|[^\w-])\/run-chain(?![\w-])/ },
	{ label: "/parallel-review", pattern: /(^|[^\w-])\/parallel-review(?![\w-])/ },
	{ label: "/review-loop", pattern: /(^|[^\w-])\/review-loop(?![\w-])/ },
	{ label: "/parallel-research", pattern: /(^|[^\w-])\/parallel-research(?![\w-])/ },
	{ label: "/parallel-context-build", pattern: /(^|[^\w-])\/parallel-context-build(?![\w-])/ },
	{ label: "/parallel-handoff-plan", pattern: /(^|[^\w-])\/parallel-handoff-plan(?![\w-])/ },
	{ label: "/gather-context-and-clarify", pattern: /(^|[^\w-])\/gather-context-and-clarify(?![\w-])/ },
	{ label: "/parallel-cleanup", pattern: /(^|[^\w-])\/parallel-cleanup(?![\w-])/ },
	{ label: "/subagents-load-profile", pattern: /(^|[^\w-])\/subagents-load-profile(?![\w-])/ },
	{ label: "/subagents-refresh-provider-models", pattern: /(^|[^\w-])\/subagents-refresh-provider-models(?![\w-])/ },
	{ label: "/subagents-generate-profiles", pattern: /(^|[^\w-])\/subagents-generate-profiles(?![\w-])/ },
];

function collectTsFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectTsFiles(entryPath).forEach((file) => files.push(file));
		} else if (entry.name.endsWith(".ts")) {
			files.push(entryPath);
		}
	}
	return files;
}

function readProjectJson<T>(relativePath: string): T {
	return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf-8")) as T;
}

test("scoped package metadata stays pointed at the TLH fork", () => {
	const packageJson = readProjectJson<{
		name?: string;
		repository?: { url?: string };
		homepage?: string;
		bugs?: { url?: string };
		publishConfig?: { access?: string };
	}>("package.json");

	assert.equal(packageJson.name, scopedPackageName);
	assert.equal(packageJson.repository?.url, forkRepositoryUrl);
	assert.equal(packageJson.homepage, forkHomepageUrl);
	assert.equal(packageJson.bugs?.url, forkIssuesUrl);
	assert.equal(packageJson.publishConfig?.access, "public");
});

test("scoped package manifest does not expose the legacy npx installer", () => {
	const packageJson = readProjectJson<{
		bin?: Record<string, string>;
		files?: string[];
	}>("package.json");

	assert.equal(packageJson.bin, undefined);
	assert.equal((packageJson.files ?? []).includes("install.mjs"), false);
	assert.equal((packageJson.files ?? []).includes("*.mjs"), false);
});

test("package lock root metadata matches the scoped package manifest", () => {
	const packageJson = readProjectJson<{ name: string; version: string }>("package.json");
	const packageLock = readProjectJson<{
		name?: string;
		version?: string;
		packages?: { ""?: { name?: string; version?: string } };
	}>("package-lock.json");

	assert.equal(packageLock.name, packageJson.name);
	assert.equal(packageLock.version, packageJson.version);
	assert.equal(packageLock.packages?.[""].name, packageJson.name);
	assert.equal(packageLock.packages?.[""].version, packageJson.version);
});

test("README install metadata matches the scoped package manifest", () => {
	const packageJson = readProjectJson<{ name: string; version: string }>("package.json");
	const readme = fs.readFileSync(path.join(projectRoot, "README.md"), "utf-8");
	const encodedPackageName = encodeURIComponent(packageJson.name);

	assert.equal(readme.includes(`https://www.npmjs.com/package/${packageJson.name}`), true);
	assert.equal(readme.includes(`https://img.shields.io/npm/v/${encodedPackageName}`), true);
	assert.equal(readme.includes(`pi install npm:${packageJson.name}@${packageJson.version}`), true);
});

test("direct @earendil-works runtime imports are declared for CI installs", () => {
	const packageJson = readProjectJson<Record<string, Record<string, string>>>("package.json");
	const declared = new Set([
		...Object.keys(packageJson.dependencies ?? {}),
		...Object.keys(packageJson.devDependencies ?? {}),
	]);
	const imported = new Set<string>();

	for (const file of [...collectTsFiles(path.join(projectRoot, "src")), ...collectTsFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		for (const match of source.matchAll(sourceImportPattern)) {
			imported.add(match[1] ?? match[2]!);
		}
	}

	const missing = [...imported].filter((specifier) => !declared.has(specifier)).sort();
	assert.deepEqual(missing, []);
});

test("direct dependency declarations are exact version pins", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));

	for (const section of ["dependencies", "devDependencies"] as const) {
		for (const [name, version] of Object.entries<string>(packageJson[section] ?? {})) {
			assert.match(version, exactVersionPattern, `${section}.${name} should use an exact version`);
		}
	}
});

test("old pi package scope is not used by source or tests", () => {
	for (const file of [...collectTsFiles(path.join(projectRoot, "src")), ...collectTsFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		assert.equal(oldPiScopePattern.test(source), false, file);
	}
});

test("Pi package resolution stays export-map safe", () => {
	for (const file of [...collectTsFiles(path.join(projectRoot, "src")), ...collectTsFiles(path.join(projectRoot, "test"))]) {
		const source = fs.readFileSync(file, "utf-8");
		assert.equal(piPackageJsonSubpathPattern.test(source), false, `${file} should not resolve unexported package.json subpaths`);
		assert.equal(cjsPiPackageResolutionPattern.test(source), false, `${file} should not use CommonJS resolution for ESM-only Pi packages`);
	}
});

test("package manifest does not bundle prompt shortcut or skill assets", () => {
	const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
	assert.equal((packageJson.files ?? []).includes("prompts/**/*"), false);
	assert.equal((packageJson.files ?? []).includes("skills/**/*"), false);
	assert.equal("prompts" in (packageJson.pi ?? {}), false);
	assert.equal("skills" in (packageJson.pi ?? {}), false);
	assert.equal(fs.existsSync(path.join(projectRoot, "skills", "pi-subagents", "SKILL.md")), false);
});

test("README does not advertise removed slash workflow surfaces", () => {
	const docPath = path.join(projectRoot, "README.md");
	const source = fs.readFileSync(docPath, "utf-8");
	for (const removedSurface of removedSlashSurfaces) {
		assert.equal(removedSurface.pattern.test(source), false, `${path.relative(projectRoot, docPath)} should not advertise ${removedSurface.label}`);
	}
});
