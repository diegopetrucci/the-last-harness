import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

import { checkDocLinks } from "../scripts/check-doc-links.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function check(files, only = Object.keys(files)) {
  const root = mkdtempSync(join(tmpdir(), "tlh-doc-links-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return checkDocLinks(root, only);
}

test("reports a missing target file", () => {
  const problems = check({ "a.md": "[x](missing.md)\n" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /a\.md:1: missing file/);
});

test("reports a missing anchor in another file and in the same file", () => {
  const problems = check({ "a.md": "# Top\n[x](b.md#nope)\n[y](#gone)\n", "b.md": "# Real\n" }, [
    "a.md",
  ]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /missing anchor "#nope" in b\.md/);
  assert.match(problems[1], /missing anchor "#gone"/);
});

test("accepts valid anchors including slug rules and duplicate suffixes", () => {
  const problems = check(
    {
      "a.md": [
        "[a](b.md#hello-world-1)",
        "[b](b.md#tlh-version)",
        "[c](b.md#reconcile)",
        "![img](img.png)",
        "[d](b.md#hello-world)",
        "[e](#self)",
        "# Self",
      ].join("\n"),
      "b.md": "# Hello, World!\n## Hello, World!\n### `tlh version`\n#### `/reconcile`\n",
      "img.png": "",
    },
    ["a.md"],
  );
  assert.deepEqual(problems, []);
});

test("skips external links", () => {
  const problems = check({
    "a.md": "[x](https://example.com/nope.md#x) [y](mailto:a@b.c) [z](//example.com/q)\n",
  });
  assert.deepEqual(problems, []);
});

test("skips links inside fenced code and inline code", () => {
  const problems = check({
    "a.md": "```md\n[x](missing.md)\n```\n~~~\n[y](missing.md)\n~~~\n`[z](missing.md)`\n",
  });
  assert.deepEqual(problems, []);
});

test("ignores headings inside fenced code when collecting anchors", () => {
  const problems = check({ "a.md": "[x](b.md#fake)\n", "b.md": "```\n# Fake\n```\n" }, ["a.md"]);
  assert.equal(problems.length, 1);
});

test("tracks every generated slug for GitHub collision rules", () => {
  const problems = check(
    {
      "a.md": "[a](b.md#foo)\n[b](b.md#foo-1)\n[c](b.md#foo-1-1)\n[d](b.md#foo-2)\n",
      "b.md": "# Foo\n# Foo\n# Foo-1\n",
    },
    ["a.md"],
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing anchor "#foo-2"/);
});

test("parses balanced and escaped parentheses in link destinations", () => {
  const problems = check({
    "a.md": [
      "[a](guide(v2).md#intro)",
      "[b](guide\\(v2\\).md#intro)",
      "[c](guide(v2).md#nope) text (more)",
      "[d](missing(x).md)",
    ].join("\n"),
    "guide(v2).md": "# Intro\n",
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /a\.md:3: missing anchor "#nope"/);
  assert.match(problems[1], /a\.md:4: missing file for link "missing\(x\)\.md"/);
});
