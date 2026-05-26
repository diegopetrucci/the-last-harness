#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

function envFlagEnabled(value) {
	if (typeof value !== "string") return false;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return false;
	return normalized !== "0" && normalized !== "false";
}

function localHuskyPath(cwd = process.cwd()) {
	const binary = process.platform === "win32" ? "husky.cmd" : "husky";
	return join(cwd, "node_modules", ".bin", binary);
}

function omitListIncludesDev(value) {
	if (typeof value !== "string") return false;
	return value
		.split(/[\s,]+/u)
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean)
		.includes("dev");
}

function productionInstallSkipReason(env = process.env) {
	if (omitListIncludesDev(env.npm_config_omit)) {
		return "skipping because npm_config_omit includes dev";
	}
	if (typeof env.NODE_ENV === "string" && env.NODE_ENV.trim().toLowerCase() === "production") {
		return "skipping because NODE_ENV=production";
	}
	if (envFlagEnabled(env.npm_config_production)) {
		return "skipping because npm_config_production is set";
	}
	return null;
}

function skip(message) {
	console.log(`prepare-husky: ${message}`);
}

const cwd = process.cwd();
const productionSkipReason = productionInstallSkipReason();

if (process.env.HUSKY === "0") {
	skip("skipping because HUSKY=0");
} else if (envFlagEnabled(process.env.CI)) {
	skip("skipping because CI is set");
} else if (productionSkipReason) {
	skip(productionSkipReason);
} else if (!existsSync(join(cwd, ".git"))) {
	skip("skipping because .git is missing");
} else {
	const huskyPath = localHuskyPath(cwd);
	if (!existsSync(huskyPath)) {
		skip("skipping because local Husky binary is missing");
	} else {
		console.log("prepare-husky: installing local Husky hooks");
		const result = spawnSync(huskyPath, [], {
			cwd,
			env: process.env,
			shell: process.platform === "win32",
			stdio: "inherit",
		});

		if (result.error) throw result.error;
		if (result.signal) process.kill(process.pid, result.signal);
		process.exitCode = result.status ?? 0;
	}
}
