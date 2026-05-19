#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_RUNS = 10;
const DEFAULT_CACHE_MODE = "both";
const DEFAULT_EXTENSION_ID = "context-cap";
const DEFAULT_CONTEXT_CAP_SOURCE = "npm:@diegopetrucci/pi-context-cap";
const EMBEDDED_RESOURCE_ROOT = "extensions/embedded";
const PI_RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes", "agents"];
const MAX_BUFFER = 100 * 1024 * 1024;
const VALID_CACHE_MODES = new Set(["cold", "warm", "both"]);

function usage() {
	return `Usage: benchmark-context-cap-embedding.mjs [options]\n\nCompare the current default-extension install path against a temporary The Last\nHarness package with a selected npm default extension embedded from its pi\nmanifest and removed from the default-extension manifest. The default target is\ncontext-cap. All install runs use temporary agent/bin/cache directories.\n\nOptions:\n  --runs N                    Timed runs per variant/cache mode (default: ${DEFAULT_RUNS})\n  --cache-mode MODE           cold, warm, or both (default: ${DEFAULT_CACHE_MODE})\n  --output-dir DIR            Result directory (default: a temporary directory)\n  --extension-id ID           Default-extension manifest id to embed (default: ${DEFAULT_EXTENSION_ID})\n  --extension-source SPEC     npm default source to embed; if omitted, resolved from --extension-id\n  --context-cap-source SPEC   Context-cap-only compatibility alias for the old package-source override\n  --keep-temp                 Keep temporary package/agent/bin/cache directories\n  --verbose-installer         Pass --verbose to installer runs instead of --quiet\n  -h, --help                  Show this help\n\nExamples:\n  benchmark-context-cap-embedding.mjs\n  benchmark-context-cap-embedding.mjs --extension-id plannotator\n  benchmark-context-cap-embedding.mjs --extension-id fff\n  benchmark-context-cap-embedding.mjs --extension-source npm:@ff-labs/pi-fff\n\nResults:\n  summary.txt                 Human-readable timings, validation, caveats, and exact command/env overrides\n  results.json                Machine-readable raw runs, package sizes, treatment validation, and caveats\n  logs/*.stdout.log           Per-run installer stdout\n  logs/*.stderr.log           Per-run installer stderr\n`;
}

function requiredValue(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
	return value;
}

function parsePositiveInteger(value, label) {
	if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
	return parsed;
}

function parseArgs(argv = process.argv.slice(2)) {
	const args = {
		runs: DEFAULT_RUNS,
		cacheMode: DEFAULT_CACHE_MODE,
		outputDir: "",
		extensionId: DEFAULT_EXTENSION_ID,
		extensionSource: "",
		embedSource: "",
		keepTemp: false,
		verboseInstaller: false,
		help: false,
	};
	let extensionIdProvided = false;
	let extensionSourceProvided = false;
	let embedSourceProvided = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") {
			args.help = true;
			continue;
		}
		if (arg === "--runs") {
			args.runs = parsePositiveInteger(requiredValue(argv, ++index, arg), "--runs");
			continue;
		}
		if (arg.startsWith("--runs=")) {
			args.runs = parsePositiveInteger(arg.slice("--runs=".length), "--runs");
			continue;
		}
		if (arg === "--cache-mode") {
			args.cacheMode = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--cache-mode=")) {
			args.cacheMode = arg.slice("--cache-mode=".length);
			continue;
		}
		if (arg === "--output-dir") {
			args.outputDir = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--output-dir=")) {
			args.outputDir = arg.slice("--output-dir=".length);
			continue;
		}
		if (arg === "--extension-id") {
			args.extensionId = requiredValue(argv, ++index, arg);
			extensionIdProvided = true;
			continue;
		}
		if (arg.startsWith("--extension-id=")) {
			args.extensionId = arg.slice("--extension-id=".length);
			extensionIdProvided = true;
			continue;
		}
		if (arg === "--extension-source") {
			args.extensionSource = requiredValue(argv, ++index, arg);
			extensionSourceProvided = true;
			continue;
		}
		if (arg.startsWith("--extension-source=")) {
			args.extensionSource = arg.slice("--extension-source=".length);
			extensionSourceProvided = true;
			continue;
		}
		if (arg === "--context-cap-source") {
			args.embedSource = requiredValue(argv, ++index, arg);
			embedSourceProvided = true;
			continue;
		}
		if (arg.startsWith("--context-cap-source=")) {
			args.embedSource = arg.slice("--context-cap-source=".length);
			embedSourceProvided = true;
			continue;
		}
		if (arg === "--keep-temp") {
			args.keepTemp = true;
			continue;
		}
		if (arg === "--verbose-installer") {
			args.verboseInstaller = true;
			continue;
		}
		throw new Error(`unknown option: ${arg}`);
	}

	if (!VALID_CACHE_MODES.has(args.cacheMode)) {
		throw new Error(`--cache-mode must be one of: ${[...VALID_CACHE_MODES].join(", ")}`);
	}
	args.extensionId = String(args.extensionId || "").trim();
	args.extensionSource = String(args.extensionSource || "").trim();
	args.embedSource = String(args.embedSource || "").trim();
	if (extensionIdProvided && !args.extensionId) throw new Error("--extension-id requires a non-empty value");
	if (extensionSourceProvided && !args.extensionSource) throw new Error("--extension-source requires a non-empty value");
	if (embedSourceProvided && !args.embedSource) throw new Error("--context-cap-source requires a non-empty value");
	if (!extensionIdProvided && extensionSourceProvided && !embedSourceProvided) {
		args.extensionId = "";
	}
	if (embedSourceProvided) {
		if (extensionIdProvided && args.extensionId !== DEFAULT_EXTENSION_ID) {
			throw new Error(`--context-cap-source can only be used with the ${DEFAULT_EXTENSION_ID} target`);
		}
		if (extensionSourceProvided && args.extensionSource !== DEFAULT_CONTEXT_CAP_SOURCE) {
			throw new Error(`--context-cap-source can only be used with the ${DEFAULT_EXTENSION_ID} target; --extension-source must be ${DEFAULT_CONTEXT_CAP_SOURCE}`);
		}
	}
	if (!args.extensionId && !args.extensionSource) {
		throw new Error("provide --extension-id, --extension-source, or use the default context-cap target");
	}
	return args;
}

