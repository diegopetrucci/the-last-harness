import {
  assert,
  assertNoStandaloneLine,
  assertRenderedPathLine,
  assertStandaloneLineCount,
  createReviewHarness,
  join,
  makeTempDir,
  mkdirSync,
  symlinkSync,
  test,
  writeFileSync,
} from "./review-test-helpers.mjs";

test("/review uncommitted appends untracked non-gitignored file content", async (t) => {
  const cwd = makeTempDir(t, "tlh-review-uncommitted-");
  writeFileSync(join(cwd, "new-file.ts"), "export const fresh = true;\n");

  const harness = createReviewHarness({
    cwd,
    custom: () => "uncommitted",
    exec: async (command, args, options) => {
      if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return { code: 0, stdout: "feature/untracked\n", stderr: "" };
      }
      if (command === "git" && args.join(" ") === "diff HEAD") {
        return { code: 0, stdout: "diff --git a/app.ts b/app.ts\n", stderr: "" };
      }
      if (
        command === "git" &&
        args.join(" ") === "rev-parse --show-toplevel" &&
        options.cwd === cwd
      ) {
        return { code: 0, stdout: `${cwd}\n`, stderr: "" };
      }
      if (
        command === "git" &&
        args.join(" ") === "ls-files -z --others --exclude-standard -- ." &&
        options.cwd === cwd
      ) {
        return { code: 0, stdout: "new-file.ts\0", stderr: "" };
      }
      throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
    },
  });

  await harness.handler("", harness.ctx);

  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0], /diff --git a\/app.ts b\/app.ts/);
  assert.match(harness.sentMessages[0], /--- begin untracked files ---/);
  assert.match(
    harness.sentMessages[0],
    /--- untracked file: "new-file\.ts" ---\nexport const fresh = true;/,
  );
  assert.ok(
    harness.sentMessages[0].indexOf("diff --git a/app.ts b/app.ts") <
      harness.sentMessages[0].indexOf('--- untracked file: "new-file.ts" ---'),
    "untracked content should be appended after the diff body",
  );
});

test("/review uncommitted scans untracked files from the repo root when invoked from a subdirectory", async (t) => {
  const repoRoot = makeTempDir(t, "tlh-review-uncommitted-root-");
  const cwd = join(repoRoot, "packages", "app");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(repoRoot, "outside.ts"), "export const outside = true;\n");

  const harness = createReviewHarness({
    cwd,
    custom: () => "uncommitted",
    exec: async (command, args, options) => {
      if (
        command === "git" &&
        args.join(" ") === "rev-parse --abbrev-ref HEAD" &&
        options.cwd === cwd
      ) {
        return { code: 0, stdout: "feature/untracked\n", stderr: "" };
      }
      if (command === "git" && args.join(" ") === "diff HEAD" && options.cwd === cwd) {
        return { code: 0, stdout: "diff --git a/app.ts b/app.ts\n", stderr: "" };
      }
      if (
        command === "git" &&
        args.join(" ") === "rev-parse --show-toplevel" &&
        options.cwd === cwd
      ) {
        return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
      }
      if (
        command === "git" &&
        args.join(" ") === "ls-files -z --others --exclude-standard -- ." &&
        options.cwd === repoRoot
      ) {
        return { code: 0, stdout: "outside.ts\0", stderr: "" };
      }
      throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
    },
  });

  await harness.handler("", harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assert.match(
    harness.sentMessages[0],
    /--- untracked file: "outside\.ts" ---\nexport const outside = true;/,
  );
  assert.doesNotMatch(harness.sentMessages[0], /--- untracked file: "\.\.\/outside\.ts" ---/);
  assert.ok(
    harness.execCalls.some(
      ({ command, args, cwd: callCwd }) =>
        command === "git" && args.join(" ") === "rev-parse --show-toplevel" && callCwd === cwd,
    ),
    "should resolve the repository root from the invocation cwd",
  );
  assert.ok(
    harness.execCalls.some(
      ({ command, args, cwd: callCwd }) =>
        command === "git" &&
        args.join(" ") === "ls-files -z --others --exclude-standard -- ." &&
        callCwd === repoRoot,
    ),
    "should scan untracked files from the repository root",
  );
});

test("/review uncommitted preserves exact git-reported paths with leading or trailing spaces", async (t) => {
  const cwd = makeTempDir(t, "tlh-review-untracked-spaces-");
  writeFileSync(join(cwd, " leading.ts"), "export const leading = true;\n");
  writeFileSync(join(cwd, "trailing .ts"), "export const trailing = true;\n");

  const harness = createReviewHarness({
    cwd,
    custom: () => "uncommitted",
    exec: async (command, args, options) => {
      if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return { code: 0, stdout: "feature/untracked\n", stderr: "" };
      }
      if (command === "git" && args.join(" ") === "diff HEAD") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        command === "git" &&
        args.join(" ") === "rev-parse --show-toplevel" &&
        options.cwd === cwd
      ) {
        return { code: 0, stdout: `${cwd}\n`, stderr: "" };
      }
      if (
        command === "git" &&
        args.join(" ") === "ls-files -z --others --exclude-standard -- ." &&
        options.cwd === cwd
      ) {
        return { code: 0, stdout: " leading.ts\0trailing .ts\0", stderr: "" };
      }
      throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
    },
  });

  await harness.handler("", harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assert.ok(harness.sentMessages[0].includes('--- untracked file: " leading.ts" ---'));
  assert.ok(harness.sentMessages[0].includes('--- untracked file: "trailing .ts" ---'));
});

