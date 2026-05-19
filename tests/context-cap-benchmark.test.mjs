import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
	DEFAULT_CONTEXT_CAP_SOURCE,
	buildInstallInvocation,
	materializeTreatmentPackage,
	parseArgs,
	resolveDefaultExtensionTarget,
	scrubbedEnv,
	validateRunSettings,
	validateTreatmentPackage,
} from "../scripts/benchmark-context-cap-embedding.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

function tempDir(t, prefix = "tlh-default-extension-benchmark-test-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function writeFakePackage(root, {
	name = "@example/pi-extension",
	version = "1.0.0",
	pi = { extensions: ["index.ts"] },
	dependencies = undefined,
	files = {},
} = {}) {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({
		name,
		version,
		...(dependencies ? { dependencies } : {}),
		pi,
	}, null, 2));
	for (const [relativePath, content] of Object.entries(files)) {
		const target = join(root, relativePath);
		mkdirSync(resolve(target, ".."), { recursive: true });
		writeFileSync(target, content);
	}
}

function writeFakeContextCapPackage(root) {
	writeFakePackage(root, {
		name: "@example/pi-context-cap",
		pi: { extensions: ["index.ts"] },
		files: {
			"index.ts": "export default function contextCap(pi) { pi.registerCommand('context-cap', { handler() {} }); }\n",
		},
	});
}

function writeInstalledPackage(agentDir, packageName, packageJson) {
	const packageJsonPath = join(agentDir, "npm", "node_modules", ...packageName.split("/"), "package.json");
	mkdirSync(resolve(packageJsonPath, ".."), { recursive: true });
	writeFileSync(packageJsonPath, JSON.stringify({ name: packageName, version: "1.0.0", ...packageJson }, null, 2));
	return packageJsonPath;
}

test("parseArgs defaults to context-cap across cold and warm cache modes", () => {
	assert.deepEqual(parseArgs([]), {
		runs: 10,
		cacheMode: "both",
		outputDir: "",
		extensionId: "context-cap",
		extensionSource: "",
		embedSource: "",
		keepTemp: false,
		verboseInstaller: false,
		help: false,
	});
	assert.equal(parseArgs(["--runs", "3", "--cache-mode", "cold"]).runs, 3);
	assert.equal(parseArgs(["--extension-id", "plannotator"]).extensionId, "plannotator");
	assert.deepEqual(
		{ extensionId: parseArgs(["--extension-source", "npm:@ff-labs/pi-fff"]).extensionId, extensionSource: parseArgs(["--extension-source", "npm:@ff-labs/pi-fff"]).extensionSource },
		{ extensionId: "", extensionSource: "npm:@ff-labs/pi-fff" },
	);
	const contextCapOverride = parseArgs(["--context-cap-source", "npm:@example/context-cap"]);
	assert.deepEqual(
		{
			extensionId: contextCapOverride.extensionId,
			extensionSource: contextCapOverride.extensionSource,
			embedSource: contextCapOverride.embedSource,
		},
		{ extensionId: "context-cap", extensionSource: "", embedSource: "npm:@example/context-cap" },
	);
	assert.equal(parseArgs(["--context-cap-source", "npm:@example/context-cap", "--extension-id", "context-cap"]).extensionId, "context-cap");
	assert.equal(parseArgs(["--extension-source", DEFAULT_CONTEXT_CAP_SOURCE, "--context-cap-source", "npm:@example/context-cap"]).extensionSource, DEFAULT_CONTEXT_CAP_SOURCE);
	for (const argv of [
		["--context-cap-source", "npm:@example/context-cap", "--extension-id", "plannotator"],
		["--extension-id", "plannotator", "--context-cap-source", "npm:@example/context-cap"],
		["--context-cap-source", "npm:@example/context-cap", "--extension-source", "npm:@ff-labs/pi-fff"],
		["--extension-source", "npm:@ff-labs/pi-fff", "--context-cap-source", "npm:@example/context-cap"],
	]) {
		assert.throws(() => parseArgs(argv), /--context-cap-source can only be used with the context-cap target/);
	}
	assert.throws(() => parseArgs(["--runs", "0"]), /positive integer/);
	assert.throws(() => parseArgs(["--cache-mode", "tepid"]), /--cache-mode/);
});

