import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { buildInstallConfig, parseArgs, reclaimRetiredExtensionResidues } from "../scripts/tlh-install.mjs";
import { captureConsole, readPiLogRecords } from "./install-stage1-test-helpers.mjs";
import { makeTempDir } from "./install-stage1-test-helpers.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scrubEnv(overrides = {}, base = process.env) {
	const env = {};
	for (const [k, v] of Object.entries(base)) {
		if (k === "PI_CODING_AGENT_DIR" || k.startsWith("TLH_")) continue;
		env[k] = v;
	}
	return { ...env, ...overrides };
}

/**
 * Build a minimal InstallConfig pointing at a temporary agent dir, with a
 * fake `pi` binary that logs `<agentDir>|<cwd>|<args...>` to PI_LOG.
 */
function makeConfig(t, { settings, fakePiBody = "exit 0", dryRun = false } = {}) {
	const root = makeTempDir("tlh-reclaim-retired-test-");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const homeDir = join(root, "home");
	const fakebin = join(root, "fakebin");
	const piLog = join(root, "pi.log");
	const settingsPath = join(agentDir, "settings.json");

	mkdirSync(agentDir, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(fakebin, { recursive: true });

	if (settings !== undefined) {
		writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
	}

	// Write fake pi binary
	const piPath = join(fakebin, "pi");
	writeFileSync(piPath, `#!/usr/bin/env bash\nset -euo pipefail\n${fakePiBody}\n`, "utf8");
	chmodSync(piPath, 0o755);

	t.after(() => rmSync(root, { recursive: true, force: true }));

	const baseArgs = ["--agent-dir", agentDir, "--bin-dir", binDir];
	if (dryRun) baseArgs.unshift("--dry-run");
	const env = scrubEnv({
		HOME: homeDir,
		PATH: `${fakebin}:${process.env.PATH || ""}`,
		PI_LOG: piLog,
	});
	const config = buildInstallConfig(parseArgs(baseArgs, env), env);
	config.quiet = true;
	config.piCmd = piPath;

	return { config, agentDir, fakebin, piLog, settingsPath, piPath };
}

/**
 * Create an npm package directory simulating an installed npm source.
 * npm sources live under <agentDir>/npm/node_modules/<packageName>.
 */
function createNpmPackageDir(agentDir, packageName) {
	const dir = join(agentDir, "npm", "node_modules", packageName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: packageName, version: "1.0.0" }), "utf8");
	return dir;
}

/**
 * Create a git checkout directory simulating an installed git source.
 * git sources live under <agentDir>/git/<host>/<path>.
 */
function createGitCheckoutDir(agentDir, host, repoPath) {
	const dir = join(agentDir, "git", host, repoPath);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: repoPath }), "utf8");
	return dir;
}

// ---------------------------------------------------------------------------
// Case 1: Managed orphan — retired source absent from post-merge settings AND
//         present on disk → pi remove is invoked.
//
// The fake pi faithfully simulates Pi 0.83.0: it deletes the on-disk residue
// and exits 1 (because no settings entry remains after the post-merge step).
// Success is determined by verifying the residue is gone, not by exit code.
// ---------------------------------------------------------------------------

