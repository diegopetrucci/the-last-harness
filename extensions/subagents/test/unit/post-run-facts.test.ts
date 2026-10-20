import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  MAX_ATTRIBUTION_LIVE_STATUS_AGE_MS,
  MAX_ATTRIBUTION_STATUS_BYTES,
  captureGitWorkspaceSnapshot,
  captureSubagentAttemptFacts,
  classifyWorkspaceAttribution,
} from "../../src/shared/post-run-facts.ts";
import type { GitWorkspaceSnapshot, SubagentAttemptFacts } from "../../src/shared/types.ts";
import { boundSubagentAttemptFacts } from "../../src/shared/terminal-result.ts";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "TLH tests",
      GIT_AUTHOR_EMAIL: "tlh-tests@example.invalid",
      GIT_COMMITTER_NAME: "TLH tests",
      GIT_COMMITTER_EMAIL: "tlh-tests@example.invalid",
    },
  });
}

function makeGitWorkspace(): string {
  const workspace = tempDir("tlh-post-run-facts-workspace-");
  git(workspace, "init", "-q");
  fs.writeFileSync(path.join(workspace, "tracked.txt"), "initial\n", "utf8");
  git(workspace, "add", "tracked.txt");
  git(workspace, "commit", "-qm", "initial");
  return workspace;
}

function availableSnapshot(): GitWorkspaceSnapshot {
  return {
    status: "available",
    statusPorcelainZ: "",
    worktreeDiffStat: "",
    indexDiffStat: "",
  };
}