function repoRootFromScript() {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function ensureDir(path) {
	mkdirSync(path, { recursive: true });
	return path;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeManifestPath(path, label = "pi resource path") {
	if (typeof path !== "string") throw new Error(`${label} must be a string`);
	let normalized = path.trim().replace(/\\/g, "/");
	if (!normalized) throw new Error(`${label} must be a non-empty path`);
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	if (normalized.startsWith("/") || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
		throw new Error(`${label} must be relative: ${path}`);
	}
	const parts = [];
	for (const part of normalized.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") throw new Error(`${label} must not traverse outside the package: ${path}`);
		parts.push(part);
	}
	return parts.join("/") || ".";
}

function posixRelativePath(path) {
	return normalizeManifestPath(path);
}

function packageSourceForRoot(root) {
	return root;
}

function commandExists(command, env = process.env) {
	const result = spawnSync("sh", ["-c", "command -v -- \"$1\"", "sh", command], {
		env,
		stdio: "ignore",
	});
	return !result.error && result.status === 0;
}

function requireCommand(command) {
	if (!commandExists(command)) throw new Error(`required command not found: ${command}`);
}

function scrubbedEnv(baseEnv, overrides = {}) {
	const env = {};
	for (const [key, value] of Object.entries(baseEnv)) {
		if (key === "PI_CODING_AGENT_DIR") continue;
		if (key === "PI_OFFLINE") continue;
		if (key.startsWith("TLH_")) continue;
		if (key.toLowerCase() === "npm_config_cache") continue;
		env[key] = value;
	}
	return { ...env, ...overrides };
}

function scrubbedEnvDescription(baseEnv, overrides = {}) {
	return {
		inheritsParentEnv: true,
		unsetIfPresent: ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "TLH_*", "NPM_CONFIG_CACHE", "npm_config_cache"],
		unset: Object.keys(baseEnv)
			.filter((key) => key === "PI_CODING_AGENT_DIR" || key === "PI_OFFLINE" || key.startsWith("TLH_") || key.toLowerCase() === "npm_config_cache")
			.sort(),
		set: { ...overrides },
	};
}

function npmEnv(cacheDir, baseEnv = process.env) {
	return scrubbedEnv(baseEnv, {
		NPM_CONFIG_CACHE: cacheDir,
		NPM_CONFIG_AUDIT: "false",
		NPM_CONFIG_FUND: "false",
		NPM_CONFIG_LOGLEVEL: "error",
		NPM_CONFIG_UPDATE_NOTIFIER: "false",
	});
}

function runCapture(command, args, { cwd, env = process.env, label = command } = {}) {
	const result = spawnSync(command, args, {
		cwd,
		env,
		encoding: "utf8",
		maxBuffer: MAX_BUFFER,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error || result.status !== 0) {
		const status = result.status ?? result.signal ?? result.error?.code ?? 1;
		const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
		throw new Error(`${label} failed (exit ${status})${output ? `\n${output}` : ""}`);
	}
	return result;
}

function copyPackageFiles(sourceRoot, targetRoot) {
	const packageJsonPath = join(sourceRoot, "package.json");
	const packageJson = readJson(packageJsonPath);
	const entries = new Set(["package.json", "LICENSE"]);
	for (const entry of packageJson.files || []) entries.add(entry);

	ensureDir(targetRoot);
	for (const entry of entries) {
		const source = join(sourceRoot, entry);
		if (!existsSync(source)) continue;
		const target = join(targetRoot, entry);
		ensureDir(dirname(target));
		cpSync(source, target, { recursive: true, force: true, errorOnExist: false });
	}
}

function defaultExtensionManifestPath(packageRoot) {
	return join(packageRoot, "config", "default-extensions.json");
}

function manifestEntrySummary(entry, index = null) {
	return {
		id: typeof entry?.id === "string" ? entry.id : "",
		source: typeof entry?.source === "string" ? entry.source : "",
		description: typeof entry?.description === "string" ? entry.description : "",
		aliases: Array.isArray(entry?.aliases) ? [...entry.aliases] : [],
		replaces: Array.isArray(entry?.replaces) ? [...entry.replaces] : [],
		migrateReplacements: Boolean(entry?.migrateReplacements),
		critical: Boolean(entry?.critical),
		manifestIndex: index,
	};
}

function targetMatchesEntry(entry, targetExtension) {
	return entry?.id === targetExtension.id && entry?.source === targetExtension.source;
}

function resolveDefaultExtensionTargetFromManifest(manifest, { extensionId = "", extensionSource = "" } = {}) {
	if (!Array.isArray(manifest)) throw new Error("default-extension manifest is not an array");
	const wantedId = String(extensionId || "").trim();
	const wantedSource = String(extensionSource || "").trim();
	if (!wantedId && !wantedSource) throw new Error("target default extension requires an id or source");

	const candidates = manifest
		.map((entry, index) => ({ entry, index }))
		.filter(({ entry }) => {
			if (wantedId && entry?.id !== wantedId) return false;
			if (wantedSource && entry?.source !== wantedSource) return false;
			return true;
		});

	if (candidates.length === 0) {
		const byId = wantedId ? manifest.find((entry) => entry?.id === wantedId) : null;
		const bySource = wantedSource ? manifest.find((entry) => entry?.source === wantedSource) : null;
		const details = [];
		if (wantedId) details.push(`id=${wantedId}`);
		if (wantedSource) details.push(`source=${wantedSource}`);
		if (byId) details.push(`manifest id match has source=${byId.source || "(missing)"}`);
		if (bySource) details.push(`manifest source match has id=${bySource.id || "(missing)"}`);
		throw new Error(`default-extension manifest does not contain a unique target for ${details.join(", ")}`);
	}
	if (candidates.length > 1) {
		const ids = candidates.map(({ entry, index }) => `${index}:${entry?.id || "(missing id)"}/${entry?.source || "(missing source)"}`);
		throw new Error(`default-extension target is ambiguous: ${ids.join(", ")}`);
	}

	const { entry, index } = candidates[0];
	const id = typeof entry?.id === "string" ? entry.id : "";
	const source = typeof entry?.source === "string" ? entry.source : "";
	if (!id) throw new Error(`selected default-extension entry at index ${index} is missing an id`);
	if (!source) throw new Error(`selected default-extension entry '${id}' is missing a source`);
	if (!source.startsWith("npm:")) {
		throw new Error(`selected default-extension entry '${id}' is not an npm source: ${source}`);
	}
	return {
		...manifestEntrySummary(entry, index),
		selectedBy: {
			id: Boolean(wantedId),
			source: Boolean(wantedSource),
		},
	};
}

function resolveDefaultExtensionTarget({ packageRoot, extensionId = "", extensionSource = "" }) {
	return resolveDefaultExtensionTargetFromManifest(readJson(defaultExtensionManifestPath(packageRoot)), { extensionId, extensionSource });
}

function removeDefaultExtension(packageRoot, targetExtension) {
	const manifestPath = defaultExtensionManifestPath(packageRoot);
	const manifest = readJson(manifestPath);
	if (!Array.isArray(manifest)) throw new Error(`default-extension manifest is not an array: ${manifestPath}`);

	const matches = manifest
		.map((entry, index) => ({ entry, index }))
		.filter(({ entry }) => targetMatchesEntry(entry, targetExtension));
	if (matches.length === 0) {
		throw new Error(`default-extension manifest does not contain '${targetExtension.id}' with source '${targetExtension.source}'`);
	}
	if (matches.length > 1) {
		throw new Error(`default-extension manifest contains duplicate '${targetExtension.id}' entries with source '${targetExtension.source}'`);
	}

	const [{ entry, index }] = matches;
	const filtered = manifest.filter((_, entryIndex) => entryIndex !== index);
	writeJson(manifestPath, filtered);
	return [entry];
}

function safeEmbedSegment(id) {
	const segment = String(id || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	if (!segment || segment === "." || segment === "..") throw new Error(`cannot derive an embedded resource directory from id: ${id}`);
	return segment;
}

function embeddedResourceDirForTarget(targetExtension) {
	return `${EMBEDDED_RESOURCE_ROOT}/${safeEmbedSegment(targetExtension.id)}`;
}

function embeddedPackagePath(embedDirRelative, resourcePath) {
	return resourcePath === "." ? `./${embedDirRelative}` : `./${embedDirRelative}/${resourcePath}`;
}

function piResourceEntries(packageJson, packageLabel = packageJson?.name || "selected package") {
	const resources = {};
	for (const key of PI_RESOURCE_KEYS) {
		const entries = packageJson?.pi?.[key];
		if (entries == null) continue;
		if (!Array.isArray(entries)) throw new Error(`${packageLabel} declares pi.${key}, but it is not an array`);
		const normalized = entries.map((entry, index) => normalizeManifestPath(entry, `${packageLabel} pi.${key}[${index}]`));
		if (normalized.length > 0) resources[key] = normalized;
	}
	if (Object.keys(resources).length === 0) {
		throw new Error(`${packageLabel} does not declare any supported pi resource paths (${PI_RESOURCE_KEYS.join(", ")})`);
	}
	return resources;
}

function objectKeys(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

function arrayValues(value) {
	return Array.isArray(value) ? value.map(String).sort() : [];
}

function dependencyCaveatsFromPackageJson(packageJson) {
	const dependencies = objectKeys(packageJson.dependencies);
	const optionalDependencies = objectKeys(packageJson.optionalDependencies);
	const peerDependencies = objectKeys(packageJson.peerDependencies);
	const bundledDependencies = [...new Set([
		...arrayValues(packageJson.bundleDependencies),
		...arrayValues(packageJson.bundledDependencies),
	])].sort();
	const installLifecycleScripts = ["preinstall", "install", "postinstall", "prepare"]
		.filter((scriptName) => typeof packageJson.scripts?.[scriptName] === "string");
	const hasRuntimeDependencies = dependencies.length > 0 || optionalDependencies.length > 0 || peerDependencies.length > 0;
	const notes = [];
	if (hasRuntimeDependencies) {
		notes.push("Treatment embeds declared pi resource paths only and does not merge the selected package dependencies into The Last Harness package; runtime equivalence is not guaranteed for dependency-heavy packages.");
	}
	if (bundledDependencies.length > 0) {
		notes.push("Selected package declares bundled dependencies; this harness copies the npm package tarball contents but does not independently validate bundled runtime behavior.");
	}
	if (installLifecycleScripts.length > 0) {
		notes.push("Selected package declares install lifecycle scripts; the treatment path does not run those scripts for the embedded package.");
	}
	if (notes.length === 0) {
		notes.push("Selected package declares no runtime dependencies or install lifecycle scripts that this harness can detect; treatment validation still covers packaging/install behavior, not full command runtime behavior.");
	}
	return {
		packageName: packageJson.name || "",
		packageVersion: packageJson.version || "",
		dependencies,
		optionalDependencies,
		peerDependencies,
		bundledDependencies,
		installLifecycleScripts,
		hasRuntimeDependencies,
		treatmentMergesDependencies: false,
		validatesRuntimeBehavior: false,
		notes,
	};
}

function appendEmbeddedResourcesToPackageJson(treatmentPackageJson, embeddedResources) {
	treatmentPackageJson.pi = treatmentPackageJson.pi || {};
	for (const [key, entries] of Object.entries(embeddedResources)) {
		treatmentPackageJson.pi[key] = Array.isArray(treatmentPackageJson.pi[key])
			? treatmentPackageJson.pi[key]
			: [];
		for (const embeddedPath of entries) {
			if (!treatmentPackageJson.pi[key].includes(embeddedPath)) {
				treatmentPackageJson.pi[key].push(embeddedPath);
			}
		}
	}
}

function embedDefaultPackage({ treatmentRoot, selectedPackageRoot, targetExtension }) {
	const selectedPackageJson = readJson(join(selectedPackageRoot, "package.json"));
	const sourceResources = piResourceEntries(selectedPackageJson);
	const embedDirRelative = embeddedResourceDirForTarget(targetExtension);
	const embedDir = join(treatmentRoot, embedDirRelative);
	ensureDir(dirname(embedDir));
	cpSync(selectedPackageRoot, embedDir, { recursive: true, force: true, errorOnExist: false });

	const embeddedResources = {};
	for (const [key, entries] of Object.entries(sourceResources)) {
		embeddedResources[key] = [];
		for (const entry of entries) {
			const absoluteEmbeddedPath = join(treatmentRoot, embedDirRelative, entry);
			if (!existsSync(absoluteEmbeddedPath)) {
				throw new Error(`${targetExtension.id} pi.${key} path is missing after embed: ${absoluteEmbeddedPath}`);
			}
			embeddedResources[key].push(embeddedPackagePath(embedDirRelative, entry));
		}
	}

	const packageJsonPath = join(treatmentRoot, "package.json");
	const treatmentPackageJson = readJson(packageJsonPath);
	appendEmbeddedResourcesToPackageJson(treatmentPackageJson, embeddedResources);
	writeJson(packageJsonPath, treatmentPackageJson);

	return {
		embedDir,
		embedDirRelative,
		embeddedResources,
		embeddedExtensions: embeddedResources.extensions || [],
		sourceResources,
		embeddedPackage: {
			name: selectedPackageJson.name || "",
			version: selectedPackageJson.version || "",
		},
		dependencyCaveats: dependencyCaveatsFromPackageJson(selectedPackageJson),
	};
}

function embedContextCapPackage({ treatmentRoot, contextCapPackageRoot }) {
	return embedDefaultPackage({
		treatmentRoot,
		selectedPackageRoot: contextCapPackageRoot,
		targetExtension: { id: DEFAULT_EXTENSION_ID, source: DEFAULT_CONTEXT_CAP_SOURCE },
	});
}

function materializeControlPackage({ sourceRoot, targetRoot }) {
	copyPackageFiles(sourceRoot, targetRoot);
	return { packageRoot: targetRoot };
}

function materializeTreatmentPackage({ sourceRoot, targetRoot, selectedPackageRoot, targetExtension, contextCapPackageRoot }) {
	const packageRoot = targetRoot;
	const packageToEmbed = selectedPackageRoot || contextCapPackageRoot;
	if (!packageToEmbed) throw new Error("materializeTreatmentPackage requires selectedPackageRoot");
	const resolvedTarget = targetExtension || resolveDefaultExtensionTarget({
		packageRoot: sourceRoot,
		extensionId: DEFAULT_EXTENSION_ID,
		extensionSource: DEFAULT_CONTEXT_CAP_SOURCE,
	});
	copyPackageFiles(sourceRoot, packageRoot);
	const removedDefaultExtensions = removeDefaultExtension(packageRoot, resolvedTarget);
	const embed = embedDefaultPackage({
		treatmentRoot: packageRoot,
		selectedPackageRoot: packageToEmbed,
		targetExtension: resolvedTarget,
	});
	return {
		packageRoot,
		targetExtension: resolvedTarget,
		removedDefaultExtensions,
		...embed,
	};
}

function listEmbeddedResources(packageJson, targetExtension) {
	const embedDirRelative = embeddedResourceDirForTarget(targetExtension);
	const prefix = `./${embedDirRelative}`;
	const resources = {};
	for (const key of PI_RESOURCE_KEYS) {
		const entries = Array.isArray(packageJson?.pi?.[key]) ? packageJson.pi[key] : [];
		const embedded = entries
			.filter((entry) => String(entry) === prefix || String(entry).startsWith(`${prefix}/`))
			.map(String);
		if (embedded.length > 0) resources[key] = embedded;
	}
	return resources;
}

function embeddedResourceExists(treatmentRoot, packagePath) {
	return existsSync(join(treatmentRoot, normalizeManifestPath(packagePath)));
}

function collectFiles(path, remaining = 200) {
	if (remaining <= 0 || !existsSync(path)) return [];
	const stats = statSync(path);
	if (stats.isFile()) return [path];
	if (!stats.isDirectory()) return [];
	const files = [];
	for (const entry of readdirSync(path)) {
		if (entry === "node_modules" || entry === ".git") continue;
		files.push(...collectFiles(join(path, entry), remaining - files.length));
		if (files.length >= remaining) break;
	}
	return files;
}

function resourceFilesContain(treatmentRoot, entries, pattern) {
	for (const entry of entries) {
		const resourcePath = join(treatmentRoot, normalizeManifestPath(entry));
		for (const file of collectFiles(resourcePath)) {
			let source = "";
			try {
				source = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			if (pattern.test(source)) return true;
		}
	}
	return false;
}

function validateTreatmentPackage(treatmentRoot, { targetExtension = { id: DEFAULT_EXTENSION_ID, source: DEFAULT_CONTEXT_CAP_SOURCE }, expectedEmbeddedResources = null } = {}) {
	const errors = [];
	const manifest = readJson(defaultExtensionManifestPath(treatmentRoot));
	const manifestHasTarget = Array.isArray(manifest) && manifest.some((entry) => targetMatchesEntry(entry, targetExtension));
	const manifestHasContextCap = Array.isArray(manifest) && manifest.some((entry) => entry?.id === DEFAULT_EXTENSION_ID);
	const targetIsContextCap = targetExtension.id === DEFAULT_EXTENSION_ID;
	if (manifestHasTarget) {
		errors.push(`${targetExtension.id} is still present in config/default-extensions.json with source ${targetExtension.source}`);
	}
	if (!targetIsContextCap && !manifestHasContextCap) {
		errors.push(`${DEFAULT_EXTENSION_ID} default extension is missing from config/default-extensions.json`);
	}

	const packageJson = readJson(join(treatmentRoot, "package.json"));
	const embeddedResources = listEmbeddedResources(packageJson, targetExtension);
	const expectedResources = expectedEmbeddedResources || embeddedResources;
	if (Object.keys(embeddedResources).length === 0) {
		errors.push(`package.json does not expose embedded ${targetExtension.id} pi resources`);
	}
	for (const [key, entries] of Object.entries(expectedResources)) {
		const actualEntries = embeddedResources[key] || [];
		for (const entry of entries) {
			if (!actualEntries.includes(entry)) {
				errors.push(`package.json pi.${key} does not expose expected embedded resource: ${entry}`);
				continue;
			}
			if (!embeddedResourceExists(treatmentRoot, entry)) {
				errors.push(`embedded pi.${key} path is missing: ${entry}`);
			}
		}
	}

	let registersContextCapCommand = null;
	if (targetExtension.id === DEFAULT_EXTENSION_ID) {
		registersContextCapCommand = resourceFilesContain(
			treatmentRoot,
			embeddedResources.extensions || [],
			/registerCommand\(\s*["'`]context-cap["'`]/,
		);
		if (!registersContextCapCommand) errors.push("embedded context-cap extension does not register /context-cap");
	}

	return {
		ok: errors.length === 0,
		errors,
		targetExtension: {
			id: targetExtension.id,
			source: targetExtension.source,
		},
		embeddedResources,
		embeddedExtensions: embeddedResources.extensions || [],
		manifestHasTarget,
		manifestHasContextCap,
		registersContextCapCommand,
	};
}

function normalizePackSpec(source) {
	const trimmed = source.trim();
	return trimmed.startsWith("npm:") ? trimmed.slice("npm:".length) : trimmed;
}

function npmPackageNameFromSource(source) {
	const sourceText = String(source || "").trim();
	if (!sourceText.startsWith("npm:")) return "";
	const packageSpec = sourceText.slice("npm:".length);
	let packageName = "";
	if (packageSpec.startsWith("@")) {
		const slashIndex = packageSpec.indexOf("/");
		if (slashIndex === -1) return "";
		const versionIndex = packageSpec.indexOf("@", slashIndex + 1);
		packageName = versionIndex === -1 ? packageSpec : packageSpec.slice(0, versionIndex);
	} else {
		const versionIndex = packageSpec.indexOf("@");
		packageName = versionIndex === -1 ? packageSpec : packageSpec.slice(0, versionIndex);
	}
	if (!/^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(packageName)) return "";
	return packageName.split("/").some((part) => part === "." || part === "..") ? "" : packageName;
}

function npmPackageJsonPathForSource(agentDir, source) {
	const packageName = npmPackageNameFromSource(source);
	if (!agentDir || !packageName) return "";
	return join(agentDir, "npm", "node_modules", ...packageName.split("/"), "package.json");
}

function downloadNpmPackage({ source, destinationDir, cacheDir, baseEnv = process.env }) {
	ensureDir(destinationDir);
	ensureDir(cacheDir);
	const packSpec = normalizePackSpec(source);
	const result = runCapture("npm", ["pack", packSpec, "--json", "--pack-destination", destinationDir], {
		env: npmEnv(cacheDir, baseEnv),
		label: `npm pack ${packSpec}`,
	});
	const parsed = JSON.parse(result.stdout);
	const [metadata] = parsed;
	if (!metadata?.filename) throw new Error(`npm pack did not report a filename for ${packSpec}`);
	const tarballPath = join(destinationDir, metadata.filename);
	const extractDir = join(destinationDir, "extract");
	ensureDir(extractDir);
	runCapture("tar", ["-xzf", tarballPath, "-C", extractDir], { label: `tar -xzf ${tarballPath}` });
	const packageRoot = join(extractDir, "package");
	if (!existsSync(join(packageRoot, "package.json"))) throw new Error(`extracted package.json not found: ${packageRoot}`);
	return { packageRoot, tarballPath, metadata };
}

function packageStats(packageRoot, { cacheDir, baseEnv = process.env }) {
	ensureDir(cacheDir);
	const result = runCapture("npm", ["pack", "--dry-run", "--json"], {
		cwd: packageRoot,
		env: npmEnv(cacheDir, baseEnv),
		label: `npm pack --dry-run ${packageRoot}`,
	});
	const parsed = JSON.parse(result.stdout);
	const [metadata] = parsed;
	if (!metadata) throw new Error(`npm pack --dry-run did not report package metadata for ${packageRoot}`);
	return {
		id: metadata.id || "",
		name: metadata.name || "",
		version: metadata.version || "",
		size: metadata.size ?? null,
		unpackedSize: metadata.unpackedSize ?? null,
		filename: metadata.filename || "",
		entryCount: metadata.entryCount ?? null,
		fileCount: Array.isArray(metadata.files) ? metadata.files.length : null,
	};
}

function buildInstallInvocation({ variant, agentDir, binDir, cacheDir, baseEnv = process.env, verboseInstaller = false }) {
	const packageSource = packageSourceForRoot(variant.packageRoot);
	const envOverrides = {
		TLH_PACKAGE_SOURCE: packageSource,
		NPM_CONFIG_CACHE: cacheDir,
		NPM_CONFIG_AUDIT: "false",
		NPM_CONFIG_FUND: "false",
		NPM_CONFIG_LOGLEVEL: "error",
		NPM_CONFIG_UPDATE_NOTIFIER: "false",
	};
	const command = [
		"bash",
		"install.sh",
		"--track",
		"custom",
		"--agent-dir",
		agentDir,
		"--bin-dir",
		binDir,
		"--without-gnosis",
		"--no-wrapper",
		"--no-pi-install",
		verboseInstaller ? "--verbose" : "--quiet",
	];

	return {
		cwd: variant.installerRoot,
		command,
		env: scrubbedEnv(baseEnv, envOverrides),
		envDescription: scrubbedEnvDescription(baseEnv, envOverrides),
		packageSource,
	};
}

function packageSourceOf(entry) {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && typeof entry.source === "string") return entry.source;
	return "";
}

function installedNpmPackageStatus({ agentDir, source }) {
	const packageName = npmPackageNameFromSource(source);
	const packageJsonPath = packageName ? npmPackageJsonPathForSource(agentDir, source) : "";
	const status = {
		packageName,
		packageJsonPath,
		packageInstalled: false,
		packageVersion: "",
		installedPackageName: "",
		parseError: "",
	};
	if (!packageJsonPath || !existsSync(packageJsonPath)) return status;
	status.packageInstalled = true;
	try {
		const packageJson = readJson(packageJsonPath);
		status.packageVersion = packageJson.version || "";
		status.installedPackageName = packageJson.name || "";
	} catch (error) {
		status.parseError = error.message;
	}
	return status;
}

function addExpectedNpmPackageErrors(validation, { variantName, id, source, sourcePresent, status }) {
	if (!sourcePresent) {
		validation.errors.push(`${variantName} settings do not include the npm ${id} default source`);
	}
	if (!status.packageName) {
		validation.errors.push(`${variantName} ${id} source is not an npm package source: ${source}`);
		return;
	}
	if (!status.packageJsonPath) {
		validation.errors.push(`${variantName} agent dir is missing for npm ${id} package validation`);
		return;
	}
	if (!status.packageInstalled) {
		validation.errors.push(`${variantName} npm ${id} package was not installed: ${status.packageJsonPath}`);
		return;
	}
	if (status.parseError) {
		validation.errors.push(`${variantName} npm ${id} package.json could not be parsed: ${status.parseError}`);
		return;
	}
	if (status.installedPackageName !== status.packageName) {
		validation.errors.push(`${variantName} npm ${id} package name mismatch: expected ${status.packageName}, found ${status.installedPackageName || "(missing)"}`);
	}
}

function validateRunSettings({ settingsPath, agentDir = "", variantName, targetSource, targetId = "", contextCapSource, packageSource }) {
	const contextCapDefaultSource = String(contextCapSource || DEFAULT_CONTEXT_CAP_SOURCE).trim() || DEFAULT_CONTEXT_CAP_SOURCE;
	const selectedSource = String(targetSource || contextCapDefaultSource).trim();
	const selectedId = targetId || (selectedSource === contextCapDefaultSource ? DEFAULT_EXTENSION_ID : "selected extension");
	const targetStatus = installedNpmPackageStatus({ agentDir, source: selectedSource });
	const contextCapStatus = installedNpmPackageStatus({ agentDir, source: contextCapDefaultSource });
	const validation = {
		settingsPath,
		settingsExists: existsSync(settingsPath),
		packageSourcePresent: false,
		targetExtensionId: selectedId,
		targetExtensionSource: selectedSource,
		targetDefaultSourcePresent: false,
		targetDefaultPackageName: targetStatus.packageName,
		targetDefaultPackageJsonPath: targetStatus.packageJsonPath,
		targetDefaultPackageInstalled: targetStatus.packageInstalled,
		targetDefaultPackageVersion: targetStatus.packageVersion,
		contextCapDefaultSource: contextCapDefaultSource,
		contextCapDefaultSourcePresent: false,
		contextCapDefaultPackageName: contextCapStatus.packageName,
		contextCapDefaultPackageJsonPath: contextCapStatus.packageJsonPath,
		contextCapDefaultPackageInstalled: contextCapStatus.packageInstalled,
		contextCapDefaultPackageVersion: contextCapStatus.packageVersion,
		ok: false,
		errors: [],
	};
	if (!validation.settingsExists) {
		validation.errors.push("settings.json was not written");
		return validation;
	}

	let settings;
	try {
		settings = readJson(settingsPath);
	} catch (error) {
		validation.errors.push(`settings.json could not be parsed: ${error.message}`);
		return validation;
	}
	const sources = Array.isArray(settings.packages) ? settings.packages.map(packageSourceOf).filter(Boolean) : [];
	const targetIsContextCap = selectedSource === contextCapDefaultSource;
	validation.packageSources = sources;
	validation.packageSourcePresent = sources.includes(packageSource);
	validation.targetDefaultSourcePresent = sources.includes(selectedSource);
	validation.contextCapDefaultSourcePresent = sources.includes(contextCapDefaultSource);
	if (!validation.packageSourcePresent) validation.errors.push("TLH package source is missing from settings.packages");
	if (variantName === "control") {
		addExpectedNpmPackageErrors(validation, {
			variantName,
			id: selectedId,
			source: selectedSource,
			sourcePresent: validation.targetDefaultSourcePresent,
			status: targetStatus,
		});
		if (!targetIsContextCap) {
			addExpectedNpmPackageErrors(validation, {
				variantName,
				id: DEFAULT_EXTENSION_ID,
				source: contextCapDefaultSource,
				sourcePresent: validation.contextCapDefaultSourcePresent,
				status: contextCapStatus,
			});
		}
	}
	if (variantName === "treatment") {
		if (validation.targetDefaultSourcePresent) {
			validation.errors.push(`treatment settings still include the npm ${selectedId} default source`);
		}
		if (!targetIsContextCap) {
			addExpectedNpmPackageErrors(validation, {
				variantName,
				id: DEFAULT_EXTENSION_ID,
				source: contextCapDefaultSource,
				sourcePresent: validation.contextCapDefaultSourcePresent,
				status: contextCapStatus,
			});
		}
	}
	validation.ok = validation.errors.length === 0;
	return validation;
}

function writeRunLogs({ outputDir, runId, stdout, stderr }) {
	const logDir = ensureDir(join(outputDir, "logs"));
	const stdoutPath = join(logDir, `${runId}.stdout.log`);
	const stderrPath = join(logDir, `${runId}.stderr.log`);
	writeFileSync(stdoutPath, stdout || "");
	writeFileSync(stderrPath, stderr || "");
	return { stdoutPath, stderrPath };
}

function runInstall({ runId, phase, cacheMode, variant, runIndex, agentDir, binDir, cacheDir, outputDir, targetExtension, baseEnv, verboseInstaller }) {
	ensureDir(dirname(agentDir));
	ensureDir(dirname(binDir));
	ensureDir(cacheDir);
	const invocation = buildInstallInvocation({ variant, agentDir, binDir, cacheDir, baseEnv, verboseInstaller });

	const startedAt = new Date().toISOString();
	const start = process.hrtime.bigint();
	const result = spawnSync(invocation.command[0], invocation.command.slice(1), {
		cwd: invocation.cwd,
		env: invocation.env,
		encoding: "utf8",
		maxBuffer: MAX_BUFFER,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const end = process.hrtime.bigint();
	const completedAt = new Date().toISOString();
	const durationMs = Number(end - start) / 1_000_000;
	const status = result.status ?? null;
	const signal = result.signal ?? null;
	const error = result.error?.message || "";
	const logs = writeRunLogs({ outputDir, runId, stdout: result.stdout || "", stderr: result.stderr || error });
	const validation = validateRunSettings({
		settingsPath: join(agentDir, "settings.json"),
		agentDir,
		variantName: variant.name,
		targetSource: targetExtension.source,
		targetId: targetExtension.id,
		packageSource: invocation.packageSource,
	});

	const commandOk = !result.error && status === 0;
	return {
		runId,
		phase,
		cacheMode,
		variant: variant.name,
		runIndex,
		startedAt,
		completedAt,
		durationMs,
		status,
		signal,
		error,
		commandOk,
		ok: commandOk && validation.ok,
		agentDir,
		binDir,
		cacheDir,
		cwd: invocation.cwd,
		command: invocation.command,
		env: invocation.envDescription,
		packageSource: invocation.packageSource,
		logs,
		validation,
	};
}

function selectedCacheModes(cacheMode) {
	return cacheMode === "both" ? ["cold", "warm"] : [cacheMode];
}

function median(values) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[middle];
	return (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundMs(value) {
	return value == null ? null : Math.round(value * 100) / 100;
}

function summarizeRuns(runs) {
	const summary = {};
	for (const run of runs.filter((entry) => entry.phase === "timed")) {
		summary[run.cacheMode] = summary[run.cacheMode] || {};
		const group = summary[run.cacheMode][run.variant] || {
			totalRuns: 0,
			succeeded: 0,
			failed: 0,
			durationsMs: [],
		};
		group.totalRuns += 1;
		if (run.ok) {
			group.succeeded += 1;
			group.durationsMs.push(run.durationMs);
		} else {
			group.failed += 1;
		}
		summary[run.cacheMode][run.variant] = group;
	}

	for (const variants of Object.values(summary)) {
		for (const group of Object.values(variants)) {
			const durations = group.durationsMs;
			group.meanMs = durations.length === 0 ? null : roundMs(durations.reduce((sum, value) => sum + value, 0) / durations.length);
			group.medianMs = roundMs(median(durations));
			group.minMs = durations.length === 0 ? null : roundMs(Math.min(...durations));
			group.maxMs = durations.length === 0 ? null : roundMs(Math.max(...durations));
			delete group.durationsMs;
		}
	}
	return summary;
}

function packageSizeDelta(control, treatment) {
	return {
		sizeBytes: typeof control.size === "number" && typeof treatment.size === "number" ? treatment.size - control.size : null,
		unpackedSizeBytes: typeof control.unpackedSize === "number" && typeof treatment.unpackedSize === "number"
			? treatment.unpackedSize - control.unpackedSize
			: null,
		entryCount: typeof control.entryCount === "number" && typeof treatment.entryCount === "number" ? treatment.entryCount - control.entryCount : null,
		fileCount: typeof control.fileCount === "number" && typeof treatment.fileCount === "number" ? treatment.fileCount - control.fileCount : null,
	};
}

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellWord(value) {
	const text = String(value);
	if (/^[A-Za-z0-9_/:.,@%+=-]+$/.test(text)) return text;
	return shellQuote(text);
}

function formatCommand(run) {
	const envSet = Object.entries(run.env.set)
		.map(([key, value]) => `${key}=${shellWord(value)}`)
		.join(" ");
	const unsetIfPresent = (run.env.unsetIfPresent || []).join(", ") || "(none)";
	const unset = run.env.unset.length > 0 ? run.env.unset.join(", ") : "(none present)";
	return [
		`${run.phase}/${run.cacheMode}/${run.variant} #${run.runIndex}`,
		`  cwd: ${run.cwd}`,
		`  inherits parent env: ${run.env.inheritsParentEnv ? "yes" : "no"}`,
		`  unset if present: ${unsetIfPresent}`,
		`  unset present in parent: ${unset}`,
		`  set: ${envSet}`,
		`  command: ${run.command.map(shellWord).join(" ")}`,
	].join("\n");
}

function formatResourceList(resources, key) {
	return (resources?.[key] || []).join(", ") || "(none)";
}

function formatSummary(results) {
	const lines = [];
	lines.push("Default-extension embedding benchmark");
	lines.push(`Started: ${results.startedAt}`);
	lines.push(`Completed: ${results.completedAt || "(in progress)"}`);
	lines.push(`Output directory: ${results.outputDir}`);
	lines.push(`Temporary work root: ${results.workRoot}${results.keepTemp ? " (kept)" : " (removed after run)"}`);
	lines.push(`Runs per variant/cache mode: ${results.options.runs}`);
	lines.push(`Cache mode: ${results.options.cacheMode}`);
	lines.push(`Target default extension: ${results.targetExtension?.id || results.options.extensionId || "(unknown)"}`);
	lines.push(`Embedded package source: ${results.embeddedPackageSource || results.targetExtension?.source || results.options.extensionSource || "(unknown)"}`);
	lines.push(`Removed default-extension source: ${results.removedDefaultExtension?.source || results.targetExtension?.source || "(unknown)"}`);
	lines.push("");
	lines.push("Variants:");
	for (const variant of results.variants) {
		lines.push(`  ${variant.name}: ${variant.description}`);
		lines.push(`    package root: ${variant.packageRoot}`);
	}
	lines.push("");
	lines.push("Treatment validation:");
	lines.push(`  ok: ${results.treatment.validation?.ok}`);
	lines.push(`  embedded extensions: ${formatResourceList(results.treatment.validation?.embeddedResources, "extensions")}`);
	lines.push(`  embedded skills: ${formatResourceList(results.treatment.validation?.embeddedResources, "skills")}`);
	lines.push(`  embedded prompts: ${formatResourceList(results.treatment.validation?.embeddedResources, "prompts")}`);
	lines.push(`  embedded themes: ${formatResourceList(results.treatment.validation?.embeddedResources, "themes")}`);
	if (results.treatment.validation?.registersContextCapCommand != null) {
		lines.push(`  registers /context-cap: ${results.treatment.validation.registersContextCapCommand}`);
	}
	if (results.treatment.validation?.errors?.length > 0) {
		for (const error of results.treatment.validation.errors) lines.push(`  error: ${error}`);
	}
	lines.push("");
	lines.push("Dependency/runtime caveats:");
	const caveats = results.treatment.dependencyCaveats;
	if (caveats) {
		lines.push(`  selected package: ${caveats.packageName || "(unknown)"}@${caveats.packageVersion || "(unknown)"}`);
		lines.push(`  dependencies: ${caveats.dependencies.join(", ") || "(none)"}`);
		lines.push(`  optional dependencies: ${caveats.optionalDependencies.join(", ") || "(none)"}`);
		lines.push(`  peer dependencies: ${caveats.peerDependencies.join(", ") || "(none)"}`);
		lines.push(`  install lifecycle scripts: ${caveats.installLifecycleScripts.join(", ") || "(none)"}`);
		for (const note of caveats.notes) lines.push(`  caveat: ${note}`);
	} else {
		lines.push("  (not recorded)");
	}
	lines.push("");
	lines.push("Package size (npm pack --dry-run):");
	lines.push(`  control:   packed=${results.packageStats.control.size} bytes, unpacked=${results.packageStats.control.unpackedSize} bytes, entries=${results.packageStats.control.entryCount}`);
	lines.push(`  treatment: packed=${results.packageStats.treatment.size} bytes, unpacked=${results.packageStats.treatment.unpackedSize} bytes, entries=${results.packageStats.treatment.entryCount}`);
	lines.push(`  delta:     packed=${results.packageStats.delta.sizeBytes} bytes, unpacked=${results.packageStats.delta.unpackedSizeBytes} bytes, entries=${results.packageStats.delta.entryCount}`);
	lines.push("");
	lines.push("Timed install summary (successful runs only for durations):");
	for (const cacheMode of Object.keys(results.summary)) {
		lines.push(`  ${cacheMode}:`);
		for (const [variant, group] of Object.entries(results.summary[cacheMode])) {
			lines.push(`    ${variant}: ok=${group.succeeded}/${group.totalRuns}, failed=${group.failed}, median=${group.medianMs ?? "n/a"} ms, mean=${group.meanMs ?? "n/a"} ms, min=${group.minMs ?? "n/a"} ms, max=${group.maxMs ?? "n/a"} ms`);
		}
	}
	lines.push("");
	lines.push("Exact install commands and env overrides:");
	for (const run of results.runs) lines.push(formatCommand(run));
	lines.push("");
	lines.push(`Machine-readable results: ${join(results.outputDir, "results.json")}`);
	lines.push(`Per-run logs: ${join(results.outputDir, "logs")}`);
	return `${lines.join("\n")}\n`;
}

function writeResults(results) {
	ensureDir(results.outputDir);
	writeJson(join(results.outputDir, "results.json"), results);
	writeFileSync(join(results.outputDir, "summary.txt"), formatSummary(results));
}

function hasRunFailures(results) {
	return results.runs.some((run) => !run.ok);
}

function prepareBenchmark({ options, repoRoot, workRoot, baseEnv = process.env }) {
	requireCommand("bash");
	requireCommand("git");
	requireCommand("npm");
	requireCommand("pi");
	requireCommand("tar");

	const targetExtension = resolveDefaultExtensionTarget({
		packageRoot: repoRoot,
		extensionId: options.extensionId,
		extensionSource: options.extensionSource,
	});
	if (String(options.embedSource || "").trim() && targetExtension.id !== DEFAULT_EXTENSION_ID) {
		throw new Error(`--context-cap-source can only be used with the ${DEFAULT_EXTENSION_ID} target`);
	}
	const packageRoot = ensureDir(join(workRoot, "packages"));
	const controlRoot = join(packageRoot, "control");
	const treatmentRoot = join(packageRoot, "treatment");
	const embeddedPackageSource = options.embedSource || targetExtension.source;
	const downloadDir = ensureDir(join(workRoot, `${safeEmbedSegment(targetExtension.id)}-package`));
	const selectedPackageDownload = downloadNpmPackage({
		source: embeddedPackageSource,
		destinationDir: downloadDir,
		cacheDir: join(workRoot, "cache", `${safeEmbedSegment(targetExtension.id)}-pack`),
		baseEnv,
	});

	materializeControlPackage({ sourceRoot: repoRoot, targetRoot: controlRoot });
	const treatment = materializeTreatmentPackage({
		sourceRoot: repoRoot,
		targetRoot: treatmentRoot,
		selectedPackageRoot: selectedPackageDownload.packageRoot,
		targetExtension,
	});
	const treatmentValidation = validateTreatmentPackage(treatmentRoot, {
		targetExtension,
		expectedEmbeddedResources: treatment.embeddedResources,
	});
	if (!treatmentValidation.ok) {
		throw new Error(`treatment package validation failed: ${treatmentValidation.errors.join("; ")}`);
	}

	const packStats = {
		control: packageStats(controlRoot, { cacheDir: join(workRoot, "cache", "pack-stats-control"), baseEnv }),
		treatment: packageStats(treatmentRoot, { cacheDir: join(workRoot, "cache", "pack-stats-treatment"), baseEnv }),
	};
	packStats.delta = packageSizeDelta(packStats.control, packStats.treatment);

	return {
		targetExtension,
		embeddedPackageSource,
		selectedPackageDownload,
		controlRoot,
		treatmentRoot,
		treatment: {
			...treatment,
			validation: treatmentValidation,
		},
		packageStats: packStats,
		variants: [
			{
				name: "control",
				description: `current default-extension manifest; ${targetExtension.id} installed from npm`,
				installerRoot: controlRoot,
				packageRoot: controlRoot,
			},
			{
				name: "treatment",
				description: `temporary package with ${targetExtension.id} embedded and removed from the default-extension manifest`,
				installerRoot: treatmentRoot,
				packageRoot: treatmentRoot,
			},
		],
	};
}

function runBenchmark(parsedOptions, { repoRoot = repoRootFromScript(), baseEnv = process.env } = {}) {
	const outputDir = parsedOptions.outputDir
		? resolve(parsedOptions.outputDir)
		: mkdtempSync(join(tmpdir(), "tlh-default-extension-benchmark-output-"));
	ensureDir(outputDir);
	const workRoot = mkdtempSync(join(tmpdir(), "tlh-default-extension-benchmark-work-"));
	const results = {
		schemaVersion: 2,
		startedAt: new Date().toISOString(),
		completedAt: "",
		repoRoot,
		outputDir,
		workRoot,
		keepTemp: parsedOptions.keepTemp,
		options: { ...parsedOptions, outputDir },
		targetExtension: {
			requestedId: parsedOptions.extensionId,
			requestedSource: parsedOptions.extensionSource,
			id: "",
			source: "",
		},
		embeddedPackageSource: parsedOptions.embedSource || "",
		removedDefaultExtension: {},
		selectedPackageDownload: {},
		treatment: {},
		packageStats: {},
		variants: [],
		runs: [],
		summary: {},
	};

	try {
		const prepared = prepareBenchmark({ options: parsedOptions, repoRoot, workRoot, baseEnv });
		const removedDefaultExtension = prepared.treatment.removedDefaultExtensions[0] || {};
		results.targetExtension = {
			requestedId: parsedOptions.extensionId,
			requestedSource: parsedOptions.extensionSource,
			...prepared.targetExtension,
		};
		results.embeddedPackageSource = prepared.embeddedPackageSource;
		results.removedDefaultExtension = manifestEntrySummary(removedDefaultExtension, prepared.targetExtension.manifestIndex);
		results.selectedPackageDownload = {
			metadata: prepared.selectedPackageDownload.metadata,
			tarballPath: prepared.selectedPackageDownload.tarballPath,
			packageRoot: prepared.selectedPackageDownload.packageRoot,
		};
		results.treatment = prepared.treatment;
		results.packageStats = prepared.packageStats;
		results.variants = prepared.variants.map(({ name, description, packageRoot, installerRoot }) => ({
			name,
			description,
			packageRoot,
			installerRoot,
		}));

		const cacheModes = selectedCacheModes(parsedOptions.cacheMode);
		const warmCacheDir = join(workRoot, "cache", "warm-npm");
		if (cacheModes.includes("warm")) {
			for (const variant of prepared.variants) {
				const runId = `warmup-${variant.name}`;
				const run = runInstall({
					runId,
					phase: "warmup",
					cacheMode: "warm",
					variant,
					runIndex: 0,
					agentDir: join(workRoot, "warmup", variant.name, "agent"),
					binDir: join(workRoot, "warmup", variant.name, "bin"),
					cacheDir: warmCacheDir,
					outputDir,
					targetExtension: prepared.targetExtension,
					baseEnv,
					verboseInstaller: parsedOptions.verboseInstaller,
				});
				results.runs.push(run);
				results.summary = summarizeRuns(results.runs);
				writeResults(results);
			}
		}

		for (const cacheMode of cacheModes) {
			for (let runIndex = 1; runIndex <= parsedOptions.runs; runIndex += 1) {
				const orderedVariants = runIndex % 2 === 1 ? prepared.variants : [...prepared.variants].reverse();
				for (const variant of orderedVariants) {
					const runId = `${cacheMode}-${variant.name}-${String(runIndex).padStart(2, "0")}`;
					const cacheDir = cacheMode === "warm"
						? warmCacheDir
						: join(workRoot, "cache", "cold", variant.name, String(runIndex));
					const run = runInstall({
						runId,
						phase: "timed",
						cacheMode,
						variant,
						runIndex,
						agentDir: join(workRoot, "runs", cacheMode, variant.name, String(runIndex), "agent"),
						binDir: join(workRoot, "runs", cacheMode, variant.name, String(runIndex), "bin"),
						cacheDir,
						outputDir,
						targetExtension: prepared.targetExtension,
						baseEnv,
						verboseInstaller: parsedOptions.verboseInstaller,
					});
					results.runs.push(run);
					results.summary = summarizeRuns(results.runs);
					writeResults(results);
				}
			}
		}

		results.completedAt = new Date().toISOString();
		results.summary = summarizeRuns(results.runs);
		writeResults(results);
		return results;
	} finally {
		if (!parsedOptions.keepTemp) rmSync(workRoot, { recursive: true, force: true });
	}
}

function isMainModule() {
	if (!process.argv[1]) return false;
	try {
		return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
	} catch {
		return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
	}
}

if (isMainModule()) {
	try {
		const options = parseArgs();
		if (options.help) {
			process.stdout.write(usage());
		} else {
			const results = runBenchmark(options);
			process.stdout.write(formatSummary(results));
			if (hasRunFailures(results)) process.exitCode = 1;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`error: ${message}`);
		process.exitCode = 1;
	}
}

export {
	DEFAULT_CONTEXT_CAP_SOURCE,
	DEFAULT_EXTENSION_ID,
	buildInstallInvocation,
	embedContextCapPackage,
	embedDefaultPackage,
	formatSummary,
	materializeControlPackage,
	materializeTreatmentPackage,
	parseArgs,
	resolveDefaultExtensionTarget,
	resolveDefaultExtensionTargetFromManifest,
	runBenchmark,
	scrubbedEnv,
	scrubbedEnvDescription,
	summarizeRuns,
	validateRunSettings,
	validateTreatmentPackage,
};
