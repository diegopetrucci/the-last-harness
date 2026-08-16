/**
 * Tests for extensions/the-last-harness/annotate-last-message/theme.ts
 *
 * Covers:
 * - parseAnsiColor: truecolor, 256-colour (cube + grayscale ramp), basic/bright,
 *   empty/no-op inputs.
 * - buildCssVarsFromThemes: full-fallback path, partial-fallback (mixed hit/miss),
 *   successful harvest producing correct hex values.
 * - getThemeCssVars: structural smoke-test (all expected vars present, valid values).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseAnsiColor, buildCssVarsFromThemes, getThemeCssVars } = await jiti.import(
  "../extensions/the-last-harness/annotate-last-message/theme.ts",
);

// ---------------------------------------------------------------------------
// parseAnsiColor — truecolor
// ---------------------------------------------------------------------------

test("parseAnsiColor: truecolor 38;2;r;g;b returns correct hex", () => {
  // ESC[38;2;240;198;116m — gold-ish truecolor
  const result = parseAnsiColor("\u001b[38;2;240;198;116mX\u001b[39m");
  assert.equal(result, "#f0c674");
});

test("parseAnsiColor: truecolor 38;2;0;0;0 → #000000", () => {
  assert.equal(parseAnsiColor("\u001b[38;2;0;0;0mX\u001b[39m"), "#000000");
});

test("parseAnsiColor: truecolor 38;2;255;255;255 → #ffffff", () => {
  assert.equal(parseAnsiColor("\u001b[38;2;255;255;255mX\u001b[39m"), "#ffffff");
});

// ---------------------------------------------------------------------------
// parseAnsiColor — 256-colour (grayscale ramp)
// ---------------------------------------------------------------------------

test("parseAnsiColor: 256-colour 38;5;245 (mutedGray) → #8a8a8a", () => {
  // 8 + (245 - 232) * 10 = 8 + 130 = 138 = 0x8a
  const result = parseAnsiColor("\u001b[38;5;245mX\u001b[39m");
  assert.equal(result, "#8a8a8a");
});

test("parseAnsiColor: 256-colour 38;5;240 (dimGray) → #585858", () => {
  // 8 + (240 - 232) * 10 = 8 + 80 = 88 = 0x58
  const result = parseAnsiColor("\u001b[38;5;240mX\u001b[39m");
  assert.equal(result, "#585858");
});

test("parseAnsiColor: 256-colour 38;5;255 (brightest grayscale) → #eeeeee", () => {
  // 8 + (255 - 232) * 10 = 8 + 230 = 238 = 0xee
  const result = parseAnsiColor("\u001b[38;5;255mX\u001b[39m");
  assert.equal(result, "#eeeeee");
});

test("parseAnsiColor: 256-colour 38;5;232 (darkest grayscale) → #080808", () => {
  // 8 + (232 - 232) * 10 = 8
  const result = parseAnsiColor("\u001b[38;5;232mX\u001b[39m");
  assert.equal(result, "#080808");
});

// ---------------------------------------------------------------------------
// parseAnsiColor — 256-colour (6×6×6 RGB cube)
// ---------------------------------------------------------------------------

test("parseAnsiColor: 256-colour 38;5;16 (black cube entry) → #000000", () => {
  // idx=0, r=0, g=0, b=0 → CUBE_LEVELS[0]=0 for all → #000000
  const result = parseAnsiColor("\u001b[38;5;16mX\u001b[39m");
  assert.equal(result, "#000000");
});

test("parseAnsiColor: 256-colour 38;5;231 (white cube entry) → #ffffff", () => {
  // idx=215, r=5, g=5, b=5 → CUBE_LEVELS[5]=255 → #ffffff
  const result = parseAnsiColor("\u001b[38;5;231mX\u001b[39m");
  assert.equal(result, "#ffffff");
});

test("parseAnsiColor: 256-colour 38;5;21 (pure blue cube) → #0000ff", () => {
  // 21 - 16 = 5, b=5, g=0, r=0 → #0000ff
  const result = parseAnsiColor("\u001b[38;5;21mX\u001b[39m");
  assert.equal(result, "#0000ff");
});

// ---------------------------------------------------------------------------
// parseAnsiColor — basic and bright ANSI colours (30-37, 90-97)
// ---------------------------------------------------------------------------

test("parseAnsiColor: basic 38;5;0-15 routes through ANSI basic palette", () => {
  // 256-colour index 0-15 maps to the 8+8 basic/bright ANSI colours
  // Index 1 → key 31 (red) → #cc0000
  const result = parseAnsiColor("\u001b[38;5;1mX\u001b[39m");
  assert.equal(result, "#cc0000");
});

test("parseAnsiColor: basic SGR 31 (red) → #cc0000", () => {
  assert.equal(parseAnsiColor("\u001b[31mX\u001b[39m"), "#cc0000");
});

test("parseAnsiColor: bright SGR 91 (bright red) → #ef2929", () => {
  assert.equal(parseAnsiColor("\u001b[91mX\u001b[39m"), "#ef2929");
});

test("parseAnsiColor: basic SGR 32 (green) → #4e9a06", () => {
  assert.equal(parseAnsiColor("\u001b[32mX\u001b[39m"), "#4e9a06");
});

test("parseAnsiColor: basic SGR 37 (white) → #d3d7cf", () => {
  assert.equal(parseAnsiColor("\u001b[37mX\u001b[39m"), "#d3d7cf");
});

// ---------------------------------------------------------------------------
// parseAnsiColor — empty / no-op inputs
// ---------------------------------------------------------------------------

test("parseAnsiColor: plain string with no ANSI → null", () => {
  assert.equal(parseAnsiColor("X"), null);
});

test("parseAnsiColor: empty string → null", () => {
  assert.equal(parseAnsiColor(""), null);
});

test("parseAnsiColor: reset-only SGR 0 → null (no fg colour)", () => {
  assert.equal(parseAnsiColor("\u001b[0mX\u001b[0m"), null);
});

test("parseAnsiColor: bold SGR 1 → null (not a colour code)", () => {
  assert.equal(parseAnsiColor("\u001b[1mX\u001b[0m"), null);
});

// ---------------------------------------------------------------------------
// buildCssVarsFromThemes — full-fallback path (all null inputs)
// ---------------------------------------------------------------------------

test("buildCssVarsFromThemes: all-null inputs returns static fallback palette", () => {
  const vars = buildCssVarsFromThemes(null, null, null);

  assert.equal(vars["--mdHeading"], "#f4c95d"); // gold
  assert.equal(vars["--mdLink"], "#7dd3fc"); // cyan
  assert.equal(vars["--mdLinkUrl"], "#8a8a8a"); // mutedGray 245
  assert.equal(vars["--mdCode"], "#9b7bff"); // violet
  assert.equal(vars["--mdCodeBlock"], "inherit"); // empty in theme
  assert.equal(vars["--mdCodeBlockBorder"], "#6f42c1"); // purple
  assert.equal(vars["--mdQuote"], "#8a8a8a"); // mutedGray 245
  assert.equal(vars["--mdQuoteBorder"], "#6f42c1"); // purple
  assert.equal(vars["--mdHr"], "#585858"); // dimGray 240
  assert.equal(vars["--mdListBullet"], "#f4c95d"); // gold
  assert.equal(vars["--mdBold"], "inherit");
  assert.equal(vars["--mdItalic"], "inherit");
  assert.equal(vars["--accent"], "#f4c95d"); // gold
  assert.equal(vars["--muted"], "#8a8a8a"); // mutedGray 245
  assert.equal(vars["--dim"], "#585858"); // dimGray 240
});

// ---------------------------------------------------------------------------
// buildCssVarsFromThemes — partial-fallback (throwing wrappers)
// ---------------------------------------------------------------------------

test("buildCssVarsFromThemes: throwing mdTheme functions keep fallback for those vars", () => {
  /** MarkdownTheme where every call throws. */
  const throwingMdTheme = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined; // not a Promise
        return () => {
          throw new Error(`mock throw for ${String(prop)}`);
        };
      },
    },
  );

  const vars = buildCssVarsFromThemes(throwingMdTheme, null, null);

  // Should fall back to static palette for all md vars.
  assert.equal(vars["--mdHeading"], "#f4c95d");
  assert.equal(vars["--mdCode"], "#9b7bff");
  assert.equal(vars["--accent"], "#f4c95d");
});

