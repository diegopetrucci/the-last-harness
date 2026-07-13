import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";

import { renderWrapper } from "../scripts/tlh-wrapper.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const checkStartupPerformanceScript = join(repoRoot, "scripts", "check-startup-performance.mjs");

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(ms) {
	return new Promise((resolvePromise) => {
		setTimeout(resolvePromise, ms);
	});
}

async function waitForCondition(predicate, timeoutMs, description) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = predicate();
		if (result) {
			return result;
		}
		await delay(25);
	}
	throw new Error(`timed out waiting for ${description}`);
}

function writeExecutable(path, content) {
	writeFileSync(path, content, "utf8");
	chmodSync(path, 0o755);
}

function hasPython3PtyBridge() {
	const result = spawnSync("python3", ["-c", "pass"], { stdio: "ignore" });
	return !result.error && result.status === 0;
}

function createManagedWrapperFixture() {
	const root = mkdtempSync(join(tmpdir(), "tlh-check-startup-performance-test-"));
	const agentDir = join(root, "agent-source");
	const runtimeBinDir = join(root, "runtime", "bin");
	const wrapperBinDir = join(root, "bin");
	const packageRoot = join(root, "package-root");
	const wrapperPath = join(wrapperBinDir, "tlh");
	const piPath = join(runtimeBinDir, "pi");
	const customCommandPath = join(root, "custom-command.sh");

	mkdirSync(agentDir, { recursive: true });
	mkdirSync(runtimeBinDir, { recursive: true });
	mkdirSync(wrapperBinDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), "{}\n", "utf8");

	writeExecutable(piPath, `#!/usr/bin/env bash
set -euo pipefail
source_agent_dir=${JSON.stringify(agentDir)}
if [[ "\${PI_CODING_AGENT_DIR:-}" == "\${source_agent_dir}" ]]; then
  printf 'used original profile: %s\n' "\${PI_CODING_AGENT_DIR}" >&2
  exit 9
fi
printf 'Context: startup check\n'
printf 'agent: ready\n'
trap 'exit 0' INT TERM
while true; do
  sleep 1
done
`);

	writeExecutable(customCommandPath, `#!/usr/bin/env bash
set -euo pipefail
if [[ -z "\${PI_CODING_AGENT_DIR:-}" ]]; then
  printf 'missing PI_CODING_AGENT_DIR\n' >&2
  exit 9
fi
printf 'Context: custom command\n'
printf 'agent: ready\n'
trap 'exit 0' INT TERM
while true; do
  sleep 1
done
`);

	writeExecutable(wrapperPath, renderWrapper({
		agentDir,
		binDir: wrapperBinDir,
		wrapperName: "tlh",
		packageRoot,
		piCmd: piPath,
	}));

	return {
		agentDir,
		customCommandPath,
		root,
		wrapperBinDir,
		wrapperPath,
	};
}

