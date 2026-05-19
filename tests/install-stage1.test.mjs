import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	MIN_NODE_VERSION,
	assertSupportedNodeRuntime,
	buildInstallConfig,
	installDefaultExtensions,
	nodeVersionMeetsMinimum,
	parseArgs,
} from "../scripts/tlh-install.mjs";
import { validateInstallerTargets } from "../scripts/lib/tlh-install-paths.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

function runQuery(args, env = scrubInstallerEnv()) {
	return spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-install-query.mjs"), ...args], {
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

test("declared Node minimum stays aligned across installer metadata", () => {
	const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	const installSh = readFileSync(join(repoRoot, "install.sh"), "utf8");
	const releaseWorkflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");

	assert.equal(packageJson.engines.node, `>=${MIN_NODE_VERSION}`);
	assert.ok(installSh.includes(`TLH_MIN_NODE_VERSION="${MIN_NODE_VERSION}"`));
	assert.ok(releaseWorkflow.includes(`node-version: '${MIN_NODE_VERSION}'`));
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

test("install query normalize-path requires explicit path", () => {
	const result = runQuery(["normalize-path"], scrubInstallerEnv({}, {
		...process.env,
		PI_CODING_AGENT_DIR: "/tmp/poisoned-pi-agent",
		TLH_AGENT_DIR: "/tmp/poisoned-agent",
	}));

	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /error: normalize-path requires --path/);
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
