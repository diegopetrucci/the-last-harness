import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
	criticalGitSourceSpec,
	gitSourceInstallSource,
	packageSourceInstallDir,
	parseGitSource,
} from "../scripts/lib/tlh-install-package-source.mjs";
import { assertGitSourceTargetSafe } from "../scripts/lib/tlh-install-git.mjs";
import {
	assertProfilePathWithinAgent,
	copySafeProfileFile,
	ensureSafeProfileDir,
	pathIsProtectedPiConfig,
	replaceSafeProfileFile,
	safeProfileFileTarget,
	validateInstallerTargets,
	writeSafeProfileFile,
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

test("safe profile file helpers support top-level, support-file, dry-run, and legacy settings targets", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const homeDir = join(root, "home");
	mkdirSync(homeDir, { recursive: true });

	assert.equal(
		safeProfileFileTarget({ agentDir }, "settings.json", "settings file", { homeDir }),
		join(realpathSync.native(agentDir), "settings.json"),
	);
	assert.equal(
		safeProfileFileTarget({ agentDir }, "tlh/default-extensions.json", "support file", { homeDir }),
		join(realpathSync.native(agentDir), "tlh", "default-extensions.json"),
	);

	writeSafeProfileFile({ agentDir }, "keybindings.json", "{\"x\":1}\n", "keybindings file", { homeDir });
	assert.equal(readFileSync(join(agentDir, "keybindings.json"), "utf8"), "{\"x\":1}\n");

	const absoluteSettingsPath = join(agentDir, "settings.json");
	writeSafeProfileFile(
		{ agentDir },
		absoluteSettingsPath,
		"{}\n",
		"settings file",
		{ homeDir, allowLegacyAbsoluteSettingsPath: true },
	);
	assert.equal(readFileSync(absoluteSettingsPath, "utf8"), "{}\n");
	assert.throws(
		() => writeSafeProfileFile({ agentDir }, absoluteSettingsPath, "{}\n", "settings file", { homeDir }),
		/refusing absolute settings file; use a TLH profile-relative path/,
	);

	const dryRunAgentDir = join(root, "dry-run-agent");
	const dryRunResult = writeSafeProfileFile(
		{ agentDir: dryRunAgentDir },
		"settings.json",
		"{}\n",
		"dry-run settings file",
		{ homeDir, dryRun: true },
	);
	assert.equal(dryRunResult.dryRun, true);
	assert.equal(dryRunResult.target, join(realpathSync.native(root), "dry-run-agent", "settings.json"));
	assert.equal(existsSync(dryRunAgentDir), false);
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
	assert.throws(
		() => writeSafeProfileFile({ agentDir: protectedAgentDir }, "settings.json", "{}\n", "test file", { homeDir }),
		/refusing to write test file parent directory under normal Pi config root/,
	);
	assert.equal(existsSync(protectedAgentDir), false);
	assert.equal(existsSync(join(homeDir, ".pi")), false);
});

test("safe profile writes reject symlinked parent components and final files", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const outsideDir = join(root, "outside");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(outsideDir, { recursive: true });

	symlinkSync(outsideDir, join(agentDir, "tlh"), "dir");
	assert.throws(
		() => writeSafeProfileFile({ agentDir }, "tlh/support.txt", "support\n", "support file"),
		/refusing to write support file parent directory through symlinked TLH profile path/,
	);
	assert.equal(existsSync(join(outsideDir, "support.txt")), false);

	rmSync(join(agentDir, "tlh"), { force: true });
	writeFileSync(join(outsideDir, "settings.json"), "outside\n");
	symlinkSync(join(outsideDir, "settings.json"), join(agentDir, "settings.json"));
	assert.throws(
		() => writeSafeProfileFile({ agentDir }, "settings.json", "inside\n", "settings file"),
		/refusing to replace symlinked settings file/,
	);
	assert.equal(readFileSync(join(outsideDir, "settings.json"), "utf8"), "outside\n");

	const sourceSupportFile = join(root, "source-support.mjs");
	const outsideSupportFile = join(outsideDir, "tlh-defaults.mjs");
	writeFileSync(sourceSupportFile, "source\n");
	writeFileSync(outsideSupportFile, "outside-support\n");
	mkdirSync(join(agentDir, "tlh"));
	symlinkSync(outsideSupportFile, join(agentDir, "tlh", "tlh-defaults.mjs"));
	assert.throws(
		() => copySafeProfileFile(
			{ agentDir },
			sourceSupportFile,
			"tlh/tlh-defaults.mjs",
			"TLH support file tlh-defaults.mjs",
		),
		/refusing to replace symlinked TLH support file tlh-defaults\.mjs/,
	);
	assert.equal(readFileSync(outsideSupportFile, "utf8"), "outside-support\n");
});