function runCheckStartupPerformance(fixture, args) {
	return spawnSync(process.execPath, [checkStartupPerformanceScript, ...args], {
		cwd: repoRoot,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${fixture.wrapperBinDir}:${process.env.PATH || ""}`,
		},
		timeout: 15000,
	});
}

test("check-startup-performance uses a temporary tlh wrapper for the default command", (t) => {
	const fixture = createManagedWrapperFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const result = runCheckStartupPerformance(fixture, [
		"--runs",
		"2",
		"--budget-ms",
		"10000",
		"--timeout-ms",
		"2000",
		"--profile-source",
		fixture.agentDir,
	]);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /launch mode: temporary managed tlh wrapper/);
	assert.match(result.stdout, new RegExp(`source wrapper: ${escapeRegExp(fixture.wrapperPath)}`));
	assert.match(result.stdout, /PASS warm first-header mean/);
	assert.equal(result.stderr, "");
});

test("check-startup-performance keeps custom --command launches usable", (t) => {
	const fixture = createManagedWrapperFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	const result = runCheckStartupPerformance(fixture, [
		"--runs",
		"2",
		"--budget-ms",
		"10000",
		"--timeout-ms",
		"2000",
		"--profile-source",
		fixture.agentDir,
		"--command",
		fixture.customCommandPath,
	]);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /launch mode: direct custom command/);
	assert.doesNotMatch(result.stdout, /temporary wrapper:/);
	assert.match(result.stdout, /PASS warm first-header mean/);
	assert.equal(result.stderr, "");
});

test("check-startup-performance requires genuine header output after a delayed rendered footer", (t) => {
	const fixture = createManagedWrapperFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	writeExecutable(fixture.customCommandPath, `#!/usr/bin/env bash
set -euo pipefail
printf '~/Developer/the-last-harness-minotaur (main)\n'
sleep 0.15
printf '────────────────────────────────────────────────────────────────────────────────\n'
trap 'exit 0' INT TERM
while true; do
  sleep 1
done
`);
	const result = runCheckStartupPerformance(fixture, [
		"--runs",
		"2",
		"--budget-ms",
		"10000",
		"--timeout-ms",
		"2000",
		"--profile-source",
		fixture.agentDir,
		"--command",
		fixture.customCommandPath,
	]);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /PASS warm first-header mean/);
	const warmRun = result.stdout.match(/run\s+2 warm\s+output [\d.]+ms\s+header ([\d.]+)ms\s+footer ([\d.]+)ms/u);
	assert.ok(warmRun, `expected warm-run timing output, got:\n${result.stdout}`);
	assert.ok(Number(warmRun[1]) - Number(warmRun[2]) >= 100, `expected delayed header after footer, got: ${warmRun[0]}`);
	assert.equal(result.stderr, "");
});

test("check-startup-performance does not treat rendered footer cwd output as a header", (t) => {
	const fixture = createManagedWrapperFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
	writeExecutable(fixture.customCommandPath, `#!/usr/bin/env bash
set -euo pipefail
printf '~/Developer/the-last-harness-minotaur (main)\n'
trap 'exit 0' INT TERM
while true; do
  sleep 1
done
`);
	const result = runCheckStartupPerformance(fixture, [
		"--runs",
		"2",
		"--budget-ms",
		"10000",
		"--timeout-ms",
		"300",
		"--profile-source",
		fixture.agentDir,
		"--command",
		fixture.customCommandPath,
	]);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /timed out waiting for header/);
});

test("check-startup-performance cleans up the active child process group and temp workspace on SIGINT", async (t) => {
	if (!hasPython3PtyBridge()) {
		t.skip("requires python3 PTY bridge coverage");
	}

	const fixture = createManagedWrapperFixture();
	t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

	const childPidFile = join(fixture.root, "child.pid");
	const childReadyFile = join(fixture.root, "child.ready");
	const childSignalFile = join(fixture.root, "child.signal");
	const helperPidFile = join(fixture.root, "helper.pid");
	const helperReadyFile = join(fixture.root, "helper.ready");
	const helperSignalFile = join(fixture.root, "helper.signal");
	const helperScriptPath = join(fixture.root, "term-trap-helper.sh");
	writeExecutable(helperScriptPath, `#!/usr/bin/env bash
set -euo pipefail
trap '' INT
trap 'printf "signal=%s\\n" "TERM" >"${helperSignalFile}"; exit 0' TERM
printf '%s\n' "$$" >"${helperPidFile}"
printf 'ready\n' >"${helperReadyFile}"
while true; do
  sleep 0.05
done
`);
	writeExecutable(fixture.customCommandPath, `#!/usr/bin/env bash
set -euo pipefail
"${helperScriptPath}" &
helper_pid=$!
while [[ ! -f "${helperReadyFile}" ]]; do
  sleep 0.05
done
printf '%s\n' "$$" >"${childPidFile}"
trap '' INT
trap 'printf "signal=%s\\n" "TERM" >"${childSignalFile}"; wait "$helper_pid"; exit 0' TERM
printf 'ready\n' >"${childReadyFile}"
printf 'Context: interrupt cleanup\\n'
while true; do
  sleep 1
done
`);

	const checker = spawn(process.execPath, [
		checkStartupPerformanceScript,
		"--runs",
		"2",
		"--budget-ms",
		"10000",
		"--timeout-ms",
		"10000",
		"--profile-source",
		fixture.agentDir,
		"--command",
		fixture.customCommandPath,
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			PATH: `${fixture.wrapperBinDir}:${process.env.PATH || ""}`,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => {
		if (checker.exitCode === null && checker.signalCode === null) {
			checker.kill("SIGKILL");
		}
		for (const pidFile of [helperPidFile, childPidFile]) {
			if (!existsSync(pidFile)) {
				continue;
			}
			const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
			if (!Number.isInteger(pid) || pid <= 0) {
				continue;
			}
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Ignore already-terminated test helper processes.
			}
		}
	});

	let stdout = "";
	let stderr = "";
	checker.stdout.setEncoding("utf8");
	checker.stderr.setEncoding("utf8");
	checker.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	checker.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	const temporaryProfile = await waitForCondition(() => {
		const match = stdout.match(/temporary profile: (.+)/u);
		if (!match || !existsSync(childPidFile) || !existsSync(childReadyFile) || !existsSync(helperPidFile) || !existsSync(helperReadyFile)) {
			return undefined;
		}
		return match[1].trim();
	}, 5000, "startup checker to create a temp profile and launch the child process group");
	const workspaceRoot = dirname(temporaryProfile);
	const childPid = Number.parseInt(readFileSync(childPidFile, "utf8"), 10);
	assert.ok(Number.isInteger(childPid) && childPid > 0, `expected child pid, got ${childPid}`);
	const helperPid = Number.parseInt(readFileSync(helperPidFile, "utf8"), 10);
	assert.ok(Number.isInteger(helperPid) && helperPid > 0, `expected helper pid, got ${helperPid}`);

	const exitPromise = new Promise((resolvePromise, rejectPromise) => {
		checker.once("error", rejectPromise);
		checker.once("exit", (code, signal) => {
			resolvePromise({ code, signal });
		});
	});
	checker.kill("SIGINT");
	const exit = await exitPromise;

	assert.deepEqual(exit, { code: null, signal: "SIGINT" });
	await waitForCondition(() => !existsSync(workspaceRoot), 5000, "temp workspace cleanup");
	await waitForCondition(() => existsSync(childSignalFile), 5000, "child signal trap output");
	await waitForCondition(() => existsSync(helperSignalFile), 5000, "helper TERM trap output");
	for (const [pid, description] of [[childPid, "child process shutdown"], [helperPid, "TERM-trap helper shutdown"]]) {
		await waitForCondition(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch (error) {
				return error && typeof error === "object" && "code" in error && error.code === "ESRCH";
			}
		}, 5000, description);
	}
	assert.match(readFileSync(childSignalFile, "utf8"), /signal=TERM/);
	assert.match(readFileSync(helperSignalFile, "utf8"), /signal=TERM/);
	assert.equal(stderr, "");
});
