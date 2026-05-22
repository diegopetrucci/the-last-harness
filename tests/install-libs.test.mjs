import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
	criticalGitSourceSpec,
	gitSourceInstallSource,
	packageSourceInstallDir,
	parseGitSource,
} from "../scripts/lib/tlh-install-package-source.mjs";
import { assertGitSourceTargetSafe, refreshGitCheckout } from "../scripts/lib/tlh-install-git.mjs";
import {
	assertProfilePathWithinAgent,
	ensureSafeProfileDir,
	pathIsProtectedPiConfig,
	safeProfileFileTarget,
	validateInstallerTargets,
} from "../scripts/lib/tlh-install-paths.mjs";
import {
	TLH_SUBAGENT_PROMPTS,
	copyTlhSubagentPrompts,
	findTlhSubagentsDir,
	missingTlhSubagentPrompts,
	settingsRequireTlhSubagentPrompts,
} from "../scripts/lib/tlh-install-subagents.mjs";
import { supportFileManifest } from "../scripts/lib/tlh-install-support-manifest.mjs";

function tempFixture(t, prefix = "tlh-install-lib-test-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function writePromptSet(dir, label = "prompt") {
	mkdirSync(dir, { recursive: true });
	for (const prompt of TLH_SUBAGENT_PROMPTS) {
		writeFileSync(join(dir, prompt), `${label}:${prompt}\n`);
	}
}

function runCommand(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		...options,
	});
	assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
	return result.stdout.trim();
}

function runGit(args, options = {}) {
	return runCommand("git", args, options);
}

function createManagedGitCheckout(t) {
	const root = tempFixture(t, "tlh-install-git-test-");
	const agentDir = join(root, "agent");
	const seedDir = join(root, "seed");
	const originDir = join(root, "origin.git");
	const targetDir = join(agentDir, "git", "github.com", "owner", "repo");

	mkdirSync(seedDir, { recursive: true });
	runGit(["init", seedDir]);
	runGit(["-C", seedDir, "checkout", "-b", "main"]);
	runGit(["-C", seedDir, "config", "user.email", "tests@example.com"]);
	runGit(["-C", seedDir, "config", "user.name", "TLH Tests"]);
	writeFileSync(join(seedDir, ".gitignore"), "build/\n");
	writeFileSync(join(seedDir, "tracked.txt"), "tracked v1\n");
	runGit(["-C", seedDir, "add", "."]);
	runGit(["-C", seedDir, "commit", "-m", "initial"]);
	runGit(["clone", "--bare", seedDir, originDir]);
	mkdirSync(join(agentDir, "git", "github.com", "owner"), { recursive: true });
	runGit(["clone", originDir, targetDir]);

	return { agentDir, originDir, targetDir };
}

function gitCheckoutIo(warnings) {
	return {
		runCommand(_config, commandArgs, options = {}) {
			const [command, ...args] = commandArgs;
			runCommand(command, args, {
				cwd: options.cwd,
				env: options.env ? { ...process.env, ...options.env } : process.env,
			});
		},
		warn(message) {
			warnings.push(message);
		},
	};
}

function listBackupRefs(targetDir) {
	const refs = runGit(["-C", targetDir, "for-each-ref", "refs/tlh-backup", "--format=%(refname)"]);
	return refs === "" ? [] : refs.split("\n");
}

test("package-source parsing resolves git, hash-pinned, and local package sources", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const homeDir = join(root, "home");

	assert.deepEqual(parseGitSource("git:github.com/diegopetrucci/the-last-harness@main"), {
		repo: "https://github.com/diegopetrucci/the-last-harness",
		host: "github.com",
		path: "diegopetrucci/the-last-harness",
		ref: "main",
	});
	assert.deepEqual(criticalGitSourceSpec("git@github.com:owner/repo@feature", { agentDir }), {
		targetDir: join(agentDir, "git", "github.com", "owner", "repo"),
		repo: "git@github.com:owner/repo",
		ref: "feature",
	});
	assert.equal(
		gitSourceInstallSource("https://github.com/acme/tool.git#v1.2.3", { agentDir }),
		"git:https://github.com/acme/tool.git@v1.2.3",
	);
	assert.equal(packageSourceInstallDir("../local-package", { agentDir, homeDir }), resolve(agentDir, "../local-package"));
	assert.equal(packageSourceInstallDir("~/local-package", { agentDir, homeDir }), join(homeDir, "local-package"));
	assert.equal(packageSourceInstallDir("github:owner/repo", { agentDir, homeDir }), "");
});

test("git source target guard rejects existing non-git checkout dirs", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const source = "git:github.com/owner/repo@main";
	const targetDir = join(agentDir, "git", "github.com", "owner", "repo");

	assert.doesNotThrow(() => assertGitSourceTargetSafe({ agentDir }, source, "The Last Harness package checkout"));
	mkdirSync(targetDir, { recursive: true });
	assert.throws(
		() => assertGitSourceTargetSafe({ agentDir }, source, "The Last Harness package checkout"),
		/refusing to use existing non-git The Last Harness package checkout/,
	);
});

