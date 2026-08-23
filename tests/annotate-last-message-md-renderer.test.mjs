/**
 * Tests for extensions/the-last-harness/annotate-last-message/web/md-renderer.js
 *
 * Covers:
 * - applyFenceState: fence state machine, line-count preservation
 * - classifyLine: heading, hr, blockquote, lists, plain, blank
 * - tokenizeLine: marker hiding, escaped markers, inline code (incl. asterisks
 *   inside code), bold, italic, bold+italic, strikethrough, links, unmatched
 *   markers, fallback path, whitespace-only lines
 *
 * The file is loaded in an isolated vm context (no DOM, no document) to verify
 * the pure-parsing contract.  Line-numbering preservation is checked by
 * asserting that applyFenceState always returns one entry per input line.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const rendererSource = readFileSync(
  new URL(
    "../extensions/the-last-harness/annotate-last-message/web/md-renderer.js",
    import.meta.url,
  ),
  "utf8",
);

function loadRenderer() {
  const context = vm.createContext({});
  vm.runInContext(rendererSource, context, { filename: "md-renderer.js" });
  return context.__tlhMdRenderer;
}

const { applyFenceState, classifyLine, tokenizeLine } = loadRenderer();

/**
 * Normalize a value produced inside a vm context so that assert.deepEqual
 * (strict mode) does not trip on cross-realm prototype inequality.
 * JSON round-trip converts vm-realm objects to outer-realm plain objects.
 */
function n(val) {
  return JSON.parse(JSON.stringify(val));
}

// =============================================================================
// applyFenceState
// =============================================================================

test("applyFenceState: plain lines are tagged 'plain'", () => {
  assert.deepEqual(n(applyFenceState(["hello", "world"])), [
    { text: "hello", lineType: "plain" },
    { text: "world", lineType: "plain" },
  ]);
});

test("applyFenceState: fence open/body/close are tagged correctly", () => {
  const result = applyFenceState(["```", "const x = 1;", "```"]);
  assert.equal(result[0].lineType, "fence-open");
  assert.equal(result[1].lineType, "fence-body");
  assert.equal(result[2].lineType, "fence-close");
});

test("applyFenceState: tilde fences work the same as backtick fences", () => {
  const result = applyFenceState(["~~~js", "code line", "~~~"]);
  assert.equal(result[0].lineType, "fence-open");
  assert.equal(result[1].lineType, "fence-body");
  assert.equal(result[2].lineType, "fence-close");
});

test("applyFenceState: multiple body lines inside a fence", () => {
  const result = applyFenceState(["```", "line 1", "line 2", "line 3", "```"]);
  assert.equal(result[0].lineType, "fence-open");
  assert.equal(result[1].lineType, "fence-body");
  assert.equal(result[2].lineType, "fence-body");
  assert.equal(result[3].lineType, "fence-body");
  assert.equal(result[4].lineType, "fence-close");
});

test("applyFenceState: unclosed fence leaves remaining lines as fence-body", () => {
  const result = applyFenceState(["```", "code", "no closing delimiter"]);
  assert.equal(result[0].lineType, "fence-open");
  assert.equal(result[1].lineType, "fence-body");
  assert.equal(result[2].lineType, "fence-body");
});

test("applyFenceState: blank lines inside a fence are tagged fence-body", () => {
  const result = applyFenceState(["```", "", "code", "```"]);
  assert.equal(result[1].lineType, "fence-body");
  assert.equal(result[1].text, "");
});

test("applyFenceState: closer must use same delimiter character", () => {
  // Opening ``` should not be closed by ~~~
  const result = applyFenceState(["```", "code", "~~~", "still inside", "```"]);
  assert.equal(result[0].lineType, "fence-open");
  assert.equal(result[1].lineType, "fence-body");
  // ~~~ does not close a ``` fence
  assert.equal(result[2].lineType, "fence-body");
  assert.equal(result[3].lineType, "fence-body");
  assert.equal(result[4].lineType, "fence-close");
});

test("applyFenceState: closer must have at least as many delimiter chars as opener", () => {
  // ```` opened with 4 backticks; ``` (3) should not close it
  const result = applyFenceState(["````", "code", "```", "still inside", "````"]);
  assert.equal(result[0].lineType, "fence-open");
  assert.equal(result[2].lineType, "fence-body"); // ``` (3) does not close ```` (4)
  assert.equal(result[4].lineType, "fence-close"); // ```` (4) closes ````
});

test("applyFenceState: fence with info string is still recognised as delimiter", () => {
  const result = applyFenceState(["```typescript", "const x: number = 1;", "```"]);
  assert.equal(result[0].lineType, "fence-open");
  assert.equal(result[1].lineType, "fence-body");
  assert.equal(result[2].lineType, "fence-close");
});

