import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import { makeTempDir, readPiLogRecords } from "./install-stage1-test-helpers.mjs";
import {
	TLH_NON_PINNED_PI_VERSION,
	TLH_PI_PACKAGE_SPEC,
	TLH_PINNED_PI_VERSION,
	escapeRegExp,
	readJson,
	repoRoot,
	runInstaller,
	runStage1LocalPackageInstall,
	safeInstallerPath,
	scrubInstallerEnv,
	writeFakeCommand,
	writeFakeNpmInstaller,
	writeFakePi,
	writeFakeTk,
	writeLoggingPi,
} from "./install-stage1-core-test-helpers.mjs";

import {
	MIN_NODE_VERSION,
	RUNTIME_MARKER_FILENAME,
	RUNTIME_OWNED_TOPLEVEL,
	assertSupportedNodeRuntime,
	nodeVersionMeetsMinimum,
} from "../scripts/tlh-install.mjs";

test("stage-1 enforces the TLH Node runtime minimum", () => {
	assert.equal(MIN_NODE_VERSION, "22.19.0");
	assert.equal(nodeVersionMeetsMinimum("22.18.9"), false);
	assert.equal(nodeVersionMeetsMinimum("22.19.0"), true);
	assert.equal(nodeVersionMeetsMinimum("23.0.0"), true);
	assert.doesNotThrow(() => assertSupportedNodeRuntime("v22.19.0"));
	assert.throws(
		() => assertSupportedNodeRuntime("22.18.9"),
		/Node\.js >= 22\.19\.0 is required \(found v22\.18\.9\)\. Install or upgrade Node\.js, then rerun the installer\./,
	);
	assert.throws(
		() => assertSupportedNodeRuntime("not-a-version"),
		/unable to determine Node\.js version; The Last Harness requires Node\.js >= 22\.19\.0\./,
	);
});

test("stage-1 repairs the TLH private Pi runtime to the pinned version when it is below the pin", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const packageDir = join(root, "package-source");
	const npmLog = join(root, "npm.log");
	const stalePiCallLog = join(root, "stale-pi.log");
	const repairedPiLog = join(root, "repaired-pi.log");
	const templateDir = join(root, "pi-template");
	const runtimeDir = join(root, "runtime");
	const runtimeBinDir = join(runtimeDir, "bin");
	const installedPiPath = join(runtimeBinDir, "pi");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify({
		schemaVersion: 1,
		repo: "diegopetrucci/the-last-harness",
		track: "ref",
		ref: "main",
		packageSource: packageDir,
		packageSourceIsDefault: false,
		piInstalledByTlh: true,
	}, null, 2));
	writeFakeCommand(fakebin, "git", "exit 0");
	writeFakeTk(fakebin);
	// Seed a stale private runtime binary at the expected path (version 0.80.2 is below pin).
	writeFakePi(runtimeBinDir, [
		`printf '%s|%s|%s\\n' "\${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${stalePiCallLog}"`,
		"if [[ \"${1:-}\" == \"--version\" ]]; then printf '0.80.2\\n'; exit 0; fi",
		"exit 0",
	].join("\n"));
	writeLoggingPi(templateDir, repairedPiLog, TLH_PINNED_PI_VERSION);
	writeFakeNpmInstaller(fakebin, {
		npmLog,
		templatePiPath: join(templateDir, "pi"),
		installedPiPath,
	});

	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: safeInstallerPath(fakebin),
		TLH_PACKAGE_SOURCE: packageDir,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});
	const result = runInstaller([
		"--agent-dir", agentDir,
		"--bin-dir", binDir,
		"--no-settings",
		"--no-wrapper",
	], env);
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 0, output);
	assert.match(output, new RegExp(`Repairing TLH private Pi runtime to pinned ${escapeRegExp(TLH_PINNED_PI_VERSION)}`));
	assert.deepEqual(readFileSync(npmLog, "utf8").trim().split(/\r?\n/).filter(Boolean), [
		`install -g --ignore-scripts --prefix ${runtimeDir} ${TLH_PI_PACKAGE_SPEC}`,
	]);
	// The stale pi was only probed for --version; the repaired pi is first validated
	// for --version (post-install check) and then ran install+update.
	assert.deepEqual(readPiLogRecords(stalePiCallLog).map((record) => record.command), ["--version"]);
	assert.deepEqual(readPiLogRecords(repairedPiLog).map((record) => record.command), [
		"--version",
		`install ${packageDir}`,
		`update ${packageDir}`,
	]);
	const state = readJson(join(agentDir, "tlh", "install-state.json"));
	assert.equal(state.piInstalledByTlh, true);
});

test("stage-1 repairs the TLH private Pi runtime even when a supported Pi exists on PATH", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const supportedPiDir = join(root, "supported-pi");
	const packageDir = join(root, "package-source");
	const npmLog = join(root, "npm.log");
	const pathPiLog = join(root, "path-pi.log");
	const stalePiCallLog = join(root, "stale-pi.log");
	const repairedPiLog = join(root, "repaired-pi.log");
	const templateDir = join(root, "pi-template");
	const runtimeDir = join(root, "runtime");
	const runtimeBinDir = join(runtimeDir, "bin");
	const installedPiPath = join(runtimeBinDir, "pi");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify({
		schemaVersion: 1,
		repo: "diegopetrucci/the-last-harness",
		track: "ref",
		ref: "main",
		packageSource: packageDir,
		packageSourceIsDefault: false,
		piInstalledByTlh: true,
	}, null, 2));
	writeFakeCommand(fakebin, "git", "exit 0");
	writeFakeTk(fakebin);
	// A non-pinned PATH pi — the installer must never use it (private runtime only).
	writeFakePi(supportedPiDir, [
		`printf '%s|%s|%s\\n' "\${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${pathPiLog}"`,
		`if [[ "\${1:-}" == "--version" ]]; then printf '${TLH_NON_PINNED_PI_VERSION}\\n'; exit 0; fi`,
		"exit 0",
	].join("\n"));
	// Stale private runtime at 0.80.7 (above pin) triggers repair.
	writeFakePi(runtimeBinDir, [
		`printf '%s|%s|%s\\n' "\${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${stalePiCallLog}"`,
		"if [[ \"${1:-}\" == \"--version\" ]]; then printf '0.80.7\\n'; exit 0; fi",
		"exit 0",
	].join("\n"));
	writeLoggingPi(templateDir, repairedPiLog, TLH_PINNED_PI_VERSION);
	writeFakeNpmInstaller(fakebin, {
		npmLog,
		templatePiPath: join(templateDir, "pi"),
		installedPiPath,
	});

	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: [supportedPiDir, safeInstallerPath(fakebin)].join(delimiter),
		TLH_PACKAGE_SOURCE: packageDir,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});
	const result = runInstaller([
		"--agent-dir", agentDir,
		"--bin-dir", binDir,
		"--no-settings",
		"--no-wrapper",
	], env);
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 0, output);
	assert.match(output, new RegExp(`Repairing TLH private Pi runtime to pinned ${escapeRegExp(TLH_PINNED_PI_VERSION)}`));
	assert.deepEqual(readFileSync(npmLog, "utf8").trim().split(/\r?\n/).filter(Boolean), [
		`install -g --ignore-scripts --prefix ${runtimeDir} ${TLH_PI_PACKAGE_SPEC}`,
	]);
	// PATH pi must never be invoked — the installer is private-runtime-only.
	assert.equal(existsSync(pathPiLog), false, output);
	// Stale runtime pi was only probed for --version.
	assert.deepEqual(readPiLogRecords(stalePiCallLog).map((record) => record.command), ["--version"]);
	// Repaired pi is first validated for --version (post-install check) then ran install+update.
	assert.deepEqual(readPiLogRecords(repairedPiLog).map((record) => record.command), [
		"--version",
		`install ${packageDir}`,
		`update ${packageDir}`,
	]);
	const state = readJson(join(agentDir, "tlh", "install-state.json"));
	assert.equal(state.piInstalledByTlh, true);
});

