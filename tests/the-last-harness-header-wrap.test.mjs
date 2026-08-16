import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTlhHeader } = await jiti.import("../extensions/the-last-harness/header.ts");

// Plain passthrough theme so visibleWidth correctly measures raw text content.
const plainTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function createResourcesWithManyExtensions() {
  return {
    context: [],
    skills: [],
    prompts: [],
    extensions: Array.from({ length: 20 }, (_, i) => `extension-${i + 1}`),
    themes: [],
  };
}

test("expanded header wraps extension list so no rendered line exceeds terminal width", () => {
  const header = createTlhHeader(plainTheme, createResourcesWithManyExtensions(), undefined);
  header.setExpanded(true);

  const lines = header.render(80);

  // There must be more than one content line (wrapping must have occurred).
  const contentLines = lines.filter((line) => line.startsWith("  "));
  assert.ok(contentLines.length > 1, "Expected wrapping to produce multiple content lines");

  // Every line must fit within the terminal width.
  for (const line of lines) {
    const w = visibleWidth(line);
    assert.ok(w <= 80, `Line exceeded terminal width (${w} > 80): ${JSON.stringify(line)}`);
  }
});

test("wrapped lines each start with the two-space indent", () => {
  const header = createTlhHeader(plainTheme, createResourcesWithManyExtensions(), undefined);
  header.setExpanded(true);

  const lines = header.render(80);
  const contentLines = lines.filter((line) => line.startsWith("  ") && !line.startsWith("   "));

  assert.ok(contentLines.length > 0, "Expected at least one indented content line");
  for (const line of contentLines) {
    assert.ok(
      line.startsWith("  "),
      `Content line missing leading two-space indent: ${JSON.stringify(line)}`,
    );
  }
});

test("no rendered line exceeds terminal width when items land exactly on width boundary", () => {
  // Repro for the off-by-two bug: 4 items of 8 chars each at width=20 caused
  // a non-final committed line of "  abcdefgh, abcdefgh, " (22 chars) to be
  // emitted because the acceptance check did not reserve 2 chars for the
  // trailing ", " added on wrap.
  const resources = {
    context: [],
    skills: [],
    prompts: [],
    extensions: Array.from({ length: 4 }, () => "abcdefgh"),
    themes: [],
  };
  const header = createTlhHeader(plainTheme, resources, undefined);
  header.setExpanded(true);

  const lines = header.render(20);

  for (const line of lines) {
    const w = visibleWidth(line);
    assert.ok(w <= 20, `Line exceeded terminal width (${w} > 20): ${JSON.stringify(line)}`);
  }
});

test("no rendered line exceeds terminal width when first item is near width", () => {
  // Regression for the headroom-gap bug: the isFirstOnLine force-accept lets the
  // first item occupy up to `width` columns. When the next item triggers the else
  // branch, the unpatched code pushed currentLine + ", " which overflows width.
  // Concrete failure: width=20, first item of 18 visible chars → currentLine is
  // 20 chars → pushed as "  <18chars>, " = 22 chars (> 20).
  const width = 20;
  // Item itself is width-2 = 18 visible chars; prefix adds 2 → currentLine = width.
  const nearWidthItem = "x".repeat(width - 2); // 18 chars
  const resources = {
    context: [],
    skills: [],
    prompts: [],
    extensions: [nearWidthItem, "extra", "more"],
    themes: [],
  };
  const header = createTlhHeader(plainTheme, resources, undefined);
  header.setExpanded(true);

  const lines = header.render(width);

  for (const line of lines) {
    const w = visibleWidth(line);
    assert.ok(
      w <= width,
      `Line exceeded terminal width (${w} > ${width}): ${JSON.stringify(line)}`,
    );
  }
});

test("non-final wrapped lines end with ', ' and final line does not", () => {
  const header = createTlhHeader(plainTheme, createResourcesWithManyExtensions(), undefined);
  header.setExpanded(true);

  const lines = header.render(80);
  const contentLines = lines.filter((line) => line.startsWith("  "));

  assert.ok(contentLines.length > 1, "Expected multiple wrapped content lines for this test");

  for (let i = 0; i < contentLines.length - 1; i++) {
    assert.ok(
      contentLines[i].endsWith(", "),
      `Non-final line should end with ', ': ${JSON.stringify(contentLines[i])}`,
    );
  }
  assert.ok(
    !contentLines[contentLines.length - 1].endsWith(", "),
    `Final line should not end with ', ': ${JSON.stringify(contentLines[contentLines.length - 1])}`,
  );
});
