import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const releaseNotesScript = join(repoRoot, "scripts", "release-notes.mjs");

function tempFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tlh-release-notes-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function runReleaseNotes(args = [], env = {}) {
  const childEnv = { ...process.env };
  delete childEnv.GITHUB_REF_NAME;
  delete childEnv.GITHUB_REPOSITORY;
  Object.assign(childEnv, env);
  return spawnSync(process.execPath, [releaseNotesScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: childEnv,
  });
}

test("release-notes prints help and rejects unknown arguments", () => {
  const help = runReleaseNotes(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: node scripts\/release-notes\.mjs/);
  assert.equal(help.stderr, "");

  const unknown = runReleaseNotes(["--wat"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /release-notes: Unknown argument: --wat/);
  assert.equal(unknown.stdout, "");
});

test("release-notes rejects missing and empty option values consistently", () => {
  for (const flag of ["--tag", "--changelog", "--output", "--repository", "--ref"]) {
    const missing = runReleaseNotes([flag]);
    assert.equal(missing.status, 1, `${flag} missing value should fail`);
    assert.match(
      missing.stderr,
      new RegExp(
        `release-notes: ${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} requires a value\\.`,
      ),
    );

    const empty = runReleaseNotes([`${flag}=`]);
    assert.equal(empty.status, 1, `${flag}= should fail`);
    assert.match(
      empty.stderr,
      new RegExp(
        `release-notes: ${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} requires a value\\.`,
      ),
    );
  }
});

test("release-notes uses CLI values over environment defaults", (t) => {
  const root = tempFixture(t);
  const changelogPath = join(root, "CHANGELOG.md");
  writeFileSync(changelogPath, ["## [1.2.3] - 2026-07-18", "", "CLI body", ""].join("\n"));

  const result = runReleaseNotes(
    [
      "--tag=v1.2.3",
      `--changelog=${changelogPath}`,
      "--repository=cli/repo",
      "--ref=refs/tags/v1.2.3",
    ],
    {
      GITHUB_REF_NAME: "v9.9.9",
      GITHUB_REPOSITORY: "env/repo",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^CLI body\n\n---\n\nFull changelog: https:\/\/github.com\/cli\/repo\/blob\/refs\/tags\/v1\.2\.3\/CHANGELOG\.md\n$/,
  );
  assert.equal(result.stderr, "");
});

test("release-notes extracts exactly one bracketed or unbracketed section across CRLF changelogs", (t) => {
  const root = tempFixture(t);
  const changelogPath = join(root, "CHANGELOG.md");
  writeFileSync(
    changelogPath,
    [
      "## [1.2.3] - 2026-07-18",
      "",
      "Bracketed body",
      "",
      "## 1.2.4",
      "- Unbracketed body",
      "",
      "## [1.2.40] - 2026-07-20",
      "",
      "Should not match 1.2.4",
    ].join("\r\n"),
    "utf8",
  );

  const bracketed = runReleaseNotes([`--changelog=${changelogPath}`], {
    GITHUB_REF_NAME: "v1.2.3",
  });
  assert.equal(bracketed.status, 0, bracketed.stderr);
  assert.equal(bracketed.stdout, "Bracketed body\n");

  const unbracketed = runReleaseNotes(["--tag", "v1.2.4", "--changelog", changelogPath]);
  assert.equal(unbracketed.status, 0, unbracketed.stderr);
  assert.equal(unbracketed.stdout, "- Unbracketed body\n");
});

test("release-notes treats version strings literally and rejects malformed headings", (t) => {
  const root = tempFixture(t);
  const literalPath = join(root, "literal.md");
  writeFileSync(
    literalPath,
    ["## [1.2.3+build(7)?.*] - 2026-07-18", "", "Literal version body", "", "##"].join("\n"),
  );

  const literal = runReleaseNotes(["--tag", "v1.2.3+build(7)?.*", "--changelog", literalPath]);
  assert.equal(literal.status, 0, literal.stderr);
  assert.equal(literal.stdout, "Literal version body\n");

  for (const [name, heading] of [
    ["opening-only", "## [1.2.3 - 2026-07-18"],
    ["closing-only", "## 1.2.3] - 2026-07-18"],
    ["split-heading", "##\n[1.2.3] - 2026-07-18"],
  ]) {
    const halfBracketedPath = join(root, `${name}.md`);
    writeFileSync(halfBracketedPath, [heading, "", "Broken heading"].join("\n"));

    const halfBracketed = runReleaseNotes(["--tag", "v1.2.3", "--changelog", halfBracketedPath]);
    assert.equal(halfBracketed.status, 1, `${name} heading should fail`);
    assert.match(halfBracketed.stderr, /missing a section for 1\.2\.3/);
    assert.equal(halfBracketed.stdout, "");
  }
});

test("release-notes rejects missing tags, blank tags, empty v tags, missing sections, and empty sections", (t) => {
  const root = tempFixture(t);
  const changelogPath = join(root, "CHANGELOG.md");
  writeFileSync(
    changelogPath,
    [
      "## [1.2.3] - 2026-07-18",
      "",
      "Filled section",
      "",
      "## [] - 2026-07-18",
      "",
      "Must not be release notes for tag v",
      "",
      "## [1.2.4] - 2026-07-19",
      "",
    ].join("\n"),
  );

  const missingTag = runReleaseNotes(["--changelog", changelogPath]);
  assert.equal(missingTag.status, 1);
  assert.match(missingTag.stderr, /Missing release tag/);

  const blankEnvTag = runReleaseNotes(["--changelog", changelogPath], { GITHUB_REF_NAME: "   " });
  assert.equal(blankEnvTag.status, 1);
  assert.match(blankEnvTag.stderr, /Missing release tag/);

  const emptyVTag = runReleaseNotes(["--tag", "v", "--changelog", changelogPath]);
  assert.equal(emptyVTag.status, 1);
  assert.match(emptyVTag.stderr, /must include a version after any leading v/);

  const blankVTag = runReleaseNotes(["--tag", "v   ", "--changelog", changelogPath]);
  assert.equal(blankVTag.status, 1);
  assert.match(blankVTag.stderr, /must include a version after any leading v/);

  const missingSection = runReleaseNotes(["--tag", "v9.9.9", "--changelog", changelogPath]);
  assert.equal(missingSection.status, 1);
  assert.match(missingSection.stderr, /missing a section for 9\.9\.9/);

  const emptySection = runReleaseNotes(["--tag", "v1.2.4", "--changelog", changelogPath]);
  assert.equal(emptySection.status, 1);
  assert.match(emptySection.stderr, /section for 1\.2\.4 is empty/);
});

test("release-notes writes output files on success and leaves existing files untouched on failure", (t) => {
  const root = tempFixture(t);
  const changelogPath = join(root, "CHANGELOG.md");
  const outputPath = join(root, "notes.md");
  writeFileSync(changelogPath, ["## [1.2.3] - 2026-07-18", "", "Saved body"].join("\n"));

  const success = runReleaseNotes([
    "--tag=v1.2.3",
    `--changelog=${changelogPath}`,
    `--output=${outputPath}`,
  ]);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, "");
  assert.equal(readFileSync(outputPath, "utf8"), "Saved body\n");

  writeFileSync(outputPath, "keep me\n", "utf8");
  const failedBuild = runReleaseNotes([
    "--tag",
    "v9.9.9",
    "--changelog",
    changelogPath,
    "--output",
    outputPath,
  ]);
  assert.equal(failedBuild.status, 1);
  assert.match(failedBuild.stderr, /missing a section for 9\.9\.9/);
  assert.equal(readFileSync(outputPath, "utf8"), "keep me\n");

  const blockedOutputPath = join(root, "missing", "notes.md");
  const failedWrite = runReleaseNotes([
    "--tag",
    "v1.2.3",
    "--changelog",
    changelogPath,
    "--output",
    blockedOutputPath,
  ]);
  assert.equal(failedWrite.status, 1);
  assert.match(failedWrite.stderr, /ENOENT/);
  assert.equal(existsSync(blockedOutputPath), false);
  assert.equal(existsSync(join(root, "missing")), false);
});