test("stage-1 preserves piInstalledByTlh=true when rerunning with a valid private runtime", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const packageDir = join(root, "package-source");
	const npmLog = join(root, "npm.log");
	const piLog = join(root, "pi.log");
	const runtimeDir = join(root, "runtime");
	const runtimeBinDir = join(runtimeDir, "bin");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify({
		schemaVersion: 1,
		repo: "diegopetrucci/the-last-harness",
		track: "ref",
		ref: "main",
		packageSource: packageDir,
		packageSourceIsDefault: false,
		piInstalledByTlh: true,
	}, null, 2));
	writeFakeCommand(fakebin, "git", "exit 0");
	// npm fails loudly if invoked — must NOT be called when runtime is already valid.
	writeFakeCommand(fakebin, "npm", `printf '%s\\n' "$*" >>"${npmLog}"\nexit 97`);
	writeFakeTk(fakebin);
	// Valid private runtime at the pinned version.
	writeLoggingPi(runtimeBinDir, piLog, TLH_PINNED_PI_VERSION);

	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: safeInstallerPath(fakebin),
		TLH_PACKAGE_SOURCE: packageDir,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});
	const result = runInstaller([
		"--agent-dir", agentDir,
		"--bin-dir", binDir,
		"--no-settings",
		"--no-wrapper",
		"--pi-installed-by-tlh", "true",
	], env);
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 0, output);
	assert.equal(existsSync(npmLog), false, output);
	assert.deepEqual(readPiLogRecords(piLog).map((record) => record.command), [
		"--version",
		`install ${packageDir}`,
		`update ${packageDir}`,
	]);
	const state = readJson(join(agentDir, "tlh", "install-state.json"));
	assert.equal(state.piInstalledByTlh, true);
});

test("stage-1 records piInstalledByTlh=true when installing the private runtime", (t) => {
	for (const scenario of [
		{
			name: "previous false field",
			state: {
				schemaVersion: 1,
				repo: "diegopetrucci/the-last-harness",
				track: "ref",
				ref: "main",
				packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
				packageSourceIsDefault: true,
				piInstalledByTlh: false,
			},
			args: ["--pi-installed-by-tlh", "false"],
		},
		{
			name: "missing previous field",
			state: {
				schemaVersion: 1,
				repo: "diegopetrucci/the-last-harness",
				track: "ref",
				ref: "main",
				packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
				packageSourceIsDefault: true,
			},
			args: [],
		},
	]) {
		const root = makeTempDir(`tlh-install-stage1-pi-runtime-${scenario.name.replace(/\s+/g, "-")}-`);
		const homeDir = join(root, "home");
		const agentDir = join(root, "agent");
		const binDir = join(root, "bin");
		const fakebin = join(root, "fakebin");
		const packageDir = join(root, "package-source");
		const npmLog = join(root, "npm.log");
		const piLog = join(root, "pi.log");
		const templateDir = join(root, "pi-template");
		const runtimeDir = join(root, "runtime");
		const installedPiPath = join(runtimeDir, "bin", "pi");
		t.after(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(homeDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });
		mkdirSync(join(agentDir, "tlh"), { recursive: true });
		writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify(scenario.state, null, 2));
		writeFakeCommand(fakebin, "git", "exit 0");
		writeFakeTk(fakebin);
		writeLoggingPi(templateDir, piLog, TLH_PINNED_PI_VERSION);
		writeFakeNpmInstaller(fakebin, {
			npmLog,
			templatePiPath: join(templateDir, "pi"),
			installedPiPath,
		});

		const env = scrubInstallerEnv({
			HOME: homeDir,
			PATH: safeInstallerPath(fakebin),
			TLH_PACKAGE_SOURCE: packageDir,
			TLH_SKIP_GNOSIS_INSTALL: "1",
		});
		const result = runInstaller([
			"--agent-dir", agentDir,
			"--bin-dir", binDir,
			"--no-settings",
			"--no-wrapper",
			...scenario.args,
		], env);
		const output = `${result.stdout}\n${result.stderr}`;

		assert.equal(result.status, 0, `${scenario.name}\n${output}`);
		assert.deepEqual(readFileSync(npmLog, "utf8").trim().split(/\r?\n/).filter(Boolean), [
			`install -g --ignore-scripts --prefix ${runtimeDir} ${TLH_PI_PACKAGE_SPEC}`,
		], scenario.name);
		const state = readJson(join(agentDir, "tlh", "install-state.json"));
		assert.equal(state.piInstalledByTlh, true, scenario.name);
		assert.deepEqual(readPiLogRecords(piLog).map((record) => record.command), [
			"--version",
			`install ${packageDir}`,
			`update ${packageDir}`,
		], scenario.name);
	}
});



