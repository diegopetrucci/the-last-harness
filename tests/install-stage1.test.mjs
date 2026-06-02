import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	MIN_NODE_VERSION,
	assertSupportedNodeRuntime,
	buildInstallConfig,
	installDefaultExtensions,
	nodeVersionMeetsMinimum,
	parseArgs,
	usage,
} from "../scripts/tlh-install.mjs";
import { validateInstallerTargets } from "../scripts/lib/tlh-install-paths.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoNodeModulesBin = join(repoRoot, "node_modules", ".bin");

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

function writeLoggingPi(commandDir, logPath, version = "0.76.0") {
	writeFakePi(commandDir, [
		`printf '%s|%s|%s\\n' "\${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${logPath}"`,
		`if [[ "\${1:-}" == "--version" ]]; then printf '${version}\\n'; exit 0; fi`,
		"exit 0",
	].join("\n"));
}

function writeVersionedWrapperPi(commandDir, logPath, version = "0.76.0") {
	writeFakePi(commandDir, [
		`if [[ "\${1:-}" == "--version" ]]; then printf '${version}\\n'; exit 0; fi`,
		`{ printf 'cmd=%s\\n' "$0"; printf 'argv=%s\\n' "$*"; printf 'agent=%s\\n' "\${PI_CODING_AGENT_DIR:-}"; printf 'path=%s\\n' "\${PATH:-}"; } >"${logPath}"`,
		"exit 0",
	].join("\n"));
}

function writeFakeNpmInstaller(fakebin, { npmLog, templatePiPath, installedPiPath }) {
	writeFakeCommand(fakebin, "npm", [
		`printf '%s\\n' "$*" >>"${npmLog}"`,
		`mkdir -p "${dirname(installedPiPath)}"`,
		`cp "${templatePiPath}" "${installedPiPath}"`,
		`chmod +x "${installedPiPath}"`,
	].join("\n"));
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

test("stage-1 hard-fails existing Pi version probes that exit nonzero", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFakePi(fakebin, "printf 'version probe failed\\n' >&2\nexit 23");
	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: `${fakebin}:${process.env.PATH || ""}`,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});
	const result = runInstaller(["--dry-run", "--agent-dir", agentDir, "--bin-dir", binDir], env);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /unable to determine Pi version from existing pi on PATH/);
	assert.match(result.stderr, /pi --version exited with 23/);
	assert.match(result.stderr, /The Last Harness requires Pi >= 0\.76\.0/);
	assert.match(result.stderr, /Verify that `pi --version` works, or upgrade with: npm install -g --ignore-scripts --prefix /);
	assert.match(result.stderr, /Probe output: version probe failed/);
});

test("stage-1 probes existing Pi version with the isolated agent dir", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const probeLog = join(root, "pi-version-probe.log");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFakePi(fakebin, [
		"printf '%s\\n' \"${PI_CODING_AGENT_DIR:-}\" >\"${PROBE_LOG}\"",
		"if [[ \"${PI_CODING_AGENT_DIR:-}\" != \"${EXPECTED_AGENT_DIR}\" ]]; then",
		"\tprintf 'poisoned profile\\n' >&2",
		"\texit 24",
		"fi",
		"printf '0.76.0\\n'",
	].join("\n"));
	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: `${fakebin}:${process.env.PATH || ""}`,
		PI_CODING_AGENT_DIR: join(root, "poisoned-pi-agent"),
		EXPECTED_AGENT_DIR: agentDir,
		PROBE_LOG: probeLog,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});
	const result = runInstaller(["--dry-run", "--agent-dir", agentDir, "--bin-dir", binDir], env);
	assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	assert.equal(readFileSync(probeLog, "utf8").trim(), agentDir);
	assert.doesNotMatch(result.stderr, /poisoned profile/);
});

