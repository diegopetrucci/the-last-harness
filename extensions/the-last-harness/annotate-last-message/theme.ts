/**
 * Live Pi theme → CSS bridge for the annotate-last-message window.
 *
 * Harvests the active Pi TUI theme colours via the upstream public API and
 * exposes them as CSS custom-property declarations for the annotate window.
 *
 * Design guarantees:
 * - Never throws: any failure or unparseable value falls back to the static
 *   TLH palette defined in themes/the-last-harness.json.
 * - Parses truecolor (38;2;r;g;b), 256-colour (38;5;n), basic (30-37/90-97),
 *   and the no-op/empty case.
 */

import {
  getMarkdownTheme,
  getSelectListTheme,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme, SelectListTheme, SettingsListTheme } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Static fallback palette (mirrors themes/the-last-harness.json)
// 256-colour indices resolved to hex: mutedGray(245)→#8a8a8a, dimGray(240)→#585858
// ---------------------------------------------------------------------------

const FALLBACK: Readonly<Record<string, string>> = {
  "--mdHeading": "#f4c95d", // gold
  "--mdLink": "#7dd3fc", // cyan
  "--mdLinkUrl": "#8a8a8a", // mutedGray 245
  "--mdCode": "#9b7bff", // violet
  "--mdCodeBlock": "inherit", // text (empty in theme = inherit)
  "--mdCodeBlockBorder": "#6f42c1", // purple
  "--mdQuote": "#8a8a8a", // mutedGray 245
  "--mdQuoteBorder": "#6f42c1", // purple
  "--mdHr": "#585858", // dimGray 240
  "--mdListBullet": "#f4c95d", // gold
  "--mdBold": "inherit", // no explicit mapping
  "--mdItalic": "inherit", // no explicit mapping
  "--accent": "#f4c95d", // gold
  "--muted": "#8a8a8a", // mutedGray 245
  "--dim": "#585858", // dimGray 240
} as const;

// ---------------------------------------------------------------------------
// ANSI SGR colour parsing
// ---------------------------------------------------------------------------

/** xterm basic-colour palette for SGR codes 30-37 and 90-97. */
const BASIC_ANSI_COLORS: Readonly<Record<number, string>> = {
  30: "#000000",
  31: "#cc0000",
  32: "#4e9a06",
  33: "#c4a000",
  34: "#3465a4",
  35: "#75507b",
  36: "#06989a",
  37: "#d3d7cf",
  90: "#555753",
  91: "#ef2929",
  92: "#8ae234",
  93: "#fce94f",
  94: "#729fcf",
  95: "#ad7fa8",
  96: "#34e2e2",
  97: "#eeeeec",
} as const;

/** xterm 6x6x6 RGB-cube level values (indices 16-231). */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function toHex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function xterm256ToHex(n: number): string | null {
  if (n < 0 || n > 255) return null;
  if (n < 16) {
    // System colours 0-15 map to the basic ANSI palette (30-37 / 90-97).
    const key = n < 8 ? 30 + n : 90 + (n - 8);
    return BASIC_ANSI_COLORS[key] ?? null;
  }
  if (n >= 232) {
    // Grayscale ramp 232-255: value = 8 + (n-232) * 10
    const v = 8 + (n - 232) * 10;
    const h = toHex2(v);
    return `#${h}${h}${h}`;
  }
  // 6×6×6 RGB cube: index 16-231
  const idx = n - 16;
  const b = idx % 6;
  const g = Math.floor(idx / 6) % 6;
  const r = Math.floor(idx / 36) % 6;
  return `#${toHex2(CUBE_LEVELS[r])}${toHex2(CUBE_LEVELS[g])}${toHex2(CUBE_LEVELS[b])}`;
}

/**
 * Parse the foreground colour from an ANSI-escaped string.
 *
 * Handles:
 * - `38;2;r;g;b` — 24-bit truecolor
 * - `38;5;n`     — xterm 256-colour index
 * - `30-37`      — basic 8 colours
 * - `90-97`      — bright 8 colours
 * - empty / no SGR prefix — returns `null` (caller falls back to static palette)
 *
 * Returns a CSS hex colour string (`#rrggbb`) or `null`.
 */
/** ESC character used in SGR regex. Stored as a string to avoid lint/regex control-char warnings. */
const ESC = "\u001b";
/** Matches the leading ESC[ ... m SGR sequence at the start of an ANSI-styled string. */
const SGR_PREFIX_RE = new RegExp(`^${ESC}\\[([0-9;]+)m`);