test("declared Node minimum stays aligned across installer metadata", () => {
	const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	const installSh = readFileSync(join(repoRoot, "install.sh"), "utf8");
	const releaseWorkflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");

	assert.equal(packageJson.engines.node, `>=${MIN_NODE_VERSION}`);
	assert.ok(installSh.includes(`TLH_MIN_NODE_VERSION="${MIN_NODE_VERSION}"`));
	assert.ok(releaseWorkflow.includes(`node-version: '${MIN_NODE_VERSION}'`));
});

// Regression (tlht-5php): post-install validation — broken/wrong-version npm install must
// throw, leaving any user-owned ~/.local/bin/pi untouched.
test("stage-1 installPiIfNeeded: broken npm install (wrong pi version) throws", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const packageDir = join(root, "package-source");
	const npmLog = join(root, "npm.log");
	const templateDir = join(root, "pi-template");
	const runtimeDir = join(root, "runtime");
	const installedPiPath = join(runtimeDir, "bin", "pi");
	const legacyBin = join(homeDir, ".local", "bin");
	const legacyPiPath = join(legacyBin, "pi");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(legacyBin, { recursive: true });

	// Install-state: piInstalledByTlh=true
	writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify({
		schemaVersion: 1,
		repo: "diegopetrucci/the-last-harness",
		track: "ref",
		ref: "main",
		packageSource: packageDir,
		packageSourceIsDefault: false,
		piInstalledByTlh: true,
	}, null, 2));

	// Legacy pi at ~/.local/bin/pi — must NOT be removed when install fails.
	writeFakePi(legacyBin, `if [[ "\${1:-}" == "--version" ]]; then printf '${TLH_PINNED_PI_VERSION}\\n'; exit 0; fi\nexit 0`);

	// Template pi with a clearly wrong non-pinned version (0.80.7) — simulates a broken npm install.
	writeFakePi(templateDir, "if [[ \"${1:-}\" == \"--version\" ]]; then printf '0.80.7\\n'; exit 0; fi\nexit 0");

	// Fake npm: always installs the wrong-version template pi.
	writeFakeNpmInstaller(fakebin, {
		npmLog,
		templatePiPath: join(templateDir, "pi"),
		installedPiPath,
	});
	writeFakeCommand(fakebin, "git", "exit 0");
	writeFakeTk(fakebin);

	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: safeInstallerPath(fakebin),
		TLH_PACKAGE_SOURCE: packageDir,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});
	const result = runInstaller([
		"--agent-dir", agentDir,
		"--bin-dir", binDir,
		"--no-settings",
		"--no-wrapper",
		"--pi-installed-by-tlh", "true",
	], env);
	const output = `${result.stdout}\n${result.stderr}`;

	// Installer must fail: freshly installed pi has wrong version.
	assert.notEqual(result.status, 0, `expected installer to fail on wrong-version pi, got exit 0:\n${output}`);
	assert.match(output, /0\.80\.7/, "error output should mention the wrong version");

	// ~/.local/bin/pi must NOT have been removed (install threw before any cleanup could run).
	assert.equal(existsSync(legacyPiPath), true, "user-owned ~/.local/bin/pi was removed despite installer throwing");

	// npm uninstall must NOT have been called.
	const npmLinesC = existsSync(npmLog)
		? readFileSync(npmLog, "utf8").trim().split(/\r?\n/).filter(Boolean)
		: [];
	assert.equal(
		npmLinesC.filter((line) => line.startsWith("uninstall ")).length,
		0,
		`npm uninstall must not have been called; npm log: ${npmLinesC.join(", ")}`,
	);
});

// Regression (tlht-5php, blocker): piInstalledByTlh=true, private runtime ABSENT at start,
// user-owned ~/.local/bin/pi@0.82.1 present.  The installer must provision the private
// runtime and succeed — without removing or executing ~/.local/bin/pi.
test("stage-1 regression (tlht-5php): installer never removes or execs user-owned ~/.local/bin/pi when piInstalledByTlh=true and private runtime is absent", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const packageDir = join(root, "package-source");
	const npmLog = join(root, "npm.log");
	const templateDir = join(root, "pi-template");
	const runtimeDir = join(root, "runtime");
	const installedPiPath = join(runtimeDir, "bin", "pi");
	const piLog = join(root, "pi.log");
	const legacyBin = join(homeDir, ".local", "bin");
	const legacyPiPath = join(legacyBin, "pi");
	const legacyPiInvocationLog = join(root, "legacy-pi.log");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(legacyBin, { recursive: true });

	// Install-state: piInstalledByTlh=true (the blocker scenario: set by old model or stale state).
	// No private runtime exists at start — runtimeDir is absent.
	writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify({
		schemaVersion: 1,
		repo: "diegopetrucci/the-last-harness",
		track: "ref",
		ref: "main",
		packageSource: packageDir,
		packageSourceIsDefault: false,
		piInstalledByTlh: true,
	}, null, 2));

	// User-owned ~/.local/bin/pi@0.82.1 — must NOT be removed or invoked by the installer.
	writeFakePi(legacyBin, [
		`printf '%s\\n' "$*" >>"${legacyPiInvocationLog}"`,
		`if [[ "\${1:-}" == "--version" ]]; then printf '${TLH_PINNED_PI_VERSION}\\n'; exit 0; fi`,
		"exit 0",
	].join("\n"));

	// Template pi for npm to install as the new private runtime (correct pinned version).
	writeLoggingPi(templateDir, piLog, TLH_PINNED_PI_VERSION);

	// Fake npm: logs all invocations, handles install only (copies template to runtime path).
	// Any npm uninstall call would indicate the installer is (incorrectly) trying to remove ~/.local.
	writeFakeCommand(fakebin, "npm", [
		`printf '%s\\n' "$*" >>"${npmLog}"`,
		`case "$1" in`,
		`  install)`,
		`    mkdir -p "${join(runtimeDir, "bin")}"`,
		`    cp "${join(templateDir, "pi")}" "${installedPiPath}"`,
		`    chmod +x "${installedPiPath}"`,
		`    ;;`,
		`esac`,
	].join("\n"));
	writeFakeCommand(fakebin, "git", "exit 0");
	writeFakeTk(fakebin);

	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: safeInstallerPath(fakebin),
		TLH_PACKAGE_SOURCE: packageDir,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});
	const result = runInstaller([
		"--agent-dir", agentDir,
		"--bin-dir", binDir,
		"--no-settings",
		"--no-wrapper",
		"--pi-installed-by-tlh", "true",
	], env);
	const output = `${result.stdout}\n${result.stderr}`;

	// Installer must succeed — the private runtime was freshly installed.
	assert.equal(result.status, 0, `installer failed unexpectedly:\n${output}`);
	assert.equal(existsSync(installedPiPath), true, "private runtime was not installed");

	// User-owned ~/.local/bin/pi must still be present (not removed).
	assert.equal(existsSync(legacyPiPath), true, "user-owned ~/.local/bin/pi was incorrectly removed by the installer");

	// npm uninstall must NOT have been called for the ~/.local prefix.
	const npmCalls = existsSync(npmLog)
		? readFileSync(npmLog, "utf8").trim().split(/\r?\n/).filter(Boolean)
		: [];
	const uninstallCalls = npmCalls.filter((line) => line.startsWith("uninstall "));
	assert.equal(
		uninstallCalls.length,
		0,
		`npm uninstall must never be called by the installer; got: ${uninstallCalls.join(", ")}`,
	);

	// ~/.local/bin/pi must NOT have been executed by the installer.
	assert.equal(
		existsSync(legacyPiInvocationLog),
		false,
		"user-owned ~/.local/bin/pi was invoked by the installer (should never happen)",
	);
});