function writeStatus(runDir: string, status: Record<string, unknown>): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify(status), "utf8");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("post-run git workspace facts", () => {
  it("captures dirty worktree, staged-only, and untracked evidence", () => {
    const workspace = makeGitWorkspace();

    fs.writeFileSync(path.join(workspace, "tracked.txt"), "dirty\n", "utf8");
    let snapshot = captureGitWorkspaceSnapshot(workspace);
    assert.equal(snapshot.status, "available");
    if (snapshot.status === "available") {
      assert.match(snapshot.statusPorcelainZ, / M tracked\.txt\0/);
      assert.match(snapshot.worktreeDiffStat, /tracked\.txt/);
    }

    git(workspace, "add", "tracked.txt");
    snapshot = captureGitWorkspaceSnapshot(workspace);
    assert.equal(snapshot.status, "available");
    if (snapshot.status === "available") {
      assert.match(snapshot.statusPorcelainZ, /M  tracked\.txt\0/);
      assert.match(snapshot.indexDiffStat, /tracked\.txt/);
    }

    fs.writeFileSync(path.join(workspace, "untracked.txt"), "new\n", "utf8");
    snapshot = captureGitWorkspaceSnapshot(workspace);
    assert.equal(snapshot.status, "available");
    if (snapshot.status === "available") {
      assert.match(snapshot.statusPorcelainZ, /\?\? untracked\.txt\0/);
    }
  });

  it("records non-git directories and command failures as unavailable", () => {
    const nonGit = tempDir("tlh-post-run-facts-non-git-");
    assert.deepEqual(captureGitWorkspaceSnapshot(nonGit), {
      status: "unavailable",
      reason: "not_git_repository",
    });

    const filePath = path.join(nonGit, "not-a-directory");
    fs.writeFileSync(filePath, "file\n", "utf8");
    assert.deepEqual(captureGitWorkspaceSnapshot(filePath), {
      status: "unavailable",
      reason: "command_failed",
    });
  });

  it("disables optional git locks for every observation without touching the index", () => {
    const workspace = makeGitWorkspace();
    const wrapperDir = tempDir("tlh-post-run-facts-git-wrapper-");
    const logPath = path.join(wrapperDir, "git.log");
    const wrapperPath = path.join(wrapperDir, "git");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(
      wrapperPath,
      [
        "#!/bin/sh",
        'printf \'%s|%s\\n\' "$GIT_OPTIONAL_LOCKS" "$*" >> "$TLH_GIT_FACTS_LOG"',
        'exec "$TLH_GIT_FACTS_REAL" "$@"',
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(wrapperPath, 0o755);
    const indexPath = path.join(workspace, ".git", "index");
    const beforeMtime = fs.statSync(indexPath).mtimeMs;
    const previousPath = process.env.PATH;
    const previousLog = process.env.TLH_GIT_FACTS_LOG;
    const previousReal = process.env.TLH_GIT_FACTS_REAL;
    process.env.PATH = `${wrapperDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.TLH_GIT_FACTS_LOG = logPath;
    process.env.TLH_GIT_FACTS_REAL = realGit;
    try {
      assert.equal(captureGitWorkspaceSnapshot(workspace).status, "available");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousLog === undefined) delete process.env.TLH_GIT_FACTS_LOG;
      else process.env.TLH_GIT_FACTS_LOG = previousLog;
      if (previousReal === undefined) delete process.env.TLH_GIT_FACTS_REAL;
      else process.env.TLH_GIT_FACTS_REAL = previousReal;
    }

    assert.equal(fs.statSync(indexPath).mtimeMs, beforeMtime);
    assert.deepEqual(
      fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("|")),
      [
        ["0", "status --porcelain -z --untracked-files=all"],
        ["0", "diff --stat"],
        ["0", "diff --cached --stat"],
      ],
    );
  });
});

describe("post-run workspace attribution", () => {
  it("marks overlapping persisted sibling runs as shared", () => {
    const workspace = makeGitWorkspace();
    const runRoot = tempDir("tlh-post-run-facts-runs-");
    const ownDir = path.join(runRoot, "own");
    const siblingDir = path.join(runRoot, "sibling");
    fs.mkdirSync(ownDir);
    fs.mkdirSync(siblingDir);
    fs.writeFileSync(
      path.join(ownDir, "status.json"),
      JSON.stringify({
        cwd: workspace,
        state: "complete",
        startedAt: 0,
        endedAt: 50,
        steps: [{ cwd: workspace, status: "complete", startedAt: 0, endedAt: 50 }],
      }),
    );
    fs.writeFileSync(
      path.join(siblingDir, "status.json"),
      JSON.stringify({
        cwd: workspace,
        state: "complete",
        startedAt: 100,
        endedAt: 500,
        steps: [{ cwd: workspace, status: "complete", startedAt: 100, endedAt: 500 }],
      }),
    );

    const attribution = classifyWorkspaceAttribution({
      cwd: workspace,
      startedAt: 200,
      endedAt: 300,
      baseline: availableSnapshot(),
      post: availableSnapshot(),
      asyncDir: ownDir,
      stepIndex: 0,
    });
    assert.equal(attribution, "shared");

    fs.writeFileSync(
      path.join(siblingDir, "status.json"),
      JSON.stringify({
        cwd: workspace,
        state: "complete",
        startedAt: 500,
        endedAt: 600,
        steps: [{ cwd: workspace, status: "complete", startedAt: 500, endedAt: 600 }],
      }),
    );
    assert.equal(
      classifyWorkspaceAttribution({
        cwd: workspace,
        startedAt: 200,
        endedAt: 300,
        baseline: availableSnapshot(),
        post: availableSnapshot(),
        asyncDir: ownDir,
        stepIndex: 0,
      }),
      "exclusive",
    );
  });

  it("ignores stale and status-less run directories while scanning all tracked status files", () => {
    const workspace = makeGitWorkspace();
    const runRoot = tempDir("tlh-post-run-facts-runs-");
    const ownDir = path.join(runRoot, "own");
    fs.mkdirSync(ownDir);
    fs.writeFileSync(
      path.join(ownDir, "status.json"),
      JSON.stringify({
        cwd: workspace,
        state: "running",
        startedAt: 100,
        steps: [{ cwd: workspace, status: "running", startedAt: 100 }],
      }),
    );
    for (let index = 0; index < 720; index++) {
      fs.mkdirSync(path.join(runRoot, `stale-${index.toString().padStart(4, "0")}`));
    }
    for (let index = 0; index < 10; index++) {
      const staleDir = path.join(runRoot, `tracked-stale-${index}`);
      fs.mkdirSync(staleDir);
      fs.writeFileSync(
        path.join(staleDir, "status.json"),
        JSON.stringify({
          cwd: workspace,
          state: "complete",
          startedAt: 0,
          endedAt: 50,
          steps: [{ cwd: workspace, status: "complete", startedAt: 0, endedAt: 50 }],
        }),
      );
    }

    assert.equal(
      classifyWorkspaceAttribution({
        cwd: workspace,
        startedAt: 100,
        endedAt: 200,
        baseline: availableSnapshot(),
        post: availableSnapshot(),
        asyncDir: ownDir,
        stepIndex: 0,
        now: 200,
      }),
      "exclusive",
    );
  });

  it("finds a recent overlapping sibling outside the former lexical scan window", () => {
    const workspace = makeGitWorkspace();
    const runRoot = tempDir("tlh-post-run-facts-runs-");
    const ownDir = path.join(runRoot, "own");
    fs.mkdirSync(ownDir);
    fs.writeFileSync(
      path.join(ownDir, "status.json"),
      JSON.stringify({
        cwd: workspace,
        state: "running",
        startedAt: 100,
        steps: [{ cwd: workspace, status: "running", startedAt: 100 }],
      }),
    );
    for (let index = 0; index < 70; index++) {
      const staleDir = path.join(runRoot, `lexical-${index.toString().padStart(3, "0")}`);
      fs.mkdirSync(staleDir);
      fs.writeFileSync(
        path.join(staleDir, "status.json"),
        JSON.stringify({
          cwd: workspace,
          state: "complete",
          startedAt: 0,
          endedAt: 50,
          steps: [{ cwd: workspace, status: "complete", startedAt: 0, endedAt: 50 }],
        }),
      );
    }
    const recentDir = path.join(runRoot, "zz-recent-live-sibling");
    fs.mkdirSync(recentDir);
    fs.writeFileSync(
      path.join(recentDir, "status.json"),
      JSON.stringify({
        cwd: workspace,
        state: "running",
        pid: 43,
        startedAt: 150,
        lastUpdate: 200,
        lastActivityAt: 200,
        steps: [{ cwd: workspace, status: "running", startedAt: 150 }],
      }),
    );

    assert.equal(
      classifyWorkspaceAttribution({
        cwd: workspace,
        startedAt: 100,
        endedAt: 200,
        baseline: availableSnapshot(),
        post: availableSnapshot(),
        asyncDir: ownDir,
        stepIndex: 0,
        now: 200,
        checkPidLiveness: () => "alive",
      }),
      "shared",
    );
  });

  it("bounds dead running siblings by their last observed heartbeat", () => {
    const workspace = makeGitWorkspace();
    const runRoot = tempDir("tlh-post-run-facts-runs-");
    const ownDir = path.join(runRoot, "own");
    const siblingDir = path.join(runRoot, "sibling");
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const now = weekMs * 2;
    fs.mkdirSync(ownDir);
    writeStatus(siblingDir, {
      cwd: workspace,
      state: "running",
      pid: 41,
      startedAt: now - weekMs,
      lastUpdate: now - weekMs + 10,
      lastActivityAt: now - weekMs + 10,
    });

    assert.equal(
      classifyWorkspaceAttribution({
        cwd: workspace,
        startedAt: now - 100,
        endedAt: now,
        baseline: availableSnapshot(),
        post: availableSnapshot(),
        asyncDir: ownDir,
        now,
        checkPidLiveness: () => "dead",
      }),
      "exclusive",
      "a dead week-old running label must not extend its interval to now",
    );

    writeStatus(siblingDir, {
      cwd: workspace,
      state: "running",
      startedAt: now - weekMs,
      lastUpdate: now - weekMs + 10,
      lastActivityAt: now - weekMs + 10,
    });
    assert.equal(
      classifyWorkspaceAttribution({
        cwd: workspace,
        startedAt: now - 100,
        endedAt: now,
        baseline: availableSnapshot(),
        post: availableSnapshot(),
        asyncDir: ownDir,
        now,
        checkPidLiveness: () => "dead",
      }),
      "unknown",
      "missing pid must not be treated as a dead sibling with a reliable end",
    );
  });

  it("requires fresh liveness before extending a running sibling to now", () => {
    const workspace = makeGitWorkspace();
    const runRoot = tempDir("tlh-post-run-facts-runs-");
    const ownDir = path.join(runRoot, "own");
    const siblingDir = path.join(runRoot, "sibling");
    const now = 50_000;
    fs.mkdirSync(ownDir);
    writeStatus(siblingDir, {
      cwd: workspace,
      state: "running",
      pid: 42,
      startedAt: now - 1_000,
      lastUpdate: now - 10,
      lastActivityAt: now - 20,
    });

    const livenessCalls: number[] = [];
    assert.equal(
      classifyWorkspaceAttribution({
        cwd: workspace,
        startedAt: now - 100,
        endedAt: now,
        baseline: availableSnapshot(),
        post: availableSnapshot(),
        asyncDir: ownDir,
        now,
        checkPidLiveness: (pid) => {
          livenessCalls.push(pid);
          return "alive";
        },
      }),
      "shared",
    );
    assert.deepEqual(livenessCalls, [42]);

    writeStatus(siblingDir, {
      cwd: workspace,
      state: "running",
      pid: 42,
      startedAt: now - 1_000,
      lastUpdate: now - MAX_ATTRIBUTION_LIVE_STATUS_AGE_MS - 1,
      lastActivityAt: now - MAX_ATTRIBUTION_LIVE_STATUS_AGE_MS - 1,
    });
    assert.equal(
      classifyWorkspaceAttribution({
        cwd: workspace,
        startedAt: now - 100,
        endedAt: now,
        baseline: availableSnapshot(),
        post: availableSnapshot(),
        asyncDir: ownDir,
        now,
        checkPidLiveness: () => "alive",
      }),
      "unknown",
      "a stale live pid is not enough to establish an overlapping run",
    );

    assert.equal(
      classifyWorkspaceAttribution({
        cwd: workspace,
        startedAt: now - 100,
        endedAt: now,
        baseline: availableSnapshot(),
        post: availableSnapshot(),
        asyncDir: ownDir,
        now,
        checkPidLiveness: () => "unknown",
      }),
      "unknown",
      "ambiguous pid liveness must fail closed",
    );
  });

  it("reads realistic multi-child terminal evidence before applying the attribution cap", () => {
    const workspace = makeGitWorkspace();
    const runRoot = tempDir("tlh-post-run-facts-runs-");
    const ownDir = path.join(runRoot, "own");
    const siblingDir = path.join(runRoot, "sibling");
    const evidence = "x".repeat(10 * 1024);
    const terminalResult = {
      state: "completed",
      facts: {
        attempts: [
          {
            attempt: 1,
            exit: { code: 0, signal: null },
            durationMs: 1,
            providerTokens: { status: "unavailable" },
            requestedToolCalls: { edit: 1, write: 1, bash: 1 },
            workspace: {
              baseline: {
                status: "available",
                statusPorcelainZ: evidence,
                worktreeDiffStat: evidence,
                indexDiffStat: evidence,
              },
              post: {
                status: "available",
                statusPorcelainZ: evidence,
                worktreeDiffStat: evidence,
                indexDiffStat: evidence,
              },
              attribution: "shared",
            },
          },
        ],
      },
    };
    const steps = Array.from({ length: 4 }, (_, index) => ({
      agent: `worker-${index}`,
      status: "complete",
      cwd: workspace,
      startedAt: 200,
      endedAt: 500,
      terminalResult,
    }));
    fs.mkdirSync(ownDir);
    writeStatus(siblingDir, { cwd: workspace, state: "complete", steps });
    assert.ok(
      fs.statSync(path.join(siblingDir, "status.json")).size > 200 * 1024,
      "fixture should exercise a realistic multi-child status size",
    );

    assert.equal(
      classifyWorkspaceAttribution({
        cwd: workspace,
        startedAt: 300,
        endedAt: 400,
        baseline: availableSnapshot(),
        post: availableSnapshot(),
        asyncDir: ownDir,
        now: 1_000,
      }),
      "shared",
    );
  });

  it("returns unknown instead of reading an oversized attribution status", () => {
    const workspace = makeGitWorkspace();
    const runRoot = tempDir("tlh-post-run-facts-runs-");
    const ownDir = path.join(runRoot, "own");
    const siblingDir = path.join(runRoot, "sibling");
    fs.mkdirSync(ownDir);
    writeStatus(siblingDir, {
      cwd: workspace,
      state: "complete",
      startedAt: 100,
      endedAt: 500,
      padding: "x".repeat(MAX_ATTRIBUTION_STATUS_BYTES + 1),
    });

    assert.equal(
      classifyWorkspaceAttribution({
        cwd: workspace,
        startedAt: 300,
        endedAt: 400,
        baseline: availableSnapshot(),
        post: availableSnapshot(),
        asyncDir: ownDir,
        now: 1_000,
      }),
      "unknown",
    );
  });
});

describe("post-run attempt facts", () => {
  it("bounds retained snapshot evidence across attempts", () => {
    const evidence = "x".repeat(256 * 1024);
    const snapshot: GitWorkspaceSnapshot = {
      status: "available",
      statusPorcelainZ: evidence,
      worktreeDiffStat: evidence,
      indexDiffStat: evidence,
    };
    const attempt = {
      attempt: 1,
      exit: { code: 0, signal: null },
      durationMs: 1,
      providerTokens: { status: "unavailable" },
      requestedToolCalls: { edit: 0, write: 0, bash: 0 },
      workspace: { baseline: snapshot, post: snapshot, attribution: "exclusive" },
    } satisfies SubagentAttemptFacts;

    const bounded = boundSubagentAttemptFacts([attempt, { ...attempt, attempt: 2 }]);
    const evidenceBytes = bounded.reduce((total, item) => {
      const snapshots = [item.workspace.baseline, item.workspace.post];
      return (
        total +
        snapshots.reduce(
          (snapshotTotal, value) =>
            snapshotTotal +
            (value.status === "available"
              ? Buffer.byteLength(value.statusPorcelainZ) +
                Buffer.byteLength(value.worktreeDiffStat) +
                Buffer.byteLength(value.indexDiffStat)
              : 0),
          0,
        )
      );
    }, 0);
    assert.ok(evidenceBytes <= 1024 * 1024);
    assert.equal(bounded[1]?.workspace.attribution, "unknown");
  });

  it("keeps exit, tokens, tool requests, duration, and workspace evidence together", () => {
    const workspace = makeGitWorkspace();
    const facts = captureSubagentAttemptFacts({
      attempt: 1,
      cwd: workspace,
      baseline: captureGitWorkspaceSnapshot(workspace),
      startedAt: 100,
      endedAt: 200,
      durationMs: 37.5,
      exitCode: 0,
      exitSignal: null,
      providerTokens: {
        status: "available",
        usage: { input: 4, output: 3, total: 7 },
      },
      requestedToolCalls: { edit: 1, write: 2, bash: 3 },
    });
    assert.equal(facts.attempt, 1);
    assert.deepEqual(facts.exit, { code: 0, signal: null });
    assert.equal(facts.durationMs, 37.5);
    assert.deepEqual(facts.providerTokens, {
      status: "available",
      usage: { input: 4, output: 3, total: 7 },
    });
    assert.deepEqual(facts.requestedToolCalls, { edit: 1, write: 2, bash: 3 });
    assert.equal(facts.workspace.post.status, "available");
  });
});