test("default extension target can be resolved by id or source for supported packages", () => {
	assert.equal(resolveDefaultExtensionTarget({ packageRoot: repoRoot, extensionId: "context-cap" }).source, "npm:@diegopetrucci/pi-context-cap");
	assert.equal(resolveDefaultExtensionTarget({ packageRoot: repoRoot, extensionId: "plannotator" }).source, "npm:@plannotator/pi-extension");
	assert.equal(resolveDefaultExtensionTarget({ packageRoot: repoRoot, extensionSource: "npm:@ff-labs/pi-fff" }).id, "fff");
});

test("treatment package embeds context-cap and removes it from default extensions", (t) => {
	const root = tempDir(t);
	const contextCapRoot = join(root, "fake-context-cap");
	const treatmentRoot = join(root, "treatment");
	writeFakeContextCapPackage(contextCapRoot);
	const targetExtension = resolveDefaultExtensionTarget({ packageRoot: repoRoot, extensionId: "context-cap" });

	const treatment = materializeTreatmentPackage({
		sourceRoot: repoRoot,
		targetRoot: treatmentRoot,
		selectedPackageRoot: contextCapRoot,
		targetExtension,
	});
	const validation = validateTreatmentPackage(treatmentRoot, {
		targetExtension,
		expectedEmbeddedResources: treatment.embeddedResources,
	});
	const manifest = JSON.parse(readFileSync(join(treatmentRoot, "config", "default-extensions.json"), "utf8"));
	const packageJson = JSON.parse(readFileSync(join(treatmentRoot, "package.json"), "utf8"));

	assert.equal(treatment.removedDefaultExtensions.length, 1);
	assert.equal(treatment.removedDefaultExtensions[0].id, "context-cap");
	assert.equal(manifest.some((entry) => entry.id === "context-cap"), false);
	assert.ok(manifest.some((entry) => entry.id === "plannotator"));
	assert.ok(packageJson.pi.extensions.includes("./extensions/embedded/context-cap/index.ts"));
	assert.equal(existsSync(join(treatmentRoot, "extensions", "embedded", "context-cap", "index.ts")), true);
	assert.deepEqual(validation, {
		ok: true,
		errors: [],
		targetExtension: {
			id: "context-cap",
			source: "npm:@diegopetrucci/pi-context-cap",
		},
		embeddedResources: {
			extensions: ["./extensions/embedded/context-cap/index.ts"],
		},
		embeddedExtensions: ["./extensions/embedded/context-cap/index.ts"],
		manifestHasTarget: false,
		manifestHasContextCap: false,
		registersContextCapCommand: true,
	});
});

test("treatment package embeds Plannotator extensions and skills", (t) => {
	const root = tempDir(t);
	const plannotatorRoot = join(root, "fake-plannotator");
	const treatmentRoot = join(root, "treatment");
	writeFakePackage(plannotatorRoot, {
		name: "@example/pi-plannotator",
		pi: { extensions: ["extension.ts"], skills: ["skills"] },
		files: {
			"extension.ts": "export default function plannotator() {}\n",
			"skills/review.md": "# Review plan\n",
		},
	});
	const targetExtension = resolveDefaultExtensionTarget({ packageRoot: repoRoot, extensionId: "plannotator" });

	const treatment = materializeTreatmentPackage({
		sourceRoot: repoRoot,
		targetRoot: treatmentRoot,
		selectedPackageRoot: plannotatorRoot,
		targetExtension,
	});
	const validation = validateTreatmentPackage(treatmentRoot, {
		targetExtension,
		expectedEmbeddedResources: treatment.embeddedResources,
	});
	const manifest = JSON.parse(readFileSync(join(treatmentRoot, "config", "default-extensions.json"), "utf8"));
	const packageJson = JSON.parse(readFileSync(join(treatmentRoot, "package.json"), "utf8"));

	assert.equal(treatment.removedDefaultExtensions.length, 1);
	assert.equal(treatment.removedDefaultExtensions[0].id, "plannotator");
	assert.equal(manifest.some((entry) => entry.id === "plannotator"), false);
	assert.ok(manifest.some((entry) => entry.id === "context-cap"));
	assert.ok(manifest.some((entry) => entry.id === "fff"));
	assert.ok(packageJson.pi.extensions.includes("./extensions/embedded/plannotator/extension.ts"));
	assert.ok(packageJson.pi.skills.includes("./extensions/embedded/plannotator/skills"));
	assert.equal(existsSync(join(treatmentRoot, "extensions", "embedded", "plannotator", "skills", "review.md")), true);
	assert.equal(validation.ok, true);
	assert.equal(validation.manifestHasTarget, false);
	assert.equal(validation.manifestHasContextCap, true);
	assert.deepEqual(validation.embeddedResources, {
		extensions: ["./extensions/embedded/plannotator/extension.ts"],
		skills: ["./extensions/embedded/plannotator/skills"],
	});
	assert.equal(validation.registersContextCapCommand, null);

	writeFileSync(join(treatmentRoot, "config", "default-extensions.json"), JSON.stringify(manifest.filter((entry) => entry.id !== "context-cap"), null, 2));
	const missingContextCapValidation = validateTreatmentPackage(treatmentRoot, {
		targetExtension,
		expectedEmbeddedResources: treatment.embeddedResources,
	});
	assert.equal(missingContextCapValidation.ok, false);
	assert.equal(missingContextCapValidation.manifestHasContextCap, false);
	assert.match(missingContextCapValidation.errors.join("\n"), /context-cap default extension is missing/);
});