// Scenario (d): uninstall.sh — piInstalledByTlh=true, no private runtime, user-owned
// legacy ~/.local/bin/pi.  Without --force-include-pi the pi is never removed
// (hint printed).  With --force-include-pi it is removed via npm.
test("uninstall.sh does not remove legacy ~/.local/bin/pi without --force-include-pi (prints hint); removes it with --force-include-pi", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const legacyBin = join(homeDir, ".local", "bin");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakeNpmDir = join(root, "fakenpm");
	const npmLog = join(root, "npm-uninstall.log");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	// Setup: agent dir with TLH ownership marker and piInstalledByTlh=true.
	// NO private runtime (runtimeDir does not exist).
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(legacyBin, { recursive: true });
	writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify({
		schemaVersion: 1,
		repo: "diegopetrucci/the-last-harness",
		piInstalledByTlh: true,
	}, null, 2));

	// User-owned legacy pi at ~/.local/bin/pi.
	writeFileSync(join(legacyBin, "pi"), "#!/bin/sh\nprintf '0.82.1\\n'\n", "utf8");
	chmodSync(join(legacyBin, "pi"), 0o755);

	// ── (d1) dry-run without --force-include-pi: hint printed, pi NOT removed ──
	const dryResult = spawnSync("bash", [join(repoRoot, "uninstall.sh"), "--dry-run", "--agent-dir", agentDir, "--bin-dir", binDir], {
		cwd: repoRoot,
		env: scrubInstallerEnv({ HOME: homeDir }),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const dryOutput = `${dryResult.stdout}\n${dryResult.stderr}`;

	assert.equal(dryResult.status, 0, `dry-run failed:\n${dryOutput}`);
	assert.match(dryOutput, /force-include-pi/, "dry-run output must mention --force-include-pi hint");
	assert.equal(existsSync(join(legacyBin, "pi")), true, "dry-run must not remove legacy pi");

	// ── (d2) with --force-include-pi: npm uninstall called, pi removed ─────────
	// Fake npm: log the call and remove the legacy pi binary.
	mkdirSync(fakeNpmDir, { recursive: true });
	writeFileSync(join(fakeNpmDir, "npm"), [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		`printf '%s\\n' "$*" >>"${npmLog}"`,
		`if [[ "$1" == "uninstall" ]]; then`,
		`  rm -f "${join(legacyBin, "pi")}"`,
		`fi`,
	].join("\n"), "utf8");
	chmodSync(join(fakeNpmDir, "npm"), 0o755);

	// Re-create the agent dir with marker (the dry-run left it intact; we need it for the real run).
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify({
		schemaVersion: 1,
		repo: "diegopetrucci/the-last-harness",
		piInstalledByTlh: true,
	}, null, 2));

	const forceResult = spawnSync("bash", [join(repoRoot, "uninstall.sh"), "--force-include-pi", "--agent-dir", agentDir, "--bin-dir", binDir], {
		cwd: repoRoot,
		env: scrubInstallerEnv({ HOME: homeDir, PATH: `${fakeNpmDir}:${process.env.PATH || ""}` }),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const forceOutput = `${forceResult.stdout}\n${forceResult.stderr}`;

	assert.equal(forceResult.status, 0, `force-include-pi uninstall failed:\n${forceOutput}`);
	// npm must have been called for uninstall.
	assert.equal(existsSync(npmLog), true, "npm uninstall was not called with --force-include-pi");
	const npmCalls = readFileSync(npmLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
	assert.ok(npmCalls.some((line) => line.startsWith("uninstall ")), `expected npm uninstall; got: ${npmCalls.join(", ")}`);
	// Legacy pi must have been removed.
	assert.equal(existsSync(join(legacyBin, "pi")), false, "legacy pi should have been removed with --force-include-pi");
});

test("uninstall.sh regression (tlht-h7vq): migrated runtime marker preserves nested foreign packages during surgical uninstall", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const profileRoot = join(root, "profile");
	const agentDir = join(profileRoot, "agent");
	const runtimeDir = join(profileRoot, "runtime");
	const binDir = join(root, "bin");
	const fakeNpmDir = join(root, "fakenpm");
	const npmLog = join(root, "npm.log");
	const markerPath = join(runtimeDir, ".tlh-runtime-owned");
	const tlhPackageDir = join(runtimeDir, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
	const foreignPackageDir = join(runtimeDir, "lib", "node_modules", "foreign-package");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	mkdirSync(homeDir, { recursive: true });
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(join(runtimeDir, "bin"), { recursive: true });
	mkdirSync(tlhPackageDir, { recursive: true });
	mkdirSync(foreignPackageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify({
		schemaVersion: 1,
		repo: "diegopetrucci/the-last-harness",
		piInstalledByTlh: true,
	}, null, 2));
	writeFileSync(join(runtimeDir, "bin", "pi"), "#!/bin/sh\n", "utf8");
	chmodSync(join(runtimeDir, "bin", "pi"), 0o755);
	writeFileSync(markerPath, JSON.stringify({
		schemaVersion: 1,
		packageName: "@earendil-works/pi-coding-agent",
		runtimeAbsPath: realpathSync(runtimeDir),
		origin: "migrated",
	}), "utf8");
	writeFileSync(join(tlhPackageDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }, null, 2));
	writeFileSync(join(foreignPackageDir, "package.json"), JSON.stringify({ name: "foreign-package" }, null, 2));

	const dryResult = spawnSync("bash", [join(repoRoot, "uninstall.sh"), "--dry-run", "--agent-dir", agentDir, "--bin-dir", binDir], {
		cwd: repoRoot,
		env: scrubInstallerEnv({ HOME: homeDir }),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const dryOutput = `${dryResult.stdout}\n${dryResult.stderr}`;

	assert.equal(dryResult.status, 0, `dry-run failed:\n${dryOutput}`);
	assert.match(
		dryOutput,
		new RegExp(`would remove migrated TLH pi from shared runtime \\(npm\\): npm uninstall -g --ignore-scripts --prefix "${escapeRegExp(runtimeDir)}" @earendil-works/pi-coding-agent`),
	);
	assert.doesNotMatch(dryOutput, new RegExp(`would remove private runtime: rm -rf ${escapeRegExp(runtimeDir)}`));
	assert.equal(existsSync(foreignPackageDir), true, "dry-run must not remove nested foreign package");

	writeFakeCommand(fakeNpmDir, "npm", [
		`printf '%s\\n' "$*" >>"${npmLog}"`,
		`if [[ "$1" != "uninstall" ]]; then printf 'unexpected npm command: %s\\n' "$*" >&2; exit 98; fi`,
		`rm -f "${join(runtimeDir, "bin", "pi")}"`,
		`rm -rf "${tlhPackageDir}"`,
	].join("\n"));

	const realResult = spawnSync("bash", [join(repoRoot, "uninstall.sh"), "--agent-dir", agentDir, "--bin-dir", binDir], {
		cwd: repoRoot,
		env: scrubInstallerEnv({ HOME: homeDir, PATH: `${fakeNpmDir}:${process.env.PATH || ""}` }),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const realOutput = `${realResult.stdout}\n${realResult.stderr}`;

	assert.equal(realResult.status, 0, `real uninstall failed:\n${realOutput}`);
	assert.deepEqual(readFileSync(npmLog, "utf8").trim().split(/\r?\n/).filter(Boolean), [
		`uninstall -g --ignore-scripts --prefix ${runtimeDir} @earendil-works/pi-coding-agent`,
	]);
	assert.equal(existsSync(agentDir), false, "agent dir should be removed after uninstall");
	assert.equal(existsSync(join(runtimeDir, "bin", "pi")), false, "TLH runtime launcher should be removed surgically");
	assert.equal(existsSync(tlhPackageDir), false, "TLH runtime package should be removed surgically");
	assert.equal(existsSync(markerPath), false, "migrated runtime ownership marker should be cleared after uninstall");
	assert.equal(existsSync(foreignPackageDir), true, "nested foreign package must survive migrated runtime uninstall");
	assert.equal(readFileSync(join(foreignPackageDir, "package.json"), "utf8"), JSON.stringify({ name: "foreign-package" }, null, 2));
	assert.equal(existsSync(runtimeDir), true, "shared runtime prefix must survive migrated runtime uninstall");
});

test("stage-1 refuses to install into a runtime prefix containing a foreign top-level entry", (t) => {
	const scenarios = [
		{ label: "normal file", foreignName: "userdata.txt", dryRun: false },
		{ label: "dotfile", foreignName: "..userdata", dryRun: false },
		{ label: "normal file (dry-run)", foreignName: "userdata.txt", dryRun: true },
	];

	for (const scenario of scenarios) {
		const root = makeTempDir(`tlh-install-runtime-guard-${scenario.label.replace(/[^a-z0-9]+/g, "-")}-`);
		const homeDir = join(root, "home");
		const agentDir = join(root, "agent");
		const binDir = join(root, "bin");
		const fakebin = join(root, "fakebin");
		const packageDir = join(root, "package-source");
		const templateDir = join(root, "pi-template");
		const npmLog = join(root, "npm.log");
		const piLog = join(root, "pi.log");
		const runtimeDir = join(root, "runtime"); // sibling of agentDir per runtimePrefix(config)
		t.after(() => rmSync(root, { recursive: true, force: true }));

		mkdirSync(homeDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });
		// Pre-seed the runtime prefix with a foreign top-level entry.
		mkdirSync(runtimeDir, { recursive: true });
		const foreignPath = join(runtimeDir, scenario.foreignName);
		writeFileSync(foreignPath, "user content\n");

		writeFakeTk(fakebin);
		writeLoggingPi(templateDir, piLog, TLH_PINNED_PI_VERSION);
		writeFakeNpmInstaller(fakebin, {
			npmLog,
			templatePiPath: join(templateDir, "pi"),
			installedPiPath: join(runtimeDir, "bin", "pi"),
		});

		const env = scrubInstallerEnv({
			HOME: homeDir,
			PATH: `${fakebin}:${process.env.PATH || ""}`,
			TLH_PACKAGE_SOURCE: packageDir,
			TLH_SKIP_GNOSIS_INSTALL: "1",
		});
		const args = ["--agent-dir", agentDir, "--bin-dir", binDir, "--no-wrapper", "--no-settings"];
		if (scenario.dryRun) args.unshift("--dry-run");
		const result = runInstaller(args, env);
		const output = `${result.stdout}\n${result.stderr}`;

		// Must fail — ownership guard surfaces even in dry-run.
		assert.notEqual(result.status, 0, `${scenario.label}: expected failure but installer succeeded\n${output}`);
		// Error message must be actionable and name the ownership marker.
		assert.match(output, /is not TLH-owned/, `${scenario.label}: error must name the ownership problem`);
		assert.match(output, /--agent-dir/, `${scenario.label}: error must mention --agent-dir`);
		// Foreign file must be left untouched.
		assert.equal(existsSync(foreignPath), true, `${scenario.label}: foreign file must still exist after refused install`);
		assert.equal(readFileSync(foreignPath, "utf8"), "user content\n", `${scenario.label}: foreign file content must be unchanged`);
		// npm must not have been invoked.
		assert.equal(existsSync(npmLog), false, `${scenario.label}: npm must not be invoked when guard refuses`);
	}
});

test("stage-1 installs normally when runtime prefix exists but is empty", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const packageDir = join(root, "package-source");
	const templateDir = join(root, "pi-template");
	const npmLog = join(root, "npm.log");
	const piLog = join(root, "pi.log");
	const runtimeDir = join(root, "runtime");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	// Pre-create the runtime prefix as an empty directory.
	mkdirSync(runtimeDir, { recursive: true });

	writeFakeTk(fakebin);
	writeLoggingPi(templateDir, piLog, TLH_PINNED_PI_VERSION);
	writeFakeNpmInstaller(fakebin, {
		npmLog,
		templatePiPath: join(templateDir, "pi"),
		installedPiPath: join(runtimeDir, "bin", "pi"),
	});

	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: `${fakebin}:${process.env.PATH || ""}`,
		TLH_PACKAGE_SOURCE: packageDir,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});
	const result = runInstaller(
		["--agent-dir", agentDir, "--bin-dir", binDir, "--no-wrapper", "--no-settings"],
		env,
	);
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 0, `install into empty runtime prefix failed:\n${output}`);
	// npm must have been called to install pi.
	assert.equal(existsSync(npmLog), true, "npm was not called for empty runtime prefix");
});