test("legacy absolute settings paths reject raw symlink components before target resolution", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const realTarget = join(agentDir, "actual-settings.json");
	const absoluteSettingsPath = join(agentDir, "settings.json");
	writeFileSync(realTarget, "actual\n");
	symlinkSync(realTarget, absoluteSettingsPath);

	assert.throws(
		() => writeSafeProfileFile(
			{ agentDir },
			absoluteSettingsPath,
			"new\n",
			"settings file",
			{ allowLegacyAbsoluteSettingsPath: true },
		),
		/refusing to replace symlinked settings file/,
	);
	assert.equal(lstatSync(absoluteSettingsPath).isSymbolicLink(), true);
	assert.equal(readFileSync(realTarget, "utf8"), "actual\n");

	const realDir = join(agentDir, "real-dir");
	const symlinkedDir = join(agentDir, "settings-link");
	const realDirSettings = join(realDir, "settings.json");
	mkdirSync(realDir);
	writeFileSync(realDirSettings, "nested\n");
	symlinkSync(realDir, symlinkedDir, "dir");
	assert.throws(
		() => writeSafeProfileFile(
			{ agentDir },
			join(symlinkedDir, "settings.json"),
			"new\n",
			"settings file",
			{ allowLegacyAbsoluteSettingsPath: true },
		),
		/refusing to write settings file parent directory through symlinked TLH profile path/,
	);
	assert.equal(readFileSync(realDirSettings, "utf8"), "nested\n");
});

test("safe profile writes avoid predictable temps and reject backup collisions", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const predictableTemp = join(agentDir, `settings.json.tmp-${process.pid}`);
	writeFileSync(predictableTemp, "attacker\n");

	writeSafeProfileFile({ agentDir }, "settings.json", "current\n", "settings file");
	assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), "current\n");
	assert.equal(readFileSync(predictableTemp, "utf8"), "attacker\n");

	const backupPath = join(agentDir, "settings.json.backup-fixed");
	writeFileSync(backupPath, "collision\n");
	assert.throws(
		() => writeSafeProfileFile({ agentDir }, "settings.json", "next\n", "settings file", { backup: true, backupPath }),
		/refusing to overwrite existing settings file backup/,
	);
	assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), "current\n");

	rmSync(backupPath, { force: true });
	const outsideBackupTarget = join(root, "outside-backup");
	writeFileSync(outsideBackupTarget, "outside\n");
	symlinkSync(outsideBackupTarget, backupPath);
	assert.throws(
		() => writeSafeProfileFile({ agentDir }, "settings.json", "next\n", "settings file", { backup: true, backupPath }),
		/refusing to write settings file backup outside the target directory|refusing to overwrite existing settings file backup/,
	);
	assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), "current\n");

	writeSafeProfileFile({ agentDir }, "exclusive-backup.json", "first\n", "exclusive backup", { exclusive: true });
	assert.throws(
		() => writeSafeProfileFile({ agentDir }, "exclusive-backup.json", "second\n", "exclusive backup", { exclusive: true }),
		/refusing to overwrite existing exclusive backup/,
	);
	assert.equal(readFileSync(join(agentDir, "exclusive-backup.json"), "utf8"), "first\n");
});