test("applyFenceState: preserves line count (one output entry per input line) — line numbering invariant", () => {
  const inputs = ["# Heading", "plain", "```", "code", "```", "", "* item"];
  const result = applyFenceState(inputs);
  assert.equal(result.length, inputs.length, "one output entry per input line");
  for (let i = 0; i < inputs.length; i++) {
    assert.equal(result[i].text, inputs[i], `text preserved at index ${i}`);
  }
});

test("applyFenceState: empty input returns empty array", () => {
  assert.deepEqual(n(applyFenceState([])), []);
});

test("applyFenceState: fence open/close without body lines", () => {
  const result = applyFenceState(["```", "```"]);
  assert.equal(result[0].lineType, "fence-open");
  assert.equal(result[1].lineType, "fence-close");
});

// =============================================================================
// classifyLine
// =============================================================================

test("classifyLine: blank line (empty string)", () => {
  assert.deepEqual(n(classifyLine("")), { type: "blank" });
});

test("classifyLine: whitespace-only line treated as blank", () => {
  assert.deepEqual(n(classifyLine("   ")), { type: "blank" });
  assert.deepEqual(n(classifyLine("\t")), { type: "blank" });
});

test("classifyLine: ATX heading h1", () => {
  const result = classifyLine("# Hello world");
  assert.equal(result.type, "heading");
  assert.equal(result.level, 1);
  assert.equal(result.text, "Hello world");
});

test("classifyLine: ATX heading h2", () => {
  const result = classifyLine("## Section");
  assert.equal(result.type, "heading");
  assert.equal(result.level, 2);
});

test("classifyLine: ATX heading h6 (max level)", () => {
  const result = classifyLine("###### Smallest");
  assert.equal(result.level, 6);
});

test("classifyLine: ATX heading with trailing closing sequence stripped", () => {
  const result = classifyLine("## Section ##");
  assert.equal(result.type, "heading");
  assert.equal(result.text, "Section");
});

test("classifyLine: #no-space is NOT a heading", () => {
  const result = classifyLine("#NoSpace");
  assert.equal(result.type, "plain");
});

test("classifyLine: thematic break --- (dashes)", () => {
  assert.equal(classifyLine("---").type, "hr");
  assert.equal(classifyLine("- - -").type, "hr");
  assert.equal(classifyLine("------").type, "hr");
});

test("classifyLine: thematic break *** (asterisks)", () => {
  assert.equal(classifyLine("***").type, "hr");
  assert.equal(classifyLine("* * *").type, "hr");
});

test("classifyLine: thematic break ___ (underscores)", () => {
  assert.equal(classifyLine("___").type, "hr");
  assert.equal(classifyLine("_ _ _").type, "hr");
});

test("classifyLine: blockquote", () => {
  const result = classifyLine("> Quoted text");
  assert.equal(result.type, "blockquote");
  assert.equal(result.text, "Quoted text");
});

test("classifyLine: blockquote without space after >", () => {
  const result = classifyLine(">Quoted");
  assert.equal(result.type, "blockquote");
  assert.equal(result.text, "Quoted");
});

test("classifyLine: unordered list with -", () => {
  const result = classifyLine("- list item");
  assert.equal(result.type, "ul");
  assert.equal(result.bullet, "-");
  assert.equal(result.text, "list item");
});

test("classifyLine: unordered list with *", () => {
  const result = classifyLine("* list item");
  assert.equal(result.type, "ul");
  assert.equal(result.bullet, "*");
});

test("classifyLine: unordered list with +", () => {
  const result = classifyLine("+ list item");
  assert.equal(result.type, "ul");
  assert.equal(result.bullet, "+");
});

test("classifyLine: unordered list preserves leading indentation", () => {
  const result = classifyLine("    - nested item");
  assert.equal(result.type, "ul");
  assert.equal(result.indent, "    ");
  assert.equal(result.text, "nested item");
});

test("classifyLine: ordered list", () => {
  const result = classifyLine("1. First item");
  assert.equal(result.type, "ol");
  assert.equal(result.bullet, "1.");
  assert.equal(result.text, "First item");
});

test("classifyLine: ordered list with higher number", () => {
  const result = classifyLine("42. Forty-two");
  assert.equal(result.type, "ol");
  assert.equal(result.bullet, "42.");
});

test("classifyLine: plain text", () => {
  const result = classifyLine("Just plain text");
  assert.equal(result.type, "plain");
  assert.equal(result.text, "Just plain text");
});

// =============================================================================
// tokenizeLine — marker hiding
// =============================================================================