// ---------------------------------------------------------------------------
// Runtime ownership marker tests (tlht-7mx4)
// ---------------------------------------------------------------------------

test("RUNTIME_MARKER_FILENAME .tlh-runtime-owned is in RUNTIME_OWNED_TOPLEVEL", () => {
	assert.equal(RUNTIME_MARKER_FILENAME, ".tlh-runtime-owned");
	assert.ok(RUNTIME_OWNED_TOPLEVEL.has(RUNTIME_MARKER_FILENAME), "marker filename must be in RUNTIME_OWNED_TOPLEVEL allow-list");
});

test("runtime ownership: pristine/absent prefix is accepted and marker origin=created is written", (t) => {
	// runStage1LocalPackageInstall starts with no pre-existing runtime prefix.
	const { result, agentDir } = runStage1LocalPackageInstall(t, { noSettings: true });
	const output = `${result.stdout}\n${result.stderr}`;
	const runtimeDir = join(dirname(agentDir), "runtime");
	const markerPath = join(runtimeDir, ".tlh-runtime-owned");

	assert.equal(result.status, 0, output);
	assert.ok(existsSync(markerPath), "ownership marker must be written after fresh install");
	const marker = JSON.parse(readFileSync(markerPath, "utf8"));
	assert.equal(marker.schemaVersion, 1);
	assert.equal(marker.packageName, "@earendil-works/pi-coding-agent");
	assert.equal(marker.origin, "created");
	assert.equal(typeof marker.runtimeAbsPath, "string");
	assert.ok(marker.runtimeAbsPath.length > 0);
});