test("normal Pi config guards reject agent, wrapper, and profile writes under ~/.pi", (t) => {
	const root = tempFixture(t);
	const homeDir = join(root, "home");
	mkdirSync(homeDir, { recursive: true });

	assert.equal(pathIsProtectedPiConfig(join(homeDir, ".pi", "agent"), { homeDir }), true);
	assert.equal(pathIsProtectedPiConfig(join(homeDir, ".pi-other", "agent"), { homeDir }), false);

	assert.throws(
		() => validateInstallerTargets({
			agentDir: join(homeDir, ".pi", "agent"),
			binDir: join(root, "bin"),
			wrapperPath: join(root, "bin", "tlh"),
			wrapperName: "tlh",
			updateTrack: "ref",
		}, { homeDir }),
		/refusing to place The Last Harness agent dir under normal Pi config root/,
	);
	assert.throws(
		() => validateInstallerTargets({
			agentDir: join(root, "agent"),
			binDir: join(homeDir, ".pi", "agent"),
			wrapperPath: join(homeDir, ".pi", "agent", "tlh"),
			wrapperName: "tlh",
			updateTrack: "ref",
		}, { homeDir }),
		/refusing to place The Last Harness wrapper dir under normal Pi config root/,
	);
	assert.throws(
		() => validateInstallerTargets({
			agentDir: join(root, "agent"),
			binDir: join(root, "bin"),
			wrapperPath: join(homeDir, ".pi", "agent", "tlh"),
			wrapperName: "tlh",
			updateTrack: "ref",
		}, { homeDir }),
		/refusing to place The Last Harness wrapper under normal Pi config root/,
	);
	assert.doesNotThrow(() => validateInstallerTargets({
		agentDir: join(root, "agent"),
		binDir: join(root, "bin"),
		wrapperPath: join(root, "bin", "tlh"),
		wrapperName: "tlh",
		updateTrack: "ref",
	}, { homeDir }));
	assert.equal(existsSync(join(homeDir, ".pi")), false);

	assert.throws(
		() => assertProfilePathWithinAgent({ agentDir: join(root, "agent") }, join(root, "outside", "settings.json"), "test file", { homeDir }),
		/refusing to write test file outside the isolated TLH profile/,
	);
});

test("safeProfileFileTarget rejects single-segment file targets", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const homeDir = join(root, "home");
	mkdirSync(homeDir, { recursive: true });

	assert.throws(
		() => safeProfileFileTarget({ agentDir }, "settings.json", "test file", { homeDir }),
		/refusing unsafe test file: settings\.json/,
	);
	assert.equal(existsSync(agentDir), false);
	assert.equal(existsSync(join(agentDir, "settings.jso")), false);
});

test("ensureSafeProfileDir rejects protected profile roots before creating them", (t) => {
	const root = tempFixture(t);
	const homeDir = join(root, "home");
	const protectedAgentDir = join(homeDir, ".pi", "agent");
	mkdirSync(homeDir, { recursive: true });

	assert.throws(
		() => ensureSafeProfileDir({ agentDir: protectedAgentDir }, "tlh", "test directory", { homeDir }),
		/refusing to write test directory under normal Pi config root/,
	);
	assert.equal(existsSync(protectedAgentDir), false);
	assert.equal(existsSync(join(homeDir, ".pi")), false);
});

test("refreshGitCheckout preserves ignored local files without creating backup refs", (t) => {
	const { agentDir, originDir, targetDir } = createManagedGitCheckout(t);
	const warnings = [];
	const ignoredFile = join(targetDir, "build", "local.txt");

	mkdirSync(join(targetDir, "build"), { recursive: true });
	writeFileSync(ignoredFile, "keep me\n");

	refreshGitCheckout({ agentDir }, {
		targetDir,
		repo: originDir,
		ref: "main",
		label: "test checkout",
		missingMessage: `missing checkout: ${targetDir}`,
	}, gitCheckoutIo(warnings));

	assert.equal(readFileSync(ignoredFile, "utf8"), "keep me\n");
	assert.deepEqual(listBackupRefs(targetDir), []);
	assert.equal(warnings.some((message) => message.includes("dirty checkout")), false);
});


test("refreshGitCheckout still backs up git-visible local changes", (t) => {
	const { agentDir, targetDir, originDir } = createManagedGitCheckout(t);
	const warnings = [];

	writeFileSync(join(targetDir, "tracked.txt"), "tracked local\n");

	refreshGitCheckout({ agentDir }, {
		targetDir,
		repo: originDir,
		ref: "main",
		label: "test checkout",
		missingMessage: `missing checkout: ${targetDir}`,
	}, gitCheckoutIo(warnings));

	const backupRefs = listBackupRefs(targetDir);
	assert.equal(backupRefs.length, 1);
	assert.equal(runGit(["-C", targetDir, "show", `${backupRefs[0]}:tracked.txt`]), "tracked local");
	assert.equal(readFileSync(join(targetDir, "tracked.txt"), "utf8"), "tracked v1\n");
	assert.equal(warnings.some((message) => message.includes("dirty checkout") && message.includes(backupRefs[0])), true);
});