test("reclaimRetiredExtensionResidues case 1: invokes pi remove for retired npm source absent from settings and present on disk", (t) => {
	const { config, agentDir, piLog } = makeConfig(t, {
		settings: { packages: ["npm:some-other-extension"] },
		// Faithful simulation: remove on-disk residue (Pi does this first), then
		// exit 1 because no settings entry remains (Pi's expected post-merge exit).
		fakePiBody: [
			`printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
			`if [[ "$1" == "remove" && "$2" == npm:* ]]; then`,
			`  PKG="\${2#npm:}"`,
			`  rm -rf "$PI_CODING_AGENT_DIR/npm/node_modules/$PKG"`,
			`  exit 1`,
			`fi`,
		].join("\n"),
	});
	// Simulate @ff-labs/pi-fff on disk
	createNpmPackageDir(agentDir, "@ff-labs/pi-fff");

	const stderr = captureConsole("error", () => reclaimRetiredExtensionResidues(config));

	const records = readPiLogRecords(piLog);
	assert.ok(
		records.some((r) => r.agentDir === agentDir && r.command === "remove npm:@ff-labs/pi-fff"),
		`expected 'remove npm:@ff-labs/pi-fff' in pi log; got: ${JSON.stringify(records)}`,
	);
	// Successful reclaim must produce NO failure warning (success is disk-absence, not exit code)
	assert.equal(stderr, "", `no failure warning expected for successful reclaim; got: ${stderr}`);
	// Residue is gone from disk
	assert.equal(
		existsSync(join(agentDir, "npm", "node_modules", "@ff-labs", "pi-fff")),
		false,
		"npm package directory should be gone after successful reclaim",
	);
});

test("reclaimRetiredExtensionResidues case 1: invokes pi remove for retired git source absent from settings and present on disk", (t) => {
	const { config, agentDir, piLog } = makeConfig(t, {
		settings: { packages: [] },
		// Faithful simulation: remove on-disk residue, exit 1 (no settings entry).
		fakePiBody: [
			`printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
			`if [[ "$1" == "remove" && "$2" == git:* ]]; then`,
			`  REST="\${2#git:}"`,
			`  rm -rf "$PI_CODING_AGENT_DIR/git/$REST"`,
			`  exit 1`,
			`fi`,
		].join("\n"),
	});
	// Simulate git:github.com/diegopetrucci/pi-rtk on disk
	createGitCheckoutDir(agentDir, "github.com", "diegopetrucci/pi-rtk");

	const stderr = captureConsole("error", () => reclaimRetiredExtensionResidues(config));

	const records = readPiLogRecords(piLog);
	assert.ok(
		records.some((r) => r.agentDir === agentDir && r.command === "remove git:github.com/diegopetrucci/pi-rtk"),
		`expected 'remove git:github.com/diegopetrucci/pi-rtk' in pi log; got: ${JSON.stringify(records)}`,
	);
	// Successful reclaim must produce NO failure warning
	assert.equal(stderr, "", `no failure warning expected for successful reclaim; got: ${stderr}`);
	// Residue is gone from disk
	assert.equal(
		existsSync(join(agentDir, "git", "github.com", "diegopetrucci", "pi-rtk")),
		false,
		"git checkout directory should be gone after successful reclaim",
	);
});

// ---------------------------------------------------------------------------
// Case 2: User-installed — retired identity still in settings.packages →
//         no removal invoked.
// ---------------------------------------------------------------------------

test("reclaimRetiredExtensionResidues case 2: skips pi remove when retired identity is still in post-merge settings", (t) => {
	const { config, agentDir, piLog } = makeConfig(t, {
		// User has kept npm:@ff-labs/pi-fff in their settings
		settings: { packages: ["npm:@ff-labs/pi-fff"] },
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
	});
	createNpmPackageDir(agentDir, "@ff-labs/pi-fff");

	reclaimRetiredExtensionResidues(config);

	// pi log should have no remove command for this package
	const records = readPiLogRecords(piLog);
	assert.ok(
		!records.some((r) => r.command.includes("remove") && r.command.includes("@ff-labs/pi-fff")),
		`pi remove must not be called when user has the package in settings; got: ${JSON.stringify(records)}`,
	);
});

// ---------------------------------------------------------------------------
// Case 3: Not-on-disk — package is absent from disk → no pi invocation.
// ---------------------------------------------------------------------------

test("reclaimRetiredExtensionResidues case 3: skips pi remove when retired source is not on disk", (t) => {
	const { config, piLog } = makeConfig(t, {
		settings: { packages: [] },
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
	});
	// Do NOT create any on-disk residue

	reclaimRetiredExtensionResidues(config);

	assert.equal(existsSync(piLog), false, "pi should not be invoked when no retired packages are on disk");
});

// ---------------------------------------------------------------------------
// Case 4: Unreadable settings → all removals skipped with a warning.
// ---------------------------------------------------------------------------

