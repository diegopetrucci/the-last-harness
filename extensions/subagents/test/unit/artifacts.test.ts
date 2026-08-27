import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  cleanupOldArtifacts,
  getArtifactsDir,
  getProjectArtifactsDir,
  getProjectSubagentsDir,
  writeArtifactWithFloor,
} from "../../src/shared/artifacts.ts";
import { TEMP_ARTIFACTS_DIR } from "../../src/shared/types.ts";

describe("project-local artifact paths", () => {
  it("places generated subagent files under .pi-subagents for a project cwd", () => {
    const cwd = path.join("tmp", "repo");
    assert.equal(getProjectSubagentsDir(cwd), path.join(cwd, ".pi-subagents"));
    assert.equal(getProjectArtifactsDir(cwd), path.join(cwd, ".pi-subagents", "artifacts"));
    assert.equal(getArtifactsDir(null, cwd), path.join(cwd, ".pi-subagents", "artifacts"));
  });

  it("keeps the session artifact fallback when no project cwd is available", () => {
    const sessionFile = path.join("tmp", "sessions", "parent.jsonl");
    assert.equal(getArtifactsDir(sessionFile), path.join("tmp", "sessions", "subagent-artifacts"));
  });

  it("falls back to the shared temp artifact root without a project cwd or session file", () => {
    assert.equal(getArtifactsDir(null), TEMP_ARTIFACTS_DIR);
  });
});

describe("artifact cleanup", () => {
  function withTempDir(fn: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-cleanup-"));
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  function agePath(target: string, ageDays: number): void {
    const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    fs.utimesSync(target, when, when);
  }

  it("removes fully stale nested artifact trees", () => {
    withTempDir((dir) => {
      const tree = path.join(dir, "nested", "progress");
      fs.mkdirSync(tree, { recursive: true });
      const staleFile = path.join(tree, "output.md");
      fs.writeFileSync(staleFile, "stale", "utf8");
      agePath(staleFile, 10);
      agePath(tree, 10);
      agePath(path.dirname(tree), 10);

      cleanupOldArtifacts(dir, 5);

      assert.equal(fs.existsSync(path.join(dir, "nested")), false);
    });
  });

  it("retains nested trees when any descendant is recent", () => {
    withTempDir((dir) => {
      const tree = path.join(dir, "nested", "progress");
      fs.mkdirSync(tree, { recursive: true });
      const staleFile = path.join(tree, "old-output.md");
      const recentFile = path.join(tree, "current-output.md");
      fs.writeFileSync(staleFile, "old", "utf8");
      fs.writeFileSync(recentFile, "recent", "utf8");
      agePath(staleFile, 10);
      agePath(tree, 10);
      agePath(path.dirname(tree), 10);

      cleanupOldArtifacts(dir, 5);

      assert.equal(fs.existsSync(path.join(dir, "nested")), true);
      assert.equal(fs.existsSync(staleFile), true);
      assert.equal(fs.existsSync(recentFile), true);
    });
  });

  it(
    "retains nested trees when a descendant cannot be inspected",
    { skip: process.platform === "win32" },
    () => {
      withTempDir((dir) => {
        const tree = path.join(dir, "nested", "progress");
        fs.mkdirSync(tree, { recursive: true });
        const staleFile = path.join(tree, "output.md");
        fs.writeFileSync(staleFile, "stale", "utf8");
        agePath(staleFile, 10);
        agePath(tree, 10);
        agePath(path.dirname(tree), 10);
        fs.chmodSync(tree, 0o000);

        try {
          cleanupOldArtifacts(dir, 5);
        } finally {
          fs.chmodSync(tree, 0o700);
        }

        assert.equal(fs.existsSync(path.join(dir, "nested")), true);
        assert.equal(fs.existsSync(staleFile), true);
      });
    },
  );

  it(
    "does not traverse or delete external symlink targets when removing stale trees",
    {
      skip: typeof fs.symlinkSync !== "function" || typeof fs.lutimesSync !== "function",
    },
    () => {
      withTempDir((dir) => {
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-external-"));
        try {
          const externalFile = path.join(externalRoot, "keep.txt");
          fs.writeFileSync(externalFile, "keep", "utf8");

          const tree = path.join(dir, "nested");
          fs.mkdirSync(tree, { recursive: true });
          const linkPath = path.join(tree, "outside-link");
          fs.symlinkSync(externalRoot, linkPath, "dir");
          agePath(tree, 10);
          fs.lutimesSync(
            linkPath,
            new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
            new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
          );

          cleanupOldArtifacts(dir, 5);

          assert.equal(fs.existsSync(tree), false);
          assert.equal(fs.existsSync(externalRoot), true);
          assert.equal(fs.readFileSync(externalFile, "utf8"), "keep");
        } finally {
          fs.rmSync(externalRoot, { recursive: true, force: true });
        }
      });
    },
  );
});

// These writeArtifactWithFloor tests are the discriminating coverage for the
// non-destruction floor (tlhm-76ph). The integration tests that exercise the
// digest-surfacing path do NOT discriminate on the floor: in those cases the
// raw and computed values are identical, so removing the floor does not change
// their outcome. Do not delete these unit tests assuming integration covers it.
describe("writeArtifactWithFloor", () => {
  function withTempDir(fn: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-floor-"));
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // The incident's own shape: raw output has real prose, computed content is
  // exactly "---" (the 3-byte value observed in destroyed artifacts).
  // This test fails if the floor is removed from writeArtifactWithFloor.
  it('preserves raw output when computed content is the incident "---" value', () => {
    withTempDir((dir) => {
      const filePath = path.join(dir, "output.md");
      writeArtifactWithFloor(filePath, "---", "My implementation report\n\nFound 3 issues.", false);
      assert.equal(
        fs.readFileSync(filePath, "utf-8"),
        "My implementation report\n\nFound 3 issues.",
      );
    });
  });

  // Positive control: a healthy computed value must be written byte-exact and
  // must NOT be replaced by the raw output. If the floor fired unconditionally
  // this test would fail.
  it("writes computed content byte-exact when it is not effectively empty", () => {
    withTempDir((dir) => {
      const filePath = path.join(dir, "output.md");
      const computed =
        "Implementation complete.\n\n---\nValidation evidence (from acceptance report):\n\n  [passed] npm test \u2014 passed\n---";
      writeArtifactWithFloor(
        filePath,
        computed,
        "Implementation complete.\n\n```acceptance-report\n{...}\n```",
        false,
      );
      assert.equal(fs.readFileSync(filePath, "utf-8"), computed);
    });
  });

  it("writes computed content byte-exact even when it is empty and isArchive is true", () => {
    withTempDir((dir) => {
      const filePath = path.join(dir, "output.md");
      writeArtifactWithFloor(filePath, "---", "non-empty raw output", true);
      assert.equal(fs.readFileSync(filePath, "utf-8"), "---");
    });
  });

  it("preserves whitespace-only computed content as empty rather than injecting raw", () => {
    withTempDir((dir) => {
      const filePath = path.join(dir, "output.md");
      // raw is also whitespace-only — floor must not fire (rawOutput.trim() is falsy)
      writeArtifactWithFloor(filePath, "", "", false);
      assert.equal(fs.readFileSync(filePath, "utf-8"), "");
    });
  });

  it("preserves raw output when computed content is whitespace-only", () => {
    withTempDir((dir) => {
      const filePath = path.join(dir, "output.md");
      writeArtifactWithFloor(filePath, "   \n", "substantive findings", false);
      assert.equal(fs.readFileSync(filePath, "utf-8"), "substantive findings");
    });
  });
});
