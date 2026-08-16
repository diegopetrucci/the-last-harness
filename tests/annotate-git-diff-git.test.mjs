import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { __testing, getCommitFiles, getReviewWindowData, loadReviewFileContents } =
  await jiti.import("../extensions/annotate-git-diff/git.ts");
const { parseStatusPorcelainZ, shouldNormalizeBranchChanges } = __testing;

function tempFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "tlh-annotate-git-diff-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result;
}

function createExecApi() {
  return {
    exec: async (command, args, options = {}) => {
      const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
      });
      return {
        code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? result.error?.message ?? "",
      };
    },
  };
}

test("parseStatusPorcelainZ tracks reviewable changes and ignores ignored files", () => {
  assert.deepEqual(
    parseStatusPorcelainZ(
      [
        "?? scratch/new-file.txt",
        "D  tracked.txt",
        "R  renamed.txt",
        "old-name.txt",
        "!! ignored.log",
        "",
      ].join("\0"),
    ),
    {
      hasChanges: true,
      hasReviewableChanges: true,
      hasUntracked: true,
      hasTrackedDeletions: true,
      hasRenames: true,
      untrackedPaths: ["scratch/new-file.txt"],
    },
  );
});

test("shouldNormalizeBranchChanges only enables snapshot normalization when needed", () => {
  const modifiedChange = [{ status: "modified", oldPath: "tracked.txt", newPath: "tracked.txt" }];
  const deletedChange = [{ status: "deleted", oldPath: "tracked.txt", newPath: null }];

  assert.equal(
    shouldNormalizeBranchChanges(modifiedChange, {
      hasChanges: true,
      hasReviewableChanges: true,
      hasUntracked: false,
      hasTrackedDeletions: false,
      hasRenames: true,
      untrackedPaths: [],
    }),
    true,
  );
  assert.equal(
    shouldNormalizeBranchChanges(deletedChange, {
      hasChanges: true,
      hasReviewableChanges: true,
      hasUntracked: true,
      hasTrackedDeletions: true,
      hasRenames: false,
      untrackedPaths: ["scratch/new-file.txt"],
    }),
    true,
  );
  assert.equal(
    shouldNormalizeBranchChanges(modifiedChange, {
      hasChanges: true,
      hasReviewableChanges: true,
      hasUntracked: true,
      hasTrackedDeletions: false,
      hasRenames: false,
      untrackedPaths: ["scratch/new-file.txt"],
    }),
    false,
  );
});

