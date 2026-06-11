#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VALID_MODES = new Set(["build", "check", "typecheck"]);

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const scriptsDir = join(repoRoot, "scripts");
const tsconfigPath = join(repoRoot, "tsconfig.runtime-scripts.json");

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

function relativeRepoPath(path) {
	return relative(repoRoot, path);
}

function spawnTsc(args, stdio = "inherit") {
	const tscEntrypoint = require.resolve("typescript/bin/tsc");
	const result = spawnSync(process.execPath, [tscEntrypoint, "--project", tsconfigPath, ...args], {
		cwd: repoRoot,
		stdio,
	});
	if (result.error) {
		throw result.error;
	}
	return result;
}

function exitWithTsc(args) {
	const result = spawnTsc(args);
	process.exit(result.status ?? 1);
}

function formatPathList(paths) {
	return paths.map((path) => `  - ${path}`).join("\n");
}

function checkFreshRuntimeOutputs(sources) {
	const tempOutDir = mkdtempSync(join(tmpdir(), "tlh-runtime-typescript-"));
	try {
		const result = spawnTsc(["--rootDir", ".", "--outDir", tempOutDir]);
		if ((result.status ?? 1) !== 0) {
			process.exit(result.status ?? 1);
		}

		const missingOutputs = [];
		const staleOutputs = [];
		const missingGeneratedOutputs = [];

		for (const sourcePath of sources) {
			const outputPath = runtimeOutputPathForSource(sourcePath);
			const generatedOutputPath = join(tempOutDir, relative(repoRoot, outputPath));
			const relativeOutputPath = relativeRepoPath(outputPath);

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
			process.exit(1);
		}
	} finally {
		rmSync(tempOutDir, { recursive: true, force: true });
	}
}

const mode = process.argv[2];
if (!VALID_MODES.has(mode)) {
	usage();
	process.exit(1);
}

const sources = listRuntimeTypescriptSources(scriptsDir);
if (sources.length === 0) {
	console.log(`No runtime TypeScript sources found under scripts/**/*.mts; skipping ${mode}.`);
	process.exit(0);
}

if (mode === "typecheck") {
	exitWithTsc(["--noEmit"]);
}

if (mode === "build") {
	exitWithTsc([]);
}

checkFreshRuntimeOutputs(sources);
console.log(`Runtime TypeScript generated outputs are fresh (${sources.length} files).`);
