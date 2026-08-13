import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { captureConsole, readPiLog } from "./install-stage1-test-helpers.mjs";
import {
	assertPiCommands,
	makeDefaultExtensionInstallConfig,
} from "./install-stage1-default-extensions-test-helpers.mjs";

import { installDefaultExtensions, preInstallNpmDefaultExtensions } from "../scripts/tlh-install.mjs";

test("stage-1 batches non-critical default extension updates", (t) => {
	const defaults = [
		{ id: "helper-a", source: "npm:helper-a" },
		{ id: "helper-b", source: "npm:helper-b" },
	];
	const { config, agentDir, piLog } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: defaults.map((entry) => entry.source) },
		fakePiBody: 'printf \'%s|%s|%s\n\' "${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${PI_LOG}"',
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
			'printf \'%s|%s|%s\\n\' "${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${PI_LOG}"',
			'if [[ "$1" == "update" && "${2:-}" == "--extensions" ]]; then',
			"\tprintf 'batch failed\\n' >&2",
			"\texit 42",
			"fi",
			'if [[ "$1" == "update" && "${2:-}" == "--extension" ]]; then',
			"\tprintf 'old pi does not support --extension\\n' >&2",
			"\texit 98",
			"fi",
			'if [[ "$1" == "update" && "${2:-}" == "npm:helper-a" ]]; then',
			'\ttouch "${PI_CODING_AGENT_DIR}/fallback-a.done"',
			"\texit 0",
			"fi",
			'if [[ "$1" == "update" && "${2:-}" == "npm:helper-b" ]]; then',
			'\ttouch "${PI_CODING_AGENT_DIR}/fallback-b.attempted"',
			"\tprintf 'helper-b failed\\n' >&2",
			"\texit 43",
			"fi",
			'if [[ "$1" == "install" && "${2:-}" == "git:github.com/example/critical" ]]; then',
			'\t[[ -f "${PI_CODING_AGENT_DIR}/fallback-a.done" && -f "${PI_CODING_AGENT_DIR}/fallback-b.attempted" ]] || { printf \'critical install ran before fallback completed\\n\' >&2; exit 44; }',
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
	assert.match(
		stderr,
		/warning: settings-wide extension refresh from merged settings failed; falling back to per-source updates for only 2 non-critical bundled default source\(s\)/,
	);
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
			'printf \'%s|%s|%s\\n\' "${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${PI_LOG}"',
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
			'printf \'%s|%s|%s\\n\' "${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${PI_LOG}"',
			'if [[ "$1" == "update" && "${2:-}" == "--extensions" ]]; then',
			"\t[[ -f \"${PI_CODING_AGENT_DIR}/preflight-safe.done\" ]] || { printf 'settings-wide update ran before critical preflight\\n' >&2; exit 46; }",
			"\tprintf 'stage:settings-wide-batch\\n' >>\"${PI_LOG}.order\"",
			'\ttouch "${PI_CODING_AGENT_DIR}/settings-wide-update.done"',
			"\texit 0",
			"fi",
			'if [[ "$1" == "update" && "${2:-}" == "--extension" ]]; then',
			"\tprintf 'unexpected per-source fallback: %s\\n' \"$*\" >&2",
			"\texit 47",
			"fi",
			'if [[ "$1" == "install" && "${2:-}" == "git:github.com/example/critical@pin" ]]; then',
			"\t[[ -f \"${PI_CODING_AGENT_DIR}/settings-wide-update.done\" ]] || { printf 'critical install ran before settings-wide update\\n' >&2; exit 48; }",
			"\t[[ -f \"${PI_CODING_AGENT_DIR}/critical-preinstall-validation.done\" ]] || { printf 'critical install ran before post-batch safety validation\\n' >&2; exit 49; }",
			"\tprintf 'stage:critical-install\\n' >>\"${PI_LOG}.order\"",
			'\ttouch "${PI_CODING_AGENT_DIR}/critical-install.done"',
			"\texit 0",
			"fi",
		].join("\n"),
		fakeGitBody: [
			"target=''",
			'if [[ "${1:-}" == "-C" ]]; then target="$2"; shift 2; fi',
			'record_stage() { local stage="$1" marker="$2"; if [[ ! -f "${AGENT_DIR}/${marker}" ]]; then printf \'stage:%s\\n\' "$stage" >>"${PI_LOG}.order"; touch "${AGENT_DIR}/${marker}"; fi; }',
			'if [[ "${1:-}" == "rev-parse" && "${2:-}" == "--show-toplevel" ]]; then',
			'\tif [[ ! -f "${AGENT_DIR}/settings-wide-update.done" ]]; then',
			"\t\trecord_stage preflight-safe preflight-safe.done",
			'\telif [[ ! -f "${AGENT_DIR}/critical-install.done" ]]; then',
			"\t\t[[ -f \"${AGENT_DIR}/preflight-safe.done\" ]] || { printf 'post-batch validation ran before preflight\\n' >&2; exit 50; }",
			"\t\trecord_stage critical-preinstall-validation critical-preinstall-validation.done",
			"\telse",
			"\t\t[[ -f \"${AGENT_DIR}/settings-wide-update.done\" ]] || { printf 'ref validation ran before settings-wide update\\n' >&2; exit 51; }",
			"\t\trecord_stage critical-ref-validation critical-ref-validation.done",
			"\tfi",
			"\tprintf '%s\\n' \"$target\"",
			"\texit 0",
			"fi",
			'if [[ "${1:-}" == "rev-parse" && "${2:-}" == "--absolute-git-dir" ]]; then printf \'%s/.git\\n\' "$target"; exit 0; fi',
			'if [[ "${1:-}" == "rev-parse" && "${2:-}" == "--git-common-dir" ]]; then printf \'%s/.git\\n\' "$target"; exit 0; fi',
			"exit 0",
		].join("\n"),
	});
	mkdirSync(join(agentDir, "git", "github.com", "example", "critical", ".git"), { recursive: true });

	installDefaultExtensions(config);

	assertPiCommands(piLog, agentDir, ["update --extensions", "install git:github.com/example/critical@pin"]);
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

	assert.match(
		stdout,
		/Would preflight 1 critical bundled default git checkout target\(s\) before any settings-wide default extension update/,
	);
	assert.match(stdout, /pi install git:github\.com\/example\/critical@pin/);
	assert.match(stdout, /git -C .*\/git\/github\.com\/example\/critical fetch --prune --tags origin/);
	assert.match(stdout, /Dry run: settings-wide extension refresh will run from merged settings/);
	assert.match(stdout, /PI_CODING_AGENT_DIR=.*pi update --extensions/);
	assert.match(stdout, /would retry only 1 non-critical bundled default source\(s\) individually/i);
	assert.doesNotMatch(stdout, /^Would.*\bpi\s+update\b/m);
	assert.doesNotMatch(stdout, /pi update --extension npm:helper/);
});