test("reclaimRetiredExtensionResidues case 4: skips all removals and warns when settings file is unreadable", (t) => {
	const { config, agentDir, piLog, settingsPath } = makeConfig(t, {
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
	});
	// Write invalid JSON to settings
	writeFileSync(settingsPath, "{ not valid json }", "utf8");
	createNpmPackageDir(agentDir, "@ff-labs/pi-fff");

	const stderr = captureConsole("error", () => reclaimRetiredExtensionResidues(config));

	assert.equal(existsSync(piLog), false, "pi must not be invoked when settings are unreadable");
	assert.match(stderr, /warning:.*settings file is unreadable/);
});

// ---------------------------------------------------------------------------
// Case 5: Dry-run — logs intended commands, executes nothing.
// ---------------------------------------------------------------------------

test("reclaimRetiredExtensionResidues case 5: dry-run logs pi remove command without executing it", (t) => {
	const { config, agentDir, piLog } = makeConfig(t, {
		settings: { packages: [] },
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
		dryRun: true,
	});
	createNpmPackageDir(agentDir, "@ff-labs/pi-fff");

	const stdout = captureConsole("log", () => reclaimRetiredExtensionResidues(config));

	// pi must not actually be invoked in dry-run
	assert.equal(existsSync(piLog), false, "pi must not be executed in dry-run mode");
	// dry-run output should mention the remove command and the package
	assert.match(stdout, /remove.*@ff-labs\/pi-fff/, "dry-run must log the intended remove command");
});

// ---------------------------------------------------------------------------
// Case 6: pi remove failure — warns but install continues (no throw).
// ---------------------------------------------------------------------------

test("reclaimRetiredExtensionResidues case 6: warns and continues when pi remove fails", (t) => {
	const { config, agentDir } = makeConfig(t, {
		settings: { packages: [] },
		fakePiBody: [`if [[ "$1" == "remove" ]]; then`, `  printf 'remove failed\\n' >&2`, `  exit 1`, `fi`].join("\n"),
	});
	createNpmPackageDir(agentDir, "@ff-labs/pi-fff");

	const stderr = captureConsole("error", () => {
		assert.doesNotThrow(() => reclaimRetiredExtensionResidues(config));
	});

	assert.match(stderr, /warning:.*failed to remove retired extension residue npm:@ff-labs\/pi-fff/);
});

// ---------------------------------------------------------------------------
// Finding 2: Guarded path walk — symlinked parents/targets/agentDir must block
//            the probe and prevent pi from being invoked.
// ---------------------------------------------------------------------------

test("reclaimRetiredExtensionResidues finding 2: symlinked npm parent (npm dir) blocks probe and prevents pi invocation", (t) => {
	if (process.platform === "win32") return;
	const { config, agentDir, piLog } = makeConfig(t, {
		settings: { packages: [] },
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
	});
	// Create external npm dir and symlink it into agentDir
	const externalNpm = join(agentDir, "..", "external-npm");
	mkdirSync(join(externalNpm, "node_modules", "@ff-labs", "pi-fff"), { recursive: true });
	symlinkSync(externalNpm, join(agentDir, "npm"), "dir");

	captureConsole("error", () => reclaimRetiredExtensionResidues(config));

	assert.equal(existsSync(piLog), false, "pi must not be invoked when npm parent is a symlink");
	assert.ok(
		existsSync(join(externalNpm, "node_modules", "@ff-labs", "pi-fff")),
		"external directory must not be removed",
	);
});

test("reclaimRetiredExtensionResidues finding 2: symlinked git parent (git dir) blocks probe and prevents pi invocation", (t) => {
	if (process.platform === "win32") return;
	const { config, agentDir, piLog } = makeConfig(t, {
		settings: { packages: [] },
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
	});
	// Create external git dir and symlink it into agentDir
	const externalGit = join(agentDir, "..", "external-git");
	mkdirSync(join(externalGit, "github.com", "diegopetrucci", "pi-rtk"), { recursive: true });
	symlinkSync(externalGit, join(agentDir, "git"), "dir");

	captureConsole("error", () => reclaimRetiredExtensionResidues(config));

	assert.equal(existsSync(piLog), false, "pi must not be invoked when git parent is a symlink");
	assert.ok(
		existsSync(join(externalGit, "github.com", "diegopetrucci", "pi-rtk")),
		"external directory must not be removed",
	);
});