export function parseAnsiColor(text: string): string | null {
  // Match the leading ESC[ ... m SGR sequence.
  const match = SGR_PREFIX_RE.exec(text);
  if (!match) return null;

  const raw = match[1];
  if (!raw) return null;

  const params = raw.split(";").map(Number);
  const [p0, p1, p2, p3, p4] = params;

  // 24-bit truecolor: ESC[38;2;r;g;b m
  if (p0 === 38 && p1 === 2 && params.length >= 5) {
    const r = p2 ?? 0;
    const g = p3 ?? 0;
    const b = p4 ?? 0;
    if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) return null;
    return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
  }

  // 256-colour index: ESC[38;5;n m
  if (p0 === 38 && p1 === 5 && params.length >= 3) {
    return xterm256ToHex(p2 ?? 0);
  }

  // Basic and bright colours: ESC[30-37 m / ESC[90-97 m
  if ((p0 >= 30 && p0 <= 37) || (p0 >= 90 && p0 <= 97)) {
    return BASIC_ANSI_COLORS[p0] ?? null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// CSS var assembly
// ---------------------------------------------------------------------------

/** Sentinel character used when probing theme wrapper functions. */
const SENTINEL = "X";

/** Mapping from MarkdownTheme keys to CSS custom-property names. */
const MD_THEME_CSS_VARS: ReadonlyArray<{ key: keyof MarkdownTheme; cssVar: string }> = [
  { key: "heading", cssVar: "--mdHeading" },
  { key: "link", cssVar: "--mdLink" },
  { key: "linkUrl", cssVar: "--mdLinkUrl" },
  { key: "code", cssVar: "--mdCode" },
  { key: "codeBlock", cssVar: "--mdCodeBlock" },
  { key: "codeBlockBorder", cssVar: "--mdCodeBlockBorder" },
  { key: "quote", cssVar: "--mdQuote" },
  { key: "quoteBorder", cssVar: "--mdQuoteBorder" },
  { key: "hr", cssVar: "--mdHr" },
  { key: "listBullet", cssVar: "--mdListBullet" },
  { key: "bold", cssVar: "--mdBold" },
  { key: "italic", cssVar: "--mdItalic" },
] as const;

/**
 * Build CSS custom-property declarations from theme objects.
 *
 * Exported for testing: callers can pass mock or null theme objects to exercise
 * specific code paths without touching the upstream singleton.
 *
 * @param mdTheme  Upstream MarkdownTheme, or null to use all fallbacks.
 * @param slTheme  Upstream SelectListTheme, or null to use all fallbacks.
 * @param ssTheme  Upstream SettingsListTheme, or null to use all fallbacks.
 * @returns        Map of CSS var name → colour value (hex or "inherit").
 */
export function buildCssVarsFromThemes(
  mdTheme: MarkdownTheme | null,
  slTheme: SelectListTheme | null,
  ssTheme: SettingsListTheme | null,
): Record<string, string> {
  const vars: Record<string, string> = { ...FALLBACK };

  // Markdown token colours
  if (mdTheme !== null) {
    for (const { key, cssVar } of MD_THEME_CSS_VARS) {
      try {
        const fn = mdTheme[key];
        if (typeof fn !== "function") continue;
        // SettingsListTheme.label / value take (text, selected); all the
        // MarkdownTheme keys we iterate are (text) → string, so the cast is safe.
        const wrapped = (fn as (text: string) => string)(SENTINEL);
        const parsed = parseAnsiColor(wrapped);
        if (parsed !== null) vars[cssVar] = parsed;
      } catch {
        // Keep fallback value for this var.
      }
    }
  }

  // Accent / muted from SelectListTheme.selectedText / description
  if (slTheme !== null) {
    try {
      const parsed = parseAnsiColor(slTheme.selectedText(SENTINEL));
      if (parsed !== null) vars["--accent"] = parsed;
    } catch {
      // Keep fallback.
    }
    try {
      const parsed = parseAnsiColor(slTheme.description(SENTINEL));
      if (parsed !== null) vars["--muted"] = parsed;
    } catch {
      // Keep fallback.
    }
  }

  // Dim from SettingsListTheme.hint
  if (ssTheme !== null) {
    try {
      const parsed = parseAnsiColor(ssTheme.hint(SENTINEL));
      if (parsed !== null) vars["--dim"] = parsed;
    } catch {
      // Keep fallback.
    }
  }

  return vars;
}

/**
 * Harvest the active Pi TUI theme colours and return them as a map of CSS
 * custom-property declarations for the annotate-last-message window.
 *
 * Falls back silently to the static TLH palette for any token whose upstream
 * theme call throws or yields an unparseable value.
 *
 * @returns Map of CSS var name → colour value, e.g. `{ "--mdHeading": "#f4c95d" }`.
 */
export function getThemeCssVars(): Record<string, string> {
  let mdTheme: MarkdownTheme | null = null;
  let slTheme: SelectListTheme | null = null;
  let ssTheme: SettingsListTheme | null = null;

  try {
    mdTheme = getMarkdownTheme();
  } catch {
    // Theme not initialized; all md vars will use fallbacks.
  }
  try {
    slTheme = getSelectListTheme();
  } catch {
    // Fallback for accent/muted.
  }
  try {
    ssTheme = getSettingsListTheme();
  } catch {
    // Fallback for dim.
  }

  return buildCssVarsFromThemes(mdTheme, slTheme, ssTheme);
}
