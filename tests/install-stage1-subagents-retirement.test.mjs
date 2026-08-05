import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { makeTempDir } from "./install-stage1-test-helpers.mjs";
import {
	TLH_PINNED_PI_VERSION,
	readJson,
	runInstaller,
	scrubInstallerEnv,
	writeFakeCommand,
	writeFakeTk,
} from "./install-stage1-core-test-helpers.mjs";

function writeExecutable(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
	chmodSync(path, 0o755);
}

test("actual install retries failed managed npm cleanup before merge and cannot resurrect it", (t) => {
	const root = makeTempDir("tlh-stage1-subagents-retirement-");
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const packageDir = join(root, "package-source");
	const runtimeDir = join(root, "runtime");
	const templatePi = join(root, "template-pi");
	const eventLog = join(root, "events.log");
	const uninstallAttemptsPath = join(root, "uninstall-attempts.txt");
	const packageName = "@diegopetrucci/pi-subagents";
	const npmRoot = join(agentDir, "npm");
	const packageDirInNodeModules = join(npmRoot, "node_modules", packageName);
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(packageDirInNodeModules, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		packages: [
			"npm:@diegopetrucci/pi-subagents@0.31.14",
			"npm:keep-me",
		],
		npmCommand: ["corepack", "--", "pnpm"],
		userSetting: { keep: true },
		tlh: {
			defaultExtensionProvenance: {
				managedPackageIdentities: ["npm:@diegopetrucci/pi-subagents"],
			},
		},
	}, null, 2));
	writeFileSync(join(npmRoot, "package.json"), JSON.stringify({
		dependencies: {
			[packageName]: "^0.31.10",
			"keep-me": "1.0.0",
		},
	}, null, 2));
	writeFileSync(join(npmRoot, "package-lock.json"), JSON.stringify({
		lockfileVersion: 3,
		packages: {
			"": { dependencies: { [packageName]: "^0.31.10", "keep-me": "1.0.0" } },
			[`node_modules/${packageName}`]: { version: "0.31.14" },
			"node_modules/keep-me": { version: "1.0.0" },
		},
	}, null, 2));
	writeFileSync(join(packageDirInNodeModules, "package.json"), JSON.stringify({ name: packageName, version: "0.31.14" }));

	writeExecutable(templatePi, `#!/usr/bin/env bash
set -euo pipefail
printf 'pi:%s\n' "$*" >>${JSON.stringify(eventLog)}
if [[ "\${1:-}" == "--version" ]]; then printf '${TLH_PINNED_PI_VERSION}\n'; exit 0; fi
if [[ "\${1:-}" == "update" && "\${2:-}" == "--extensions" ]]; then
  node --input-type=module - "\${PI_CODING_AGENT_DIR}/npm" ${JSON.stringify(eventLog)} ${JSON.stringify(packageName)} <<'NODE'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [installRoot, eventLog, packageName] = process.argv.slice(2);
const packageJsonPath = join(installRoot, "package.json");
if (existsSync(packageJsonPath)) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (Object.hasOwn(packageJson.dependencies || {}, packageName)) {
    const packageDir = join(installRoot, "node_modules", packageName);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: packageName, resurrected: true }));
    appendFileSync(eventLog, "resurrected:" + packageName + "\\n");
  }
}
NODE
fi
exit 0
`);

	writeFakeCommand(fakebin, "npm", [
		`printf 'npm:%s\\n' "$*" >>${JSON.stringify(eventLog)}`,
		`prefix=""`,
		`previous=""`,
		`for argument in "$@"; do if [[ "$previous" == "--prefix" ]]; then prefix="$argument"; fi; previous="$argument"; done`,
		`if [[ "\${1:-}" == "install" && "\${2:-}" == "-g" ]]; then`,
		`  mkdir -p "$prefix/bin"`,
		`  cp ${JSON.stringify(templatePi)} "$prefix/bin/pi"`,
		`  chmod +x "$prefix/bin/pi"`,
		`fi`,
	].join("\n"));
	writeExecutable(join(fakebin, "corepack"), `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(eventLog)}, "pm:" + args.join(" ") + "\\n");
if (args[0] !== "--" || args[1] !== "pnpm" || args[2] !== "uninstall") process.exit(91);
const previousAttempts = existsSync(${JSON.stringify(uninstallAttemptsPath)})
  ? Number(readFileSync(${JSON.stringify(uninstallAttemptsPath)}, "utf8"))
  : 0;
writeFileSync(${JSON.stringify(uninstallAttemptsPath)}, String(previousAttempts + 1));
if (previousAttempts === 0) {
  process.stderr.write("simulated package-manager failure\\n");
  process.exit(7);
}
const packageName = args[3];
const prefixIndex = args.indexOf("--prefix");
const installRoot = args[prefixIndex + 1];
const packageJsonPath = join(installRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
delete packageJson.dependencies?.[packageName];
writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
const lockPath = join(installRoot, "package-lock.json");
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  delete lock.packages?.[""]?.dependencies?.[packageName];
  delete lock.packages?.["node_modules/" + packageName];
  writeFileSync(lockPath, JSON.stringify(lock, null, 2));
}
rmSync(join(installRoot, "node_modules", packageName), { recursive: true, force: true });
`);
	writeFakeCommand(fakebin, "git", "exit 0");
	writeFakeTk(fakebin);

	const installArgs = [
		"--agent-dir", agentDir,
		"--bin-dir", binDir,
		"--no-wrapper",
	];
	const installEnv = scrubInstallerEnv({
		HOME: homeDir,
		PATH: `${fakebin}:${process.env.PATH || ""}`,
		TLH_PACKAGE_SOURCE: packageDir,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});

	const firstResult = runInstaller(installArgs, installEnv);
	const firstOutput = `${firstResult.stdout}\n${firstResult.stderr}`;
	assert.equal(firstResult.status, 1, firstOutput);
	assert.match(firstOutput, /failed to uninstall retired TLH subagent npm package.*simulated package-manager failure/);

	const failedSettings = readJson(join(agentDir, "settings.json"));
	assert.equal(
		failedSettings.packages.includes("npm:@diegopetrucci/pi-subagents@0.31.14"),
		true,
		"failed cleanup must leave the managed package entry available for retry",
	);
	assert.equal(
		failedSettings.tlh.defaultExtensionProvenance.managedPackageIdentities.includes("npm:@diegopetrucci/pi-subagents"),
		true,
		"failed cleanup must leave ownership provenance available for retry",
	);
	assert.equal(Object.hasOwn(readJson(join(npmRoot, "package.json")).dependencies, packageName), true);
	assert.equal(existsSync(packageDirInNodeModules), true);

	const firstEvents = readFileSync(eventLog, "utf8").trim().split(/\r?\n/);
	assert.equal(firstEvents.filter((line) => line.startsWith("pm:-- pnpm uninstall")).length, 1);
	assert.equal(firstEvents.includes("pi:update --extensions"), false, "failed cleanup must abort before extension refresh");

	// Installer preflight backups use second-resolution names; cross the boundary
	// so this retry exercises retirement recovery rather than backup collision handling.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
	const secondResult = runInstaller(installArgs, installEnv);
	const secondOutput = `${secondResult.stdout}\n${secondResult.stderr}`;
	assert.equal(secondResult.status, 0, secondOutput);
	assert.match(secondOutput, /Uninstalled retired TLH subagent npm package: @diegopetrucci\/pi-subagents/);

	const allEvents = readFileSync(eventLog, "utf8").trim().split(/\r?\n/);
	const secondEvents = allEvents.slice(firstEvents.length);
	const uninstallIndex = secondEvents.findIndex((line) => line.startsWith("pm:-- pnpm uninstall @diegopetrucci/pi-subagents"));
	const refreshIndex = secondEvents.findIndex((line) => line === "pi:update --extensions");
	assert.ok(uninstallIndex >= 0, `configured package manager was not retried: ${secondEvents.join("\n")}`);
	assert.ok(refreshIndex > uninstallIndex, `extension refresh must run after uninstall and settings merge: ${secondEvents.join("\n")}`);
	assert.equal(secondEvents.some((line) => line.startsWith("resurrected:")), false, "post-merge extension refresh must not resurrect subagents");

	const npmPackageJson = readJson(join(npmRoot, "package.json"));
	const npmPackageLock = readJson(join(npmRoot, "package-lock.json"));
	assert.equal(Object.hasOwn(npmPackageJson.dependencies, packageName), false, "package.json dependency must be removed");
	assert.equal(Object.hasOwn(npmPackageLock.packages[""].dependencies, packageName), false, "package-lock root dependency must be removed");
	assert.equal(Object.hasOwn(npmPackageLock.packages, `node_modules/${packageName}`), false, "package-lock package entry must be removed");
	assert.equal(existsSync(packageDirInNodeModules), false, "node_modules package must remain absent after refresh");

	const settings = readJson(join(agentDir, "settings.json"));
	assert.equal(settings.packages.some((entry) => String(typeof entry === "string" ? entry : entry.source).includes("pi-subagents")), false);
	assert.equal(settings.packages.includes("npm:keep-me"), true, "unrelated configured package must survive");
	assert.equal(settings.tlh.defaultExtensionProvenance.managedPackageIdentities.includes("npm:@diegopetrucci/pi-subagents"), false);
	assert.deepEqual(settings.userSetting, { keep: true }, "unrelated settings must survive");
	assert.deepEqual(settings.npmCommand, ["corepack", "--", "pnpm"], "configured package-manager command must survive");
	assert.ok(existsSync(join(runtimeDir, "bin", "pi")), "installer must complete with the private runtime intact");

	// A malformed command setting is unrelated once no retired candidate remains.
	settings.npmCommand = "npm";
	const malformedSettingsRaw = JSON.stringify(settings, null, 2);
	writeFileSync(join(agentDir, "settings.json"), malformedSettingsRaw);
	const dryRunResult = runInstaller(["--dry-run", ...installArgs], installEnv);
	const dryRunOutput = `${dryRunResult.stdout}\n${dryRunResult.stderr}`;
	assert.equal(dryRunResult.status, 0, dryRunOutput);
	assert.doesNotMatch(dryRunOutput, /invalid npmCommand/);
	assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), malformedSettingsRaw, "dry-run must not rewrite settings");
	assert.equal(readFileSync(uninstallAttemptsPath, "utf8"), "2", "no retired candidate means no package-manager invocation");
});
