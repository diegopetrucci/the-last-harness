import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { makeTempDir } from "./install-stage1-test-helpers.mjs";
import {
	repoRoot,
	scrubInstallerEnv,
	writeFakePi,
	writeVersionedWrapperPi,
} from "./install-stage1-core-test-helpers.mjs";


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