test("safe profile replacements and backups preserve restrictive target modes", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	const settingsPath = join(agentDir, "settings.json");
	const backupPath = join(agentDir, "settings.json.backup-fixed");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(settingsPath, "old\n");
	chmodSync(settingsPath, 0o600);
	assert.equal(lstatSync(settingsPath).mode & 0o777, 0o600);

	const result = writeSafeProfileFile({ agentDir }, "settings.json", "new\n", "settings file", {
		backup: true,
		backupPath,
	});

	assert.equal(result.backupPath, realpathSync.native(backupPath));
	assert.equal(readFileSync(settingsPath, "utf8"), "new\n");
	assert.equal(readFileSync(backupPath, "utf8"), "old\n");
	assert.equal(lstatSync(settingsPath).mode & 0o777, 0o600);
	assert.equal(lstatSync(backupPath).mode & 0o777, 0o600);
});

test("safe profile writes preserve failed targets and clean only owned temp dirs", (t) => {
	const root = tempFixture(t);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), "old\n");

	assert.throws(
		() => replaceSafeProfileFile(
			{ agentDir },
			"settings.json",
			({ fd }) => {
				writeFileSync(fd, "new\n");
				throw new Error("simulated write failure");
			},
			"settings file",
		),
		/simulated write failure/,
	);
	assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), "old\n");

	const victimDir = join(root, "victim");
	mkdirSync(victimDir);
	writeFileSync(join(victimDir, "keep.txt"), "keep\n");
	let capturedTempDir;
	assert.throws(
		() => replaceSafeProfileFile(
			{ agentDir },
			"settings.json",
			({ tempDir }) => {
				capturedTempDir = tempDir;
				rmSync(tempDir, { recursive: true, force: true });
				symlinkSync(victimDir, tempDir, "dir");
				throw new Error("simulated cleanup race");
			},
			"settings file",
		),
		/simulated cleanup race/,
	);
	assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), "old\n");
	assert.equal(readFileSync(join(victimDir, "keep.txt"), "utf8"), "keep\n");
	assert.equal(lstatSync(capturedTempDir).isSymbolicLink(), true);
});

test("safe profile writes reject temp replacement, removal, and symlink swaps before rename", (t) => {
	const root = tempFixture(t);
	const cases = [
		{
			name: "removed",
			expected: /temp file disappeared before rename/,
			tamper({ tempPath }) {
				rmSync(tempPath, { force: true });
			},
		},
		{
			name: "replaced",
			expected: /temp file changed before rename/,
			tamper({ tempPath }) {
				rmSync(tempPath, { force: true });
				writeFileSync(tempPath, "attacker\n");
			},
		},
		{
			name: "symlinked",
			expected: /temp file changed to symlink before rename/,
			tamper({ tempPath, victimPath }) {
				rmSync(tempPath, { force: true });
				symlinkSync(victimPath, tempPath);
			},
		},
	];

	for (const { name, expected, tamper } of cases) {
		const agentDir = join(root, `agent-${name}`);
		const finalTarget = join(agentDir, "settings.json");
		const victimPath = join(root, `victim-${name}.txt`);
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(finalTarget, "old\n");
		writeFileSync(victimPath, "victim\n");

		assert.throws(
			() => replaceSafeProfileFile(
				{ agentDir },
				"settings.json",
				({ fd, tempPath }) => {
					writeFileSync(fd, "new\n");
					tamper({ tempPath, victimPath });
				},
				"settings file",
			),
			expected,
		);
		assert.equal(lstatSync(finalTarget).isSymbolicLink(), false, `${name} must not replace final target with a symlink`);
		assert.equal(readFileSync(finalTarget, "utf8"), "old\n");
		assert.equal(readFileSync(victimPath, "utf8"), "victim\n");
	}
});

test("safe profile write helper documents residual TOCTOU risk", () => {
	const source = readFileSync(new URL("../scripts/lib/tlh-install-paths.mjs", import.meta.url), "utf8");
	assert.match(source, /residual\s+TOCTOU/i);
	assert.match(source, /openat\(2\)\/renameat\(2\)/);
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

test("support manifest includes stage-1 library dependencies", () => {
	const manifest = supportFileManifest();
	const relativePaths = manifest.map((file) => file.relativePath);
	assert.ok(relativePaths.includes("scripts/lib/tlh-install-git.mjs"));
	assert.ok(relativePaths.includes("scripts/lib/tlh-install-support-files.mjs"));
	assert.ok(manifest.some((file) => file.relativePath === "scripts/lib/tlh-install-paths.mjs" && file.installName === "lib/tlh-install-paths.mjs"));
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
