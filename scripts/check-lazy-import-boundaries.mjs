#!/usr/bin/env node
/**
 * check-lazy-import-boundaries.mjs
 *
 * Enforce the lazy-import invariant over the extensions/ tree:
 *
 *   A dynamically import()-ed extension module's static dependency graph must:
 *   (a) contain no bare specifiers (fully transitive check), AND
 *   (b) contain no module that is also reachable from the eager entry graph
 *       of the same extension (fully transitive check, with a narrow allowlist
 *       for verified-stateless shared utilities — see SHARED_MODULE_ALLOWLIST).
 *
 * WHY: pi's extension loader injects the @earendil-works/pi-coding-agent alias
 * only within the jiti-loaded eager graph. A dynamic import() crosses into native
 * ESM where that alias is absent — resolving a bare specifier there dies with
 * ERR_MODULE_NOT_FOUND at command-execution time. Condition (b) matters
 * independently: a module loaded in both the jiti graph and native ESM gets
 * duplicated module-level singleton state and prototype patches applied twice
 * (e.g. model-selection-scope.js holds AsyncLocalStorage and a prototype-patch
 * symbol; profile-state.js holds claim state — duplicating either silently splits
 * state and was the root cause of the tlhmf-1yvd regression).
 *
 * SCOPE: All .js/.mjs files under extensions/, analysed on the GENERATED .js
 * files (not .ts), so type-only imports erased during compilation are not
 * over-reported. Only string-literal import() targets are checked; dynamic
 * expressions (e.g. import(computedUrl)) are skipped.
 *
 * PARSING: Uses the TypeScript compiler API (ts.createSourceFile + AST walk)
 * to extract ImportDeclaration, ExportDeclaration (including `export * from`),
 * side-effect imports, and CallExpression with ImportKeyword. This eliminates
 * multiline, comment, and template-string classes of false negative at the root
 * rather than patching regexes. The `typescript` package is already a devDep.
 *
 * Usage: node scripts/check-lazy-import-boundaries.mjs [--extensions-dir <dir>]
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function usage() {
	return `Usage: node scripts/check-lazy-import-boundaries.mjs [options]

Check that dynamically import()-ed extension modules satisfy the lazy-import invariant.

Options:
  --extensions-dir <path>  Path to the extensions directory (default: extensions)
  -h, --help               Show this help
`;
}

function parseArgs(argv) {
	const args = {
		extensionsDir: join(ROOT, "extensions"),
		help: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") {
			args.help = true;
		} else if (arg === "--extensions-dir") {
			const next = argv[i + 1];
			if (!next || next.startsWith("-")) {
				process.stderr.write(`error: --extensions-dir requires a value\n`);
				process.exit(1);
			}
			args.extensionsDir = resolve(next);
			i += 1;
		} else {
			process.stderr.write(`error: unknown argument: ${arg}\n`);
			process.exit(1);
		}
	}
	return args;
}

// ---------------------------------------------------------------------------
// Condition (b) allowlist — verified-stateless shared modules
// ---------------------------------------------------------------------------
//
// These modules appear in both the eager entry graph and the static dep graph
// of at least one lazy import target, but have been verified to be safe:
// they contain ZERO module-level mutable state and import only node: builtins.
//
// ADDING AN ENTRY: you must verify that the module has no module-level mutable
// state (no top-level Map/Set/object mutations, no class definitions used as
// singletons, no prototype patches). Document the reason here. Do not add
// entries to silence a check you have not fully analysed — this list is the
// only mechanism that allows a transitive overlap, so it fails closed.
//
// Current entries:
//
//   the-last-harness/common.js
//     15 pure exported functions (formatHomePath, isRecord, readText, …).
//     Imports only node:fs and node:path. No module-level mutable state.
//     Verified 2026-08-15: shared between the eager graph of the-last-harness.js
//     and the lazy static graphs of tokens.js and session-limit-report.js.
//
/** @type {ReadonlySet<string>} Paths relative to extensionsDir, using '/' separators. */
const SHARED_MODULE_ALLOWLIST = new Set(["the-last-harness/common.js"]);

// ---------------------------------------------------------------------------
// Import specifier classification
// ---------------------------------------------------------------------------

/**
 * Returns true if the specifier is a bare (package) specifier —
 * i.e. not relative (./ or ../), not a Node built-in (node:*), and
 * not a file URL (file:*).
 */
function isBareSpecifier(spec) {
	return !spec.startsWith("./") && !spec.startsWith("../") && !spec.startsWith("node:") && !spec.startsWith("file:");
}

// ---------------------------------------------------------------------------
// File parsing — AST-based static and dynamic import extraction
// ---------------------------------------------------------------------------

