import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  for (const flag of ["--tag", "--notes-dir", "--output", "--repository", "--ref"]) {
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

function notesFixture(t, files) {
  const root = tempFixture(t);
  const dir = join(root, "release-notes");
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return { root, dir };
}

test("release-notes builds the body from the notes file with CLI values over env defaults", (t) => {
  const { dir } = notesFixture(t, { "v1.2.3.md": "## Highlights\n\n- CLI body.\n\n" });
  const result = runReleaseNotes(
    ["--tag=v1.2.3", `--notes-dir=${dir}`, "--repository=cli/repo", "--ref=refs/tags/v1.2.3"],
    { GITHUB_REF_NAME: "v9.9.9", GITHUB_REPOSITORY: "env/repo" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "## Highlights\n\n- CLI body.\n\n---\n\nFull changelog: https://github.com/cli/repo/blob/refs/tags/v1.2.3/CHANGELOG.md\n",
  );
});

test("release-notes uses GITHUB_REF_NAME, strips CRLF, and omits footer without repository", (t) => {
  const { dir } = notesFixture(t, { "v1.2.3.md": "- One.\r\n- Two.\r\n" });
  const result = runReleaseNotes([`--notes-dir=${dir}`], { GITHUB_REF_NAME: "v1.2.3" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "- One.\n- Two.\n");
});

test("release-notes fails without CHANGELOG fallback for missing, empty, and bad tags", (t) => {
  const { root, dir } = notesFixture(t, { "v1.2.4.md": " \n\n" });
  writeFileSync(join(root, "CHANGELOG.md"), "## [1.2.3] - 2026-07-18\n\nChangelog body\n");

  const missing = runReleaseNotes(["--tag", "v1.2.3", "--notes-dir", dir]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing release notes file .*v1\.2\.3\.md/);
  assert.equal(missing.stdout, "");

  const empty = runReleaseNotes(["--tag", "v1.2.4", "--notes-dir", dir]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /v1\.2\.4\.md is empty/);

  const noTag = runReleaseNotes(["--notes-dir", dir]);
  assert.equal(noTag.status, 1);
  assert.match(noTag.stderr, /Missing release tag/);

  const bareV = runReleaseNotes(["--tag", "v", "--notes-dir", dir]);
  assert.equal(bareV.status, 1);
  assert.match(bareV.stderr, /must include a version after any leading v/);
});

test("release-notes writes output on success and leaves existing output on failure", (t) => {
  const { root, dir } = notesFixture(t, { "v1.2.3.md": "Saved body.\n" });
  const outputPath = join(root, "notes.md");

  const success = runReleaseNotes(["--tag=v1.2.3", `--notes-dir=${dir}`, `--output=${outputPath}`]);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, "");
  assert.equal(readFileSync(outputPath, "utf8"), "Saved body.\n");

  writeFileSync(outputPath, "keep me\n");
  const failed = runReleaseNotes(["--tag", "v9.9.9", "--notes-dir", dir, "--output", outputPath]);
  assert.equal(failed.status, 1);
  assert.equal(readFileSync(outputPath, "utf8"), "keep me\n");

  const blocked = join(root, "missing", "notes.md");
  const failedWrite = runReleaseNotes(["--tag", "v1.2.3", "--notes-dir", dir, "--output", blocked]);
  assert.equal(failedWrite.status, 1);
  assert.match(failedWrite.stderr, /ENOENT/);
  assert.equal(existsSync(blocked), false);
});

test("release-notes --check passes with zero files, a missing dir, and valid files", (t) => {
  const empty = notesFixture(t, { "README.md": "no heading and mid sentence" });
  const zero = runReleaseNotes(["--check", "--notes-dir", empty.dir]);
  assert.equal(zero.status, 0, zero.stderr);

  const absent = runReleaseNotes(["--check", "--notes-dir", join(empty.root, "nope")]);
  assert.equal(absent.status, 0, absent.stderr);

  const valid = notesFixture(t, {
    "v1.0.0.md": "- Added a thing.\n",
    "v1.0.1.md": "Intro.\n\n## Heading\n\n```sh\ntlh\n```\n",
    "v1.0.2.md": "- Item\n\n## Trailing heading\n",
  });
  const ok = runReleaseNotes(["--check", "--notes-dir", valid.dir]);
  assert.equal(ok.status, 0, ok.stderr);
});

test("release-notes --check reports every invalid file", (t) => {
  const { dir } = notesFixture(t, {
    "v1.0.0.md": "\n  \n",
    "v1.0.1.md": "Plain prose without structure.\n",
    "v1.0.2.md": "- Item that stops mid\n",
    "v1.0.3.md": "- Fine.\n",
  });
  const result = runReleaseNotes(["--check", "--notes-dir", dir]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /v1\.0\.0\.md is empty/);
  assert.match(result.stderr, /v1\.0\.1\.md contains no markdown heading or list item/);
  assert.match(result.stderr, /v1\.0\.2\.md ends mid-sentence/);
  assert.doesNotMatch(result.stderr, /v1\.0\.3/);
});

test("release-notes --check judges the last line by punctuation after closing delimiters", (t) => {
  const passing = notesFixture(t, {
    "v1.0.0.md": "- **Bold.**\n",
    "v1.0.1.md": "- The status now says \u201cReady.\u201d\n",
    "v1.0.2.md": "- Use `/tokens`\n",
  });
  const ok = runReleaseNotes(["--check", "--notes-dir", passing.dir]);
  assert.equal(ok.status, 0, ok.stderr);

  const failing = notesFixture(t, {
    "v1.0.0.md": "- You can now **configure updates**\n",
    "v1.0.1.md": "- Something changed \u2014 no\n",
  });
  const bad = runReleaseNotes(["--check", "--notes-dir", failing.dir]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /v1\.0\.0\.md ends mid-sentence/);
  assert.match(bad.stderr, /v1\.0\.1\.md ends mid-sentence/);
});
