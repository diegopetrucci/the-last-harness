import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

function runCommand(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result;
}

function createExecApi(env = {}) {
  return {
    exec: async (command, args, options = {}) => {
      const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
      return {
        code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? result.error?.message ?? "",
      };
    },
  };
}

function createNoisyShellEnvironment(t) {
  const home = mkdtempSync(join(tmpdir(), "tlh-annotate-git-diff-home-"));
  const bashEnv = join(home, "bash-env.sh");
  writeFileSync(join(home, ".bash_profile"), "printf '%s\\n' 'TLH_LOGIN_STARTUP_NOISE'\\n");
  writeFileSync(bashEnv, "printf '%s\\n' 'TLH_BASH_ENV_STARTUP_NOISE'\\n");
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const env = { ...process.env, HOME: home, BASH_ENV: bashEnv };
  const loginProbe = spawnSync("bash", ["-lc", "printf '%s\\n' probe"], {
    env,
    encoding: "utf8",
  });
  assert.match(loginProbe.stdout ?? "", /TLH_LOGIN_STARTUP_NOISE/u);
  const envProbe = spawnSync("bash", ["-c", "printf '%s\\n' probe"], {
    env,
    encoding: "utf8",
  });
  assert.match(envProbe.stdout ?? "", /TLH_BASH_ENV_STARTUP_NOISE/u);
  return env;
}

function createSyntheticHead(repoRoot) {
  runCommand("git", ["add", "--", "."], repoRoot);
  const tree = runCommand("git", ["write-tree"], repoRoot).stdout.trim();
  const commit = runCommand("git", ["hash-object", "-t", "commit", "-w", "--stdin"], repoRoot, {
    input: [
      `tree ${tree}`,
      "author TLH Test <tlh@example.com> 1700000000 +0000",
      "committer TLH Test <tlh@example.com> 1700000000 +0000",
      "",
      "synthetic test head",
      "",
    ].join("\n"),
  }).stdout.trim();
  runCommand("git", ["update-ref", "refs/heads/main", commit], repoRoot);
  runCommand("git", ["symbolic-ref", "HEAD", "refs/heads/main"], repoRoot);
  return commit;
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

test(
  "machine-readable diff snapshots ignore noisy login and BASH_ENV startup output",
  { skip: process.platform === "win32" },
  async (t) => {
    const repoRoot = tempFixture(t);
    const noisyEnv = createNoisyShellEnvironment(t);
    const revisionImage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x80]);

    runCommand("git", ["init"], repoRoot);
    writeFileSync(join(repoRoot, "old-name.txt"), "rename me\n");
    writeFileSync(join(repoRoot, "deleted.txt"), "delete me\n");
    writeFileSync(join(repoRoot, "deleted-image.png"), revisionImage);
    const baseRevision = createSyntheticHead(repoRoot);

    renameSync(join(repoRoot, "old-name.txt"), join(repoRoot, "renamed.txt"));
    rmSync(join(repoRoot, "deleted.txt"));
    rmSync(join(repoRoot, "deleted-image.png"));
    writeFileSync(join(repoRoot, "added.txt"), "added file\n");

    const pi = createExecApi(noisyEnv);
    const reviewData = await getReviewWindowData(pi, repoRoot);
    assert.equal(reviewData.branchMergeBaseSha, baseRevision);
    const filesByPath = new Map(reviewData.files.map((file) => [file.path, file]));
    const addedFile = filesByPath.get("added.txt");
    const renamedFile = filesByPath.get("renamed.txt");
    const deletedFile = filesByPath.get("deleted.txt");
    const deletedImageFile = filesByPath.get("deleted-image.png");

    assert.ok(addedFile, "expected added file in review data");
    assert.equal(addedFile.worktreeStatus, "added");
    assert.equal(addedFile.gitDiff?.status, "added");
    assert.ok(renamedFile, "expected renamed file in review data");
    assert.equal(renamedFile.worktreeStatus, "renamed");
    assert.equal(renamedFile.gitDiff?.status, "renamed");
    assert.equal(renamedFile.gitDiff?.oldPath, "old-name.txt");
    assert.equal(renamedFile.gitDiff?.newPath, "renamed.txt");
    assert.ok(deletedFile, "expected deleted file in review data");
    assert.equal(deletedFile.worktreeStatus, "deleted");
    assert.equal(deletedFile.gitDiff?.status, "deleted");
    assert.ok(deletedImageFile, "expected deleted image in review data");

    const imageContents = await loadReviewFileContents(
      pi,
      repoRoot,
      deletedImageFile,
      "branch",
      null,
      reviewData.branchMergeBaseSha,
    );
    assert.equal(imageContents.originalExists, true);
    assert.equal(imageContents.modifiedExists, false);
    assert.equal(
      imageContents.originalPreviewUrl,
      `data:image/png;base64,${revisionImage.toString("base64")}`,
    );
  },
);

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

