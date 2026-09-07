import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  formatAsyncRunList,
  listAsyncRuns,
  scanAsyncRunsForRestore,
} from "../../src/runs/background/async-status.ts";

function createAsyncDir(root: string, id: string, status: Record<string, unknown>): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status), "utf-8");
  return dir;
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
      assert.match(formatAsyncRunList(runs), /output: .*output-1\.log/);
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

  it("sorts continued runs as terminal non-active work instead of completed success", () => {
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
      assert.match(formatAsyncRunList(runs), /run-continued \| continued/);
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

  it("reads historical paused payloads that predate skipped acceptance ledgers", () => {
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
                  message: "Structured acceptance report missing.",
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

  it("surfaces malformed status files instead of silently skipping them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-bad-status-"));
    const dir = path.join(root, "broken-run");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "status.json"), "{not-json", "utf-8");
    try {
      assert.throws(() => listAsyncRuns(root), /Failed to parse async status file/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed persisted session ids unless filters skip them first", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-bad-session-id-"));
    try {
      createAsyncDir(root, "bad-session", {
        runId: "bad-session",
        sessionId: { value: "session" },
        mode: "single",
        state: "complete",
        startedAt: 100,
        steps: [{ agent: "worker", status: "complete" }],
      });

      assert.deepEqual(listAsyncRuns(root, { states: ["running"] }), []);
      assert.deepEqual(listAsyncRuns(root, { sessionId: "session-owner" }), []);
      assert.throws(() => listAsyncRuns(root), /sessionId must be a string/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns valid restore candidates plus structured corrupt-entry issues", () => {
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
      createAsyncDir(root, "bad-session", {
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
        [...filteredResult.issues]
          .map((issue) => [issue.entry, issue.kind])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        [
          ["bad-json", "json_parse"],
          ["bad-session", "persisted_validation"],
        ],
      );

      const fullResult = scanAsyncRunsForRestore(root, { states: ["queued", "running"] });
      assert.deepEqual(
        [...fullResult.issues]
          .map((issue) => [issue.entry, issue.kind])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        [
          ["bad-json", "json_parse"],
          ["bad-session", "persisted_validation"],
        ],
      );
      assert.ok(filteredResult.issues.every((issue) => issue.asyncDir.startsWith(root)));
      assert.ok(filteredResult.issues.every((issue) => issue.statusPath.endsWith("status.json")));
      assert.ok(
        filteredResult.issues.every(
          (issue) =>
            issue.fingerprint?.algorithm === "sha256" &&
            typeof issue.fingerprint.value === "string" &&
            issue.fingerprint.value.length > 0,
        ),
      );
      assert.ok(fullResult.issues.every((issue) => issue.asyncDir.startsWith(root)));
      assert.ok(fullResult.issues.every((issue) => issue.statusPath.endsWith("status.json")));
      assert.ok(
        fullResult.issues.every(
          (issue) =>
            issue.fingerprint?.algorithm === "sha256" &&
            typeof issue.fingerprint.value === "string" &&
            issue.fingerprint.value.length > 0,
        ),
      );
      assert.ok(fullResult.issues.every((issue) => !("snapshot" in issue)));
      assert.deepEqual(
        fullResult.issues.map((issue) => issue.fingerprint?.value).sort(),
        [
          createHash("sha256").update("{bad json", "utf8").digest("hex"),
          createHash("sha256")
            .update(fs.readFileSync(path.join(root, "bad-session", "status.json"), "utf-8"), "utf8")
            .digest("hex"),
        ].sort(),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps restore scans strict for root listing failures and per-entry read errors", () => {
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
      assert.throws(() => scanAsyncRunsForRestore(root), /Failed to read async status file/);
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
      assert.equal(fs.existsSync(path.join(resultsDir, "run-stale.json")), true);
      assert.match(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8"), /repaired_stale/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses foreground-style wording for top-level async parallel runs", () => {
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
});
