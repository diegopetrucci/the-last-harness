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
  const collapsedHeader = createTlhHeader(plainTheme, createEmptyResources(), undefined, {
    startupTip,
  });
  const expandedHeader = createTlhHeader(plainTheme, createEmptyResources(), undefined, {
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
// Install-track notices are footer-only
// ---------------------------------------------------------------------------

test("collapsed header omits the retired install-track warning", () => {
  const header = createTlhHeader(plainTheme, createEmptyResources(), undefined, {});
  assert.doesNotMatch(header.render(80).join("\n"), /running TLH from/);
});

test("expanded header omits the retired install-track warning while retaining resource details", () => {
  const header = createTlhHeader(
    plainTheme,
    {
      ...createEmptyResources(),
      context: ["AGENTS.md"],
      skills: ["tlh-dev-hygiene"],
    },
    undefined,
    {},
  );
  header.setExpanded(true);

  const lines = header.render(80);
  assert.doesNotMatch(lines.join("\n"), /running TLH from/);
  assert.ok(lines.includes("Context: AGENTS.md"));
  assert.ok(lines.includes("[Skills]"));
});

test("collapsed header emits no trailing blank line when startupTip is absent", () => {
  // Without a tip and without allocation, the last rendered line must not be a
  // stray blank — the conditional-blank structure only inserts separators when
  // there is content following them.
  const header = createTlhHeader(plainTheme, createEmptyResources(), undefined, {});
  const lines = header.render(80);
  assert.notEqual(
    lines.at(-1),
    "",
    "last collapsed line must not be a blank line when no tip is set",
  );
});

test("collapsed header with no allocation and no tip renders only the logo", () => {
  // The bare case: renderCollapsed with no details and no tip should be exactly
  // [logo], not [logo, ""] with a stray trailing blank.
  const header = createTlhHeader(plainTheme, createEmptyResources(), undefined, {});
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