test("subagent prompt discovery honors source precedence and copies prompt files safely", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const localRepo = join(root, "local-repo");
	const localPrompts = join(localRepo, "agents", "subagents");
	const customPrompts = join(agentDir, "git", "github.com", "custom", "pkg", "agents", "subagents");
	const defaultPrompts = join(agentDir, "git", "github.com", "diegopetrucci", "the-last-harness", "agents", "subagents");
	writePromptSet(localPrompts, "local");
	writePromptSet(customPrompts, "custom");
	writePromptSet(defaultPrompts, "default");

	const customConfig = {
		agentDir,
		repo: "diegopetrucci/the-last-harness",
		packageSource: "git:github.com/custom/pkg@main",
		packageSourceIsDefault: false,
		tmpDir: "",
	};
	assert.equal(findTlhSubagentsDir(customConfig, { localRepoDir: localRepo }), customPrompts);

	unlinkSync(join(customPrompts, TLH_SUBAGENT_PROMPTS[0]));
	assert.deepEqual(missingTlhSubagentPrompts(customPrompts), [TLH_SUBAGENT_PROMPTS[0]]);
	assert.equal(findTlhSubagentsDir(customConfig, { localRepoDir: localRepo }), localPrompts);

	const defaultConfig = {
		agentDir,
		repo: "diegopetrucci/the-last-harness",
		packageSource: "git:github.com/diegopetrucci/the-last-harness@main",
		packageSourceIsDefault: true,
		tmpDir: "",
	};
	assert.equal(findTlhSubagentsDir(defaultConfig, { localRepoDir: localRepo }), localPrompts);

	const installedDir = copyTlhSubagentPrompts(defaultConfig, localPrompts);
	assert.equal(installedDir, join(realpathSync.native(agentDir), "tlh", "agents", "subagents"));
	for (const prompt of TLH_SUBAGENT_PROMPTS) {
		assert.equal(readFileSync(join(installedDir, prompt), "utf8"), `local:${prompt}\n`);
	}
});

test("support manifest includes stage-1 and installed helper library dependencies", () => {
	const manifest = supportFileManifest();
	const relativePaths = manifest.map((file) => file.relativePath);
	assert.ok(relativePaths.includes("scripts/lib/tlh-install-git.mjs"));
	assert.ok(relativePaths.includes("scripts/lib/tlh-install-support-files.mjs"));
	assert.ok(relativePaths.includes("scripts/lib/tlh-install-utils.mjs"));
	assert.deepEqual(manifest.find((file) => file.variable === "TLH_INSTALL_PATHS_LIB"), {
		variable: "TLH_INSTALL_PATHS_LIB",
		requirement: "required",
		relativePath: "scripts/lib/tlh-install-paths.mjs",
		tempPath: "lib/tlh-install-paths.mjs",
		installName: "lib/tlh-install-paths.mjs",
	});
	assert.deepEqual(manifest.find((file) => file.variable === "TLH_INSTALL_UTILS_LIB"), {
		variable: "TLH_INSTALL_UTILS_LIB",
		requirement: "required",
		relativePath: "scripts/lib/tlh-install-utils.mjs",
		tempPath: "lib/tlh-install-utils.mjs",
		installName: "lib/tlh-install-utils.mjs",
	});
	assert.equal(manifest.find((file) => file.variable === "TLH_GNOSIS_SCRIPT")?.requirement, "required");
	assert.deepEqual(manifest.find((file) => file.variable === "DEFAULT_EXTENSIONS_LIB"), {
		variable: "DEFAULT_EXTENSIONS_LIB",
		requirement: "required",
		relativePath: "scripts/lib/default-extensions.mjs",
		tempPath: "lib/default-extensions.mjs",
		installName: "lib/default-extensions.mjs",
	});

	const bootstrap = readFileSync(resolve(import.meta.dirname, "..", "install.sh"), "utf8");
	assert.match(bootstrap, /^required\|scripts\/lib\/default-extensions\.mjs$/m);
	assert.match(bootstrap, /^required\|scripts\/lib\/tlh-install-utils\.mjs$/m);
});

test("settings defaults declare when bundled subagent prompts are required", (t) => {
	const root = tempFixture(t);
	const defaults = join(root, "settings.defaults.json");
	writeFileSync(defaults, JSON.stringify({ subagents: { agentDirs: ["tlh/agents/subagents"] } }));
	assert.equal(settingsRequireTlhSubagentPrompts(defaults), true);

	writeFileSync(defaults, JSON.stringify({ subagents: { agentDirs: ["other"] } }));
	assert.equal(settingsRequireTlhSubagentPrompts(defaults), false);

	writeFileSync(defaults, "not json");
	assert.equal(settingsRequireTlhSubagentPrompts(defaults), false);
});
