#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";

import { readDefaultExtensions } from "./lib/default-extensions.mjs";
import { parseGitSource } from "./lib/tlh-install-package-source.mjs";
import { requiredValue } from "./lib/tlh-install-utils.mjs";

const EXACT_VERSION_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VERSION_TOKEN_RE = /(?:^|[^0-9A-Za-z])((?:v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?))(?=$|[^0-9A-Za-z])/;
const COMMIT_SHA_GIT_REF_RE = /^[0-9a-f]{7,40}$/i;
const FLOATING_GIT_REF_RE = /^(?:head|latest|main|master|trunk|develop)$/i;
const BRANCH_LIKE_GIT_REF_RE = /^(?:feature|features|release|releases|hotfix|bugfix|fix|feat|chore|develop|dev)(?:$|[/-])/i;
const DEFAULT_GNOSIS_SCRIPT_PATHS = Object.freeze([
	"scripts/tlh-gnosis.mjs",
	"scripts/tlh-install.mjs",
]);
const DEFAULT_RTK_SCRIPT_PATHS = Object.freeze([
	"scripts/tlh-rtk.mjs",
]);
const ALLOWED_LOCAL_DEPENDENCY_PREFIXES = Object.freeze([
	"file:",
	"link:",
	"workspace:",
]);

function usage() {
	return `Usage: node scripts/check-package-versions.mjs [options]

Validate tracked version metadata and TLH-managed dependency pins.

Options:
  --package <path>             package.json path (default: package.json)
  --lockfile <path>            package-lock.json path (default: package-lock.json)
  --default-extensions <path>  Bundled default-extension manifest (default: config/default-extensions.json)
  --gnosis-script <path>       Managed Gnosis script to validate (repeatable; defaults: scripts/tlh-gnosis.mjs, scripts/tlh-install.mjs)
  --rtk-script <path>          Managed RTK script to validate (repeatable; default: scripts/tlh-rtk.mjs)
  -h, --help                   Show this help
`;
}

