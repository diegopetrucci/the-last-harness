import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const installQueryScript = join(repoRoot, "scripts", "tlh-install-query.mjs");

function tempFixture(t) {
	const root = mkdtempSync(join(tmpdir(), "tlh-install-query-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function runInstallQuery(args = [], env = {}) {
	const childEnv = { ...process.env };
	delete childEnv.TLH_CRITICAL_SOURCE;
	delete childEnv.TLH_PACKAGE_SOURCE_VALUE;
	delete childEnv.TLH_AGENT_DIR;
	delete childEnv.TLH_DEFAULTS_FILE;
	delete childEnv.TLH_DEFAULT_EXTENSIONS_FILE;
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, [installQueryScript, ...args], {
		cwd: repoRoot,
		encoding: "utf8",
		env: childEnv,
	});
}

test("tlh-install-query prints help and rejects unknown commands or options", () => {
	const help = runInstallQuery(["--help"]);
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /Usage: tlh-install-query\.mjs <command> \[options\]/);
	assert.equal(help.stderr, "");

	const unknownCommand = runInstallQuery(["wat"]);
	assert.equal(unknownCommand.status, 1);
	assert.match(unknownCommand.stderr, /error: unknown command: wat/);
	assert.equal(unknownCommand.stdout, "");

	const unknownOption = runInstallQuery(["normalize-path", "--wat"]);
	assert.equal(unknownOption.status, 1);
	assert.match(unknownOption.stderr, /error: unknown option: --wat/);
	assert.equal(unknownOption.stdout, "");
});

test("tlh-install-query rejects missing and empty option values consistently", () => {
	const scenarios = [
		{ args: ["critical-git-source-spec", "--source"], error: /error: --source requires a value/ },
		{ args: ["critical-git-source-spec", "--source="], error: /error: --source requires a value/ },
		{ args: ["critical-git-source-spec", "--agent-dir"], error: /error: --agent-dir requires a value/ },
		{ args: ["critical-git-source-spec", "--agent-dir="], error: /error: --agent-dir requires a value/ },
		{ args: ["settings-require-subagent-prompts", "--defaults"], error: /error: --defaults requires a value/ },
		{ args: ["settings-require-subagent-prompts", "--defaults="], error: /error: --defaults requires a value/ },
		{ args: ["normalize-path", "--path"], error: /error: --path requires a value/ },
		{ args: ["normalize-path", "--path="], error: /error: --path requires a value/ },
	];

	for (const scenario of scenarios) {
		const result = runInstallQuery(scenario.args);
		assert.equal(result.status, 1, `${scenario.args.join(" ")} should fail`);
		assert.match(result.stderr, scenario.error);
		assert.equal(result.stdout, "");
	}
});

test("tlh-install-query CLI options override environment defaults", (t) => {
	const root = tempFixture(t);
	const cliAgentDir = join(root, "agent-cli");
	const envAgentDir = join(root, "agent-env");
	mkdirSync(cliAgentDir, { recursive: true });
	mkdirSync(envAgentDir, { recursive: true });

	const spec = runInstallQuery([
		"critical-git-source-spec",
		"--source=git:github.com/cli/repo@v1.2.3",
		`--agent-dir=${cliAgentDir}`,
	], {
		TLH_CRITICAL_SOURCE: "git:github.com/env/repo@main",
		TLH_PACKAGE_SOURCE_VALUE: "git:github.com/env/package@main",
		TLH_AGENT_DIR: envAgentDir,
	});
	assert.equal(spec.status, 0, spec.stderr);
	assert.equal(spec.stdout.trim(), `${join(cliAgentDir, "git", "github.com", "cli", "repo")}\thttps://github.com/cli/repo\tv1.2.3`);

	const defaultsPath = join(root, "defaults.json");
	const envDefaultsPath = join(root, "env-defaults.json");
	writeFileSync(defaultsPath, JSON.stringify({ subagents: { agentDirs: ["tlh/agents/subagents"] } }));
	writeFileSync(envDefaultsPath, JSON.stringify({ subagents: { agentDirs: ["other"] } }));
	const booleanResult = runInstallQuery([
		"settings-require-subagent-prompts",
		`--defaults=${defaultsPath}`,
	], {
		TLH_DEFAULTS_FILE: envDefaultsPath,
	});
	assert.equal(booleanResult.status, 0, booleanResult.stderr);
	assert.equal(booleanResult.stdout, "");
});

