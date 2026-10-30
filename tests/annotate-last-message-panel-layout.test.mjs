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