function parseArgs(argv) {
	const args = {
		packagePath: "package.json",
		lockfilePath: "package-lock.json",
		defaultExtensionsPath: "config/default-extensions.json",
		gnosisScriptPaths: [...DEFAULT_GNOSIS_SCRIPT_PATHS],
		rtkScriptPaths: [...DEFAULT_RTK_SCRIPT_PATHS],
		help: false,
	};
	let customGnosisScripts = false;
	let customRtkScripts = false;

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
		if (arg === "--default-extensions") {
			args.defaultExtensionsPath = requiredValue(argv, index + 1, arg);
			index += 1;
			continue;
		}
		if (arg === "--gnosis-script") {
			if (!customGnosisScripts) {
				args.gnosisScriptPaths = [];
				customGnosisScripts = true;
			}
			args.gnosisScriptPaths.push(requiredValue(argv, index + 1, arg));
			index += 1;
			continue;
		}
		if (arg === "--rtk-script") {
			if (!customRtkScripts) {
				args.rtkScriptPaths = [];
				customRtkScripts = true;
			}
			args.rtkScriptPaths.push(requiredValue(argv, index + 1, arg));
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
		if (arg.startsWith("--default-extensions=")) {
			args.defaultExtensionsPath = arg.slice("--default-extensions=".length);
			if (!args.defaultExtensionsPath) throw new Error("--default-extensions requires a value");
			continue;
		}
		if (arg.startsWith("--gnosis-script=")) {
			const value = arg.slice("--gnosis-script=".length);
			if (!value) throw new Error("--gnosis-script requires a value");
			if (!customGnosisScripts) {
				args.gnosisScriptPaths = [];
				customGnosisScripts = true;
			}
			args.gnosisScriptPaths.push(value);
			continue;
		}
		if (arg.startsWith("--rtk-script=")) {
			const value = arg.slice("--rtk-script=".length);
			if (!value) throw new Error("--rtk-script requires a value");
			if (!customRtkScripts) {
				args.rtkScriptPaths = [];
				customRtkScripts = true;
			}
			args.rtkScriptPaths.push(value);
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return args;
}

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readTextFile(path) {
	try {
		return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read ${path}: ${message}`, { cause: error });
	}
}

function readJsonFile(path) {
	const raw = readTextFile(path);

	try {
		return JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in ${path}: ${message}`, { cause: error });
	}
}

function readRequiredVersion(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Missing string version at ${label}`);
	}
	return value;
}

function versionEntries({ packagePath, lockfilePath }, packageJson, packageLock) {
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

function isPinnedExactVersion(value) {
	return EXACT_VERSION_RE.test(String(value ?? "").trim());
}

function splitNpmPackageSpec(spec) {
	const text = String(spec ?? "").trim().replace(/^npm:/, "").trim();
	if (!text) return { name: "", version: "" };
	if (text.startsWith("@")) {
		const secondAt = text.indexOf("@", 1);
		if (secondAt === -1) return { name: text, version: "" };
		return {
			name: text.slice(0, secondAt),
			version: text.slice(secondAt + 1),
		};
	}
	const separator = text.lastIndexOf("@");
	if (separator === -1) return { name: text, version: "" };
	return {
		name: text.slice(0, separator),
		version: text.slice(separator + 1),
	};
}

function extractExactVersionToken(value) {
	const match = String(value ?? "").match(VERSION_TOKEN_RE);
	return match?.[1] || "";
}

function hasAllowedLocalDependencyPrefix(spec) {
	const trimmed = String(spec ?? "").trim();
	return ALLOWED_LOCAL_DEPENDENCY_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function parseGithubDependencySpec(spec) {
	const trimmed = String(spec ?? "").trim();
	if (!trimmed.startsWith("github:")) return undefined;

	const source = trimmed.slice("github:".length).trim();
	if (!source) return undefined;
	const hashIndex = source.lastIndexOf("#");
	if (hashIndex < 0) return { repo: source, ref: "" };
	return {
		repo: source.slice(0, hashIndex).trim(),
		ref: source.slice(hashIndex + 1).trim(),
	};
}

function stripArchiveExtension(value) {
	return String(value ?? "").replace(/\.(?:tar\.gz|tgz|zip)$/i, "");
}

function isPinnedGitRef(ref) {
	const trimmed = String(ref ?? "").trim();
	if (!trimmed) return false;
	if (/^semver:/i.test(trimmed)) {
		return isPinnedExactVersion(trimmed.slice("semver:".length).trim());
	}
	if (/^refs\/tags\//i.test(trimmed)) {
		return isPinnedGitRef(trimmed.slice("refs/tags/".length));
	}
	if (/^refs\/heads\//i.test(trimmed) || /^heads\//i.test(trimmed)) return false;
	if (COMMIT_SHA_GIT_REF_RE.test(trimmed)) return true;
	if (trimmed.includes("/")) return false;
	if (FLOATING_GIT_REF_RE.test(trimmed) || BRANCH_LIKE_GIT_REF_RE.test(trimmed)) return false;
	return Boolean(extractExactVersionToken(trimmed));
}

function isPinnedGitLikeDependencySpec(spec) {
	const trimmed = String(spec ?? "").trim();
	const githubSpec = parseGithubDependencySpec(trimmed);
	if (githubSpec) {
		return Boolean(githubSpec.repo) && isPinnedGitRef(githubSpec.ref);
	}

	const normalized = trimmed.startsWith("git+") ? trimmed.slice(4) : trimmed;
	const gitSource = parseGitSource(normalized);
	return Boolean(gitSource) && isPinnedGitRef(gitSource.ref);
}

function isPinnedUrlDependencySpec(spec) {
	const trimmed = String(spec ?? "").trim();
	let parsed;
	try {
		parsed = new URL(trimmed);
	} catch {
		return false;
	}

	const pathname = decodeURIComponent(parsed.pathname || "");
	if (/\/releases\/latest(?:\/|$)/i.test(pathname)) return false;
	const segments = pathname.split("/").filter(Boolean);

	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index];
		if (segment === "download" && segments[index - 1] === "releases") {
			return isPinnedGitRef(stripArchiveExtension(segments[index + 1] || ""));
		}
		if (segment === "archive" || segment === "tarball" || segment === "zipball") {
			if (segments[index + 1] === "refs") {
				if (segments[index + 2] === "tags") {
					return isPinnedGitRef(stripArchiveExtension(segments[index + 3] || ""));
				}
				if (segments[index + 2] === "heads") {
					return false;
				}
				return false;
			}
			if (segments[index + 1]) {
				return isPinnedGitRef(stripArchiveExtension(segments[index + 1] || ""));
			}
		}
	}

	return Boolean(extractExactVersionToken(pathname));
}

function isPinnedDependencySpec(spec) {
	const trimmed = String(spec ?? "").trim();
	if (!trimmed) return false;
	if (isPinnedExactVersion(trimmed)) return true;
	if (trimmed.startsWith("npm:")) {
		const { name, version } = splitNpmPackageSpec(trimmed);
		return Boolean(name) && isPinnedExactVersion(version);
	}
	if (hasAllowedLocalDependencyPrefix(trimmed)) return true;
	if (trimmed.startsWith("http:") || trimmed.startsWith("https:")) {
		return isPinnedUrlDependencySpec(trimmed);
	}
	return isPinnedGitLikeDependencySpec(trimmed);
}

function validatePinnedDependencies(packageJson, packagePath, problems) {
	for (const field of ["dependencies", "devDependencies", "overrides"]) {
		const value = packageJson[field];
		if (value === undefined) continue;
		if (!isPlainObject(value)) {
			problems.push(`${packagePath}#${field} must be an object`);
			continue;
		}
		for (const [name, spec] of Object.entries(value)) {
			if (typeof spec !== "string" || spec.trim().length === 0) {
				problems.push(`Missing string dependency spec at ${packagePath}#${field}.${name}`);
				continue;
			}
			if (!isPinnedDependencySpec(spec)) {
				problems.push(`${packagePath}#${field}.${name} must use an exact version or pinned non-registry source, found ${JSON.stringify(spec)}`);
			}
		}
	}
}