// --- preInstallNpmDefaultExtensions tests ---

test("preInstallNpmDefaultExtensions batch-installs all enabled npm: sources", (t) => {
	const defaults = [
		{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" },
		{ id: "pkg-b", source: "npm:@scope/pkg-b@2.0.0" },
	];
	const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: defaults.map((entry) => entry.source) },
		fakeNpmBody: ['printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"', "exit 0"].join("\n"),
	});

	preInstallNpmDefaultExtensions(config);

	const npmRootPkg = join(agentDir, "npm", "package.json");
	const npmRootGitignore = join(agentDir, "npm", ".gitignore");
	assert.ok(existsSync(npmRootPkg), "npm/package.json should be created");
	assert.ok(existsSync(npmRootGitignore), "npm/.gitignore should be created");

	const pkgJson = JSON.parse(readFileSync(npmRootPkg, "utf8"));
	assert.equal(pkgJson.name, "pi-extensions");
	assert.equal(pkgJson.private, true);

	const gitignore = readFileSync(npmRootGitignore, "utf8");
	assert.match(gitignore, /^\*\n!\.gitignore/);

	const npmLogPath = join(agentDir, "npm.log");
	assert.ok(existsSync(npmLogPath), "fake npm should have been called");
	const logContent = readFileSync(npmLogPath, "utf8").trim();
	// Should be one batch call: install <specs...> --prefix <npmRoot> --legacy-peer-deps
	const lines = logContent.split(/\r?\n/).filter(Boolean);
	assert.equal(lines.length, 1, "only one npm call should be made (batch)");
	assert.match(lines[0], /install.*@scope\/pkg-a@1\.0\.0.*@scope\/pkg-b@2\.0\.0/);
	assert.match(lines[0], /--prefix/);
	assert.match(lines[0], /--legacy-peer-deps/);
});

test("preInstallNpmDefaultExtensions skips on --no-settings", (t) => {
	const defaults = [{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" }];
	const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: defaults.map((entry) => entry.source) },
		fakeNpmBody: 'printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"\nexit 0',
	});
	config.noSettings = true;

	preInstallNpmDefaultExtensions(config);

	assert.ok(!existsSync(join(agentDir, "npm.log")), "npm should not be called when --no-settings");
	assert.ok(!existsSync(join(agentDir, "npm")), "npm root should not be created when --no-settings");
});

