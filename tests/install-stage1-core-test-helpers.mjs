import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./install-stage1-test-helpers.mjs";

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoNodeModulesBin = join(repoRoot, "node_modules", ".bin");
export const TLH_NON_PINNED_PI_VERSION = "0.80.1";
export const TLH_PINNED_PI_VERSION = "0.83.0";
export const TLH_PI_PACKAGE_SPEC = `@earendil-works/pi-coding-agent@${TLH_PINNED_PI_VERSION}`;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

export function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pathWithoutRepoNodeModulesBin(pathValue = process.env.PATH || "") {
	return pathValue
		.split(delimiter)
		.filter((entry) => entry && resolve(entry) !== repoNodeModulesBin)
		.join(delimiter);
}

export function scrubInstallerEnv(overrides = {}, baseEnv = process.env) {
	const env = {};
	for (const [key, value] of Object.entries(baseEnv)) {
		if (key === "PI_CODING_AGENT_DIR" || key.startsWith("TLH_")) continue;
		env[key] = value;
	}
	return { ...env, ...overrides };
}

export function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function safeInstallerPath(fakebin) {
	return [fakebin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
}

// ---------------------------------------------------------------------------
// Installer runner helpers
// ---------------------------------------------------------------------------

export function runInstaller(args, env = scrubInstallerEnv()) {
	return spawnSync(process.execPath, [join(repoRoot, "scripts/tlh-install.mjs"), ...args], {
		cwd: repoRoot,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

export function runHelper(scriptRelativePath, args, { homeDir }) {
	const scriptPath = join(repoRoot, scriptRelativePath);
	const result = spawnSync(process.execPath, [scriptPath, ...args], {
		cwd: repoRoot,
		env: scrubInstallerEnv({ HOME: homeDir }),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(result.status, 0, `${scriptRelativePath} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

// ---------------------------------------------------------------------------
// Fake command writers
// ---------------------------------------------------------------------------

export function writeFakeCommand(fakebin, name, body) {
	mkdirSync(fakebin, { recursive: true });
	const commandPath = join(fakebin, name);
	writeFileSync(commandPath, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, "utf8");
	chmodSync(commandPath, 0o755);
}

export function writeFakePi(fakebin, body) {
	writeFakeCommand(fakebin, "pi", body);
}

export function writeFakeTk(fakebin) {
	writeFakeCommand(fakebin, "tk", "printf 'Usage: tk help\\nTicket CLI helper\\n'");
}

export function writeFakeNpmInstaller(fakebin, { npmLog, templatePiPath, installedPiPath }) {
	writeFakeCommand(
		fakebin,
		"npm",
		[
			`printf '%s\\n' "$*" >>"${npmLog}"`,
			`mkdir -p "${dirname(installedPiPath)}"`,
			`cp "${templatePiPath}" "${installedPiPath}"`,
			`chmod +x "${installedPiPath}"`,
		].join("\n"),
	);
}

export function writeLoggingPi(commandDir, logPath, version = TLH_PINNED_PI_VERSION) {
	writeFakePi(
		commandDir,
		[
			`printf '%s|%s|%s\\n' "\${PI_CODING_AGENT_DIR:-}" "$PWD" "$*" >>"${logPath}"`,
			`if [[ "\${1:-}" == "--version" ]]; then printf '${version}\\n'; exit 0; fi`,
			"exit 0",
		].join("\n"),
	);
}

export function writeVersionedWrapperPi(commandDir, logPath, version = TLH_PINNED_PI_VERSION) {
	writeFakePi(
		commandDir,
		[
			`if [[ "\${1:-}" == "--version" ]]; then printf '${version}\\n'; exit 0; fi`,
			`{ printf 'cmd=%s\\n' "$0"; printf 'argv=%s\\n' "$*"; printf 'agent=%s\\n' "\${PI_CODING_AGENT_DIR:-}"; printf 'path=%s\\n' "\${PATH:-}"; } >"${logPath}"`,
			"exit 0",
		].join("\n"),
	);
}

export function writeWrapperHelperLogger(scriptPath, logEnvVar, source) {
	mkdirSync(dirname(scriptPath), { recursive: true });
	writeFileSync(
		scriptPath,
		`import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.${logEnvVar}, JSON.stringify({ source: ${JSON.stringify(source)}, argv: process.argv.slice(2), env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH } }));\n`,
		"utf8",
	);
}

// ---------------------------------------------------------------------------
// High-level test orchestration helpers
// ---------------------------------------------------------------------------

export function runStage1LocalPackageInstall(
	t,
	{
		dryRun = false,
		noSettings = false,
		force = false,
		verbose = false,
		existingSupportFiles,
		existingLibrarianConfig,
		existingManagedRtk = false,
		envOverrides = {},
	} = {},
) {
	const root = makeTempDir();
	const homeDir = join(root, "home");
	const agentDir = join(root, "agent");
	const binDir = join(root, "bin");
	const fakebin = join(root, "fakebin");
	const packageDir = join(root, "package-source");
	const piLog = join(root, "pi.log");
	const templateDir = join(root, "pi-template");
	const npmLog = join(root, "npm.log");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	writeFakeTk(fakebin);
	writeLoggingPi(fakebin, piLog);
	// Fake npm so installPiIfNeeded never hits the network. The fake npm copies a
	// template pi (reporting the pinned version) into the private runtime path.
	writeLoggingPi(templateDir, piLog, TLH_PINNED_PI_VERSION);
	writeFakeNpmInstaller(fakebin, {
		npmLog,
		templatePiPath: join(templateDir, "pi"),
		installedPiPath: join(dirname(agentDir), "runtime", "bin", "pi"),
	});
	if (existingLibrarianConfig !== undefined) {
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "librarian.json"), JSON.stringify(existingLibrarianConfig, null, 2));
	}
	if (existingSupportFiles) {
		for (const [relativePath, content] of Object.entries(existingSupportFiles)) {
			const target = join(agentDir, "tlh", relativePath);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
	}
	if (existingManagedRtk) {
		mkdirSync(join(agentDir, "bin"), { recursive: true });
		writeFileSync(join(agentDir, "bin", "rtk"), "#!/bin/sh\nexit 0\n");
	}
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const env = scrubInstallerEnv({
		HOME: homeDir,
		PATH: `${fakebin}:${process.env.PATH || ""}`,
		TLH_PACKAGE_SOURCE: packageDir,
		TLH_SKIP_GNOSIS_INSTALL: "1",
		...envOverrides,
	});
	const args = ["--agent-dir", agentDir, "--bin-dir", binDir, "--no-wrapper"];
	if (dryRun) args.unshift("--dry-run");
	if (noSettings) args.push("--no-settings");
	if (force) args.push("--force");
	if (verbose) args.push("--verbose");
	const result = runInstaller(args, env);
	return { result, homeDir, agentDir, binDir, piLog };
}