function validateDefaultExtensionPins(defaultExtensionsPath, problems) {
	let defaultExtensions;
	try {
		defaultExtensions = readDefaultExtensions(defaultExtensionsPath);
	} catch (error) {
		problems.push(error.message);
		return;
	}

	for (const extension of defaultExtensions) {
		const label = `${defaultExtensionsPath}#${extension.id}.source`;
		if (extension.source.startsWith("npm:")) {
			const { name, version } = splitNpmPackageSpec(extension.source);
			if (!name || !isPinnedExactVersion(version)) {
				problems.push(`${label} must pin npm defaults to an exact version, found ${JSON.stringify(extension.source)}`);
			}
			continue;
		}

		const gitSource = parseGitSource(extension.source);
		if (!gitSource) {
			problems.push(`${label} must use a pinned npm or git source, found ${JSON.stringify(extension.source)}`);
			continue;
		}
		if (!gitSource.ref) {
			problems.push(`${label} must pin git defaults to an explicit ref, found ${JSON.stringify(extension.source)}`);
			continue;
		}
		if (!isPinnedGitRef(gitSource.ref)) {
			problems.push(`${label} must pin git defaults to a tag- or commit-like ref, found ${JSON.stringify(extension.source)}`);
		}
	}
}

function escapeRegex(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readDeclaredStringConstant(path, name) {
	const source = readTextFile(path);
	const pattern = new RegExp(`(?:^|\\n)const\\s+${escapeRegex(name)}\\s*=\\s*["']([^"'\\n]+)["'];`);
	const match = source.match(pattern);
	if (!match) {
		throw new Error(`Missing ${name} constant in ${path}`);
	}
	return match[1];
}

function validatePinnedManagedScriptDefaults(scriptPaths, constantName, label, problems) {
	const versions = [];
	for (const path of scriptPaths) {
		let version;
		try {
			version = readDeclaredStringConstant(path, constantName);
		} catch (error) {
			problems.push(error.message);
			continue;
		}
		versions.push({ path, version });
		if (!isPinnedExactVersion(version)) {
			problems.push(`${path}#${constantName} must use an exact version, found ${JSON.stringify(version)}`);
		}
	}

	const distinctVersions = new Set(versions.map(({ version }) => version));
	if (versions.length > 1 && distinctVersions.size > 1) {
		const details = versions
			.map(({ path, version }) => `  - ${path}: ${JSON.stringify(version)}`)
			.join("\n");
		problems.push(`${label} defaults must stay in sync:\n${details}`);
	}
}

function collectProblems(args) {
	const packageJson = readJsonFile(args.packagePath);
	const packageLock = readJsonFile(args.lockfilePath);
	const problems = [];
	const entries = versionEntries(args, packageJson, packageLock);
	let version = entries[0]?.value;

	try {
		version = assertMatchingVersions(entries);
	} catch (error) {
		problems.push(error.message);
	}

	validatePinnedDependencies(packageJson, args.packagePath, problems);
	validateDefaultExtensionPins(args.defaultExtensionsPath, problems);
	validatePinnedManagedScriptDefaults(args.gnosisScriptPaths, "DEFAULT_GNOSIS_VERSION", "Managed Gnosis", problems);
	validatePinnedManagedScriptDefaults(args.rtkScriptPaths, "DEFAULT_RTK_VERSION", "Managed RTK", problems);

	return { version, problems };
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(usage());
		return;
	}

	const { version, problems } = collectProblems(args);
	if (problems.length > 0) {
		throw new Error(problems.join("\n\n"));
	}

	process.stdout.write(`check-package-versions: all tracked version fields match (${version}), and managed dependency pins are valid.\n`);
}

try {
	main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`check-package-versions: ${message}\n`);
	process.exitCode = 1;
}