test("tlh-install-query normalizes existing symlinks and missing descendant paths", (t) => {
	const root = tempFixture(t);
	const actual = join(root, "actual");
	const alias = join(root, "alias");
	mkdirSync(join(actual, "nested"), { recursive: true });
	symlinkSync(actual, alias, "dir");

	const actualRoot = realpathSync.native(actual);

	const existing = runInstallQuery(["normalize-path", `--path=${join(alias, "nested")}`]);
	assert.equal(existing.status, 0, existing.stderr);
	assert.equal(existing.stdout.trim(), join(actualRoot, "nested"));

	const missing = runInstallQuery(["normalize-path", "--path", join(alias, "future", "child.txt")]);
	assert.equal(missing.status, 0, missing.stderr);
	assert.equal(missing.stdout.trim(), join(actualRoot, "future", "child.txt"));
});

test("tlh-install-query exposes package source compatibility commands without re-testing library algorithms", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });

	const critical = runInstallQuery(["critical-git-source-spec"], {
		TLH_CRITICAL_SOURCE: "git:github.com/acme/tool@refs/tags/v1.2.3",
		TLH_PACKAGE_SOURCE_VALUE: "git:github.com/wrong/fallback@main",
		TLH_AGENT_DIR: agentDir,
	});
	assert.equal(critical.status, 0, critical.stderr);
	assert.equal(critical.stdout.trim(), `${join(agentDir, "git", "github.com", "acme", "tool")}\thttps://github.com/acme/tool\trefs/tags/v1.2.3`);

	const installDir = runInstallQuery([
		"package-source-install-dir",
		"--source=../package-src",
		`--agent-dir=${agentDir}`,
	]);
	assert.equal(installDir.status, 0, installDir.stderr);
	assert.equal(installDir.stdout.trim(), resolve(agentDir, "../package-src"));

	const installSource = runInstallQuery([
		"git-source-install-source",
		"--source=https://github.com/acme/tool.git#v1.2.3",
		`--agent-dir=${agentDir}`,
	]);
	assert.equal(installSource.status, 0, installSource.stderr);
	assert.equal(installSource.stdout.trim(), "git:https://github.com/acme/tool.git@v1.2.3");

	const packageSourceFallback = runInstallQuery(["git-source-install-source"], {
		TLH_PACKAGE_SOURCE_VALUE: "https://github.com/acme/fallback.git#v2.0.0",
	});
	assert.equal(packageSourceFallback.status, 0, packageSourceFallback.stderr);
	assert.equal(packageSourceFallback.stdout.trim(), "git:https://github.com/acme/fallback.git@v2.0.0");
});

test("tlh-install-query boolean commands honor output and exit-status contracts", (t) => {
	const root = tempFixture(t);
	const settingsTrue = join(root, "settings-true.json");
	const settingsFalse = join(root, "settings-false.json");
	const extensionsTrue = join(root, "extensions-true.json");
	const extensionsFalse = join(root, "extensions-false.json");
	writeFileSync(settingsTrue, JSON.stringify({ subagents: { agentDirs: ["tlh/agents/subagents"] } }));
	writeFileSync(settingsFalse, JSON.stringify({ subagents: { agentDirs: ["other"] } }));
	writeFileSync(extensionsTrue, JSON.stringify([{ id: "critical", critical: true }]));
	writeFileSync(extensionsFalse, JSON.stringify([{ id: "optional", critical: false }]));

	const subagentsNeeded = runInstallQuery(["settings-require-subagent-prompts"], { TLH_DEFAULTS_FILE: settingsTrue });
	assert.equal(subagentsNeeded.status, 0, subagentsNeeded.stderr);
	assert.equal(subagentsNeeded.stdout, "");
	assert.equal(subagentsNeeded.stderr, "");

	const subagentsNotNeeded = runInstallQuery(["settings-require-subagent-prompts", "--defaults", settingsFalse]);
	assert.equal(subagentsNotNeeded.status, 1);
	assert.equal(subagentsNotNeeded.stdout, "");
	assert.equal(subagentsNotNeeded.stderr, "");

	const subagentsSkipped = runInstallQuery(["settings-require-subagent-prompts", "--defaults", settingsTrue, "--no-settings"]);
	assert.equal(subagentsSkipped.status, 1);
	assert.equal(subagentsSkipped.stdout, "");

	const criticalNeeded = runInstallQuery(["default-extensions-require-critical-install"], { TLH_DEFAULT_EXTENSIONS_FILE: extensionsTrue });
	assert.equal(criticalNeeded.status, 0, criticalNeeded.stderr);
	assert.equal(criticalNeeded.stdout, "");
	assert.equal(criticalNeeded.stderr, "");

	const criticalNotNeeded = runInstallQuery(["default-extensions-require-critical-install", "--defaults", extensionsFalse]);
	assert.equal(criticalNotNeeded.status, 1);
	assert.equal(criticalNotNeeded.stdout, "");
	assert.equal(criticalNotNeeded.stderr, "");

	const criticalSkipped = runInstallQuery(["default-extensions-require-critical-install", "--defaults", extensionsTrue, "--no-settings"]);
	assert.equal(criticalSkipped.status, 1);
	assert.equal(criticalSkipped.stdout, "");
});