test("preInstallNpmDefaultExtensions ignores git: and local sources", (t) => {
	const defaults = [
		{ id: "git-ext", source: "git:github.com/example/ext@main" },
		{ id: "npm-ext", source: "npm:@scope/npm-ext@1.0.0" },
	];
	const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: defaults.map((entry) => entry.source) },
		fakeNpmBody: ['printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"', "exit 0"].join("\n"),
	});

	preInstallNpmDefaultExtensions(config);

	const npmLogPath = join(agentDir, "npm.log");
	assert.ok(existsSync(npmLogPath), "npm should be called for npm: sources");
	const logContent = readFileSync(npmLogPath, "utf8").trim();
	assert.doesNotMatch(logContent, /git:/, "git: source should not appear in npm install args");
	assert.match(logContent, /@scope\/npm-ext@1\.0\.0/, "npm: source should be installed");
});

test("preInstallNpmDefaultExtensions is non-fatal when npm install fails", (t) => {
	const defaults = [{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" }];
	const { config } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: defaults.map((entry) => entry.source) },
		fakeNpmBody: "printf 'npm install failed\\n' >&2\nexit 1",
	});

	const stderr = captureConsole("error", () => {
		assert.doesNotThrow(() => preInstallNpmDefaultExtensions(config));
	});
	assert.match(stderr, /npm pre-install of pinned default extensions failed/);
	assert.match(stderr, /Pi will install missing packages on first launch/);
});

test("preInstallNpmDefaultExtensions dry-run prints planned command without writing", (t) => {
	const defaults = [
		{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" },
		{ id: "pkg-b", source: "npm:@scope/pkg-b@2.0.0" },
	];
	const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: defaults.map((entry) => entry.source) },
		dryRun: true,
	});

	const stdout = captureConsole("log", () => preInstallNpmDefaultExtensions(config));

	assert.match(stdout, /npm install/, "dry-run should print the planned npm install command");
	assert.match(stdout, /@scope\/pkg-a@1\.0\.0/, "dry-run should include spec a");
	assert.match(stdout, /@scope\/pkg-b@2\.0\.0/, "dry-run should include spec b");
	assert.match(stdout, /--legacy-peer-deps/, "dry-run should include --legacy-peer-deps");
	assert.ok(!existsSync(join(agentDir, "npm")), "npm root should not be created in dry-run");
});

test("preInstallNpmDefaultExtensions does not install disabled extensions", (t) => {
	const defaults = [
		{ id: "enabled-ext", source: "npm:@scope/enabled@1.0.0" },
		{ id: "disabled-ext", source: "npm:@scope/disabled@1.0.0" },
	];
	const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: {
			packages: defaults.map((entry) => entry.source),
			tlh: { disabledDefaultExtensions: ["disabled-ext"] },
		},
		fakeNpmBody: ['printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"', "exit 0"].join("\n"),
	});

	preInstallNpmDefaultExtensions(config);

	const npmLogPath = join(agentDir, "npm.log");
	assert.ok(existsSync(npmLogPath), "npm should be called");
	const logContent = readFileSync(npmLogPath, "utf8").trim();
	assert.match(logContent, /@scope\/enabled@1\.0\.0/, "enabled extension should be installed");
	assert.doesNotMatch(logContent, /@scope\/disabled@1\.0\.0/, "disabled extension should not be installed");
});

test("preInstallNpmDefaultExtensions idempotent: does not corrupt existing npm root", (t) => {
	const defaults = [{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" }];
	const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: defaults.map((entry) => entry.source) },
		fakeNpmBody: ['printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"', "exit 0"].join("\n"),
	});

	// Pre-create npm root with existing package.json and .gitignore
	const npmRoot = join(agentDir, "npm");
	mkdirSync(npmRoot, { recursive: true });
	const existingPkg = JSON.stringify({ name: "pi-extensions", private: true, version: "1.0.0" });
	writeFileSync(join(npmRoot, "package.json"), existingPkg);
	writeFileSync(join(npmRoot, ".gitignore"), "*\n!.gitignore\n");

	preInstallNpmDefaultExtensions(config);

	// Existing files should NOT be overwritten
	assert.equal(readFileSync(join(npmRoot, "package.json"), "utf8"), existingPkg);
});

// --- Finding 1: symlinked npm root refusal ---

