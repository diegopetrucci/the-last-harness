import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  writeAsyncArtifactJson as writeJson,
  type AcceptanceConfigFixture,
  type AcceptanceLedgerFixture,
} from "../support/async-artifact-fixtures.ts";
import {
  notRequiredPausedAcceptanceLedger,
  pausedCheckedAcceptance,
  pausedNoneAcceptance,
  skippedPausedAcceptanceLedger,
} from "../support/async-resume-fixtures.ts";
import {
  buildRevivedAsyncTask,
  resolveAsyncResumeTarget,
} from "../../src/runs/background/async-resume.ts";
import type { ResolvedAcceptanceConfig } from "../../src/shared/types.ts";

describe("async resume lookup", () => {
  it("rejects continued awaiting-supervisor sources after continuation finalization", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-continued-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const sessionFile = path.join(root, "continued.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-continued", "status.json"), {
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
      });

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-continued" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /already launched continuation 'revived-123'/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers a dead-owner paused continuation claim before resuming", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-claimed-dead-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const sessionFile = path.join(root, "paused-dead.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-claimed-dead", "status.json"), {
        runId: "run-claimed-dead",
        mode: "single",
        state: "paused",
        startedAt: 100,
        lastUpdate: 200,
        cwd: root,
        sessionFile,
        steps: [
          {
            agent: "worker",
            status: "paused",
            sessionFile,
            acceptance: {
              status: "skipped",
              effectiveAcceptance: {
                level: "checked",
                explicit: true,
                inferredReason: ["async write-capable or risky run"],
                criteria: [
                  {
                    id: "criterion-1",
                    must: "Implement the requested change without widening scope",
                    evidence: ["changed-files"],
                    severity: "required",
                  },
                ],
                evidence: ["changed-files", "commands-run", "no-staged-files"],
                verify: [{ id: "tests", command: "npm test" }],
                stopRules: ["Do not widen scope"],
              },
              inferredReason: ["async write-capable or risky run"],
              criteria: [
                {
                  id: "criterion-1",
                  must: "Implement the requested change without widening scope",
                  evidence: ["changed-files"],
                  severity: "required",
                },
              ],
              runtimeChecks: [
                {
                  id: "paused",
                  status: "not-applicable",
                  message:
                    "Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
                },
              ],
              verifyRuns: [],
            },
          },
        ],
        lifecycle: { continuation: { claimToken: "claim-dead", claimedAt: 150, ownerPid: 4444 } },
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-claimed-dead" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
          kill: () => {
            const error = new Error("dead") as NodeJS.ErrnoException;
            error.code = "ESRCH";
            throw error;
          },
          now: () => 250,
        },
      );
      assert.equal(target.kind, "revive");
      assert.equal(target.runId, "run-claimed-dead");
      const persisted = JSON.parse(
        fs.readFileSync(path.join(asyncRoot, "run-claimed-dead", "status.json"), "utf-8"),
      ) as { lifecycle?: { continuation?: object; generation?: number } };
      assert.equal(persisted.lifecycle?.continuation, undefined);
      assert.equal(persisted.lifecycle?.generation, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects reserved or launched paused continuations with a known target run id as already launched", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-launched-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const sessionFile = path.join(root, "paused-launched.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-launched", "status.json"), {
        runId: "run-launched",
        mode: "single",
        state: "paused",
        startedAt: 100,
        lastUpdate: 200,
        cwd: root,
        sessionFile,
        steps: [{ agent: "worker", status: "paused", sessionFile }],
        lifecycle: {
          continuation: {
            phase: "launched",
            claimToken: "claim-launched",
            claimedAt: 150,
            ownerPid: 5555,
            continuationRunId: "revived-123",
          },
        },
      });
      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-launched" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), kill: () => true },
          ),
        /already launched continuation 'revived-123'/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects paused continuation claims when the recorded owner is alive, unknown, or legacy metadata is incomplete", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-claimed-live-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const sessionFile = path.join(root, "paused-live.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-claimed-live", "status.json"), {
        runId: "run-claimed-live",
        mode: "single",
        state: "paused",
        startedAt: 100,
        lastUpdate: 200,
        cwd: root,
        sessionFile,
        steps: [
          {
            agent: "worker",
            status: "paused",
            sessionFile,
            acceptance: {
              status: "skipped",
              effectiveAcceptance: {
                level: "checked",
                explicit: true,
                inferredReason: ["async write-capable or risky run"],
                criteria: [
                  {
                    id: "criterion-1",
                    must: "Implement the requested change without widening scope",
                    evidence: ["changed-files"],
                    severity: "required",
                  },
                ],
                evidence: ["changed-files", "commands-run", "no-staged-files"],
                verify: [{ id: "tests", command: "npm test" }],
                stopRules: ["Do not widen scope"],
              },
              inferredReason: ["async write-capable or risky run"],
              criteria: [
                {
                  id: "criterion-1",
                  must: "Implement the requested change without widening scope",
                  evidence: ["changed-files"],
                  severity: "required",
                },
              ],
              runtimeChecks: [
                {
                  id: "paused",
                  status: "not-applicable",
                  message:
                    "Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
                },
              ],
              verifyRuns: [],
            },
          },
        ],
        lifecycle: { continuation: { claimToken: "claim-live", claimedAt: 150, ownerPid: 5555 } },
      });
      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-claimed-live" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), kill: () => true },
          ),
        /already claimed for continuation/,
      );
      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-claimed-live" },
            {
              asyncDirRoot: asyncRoot,
              resultsDir: path.join(root, "results"),
              kill: () => {
                const error = new Error("unknown") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
              },
            },
          ),
        /already claimed for continuation/,
      );
      writeJson(path.join(asyncRoot, "run-claimed-live", "status.json"), {
        runId: "run-claimed-live",
        mode: "single",
        state: "paused",
        startedAt: 100,
        lastUpdate: 200,
        cwd: root,
        sessionFile,
        steps: [
          {
            agent: "worker",
            status: "paused",
            sessionFile,
            acceptance: {
              status: "skipped",
              effectiveAcceptance: {
                level: "checked",
                explicit: true,
                inferredReason: ["async write-capable or risky run"],
                criteria: [
                  {
                    id: "criterion-1",
                    must: "Implement the requested change without widening scope",
                    evidence: ["changed-files"],
                    severity: "required",
                  },
                ],
                evidence: ["changed-files", "commands-run", "no-staged-files"],
                verify: [{ id: "tests", command: "npm test" }],
                stopRules: ["Do not widen scope"],
              },
              inferredReason: ["async write-capable or risky run"],
              criteria: [
                {
                  id: "criterion-1",
                  must: "Implement the requested change without widening scope",
                  evidence: ["changed-files"],
                  severity: "required",
                },
              ],
              runtimeChecks: [
                {
                  id: "paused",
                  status: "not-applicable",
                  message:
                    "Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
                },
              ],
              verifyRuns: [],
            },
          },
        ],
        lifecycle: { continuation: { claimToken: "claim-legacy", claimedAt: 150 } },
      });
      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-claimed-live" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /already claimed for continuation/,
      );
      const persisted = JSON.parse(
        fs.readFileSync(path.join(asyncRoot, "run-claimed-live", "status.json"), "utf-8"),
      ) as { lifecycle?: { continuation?: { ownerPid?: number; claimToken?: string } } };
      assert.equal(persisted.lifecycle?.continuation?.ownerPid, undefined);
      assert.equal(persisted.lifecycle?.continuation?.claimToken, "claim-legacy");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses skipped paused acceptance when reviving a paused child", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paused-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const sessionFile = path.join(root, "paused.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-paused", "status.json"), {
        runId: "run-paused",
        mode: "single",
        state: "paused",
        startedAt: 100,
        lastUpdate: 200,
        cwd: root,
        sessionFile,
        tkTicket: { id: "psr-raw4", title: "Paused\u009b ticket\u001b[31m title\u001b[0m" },
        steps: [
          {
            agent: "worker",
            status: "paused",
            sessionFile,
            acceptance: {
              status: "skipped",
              effectiveAcceptance: {
                level: "checked",
                explicit: true,
                inferredReason: ["async write-capable or risky run"],
                criteria: [
                  {
                    id: "criterion-1",
                    must: "Implement the requested change without widening scope",
                    evidence: ["changed-files"],
                    severity: "required",
                  },
                ],
                evidence: ["changed-files", "commands-run", "no-staged-files"],
                verify: [{ id: "tests", command: "npm test" }],
                stopRules: ["Do not widen scope"],
              },
              inferredReason: ["async write-capable or risky run"],
              criteria: [
                {
                  id: "criterion-1",
                  must: "Implement the requested change without widening scope",
                  evidence: ["changed-files"],
                  severity: "required",
                },
              ],
              runtimeChecks: [
                {
                  id: "paused",
                  status: "not-applicable",
                  message:
                    "Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
                },
              ],
              verifyRuns: [],
            },
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-paused" },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
      );
      assert.equal(target.kind, "revive");
      assert.equal(target.state, "paused");
      assert.deepEqual(target.tkTicket, { id: "psr-raw4", title: "Paused ticket title" });
      assert.deepEqual(target.continuationAcceptance, {
        level: "checked",
        explicit: true,
        inferredReason: ["async write-capable or risky run"],
        criteria: [
          {
            id: "criterion-1",
            must: "Implement the requested change without widening scope",
            evidence: ["changed-files"],
            severity: "required",
          },
        ],
        evidence: ["changed-files", "commands-run", "no-staged-files"],
        verify: [{ id: "tests", command: "npm test" }],
        stopRules: ["Do not widen scope"],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("permits paused not-required/level-none ledgers without reviving a continuation contract", () => {
    for (const persistedAs of ["status", "result-only"] as const) {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), `pi-async-resume-paused-none-${persistedAs}-`),
      );
      try {
        const asyncRoot = path.join(root, "runs");
        const resultsDir = path.join(root, "results");
        const sessionFile = path.join(root, `${persistedAs}.jsonl`);
        fs.writeFileSync(sessionFile, "", "utf-8");
        if (persistedAs === "status") {
          writeJson(path.join(asyncRoot, "run-paused-none", "status.json"), {
            runId: "run-paused-none",
            mode: "single",
            state: "paused",
            startedAt: 100,
            lastUpdate: 200,
            cwd: root,
            sessionFile,
            steps: [
              {
                agent: "worker",
                status: "paused",
                sessionFile,
                acceptance: notRequiredPausedAcceptanceLedger(),
              },
            ],
          });
        } else {
          writeJson(path.join(resultsDir, "run-paused-none.json"), {
            id: "run-paused-none",
            agent: "worker",
            success: false,
            state: "paused",
            cwd: root,
            results: [
              {
                agent: "worker",
                interrupted: true,
                success: false,
                sessionFile,
                acceptance: notRequiredPausedAcceptanceLedger(),
              },
            ],
          });
        }

        const target = resolveAsyncResumeTarget(
          { id: "run-paused-none" },
          { asyncDirRoot: asyncRoot, resultsDir },
        );
        assert.equal(target.kind, "revive");
        assert.equal(target.state, "paused");
        assert.equal(target.sessionFile, sessionFile);
        assert.equal(target.continuationAcceptance, undefined);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects incompatible paused acceptance ledger statuses and status-level mismatches", () => {
    for (const persistedAs of ["status", "result-only"] as const) {
      for (const { label, acceptance, message } of [
        {
          label: "skipped-level-none",
          acceptance: skippedPausedAcceptanceLedger(pausedNoneAcceptance),
          message: /status 'skipped' cannot carry effective level 'none'/,
        },
        {
          label: "not-required-level-checked",
          acceptance: notRequiredPausedAcceptanceLedger(pausedCheckedAcceptance),
          message: /status 'not-required' must carry effective level 'none'/,
        },
        {
          label: "reviewed-terminal-status",
          acceptance: {
            ...skippedPausedAcceptanceLedger(),
            status: "reviewed",
          } satisfies AcceptanceLedgerFixture,
          message:
            /status 'reviewed' is incompatible with continuation resume; expected 'skipped' or 'not-required'/,
        },
        {
          label: "accepted-terminal-status",
          acceptance: {
            ...skippedPausedAcceptanceLedger(),
            status: "accepted",
          } satisfies AcceptanceLedgerFixture,
          message:
            /status 'accepted' is incompatible with continuation resume; expected 'skipped' or 'not-required'/,
        },
        {
          label: "rejected-terminal-status",
          acceptance: {
            ...skippedPausedAcceptanceLedger(),
            status: "rejected",
          } satisfies AcceptanceLedgerFixture,
          message:
            /status 'rejected' is incompatible with continuation resume; expected 'skipped' or 'not-required'/,
        },
      ]) {
        const root = fs.mkdtempSync(
          path.join(os.tmpdir(), `pi-async-resume-paused-incompatible-${persistedAs}-${label}-`),
        );
        try {
          const asyncRoot = path.join(root, "runs");
          const resultsDir = path.join(root, "results");
          const sessionFile = path.join(root, `${label}.jsonl`);
          fs.writeFileSync(sessionFile, "", "utf-8");
          if (persistedAs === "status") {
            writeJson(path.join(asyncRoot, "run-paused-incompatible", "status.json"), {
              runId: "run-paused-incompatible",
              mode: "single",
              state: "paused",
              startedAt: 100,
              lastUpdate: 200,
              cwd: root,
              sessionFile,
              steps: [{ agent: "worker", status: "paused", sessionFile, acceptance }],
            });
          } else {
            writeJson(path.join(resultsDir, "run-paused-incompatible.json"), {
              id: "run-paused-incompatible",
              agent: "worker",
              success: false,
              state: "paused",
              cwd: root,
              results: [
                { agent: "worker", interrupted: true, success: false, sessionFile, acceptance },
              ],
            });
          }

          assert.throws(
            () =>
              resolveAsyncResumeTarget(
                { id: "run-paused-incompatible" },
                { asyncDirRoot: asyncRoot, resultsDir },
              ),
            message,
          );
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });

  it("allows a paused child to revive without replay when its persisted session file is absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paused-missing-session-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const sessionFile = path.join(root, "missing.jsonl");
      writeJson(path.join(asyncRoot, "run-paused-missing-session", "status.json"), {
        runId: "run-paused-missing-session",
        mode: "single",
        state: "paused",
        startedAt: 100,
        lastUpdate: 200,
        cwd: root,
        sessionFile,
        steps: [
          {
            agent: "worker",
            status: "paused",
            sessionFile,
            acceptance: {
              status: "skipped",
              effectiveAcceptance: {
                level: "checked",
                explicit: true,
                inferredReason: [],
                criteria: [
                  {
                    id: "criterion-1",
                    must: "Implement the requested change without widening scope",
                    evidence: ["changed-files"],
                    severity: "required",
                  },
                ],
                evidence: ["changed-files", "commands-run", "no-staged-files"],
                verify: [],
                stopRules: ["Do not widen scope"],
              },
              criteria: [
                {
                  id: "criterion-1",
                  must: "Implement the requested change without widening scope",
                  evidence: ["changed-files"],
                  severity: "required",
                },
              ],
              runtimeChecks: [
                {
                  id: "paused",
                  status: "not-applicable",
                  message:
                    "Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
                },
              ],
              verifyRuns: [],
            },
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-paused-missing-session" },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
      );
      assert.equal(target.kind, "revive");
      assert.equal(target.state, "paused");
      assert.equal(target.sessionFile, undefined);
      assert.deepEqual(target.continuationAcceptance, {
        level: "checked",
        explicit: true,
        inferredReason: [],
        criteria: [
          {
            id: "criterion-1",
            must: "Implement the requested change without widening scope",
            evidence: ["changed-files"],
            severity: "required",
          },
        ],
        evidence: ["changed-files", "commands-run", "no-staged-files"],
        verify: [],
        stopRules: ["Do not widen scope"],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a paused child has no persisted acceptance ledger yet", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paused-window-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const sessionFile = path.join(root, "paused.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-paused-window", "status.json"), {
        runId: "run-paused-window",
        mode: "single",
        state: "paused",
        startedAt: 100,
        lastUpdate: 200,
        cwd: root,
        sessionFile,
        steps: [{ agent: "worker", status: "paused", sessionFile }],
      });

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-paused-window" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /skipped acceptance ledger has not been persisted yet/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("result-only revival identifies a paused child via interrupted flag", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-only-paused-"));
    try {
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "result-only.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      const effectiveAcceptance: ResolvedAcceptanceConfig = {
        level: "checked",
        explicit: true,
        inferredReason: [],
        criteria: [
          {
            id: "criterion-1",
            must: "Implement the requested change without widening scope",
            evidence: ["changed-files"],
            severity: "required",
          },
        ],
        evidence: ["changed-files", "commands-run", "no-staged-files"],
        verify: [],
        stopRules: ["Do not widen scope"],
      };
      writeJson(path.join(resultsDir, "run-result-only-paused.json"), {
        id: "run-result-only-paused",
        agent: "worker",
        success: false,
        state: "paused",
        cwd: root,
        results: [
          {
            agent: "worker",
            interrupted: true,
            success: false,
            exitCode: 0,
            sessionFile,
            activeRuntimeMs: 375,
            contextUsage: { restoredTokens: 700, contextTokens: 800, peakTokens: 900 },
            terminationReason: "paused",
            acceptance: {
              status: "skipped",
              effectiveAcceptance,
              criteria: [
                {
                  id: "criterion-1",
                  must: "Implement the requested change without widening scope",
                  evidence: ["changed-files"],
                  severity: "required",
                },
              ],
              runtimeChecks: [
                {
                  id: "paused",
                  status: "not-applicable",
                  message:
                    "Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
                },
              ],
              verifyRuns: [],
            },
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-result-only-paused" },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );
      assert.equal(target.kind, "revive");
      assert.equal(target.state, "paused");
      // F3: paused correctly identified via interrupted
      assert.equal(target.sessionFile, sessionFile);
      assert.equal(target.activeRuntimeMs, 375);
      assert.deepEqual(target.contextUsage, {
        restoredTokens: 700,
        contextTokens: 800,
        peakTokens: 900,
      });
      assert.equal(target.terminationReason, "paused");
      // F3: continuationAcceptance applied from result artifact
      assert.deepEqual(target.continuationAcceptance, effectiveAcceptance);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("result-only revival fails closed when interrupted child has no acceptance ledger", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-async-resume-result-only-no-acceptance-"),
    );
    try {
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "result-only-no-acceptance.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(resultsDir, "run-result-only-no-acceptance.json"), {
        id: "run-result-only-no-acceptance",
        agent: "worker",
        success: false,
        state: "paused",
        cwd: root,
        results: [
          {
            agent: "worker",
            interrupted: true,
            success: false,
            exitCode: 0,
            sessionFile,
            // No acceptance field — should trigger fail-closed guard
          },
        ],
      });

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-result-only-no-acceptance" },
            { asyncDirRoot: path.join(root, "runs"), resultsDir },
          ),
        /skipped acceptance ledger has not been persisted yet/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("result-only revival propagates the full persisted skipped ledger into continuationAcceptance", () => {
    // This test verifies result-artifact propagation on result-only revival:
    // the persisted skipped ledger's effectiveAcceptance is surfaced verbatim as
    // continuationAcceptance (all gates preserved). It does NOT exercise
    // mergeContinuationAcceptance — the caller applies any monotonic merge externally.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-only-propagation-"));
    try {
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "result-only-monotonic.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      const strictAcceptance: ResolvedAcceptanceConfig = {
        level: "checked",
        explicit: true,
        inferredReason: [],
        criteria: [
          {
            id: "criterion-1",
            must: "Implement the requested change without widening scope",
            evidence: ["changed-files"],
            severity: "required",
          },
        ],
        evidence: ["changed-files", "commands-run", "no-staged-files"],
        verify: [{ id: "tests", command: "npm test" }],
        stopRules: ["Do not widen scope"],
      };
      writeJson(path.join(resultsDir, "run-result-only-monotonic.json"), {
        id: "run-result-only-monotonic",
        agent: "worker",
        success: false,
        state: "paused",
        cwd: root,
        results: [
          {
            agent: "worker",
            interrupted: true,
            success: false,
            exitCode: 0,
            sessionFile,
            acceptance: {
              status: "skipped",
              effectiveAcceptance: strictAcceptance,
              criteria: [
                {
                  id: "criterion-1",
                  must: "Implement the requested change without widening scope",
                  evidence: ["changed-files"],
                  severity: "required",
                },
              ],
              runtimeChecks: [
                {
                  id: "paused",
                  status: "not-applicable",
                  message: "Acceptance was not evaluated because the run was paused/interrupted.",
                },
              ],
              verifyRuns: [],
            },
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-result-only-monotonic" },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );
      assert.equal(target.kind, "revive");
      assert.equal(target.state, "paused");
      // continuationAcceptance carries the full strict contract from the result artifact:
      // verify commands, stop rules, and criteria are all propagated verbatim.
      const ca = target.continuationAcceptance;
      assert.ok(ca, "continuationAcceptance must be present");
      assert.equal(ca.level, "checked");
      assert.ok(
        Array.isArray(ca.verify) && ca.verify.length > 0,
        "verify commands must be preserved",
      );
      assert.ok(
        Array.isArray(ca.stopRules) && ca.stopRules.length > 0,
        "stop rules must be preserved",
      );
      assert.ok(Array.isArray(ca.criteria) && ca.criteria.length > 0, "criteria must be preserved");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("F4: result-only paused child with a malformed skipped acceptance ledger fails closed with a clear error", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-only-malformed-"));
    try {
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "result-only-malformed.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(resultsDir, "run-result-only-malformed.json"), {
        id: "run-result-only-malformed",
        agent: "worker",
        success: false,
        state: "paused",
        cwd: root,
        results: [
          {
            agent: "worker",
            interrupted: true,
            success: false,
            exitCode: 0,
            sessionFile,
            acceptance: {
              status: "skipped",
              // Malformed/partial: status is skipped (so the presence guard passes) but
              // effectiveAcceptance is missing the required arrays
              // (criteria/evidence/verify/stopRules/inferredReason). Must fail closed with
              // the incomplete/malformed error, NOT a raw TypeError from mergeContinuationAcceptance.
              effectiveAcceptance: { level: "checked" },
              runtimeChecks: [
                {
                  id: "paused",
                  status: "not-applicable",
                  message: "Acceptance was not evaluated because the run was paused/interrupted.",
                },
              ],
              verifyRuns: [],
            },
          },
        ],
      });

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-result-only-malformed" },
            { asyncDirRoot: path.join(root, "runs"), resultsDir },
          ),
        (err) => {
          assert.ok(err instanceof Error, "must throw an Error");
          assert.match(
            err.message,
            /incomplete or malformed; refusing to resume with an unverified acceptance contract/,
          );
          assert.doesNotMatch(
            err.message,
            /is not iterable|Cannot read propert|undefined is not/,
            "must be a clean fail-closed error, not a raw TypeError",
          );
          return true;
        },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("F5: result-only paused child whose acceptance arrays hold malformed elements fails closed cleanly", () => {
    // All 5 arrays are PRESENT (so the presence-only predicate would have passed),
    // but criteria holds a null element (and verify a command-less object). Downstream
    // mergeAcceptanceCriteria/formatAcceptancePrompt dereference criterion.id and would
    // throw a raw TypeError; the element-shape predicate must fail closed with the clean
    // incomplete/malformed error instead.
    for (const { label, effectiveAcceptance } of [
      {
        label: "criteria-null-element",
        effectiveAcceptance: {
          level: "checked",
          explicit: true,
          inferredReason: [],
          criteria: [null],
          evidence: ["changed-files"],
          verify: [],
          stopRules: ["Do not widen scope"],
        } satisfies AcceptanceConfigFixture,
      },
      {
        label: "verify-missing-command",
        effectiveAcceptance: {
          level: "checked",
          explicit: true,
          inferredReason: [],
          criteria: [
            { id: "criterion-1", must: "x", evidence: ["changed-files"], severity: "required" },
          ],
          evidence: ["changed-files"],
          verify: [{}],
          stopRules: [],
        } satisfies AcceptanceConfigFixture,
      },
    ]) {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), `pi-async-resume-result-only-badelem-${label}-`),
      );
      try {
        const resultsDir = path.join(root, "results");
        const sessionFile = path.join(root, "result-only-badelem.jsonl");
        fs.writeFileSync(sessionFile, "", "utf-8");
        writeJson(path.join(resultsDir, "run-result-only-badelem.json"), {
          id: "run-result-only-badelem",
          agent: "worker",
          success: false,
          state: "paused",
          cwd: root,
          results: [
            {
              agent: "worker",
              interrupted: true,
              success: false,
              exitCode: 0,
              sessionFile,
              acceptance: {
                status: "skipped",
                effectiveAcceptance,
                runtimeChecks: [
                  {
                    id: "paused",
                    status: "not-applicable",
                    message: "Acceptance was not evaluated because the run was paused/interrupted.",
                  },
                ],
                verifyRuns: [],
              },
            },
          ],
        });

        assert.throws(
          () =>
            resolveAsyncResumeTarget(
              { id: "run-result-only-badelem" },
              { asyncDirRoot: path.join(root, "runs"), resultsDir },
            ),
          (err) => {
            assert.ok(err instanceof Error, `[${label}] must throw an Error`);
            assert.match(
              err.message,
              /incomplete or malformed; refusing to resume with an unverified acceptance contract/,
              `[${label}] must be the clean fail-closed error`,
            );
            assert.doesNotMatch(
              err.message,
              /is not iterable|Cannot read propert|undefined is not/,
              `[${label}] must not be a raw TypeError`,
            );
            return true;
          },
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("F4: result-only paused child with a well-formed skipped ledger still returns continuationAcceptance", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-only-wellformed-"));
    try {
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "result-only-wellformed.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      const effectiveAcceptance: ResolvedAcceptanceConfig = {
        level: "checked",
        explicit: true,
        inferredReason: [],
        criteria: [
          {
            id: "criterion-1",
            must: "Implement the requested change without widening scope",
            evidence: ["changed-files"],
            severity: "required",
          },
        ],
        evidence: ["changed-files", "commands-run", "no-staged-files"],
        verify: [],
        stopRules: ["Do not widen scope"],
      };
      writeJson(path.join(resultsDir, "run-result-only-wellformed.json"), {
        id: "run-result-only-wellformed",
        agent: "worker",
        success: false,
        state: "paused",
        cwd: root,
        results: [
          {
            agent: "worker",
            interrupted: true,
            success: false,
            exitCode: 0,
            sessionFile,
            acceptance: {
              status: "skipped",
              effectiveAcceptance,
              criteria: [
                {
                  id: "criterion-1",
                  must: "Implement the requested change without widening scope",
                  evidence: ["changed-files"],
                  severity: "required",
                },
              ],
              runtimeChecks: [
                {
                  id: "paused",
                  status: "not-applicable",
                  message: "Acceptance was not evaluated because the run was paused/interrupted.",
                },
              ],
              verifyRuns: [],
            },
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-result-only-wellformed" },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );
      assert.equal(target.kind, "revive");
      assert.equal(target.state, "paused");
      assert.deepEqual(target.continuationAcceptance, effectiveAcceptance);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("frames the revived follow-up with original run context", () => {
    const task = buildRevivedAsyncTask(
      {
        kind: "revive",
        runId: "run-old",
        state: "complete",
        agent: "worker",
        index: 0,
        sessionFile: "/tmp/session.jsonl",
      },
      "What changed?",
    );

    assert.match(task, /Original run: run-old/);
    assert.doesNotMatch(task, /async subagent conversation/);
    assert.match(task, /Original agent: worker/);
    assert.match(task, /Original session file: \/tmp\/session\.jsonl/);
    assert.match(task, /Follow-up:\nWhat changed\?/);
  });
});