test("tokenizeLine: plain text produces a single text token", () => {
  assert.deepEqual(n(tokenizeLine("Hello world")), [{ type: "text", text: "Hello world" }]);
});

test("tokenizeLine: bold markers are hidden, text styled bold", () => {
  const tokens = n(tokenizeLine("**bold text**"));
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "bold");
  // Children should be plain text (no ** visible)
  assert.deepEqual(tokens[0].children, [{ type: "text", text: "bold text" }]);
});

test("tokenizeLine: italic markers are hidden, text styled italic", () => {
  const tokens = n(tokenizeLine("*italic*"));
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "italic");
  assert.deepEqual(tokens[0].children, [{ type: "text", text: "italic" }]);
});

test("tokenizeLine: bold+italic markers hidden", () => {
  const tokens = n(tokenizeLine("***bold italic***"));
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "boldItalic");
  assert.deepEqual(tokens[0].children, [{ type: "text", text: "bold italic" }]);
});

test("tokenizeLine: strikethrough markers hidden", () => {
  const tokens = n(tokenizeLine("~~struck~~"));
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "strikethrough");
  assert.deepEqual(tokens[0].children, [{ type: "text", text: "struck" }]);
});

test("tokenizeLine: inline code backticks hidden, text is code token", () => {
  assert.deepEqual(n(tokenizeLine("`code`")), [{ type: "code", text: "code" }]);
});

test("tokenizeLine: link brackets and parens hidden", () => {
  const tokens = n(tokenizeLine("[link text](https://example.com)"));
  assert.equal(tokens.length, 1);
  const token = tokens[0];
  assert.equal(token.type, "link");
  assert.equal(token.url, "https://example.com");
  assert.deepEqual(token.labelTokens, [{ type: "text", text: "link text" }]);
});

// =============================================================================
// tokenizeLine — correctness details
// =============================================================================

test("tokenizeLine: escaped markers render as literal text (\\* not bold)", () => {
  assert.deepEqual(n(tokenizeLine("\\*not bold\\*")), [{ type: "text", text: "*not bold*" }]);
});

test("tokenizeLine: escaped underscore renders as literal", () => {
  assert.deepEqual(n(tokenizeLine("\\_not italic\\_")), [{ type: "text", text: "_not italic_" }]);
});

test("tokenizeLine: inline code containing asterisks is not parsed as italic", () => {
  const tokens = tokenizeLine("`a*b*c`");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "code");
  assert.equal(tokens[0].text, "a*b*c");
});

test("tokenizeLine: unmatched single asterisk renders as plain text", () => {
  // The * has spaces around it — no closing * found with non-empty content
  assert.deepEqual(n(tokenizeLine("a * b")), [{ type: "text", text: "a * b" }]);
});

test("tokenizeLine: odd/unmatched markers render as plain text", () => {
  // Both stars surrounded by spaces → no italic
  assert.deepEqual(n(tokenizeLine("a * b * c")), [{ type: "text", text: "a * b * c" }]);
});

test("tokenizeLine: bold+italic nesting — **bold *italic* bold**", () => {
  const tokens = n(tokenizeLine("**bold *italic* bold**"));
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "bold");
  // Inner content should contain italic token
  const italicToken = tokens[0].children.find((t) => t.type === "italic");
  assert.ok(italicToken, "inner italic token must be present");
  assert.deepEqual(italicToken.children, [{ type: "text", text: "italic" }]);
});

test("tokenizeLine: link whose label contains inline code", () => {
  const tokens = n(tokenizeLine("[`code` link](https://example.com)"));
  assert.equal(tokens.length, 1);
  const link = tokens[0];
  assert.equal(link.type, "link");
  assert.equal(link.url, "https://example.com");
  const codeToken = link.labelTokens.find((t) => t.type === "code");
  assert.ok(codeToken, "label must contain a code token");
  assert.equal(codeToken.text, "code");
});

test("tokenizeLine: whitespace-only text (spaces only) returns plain text token", () => {
  assert.deepEqual(n(tokenizeLine("   ")), [{ type: "text", text: "   " }]);
});

test("tokenizeLine: empty string returns empty array", () => {
  assert.deepEqual(n(tokenizeLine("")), []);
});

test("tokenizeLine: mixed content — text + bold + text", () => {
  const tokens = n(tokenizeLine("hello **world** there"));
  assert.equal(tokens.length, 3);
  assert.equal(tokens[0].type, "text");
  assert.equal(tokens[0].text, "hello ");
  assert.equal(tokens[1].type, "bold");
  assert.equal(tokens[2].type, "text");
  assert.equal(tokens[2].text, " there");
});

