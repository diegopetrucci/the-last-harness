#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";

import { requiredValue } from "./lib/tlh-install-utils.mjs";

function usage() {
	return `Usage: node scripts/check-package-versions.mjs [options]

Validate that tracked package metadata versions stay in sync.

Options:
  --package <path>   package.json path (default: package.json)
  --lockfile <path>  package-lock.json path (default: package-lock.json)
  -h, --help         Show this help
`;
}

function parseArgs(argv) {
	const args = {
		packagePath: "package.json",
		lockfilePath: "package-lock.json",
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") {
			args.help = true;
			continue;
		}
		if (arg === "--package") {
			args.packagePath = requiredValue(argv, index + 1, arg);
			index += 1;
			continue;
		}
		if (arg === "--lockfile") {
			args.lockfilePath = requiredValue(argv, index + 1, arg);
			index += 1;
			continue;
		}
		if (arg.startsWith("--package=")) {
			args.packagePath = arg.slice("--package=".length);
			if (!args.packagePath) throw new Error("--package requires a value");
			continue;
		}
		if (arg.startsWith("--lockfile=")) {
			args.lockfilePath = arg.slice("--lockfile=".length);
			if (!args.lockfilePath) throw new Error("--lockfile requires a value");
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return args;
}

function readJsonFile(path) {
	let raw;
	try {
		raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	} catch (error) {
		throw new Error(`Unable to read ${path}: ${error.message}`);
	}

	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}: ${error.message}`);
	}
}

function readRequiredVersion(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Missing string version at ${label}`);
	}
	return value;
}

function versionEntries({ packagePath, lockfilePath }) {
	const packageJson = readJsonFile(packagePath);
	const packageLock = readJsonFile(lockfilePath);

	return [
		{
			label: `${packagePath}#version`,
			value: readRequiredVersion(packageJson.version, `${packagePath}#version`),
		},
		{
			label: `${lockfilePath}#version`,
			value: readRequiredVersion(packageLock.version, `${lockfilePath}#version`),
		},
		{
			label: `${lockfilePath}#packages[""].version`,
			value: readRequiredVersion(packageLock.packages?.[""]?.version, `${lockfilePath}#packages[""].version`),
		},
	];
}

function assertMatchingVersions(entries) {
	const distinctVersions = new Set(entries.map(({ value }) => value));
	if (distinctVersions.size <= 1) return entries[0].value;

	const details = entries
		.map(({ label, value }) => `  - ${label}: ${JSON.stringify(value)}`)
		.join("\n");
	throw new Error(`Version metadata mismatch:\n${details}`);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(usage());
		return;
	}

	const version = assertMatchingVersions(versionEntries(args));
	process.stdout.write(`check-package-versions: all tracked version fields match (${version}).\n`);
}

try {
	main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`check-package-versions: ${message}\n`);
	process.exitCode = 1;
}
