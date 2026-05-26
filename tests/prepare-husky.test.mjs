import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const prepareScript = join(repoRoot, "scripts", "prepare-husky.mjs");

function tempFixture(t) {
	const dir = mkdtempSync(join(tmpdir(), "tlh-prepare-husky-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function runPrepare(cwd, env = {}) {
	const childEnv = { ...process.env };
	for (const key of ["CI", "HUSKY", "NODE_ENV", "npm_config_omit", "npm_config_production"]) {
		delete childEnv[key];
	}

	return spawnSync(process.execPath, [prepareScript], {
		cwd,
		env: { ...childEnv, ...env },
		encoding: "utf8",
	});
}

function writeFakeHusky(cwd, body) {
	const binDir = join(cwd, "node_modules", ".bin");
	mkdirSync(binDir, { recursive: true });
	const huskyPath = join(binDir, "husky");
	writeFileSync(huskyPath, `#!/bin/sh
set -eu
${body}
`);
	chmodSync(huskyPath, 0o755);
	return huskyPath;
}

test("prepare-husky skips cleanly when git metadata is absent", { skip: process.platform === "win32" }, (t) => {
	const fixture = tempFixture(t);
	const result = runPrepare(fixture);

	assert.equal(result.status, 0, result.stderr || String(result.error));
	assert.match(result.stdout, /skipping because \.git is missing/);
	assert.equal(existsSync(join(fixture, "node_modules", ".bin", "husky")), false);
});

test("prepare-husky skips when git metadata exists but the local Husky binary is missing", { skip: process.platform === "win32" }, (t) => {
	const fixture = tempFixture(t);
	mkdirSync(join(fixture, ".git"), { recursive: true });

	const result = runPrepare(fixture);

	assert.equal(result.status, 0, result.stderr || String(result.error));
	assert.match(result.stdout, /skipping because local Husky binary is missing/);
	assert.equal(existsSync(join(fixture, "node_modules")), false);
	assert.equal(existsSync(join(fixture, "node_modules", ".bin", "husky")), false);
});

test("prepare-husky skips production-ish installs even when a local Husky binary exists", { skip: process.platform === "win32" }, (t) => {
	const omitDevFixture = tempFixture(t);
	mkdirSync(join(omitDevFixture, ".git"), { recursive: true });
	const omitDevRunLog = join(omitDevFixture, "husky-ran.log");
	writeFakeHusky(omitDevFixture, `printf omit-dev-run > ${JSON.stringify(omitDevRunLog)}`);

	const omitDevResult = runPrepare(omitDevFixture, { npm_config_omit: "optional,dev" });
	assert.equal(omitDevResult.status, 0, omitDevResult.stderr || String(omitDevResult.error));
	assert.match(omitDevResult.stdout, /skipping because npm_config_omit includes dev/);
	assert.equal(existsSync(omitDevRunLog), false);

	const nodeEnvFixture = tempFixture(t);
	mkdirSync(join(nodeEnvFixture, ".git"), { recursive: true });
	const nodeEnvRunLog = join(nodeEnvFixture, "husky-ran.log");
	writeFakeHusky(nodeEnvFixture, `printf node-env-run > ${JSON.stringify(nodeEnvRunLog)}`);

	const nodeEnvResult = runPrepare(nodeEnvFixture, { NODE_ENV: "production" });
	assert.equal(nodeEnvResult.status, 0, nodeEnvResult.stderr || String(nodeEnvResult.error));
	assert.match(nodeEnvResult.stdout, /skipping because NODE_ENV=production/);
	assert.equal(existsSync(nodeEnvRunLog), false);

	const npmProductionFixture = tempFixture(t);
	mkdirSync(join(npmProductionFixture, ".git"), { recursive: true });
	const npmProductionRunLog = join(npmProductionFixture, "husky-ran.log");
	writeFakeHusky(npmProductionFixture, `printf npm-production-run > ${JSON.stringify(npmProductionRunLog)}`);

	const npmProductionResult = runPrepare(npmProductionFixture, { npm_config_production: "true" });
	assert.equal(npmProductionResult.status, 0, npmProductionResult.stderr || String(npmProductionResult.error));
	assert.match(npmProductionResult.stdout, /skipping because npm_config_production is set/);
	assert.equal(existsSync(npmProductionRunLog), false);
});

test("prepare-husky skips contributor installs when HUSKY=0 or CI is set", { skip: process.platform === "win32" }, (t) => {
	const fixture = tempFixture(t);
	mkdirSync(join(fixture, ".git"), { recursive: true });
	const runLog = join(fixture, "husky-ran.log");
	writeFakeHusky(fixture, `printf ran > ${JSON.stringify(runLog)}`);

	const huskyDisabled = runPrepare(fixture, { HUSKY: "0" });
	assert.equal(huskyDisabled.status, 0, huskyDisabled.stderr || String(huskyDisabled.error));
	assert.match(huskyDisabled.stdout, /skipping because HUSKY=0/);
	assert.equal(existsSync(runLog), false);

	const ciDisabled = runPrepare(fixture, { CI: "true" });
	assert.equal(ciDisabled.status, 0, ciDisabled.stderr || String(ciDisabled.error));
	assert.match(ciDisabled.stdout, /skipping because CI is set/);
	assert.equal(existsSync(runLog), false);
});

test("prepare-husky runs the local Husky binary for contributor installs", { skip: process.platform === "win32" }, (t) => {
	const fixture = tempFixture(t);
	mkdirSync(join(fixture, ".git"), { recursive: true });
	const runLog = join(fixture, "husky-ran.log");
	writeFakeHusky(fixture, `printf contributor-run > ${JSON.stringify(runLog)}`);

	const result = runPrepare(fixture);

	assert.equal(result.status, 0, result.stderr || String(result.error));
	assert.match(result.stdout, /installing local Husky hooks/);
	assert.equal(readFileSync(runLog, "utf8"), "contributor-run");
});

test("prepare-husky propagates local Husky failures", { skip: process.platform === "win32" }, (t) => {
	const fixture = tempFixture(t);
	mkdirSync(join(fixture, ".git"), { recursive: true });
	writeFakeHusky(fixture, `echo 'husky failed intentionally' >&2
exit 17`);

	const result = runPrepare(fixture);

	assert.equal(result.status, 17);
	assert.match(result.stderr, /husky failed intentionally/);
});