test("tokenizeLine: double-backtick code span allows single backtick inside", () => {
  const tokens = n(tokenizeLine("`` `inner` ``"));
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "code");
  assert.equal(tokens[0].text, " `inner` ");
});

test("tokenizeLine: underscore bold __text__", () => {
  const tokens = n(tokenizeLine("__bold__"));
  assert.equal(tokens[0].type, "bold");
  assert.deepEqual(tokens[0].children, [{ type: "text", text: "bold" }]);
});

test("tokenizeLine: underscore italic _text_", () => {
  const tokens = tokenizeLine("_italic_");
  assert.equal(tokens[0].type, "italic");
});

test("tokenizeLine: fallback — any string produces a valid token array", () => {
  // tokenizeLine wraps parseInlineSpans in try/catch.
  // Verify that edge-case inputs never return undefined or throw.
  const edgeCases = ["\\", "~", "~~", "[", "[[[]]]", "***", "____"];
  for (const input of edgeCases) {
    const tokens = tokenizeLine(input);
    assert.ok(Array.isArray(tokens), `tokenizeLine("${input}") must return an array`);
    for (const tok of tokens) {
      assert.ok(typeof tok.type === "string", "each token must have a type string");
    }
  }
});

test("tokenizeLine: indentation (leading spaces) is preserved in plain text", () => {
  assert.deepEqual(n(tokenizeLine("    indented line")), [
    { type: "text", text: "    indented line" },
  ]);
});

// =============================================================================
// Fix 1 regressions — intraword underscore
// =============================================================================

test("tokenizeLine: snake_case_value underscores are literal (not italic)", () => {
  // All underscores flanked by alphanumerics on both sides — must be literal.
  const tokens = n(tokenizeLine("snake_case_value"));
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "text");
  assert.equal(tokens[0].text, "snake_case_value");
});

test("tokenizeLine: alpha__beta__gamma double-underscores are literal (not bold)", () => {
  const tokens = n(tokenizeLine("alpha__beta__gamma"));
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "text");
  assert.equal(tokens[0].text, "alpha__beta__gamma");
});

test("tokenizeLine: PI_CODING_AGENT_DIR underscores are all literal", () => {
  const tokens = n(tokenizeLine("PI_CODING_AGENT_DIR"));
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "text");
  assert.equal(tokens[0].text, "PI_CODING_AGENT_DIR");
});

test("tokenizeLine: _real italic_ is still parsed as italic", () => {
  // Opening underscore at word boundary (preceded by nothing/space), not intraword.
  const tokens = n(tokenizeLine("_real italic_"));
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "italic");
  assert.deepEqual(tokens[0].children, [{ type: "text", text: "real italic" }]);
});

// =============================================================================
// Fix 2 regressions — indented block markers
// =============================================================================

test("classifyLine: 4-space-indented # is plain text (not a heading)", () => {
  const result = classifyLine("    # shell comment");
  assert.equal(result.type, "plain");
  assert.equal(result.text, "    # shell comment");
});

test("classifyLine: 4-space-indented --- is plain text (not an hr)", () => {
  const result = classifyLine("    ---");
  assert.equal(result.type, "plain");
  assert.equal(result.text, "    ---");
});

test("classifyLine: 3-space-indented # heading is still a heading", () => {
  const result = classifyLine("   # heading at 3 spaces");
  assert.equal(result.type, "heading");
  assert.equal(result.level, 1);
  assert.equal(result.text, "heading at 3 spaces");
});

test("classifyLine: 4-space-indented list item is still a list item", () => {
  // List markers are exempt from the 3-space limit (they preserve all chars).
  const result = classifyLine("    - nested item");
  assert.equal(result.type, "ul");
  assert.equal(result.indent, "    ");
  assert.equal(result.text, "nested item");
});

// =============================================================================
// Fix 3 regressions — fence detection
// =============================================================================

test("applyFenceState: fence-body line with ``` and trailing text does not close the fence", () => {
  // A closing fence must have nothing but whitespace after the delimiter.
  const result = applyFenceState(["```", "``` trailing text", "```"]);
  assert.equal(result[0].lineType, "fence-open");
  // Middle line has trailing text — must NOT close the fence.
  assert.equal(result[1].lineType, "fence-body");
  assert.equal(result[2].lineType, "fence-close");
});

test("applyFenceState: fence-body line indented 6 spaces with ``` does not close the fence", () => {
  // 6 spaces of indentation exceeds the 3-space CommonMark limit.
  const result = applyFenceState(["```", "      ``` trailing text", "```"]);
  assert.equal(result[0].lineType, "fence-open");
  assert.equal(result[1].lineType, "fence-body");
  assert.equal(result[2].lineType, "fence-close");
});
