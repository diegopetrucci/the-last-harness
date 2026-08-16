import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  quarantineCorruptAsyncRun,
  QUARANTINED_ASYNC_RUNS_DIRNAME,
  type AsyncStatusQuarantineFs,
} from "../../src/runs/background/async-status-quarantine.ts";
import { fingerprintAsyncStatusContent } from "../../src/runs/background/async-status-corruption.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

function createAsyncRoot(baseDir: string): string {
  const asyncRoot = path.join(baseDir, "async-subagent-runs");
  fs.mkdirSync(asyncRoot, { recursive: true });
  return asyncRoot;
}

function createIssue(
  asyncRoot: string,
  entry: string,
  content: string,
  kind: "json_parse" | "persisted_validation",
) {
  const asyncDir = path.join(asyncRoot, entry);
  const statusPath = path.join(asyncDir, "status.json");
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(statusPath, content, "utf-8");
  return {
    entry,
    asyncDir,
    statusPath,
    kind,
    message: `${kind} fixture`,
    fingerprint: fingerprintAsyncStatusContent(content),
  };
}

function createStableStatFs(statusPath: string): AsyncStatusQuarantineFs {
  const stableStat = fs.statSync(statusPath);
  return {
    statSync: () => stableStat,
    readFileSync: fs.readFileSync,
    mkdirSync: fs.mkdirSync,
    renameSync: fs.renameSync,
  };
}

