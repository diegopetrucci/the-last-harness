#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir as systemTmpDir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VALID_MODES = new Set(["build", "check", "typecheck"]);

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(__dirname, "..");

function resolveOverridePath(value, fallback) {
	return value ? resolve(value) : fallback;
}

function loadConfig() {
	const repoRoot = realpathSync(resolveOverridePath(process.env.TLH_RUNTIME_TYPESCRIPT_REPO_ROOT, defaultRepoRoot));
	return {
		repoRoot,
		scriptsDir: realpathSync(resolveOverridePath(process.env.TLH_RUNTIME_TYPESCRIPT_SCRIPTS_DIR, join(repoRoot, "scripts"))),
		tsconfigPath: realpathSync(resolveOverridePath(process.env.TLH_RUNTIME_TYPESCRIPT_TSCONFIG, join(repoRoot, "tsconfig.runtime-scripts.json"))),
		tempParentDir: realpathSync(resolveOverridePath(process.env.TLH_RUNTIME_TYPESCRIPT_TMPDIR, systemTmpDir())),
	};
}

function usage() {
	console.error("Usage: node scripts/runtime-typescript.mjs <build|check|typecheck>");
}

function listRuntimeTypescriptSources(dir) {
	const entries = readdirSync(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const entryPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listRuntimeTypescriptSources(entryPath));
			continue;
		}
		if (entry.name.endsWith(".mts") && !entry.name.endsWith(".d.mts")) {
			files.push(entryPath);
		}
	}
	return files.sort();
}

function runtimeOutputPathForSource(sourcePath) {
	return `${sourcePath.slice(0, -4)}.mjs`;
}

function relativeRepoPath(path, repoRoot) {
	return relative(repoRoot, path);
}

function spawnTsc(config, args, stdio = "inherit") {
	const tscEntrypoint = require.resolve("typescript/bin/tsc");
	const result = spawnSync(process.execPath, [tscEntrypoint, "--project", config.tsconfigPath, ...args], {
		cwd: config.repoRoot,
		stdio,
	});
	if (result.error) {
		throw result.error;
	}
	return result;
}

function runTsc(config, args) {
	return spawnTsc(config, args).status ?? 1;
}

function formatPathList(paths) {
	return paths.map((path) => `  - ${path}`).join("\n");
}

function checkFreshRuntimeOutputs(config, sources) {
	const tempOutDir = mkdtempSync(join(config.tempParentDir, "tlh-runtime-typescript-"));
	try {
		const tscStatus = runTsc(config, ["--rootDir", ".", "--outDir", tempOutDir]);
		if (tscStatus !== 0) {
			return tscStatus;
		}

		const missingOutputs = [];
		const staleOutputs = [];
		const missingGeneratedOutputs = [];

		for (const sourcePath of sources) {
			const outputPath = runtimeOutputPathForSource(sourcePath);
			const generatedOutputPath = join(tempOutDir, relative(config.repoRoot, outputPath));
			const relativeOutputPath = relativeRepoPath(outputPath, config.repoRoot);

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

		if (missingGeneratedOutputs.length > 0 || missingOutputs.length > 0 || staleOutputs.length > 0) {
			console.error("Runtime TypeScript generated outputs are not fresh.");
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
			console.error("\nRun 'npm run build' to refresh scripts/**/*.mjs from scripts/**/*.mts.");
			return 1;
		}

		return 0;
	} finally {
		rmSync(tempOutDir, { recursive: true, force: true });
	}
}

function main() {
	const mode = process.argv[2];
	if (!VALID_MODES.has(mode)) {
		usage();
		return 1;
	}

	const config = loadConfig();
	const sources = listRuntimeTypescriptSources(config.scriptsDir);
	if (sources.length === 0) {
		console.log(`No runtime TypeScript sources found under scripts/**/*.mts; skipping ${mode}.`);
		return 0;
	}

	if (mode === "typecheck") {
		return runTsc(config, ["--noEmit"]);
	}

	if (mode === "build") {
		return runTsc(config, []);
	}

	const status = checkFreshRuntimeOutputs(config, sources);
	if (status === 0) {
		console.log(`Runtime TypeScript generated outputs are fresh (${sources.length} files).`);
	}
	return status;
}

process.exit(main());
