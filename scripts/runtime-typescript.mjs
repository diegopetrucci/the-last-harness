#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir as systemTmpDir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VALID_MODES = new Set(["build", "check", "typecheck"]);
const VALID_TARGET_IDS = new Set(["scripts", "extensions"]);

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(__dirname, "..");

function resolveOverridePath(value, fallback) {
	return value ? resolve(value) : fallback;
}

function resolveConfiguredTargets(repoRoot) {
	const configuredTargetIds = (process.env.TLH_RUNTIME_TYPESCRIPT_TARGETS ?? "scripts,extensions")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);

	if (configuredTargetIds.length === 0) {
		throw new Error("TLH_RUNTIME_TYPESCRIPT_TARGETS must include at least one of: scripts, extensions.");
	}

	const invalidTargetIds = configuredTargetIds.filter((value) => !VALID_TARGET_IDS.has(value));
	if (invalidTargetIds.length > 0) {
		throw new Error(`Unknown runtime TypeScript target(s): ${invalidTargetIds.join(", ")}`);
	}

	const uniqueTargetIds = [...new Set(configuredTargetIds)];
	return uniqueTargetIds.map((targetId) => {
		if (targetId === "scripts") {
			return {
				id: "scripts",
				label: "scripts/**/*.mts",
				sourceDir: realpathSync(resolveOverridePath(process.env.TLH_RUNTIME_TYPESCRIPT_SCRIPTS_DIR, join(repoRoot, "scripts"))),
				tsconfigPath: realpathSync(
					resolveOverridePath(
						process.env.TLH_RUNTIME_TYPESCRIPT_SCRIPTS_TSCONFIG ?? process.env.TLH_RUNTIME_TYPESCRIPT_TSCONFIG,
						join(repoRoot, "tsconfig.runtime-scripts.json"),
					),
				),
				sourceExtension: ".mts",
				outputExtension: ".mjs",
			};
		}

		return {
			id: "extensions",
			label: "extensions/**/*.ts",
			sourceDir: realpathSync(resolveOverridePath(process.env.TLH_RUNTIME_TYPESCRIPT_EXTENSIONS_DIR, join(repoRoot, "extensions"))),
			tsconfigPath: realpathSync(
				resolveOverridePath(process.env.TLH_RUNTIME_TYPESCRIPT_EXTENSIONS_TSCONFIG, join(repoRoot, "tsconfig.runtime-extensions.json")),
			),
			sourceExtension: ".ts",
			outputExtension: ".js",
		};
	});
}

function normalizeRepoRelativePath(path) {
	return path.replaceAll("\\", "/");
}

function loadGeneratedOutputRegistry(repoRoot) {
	const registryPath = join(repoRoot, ".gitattributes");
	if (!existsSync(registryPath)) {
		throw new Error(`Missing generated output registry: ${relativeRepoPath(registryPath, repoRoot)}`);
	}

	return new Set(
		readFileSync(registryPath, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#") && line.includes("linguist-generated=true"))
			.map((line) => normalizeRepoRelativePath(line.split(/\s+/)[0])),
	);
}

function loadConfig() {
	const repoRoot = realpathSync(resolveOverridePath(process.env.TLH_RUNTIME_TYPESCRIPT_REPO_ROOT, defaultRepoRoot));
	return {
		repoRoot,
		tempParentDir: realpathSync(resolveOverridePath(process.env.TLH_RUNTIME_TYPESCRIPT_TMPDIR, systemTmpDir())),
		targets: resolveConfiguredTargets(repoRoot),
		generatedOutputRegistry: loadGeneratedOutputRegistry(repoRoot),
	};
}

function usage() {
	console.error("Usage: node scripts/runtime-typescript.mjs <build|check|typecheck>");
}

function listRuntimeTypescriptSources(dir, sourceExtension) {
	const entries = readdirSync(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const entryPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listRuntimeTypescriptSources(entryPath, sourceExtension));
			continue;
		}
		if (entry.name.endsWith(sourceExtension) && !entry.name.endsWith(`.d${sourceExtension}`)) {
			files.push(entryPath);
		}
	}
	return files.sort();
}

function runtimeOutputPathForSource(sourcePath, sourceExtension, outputExtension) {
	return `${sourcePath.slice(0, -sourceExtension.length)}${outputExtension}`;
}

function relativeRepoPath(path, repoRoot) {
	return normalizeRepoRelativePath(relative(repoRoot, path));
}

function resolveTscEntrypoint() {
	const typescriptPackagePath = require.resolve("typescript/package.json");
	const typescriptPackage = JSON.parse(readFileSync(typescriptPackagePath, "utf8"));
	const tscBinPath = typeof typescriptPackage.bin === "string" ? typescriptPackage.bin : typescriptPackage.bin?.tsc;
	if (!tscBinPath) {
		throw new Error("The installed TypeScript package does not declare a tsc executable.");
	}
	return resolve(dirname(typescriptPackagePath), tscBinPath);
}

