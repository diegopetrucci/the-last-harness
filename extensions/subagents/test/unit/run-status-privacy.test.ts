import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import { errno, textContent } from "../support/run-status-fixtures.ts";

describe("async run status inspection privacy and lifecycle", () => {
  it("reports an unreadable status clearly for direct id lookup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-invalid-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-invalid");
      fs.mkdirSync(asyncDir, { recursive: true });
      const statusPath = path.join(asyncDir, "status.json");
      const sentinel = "MALFORMED_STATUS_BODY_SENTINEL";
      fs.writeFileSync(statusPath, `{ "runId": "${sentinel}`, "utf-8");

      const result = inspectSubagentStatus(
        { id: "run-invalid" },
        { asyncDirRoot: asyncRoot, resultsDir, now: () => 1_600 },
      );
      assert.equal(result.isError, true);
      assert.equal(textContent(result), `unreadable status at ${statusPath}`);
      assert.doesNotMatch(textContent(result), /MALFORMED_STATUS_BODY_SENTINEL/);
      assert.equal(fs.readFileSync(statusPath, "utf-8"), `{ "runId": "${sentinel}`);
      assert.equal(fs.existsSync(path.join(root, "quarantined-async-subagent-runs")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows elapsed time from the current child spawn for a running step", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-status-elapsed-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-elapsed");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify(
          {
            runId: "run-elapsed",
            mode: "single",
            state: "running",
            pid: process.pid,
            startedAt: 100,
            lastUpdate: 900,
            steps: [{ agent: "worker", status: "running", startedAt: 500 }],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const result = inspectSubagentStatus(
        { id: "run-elapsed" },
        { asyncDirRoot: asyncRoot, resultsDir, now: () => 1_600 },
      );
      const text = textContent(result);
      assert.equal(result.isError, undefined);
      assert.match(text, /Step 1: worker running/);
      assert.match(text, /Elapsed: 1.1s \(since spawn\)/);
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
      assert.match(text, /State: complete/);
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
      assert.match(text, /State: failed/);
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
});