test(
  "loadReviewFileContents keeps POSIX backslash filenames inside the repository",
  { skip: process.platform === "win32" },
  async (t) => {
    const repoRoot = tempFixture(t);
    const secretRoot = tempFixture(t);
    const secretRootName = basename(secretRoot);
    const externalText = "external text sentinel\n";
    const externalImage = Buffer.from("external image sentinel");
    const actualText = "repository text\n";
    const actualImage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);
    const traversalTextPath = `dir\\..\\..\\${secretRootName}\\outside.txt`;
    const traversalImagePath = `images\\..\\..\\${secretRootName}\\outside.png`;
    const ordinaryBackslashPath = "ordinary\\backslash.txt";

    runCommand("git", ["init"], repoRoot);
    mkdirSync(join(repoRoot, "dir"), { recursive: true });
    mkdirSync(join(repoRoot, "images"), { recursive: true });
    writeFileSync(join(secretRoot, "outside.txt"), externalText);
    writeFileSync(join(secretRoot, "outside.png"), externalImage);
    writeFileSync(join(repoRoot, traversalTextPath), actualText);
    writeFileSync(join(repoRoot, traversalImagePath), actualImage);
    writeFileSync(join(repoRoot, ordinaryBackslashPath), "ordinary backslash content\n");

    const reviewData = await getReviewWindowData(createExecApi(), repoRoot);
    const filesByPath = new Map(reviewData.files.map((file) => [file.path, file]));
    const traversalTextFile = filesByPath.get(traversalTextPath);
    const traversalImageFile = filesByPath.get(traversalImagePath);
    const ordinaryBackslashFile = filesByPath.get(ordinaryBackslashPath);
    assert.ok(traversalTextFile, "expected traversal-like text filename in review data");
    assert.ok(traversalImageFile, "expected traversal-like image filename in review data");
    assert.ok(ordinaryBackslashFile, "expected ordinary backslash filename in review data");

    const textContents = await loadReviewFileContents(
      createExecApi(),
      repoRoot,
      traversalTextFile,
      "all",
    );
    assert.equal(textContents.modifiedExists, true);
    assert.equal(textContents.modifiedContent, actualText);
    assert.notEqual(textContents.modifiedContent, externalText);

    const imageContents = await loadReviewFileContents(
      createExecApi(),
      repoRoot,
      traversalImageFile,
      "all",
    );
    assert.equal(imageContents.modifiedExists, true);
    assert.equal(
      imageContents.modifiedPreviewUrl,
      `data:image/png;base64,${actualImage.toString("base64")}`,
    );
    assert.notEqual(
      imageContents.modifiedPreviewUrl,
      `data:image/png;base64,${externalImage.toString("base64")}`,
    );

    const ordinaryBackslashContents = await loadReviewFileContents(
      createExecApi(),
      repoRoot,
      ordinaryBackslashFile,
      "all",
    );
    assert.equal(ordinaryBackslashContents.modifiedContent, "ordinary backslash content\n");
  },
);

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
