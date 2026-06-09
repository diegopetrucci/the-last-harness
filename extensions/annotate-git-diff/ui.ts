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
	monacoEditorJs: string;
	monacoEditorCss: string;
	monacoWorkerJs: string;
	monacoBasicLanguagesJs: string;
	bootstrapError: string | null;
}

function safeReadResolvedAsset(specifier: string): string {
	return readFileSync(require.resolve(specifier), "utf8");
}

function resolveReviewUiAssets(): ReviewUiAssets {
	try {
		const tailwindBrowserJs = safeReadResolvedAsset("@tailwindcss/browser");
		const monacoBasePath = join(dirname(require.resolve("monaco-editor/package.json")), "min", "vs");
		const monacoLoaderJs = readFileSync(join(monacoBasePath, "loader.js"), "utf8");
		const monacoEditorJs = readFileSync(join(monacoBasePath, "editor", "editor.main.js"), "utf8");
		const monacoEditorCss = readFileSync(join(monacoBasePath, "editor", "editor.main.css"), "utf8");
		const monacoWorkerJs = readFileSync(join(monacoBasePath, "base", "worker", "workerMain.js"), "utf8");
		const basicLanguagesDir = join(monacoBasePath, "basic-languages");
		const basicLanguagesJs = readdirSync(basicLanguagesDir)
			.sort()
			.map((lang) => {
				const filePath = join(basicLanguagesDir, lang, `${lang}.js`);
				return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
			})
			.filter(Boolean)
			.join("\n");
		return {
			tailwindBrowserJs,
			monacoLoaderJs,
			monacoEditorJs,
			monacoEditorCss,
			monacoWorkerJs,
			monacoBasicLanguagesJs: basicLanguagesJs,
			bootstrapError: null,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			tailwindBrowserJs: "",
			monacoLoaderJs: "",
			monacoEditorJs: "",
			monacoEditorCss: "",
			monacoWorkerJs: "",
			monacoBasicLanguagesJs: "",
			bootstrapError: `Unable to load packaged review UI assets: ${message}`,
		};
	}
}

export function buildReviewHtml(data: ReviewWindowData): string {
	const templateHtml = readFileSync(join(webDir, "index.html"), "utf8");
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
	html = safeReplace(html, "__INLINE_MONACO_WORKER_SOURCE_JSON__", escapeForInlineScript(JSON.stringify(assets.monacoWorkerJs)));
	html = safeReplace(html, "__INLINE_MONACO_EDITOR_JS__", escapeInlineScriptSource(assets.monacoEditorJs));
	html = safeReplace(html, "__INLINE_MONACO_BASIC_LANGUAGES_JS__", escapeInlineScriptSource(assets.monacoBasicLanguagesJs));
	html = safeReplace(html, "__INLINE_JS__", appJs);
	return html;
}
