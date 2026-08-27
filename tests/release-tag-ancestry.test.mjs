import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const workflowPath = join(repoRoot, ".github", "workflows", "release.yml");
const ancestryScript = join(repoRoot, "scripts", "check-release-tag-ancestry.mjs");

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim();
}

function createRepository(t) {
  const root = mkdtempSync(join(tmpdir(), "tlh-release-tag-ancestry-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.email", "tlh-tests@example.invalid"]);
  runGit(root, ["config", "user.name", "TLH Tests"]);

  writeFileSync(join(root, "state.txt"), "initial\n");
  runGit(root, ["add", "state.txt"]);
  runGit(root, ["commit", "-m", "initial"]);
  const initialCommit = runGit(root, ["rev-parse", "HEAD"]);
  runGit(root, ["update-ref", "refs/remotes/origin/main", initialCommit]);

  return { root, initialCommit };
}

function commitChange(root, content, message) {
  writeFileSync(join(root, "state.txt"), `${content}\n`);
  runGit(root, ["add", "state.txt"]);
  runGit(root, ["commit", "-m", message]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

function runAncestryCheck(root, commit, env = {}) {
  return spawnSync(process.execPath, [ancestryScript], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REF_NAME: "v1.2.3",
      GITHUB_SHA: commit,
      ...env,
    },
  });
}

test("release commit ancestry check passes for a commit reachable from origin/main", (t) => {
  const fixture = createRepository(t);
  const mainCommit = commitChange(fixture.root, "main", "main change");
  runGit(fixture.root, ["update-ref", "refs/remotes/origin/main", mainCommit]);

  const result = runAncestryCheck(fixture.root, mainCommit);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /is reachable from origin\/main/);
  assert.equal(result.stderr, "");
});

test("release commit ancestry check rejects a tag commit outside origin/main", (t) => {
  const fixture = createRepository(t);
  runGit(fixture.root, ["checkout", "-b", "release"]);
  const releaseCommit = commitChange(fixture.root, "release", "release-only change");
  runGit(fixture.root, ["checkout", "main"]);
  const mainCommit = commitChange(fixture.root, "main", "main-only change");
  runGit(fixture.root, ["update-ref", "refs/remotes/origin/main", mainCommit]);

  const result = runAncestryCheck(fixture.root, releaseCommit);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Release commit .* is not reachable from origin\/main/);
  assert.equal(result.stdout, "");
});

test("release commit ancestry check fails closed when origin/main is unavailable", (t) => {
  const fixture = createRepository(t);
  runGit(fixture.root, ["update-ref", "-d", "refs/remotes/origin/main"]);

  const result = runAncestryCheck(fixture.root, fixture.initialCommit);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unable to verify release commit ancestry/);
});

test("release workflow gates install, validation, packaging, and publication on ancestry", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const ancestry = workflow.indexOf("node scripts/check-release-tag-ancestry.mjs");
  const install = workflow.indexOf("run: npm ci");
  const validation = workflow.indexOf("run: npm run validate");
  const packaging = workflow.indexOf("npm pack --json");
  const publication = workflow.indexOf("gh release create");

  assert.ok(ancestry >= 0, "release workflow must invoke the ancestry check");
  assert.ok(install > ancestry, "ancestry check must precede dependency installation");
  assert.ok(validation > ancestry, "ancestry check must precede validation");
  assert.ok(packaging > ancestry, "ancestry check must precede packaging");
  assert.ok(publication > ancestry, "ancestry check must precede publication");
});