function spawnTsc(config, target, args, stdio = "inherit") {
	const tscEntrypoint = resolveTscEntrypoint();
	const result = spawnSync(process.execPath, [tscEntrypoint, "--project", target.tsconfigPath, ...args], {
		cwd: config.repoRoot,
		stdio,
	});
	if (result.error) {
		throw result.error;
	}
	return result;
}

function runTsc(config, target, args) {
	return spawnTsc(config, target, args).status ?? 1;
}

function formatPathList(paths) {
	return paths.map((path) => `  - ${path}`).join("\n");
}

function compileTargetToTemp(config, target) {
	const tempOutDir = mkdtempSync(join(config.tempParentDir, `tlh-runtime-typescript-${target.id}-`));
	const tscStatus = runTsc(config, target, ["--rootDir", ".", "--outDir", tempOutDir]);
	if (tscStatus !== 0) {
		rmSync(tempOutDir, { recursive: true, force: true });
		return { status: tscStatus };
	}
	return { status: 0, tempOutDir };
}

function generatedOutputPathForSource(config, target, tempOutDir, sourcePath) {
	const outputPath = runtimeOutputPathForSource(sourcePath, target.sourceExtension, target.outputExtension);
	return {
		outputPath,
		generatedOutputPath: join(tempOutDir, relative(config.repoRoot, outputPath)),
		relativeOutputPath: relativeRepoPath(outputPath, config.repoRoot),
	};
}

function sourcePathForRuntimeOutput(repoRoot, target, relativeOutputPath) {
	return join(repoRoot, relativeOutputPath.slice(0, -target.outputExtension.length) + target.sourceExtension);
}

function listRegisteredTargetOutputs(config, target) {
	const targetRootPrefix = `${relativeRepoPath(target.sourceDir, config.repoRoot)}/`;
	return [...config.generatedOutputRegistry]
		.filter((relativePath) => relativePath.startsWith(targetRootPrefix) && relativePath.endsWith(target.outputExtension))
		.sort();
}

function inspectGeneratedOutputRegistry(config, target, sources) {
	const registeredOutputs = listRegisteredTargetOutputs(config, target);
	const expectedOutputPaths = sources.map((sourcePath) => relativeRepoPath(runtimeOutputPathForSource(sourcePath, target.sourceExtension, target.outputExtension), config.repoRoot));
	const registeredOutputSet = new Set(registeredOutputs);
	const unregisteredOutputs = expectedOutputPaths.filter((outputPath) => !registeredOutputSet.has(outputPath));
	const orphanOutputPaths = registeredOutputs.filter((outputPath) => !existsSync(sourcePathForRuntimeOutput(config.repoRoot, target, outputPath)));
	const shippingOrphanOutputs = orphanOutputPaths.filter((outputPath) => existsSync(join(config.repoRoot, outputPath)));

	return {
		unregisteredOutputs,
		shippingOrphanOutputs,
	};
}

function reportRegistryProblems(target, registryProblems, { includeOrphans }) {
	if (registryProblems.unregisteredOutputs.length === 0 && (!includeOrphans || registryProblems.shippingOrphanOutputs.length === 0)) {
		return false;
	}

	console.error(`Generated runtime output registry is not in sync for ${target.label}.`);
	if (registryProblems.unregisteredOutputs.length > 0) {
		console.error("\nMissing generated-output registry entries:");
		console.error(formatPathList(registryProblems.unregisteredOutputs));
	}
	if (includeOrphans && registryProblems.shippingOrphanOutputs.length > 0) {
		console.error("\nOrphan generated runtime outputs would still ship:");
		console.error(formatPathList(registryProblems.shippingOrphanOutputs));
	}
	console.error("\nUpdate .gitattributes and run 'npm run build' to reconcile generated runtime outputs.");
	return true;
}

function buildRuntimeOutputs(config, target, sources) {
	const registryProblems = inspectGeneratedOutputRegistry(config, target, sources);
	if (reportRegistryProblems(target, registryProblems, { includeOrphans: false })) {
		return 1;
	}
	const compiledTarget = compileTargetToTemp(config, target);
	if (compiledTarget.status !== 0) {
		return compiledTarget.status;
	}

	try {
		const missingGeneratedOutputs = [];
		for (const sourcePath of sources) {
			const { outputPath, generatedOutputPath, relativeOutputPath } = generatedOutputPathForSource(
				config,
				target,
				compiledTarget.tempOutDir,
				sourcePath,
			);
			if (!existsSync(generatedOutputPath)) {
				missingGeneratedOutputs.push(relativeOutputPath);
				continue;
			}
			mkdirSync(dirname(outputPath), { recursive: true });
			writeFileSync(outputPath, readFileSync(generatedOutputPath, "utf8"));
		}

		if (missingGeneratedOutputs.length > 0) {
			console.error(`TypeScript did not emit expected runtime outputs for ${target.label}:`);
			console.error(formatPathList(missingGeneratedOutputs));
			return 1;
		}
		for (const orphanOutputPath of registryProblems.shippingOrphanOutputs) {
			rmSync(join(config.repoRoot, orphanOutputPath), { force: true });
		}
		if (registryProblems.shippingOrphanOutputs.length > 0) {
			console.log(`Removed orphan generated runtime outputs for ${target.label}:`);
			console.log(formatPathList(registryProblems.shippingOrphanOutputs));
		}
		return 0;
	} finally {
		rmSync(compiledTarget.tempOutDir, { recursive: true, force: true });
	}
}

