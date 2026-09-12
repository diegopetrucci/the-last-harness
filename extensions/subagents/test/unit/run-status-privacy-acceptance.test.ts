import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import { errno, textContent } from "../support/run-status-fixtures.ts";

describe("async run status inspection", () => {
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
