import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  // Absolute file:// URL for the Monaco min/ directory (parent of min/vs) with a
  // trailing slash. Required so that require.toUrl() returns absolute URLs:
  // on about:blank, new URL(require.toUrl("./assets/..."), document.baseURI) throws
  // because document.baseURI is "about:blank". Setting an absolute baseUrl makes
  // toUrl() return a file:// URL that AMD can resolve without touching document.baseURI.
  monacoBaseUrl: string;
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
        // nls/lang/*.js each overwrite globalThis._VSCODE_NLS_LANGUAGE and
        // globalThis._VSCODE_NLS_MESSAGES; inlining all of them would let the last
        // file (alphabetically zh-tw) win and display a non-English locale.
        if (entryPath === join(monacoBasePath, "nls", "lang")) continue;
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
    const monacoEditorCss = existsSync(monacoEditorCssPath)
      ? readFileSync(monacoEditorCssPath, "utf8")
      : "";
    const monacoWorkerJs = resolveMonacoEditorWorkerJs(monacoBasePath);
    const monacoRuntimeJs = resolveMonacoRuntimeJs(monacoBasePath, monacoEntryPath);
    // Absolute file:// URL for the Monaco min/ directory (parent of min/vs).
    // See the monacoBaseUrl field comment on ReviewUiAssets for why this is needed.
    const monacoBaseUrl = pathToFileURL(dirname(monacoBasePath) + "/").href;
    return {
      tailwindBrowserJs,
      monacoLoaderJs,
      monacoEntryJs,
      monacoEditorCss,
      monacoWorkerJs,
      monacoBasicLanguagesJs: monacoRuntimeJs,
      monacoBaseUrl,
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
      monacoBaseUrl: "",
      bootstrapError: `Unable to load packaged review UI assets: ${message}`,
    };
  }
}

export function buildReviewHtml(data: ReviewWindowData): string {
  const templateHtml = readFileSync(join(webDir, "index.html"), "utf8");
  const reviewNavigationJs = escapeInlineScriptSource(
    readFileSync(join(webDir, "review-navigation.js"), "utf8"),
  );
  const reviewStateJs = escapeInlineScriptSource(
    readFileSync(join(webDir, "review-state.js"), "utf8"),
  );
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
  html = safeReplace(
    html,
    "__INLINE_TAILWIND_JS__",
    escapeInlineScriptSource(assets.tailwindBrowserJs),
  );
  html = safeReplace(
    html,
    "__INLINE_MONACO_LOADER_JS__",
    escapeInlineScriptSource(assets.monacoLoaderJs),
  );
  html = safeReplace(
    html,
    "__INLINE_MONACO_EDITOR_CSS__",
    escapeInlineStyleSource(assets.monacoEditorCss),
  );
  html = safeReplace(
    html,
    "__INLINE_MONACO_WORKER_SOURCE_JSON__",
    escapeForInlineScript(JSON.stringify(assets.monacoWorkerJs)),
  );
  // Emit require.config({ baseUrl }) immediately before the inlined Monaco entry
  // module. On about:blank, new URL(require.toUrl("./assets/..."), document.baseURI)
  // throws because document.baseURI resolves to "about:blank". Providing an absolute
  // file:// baseUrl makes toUrl() return absolute URLs that AMD resolves safely.
  const monacoBaseUrlConfig = assets.monacoBaseUrl
    ? `require.config({baseUrl:${escapeForInlineScript(JSON.stringify(assets.monacoBaseUrl))}});\n`
    : "";
  html = safeReplace(
    html,
    "__INLINE_MONACO_ENTRY_JS__",
    monacoBaseUrlConfig + escapeInlineScriptSource(assets.monacoEntryJs),
  );
  html = safeReplace(
    html,
    "__INLINE_MONACO_BASIC_LANGUAGES_JS__",
    escapeInlineScriptSource(assets.monacoBasicLanguagesJs),
  );
  html = safeReplace(html, "__INLINE_REVIEW_STATE_JS__", reviewStateJs);
  html = safeReplace(html, "__INLINE_REVIEW_NAVIGATION_JS__", reviewNavigationJs);
  html = safeReplace(html, "__INLINE_JS__", appJs);
  return html;
}