function checkFreshRuntimeOutputs(config, target, sources) {
	const registryProblems = inspectGeneratedOutputRegistry(config, target, sources);
	const compiledTarget = compileTargetToTemp(config, target);
	if (compiledTarget.status !== 0) {
		return compiledTarget.status;
	}

	try {
		const missingOutputs = [];
		const staleOutputs = [];
		const missingGeneratedOutputs = [];

		for (const sourcePath of sources) {
			const { outputPath, generatedOutputPath, relativeOutputPath } = generatedOutputPathForSource(
				config,
				target,
				compiledTarget.tempOutDir,
				sourcePath,
			);

			if (!existsSync(generatedOutputPath)) {
				missingGeneratedOutputs.push(relativeOutputPath);
				continue;
			}
			if (!existsSync(outputPath)) {
				missingOutputs.push(relativeOutputPath);
				continue;
			}
			if (readFileSync(outputPath, "utf8") !== readFileSync(generatedOutputPath, "utf8")) {
				staleOutputs.push(relativeOutputPath);
			}
		}

		if (
			registryProblems.unregisteredOutputs.length > 0 ||
			registryProblems.shippingOrphanOutputs.length > 0 ||
			missingGeneratedOutputs.length > 0 ||
			missingOutputs.length > 0 ||
			staleOutputs.length > 0
		) {
			console.error(`Generated runtime outputs are not fresh for ${target.label}.`);
			if (registryProblems.unregisteredOutputs.length > 0) {
				console.error("\nMissing generated-output registry entries:");
				console.error(formatPathList(registryProblems.unregisteredOutputs));
			}
			if (registryProblems.shippingOrphanOutputs.length > 0) {
				console.error("\nOrphan generated runtime outputs would still ship:");
				console.error(formatPathList(registryProblems.shippingOrphanOutputs));
			}
			if (missingGeneratedOutputs.length > 0) {
				console.error("\nTypeScript did not emit expected runtime outputs:");
				console.error(formatPathList(missingGeneratedOutputs));
			}
			if (missingOutputs.length > 0) {
				console.error("\nMissing generated runtime outputs:");
				console.error(formatPathList(missingOutputs));
			}
			if (staleOutputs.length > 0) {
				console.error("\nStale generated runtime outputs:");
				console.error(formatPathList(staleOutputs));
			}
			console.error("\nRun 'npm run build' to refresh generated runtime outputs.");
			return 1;
		}

		return 0;
	} finally {
		rmSync(compiledTarget.tempOutDir, { recursive: true, force: true });
	}
}

function main() {
	const mode = process.argv[2];
	if (!VALID_MODES.has(mode)) {
		usage();
		return 1;
	}

	const config = loadConfig();
	const targetsWithSources = config.targets
		.map((target) => ({
			target,
			sources: listRuntimeTypescriptSources(target.sourceDir, target.sourceExtension),
		}))
		.filter(({ sources }) => sources.length > 0);
	if (targetsWithSources.length === 0) {
		const labels = config.targets.map((target) => target.label).join(", ");
		console.log(`No runtime TypeScript sources found under ${labels}; skipping ${mode}.`);
		return 0;
	}

	if (mode === "typecheck") {
		for (const { target } of targetsWithSources) {
			const status = runTsc(config, target, ["--noEmit"]);
			if (status !== 0) {
				return status;
			}
		}
		return 0;
	}

	if (mode === "build") {
		for (const { target, sources } of targetsWithSources) {
			const status = buildRuntimeOutputs(config, target, sources);
			if (status !== 0) {
				return status;
			}
		}
		return 0;
	}

	let totalSourceCount = 0;
	for (const { target, sources } of targetsWithSources) {
		totalSourceCount += sources.length;
		const status = checkFreshRuntimeOutputs(config, target, sources);
		if (status !== 0) {
			return status;
		}
	}
	console.log(`Generated runtime outputs are fresh (${totalSourceCount} files across ${targetsWithSources.length} target${targetsWithSources.length === 1 ? "" : "s"}).`);
	return 0;
}

process.exit(main());