test("preInstallNpmDefaultExtensions refuses symlinked npm root: warns, writes nothing through symlink, npm not invoked", (t) => {
	const defaults = [{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" }];
	const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: defaults.map((entry) => entry.source) },
		fakeNpmBody: ['printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"', "exit 0"].join("\n"),
	});

	// Symlink agentDir/npm to an external directory.
	const npmExternal = join(agentDir, "..", "npm-external");
	mkdirSync(npmExternal, { recursive: true });
	symlinkSync(npmExternal, join(agentDir, "npm"));

	const stderr = captureConsole("error", () => {
		assert.doesNotThrow(() => preInstallNpmDefaultExtensions(config));
	});

	// Should warn about the unsafe npm prefix.
	assert.match(stderr, /npm pre-install skipped.*unsafe npm prefix/);
	// npm must NOT have been invoked.
	assert.ok(!existsSync(join(agentDir, "npm.log")), "npm must not be invoked when npm root is a symlink");
	// Nothing should have been written into the external directory through the symlink.
	assert.deepEqual(
		existsSync(join(npmExternal, "package.json")),
		false,
		"package.json must not be written through symlink",
	);
});

// --- Finding 2: differing configured version skip (no downgrade) ---

test("preInstallNpmDefaultExtensions skips pre-install when configured version differs from bundled pin", (t) => {
	const bundledSource = "npm:@scope/pkg-a@1.0.0";
	const configuredSource = "npm:@scope/pkg-a@2.0.0"; // user-preserved newer version
	const defaults = [{ id: "pkg-a", source: bundledSource }];
	const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		// Settings carry the user-preserved version, not the bundled pin.
		settings: { packages: [configuredSource] },
		fakeNpmBody: ['printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"', "exit 0"].join("\n"),
	});
	// Enable verbose + un-quiet so we can verify the skip log.
	config.verbose = true;
	config.quiet = false;

	const stdout = captureConsole("log", () => preInstallNpmDefaultExtensions(config));

	// npm must NOT have been invoked (would downgrade @2.0.0 → @1.0.0).
	assert.ok(
		!existsSync(join(agentDir, "npm.log")),
		"npm must not be invoked when configured version differs from bundled pin",
	);
	// Verbose log must explain the skip.
	assert.match(
		stdout,
		/Skipping pre-install of.*@scope\/pkg-a@1\.0\.0.*configured version.*@scope\/pkg-a@2\.0\.0.*differs from bundled pin/,
	);
});

test("preInstallNpmDefaultExtensions still installs when configured version matches bundled pin", (t) => {
	const source = "npm:@scope/pkg-a@1.0.0";
	const defaults = [{ id: "pkg-a", source }];
	const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: [source] }, // settings match the bundled pin exactly
		fakeNpmBody: ['printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"', "exit 0"].join("\n"),
	});

	preInstallNpmDefaultExtensions(config);

	// npm SHOULD have been invoked since the version matches.
	assert.ok(existsSync(join(agentDir, "npm.log")), "npm should be invoked when configured version matches bundled pin");
	const logContent = readFileSync(join(agentDir, "npm.log"), "utf8").trim();
	assert.match(logContent, /@scope\/pkg-a@1\.0\.0/);
});

// --- Finding 3: non-npm package manager skip ---

test("preInstallNpmDefaultExtensions skips when configured npmCommand is pnpm", (t) => {
	const defaults = [{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" }];
	const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: defaults.map((entry) => entry.source), npmCommand: ["pnpm"] },
		fakeNpmBody: ['printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"', "exit 0"].join("\n"),
	});
	// Enable verbose + un-quiet so we can verify the skip log.
	config.verbose = true;
	config.quiet = false;

	const stdout = captureConsole("log", () => preInstallNpmDefaultExtensions(config));

	// npm must NOT have been invoked (pnpm uses different install args).
	assert.ok(!existsSync(join(agentDir, "npm.log")), "npm must not be invoked when npmCommand is pnpm");
	// Verbose log must explain the skip.
	assert.match(stdout, /Skipping npm pre-install.*configured npmCommand is not plain npm.*pnpm/);
	// Installer must still be non-fatal (no throw).
});

test("preInstallNpmDefaultExtensions skips when configured npmCommand is bun", (t) => {
	const defaults = [{ id: "pkg-a", source: "npm:@scope/pkg-a@1.0.0" }];
	const { config, agentDir } = makeDefaultExtensionInstallConfig(t, {
		defaultExtensions: defaults,
		settings: { packages: defaults.map((entry) => entry.source), npmCommand: ["bun"] },
		fakeNpmBody: ['printf \'%s\\n\' "$*" >>"${AGENT_DIR}/npm.log"', "exit 0"].join("\n"),
	});
	config.verbose = true;
	config.quiet = false;

	const stdout = captureConsole("log", () => preInstallNpmDefaultExtensions(config));

	assert.ok(!existsSync(join(agentDir, "npm.log")), "npm must not be invoked when npmCommand is bun");
	assert.match(stdout, /Skipping npm pre-install.*configured npmCommand is not plain npm.*bun/);
});