test("treatment package records dependency caveats for dependency-heavy packages", (t) => {
	const root = tempDir(t);
	const fffRoot = join(root, "fake-fff");
	const treatmentRoot = join(root, "treatment");
	writeFakePackage(fffRoot, {
		name: "@example/pi-fff",
		dependencies: { "@ff-labs/fff": "^1.0.0" },
		pi: { extensions: ["dist/index.js"] },
		files: {
			"dist/index.js": "export default function fff() {}\n",
		},
	});
	const targetExtension = resolveDefaultExtensionTarget({ packageRoot: repoRoot, extensionId: "fff" });

	const treatment = materializeTreatmentPackage({
		sourceRoot: repoRoot,
		targetRoot: treatmentRoot,
		selectedPackageRoot: fffRoot,
		targetExtension,
	});
	const validation = validateTreatmentPackage(treatmentRoot, {
		targetExtension,
		expectedEmbeddedResources: treatment.embeddedResources,
	});

	assert.equal(treatment.removedDefaultExtensions[0].id, "fff");
	assert.equal(validation.ok, true);
	assert.equal(validation.manifestHasContextCap, true);
	assert.deepEqual(treatment.embeddedResources, {
		extensions: ["./extensions/embedded/fff/dist/index.js"],
	});
	assert.equal(treatment.dependencyCaveats.hasRuntimeDependencies, true);
	assert.deepEqual(treatment.dependencyCaveats.dependencies, ["@ff-labs/fff"]);
	assert.equal(treatment.dependencyCaveats.treatmentMergesDependencies, false);
	assert.equal(treatment.dependencyCaveats.validatesRuntimeBehavior, false);
	assert.match(treatment.dependencyCaveats.notes.join("\n"), /does not merge the selected package dependencies/);
});

test("install invocation uses temp dirs, no wrapper, no gnosis, and a temp npm cache", (t) => {
	const root = tempDir(t);
	const variant = {
		name: "treatment",
		installerRoot: join(root, "pkg"),
		packageRoot: join(root, "pkg"),
	};
	const baseEnv = {
		PATH: process.env.PATH || "",
		PI_CODING_AGENT_DIR: "/poison/pi",
		PI_OFFLINE: "1",
		TLH_AGENT_DIR: "/poison/tlh",
		NPM_CONFIG_CACHE: "/poison/npm-cache",
	};
	const invocation = buildInstallInvocation({
		variant,
		agentDir: join(root, "agent"),
		binDir: join(root, "bin"),
		cacheDir: join(root, "cache"),
		baseEnv,
	});

	assert.deepEqual(invocation.command.slice(0, 4), ["bash", "install.sh", "--track", "custom"]);
	assert.ok(invocation.command.includes("--without-gnosis"));
	assert.ok(invocation.command.includes("--no-wrapper"));
	assert.ok(invocation.command.includes("--no-pi-install"));
	assert.ok(invocation.command.includes("--quiet"));
	assert.equal(invocation.env.TLH_PACKAGE_SOURCE, variant.packageRoot);
	assert.equal(invocation.env.NPM_CONFIG_CACHE, join(root, "cache"));
	assert.equal(Object.hasOwn(invocation.env, "PI_CODING_AGENT_DIR"), false);
	assert.equal(Object.hasOwn(invocation.env, "PI_OFFLINE"), false);
	assert.equal(Object.hasOwn(invocation.env, "TLH_AGENT_DIR"), false);
	assert.equal(invocation.envDescription.inheritsParentEnv, true);
	assert.deepEqual(invocation.envDescription.unsetIfPresent, ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "TLH_*", "NPM_CONFIG_CACHE", "npm_config_cache"]);
	assert.deepEqual(invocation.envDescription.unset, ["NPM_CONFIG_CACHE", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "TLH_AGENT_DIR"]);
});