test("stage-1 hard-fails existing Pi version probes with unparsable output", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFakePi(fakebin, "printf 'development build\\n'");
	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: `${fakebin}:${process.env.PATH || ""}`,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});
	const result = runInstaller(["--dry-run", "--agent-dir", agentDir, "--bin-dir", binDir], env);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /unable to parse Pi version from existing pi on PATH: development build/);
	assert.match(result.stderr, /The Last Harness requires Pi >= 0\.76\.0/);
	assert.match(result.stderr, /Verify that `pi --version` prints a semantic version like 0\.76\.0, or upgrade with: npm install -g --ignore-scripts --prefix /);
});

test("stage-1 rejects existing Pi older than the TLH minimum", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFakePi(fakebin, "printf '0.75.2\\n'");
	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: `${fakebin}:${process.env.PATH || ""}`,
		TLH_SKIP_GNOSIS_INSTALL: "1",
	});
	const result = runInstaller(["--dry-run", "--agent-dir", agentDir, "--bin-dir", binDir], env);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Pi >= 0\.76\.0 is required \(found 0\.75\.2\)\. Upgrade with: npm install -g --ignore-scripts --prefix /);
});

test("stage-1 reuses a per-user Pi runtime outside PATH without claiming ownership", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const packageDir = join(root, "package-source");
	const npmLog = join(root, "npm.log");
	const piLog = join(root, "pi.log");
	const perUserPiDir = join(homeDir, ".local", "bin");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	writeFakeCommand(fakebin, "git", "exit 0");
	writeFakeCommand(fakebin, "npm", `printf '%s\\n' "$*" >>"${npmLog}"`);
	writeFakeTk(fakebin);
	writeLoggingPi(perUserPiDir, piLog);

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
	assert.equal(existsSync(npmLog), false, output);
	assert.match(output, /Existing Pi runtime .*\.local\/bin\/pi is not on PATH\. Added it to PATH for this install/);
	assert.doesNotMatch(output, /Installing Pi runtime to .*\.local/);
	const piRecords = readPiLogRecords(piLog);
	assert.equal(piRecords[0]?.command, "--version");
	assert.equal(piRecords[0]?.agentDir, agentDir);
	assert.equal(realpathSync(piRecords[1]?.cwd), realpathSync(agentDir));
	assert.equal(realpathSync(piRecords[2]?.cwd), realpathSync(agentDir));
	assert.equal(piRecords[1]?.command, `install ${packageDir}`);
	assert.equal(piRecords[2]?.command, `update ${packageDir}`);
	const state = readJson(join(agentDir, "tlh", "install-state.json"));
	assert.equal(state.piInstalledByTlh, false);
});


test("stage-1 prefers a supported per-user Pi runtime over a stale PATH Pi", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const stalePiDir = join(root, "stale-pi");
	const packageDir = join(root, "package-source");
	const npmLog = join(root, "npm.log");
	const stalePiLog = join(root, "stale-pi.log");
	const perUserPiLog = join(root, "per-user-pi.log");
	const perUserPiDir = join(homeDir, ".local", "bin");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	writeFakeCommand(fakebin, "git", "exit 0");
	writeFakeCommand(fakebin, "npm", `printf '%s\\n' "$*" >>"${npmLog}"`);
	writeFakeTk(fakebin);
	writeFakePi(stalePiDir, [
		`printf '%s|%s|%s\\n' "\${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${stalePiLog}"`,
		"if [[ \"${1:-}\" == \"--version\" ]]; then printf '0.75.2\\n'; exit 0; fi",
		"exit 0",
	].join("\n"));
	writeLoggingPi(perUserPiDir, perUserPiLog);

	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: [stalePiDir, perUserPiDir, safeInstallerPath(fakebin)].join(delimiter),
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
	assert.equal(existsSync(npmLog), false, output);
	assert.match(output, /Using validated per-user Pi runtime .*\.local\/bin\/pi instead of the current PATH entry/);
	assert.doesNotMatch(output, /Installing Pi runtime to .*\.local/);
	assert.deepEqual(readPiLogRecords(stalePiLog).map((record) => record.command), ["--version"]);
	const perUserRecords = readPiLogRecords(perUserPiLog);
	assert.deepEqual(perUserRecords.map((record) => record.command), [
		"--version",
		`install ${packageDir}`,
		`update ${packageDir}`,
	]);
	assert.equal(perUserRecords[0]?.agentDir, agentDir);
	assert.equal(realpathSync(perUserRecords[1]?.cwd), realpathSync(agentDir));
	assert.equal(realpathSync(perUserRecords[2]?.cwd), realpathSync(agentDir));
	const state = readJson(join(agentDir, "tlh", "install-state.json"));
	assert.equal(state.piInstalledByTlh, false);
});