test("runtime ownership: non-empty unmarked prefix without provenance is refused", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const runtimeDir = join(root, "runtime"); // sibling of agentDir = runtimePrefix(config)
	const packageDir = join(root, "package-source");
	const npmLog = join(root, "npm.log");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	// Pre-create a non-empty runtime prefix WITHOUT the ownership marker
	// and WITHOUT an install-state (no piInstalledByTlh=true provenance).
	mkdirSync(join(runtimeDir, "bin"), { recursive: true });
	writeFileSync(join(runtimeDir, "bin", "some-binary"), "#!/bin/sh\nexit 0\n", "utf8");
	writeFakeCommand(fakebin, "git", "exit 0");
	writeFakeTk(fakebin);
	writeFakeCommand(fakebin, "npm", `printf '%s\\n' "$*" >>"${npmLog}"\nexit 97`);

	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: safeInstallerPath(fakebin),
		TLH_PACKAGE_SOURCE: packageDir,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});
	const result = runInstaller([
		"--agent-dir", agentDir,
		"--bin-dir", binDir,
		"--no-settings",
		"--no-wrapper",
	], env);
	const output = `${result.stdout}\n${result.stderr}`;

	assert.notEqual(result.status, 0, `expected failure but installer succeeded\n${output}`);
	assert.match(output, /is not TLH-owned/, "error must name the ownership problem");
	assert.match(output, /\.tlh-runtime-owned/, "error must mention the marker filename");
	assert.match(output, /--agent-dir/, "error must mention --agent-dir");
	// npm must not be invoked when ownership is refused.
	assert.equal(existsSync(npmLog), false, "npm must not be called when ownership guard refuses");
	// No marker must be written.
	assert.equal(existsSync(join(runtimeDir, ".tlh-runtime-owned")), false, "marker must not be written on refusal");
});

test("runtime ownership: existing valid marker (path-matched) is accepted on reuse", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const runtimeDir = join(root, "runtime");
	const packageDir = join(root, "package-source");
	const npmLog = join(root, "npm.log");
	const piLog = join(root, "pi.log");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(runtimeDir, "bin"), { recursive: true });
	writeFakeCommand(fakebin, "git", "exit 0");
	writeFakeTk(fakebin);
	// npm must NOT be called (valid pi exists).
	writeFakeCommand(fakebin, "npm", `printf '%s\\n' "$*" >>"${npmLog}"\nexit 97`);
	writeLoggingPi(join(runtimeDir, "bin"), piLog, TLH_PINNED_PI_VERSION);

	// Write a valid ownership marker into the pre-existing runtime.
	const realRuntimeDir = realpathSync(runtimeDir);
	writeFileSync(join(runtimeDir, ".tlh-runtime-owned"), JSON.stringify({
		schemaVersion: 1,
		packageName: "@earendil-works/pi-coding-agent",
		runtimeAbsPath: realRuntimeDir,
		origin: "created",
	}), "utf8");

	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: safeInstallerPath(fakebin),
		TLH_PACKAGE_SOURCE: packageDir,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});
	const result = runInstaller([
		"--agent-dir", agentDir,
		"--bin-dir", binDir,
		"--no-settings",
		"--no-wrapper",
	], env);
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 0, output);
	// npm must not be called (valid pi + valid marker = reuse path).
	assert.equal(existsSync(npmLog), false, "npm must not be called when valid marker present and pi is valid");
	// pi --version was called (reuse path version check).
	const piRecords = readPiLogRecords(piLog);
	assert.ok(piRecords.some((r) => r.command === "--version"), "pi --version must be called on reuse");
	// Marker must be refreshed (still present) after reuse.
	const marker = JSON.parse(readFileSync(join(runtimeDir, ".tlh-runtime-owned"), "utf8"));
	assert.equal(marker.origin, "created", "marker origin must be preserved on refresh");
});