test("buildCssVarsFromThemes: mdTheme returning plain strings (no ANSI) keeps fallback", () => {
  const noAnsiMdTheme = {
    heading: (s) => s,
    link: (s) => s,
    linkUrl: (s) => s,
    code: (s) => s,
    codeBlock: (s) => s,
    codeBlockBorder: (s) => s,
    quote: (s) => s,
    quoteBorder: (s) => s,
    hr: (s) => s,
    listBullet: (s) => s,
    bold: (s) => s,
    italic: (s) => s,
    strikethrough: (s) => s,
    underline: (s) => s,
  };

  const vars = buildCssVarsFromThemes(noAnsiMdTheme, null, null);

  // No ANSI codes → parseAnsiColor returns null → fallback values preserved.
  assert.equal(vars["--mdHeading"], "#f4c95d");
  assert.equal(vars["--mdCode"], "#9b7bff");
});

// ---------------------------------------------------------------------------
// buildCssVarsFromThemes — successful harvest
// ---------------------------------------------------------------------------

test("buildCssVarsFromThemes: truecolor-returning mdTheme overrides fallback", () => {
  const customMdTheme = {
    heading: (_s) => "\u001b[38;2;100;200;50mX\u001b[39m",
    link: (_s) => "\u001b[38;2;10;20;30mX\u001b[39m",
    linkUrl: (_s) => "X", // no ANSI → fallback stays
    code: (_s) => "\u001b[38;2;255;0;128mX\u001b[39m",
    codeBlock: (_s) => "X",
    codeBlockBorder: (_s) => "\u001b[38;2;64;32;128mX\u001b[39m",
    quote: (_s) => "X",
    quoteBorder: (_s) => "X",
    hr: (_s) => "\u001b[38;2;50;50;50mX\u001b[39m",
    listBullet: (_s) => "\u001b[38;2;255;255;0mX\u001b[39m",
    bold: (_s) => "X",
    italic: (_s) => "X",
    strikethrough: (_s) => "X",
    underline: (_s) => "X",
  };

  const vars = buildCssVarsFromThemes(customMdTheme, null, null);

  assert.equal(vars["--mdHeading"], "#64c832"); // 100,200,50
  assert.equal(vars["--mdLink"], "#0a141e"); // 10,20,30
  assert.equal(vars["--mdLinkUrl"], "#8a8a8a"); // no ANSI → fallback
  assert.equal(vars["--mdCode"], "#ff0080"); // 255,0,128
  assert.equal(vars["--mdCodeBlock"], "inherit"); // no ANSI → fallback
  assert.equal(vars["--mdCodeBlockBorder"], "#402080"); // 64,32,128
  assert.equal(vars["--mdHr"], "#323232"); // 50,50,50
  assert.equal(vars["--mdListBullet"], "#ffff00"); // 255,255,0
});

