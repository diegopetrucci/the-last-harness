/**
 * App-level test for extensions/the-last-harness/annotate-last-message/web/app.js
 *
 * Loads both md-renderer.js and app.js into an isolated vm context with a
 * minimal DOM stub, then asserts the core line-numbering invariant:
 *   - there is exactly one .message-line element per input line, and
 *   - the rendered .line-number values are exactly the original line numbers
 *     in order.
 *
 * This exercises the full render path (fence state machine + classifyLine +
 * renderLineContent + createLineRow) without a real browser.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const rendererSrc = readFileSync(
  new URL(
    "../extensions/the-last-harness/annotate-last-message/web/md-renderer.js",
    import.meta.url,
  ),
  "utf8",
);
const appSrc = readFileSync(
  new URL("../extensions/the-last-harness/annotate-last-message/web/app.js", import.meta.url),
  "utf8",
);

/**
 * Minimal DOM element stub.  Only surfaces the API that app.js actually calls;
 * kept intentionally small so it stays easy to maintain.
 */
function makeElement(tag) {
  return {
    _tag: tag,
    className: "",
    type: "",
    style: { cssText: "" },
    dataset: {},
    hidden: false,
    disabled: false,
    placeholder: "",
    value: "",
    _text: "",
    _children: [],
    get textContent() {
      return this._text;
    },
    set textContent(v) {
      this._text = String(v);
    },
    /** append(node, ...) — matches DOM append() */
    append(...nodes) {
      this._children.push(...nodes);
    },
    /** replaceChildren() called with no args to clear, or with nodes */
    replaceChildren(...nodes) {
      this._children = [...nodes];
    },
    addEventListener() {},
    focus() {},
  };
}

/**
 * Build and run both scripts in a shared vm context with a DOM stub wired to
 * the supplied message data JSON.  Returns the stub element that represents
 * `#message-lines` so callers can inspect rendered children.
 */
function runAppWithData(data) {
  const dataEl = { textContent: JSON.stringify(data) };
  const messageLinesEl = makeElement("div");

  const docStub = {
    getElementById(id) {
      if (id === "annotate-last-message-data") return dataEl;
      if (id === "message-lines") return messageLinesEl;
      // Remaining named elements (overall-comment, section-comments,
      // status, submit-button, cancel-button) get generic stubs.
      return makeElement("div");
    },
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ _type: "text", _text: text }),
    addEventListener() {},
  };

  const ctx = vm.createContext({
    document: docStub,
    window: {},
  });

  // md-renderer.js sets ctx.__tlhMdRenderer; app.js reads it via globalThis.
  vm.runInContext(rendererSrc, ctx, { filename: "md-renderer.js" });
  vm.runInContext(appSrc, ctx, { filename: "app.js" });

  return messageLinesEl;
}

// =============================================================================
// Line-numbering invariant
// =============================================================================

test("app.js: one .message-line per input line, .line-number values in order", () => {
  // Multi-line message that exercises fenced code, blank, and plain lines.
  const lineTexts = [
    "# Heading", // line 1 — heading
    "```", // line 2 — fence-open
    "const x = 1;", // line 3 — fence-body
    "```", // line 4 — fence-close
    "", // line 5 — blank
    "plain text", // line 6 — plain
  ];
  const data = {
    text: lineTexts.join("\n"),
    lines: lineTexts.map((text, i) => ({ number: i + 1, text })),
    sections: [],
  };

  const messageLinesEl = runAppWithData(data);

  // Each input line must produce exactly one .message-line wrapper.
  const messageLineEls = messageLinesEl._children.filter((el) => el.className === "message-line");
  assert.equal(messageLineEls.length, lineTexts.length, "one .message-line per input line");

  // The .line-number inside each row must carry the original line number.
  const lineNumbers = messageLineEls.map((wrapper, idx) => {
    const row = wrapper._children.find((c) => c.className === "message-line-row");
    assert.ok(row, `.message-line[${idx}] must contain a .message-line-row`);
    const lineNumEl = row._children.find((c) => c.className === "line-number");
    assert.ok(lineNumEl, `.message-line-row[${idx}] must contain a .line-number`);
    return lineNumEl.textContent;
  });

  assert.deepEqual(
    lineNumbers,
    lineTexts.map((_, i) => String(i + 1)),
    ".line-number values must equal the original line numbers in order",
  );
});
