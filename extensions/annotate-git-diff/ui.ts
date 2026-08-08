import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewWindowData } from "./types.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "web");

function escapeForInlineScript(value: string): string {
	return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function escapeInlineScriptSource(value: string): string {
	return value.replace(/<\/(script)/gi, "<\\/$1");
}

function escapeInlineStyleSource(value: string): string {
	return value.replace(/<\/(style)/gi, "<\\/$1");
}

interface ReviewUiAssets {
	tailwindBrowserJs: string;
	monacoLoaderJs: string;
	monacoEntryJs: string;
	monacoEditorCss: string;
	monacoWorkerJs: string;
	monacoBasicLanguagesJs: string;
	bootstrapError: string | null;
}

function safeReadResolvedAsset(specifier: string): string {
	return readFileSync(require.resolve(specifier), "utf8");
}

function resolveMonacoEditorWorkerJs(monacoBasePath: string): string {
	const legacyWorkerPath = join(monacoBasePath, "base", "worker", "workerMain.js");
	if (existsSync(legacyWorkerPath)) {
		return readFileSync(legacyWorkerPath, "utf8");
	}

	const assetsDir = join(monacoBasePath, "assets");
	if (existsSync(assetsDir)) {
		const editorWorkerAsset = readdirSync(assetsDir)
			.sort()
			.find((entry) => /^editor\.worker[-.].*\.js$/.test(entry));
		if (editorWorkerAsset) {
			return readFileSync(join(assetsDir, editorWorkerAsset), "utf8");
		}
	}

	throw new Error(`Unable to locate Monaco editor worker under ${monacoBasePath}`);
}

function resolveMonacoRuntimeJs(monacoBasePath: string, monacoEntryPath: string): string {
	const excludedFiles = new Set([
		join(monacoBasePath, "loader.js"),
		// Monaco 0.56's legacy editor.main module replaces MonacoEnvironment and
		// injects a stylesheet link. TLH loads the public vs/index entry instead so
		// its inlined CSS and blob-backed worker environment remain authoritative.
		join(monacoBasePath, "editor", "editor.main.js"),
		monacoEntryPath,
	]);
	const scripts: string[] = [];

	const visit = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			const entryPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "assets") continue;
				visit(entryPath);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".js") || excludedFiles.has(entryPath)) {
				continue;
			}
			scripts.push(readFileSync(entryPath, "utf8"));
		}
	};

	visit(monacoBasePath);
	return scripts.join("\n");
}

function resolveReviewUiAssets(): ReviewUiAssets {
	try {
		const tailwindBrowserJs = safeReadResolvedAsset("@tailwindcss/browser");
		// Monaco 0.56 exports its public AMD entry but not package.json. Resolving the
		// package itself gives us min/vs/index.js without relying on private exports.
		const monacoEntryPath = require.resolve("monaco-editor");
		const monacoBasePath = dirname(monacoEntryPath);
		const monacoLoaderJs = readFileSync(join(monacoBasePath, "loader.js"), "utf8");
		const monacoEntryJs = readFileSync(monacoEntryPath, "utf8");
		const monacoEditorCssPath = join(monacoBasePath, "editor", "editor.main.css");
		const monacoEditorCss = existsSync(monacoEditorCssPath) ? readFileSync(monacoEditorCssPath, "utf8") : "";
		const monacoWorkerJs = resolveMonacoEditorWorkerJs(monacoBasePath);
		const monacoRuntimeJs = resolveMonacoRuntimeJs(monacoBasePath, monacoEntryPath);
		return {
			tailwindBrowserJs,
			monacoLoaderJs,
			monacoEntryJs,
			monacoEditorCss,
			monacoWorkerJs,
			monacoBasicLanguagesJs: monacoRuntimeJs,
			bootstrapError: null,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			tailwindBrowserJs: "",
			monacoLoaderJs: "",
			monacoEntryJs: "",
			monacoEditorCss: "",
			monacoWorkerJs: "",
			monacoBasicLanguagesJs: "",
			bootstrapError: `Unable to load packaged review UI assets: ${message}`,
		};
	}
}

export function buildReviewHtml(data: ReviewWindowData): string {
	const templateHtml = readFileSync(join(webDir, "index.html"), "utf8");
	const reviewStateJs = escapeInlineScriptSource(readFileSync(join(webDir, "review-state.js"), "utf8"));
	const appJs = escapeInlineScriptSource(readFileSync(join(webDir, "app.js"), "utf8"));
	const assets = resolveReviewUiAssets();
	const payload = escapeForInlineScript(JSON.stringify(data));
	const assetConfig = escapeForInlineScript(
		JSON.stringify({
			bootstrapError: assets.bootstrapError,
		}),
	);
	// Use function-form replacements throughout so that `$` in the replacement text
	// is treated as a literal character rather than a special `String.replace` pattern
	// (e.g. `$&`, `$'`, `$``, `$1` are all live in minified Monaco JS).
	const safeReplace = (source: string, marker: string, replacement: string): string =>
		source.replace(marker, () => replacement);

	let html = templateHtml;
	html = safeReplace(html, '"__INLINE_DATA__"', payload);
	html = safeReplace(html, "__INLINE_ASSET_CONFIG__", assetConfig);
	html = safeReplace(html, "__INLINE_TAILWIND_JS__", escapeInlineScriptSource(assets.tailwindBrowserJs));
	html = safeReplace(html, "__INLINE_MONACO_LOADER_JS__", escapeInlineScriptSource(assets.monacoLoaderJs));
	html = safeReplace(html, "__INLINE_MONACO_EDITOR_CSS__", escapeInlineStyleSource(assets.monacoEditorCss));
	html = safeReplace(
		html,
		"__INLINE_MONACO_WORKER_SOURCE_JSON__",
		escapeForInlineScript(JSON.stringify(assets.monacoWorkerJs)),
	);
	html = safeReplace(html, "__INLINE_MONACO_ENTRY_JS__", escapeInlineScriptSource(assets.monacoEntryJs));
	html = safeReplace(
		html,
		"__INLINE_MONACO_BASIC_LANGUAGES_JS__",
		escapeInlineScriptSource(assets.monacoBasicLanguagesJs),
	);
	html = safeReplace(html, "__INLINE_REVIEW_STATE_JS__", reviewStateJs);
	html = safeReplace(html, "__INLINE_JS__", appJs);
	return html;
}
