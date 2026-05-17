import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildInstallConfig, parseArgs } from "../scripts/tlh-install.mjs";
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
