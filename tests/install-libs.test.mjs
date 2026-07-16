import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
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
import { writeSafeProfileFile } from "../scripts/lib/tlh-safe-profile-write.mjs";
import {
	TLH_SUBAGENT_PROMPTS,
	copyTlhSubagentPrompts,
	findTlhSubagentsDir,
	missingTlhSubagentPrompts,
	restoreNeededTlhSubagentPrompts,
	settingsRequireTlhSubagentPrompts,
} from "../scripts/lib/tlh-install-subagents.mjs";
import {
	installableSupportFiles,
	supportFileManifest,
} from "../scripts/lib/tlh-install-support-manifest.mjs";

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

test("writeSafeProfileFile writes root profile files with safe temp dirs and explicit modes", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const homeDir = join(root, "home");
	const externalDir = join(root, "external");
	const legacyTempPath = join(agentDir, `settings.json.tmp-${process.pid}`);
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(externalDir, { recursive: true });
	symlinkSync(join(externalDir, "legacy-target.json"), legacyTempPath);

	writeSafeProfileFile(
		{ agentDir },
		"settings.json",
		"{\n  \"tlh\": true\n}\n",
		"isolated settings",
		{ homeDir, mode: 0o600 },
	);

	assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), "{\n  \"tlh\": true\n}\n");
	assert.equal(lstatSync(join(agentDir, "settings.json")).mode & 0o777, 0o600);
	assert.equal(lstatSync(legacyTempPath).isSymbolicLink(), true);
	assert.deepEqual(readdirSync(agentDir).filter((entry) => entry.startsWith(".settings.json.tmp.")), []);
});


test("writeSafeProfileFile preserves existing file mode when overwriting", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const homeDir = join(root, "home");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), "before\n", { mode: 0o640 });

	writeSafeProfileFile({ agentDir }, "settings.json", "after\n", "isolated settings", { homeDir });

	assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), "after\n");
	assert.equal(lstatSync(join(agentDir, "settings.json")).mode & 0o777, 0o640);
});


test("writeSafeProfileFile preserves resolved modes under restrictive umask", { concurrency: false }, (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const homeDir = join(root, "home");
	const explicitTarget = join(agentDir, "settings.json");
	const preservedTarget = join(agentDir, "state.json");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const previousUmask = process.umask(0o077);
	t.after(() => {
		process.umask(previousUmask);
	});

	writeSafeProfileFile(
		{ agentDir },
		"settings.json",
		"{\n  \"tlh\": true\n}\n",
		"isolated settings",
		{ homeDir, mode: 0o640 },
	);
	assert.equal(lstatSync(explicitTarget).mode & 0o777, 0o640);

	writeFileSync(preservedTarget, "before\n");
	chmodSync(preservedTarget, 0o640);
	writeSafeProfileFile({ agentDir }, "state.json", "after\n", "isolated state", { homeDir });
	assert.equal(readFileSync(preservedTarget, "utf8"), "after\n");
	assert.equal(lstatSync(preservedTarget).mode & 0o777, 0o640);
});


test("writeSafeProfileFile rejects protected normal Pi targets before creating them", (t) => {
	const root = tempFixture(t);
	const homeDir = join(root, "home");
	const protectedAgentDir = join(homeDir, ".pi", "agent");
	mkdirSync(homeDir, { recursive: true });

	assert.throws(
		() => writeSafeProfileFile({ agentDir: protectedAgentDir }, "settings.json", "{}\n", "isolated settings", { homeDir }),
		/refusing to write isolated settings parent directory under normal Pi config root/,
	);
	assert.equal(existsSync(protectedAgentDir), false);
	assert.equal(existsSync(join(homeDir, ".pi")), false);
});


test("writeSafeProfileFile rejects symlinked profile roots, parents, and final targets", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const linkedAgentDir = join(root, "linked-agent");
	const homeDir = join(root, "home");
	const externalDir = join(root, "external");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(externalDir, { recursive: true });
	symlinkSync(externalDir, linkedAgentDir, "dir");
	symlinkSync(externalDir, join(agentDir, "nested"), "dir");

	assert.throws(
		() => writeSafeProfileFile({ agentDir: linkedAgentDir }, "settings.json", "{}\n", "isolated settings", { homeDir }),
		/refusing to write isolated settings parent directory through symlinked TLH profile path/,
	);
	assert.throws(
		() => writeSafeProfileFile({ agentDir: linkedAgentDir }, "tlh/install-state.json", "{}\n", "install state", { homeDir }),
		/refusing to write install state parent directory through symlinked TLH profile path/,
	);
	assert.throws(
		() => writeSafeProfileFile({ agentDir }, "nested/settings.json", "{}\n", "isolated settings", { homeDir }),
		/refusing to write isolated settings parent directory through symlinked TLH profile path/,
	);
	assert.equal(existsSync(join(externalDir, "settings.json")), false);
	assert.equal(existsSync(join(externalDir, "tlh", "install-state.json")), false);

	symlinkSync(join(externalDir, "settings.json"), join(agentDir, "settings.json"));
	assert.throws(
		() => writeSafeProfileFile({ agentDir }, "settings.json", "{}\n", "isolated settings", { homeDir }),
		/refusing to replace symlinked isolated settings/,
	);
	assert.equal(existsSync(join(externalDir, "settings.json")), false);
});