test("control run validation requires the managed npm target package to be installed", (t) => {
	const root = tempDir(t);
	const agentDir = join(root, "agent");
	const packageSource = join(root, "pkg");
	const targetSource = "npm:@diegopetrucci/pi-context-cap";
	const settingsPath = join(agentDir, "settings.json");
	const packageJsonPath = join(agentDir, "npm", "node_modules", "@diegopetrucci", "pi-context-cap", "package.json");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(settingsPath, JSON.stringify({ packages: [packageSource, targetSource] }, null, 2));

	const missingPackage = validateRunSettings({
		settingsPath,
		agentDir,
		variantName: "control",
		targetSource,
		targetId: "context-cap",
		packageSource,
	});
	assert.equal(missingPackage.ok, false);
	assert.equal(missingPackage.targetDefaultPackageName, "@diegopetrucci/pi-context-cap");
	assert.equal(missingPackage.targetDefaultPackageJsonPath, packageJsonPath);
	assert.equal(missingPackage.targetDefaultPackageInstalled, false);
	assert.equal(missingPackage.contextCapDefaultPackageName, "@diegopetrucci/pi-context-cap");
	assert.equal(missingPackage.contextCapDefaultPackageInstalled, false);
	assert.match(missingPackage.errors.join("\n"), /control npm context-cap package was not installed/);

	mkdirSync(join(agentDir, "npm", "node_modules", "@diegopetrucci", "pi-context-cap"), { recursive: true });
	writeFileSync(packageJsonPath, JSON.stringify({ name: "@diegopetrucci/pi-context-cap", version: "1.2.3" }, null, 2));
	const installedPackage = validateRunSettings({
		settingsPath,
		agentDir,
		variantName: "control",
		targetSource,
		targetId: "context-cap",
		packageSource,
	});
	assert.equal(installedPackage.ok, true);
	assert.equal(installedPackage.targetDefaultPackageInstalled, true);
	assert.equal(installedPackage.targetDefaultPackageVersion, "1.2.3");
	assert.equal(installedPackage.contextCapDefaultPackageInstalled, true);
	assert.equal(installedPackage.contextCapDefaultPackageVersion, "1.2.3");
});

test("control run validation tracks the target and context-cap packages independently", (t) => {
	const root = tempDir(t);
	const agentDir = join(root, "agent");
	const packageSource = join(root, "pkg");
	const targetSource = "npm:@ff-labs/pi-fff";
	const settingsPath = join(agentDir, "settings.json");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(settingsPath, JSON.stringify({ packages: [packageSource, targetSource, DEFAULT_CONTEXT_CAP_SOURCE] }, null, 2));
	writeInstalledPackage(agentDir, "@ff-labs/pi-fff", { version: "2.0.0" });

	const missingContextCap = validateRunSettings({
		settingsPath,
		agentDir,
		variantName: "control",
		targetSource,
		targetId: "fff",
		packageSource,
	});
	assert.equal(missingContextCap.ok, false);
	assert.equal(missingContextCap.targetDefaultPackageName, "@ff-labs/pi-fff");
	assert.equal(missingContextCap.targetDefaultPackageInstalled, true);
	assert.equal(missingContextCap.contextCapDefaultPackageName, "@diegopetrucci/pi-context-cap");
	assert.equal(missingContextCap.contextCapDefaultPackageInstalled, false);
	assert.match(missingContextCap.errors.join("\n"), /control npm context-cap package was not installed/);

	writeInstalledPackage(agentDir, "@diegopetrucci/pi-context-cap", { version: "1.2.3" });
	const installedPackages = validateRunSettings({
		settingsPath,
		agentDir,
		variantName: "control",
		targetSource,
		targetId: "fff",
		packageSource,
	});
	assert.equal(installedPackages.ok, true);
	assert.equal(installedPackages.targetDefaultPackageInstalled, true);
	assert.equal(installedPackages.targetDefaultPackageVersion, "2.0.0");
	assert.equal(installedPackages.contextCapDefaultPackageInstalled, true);
	assert.equal(installedPackages.contextCapDefaultPackageVersion, "1.2.3");
});