test("reclaimRetiredExtensionResidues finding 2: symlinked target package dir blocks probe and prevents pi invocation", (t) => {
	if (process.platform === "win32") return;
	const { config, agentDir, piLog } = makeConfig(t, {
		settings: { packages: [] },
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
	});
	// Create a real scope dir but symlink the target package dir to an external location
	const scopeDir = join(agentDir, "npm", "node_modules", "@ff-labs");
	mkdirSync(scopeDir, { recursive: true });
	const externalPkg = join(agentDir, "..", "external-pkg");
	mkdirSync(externalPkg, { recursive: true });
	symlinkSync(externalPkg, join(scopeDir, "pi-fff"), "dir");

	captureConsole("error", () => reclaimRetiredExtensionResidues(config));

	assert.equal(existsSync(piLog), false, "pi must not be invoked when target is a symlink");
	assert.ok(existsSync(externalPkg), "external directory must not be removed");
});

test("reclaimRetiredExtensionResidues finding 2: symlinked agentDir blocks all probes and prevents pi invocation", (t) => {
	if (process.platform === "win32") return;
	const { config, agentDir, piLog } = makeConfig(t, {
		settings: { packages: [] },
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
	});
	// Create a real npm package dir under a real external dir,
	// then replace agentDir with a symlink pointing to it
	const externalAgent = join(agentDir, "..", "external-agent");
	mkdirSync(join(externalAgent, "npm", "node_modules", "@ff-labs", "pi-fff"), { recursive: true });
	rmSync(agentDir, { recursive: true });
	symlinkSync(externalAgent, agentDir, "dir");

	captureConsole("error", () => reclaimRetiredExtensionResidues(config));

	assert.equal(existsSync(piLog), false, "pi must not be invoked when agentDir is a symlink");
});

test("reclaimRetiredExtensionResidues finding 2: non-directory agentDir blocks all probes and prevents pi invocation", (t) => {
	if (process.platform === "win32") return;
	const { config, agentDir, piLog } = makeConfig(t, {
		settings: { packages: [] },
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
	});
	// Replace the agentDir directory with a regular file
	rmSync(agentDir, { recursive: true });
	writeFileSync(agentDir, "not-a-directory");

	assert.doesNotThrow(() => captureConsole("error", () => reclaimRetiredExtensionResidues(config)));
	assert.equal(existsSync(piLog), false, "pi must not be invoked when agentDir is a regular file");
});

// ---------------------------------------------------------------------------
// Finding 3: Dry-run gating uses the force-removed list, not pre-merge
// settings — a force-removed source present in settings AND on disk must
// have its pi remove command printed in dry-run.
// ---------------------------------------------------------------------------

test("reclaimRetiredExtensionResidues finding 3: dry-run prints pi remove for force-removed source even when present in pre-merge settings", (t) => {
	const settingsBefore = JSON.stringify({ packages: ["git:github.com/diegopetrucci/pi-rtk"] });
	const { config, agentDir, piLog, settingsPath } = makeConfig(t, {
		// Settings contain a force-removed source (as-if merge hasn't run yet in dry-run)
		settings: { packages: ["git:github.com/diegopetrucci/pi-rtk"] },
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
		dryRun: true,
	});
	const gitDir = createGitCheckoutDir(agentDir, "github.com", "diegopetrucci/pi-rtk");

	const stdout = captureConsole("log", () => reclaimRetiredExtensionResidues(config));

	// dry-run: pi must not be executed
	assert.equal(existsSync(piLog), false, "pi must not be executed in dry-run mode");
	// dry-run: pi remove command must be printed
	assert.match(stdout, /remove.*github\.com\/diegopetrucci\/pi-rtk/, "dry-run must print the pi remove command");
	// dry-run: nothing on disk changes
	assert.ok(existsSync(gitDir), "git directory must not be removed in dry-run");
	// dry-run: settings file unchanged
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore, "settings file must be unchanged in dry-run");
});

// ---------------------------------------------------------------------------
// Finding 4: Invalid settings schema — warn and skip all reclamation.
// ---------------------------------------------------------------------------