test("getReviewWindowData includes tracked and untracked minified files in all-files scope", async (t) => {
  const repoRoot = tempFixture(t);
  runCommand("git", ["init"], repoRoot);
  runCommand("git", ["config", "user.name", "TLH Test"], repoRoot);
  runCommand("git", ["config", "user.email", "tlh@example.com"], repoRoot);

  mkdirSync(join(repoRoot, "assets"), { recursive: true });
  mkdirSync(join(repoRoot, "styles"), { recursive: true });
  mkdirSync(join(repoRoot, "images"), { recursive: true });
  writeFileSync(join(repoRoot, "assets", "app.min.js"), "console.log('tracked');\n");
  writeFileSync(join(repoRoot, "styles", "site.min.css"), "body{color:black}\n");
  writeFileSync(join(repoRoot, "images", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  runCommand("git", ["add", "."], repoRoot);
  runCommand("git", ["commit", "-m", "seed repo"], repoRoot);

  mkdirSync(join(repoRoot, "scratch"), { recursive: true });
  writeFileSync(join(repoRoot, "scratch", "vendor.min.js"), "console.log('untracked');\n");
  writeFileSync(join(repoRoot, "scratch", "theme.min.css"), ".app{display:block}\n");

  const reviewData = await getReviewWindowData(createExecApi(), repoRoot);
  const filesByPath = new Map(reviewData.files.map((file) => [file.path, file]));

  for (const path of [
    "assets/app.min.js",
    "styles/site.min.css",
    "scratch/vendor.min.js",
    "scratch/theme.min.css",
  ]) {
    assert.ok(filesByPath.has(path), `expected all-files scope to include ${path}`);
    assert.equal(filesByPath.get(path)?.kind, "text");
  }

  assert.equal(filesByPath.get("images/logo.png")?.kind, "image");
  assert.ok(reviewData.commits.some((commit) => commit.kind === "working-tree"));
});

test("getReviewWindowData surfaces working tree files in repositories without HEAD", async (t) => {
  const repoRoot = tempFixture(t);
  runCommand("git", ["init"], repoRoot);
  writeFileSync(join(repoRoot, "notes.txt"), "draft review\n");

  const reviewData = await getReviewWindowData(createExecApi(), repoRoot);
  assert.equal(reviewData.repositoryHasHead, false);
  assert.equal(reviewData.branchBaseRef, null);
  assert.equal(reviewData.branchMergeBaseSha, null);
  assert.deepEqual(
    reviewData.files.map((file) => file.path),
    ["notes.txt"],
  );
  assert.equal(reviewData.files[0]?.kind, "text");
  assert.equal(reviewData.files[0]?.worktreeStatus, "added");
  assert.deepEqual(
    reviewData.commits.map((commit) => commit.kind),
    ["working-tree"],
  );
});

test("getReviewWindowData returns no files or commits for an empty repository without HEAD", async (t) => {
  const repoRoot = tempFixture(t);
  runCommand("git", ["init"], repoRoot);

  const reviewData = await getReviewWindowData(createExecApi(), repoRoot);
  assert.equal(reviewData.repositoryHasHead, false);
  assert.deepEqual(reviewData.files, []);
  assert.deepEqual(reviewData.commits, []);
});

test("getCommitFiles returns an empty list for an invalid commit sha", async (t) => {
  const repoRoot = tempFixture(t);
  runCommand("git", ["init"], repoRoot);
  runCommand("git", ["config", "user.name", "TLH Test"], repoRoot);
  runCommand("git", ["config", "user.email", "tlh@example.com"], repoRoot);
  writeFileSync(join(repoRoot, "tracked.txt"), "seed\n");
  runCommand("git", ["add", "tracked.txt"], repoRoot);
  runCommand("git", ["commit", "-m", "seed repo"], repoRoot);

  assert.deepEqual(await getCommitFiles(createExecApi(), repoRoot, "not-a-real-sha"), []);
});

test("loadReviewFileContents returns empty contents when commit or branch context is missing", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "tlh-annotate-git-diff-contents-"));
  try {
    const file = {
      id: "file-1",
      path: "notes.txt",
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      gitDiff: {
        status: "modified",
        oldPath: "notes.txt",
        newPath: "notes.txt",
        displayPath: "notes.txt",
        hasOriginal: true,
        hasModified: true,
      },
      kind: "text",
      mimeType: null,
    };

    assert.deepEqual(await loadReviewFileContents(createExecApi(), repoRoot, file, "commits"), {
      originalContent: "",
      modifiedContent: "",
      kind: "text",
      mimeType: null,
      originalExists: false,
      modifiedExists: false,
      originalPreviewUrl: null,
      modifiedPreviewUrl: null,
    });
    assert.deepEqual(await loadReviewFileContents(createExecApi(), repoRoot, file, "branch"), {
      originalContent: "",
      modifiedContent: "",
      kind: "text",
      mimeType: null,
      originalExists: false,
      modifiedExists: false,
      originalPreviewUrl: null,
      modifiedPreviewUrl: null,
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("loadReviewFileContents does not follow tracked working-tree symlinks for text files", async (t) => {
  const repoRoot = tempFixture(t);
  const secretRoot = tempFixture(t);
  const secretContent = "do-not-read-this-secret\n";
  const secretPath = join(secretRoot, "secret.txt");

  runCommand("git", ["init"], repoRoot);
  runCommand("git", ["config", "user.name", "TLH Test"], repoRoot);
  runCommand("git", ["config", "user.email", "tlh@example.com"], repoRoot);
  writeFileSync(secretPath, secretContent);
  symlinkSync(secretPath, join(repoRoot, "tracked.txt"));
  runCommand("git", ["add", "tracked.txt"], repoRoot);
  runCommand("git", ["commit", "-m", "seed repo"], repoRoot);

  const reviewData = await getReviewWindowData(createExecApi(), repoRoot);
  const trackedFile = reviewData.files.find((file) => file.path === "tracked.txt");
  assert.ok(trackedFile, "expected tracked.txt in review data");
  assert.equal(trackedFile.hasWorkingTreeFile, true);

  const contents = await loadReviewFileContents(createExecApi(), repoRoot, trackedFile, "all");
  assert.equal(contents.originalExists, true);
  assert.equal(contents.modifiedExists, true);
  assert.notEqual(contents.originalContent, secretContent);
  assert.notEqual(contents.modifiedContent, secretContent);
  assert.match(contents.originalContent, /symlink/i);
  assert.match(contents.modifiedContent, /symlink/i);
});

test("loadReviewFileContents does not follow untracked working-tree symlinks for image files", async (t) => {
  const repoRoot = tempFixture(t);
  const secretRoot = tempFixture(t);
  const secretPath = join(secretRoot, "secret.png");

  runCommand("git", ["init"], repoRoot);
  runCommand("git", ["config", "user.name", "TLH Test"], repoRoot);
  runCommand("git", ["config", "user.email", "tlh@example.com"], repoRoot);
  writeFileSync(join(repoRoot, "README.md"), "seed\n");
  runCommand("git", ["add", "README.md"], repoRoot);
  runCommand("git", ["commit", "-m", "seed repo"], repoRoot);

  mkdirSync(join(repoRoot, "images"), { recursive: true });
  writeFileSync(secretPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  symlinkSync(secretPath, join(repoRoot, "images", "leak.png"));

  const reviewData = await getReviewWindowData(createExecApi(), repoRoot);
  const imageFile = reviewData.files.find((file) => file.path === "images/leak.png");
  assert.ok(imageFile, "expected images/leak.png in review data");
  assert.equal(imageFile.kind, "image");
  assert.equal(imageFile.hasWorkingTreeFile, true);

  const allContents = await loadReviewFileContents(createExecApi(), repoRoot, imageFile, "all");
  assert.equal(allContents.kind, "image");
  assert.equal(allContents.modifiedExists, true);
  assert.equal(allContents.modifiedPreviewUrl, null);

  const branchContents = await loadReviewFileContents(
    createExecApi(),
    repoRoot,
    imageFile,
    "branch",
    null,
    reviewData.branchMergeBaseSha,
  );
  assert.equal(branchContents.originalExists, false);
  assert.equal(branchContents.modifiedExists, true);
  assert.equal(branchContents.modifiedPreviewUrl, null);

  const workingTreeCommitSha = reviewData.commits.find(
    (commit) => commit.kind === "working-tree",
  )?.sha;
  assert.ok(workingTreeCommitSha, "expected working tree commit in review data");
  const commitFiles = await getCommitFiles(createExecApi(), repoRoot, workingTreeCommitSha);
  const commitFile = commitFiles.find((file) => file.path === "images/leak.png");
  assert.ok(commitFile, "expected images/leak.png in working tree commit files");

  const commitContents = await loadReviewFileContents(
    createExecApi(),
    repoRoot,
    commitFile,
    "commits",
    workingTreeCommitSha,
  );
  assert.equal(commitContents.originalExists, false);
  assert.equal(commitContents.modifiedExists, true);
  assert.equal(commitContents.modifiedPreviewUrl, null);
});
