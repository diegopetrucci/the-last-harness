import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LastAssistantMessageData } from "./types.js";
import { type ThemeGetters, getThemeCssVars } from "./theme.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "web");

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function escapeInlineScriptSource(value: string): string {
  return value.replace(/<\/(script)/gi, "<\\/$1");
}

/**
 * Build a CSS `:root { … }` block from a map of CSS custom-property names → values.
 *
 * Used to inject the live Pi theme colours into the annotate-last-message window
 * after the static default palette, so the injected values win the cascade.
 */
function buildThemeCssBlock(vars: Record<string, string>): string {
  const declarations = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `:root {\n${declarations}\n}`;
}

export function buildAnnotateLastMessageHtml(
  data: LastAssistantMessageData,
  getters?: ThemeGetters,
): string {
  const templateHtml = readFileSync(join(webDir, "index.html"), "utf8");
  const mdRendererJs = escapeInlineScriptSource(
    readFileSync(join(webDir, "md-renderer.js"), "utf8"),
  );
  const appJs = escapeInlineScriptSource(readFileSync(join(webDir, "app.js"), "utf8"));
  const payload = escapeForInlineScript(JSON.stringify(data));
  const themeBlock = buildThemeCssBlock(getThemeCssVars(getters));
  return templateHtml
    .replace('"__INLINE_DATA__"', () => payload)
    .replace("__INLINE_MD_RENDERER_JS__", () => mdRendererJs)
    .replace("__INLINE_JS__", () => appJs)
    .replace("__INLINE_THEME__", () => themeBlock);
}
