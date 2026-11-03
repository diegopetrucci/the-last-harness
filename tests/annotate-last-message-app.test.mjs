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
    _listeners: new Map(),
    _attrs: {},
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
      this._children = [];
    },
    /** append(node, ...) — matches DOM append() */
    append(...nodes) {
      this._children.push(...nodes);
    },
    /** replaceChildren() called with no args to clear, or with nodes */
    replaceChildren(...nodes) {
      this._children = [...nodes];
      this._text = "";
    },
    addEventListener(type, handler) {
      const handlers = this._listeners.get(type) ?? [];
      handlers.push(handler);
      this._listeners.set(type, handlers);
    },
    dispatch(type, event = {}) {
      for (const handler of this._listeners.get(type) ?? []) handler(event);
    },
    setAttribute(name, value) {
      this._attrs[name] = String(value);
    },
    _focusCalls: 0,
    focus() {
      this._focusCalls += 1;
    },
  };
}

/**
 * Build and run both scripts in a shared vm context with a DOM stub wired to
 * the supplied message data JSON.  Returns the stub element that represents
 * `#message-lines` so callers can inspect rendered children.
 */
function runAppWithData(data) {
  const clock = { now: 1_000_000 };
  const dataEl = { textContent: JSON.stringify(data) };
  const elements = new Map();
  const messageLinesEl = makeElement("div");
  elements.set("message-lines", messageLinesEl);
  const documentListeners = new Map();
  const sent = [];
  let closeCalls = 0;

  const docStub = {
    getElementById(id) {
      if (id === "annotate-last-message-data") return dataEl;
      if (!elements.has(id)) elements.set(id, makeElement(id === "submit-hint" ? "kbd" : "div"));
      return elements.get(id);
    },
    createElement: (tag) => makeElement(tag),
    createElementNS: (_ns, tag) => makeElement(tag),
    createTextNode: (text) => ({ _type: "text", _text: text }),
    addEventListener(type, handler) {
      const handlers = documentListeners.get(type) ?? [];
      handlers.push(handler);
      documentListeners.set(type, handlers);
    },
    dispatch(type, event = {}) {
      for (const handler of documentListeners.get(type) ?? []) handler(event);
    },
  };

  const windowStub = {
    glimpse: {
      send(payload) {
        sent.push(payload);
      },
      close() {
        closeCalls += 1;
      },
    },
  };

  const ctx = vm.createContext({
    document: docStub,
    window: windowStub,
    Date: { now: () => clock.now },
    setTimeout: () => 0,
  });

  // md-renderer.js sets ctx.__tlhMdRenderer; app.js reads it via globalThis.
  vm.runInContext(rendererSrc, ctx, { filename: "md-renderer.js" });
  vm.runInContext(appSrc, ctx, { filename: "app.js" });

  return {
    messageLinesEl,
    elements,
    document: docStub,
    sent,
    clock,
    getCloseCalls: () => closeCalls,
  };
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

  const { messageLinesEl } = runAppWithData(data);

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

// =============================================================================
// Window refresh: inline toggle, section preview, shortcut hints, two-step Esc
// =============================================================================

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("app.js: inline toggle states, ARIA, noted-line marker, and Esc in editor", () => {
  const { messageLinesEl, document, sent, getCloseCalls } = runAppWithData({
    text: "Alpha",
    lines: [{ number: 7, text: "Alpha" }],
    sections: [],
  });
  const wrapper = messageLinesEl._children[0];
  const row = wrapper._children.find((c) => c.className === "message-line-row");
  const toggle = row._children.find((c) => c.className === "inline-toggle");
  const editor = wrapper._children.find((c) => c.className === "inline-editor");
  const textarea = editor._children.find((c) => c._tag === "textarea");

  assert.equal(textarea._attrs.autocorrect, "off");
  assert.equal(textarea._attrs.autocapitalize, "off");
  assert.equal(toggle.textContent, "+");
  assert.equal(toggle._attrs["aria-label"], "Add note to line 7");
  assert.equal(toggle.title, "Add note to line 7");
  assert.equal(toggle._attrs["aria-expanded"], "false");
  assert.equal(wrapper.dataset.hasNote, "false");

  toggle.dispatch("click");
  assert.equal(toggle.textContent, "\u2212");
  assert.equal(toggle._attrs["aria-expanded"], "true");
  assert.equal(textarea._focusCalls, 1);

  textarea.value = "note";
  textarea.dispatch("input");
  assert.equal(wrapper.dataset.hasNote, "true");

  const esc = {
    key: "Escape",
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
  const focusBefore = toggle._focusCalls;
  textarea.dispatch("keydown", esc);
  assert.equal(editor.hidden, true);
  assert.equal(esc.prevented && esc.stopped, true);
  assert.equal(toggle._focusCalls, focusBefore + 1);
  assert.equal(toggle._children.length, 1);
  assert.equal(toggle._children[0]._tag, "svg");
  assert.equal(toggle._children[0]._attrs["aria-hidden"], "true");
  assert.equal(toggle._attrs["aria-label"], "Edit note on line 7");
  assert.equal(toggle._attrs["aria-expanded"], "false");
  assert.equal(textarea.value, "note");
  assert.deepEqual(sent, []);
  assert.equal(getCloseCalls(), 0);

  textarea.value = "  ";
  textarea.dispatch("input");
  assert.equal(wrapper.dataset.hasNote, "false");
  assert.equal(toggle.textContent, "+");

  document.dispatch("keydown", { key: "Escape", preventDefault() {} });
  assert.deepEqual(plain(sent), [{ type: "cancel" }]);
});

test("app.js: section preview is capped at 4 lines with '+N more lines'", () => {
  const long = ["```", "a", "b", "c", "d", "```"].join("\n");
  const five = "1\n2\n3\n4\n5";
  const four = "1\n2\n3\n4";
  const sections = [long, five, four].map((text, i) => ({
    id: `s${i}`,
    index: i + 1,
    startLine: 1,
    endLine: text.split("\n").length,
    text,
  }));
  const { elements } = runAppWithData({
    text: long,
    lines: long.split("\n").map((t, i) => ({ number: i + 1, text: t })),
    sections,
  });
  const cards = elements.get("section-comments")._children;
  const preview = (card) => card._children.find((c) => c.className.startsWith("section-preview"));

  const p0 = preview(cards[0]);
  assert.equal(p0._children.length, 5, "4 lines + more marker");
  assert.equal(p0._children[4].textContent, "+2 more lines");
  assert.match(p0._children[3]._children[0]._tag, /code/);

  const p1 = preview(cards[1]);
  assert.equal(p1._children.length, 5);
  assert.equal(p1._children[4].textContent, "+1 more line");

  assert.equal(preview(cards[2])._children.length, 4, "short sections unchanged");

  const textarea = cards[0]._children.find((c) => c._tag === "textarea");
  assert.equal(textarea.placeholder, "Note on this section\u2026");
  assert.equal(textarea._attrs.autocorrect, "off");
});

test("app.js: section card header row holds heading and line range", () => {
  const { elements } = runAppWithData({
    text: "a\nb",
    lines: [
      { number: 1, text: "a" },
      { number: 2, text: "b" },
    ],
    sections: [{ id: "s1", index: 1, startLine: 1, endLine: 2, text: "a\nb" }],
  });
  const header = elements.get("section-comments")._children[0]._children[0];
  assert.equal(header.className, "section-header");
  assert.equal(header._children[0]._tag, "h3");
  assert.equal(header._children[1].className, "section-meta");
  assert.equal(header._children[1].textContent, "lines 1-2");
});

test("app.js: submit hint defaults to ⌘ ↵ and uses Ctrl ↵ on non-Mac platforms", () => {
  const data = { text: "x", lines: [{ number: 1, text: "x" }], sections: [] };
  const mac = runAppWithData(data);
  assert.equal(mac.elements.get("submit-hint").textContent, "\u2318 \u21B5");

  const dataEl = { textContent: JSON.stringify(data) };
  const hint = makeElement("kbd");
  const doc = {
    getElementById: (id) =>
      id === "annotate-last-message-data"
        ? dataEl
        : id === "submit-hint"
          ? hint
          : makeElement("div"),
    createElement: makeElement,
    createTextNode: (t) => ({ _text: t }),
    addEventListener() {},
  };
  const ctx = vm.createContext({ document: doc, window: {}, navigator: { platform: "Win32" } });
  vm.runInContext(rendererSrc, ctx);
  vm.runInContext(appSrc, ctx);
  assert.equal(hint.textContent, "Ctrl \u21B5");
});

const NOTE_DATA = {
  text: "Only line",
  lines: [{ number: 1, text: "Only line" }],
  sections: [],
};

function escEvent() {
  return { ctrlKey: false, metaKey: false, key: "Escape", preventDefault() {} };
}

test("app.js: Esc without notes closes immediately", () => {
  const app = runAppWithData(NOTE_DATA);
  app.document.dispatch("keydown", escEvent());
  assert.deepEqual(plain(app.sent), [{ type: "cancel" }]);
});

test("app.js: auto-repeated Esc with notes does not confirm the discard", () => {
  const app = runAppWithData(NOTE_DATA);
  app.elements.get("overall-comment").value = "Keep this";
  app.elements.get("overall-comment").dispatch("input");

  app.document.dispatch("keydown", escEvent());
  app.clock.now += 100;
  app.document.dispatch("keydown", { ...escEvent(), repeat: true });
  app.document.dispatch("keydown", { ...escEvent(), repeat: true });
  assert.deepEqual(plain(app.sent), []);

  app.clock.now += 100;
  app.document.dispatch("keydown", { ...escEvent(), repeat: false });
  assert.deepEqual(plain(app.sent), [{ type: "cancel" }]);
});

test("app.js: Esc with notes needs a second press within the window to discard", () => {
  const app = runAppWithData(NOTE_DATA);
  app.elements.get("overall-comment").value = "Keep this";
  app.elements.get("overall-comment").dispatch("input");

  app.document.dispatch("keydown", escEvent());
  assert.deepEqual(plain(app.sent), []);
  assert.equal(app.elements.get("status").textContent, "Press Esc again to discard 1 note");

  app.clock.now += 2500;
  app.document.dispatch("keydown", escEvent());
  assert.deepEqual(plain(app.sent), []);

  app.clock.now += 500;
  app.document.dispatch("keydown", escEvent());
  assert.deepEqual(plain(app.sent), [{ type: "cancel" }]);
  assert.equal(app.getCloseCalls(), 1);
  assert.equal(app.sent.length, 1);
});
