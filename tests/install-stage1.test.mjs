import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	MIN_NODE_VERSION,
	RUNTIME_MARKER_FILENAME,
	RUNTIME_OWNED_TOPLEVEL,
	assertSupportedNodeRuntime,
	buildInstallConfig,
	installDefaultExtensions,
	nodeVersionMeetsMinimum,
	parseArgs,
	seedLibrarianConfig,
	usage,
} from "../scripts/tlh-install.mjs";
import { validateInstallerTargets } from "../scripts/lib/tlh-install-paths.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoNodeModulesBin = join(repoRoot, "node_modules", ".bin");
const TLH_MIN_PI_VERSION = "0.79.1";
const TLH_PINNED_PI_VERSION = "0.79.7";

const TLH_PI_PACKAGE_SPEC = `@earendil-works/pi-coding-agent@${TLH_PINNED_PI_VERSION}`;

function pathWithoutRepoNodeModulesBin(pathValue = process.env.PATH || "") {
	return pathValue.split(delimiter).filter((entry) => entry && resolve(entry) !== repoNodeModulesBin).join(delimiter);
}

function makeTempDir(prefix = "tlh-install-stage1-test-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

function scrubInstallerEnv(overrides = {}, baseEnv = process.env) {
	const env = {};
	for (const [key, value] of Object.entries(baseEnv)) {
		if (key === "PI_CODING_AGENT_DIR" || key.startsWith("TLH_")) continue;
		env[key] = value;
	}
	return { ...env, ...overrides };
}

function runHelper(scriptRelativePath, args, { homeDir }) {
	const scriptPath = join(repoRoot, scriptRelativePath);
	const result = spawnSync(process.execPath, [scriptPath, ...args], {
		cwd: repoRoot,
		env: scrubInstallerEnv({ HOME: homeDir }),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(
		result.status,
		0,
		`${scriptRelativePath} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
	);
}

function runInstaller(args, env = scrubInstallerEnv()) {
	return spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-install.mjs"), ...args], {
		cwd: repoRoot,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function captureConsole(method, callback) {
	const original = console[method];
	const lines = [];
	console[method] = (...args) => {
		lines.push(args.map(String).join(" "));
	};
	try {
		callback();
	} finally {
		console[method] = original;
	}
	return lines.join("\n");
}

function writeFakeCommand(fakebin, name, body) {
	mkdirSync(fakebin, { recursive: true });
	const commandPath = join(fakebin, name);
	writeFileSync(commandPath, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf8");
	chmodSync(commandPath, 0o755);
}

function writeFakePi(fakebin, body) {
	writeFakeCommand(fakebin, "pi", body);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function safeInstallerPath(fakebin) {
	return [fakebin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
}

function writeFakeTk(fakebin) {
	writeFakeCommand(fakebin, "tk", "printf 'Usage: tk help\\nTicket CLI helper\\n'");
}

function writeLoggingPi(commandDir, logPath, version = "0.79.1") {
	writeFakePi(commandDir, [
		`printf '%s|%s|%s\\n' "\${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${logPath}"`,
		`if [[ "\${1:-}" == "--version" ]]; then printf '${version}\\n'; exit 0; fi`,
		"exit 0",
	].join("\n"));
}

function writeVersionedWrapperPi(commandDir, logPath, version = "0.79.1") {
	writeFakePi(commandDir, [
		`if [[ "\${1:-}" == "--version" ]]; then printf '${version}\\n'; exit 0; fi`,
		`{ printf 'cmd=%s\\n' "$0"; printf 'argv=%s\\n' "$*"; printf 'agent=%s\\n' "\${PI_CODING_AGENT_DIR:-}"; printf 'path=%s\\n' "\${PATH:-}"; } >"${logPath}"`,
		"exit 0",
	].join("\n"));
}

function writeWrapperHelperLogger(scriptPath, logEnvVar, source) {
	mkdirSync(dirname(scriptPath), { recursive: true });
	writeFileSync(scriptPath, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.${logEnvVar}, JSON.stringify({ source: ${JSON.stringify(source)}, argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH } }));\n`, "utf8");
}

function writeFakeNpmInstaller(fakebin, { npmLog, templatePiPath, installedPiPath }) {
	writeFakeCommand(fakebin, "npm", [
		`printf '%s\\n' "$*" >>"${npmLog}"`,
		`mkdir -p "${dirname(installedPiPath)}"`,
		`cp "${templatePiPath}" "${installedPiPath}"`,
		`chmod +x "${installedPiPath}"`,
	].join("\n"));
}

function runStage1LocalPackageInstall(t, {
	dryRun = false,
	noSettings = false,
	force = false,
	existingLibrarianConfig,
	existingSupportFiles,
} = {}) {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const packageDir = join(root, "package-source");
	const piLog = join(root, "pi.log");
	const templateDir = join(root, "pi-template");
	const npmLog = join(root, "npm.log");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	writeFakeTk(fakebin);
	writeLoggingPi(fakebin, piLog);
	// Fake npm so installPiIfNeeded never hits the network. The fake npm copies a
	// template pi (reporting the pinned version) into the private runtime path.
	writeLoggingPi(templateDir, piLog, TLH_PINNED_PI_VERSION);
	writeFakeNpmInstaller(fakebin, {
		npmLog,
		templatePiPath: join(templateDir, "pi"),
		installedPiPath: join(dirname(agentDir), "runtime", "bin", "pi"),
	});
	if (existingLibrarianConfig !== undefined) {
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "librarian.json"), JSON.stringify(existingLibrarianConfig, null, 2));
	}
	if (existingSupportFiles) {
		for (const [relativePath, content] of Object.entries(existingSupportFiles)) {
			const target = join(agentDir, "tlh", relativePath);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
	}
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: `${fakebin}:${process.env.PATH || ""}`,
		TLH_PACKAGE_SOURCE: packageDir,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});
	const args = ["--agent-dir", agentDir, "--bin-dir", binDir, "--no-wrapper"];
	if (dryRun) args.unshift("--dry-run");
	if (noSettings) args.push("--no-settings");
	if (force) args.push("--force");
	const result = runInstaller(args, env);
	return { result, homeDir, agentDir, binDir, piLog };
}

function makeLibrarianSeedConfig(t, { dryRun = false, noSettings = false, existingLibrarianConfig } = {}) {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	mkdirSync(homeDir, { recursive: true });
	if (existingLibrarianConfig !== undefined) {
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "librarian.json"), JSON.stringify(existingLibrarianConfig, null, 2));
	}
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const env = scrubInstallerEnv({ HOME: homeDir });
	const args = ["--agent-dir", agentDir, "--bin-dir", binDir];
	if (dryRun) args.unshift("--dry-run");
	if (noSettings) args.push("--no-settings");
	const config = buildInstallConfig(parseArgs(args, env), env);
	config.supportFilePaths.LIBRARIAN_DEFAULTS_FILE = join(repoRoot, "config", "librarian.defaults.json");
	return { config, homeDir, agentDir };
}

function makeDefaultExtensionInstallConfig(t, { defaultExtensions, settings, dryRun = false, fakePiBody = "exit 0", fakeGitBody = "" }) {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const piLog = join(root, "pi.log");
	const defaultsPath = join(root, "default-extensions.json");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(defaultsPath, JSON.stringify(defaultExtensions, null, 2));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
	writeFakePi(fakebin, fakePiBody);
	if (fakeGitBody) writeFakeCommand(fakebin, "git", fakeGitBody);
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: `${fakebin}:${process.env.PATH || ""}`,
		PI_LOG: piLog,
		AGENT_DIR: agentDir,
	});
	const args = ["--agent-dir", agentDir, "--bin-dir", binDir];
	if (dryRun) args.unshift("--dry-run");
	const config = buildInstallConfig(parseArgs(args, env), env);
	if (!dryRun) config.quiet = true;
	// In the private-runtime model, absolutePiCmd(config) resolves to the private
	// runtime path which doesn't exist in tests.  Seed piCmd to the fakebin pi so
	// installDefaultExtensions can invoke pi without a real npm install.
	config.piCmd = join(fakebin, "pi");
	config.supportFilePaths.TLH_DEFAULTS_SCRIPT = join(repoRoot, "scripts/tlh-defaults.mjs");
	config.supportFilePaths.DEFAULT_EXTENSIONS_FILE = defaultsPath;
	return { config, agentDir, piLog };
}

function readPiLog(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
}

function readPiLogRecords(path) {
	return readPiLog(path).map((line) => {
		const [agentDir, cwd, ...commandParts] = line.split("|");
		return { agentDir, cwd, command: commandParts.join("|") };
	});
}

function assertPiCommands(path, agentDir, commands) {
	const records = readPiLogRecords(path);
	assert.deepEqual(records.map((record) => [record.agentDir, record.command]), commands.map((command) => [agentDir, command]));
	for (const record of records) assert.equal(realpathSync(record.cwd), realpathSync(agentDir));
}

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

