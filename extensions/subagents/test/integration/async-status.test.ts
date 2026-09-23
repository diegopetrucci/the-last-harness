import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { MAX_TOP_LEVEL_PARALLEL_TASKS, type GitWorkspaceSnapshot } from "../../src/shared/types.ts";
import {
  formatAsyncRunList,
  listAsyncRuns,
  scanAsyncRunsForRestore,
} from "../../src/runs/background/async-status.ts";
import { mergeAndWriteSourceRunnerStatus } from "../../src/runs/shared/lifecycle-state.ts";
import {
  isAsyncStatusReadError,
  parsePersistedAsyncStatus,
} from "../../src/runs/background/async-status-boundary.ts";
import {
  MAX_ATTRIBUTION_STATUS_BYTES,
  MAX_SUBAGENT_TERMINAL_SNAPSHOT_BYTES,
} from "../../src/shared/terminal-result.ts";
import {
  ASYNC_STATUS_RETRY_DELAY_MS,
  invalidateStatusCache,
  MAX_ASYNC_STATUS_BYTES,
  MAX_STATUS_CACHE_BYTES,
  readStatus,
  type AsyncStatusReadOptions,
} from "../../src/shared/utils.ts";

function createAsyncDir(root: string, id: string, status: Record<string, unknown>): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status), "utf-8");
  return dir;
}

function sourceSizedStatusRead(
  sourceBytes: ReadonlyMap<string, number>,
  reads: Map<string, number>,
): AsyncStatusReadOptions {
  return {
    statSync: (statusPath) => {
      const stat = fs.statSync(statusPath);
      const sourceSize = sourceBytes.get(statusPath);
      return sourceSize === undefined ? stat : Object.assign(stat, { size: sourceSize });
    },
    readFileSync: (statusPath, encoding) => {
      reads.set(statusPath, (reads.get(statusPath) ?? 0) + 1);
      return fs.readFileSync(statusPath, encoding);
    },
    sleep: () => {},
  };
}

function assertAvailableEvidence(
  snapshot: GitWorkspaceSnapshot | undefined,
  expectedBytes: number,
): void {
  if (!snapshot || snapshot.status !== "available")
    throw new Error("expected available workspace evidence");
  assert.equal(snapshot.statusPorcelainZ.length, expectedBytes);
}

function maximalTerminalResult(): Record<string, unknown> {
  const bytesPerField = Math.floor(MAX_SUBAGENT_TERMINAL_SNAPSHOT_BYTES / 6);
  const remainder = MAX_SUBAGENT_TERMINAL_SNAPSHOT_BYTES % 6;
  const fieldSizes = Array.from(
    { length: 6 },
    (_, index) => bytesPerField + (index < remainder ? 1 : 0),
  );
  const snapshot = (offset: number) => ({
    status: "available",
    statusPorcelainZ: "x".repeat(fieldSizes[offset]!),
    worktreeDiffStat: "x".repeat(fieldSizes[offset + 1]!),
    indexDiffStat: "x".repeat(fieldSizes[offset + 2]!),
  });
  return {
    state: "completed",
    facts: {
      attempts: [
        {
          attempt: 1,
          exit: { code: 0, signal: null },
          durationMs: 1,
          providerTokens: { status: "unavailable" },
          requestedToolCalls: { edit: 0, write: 0, bash: 0 },
          workspace: {
            baseline: snapshot(0),
            post: snapshot(3),
            attribution: "exclusive",
          },
        },
      ],
    },
  };
}

