import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// This test file exists because typescript-eslint 8 declares a peer dependency of
// typescript >=4.8.4 <6.1.0 and cannot resolve TypeScript 7 directly.  eslint.config.mjs
// installs a module-resolution hook (registerHooks) that redirects the bare "typescript"
// specifier to "@typescript/typescript6", which re-exports typescript@6.0.3, so that
// typescript-eslint sees a compatible compiler while the rest of the project uses TypeScript 7.
//
// This file can be deleted (along with the registerHooks shim in eslint.config.mjs and the
// @typescript/typescript6 package) once typescript-eslint supports TypeScript 7.

const repoRoot = resolve(import.meta.dirname, "..");

function readPackageJson() {
	return JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
}

function parseNpmSpecVersion(spec) {
	// Parse the version from an "npm:package@version" specifier, e.g. "npm:typescript@6.0.3" → "6.0.3"
	const match = /^npm:[^@]+@(.+)$/.exec(spec);
	if (!match) {
		throw new Error(`Cannot parse version from npm spec: ${spec}`);
	}
	return match[1];
}

test("typescript resolves to the TypeScript 6 compatibility API after eslint.config.mjs is loaded", () => {
	const pkg = readPackageJson();
	const ts6Spec = pkg.overrides["@typescript/typescript6"]["@typescript/old"];
	const expectedVersion = parseNpmSpecVersion(ts6Spec);

	// registerHooks mutates module resolution process-wide, so the hooked assertion runs in a
	// child process.  Running it in-process would leak the hook into sibling tests and make
	// failures order-dependent.  The child imports the real eslint.config.mjs so this test
	// guards the actual config, not a re-implementation of the hook.
	const eslintConfigUrl = pathToFileURL(resolve(repoRoot, "eslint.config.mjs")).href;
	const childCode = [
		`await import(${JSON.stringify(eslintConfigUrl)});`,
		`const { default: ts } = await import("typescript");`,
		`process.stdout.write(ts.version + "\\n");`,
	].join("\n");

	const result = spawnSync(process.execPath, ["--input-type=module"], {
		input: childCode,
		cwd: repoRoot,
		encoding: "utf8",
	});

	assert.equal(result.status, 0, `Child process failed:\n${result.stderr}`);
	const resolvedVersion = result.stdout.trim();
	assert.equal(
		resolvedVersion,
		expectedVersion,
		`After eslint.config.mjs is loaded, the bare "typescript" specifier must resolve to the TypeScript 6 ` +
			`compatibility API (expected ${expectedVersion} per package.json overrides["@typescript/typescript6"]["@typescript/old"], ` +
			`got ${resolvedVersion}). A regression here means typescript-eslint receives an incompatible TypeScript version.`,
	);
});

test("root tsc entrypoint reports TypeScript 7", () => {
	const pkg = readPackageJson();
	const expectedVersion = pkg.devDependencies.typescript;

	// Resolve the tsc entrypoint the same way resolveTscEntrypoint() does in scripts/runtime-typescript.mjs,
	// consistent with how "npm run typecheck" (node node_modules/typescript/bin/tsc --noEmit) runs tsc.
	const typescriptPackagePath = fileURLToPath(import.meta.resolve("typescript/package.json"));
	const typescriptPackage = JSON.parse(readFileSync(typescriptPackagePath, "utf8"));
	const tscBinRelPath = typeof typescriptPackage.bin === "string" ? typescriptPackage.bin : typescriptPackage.bin?.tsc;
	assert.ok(tscBinRelPath, "typescript/package.json must declare a tsc executable in its bin field");
	const tscEntrypoint = resolve(dirname(typescriptPackagePath), tscBinRelPath);

	const result = spawnSync(process.execPath, [tscEntrypoint, "--version"], {
		cwd: repoRoot,
		encoding: "utf8",
	});

	assert.equal(result.status, 0, `tsc --version failed:\n${result.stderr}`);
	// tsc outputs "Version X.Y.Z"; strip the prefix to get the bare semver.
	const reportedVersion = result.stdout.trim().replace(/^Version\s+/i, "");
	assert.equal(
		reportedVersion,
		expectedVersion,
		`The root tsc entrypoint must report TypeScript ${expectedVersion} (from package.json devDependencies.typescript), ` +
			`got ${reportedVersion}. A regression here means "npm run typecheck" uses the wrong TypeScript version.`,
	);
});
