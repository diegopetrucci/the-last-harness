import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(
  new URL("../extensions/the-last-harness/annotate-last-message/web/index.html", import.meta.url),
  "utf8",
);

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, "m"));
  assert.ok(match, `missing rule ${selector}`);
  return match[1];
}

test("annotate-last-message panel is a flex column and the scroller fills it without height:100%", () => {
  const panel = rule(".panel");
  assert.match(panel, /display:\s*flex/);
  assert.match(panel, /flex-direction:\s*column/);
  const lines = rule(".message-lines");
  assert.match(lines, /flex:\s*1/);
  assert.match(lines, /min-height:\s*0/);
  assert.doesNotMatch(lines, /height:\s*100%/);
});

test("annotate panel: scroller keeps non-zero token bottom padding", () => {
  const body = rule(".message-lines");
  assert.match(body, /padding:\s*var\(--space-\d\)\s+0\s+var\(--space-[1-6]\)/);
});

test("annotate rows: fixed toggle column and min-height keep rows with and without a note button equal", () => {
  assert.match(rule(":root"), /--toggle-size:\s*2rem/);
  const row = rule(".message-line-row");
  assert.match(row, /grid-template-columns:[^;]*minmax\(0,\s*1fr\)\s+var\(--toggle-size\)\s*;/);
  assert.doesNotMatch(row, /grid-template-columns:[^;]*\bauto\b/);
  assert.match(row, /min-height:\s*var\(--toggle-size\)/);
  const toggle = rule(".inline-toggle");
  assert.match(toggle, /width:\s*var\(--toggle-size\)/);
  assert.match(toggle, /height:\s*var\(--toggle-size\)/);
  assert.match(rule(".message-line"), /padding:\s*var\(--space-2\)\s+var\(--space-4\)\s+0/);
});

test("annotate editor: aligns with line-text column and gutter is 32px", () => {
  assert.match(rule(":root"), /--line-number-width:\s*32px/);
  assert.match(
    rule(".inline-editor"),
    /margin:\s*var\(--space-3\)\s+calc\(var\(--space-3\)\s*\+\s*var\(--toggle-size\)\)\s+0\s+calc\(var\(--line-number-width\)\s*\+\s*var\(--space-3\)\)\s*;/,
  );
});

test("overall comment textarea disables autocorrect and autocapitalize but keeps spellcheck", () => {
  const tag = html.match(/<textarea id="overall-comment"[^>]*>/)?.[0] ?? "";
  assert.match(tag, /autocorrect="off"/);
  assert.match(tag, /autocapitalize="off"/);
  assert.doesNotMatch(tag, /spellcheck/);
});
