import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "web");
function escapeForInlineScript(value) {
    return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}
function escapeInlineScriptSource(value) {
    return value.replace(/<\/(script)/gi, "<\\/$1");
}
export function buildAnnotateLastMessageHtml(data) {
    const templateHtml = readFileSync(join(webDir, "index.html"), "utf8");
    const appJs = escapeInlineScriptSource(readFileSync(join(webDir, "app.js"), "utf8"));
    const payload = escapeForInlineScript(JSON.stringify(data));
    return templateHtml.replace('"__INLINE_DATA__"', payload).replace("__INLINE_JS__", appJs);
}
