import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import { makeSubagentState } from "../support/helpers.ts";

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function textContent(result: ReturnType<typeof inspectSubagentStatus>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

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
            chainStepCount: 1,
            parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
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

  it("tails a readable transcript from async output artifacts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-transcript-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-transcript");
      fs.mkdirSync(asyncDir, { recursive: true });
      const outputPath = path.join(asyncDir, "output-0.log");
      fs.writeFileSync(outputPath, ["first line", "second line", "third line"].join("\n"), "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-transcript",
            mode: "single",
            state: "running",
            startedAt: 100,
            lastUpdate: 200,
            currentStep: 0,
            steps: [{ agent: "worker", status: "running", startedAt: 100 }],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-transcript", view: "transcript", lines: 2 },
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
          kill: () => true,
          now: () => 250,
        },
      );

      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /Run: run-transcript/);
      assert.match(text, /Step: 0 \(worker\) \| running/);
      assert.match(
        text,
        new RegExp(
          `Transcript tail from ${outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(tail truncated\\):`,
        ),
      );
      assert.doesNotMatch(text, /first line/);
      assert.match(text, /second line/);
      assert.match(text, /third line/);
      assert.match(
        text,
        new RegExp(`Output: ${outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fall back to another child output when an explicit transcript index output is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-transcript-index-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-indexed-transcript");
      fs.mkdirSync(asyncDir, { recursive: true });
      const wrongOutputPath = path.join(asyncDir, "output-0.log");
      fs.writeFileSync(wrongOutputPath, "WRONG_CHILD_OUTPUT", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-indexed-transcript",
            mode: "parallel",
            state: "running",
            startedAt: 100,
            lastUpdate: 200,
            currentStep: 0,
            outputFile: wrongOutputPath,
            steps: [
              { agent: "worker", status: "running", startedAt: 100 },
              { agent: "reviewer", status: "pending", recentOutput: ["RIGHT_CHILD_RECENT"] },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-indexed-transcript", view: "transcript", index: 1 },
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
          kill: () => true,
          now: () => 250,
        },
      );

      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /Agent: 1 \(reviewer\) \| pending/);
      assert.match(text, /Recent output from status\.json:/);
      assert.match(text, /RIGHT_CHILD_RECENT/);
      assert.doesNotMatch(text, /WRONG_CHILD_OUTPUT/);
      assert.doesNotMatch(
        text,
        new RegExp(
          `Transcript tail from ${wrongOutputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to tail status outputFile paths outside the async directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-transcript-escape-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-escape");
      fs.mkdirSync(asyncDir, { recursive: true });
      const outsideOutput = path.join(root, "outside.log");
      fs.writeFileSync(outsideOutput, "OUTSIDE_SENTINEL", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-escape",
            mode: "single",
            state: "complete",
            startedAt: 100,
            lastUpdate: 200,
            outputFile: path.relative(asyncDir, outsideOutput),
            steps: [],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-escape", view: "transcript" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
        },
      );

      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /Output read failed .*outside trusted roots/);
      assert.doesNotMatch(text, /OUTSIDE_SENTINEL/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses symlink session transcript paths even under trusted roots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-transcript-session-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-session-symlink");
      const sessionRoot = path.join(root, "sessions");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.mkdirSync(sessionRoot, { recursive: true });
      const outsideSession = path.join(root, "outside-session.jsonl");
      const linkedSession = path.join(sessionRoot, "session.jsonl");
      fs.writeFileSync(
        outsideSession,
        `${JSON.stringify({ message: { role: "assistant", content: "OUTSIDE_SESSION_SENTINEL" } })}\n`,
        "utf-8",
      );
      fs.symlinkSync(outsideSession, linkedSession);
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-session-symlink",
            mode: "single",
            state: "complete",
            startedAt: 100,
            lastUpdate: 200,
            steps: [{ agent: "worker", status: "complete", sessionFile: linkedSession }],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-session-symlink", view: "transcript", index: 0 },
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
          sessionRoots: [sessionRoot],
        },
      );

      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /Session read failed .*Refusing to read symlink session transcript path/);
      assert.match(
        text,
        new RegExp(`Session: ${linkedSession.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
      assert.doesNotMatch(text, /OUTSIDE_SESSION_SENTINEL/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows an active read-only fleet view with transcript commands", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-fleet-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-fleet");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(path.join(asyncDir, "output-0.log"), "worker output", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-fleet",
            mode: "parallel",
            state: "running",
            startedAt: 100,
            lastUpdate: 200,
            currentStep: 0,
            chainStepCount: 1,
            parallelGroups: [{ start: 0, count: 2, stepIndex: 0 }],
            steps: [
              { agent: "worker", status: "running", startedAt: 100 },
              { agent: "reviewer", status: "pending" },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const state = makeSubagentState({
        foregroundControls: new Map([
          [
            "fg-run",
            {
              runId: "fg-run",
              mode: "single",
              startedAt: 100,
              updatedAt: 250,
              currentAgent: "scout",
              currentIndex: 0,
              lastActivityAt: 240,
            },
          ],
        ]),
      });

      const result = inspectSubagentStatus(
        { view: "fleet" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
          state,
          kill: () => true,
          now: () => 250,
        },
      );

      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /Subagent fleet: 2 active/);
      assert.match(text, /Foreground runs:/);
      assert.match(text, /fg-run \| running \| scout/);
      assert.match(text, /Async runs:/);
      assert.match(text, /run-fleet \| running .*\| parallel \| 1 agent running · 0\/2 done/);
      assert.match(
        text,
        /transcript: subagent\(\{ action: "status", id: "run-fleet", view: "transcript" \}\)/,
      );
      assert.match(
        text,
        /transcript: subagent\(\{ action: "status", id: "run-fleet", index: 0, view: "transcript" \}\)/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes fleet active-run discovery to the current session", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-fleet-session-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const currentDir = path.join(asyncRoot, "run-current");
      const otherDir = path.join(asyncRoot, "run-other");
      fs.mkdirSync(currentDir, { recursive: true });
      fs.mkdirSync(otherDir, { recursive: true });
      fs.writeFileSync(
        path.join(currentDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-current",
            sessionId: "session-current",
            mode: "single",
            state: "running",
            startedAt: 100,
            lastUpdate: 200,
            steps: [{ agent: "worker", status: "running", startedAt: 100 }],
          },
          null,
          2,
        ),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(otherDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-other",
            sessionId: "session-other",
            mode: "single",
            state: "running",
            startedAt: 100,
            lastUpdate: 200,
            steps: [{ agent: "reviewer", status: "running", startedAt: 100 }],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const state = makeSubagentState({ currentSessionId: "session-current" });

      const result = inspectSubagentStatus(
        { view: "fleet" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
          state,
          kill: () => true,
          now: () => 250,
        },
      );

      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /run-current/);
      assert.doesNotMatch(text, /run-other/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses transcript reads for async runs owned by another session", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-transcript-session-scope-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-other-session");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(path.join(asyncDir, "output-0.log"), "OTHER_SESSION_SENTINEL", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-other-session",
            sessionId: "session-other",
            mode: "single",
            state: "running",
            startedAt: 100,
            lastUpdate: 200,
            currentStep: 0,
            steps: [{ agent: "worker", status: "running", startedAt: 100 }],
          },
          null,
          2,
        ),
        "utf-8",
      );
      const state = makeSubagentState({ currentSessionId: "session-current" });

      const result = inspectSubagentStatus(
        { id: "run-other-session", view: "transcript" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
          state,
          kill: () => true,
          now: () => 250,
        },
      );

      const text = textContent(result);
      assert.equal(result.isError, true);
      assert.match(text, /owned by the current session/);
      assert.doesNotMatch(text, /OTHER_SESSION_SENTINEL/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fall back to aggregate result output for an explicit completed child index", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-result-index-fallback-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      fs.mkdirSync(path.join(asyncRoot, "run-result-index-fallback"), { recursive: true });
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(
        path.join(resultsDir, "run-result-index-fallback.json"),
        JSON.stringify(
          {
            id: "run-result-index-fallback",
            success: true,
            summary: "AGGREGATE_SENTINEL",
            results: [{ agent: "worker", output: "first child" }, { agent: "reviewer" }],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-result-index-fallback", view: "transcript", index: 1 },
        {
          asyncDirRoot: asyncRoot,
          resultsDir,
        },
      );

      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /Child: 1 \(reviewer\)/);
      assert.match(text, /\(no transcript lines available yet\)/);
      assert.doesNotMatch(text, /AGGREGATE_SENTINEL/);
      assert.doesNotMatch(text, /first child/);
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

  it("shows nested runs under owning steps with exact status hints", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-nested-root-"));
    const route = createNestedRoute("run-nested-root");
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-nested-root");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-nested-root",
            mode: "single",
            state: "running",
            pid: 12345,
            startedAt: 100,
            lastUpdate: 100,
            steps: [{ agent: "orchestrator", status: "running", startedAt: 100 }],
          },
          null,
          2,
        ),
        "utf-8",
      );
      writeNestedEvent(route, {
        type: "subagent.nested.updated",
        ts: 150,
        parentRunId: "run-nested-root",
        parentStepIndex: 0,
        child: {
          id: "nested-status-child",
          parentRunId: "run-nested-root",
          parentStepIndex: 0,
          depth: 1,
          path: [{ runId: "run-nested-root", stepIndex: 0, agent: "orchestrator" }],
          state: "running",
          agent: "reviewer",
          currentTool: "read",
          lastUpdate: 150,
        },
      });

      const result = inspectSubagentStatus(
        { id: "run-nested-root" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
          kill: () => true,
          now: () => 200,
        },
      );

      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /Step 1: orchestrator running/);
      assert.match(text, /↳ reviewer \[nested-status-child\] running \| tool read/);
      assert.match(text, /Status: subagent\(\{ action: "status", id: "nested-status-child" \}\)/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
    }
  });

  it("repairs stale nested async descendants before rendering root status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-stale-nested-"));
    const route = createNestedRoute("run-stale-nested-root");
    const nestedAsyncDir = path.join(
      TEMP_ROOT_DIR,
      "nested-subagent-runs",
      "run-stale-nested-root",
      "nested-stale",
    );
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-stale-nested-root");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.mkdirSync(nestedAsyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-stale-nested-root",
            mode: "single",
            state: "complete",
            startedAt: 100,
            lastUpdate: 300,
            steps: [{ agent: "orchestrator", status: "complete", startedAt: 100 }],
          },
          null,
          2,
        ),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(nestedAsyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "nested-stale",
            mode: "single",
            state: "running",
            pid: 54321,
            startedAt: 150,
            lastUpdate: 150,
            steps: [{ agent: "reviewer", status: "running", startedAt: 150 }],
          },
          null,
          2,
        ),
        "utf-8",
      );
      writeNestedEvent(route, {
        type: "subagent.nested.updated",
        ts: 150,
        parentRunId: "run-stale-nested-root",
        parentStepIndex: 0,
        child: {
          id: "nested-stale",
          parentRunId: "run-stale-nested-root",
          parentStepIndex: 0,
          depth: 1,
          path: [{ runId: "run-stale-nested-root", stepIndex: 0 }],
          asyncDir: nestedAsyncDir,
          pid: 54321,
          state: "running",
          agent: "reviewer",
          lastUpdate: 150,
        },
      });

      const result = inspectSubagentStatus(
        { id: "run-stale-nested-root" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir,
          kill: () => {
            throw errno("ESRCH");
          },
          now: () => 500,
        },
      );

      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /↳ reviewer \[nested-stale\] failed/);
      assert.match(
        text,
        /1\. reviewer failed \| error: Async runner process 54321 exited or disappeared/,
      );
      assert.ok(
        fs.existsSync(
          path.join(resultsDir, "nested", "run-stale-nested-root", "nested-stale.json"),
        ),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
      fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
    }
  });

  it("shows a warning when nested projection fails for detailed status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-nested-warning-"));
    const route = createNestedRoute("run-nested-warning");
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-nested-warning");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(path.join(path.dirname(route.eventSink), "registry.json"), "{", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-nested-warning",
            mode: "single",
            state: "running",
            pid: 12345,
            startedAt: 100,
            lastUpdate: 100,
            steps: [{ agent: "orchestrator", status: "running", startedAt: 100 }],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-nested-warning" },
        { asyncDirRoot: asyncRoot, resultsDir },
      );

      assert.equal(result.isError, undefined);
      assert.match(textContent(result), /Warning: Nested status unavailable:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
    }
  });

  it("shows a warning when nested projection fails for active status lists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-nested-list-warning-"));
    const route = createNestedRoute("run-nested-list-warning");
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-nested-list-warning");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(path.join(path.dirname(route.eventSink), "registry.json"), "{", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-nested-list-warning",
            mode: "single",
            state: "running",
            pid: 12345,
            startedAt: 100,
            lastUpdate: 100,
            steps: [{ agent: "orchestrator", status: "running", startedAt: 100 }],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        {},
        { asyncDirRoot: asyncRoot, resultsDir, kill: () => true, now: () => 200 },
      );

      assert.equal(result.isError, undefined);
      assert.match(textContent(result), /Warning: Nested status unavailable:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
    }
  });

  it("resolves exact nested run ids from the nested registry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-nested-exact-"));
    const route = createNestedRoute("run-nested-exact-root");
    try {
      writeNestedEvent(route, {
        type: "subagent.nested.updated",
        ts: 150,
        parentRunId: "run-nested-exact-root",
        parentStepIndex: 0,
        child: {
          id: "nested-exact-child",
          parentRunId: "run-nested-exact-root",
          parentStepIndex: 0,
          depth: 1,
          path: [{ runId: "run-nested-exact-root", stepIndex: 0, agent: "orchestrator" }],
          state: "running",
          mode: "single",
          agent: "validator",
          steps: [{ agent: "leaf", status: "running", currentTool: "grep" }],
          lastUpdate: 150,
        },
      });

      const result = inspectSubagentStatus(
        { id: "nested-exact-child" },
        {
          asyncDirRoot: path.join(root, "runs"),
          resultsDir: path.join(root, "results"),
        },
      );

      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /Nested run: nested-exact-child/);
      assert.match(text, /Root: run-nested-exact-root/);
      assert.match(text, /Agent: validator/);
      assert.match(text, /1\. leaf running/);
      assert.match(
        text,
        /Root status: subagent\(\{ action: "status", id: "run-nested-exact-root" \}\)/,
      );
      assert.match(
        text,
        /Interrupt: subagent\(\{ action: "interrupt", id: "nested-exact-child" \}\)/,
      );
      assert.match(
        text,
        /Resume: subagent\(\{ action: "resume", id: "nested-exact-child", message: "\.\.\." \}\)/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
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

  it("labels chain parallel group children with logical step and agent numbers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-chain-parallel-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-chain");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-chain",
            mode: "chain",
            state: "running",
            pid: 12345,
            startedAt: 100,
            lastUpdate: 100,
            currentStep: 1,
            chainStepCount: 3,
            parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
            steps: [
              { agent: "scout", status: "complete", startedAt: 100 },
              { agent: "reviewer", status: "running", startedAt: 100 },
              { agent: "auditor", status: "pending" },
              { agent: "writer", status: "pending" },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-chain" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
          kill: () => true,
          now: () => 200,
        },
      );

      const text = textContent(result);
      assert.match(text, /Step 1\/3: scout complete/);
      assert.match(text, /Step 2\/3 Agent 1\/2: reviewer running/);
      assert.match(text, /Step 2\/3 Agent 2\/2: auditor pending/);
      assert.match(text, /Step 3\/3: writer pending/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps continued awaiting-supervisor status privacy-safe after unchanged resume", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-continued-privacy-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-continued");
      const sessionFile = path.join(root, "secret-session.jsonl");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-continued",
            mode: "single",
            state: "continued",
            startedAt: 100,
            endedAt: 200,
            lastUpdate: 200,
            cwd: root,
            sessionFile,
            pause: { kind: "awaiting_supervisor", summary: "Need a decision", pausedAt: 150 },
            lifecycle: {
              continuation: {
                claimToken: "claim-run-continued",
                claimedAt: 160,
                continuedAt: 200,
                continuationRunId: "revived-123",
              },
            },
            steps: [{ agent: "worker", status: "continued", sessionFile }],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-continued" },
        { asyncDirRoot: asyncRoot, resultsDir },
      );
      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /State: continued/);
      assert.match(text, /Continuation: revived-123/);
      assert.match(
        text,
        /Resume: unavailable; this paused supervisor run already launched its continuation/,
      );
      assert.doesNotMatch(text, /Session:|Dir:|secret-session|\/private|\/tmp\//);
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

  it("treats a top-level completed result as one transcript child", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-result-transcript-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      fs.mkdirSync(path.join(asyncRoot, "run-result-transcript"), { recursive: true });
      fs.mkdirSync(resultsDir, { recursive: true });
      const sessionFile = path.join(root, "session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(resultsDir, "run-result-transcript.json"),
        JSON.stringify(
          {
            id: "run-result-transcript",
            agent: "worker",
            success: false,
            state: "failed",
            sessionFile,
            summary: "legacy result transcript",
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-result-transcript", view: "transcript", index: 0 },
        {
          asyncDirRoot: asyncRoot,
          resultsDir,
        },
      );

      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /Child: 0 \(worker\)/);
      assert.match(text, /legacy result transcript/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates completed result transcript indexes as integers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-result-transcript-index-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      fs.mkdirSync(path.join(asyncRoot, "run-result-index-validation"), { recursive: true });
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(
        path.join(resultsDir, "run-result-index-validation.json"),
        JSON.stringify(
          {
            id: "run-result-index-validation",
            agent: "worker",
            success: true,
            summary: "done",
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-result-index-validation", view: "transcript", index: 0.5 },
        {
          asyncDirRoot: asyncRoot,
          resultsDir,
        },
      );

      assert.equal(result.isError, true);
      assert.match(textContent(result), /Transcript index must be an integer/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("redacts protected paused summaries in result-file fallback status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-paused-result-privacy-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      fs.mkdirSync(resultsDir, { recursive: true });
      const sessionFile = path.join(root, "private-session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(resultsDir, "run-paused-result.json"),
        JSON.stringify(
          {
            id: "run-paused-result",
            agent: "worker",
            success: false,
            state: "paused",
            pause: { kind: "awaiting_supervisor" },
            sessionFile,
            summary:
              "Paused at /private/root/project for pid 43210; output /private/results/result.md",
            results: [{ agent: "worker", sessionFile }],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const text = textContent(
        inspectSubagentStatus({ id: "run-paused-result" }, { asyncDirRoot: asyncRoot, resultsDir }),
      );
      assert.match(text, /Run: run-paused-result/);
      assert.match(text, /State: paused/);
      assert.match(text, /Paused awaiting supervisor\./);
      assert.doesNotMatch(text, /Result:|\/private\/|43210|private-session/);
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
            summary: "result survived missing status",
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
      assert.match(text, /result survived missing status/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps repaired pausing lifecycle diagnostics privacy-safe", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-pausing-privacy-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-pausing-private");
      const sessionFile = path.join(root, "private-session.jsonl");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-pausing-private",
            mode: "single",
            state: "pausing",
            pid: 12345,
            cwd: "/private/root/project",
            sessionFile,
            startedAt: 100,
            lastUpdate: 150,
            pause: {
              kind: "awaiting_supervisor",
              summary: "Need approval",
              requestedAt: 140,
              ownerPid: 12345,
            },
            steps: [
              {
                agent: "worker",
                status: "pausing",
                sessionFile,
                pause: {
                  kind: "awaiting_supervisor",
                  summary: "Need approval",
                  requestedAt: 140,
                  ownerPid: 12345,
                },
                processCleanup: {
                  supported: true,
                  attempted: true,
                  terminated: false,
                  escalatedToSigkill: true,
                  signals: ["SIGINT", "SIGTERM", "SIGKILL"],
                  warnings: ["left /private/root/worker.log behind for pid 12345"],
                },
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(asyncDir, "runner.stderr.log"),
        "private stderr path /private/root/runner.log\n",
        "utf-8",
      );
      fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "{}\n", "utf-8");

      const text = textContent(
        inspectSubagentStatus(
          { id: "run-pausing-private" },
          {
            asyncDirRoot: asyncRoot,
            resultsDir,
            kill: () => {
              throw errno("ESRCH");
            },
            now: () => 200,
          },
        ),
      );
      assert.match(text, /State: paused/);
      assert.match(text, /Diagnosis: Lifecycle state was refreshed for this paused run\./);
      assert.match(text, /Cleanup: unconfirmed\./);
      assert.doesNotMatch(
        text,
        /PID:|Cwd:|Dir:|Session:|Log:|Events:|Cleanup warning:|\/private\/|12345/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows durable paused-awaiting-supervisor guidance without private paths or detached wording", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-paused-supervisor-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-paused");
      fs.mkdirSync(asyncDir, { recursive: true });
      const sessionFile = path.join(root, "private-session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-paused",
            mode: "single",
            state: "paused",
            pid: 12345,
            cwd: "/private/root/project",
            sessionFile,
            startedAt: 100,
            lastUpdate: 200,
            pause: { kind: "awaiting_supervisor", summary: "Need approval" },
            steps: [
              {
                agent: "worker",
                status: "paused",
                sessionFile,
                pause: { kind: "awaiting_supervisor", summary: "Need approval" },
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-paused" },
        { asyncDirRoot: asyncRoot, resultsDir },
      );
      const text = textContent(result);
      assert.match(
        text,
        /Pause succeeded; this run is durably paused awaiting supervisor guidance\./,
      );
      assert.match(text, /No child process is running\./);
      assert.match(text, /Resume unchanged: subagent\(\{ action: "resume", id: "run-paused" \}\)/);
      assert.match(
        text,
        /Resume with guidance: subagent\(\{ action: "resume", id: "run-paused", message: "Supervisor replied: \.\.\." \}\)/,
      );
      assert.match(text, /Cancel: subagent\(\{ action: "interrupt", id: "run-paused" \}\)/);
      assert.doesNotMatch(text, /PID:|Cwd:|Dir:|Session:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not claim paused supervisor children are stopped or resumable while root status is still pausing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-pausing-supervisor-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-pausing");
      fs.mkdirSync(asyncDir, { recursive: true });
      const sessionFile = path.join(root, "private-session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-pausing",
            mode: "single",
            state: "pausing",
            pid: 12345,
            startedAt: 100,
            lastUpdate: 150,
            pause: {
              kind: "awaiting_supervisor",
              summary: "Need approval",
              requestedAt: 140,
              ownerPid: 12345,
            },
            steps: [
              {
                agent: "worker",
                status: "pausing",
                sessionFile,
                pause: {
                  kind: "awaiting_supervisor",
                  summary: "Need approval",
                  requestedAt: 140,
                  ownerPid: 12345,
                },
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
          { id: "run-pausing" },
          { asyncDirRoot: asyncRoot, resultsDir, kill: () => true },
        ),
      );
      assert.match(text, /Pause: awaiting supervisor \(Need approval\)/);
      assert.match(text, /Stopping\/reaping child; not resumable yet; check status again\./);
      assert.doesNotMatch(text, /No child process is running\./);
      assert.doesNotMatch(text, /Resume unchanged: subagent\(/);
      assert.doesNotMatch(text, /Resume with guidance: subagent\(/);
      assert.doesNotMatch(text, /Cancel: subagent\(/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not show cohort pause actions before the root finishes pausing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-pausing-cohort-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-pausing-cohort");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-pausing-cohort",
            mode: "parallel",
            state: "pausing",
            pid: 12345,
            startedAt: 100,
            lastUpdate: 150,
            steps: [
              {
                agent: "worker",
                status: "pausing",
                pause: {
                  kind: "awaiting_supervisor",
                  summary: "Need approval",
                  requestedAt: 140,
                  ownerPid: 12345,
                },
              },
              {
                agent: "reviewer",
                status: "paused",
                pause: { kind: "cohort_pause", requestedAt: 140 },
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
          { id: "run-pausing-cohort" },
          { asyncDirRoot: asyncRoot, resultsDir, kill: () => true },
        ),
      );
      assert.match(text, /Pause: cohort pause while another child awaited supervisor\./);
      assert.match(text, /Stopping\/reaping child; not resumable yet; check status again\./);
      assert.doesNotMatch(text, /No child process is running\./);
      assert.doesNotMatch(text, /Resume child: subagent\(/);
      assert.doesNotMatch(text, /Cancel child: subagent\(/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Acceptance rejection reason surfacing (ticket tlhm-rzlp)
  // These tests assert the reason reaches rendered output, not just status.json.
  // ---------------------------------------------------------------------------

  it("renders acceptance parse-error reason beneath a rejected step line", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-reject-parse-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-reject-parse");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-reject-parse",
            mode: "single",
            state: "done",
            startedAt: 100,
            lastUpdate: 200,
            currentStep: 0,
            steps: [
              {
                agent: "worker",
                status: "done",
                acceptance: {
                  status: "rejected",
                  explicit: false,
                  effectiveAcceptance: { level: "attested" },
                  inferredReason: [],
                  criteria: [],
                  childReportParseError:
                    "Failed to parse acceptance-report: Invalid acceptance-report: commandsRun[1].result: expected string; got boolean",
                  runtimeChecks: [
                    {
                      id: "attestation",
                      status: "failed",
                      message:
                        "Failed to parse acceptance-report: Invalid acceptance-report: commandsRun[1].result: expected string; got boolean",
                    },
                  ],
                  verifyRuns: [],
                },
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
          { id: "run-reject-parse" },
          { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), kill: () => true },
        ),
      );
      assert.match(text, /acceptance: rejected/);
      assert.match(
        text,
        /Acceptance reason: Failed to parse acceptance-report: Invalid acceptance-report/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders first failed runtimeCheck reason when there is no parse error", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-reject-check-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-reject-check");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-reject-check",
            mode: "single",
            state: "done",
            startedAt: 100,
            lastUpdate: 200,
            currentStep: 0,
            steps: [
              {
                agent: "worker",
                status: "done",
                acceptance: {
                  status: "rejected",
                  explicit: true,
                  effectiveAcceptance: { level: "checked" },
                  inferredReason: [],
                  criteria: [],
                  runtimeChecks: [
                    {
                      id: "tests-added",
                      status: "failed",
                      message: "tests-added evidence missing from acceptance report",
                    },
                  ],
                  verifyRuns: [],
                },
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
          { id: "run-reject-check" },
          { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), kill: () => true },
        ),
      );
      assert.match(text, /acceptance: rejected/);
      assert.match(text, /Acceptance reason: tests-added evidence missing from acceptance report/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders first failed verifyRuns entry when there is no parse error or failed check", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-reject-verify-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-reject-verify");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-reject-verify",
            mode: "single",
            state: "done",
            startedAt: 100,
            lastUpdate: 200,
            currentStep: 0,
            steps: [
              {
                agent: "worker",
                status: "done",
                acceptance: {
                  status: "rejected",
                  explicit: true,
                  effectiveAcceptance: { level: "verified" },
                  inferredReason: [],
                  criteria: [],
                  runtimeChecks: [],
                  verifyRuns: [
                    {
                      id: "typecheck",
                      command: "npm run typecheck",
                      exitCode: 1,
                      status: "failed",
                      durationMs: 1200,
                    },
                  ],
                },
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
          { id: "run-reject-verify" },
          { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), kill: () => true },
        ),
      );
      assert.match(text, /acceptance: rejected/);
      assert.match(text, /Acceptance reason: Verification 'typecheck' failed\./);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits the acceptance reason line when the rejection has no diagnosable cause", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-reject-no-cause-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-reject-no-cause");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-reject-no-cause",
            mode: "single",
            state: "done",
            startedAt: 100,
            lastUpdate: 200,
            currentStep: 0,
            steps: [
              {
                agent: "worker",
                status: "done",
                acceptance: {
                  status: "rejected",
                  explicit: true,
                  effectiveAcceptance: { level: "checked" },
                  inferredReason: [],
                  criteria: [],
                  runtimeChecks: [],
                  verifyRuns: [],
                },
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
          { id: "run-reject-no-cause" },
          { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), kill: () => true },
        ),
      );
      // Positive control: acceptance: rejected must be present so the negative assertion
      // below is discriminating rather than passing vacuously.
      assert.match(text, /acceptance: rejected/);
      assert.doesNotMatch(text, /Acceptance reason:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not add an acceptance reason line for non-rejected statuses", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-accept-checked-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-accept-checked");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-accept-checked",
            mode: "single",
            state: "done",
            startedAt: 100,
            lastUpdate: 200,
            currentStep: 0,
            steps: [
              {
                agent: "worker",
                status: "done",
                acceptance: {
                  status: "checked",
                  explicit: true,
                  effectiveAcceptance: { level: "checked" },
                  inferredReason: [],
                  criteria: [],
                  runtimeChecks: [{ id: "all-criteria", status: "passed", message: "OK" }],
                  verifyRuns: [],
                },
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
          { id: "run-accept-checked" },
          { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), kill: () => true },
        ),
      );
      // Positive control: acceptance: checked is present so the negative assertion is discriminating.
      assert.match(text, /acceptance: checked/);
      assert.doesNotMatch(text, /Acceptance reason:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("truncates very long acceptance rejection reasons at 200 characters", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-reject-long-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-reject-long");
      fs.mkdirSync(asyncDir, { recursive: true });
      const longReason = "A".repeat(250);
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-reject-long",
            mode: "single",
            state: "done",
            startedAt: 100,
            lastUpdate: 200,
            currentStep: 0,
            steps: [
              {
                agent: "worker",
                status: "done",
                acceptance: {
                  status: "rejected",
                  explicit: false,
                  effectiveAcceptance: { level: "attested" },
                  inferredReason: [],
                  criteria: [],
                  childReportParseError: longReason,
                  runtimeChecks: [],
                  verifyRuns: [],
                },
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
          { id: "run-reject-long" },
          { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), kill: () => true },
        ),
      );
      assert.match(text, /acceptance: rejected/);
      const reasonLine = text.split("\n").find((l) => l.includes("Acceptance reason:"));
      assert.ok(reasonLine, "Acceptance reason line should be present");
      assert.match(reasonLine, /\u2026$/);
      assert.ok(
        reasonLine.length < 250,
        `reason line should be truncated, but got length ${reasonLine.length}`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits acceptance reason line in privacy-safe (awaiting-supervisor) lifecycle", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-reject-privacy-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-reject-privacy");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-reject-privacy",
            mode: "single",
            state: "pausing",
            startedAt: 100,
            lastUpdate: 150,
            pause: { kind: "awaiting_supervisor", summary: "Need approval", requestedAt: 140 },
            currentStep: 0,
            steps: [
              {
                agent: "worker",
                status: "pausing",
                pause: { kind: "awaiting_supervisor", summary: "Need approval", requestedAt: 140 },
                acceptance: {
                  status: "rejected",
                  explicit: false,
                  effectiveAcceptance: { level: "attested" },
                  inferredReason: [],
                  criteria: [],
                  childReportParseError: "Structured acceptance report not found.",
                  runtimeChecks: [
                    {
                      id: "attestation",
                      status: "failed",
                      message: "Structured acceptance report not found.",
                    },
                  ],
                  verifyRuns: [],
                },
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
          { id: "run-reject-privacy" },
          { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), kill: () => true },
        ),
      );
      // Positive control: the step line still shows acceptance: rejected
      assert.match(text, /acceptance: rejected/);
      // The reason must be suppressed in privacy-safe lifecycle
      assert.doesNotMatch(
        text,
        /Acceptance reason:/,
        "acceptance reason must be suppressed in privacy-safe lifecycle",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes newlines in rejection reason to prevent line injection", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-reject-newline-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-reject-newline");
      fs.mkdirSync(asyncDir, { recursive: true });
      const poisonReason = "first line\nsecond line\nthird line";
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-reject-newline",
            mode: "single",
            state: "done",
            startedAt: 100,
            lastUpdate: 200,
            currentStep: 0,
            steps: [
              {
                agent: "worker",
                status: "done",
                acceptance: {
                  status: "rejected",
                  explicit: false,
                  effectiveAcceptance: { level: "attested" },
                  inferredReason: [],
                  criteria: [],
                  childReportParseError: poisonReason,
                  runtimeChecks: [],
                  verifyRuns: [],
                },
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
          { id: "run-reject-newline" },
          { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), kill: () => true },
        ),
      );
      // There must be exactly one Acceptance reason line (no injected extra lines)
      const reasonLines = text.split("\n").filter((l) => l.includes("Acceptance reason:"));
      assert.equal(reasonLines.length, 1, "reason must collapse to a single line");
      const reasonLine = reasonLines[0]!;
      // The forged line prefixes must not appear as separate status lines
      assert.doesNotMatch(text, /^second line$/m);
      assert.doesNotMatch(text, /^third line$/m);
      // All three content words must be present on the single reason line
      assert.ok(reasonLine.includes("first line"), "first segment must appear on the reason line");
      assert.ok(
        reasonLine.includes("second line"),
        "second segment must be collapsed onto the reason line",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("truncates rejection reason safely at a surrogate pair boundary", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-reject-surrogate-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-reject-surrogate");
      fs.mkdirSync(asyncDir, { recursive: true });
      // Build a reason where the high surrogate sits at position 199 (0-indexed).
      // truncateWithMarker calls sliceSafe(value, 200-1) = sliceSafe(value, 199),
      // which detects no surrogate at the end of the 199-char slice and is safe.
      const pair = "\uD800\uDC00"; // 2 UTF-16 code units for U+10000
      const prefix = "A".repeat(199); // high surrogate lands at position 199
      const surrogateReason = prefix + pair + "Z"; // 202 UTF-16 code units total
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-reject-surrogate",
            mode: "single",
            state: "done",
            startedAt: 100,
            lastUpdate: 200,
            currentStep: 0,
            steps: [
              {
                agent: "worker",
                status: "done",
                acceptance: {
                  status: "rejected",
                  explicit: false,
                  effectiveAcceptance: { level: "attested" },
                  inferredReason: [],
                  criteria: [],
                  childReportParseError: surrogateReason,
                  runtimeChecks: [],
                  verifyRuns: [],
                },
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
          { id: "run-reject-surrogate" },
          { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), kill: () => true },
        ),
      );
      const reasonLine = text.split("\n").find((l) => l.includes("Acceptance reason:"));
      assert.ok(reasonLine, "Acceptance reason line should be present");
      // The string must be well-formed UTF-16: no lone high surrogate at the cut point.
      const hasLoneHighSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(reasonLine);
      assert.ok(!hasLoneHighSurrogate, "truncated reason must not contain a lone high surrogate");
      // The ellipsis must be appended as the truncation marker
      assert.match(reasonLine, /\u2026$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not throw when a disk-parsed rejected ledger omits runtimeChecks and verifyRuns", () => {
    // Regression: acceptanceRejectionReason previously called .find() directly on
    // ledger.runtimeChecks and ledger.verifyRuns without guarding against undefined.
    // A status.json written by an older runtime or truncated on disk can omit these
    // required-typed fields, causing inspectSubagentStatus to throw and taking down
    // the entire status command — strictly worse than showing "accepted: rejected" with no reason.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-reject-sparse-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-reject-sparse");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-reject-sparse",
            mode: "single",
            state: "done",
            startedAt: 100,
            lastUpdate: 200,
            currentStep: 0,
            steps: [
              {
                agent: "worker",
                status: "done",
                acceptance: {
                  status: "rejected",
                  explicit: false,
                  effectiveAcceptance: { level: "attested" },
                  inferredReason: [],
                  criteria: [],
                  // runtimeChecks and verifyRuns intentionally omitted to simulate
                  // a ledger written by an older runtime or truncated on disk.
                },
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      // Must not throw. A TypeError: Cannot read properties of undefined (reading 'find')
      // would crash inspectSubagentStatus and return no output at all.
      let text: string;
      assert.doesNotThrow(() => {
        text = textContent(
          inspectSubagentStatus(
            { id: "run-reject-sparse" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), kill: () => true },
          ),
        );
      });
      // Positive control: the bare rejection marker must be present in the output.
      assert.match(text!, /acceptance: rejected/);
      // No reason line when there is nothing diagnosable.
      assert.doesNotMatch(text!, /Acceptance reason:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not throw when a disk-parsed ledger has null array members or a non-string parse error", () => {
    // Regression guard: acceptanceRejectionReason previously crashed on:
    //   runtimeChecks:[null]       -> null.status throws
    //   verifyRuns:[null]          -> null.status throws
    //   childReportParseError:123  -> formatRejectionReason calls reason.replace(), throws
    // A malformed or legacy status.json that contains these must degrade gracefully
    // rather than taking down the entire status command.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-reject-malform-"));
    try {
      const asyncRoot = path.join(root, "runs");

      const cases: Array<{ id: string; acceptance: Record<string, unknown> }> = [
        {
          id: "null-runtime-check",
          acceptance: {
            status: "rejected",
            explicit: false,
            effectiveAcceptance: { level: "attested" },
            inferredReason: [],
            criteria: [],
            runtimeChecks: [null], // null member — was: null.status throws
            verifyRuns: [],
          },
        },
        {
          id: "null-verify-run",
          acceptance: {
            status: "rejected",
            explicit: false,
            effectiveAcceptance: { level: "attested" },
            inferredReason: [],
            criteria: [],
            runtimeChecks: [],
            verifyRuns: [null], // null member — was: null.status throws
          },
        },
        {
          id: "non-string-parse-error",
          acceptance: {
            status: "rejected",
            explicit: false,
            effectiveAcceptance: { level: "attested" },
            inferredReason: [],
            criteria: [],
            runtimeChecks: [],
            verifyRuns: [],
            childReportParseError: 123, // non-string — was: formatRejectionReason calls .replace(), throws
          },
        },
      ];

      for (const { id, acceptance } of cases) {
        const asyncDir = path.join(asyncRoot, id);
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(
          path.join(asyncDir, "status.json"),
          JSON.stringify(
            {
              runId: id,
              mode: "single",
              state: "done",
              startedAt: 100,
              lastUpdate: 200,
              currentStep: 0,
              steps: [{ agent: "worker", status: "done", acceptance }],
            },
            null,
            2,
          ),
          "utf-8",
        );

        let text: string;
        assert.doesNotThrow(() => {
          text = textContent(
            inspectSubagentStatus(
              { id },
              { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), kill: () => true },
            ),
          );
        }, `case ${id} must not throw`);
        // Positive control: status command still renders the rejection marker.
        assert.match(text!, /acceptance: rejected/, `case ${id} must still render rejection`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