test("stage-1 refuses to reinstall over a broken per-user Pi npm package", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const packageDir = join(root, "package-source");
	const npmLog = join(root, "npm.log");
	const perUserPiPackageDir = join(homeDir, ".local", "lib", "node_modules", "@earendil-works", "pi-coding-agent");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(perUserPiPackageDir, { recursive: true });
	writeFakeCommand(fakebin, "git", "exit 0");
	writeFakeCommand(fakebin, "npm", `printf '%s\\n' "$*" >>"${npmLog}"`);

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

	assert.notEqual(result.status, 0, output);
	assert.equal(existsSync(npmLog), false, output);
	assert.match(output, /detected an existing per-user Pi npm package/);
	assert.match(output, new RegExp(perUserPiPackageDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(output, /no runnable pi binary could be validated/);
	assert.match(output, /The Last Harness will not reinstall over that package or mark it TLH-owned/);
	assert.match(output, /Repair or remove the existing package, then rerun the installer/);
	assert.match(output, /npm install -g --ignore-scripts --prefix /);
	assert.equal(existsSync(join(agentDir, "tlh", "install-state.json")), false, output);
});

test("stage-1 records piInstalledByTlh=true when an update installs Pi", (t) => {
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
		const root = makeTempDir(`tlh-install-stage1-update-${scenario.name.replace(/\s+/g, "-")}-`);
		const homeDir = join(root, "home");
		const agentDir = join(root, "agent");
		const binDir = join(root, "bin");
		const fakebin = join(root, "fakebin");
		const packageDir = join(root, "package-source");
		const npmLog = join(root, "npm.log");
		const piLog = join(root, "pi.log");
		const templateDir = join(root, "pi-template");
		const installedPiPath = join(homeDir, ".local", "bin", "pi");
		t.after(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(homeDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });
		mkdirSync(join(agentDir, "tlh"), { recursive: true });
		writeFileSync(join(agentDir, "tlh", "install-state.json"), JSON.stringify(scenario.state, null, 2));
		writeFakeCommand(fakebin, "git", "exit 0");
		writeFakeTk(fakebin);
		writeLoggingPi(templateDir, piLog);
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
			`install -g --ignore-scripts --prefix ${join(homeDir, ".local")} @earendil-works/pi-coding-agent`,
		], scenario.name);
		const state = readJson(join(agentDir, "tlh", "install-state.json"));
		assert.equal(state.piInstalledByTlh, true, scenario.name);
		assert.deepEqual(readPiLogRecords(piLog).map((record) => record.command), [
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
	assert.match(stage0Help.stdout, /installed per-user under ~\/\.local when missing;/);
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
	assert.doesNotMatch(usage(), /--no-pi-install/);

	const updateHelp = spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-update.mjs"), "--help"], {
		cwd: repoRoot,
		env: scrubInstallerEnv({ HOME: homeDir }),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(updateHelp.status, 0, updateHelp.stderr);
	assert.match(updateHelp.stdout, /Missing upstream Pi is installed per-user under ~\/\.local/);
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

test("stage-1 --no-settings does not short-circuit Gnosis configure", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	mkdirSync(homeDir, { recursive: true });
	writeFakePi(fakebin, "if [[ \"${1:-}\" == \"--version\" ]]; then\n\tprintf '0.76.0\\n'\n\texit 0\nfi\nexit 0");
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

	runHelper("scripts/tlh-wrapper.mjs", [
		"--agent-dir",
		gitConfig.agentDir,
		"--bin-dir",
		gitConfig.binDir,
		"--wrapper-name",
		gitConfig.wrapperName,
		"--package-root",
		gitConfig.packageRoot,
	], { homeDir });
	const wrapper = readFileSync(gitConfig.wrapperPath, "utf8");
	assert.ok(wrapper.split(/\r?\n/).includes(`default_tlh_package_root='${gitConfig.packageRoot}'`));

	const relativeLocalConfig = configFor("../local-package");
	assert.equal(relativeLocalConfig.packageRoot, resolve(agentDir, "../local-package"));

	const homeLocalConfig = configFor("~/local-package");
	assert.equal(homeLocalConfig.packageRoot, join(homeDir, "local-package"));

	const unsupportedConfig = configFor("github:owner/repo");
	assert.equal(
		unsupportedConfig.packageRoot,
		join(agentDir, "git", "github.com", "diegopetrucci", "the-last-harness"),
	);
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
	mkdirSync(packageRoot, { recursive: true });
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
	writeFileSync(join(agentDir, "tlh", "tlh-update.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.TLH_UPDATE_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH } }));\n`, "utf8");
	writeFileSync(join(agentDir, "tlh", "tlh-tickets.mjs"), `import { spawnSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst tk = spawnSync("tk", ["help"], { encoding: "utf8" });\nwriteFileSync(process.env.TLH_TICKETS_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH }, tk: { status: tk.status, stdout: (tk.stdout || "").trim(), stderr: (tk.stderr || "").trim(), error: tk.error?.message } }));\nprocess.exit(tk.status ?? (tk.error ? 1 : 0));\n`, "utf8");
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
	mkdirSync(packageRoot, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFakePi(agentBin, `printf 'managed:%s\n' "$*" >>"${piProbeLog}"
exit 63`);
	writeFakeCommand(agentBin, "tk", "if [[ \"${1:-}\" == \"help\" ]]; then printf 'isolated tk help\\n'; exit 0; fi\nexit 1");
	writeFakePi(fakebin, `printf 'path:%s\n' "$*" >>"${piProbeLog}"
exit 64`);
	writeFileSync(join(agentDir, "tlh", "tlh-defaults.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.TLH_DEFAULTS_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH } }));\n`, "utf8");
	writeFileSync(join(agentDir, "tlh", "default-extensions.json"), "[]\n", "utf8");
	writeFileSync(join(agentDir, "tlh", "tlh-tickets.mjs"), `import { spawnSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst tk = spawnSync("tk", ["help"], { encoding: "utf8" });\nwriteFileSync(process.env.TLH_TICKETS_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH }, tk: { status: tk.status, stdout: (tk.stdout || "").trim(), stderr: (tk.stderr || "").trim(), error: tk.error?.message } }));\nprocess.exit(tk.status ?? (tk.error ? 1 : 0));\n`, "utf8");

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
		join(agentDir, "tlh", "default-extensions.json"),
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
	assert.equal(piRecord.cmd, join(realpathSync(safeBin), "pi"));
	assert.ok(isAbsolute(piRecord.cmd), `expected absolute pi path: ${piRecord.cmd}`);
	assert.equal(piRecord.argv, "chat");
	assert.equal(piRecord.agent, agentDir);
	const piPathEntries = piRecord.path.split(":");
	assert.deepEqual(piPathEntries.slice(0, 2), [agentBin, safeBinName]);
	assert.equal(existsSync(isolatedPiLog), false);
	assert.equal(existsSync(functionPiLog), false);
});


test("wrapper prefers a validated per-user ~/.local/bin/pi over a stale PATH Pi", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const stalePiDir = join(root, "stale-pi");
	const perUserPiDir = join(homeDir, ".local", "bin");
	const piLog = join(root, "pi.txt");
	const stalePiLog = join(root, "stale-pi.log");
	const isolatedPiLog = join(root, "isolated-pi.log");
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFakePi(agentBin, "printf 'isolated pi intercepted\\n' >\"${ISOLATED_PI_LOG}\"\nexit 89");
	writeFakePi(stalePiDir, [
		"if [[ \"${1:-}\" == \"--version\" ]]; then printf '0.75.2\\n'; exit 0; fi",
		"printf 'stale pi intercepted\\n' >\"${STALE_PI_LOG}\"",
		"exit 85",
	].join("\n"));
	writeFakePi(perUserPiDir, [
		"if [[ \"${1:-}\" == \"--version\" ]]; then printf '0.76.0\\n'; exit 0; fi",
		"{ printf 'cmd=%s\\n' \"$0\"; printf 'argv=%s\\n' \"$*\"; printf 'agent=%s\\n' \"${PI_CODING_AGENT_DIR:-}\"; printf 'path=%s\\n' \"${PATH:-}\"; } >\"${PI_WRAPPER_LOG}\"",
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
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const result = spawnSync(wrapper, ["chat", "--version"], {
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: [stalePiDir, perUserPiDir, agentBin, process.env.PATH || ""].join(":"),
			PI_WRAPPER_LOG: piLog,
			STALE_PI_LOG: stalePiLog,
			ISOLATED_PI_LOG: isolatedPiLog,
		}),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

	assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	const piRecord = Object.fromEntries(readFileSync(piLog, "utf8").trim().split(/\r?\n/).map((line) => {
		const separator = line.indexOf("=");
		return [line.slice(0, separator), line.slice(separator + 1)];
	}));
	assert.equal(piRecord.cmd, join(perUserPiDir, "pi"));
	assert.ok(isAbsolute(piRecord.cmd), `expected absolute pi path: ${piRecord.cmd}`);
	assert.equal(piRecord.argv, "chat --version");
	assert.equal(piRecord.agent, agentDir);
	const piPathEntries = piRecord.path.split(":");
	assert.deepEqual(piPathEntries.slice(0, 3), [agentBin, perUserPiDir, stalePiDir]);
	assert.equal(existsSync(stalePiLog), false);
	assert.equal(existsSync(isolatedPiLog), false);
});

test("wrapper keeps a supported PATH Pi ahead of a supported per-user ~/.local/bin/pi", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const supportedPiDir = join(root, "supported-pi");
	const perUserPiDir = join(homeDir, ".local", "bin");
	const piLog = join(root, "pi.txt");
	const perUserPiLog = join(root, "per-user-pi.log");
	const isolatedPiLog = join(root, "isolated-pi.log");
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFakePi(agentBin, "printf 'isolated pi intercepted\\n' >\"${ISOLATED_PI_LOG}\"\nexit 89");
	writeVersionedWrapperPi(supportedPiDir, piLog);
	writeFakePi(perUserPiDir, [
		"if [[ \"${1:-}\" == \"--version\" ]]; then printf '0.76.0\\n'; exit 0; fi",
		"printf 'per-user pi intercepted\\n' >\"${PER_USER_PI_LOG}\"",
		"exit 84",
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
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const result = spawnSync(wrapper, ["chat"], {
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: [supportedPiDir, perUserPiDir, agentBin, process.env.PATH || ""].join(":"),
			PI_WRAPPER_LOG: piLog,
			PER_USER_PI_LOG: perUserPiLog,
			ISOLATED_PI_LOG: isolatedPiLog,
		}),
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
	assert.deepEqual(piPathEntries.slice(0, 3), [agentBin, supportedPiDir, perUserPiDir]);
	assert.equal(existsSync(perUserPiLog), false);
	assert.equal(existsSync(isolatedPiLog), false);
});

test("wrapper keeps sanitized PATH order when per-user ~/.local/bin/pi is stale", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const supportedPiDir = join(root, "supported-pi");
	const perUserPiDir = join(homeDir, ".local", "bin");
	const piLog = join(root, "pi.txt");
	const stalePiLog = join(root, "stale-pi.log");
	const isolatedPiLog = join(root, "isolated-pi.log");
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFakePi(agentBin, "printf 'isolated pi intercepted\\n' >\"${ISOLATED_PI_LOG}\"\nexit 89");
	writeVersionedWrapperPi(supportedPiDir, piLog);
	writeFakePi(perUserPiDir, [
		"if [[ \"${1:-}\" == \"--version\" ]]; then printf '0.75.2\\n'; exit 0; fi",
		"printf 'stale pi intercepted\\n' >\"${STALE_PI_LOG}\"",
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
	], { homeDir });

	const wrapper = join(binDir, "tlh");
	const result = spawnSync(wrapper, ["chat"], {
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: [supportedPiDir, agentBin, process.env.PATH || ""].join(":"),
			PI_WRAPPER_LOG: piLog,
			STALE_PI_LOG: stalePiLog,
			ISOLATED_PI_LOG: isolatedPiLog,
		}),
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
	assert.equal(existsSync(stalePiLog), false);
	assert.equal(existsSync(isolatedPiLog), false);
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

	writeFakePi(fakebin, "printf 'path=%s\\n' \"${PATH:-}\" >\"${PI_WRAPPER_LOG}\"");

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

test("tlh update --extensions resolves pi on the sanitized PATH and targets the isolated agent dir", (t) => {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const agentBinLink = join(root, "agent-bin-link");
	const cwdDir = join(root, "cwd");
	const cwdLink = join(root, "cwd-link");
	const safeBin = join(root, "safe-bin");
	const piLog = join(root, "pi.txt");
	const currentPiLog = join(root, "current-pi.log");
	const isolatedPiLog = join(root, "isolated-pi.log");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(cwdDir, { recursive: true });
	if (process.platform !== "win32") {
		symlinkSync(agentBin, agentBinLink, "dir");
		symlinkSync(cwdDir, cwdLink, "dir");
	}
	writeFakePi(agentBin, "printf 'isolated pi intercepted\\n' >\"${ISOLATED_PI_LOG}\"\nexit 89");
	writeFakePi(cwdDir, "printf 'current-dir pi intercepted\\n' >\"${CURRENT_PI_LOG}\"\nexit 86");
	writeVersionedWrapperPi(safeBin, piLog);
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const poisonedPathEntries = ["", ".", cwdDir, agentBin];
	if (process.platform !== "win32") poisonedPathEntries.push(cwdLink, agentBinLink);
	poisonedPathEntries.push(safeBin, process.env.PATH || "");
	const result = spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-update.mjs"), "--extensions", "--agent-dir", agentDir, "--quiet"], {
		cwd: cwdDir,
		env: scrubInstallerEnv({
			HOME: homeDir,
			PATH: poisonedPathEntries.join(":"),
			PI_WRAPPER_LOG: piLog,
			CURRENT_PI_LOG: currentPiLog,
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
	assert.equal(piRecord.cmd, join(safeBin, "pi"));
	assert.equal(piRecord.argv, "update --extensions");
	assert.equal(piRecord.agent, agentDir);
	assert.notEqual(piRecord.agent, join(homeDir, ".pi", "agent"));
	const piPathEntries = piRecord.path.split(":");
	assert.equal(piPathEntries[0], safeBin);
	assert.equal(piPathEntries.includes(""), false);
	assert.equal(piPathEntries.includes("."), false);
	assert.equal(piPathEntries.includes(cwdDir), false);
	assert.equal(piPathEntries.includes(agentBin), false);
	if (process.platform !== "win32") {
		assert.equal(piPathEntries.includes(cwdLink), false);
		assert.equal(piPathEntries.includes(agentBinLink), false);
	}
	assert.equal(existsSync(currentPiLog), false);
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