test("treatment run validation keeps context-cap installed while requiring the target source to be absent", (t) => {
	const root = tempDir(t);
	const agentDir = join(root, "agent");
	const packageSource = join(root, "pkg");
	const targetSource = "npm:@ff-labs/pi-fff";
	const settingsPath = join(agentDir, "settings.json");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(settingsPath, JSON.stringify({ packages: [packageSource] }, null, 2));

	const missingContextCapSource = validateRunSettings({
		settingsPath,
		agentDir,
		variantName: "treatment",
		targetSource,
		targetId: "fff",
		packageSource,
	});
	assert.equal(missingContextCapSource.ok, false);
	assert.equal(missingContextCapSource.targetDefaultSourcePresent, false);
	assert.equal(missingContextCapSource.contextCapDefaultSourcePresent, false);
	assert.match(missingContextCapSource.errors.join("\n"), /treatment settings do not include the npm context-cap default source/);

	writeFileSync(settingsPath, JSON.stringify({ packages: [packageSource, DEFAULT_CONTEXT_CAP_SOURCE] }, null, 2));
	const missingContextCapPackage = validateRunSettings({
		settingsPath,
		agentDir,
		variantName: "treatment",
		targetSource,
		targetId: "fff",
		packageSource,
	});
	assert.equal(missingContextCapPackage.ok, false);
	assert.equal(missingContextCapPackage.targetDefaultPackageName, "@ff-labs/pi-fff");
	assert.equal(missingContextCapPackage.targetDefaultPackageInstalled, false);
	assert.equal(missingContextCapPackage.contextCapDefaultPackageName, "@diegopetrucci/pi-context-cap");
	assert.equal(missingContextCapPackage.contextCapDefaultPackageInstalled, false);
	assert.match(missingContextCapPackage.errors.join("\n"), /treatment npm context-cap package was not installed/);

	writeInstalledPackage(agentDir, "@diegopetrucci/pi-context-cap", { version: "1.2.3" });
	const absent = validateRunSettings({
		settingsPath,
		agentDir,
		variantName: "treatment",
		targetSource,
		targetId: "fff",
		packageSource,
	});
	assert.equal(absent.ok, true);
	assert.equal(absent.targetDefaultSourcePresent, false);
	assert.equal(absent.targetDefaultPackageInstalled, false);
	assert.equal(absent.contextCapDefaultSourcePresent, true);
	assert.equal(absent.contextCapDefaultPackageInstalled, true);
	assert.equal(absent.contextCapDefaultPackageVersion, "1.2.3");

	writeFileSync(settingsPath, JSON.stringify({ packages: [packageSource, DEFAULT_CONTEXT_CAP_SOURCE, targetSource] }, null, 2));
	const present = validateRunSettings({
		settingsPath,
		agentDir,
		variantName: "treatment",
		targetSource,
		targetId: "fff",
		packageSource,
	});
	assert.equal(present.ok, false);
	assert.match(present.errors.join("\n"), /treatment settings still include the npm fff default source/);
});

test("scrubbedEnv removes inherited TLH, PI_OFFLINE, and npm cache variables before applying overrides", () => {
	const env = scrubbedEnv({
		PATH: "/bin",
		TLH_BIN_DIR: "/poison/bin",
		PI_CODING_AGENT_DIR: "/poison/pi",
		PI_OFFLINE: "1",
		npm_config_cache: "/poison/lower-cache",
	}, {
		NPM_CONFIG_CACHE: "/tmp/cache",
	});

	assert.deepEqual(env, {
		PATH: "/bin",
		NPM_CONFIG_CACHE: "/tmp/cache",
	});
});
