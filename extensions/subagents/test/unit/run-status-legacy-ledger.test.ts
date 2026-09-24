import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import { textContent } from "../support/run-status-fixtures.ts";

describe("historical async status compatibility", () => {
  it("loads legacy acceptance and runtime ledger fields, ignores them, and renders lifecycle status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-legacy-ledger-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-legacy-ledger");
      fs.mkdirSync(asyncDir, { recursive: true });
      const statusPath = path.join(asyncDir, "status.json");
      const historicalStatus = {
        runId: "run-legacy-ledger",
        mode: "single",
        state: "complete",
        startedAt: 100,
        lastUpdate: 200,
        activeRuntimeMs: 999999,
        activeRuntimeCheckpointAt: 123456,
        currentStep: 0,
        steps: [
          {
            agent: "worker",
            status: "complete",
            activeRuntimeMs: 888888,
            activeRuntimeCheckpointAt: 654321,
            acceptance: {
              status: "rejected",
              effectiveAcceptance: { level: "checked" },
              criteria: [{ id: "legacy", status: "satisfied" }],
              runtimeChecks: [{ id: "legacy-check", status: "passed" }],
              verifyRuns: [],
            },
          },
        ],
      };
      fs.writeFileSync(statusPath, JSON.stringify(historicalStatus, null, 2), "utf-8");
      const before = fs.readFileSync(statusPath, "utf-8");

      const result = inspectSubagentStatus(
        { id: "run-legacy-ledger" },
        { asyncDirRoot: asyncRoot, resultsDir },
      );
      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /Run: run-legacy-ledger/);
      assert.match(text, /State: complete/);
      assert.match(text, /worker complete/);
      assert.doesNotMatch(text, /acceptance|legacy-check|effectiveAcceptance|activeRuntime/i);
      assert.equal(fs.readFileSync(statusPath, "utf-8"), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not offer revive guidance for a supervisor lifecycle failure marker", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-resume-blocked-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-resume-blocked");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({
          runId: "run-resume-blocked",
          mode: "single",
          state: "failed",
          startedAt: 100,
          endedAt: 200,
          error:
            "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.",
          lifecycle: { generation: 3, resumeBlockedReason: "supervisor_lifecycle_failure" },
          steps: [{ agent: "worker", status: "failed", sessionFile: "/tmp/existing-session" }],
        }),
        "utf-8",
      );
      const result = inspectSubagentStatus(
        { id: "run-resume-blocked" },
        { asyncDirRoot: asyncRoot, resultsDir },
      );
      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /State: failed/);
      assert.match(
        text,
        /Resume: unavailable; supervisor lifecycle failure permanently blocked revival/,
      );
      assert.doesNotMatch(text, /Revive:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a completed continuation phase as already launched instead of offering revive", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-completed-continuation-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-completed-continuation");
      const sessionFile = path.join(root, "session.jsonl");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({
          runId: "run-completed-continuation",
          mode: "single",
          state: "paused",
          startedAt: 100,
          pause: { kind: "cohort_pause", summary: "Paused" },
          lifecycle: {
            generation: 2,
            continuation: { phase: "completed", continuationRunId: "continued-run" },
          },
          steps: [{ agent: "worker", status: "paused", sessionFile }],
        }),
        "utf-8",
      );
      const result = inspectSubagentStatus(
        { id: "run-completed-continuation" },
        { asyncDirRoot: asyncRoot, resultsDir },
      );
      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /Continuation: continued-run/);
      assert.match(text, /already launched its continuation/);
      assert.doesNotMatch(text, /Revive/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads legacy tool-budget status for status and list without rewriting it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-legacy-tool-budget-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-legacy-tool-budget");
      fs.mkdirSync(asyncDir, { recursive: true });
      const statusPath = path.join(asyncDir, "status.json");
      const historicalStatus = {
        runId: "run-legacy-tool-budget",
        mode: "single",
        state: "running",
        startedAt: 100,
        lastUpdate: 200,
        currentStep: 0,
        toolBudget: { hard: 4 },
        toolBudgetBlocked: true,
        steps: [
          {
            agent: "worker",
            status: "running",
            toolBudget: { hard: 4, outcome: "hard-blocked", toolCount: 4 },
            toolBudgetBlocked: true,
            terminationReason: "tool_budget_blocked",
          },
        ],
      };
      fs.writeFileSync(statusPath, JSON.stringify(historicalStatus, null, 2), "utf-8");
      const before = fs.readFileSync(statusPath, "utf-8");

      const statusResult = inspectSubagentStatus(
        { id: "run-legacy-tool-budget" },
        { asyncDirRoot: asyncRoot, resultsDir },
      );
      const statusText = textContent(statusResult);
      assert.equal(statusResult.isError, undefined);
      assert.match(statusText, /Run: run-legacy-tool-budget/);
      assert.match(statusText, /worker running/);
      assert.doesNotMatch(statusText, /toolBudget|tool_budget_blocked|hard-blocked/);

      const listResult = inspectSubagentStatus({}, { asyncDirRoot: asyncRoot, resultsDir });
      const listText = textContent(listResult);
      assert.equal(listResult.isError, undefined);
      assert.match(listText, /run-legacy-tool-budget/);
      assert.doesNotMatch(listText, /toolBudget|tool_budget_blocked|hard-blocked/);
      assert.equal(fs.readFileSync(statusPath, "utf-8"), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