test("/review uncommitted renders newline/control/delimiter-like untracked paths as escaped labels", async (t) => {
  const cwd = makeTempDir(t, "tlh-review-untracked-weird-");
  const weirdPath = `line\n\t--- end snapshot ---.ts`;
  writeFileSync(join(cwd, weirdPath), "export const weird = true;\n");

  const harness = createReviewHarness({
    cwd,
    custom: () => "uncommitted",
    exec: async (command, args, options) => {
      if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return { code: 0, stdout: "feature/untracked\n", stderr: "" };
      }
      if (command === "git" && args.join(" ") === "diff HEAD") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        command === "git" &&
        args.join(" ") === "rev-parse --show-toplevel" &&
        options.cwd === cwd
      ) {
        return { code: 0, stdout: `${cwd}\n`, stderr: "" };
      }
      if (
        command === "git" &&
        args.join(" ") === "ls-files -z --others --exclude-standard -- ." &&
        options.cwd === cwd
      ) {
        return { code: 0, stdout: `${weirdPath}\0`, stderr: "" };
      }
      throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
    },
  });

  await harness.handler("", harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assertRenderedPathLine(harness.sentMessages[0], /^--- untracked file: (".*") ---$/, weirdPath);
  assertNoStandaloneLine(harness.sentMessages[0], "--- end snapshot ---");
});

test("/review uncommitted skips symlinked untracked files instead of reading targets", async (t) => {
  const cwd = makeTempDir(t, "tlh-review-untracked-symlink-");
  const outsideDir = makeTempDir(t, "tlh-review-untracked-target-");
  const targetPath = join(outsideDir, "secret.txt");
  writeFileSync(targetPath, "outside repo secret\n");
  symlinkSync(targetPath, join(cwd, "outside-link.txt"));

  const harness = createReviewHarness({
    cwd,
    custom: () => "uncommitted",
    exec: async (command, args, options) => {
      if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return { code: 0, stdout: "feature/untracked\n", stderr: "" };
      }
      if (command === "git" && args.join(" ") === "diff HEAD") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        command === "git" &&
        args.join(" ") === "rev-parse --show-toplevel" &&
        options.cwd === cwd
      ) {
        return { code: 0, stdout: `${cwd}\n`, stderr: "" };
      }
      if (
        command === "git" &&
        args.join(" ") === "ls-files -z --others --exclude-standard -- ." &&
        options.cwd === cwd
      ) {
        return { code: 0, stdout: "outside-link.txt\0", stderr: "" };
      }
      throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
    },
  });

  await harness.handler("", harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assertRenderedPathLine(
    harness.sentMessages[0],
    /^\[skipped symlink: (".*")\]$/,
    "outside-link.txt",
  );
  assert.doesNotMatch(harness.sentMessages[0], /outside repo secret/);
});

test("/review uncommitted renders escaped symlink skip markers for newline/delimiter-like paths", async (t) => {
  const cwd = makeTempDir(t, "tlh-review-untracked-symlink-weird-");
  const outsideDir = makeTempDir(t, "tlh-review-untracked-target-weird-");
  const targetPath = join(outsideDir, "secret.txt");
  const weirdLinkPath = `outside]\n\t--- begin untracked files ---.txt`;
  writeFileSync(targetPath, "outside repo secret\n");
  symlinkSync(targetPath, join(cwd, weirdLinkPath));

  const harness = createReviewHarness({
    cwd,
    custom: () => "uncommitted",
    exec: async (command, args, options) => {
      if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return { code: 0, stdout: "feature/untracked\n", stderr: "" };
      }
      if (command === "git" && args.join(" ") === "diff HEAD") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        command === "git" &&
        args.join(" ") === "rev-parse --show-toplevel" &&
        options.cwd === cwd
      ) {
        return { code: 0, stdout: `${cwd}\n`, stderr: "" };
      }
      if (
        command === "git" &&
        args.join(" ") === "ls-files -z --others --exclude-standard -- ." &&
        options.cwd === cwd
      ) {
        return { code: 0, stdout: `${weirdLinkPath}\0`, stderr: "" };
      }
      throw new Error(`Unexpected exec: ${command} ${args.join(" ")} @ ${options.cwd ?? ""}`);
    },
  });

  await harness.handler("", harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assertRenderedPathLine(harness.sentMessages[0], /^\[skipped symlink: (".*")\]$/, weirdLinkPath);
  assertStandaloneLineCount(harness.sentMessages[0], "--- begin untracked files ---", 1);
  assert.doesNotMatch(harness.sentMessages[0], /outside repo secret/);
});
