import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const installStateScript = join(repoRoot, "scripts", "tlh-install-state.mjs");

function tempFixture() {
  const dir = mkdtempSync(join(tmpdir(), "tlh-install-state-test-"));
  const agentDir = join(dir, "agent");
  const statePath = join(agentDir, "tlh", "install-state.json");
  const binDir = join(dir, "bin");
  return { dir, agentDir, statePath, binDir };
}

function runInstallState(fixture, extraArgs = []) {
  return execFileSync(
    process.execPath,
    [
      installStateScript,
      "--state-path",
      fixture.statePath,
      "--repo",
      "diegopetrucci/the-last-harness",
      "--ref",
      "main",
      "--track",
      "ref",
      "--package-source",
      "git:github.com/diegopetrucci/the-last-harness@main",
      "--package-source-is-default",
      "true",
      "--raw-base",
      "https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main",
      "--agent-dir",
      fixture.agentDir,
      "--bin-dir",
      fixture.binDir,
      "--wrapper-name",
      "tlh",
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("tlh-install-state dry-run reports the write without creating install-state.json", () => {
  const fixture = tempFixture();

  const output = runInstallState(fixture, ["--pi-installed-by-tlh", "false", "--dry-run"]);

  assert.match(output, /Would write tlh update metadata:/);
  assert.equal(existsSync(fixture.statePath), false);
});

test("tlh-install-state accepts a hyphen-leading installed commit subject", () => {
  const fixture = tempFixture();

  runInstallState(fixture, ["--commit-subject=-Record the installed commit subject"]);

  assert.equal(readJson(fixture.statePath).commitSubject, "-Record the installed commit subject");
});

test("tlh-install-state preserves install-state file mode when overwriting", () => {
  const fixture = tempFixture();
  mkdirSync(join(fixture.agentDir, "tlh"), { recursive: true });
  writeFileSync(fixture.statePath, "{}\n", { mode: 0o640 });
  chmodSync(fixture.statePath, 0o640);

  runInstallState(fixture, ["--pi-installed-by-tlh", "true"]);

  const state = readJson(fixture.statePath);
  assert.equal(state.repo, "diegopetrucci/the-last-harness");
  assert.equal(state.piInstalledByTlh, true);
  assert.equal(lstatSync(fixture.statePath).mode & 0o777, 0o640);
});

test("tlh-install-state refuses to write install-state outside the isolated tlh profile", () => {
  const fixture = tempFixture();
  const outsideStatePath = join(fixture.dir, "outside-install-state.json");

  const result = spawnSync(
    process.execPath,
    [
      installStateScript,
      "--state-path",
      outsideStatePath,
      "--repo",
      "diegopetrucci/the-last-harness",
      "--ref",
      "main",
      "--track",
      "ref",
      "--package-source",
      "git:github.com/diegopetrucci/the-last-harness@main",
      "--package-source-is-default",
      "true",
      "--raw-base",
      "https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main",
      "--agent-dir",
      fixture.agentDir,
      "--bin-dir",
      fixture.binDir,
      "--wrapper-name",
      "tlh",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing unsafe TLH install state/);
  assert.equal(existsSync(outsideStatePath), false);
});