describe("async status helpers", () => {
  it("lists only requested states and includes flattened step summaries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-"));
    try {
      const outputFile = path.join(root, "run-a", "output-1.log");
      createAsyncDir(root, "run-a", {
        runId: "run-a",
        mode: "parallel",
        state: "running",
        awaited: true,
        startedAt: 100,
        lastUpdate: 200,
        cwd: "/repo-a",
        currentStep: 1,
        outputFile,
        steps: [
          { agent: "scout", status: "complete", durationMs: 10 },
          { agent: "worker", status: "running", durationMs: 20 },
        ],
      });
      createAsyncDir(root, "run-b", {
        runId: "run-b",
        mode: "single",
        state: "complete",
        startedAt: 50,
        lastUpdate: 75,
        steps: [{ agent: "reviewer", status: "complete" }],
      });

      const runs = listAsyncRuns(root, { states: ["queued", "running"] });
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.id, "run-a");
      assert.equal(runs[0]?.cwd, "/repo-a");
      assert.equal(runs[0]?.steps.length, 2);
      assert.equal(runs[0]?.steps[1]?.agent, "worker");
      assert.equal(runs[0]?.steps[1]?.status, "running");
      assert.equal(runs[0]?.awaited, true);
      assert.match(formatAsyncRunList(runs), /run-a \| running \| awaited .*\| parallel/);
      assert.match(formatAsyncRunList(runs), /output: .*output-1\.log/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the maximum running timestamp as the idle baseline", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-baseline-"));
    try {
      createAsyncDir(root, "run-baseline", {
        runId: "run-baseline",
        mode: "single",
        state: "running",
        startedAt: 100,
        lastActivityAt: 200,
        currentStep: 0,
        steps: [{ agent: "worker", status: "running", startedAt: 500, lastActivityAt: 150 }],
      });
      const run = listAsyncRuns(root, { states: ["running"] })[0];
      assert.equal(run?.lastActivityAt, 500);
      assert.equal(run?.steps[0]?.lastActivityAt, 500);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects terminal context and termination diagnostics into step summaries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-diagnostics-"));
    try {
      createAsyncDir(root, "run-diagnostics", {
        runId: "run-diagnostics",
        mode: "single",
        state: "complete",
        startedAt: 100,
        lastUpdate: 200,
        steps: [
          {
            agent: "worker",
            status: "complete",
            contextUsage: {
              contextTokens: 900,
              peakTokens: 950,
              contextWindow: 2000,
              contextPercent: 45,
            },
            terminationReason: "output_limit",
          },
        ],
      });
      const step = listAsyncRuns(root)[0]?.steps[0];
      assert.deepEqual(step?.contextUsage, {
        contextTokens: 900,
        peakTokens: 950,
        contextWindow: 2000,
        contextPercent: 45,
      });
      assert.equal(step?.terminationReason, "output_limit");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitizes malformed optional diagnostics while preserving legacy status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-malformed-diagnostics-"));
    try {
      createAsyncDir(root, "run-malformed-diagnostics", {
        runId: "run-malformed-diagnostics",
        mode: "single",
        state: "complete",
        startedAt: 100,
        steps: [
          {
            agent: "worker",
            status: "complete",
            contextUsage: { contextTokens: "not-a-number" },
            terminationReason: "future_reason",
          },
        ],
      });

      const step = listAsyncRuns(root)[0]?.steps[0];
      assert.equal(step?.contextUsage, undefined);
      assert.equal(step?.terminationReason, undefined);
      assert.equal(step?.status, "complete");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("canonicalizes continued runs as terminal complete work", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-continued-"));
    try {
      createAsyncDir(root, "run-complete", {
        runId: "run-complete",
        mode: "single",
        state: "complete",
        startedAt: 100,
        lastUpdate: 400,
        steps: [{ agent: "worker", status: "complete" }],
      });
      createAsyncDir(root, "run-continued", {
        runId: "run-continued",
        mode: "single",
        state: "continued",
        startedAt: 100,
        lastUpdate: 500,
        steps: [{ agent: "worker", status: "continued" }],
      });

      const runs = listAsyncRuns(root);
      assert.deepEqual(
        runs.map((run) => run.id),
        ["run-continued", "run-complete"],
      );
      assert.equal(runs[0]?.state, "complete");
      assert.deepEqual(runs[0]?.lifecycle?.continuation, { phase: "completed" });
      assert.equal(runs[1]?.lifecycle?.continuation, undefined);
      assert.match(formatAsyncRunList(runs), /run-continued \| complete/);
      const raw = JSON.parse(
        fs.readFileSync(path.join(root, "run-continued", "status.json"), "utf8"),
      ) as { state?: string; lifecycle?: unknown; steps?: Array<{ status?: string }> };
      assert.equal(raw.state, "continued");
      assert.equal(raw.steps?.[0]?.status, "continued");
      assert.equal(raw.lifecycle, undefined, "legacy read projection must not rewrite disk");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects legacy continued child labels into per-index continuation metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-continued-step-"));
    try {
      const runDir = createAsyncDir(root, "run-continued-step", {
        runId: "run-continued-step",
        mode: "parallel",
        state: "complete",
        startedAt: 100,
        steps: [
          { agent: "worker", status: "continued" },
          { agent: "reviewer", status: "complete" },
        ],
      });
      const status = readStatus(runDir);
      assert.equal(status?.state, "complete");
      assert.equal(status?.steps?.[0]?.status, "complete");
      assert.equal(status?.steps?.[1]?.status, "complete");
      assert.deepEqual(status?.lifecycle?.continuationsByIndex, {
        "0": { phase: "completed" },
      });
      const raw = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf8")) as {
        lifecycle?: unknown;
      };
      assert.equal(raw.lifecycle, undefined, "legacy child projection must not rewrite disk");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("formats model thinking in step summaries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-model-thinking-"));
    try {
      createAsyncDir(root, "run-model", {
        runId: "run-model",
        mode: "parallel",
        state: "running",
        startedAt: 100,
        lastUpdate: 200,
        steps: [
          { agent: "reviewer", status: "running", model: "openai-codex/gpt-5.5:high" },
          {
            agent: "scout",
            status: "running",
            model: "anthropic/claude-haiku-4-5",
            thinking: "low",
          },
          { agent: "local", status: "running", model: "ollama/qwen2.5-coder:7b" },
          {
            agent: "fallback",
            status: "running",
            model: "anthropic/claude-sonnet-4-5:low",
            thinking: "high",
          },
        ],
      });

      const text = formatAsyncRunList(listAsyncRuns(root, { states: ["running"] }));
      assert.match(text, /1\. reviewer \| running \| gpt-5\.5 · thinking high/);
      assert.match(text, /2\. scout \| running \| claude-haiku-4-5 · thinking low/);
      assert.match(text, /3\. local \| running \| qwen2\.5-coder:7b(?! · thinking)/);
      assert.match(text, /4\. fallback \| running \| claude-sonnet-4-5 · thinking low/);
      assert.doesNotMatch(text, /openai-codex\/gpt-5\.5/);
      assert.doesNotMatch(text, /gpt-5\.5:high/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses persisted running attention state from detached runners", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-running-state-"));
    try {
      const lastActivityAt = Date.now() - 65_000;
      createAsyncDir(root, "run-running", {
        runId: "run-running",
        mode: "single",
        state: "running",
        activityState: "needs_attention",
        lastActivityAt,
        startedAt: Date.now() - 70_000,
        lastUpdate: Date.now(),
        steps: [
          { agent: "worker", status: "running", activityState: "needs_attention", lastActivityAt },
        ],
      });

      const runs = listAsyncRuns(root, { states: ["running"] });
      assert.equal(runs[0]?.activityState, "needs_attention");
      assert.equal(runs[0]?.steps[0]?.activityState, "needs_attention");
      const text = formatAsyncRunList(runs, "Active async runs");
      assert.match(text, /no activity for/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not infer attention state when the runner has not persisted one", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-no-derived-attention-"));
    try {
      const now = Date.now();
      createAsyncDir(root, "run-running", {
        runId: "run-running",
        mode: "single",
        state: "running",
        lastActivityAt: now - 90_000,
        startedAt: now - 120_000,
        lastUpdate: now,
        steps: [{ agent: "worker", status: "running", lastActivityAt: now - 90_000 }],
      });

      const runs = listAsyncRuns(root, { states: ["running"] });
      assert.equal(runs[0]?.activityState, undefined);
      assert.equal(runs[0]?.steps[0]?.activityState, undefined);
      assert.match(formatAsyncRunList(runs, "Active async runs"), /worker \| running \| active/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops retired active-long-running state from persisted status projections", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-retired-health-"));
    try {
      const now = Date.now();
      createAsyncDir(root, "run-retired-health", {
        runId: "run-retired-health",
        mode: "single",
        state: "running",
        activityState: "active_long_running",
        lastActivityAt: now - 90_000,
        startedAt: now - 120_000,
        lastUpdate: now,
        steps: [
          {
            agent: "worker",
            status: "running",
            activityState: "active_long_running",
            lastActivityAt: now - 90_000,
          },
        ],
      });

      const run = listAsyncRuns(root, { states: ["running"] })[0];
      assert.equal(run?.activityState, undefined);
      assert.equal(run?.steps[0]?.activityState, undefined);
      const text = formatAsyncRunList([run!], "Active async runs");
      assert.match(text, /worker \| running \| active/);
      assert.doesNotMatch(text, /needs attention|no activity/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not smear run-level attention state across running siblings when step metadata exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-step-attention-"));
    try {
      const now = Date.now();
      createAsyncDir(root, "run-mixed", {
        runId: "run-mixed",
        mode: "parallel",
        state: "running",
        activityState: "needs_attention",
        lastActivityAt: now - 90_000,
        startedAt: now - 120_000,
        lastUpdate: now,
        steps: [
          {
            agent: "idle",
            status: "running",
            activityState: "needs_attention",
            lastActivityAt: now - 90_000,
          },
          { agent: "active", status: "running", lastActivityAt: now - 1_000 },
        ],
      });

      const runs = listAsyncRuns(root, { states: ["running"] });
      assert.equal(runs[0]?.steps[0]?.activityState, "needs_attention");
      assert.equal(runs[0]?.steps[1]?.activityState, undefined);
      const text = formatAsyncRunList(runs, "Active async runs");
      assert.match(text, /idle \| running \| no activity for/);
      assert.match(text, /active \| running \| active/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("hides protected paused lifecycle paths from async run lists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-paused-privacy-"));
    try {
      const sessionFile = path.join(root, "private-session.jsonl");
      fs.writeFileSync(sessionFile, "session\n", "utf-8");
      createAsyncDir(root, "run-paused-private", {
        runId: "run-paused-private",
        mode: "single",
        state: "paused",
        pause: { kind: "awaiting_supervisor", pausedAt: 200 },
        startedAt: 100,
        lastUpdate: 200,
        cwd: "/private/root/project",
        outputFile: path.join(root, "run-paused-private", "output-0.log"),
        sessionFile,
        steps: [{ agent: "worker", status: "paused", currentPath: "/private/root/child.ts" }],
      });

      const text = formatAsyncRunList(
        listAsyncRuns(root, { states: ["paused"] }),
        "Paused async runs",
      );
      assert.match(text, /run-paused-private \| paused \| single \| steps 1/);
      assert.doesNotMatch(text, /private-session|\/private\/root|output-0\.log|session:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("formats paused runs as lifecycle state without activity state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-paused-status-"));
    try {
      createAsyncDir(root, "run-paused", {
        runId: "run-paused",
        mode: "single",
        state: "paused",
        startedAt: 100,
        lastUpdate: 200,
        endedAt: 200,
        steps: [{ agent: "worker", status: "complete" }],
      });

      const runs = listAsyncRuns(root, { states: ["paused"] });
      assert.equal(runs[0]?.id, "run-paused");
      assert.equal(runs[0]?.activityState, undefined);
      assert.equal(runs[0]?.steps[0]?.activityState, undefined);

      const text = formatAsyncRunList(runs, "Paused async runs");
      assert.match(text, /run-paused \| paused/);
      assert.match(text, /worker \| complete/);
      assert.doesNotMatch(text, /paused\/paused/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads historical paused payloads with retired step fields", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-historical-paused-status-"));
    try {
      createAsyncDir(root, "run-historical-paused", {
        runId: "run-historical-paused",
        mode: "single",
        state: "paused",
        startedAt: 100,
        lastUpdate: 200,
        steps: [
          {
            agent: "worker",
            status: "paused",
            acceptance: {
              status: "rejected",
              runtimeChecks: [
                {
                  id: "attestation",
                  status: "failed",
                  message: "Legacy diagnostic unavailable.",
                },
              ],
            },
          },
        ],
      });

      const runs = listAsyncRuns(root, { states: ["paused"] });
      assert.equal(runs[0]?.id, "run-historical-paused");
      assert.equal(runs[0]?.steps[0]?.status, "paused");
      assert.match(formatAsyncRunList(runs), /run-historical-paused \| paused/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores legacy turn-budget fields without rewriting historical status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-historical-turn-budget-status-"));
    try {
      const dir = createAsyncDir(root, "run-historical-turn-budget", {
        runId: "run-historical-turn-budget",
        mode: "single",
        state: "complete",
        startedAt: 100,
        lastUpdate: 200,
        turnBudget: { maxTurns: 5, graceTurns: 1, outcome: "exceeded", turnCount: 6 },
        turnBudgetExceeded: true,
        wrapUpRequested: true,
        steps: [
          {
            agent: "worker",
            status: "complete",
            turnBudget: { maxTurns: 5, graceTurns: 1, outcome: "exceeded", turnCount: 6 },
            turnBudgetExceeded: true,
            wrapUpRequested: true,
          },
        ],
      });
      const statusPath = path.join(dir, "status.json");
      const before = fs.readFileSync(statusPath);

      const runs = listAsyncRuns(root, { reconcile: false });
      const summary = runs[0];
      assert.ok(summary, "historical status should remain discoverable");
      assert.equal("turnBudget" in summary, false);
      assert.equal("turnBudgetExceeded" in summary, false);
      assert.equal("wrapUpRequested" in summary, false);
      assert.equal("turnBudget" in (summary.steps[0] ?? {}), false);
      assert.equal("turnBudgetExceeded" in (summary.steps[0] ?? {}), false);
      assert.equal("wrapUpRequested" in (summary.steps[0] ?? {}), false);
      assert.deepEqual(fs.readFileSync(statusPath), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports malformed status files without hiding healthy runs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-bad-status-"));
    const issues: Array<{ statusPath: string }> = [];
    try {
      createAsyncDir(root, "healthy-run", {
        runId: "healthy-run",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      const dir = path.join(root, "broken-run");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "status.json"), "{not-json", "utf-8");

      const runs = listAsyncRuns(root, {
        onUnreadable: (issue) => issues.push(issue),
      });
      assert.deepEqual(
        runs.map((run) => run.id),
        ["healthy-run"],
      );
      assert.equal(issues.length, 1);
      assert.equal(issues[0]?.statusPath, path.join(dir, "status.json"));
      assert.match(formatAsyncRunList(runs, "Active async runs", issues), /unreadable status at/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports malformed persisted fields as unreadable regardless of list filters", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-bad-session-id-"));
    const issues: Array<{ statusPath: string }> = [];
    try {
      const dir = createAsyncDir(root, "bad-session", {
        runId: "bad-session",
        sessionId: { value: "session" },
        mode: "single",
        state: "complete",
        startedAt: 100,
        steps: [{ agent: "worker", status: "complete" }],
      });

      assert.deepEqual(
        listAsyncRuns(root, { states: ["running"], onUnreadable: (issue) => issues.push(issue) }),
        [],
      );
      assert.equal(issues.length, 1);
      assert.equal(issues[0]?.statusPath, path.join(dir, "status.json"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds unreadable status output and caches unchanged failures", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-failure-cache-"));
    try {
      createAsyncDir(root, "healthy-run", {
        runId: "healthy-run",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      const badPaths = Array.from({ length: 60 }, (_, index) => {
        const dir = createAsyncDir(root, `bad-${String(index).padStart(2, "0")}`, {
          runId: `bad-${index}`,
          mode: "single",
          state: "running",
          startedAt: 100,
          steps: [{ agent: "worker", status: "running" }],
        });
        const statusPath = path.join(dir, "status.json");
        fs.writeFileSync(statusPath, "{bad status", "utf-8");
        return statusPath;
      });
      let reads = 0;
      let sleeps = 0;
      const statusRead = {
        cache: true,
        statSync: (statusPath: string) => fs.statSync(statusPath),
        readFileSync: (statusPath: string) => {
          reads++;
          return fs.readFileSync(statusPath, "utf-8");
        },
        sleep: () => {
          sleeps++;
        },
      };
      const firstIssues: Array<{ statusPath: string }> = [];
      const firstRuns = listAsyncRuns(root, {
        reconcile: false,
        statusRead,
        onUnreadable: (issue) => firstIssues.push(issue),
      });
      assert.deepEqual(
        firstRuns.map((run) => run.id),
        ["healthy-run"],
      );
      assert.equal(firstIssues.length, 60);
      const firstReads = reads;
      const firstSleeps = sleeps;
      assert.equal(firstReads, 121, "healthy status once plus two reads per bad status");
      assert.equal(firstSleeps, 60, "each persistent failure gets one retry delay");
      const firstText = formatAsyncRunList(firstRuns, "Active async runs", firstIssues);
      assert.equal((firstText.match(/unreadable status at /g) ?? []).length, 20);
      assert.match(firstText, /and 40 more unreadable statuses/);

      const secondIssues: Array<{ statusPath: string }> = [];
      const secondRuns = listAsyncRuns(root, {
        reconcile: false,
        statusRead,
        onUnreadable: (issue) => secondIssues.push(issue),
      });
      assert.deepEqual(
        secondRuns.map((run) => run.id),
        ["healthy-run"],
      );
      assert.equal(secondIssues.length, 60);
      assert.equal(reads, firstReads, "unchanged failures must not be reread");
      assert.equal(sleeps, firstSleeps, "unchanged failures must not sleep again");

      const changedBadPath = badPaths[0]!;
      fs.writeFileSync(changedBadPath, "{changed invalid status with new metadata", "utf-8");
      fs.utimesSync(changedBadPath, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
      listAsyncRuns(root, { reconcile: false, statusRead });
      assert.equal(reads, firstReads + 2, "metadata changes get a fresh bounded retry");
      assert.equal(sleeps, firstSleeps + 1);

      fs.writeFileSync(
        changedBadPath,
        JSON.stringify({
          runId: "recovered-run",
          mode: "single",
          state: "running",
          startedAt: 100,
          steps: [{ agent: "worker", status: "running" }],
        }),
        "utf-8",
      );
      fs.utimesSync(changedBadPath, new Date(Date.now() + 4_000), new Date(Date.now() + 4_000));
      const recovered = listAsyncRuns(root, { reconcile: false, statusRead });
      assert.ok(recovered.some((run) => run.id === "recovered-run"));
      assert.equal(reads, firstReads + 3, "changed content must clear the stale failure");
      assert.equal(sleeps, firstSleeps + 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not cache transient EACCES failures when metadata is unchanged", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-transient-eacces-"));
    const issues: Array<{ statusPath: string }> = [];
    try {
      const dir = createAsyncDir(root, "run-transient-eacces", {
        runId: "run-transient-eacces",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      const statusPath = path.join(dir, "status.json");
      const valid = fs.readFileSync(statusPath, "utf-8");
      const metadata = fs.statSync(statusPath);
      const denied = Object.assign(new Error("permission denied"), {
        code: "EACCES",
        path: statusPath,
      });
      let reads = 0;
      let sleeps = 0;
      let denyReads = true;
      const statusRead = {
        statSync: () => metadata,
        readFileSync: () => {
          reads++;
          if (denyReads) throw denied;
          return valid;
        },
        sleep: () => {
          sleeps++;
        },
      };

      assert.deepEqual(
        listAsyncRuns(root, {
          reconcile: false,
          statusRead,
          onUnreadable: (issue) => issues.push(issue),
        }),
        [],
      );
      assert.equal(reads, 2);
      assert.equal(sleeps, 1);
      assert.equal(issues.length, 1);

      denyReads = false;
      const recovered = listAsyncRuns(root, { reconcile: false, statusRead });
      assert.deepEqual(
        recovered.map((run) => run.id),
        ["run-transient-eacces"],
      );
      assert.equal(reads, 3, "transient I/O failures must be reread with unchanged metadata");
      assert.equal(sleeps, 1, "the successful retry must not sleep");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("cache:false bypasses deterministic failure caches without replacing them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-cache-bypass-"));
    try {
      const dir = createAsyncDir(root, "run-cache-bypass", {
        runId: "run-cache-bypass",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      const statusPath = path.join(dir, "status.json");
      const metadata = fs.statSync(statusPath);
      const valid = JSON.stringify({
        runId: "fresh-from-bypass",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      let reads = 0;
      let sleeps = 0;
      const invalidStatusRead = {
        statSync: () => metadata,
        readFileSync: () => {
          reads++;
          return "{invalid status";
        },
        sleep: () => {
          sleeps++;
        },
      };
      assert.deepEqual(
        listAsyncRuns(root, { reconcile: false, statusRead: invalidStatusRead }),
        [],
      );
      assert.equal(reads, 2);
      assert.equal(sleeps, 1);

      const fresh = listAsyncRuns(root, {
        reconcile: false,
        statusRead: {
          ...invalidStatusRead,
          cache: false,
          readFileSync: () => {
            reads++;
            return valid;
          },
        },
      });
      assert.deepEqual(
        fresh.map((run) => run.id),
        ["fresh-from-bypass"],
      );
      assert.equal(
        reads,
        3,
        "cache:false must reread instead of using deterministic failure cache",
      );
      assert.equal(sleeps, 1);

      assert.deepEqual(
        listAsyncRuns(root, { reconcile: false, statusRead: invalidStatusRead }),
        [],
      );
      assert.equal(reads, 3, "cache:false must not replace the ordinary failure cache");
      assert.equal(sleeps, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps near-limit successful status cache bytes within the fixed budget", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-cache-near-limit-"));
    try {
      const sourceBytes = new Map<string, number>();
      const reads = new Map<string, number>();
      const statusRead = sourceSizedStatusRead(sourceBytes, reads);
      const sizes = [
        MAX_ASYNC_STATUS_BYTES,
        MAX_ASYNC_STATUS_BYTES,
        MAX_ASYNC_STATUS_BYTES,
        MAX_STATUS_CACHE_BYTES - MAX_ASYNC_STATUS_BYTES * 3,
      ];
      assert.ok(sizes.every((size) => size > 0 && size <= MAX_ASYNC_STATUS_BYTES));
      assert.equal(
        sizes.reduce((total, size) => total + size, 0),
        MAX_STATUS_CACHE_BYTES,
      );

      const dirs = sizes.map((size, index) => {
        const dir = createAsyncDir(root, `run-cache-near-limit-${index}`, {
          runId: `run-cache-near-limit-${index}`,
          mode: "single",
          state: "running",
          startedAt: 100,
          steps: [{ agent: "worker", status: "running" }],
        });
        sourceBytes.set(path.join(dir, "status.json"), size);
        return dir;
      });
      const cachedStatuses = dirs.map((dir) => {
        const status = readStatus(dir, statusRead);
        assert.ok(status);
        return status;
      });
      assert.deepEqual(
        dirs.map((dir) => reads.get(path.join(dir, "status.json"))),
        [1, 1, 1, 1],
      );

      dirs.forEach((dir, index) => {
        assert.strictEqual(readStatus(dir, statusRead), cachedStatuses[index]);
      });
      assert.deepEqual(
        dirs.map((dir) => reads.get(path.join(dir, "status.json"))),
        [1, 1, 1, 1],
        "entries at the exact source-byte budget remain cache hits",
      );

      const extraDir = createAsyncDir(root, "run-cache-near-limit-extra", {
        runId: "run-cache-near-limit-extra",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      sourceBytes.set(path.join(extraDir, "status.json"), 1);
      assert.ok(readStatus(extraDir, statusRead));
      assert.equal(reads.get(path.join(extraDir, "status.json")), 1);
      dirs.slice(1).forEach((dir) => assert.ok(readStatus(dir, statusRead)));
      assert.deepEqual(
        dirs.slice(1).map((dir) => reads.get(path.join(dir, "status.json"))),
        [1, 1, 1],
        "entries retained under the byte budget remain cache hits",
      );
      assert.ok(readStatus(dirs[0]!, statusRead));
      assert.equal(
        reads.get(path.join(dirs[0]!, "status.json")),
        2,
        "the byte-budget overflow must evict the oldest source entry",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("evicts multiple oldest entries when one status crosses the source-byte budget", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-cache-eviction-"));
    try {
      const sourceBytes = new Map<string, number>();
      const reads = new Map<string, number>();
      const statusRead = sourceSizedStatusRead(sourceBytes, reads);
      const retainedSize = Math.floor(MAX_STATUS_CACHE_BYTES / 5);
      const retainedSizes = Array.from({ length: 5 }, () => retainedSize);
      assert.ok(MAX_STATUS_CACHE_BYTES - retainedSize * 5 < retainedSize);
      assert.ok(
        retainedSizes.reduce((total, size) => total + size, 0) + MAX_ASYNC_STATUS_BYTES >
          MAX_STATUS_CACHE_BYTES,
      );

      const dirs = retainedSizes.map((size, index) => {
        const dir = createAsyncDir(root, `run-cache-eviction-${index}`, {
          runId: `run-cache-eviction-${index}`,
          mode: "single",
          state: "running",
          startedAt: 100,
          steps: [{ agent: "worker", status: "running" }],
        });
        sourceBytes.set(path.join(dir, "status.json"), size);
        return dir;
      });
      dirs.forEach((dir) => assert.ok(readStatus(dir, statusRead)));

      const extraDir = createAsyncDir(root, "run-cache-eviction-extra", {
        runId: "run-cache-eviction-extra",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      sourceBytes.set(path.join(extraDir, "status.json"), MAX_ASYNC_STATUS_BYTES);
      assert.ok(readStatus(extraDir, statusRead));

      assert.equal(reads.get(path.join(extraDir, "status.json")), 1);
      dirs.slice(2).forEach((dir) => assert.ok(readStatus(dir, statusRead)));
      assert.deepEqual(
        dirs.slice(2).map((dir) => reads.get(path.join(dir, "status.json"))),
        [1, 1, 1],
        "entries retained under the byte budget remain cache hits",
      );

      dirs.slice(0, 2).forEach((dir) => assert.ok(readStatus(dir, statusRead)));
      assert.deepEqual(
        dirs.slice(0, 2).map((dir) => reads.get(path.join(dir, "status.json"))),
        [2, 2],
        "the byte-budget overflow must evict both oldest source entries",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads bounded eight-child terminal evidence and supports a lifecycle merge/write", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-terminal-evidence-"));
    try {
      const terminalResult = maximalTerminalResult();
      const status = {
        runId: "run-terminal-evidence",
        mode: "parallel",
        state: "complete",
        startedAt: 100,
        lifecycle: { generation: 0 },
        steps: Array.from({ length: MAX_TOP_LEVEL_PARALLEL_TASKS }, (_, index) => ({
          agent: `worker-${index}`,
          status: "complete",
          terminalResult,
        })),
        diagnosticPayload: "",
      };
      // Unknown status fields are intentionally preserved at this boundary;
      // fill the existing envelope so this is a near-limit, not merely >1 MiB,
      // regression fixture.
      const paddingBytes =
        MAX_ATTRIBUTION_STATUS_BYTES -
        Buffer.byteLength(JSON.stringify(status), "utf-8") -
        MAX_SUBAGENT_TERMINAL_SNAPSHOT_BYTES / 4;
      assert.ok(paddingBytes > 0);
      status.diagnosticPayload = "x".repeat(paddingBytes);
      const serialized = JSON.stringify(status);
      const serializedBytes = Buffer.byteLength(serialized, "utf-8");
      assert.ok(
        serializedBytes > MAX_ATTRIBUTION_STATUS_BYTES - MAX_SUBAGENT_TERMINAL_SNAPSHOT_BYTES,
      );
      assert.ok(serializedBytes <= MAX_ATTRIBUTION_STATUS_BYTES);
      assert.equal(
        MAX_ATTRIBUTION_STATUS_BYTES,
        MAX_SUBAGENT_TERMINAL_SNAPSHOT_BYTES * MAX_TOP_LEVEL_PARALLEL_TASKS * 2,
      );
      assert.equal(MAX_ASYNC_STATUS_BYTES, MAX_ATTRIBUTION_STATUS_BYTES);

      const dir = path.join(root, "run-terminal-evidence");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "status.json"), serialized, "utf-8");

      const readable = readStatus(dir, { cache: false, sleep: () => {} });
      assert.ok(readable);
      assert.equal(readable.steps?.length, MAX_TOP_LEVEL_PARALLEL_TASKS);
      const expectedEvidenceBytes = Math.ceil(MAX_SUBAGENT_TERMINAL_SNAPSHOT_BYTES / 6);
      assertAvailableEvidence(
        readable.steps?.[0]?.terminalResult?.facts.attempts[0]?.workspace.baseline,
        expectedEvidenceBytes,
      );

      const merged = mergeAndWriteSourceRunnerStatus(dir, {
        ...readable,
        endedAt: 200,
      });
      assert.equal(merged.endedAt, 200);
      const persisted = readStatus(dir, { cache: false, sleep: () => {} });
      assert.equal(persisted?.endedAt, 200);
      assertAvailableEvidence(
        persisted?.steps?.[0]?.terminalResult?.facts.attempts[0]?.workspace.baseline,
        expectedEvidenceBytes,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("caches deterministic oversized failures until metadata or explicit invalidation changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-oversize-cache-"));
    try {
      const dir = path.join(root, "run-oversized");
      fs.mkdirSync(dir, { recursive: true });
      const statusPath = path.join(dir, "status.json");
      fs.writeFileSync(statusPath, "x".repeat(MAX_ASYNC_STATUS_BYTES + 1), "utf-8");
      const metadata = fs.statSync(statusPath);
      let reads = 0;
      let sleeps = 0;
      const statusRead = {
        statSync: () => metadata,
        readFileSync: () => {
          reads++;
          return fs.readFileSync(statusPath, "utf-8");
        },
        sleep: () => {
          sleeps++;
        },
      };
      const firstIssues: Array<{ statusPath: string }> = [];
      listAsyncRuns(root, {
        reconcile: false,
        statusRead,
        onUnreadable: (issue) => firstIssues.push(issue),
      });
      assert.equal(firstIssues.length, 1);
      assert.equal(reads, 0, "oversized status must be rejected before reading its body");
      assert.equal(sleeps, 1);

      const secondIssues: Array<{ statusPath: string }> = [];
      listAsyncRuns(root, {
        reconcile: false,
        statusRead,
        onUnreadable: (issue) => secondIssues.push(issue),
      });
      assert.equal(secondIssues.length, 1);
      assert.equal(reads, 0, "unchanged oversized status must use deterministic failure cache");
      assert.equal(sleeps, 1);

      invalidateStatusCache(statusPath);
      listAsyncRuns(root, { reconcile: false, statusRead });
      assert.equal(sleeps, 2, "explicit invalidation must permit one fresh retry");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not retain malformed status body text in error diagnostics", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-diagnostic-privacy-"));
    try {
      const dir = createAsyncDir(root, "run-diagnostic-privacy", {
        runId: "run-diagnostic-privacy",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      const statusPath = path.join(dir, "status.json");
      const sentinel = "MALFORMED_STATUS_BODY_SENTINEL";
      fs.writeFileSync(statusPath, `{ "runId": "${sentinel}`, "utf-8");
      let captured: unknown;
      assert.throws(
        () =>
          readStatus(dir, {
            cache: false,
            sleep: () => {},
          }),
        (error: unknown) => {
          captured = error;
          return isAsyncStatusReadError(error) && error.failure === "invalid";
        },
      );
      assert.ok(isAsyncStatusReadError(captured));
      const diagnostic = captured as Error & { cause?: unknown };
      assert.equal(diagnostic.cause, undefined);
      const serialized = [
        diagnostic.name,
        diagnostic.message,
        diagnostic.stack,
        String(diagnostic),
        JSON.stringify(diagnostic),
        JSON.stringify(diagnostic, Object.getOwnPropertyNames(diagnostic)),
      ].join("\\n");
      assert.equal(serialized.includes(sentinel), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("converts a throwing retry wait into an unreadable status issue", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-sleep-error-"));
    try {
      const dir = createAsyncDir(root, "run-sleep-error", {
        runId: "run-sleep-error",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      fs.writeFileSync(path.join(dir, "status.json"), "{still torn", "utf-8");
      assert.throws(
        () =>
          readStatus(dir, {
            cache: false,
            sleep: () => {
              throw new Error("injected wait failure");
            },
          }),
        (error: unknown) => isAsyncStatusReadError(error) && error.failure === "unreadable",
      );
      const issues: Array<{ statusPath: string }> = [];
      assert.doesNotThrow(() =>
        listAsyncRuns(root, {
          reconcile: false,
          statusRead: {
            sleep: () => {
              throw new Error("injected wait failure");
            },
          },
          onUnreadable: (issue) => issues.push(issue),
        }),
      );
      assert.equal(issues.length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a finite root startedAt and drops malformed persisted tickets", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-boundary-fields-"));
    const statusPath = path.join(root, "status.json");
    try {
      const base = { runId: "boundary", mode: "single", state: "complete" };
      assert.throws(
        () => parsePersistedAsyncStatus(base, root, statusPath),
        /startedAt must be a finite number/,
      );
      assert.throws(
        () => parsePersistedAsyncStatus({ ...base, startedAt: Number.NaN }, root, statusPath),
        /startedAt must be a finite number/,
      );
      assert.throws(
        () =>
          parsePersistedAsyncStatus(
            {
              ...base,
              startedAt: 100,
              steps: [{ agent: "worker", status: "complete", durationMs: null }],
            },
            root,
            statusPath,
          ),
        /steps\[0\]\.durationMs must be a finite number/,
      );

      const dir = createAsyncDir(root, "run-ticket", {
        runId: "run-ticket",
        mode: "single",
        state: "complete",
        startedAt: 100,
        steps: [
          { agent: "worker", status: "complete", ticketId: { malformed: true } },
          { agent: "valid", status: "complete", ticketId: "safe-ticket-1" },
        ],
      });
      const runs = listAsyncRuns(root, { reconcile: false });
      const run = runs.find((candidate) => candidate.id === "run-ticket");
      assert.ok(run);
      assert.equal(run.steps[0]?.agent, "worker");
      assert.equal(run.steps[0]?.ticketId, undefined);
      assert.equal(run.steps[1]?.ticketId, "safe-ticket-1");
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf-8")).steps, [
        { agent: "worker", status: "complete", ticketId: { malformed: true } },
        { agent: "valid", status: "complete", ticketId: "safe-ticket-1" },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads each listed status once whether reconciliation is enabled or disabled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-read-count-"));
    try {
      createAsyncDir(root, "run-once", {
        runId: "run-once",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      let reads = 0;
      let stats = 0;
      const statusRead = {
        cache: false,
        statSync: (statusPath: string) => {
          stats++;
          return fs.statSync(statusPath);
        },
        readFileSync: (statusPath: string) => {
          reads++;
          return fs.readFileSync(statusPath, "utf-8");
        },
      };
      listAsyncRuns(root, { statusRead });
      assert.equal(stats, 1);
      assert.equal(reads, 1);
      listAsyncRuns(root, { reconcile: false, statusRead });
      assert.equal(stats, 2);
      assert.equal(reads, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries one torn read after the bounded delay and accepts the valid status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-retry-"));
    try {
      const dir = createAsyncDir(root, "run-retry", {
        runId: "run-retry",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      const valid = fs.readFileSync(path.join(dir, "status.json"), "utf-8");
      let reads = 0;
      const delays: number[] = [];
      const status = readStatus(dir, {
        cache: false,
        readFileSync: () => (++reads === 1 ? "{torn" : valid),
        sleep: (delayMs) => delays.push(delayMs),
      });
      assert.equal(status?.runId, "run-retry");
      assert.equal(reads, 2);
      assert.deepEqual(delays, [ASYNC_STATUS_RETRY_DELAY_MS]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves persistent invalid, unreadable, and oversized statuses untouched", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-invalid-"));
    try {
      const invalidDir = createAsyncDir(root, "run-invalid", {
        runId: "run-invalid",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      const invalidPath = path.join(invalidDir, "status.json");
      fs.writeFileSync(invalidPath, "{still-torn", "utf-8");
      const oversizedDir = path.join(root, "run-oversized");
      fs.mkdirSync(oversizedDir, { recursive: true });
      const oversizedPath = path.join(oversizedDir, "status.json");
      fs.writeFileSync(oversizedPath, "x".repeat(MAX_ASYNC_STATUS_BYTES + 1), "utf-8");
      const beforeInvalid = fs.readFileSync(invalidPath);
      const beforeOversized = fs.readFileSync(oversizedPath);
      const issues: Array<{ statusPath: string }> = [];
      let invalidReads = 0;
      let oversizedReads = 0;
      const runs = listAsyncRuns(root, {
        reconcile: false,
        onUnreadable: (issue) => issues.push(issue),
        statusRead: {
          readFileSync: (statusPath) => {
            if (statusPath === invalidPath) {
              invalidReads++;
              return "{still-torn";
            }
            oversizedReads++;
            return fs.readFileSync(statusPath, "utf-8");
          },
          sleep: () => {},
        },
      });
      assert.deepEqual(runs, []);
      assert.equal(issues.length, 2);
      assert.equal(invalidReads, 2);
      assert.equal(oversizedReads, 0, "oversized status must be rejected before reading its body");
      assert.deepEqual(fs.readFileSync(invalidPath), beforeInvalid);
      assert.deepEqual(fs.readFileSync(oversizedPath), beforeOversized);
      assert.equal(fs.existsSync(path.join(root, "quarantined-async-subagent-runs")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries permission/read failures exactly once", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-read-error-"));
    try {
      createAsyncDir(root, "run-permission", {
        runId: "run-permission",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      const error = Object.assign(new Error("denied"), { code: "EACCES" });
      let stats = 0;
      let reads = 0;
      let sleeps = 0;
      const issues: Array<{ statusPath: string }> = [];
      const runs = listAsyncRuns(root, {
        reconcile: false,
        onUnreadable: (issue) => issues.push(issue),
        statusRead: {
          statSync: () => {
            stats++;
            throw error;
          },
          readFileSync: () => {
            reads++;
            return "";
          },
          sleep: () => {
            sleeps++;
          },
        },
      });
      assert.deepEqual(runs, []);
      assert.equal(issues.length, 1);
      assert.equal(stats, 2);
      assert.equal(reads, 0);
      assert.equal(sleeps, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns valid restore candidates plus unreadable status issues", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-restore-scan-"));
    try {
      createAsyncDir(root, "run-owner", {
        runId: "run-owner",
        sessionId: "session-owner",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      createAsyncDir(root, "run-other", {
        runId: "run-other",
        sessionId: "session-other",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      const badSessionDir = createAsyncDir(root, "bad-session", {
        runId: "bad-session",
        sessionId: { value: "session-owner" },
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });
      const badJsonDir = path.join(root, "bad-json");
      fs.mkdirSync(badJsonDir, { recursive: true });
      fs.writeFileSync(path.join(badJsonDir, "status.json"), "{bad json", "utf-8");

      const filteredResult = scanAsyncRunsForRestore(root, {
        states: ["queued", "running"],
        sessionId: "session-owner",
      });
      assert.deepEqual(
        filteredResult.runs.map((run) => run.id),
        ["run-owner"],
      );
      assert.deepEqual(
        filteredResult.issues.map((issue) => issue.entry).sort((a, b) => a.localeCompare(b)),
        ["bad-json", "bad-session"],
      );
      assert.ok(filteredResult.issues.every((issue) => issue.asyncDir.startsWith(root)));
      assert.ok(filteredResult.issues.every((issue) => issue.statusPath.endsWith("status.json")));
      assert.deepEqual(fs.readFileSync(path.join(badJsonDir, "status.json"), "utf-8"), "{bad json");
      assert.equal(fs.existsSync(badSessionDir), true);

      const fullResult = scanAsyncRunsForRestore(root, { states: ["queued", "running"] });
      assert.deepEqual(
        fullResult.issues.map((issue) => issue.entry).sort((a, b) => a.localeCompare(b)),
        ["bad-json", "bad-session"],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps restore scans strict for root listing failures and reports per-entry read errors", () => {
    const rootFile = path.join(os.tmpdir(), `pi-async-root-file-${Date.now()}`);
    fs.writeFileSync(rootFile, "file", "utf-8");
    try {
      assert.throws(() => scanAsyncRunsForRestore(rootFile), /Failed to list async runs/);
    } finally {
      fs.rmSync(rootFile, { force: true });
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-read-failure-"));
    try {
      const runDir = path.join(root, "run-io-failure");
      fs.mkdirSync(path.join(runDir, "status.json"), { recursive: true });
      const result = scanAsyncRunsForRestore(root);
      assert.deepEqual(result.runs, []);
      assert.equal(result.issues[0]?.statusPath, path.join(runDir, "status.json"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("repairs stale running runs before listing active async runs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-stale-list-"));
    const resultsDir = path.join(root, "results");
    try {
      const asyncDir = createAsyncDir(root, "run-stale", {
        runId: "run-stale",
        mode: "single",
        state: "running",
        pid: 12345,
        startedAt: 100,
        lastUpdate: 100,
        steps: [{ agent: "scout", status: "running", startedAt: 100 }],
      });

      const active = listAsyncRuns(root, {
        states: ["running"],
        resultsDir,
        kill: () => {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        },
        now: () => 200,
      });
      assert.equal(active.length, 0);
      const failed = listAsyncRuns(root, { states: ["failed"], resultsDir, reconcile: false });
      assert.equal(failed[0]?.id, "run-stale");
      assert.equal(failed[0]?.steps[0]?.status, "failed");
      const repairedResult = JSON.parse(
        fs.readFileSync(path.join(resultsDir, "run-stale.json"), "utf-8"),
      ) as { generation?: number };
      const repairedStatus = JSON.parse(
        fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
      ) as { lifecycle?: { generation?: number } };
      assert.equal(repairedResult.generation, repairedStatus.lifecycle?.generation);
      assert.equal(fs.existsSync(path.join(resultsDir, "run-stale.json")), true);
      assert.match(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8"), /repaired_stale/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses awaited-style wording for top-level async parallel runs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-top-parallel-wording-"));
    try {
      createAsyncDir(root, "run-parallel", {
        runId: "run-parallel",
        mode: "parallel",
        state: "running",
        startedAt: 100,
        lastUpdate: 300,
        currentStep: 0,
        steps: [
          { agent: "scout", status: "running", durationMs: 12_000 },
          { agent: "reviewer", status: "running", durationMs: 11_000 },
          { agent: "worker", status: "pending" },
        ],
      });
      const text = formatAsyncRunList(listAsyncRuns(root, { states: ["running"] }));
      assert.match(text, /run-parallel \| running .*\| parallel \| 2 agents running · 0\/3 done/);
      assert.doesNotMatch(text, /step 1\/1/);
      assert.doesNotMatch(text, /parallel group/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes terminal outcome counts for failed top-level async parallel runs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-terminal-parallel-counts-"));
    try {
      createAsyncDir(root, "run-parallel-failed", {
        runId: "run-parallel-failed",
        mode: "parallel",
        state: "failed",
        startedAt: 100,
        lastUpdate: 300,
        currentStep: 0,
        steps: [
          { agent: "scout", status: "failed" },
          { agent: "reviewer", status: "failed" },
          { agent: "worker", status: "paused" },
        ],
      });
      const text = formatAsyncRunList(listAsyncRuns(root, { states: ["failed"] }));
      assert.match(
        text,
        /run-parallel-failed \| failed \| parallel \| 0\/3 done · 2 failed · 1 paused/,
      );
      assert.doesNotMatch(text, /0 agents running/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores retired parallel metadata without rewriting historical status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-invalid-parallel-group-"));
    try {
      const dir = createAsyncDir(root, "run-invalid-group", {
        runId: "run-invalid-group",
        mode: "chain",
        state: "running",
        startedAt: 100,
        lastUpdate: 300,
        currentStep: 0,
        // These ignored legacy extras stay only to exercise historical open-object safety; status.json must not be rewritten.
        chainStepCount: 2,
        parallelGroups: [{ start: 0, count: 3, stepIndex: 4 }, null, "bad"],
        steps: [
          { agent: "scout", status: "running", durationMs: 12_000 },
          { agent: "writer", status: "pending" },
        ],
      });
      const before = fs.readFileSync(path.join(dir, "status.json"));
      const text = formatAsyncRunList(listAsyncRuns(root, { states: ["running"] }));
      assert.match(text, /run-invalid-group \| running .* \| single \| step 1\/2/);
      assert.doesNotMatch(text, /parallel group/);
      assert.deepEqual(fs.readFileSync(path.join(dir, "status.json")), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps top-level parallel wording with ordinary status metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-parallel-invalid-group-"));
    try {
      createAsyncDir(root, "run-parallel-invalid-group", {
        runId: "run-parallel-invalid-group",
        mode: "parallel",
        state: "running",
        startedAt: 100,
        lastUpdate: 300,
        currentStep: 0,
        steps: [
          { agent: "scout", status: "running" },
          { agent: "reviewer", status: "pending" },
        ],
      });
      const text = formatAsyncRunList(listAsyncRuns(root, { states: ["running"] }));
      assert.match(text, /parallel \| 1 agent running · 0\/2 done/);
      assert.doesNotMatch(text, /step 1\/2/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps step wording for single running async jobs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-sequential-wording-"));
    try {
      createAsyncDir(root, "run-seq", {
        runId: "run-seq",
        mode: "single",
        state: "running",
        startedAt: 100,
        lastUpdate: 300,
        currentStep: 0,
        steps: [
          { agent: "scout", status: "running", durationMs: 12_000 },
          { agent: "reviewer", status: "pending" },
        ],
      });
      const text = formatAsyncRunList(listAsyncRuns(root, { states: ["running"] }));
      assert.match(text, /step 1\/2/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("filters terminal runs to active states without scanning nested routes per run", () => {
    // Regression guard: load-time restoration calls listAsyncRuns with a
    // queued/running filter over every run dir on disk. The nested-route
    // lookup must be skipped for runs that fail the state filter, otherwise
    // session start freezes when many stale run dirs have accumulated.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-status-filter-"));
    try {
      for (let i = 0; i < 200; i++) {
        createAsyncDir(root, `run-${i}`, {
          runId: `run-${i}`,
          mode: "single",
          state: "complete",
          startedAt: 100,
          lastUpdate: 200,
          steps: [{ agent: "reviewer", status: "complete" }],
        });
      }

      const start = Date.now();
      const runs = listAsyncRuns(root, { states: ["queued", "running"] });
      const elapsed = Date.now() - start;

      assert.equal(runs.length, 0);
      // 200 terminal dirs filtered to active states should resolve in well
      // under a second. The old per-run nested-route scan blew past this.
      assert.ok(elapsed < 1000, `listAsyncRuns took ${elapsed}ms for 200 terminal runs`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves childLocation in step summaries for parallel runs (status-file round trip)", () => {
    // Regression guard: statusToSummary must carry childLocation from the
    // persisted step through to AsyncRunStepSummary. A field-by-field rewrite
    // of that mapping that drops childLocation would cause the render ticket's
    // 'line never appears' failure because the tracker's restore path feeds
    // through this summary before the first poll updates job.steps.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-child-loc-parallel-"));
    try {
      const childLocation = {
        childCwd: "/other/repo",
        displayPath: "/other/repo",
        repoName: "repo",
        branch: "feat/other",
      };
      createAsyncDir(root, "run-parallel-loc", {
        runId: "run-parallel-loc",
        mode: "parallel",
        state: "running",
        startedAt: 100,
        lastUpdate: 200,
        steps: [
          { agent: "scout", status: "complete" },
          { agent: "worker", status: "running", childLocation },
        ],
      });
      const runs = listAsyncRuns(root, { states: ["running"] });
      assert.equal(runs.length, 1);
      const step = runs[0]?.steps[1];
      assert.ok(step, "expected second step to be present");
      assert.deepEqual(
        step.childLocation,
        childLocation,
        "childLocation must survive the status-file → summary projection",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves childLocation in step summaries for single runs (status-file round trip)", () => {
    // Same guard as the parallel test above, but for single-mode runs which
    // also write childLocation into steps[0] via the single runner plan.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-child-loc-single-"));
    try {
      const childLocation = {
        childCwd: "/work/subproject",
        displayPath: "subproject",
        linkedWorktree: true as const,
        branch: "feat/sub",
      };
      createAsyncDir(root, "run-single-loc", {
        runId: "run-single-loc",
        mode: "single",
        state: "running",
        startedAt: 100,
        lastUpdate: 200,
        steps: [{ agent: "worker", status: "running", childLocation }],
      });
      const runs = listAsyncRuns(root, { states: ["running"] });
      assert.equal(runs.length, 1);
      const step = runs[0]?.steps[0];
      assert.ok(step, "expected step to be present");
      assert.deepEqual(
        step.childLocation,
        childLocation,
        "childLocation must survive the status-file → summary projection for single mode",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
