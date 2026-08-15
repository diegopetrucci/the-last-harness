import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getThemeCssVars } from "./theme.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "web");
function escapeForInlineScript(value) {
    return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}
function escapeInlineScriptSource(value) {
    return value.replace(/<\/(script)/gi, "<\\/$1");
}
function buildThemeCssBlock(vars) {
    const declarations = Object.entries(vars)
        .map(([k, v]) => `  ${k}: ${v};`)
        .join("\n");
    return `:root {\n${declarations}\n}`;
}
export function buildAnnotateLastMessageHtml(data) {
    const templateHtml = readFileSync(join(webDir, "index.html"), "utf8");
    const mdRendererJs = escapeInlineScriptSource(readFileSync(join(webDir, "md-renderer.js"), "utf8"));
    const appJs = escapeInlineScriptSource(readFileSync(join(webDir, "app.js"), "utf8"));
    const payload = escapeForInlineScript(JSON.stringify(data));
    const themeBlock = buildThemeCssBlock(getThemeCssVars());
    return templateHtml
        .replace('"__INLINE_DATA__"', () => payload)
        .replace("__INLINE_MD_RENDERER_JS__", () => mdRendererJs)
        .replace("__INLINE_JS__", () => appJs)
        .replace("__INLINE_THEME__", () => themeBlock);
}