test("runtime ownership: non-empty unmarked prefix with piInstalledByTlh=true is migrated", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const runtimeDir = join(root, "runtime");
	const packageDir = join(root, "package-source");
	const npmLog = join(root, "npm.log");
	const piLog = join(root, "pi.log");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(join(runtimeDir, "bin"), { recursive: true });
	writeFakeCommand(fakebin, "git", "exit 0");
	writeFakeTk(fakebin);
	// npm must NOT be called (valid pi exists, migration only writes marker).
	writeFakeCommand(fakebin, "npm", `printf '%s\\n' "$*" >>"${npmLog}"\nexit 97`);
	writeLoggingPi(join(runtimeDir, "bin"), piLog, TLH_PINNED_PI_VERSION);

	// Install-state carries piInstalledByTlh=true (provenance from a prior install).
	writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify({
		schemaVersion: 1,
		repo: "diegopetrucci/the-last-harness",
		track: "ref",
		ref: "main",
		packageSource: packageDir,
		packageSourceIsDefault: false,
		piInstalledByTlh: true,
	}, null, 2));
	// No marker file exists yet.

	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: safeInstallerPath(fakebin),
		TLH_PACKAGE_SOURCE: packageDir,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});
	const result = runInstaller([
		"--agent-dir", agentDir,
		"--bin-dir", binDir,
		"--no-settings",
		"--no-wrapper",
	], env);
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 0, output);
	// npm must not be called (valid pi + migration path).
	assert.equal(existsSync(npmLog), false, "npm must not be called during provenance-gated migration");
	// Marker must be written with origin='migrated'.
	const markerPath = join(runtimeDir, ".tlh-runtime-owned");
	assert.ok(existsSync(markerPath), "ownership marker must be written after migration");
	const marker = JSON.parse(readFileSync(markerPath, "utf8"));
	assert.equal(marker.origin, "migrated", "migrated marker must carry origin=migrated");
	assert.equal(marker.schemaVersion, 1);
	assert.equal(marker.packageName, "@earendil-works/pi-coding-agent");
});

test("runtime ownership: symlinked runtime prefix is refused", (t) => {
	if (process.platform === "win32") {
		return; // symlinks not reliably available on Windows
	}
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const runtimeTarget = join(root, "runtime-real"); // the real directory
	const runtimeLink = join(root, "runtime"); // sibling of agentDir; symlink
	const packageDir = join(root, "package-source");
	const npmLog = join(root, "npm.log");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(runtimeTarget, { recursive: true });
	// Create the runtime dir as a symlink to a real directory.
	symlinkSync(runtimeTarget, runtimeLink, "dir");
	writeFakeCommand(fakebin, "git", "exit 0");
	writeFakeTk(fakebin);
	writeFakeCommand(fakebin, "npm", `printf '%s\\n' "$*" >>"${npmLog}"\nexit 97`);

	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: safeInstallerPath(fakebin),
		TLH_PACKAGE_SOURCE: packageDir,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});
	const result = runInstaller([
		"--agent-dir", agentDir,
		"--bin-dir", binDir,
		"--no-settings",
		"--no-wrapper",
	], env);
	const output = `${result.stdout}\n${result.stderr}`;

	assert.notEqual(result.status, 0, `expected failure on symlinked runtime but installer succeeded\n${output}`);
	assert.match(output, /symlink/i, "error must mention symlink");
	assert.match(output, /runtime/i, "error must mention runtime");
	// npm must not be invoked.
	assert.equal(existsSync(npmLog), false, "npm must not be called when symlink guard refuses");
});

// ---------------------------------------------------------------------------
// Uninstall ownership-marker gate tests (tlht-7son)
// ---------------------------------------------------------------------------

// Helper: write agentDir install-state.json with piInstalledByTlh=true
function writeAgentInstallState(agentDir, extra = {}) {
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	writeFileSync(
		join(agentDir, "tlh", "install-state.json"),
		JSON.stringify({ schemaVersion: 1, repo: "diegopetrucci/the-last-harness", piInstalledByTlh: true, ...extra }),
	);
}

// Helper: write a valid .tlh-runtime-owned marker into runtimeDir
function writeRuntimeMarker(runtimeDir, overrides = {}) {
	const realRuntimeDir = realpathSync(runtimeDir);
	writeFileSync(
		join(runtimeDir, ".tlh-runtime-owned"),
		JSON.stringify({
			schemaVersion: 1,
			packageName: "@earendil-works/pi-coding-agent",
			runtimeAbsPath: realRuntimeDir,
			origin: "created",
			...overrides,
		}),
	);
}