/**
 * Parse a .js file with the TypeScript compiler and extract all import/export
 * specifiers. Returns `{ static: string[], dynamic: string[] }` where:
 *   - `static`  contains specifiers from ImportDeclaration, ExportDeclaration
 *               (including `export * from`), and side-effect-only imports.
 *   - `dynamic` contains string-literal arguments of CallExpression nodes
 *               whose expression is the `import` keyword.
 *
 * Using the TypeScript AST instead of regexes means:
 *   - Multiline dynamic imports are found correctly.
 *   - Import-looking text inside comments or template strings is ignored.
 *   - Non-literal dynamic import(variable) calls are skipped intentionally.
 */
function parseImports(filePath) {
	let src;
	try {
		src = readFileSync(filePath, "utf8");
	} catch {
		return { static: [], dynamic: [] };
	}

	const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.ESNext, /* setParentNodes */ true);

	const staticSpecs = new Set();
	const dynamicSpecs = [];

	function visit(node) {
		// import ... from "specifier"
		// import "side-effect"
		if (ts.isImportDeclaration(node)) {
			if (ts.isStringLiteral(node.moduleSpecifier)) {
				staticSpecs.add(node.moduleSpecifier.text);
			}
		}
		// export * from "specifier"
		// export { x } from "specifier"
		else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
			if (ts.isStringLiteral(node.moduleSpecifier)) {
				staticSpecs.add(node.moduleSpecifier.text);
			}
		}
		// import("string-literal")
		else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length > 0 &&
			ts.isStringLiteral(node.arguments[0])
		) {
			dynamicSpecs.push(node.arguments[0].text);
		}

		ts.forEachChild(node, visit);
	}

	visit(sf);

	return { static: [...staticSpecs], dynamic: dynamicSpecs };
}

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a relative specifier from a source file directory.
 * Tries the specifier as-is, then appends /index.js if it's a directory,
 * and handles specifiers without extensions.
 * Returns absolute path or null if unresolvable.
 */
