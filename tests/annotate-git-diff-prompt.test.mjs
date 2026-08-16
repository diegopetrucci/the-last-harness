import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { composeReviewPrompt } = await jiti.import("../extensions/annotate-git-diff/prompt.ts");

test("composeReviewPrompt renders overall, branch, commit, working-tree, and all-files comments", () => {
  const files = [
    {
      id: "branch:notes.txt",
      path: "notes.txt",
      gitDiff: { displayPath: "notes.txt" },
    },
    {
      id: "rename:docs/new.md",
      path: "docs/new.md",
      gitDiff: { displayPath: "docs/old.md → docs/new.md" },
    },
  ];
  const prompt = composeReviewPrompt(files, {
    type: "submit",
    overallComment: "  Please tighten the tests.  ",
    comments: [
      {
        id: "c1",
        fileId: "branch:notes.txt",
        scope: "branch",
        side: "original",
        startLine: 12,
        endLine: 14,
        body: "  Old branch logic is hard to follow.  ",
      },
      {
        id: "c2",
        fileId: "rename:docs/new.md",
        scope: "commits",
        commitKind: "commit",
        commitShort: "abc1234",
        side: "modified",
        startLine: 8,
        endLine: 8,
        body: "Clarify the rename rationale.",
      },
      {
        id: "c3",
        fileId: "branch:notes.txt",
        scope: "commits",
        commitKind: "working-tree",
        side: "file",
        startLine: null,
        endLine: null,
        body: "Document the current unstaged changes.",
      },
      {
        id: "c4",
        fileId: "rename:docs/new.md",
        scope: "all",
        side: "modified",
        startLine: 3,
        endLine: 3,
        body: "Mention this file in the overview.",
      },
    ],
  });

  assert.equal(
    prompt,
    [
      "Please address the following feedback",
      "",
      "Please tighten the tests.",
      "",
      "1. [branch diff] notes.txt:12-14 (old)",
      "   Old branch logic is hard to follow.",
      "",
      "2. [commit abc1234] docs/old.md → docs/new.md:8 (new)",
      "   Clarify the rename rationale.",
      "",
      "3. [working tree changes] notes.txt",
      "   Document the current unstaged changes.",
      "",
      "4. [all files] docs/old.md → docs/new.md:3",
      "   Mention this file in the overview.",
    ].join("\n"),
  );
});