test("buildCssVarsFromThemes: slTheme.selectedText overrides --accent", () => {
  const mockSlTheme = {
    selectedText: (_s) => "\u001b[38;2;255;128;0mX\u001b[39m",
    description: (_s) => "\u001b[38;2;100;100;100mX\u001b[39m",
    scrollInfo: (_s) => "X",
    noMatch: (_s) => "X",
    selectedPrefix: (_s) => "X",
  };

  const vars = buildCssVarsFromThemes(null, mockSlTheme, null);

  assert.equal(vars["--accent"], "#ff8000"); // 255,128,0
  assert.equal(vars["--muted"], "#646464"); // 100,100,100
  // md vars still use fallback
  assert.equal(vars["--mdHeading"], "#f4c95d");
});

test("buildCssVarsFromThemes: ssTheme.hint overrides --dim", () => {
  const mockSsTheme = {
    hint: (_s) => "\u001b[38;2;80;80;80mX\u001b[39m",
    label: (_s, _sel) => "X",
    value: (_s, _sel) => "X",
    description: (_s) => "X",
    cursor: "> ",
  };

  const vars = buildCssVarsFromThemes(null, null, mockSsTheme);

  assert.equal(vars["--dim"], "#505050"); // 80,80,80
  // Other vars use fallback
  assert.equal(vars["--accent"], "#f4c95d");
});

// ---------------------------------------------------------------------------
// getThemeCssVars — structural smoke-test
// ---------------------------------------------------------------------------

const EXPECTED_CSS_VARS = [
  "--mdHeading",
  "--mdLink",
  "--mdLinkUrl",
  "--mdCode",
  "--mdCodeBlock",
  "--mdCodeBlockBorder",
  "--mdQuote",
  "--mdQuoteBorder",
  "--mdHr",
  "--mdListBullet",
  "--mdBold",
  "--mdItalic",
  "--accent",
  "--muted",
  "--dim",
];

test("getThemeCssVars: returns all expected CSS vars", () => {
  const vars = getThemeCssVars();
  for (const cssVar of EXPECTED_CSS_VARS) {
    assert.ok(cssVar in vars, `Missing CSS var: ${cssVar}`);
  }
});

