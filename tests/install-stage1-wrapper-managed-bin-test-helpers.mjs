import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./install-stage1-test-helpers.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
	assert.equal(result.status, 0, `${scriptRelativePath} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
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

export function setupTicketsEnabledWrapperFixture(t) {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const agentBin = join(agentDir, "bin");
	const binDir = join(root, "bin");
	const packageRoot = join(root, "package");
	const fakebin = join(root, "fakebin");
	const cwdDir = join(root, "cwd");
	const piLog = join(root, "pi.txt");
	mkdirSync(join(agentDir, "tlh"), { recursive: true });
	mkdirSync(agentBin, { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageRoot, { recursive: true });
	mkdirSync(cwdDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeFakePi(
		fakebin,
		[
			'if [[ "${1:-}" == "--version" ]]; then printf \'0.84.1\\n\'; exit 0; fi',
			'printf \'path=%s\\n\' "${PATH:-}" >"${PI_WRAPPER_LOG}"',
		].join("\n"),
	);

	runHelper(
		"scripts/tlh-wrapper.mjs",
		[
			"--agent-dir",
			agentDir,
			"--bin-dir",
			binDir,
			"--wrapper-name",
			"tlh",
			"--package-root",
			packageRoot,
			"--pi-cmd",
			join(fakebin, "pi"),
		],
		{ homeDir },
	);

	const wrapper = join(binDir, "tlh");
	const runWrapper = () =>
		spawnSync(wrapper, ["chat"], {
			cwd: cwdDir,
			env: scrubInstallerEnv({
				HOME: homeDir,
				PATH: [fakebin, process.env.PATH || ""].join(":"),
				PI_WRAPPER_LOG: piLog,
			}),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	const readPiPath = () => readFileSync(piLog, "utf8").trim().slice("path=".length).split(":");

	return { agentDir, agentBin, runWrapper, readPiPath };
}