test("writeSafeProfileFile rejects temp target symlink swaps before commit", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const homeDir = join(root, "home");
	const externalDir = join(root, "external");
	const target = join(agentDir, "settings.json");
	const attackerTarget = join(externalDir, "attacker-settings.json");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(externalDir, { recursive: true });
	writeFileSync(target, "original\n", { mode: 0o600 });
	writeFileSync(attackerTarget, "attacker\n");

	assert.throws(
		() => writeSafeProfileFile(
			{ agentDir },
			"settings.json",
			"safe\n",
			"isolated settings",
			{
				homeDir,
				beforeCommit({ tempTarget }) {
					unlinkSync(tempTarget);
					symlinkSync(attackerTarget, tempTarget);
				},
			},
		),
		/refusing to commit unexpected temp file type/,
	);
	assert.equal(readFileSync(target, "utf8"), "original\n");
	assert.equal(lstatSync(target).isSymbolicLink(), false);
	assert.equal(readFileSync(attackerTarget, "utf8"), "attacker\n");
});


test("writeSafeProfileFile rejects temp dir swaps to attacker-controlled content", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const homeDir = join(root, "home");
	const externalDir = join(root, "external");
	const target = join(agentDir, "settings.json");
	const externalTempTarget = join(externalDir, "settings.json");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(externalDir, { recursive: true });
	writeFileSync(target, "original\n", { mode: 0o600 });

	assert.throws(
		() => writeSafeProfileFile(
			{ agentDir },
			"settings.json",
			"safe\n",
			"isolated settings",
			{
				homeDir,
				beforeCommit({ tempDir }) {
					rmSync(tempDir, { recursive: true, force: true });
					symlinkSync(externalDir, tempDir, "dir");
					writeFileSync(externalTempTarget, "attacker\n");
				},
			},
		),
		/refusing to commit unexpected temp directory type/,
	);
	assert.equal(readFileSync(target, "utf8"), "original\n");
	assert.equal(lstatSync(target).isSymbolicLink(), false);
	assert.equal(readFileSync(externalTempTarget, "utf8"), "attacker\n");
});


test("writeSafeProfileFile preserves temp dirs with unexpected extra content during cleanup", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const homeDir = join(root, "home");
	let tempDirWithSentinel = "";
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	assert.throws(
		() => writeSafeProfileFile(
			{ agentDir },
			"settings.json",
			"{}\n",
			"isolated settings",
			{
				homeDir,
				beforeCommit({ tempDir }) {
					tempDirWithSentinel = tempDir;
					writeFileSync(join(tempDir, "sentinel.txt"), "keep\n");
					throw new Error("stop before commit");
				},
			},
		),
		/stop before commit/,
	);
	assert.equal(existsSync(join(agentDir, "settings.json")), false);
	assert.equal(existsSync(join(tempDirWithSentinel, "settings.json")), false);
	assert.equal(readFileSync(join(tempDirWithSentinel, "sentinel.txt"), "utf8"), "keep\n");
});


test("writeSafeProfileFile skips cleanup when the helper temp dir path is recreated", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const homeDir = join(root, "home");
	let recreatedTempDir = "";
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	assert.throws(
		() => writeSafeProfileFile(
			{ agentDir },
			"settings.json",
			"{}\n",
			"isolated settings",
			{
				homeDir,
				beforeCommit({ tempDir }) {
					recreatedTempDir = tempDir;
					rmSync(tempDir, { recursive: true, force: true });
					mkdirSync(tempDir, { recursive: true });
					writeFileSync(join(tempDir, "sentinel.txt"), "keep\n");
				},
			},
		),
		/refusing to commit (replaced temp directory|missing temp file)/,
	);
	assert.equal(existsSync(join(agentDir, "settings.json")), false);
	assert.equal(readFileSync(join(recreatedTempDir, "sentinel.txt"), "utf8"), "keep\n");
});