test("getThemeCssVars: all values are non-empty strings", () => {
  const vars = getThemeCssVars();
  for (const [key, value] of Object.entries(vars)) {
    assert.ok(
      typeof value === "string" && value.length > 0,
      `${key} has empty or non-string value: ${JSON.stringify(value)}`,
    );
  }
});

test("getThemeCssVars: colour values are valid hex or 'inherit'", () => {
  const vars = getThemeCssVars();
  const hexOrInherit = /^(#[0-9a-f]{6}|inherit)$/i;
  for (const [key, value] of Object.entries(vars)) {
    assert.match(value, hexOrInherit, `${key} has unexpected value: ${JSON.stringify(value)}`);
  }
});

test("getThemeCssVars: does not throw regardless of theme state", () => {
  // Should never throw, even in this test context where the theme singleton
  // may or may not be initialized.
  assert.doesNotThrow(() => {
    getThemeCssVars();
  });
});

// ---------------------------------------------------------------------------
// getThemeCssVars — injected getter path
// ---------------------------------------------------------------------------

/**
 * Distinctive colour guaranteed not to appear in the static TLH palette.
 * SGR 38;2;18;171;52 → #12ab34. The static palette uses #f4c95d, #7dd3fc,
 * #8a8a8a, #9b7bff, #6f42c1, and #585858 — none of which is #12ab34.
 */
const INJECTED_COLOR = "#12ab34";
const INJECTED_COLOR_SGR = "\u001b[38;2;18;171;52mX\u001b[39m";

/** Minimal MarkdownTheme-shaped fake that colours every key with INJECTED_COLOR. */
const FAKE_MD_THEME_ALL_INJECTED = {
  heading: (_s) => INJECTED_COLOR_SGR,
  link: (_s) => INJECTED_COLOR_SGR,
  linkUrl: (_s) => INJECTED_COLOR_SGR,
  code: (_s) => INJECTED_COLOR_SGR,
  codeBlock: (_s) => INJECTED_COLOR_SGR,
  codeBlockBorder: (_s) => INJECTED_COLOR_SGR,
  quote: (_s) => INJECTED_COLOR_SGR,
  quoteBorder: (_s) => INJECTED_COLOR_SGR,
  hr: (_s) => INJECTED_COLOR_SGR,
  listBullet: (_s) => INJECTED_COLOR_SGR,
  bold: (_s) => INJECTED_COLOR_SGR,
  italic: (_s) => INJECTED_COLOR_SGR,
  strikethrough: (_s) => INJECTED_COLOR_SGR,
  underline: (_s) => INJECTED_COLOR_SGR,
};

test("getThemeCssVars: injected markdown getter colours replace static fallback", () => {
  const vars = getThemeCssVars({ getMarkdownTheme: () => FAKE_MD_THEME_ALL_INJECTED });

  // Injected path must be used — NOT the static fallback gold (#f4c95d).
  assert.equal(vars["--mdHeading"], INJECTED_COLOR);
  assert.equal(vars["--mdCode"], INJECTED_COLOR);
  assert.equal(vars["--mdLink"], INJECTED_COLOR);
  assert.notEqual(vars["--mdHeading"], "#f4c95d");
  assert.notEqual(vars["--mdCode"], "#9b7bff");
});

test("getThemeCssVars: a getter that throws falls back for its own vars while other getters' vars still apply", () => {
  // getMarkdownTheme throws → md vars fall back to static palette.
  // getSelectListTheme succeeds → --accent receives the injected colour.
  const throwingMdGetter = () => {
    throw new Error("markdown theme not initialised");
  };
  const fakeSLGetter = () => ({
    selectedText: (_s) => INJECTED_COLOR_SGR,
    description: (_s) => "X", // no ANSI → --muted keeps static fallback
    scrollInfo: (_s) => "X",
    noMatch: (_s) => "X",
    selectedPrefix: (_s) => "X",
  });

  const vars = getThemeCssVars({
    getMarkdownTheme: throwingMdGetter,
    getSelectListTheme: fakeSLGetter,
  });

  // MD vars fall back to static palette because getMarkdownTheme threw.
  assert.equal(vars["--mdHeading"], "#f4c95d");
  assert.equal(vars["--mdCode"], "#9b7bff");

  // Accent comes from the working selectList getter.
  assert.equal(vars["--accent"], INJECTED_COLOR);

  // Muted falls back because description returned no ANSI.
  assert.equal(vars["--muted"], "#8a8a8a");
});