function resolveRelativeSpecifier(sourceFile, spec) {
	const base = dirname(sourceFile);
	const candidate = resolve(base, spec);

	if (existsSync(candidate) && statSync(candidate).isFile()) {
		return candidate;
	}
	// Try as directory index
	const indexCandidate = join(candidate, "index.js");
	if (existsSync(indexCandidate)) {
		return indexCandidate;
	}
	// Try appending .js if no extension
	if (!spec.endsWith(".js") && !spec.endsWith(".mjs")) {
		const withExt = `${candidate}.js`;
		if (existsSync(withExt)) {
			return withExt;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Graph traversal
// ---------------------------------------------------------------------------

/**
 * Build the STATIC dependency graph reachable from `entryFile` by following
 * only static import/export specifiers. Dynamic import() calls are NOT
 * followed — they define lazy boundaries.
 *
 * Returns a Set<string> of absolute resolved file paths.
 * Only resolves relative specifiers; bare and node: specifiers are not walked.
 */
function buildStaticGraph(entryFile) {
	const visited = new Set();
	const queue = [entryFile];

	while (queue.length > 0) {
		const file = queue.shift();
		if (visited.has(file)) continue;
		visited.add(file);

		const { static: specifiers } = parseImports(file);
		for (const spec of specifiers) {
			if (spec.startsWith("./") || spec.startsWith("../")) {
				const resolved = resolveRelativeSpecifier(file, spec);
				if (resolved && !visited.has(resolved)) {
					queue.push(resolved);
				}
			}
			// node: and bare specifiers are external — don't walk them
		}
	}

	return visited;
}

// ---------------------------------------------------------------------------
// Entry file discovery
// ---------------------------------------------------------------------------

/**
 * Discover extension entry files:
 *   1. (Production) Read `pi.extensions` from the nearest package.json found
 *      in the parent directory chain of extensionsDir. This is the authoritative
 *      manifest that lists exactly which files are loaded as extension entries.
 *   2. (Fallback for fixture directories without package.json) All .js/.mjs
 *      files directly inside extensionsDir (depth 1) plus all index.js files
 *      anywhere inside extensionsDir.
 *
 * Returns an array of absolute file paths.
 */
function discoverEntryFiles(extensionsDir) {
	// Try to find a package.json with `pi.extensions` up the directory tree,
	// starting from extensionsDir's parent.
	const manifestEntries = tryReadPiExtensions(extensionsDir);
	if (manifestEntries !== null) {
		return manifestEntries;
	}

	// Fallback: filename-heuristic discovery (used by fixture directories
	// that have no package.json manifest).
	const entries = new Set();

	// Depth-1 .js and .mjs files
	let topLevel;
	try {
		topLevel = readdirSync(extensionsDir);
	} catch {
		return [...entries];
	}
	for (const name of topLevel) {
		if (name.endsWith(".js") || name.endsWith(".mjs")) {
			const full = join(extensionsDir, name);
			if (statSync(full).isFile()) {
				entries.add(full);
			}
		}
	}

	// Recursive index.js discovery
	function walkForIndex(dir) {
		let items;
		try {
			items = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of items) {
			const full = join(dir, name);
			let stat;
			try {
				stat = statSync(full);
			} catch {
				continue;
			}
			if (stat.isDirectory()) {
				walkForIndex(full);
			} else if (stat.isFile() && name === "index.js") {
				entries.add(full);
			}
		}
	}

	for (const name of topLevel) {
		const full = join(extensionsDir, name);
		try {
			if (statSync(full).isDirectory()) {
				walkForIndex(full);
			}
		} catch {
			// ignore
		}
	}

	return [...entries];
}

/**
 * Search for a package.json with `pi.extensions` starting from the parent of
 * `extensionsDir` and walking up. Returns an array of absolute entry file
 * paths resolved relative to the package.json directory, or null if no
 * suitable package.json is found.
 *
 * Critically, entries are only accepted if they actually live under
 * `extensionsDir`. This prevents a fixture placed inside the repository from
 * silently resolving the repo's own `pi.extensions` manifest — the repo
 * package.json would be found first but its entries would not be children of
 * the fixture directory, so we fall through to heuristic discovery instead.
 */
function tryReadPiExtensions(extensionsDir) {
	// Normalise extensionsDir for prefix matching.
	const extDirNorm = extensionsDir.endsWith("/") ? extensionsDir : extensionsDir + "/";

	let dir = dirname(extensionsDir);
	const root = resolve("/");
	while (true) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			let pkg;
			try {
				pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
			} catch {
				return null;
			}
			const extensions = pkg?.pi?.extensions;
			if (Array.isArray(extensions) && extensions.length > 0) {
				const resolved = extensions
					.map((spec) => {
						const abs = resolve(dir, spec);
						return existsSync(abs) ? abs : null;
					})
					.filter(Boolean);
				// Only use manifest entries that are children of extensionsDir.
				// If the resolved entries all live somewhere else (e.g. the repo
				// root's package.json was found while analysing an in-repo fixture
				// directory), fall through to heuristic discovery.
				const underExtDir = resolved.filter((abs) => abs.startsWith(extDirNorm) || abs === extensionsDir);
				if (underExtDir.length > 0) {
					return underExtDir;
				}
				// Manifest exists but entries don't govern extensionsDir — stop
				// searching upward and fall through to heuristic discovery.
				return null;
			}
			// Found a package.json but no pi.extensions — stop searching upward
			return null;
		}
		const parent = resolve(dir, "..");
		if (parent === dir || dir === root) break;
		dir = parent;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

function runCheck(extensionsDir) {
	const violations = [];

	// Step 1: Discover extension entry files.
	const entryFiles = discoverEntryFiles(extensionsDir);
	if (entryFiles.length === 0) {
		process.stderr.write(`warning: no extension entry files found in ${extensionsDir}\n`);
		return violations;
	}

	// Step 2: Build eager static dep graph per entry file.
	// Map from entry file path → Set<absolute path> of eagerly reachable files.
	/** @type {Map<string, Set<string>>} */
	const eagerGraphs = new Map();
	for (const entry of entryFiles) {
		eagerGraphs.set(entry, buildStaticGraph(entry));
	}

	// Step 3: Walk all dynamic import() boundaries — both from eager graph files
	// AND transitively from lazy graph files (nested lazy boundaries). For each
	// dynamic import found, check the static graph of the lazy target for
	// conditions (a) and (b).
	//
	// We use a worklist of (sourceFile, ownerEntry) pairs and guard against
	// cycles with a per-entry visited set.

	// Seed the worklist with dynamic imports found in each entry's eager graph.
	/** @type {Array<{ sourceFile: string, ownerEntry: string }>} */
	const dynWorklist = [];

	// visitedDynTargets: per ownerEntry, the set of lazy target absolute paths
	// already enqueued (cycle guard for nested lazy boundaries).
	/** @type {Map<string, Set<string>>} */
	const visitedDynTargets = new Map();

	for (const entry of entryFiles) {
		visitedDynTargets.set(entry, new Set());
		const eagerGraph = eagerGraphs.get(entry);
		for (const file of eagerGraph) {
			dynWorklist.push({ sourceFile: file, ownerEntry: entry });
		}
	}

	while (dynWorklist.length > 0) {
		const { sourceFile, ownerEntry } = dynWorklist.shift();

		const { dynamic: dynSpecs } = parseImports(sourceFile);
		if (dynSpecs.length === 0) continue;

		const eagerGraph = eagerGraphs.get(ownerEntry);
		const visitedTargets = visitedDynTargets.get(ownerEntry);

		for (const dynSpec of dynSpecs) {
			// Only check relative specifiers (our invariant is about extension-local lazy boundaries).
			if (!dynSpec.startsWith("./") && !dynSpec.startsWith("../")) continue;

			const lazyTarget = resolveRelativeSpecifier(sourceFile, dynSpec);
			if (!lazyTarget) {
				// Target file not found — reported as a violation (causes exit 1).
				// Dynamic import targets that cannot be resolved to a real file are
				// unconditionally flagged; callers should remove the import() or
				// ensure the referenced file exists before committing.
				violations.push({
					kind: "unresolved-target",
					sourceFile,
					dynSpec,
					message: `Dynamic import target not found: import("${dynSpec}") in ${relative(extensionsDir, sourceFile)}`,
				});
				continue;
			}

			// Cycle guard: if we've already analysed this lazy target for this
			// ownerEntry, skip to avoid infinite loops.
			if (visitedTargets.has(lazyTarget)) continue;
			visitedTargets.add(lazyTarget);

			// Build the STATIC dep graph of the lazy target.
			const lazyGraph = buildStaticGraph(lazyTarget);

			// Collect all static import specifiers within the lazy graph (for condition a).
			const allLazyStaticSpecifiers = new Map(); // specifier → file where it appears
			for (const lazyFile of lazyGraph) {
				const { static: specs } = parseImports(lazyFile);
				for (const spec of specs) {
					if (!allLazyStaticSpecifiers.has(spec)) {
						allLazyStaticSpecifiers.set(spec, lazyFile);
					}
				}
			}

			// Condition (a): no bare specifiers in the lazy static graph.
			for (const [spec, inFile] of allLazyStaticSpecifiers) {
				if (isBareSpecifier(spec)) {
					violations.push({
						kind: "bare-specifier",
						sourceFile,
						dynSpec,
						lazyFile: inFile,
						bareSpec: spec,
						message:
							`Bare specifier in lazy graph: ` +
							`import("${dynSpec}") at ${relative(extensionsDir, sourceFile)} ` +
							`→ ${relative(extensionsDir, inFile)} imports bare specifier "${spec}"`,
					});
				}
			}

			// Condition (b): no module in the lazy static graph is also in the eager
			// graph of the owning entry (fully transitive check). Violations indicate a
			// module that will be instantiated twice — once by jiti and once by native
			// ESM — duplicating any module-level singleton state or prototype patches.
			//
			// Modules in SHARED_MODULE_ALLOWLIST are exempted because they have been
			// individually verified to contain no module-level mutable state. Do not
			// add entries without that verification.
			for (const lazyFile of lazyGraph) {
				const relPath = relative(extensionsDir, lazyFile).replace(/\\/gu, "/");
				if (SHARED_MODULE_ALLOWLIST.has(relPath)) continue;
				if (eagerGraph.has(lazyFile)) {
					violations.push({
						kind: "shared-module",
						sourceFile,
						dynSpec,
						sharedModule: lazyFile,
						ownerEntry,
						message:
							`Shared module between eager and lazy graphs: ` +
							`import("${dynSpec}") at ${relative(extensionsDir, sourceFile)} ` +
							`→ ${relative(extensionsDir, lazyFile)} is also eagerly reachable ` +
							`from ${relative(extensionsDir, ownerEntry)} ` +
							`(add to SHARED_MODULE_ALLOWLIST only if verified stateless)`,
					});
				}
			}

			// Nested lazy boundaries: enqueue all files in the lazy static graph
			// for further dynamic-import scanning under the same ownerEntry.
			// This ensures outer lazy → inner lazy → bare specifier is detected.
			for (const lazyFile of lazyGraph) {
				dynWorklist.push({ sourceFile: lazyFile, ownerEntry });
			}
		}
	}

	return violations;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

if (args.help) {
	process.stdout.write(usage());
	process.exit(0);
}

const violations = runCheck(args.extensionsDir);

if (violations.length === 0) {
	process.stdout.write("check:lazy-import-boundaries: OK\n");
	process.exit(0);
} else {
	process.stderr.write(`check:lazy-import-boundaries: FAILED — ${violations.length} violation(s)\n\n`);
	for (const v of violations) {
		process.stderr.write(`  ${v.message}\n`);
	}
	process.stderr.write("\n");
	process.exit(1);
}