test("stage-1 repairs the TLH private Pi runtime to the pinned version when it has a wrong version", (t) => {
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
	// Seed a stale private runtime binary at the expected path (version 0.79.8 is above pin).
	writeFakePi(runtimeBinDir, [
		`printf '%s|%s|%s\\n' "\${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${stalePiCallLog}"`,
		"if [[ \"${1:-}\" == \"--version\" ]]; then printf '0.79.8\\n'; exit 0; fi",
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
	assert.match(output, /Repairing TLH private Pi runtime to pinned 0\.79\.7/);
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
	// A supported PATH pi — the installer must never use it (private runtime only).
	writeFakePi(supportedPiDir, [
		`printf '%s|%s|%s\\n' "\${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${pathPiLog}"`,
		`if [[ "\${1:-}" == "--version" ]]; then printf '${TLH_MIN_PI_VERSION}\\n'; exit 0; fi`,
		"exit 0",
	].join("\n"));
	// Stale private runtime at 0.79.8 (above pin) triggers repair.
	writeFakePi(runtimeBinDir, [
		`printf '%s|%s|%s\\n' "\${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${stalePiCallLog}"`,
		"if [[ \"${1:-}\" == \"--version\" ]]; then printf '0.79.8\\n'; exit 0; fi",
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
	assert.match(output, /Repairing TLH private Pi runtime to pinned 0\.79\.7/);
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

test("stage-0 installer allowlist explicitly includes web-scout.md", () => {
	const installSh = readFileSync(join(repoRoot, "install.sh"), "utf8");
	assert.match(
		installSh,
		/^TLH_SUBAGENT_PROMPTS=\(developer\.md code-reviewer\.md repo-scout\.md diff-summarizer\.md librarian\.md oracle\.md web-scout\.md\)$/m,
	);
});

test("stage-1 rejects legacy ticket integration flags", () => {
	assert.doesNotThrow(() => parseArgs([]));
	for (const flag of ["--with-tickets", "--without-tickets", "--no-tickets"]) {
		assert.throws(() => parseArgs([flag]), new RegExp(`unknown option: ${flag}`));
	}
});

test("installer helpers no longer support the removed --no-pi-install opt-out", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	mkdirSync(homeDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const stage0Help = spawnSync("bash", [join(repoRoot, "install.sh"), "--help"], {
		cwd: repoRoot,
		env: scrubInstallerEnv({ HOME: homeDir }),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(stage0Help.status, 0, stage0Help.stderr);
	assert.match(stage0Help.stdout, /Upstream Pi 0\.79\.7/);
	assert.match(stage0Help.stdout, /installed into a private TLH runtime/);
	assert.doesNotMatch(stage0Help.stdout, /--no-pi-install/);

	const stage0RemovedFlag = spawnSync("bash", [join(repoRoot, "install.sh"), "--no-pi-install"], {
		cwd: repoRoot,
		env: scrubInstallerEnv({ HOME: homeDir }),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.notEqual(stage0RemovedFlag.status, 0);
	assert.match(stage0RemovedFlag.stderr, /error: unknown option: --no-pi-install/);
	assert.equal(stage0RemovedFlag.stdout, "");

	assert.throws(() => parseArgs(["--no-pi-install"]), /unknown option: --no-pi-install/);
	assert.match(usage(), /Upstream Pi 0\.79\.7/);
	assert.doesNotMatch(usage(), /--no-pi-install/);

	const updateHelp = spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-update.mjs"), "--help"], {
		cwd: repoRoot,
		env: scrubInstallerEnv({ HOME: homeDir }),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(updateHelp.status, 0, updateHelp.stderr);
	assert.match(updateHelp.stdout, /Upstream Pi is installed into a private TLH runtime/);
	assert.doesNotMatch(updateHelp.stdout, /--no-pi-install/);

	const updateRemovedFlag = spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-update.mjs"), "--no-pi-install"], {
		cwd: repoRoot,
		env: scrubInstallerEnv({ HOME: homeDir }),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.notEqual(updateRemovedFlag.status, 0);
	assert.match(updateRemovedFlag.stderr, /Unknown option for tlh update: --no-pi-install/);
	assert.equal(updateRemovedFlag.stdout, "");
});

test("stage-1 infers update track unless env or CLI overrides", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	mkdirSync(homeDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const configFor = (argv = [], overrides = {}) => {
		const env = scrubInstallerEnv({ HOME: homeDir, ...overrides });
		return buildInstallConfig(parseArgs(["--agent-dir", agentDir, "--bin-dir", binDir, ...argv], env), env);
	};

	assert.equal(configFor([], { TLH_REF: "feature" }).updateTrack, "ref");
	assert.equal(configFor([], { TLH_REF: "v1.2.3" }).updateTrack, "pinned-tag");
	assert.equal(configFor([], { TLH_REF: "v1.2.3", TLH_UPDATE_TRACK: "latest-release" }).updateTrack, "latest-release");
	assert.equal(configFor(["--track", "ref"], { TLH_REF: "v1.2.3", TLH_UPDATE_TRACK: "latest-release" }).updateTrack, "ref");
});

test("stage-1 defaults managed Gnosis to the pinned release and still honors env overrides", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	mkdirSync(homeDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const configFor = (overrides = {}) => {
		const env = scrubInstallerEnv({ HOME: homeDir, ...overrides });
		return buildInstallConfig(parseArgs(["--agent-dir", agentDir, "--bin-dir", binDir], env), env);
	};

	assert.equal(configFor().gnosisVersion, "0.5.3");
	assert.equal(configFor({ TLH_GNOSIS_VERSION: "latest" }).gnosisVersion, "latest");
	assert.equal(configFor({ TLH_GNOSIS_VERSION: "0.5.2" }).gnosisVersion, "0.5.2");
});

test("stage-1 --no-settings does not short-circuit Gnosis configure", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	mkdirSync(homeDir, { recursive: true });
	writeFakePi(fakebin, "if [[ \"${1:-}\" == \"--version\" ]]; then\n\tprintf '0.79.1\\n'\n\texit 0\nfi\nexit 0");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const result = spawnSync(process.execPath, [
		join(repoRoot, "scripts/tlh-install.mjs"),
		"--dry-run",
		"--no-settings",
		"--agent-dir", agentDir,
		"--bin-dir", binDir,
	], {
		cwd: repoRoot,
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: [fakebin, pathWithoutRepoNodeModulesBin()].filter(Boolean).join(delimiter),
			TLH_SKIP_GNOSIS_INSTALL: "1",
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 0, output);
	assert.match(output, /Skipping settings\/keybinding merge \(--no-settings\)\./);
	assert.match(output, /Skipping Gnosis integration \(TLH_SKIP_GNOSIS_INSTALL is set\)\./);
	assert.doesNotMatch(output, /Skipping Gnosis integration \(--no-settings\)\./);
});

test("stage-1 seeds isolated Librarian config only when it is missing", async (t) => {
	const { config, agentDir, homeDir } = makeLibrarianSeedConfig(t);

	await seedLibrarianConfig(config);

	assert.deepEqual(readJson(join(agentDir, "extensions", "librarian.json")), { cacheMode: "disabled" });
	assert.equal(existsSync(join(homeDir, ".pi")), false);
});

test("stage-1 preserves existing isolated Librarian config even with --force", async (t) => {
	const existingConfig = { cacheMode: "workspace", custom: true };
	const { config, agentDir } = makeLibrarianSeedConfig(t, { existingLibrarianConfig: existingConfig });
	config.force = true;

	await seedLibrarianConfig(config);

	assert.deepEqual(readJson(join(agentDir, "extensions", "librarian.json")), existingConfig);
});

test("stage-1 dry-run reports isolated Librarian config creation without writing it", (t) => {
	const { result, agentDir } = runStage1LocalPackageInstall(t, { dryRun: true });
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 0, output);
	assert.match(output, /cp .*librarian\.defaults\.json .*extensions\/librarian\.json/);
	assert.equal(existsSync(join(agentDir, "extensions", "librarian.json")), false);
});

test("stage-1 copies only the profile recovery launcher into the isolated profile", (t) => {
	const { result, agentDir } = runStage1LocalPackageInstall(t, { noSettings: true });
	const output = `${result.stdout}\n${result.stderr}`;
	const supportDir = join(agentDir, "tlh");

	assert.equal(result.status, 0, output);
	assert.equal(existsSync(join(supportDir, "recover-update.mjs")), true, "recover-update.mjs");
	for (const relativePath of [
		"tlh-defaults.mjs",
		"tlh-tickets.mjs",
		"tlh-update.mjs",
		"default-extensions.json",
		"lib/default-extensions.mjs",
		"lib/tlh-install-package-source.mjs",
		"lib/tlh-install-paths.mjs",
		"lib/tlh-install-utils.mjs",
		"lib/tlh-safe-profile-write.mjs",
		"tlh-gnosis.mjs",
		"tlh-wrapper.mjs",
		"tlh-install-state.mjs",
		"librarian.defaults.json",
	]) {
		assert.equal(existsSync(join(supportDir, relativePath)), false, relativePath);
	}
});

test("stage-1 leaves existing install-only TLH support files untouched during install", (t) => {
	const existingSupportFiles = {
		"tlh-gnosis.mjs": "legacy gnosis helper\n",
		"tlh-wrapper.mjs": "legacy wrapper helper\n",
		"tlh-install-state.mjs": "legacy install-state helper\n",
		"librarian.defaults.json": "{\n  \"legacy\": true\n}\n",
	};
	const { result, agentDir } = runStage1LocalPackageInstall(t, { existingSupportFiles, noSettings: true });
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 0, output);
	for (const [relativePath, content] of Object.entries(existingSupportFiles)) {
		assert.equal(readFileSync(join(agentDir, "tlh", relativePath), "utf8"), content, relativePath);
	}
});

test("stage-1 --no-settings skips the isolated Librarian config default", (t) => {
	const { result, agentDir } = runStage1LocalPackageInstall(t, { noSettings: true });
	const output = `${result.stdout}\n${result.stderr}`;

	assert.equal(result.status, 0, output);
	assert.equal(existsSync(join(agentDir, "extensions", "librarian.json")), false);
	assert.equal(existsSync(join(agentDir, "tlh", "librarian.defaults.json")), false);
});

test("stage-1 derives packageRoot from custom package source install dirs", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	mkdirSync(homeDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const baseEnv = {
		...process.env,
		PI_CODING_AGENT_DIR: join(homeDir, ".pi", "agent"),
		TLH_AGENT_DIR: join(homeDir, ".pi", "agent"),
		TLH_REPO: "poisoned/repo",
		TLH_REF: "poisoned-ref",
	};
	const configFor = (packageSource) => {
		const env = scrubInstallerEnv({ HOME: homeDir, TLH_PACKAGE_SOURCE: packageSource }, baseEnv);
		return buildInstallConfig(parseArgs(["--agent-dir", agentDir, "--bin-dir", binDir], env), env);
	};

	const gitConfig = configFor("git:github.com/custom/pkg@feature");
	assert.equal(gitConfig.packageSourceIsDefault, false);
	assert.equal(gitConfig.updateTrack, "custom");
	assert.equal(gitConfig.packageRoot, join(agentDir, "git", "github.com", "custom", "pkg"));
	assert.equal(gitConfig.packageHelperRoot, gitConfig.packageRoot);

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		gitConfig.agentDir,
		"--bin-dir",
		gitConfig.binDir,
		"--wrapper-name",
		gitConfig.wrapperName,
		"--package-root",
		gitConfig.packageHelperRoot,
	], { homeDir });
	const wrapper = readFileSync(gitConfig.wrapperPath, "utf8");
	assert.ok(wrapper.split(/\r?\n/).includes(`default_tlh_package_root='${gitConfig.packageHelperRoot}'`));

	const relativeLocalConfig = configFor("../local-package");
	assert.equal(relativeLocalConfig.packageRoot, resolve(agentDir, "../local-package"));
	assert.equal(relativeLocalConfig.packageHelperRoot, relativeLocalConfig.packageRoot);

	const homeLocalConfig = configFor("~/local-package");
	assert.equal(homeLocalConfig.packageRoot, join(homeDir, "local-package"));
	assert.equal(homeLocalConfig.packageHelperRoot, homeLocalConfig.packageRoot);

	const unsupportedConfig = configFor("github:owner/repo");
	assert.equal(
		unsupportedConfig.packageRoot,
		join(agentDir, "git", "github.com", "diegopetrucci", "the-last-harness"),
	);
	assert.equal(unsupportedConfig.packageHelperRoot, "");
});

test("wrapper skips stale fallback package helpers for unlocatable custom sources", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const updateLog = join(root, "update.json");
	const defaultsLog = join(root, "defaults.json");
	const ticketsLog = join(root, "tickets.json");
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const env = scrubInstallerEnv({
		HOME: homeDir,
		TLH_PACKAGE_SOURCE: "github:owner/repo",
	}, {
		...process.env,
		PI_CODING_AGENT_DIR: join(homeDir, ".pi", "agent"),
		TLH_AGENT_DIR: join(homeDir, ".pi", "agent"),
		TLH_REPO: "poisoned/repo",
		TLH_REF: "poisoned-ref",
	});
	const config = buildInstallConfig(parseArgs(["--agent-dir", agentDir, "--bin-dir", binDir], env), env);

	writeWrapperHelperLogger(join(config.packageRoot, "scripts", "tlh-update.mjs"), "TLH_UPDATE_LOG", "stale-package");
	writeWrapperHelperLogger(join(config.packageRoot, "scripts", "tlh-defaults.mjs"), "TLH_DEFAULTS_LOG", "stale-package");
	writeWrapperHelperLogger(join(config.packageRoot, "scripts", "tlh-tickets.mjs"), "TLH_TICKETS_LOG", "stale-package");
	mkdirSync(join(config.packageRoot, "config"), { recursive: true });
	writeFileSync(join(config.packageRoot, "config", "default-extensions.json"), "[\n  \"stale-package\"\n]\n", "utf8");
	writeWrapperHelperLogger(join(agentDir, "tlh", "recover-update.mjs"), "TLH_UPDATE_LOG", "recovery");
	writeWrapperHelperLogger(join(agentDir, "tlh", "tlh-update.mjs"), "TLH_UPDATE_LOG", "legacy-profile");
	writeWrapperHelperLogger(join(agentDir, "tlh", "tlh-defaults.mjs"), "TLH_DEFAULTS_LOG", "legacy-profile");
	writeWrapperHelperLogger(join(agentDir, "tlh", "tlh-tickets.mjs"), "TLH_TICKETS_LOG", "legacy-profile");
	writeFileSync(join(agentDir, "tlh", "default-extensions.json"), "[\n  \"legacy-profile\"\n]\n", "utf8");

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		config.agentDir,
		"--bin-dir",
		config.binDir,
		"--wrapper-name",
		config.wrapperName,
		`--package-root=${config.packageHelperRoot}`,
	], { homeDir });
	const wrapper = readFileSync(config.wrapperPath, "utf8");
	assert.ok(wrapper.split(/\r?\n/).includes("default_tlh_package_root=''"));

	const wrapperEnv = scrubInstallerEnv({
		HOME: homeDir,
		PATH: process.env.PATH || "",
		TLH_UPDATE_LOG: updateLog,
		TLH_DEFAULTS_LOG: defaultsLog,
		TLH_TICKETS_LOG: ticketsLog,
	});
	const wrapperPath = join(binDir, config.wrapperName);

	const updateResult = spawnSync(wrapperPath, ["update", "--dry-run"], {
		env: wrapperEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(updateResult.status, 0, updateResult.stderr);
	const updateRecord = JSON.parse(readFileSync(updateLog, "utf8"));
	assert.equal(updateRecord.source, "recovery");

	const defaultsResult = spawnSync(wrapperPath, ["defaults", "list"], {
		env: wrapperEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(defaultsResult.status, 1);
	assert.match(defaultsResult.stderr, /tlh defaults package support files are missing or corrupt; run `tlh update` to recover\./);
	assert.doesNotMatch(defaultsResult.stderr, /ERR_MODULE_NOT_FOUND/);
	assert.equal(existsSync(defaultsLog), false);

	const ticketsResult = spawnSync(wrapperPath, ["tickets", "status"], {
		env: wrapperEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(ticketsResult.status, 1);
	assert.match(ticketsResult.stderr, /tlh tickets package support files are missing or corrupt; run `tlh update` to recover\./);
	assert.doesNotMatch(ticketsResult.stderr, /ERR_MODULE_NOT_FOUND/);
	assert.equal(existsSync(ticketsLog), false);
});

test("wrapper uses original node for helpers while exposing isolated bin only for tickets and pi", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const agentBinLink = join(root, "agent-bin-link");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const fakebin = join(root, "fakebin");
	const cwdDir = join(root, "cwd");
	const cwdLink = join(root, "cwd-link");
	const updateLog = join(root, "update.json");
	const ticketsLog = join(root, "tickets.json");
	const piLog = join(root, "pi.txt");
	const fakeNodeLog = join(root, "fake-node.log");
	const currentNodeLog = join(root, "current-node.log");
	const currentPiLog = join(root, "current-pi.log");
	const isolatedPiLog = join(root, "isolated-pi.log");
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(join(packageRoot, "scripts"), { recursive: true });
	mkdirSync(cwdDir, { recursive: true });
	if (process.platform !== "win32") {
		symlinkSync(agentBin, agentBinLink, "dir");
		symlinkSync(cwdDir, cwdLink, "dir");
	}
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFakeCommand(agentBin, "node", "printf 'isolated node intercepted\\n' >\"${FAKE_NODE_LOG}\"\nexit 88");
	writeFakeCommand(agentBin, "tk", "if [[ \"${1:-}\" == \"help\" ]]; then printf 'isolated tk help\\n'; exit 0; fi\nexit 1");
	writeFakeCommand(agentBin, "pi", "printf 'isolated pi intercepted\\n' >\"${ISOLATED_PI_LOG}\"\nexit 89");
	writeFakeCommand(cwdDir, "node", "printf 'current-dir node intercepted\\n' >\"${CURRENT_NODE_LOG}\"\nexit 87");
	writeFakeCommand(cwdDir, "pi", "printf 'current-dir pi intercepted\\n' >\"${CURRENT_PI_LOG}\"\nexit 86");
	writeWrapperHelperLogger(join(agentDir, "tlh", "recover-update.mjs"), "TLH_UPDATE_LOG", "recovery");
	writeFileSync(join(packageRoot, "scripts", "tlh-tickets.mjs"), `import { spawnSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst tk = spawnSync("tk", ["help"], { encoding: "utf8" });\nwriteFileSync(process.env.TLH_TICKETS_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH }, tk: { status: tk.status, stdout: (tk.stdout || "").trim(), stderr: (tk.stderr || "").trim(), error: tk.error?.message } }));\nprocess.exit(tk.status ?? (tk.error ? 1 : 0));\n`, "utf8");
	writeVersionedWrapperPi(fakebin, piLog);

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
		"--pi-cmd",
		join(fakebin, "pi"),
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const poisonedPathEntries = ["", ".", cwdDir, agentBin];
	if (process.platform !== "win32") poisonedPathEntries.push(cwdLink, agentBinLink);
	poisonedPathEntries.push(fakebin, process.env.PATH || "");
	const wrapperEnv = scrubInstallerEnv({
		HOME: homeDir,
		PATH: poisonedPathEntries.join(":"),
		TLH_UPDATE_LOG: updateLog,
		TLH_TICKETS_LOG: ticketsLog,
		PI_WRAPPER_LOG: piLog,
		FAKE_NODE_LOG: fakeNodeLog,
		CURRENT_NODE_LOG: currentNodeLog,
		CURRENT_PI_LOG: currentPiLog,
		ISOLATED_PI_LOG: isolatedPiLog,
	});

	const updateResult = spawnSync(wrapper, ["update", "--dry-run"], {
		cwd: cwdDir,
		env: wrapperEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(updateResult.status, 0, updateResult.stderr);
	const updateRecord = JSON.parse(readFileSync(updateLog, "utf8"));
	assert.deepEqual(updateRecord.argv, [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--dry-run",
	]);
	assert.equal(updateRecord.env.PI_CODING_AGENT_DIR, agentDir);
	const updatePathEntries = updateRecord.env.PATH.split(":");
	assert.equal(updatePathEntries[0], fakebin);
	assert.equal(updatePathEntries.includes(""), false);
	assert.equal(updatePathEntries.includes("."), false);
	assert.equal(updatePathEntries.includes(cwdDir), false);
	assert.equal(updatePathEntries.includes(agentBin), false);
	if (process.platform !== "win32") {
		assert.equal(updatePathEntries.includes(cwdLink), false);
		assert.equal(updatePathEntries.includes(agentBinLink), false);
	}
	assert.equal(existsSync(currentNodeLog), false);
	assert.equal(existsSync(fakeNodeLog), false);

	const ticketsResult = spawnSync(wrapper, ["tickets", "status"], {
		cwd: cwdDir,
		env: wrapperEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(ticketsResult.status, 0, ticketsResult.stderr);
	const ticketsRecord = JSON.parse(readFileSync(ticketsLog, "utf8"));
	assert.deepEqual(ticketsRecord.argv, [
		"--settings",
		join(agentDir, "settings.json"),
		"--agent-dir",
		agentDir,
		"--wrapper-name",
		"tlh",
		"status",
	]);
	assert.equal(ticketsRecord.env.PI_CODING_AGENT_DIR, agentDir);
	const ticketsPathEntries = ticketsRecord.env.PATH.split(":");
	assert.deepEqual(ticketsPathEntries.slice(0, 2), [agentBin, fakebin]);
	assert.equal(ticketsPathEntries.includes(""), false);
	assert.equal(ticketsPathEntries.includes("."), false);
	assert.equal(ticketsPathEntries.includes(cwdDir), false);
	if (process.platform !== "win32") {
		assert.equal(ticketsPathEntries.includes(cwdLink), false);
		assert.equal(ticketsPathEntries.includes(agentBinLink), false);
	}
	assert.equal(ticketsRecord.tk.status, 0);
	assert.equal(ticketsRecord.tk.stdout, "isolated tk help");
	assert.equal(existsSync(fakeNodeLog), false);

	const piResult = spawnSync(wrapper, ["chat", "--version"], {
		cwd: cwdDir,
		env: wrapperEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(piResult.status, 0, piResult.stderr);
	const piRecord = Object.fromEntries(readFileSync(piLog, "utf8").trim().split(/\r?\n/).map((line) => {
		const separator = line.indexOf("=");
		return [line.slice(0, separator), line.slice(separator + 1)];
	}));
	assert.equal(piRecord.argv, "chat --version");
	assert.equal(piRecord.agent, agentDir);
	const piPathEntries = piRecord.path.split(":");
	assert.deepEqual(piPathEntries.slice(0, 2), [agentBin, fakebin]);
	assert.equal(piPathEntries.includes(""), false);
	assert.equal(piPathEntries.includes("."), false);
	assert.equal(piPathEntries.includes(cwdDir), false);
	if (process.platform !== "win32") {
		assert.equal(piPathEntries.includes(cwdLink), false);
		assert.equal(piPathEntries.includes(agentBinLink), false);
	}
	assert.equal(existsSync(currentPiLog), false);
	assert.equal(existsSync(isolatedPiLog), false);
	assert.equal(existsSync(currentNodeLog), false);
	assert.equal(existsSync(fakeNodeLog), false);
});

test("wrapper defaults and tickets helpers do not invoke PATH pi", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const fakebin = join(root, "fakebin");
	const defaultsLog = join(root, "defaults.json");
	const ticketsLog = join(root, "tickets.json");
	const piProbeLog = join(root, "pi-probe.log");
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(join(packageRoot, "scripts"), { recursive: true });
	mkdirSync(join(packageRoot, "config"), { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFakePi(agentBin, `printf 'managed:%s\n' "$*" >>"${piProbeLog}"
exit 63`);
	writeFakeCommand(agentBin, "tk", "if [[ \"${1:-}\" == \"help\" ]]; then printf 'isolated tk help\\n'; exit 0; fi\nexit 1");
	writeFakePi(fakebin, `printf 'path:%s\n' "$*" >>"${piProbeLog}"
exit 64`);
	writeWrapperHelperLogger(join(packageRoot, "scripts", "tlh-defaults.mjs"), "TLH_DEFAULTS_LOG", "package");
	writeFileSync(join(packageRoot, "config", "default-extensions.json"), "[]\n", "utf8");
	writeFileSync(join(packageRoot, "scripts", "tlh-tickets.mjs"), `import { spawnSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst tk = spawnSync("tk", ["help"], { encoding: "utf8" });\nwriteFileSync(process.env.TLH_TICKETS_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH }, tk: { status: tk.status, stdout: (tk.stdout || "").trim(), stderr: (tk.stderr || "").trim(), error: tk.error?.message } }));\nprocess.exit(tk.status ?? (tk.error ? 1 : 0));\n`, "utf8");

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const wrapperEnv = scrubInstallerEnv({
		HOME: homeDir,
		PATH: [fakebin, agentBin, process.env.PATH || ""].join(":"),
		TLH_DEFAULTS_LOG: defaultsLog,
		TLH_TICKETS_LOG: ticketsLog,
	});

	const defaultsResult = spawnSync(wrapper, ["defaults", "list"], {
		env: wrapperEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(defaultsResult.status, 0, defaultsResult.stderr);
	const defaultsRecord = JSON.parse(readFileSync(defaultsLog, "utf8"));
	assert.deepEqual(defaultsRecord.argv, [
		"--settings",
		join(agentDir, "settings.json"),
		"--defaults",
		join(packageRoot, "config", "default-extensions.json"),
		"list",
	]);
	assert.equal(defaultsRecord.env.PI_CODING_AGENT_DIR, agentDir);
	const defaultsPathEntries = defaultsRecord.env.PATH.split(":");
	assert.equal(defaultsPathEntries[0], fakebin);
	assert.equal(defaultsPathEntries.includes(agentBin), false);
	assert.equal(existsSync(piProbeLog), false);

	const ticketsResult = spawnSync(wrapper, ["tickets", "status"], {
		env: wrapperEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(ticketsResult.status, 0, ticketsResult.stderr);
	const ticketsRecord = JSON.parse(readFileSync(ticketsLog, "utf8"));
	assert.deepEqual(ticketsRecord.argv, [
		"--settings",
		join(agentDir, "settings.json"),
		"--agent-dir",
		agentDir,
		"--wrapper-name",
		"tlh",
		"status",
	]);
	assert.equal(ticketsRecord.env.PI_CODING_AGENT_DIR, agentDir);
	const ticketsPathEntries = ticketsRecord.env.PATH.split(":");
	assert.deepEqual(ticketsPathEntries.slice(0, 2), [agentBin, fakebin]);
	assert.equal(ticketsRecord.tk.status, 0);
	assert.equal(ticketsRecord.tk.stdout, "isolated tk help");
	assert.equal(existsSync(piProbeLog), false);
});

test("wrapper prefers package checkout helpers over profile copies", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const updateLog = join(root, "update.json");
	const defaultsLog = join(root, "defaults.json");
	const ticketsLog = join(root, "tickets.json");
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(join(packageRoot, "scripts"), { recursive: true });
	mkdirSync(join(packageRoot, "config"), { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeWrapperHelperLogger(join(packageRoot, "scripts", "tlh-update.mjs"), "TLH_UPDATE_LOG", "package");
	writeWrapperHelperLogger(join(packageRoot, "scripts", "tlh-defaults.mjs"), "TLH_DEFAULTS_LOG", "package");
	writeWrapperHelperLogger(join(packageRoot, "scripts", "tlh-tickets.mjs"), "TLH_TICKETS_LOG", "package");
	writeFileSync(join(packageRoot, "config", "default-extensions.json"), "[\n  \"package\"\n]\n", "utf8");
	writeWrapperHelperLogger(join(agentDir, "tlh", "tlh-update.mjs"), "TLH_UPDATE_LOG", "profile");
	writeWrapperHelperLogger(join(agentDir, "tlh", "tlh-defaults.mjs"), "TLH_DEFAULTS_LOG", "profile");
	writeWrapperHelperLogger(join(agentDir, "tlh", "tlh-tickets.mjs"), "TLH_TICKETS_LOG", "profile");
	writeFileSync(join(agentDir, "tlh", "default-extensions.json"), "[\n  \"profile\"\n]\n", "utf8");

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const wrapperEnv = scrubInstallerEnv({
		HOME: homeDir,
		PATH: process.env.PATH || "",
		TLH_UPDATE_LOG: updateLog,
		TLH_DEFAULTS_LOG: defaultsLog,
		TLH_TICKETS_LOG: ticketsLog,
	});

	const updateResult = spawnSync(wrapper, ["update", "--dry-run"], {
		env: wrapperEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(updateResult.status, 0, updateResult.stderr);
	const updateRecord = JSON.parse(readFileSync(updateLog, "utf8"));
	assert.equal(updateRecord.source, "package");
	assert.deepEqual(updateRecord.argv, ["--agent-dir", agentDir, "--bin-dir", binDir, "--wrapper-name", "tlh", "--dry-run"]);

	const defaultsResult = spawnSync(wrapper, ["defaults", "list"], {
		env: wrapperEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(defaultsResult.status, 0, defaultsResult.stderr);
	const defaultsRecord = JSON.parse(readFileSync(defaultsLog, "utf8"));
	assert.equal(defaultsRecord.source, "package");
	assert.deepEqual(defaultsRecord.argv, [
		"--settings",
		join(agentDir, "settings.json"),
		"--defaults",
		join(packageRoot, "config", "default-extensions.json"),
		"list",
	]);

	const ticketsResult = spawnSync(wrapper, ["tickets", "status"], {
		env: wrapperEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(ticketsResult.status, 0, ticketsResult.stderr);
	const ticketsRecord = JSON.parse(readFileSync(ticketsLog, "utf8"));
	assert.equal(ticketsRecord.source, "package");
	assert.deepEqual(ticketsRecord.argv, [
		"--settings",
		join(agentDir, "settings.json"),
		"--agent-dir",
		agentDir,
		"--wrapper-name",
		"tlh",
		"status",
	]);
});

test("wrapper ignores stale profile defaults/tickets helpers when package helper transitive imports are corrupt", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const defaultsLog = join(root, "defaults.json");
	const ticketsLog = join(root, "tickets.json");
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(join(packageRoot, "scripts", "lib"), { recursive: true });
	mkdirSync(join(packageRoot, "config"), { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeWrapperHelperLogger(join(agentDir, "tlh", "tlh-defaults.mjs"), "TLH_DEFAULTS_LOG", "legacy-profile");
	writeWrapperHelperLogger(join(agentDir, "tlh", "tlh-tickets.mjs"), "TLH_TICKETS_LOG", "legacy-profile");
	writeFileSync(join(agentDir, "tlh", "default-extensions.json"), "[\n  \"legacy-profile\"\n]\n", "utf8");
	writeFileSync(join(packageRoot, "scripts", "tlh-defaults.mjs"), 'import "./lib/defaults-hop.mjs";\n', "utf8");
	writeFileSync(join(packageRoot, "scripts", "lib", "defaults-hop.mjs"), 'import "./missing-defaults-lib.mjs";\n', "utf8");
	writeFileSync(join(packageRoot, "config", "default-extensions.json"), "[]\n", "utf8");
	writeFileSync(join(packageRoot, "scripts", "tlh-tickets.mjs"), 'import "./lib/tickets-hop.mjs";\n', "utf8");
	writeFileSync(join(packageRoot, "scripts", "lib", "tickets-hop.mjs"), 'import "./missing-tickets-lib.mjs";\n', "utf8");

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const wrapperEnv = scrubInstallerEnv({
		HOME: homeDir,
		PATH: process.env.PATH || "",
		TLH_DEFAULTS_LOG: defaultsLog,
		TLH_TICKETS_LOG: ticketsLog,
	});

	const defaultsResult = spawnSync(wrapper, ["defaults", "list"], {
		env: wrapperEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(defaultsResult.status, 1);
	assert.match(defaultsResult.stderr, /tlh defaults package support files are missing or corrupt; run `tlh update` to recover\./);
	assert.doesNotMatch(defaultsResult.stderr, /ERR_MODULE_NOT_FOUND/);
	assert.equal(existsSync(defaultsLog), false);

	const ticketsResult = spawnSync(wrapper, ["tickets", "status"], {
		env: wrapperEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(ticketsResult.status, 1);
	assert.match(ticketsResult.stderr, /tlh tickets package support files are missing or corrupt; run `tlh update` to recover\./);
	assert.doesNotMatch(ticketsResult.stderr, /ERR_MODULE_NOT_FOUND/);
	assert.equal(existsSync(ticketsLog), false);
});

test("wrapper falls back to the profile recovery updater when package update helper transitive imports are missing", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const legacyUpdateLog = join(root, "legacy-update.log");
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(join(packageRoot, "scripts", "lib"), { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify({
		schemaVersion: 1,
		repo: "diegopetrucci/the-last-harness",
		track: "latest-release",
		packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
		packageSourceIsDefault: true,
	}, null, 2));
	writeFileSync(join(packageRoot, "scripts", "tlh-update.mjs"), 'import "./lib/update-hop.mjs";\n', "utf8");
	writeFileSync(join(packageRoot, "scripts", "lib", "update-hop.mjs"), 'import "./missing-update-hop.mjs";\n', "utf8");
	copyFileSync(join(repoRoot, "scripts", "tlh-recover-update.mjs"), join(agentDir, "tlh", "recover-update.mjs"));
	writeFileSync(join(agentDir, "tlh", "tlh-update.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(legacyUpdateLog)}, "legacy profile update should not run\\n");\nprocess.exit(91);\n`, "utf8");

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const result = spawnSync(wrapper, ["update", "--dry-run"], {
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: process.env.PATH || "",
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	assert.match(result.stdout, /The Last Harness update plan/);
	assert.match(result.stdout, /releases\/latest\/download\/install\.sh/);
	assert.equal(result.stderr, "");
	assert.equal(existsSync(legacyUpdateLog), false);
});

test("wrapper uses the profile recovery updater before legacy profile update helpers", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const safeBin = join(root, "safe-bin");
	const fetchPreload = join(root, "stub-recovery-fetch.mjs");
	const bashLog = join(root, "bash.log");
	const legacyUpdateLog = join(root, "legacy-update.log");
	const bashPath = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim() || "/bin/bash";
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	mkdirSync(safeBin, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify({
		schemaVersion: 1,
		repo: "diegopetrucci/the-last-harness",
		track: "ref",
		ref: "main",
		packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
		packageSourceIsDefault: true,
	}, null, 2));
	copyFileSync(join(repoRoot, "scripts", "tlh-recover-update.mjs"), join(agentDir, "tlh", "recover-update.mjs"));
	writeFileSync(join(agentDir, "tlh", "tlh-update.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(legacyUpdateLog)}, "legacy profile update should not run\\n");\nprocess.exit(91);\n`, "utf8");
	writeFileSync(join(safeBin, "bash"), [
		"#!/bin/sh",
		"marker=$(grep -F 'recovery stub marker' \"$1\" || true)",
		"{ printf 'cmd=%s\\n' \"$0\"; printf 'argv=%s\\n' \"$*\"; printf 'marker=%s\\n' \"${marker}\"; printf 'repo=%s\\n' \"${TLH_REPO:-}\"; printf 'source=%s\\n' \"${TLH_PACKAGE_SOURCE:-}\"; printf 'agent=%s\\n' \"${PI_CODING_AGENT_DIR:-}\"; printf 'path=%s\\n' \"${PATH:-}\"; } >\"${BASH_LOG}\"",
	].join("\n"), "utf8");
	chmodSync(join(safeBin, "bash"), 0o755);
	writeFileSync(fetchPreload, `globalThis.fetch = async () => ({\n\tok: true,\n\tstatus: 200,\n\tstatusText: "OK",\n\ttext: async () => "#!/usr/bin/env bash\\n# recovery stub marker\\nexit 0\\n",\n});\n`, "utf8");

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const result = spawnSync(bashPath, [wrapper, "update", "--quiet"], {
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: `${safeBin}:${process.env.PATH || ""}`,
			NODE_OPTIONS: `--import=${fetchPreload}`,
			BASH_LOG: bashLog,
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	assert.equal(existsSync(legacyUpdateLog), false);
	const bashRecord = Object.fromEntries(readFileSync(bashLog, "utf8").trim().split(/\r?\n/).map((line) => {
		const separator = line.indexOf("=");
		return [line.slice(0, separator), line.slice(separator + 1)];
	}));
	assert.equal(bashRecord.cmd, join(safeBin, "bash"));
	assert.match(bashRecord.argv, new RegExp(`--agent-dir ${agentDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.match(bashRecord.argv, new RegExp(`--bin-dir ${binDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.match(bashRecord.argv, /--wrapper-name tlh/);
	assert.match(bashRecord.argv, /--track ref/);
	assert.match(bashRecord.argv, /--ref main/);
	assert.match(bashRecord.argv, /--quiet/);
	assert.equal(bashRecord.marker, "# recovery stub marker");
	assert.equal(bashRecord.repo, "diegopetrucci/the-last-harness");
	assert.equal(bashRecord.source, "");
	assert.equal(bashRecord.agent, agentDir);
});

test("wrapper resolves pi to an absolute command path before exposing isolated bin", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const cwdDir = join(root, "cwd");
	const safeBinName = "safe-bin";
	const safeBin = join(cwdDir, safeBinName);
	const bashEnv = join(root, "bash-env.sh");
	const piLog = join(root, "pi.txt");
	const isolatedPiLog = join(root, "isolated-pi.log");
	const functionPiLog = join(root, "function-pi.log");
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	mkdirSync(cwdDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFakePi(agentBin, "printf 'isolated pi intercepted\\n' >\"${ISOLATED_PI_LOG}\"\nexit 89");
	writeVersionedWrapperPi(safeBin, piLog);
	writeFileSync(bashEnv, "pi() {\n\tprintf 'shell function pi intercepted\\n' >\"${FUNCTION_PI_LOG}\"\n\treturn 79\n}\n", "utf8");

	// Under the private-runtime model, --pi-cmd bakes the absolute pi path at wrapper-creation time.
	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
		"--pi-cmd",
		join(safeBin, "pi"),
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const result = spawnSync(wrapper, ["chat"], {
		cwd: cwdDir,
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: [safeBinName, agentBin, process.env.PATH || ""].join(":"),
			BASH_ENV: bashEnv,
			PI_WRAPPER_LOG: piLog,
			ISOLATED_PI_LOG: isolatedPiLog,
			FUNCTION_PI_LOG: functionPiLog,
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	const piRecord = Object.fromEntries(readFileSync(piLog, "utf8").trim().split(/\r?\n/).map((line) => {
		const separator = line.indexOf("=");
		return [line.slice(0, separator), line.slice(separator + 1)];
	}));
	// The absolute --pi-cmd path is exec'd directly; shell functions and PATH pi are bypassed.
	// piRecord.cmd is $0 from the exec'd script, which is the --pi-cmd value (not necessarily realpath'd).
	assert.ok(piRecord.cmd.endsWith("/pi"), `expected pi command to end with /pi: ${piRecord.cmd}`);
	assert.ok(isAbsolute(piRecord.cmd), `expected absolute pi path: ${piRecord.cmd}`);
	assert.equal(piRecord.argv, "chat");
	assert.equal(piRecord.agent, agentDir);
	const piPathEntries = piRecord.path.split(":");
	// PATH for pi: managed_bin (agentBin) first, then pinned_dir (safeBin, absolute), then sanitized PATH.
	assert.deepEqual(piPathEntries.slice(0, 2), [agentBin, safeBin]);
	assert.equal(existsSync(isolatedPiLog), false);
	assert.equal(existsSync(functionPiLog), false);
});



test("wrapper falls back to the sanitized PATH when HOME is unset", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const supportedPiDir = join(root, "supported-pi");
	const piLog = join(root, "pi.txt");
	const isolatedPiLog = join(root, "isolated-pi.log");
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFakePi(agentBin, "printf 'isolated pi intercepted\\n' >\"${ISOLATED_PI_LOG}\"\nexit 89");
	writeVersionedWrapperPi(supportedPiDir, piLog);

	// In the private-runtime model, --pi-cmd is baked in at wrapper creation; HOME is not needed at runtime.
	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
		"--pi-cmd",
		join(supportedPiDir, "pi"),
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const wrapperEnv = scrubInstallerEnv({
		PATH: [supportedPiDir, agentBin, process.env.PATH || ""].join(":"),
		PI_WRAPPER_LOG: piLog,
		ISOLATED_PI_LOG: isolatedPiLog,
	});
	delete wrapperEnv.HOME;
	const result = spawnSync(wrapper, ["chat"], {
		env: wrapperEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	const piRecord = Object.fromEntries(readFileSync(piLog, "utf8").trim().split(/\r?\n/).map((line) => {
		const separator = line.indexOf("=");
		return [line.slice(0, separator), line.slice(separator + 1)];
	}));
	assert.equal(piRecord.cmd, join(supportedPiDir, "pi"));
	assert.equal(piRecord.argv, "chat");
	assert.equal(piRecord.agent, agentDir);
	const piPathEntries = piRecord.path.split(":");
	assert.deepEqual(piPathEntries.slice(0, 2), [agentBin, supportedPiDir]);
	assert.equal(existsSync(isolatedPiLog), false);
});

function setupTicketsEnabledWrapperFixture(t) {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const fakebin = join(root, "fakebin");
	const cwdDir = join(root, "cwd");
	const piLog = join(root, "pi.txt");
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	mkdirSync(cwdDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFakePi(fakebin, [
		"if [[ \"${1:-}\" == \"--version\" ]]; then printf '0.79.7\\n'; exit 0; fi",
		"printf 'path=%s\\n' \"${PATH:-}\" >\"${PI_WRAPPER_LOG}\"",
	].join("\n"));

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
		"--pi-cmd",
		join(fakebin, "pi"),
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const runWrapper = () => spawnSync(wrapper, ["chat"], {
		cwd: cwdDir,
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: [fakebin, process.env.PATH || ""].join(":"),
			PI_WRAPPER_LOG: piLog,
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const readPiPath = () => readFileSync(piLog, "utf8").trim().slice("path=".length).split(":");

	return { agentDir, agentBin, fakebin, runWrapper, readPiPath };
}

test("wrapper includes managed_bin in pi PATH when tlh.tickets.enabled is true", (t) => {
	const { agentDir, agentBin, runWrapper, readPiPath } = setupTicketsEnabledWrapperFixture(t);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tlh: { tickets: { enabled: true } } }, null, 2));

	const result = runWrapper();
	assert.equal(result.status, 0, result.stderr);
	const piPathEntries = readPiPath();
	assert.equal(piPathEntries[0], agentBin, `expected managed bin first; got ${piPathEntries.join(":")}`);
});

test("wrapper includes managed_bin in pi PATH when legacy tlh.tickets.enabled is false", (t) => {
	const { agentDir, agentBin, runWrapper, readPiPath } = setupTicketsEnabledWrapperFixture(t);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tlh: { tickets: { enabled: false } } }, null, 2));

	const result = runWrapper();
	assert.equal(result.status, 0, result.stderr);
	const piPathEntries = readPiPath();
	assert.equal(piPathEntries[0], agentBin, `expected managed bin first; got ${piPathEntries.join(":")}`);
});

test("wrapper defaults to managed_bin in pi PATH when settings.json is missing", (t) => {
	const { agentDir, agentBin, runWrapper, readPiPath } = setupTicketsEnabledWrapperFixture(t);
	assert.equal(existsSync(join(agentDir, "settings.json")), false);

	const result = runWrapper();
	assert.equal(result.status, 0, result.stderr);
	const piPathEntries = readPiPath();
	assert.equal(piPathEntries[0], agentBin, `expected managed bin first; got ${piPathEntries.join(":")}`);
});

test("wrapper defaults to managed_bin in pi PATH when tlh.tickets.enabled is not a boolean", (t) => {
	const { agentDir, agentBin, runWrapper, readPiPath } = setupTicketsEnabledWrapperFixture(t);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tlh: { tickets: { enabled: "false" } } }, null, 2));

	const result = runWrapper();
	assert.equal(result.status, 0, result.stderr);
	const piPathEntries = readPiPath();
	assert.equal(piPathEntries[0], agentBin, `expected managed bin first; got ${piPathEntries.join(":")}`);
});

test("tlh update rejects legacy ticket integration flags", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify({
		schemaVersion: 1,
		repo: "diegopetrucci/the-last-harness",
		track: "ref",
		ref: "main",
		packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
		packageSourceIsDefault: true,
	}, null, 2));

	const runUpdate = (...extraArgs) => spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-update.mjs"), "--dry-run", "--agent-dir", agentDir, "--bin-dir", binDir, ...extraArgs], {
		cwd: repoRoot,
		env: scrubInstallerEnv({ HOME: homeDir }),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	const defaultResult = runUpdate();
	assert.equal(defaultResult.status, 0, defaultResult.stderr);
	assert.doesNotMatch(defaultResult.stdout, /--with-tickets|--without-tickets|--no-tickets/);

	for (const flag of ["--with-tickets", "--without-tickets", "--no-tickets"]) {
		const result = runUpdate(flag);
		assert.notEqual(result.status, 0, `expected ${flag} to be rejected`);
		assert.match(result.stderr, new RegExp(`Unknown option for tlh update: ${flag}`));
		assert.equal(result.stdout, "");
	}
});

test("tlh update --extensions dry-run prints the isolated package update plan and rejects installer-only flags", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const fakebin = join(root, "fakebin");
	const dryRunPiLog = join(root, "dry-run-pi.log");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFakePi(fakebin, "printf 'pi should not run during dry-run\\n' >\"${DRY_RUN_PI_LOG}\"\nexit 91");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const runUpdate = (...extraArgs) => spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-update.mjs"), "--extensions", "--dry-run", "--agent-dir", agentDir, ...extraArgs], {
		cwd: repoRoot,
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: `${fakebin}:${process.env.PATH || ""}`,
			DRY_RUN_PI_LOG: dryRunPiLog,
			PI_CODING_AGENT_DIR: join(homeDir, ".pi", "agent"),
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	const defaultResult = runUpdate();
	assert.equal(defaultResult.status, 0, defaultResult.stderr);
	assert.match(defaultResult.stdout, /The Last Harness extension update plan/);
	assert.ok(defaultResult.stdout.includes(`Agent dir: ${agentDir}`));
	assert.match(defaultResult.stdout, /Would run: PI_CODING_AGENT_DIR='/);
	assert.match(defaultResult.stdout, /'update' '--extensions'/);
	assert.equal(defaultResult.stdout.includes(join(homeDir, ".pi", "agent")), false);
	assert.equal(defaultResult.stderr, "");
	assert.equal(existsSync(dryRunPiLog), false);

	const unsupportedFlags = [
		["--track", "ref"],
		["--ref", "main"],
		["--repo", "owner/repo"],
		["--package-source", "git:github.com/owner/repo@main"],
		["--force"],
		["--no-settings"],
		["--no-wrapper"],
	];
	for (const [flag, value] of unsupportedFlags) {
		const result = value ? runUpdate(flag, value) : runUpdate(flag);
		assert.notEqual(result.status, 0, `expected ${flag} to be rejected`);
		assert.match(result.stderr, /--extensions does not support /);
		assert.match(result.stderr, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(result.stdout, "");
	}
});

test("tlh update --extensions refuses to target normal Pi config via explicit or inherited agent dir selection", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const protectedAgentDir = join(homeDir, ".pi", "agent");
	mkdirSync(homeDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const scenarios = [
		{
			name: "explicit --agent-dir",
			args: ["--agent-dir", protectedAgentDir],
			env: {},
		},
		{
			name: "PI_CODING_AGENT_DIR fallback",
			args: [],
			env: { PI_CODING_AGENT_DIR: protectedAgentDir },
		},
		{
			name: "TLH_AGENT_DIR override",
			args: [],
			env: { TLH_AGENT_DIR: protectedAgentDir },
		},
	];

	for (const scenario of scenarios) {
		const result = spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-update.mjs"), "--extensions", "--dry-run", ...scenario.args], {
			cwd: repoRoot,
			env: scrubInstallerEnv({
				HOME: homeDir,
				PATH: "",
				...scenario.env,
			}),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});

		assert.notEqual(result.status, 0, `expected ${scenario.name} to be rejected`);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /refusing to run The Last Harness extension update against normal Pi config root/);
		assert.ok(result.stderr.includes(protectedAgentDir), `${scenario.name} stderr should mention the protected agent dir`);
		assert.doesNotMatch(result.stderr, /required command not found on sanitized PATH: pi/);
	}
	assert.equal(existsSync(join(homeDir, ".pi")), false);
});

test("tlh recovery update refuses to target normal Pi config before reading install-state", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const protectedAgentDir = join(homeDir, ".pi", "agent");
	mkdirSync(join(protectedAgentDir, "tlh"), { recursive: true });
	writeFileSync(join(protectedAgentDir, "tlh", "install-state.json"), "{ not valid json\n", "utf8");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const scenarios = [
		{
			name: "explicit --agent-dir",
			args: ["--agent-dir", protectedAgentDir],
			env: {},
		},
		{
			name: "PI_CODING_AGENT_DIR fallback",
			args: [],
			env: { PI_CODING_AGENT_DIR: protectedAgentDir },
		},
		{
			name: "TLH_AGENT_DIR override",
			args: [],
			env: { TLH_AGENT_DIR: protectedAgentDir },
		},
	];

	for (const scenario of scenarios) {
		const result = spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-recover-update.mjs"), "--dry-run", ...scenario.args], {
			cwd: repoRoot,
			env: scrubInstallerEnv({
				HOME: homeDir,
				PATH: "",
				...scenario.env,
			}),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});

		assert.notEqual(result.status, 0, `expected ${scenario.name} to be rejected`);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /refusing to recover The Last Harness update against normal Pi config root/);
		assert.ok(result.stderr.includes(protectedAgentDir), `${scenario.name} stderr should mention the protected agent dir`);
		assert.doesNotMatch(result.stderr, /could not read .*install-state\.json/);
		assert.doesNotMatch(result.stderr, /does not contain usable The Last Harness update metadata/);
		assert.doesNotMatch(result.stderr, /Could not determine update track/);
	}
});

test("tlh update --extensions uses the absolute private runtime pi binary and does not fall back to PATH", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const agentBinLink = join(root, "agent-bin-link");
	const cwdDir = join(root, "cwd");
	const cwdLink = join(root, "cwd-link");
	const runtimeBinDir = join(root, "runtime", "bin"); // dirname(agentDir)/runtime/bin
	const pathPiDir = join(root, "path-pi"); // PATH-based pi that must NOT be called
	const piLog = join(root, "pi.txt");
	const pathPiLog = join(root, "path-pi.log");
	const isolatedPiLog = join(root, "isolated-pi.log");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(cwdDir, { recursive: true });
	if (process.platform !== "win32") {
		symlinkSync(agentBin, agentBinLink, "dir");
		symlinkSync(cwdDir, cwdLink, "dir");
	}
	// Private runtime pi at the absolute path tlh-update.mjs now uses directly.
	writeVersionedWrapperPi(runtimeBinDir, piLog);
	// Poisoned pi entries that must not be invoked.
	writeFakePi(agentBin, `printf 'isolated pi intercepted\\n' >"\${ISOLATED_PI_LOG}"\nexit 89`);
	writeFakePi(pathPiDir, `printf 'PATH pi intercepted\\n' >"\${PATH_PI_LOG}"\nexit 97`);
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const poisonedPathEntries = ["", ".", cwdDir, agentBin];
	if (process.platform !== "win32") poisonedPathEntries.push(cwdLink, agentBinLink);
	poisonedPathEntries.push(pathPiDir, process.env.PATH || "");
	const result = spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-update.mjs"), "--extensions", "--agent-dir", agentDir, "--quiet"], {
		cwd: cwdDir,
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: poisonedPathEntries.join(":"),
			PI_WRAPPER_LOG: piLog,
			PATH_PI_LOG: pathPiLog,
			ISOLATED_PI_LOG: isolatedPiLog,
			PI_CODING_AGENT_DIR: join(homeDir, ".pi", "agent"),
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "");
	const piRecord = Object.fromEntries(readFileSync(piLog, "utf8").trim().split(/\r?\n/).map((line) => {
		const separator = line.indexOf("=");
		return [line.slice(0, separator), line.slice(separator + 1)];
	}));
	// Must use the absolute private runtime pi — not anything resolved from PATH.
	assert.equal(piRecord.cmd, join(runtimeBinDir, "pi"));
	assert.equal(piRecord.argv, "update --extensions");
	assert.equal(piRecord.agent, agentDir);
	assert.notEqual(piRecord.agent, join(homeDir, ".pi", "agent"));
	// PATH-based and isolated pi must not have been called.
	assert.equal(existsSync(pathPiLog), false);
	assert.equal(existsSync(isolatedPiLog), false);
});

test("tlh update removes isolated bin and skips non-file bash candidates before running bash", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const agentBinLink = join(root, "agent-bin-link");
	const binDir = join(root, "bin");
	const poisonedBin = join(root, "poisoned-bin");
	const safeBin = join(root, "safe-bin");
	const cwdDir = join(root, "cwd");
	const cwdLink = join(root, "cwd-link");
	const bashLog = join(root, "bash.txt");
	const currentBashLog = join(root, "current-bash.log");
	const interceptedBashLog = join(root, "intercepted-bash.log");
	const fetchPreload = join(root, "stub-update-fetch.mjs");
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(poisonedBin, { recursive: true });
	mkdirSync(safeBin, { recursive: true });
	mkdirSync(cwdDir, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	if (process.platform !== "win32") {
		symlinkSync(agentBin, agentBinLink, "dir");
		symlinkSync(cwdDir, cwdLink, "dir");
	}
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify({
		schemaVersion: 1,
		repo: "diegopetrucci/the-last-harness",
		track: "ref",
		ref: "main",
		packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
		packageSourceIsDefault: true,
	}, null, 2));
	writeFileSync(join(agentBin, "bash"), "#!/bin/sh\nprintf 'isolated bash intercepted\\n' >\"${INTERCEPTED_BASH_LOG}\"\nexit 88\n", "utf8");
	chmodSync(join(agentBin, "bash"), 0o755);
	writeFileSync(join(cwdDir, "bash"), "#!/bin/sh\nprintf 'current-dir bash intercepted\\n' >\"${CURRENT_BASH_LOG}\"\nexit 87\n", "utf8");
	chmodSync(join(cwdDir, "bash"), 0o755);
	mkdirSync(join(poisonedBin, "bash"), { recursive: true });
	chmodSync(join(poisonedBin, "bash"), 0o755);
	writeFileSync(join(safeBin, "bash"), "#!/bin/sh\n{ printf 'cmd=%s\\n' \"$0\"; printf 'argv=%s\\n' \"$*\"; printf 'path=%s\\n' \"${PATH:-}\"; } >\"${BASH_LOG}\"\n", "utf8");
	chmodSync(join(safeBin, "bash"), 0o755);
	writeFileSync(fetchPreload, `globalThis.fetch = async () => ({\n\tok: true,\n\tstatus: 200,\n\tstatusText: "OK",\n\ttext: async () => "#!/usr/bin/env bash\\nexit 0\\n",\n});\n`, "utf8");

	const poisonedPathEntries = ["", ".", cwdDir, agentBin];
	if (process.platform !== "win32") poisonedPathEntries.push(cwdLink, agentBinLink);
	poisonedPathEntries.push(poisonedBin, safeBin, process.env.PATH || "");
	const result = spawnSync(process.execPath, ["--import", fetchPreload, join(repoRoot, "scripts/tlh-update.mjs"), "--agent-dir", agentDir, "--bin-dir", binDir, "--quiet"], {
		cwd: cwdDir,
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: poisonedPathEntries.join(":"),
			BASH_LOG: bashLog,
			CURRENT_BASH_LOG: currentBashLog,
			INTERCEPTED_BASH_LOG: interceptedBashLog,
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(currentBashLog), false);
	assert.equal(existsSync(interceptedBashLog), false);
	const bashRecord = Object.fromEntries(readFileSync(bashLog, "utf8").trim().split(/\r?\n/).map((line) => {
		const separator = line.indexOf("=");
		return [line.slice(0, separator), line.slice(separator + 1)];
	}));
	assert.equal(bashRecord.cmd, join(safeBin, "bash"));
	assert.match(bashRecord.argv, /--agent-dir/);
	assert.match(bashRecord.argv, /--bin-dir/);
	const bashPathEntries = bashRecord.path.split(":");
	assert.equal(bashPathEntries[0], poisonedBin);
	assert.equal(bashPathEntries[1], safeBin);
	assert.equal(bashPathEntries.includes(""), false);
	assert.equal(bashPathEntries.includes("."), false);
	assert.equal(bashPathEntries.includes(cwdDir), false);
	assert.equal(bashPathEntries.includes(agentBin), false);
	if (process.platform !== "win32") {
		assert.equal(bashPathEntries.includes(cwdLink), false);
		assert.equal(bashPathEntries.includes(agentBinLink), false);
	}
});

test("stage-1 batches non-critical default extension updates", (t) => {
	const defaults = [
		{ id: "helper-a", source: "npm:helper-a" },
		{ id: "helper-b", source: "npm:helper-b" },
	];
	const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: defaults.map((entry) => entry.source) },
		fakePiBody: "printf '%s|%s|%s\n' \"${PI_CODING_AGENT_DIR:-}\" \"$PWD\" \"$*\" >>\"${PI_LOG}\"",
	});

	installDefaultExtensions(config);

	assertPiCommands(piLog, agentDir, ["update --extensions"]);
});

test("stage-1 falls back to old-CLI positional per-source non-critical updates when batch update fails", (t) => {
	const criticalSource = "git:github.com/example/critical";
	const defaults = [
		{ id: "critical", critical: true, source: criticalSource },
		{ id: "helper-a", source: "npm:helper-a" },
		{ id: "helper-b", source: "npm:helper-b" },
	];
	const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: defaults.map((entry) => entry.source) },
		fakePiBody: [
			"printf '%s|%s|%s\\n' \"${PI_CODING_AGENT_DIR:-}\" \"$PWD\" \"$*\" >>\"${PI_LOG}\"",
			"if [[ \"$1\" == \"update\" && \"${2:-}\" == \"--extensions\" ]]; then",
			"\tprintf 'batch failed\\n' >&2",
			"\texit 42",
			"fi",
			"if [[ \"$1\" == \"update\" && \"${2:-}\" == \"--extension\" ]]; then",
			"\tprintf 'old pi does not support --extension\\n' >&2",
			"\texit 98",
			"fi",
			"if [[ \"$1\" == \"update\" && \"${2:-}\" == \"npm:helper-a\" ]]; then",
			"\ttouch \"${PI_CODING_AGENT_DIR}/fallback-a.done\"",
			"\texit 0",
			"fi",
			"if [[ \"$1\" == \"update\" && \"${2:-}\" == \"npm:helper-b\" ]]; then",
			"\ttouch \"${PI_CODING_AGENT_DIR}/fallback-b.attempted\"",
			"\tprintf 'helper-b failed\\n' >&2",
			"\texit 43",
			"fi",
			"if [[ \"$1\" == \"install\" && \"${2:-}\" == \"git:github.com/example/critical\" ]]; then",
			"\t[[ -f \"${PI_CODING_AGENT_DIR}/fallback-a.done\" && -f \"${PI_CODING_AGENT_DIR}/fallback-b.attempted\" ]] || { printf 'critical install ran before fallback completed\\n' >&2; exit 44; }",
			"\texit 0",
			"fi",
		].join("\n"),
	});

	const stderr = captureConsole("error", () => installDefaultExtensions(config));

	assertPiCommands(piLog, agentDir, [
		"update --extensions",
		"update npm:helper-a",
		"update npm:helper-b",
		"install git:github.com/example/critical",
	]);
	assert.match(stderr, /warning: settings-wide extension refresh from merged settings failed; falling back to per-source updates for only 2 non-critical bundled default source\(s\)/);
	assert.match(stderr, /warning: default extension package update failed; continuing: npm:helper-b/);
	assert.match(stderr, /warning: 1 bundled default extension package\(s\) failed to update/);
});

test("stage-1 rejects unsafe critical default checkouts before settings-wide updates", (t) => {
	const criticalSource = "git:github.com/example/critical@pin";
	const defaults = [
		{ id: "critical", critical: true, source: criticalSource },
		{ id: "helper", source: "npm:helper" },
	];
	const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: defaults.map((entry) => entry.source) },
		fakePiBody: [
			"printf '%s|%s|%s\\n' \"${PI_CODING_AGENT_DIR:-}\" \"$PWD\" \"$*\" >>\"${PI_LOG}\"",
			"printf 'pi should not run for unsafe critical checkout\\n' >&2",
			"exit 45",
		].join("\n"),
	});
	mkdirSync(join(agentDir, "git", "github.com", "example", "critical"), { recursive: true });

	assert.throws(
		() => installDefaultExtensions(config),
		/refusing to use existing non-git critical default extension package checkout/,
	);
	assert.deepEqual(readPiLog(piLog), []);
});

test("stage-1 preflights critical checkouts before batch and validates critical refs after", (t) => {
	const criticalSource = "git:github.com/example/critical@pin";
	const defaults = [
		{ id: "critical", critical: true, source: criticalSource },
		{ id: "helper", source: "npm:helper" },
	];
	const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: defaults.map((entry) => entry.source) },
		fakePiBody: [
			"printf '%s|%s|%s\\n' \"${PI_CODING_AGENT_DIR:-}\" \"$PWD\" \"$*\" >>\"${PI_LOG}\"",
			"if [[ \"$1\" == \"update\" && \"${2:-}\" == \"--extensions\" ]]; then",
			"\t[[ -f \"${PI_CODING_AGENT_DIR}/preflight-safe.done\" ]] || { printf 'settings-wide update ran before critical preflight\\n' >&2; exit 46; }",
			"\tprintf 'stage:settings-wide-batch\\n' >>\"${PI_LOG}.order\"",
			"\ttouch \"${PI_CODING_AGENT_DIR}/settings-wide-update.done\"",
			"\texit 0",
			"fi",
			"if [[ \"$1\" == \"update\" && \"${2:-}\" == \"--extension\" ]]; then",
			"\tprintf 'unexpected per-source fallback: %s\\n' \"$*\" >&2",
			"\texit 47",
			"fi",
			"if [[ \"$1\" == \"install\" && \"${2:-}\" == \"git:github.com/example/critical@pin\" ]]; then",
			"\t[[ -f \"${PI_CODING_AGENT_DIR}/settings-wide-update.done\" ]] || { printf 'critical install ran before settings-wide update\\n' >&2; exit 48; }",
			"\t[[ -f \"${PI_CODING_AGENT_DIR}/critical-preinstall-validation.done\" ]] || { printf 'critical install ran before post-batch safety validation\\n' >&2; exit 49; }",
			"\tprintf 'stage:critical-install\\n' >>\"${PI_LOG}.order\"",
			"\ttouch \"${PI_CODING_AGENT_DIR}/critical-install.done\"",
			"\texit 0",
			"fi",
		].join("\n"),
		fakeGitBody: [
			"target=''",
			"if [[ \"${1:-}\" == \"-C\" ]]; then target=\"$2\"; shift 2; fi",
			"record_stage() { local stage=\"$1\" marker=\"$2\"; if [[ ! -f \"${AGENT_DIR}/${marker}\" ]]; then printf 'stage:%s\\n' \"$stage\" >>\"${PI_LOG}.order\"; touch \"${AGENT_DIR}/${marker}\"; fi; }",
			"if [[ \"${1:-}\" == \"rev-parse\" && \"${2:-}\" == \"--show-toplevel\" ]]; then",
			"\tif [[ ! -f \"${AGENT_DIR}/settings-wide-update.done\" ]]; then",
			"\t\trecord_stage preflight-safe preflight-safe.done",
			"\telif [[ ! -f \"${AGENT_DIR}/critical-install.done\" ]]; then",
			"\t\t[[ -f \"${AGENT_DIR}/preflight-safe.done\" ]] || { printf 'post-batch validation ran before preflight\\n' >&2; exit 50; }",
			"\t\trecord_stage critical-preinstall-validation critical-preinstall-validation.done",
			"\telse",
			"\t\t[[ -f \"${AGENT_DIR}/settings-wide-update.done\" ]] || { printf 'ref validation ran before settings-wide update\\n' >&2; exit 51; }",
			"\t\trecord_stage critical-ref-validation critical-ref-validation.done",
			"\tfi",
			"\tprintf '%s\\n' \"$target\"",
			"\texit 0",
			"fi",
			"if [[ \"${1:-}\" == \"rev-parse\" && \"${2:-}\" == \"--absolute-git-dir\" ]]; then printf '%s/.git\\n' \"$target\"; exit 0; fi",
			"if [[ \"${1:-}\" == \"rev-parse\" && \"${2:-}\" == \"--git-common-dir\" ]]; then printf '%s/.git\\n' \"$target\"; exit 0; fi",
			"exit 0",
		].join("\n"),
	});
	mkdirSync(join(agentDir, "git", "github.com", "example", "critical", ".git"), { recursive: true });

	installDefaultExtensions(config);

	assertPiCommands(piLog, agentDir, [
		"update --extensions",
		"install git:github.com/example/critical@pin",
	]);
	const stages = readFileSync(`${piLog}.order`, "utf8").trim().split(/\r?\n/);
	assert.deepEqual(stages, [
		"stage:preflight-safe",
		"stage:settings-wide-batch",
		"stage:critical-preinstall-validation",
		"stage:critical-install",
		"stage:critical-ref-validation",
	]);
});

test("stage-1 keeps critical defaults on per-source install path while dry-run shows batch fallback", (t) => {
	const criticalSource = "git:github.com/example/critical@pin";
	const defaults = [
		{ id: "critical", critical: true, source: criticalSource },
		{ id: "helper", source: "npm:helper" },
	];
	const { config } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: defaults.map((entry) => entry.source) },
		dryRun: true,
	});

	const stdout = captureConsole("log", () => installDefaultExtensions(config));

	assert.match(stdout, /Would preflight 1 critical bundled default git checkout target\(s\) before any settings-wide default extension update/);
	assert.match(stdout, /pi install git:github\.com\/example\/critical@pin/);
	assert.match(stdout, /git -C .*\/git\/github\.com\/example\/critical fetch --prune --tags origin/);
	assert.match(stdout, /Dry run: settings-wide extension refresh will run from merged settings/);
	assert.match(stdout, /PI_CODING_AGENT_DIR=.*pi update --extensions/);
	assert.match(stdout, /would retry only 1 non-critical bundled default source\(s\) individually/i);
	assert.doesNotMatch(stdout, /^Would.*\bpi\s+update\b/m);
	assert.doesNotMatch(stdout, /pi update --extension npm:helper/);
});

test("stage-1 canonicalizes relative target dirs before deriving wrapper and state paths", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const cwd = join(root, "workspace");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });

	const previousCwd = process.cwd();
	t.after(() => {
		process.chdir(previousCwd);
		rmSync(root, { recursive: true, force: true });
	});
	process.chdir(cwd);
	const canonicalCwd = process.cwd();

	const env = scrubInstallerEnv({ HOME: homeDir }, {
		...process.env,
		PI_CODING_AGENT_DIR: join(homeDir, ".pi", "agent"),
		TLH_AGENT_DIR: join(homeDir, ".pi", "agent"),
		TLH_BIN_DIR: join(homeDir, ".pi", "agent"),
		TLH_PACKAGE_SOURCE: "~/poisoned-package",
		TLH_REPO: "poisoned/repo",
		TLH_REF: "poisoned-ref",
		TLH_UPDATE_TRACK: "custom",
	});
	const parsed = parseArgs(["--agent-dir", ".pi/agent", "--bin-dir", "bin"], env);
	const config = buildInstallConfig(parsed, env);
	const expectedAgentDir = join(canonicalCwd, ".pi", "agent");
	const expectedBinDir = join(canonicalCwd, "bin");
	const normalPiAgentIfLeftRelative = join(homeDir, ".pi", "agent");

	assert.equal(resolve(homeDir, parsed.agentDirInput), normalPiAgentIfLeftRelative);
	assert.equal(config.agentDir, expectedAgentDir);
	assert.equal(config.binDir, expectedBinDir);
	assert.notEqual(config.agentDir, normalPiAgentIfLeftRelative);
	for (const targetPath of [
		config.agentDir,
		config.binDir,
		config.settingsPath,
		config.keybindingsPath,
		config.supportDir,
		config.statePath,
		config.wrapperPath,
		config.packageRoot,
	]) {
		assert.ok(isAbsolute(targetPath), `expected absolute path: ${targetPath}`);
	}
	assert.equal(config.settingsPath, join(expectedAgentDir, "settings.json"));
	assert.equal(config.keybindingsPath, join(expectedAgentDir, "keybindings.json"));
	assert.equal(config.statePath, join(expectedAgentDir, "tlh", "install-state.json"));
	assert.equal(config.wrapperPath, join(expectedBinDir, "tlh"));
	assert.equal(
		config.packageRoot,
		join(expectedAgentDir, "git", "github.com", "diegopetrucci", "the-last-harness"),
	);
	assert.doesNotThrow(() => validateInstallerTargets(config, { homeDir }));

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		config.agentDir,
		"--bin-dir",
		config.binDir,
		"--wrapper-name",
		config.wrapperName,
		"--package-root",
		config.packageRoot,
	], { homeDir });
	const wrapper = readFileSync(config.wrapperPath, "utf8");
	assert.ok(wrapper.split(/\r?\n/).includes(`default_agent_dir='${config.agentDir}'`));
	assert.doesNotMatch(wrapper, /^default_agent_dir='\.pi\/agent'$/m);
	assert.doesNotMatch(wrapper, /PI_CODING_AGENT_DIR=\.pi\/agent/);

	runHelper("scripts/tlh-install-state.mjs", [
		"--state-path",
		config.statePath,
		"--repo",
		config.repo,
		"--ref",
		config.ref,
		"--track",
		config.updateTrack,
		"--package-source",
		config.packageSource,
		"--package-source-is-default",
		String(config.packageSourceIsDefault),
		"--raw-base",
		config.rawBase,
		"--agent-dir",
		config.agentDir,
		"--bin-dir",
		config.binDir,
		"--wrapper-name",
		config.wrapperName,
	], { homeDir });
	const state = JSON.parse(readFileSync(config.statePath, "utf8"));
	assert.equal(state.agentDir, config.agentDir);
	assert.equal(state.binDir, config.binDir);
	assert.ok(isAbsolute(state.agentDir));
	assert.ok(isAbsolute(state.binDir));
	assert.notEqual(state.agentDir, parsed.agentDirInput);
	assert.notEqual(state.agentDir, normalPiAgentIfLeftRelative);
	assert.equal(existsSync(join(homeDir, ".pi")), false);
});

test("wrapper --pi-cmd validates the pinned binary before fast-path exec", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const pinnedPiDir = join(root, "pinned-pi");
	const piCallLog = join(root, "pi-calls.log");
	const piMainLog = join(root, "pi-main.txt");
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFakePi(pinnedPiDir, [
		`printf '%s\\n' "$*" >>"${piCallLog}"`,
		`if [[  "\${1:-}" == "--version" ]]; then printf '0.79.1\\n'; exit 0; fi`,
		`{ printf 'cmd=%s\\n' "$0"; printf 'argv=%s\\n' "$*"; printf 'agent=%s\\n' "\${PI_CODING_AGENT_DIR:-}"; printf 'path=%s\\n' "\${PATH:-}"; } >"${piMainLog}"`,
		"exit 0",
	].join("\n"));

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
		"--pi-cmd",
		join(pinnedPiDir, "pi"),
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const result = spawnSync(wrapper, ["chat"], {
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: [agentBin, process.env.PATH || ""].join(":"),
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

	const mainRecord = Object.fromEntries(readFileSync(piMainLog, "utf8").trim().split(/\r?\n/).map((line) => {
		const separator = line.indexOf("=");
		return [line.slice(0, separator), line.slice(separator + 1)];
	}));
	assert.equal(mainRecord.argv, "chat");
	assert.equal(mainRecord.agent, agentDir);

	const allCalls = readFileSync(piCallLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
	assert.deepEqual(allCalls, ["--version", "chat"]);
});
test("wrapper --pi-cmd hard-fails when the pinned path is non-executable", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const piLog = join(root, "pi.txt");
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const missingPiCmd = join(root, "nonexistent", "pi");
	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
		"--pi-cmd",
		missingPiCmd,
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const result = spawnSync(wrapper, ["chat"], {
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: [agentBin, process.env.PATH || ""].join(":"),
			PI_WRAPPER_LOG: piLog,
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	// Under the private-runtime model, a missing pinned binary is a hard error.
	assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	assert.match(result.stderr, /private pi runtime not found at/);
	assert.equal(existsSync(piLog), false);
});

test("wrapper --pi-cmd soft-warns when the pinned runtime is 0.79.8 and still exec's it", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const pinnedPiDir = join(root, "pinned-pi");
	const pinnedPiCallLog = join(root, "pinned-pi-calls.log");
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFakePi(pinnedPiDir, [
		`printf '%s\\n' "$*" >>"${pinnedPiCallLog}"`,
		`if [[ "\${1:-}" == "--version" ]]; then printf '0.79.8\\n'; exit 0; fi`,
		// Non-version invocation exits with a recognizable code.
		"exit 85",
	].join("\n"));

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
		"--pi-cmd",
		join(pinnedPiDir, "pi"),
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const result = spawnSync(wrapper, ["chat"], {
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: [agentBin, process.env.PATH || ""].join(":"),
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	// 0.79.8 >= minimum (0.79.1) → soft-warn only, pinned pi is still exec'd.
	assert.match(result.stderr, /private pi version 0\.79\.8 differs from the expected 0\.79\.7/);
	assert.equal(result.status, 85);
	const pinnedCalls = readFileSync(pinnedPiCallLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
	// Wrapper called --version probe + exec'd "chat".
	assert.ok(pinnedCalls.includes("--version"), `expected --version probe; got ${pinnedCalls.join(",")}`);
	assert.ok(pinnedCalls.includes("chat"), `expected chat to be exec'd; got ${pinnedCalls.join(",")}`);
});

test("wrapper --pi-cmd soft-warns on a 0.79.8 pinned runtime even when no fallback exists", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const pinnedPiDir = join(root, "pinned-pi");
	const pinnedPiCallLog = join(root, "pinned-pi-calls.log");
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFakePi(pinnedPiDir, [
		`printf '%s\\n' "$*" >>"${pinnedPiCallLog}"`,
		`if [[ "\${1:-}" == "--version" ]]; then printf '0.79.8\\n'; exit 0; fi`,
		"exit 85",
	].join("\n"));

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
		"--pi-cmd",
		join(pinnedPiDir, "pi"),
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const result = spawnSync(wrapper, ["chat"], {
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: [agentBin, safeInstallerPath(join(root, "fakebin"))].join(":"),
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	// No PATH fallback exists, but 0.79.8 >= min → soft-warn + exec (not hard-fail).
	assert.match(result.stderr, /private pi version 0\.79\.8 differs from the expected 0\.79\.7/);
	assert.equal(result.status, 85);
	const pinnedCalls = readFileSync(pinnedPiCallLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
	assert.ok(pinnedCalls.includes("--version"), `expected --version probe; got ${pinnedCalls.join(",")}`);
	assert.ok(pinnedCalls.includes("chat"), `expected chat to be exec'd; got ${pinnedCalls.join(",")}`);
});



test("wrapper --pi-cmd fast path exports PATH as managed_bin:pinned_dir:sanitized_path", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const pinnedPiDir = join(root, "pinned-pi");
	const stalePiDir = join(root, "stale-pi");
	const piLog = join(root, "pi.txt");
	const stalePiLog = join(root, "stale-pi.log");
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	// Pinned pi logs PATH so we can verify ordering.
	writeFakePi(pinnedPiDir, [
		`if [[ "\${1:-}" == "--version" ]]; then printf '0.79.1\\n'; exit 0; fi`,
		`{ printf 'cmd=%s\\n' "$0"; printf 'argv=%s\\n' "$*"; printf 'agent=%s\\n' "\${PI_CODING_AGENT_DIR:-}"; printf 'path=%s\\n' "\${PATH:-}"; } >"${piLog}"`,
		"exit 0",
	].join("\n"));

	// Stale pi should not be called and should not appear before pinned_dir.
	writeFakePi(stalePiDir, [
		`printf 'stale pi intercepted\\n' >"${stalePiLog}"`,
		"exit 85",
	].join("\n"));

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
		"--pi-cmd",
		join(pinnedPiDir, "pi"),
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const result = spawnSync(wrapper, ["chat"], {
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: [stalePiDir, agentBin, process.env.PATH || ""].join(":"),
			STALE_PI_LOG: stalePiLog,
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

	const piRecord = Object.fromEntries(readFileSync(piLog, "utf8").trim().split(/\r?\n/).map((line) => {
		const separator = line.indexOf("=");
		return [line.slice(0, separator), line.slice(separator + 1)];
	}));
	assert.equal(piRecord.argv, "chat");
	assert.equal(piRecord.agent, agentDir);

	// PATH must be: managed_bin : pinned_dir : sanitized_path (stale entries come after).
	const piPathEntries = piRecord.path.split(":");
	assert.equal(piPathEntries[0], agentBin, `expected managed_bin first; got ${piPathEntries.join(":")}`);
	assert.equal(piPathEntries[1], pinnedPiDir, `expected pinned_dir second; got ${piPathEntries.join(":")}`);
	const stalePiIndex = piPathEntries.indexOf(stalePiDir);
	assert.ok(stalePiIndex === -1 || stalePiIndex > 1, `stale entry must not appear before pinned_dir; PATH: ${piPathEntries.join(":")}`);

	// Verify stale pi was not invoked.
	assert.equal(existsSync(stalePiLog), false);
});

test("wrapper update --extensions helper prepends executable --pi-cmd directory before the sanitized PATH", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const pinnedPiDir = join(root, "pinned-pi");
	const cwdDir = join(root, "cwd");
	const updateLog = join(root, "update.json");
	const nodeDir = dirname(process.execPath);
	const bashPath = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim() || "/bin/bash";
	const bashDir = dirname(bashPath);
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	mkdirSync(cwdDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	mkdirSync(pinnedPiDir, { recursive: true });
	writeFileSync(join(pinnedPiDir, "pi"), "#!/bin/sh\nif [ \"${1:-}\" = \"--version\" ]; then printf '0.79.1\\n'; exit 0; fi\nprintf 'unexpected args: %s\\n' \"$*\" >&2\nexit 1\n", "utf8");
	chmodSync(join(pinnedPiDir, "pi"), 0o755);
	writeFileSync(join(agentDir, "tlh", "recover-update.mjs"), `import { spawnSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst pi = spawnSync("pi", ["--version"], { encoding: "utf8" });\nwriteFileSync(process.env.TLH_UPDATE_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH }, pi: { status: pi.status, stdout: pi.stdout, stderr: pi.stderr, error: pi.error?.message } }));\nprocess.exit(pi.status ?? (pi.error ? 1 : 0));\n`, "utf8");

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
		"--pi-cmd",
		join(pinnedPiDir, "pi"),
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const result = spawnSync(wrapper, ["update", "--extensions", "--dry-run"], {
		cwd: cwdDir,
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: ["", ".", cwdDir, agentBin, nodeDir, bashDir].join(delimiter),
			TLH_UPDATE_LOG: updateLog,
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

	const updateRecord = JSON.parse(readFileSync(updateLog, "utf8"));
	assert.deepEqual(updateRecord.argv, [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--extensions",
		"--dry-run",
	]);
	assert.equal(updateRecord.env.PI_CODING_AGENT_DIR, agentDir);
	assert.equal(updateRecord.pi.status, 0, JSON.stringify(updateRecord));
	assert.match(updateRecord.pi.stdout, /0\.79\.1/);

	const updatePathEntries = updateRecord.env.PATH.split(delimiter);
	assert.equal(updatePathEntries[0], pinnedPiDir, `expected pinned_dir first; got ${updatePathEntries.join(delimiter)}`);
	assert.equal(updatePathEntries[1], nodeDir, `expected sanitized PATH to follow pinned_dir; got ${updatePathEntries.join(delimiter)}`);
	assert.equal(updatePathEntries.includes(""), false);
	assert.equal(updatePathEntries.includes("."), false);
	assert.equal(updatePathEntries.includes(cwdDir), false);
	assert.equal(updatePathEntries.includes(agentBin), false);
});

test("wrapper update --extensions helper prepends the pinned private runtime dir to PATH", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const pinnedPiDir = join(root, "pinned-pi");
	const cwdDir = join(root, "cwd");
	const updateLog = join(root, "update.json");
	const pinnedPiCallLog = join(root, "pinned-pi-calls.log");
	const nodeDir = dirname(process.execPath);
	const bashPath = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim() || "/bin/bash";
	const bashDir = dirname(bashPath);
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	mkdirSync(cwdDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	// Pinned pi at 0.79.8 (soft-warn territory) — still prepended for --extensions.
	writeFakePi(pinnedPiDir, [
		`printf '%s\\n' "$*" >>"${pinnedPiCallLog}"`,
		`if [[ "\${1:-}" == "--version" ]]; then printf '0.79.8\\n'; exit 0; fi`,
		"exit 85",
	].join("\n"));
	writeFileSync(join(agentDir, "tlh", "recover-update.mjs"), `import { spawnSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst pi = spawnSync("pi", ["--version"], { encoding: "utf8" });\nwriteFileSync(process.env.TLH_UPDATE_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH }, pi: { status: pi.status, stdout: pi.stdout, stderr: pi.stderr, error: pi.error?.message } }));\nprocess.exit(pi.status ?? (pi.error ? 1 : 0));\n`, "utf8");

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
		"--pi-cmd",
		join(pinnedPiDir, "pi"),
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const result = spawnSync(wrapper, ["update", "--extensions", "--dry-run"], {
		cwd: cwdDir,
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: ["", ".", cwdDir, agentBin, nodeDir, bashDir].join(delimiter),
			TLH_UPDATE_LOG: updateLog,
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	// For --extensions, the wrapper prepends the private runtime dir regardless of version.
	assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	const updateRecord = JSON.parse(readFileSync(updateLog, "utf8"));
	const updatePathEntries = updateRecord.env.PATH.split(delimiter);
	assert.equal(updatePathEntries[0], pinnedPiDir, `expected pinned pi dir first for --extensions; got ${updatePathEntries.join(delimiter)}`);
	assert.equal(updatePathEntries.includes(""), false);
	assert.equal(updatePathEntries.includes("."), false);
	assert.equal(updatePathEntries.includes(cwdDir), false);
	assert.equal(updatePathEntries.includes(agentBin), false);
	// The update script invokes pi --version and finds the pinned runtime.
	assert.match(updateRecord.pi.stdout, /0\.79\.8/);
});

test("tlh update --extensions uses absolute private runtime pi and hard-fails when missing", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const runtimeBinDir = join(root, "runtime", "bin"); // dirname(agentDir)/runtime/bin
	const pathPiDir = join(root, "path-pi"); // PATH-based pi that must NOT be used
	const piLog = join(root, "pi.txt");
	const pathPiLog = join(root, "path-pi.log");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	// Case 1: private runtime pi exists — must be used, not the PATH pi.
	writeVersionedWrapperPi(runtimeBinDir, piLog);
	writeFakePi(pathPiDir, `printf 'PATH pi should not be called\\n' >"\${PATH_PI_LOG}"\nexit 97`);

	const result = spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-update.mjs"), "--extensions", "--agent-dir", agentDir, "--quiet"], {
		cwd: repoRoot,
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: `${pathPiDir}:${process.env.PATH || ""}`,
			PI_WRAPPER_LOG: piLog,
			PATH_PI_LOG: pathPiLog,
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(result.status, 0, `Case 1 stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	assert.equal(result.stdout, "");
	const piRecord = Object.fromEntries(readFileSync(piLog, "utf8").trim().split(/\r?\n/).map((line) => {
		const separator = line.indexOf("=");
		return [line.slice(0, separator), line.slice(separator + 1)];
	}));
	// Absolute private runtime pi was used — not any PATH-based pi.
	assert.equal(piRecord.cmd, join(runtimeBinDir, "pi"), "expected absolute private runtime pi");
	assert.equal(piRecord.argv, "update --extensions");
	assert.equal(piRecord.agent, agentDir);
	assert.equal(existsSync(pathPiLog), false, "PATH pi must not be called");

	// Case 2: private runtime pi absent, non-dry-run — must hard-fail with a clear error.
	const root2 = makeTempDir();
	const agentDir2 = join(root2, "agent");
	const homeDir2 = join(root2, "home");
	mkdirSync(agentDir2, { recursive: true });
	mkdirSync(homeDir2, { recursive: true });
	t.after(() => rmSync(root2, { recursive: true, force: true }));
	// No private runtime pi created at root2/runtime/bin/pi.
	const missingResult = spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-update.mjs"), "--extensions", "--agent-dir", agentDir2], {
		cwd: repoRoot,
		env: scrubInstallerEnv({
			HOME: homeDir2,
			PATH: `${pathPiDir}:${process.env.PATH || ""}`,
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.notEqual(missingResult.status, 0, "expected hard failure when private runtime pi is missing");
	assert.equal(missingResult.stdout, "");
	assert.match(missingResult.stderr, /private runtime pi not found/);
	assert.match(missingResult.stderr, /tlh update/);
	// Dry-run must NOT hard-fail even when the binary is absent.
	const dryRunResult = spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-update.mjs"), "--extensions", "--dry-run", "--agent-dir", agentDir2], {
		cwd: repoRoot,
		env: scrubInstallerEnv({
			HOME: homeDir2,
			PATH: process.env.PATH || "",
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(dryRunResult.status, 0, `dry-run must succeed even without runtime pi: ${dryRunResult.stderr}`);
	assert.match(dryRunResult.stdout, /Would run:/);
	assert.match(dryRunResult.stdout, new RegExp(join(root2, "runtime", "bin", "pi").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});



test("wrapper plain update helper does not prepend executable --pi-cmd directory", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const pinnedPiDir = join(root, "pinned-pi");
	const cwdDir = join(root, "cwd");
	const updateLog = join(root, "update.json");
	const nodeDir = dirname(process.execPath);
	const bashPath = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim() || "/bin/bash";
	const bashDir = dirname(bashPath);
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	mkdirSync(cwdDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	mkdirSync(pinnedPiDir, { recursive: true });
	writeFileSync(join(pinnedPiDir, "pi"), "#!/bin/sh\nprintf 'unexpected args: %s\\n' \"$*\" >&2\nexit 1\n", "utf8");
	chmodSync(join(pinnedPiDir, "pi"), 0o755);
	writeFileSync(join(agentDir, "tlh", "recover-update.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.TLH_UPDATE_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH } }));\n`, "utf8");

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--package-root",
		packageRoot,
		"--pi-cmd",
		join(pinnedPiDir, "pi"),
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const result = spawnSync(wrapper, ["update", "--dry-run"], {
		cwd: cwdDir,
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: ["", ".", cwdDir, agentBin, nodeDir, bashDir].join(delimiter),
			TLH_UPDATE_LOG: updateLog,
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

	const updateRecord = JSON.parse(readFileSync(updateLog, "utf8"));
	assert.deepEqual(updateRecord.argv, [
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--wrapper-name",
		"tlh",
		"--dry-run",
	]);
	assert.equal(updateRecord.env.PI_CODING_AGENT_DIR, agentDir);

	const updatePathEntries = updateRecord.env.PATH.split(delimiter);
	assert.equal(updatePathEntries[0], nodeDir, `expected sanitized PATH first; got ${updatePathEntries.join(delimiter)}`);
	assert.equal(updatePathEntries.includes(pinnedPiDir), false, `did not expect pinned_dir in PATH: ${updatePathEntries.join(delimiter)}`);
	assert.equal(updatePathEntries.includes(""), false);
	assert.equal(updatePathEntries.includes("."), false);
	assert.equal(updatePathEntries.includes(cwdDir), false);
	assert.equal(updatePathEntries.includes(agentBin), false);
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

	// Template pi with WRONG version (0.79.8 > MAX 0.79.7) — simulates a broken npm install.
	writeFakePi(templateDir, "if [[ \"${1:-}\" == \"--version\" ]]; then printf '0.79.8\\n'; exit 0; fi\nexit 0");

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
	assert.match(output, /0\.79\.8/, "error output should mention the wrong version");

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
// user-owned ~/.local/bin/pi@0.79.7 present.  The installer must provision the private
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

	// User-owned ~/.local/bin/pi@0.79.7 — must NOT be removed or invoked by the installer.
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
	writeFileSync(join(legacyBin, "pi"), "#!/bin/sh\nprintf '0.79.7\\n'\n", "utf8");
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