// Helper: create minimum valid TLH runtime layout (bin/pi + lib/node_modules/PI)
function writeRuntimeLayout(runtimeDir) {
	mkdirSync(join(runtimeDir, "bin"), { recursive: true });
	mkdirSync(join(runtimeDir, "lib", "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
	writeFileSync(join(runtimeDir, "bin", "pi"), "#!/bin/sh\nexit 0\n", "utf8");
	chmodSync(join(runtimeDir, "bin", "pi"), 0o755);
}

// Helper: run uninstall.sh and return result + combined output
function runUninstall(args, homeDir) {
	const result = spawnSync("bash", [join(repoRoot, "uninstall.sh"), ...args], {
		cwd: repoRoot,
		env: scrubInstallerEnv({ HOME: homeDir }),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { result, output: `${result.stdout}\n${result.stderr}` };
}

// (a) Marked TLH runtime (valid marker, path match, layout present, not symlink)
// → dry-run plan includes rm -rf; real run removes the runtime dir.
test("uninstall.sh: marked TLH runtime is planned and removed (valid marker + layout)", (t) => {
	const root = makeTempDir("tlh-uninstall-marker-a-");
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const runtimeDir = join(root, "runtime"); // PROFILE_ROOT/runtime = dirname(agentDir)/runtime
	t.after(() => rmSync(root, { recursive: true, force: true }));

	mkdirSync(homeDir, { recursive: true });
	writeAgentInstallState(agentDir);
	writeRuntimeLayout(runtimeDir);
	writeRuntimeMarker(runtimeDir);

	// ── dry-run: plan must include rm -rf ──
	const { result: dryResult, output: dryOutput } = runUninstall(
		["--dry-run", "--agent-dir", agentDir, "--bin-dir", binDir],
		homeDir,
	);
	assert.equal(dryResult.status, 0, `dry-run failed:\n${dryOutput}`);
	assert.match(dryOutput, /rm -rf/, "dry-run must include rm -rf for marked runtime");
	// dry-run must not actually remove anything
	assert.equal(existsSync(runtimeDir), true, "dry-run must not remove runtime dir");

	// ── real run: runtime dir is removed ──
	const { result, output } = runUninstall(
		["--agent-dir", agentDir, "--bin-dir", binDir],
		homeDir,
	);
	assert.equal(result.status, 0, `uninstall failed:\n${output}`);
	assert.equal(existsSync(runtimeDir), false, "runtime dir must be removed for marked TLH runtime");
});

// (b) Shared/unmarked prefix containing the pi package AND an unrelated package
// → SKIP with conditional manual-removal hint; foreign package untouched.
test("uninstall.sh: shared/unmarked runtime prefix is SKIPPED with conditional hint; foreign package preserved", (t) => {
	const root = makeTempDir("tlh-uninstall-marker-b-");
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const runtimeDir = join(root, "runtime");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	mkdirSync(homeDir, { recursive: true });
	writeAgentInstallState(agentDir);
	// Layout present (pi package) + foreign package in lib/node_modules — NO marker.
	writeRuntimeLayout(runtimeDir);
	mkdirSync(join(runtimeDir, "lib", "node_modules", "some-other-tool"), { recursive: true });
	writeFileSync(join(runtimeDir, "lib", "node_modules", "some-other-tool", "index.js"), "// user content\n", "utf8");

	const { result, output } = runUninstall(
		["--dry-run", "--agent-dir", agentDir, "--bin-dir", binDir],
		homeDir,
	);
	assert.equal(result.status, 0, `uninstall failed:\n${output}`);
	// Must NOT plan rm -rf (no marker)
	assert.doesNotMatch(output, /would remove private runtime/, "must not plan runtime removal without marker");
	// Must emit the conditional manual-removal hint, not a blind rm suggestion
	assert.match(output, /leave it/i, "output must include conditional 'leave it' hint");
	// Foreign package must still exist
	assert.equal(
		existsSync(join(runtimeDir, "lib", "node_modules", "some-other-tool", "index.js")),
		true,
		"foreign package must be preserved when runtime is skipped",
	);
});

// (c) Malformed/missing marker → SKIP (fail-closed)
test("uninstall.sh: malformed or missing marker causes SKIP (fail-closed)", (t) => {
	const scenarios = [
		{ label: "missing marker file", markerContent: null },
		{ label: "empty marker file", markerContent: "" },
		{ label: "non-JSON content", markerContent: "not json at all" },
		{ label: "wrong schemaVersion", markerContent: JSON.stringify({ schemaVersion: 99, packageName: "@earendil-works/pi-coding-agent", runtimeAbsPath: "/tmp", origin: "created" }) },
		{ label: "wrong packageName", markerContent: JSON.stringify({ schemaVersion: 1, packageName: "@other/package", runtimeAbsPath: "/tmp", origin: "created" }) },
		{ label: "invalid origin", markerContent: JSON.stringify({ schemaVersion: 1, packageName: "@earendil-works/pi-coding-agent", runtimeAbsPath: "/tmp", origin: "alien" }) },
	];

	for (const scenario of scenarios) {
		const root = makeTempDir(`tlh-uninstall-marker-c-${scenario.label.replace(/[^a-z0-9]+/g, "-")}-`);
		const homeDir = join(root, "home");
		const agentDir = join(root, "agent");
		const binDir = join(root, "bin");
		const runtimeDir = join(root, "runtime");
		t.after(() => rmSync(root, { recursive: true, force: true }));

		mkdirSync(homeDir, { recursive: true });
		writeAgentInstallState(agentDir);
		writeRuntimeLayout(runtimeDir);
		if (scenario.markerContent !== null) {
			writeFileSync(join(runtimeDir, ".tlh-runtime-owned"), scenario.markerContent, "utf8");
		}

		const { result, output } = runUninstall(
			["--dry-run", "--agent-dir", agentDir, "--bin-dir", binDir],
			homeDir,
		);
		// Must not plan removal
		assert.equal(result.status, 0, `${scenario.label}: uninstall failed:\n${output}`);
		assert.doesNotMatch(output, /would remove private runtime/, `${scenario.label}: must not plan rm -rf when marker is malformed/missing`);
		// Must emit conditional hint
		assert.match(output, /leave it/i, `${scenario.label}: must include conditional hint on skip`);
	}
});

// (d) Marker runtimeAbsPath mismatch → SKIP
test("uninstall.sh: runtimeAbsPath mismatch in marker causes SKIP", (t) => {
	const root = makeTempDir("tlh-uninstall-marker-d-");
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const runtimeDir = join(root, "runtime");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	mkdirSync(homeDir, { recursive: true });
	writeAgentInstallState(agentDir);
	writeRuntimeLayout(runtimeDir);
	// Write marker pointing to a *different* path
	writeFileSync(
		join(runtimeDir, ".tlh-runtime-owned"),
		JSON.stringify({
			schemaVersion: 1,
			packageName: "@earendil-works/pi-coding-agent",
			runtimeAbsPath: "/some/other/completely/different/path",
			origin: "created",
		}),
		"utf8",
	);

	const { result, output } = runUninstall(
		["--dry-run", "--agent-dir", agentDir, "--bin-dir", binDir],
		homeDir,
	);
	assert.equal(result.status, 0, `uninstall failed:\n${output}`);
	// Must NOT plan removal
	assert.doesNotMatch(output, /would remove private runtime/, "must not plan rm -rf when runtimeAbsPath mismatches");
	// Must emit the conditional hint
	assert.match(output, /leave it/i, "must include conditional hint on path mismatch");
});

// (e) Marked runtime with .tlh-runtime-owned in allow-list: exclusivity check does not trip on marker dotfile.
test("uninstall.sh: marker dotfile is in exclusivity allow-list; runtime with bin+lib+node-compile-cache+marker is planned for removal", (t) => {
	const root = makeTempDir("tlh-uninstall-marker-e-");
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const runtimeDir = join(root, "runtime");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	mkdirSync(homeDir, { recursive: true });
	writeAgentInstallState(agentDir);
	writeRuntimeLayout(runtimeDir);
	// Add node-compile-cache (all four allowed top-level entries present)
	mkdirSync(join(runtimeDir, "node-compile-cache"), { recursive: true });
	writeRuntimeMarker(runtimeDir);

	const { result, output } = runUninstall(
		["--dry-run", "--agent-dir", agentDir, "--bin-dir", binDir],
		homeDir,
	);
	assert.equal(result.status, 0, `dry-run failed:\n${output}`);
	// All four allowed entries present: must plan rm -rf (not SKIP)
	assert.match(output, /rm -rf/, "runtime with bin+lib+node-compile-cache+marker must be planned for rm -rf");
	assert.doesNotMatch(output, /leave it/i, "exclusivity allow-list must not trip on marker dotfile");
});
