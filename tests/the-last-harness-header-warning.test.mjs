import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTlhHeader } = await jiti.import("../extensions/the-last-harness/header.ts");

const plainTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function createEmptyResources() {
  return {
    context: [],
    skills: [],
    prompts: [],
    extensions: [],
    themes: [],
  };
}

test("startup tips wrap without truncation and stay last in collapsed and expanded headers", () => {
  const startupTip =
    "Use /fork to branch from an earlier user message and explore an alternate path.";
  const expectedTipBlock = [
    "Tip: Use /fork to branch",
    "     from an earlier user",
    "     message and explore",
    "     an alternate path.",
  ];
  const collapsedHeader = createTlhHeader(
    plainTheme,
    createEmptyResources(),
    undefined,
    undefined,
    { startupTip },
  );
  const expandedHeader = createTlhHeader(plainTheme, createEmptyResources(), undefined, undefined, {
    startupTip,
  });
  expandedHeader.setExpanded(true);

  const collapsedLines = collapsedHeader.render(25);
  const expandedLines = expandedHeader.render(25);
  const collapsedTipBlock = collapsedLines.slice(-expectedTipBlock.length);
  const expandedTipBlock = expandedLines.slice(-expectedTipBlock.length);

  assert.deepEqual(collapsedTipBlock, expectedTipBlock);
  assert.deepEqual(expandedTipBlock, expectedTipBlock);
  assert.equal(collapsedLines.at(-expectedTipBlock.length - 1), "");
  assert.equal(expandedLines.at(-expectedTipBlock.length - 1), "");
  assert.equal(
    collapsedTipBlock.some((line) => line.includes("...")),
    false,
  );
  assert.equal(
    expandedTipBlock.some((line) => line.includes("...")),
    false,
  );
  assert.equal(
    collapsedTipBlock.every((line) => visibleWidth(line) <= 25),
    true,
  );
  assert.equal(
    expandedTipBlock.every((line) => visibleWidth(line) <= 25),
    true,
  );
});

// ---------------------------------------------------------------------------
// Install notice warning line (value-based)
// ---------------------------------------------------------------------------

test("header shows no warning line when installNotice is undefined", () => {
  const header = createTlhHeader(plainTheme, createEmptyResources(), undefined, undefined);
  const lines = header.render(80);
  assert.doesNotMatch(lines.join("\n"), /running TLH from/);
});

test("header shows warning line when installNotice is a ref notice", () => {
  const notice = { kind: "ref", summary: "non-stable ref", detail: "my-branch" };
  const header = createTlhHeader(plainTheme, createEmptyResources(), undefined, notice);
  const lines = header.render(80);
  assert.ok(
    lines.some((line) => /Warning.*running TLH from my-branch track/.test(line)),
    "expected warning line with ref detail",
  );
});

test("header shows warning line when installNotice is a pinned-tag notice", () => {
  const notice = { kind: "pinned-tag", summary: "pinned tag", detail: "v0.28.0" };
  const header = createTlhHeader(plainTheme, createEmptyResources(), undefined, notice);
  const lines = header.render(80);
  assert.ok(
    lines.some((line) => /Warning.*running TLH from v0\.28\.0 track/.test(line)),
    "expected warning line with tag detail",
  );
});

test("collapsed header emits no trailing blank line when startupTip is absent", () => {
  // Provide an install notice so there is real content after the structural blank
  // separator that follows the logo. Without a tip the last rendered line must
  // be the warning text, not a stray blank.
  const notice = { kind: "ref", summary: "non-stable ref", detail: "my-branch" };
  const header = createTlhHeader(plainTheme, createEmptyResources(), undefined, notice);
  const lines = header.render(80);
  assert.notEqual(
    lines.at(-1),
    "",
    "last collapsed line must not be a blank line when no tip is set",
  );
});

test("collapsed header with no notice, no allocation, no tip renders only the logo", () => {
  // This is the bare case that was broken: renderCollapsed unconditionally seeded
  // [logo, ""] producing a stray trailing blank when nothing follows the separator.
  const header = createTlhHeader(plainTheme, createEmptyResources(), undefined, undefined);
  const lines = header.render(80);
  assert.deepEqual(lines, ["tlh"], "bare collapsed header must be exactly [logo]");
  assert.notEqual(lines.at(-1), "", "bare collapsed header must not end with a blank line");

  const linesW0 = header.render(0);
  assert.deepEqual(linesW0, ["tlh"], "bare collapsed header at width 0 must be exactly [logo]");
  assert.notEqual(
    linesW0.at(-1),
    "",
    "bare collapsed header at width 0 must not end with a blank line",
  );
});

test("header shows no warning line when installNotice is absent (no 4th arg)", () => {
  const header = createTlhHeader(plainTheme, createEmptyResources(), undefined);
  const lines = header.render(80);
  assert.doesNotMatch(lines.join("\n"), /running TLH from/);
});