describe("async status quarantine helper", () => {
  it("quarantines confirmed json-parse corruption and preserves run artifacts", () => {
    const baseDir = createTempDir("pi-async-quarantine-unit-");
    try {
      const asyncRoot = createAsyncRoot(baseDir);
      const issue = createIssue(asyncRoot, "bad-json", "{bad json", "json_parse");
      fs.writeFileSync(path.join(issue.asyncDir, "events.jsonl"), '{"type":"event"}\n', "utf-8");
      fs.writeFileSync(path.join(issue.asyncDir, "output.log"), "private output\n", "utf-8");
      fs.writeFileSync(path.join(issue.asyncDir, "session.jsonl"), '{"secret":true}\n', "utf-8");
      fs.writeFileSync(path.join(issue.asyncDir, "extra.bin"), Buffer.from([0, 1, 2, 3]));

      const result = quarantineCorruptAsyncRun(asyncRoot, issue, {
        createUniqueSuffix: () => "fixed-suffix",
      });
      assert.deepEqual(result, {
        outcome: "quarantined",
        kind: "json_parse",
        quarantineDir: path.join(baseDir, QUARANTINED_ASYNC_RUNS_DIRNAME, "bad-json.fixed-suffix"),
      });
      assert.equal(fs.existsSync(issue.asyncDir), false);
      assert.equal(
        fs.readFileSync(path.join(result.quarantineDir, "status.json"), "utf-8"),
        "{bad json",
      );
      assert.equal(
        fs.readFileSync(path.join(result.quarantineDir, "events.jsonl"), "utf-8"),
        '{"type":"event"}\n',
      );
      assert.equal(
        fs.readFileSync(path.join(result.quarantineDir, "output.log"), "utf-8"),
        "private output\n",
      );
      assert.equal(
        fs.readFileSync(path.join(result.quarantineDir, "session.jsonl"), "utf-8"),
        '{"secret":true}\n',
      );
      assert.deepEqual(
        fs.readFileSync(path.join(result.quarantineDir, "extra.bin")),
        Buffer.from([0, 1, 2, 3]),
      );
    } finally {
      removeTempDir(baseDir);
    }
  });

  it("quarantines confirmed persisted-validation corruption", () => {
    const baseDir = createTempDir("pi-async-quarantine-unit-");
    try {
      const asyncRoot = createAsyncRoot(baseDir);
      const content = JSON.stringify({
        runId: "bad-session",
        mode: "single",
        state: "running",
        sessionId: { value: "session" },
        startedAt: 1,
        steps: [{ agent: "worker", status: "running" }],
      });
      const issue = createIssue(asyncRoot, "bad-session", content, "persisted_validation");

      const result = quarantineCorruptAsyncRun(asyncRoot, issue, {
        createUniqueSuffix: () => "validated",
      });
      assert.equal(result.outcome, "quarantined");
      assert.equal(result.kind, "persisted_validation");
      assert.equal(fs.existsSync(issue.asyncDir), false);
      assert.equal(
        fs.existsSync(
          path.join(
            baseDir,
            QUARANTINED_ASYNC_RUNS_DIRNAME,
            "bad-session.validated",
            "status.json",
          ),
        ),
        true,
      );
    } finally {
      removeTempDir(baseDir);
    }
  });

  it("returns exact deferred reasons for unstable stats and stable fingerprint drift without moving the source", () => {
    const baseDir = createTempDir("pi-async-quarantine-unit-");
    try {
      const asyncRoot = createAsyncRoot(baseDir);
      const unstableIssue = createIssue(asyncRoot, "unstable-race", "{bad json", "json_parse");
      const unstableBefore = fs.statSync(unstableIssue.statusPath);
      const unstableAfter = { ...unstableBefore, mtimeMs: unstableBefore.mtimeMs + 1 } as fs.Stats;
      let unstableStatCalls = 0;
      const unstable = quarantineCorruptAsyncRun(asyncRoot, unstableIssue, {
        fs: {
          statSync: () => (++unstableStatCalls === 1 ? unstableBefore : unstableAfter),
          readFileSync: fs.readFileSync,
          mkdirSync: fs.mkdirSync,
          renameSync: fs.renameSync,
        },
        createUniqueSuffix: () => "unstable",
      });
      assert.deepEqual(unstable, {
        outcome: "deferred",
        reason: "unstable",
        kind: "json_parse",
        dedupeKey: `${unstableIssue.entry}\u0000${unstableIssue.fingerprint.value}\u0000unstable`,
      });
      assert.equal(fs.existsSync(unstableIssue.asyncDir), true);
      assert.equal(
        fs.existsSync(path.join(baseDir, QUARANTINED_ASYNC_RUNS_DIRNAME, "unstable-race.unstable")),
        false,
      );

      const changedIssue = createIssue(asyncRoot, "changed-race", "{bad json", "json_parse");
      const changedContent = "{bad jzon";
      const changed = quarantineCorruptAsyncRun(asyncRoot, changedIssue, {
        fs: {
          ...createStableStatFs(changedIssue.statusPath),
          readFileSync(filePath: string, encoding: BufferEncoding) {
            fs.writeFileSync(filePath, changedContent, "utf-8");
            return fs.readFileSync(filePath, encoding);
          },
        },
        createUniqueSuffix: () => "changed",
      });
      assert.deepEqual(changed, {
        outcome: "deferred",
        reason: "changed",
        kind: "json_parse",
        dedupeKey: `${changedIssue.entry}\u0000${changedIssue.fingerprint.value}\u0000changed`,
      });
      assert.equal(fs.existsSync(changedIssue.asyncDir), true);
      assert.equal(fs.readFileSync(changedIssue.statusPath, "utf-8"), changedContent);
      assert.equal(
        fs.existsSync(path.join(baseDir, QUARANTINED_ASYNC_RUNS_DIRNAME, "changed-race.changed")),
        false,
      );
    } finally {
      removeTempDir(baseDir);
    }
  });

  it("revalidates stable current content and reports repaired when the issue fingerprint matches it", () => {
    const baseDir = createTempDir("pi-async-quarantine-unit-");
    try {
      const asyncRoot = createAsyncRoot(baseDir);
      const invalidContent = JSON.stringify({
        runId: "repair-race",
        mode: "single",
        state: "running",
        sessionId: { value: "session" },
        startedAt: 1,
        steps: [{ agent: "worker", status: "running" }],
      });
      const repairedContent = JSON.stringify({
        runId: "repair-race",
        mode: "single",
        state: "running",
        sessionId: "session",
        startedAt: 1,
        steps: [{ agent: "worker", status: "running" }],
      });
      const issue = createIssue(asyncRoot, "repair-race", invalidContent, "persisted_validation");
      fs.writeFileSync(issue.statusPath, repairedContent, "utf-8");

      const repaired = quarantineCorruptAsyncRun(
        asyncRoot,
        {
          ...issue,
          fingerprint: fingerprintAsyncStatusContent(repairedContent),
        },
        {
          fs: createStableStatFs(issue.statusPath),
          createUniqueSuffix: () => "repair",
        },
      );
      assert.deepEqual(repaired, {
        outcome: "skipped",
        reason: "repaired",
        kind: "persisted_validation",
      });
      assert.equal(fs.existsSync(issue.asyncDir), true);
      assert.equal(fs.readFileSync(issue.statusPath, "utf-8"), repairedContent);
      assert.equal(
        fs.existsSync(path.join(baseDir, QUARANTINED_ASYNC_RUNS_DIRNAME, "repair-race.repair")),
        false,
      );
    } finally {
      removeTempDir(baseDir);
    }
  });

  it("requires a detection fingerprint and validated in-root paths before any fs mutation", () => {
    const baseDir = createTempDir("pi-async-quarantine-unit-");
    try {
      const asyncRoot = createAsyncRoot(baseDir);
      const missingFingerprintIssue = createIssue(
        asyncRoot,
        "missing-fingerprint",
        "{bad json",
        "json_parse",
      );
      let missingFingerprintCalls = 0;
      const missingFingerprint = quarantineCorruptAsyncRun(
        asyncRoot,
        {
          ...missingFingerprintIssue,
          fingerprint: undefined,
        },
        {
          fs: {
            statSync: () => {
              missingFingerprintCalls += 1;
              return fs.statSync(missingFingerprintIssue.statusPath);
            },
            readFileSync: fs.readFileSync,
            mkdirSync: fs.mkdirSync,
            renameSync: fs.renameSync,
          },
        },
      );
      assert.deepEqual(missingFingerprint, {
        outcome: "deferred",
        reason: "missing_fingerprint",
        kind: "json_parse",
        dedupeKey: `${missingFingerprintIssue.entry}\u0000missing-fingerprint\u0000missing_fingerprint`,
      });
      assert.equal(missingFingerprintCalls, 0);
      assert.equal(fs.existsSync(missingFingerprintIssue.asyncDir), true);

      const invalidPathIssue = createIssue(asyncRoot, "invalid-path", "{bad json", "json_parse");
      let invalidPathMutations = 0;
      const invalidPath = quarantineCorruptAsyncRun(
        asyncRoot,
        {
          ...invalidPathIssue,
          asyncDir: path.join(baseDir, "escaped-run"),
        },
        {
          fs: {
            statSync: fs.statSync,
            readFileSync: fs.readFileSync,
            mkdirSync(...args) {
              invalidPathMutations += 1;
              return fs.mkdirSync(...args);
            },
            renameSync(...args) {
              invalidPathMutations += 1;
              return fs.renameSync(...args);
            },
          },
        },
      );
      assert.deepEqual(invalidPath, {
        outcome: "failed",
        reason: "invalid_path",
        kind: "json_parse",
        dedupeKey: `${invalidPathIssue.entry}\u0000${invalidPathIssue.fingerprint.value}\u0000invalid_path`,
      });
      assert.equal(invalidPathMutations, 0);
      assert.equal(fs.existsSync(invalidPathIssue.asyncDir), true);
    } finally {
      removeTempDir(baseDir);
    }
  });

  it("leaves the source run untouched when rename fails", () => {
    const baseDir = createTempDir("pi-async-quarantine-unit-");
    try {
      const asyncRoot = createAsyncRoot(baseDir);
      const issue = createIssue(asyncRoot, "rename-failure", "{bad json", "json_parse");
      const failingFs = {
        statSync: fs.statSync,
        readFileSync: fs.readFileSync,
        mkdirSync: fs.mkdirSync,
        renameSync() {
          const error = new Error("blocked") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        },
      };
      const result = quarantineCorruptAsyncRun(asyncRoot, issue, {
        fs: failingFs,
        createUniqueSuffix: () => "rename-failure",
      });
      assert.deepEqual(result, {
        outcome: "failed",
        reason: "rename",
        kind: "json_parse",
        dedupeKey: `${issue.entry}\u0000${issue.fingerprint.value}\u0000rename`,
      });
      assert.equal(fs.existsSync(issue.asyncDir), true);
      assert.equal(fs.readFileSync(path.join(issue.asyncDir, "status.json"), "utf-8"), "{bad json");
    } finally {
      removeTempDir(baseDir);
    }
  });
});
