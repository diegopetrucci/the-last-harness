import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { MAX_ASYNC_STATUS_BYTES, readStatus } from "../../src/shared/utils.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

function status(runId: string): Record<string, unknown> {
  return {
    runId,
    mode: "single",
    state: "running",
    startedAt: 1,
  };
}

function writeStatus(statusPath: string, runId: string): void {
  fs.writeFileSync(statusPath, JSON.stringify(status(runId)), "utf-8");
}

describe("readStatus", () => {
  it("reads regular files, preserves cache behavior, and reports malformed or missing files", () => {
    const root = createTempDir("tlh-read-status-unit-");
    const asyncDir = path.join(root, "run");
    const statusPath = path.join(asyncDir, "status.json");
    fs.mkdirSync(asyncDir);
    try {
      writeStatus(statusPath, "regular");
      const first = readStatus(asyncDir);
      assert.equal(first?.runId, "regular");
      assert.strictEqual(readStatus(asyncDir), first);

      fs.writeFileSync(statusPath, JSON.stringify({ state: "running", legacy: true }), "utf-8");
      assert.equal(readStatus(asyncDir)?.state, "running");

      fs.unlinkSync(statusPath);
      assert.equal(readStatus(asyncDir), null);

      writeStatus(statusPath, "malformed");
      fs.writeFileSync(statusPath, "{not-json", "utf-8");
      assert.throws(() => readStatus(asyncDir), /Failed to parse async status file/);
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects oversized regular files without changing the artifact", () => {
    const root = createTempDir("tlh-read-status-oversize-");
    const asyncDir = path.join(root, "run");
    const statusPath = path.join(asyncDir, "status.json");
    fs.mkdirSync(asyncDir);
    const content = Buffer.alloc(MAX_ASYNC_STATUS_BYTES + 1, 0x78);
    try {
      fs.writeFileSync(statusPath, content);
      assert.throws(() => readStatus(asyncDir), /Failed to read async status file/);
      assert.deepEqual(fs.readFileSync(statusPath), content);
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects a FIFO promptly without a writer and leaves it untouched", () => {
    if (process.platform === "win32") return;

    const root = createTempDir("tlh-read-status-fifo-");
    const asyncDir = path.join(root, "run");
    const statusPath = path.join(asyncDir, "status.json");
    fs.mkdirSync(asyncDir);
    try {
      execFileSync("mkfifo", [statusPath]);
      const startedAt = Date.now();
      assert.throws(() => readStatus(asyncDir), /Failed to read async status file/);
      assert.ok(Date.now() - startedAt < 1_000, "FIFO read should not block");
      assert.equal(fs.lstatSync(statusPath).isFIFO(), true);
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects symlink and directory status paths without touching them", () => {
    if (process.platform === "win32") return;

    const root = createTempDir("tlh-read-status-non-regular-");
    const symlinkDir = path.join(root, "symlink-run");
    const symlinkPath = path.join(symlinkDir, "status.json");
    const targetPath = path.join(root, "target.json");
    const directoryDir = path.join(root, "directory-run");
    const directoryPath = path.join(directoryDir, "status.json");
    fs.mkdirSync(symlinkDir);
    fs.mkdirSync(directoryDir);
    writeStatus(targetPath, "target");
    fs.symlinkSync(targetPath, symlinkPath);
    fs.mkdirSync(directoryPath);
    try {
      const targetBefore = fs.readFileSync(targetPath);
      assert.throws(() => readStatus(symlinkDir), /Failed to read async status file/);
      assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
      assert.deepEqual(fs.readFileSync(targetPath), targetBefore);

      assert.throws(() => readStatus(directoryDir), /Failed to read async status file/);
      assert.equal(fs.lstatSync(directoryPath).isDirectory(), true);
      assert.deepEqual(fs.readdirSync(directoryPath), []);
    } finally {
      removeTempDir(root);
    }
  });

  it("reads from the opened descriptor after the path is replaced", () => {
    if (process.platform === "win32") return;

    const root = createTempDir("tlh-read-status-toctou-");
    const asyncDir = path.join(root, "run");
    const statusPath = path.join(asyncDir, "status.json");
    const displacedPath = path.join(root, "displaced.json");
    fs.mkdirSync(asyncDir);
    writeStatus(statusPath, "original");
    const originalContent = fs.readFileSync(statusPath);
    const replacementContent = JSON.stringify(status("replacement"));
    let replaced = false;
    const originalReadSync = fsDefault.readSync;
    fsDefault.readSync = ((fd, buffer, offset, length, position) => {
      if (!replaced) {
        fs.renameSync(statusPath, displacedPath);
        fs.writeFileSync(statusPath, replacementContent, "utf-8");
        replaced = true;
      }
      return originalReadSync(fd, buffer, offset, length, position);
    }) as typeof fsDefault.readSync;
    syncBuiltinESMExports();
    try {
      const first = readStatus(asyncDir);
      assert.equal(first?.runId, "original");
      assert.deepEqual(fs.readFileSync(displacedPath), originalContent);
      assert.equal(JSON.parse(fs.readFileSync(statusPath, "utf-8")).runId, "replacement");
      assert.equal(readStatus(asyncDir)?.runId, "replacement");
    } finally {
      fsDefault.readSync = originalReadSync;
      syncBuiltinESMExports();
      removeTempDir(root);
    }
  });
});
