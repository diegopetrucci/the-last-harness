import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import { errno, textContent } from "../support/run-status-fixtures.ts";

describe("async run status inspection", () => {
  it("repairs stale running status and reports diagnosis plus result path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-stale-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-stale");
      fs.mkdirSync(asyncDir, { recursive: true });
      const sessionFile = path.join(root, "session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-stale",
            mode: "single",
            state: "running",
            pid: 12345,
            startedAt: 100,
            lastUpdate: 100,
            currentStep: 0,
            sessionFile,
            steps: [{ agent: "scout", status: "running", startedAt: 100, sessionFile }],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-stale" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir,
          kill: () => {
            throw errno("ESRCH");
          },
          now: () => 200,
        },
      );

      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /State: failed/);
      assert.match(text, /Diagnosis: Async runner process 12345 exited or disappeared/);
      assert.match(
        text,
        new RegExp(
          `Result: ${path.join(resultsDir, "run-stale.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      );
      assert.match(
        text,
        /Step 1: scout failed, error: Async runner process 12345 exited or disappeared/,
      );
      assert.match(
        text,
        /Revive: subagent\(\{ action: "resume", id: "run-stale", message: "\.\.\." \}\)/,
      );
      const resultJson = JSON.parse(
        fs.readFileSync(path.join(resultsDir, "run-stale.json"), "utf-8"),
      );
      assert.equal(resultJson.success, false);
      assert.equal(resultJson.results[0].sessionFile, sessionFile);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows parallel mode and aggregate progress for top-level async parallel runs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-parallel-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-parallel");
      fs.mkdirSync(asyncDir, { recursive: true });
      const runOutputPath = path.join(asyncDir, "combined-output.log");
      const firstStepOutputPath = path.join(asyncDir, "output-0.log");
      const secondStepOutputPath = path.join(asyncDir, "output-1.log");
      fs.writeFileSync(firstStepOutputPath, "reviewer one", "utf-8");
      fs.writeFileSync(secondStepOutputPath, "reviewer two", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-parallel",
            mode: "parallel",
            state: "running",
            error: "top-level async status error",
            pid: 12345,
            startedAt: 100,
            lastUpdate: 100,
            currentStep: 0,
            outputFile: runOutputPath,
            steps: [
              {
                agent: "reviewer",
                status: "running",
                startedAt: 100,
                model: "openai-codex/gpt-5.5:high",
              },
              {
                agent: "reviewer",
                status: "running",
                startedAt: 100,
                model: "anthropic/claude-haiku-4-5",
                thinking: "low",
              },
              { agent: "reviewer", status: "pending" },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-parallel" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
          kill: () => true,
          now: () => 200,
        },
      );

      const text = textContent(result);
      assert.match(text, /Mode: parallel/);
      assert.match(text, /Error: top-level async status error/);
      assert.match(text, /Progress: 2 agents running · 0\/3 done/);
      assert.match(
        text,
        new RegExp(`Output: ${runOutputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
      assert.match(text, /Agent 1\/3: reviewer running \(gpt-5\.5 · thinking high\)/);
      assert.match(text, /Agent 2\/3: reviewer running \(claude-haiku-4-5 · thinking low\)/);
      assert.match(text, /Agent 3\/3: reviewer pending/);
      assert.doesNotMatch(text, /openai-codex\/gpt-5\.5/);
      assert.match(
        text,
        new RegExp(`  Output: ${firstStepOutputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
      assert.match(
        text,
        new RegExp(`  Output: ${secondStepOutputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
      assert.doesNotMatch(text, /Step 1: reviewer/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces steering counts and timestamps in exact and list status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-steering-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-steered");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-steered",
            mode: "single",
            state: "running",
            pid: 12345,
            startedAt: 100,
            lastUpdate: 200,
            currentStep: 0,
            steerCount: 2,
            lastSteerAt: 150,
            steps: [
              {
                agent: "worker",
                status: "running",
                startedAt: 100,
                steerCount: 2,
                lastSteerAt: 150,
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const exact = inspectSubagentStatus(
        { id: "run-steered" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
          kill: () => true,
          now: () => 250,
        },
      );
      const exactText = textContent(exact);
      assert.equal(exact.isError, undefined);
      assert.match(exactText, /Steering: 2 steers, last 1970-01-01T00:00:00\.150Z/);
      assert.match(
        exactText,
        /Step 1: worker running, steering: 2 steers, last 1970-01-01T00:00:00\.150Z/,
      );

      const list = inspectSubagentStatus(
        {},
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
          kill: () => true,
          now: () => 250,
        },
      );
      const listText = textContent(list);
      assert.equal(list.isError, undefined);
      assert.match(listText, /2 steers \| last steer 1970-01-01T00:00:00\.150Z/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows indexed revive guidance for completed multi-child async runs with child sessions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-multi-resume-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-multi");
      const firstSession = path.join(root, "a.jsonl");
      const secondSession = path.join(root, "b.jsonl");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(firstSession, "", "utf-8");
      fs.writeFileSync(secondSession, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-multi",
            mode: "parallel",
            state: "complete",
            startedAt: 100,
            lastUpdate: 200,
            steps: [
              { agent: "a", status: "complete", sessionFile: firstSession },
              { agent: "b", status: "complete", sessionFile: secondSession },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-multi" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
        },
      );

      const text = textContent(result);
      assert.match(
        text,
        /Revive child: subagent\(\{ action: "resume", id: "run-multi", index: 0, message: "\.\.\." \}\)/,
      );
      assert.doesNotMatch(text, /unsupported for multi-child/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("suppresses poisoned-child resume hints while preserving recoverable siblings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-exhausted-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-exhausted-mixed");
      const exhaustedSession = path.join(root, "exhausted.jsonl");
      const pausedSession = path.join(root, "paused.jsonl");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(exhaustedSession, "", "utf-8");
      fs.writeFileSync(pausedSession, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-exhausted-mixed",
            mode: "parallel",
            state: "failed",
            startedAt: 100,
            lastUpdate: 200,
            steps: [
              {
                agent: "developer",
                status: "failed",
                timedOut: true,
                timeoutOwner: "role",
                terminationReason: "timed_out",
                sessionFile: exhaustedSession,
              },
              { agent: "reviewer", status: "paused", sessionFile: pausedSession },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const text = textContent(
        inspectSubagentStatus(
          { id: "run-exhausted-mixed" },
          { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
        ),
      );
      assert.match(text, /Budget exhausted: this child instance is permanently expired/);
      assert.match(
        text,
        /Revive child: subagent\(\{ action: "resume", id: "run-exhausted-mixed", index: 1, message: "\.\.\." \}\)/,
      );
      assert.doesNotMatch(
        text,
        /Revive child: subagent\(\{ action: "resume", id: "run-exhausted-mixed", index: 0/,
      );

      const oldRunDeadlineDir = path.join(asyncRoot, "run-old-deadline");
      const oldRunSession = path.join(root, "old-run.jsonl");
      fs.mkdirSync(oldRunDeadlineDir, { recursive: true });
      fs.writeFileSync(oldRunSession, "", "utf-8");
      fs.writeFileSync(
        path.join(oldRunDeadlineDir, "status.json"),
        JSON.stringify({
          runId: "run-old-deadline",
          mode: "single",
          state: "failed",
          startedAt: 100,
          lastUpdate: 200,
          steps: [
            {
              agent: "legacy-worker",
              status: "failed",
              timedOut: true,
              timeoutOwner: "run",
              terminationReason: "timed_out",
              sessionFile: oldRunSession,
            },
          ],
        }),
        "utf-8",
      );
      const oldDeadlineText = textContent(
        inspectSubagentStatus(
          { id: "run-old-deadline" },
          { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
        ),
      );
      assert.doesNotMatch(oldDeadlineText, /Budget exhausted/);
      assert.match(
        oldDeadlineText,
        /Revive: subagent\(\{ action: "resume", id: "run-old-deadline", message: "\.\.\." \}\)/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses original child indexes when result metadata contains invalid children", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-original-index-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "b.jsonl");
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(resultsDir, "run-result-index.json"),
        JSON.stringify(
          {
            id: "run-result-index",
            success: false,
            state: "failed",
            results: [
              { output: "missing agent", sessionFile: path.join(root, "a.jsonl") },
              { agent: "b", success: false, sessionFile },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-result-index" },
        { asyncDirRoot: asyncRoot, resultsDir },
      );

      const text = textContent(result);
      assert.match(
        text,
        /Revive child: subagent\(\{ action: "resume", id: "run-result-index", index: 1, message: "\.\.\." \}\)/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous async run id prefixes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-ambiguous-"));
    try {
      const asyncRoot = path.join(root, "runs");
      fs.mkdirSync(path.join(asyncRoot, "run-aa"), { recursive: true });
      fs.mkdirSync(path.join(asyncRoot, "run-ab"), { recursive: true });

      const result = inspectSubagentStatus(
        { id: "run-a" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
        },
      );

      assert.equal(result.isError, true);
      assert.match(
        textContent(result),
        /Ambiguous subagent run id prefix 'run-a' matched: async:run-aa, async:run-ab/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects path-like async run ids", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-paths-"));
    try {
      const result = inspectSubagentStatus(
        { id: "../run" },
        {
          asyncDirRoot: path.join(root, "runs"),
          resultsDir: path.join(root, "results"),
        },
      );

      assert.equal(result.isError, true);
      assert.match(textContent(result), /id must be a non-empty safe id token/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not advertise revive for result fallback with only a top-level session file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-result-no-child-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      fs.mkdirSync(path.join(asyncRoot, "run-session-only"), { recursive: true });
      fs.mkdirSync(resultsDir, { recursive: true });
      const sessionFile = path.join(root, "session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(resultsDir, "run-session-only.json"),
        JSON.stringify(
          {
            id: "run-session-only",
            success: false,
            state: "failed",
            sessionFile,
            summary: "missing child metadata",
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-session-only" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir,
        },
      );

      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /Resume: unavailable/);
      assert.doesNotMatch(text, /Revive:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to an existing result when async dir has no status file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-result-fallback-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      fs.mkdirSync(path.join(asyncRoot, "run-result-only"), { recursive: true });
      fs.mkdirSync(resultsDir, { recursive: true });
      const sessionFile = path.join(root, "session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(resultsDir, "run-result-only.json"),
        JSON.stringify(
          {
            id: "run-result-only",
            agent: "worker",
            success: false,
            state: "failed",
            sessionFile,
            summary: "worker-a:\nfirst line\nsecond line\n\nworker-b:\nthird line",
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-result-only" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir,
        },
      );

      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /State: failed/);
      assert.match(text, /Result: /);
      assert.match(
        text,
        /Revive: subagent\(\{ action: "resume", id: "run-result-only", message: "\.\.\." \}\)/,
      );
      assert.ok(
        text.includes("worker-a:\nfirst line\nsecond line\n\nworker-b:\nthird line"),
        "multi-paragraph async result summary should preserve its document structure",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the requested direct child index for continued status guidance", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-indexed-continuation-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-indexed");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({
          runId: "run-indexed",
          mode: "parallel",
          state: "continued",
          startedAt: 100,
          lastUpdate: 200,
          steps: [
            { agent: "zero", status: "continued" },
            { agent: "one", status: "continued" },
          ],
          lifecycle: {
            continuationsByIndex: {
              "0": { phase: "continued", continuationRunId: "continuation-zero" },
              "1": { phase: "continued", continuationRunId: "continuation-one" },
            },
          },
        }),
        "utf-8",
      );

      const childOne = textContent(
        inspectSubagentStatus(
          { id: "run-indexed", index: 1 },
          { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
        ),
      );
      assert.match(childOne, /Continuation: continuation-one/);
      assert.doesNotMatch(childOne, /continuation-zero/);

      const childZero = textContent(
        inspectSubagentStatus(
          { id: "run-indexed", index: 0 },
          { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
        ),
      );
      assert.match(childZero, /Continuation: continuation-zero/);
      assert.doesNotMatch(childZero, /continuation-one/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("suppresses revive hint for single-child run when runExhausted is true even if child is unmarked", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-run-exhausted-single-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-exhausted-single");
      const sessionFile = path.join(root, "session.jsonl");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-exhausted-single",
            mode: "single",
            state: "failed",
            startedAt: 100,
            lastUpdate: 200,
            timedOut: true,
            timeoutOwner: "role",
            terminationReason: "timed_out",
            steps: [
              {
                agent: "developer",
                status: "failed",
                sessionFile,
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const text = textContent(
        inspectSubagentStatus(
          { id: "run-exhausted-single" },
          { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
        ),
      );
      assert.match(text, /Budget exhausted: this child instance is permanently expired/);
      assert.doesNotMatch(text, /Revive:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