test("reclaimRetiredExtensionResidues finding 4: null settings JSON skips all reclamation with a warning", (t) => {
	const { config, agentDir, piLog, settingsPath } = makeConfig(t, {
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
	});
	writeFileSync(settingsPath, "null", "utf8");
	createNpmPackageDir(agentDir, "@ff-labs/pi-fff");

	const stderr = captureConsole("error", () => reclaimRetiredExtensionResidues(config));

	assert.equal(existsSync(piLog), false, "pi must not be invoked when settings schema is invalid");
	assert.match(stderr, /warning:.*invalid schema/);
});

test("reclaimRetiredExtensionResidues finding 4: array settings JSON skips all reclamation with a warning", (t) => {
	const { config, agentDir, piLog, settingsPath } = makeConfig(t, {
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
	});
	writeFileSync(settingsPath, "[]", "utf8");
	createNpmPackageDir(agentDir, "@ff-labs/pi-fff");

	const stderr = captureConsole("error", () => reclaimRetiredExtensionResidues(config));

	assert.equal(existsSync(piLog), false, "pi must not be invoked when settings is an array");
	assert.match(stderr, /warning:.*invalid schema/);
});

test("reclaimRetiredExtensionResidues finding 4: present non-array packages field skips all reclamation with a warning", (t) => {
	const { config, agentDir, piLog, settingsPath } = makeConfig(t, {
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
	});
	writeFileSync(settingsPath, JSON.stringify({ packages: "invalid" }), "utf8");
	createNpmPackageDir(agentDir, "@ff-labs/pi-fff");

	const stderr = captureConsole("error", () => reclaimRetiredExtensionResidues(config));

	assert.equal(existsSync(piLog), false, "pi must not be invoked when packages is not an array");
	assert.match(stderr, /warning:.*invalid schema/);
});

// ---------------------------------------------------------------------------
// Non-directory intermediate path components — regression for ENOTDIR crash
// ---------------------------------------------------------------------------

test("reclaimRetiredExtensionResidues: file at agentDir/npm skips without throwing (ENOTDIR regression)", (t) => {
	const { config, agentDir, piLog } = makeConfig(t, {
		settings: { packages: [] },
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
	});
	// Place a regular FILE at agentDir/npm — simulates a collision with the npm dir
	writeFileSync(join(agentDir, "npm"), "not-a-directory", "utf8");
	// Previously threw ENOTDIR when trying to lstat agentDir/npm/node_modules
	assert.doesNotThrow(() => reclaimRetiredExtensionResidues(config));
	assert.equal(existsSync(piLog), false, "pi must not be invoked when npm path is not a directory");
});

test("reclaimRetiredExtensionResidues: file at agentDir/git skips without throwing (ENOTDIR regression)", (t) => {
	const { config, agentDir, piLog } = makeConfig(t, {
		settings: { packages: [] },
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
	});
	// Place a regular FILE at agentDir/git
	writeFileSync(join(agentDir, "git"), "not-a-directory", "utf8");
	assert.doesNotThrow(() => reclaimRetiredExtensionResidues(config));
	assert.equal(existsSync(piLog), false, "pi must not be invoked when git path is not a directory");
});

test("reclaimRetiredExtensionResidues finding 4: object-form packages entry is preserved (user-owned package not removed)", (t) => {
	const { config, agentDir, piLog } = makeConfig(t, {
		// Object-form settings entry: user has @ff-labs/pi-fff with extra options
		settings: { packages: [{ source: "npm:@ff-labs/pi-fff", extensions: { disabled: true } }] },
		fakePiBody: `printf '%s|%s|%s\\n' "$PI_CODING_AGENT_DIR" "$PWD" "$*" >>"$PI_LOG"`,
	});
	createNpmPackageDir(agentDir, "@ff-labs/pi-fff");

	reclaimRetiredExtensionResidues(config);

	// pi must not be invoked: object-form entry resolves to npm:@ff-labs/pi-fff identity
	assert.equal(
		existsSync(piLog),
		false,
		"pi must not be invoked when user has an object-form entry for the retired package",
	);
	// Directory must still exist
	assert.ok(
		existsSync(join(agentDir, "npm", "node_modules", "@ff-labs", "pi-fff")),
		"package directory must be preserved when user-owned via object-form entry",
	);
});
