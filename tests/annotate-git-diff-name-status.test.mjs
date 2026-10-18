import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { __testing, getCommitFiles, getReviewWindowData } = await jiti.import(
  "../extensions/annotate-git-diff/git.ts",
);
const { parseNameStatus } = __testing;

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim();
}

function createExecApi() {
  return {
    exec: async (command, args, options = {}) => {
      const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
      return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
  };
}

test("parseNameStatus parses NUL-delimited records verbatim, including T and renames", () => {
  const output = [
    "M",
    "café.txt",
    "T",
    " tab\tname ",
    "R100",
    "old name.txt",
    "new café.txt",
    "A",
    "added.txt",
    "D",
    "gone.txt",
    "",
  ].join("\0");
  assert.deepEqual(parseNameStatus(output), [
    { status: "modified", oldPath: "café.txt", newPath: "café.txt" },
    { status: "modified", oldPath: " tab\tname ", newPath: " tab\tname " },
    { status: "renamed", oldPath: "old name.txt", newPath: "new café.txt" },
    { status: "added", oldPath: null, newPath: "added.txt" },
    { status: "deleted", oldPath: "gone.txt", newPath: null },
  ]);
});

test("name-status callers handle non-ASCII, spaced, renamed, and type-changed paths", async (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "tlh-annotate-git-diff-name-status-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  git(repoRoot, ["init", "-q", "-b", "main"]);
  git(repoRoot, ["config", "user.name", "TLH Test"]);
  git(repoRoot, ["config", "user.email", "tlh@example.com"]);

  writeFileSync(join(repoRoot, "café.txt"), "one\n");
  writeFileSync(join(repoRoot, "with space.txt"), "space\n");
  writeFileSync(join(repoRoot, "old-name.txt"), "rename me\nwith enough content\nto match\n");
  writeFileSync(join(repoRoot, "regular.txt"), "regular\n");
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-q", "-m", "seed"]);

  writeFileSync(join(repoRoot, "café.txt"), "two\n");
  writeFileSync(join(repoRoot, "with space.txt"), "space changed\n");
  git(repoRoot, ["mv", "old-name.txt", "néw name.txt"]);
  unlinkSync(join(repoRoot, "regular.txt"));
  symlinkSync("café.txt", join(repoRoot, "regular.txt"));

  const expected = [
    ["café.txt", "modified"],
    ["néw name.txt", "renamed"],
    ["regular.txt", "modified"],
    ["with space.txt", "modified"],
  ];
  const summarize = (files) => files.map((f) => [f.path, f.worktreeStatus]).sort();

  const reviewData = await getReviewWindowData(createExecApi(), repoRoot);
  const wt = reviewData.commits.find((commit) => commit.kind === "working-tree");
  assert.ok(wt);
  const wtFiles = await getCommitFiles(createExecApi(), repoRoot, wt.sha);
  assert.deepEqual(summarize(wtFiles), expected);

  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", "change"]);
  const sha = git(repoRoot, ["rev-parse", "HEAD"]);
  const committed = await getCommitFiles(createExecApi(), repoRoot, sha);
  assert.deepEqual(
    committed.map((f) => f.path).sort(),
    expected.map(([p]) => p),
  );
  assert.ok(committed.every((f) => !f.path.startsWith('"')));
});
