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

test("actual install flow uninstalls managed npm subagents before extension refresh can resurrect it", (t) => {
	const root = makeTempDir("tlh-stage1-subagents-retirement-");
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const packageDir = join(root, "package-source");
	const runtimeDir = join(root, "runtime");
	const templatePi = join(root, "template-pi");
	const eventLog = join(root, "events.log");
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

	const result = runInstaller([
		"--agent-dir", agentDir,
		"--bin-dir", binDir,
		"--no-wrapper",
	], scrubInstallerEnv({
		HOME: homeDir,
		PATH: `${fakebin}:${process.env.PATH || ""}`,
		TLH_PACKAGE_SOURCE: packageDir,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	}));
	const output = `${result.stdout}\n${result.stderr}`;
	assert.equal(result.status, 0, output);
	assert.match(output, /Uninstalled retired TLH subagent npm package: @diegopetrucci\/pi-subagents/);

	const events = readFileSync(eventLog, "utf8").trim().split(/\r?\n/);
	const uninstallIndex = events.findIndex((line) => line.startsWith("pm:-- pnpm uninstall @diegopetrucci/pi-subagents"));
	const refreshIndex = events.findIndex((line) => line === "pi:update --extensions");
	assert.ok(uninstallIndex >= 0, `configured package manager was not called: ${events.join("\n")}`);
	assert.ok(refreshIndex > uninstallIndex, `extension refresh must run after uninstall: ${events.join("\n")}`);
	assert.equal(events.some((line) => line.startsWith("resurrected:")), false, "post-merge extension refresh must not resurrect subagents");

	const npmPackageJson = readJson(join(npmRoot, "package.json"));
	const npmPackageLock = readJson(join(npmRoot, "package-lock.json"));
	assert.equal(Object.hasOwn(npmPackageJson.dependencies, packageName), false, "package.json dependency must be removed");
	assert.equal(Object.hasOwn(npmPackageLock.packages[""].dependencies, packageName), false, "package-lock root dependency must be removed");
	assert.equal(Object.hasOwn(npmPackageLock.packages, `node_modules/${packageName}`), false, "package-lock package entry must be removed");
	assert.equal(existsSync(packageDirInNodeModules), false, "node_modules package must remain absent after refresh");

	const settings = readJson(join(agentDir, "settings.json"));
	assert.equal(settings.packages.some((entry) => String(typeof entry === "string" ? entry : entry.source).includes("pi-subagents")), false);
	assert.equal(settings.packages.includes("npm:keep-me"), true, "unrelated configured package must survive");
	assert.deepEqual(settings.userSetting, { keep: true }, "unrelated settings must survive");
	assert.deepEqual(settings.npmCommand, ["corepack", "--", "pnpm"], "configured package-manager command must survive");
	assert.ok(existsSync(join(runtimeDir, "bin", "pi")), "installer must complete with the private runtime intact");
});