test("writeSafeProfileFile detects swapped parents and avoids unsafe cleanup", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const homeDir = join(root, "home");
	const externalDir = join(root, "external");
	let externalTempDir = "";
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(externalDir, { recursive: true });

	assert.throws(
		() => writeSafeProfileFile(
			{ agentDir },
			"tlh/install-state.json",
			"{}\n",
			"TLH install state",
			{
				homeDir,
				beforeCommit({ parent, tempDir }) {
					externalTempDir = join(externalDir, basename(tempDir));
					rmSync(parent, { recursive: true, force: true });
					symlinkSync(externalDir, parent, "dir");
					mkdirSync(externalTempDir, { recursive: true });
					writeFileSync(join(externalTempDir, "sentinel.txt"), "keep\n");
				},
			},
		),
		/symlinked TLH profile path/,
	);
	assert.equal(existsSync(join(externalDir, "install-state.json")), false);
	assert.equal(readFileSync(join(externalTempDir, "sentinel.txt"), "utf8"), "keep\n");
});


test("writeSafeProfileFile preserves temp dirs when the profile root is moved aside and symlinked back", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const movedAgentDir = join(root, "moved-agent");
	const homeDir = join(root, "home");
	let movedTempDir = "";
	let movedTempTarget = "";
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	assert.throws(
		() => writeSafeProfileFile(
			{ agentDir },
			"settings.json",
			"safe\n",
			"isolated settings",
			{
				homeDir,
				beforeCommit({ tempDir }) {
					movedTempDir = join(movedAgentDir, basename(tempDir));
					movedTempTarget = join(movedTempDir, "settings.json");
					renameSync(agentDir, movedAgentDir);
					symlinkSync(movedAgentDir, agentDir, "dir");
				},
			},
		),
		/symlinked TLH profile path/,
	);
	assert.equal(lstatSync(agentDir).isSymbolicLink(), true);
	assert.equal(readFileSync(movedTempTarget, "utf8"), "safe\n");
	assert.equal(lstatSync(movedTempDir).isDirectory(), true);
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


test("refreshGitCheckout keeps dirty-checkout backup output concise by default", (t) => {
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
	assert.equal(warnings.some((message) => message.includes("diff --git")), false);
	assert.equal(warnings.some((message) => message.includes("@@")), false);
});


test("refreshGitCheckout emits dirty-checkout diff details only in verbose mode", (t) => {
	const { agentDir, targetDir, originDir } = createManagedGitCheckout(t);
	const warnings = [];

	writeFileSync(join(targetDir, "tracked.txt"), "tracked local\n");

	refreshGitCheckout({ agentDir, verbose: true }, {
		targetDir,
		repo: originDir,
		ref: "main",
		label: "test checkout",
		missingMessage: `missing checkout: ${targetDir}`,
	}, gitCheckoutIo(warnings));

	const backupRefs = listBackupRefs(targetDir);
	assert.equal(backupRefs.length, 1);
	assert.equal(warnings.some((message) => message.includes("dirty checkout") && message.includes(backupRefs[0])), true);
	assert.equal(warnings.some((message) => message.includes("diff --git a/tracked.txt b/tracked.txt")), true);
	assert.equal(warnings.some((message) => message.includes("-tracked v1") && message.includes("+tracked local")), true);
});


test("refreshGitCheckout stays quiet about dirty-checkout backups in quiet mode", (t) => {
	const { agentDir, targetDir, originDir } = createManagedGitCheckout(t);
	const warnings = [];

	writeFileSync(join(targetDir, "tracked.txt"), "tracked local\n");

	refreshGitCheckout({ agentDir, quiet: true }, {
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
	assert.deepEqual(warnings, []);
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
	writeFileSync(join(installedDir, "contrarian.md"), "stale:contrarian.md\n");
	assert.deepEqual(restoreNeededTlhSubagentPrompts(localPrompts, installedDir), ["contrarian.md"]);
	copyTlhSubagentPrompts(defaultConfig, localPrompts);
	assert.deepEqual(TLH_SUBAGENT_PROMPTS, [
		"developer.md",
		"code-reviewer.md",
		"repo-scout.md",
		"diff-summarizer.md",
		"librarian.md",
		"oracle.md",
		"contrarian.md",
		"web-scout.md",
	]);
	assert.equal(readFileSync(join(installedDir, "contrarian.md"), "utf8"), "local:contrarian.md\n");
	assert.equal(readFileSync(join(installedDir, "web-scout.md"), "utf8"), "local:web-scout.md\n");
	for (const prompt of TLH_SUBAGENT_PROMPTS) {
		assert.equal(readFileSync(join(installedDir, prompt), "utf8"), `local:${prompt}\n`);
	}
});

test("support manifests preserve current-ref packaging while keeping stage-0 bootstrap compatibility", () => {
	const manifest = supportFileManifest();
	const relativePaths = manifest.map((file) => file.relativePath);
	assert.ok(relativePaths.includes("scripts/lib/tlh-install-git.mjs"));
	assert.ok(relativePaths.includes("scripts/lib/tlh-install-support-files.mjs"));
	assert.ok(relativePaths.includes("scripts/lib/tlh-safe-profile-write.mjs"));
	assert.ok(relativePaths.includes("scripts/lib/tlh-install-utils.mjs"));
	assert.deepEqual(manifest.find((file) => file.variable === "TLH_INSTALL_PATHS_LIB"), {
		variable: "TLH_INSTALL_PATHS_LIB",
		requirement: "required",
		relativePath: "scripts/lib/tlh-install-paths.mjs",
		tempPath: "lib/tlh-install-paths.mjs",
		installName: "",
	});
	assert.deepEqual(manifest.find((file) => file.variable === "TLH_SAFE_PROFILE_WRITE_LIB"), {
		variable: "TLH_SAFE_PROFILE_WRITE_LIB",
		requirement: "required",
		relativePath: "scripts/lib/tlh-safe-profile-write.mjs",
		tempPath: "lib/tlh-safe-profile-write.mjs",
		installName: "",
	});
	assert.deepEqual(manifest.find((file) => file.variable === "TLH_INSTALL_UTILS_LIB"), {
		variable: "TLH_INSTALL_UTILS_LIB",
		requirement: "required",
		relativePath: "scripts/lib/tlh-install-utils.mjs",
		tempPath: "lib/tlh-install-utils.mjs",
		installName: "",
	});
	assert.equal(manifest.find((file) => file.variable === "TLH_GNOSIS_SCRIPT")?.requirement, "required");
	assert.equal(manifest.find((file) => file.variable === "TLH_GNOSIS_SCRIPT")?.installName, "");
	assert.deepEqual(manifest.find((file) => file.variable === "TLH_RTK_SCRIPT"), {
		variable: "TLH_RTK_SCRIPT",
		requirement: "required",
		relativePath: "scripts/tlh-rtk.mjs",
		tempPath: "tlh-rtk.mjs",
		installName: "tlh-rtk.mjs",
	});
	assert.deepEqual(manifest.find((file) => file.variable === "TLH_RECOVER_UPDATE_SCRIPT"), {
		variable: "TLH_RECOVER_UPDATE_SCRIPT",
		requirement: "required",
		relativePath: "scripts/tlh-recover-update.mjs",
		tempPath: "tlh-recover-update.mjs",
		installName: "recover-update.mjs",
	});
	assert.deepEqual(manifest.find((file) => file.variable === "DEFAULT_EXTENSIONS_LIB"), {
		variable: "DEFAULT_EXTENSIONS_LIB",
		requirement: "required",
		relativePath: "scripts/lib/default-extensions.mjs",
		tempPath: "lib/default-extensions.mjs",
		installName: "",
	});
	assert.equal(manifest.find((file) => file.variable === "TLH_WRAPPER_SCRIPT")?.installName, "");
	assert.equal(manifest.find((file) => file.variable === "TLH_INSTALL_STATE_SCRIPT")?.installName, "");

	const installableVariables = new Set(installableSupportFiles().map((file) => file.variable));
	for (const variable of [
		"TLH_RTK_SCRIPT",
		"TLH_RECOVER_UPDATE_SCRIPT",
	]) {
		assert.equal(installableVariables.has(variable), true, variable);
	}
	for (const variable of [
		"TLH_DEFAULTS_SCRIPT",
		"TLH_TICKETS_SCRIPT",
		"TLH_UPDATE_SCRIPT",
		"TLH_INSTALL_PACKAGE_SOURCE_LIB",
		"TLH_INSTALL_PATHS_LIB",
		"TLH_SAFE_PROFILE_WRITE_LIB",
		"TLH_INSTALL_UTILS_LIB",
		"DEFAULT_EXTENSIONS_LIB",
		"TLH_GNOSIS_SCRIPT",
		"TLH_WRAPPER_SCRIPT",
		"TLH_INSTALL_STATE_SCRIPT",
	]) {
		assert.equal(installableVariables.has(variable), false, variable);
	}

	const bootstrap = readFileSync(resolve(import.meta.dirname, "..", "install.sh"), "utf8");
	assert.match(bootstrap, /^required\|scripts\/lib\/default-extensions\.mjs$/m);
	assert.match(bootstrap, /^required\|scripts\/lib\/tlh-safe-profile-write\.mjs$/m);
	assert.doesNotMatch(bootstrap, /^optional\|scripts\/lib\/tlh-safe-profile-write\.mjs$/m);
	assert.match(bootstrap, /^required\|scripts\/lib\/tlh-install-utils\.mjs$/m);
	assert.match(bootstrap, /^required\|scripts\/tlh-gnosis\.mjs$/m);
	assert.match(bootstrap, /^required\|scripts\/tlh-rtk\.mjs$/m);
	assert.match(bootstrap, /^required\|scripts\/tlh-recover-update\.mjs$/m);
	assert.match(bootstrap, /^optional\|scripts\/tlh-wrapper\.mjs$/m);
	assert.match(bootstrap, /^optional\|scripts\/tlh-install-state\.mjs$/m);
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
