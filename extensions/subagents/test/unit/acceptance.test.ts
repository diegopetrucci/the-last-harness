import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  acceptanceFailureMessage,
  acceptanceRejectionReason,
  analyzeAcceptanceOutput,
  appendAcceptanceReportDigest,
  buildAcceptanceReportDigest,
  evaluateAcceptance,
  formatAcceptancePrompt,
  isNearlyEmpty,
  mergeContinuationAcceptance,
  parseAcceptanceReport,
  resolveEffectiveAcceptance,
  stripAcceptanceReportIfValid,
  validateAcceptanceInput,
  validateDispatchAcceptanceInput,
} from "../../src/runs/shared/acceptance.ts";
import { formatRejectionReason } from "../../src/shared/string-utils.ts";
import type { AcceptanceReport } from "../../src/shared/types.ts";

function reportData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "verified in test" }],
    changedFiles: ["src/file.ts"],
    testsAddedOrUpdated: ["test/file.test.ts"],
    commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
    validationOutput: ["tests passed"],
    residualRisks: [],
    noStagedFiles: true,
    notes: "complete",
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}, fence = "acceptance-report"): string {
  return ["done", `\`\`\`${fence}`, JSON.stringify(reportData(overrides)), "```"].join("\n");
}

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-acceptance-"));
  fs.writeFileSync(path.join(dir, "file.txt"), "hello\n", "utf-8");
  return dir;
}

describe("acceptance gates", () => {
  it("infers only self-contained acceptance levels across reviewer, writer, async, and risky contexts", () => {
    assert.equal(
      resolveEffectiveAcceptance({
        agentName: "reviewer",
        task: "Review-only. Do not edit.",
        mode: "single",
      }).level,
      "attested",
    );
    assert.equal(
      resolveEffectiveAcceptance({
        agentName: "reviewer",
        task: "Review-only. Do not edit.",
        mode: "single",
        async: true,
      }).level,
      "attested",
    );
    assert.equal(
      resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "single" })
        .level,
      "checked",
    );
    assert.equal(
      resolveEffectiveAcceptance({
        agentName: "worker",
        task: "Implement the fix",
        mode: "single",
        async: true,
      }).level,
      "checked",
    );
    assert.equal(
      resolveEffectiveAcceptance({ agentName: "worker", task: "Run the migration", mode: "single" })
        .level,
      "checked",
    );
  });

  it("uses explicit agent roles for ambiguous tasks while preserving task-intent precedence", () => {
    assert.equal(
      resolveEffectiveAcceptance({
        agentName: "explorer",
        acceptanceRole: "read-only",
        task: "Explore the authentication flow",
        mode: "single",
      }).level,
      "attested",
    );
    assert.equal(
      resolveEffectiveAcceptance({
        agentName: "reviewer",
        acceptanceRole: "writer",
        task: "Handle the authentication flow",
        mode: "single",
      }).level,
      "checked",
    );
    for (const task of [
      "Implement the authentication fix",
      "Create a fixture",
      "Add coverage",
      "Replace the dependency",
      "Patch src/auth.ts",
    ]) {
      assert.equal(
        resolveEffectiveAcceptance({
          agentName: "worker",
          acceptanceRole: "read-only",
          task,
          mode: "single",
        }).level,
        "checked",
        task,
      );
    }
    assert.equal(
      resolveEffectiveAcceptance({
        agentName: "worker",
        acceptanceRole: "read-only",
        task: "Patch src/auth.ts",
        mode: "single",
        async: true,
      }).level,
      "checked",
    );
    assert.equal(
      resolveEffectiveAcceptance({
        agentName: "worker",
        acceptanceRole: "read-only",
        task: "Create a report",
        mode: "single",
      }).level,
      "attested",
    );
    assert.equal(
      resolveEffectiveAcceptance({
        agentName: "worker",
        acceptanceRole: "writer",
        task: "Review only; do not edit files",
        mode: "single",
      }).level,
      "attested",
    );
    assert.equal(
      resolveEffectiveAcceptance({
        agentName: "reviewer",
        acceptanceRole: "writer",
        task: "Handle the authentication flow",
        mode: "single",
        async: true,
      }).level,
      "checked",
    );
    assert.equal(
      resolveEffectiveAcceptance({
        agentName: "worker",
        acceptanceRole: "read-only",
        task: "Explore the authentication flow",
        mode: "single",
      }).level,
      "attested",
    );
    assert.equal(
      resolveEffectiveAcceptance({
        agentName: "explorer",
        acceptanceRole: "read-only",
        task: "Audit the security posture",
        mode: "single",
      }).level,
      "attested",
    );
    assert.equal(
      resolveEffectiveAcceptance({
        agentName: "explorer",
        acceptanceRole: "read-only",
        task: "Explore each target",
        mode: "chain",
      }).level,
      "attested",
    );
    assert.equal(
      resolveEffectiveAcceptance({
        agentName: "worker",
        acceptanceRole: "writer",
        task: "Review only; do not edit files",
        mode: "chain",
      }).level,
      "attested",
    );
    assert.equal(
      resolveEffectiveAcceptance({
        agentName: "reviewer",
        task: "Review each target",
        mode: "chain",
      }).level,
      "attested",
    );
  });

  it("preserves legacy inference byte-for-byte when acceptance role metadata is omitted", () => {
    // Pinned empirically against origin/main (parity worktree check, ts-zj05):
    // role-less inference must keep the fork's pre-role heuristics, where
    // read-only task wording ("inspect", "read-only") wins before risky keywords
    // and "write" counts as a write verb even for report deliverables.
    const matrix: Array<[string, string, "attested" | "checked"]> = [
      ["worker", "Inspect the failure and implement the fix", "attested"],
      ["worker", "Write a report on the API", "checked"],
      ["worker", "Inspect the security posture", "attested"],
      ["worker", "Read-only security audit", "attested"],
      ["worker", "Do not modify tests; implement the fix", "checked"],
      ["explorer", "Explore the repo structure", "attested"],
      ["worker", "Migrate the database schema", "checked"],
      ["code-reviewer", "Review the PR for regressions", "attested"],
    ];
    for (const [agentName, task, level] of matrix) {
      assert.equal(
        resolveEffectiveAcceptance({ agentName, task }).level,
        level,
        `${agentName} :: ${task}`,
      );
    }
  });

  it("merge continuation retains inferred provenance for empty or auto overrides", () => {
    const base = resolveEffectiveAcceptance({
      agentName: "worker",
      task: "Implement the fix",
      mode: "single",
    });
    assert.equal(base.explicit, false);

    assert.equal(mergeContinuationAcceptance(base, undefined)?.explicit, false);
    assert.equal(mergeContinuationAcceptance(base, {})?.explicit, false);
    assert.equal(mergeContinuationAcceptance(base, "auto")?.explicit, false);
    assert.equal(mergeContinuationAcceptance(base, { level: "auto" })?.explicit, false);

    const strengthenedLevel = mergeContinuationAcceptance(base, {
      level: "verified",
      verify: [{ id: "ok", command: "node --version" }],
    });
    assert.equal(strengthenedLevel?.explicit, true);
    assert.equal(strengthenedLevel?.level, "verified");
    const strengthenedCriteria = mergeContinuationAcceptance(base, {
      criteria: ["Keep the fix minimal"],
    });
    assert.equal(strengthenedCriteria?.explicit, true);

    const explicitBase = resolveEffectiveAcceptance({
      agentName: "worker",
      task: "Implement the fix",
      mode: "single",
      explicit: { level: "checked" },
    });
    assert.equal(mergeContinuationAcceptance(explicitBase, {})?.explicit, true);
  });

  it("merge continuation dedupes verify commands by execution identity, not id", () => {
    const base = resolveEffectiveAcceptance({
      agentName: "worker",
      task: "Implement the fix",
      mode: "single",
      explicit: { level: "verified", verify: [{ id: "a", command: "npm test" }] },
    });

    const sameCommandNewId = mergeContinuationAcceptance(base, {
      verify: [{ id: "b", command: "npm test" }],
    });
    assert.equal(sameCommandNewId?.verify.length, 1);
    assert.equal(sameCommandNewId?.verify[0]?.id, "a");

    const distinctCwd = mergeContinuationAcceptance(base, {
      verify: [{ id: "c", command: "npm test", cwd: "/tmp" }],
    });
    assert.equal(distinctCwd?.verify.length, 2);

    const distinctEnv = mergeContinuationAcceptance(base, {
      verify: [{ id: "d", command: "npm test", env: { CI: "1" } }],
    });
    assert.equal(distinctEnv?.verify.length, 2);

    const distinctCommand = mergeContinuationAcceptance(base, {
      verify: [{ id: "e", command: "npm run lint" }],
    });
    assert.equal(distinctCommand?.verify.length, 2);
  });

  it("explicit acceptance can strengthen inferred policy", () => {
    const resolved = resolveEffectiveAcceptance({
      agentName: "reviewer",
      task: "Review-only.",
      explicit: { level: "verified", verify: [{ id: "ok", command: "node --version" }] },
    });

    assert.equal(resolved.level, "verified");
    assert.equal(resolved.verify[0]?.id, "ok");
  });

  it("formats a standardized child prompt section", () => {
    const resolved = resolveEffectiveAcceptance({
      agentName: "worker",
      task: "Implement a fix",
      explicit: {
        level: "checked",
        criteria: ["Patch the bug"],
        stopRules: ["Do not stop after analysis"],
      },
    });
    const prompt = formatAcceptancePrompt(resolved);

    assert.match(prompt, /## Acceptance Contract/);
    assert.match(prompt, /Acceptance level: checked/);
    assert.match(prompt, /Patch the bug/);
    assert.match(prompt, /```acceptance-report/);
    assert.match(prompt, /array fields contain strings/);
    assert.match(prompt, /"reviewFindings": \[\n    "blocker:/);
  });

  it("parses acceptance-report fences and ignores unrelated json fences", () => {
    const parsed = parseAcceptanceReport(report());

    assert.ok(parsed.report);
    assert.deepEqual(parsed.report.changedFiles, ["src/file.ts"]);
    assert.equal(parsed.error, undefined);

    const genericJson = parseAcceptanceReport(`done\n\
\
\`\`\`json\n{"notes":"not an acceptance report"}\n\`\`\``);
    assert.equal(genericJson.report, undefined);
    assert.match(genericJson.error ?? "", /Structured acceptance report not found/);

    const criteriaOnlyJson = parseAcceptanceReport(`done\n\
\
\`\`\`json\n{"criteriaSatisfied":[{"id":"criterion-1","status":"satisfied","evidence":"example"}]}\n\`\`\``);
    assert.equal(criteriaOnlyJson.report, undefined);
    assert.match(criteriaOnlyJson.error ?? "", /Structured acceptance report not found/);

    const invalidSignalJson = `done\n\
\
\`\`\`json\n{"criteriaSatisfied":[{"id":"criterion-1","status":"satisfied","evidence":"example"}],"changedFiles":false}\n\`\`\``;
    const genericJsonWithInvalidSignal = parseAcceptanceReport(invalidSignalJson);
    assert.equal(genericJsonWithInvalidSignal.report, undefined);
    assert.match(
      genericJsonWithInvalidSignal.error ?? "",
      /Structured acceptance report not found/,
    );
    // Non-acceptance json fences leave the string unchanged (no candidate found).
    assert.equal(analyzeAcceptanceOutput(invalidSignalJson).strippedOutput, invalidSignalJson);

    const partialWrapperJson = `done\n\
\
\`\`\`json\n{"acceptance":{"changedFiles":["src/file.ts"]}}\n\`\`\``;
    const genericJsonWithPartialWrapper = parseAcceptanceReport(partialWrapperJson);
    assert.equal(genericJsonWithPartialWrapper.report, undefined);
    assert.match(
      genericJsonWithPartialWrapper.error ?? "",
      /Structured acceptance report not found/,
    );
    assert.equal(analyzeAcceptanceOutput(partialWrapperJson).strippedOutput, partialWrapperJson);

    const reportPayloadJson = `done\n\
\
\`\`\`json\n{"changedFiles":["src/file.ts"]}\n\`\`\``;
    const genericReportPayloadJson = parseAcceptanceReport(reportPayloadJson);
    assert.equal(genericReportPayloadJson.report, undefined);
    assert.match(genericReportPayloadJson.error ?? "", /Structured acceptance report not found/);
    assert.equal(analyzeAcceptanceOutput(reportPayloadJson).strippedOutput, reportPayloadJson);

    const malformed = parseAcceptanceReport("```acceptance-report\n{bad-json\n```");
    assert.equal(malformed.report, undefined);
    assert.match(malformed.error ?? "", /Failed to parse acceptance-report/);
  });

  it("parses acceptance reports from json-family fences", () => {
    for (const fence of ["json", "jsonc", "json5"]) {
      const output = report({}, fence);
      const parsed = parseAcceptanceReport(output);

      assert.ok(parsed.report);
      assert.deepEqual(parsed.report.changedFiles, ["src/file.ts"]);
      assert.equal(parsed.error, undefined);
      // analyzeAcceptanceOutput selects the trailing json fence and strips it.
      assert.equal(analyzeAcceptanceOutput(output).strippedOutput, "done");
    }
  });

  it("strips trailing json-family reports after earlier unrelated json fences", () => {
    const output = [
      "metadata",
      "```json",
      JSON.stringify({ notes: "not an acceptance report" }),
      "```",
      "done",
      "```json",
      JSON.stringify(reportData()),
      "```",
    ].join("\n");
    const parsed = parseAcceptanceReport(output);

    assert.ok(parsed.report);
    assert.equal(
      analyzeAcceptanceOutput(output).strippedOutput,
      [
        "metadata",
        "```json",
        JSON.stringify({ notes: "not an acceptance report" }),
        "```",
        "done",
      ].join("\n"),
    );
  });

  it("unwraps acceptance-report wrapper objects", () => {
    const output = [
      "done",
      "```json",
      JSON.stringify({ "acceptance-report": reportData() }),
      "```",
    ].join("\n");
    const parsed = parseAcceptanceReport(output);

    assert.ok(parsed.report);
    assert.deepEqual(parsed.report.testsAddedOrUpdated, ["test/file.test.ts"]);
    assert.equal(analyzeAcceptanceOutput(output).strippedOutput, "done");
  });

  it("reports field-level validation errors for malformed acceptance-report fields", () => {
    const invalidReviewerReport = parseAcceptanceReport(
      report({
        reviewFindings: [{ id: "B-1", severity: "blocker", finding: "Missing evidence" }],
      }),
    );
    assert.equal(invalidReviewerReport.report, undefined);
    assert.match(
      invalidReviewerReport.error ?? "",
      /reviewFindings\[0\]: expected string; got object/,
    );

    const invalidCommandReport = parseAcceptanceReport(
      report({
        commandsRun: [{ command: "npm test", exitCode: 0 }],
      }),
    );
    assert.equal(invalidCommandReport.report, undefined);
    assert.match(
      invalidCommandReport.error ?? "",
      /commandsRun\[0\]\.result: expected string; got missing/,
    );
    assert.match(
      invalidCommandReport.error ?? "",
      /commandsRun\[0\]\.summary: expected string; got missing/,
    );

    // A non-string result value (e.g. a number) is still a validation error.
    const nonStringResultReport = parseAcceptanceReport(
      report({
        commandsRun: [{ command: "npm test", result: 42, summary: "ok" }],
      }),
    );
    assert.equal(nonStringResultReport.report, undefined);
    assert.match(
      nonStringResultReport.error ?? "",
      /commandsRun\[0\]\.result: expected string; got number 42/,
    );

    const invalidCriteriaReport = parseAcceptanceReport(
      report({
        criteriaSatisfied: [{ id: 7, status: "done", evidence: "" }],
      }),
    );
    assert.equal(invalidCriteriaReport.report, undefined);
    assert.match(
      invalidCriteriaReport.error ?? "",
      /criteriaSatisfied\[0\]\.id: expected string; got number 7/,
    );
    assert.match(
      invalidCriteriaReport.error ?? "",
      /criteriaSatisfied\[0\]\.status: expected one of "satisfied", "not-satisfied", "not-applicable"; got "done"/,
    );
    assert.match(
      invalidCriteriaReport.error ?? "",
      /criteriaSatisfied\[0\]\.evidence: expected non-empty string; got ""/,
    );
  });

  it("accepts arbitrary strings as commandsRun[].result (regression: real-world values)", () => {
    // These nine values were observed in real runs that were rejected solely because
    // their result string was not in the strict enum. The field is display-only;
    // nothing branches on its value. All should parse without error.
    const realWorldResults = [
      "failed as expected",
      "failed (pre-fix)",
      "failed (expected: 77, actual: 79)",
      "failed (expected: 171, actual: 173)",
      "failed (pre-existing)",
      "no output (exit 1 = no matches)",
      "passed (third attempt)",
      "passed (anomaly documented)",
      "partial - metadata_whenNoMetadata passed; unrelated AuthProvider keychain failures are pre-existing",
    ];
    for (const result of realWorldResults) {
      const parsed = parseAcceptanceReport(
        report({
          commandsRun: [{ command: "npm test", result, summary: "see result" }],
        }),
      );
      assert.ok(
        parsed.report !== undefined,
        `Expected report to parse successfully for result=${JSON.stringify(result)}, got error: ${parsed.error}`,
      );
      // The raw result string must appear in the digest (display contract).
      const digest = parsed.report ? buildAcceptanceReportDigest(parsed.report) : "";
      assert.ok(
        digest.includes(result),
        `Expected digest to contain raw result string ${JSON.stringify(result)}`,
      );
    }
  });

  it("explicit none disables inferred gates when a reason is present", () => {
    const acceptance = resolveEffectiveAcceptance({
      agentName: "worker",
      task: "Implement a fix",
      explicit: { level: "none", reason: "parent is doing manual acceptance" },
    });

    assert.equal(acceptance.level, "none");
    assert.deepEqual(acceptance.evidence, []);
  });

  it("checked mode rejects missing required evidence", async () => {
    const cwd = tempRepo();
    try {
      const acceptance = resolveEffectiveAcceptance({
        agentName: "worker",
        task: "Implement a fix",
        explicit: { level: "checked" },
      });
      const ledger = await evaluateAcceptance({
        acceptance,
        output: report({ testsAddedOrUpdated: [] }),
        cwd,
      });

      assert.equal(ledger.status, "rejected");
      assert.match(acceptanceFailureMessage(ledger) ?? "", /tests-added evidence missing/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("surfaces parse validation details in acceptance failure messages", async () => {
    const cwd = tempRepo();
    try {
      const acceptance = resolveEffectiveAcceptance({
        agentName: "reviewer",
        task: "Review-only. Do not edit.",
        explicit: { level: "attested", evidence: ["review-findings"] },
      });
      const ledger = await evaluateAcceptance({
        acceptance,
        output: report({ reviewFindings: [{ id: "B-1", finding: "Missing evidence" }] }),
        cwd,
      });

      assert.equal(ledger.status, "rejected");
      assert.match(acceptanceFailureMessage(ledger) ?? "", /Failed to parse acceptance-report/);
      assert.match(
        acceptanceFailureMessage(ledger) ?? "",
        /reviewFindings\[0\]: expected string; got object/,
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("checked mode rejects not-satisfied required criteria", async () => {
    const cwd = tempRepo();
    try {
      const acceptance = resolveEffectiveAcceptance({
        agentName: "worker",
        task: "Implement a fix",
        explicit: {
          level: "checked",
          criteria: [{ id: "regression", must: "Regression is covered" }],
        },
      });
      const ledger = await evaluateAcceptance({
        acceptance,
        output: report({
          criteriaSatisfied: [
            { id: "regression", status: "not-satisfied", evidence: "test missing" },
          ],
        }),
        cwd,
      });

      assert.equal(ledger.status, "rejected");
      assert.match(
        acceptanceFailureMessage(ledger) ?? "",
        /Required criterion 'regression' was reported as not-satisfied/,
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("verified mode records runtime command success and failure separately from child command claims", async () => {
    const cwd = tempRepo();
    try {
      const passing = resolveEffectiveAcceptance({
        agentName: "worker",
        task: "Implement a fix",
        explicit: {
          level: "verified",
          verify: [{ id: "pass", command: 'node -e "process.exit(0)"', timeoutMs: 10_000 }],
        },
      });
      const passLedger = await evaluateAcceptance({ acceptance: passing, output: report(), cwd });
      assert.equal(passLedger.status, "verified");
      assert.equal(passLedger.verifyRuns[0]?.status, "passed");

      const failing = resolveEffectiveAcceptance({
        agentName: "worker",
        task: "Implement a fix",
        explicit: {
          level: "verified",
          verify: [{ id: "fail", command: 'node -e "process.exit(7)"', timeoutMs: 10_000 }],
        },
      });
      const failLedger = await evaluateAcceptance({ acceptance: failing, output: report(), cwd });
      assert.equal(failLedger.status, "rejected");
      assert.equal(failLedger.childReport?.commandsRun?.[0]?.result, "passed");
      assert.equal(failLedger.verifyRuns[0]?.status, "failed");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reviewed mode records no-blocker and blocker reviewer outcomes", async () => {
    const cwd = tempRepo();
    try {
      const acceptance = resolveEffectiveAcceptance({
        agentName: "worker",
        task: "Implement a risky fix",
        explicit: { level: "reviewed", review: { agent: "reviewer", required: true } },
      });
      const noBlockers = await evaluateAcceptance({
        acceptance,
        output: report(),
        cwd,
        reviewResult: { status: "no-blockers", findings: [] },
      });
      assert.equal(noBlockers.status, "reviewed");
      assert.equal(noBlockers.reviewResult?.status, "no-blockers");

      const blockers = await evaluateAcceptance({
        acceptance,
        output: report(),
        cwd,
        reviewResult: {
          status: "blockers",
          findings: [
            {
              severity: "blocker",
              issue: "Missing test",
              rationale: "Acceptance requires test evidence.",
            },
          ],
        },
      });
      assert.equal(blockers.status, "rejected");
      assert.equal(blockers.reviewResult?.status, "blockers");

      const unavailable = await evaluateAcceptance({ acceptance, output: report(), cwd });
      assert.equal(unavailable.status, "rejected");
      assert.equal(unavailable.reviewResult?.status, "needs-parent-decision");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not make explicit checked acceptance a stronger inferred blocker in risky contexts", async () => {
    const cwd = tempRepo();
    try {
      const acceptance = resolveEffectiveAcceptance({
        agentName: "worker",
        task: "Implement each dynamic item",
        explicit: { level: "checked" },
      });

      assert.equal(acceptance.level, "checked");
      assert.equal(acceptance.review, undefined);
      const ledger = await evaluateAcceptance({
        acceptance,
        output: report({
          criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "implemented" }],
        }),
        cwd,
      });
      assert.equal(ledger.status, "checked");
      assert.equal(ledger.reviewResult, undefined);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not mark reviewed without an independent reviewer result", async () => {
    const cwd = tempRepo();
    try {
      const acceptance = resolveEffectiveAcceptance({
        agentName: "worker",
        task: "Implement a fix",
        explicit: {
          level: "reviewed",
          review: false,
        },
      });
      assert.equal(acceptance.level, "reviewed");

      const ledger = await evaluateAcceptance({ acceptance, output: report(), cwd });
      assert.equal(ledger.status, "rejected");
      assert.equal(ledger.reviewResult?.status, "needs-parent-decision");
      assert.match(acceptanceFailureMessage(ledger) ?? "", /review required/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("acceptance failure messages ignore skipped ledgers", () => {
    const acceptance = resolveEffectiveAcceptance({
      agentName: "worker",
      task: "Implement a fix",
      explicit: { level: "checked" },
    });

    assert.equal(
      acceptanceFailureMessage({
        status: "skipped",
        explicit: acceptance.explicit,
        effectiveAcceptance: acceptance,
        inferredReason: acceptance.inferredReason,
        criteria: acceptance.criteria,
        runtimeChecks: [
          { id: "paused", status: "not-applicable", message: "Acceptance will run after resume." },
        ],
        verifyRuns: [],
      }),
      undefined,
    );
  });

  it("rejects explicit reviewed at dispatch with actionable guidance while preserving parse compatibility", () => {
    assert.deepEqual(validateAcceptanceInput("reviewed"), []);
    const errors = validateDispatchAcceptanceInput({ level: "reviewed" });
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /reviewed/);
    assert.match(errors[0] ?? "", /verified/);
    assert.match(errors[0] ?? "", /verify commands/);
    assert.doesNotMatch(errors[0] ?? "", /tlh fork/i);
    assert.match(errors[0] ?? "", /checked/);
  });

  it("explicit verified without verify commands still fails", async () => {
    const cwd = tempRepo();
    try {
      const acceptance = resolveEffectiveAcceptance({
        agentName: "worker",
        task: "Implement a fix",
        explicit: { level: "verified" },
      });
      const ledger = await evaluateAcceptance({ acceptance, output: report(), cwd });
      assert.equal(ledger.status, "rejected");
      assert.match(
        acceptanceFailureMessage(ledger) ?? "",
        /verified acceptance requires runtime verify commands/i,
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("validates invalid disable and verify shapes", () => {
    assert.deepEqual(validateAcceptanceInput({ level: "none" }), [
      "acceptance.reason is required when level is none.",
    ]);
    assert.deepEqual(validateAcceptanceInput({ verify: [{ id: "missing-command" }] }), [
      "acceptance.verify[0].command is required.",
    ]);
    assert.deepEqual(
      validateAcceptanceInput({
        verify: [{ id: "fractional", command: "npm test", timeoutMs: 1.5 }],
      }),
      ["acceptance.verify[0].timeoutMs must be an integer >= 1."],
    );
    assert.deepEqual(validateAcceptanceInput(false), []);
    assert.deepEqual(validateAcceptanceInput("checked"), []);
    assert.deepEqual(
      validateAcceptanceInput({
        criteria: ["ship the fix"],
        review: false,
        stopRules: ["stay scoped"],
      }),
      [],
    );
    assert.match(
      validateAcceptanceInput({ criteria: [{ id: "missing-must" }] }).join("\n"),
      /acceptance\.criteria\[0\]\.must is required/,
    );
    assert.match(
      validateAcceptanceInput({ criteria: [123] }).join("\n"),
      /acceptance\.criteria\[0\] must be a string or an object/,
    );
    assert.match(
      validateAcceptanceInput({ evidence: ["bogus"] }).join("\n"),
      /acceptance\.evidence\[0\] is not a supported evidence kind/,
    );
    assert.match(
      validateAcceptanceInput({ review: true }).join("\n"),
      /acceptance\.review must be false or an object/,
    );
    assert.match(
      validateAcceptanceInput({ review: { required: "yes" } }).join("\n"),
      /acceptance\.review\.required must be a boolean/,
    );
    assert.match(
      validateAcceptanceInput({ stopRules: [123] }).join("\n"),
      /acceptance\.stopRules\[0\] must be a string/,
    );
    assert.match(
      validateAcceptanceInput({ surprise: true }).join("\n"),
      /acceptance\.surprise is not supported/,
    );
  });
});

describe("buildAcceptanceReportDigest", () => {
  it("includes commandsRun entries with their results", () => {
    const digest = buildAcceptanceReportDigest({
      commandsRun: [
        { command: "npm run typecheck", result: "passed", summary: "0 errors" },
        { command: "npm run test:unit", result: "failed", summary: "1 failing" },
      ],
      residualRisks: [],
    });
    assert.match(digest, /\[passed\] npm run typecheck/);
    assert.match(digest, /0 errors/);
    assert.match(digest, /\[failed\] npm run test:unit/);
    assert.match(digest, /1 failing/);
  });

  it("includes residualRisks when non-empty and non-'none'", () => {
    const digest = buildAcceptanceReportDigest({
      commandsRun: [{ command: "npm test", result: "passed", summary: "ok" }],
      residualRisks: ["none", "potential flakiness on CI"],
    });
    assert.match(digest, /potential flakiness on CI/);
    // "none" sentinels must be filtered out
    assert.doesNotMatch(digest, /\bnone\b/i);
  });

  it("does not include residual-risks section when all entries are 'none'", () => {
    const digest = buildAcceptanceReportDigest({
      commandsRun: [{ command: "npm test", result: "passed", summary: "ok" }],
      residualRisks: ["none"],
    });
    assert.doesNotMatch(digest, /Residual risks/);
  });

  it("does not include residual-risks section when residualRisks is empty", () => {
    const digest = buildAcceptanceReportDigest({
      commandsRun: [{ command: "npm test", result: "passed", summary: "ok" }],
      residualRisks: [],
    });
    assert.doesNotMatch(digest, /Residual risks/);
  });

  it("is non-empty even for a report with no commandsRun", () => {
    const digest = buildAcceptanceReportDigest({});
    assert.ok(digest.length > 0);
    assert.match(digest, /Validation evidence/);
  });

  it("analyzeAcceptanceOutput is remove-only — does not inject digest", () => {
    // The progress/step-tail path and stripAcceptanceReportsFromMessages call
    // analyzeAcceptanceOutput (via stripAcceptanceReportIfValid or directly).
    // strippedOutput must be a pure remove-only result so progress tails do not bloat.
    const output = ["done", "```acceptance-report", JSON.stringify(reportData()), "```"].join("\n");
    const stripped = analyzeAcceptanceOutput(output).strippedOutput;
    assert.equal(stripped, "done");
    assert.doesNotMatch(stripped, /Validation evidence/);
    assert.doesNotMatch(stripped, /commandsRun/);
  });
});

describe("appendAcceptanceReportDigest", () => {
  function parsedReport(): AcceptanceReport {
    const parsed = parseAcceptanceReport(report());
    assert.ok(parsed.report);
    return parsed.report;
  }

  it("appends the digest after the already-stripped output", () => {
    const stripped = analyzeAcceptanceOutput(report()).strippedOutput;
    const joined = appendAcceptanceReportDigest(stripped, parsedReport());

    assert.equal(stripped, "done");
    assert.ok(
      joined.startsWith("done\n\n"),
      "original output must be preserved verbatim at the head",
    );
    assert.match(joined, /Validation evidence/);
    assert.match(joined, /\[passed\] npm test/);
  });

  it("appends deterministically regardless of output length", () => {
    // No length threshold or magic-number gating: a 4-character output and a long
    // one both receive the digest.
    const shortJoined = appendAcceptanceReportDigest("ok", parsedReport());
    const longJoined = appendAcceptanceReportDigest("x".repeat(5000), parsedReport());

    assert.match(shortJoined, /Validation evidence/);
    assert.match(longJoined, /Validation evidence/);
  });

  it("emits the digest alone when the stripped output is empty", () => {
    const joined = appendAcceptanceReportDigest("", parsedReport());

    assert.ok(!joined.startsWith("\n"), "must not emit leading blank lines");
    assert.match(joined, /Validation evidence/);
  });

  it("never removes or rewrites the caller's output", () => {
    const original = "line one\nline two\n\n  indented";
    const joined = appendAcceptanceReportDigest(original, parsedReport());

    assert.ok(joined.startsWith(original), "append-only");
  });
});

describe("isNearlyEmpty", () => {
  it("returns true for empty string", () => {
    assert.equal(isNearlyEmpty(""), true);
  });

  it("returns true for whitespace only", () => {
    assert.equal(isNearlyEmpty("   \n  "), true);
  });

  it("returns true for a single horizontal rule", () => {
    assert.equal(isNearlyEmpty("---"), true);
  });

  it("returns true for a horizontal rule with surrounding whitespace", () => {
    assert.equal(isNearlyEmpty("\n---\n"), true);
  });

  it("returns true for multiple horizontal rules with whitespace", () => {
    assert.equal(isNearlyEmpty("---\n---\n---"), true);
  });

  it("returns false for real prose content", () => {
    assert.equal(isNearlyEmpty("Implementation complete."), false);
  });

  it("returns false for content mixed with a horizontal rule", () => {
    assert.equal(isNearlyEmpty("---\nSome actual content"), false);
  });

  it("returns false for a digest output (non-destruction floor must not loop)", () => {
    // A digest contains real text, so the floor should not trigger again on it.
    assert.equal(isNearlyEmpty("---\nValidation evidence (from acceptance report):\n---"), false);
  });
});

describe("shared-predicate: strip and parse share one outcome", () => {
  // Durably invalid fixture: criteriaSatisfied[].status is not a valid enum value.
  // Do NOT use commandsRun[].result — that field was made permissive in tlhm-uaw2
  // and would silently stop being invalid.
  function invalidAcceptanceOutput(prose = "Work done."): string {
    const json = JSON.stringify({
      criteriaSatisfied: [{ id: "c1", status: "INVALID_STATUS", evidence: "e" }],
      changedFiles: ["src/file.ts"],
      commandsRun: [{ command: "test", result: "passed", summary: "ok" }],
      validationOutput: [],
      residualRisks: [],
      noStagedFiles: true,
    });
    return `${prose}\n\`\`\`acceptance-report\n${json}\n\`\`\``;
  }

  it("invalid fixture is genuinely unparseable (fixture validity guard)", () => {
    // If this assertion fails, the fixture stopped being invalid and the
    // tests below would assert nothing meaningful — fix the fixture first.
    const result = parseAcceptanceReport(invalidAcceptanceOutput());
    assert.equal(result.report, undefined, "invalid fixture must fail to parse");
    assert.ok(result.error, "invalid fixture must return a parse error");
  });

  it("parseAcceptanceReport returns a report for a valid output", () => {
    const output = report();
    const result = parseAcceptanceReport(output);
    assert.ok(result.report, "valid fixture must parse successfully");
    assert.equal(result.error, undefined);
  });

  it("invalid report: analyzeAcceptanceOutput returns unchanged output, not nearly-empty", () => {
    // analyzeAcceptanceOutput returns strippedOutput === raw when the report is
    // invalid, so the non-destruction floor never has to be the sole defence.
    // Callers in subagent-runner.ts and execution.ts consume a single result and
    // therefore cannot accidentally strip when the report failed to parse.
    const raw = invalidAcceptanceOutput();
    const analysis = analyzeAcceptanceOutput(raw);
    assert.equal(analysis.status, "invalid", "must detect as invalid");
    assert.equal(
      analysis.strippedOutput,
      raw,
      "invalid report must leave strippedOutput unchanged",
    );
    assert.equal(isNearlyEmpty(raw), false, "raw output must not be nearly empty");
    assert.equal(
      isNearlyEmpty(analysis.strippedOutput),
      false,
      "strippedOutput must not be nearly-empty",
    );

    // The old ungated strip path (now retired) WOULD have produced nearly-empty output
    // for an hr-only + invalid fence. Verify the new path does not:
    const hrOnly = `---\n\`\`\`acceptance-report\n${JSON.stringify({ criteriaSatisfied: [{ id: "c1", status: "INVALID_STATUS", evidence: "e" }] })}\n\`\`\``;
    const hrAnalysis = analyzeAcceptanceOutput(hrOnly);
    assert.equal(hrAnalysis.status, "invalid");
    assert.equal(hrAnalysis.strippedOutput, hrOnly, "invalid fence in hr-only output must survive");
    assert.equal(
      isNearlyEmpty(hrAnalysis.strippedOutput),
      false,
      "strippedOutput must not be nearly-empty",
    );
  });
});

describe("multi-fence regression matrix (tlhm-30b6)", () => {
  // Shared helpers — mirrors the fixtures used in the shared-predicate suite.
  // The invalid fixture uses an illegal enum value for criteriaSatisfied[].status;
  // this field was chosen deliberately because it cannot become silently permissive
  // the way commandsRun[].result was (see tlhm-uaw2).
  function validFenceBody(): string {
    return JSON.stringify(reportData());
  }

  function invalidFenceBody(): string {
    return JSON.stringify({
      criteriaSatisfied: [{ id: "c1", status: "INVALID_STATUS", evidence: "e" }],
      changedFiles: ["src/file.ts"],
      commandsRun: [{ command: "test", result: "passed", summary: "ok" }],
      validationOutput: [],
      residualRisks: [],
      noStagedFiles: true,
    });
  }

  function fence(body: string): string {
    return `\`\`\`acceptance-report\n${body}\n\`\`\``;
  }

  // Guard: the valid fixture must parse and the invalid fixture must not.
  it("fixtures are durably valid and invalid (guard)", () => {
    assert.ok(
      parseAcceptanceReport(`prose\n${fence(validFenceBody())}`).report,
      "valid fixture must parse",
    );
    assert.equal(
      parseAcceptanceReport(`prose\n${fence(invalidFenceBody())}`).report,
      undefined,
      "invalid fixture must not parse",
    );
  });

  // 1. valid only — analyzeAcceptanceOutput selects the single fence and strips it.
  it("valid only: analysis selects the fence, parses, and strips it", () => {
    const output = `prose\n${fence(validFenceBody())}`;
    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(analysis.status, "valid", "must parse the valid fence");
    assert.ok(analysis.stripped, "terminal valid fence must be marked stripped");
    assert.equal(analysis.strippedOutput, "prose", "strippedOutput must be prose only");
    // parseAcceptanceReport is a thin projection — same result.
    const parsed = parseAcceptanceReport(output);
    assert.ok(parsed.report, "must parse the valid fence");
    assert.equal(parsed.error, undefined);
  });

  // 2. invalid only — retired caller-gating contract. The old `stripAcceptanceReport`
  //    removed fences unconditionally (callers were responsible for gating on parse).
  //    The new contract: invalid fences are NEVER stripped; strippedOutput === output.
  //    This closes the class of mismatches where two independent selection chains
  //    could authorise different operations on the same output (tlhm-wbvp).
  it("invalid only: analysis detects invalid fence and leaves output unchanged", () => {
    const output = `prose\n${fence(invalidFenceBody())}`;
    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(analysis.status, "invalid", "must detect the fence as invalid");
    assert.equal(analysis.stripped, false, "invalid fence must not be stripped");
    assert.equal(
      analysis.strippedOutput,
      output,
      "strippedOutput must equal the original — invalid fences are never removed",
    );
    // parseAcceptanceReport projection also returns no report.
    const parsed = parseAcceptanceReport(output);
    assert.equal(parsed.report, undefined, "must not parse the invalid fence");
    assert.ok(parsed.error, "must return a parse error");
  });

  // 3. valid-then-invalid — canonical regression case for tlhm-30b6 AND tlhm-wbvp.
  //    The last fence is invalid; parse must NOT return the earlier valid one.
  //    analyzeAcceptanceOutput selects the LAST fence (invalid, terminal) and does
  //    NOT strip it — a single result, no independent selection sites.
  it("valid-then-invalid: analysis selects last (invalid) fence; nothing is stripped", () => {
    const validF = fence(validFenceBody());
    const invalidF = fence(invalidFenceBody());
    const output = `prose\n${validF}\n${invalidF}`;

    // The last (invalid) fence is terminal and wins by position.
    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(
      analysis.status,
      "invalid",
      "REGRESSION GUARD: must select the last (invalid) fence, not the earlier valid one",
    );
    assert.equal(analysis.stripped, false, "invalid fence must not be stripped");
    assert.equal(analysis.strippedOutput, output, "output must be byte-for-byte unchanged");
    assert.ok(
      analysis.strippedOutput.includes(validFenceBody()),
      "valid fence body must survive in the unchanged output",
    );
    assert.ok(
      analysis.strippedOutput.includes("INVALID_STATUS"),
      "invalid fence must also survive — not silently removed",
    );
    // parseAcceptanceReport projects the same outcome.
    const parsed = parseAcceptanceReport(output);
    assert.equal(parsed.report, undefined, "must not return the earlier valid fence");
    assert.ok(parsed.error, "parse must report an error for the invalid last fence");
  });

  // 4. invalid-then-valid — the last fence is valid; analysis selects and strips it.
  it("invalid-then-valid: analysis selects last (valid) fence; it is stripped, invalid survives", () => {
    const invalidF = fence(invalidFenceBody());
    const validF = fence(validFenceBody());
    const output = `prose\n${invalidF}\n${validF}`;

    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(analysis.status, "valid", "must select the last (valid) fence");
    assert.equal(analysis.stripped, true, "terminal valid fence must be stripped");
    assert.equal(
      analysis.report?.changedFiles?.[0],
      "src/file.ts",
      "report must come from the valid fence",
    );
    assert.ok(
      analysis.strippedOutput.includes("INVALID_STATUS"),
      "invalid fence must survive — only the valid last fence is stripped",
    );
    assert.ok(
      !analysis.strippedOutput.includes(validFenceBody()),
      "valid fence body must be stripped",
    );

    const parsed = parseAcceptanceReport(output);
    assert.ok(parsed.report, "must parse the last (valid) fence");
  });

  // 5. two-valid — the last valid fence is canonical; the first is not stripped.
  it("two-valid: analysis returns the last fence; first fence survives strip", () => {
    const firstBody = JSON.stringify({ ...reportData(), changedFiles: ["first/file.ts"] });
    const lastBody = JSON.stringify({ ...reportData(), changedFiles: ["last/file.ts"] });
    const output = `prose\n${fence(firstBody)}\n${fence(lastBody)}`;

    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(analysis.status, "valid", "must parse one of the valid fences");
    assert.deepEqual(
      analysis.report?.changedFiles,
      ["last/file.ts"],
      "must select the LAST valid fence, not the first",
    );
    assert.ok(analysis.strippedOutput.includes("first/file.ts"), "first fence must survive strip");
    assert.ok(!analysis.strippedOutput.includes("last/file.ts"), "last fence must be stripped");

    const parsed = parseAcceptanceReport(output);
    assert.ok(parsed.report);
    assert.deepEqual(parsed.report?.changedFiles, ["last/file.ts"]);
  });
});

describe("acceptanceRejectionReason", () => {
  it("returns childReportParseError as highest priority", () => {
    const reason = acceptanceRejectionReason({
      status: "rejected",
      childReportParseError: "Parse error: no fenced block found",
      runtimeChecks: [{ id: "attestation", status: "failed", message: "should not win" }],
      verifyRuns: [],
    } as never);
    assert.equal(reason, "Parse error: no fenced block found");
  });

  it("returns first failed runtimeChecks message when no parse error", () => {
    const reason = acceptanceRejectionReason({
      status: "rejected",
      runtimeChecks: [
        { id: "criterion:criterion-1", status: "passed", message: "pass" },
        {
          id: "evidence:no-staged-files",
          status: "failed",
          message: "Staged files present: src/file.ts",
        },
        { id: "evidence:changed-files", status: "failed", message: "should not win" },
      ],
      verifyRuns: [],
    } as never);
    assert.equal(reason, "Staged files present: src/file.ts");
  });

  it("returns first failed/timed-out verifyRuns entry when no check failures", () => {
    const reason = acceptanceRejectionReason({
      status: "rejected",
      runtimeChecks: [{ id: "evidence:no-staged-files", status: "passed", message: "ok" }],
      verifyRuns: [
        {
          id: "check-types",
          command: "npm run typecheck",
          cwd: "/repo",
          durationMs: 0,
          exitCode: 0,
          status: "passed",
        },
        {
          id: "run-tests",
          command: "npm test",
          cwd: "/repo",
          durationMs: 100,
          exitCode: 1,
          status: "failed",
        },
        {
          id: "check-build",
          command: "npm run build",
          cwd: "/repo",
          durationMs: 0,
          exitCode: 1,
          status: "failed",
        },
      ],
    } as never);
    assert.equal(reason, "Verification 'run-tests' failed.");
  });

  it("returns undefined when there is no diagnosable cause", () => {
    const reason = acceptanceRejectionReason({
      status: "rejected",
      runtimeChecks: [],
      verifyRuns: [],
    } as never);
    assert.equal(reason, undefined);
  });

  it("returns a timed-out verifyRuns entry with the correct suffix", () => {
    const reason = acceptanceRejectionReason({
      status: "rejected",
      runtimeChecks: [],
      verifyRuns: [
        {
          id: "slow-test",
          command: "npm test",
          cwd: "/repo",
          durationMs: 120_000,
          exitCode: null,
          status: "timed-out",
        },
      ],
    } as never);
    assert.equal(reason, "Verification 'slow-test' timed-out.");
  });
});

describe("stripAcceptanceReportIfValid: parse-gated strip (tlhm-qgme)", () => {
  // Durably invalid fixture: criteriaSatisfied[].status is not a valid enum value.
  // Do NOT use commandsRun[].result — that field was made permissive in tlhm-uaw2
  // and would silently stop being invalid.
  function invalidOutput(prose = "Work done."): string {
    const json = JSON.stringify({
      criteriaSatisfied: [{ id: "c1", status: "INVALID_STATUS", evidence: "e" }],
      changedFiles: ["src/file.ts"],
      commandsRun: [{ command: "test", result: "passed", summary: "ok" }],
      validationOutput: [],
      residualRisks: [],
      noStagedFiles: true,
    });
    return `${prose}\n\`\`\`acceptance-report\n${json}\n\`\`\``;
  }

  function validOutput(prose = "Work done."): string {
    const json = JSON.stringify({
      criteriaSatisfied: [{ id: "c1", status: "satisfied", evidence: "done" }],
      changedFiles: ["src/file.ts"],
      commandsRun: [{ command: "npm test", result: "passed", summary: "all green" }],
      validationOutput: ["1108/1108"],
      residualRisks: ["none"],
      noStagedFiles: true,
    });
    return `${prose}\n\`\`\`acceptance-report\n${json}\n\`\`\``;
  }

  it("fixture validity guard: invalid fixture must not parse", () => {
    // If this fails the fixture is no longer invalid and the guard tests below
    // would certify nothing. Fix the fixture first.
    const result = parseAcceptanceReport(invalidOutput());
    assert.equal(result.report, undefined, "invalid fixture must fail to parse");
    assert.ok(result.error, "invalid fixture must produce a parse error");
  });

  it("fixture validity guard: valid fixture must parse", () => {
    const result = parseAcceptanceReport(validOutput());
    assert.ok(result.report, "valid fixture must parse successfully");
    assert.equal(result.error, undefined);
  });

  // MESSAGE-LIST PATH (tlhm-qgme guard 1): invalid report survives unchanged.
  //
  // Removing the parse guard in stripAcceptanceReportsFromMessages (i.e. reverting
  // to stripAcceptanceReport, which strips unconditionally) would cause this test
  // to fail because the fence block would be silently removed despite being invalid.
  it("leaves text part unchanged when its own acceptance-report fence is invalid", () => {
    const text = invalidOutput("Evidence prose that must survive.");
    const result = stripAcceptanceReportIfValid(text);
    // The fence must survive intact — no stripping on an invalid report.
    assert.equal(result, text, "invalid fence must not be stripped");
    assert.ok(
      result.includes("```acceptance-report"),
      "fence block must still be present in the output",
    );
  });

  it("strips the fence when the text part's own acceptance-report is valid", () => {
    const text = validOutput("Work done.");
    const result = stripAcceptanceReportIfValid(text);
    assert.equal(result, "Work done.", "valid fence must be stripped");
    assert.ok(
      !result.includes("```acceptance-report"),
      "fence block must be absent after stripping",
    );
  });

  // OUTPUT-FILE PATH (tlhm-qgme guard 2): user-owned deliverable with invalid report.
  //
  // Removing the parse guard (i.e. reverting to the cross-authorised form where
  // finalAcceptanceReport from acceptanceOutput authorises stripping
  // resolvedOutput.fullOutput) would cause this test to fail because an invalid
  // fence in the output file would be stripped on the authority of a different
  // string's parse result.
  //
  // We test the function used on the output-file path directly. The guard is that
  // stripAcceptanceReportIfValid(outputFileContent) returns the original text
  // unchanged when the output file's own fence is invalid — regardless of whether
  // any other string parsed successfully.
  it("does not modify output file content when its own acceptance-report fence is invalid", () => {
    // Simulate a user-owned output file that contains an invalid acceptance-report
    // fence at the end. This represents a deliverable written to a configured
    // outputPath that happens to contain a malformed fence.
    const outputFileContent = invalidOutput("User deliverable content.");

    // The file is parsed independently — its own fence is invalid.
    const ownParse = parseAcceptanceReport(outputFileContent);
    assert.equal(ownParse.report, undefined, "output file fence must not parse");

    // The output-file strip path uses stripAcceptanceReportIfValid, which must
    // leave the content untouched when the file's own fence is invalid.
    const result = stripAcceptanceReportIfValid(outputFileContent);
    assert.equal(
      result,
      outputFileContent,
      "user-owned output file with invalid fence must not be modified",
    );
  });

  it("does not strip a non-trailing fence", () => {
    const json = JSON.stringify({
      criteriaSatisfied: [{ id: "c1", status: "satisfied", evidence: "done" }],
      changedFiles: ["src/file.ts"],
      commandsRun: [{ command: "npm test", result: "passed", summary: "ok" }],
      validationOutput: [],
      residualRisks: [],
      noStagedFiles: true,
    });
    // Fence is followed by prose — not trailing.
    const text = `\`\`\`acceptance-report\n${json}\n\`\`\`\n\nMore prose after.`;
    const result = stripAcceptanceReportIfValid(text);
    assert.equal(result, text, "non-trailing fence must not be stripped");
  });
});

/**
 * Table-driven tests for stripAcceptanceReportIfValid across all three
 * syntactic forms (tlhm-hrka).
 *
 * Correctness contract: parse THIS string; if it parses, strip whichever form
 * it actually took; if it does not parse, leave the string completely untouched.
 * Validity gates the strip — not the syntactic flavour.
 *
 * VALIDITY-GATING BREAK TEST: the final test in this block confirms that these
 * assertions would FAIL if the gating were removed. That test was verified by
 * temporarily replacing `locateAnyAcceptanceCandidate` with an always-strip
 * variant and observing failures in the three "invalid → unchanged" cases.
 */
describe("stripAcceptanceReportIfValid: all three forms (tlhm-hrka)", () => {
  // Durably invalid payload: criteriaSatisfied[].status is not a valid enum value.
  // Do NOT switch to commandsRun[].result — that field is permissive (tlhm-uaw2)
  // and would silently stop being invalid.
  const INVALID_PAYLOAD = {
    criteriaSatisfied: [{ id: "c1", status: "INVALID_STATUS", evidence: "e" }],
    changedFiles: ["src/file.ts"],
    commandsRun: [{ command: "test", result: "passed", summary: "ok" }],
    residualRisks: [],
    noStagedFiles: true,
  };
  const VALID_PAYLOAD = {
    criteriaSatisfied: [{ id: "c1", status: "satisfied", evidence: "done" }],
    changedFiles: ["src/file.ts"],
    commandsRun: [{ command: "npm test", result: "passed", summary: "all green" }],
    residualRisks: ["none"],
    noStagedFiles: true,
  };

  // Helper builders for each form.
  function taggedFence(payload: Record<string, unknown>, prose = "Work done."): string {
    return `${prose}\n\`\`\`acceptance-report\n${JSON.stringify(payload)}\n\`\`\``;
  }
  function jsonFence(payload: Record<string, unknown>, prose = "Work done."): string {
    return `${prose}\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
  }
  function prefixForm(payload: Record<string, unknown>, prose = "Work done."): string {
    return `${prose}\nACCEPTANCE_REPORT: ${JSON.stringify(payload)}`;
  }

  // Six table cases: 3 forms × 2 validity states.
  const cases: Array<{
    label: string;
    input: string;
    valid: boolean;
    prose: string;
  }> = [
    {
      label: "tagged fence — valid",
      input: taggedFence(VALID_PAYLOAD),
      valid: true,
      prose: "Work done.",
    },
    {
      label: "tagged fence — invalid",
      input: taggedFence(INVALID_PAYLOAD),
      valid: false,
      prose: "Work done.",
    },
    {
      label: "json-family fence — valid",
      input: jsonFence(VALID_PAYLOAD),
      valid: true,
      prose: "Work done.",
    },
    {
      label: "json-family fence — invalid",
      input: jsonFence(INVALID_PAYLOAD),
      valid: false,
      prose: "Work done.",
    },
    {
      label: "ACCEPTANCE_REPORT: prefix — valid",
      input: prefixForm(VALID_PAYLOAD),
      valid: true,
      prose: "Work done.",
    },
    {
      label: "ACCEPTANCE_REPORT: prefix — invalid",
      input: prefixForm(INVALID_PAYLOAD),
      valid: false,
      prose: "Work done.",
    },
  ];

  for (const { label, input, valid, prose } of cases) {
    it(label, () => {
      const result = stripAcceptanceReportIfValid(input);
      if (valid) {
        // A valid report in any form must be stripped, leaving only the prose.
        assert.equal(
          result,
          prose,
          `valid ${label}: expected prose only, got: ${JSON.stringify(result)}`,
        );
      } else {
        // An invalid report in any form must leave the string completely untouched.
        assert.equal(
          result,
          input,
          `invalid ${label}: expected unchanged input, got: ${JSON.stringify(result)}`,
        );
      }
    });
  }

  // Confirm the valid fixture actually parses and the invalid fixture does not,
  // so the table cases above are certifying real protection (not vacuous identity).
  it("fixture guards: valid payload parses; invalid payload does not", () => {
    const validTagged = parseAcceptanceReport(taggedFence(VALID_PAYLOAD));
    assert.ok(validTagged.report, "valid tagged must parse");
    const invalidTagged = parseAcceptanceReport(taggedFence(INVALID_PAYLOAD));
    assert.equal(invalidTagged.report, undefined, "invalid tagged must not parse");

    const validJson = parseAcceptanceReport(jsonFence(VALID_PAYLOAD));
    assert.ok(validJson.report, "valid json-family must parse");
    // Invalid json-family: the shape-sniff (hasGenericAcceptanceReportSignal)
    // requires criteriaSatisfied to be present with a recognised structure.
    // INVALID_PAYLOAD has criteriaSatisfied with a bad status so validateAcceptanceReport
    // rejects it — but parseGenericJsonAcceptanceReportBody runs validateAcceptanceReport
    // which returns no report, so parseAcceptanceReport returns no report.
    const invalidJson = parseAcceptanceReport(jsonFence(INVALID_PAYLOAD));
    assert.equal(invalidJson.report, undefined, "invalid json-family must not parse");

    const validPrefix = parseAcceptanceReport(prefixForm(VALID_PAYLOAD));
    assert.ok(validPrefix.report, "valid ACCEPTANCE_REPORT: prefix must parse");
    const invalidPrefix = parseAcceptanceReport(prefixForm(INVALID_PAYLOAD));
    assert.equal(
      invalidPrefix.report,
      undefined,
      "invalid ACCEPTANCE_REPORT: prefix must not parse",
    );
  });
});

describe("analyzeAcceptanceOutput: prefix-form balanced-span regression (tlhm-bbhv)", () => {
  // Prefix-form report with valid JSON. The report is trailing so it is stripped.
  function prefixReport(prose: string): string {
    return `${prose}\nACCEPTANCE_REPORT: ${JSON.stringify(reportData())}`;
  }

  // Prose-before cases — the report is trailing, so strippedOutput must equal prose.
  // Bytes before the span are never modified (no trimEnd on surrounding content).

  it("prose before the report with a single brace survives", () => {
    const prose = "Evidence { with a single brace }";
    const output = prefixReport(prose);
    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(analysis.status, "valid");
    assert.equal(
      analysis.strippedOutput,
      prose,
      "prose containing { } must survive intact after stripping the trailing prefix report",
    );
  });

  it("prose before the report with nested braces survives", () => {
    const prose = "Evidence { outer { inner } still-outer }";
    const analysis = analyzeAcceptanceOutput(prefixReport(prose));
    assert.equal(analysis.status, "valid");
    assert.equal(analysis.strippedOutput, prose, "prose with nested braces must survive intact");
  });

  it("prose before the report with multiple closing braces survives", () => {
    const prose = "Results: } second } third }";
    const analysis = analyzeAcceptanceOutput(prefixReport(prose));
    assert.equal(analysis.status, "valid");
    assert.equal(
      analysis.strippedOutput,
      prose,
      "prose with multiple closing braces must survive intact",
    );
  });

  // Prose-after case — the original incident: prose FOLLOWS the report and
  // contains a closing brace. The greedy regex swallowed the prose; the balanced
  // extractor must not. Because prose follows, the report is non-trailing and
  // must NOT be stripped (stripped: false).
  it("prose after a valid prefix report containing braces is not swallowed (reproduction)", () => {
    const validJson = JSON.stringify(reportData());
    const input = `ACCEPTANCE_REPORT: ${validJson}\n\nIMPORTANT PROSE the user needs { and it ends with a brace }`;

    // Report parses successfully but is non-terminal (prose follows).
    const analysis = analyzeAcceptanceOutput(input);
    assert.equal(analysis.status, "valid", "valid prefix report must parse");
    assert.equal(analysis.stripped, false, "non-terminal report must not be stripped");
    assert.equal(
      analysis.strippedOutput,
      input,
      "prose after the report must not be swallowed — strippedOutput must equal input",
    );
    assert.ok(
      analysis.strippedOutput.includes("IMPORTANT PROSE"),
      "the prose must survive byte-for-byte",
    );
  });

  // Non-destruction floor: strippedOutput is never empty when input had non-report content.
  it("strippedOutput is never empty when input contains non-report content", () => {
    const cases = [
      prefixReport("prose before the report"),
      `ACCEPTANCE_REPORT: ${JSON.stringify(reportData())}\n\nProse after with a brace }`,
      `ACCEPTANCE_REPORT: ${JSON.stringify(reportData())}\n\nProse with { opening and } closing`,
    ];
    for (const input of cases) {
      const result = analyzeAcceptanceOutput(input);
      assert.ok(
        result.strippedOutput.trim().length > 0,
        `strippedOutput must not be empty for input: ${JSON.stringify(input.slice(0, 80))}`,
      );
    }
  });
});

// ─── analyzeAcceptanceOutput: acceptance criterion tests (tlhm-wbvp) ──────────

describe("analyzeAcceptanceOutput: one selection site, five-row mismatch table", () => {
  // Shared valid payload used across all form builders.
  const VALID_PAYLOAD = {
    criteriaSatisfied: [{ id: "c1", status: "satisfied", evidence: "done" }],
    changedFiles: ["src/file.ts"],
    commandsRun: [{ command: "npm test", result: "passed", summary: "all green" }],
    residualRisks: ["none"],
    noStagedFiles: true,
  };

  // ── Five-row mismatch table (measured against old runtime; now all consistent) ──
  //
  // input              old parse   old stripIfValid   new analyzeAcceptanceOutput
  // tag then json      TAGGED      strips nothing      selects json (terminal) strips json
  // json then tag      TAGGED      strips TAGGED       selects tagged (terminal) strips tagged
  // tag then prefix    TAGGED      strips nothing      selects prefix (terminal) strips prefix
  // prefix then tag    TAGGED      strips TAGGED       selects tagged (terminal) strips tagged
  // json then prefix   JSONFAM     strips PREFIX       selects prefix (terminal) strips prefix
  //
  // The old "strips nothing" rows were safe but inconsistent (parse and strip disagreed).
  // The old "json then prefix" row was a genuine mismatch (JSONFAM parsed, PREFIX stripped).
  // The new unified result is always consistent: one candidate, one outcome.

  it("tag then json: terminality wins — json (terminal) selected, tagged (non-terminal) ignored", () => {
    // tagged fence appears first (non-terminal), json fence appears last (terminal).
    const tagged = `\`\`\`acceptance-report\n${JSON.stringify(VALID_PAYLOAD)}\n\`\`\``;
    const json = `\`\`\`json\n${JSON.stringify(VALID_PAYLOAD)}\n\`\`\``;
    const output = `${tagged}\n${json}`;
    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(analysis.status, "valid");
    assert.equal(
      analysis.form,
      "jsonfam",
      "json (terminal) must be selected over tagged (non-terminal)",
    );
    assert.equal(analysis.stripped, true, "terminal candidate must be stripped");
    // strippedOutput ends just before the json fence separator newline.
    assert.ok(
      analysis.strippedOutput.includes("acceptance-report"),
      "tagged fence must survive in strippedOutput",
    );
    assert.ok(
      !analysis.strippedOutput.includes("```json"),
      "json fence must be removed from strippedOutput",
    );
  });

  it("json then tag: tagged (terminal) selected — consistent parse and strip", () => {
    const json = `\`\`\`json\n${JSON.stringify(VALID_PAYLOAD)}\n\`\`\``;
    const tagged = `\`\`\`acceptance-report\n${JSON.stringify(VALID_PAYLOAD)}\n\`\`\``;
    const output = `prose\n${json}\n${tagged}`;
    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(analysis.status, "valid");
    assert.equal(analysis.form, "tagged", "tagged (terminal) must be selected");
    assert.equal(analysis.stripped, true);
    assert.equal(analysis.strippedOutput, `prose\n${json}`, "strippedOutput must be prose+json");
  });

  it("tag then prefix: terminality wins — prefix (terminal) selected", () => {
    const tagged = `\`\`\`acceptance-report\n${JSON.stringify(VALID_PAYLOAD)}\n\`\`\``;
    const prefix = `ACCEPTANCE_REPORT: ${JSON.stringify(VALID_PAYLOAD)}`;
    const output = `${tagged}\n${prefix}`;
    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(analysis.status, "valid");
    assert.equal(analysis.form, "prefix", "prefix (terminal) must win over tagged (non-terminal)");
    assert.equal(analysis.stripped, true);
    assert.ok(analysis.strippedOutput.includes("acceptance-report"), "tagged fence must survive");
    assert.ok(!analysis.strippedOutput.includes("ACCEPTANCE_REPORT:"), "prefix must be removed");
  });

  it("prefix then tag: tagged (terminal) selected — consistent parse and strip", () => {
    const prefix = `ACCEPTANCE_REPORT: ${JSON.stringify(VALID_PAYLOAD)}`;
    const tagged = `\`\`\`acceptance-report\n${JSON.stringify(VALID_PAYLOAD)}\n\`\`\``;
    const output = `prose\n${prefix}\n${tagged}`;
    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(analysis.status, "valid");
    assert.equal(analysis.form, "tagged", "tagged (terminal) must be selected");
    assert.equal(analysis.stripped, true);
    // strippedOutput contains the prefix (which was non-terminal).
    assert.ok(analysis.strippedOutput.includes("ACCEPTANCE_REPORT:"), "prefix must survive");
    assert.ok(
      !analysis.strippedOutput.includes("acceptance-report"),
      "tagged fence must be removed",
    );
  });

  it("json then prefix: THE MISMATCH — prefix (terminal) selected for both parse and strip", () => {
    // This was the open bug: parseAcceptanceReport returned JSONFAM while
    // stripAcceptanceReportIfValid stripped PREFIX. Now a single result selects PREFIX.
    const json = `\`\`\`json\n${JSON.stringify(VALID_PAYLOAD)}\n\`\`\``;
    const prefix = `ACCEPTANCE_REPORT: ${JSON.stringify(VALID_PAYLOAD)}`;
    const output = `prose\n${json}\n${prefix}`;
    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(analysis.status, "valid");
    assert.equal(
      analysis.form,
      "prefix",
      "MISMATCH FIX: prefix (terminal) must win over json (non-terminal)",
    );
    assert.equal(analysis.stripped, true);
    // The json fence (non-terminal) survives; the prefix (terminal) is removed.
    assert.ok(analysis.strippedOutput.includes("```json"), "json fence must survive");
    assert.ok(!analysis.strippedOutput.includes("ACCEPTANCE_REPORT:"), "prefix must be removed");
    // parseAcceptanceReport projection is now consistent with strippedOutput.
    const parsed = parseAcceptanceReport(output);
    assert.ok(parsed.report, "parseAcceptanceReport must return a report");
  });
});

describe("analyzeAcceptanceOutput: uniform policy edge cases (tlhm-wbvp)", () => {
  const VALID_PAYLOAD = {
    criteriaSatisfied: [{ id: "c1", status: "satisfied", evidence: "done" }],
    changedFiles: ["src/file.ts"],
    commandsRun: [{ command: "npm test", result: "passed", summary: "ok" }],
    residualRisks: ["none"],
    noStagedFiles: true,
  };
  const INVALID_PAYLOAD = {
    criteriaSatisfied: [{ id: "c1", status: "INVALID_STATUS", evidence: "e" }],
    changedFiles: ["src/file.ts"],
    residualRisks: [],
    noStagedFiles: true,
  };

  it("non-terminal valid candidate: report returned, stripped: false, strippedOutput === output", () => {
    // A valid json fence followed by prose is non-terminal. The report is
    // returned (valid) but the fence is not removed (stripped: false).
    const output = `\`\`\`json\n${JSON.stringify(VALID_PAYLOAD)}\n\`\`\`\n\nMore prose.`;
    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(analysis.status, "valid", "non-terminal valid candidate parses successfully");
    assert.equal(analysis.stripped, false, "non-terminal candidate must not be stripped");
    assert.equal(analysis.strippedOutput, output, "strippedOutput must equal input");
  });

  it("later malformed explicit blocks earlier valid: no fallback to stale candidate", () => {
    // A valid json fence (earlier) followed by a malformed tagged fence (later, terminal).
    // The later malformed explicit blocks the earlier valid one — no silent fallback.
    const json = `\`\`\`json\n${JSON.stringify(VALID_PAYLOAD)}\n\`\`\``;
    const malformedTagged = `\`\`\`acceptance-report\n${JSON.stringify(INVALID_PAYLOAD)}\n\`\`\``;
    const output = `prose\n${json}\n${malformedTagged}`;
    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(
      analysis.status,
      "invalid",
      "later malformed explicit candidate must block earlier valid one",
    );
    assert.equal(analysis.form, "tagged", "tagged (explicit, terminal) must be selected");
    assert.equal(analysis.stripped, false, "invalid candidate must not be stripped");
    assert.equal(analysis.strippedOutput, output, "output must be byte-for-byte unchanged");
  });

  it("missing: no candidates at all returns status:missing and unchanged strippedOutput", () => {
    const output = "Just prose, no acceptance report here.";
    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(analysis.status, "missing");
    assert.equal(analysis.strippedOutput, output);
    assert.equal(analysis.stripped, false);
    assert.match(analysis.error, /Structured acceptance report not found/);
  });

  it("exact span splice: blank lines before fence are preserved, not eaten by trimEnd", () => {
    // "user line\\n\\n\\n\\n" + report currently becomes "user line" via trimEnd.
    // After fix: the separator \\n (captured in the span) is removed but the
    // preceding \\n\\n\\n are preserved as-is (bytes outside the span unchanged).
    const report = `\`\`\`acceptance-report\n${JSON.stringify(VALID_PAYLOAD)}\n\`\`\``;
    const output = `user line\n\n\n\n${report}`;
    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(analysis.status, "valid");
    assert.equal(analysis.stripped, true);
    // The separator \\n (captured by \\n? in the pattern) is inside the span.
    // The three preceding \\n are outside and must survive byte-for-byte.
    assert.equal(
      analysis.strippedOutput,
      "user line\n\n\n",
      "three blank lines must survive; only the separator newline is inside the span",
    );
  });

  // tlhm-ilsw: ordering — remedy must precede raw validator detail in the displacement annotation
  it("displacement annotation: remedy directive appears before diagnosis and raw error", () => {
    // Valid fence followed by an invalid terminal fence (the prose-example trigger).
    const validBody = JSON.stringify({
      criteriaSatisfied: [{ id: "c1", status: "satisfied", evidence: "done" }],
      changedFiles: ["src/file.ts"],
      testsAddedOrUpdated: [],
      commandsRun: [{ command: "npm test", result: "passed", summary: "ok" }],
      validationOutput: [],
      residualRisks: ["none"],
      noStagedFiles: true,
      diffSummary: "added feature",
      reviewFindings: [],
      manualNotes: "",
    });
    const invalidBody = JSON.stringify({}); // fails: no acceptance report field
    const validFence = `\`\`\`acceptance-report\n${validBody}\n\`\`\``;
    const invalidFence = `\`\`\`acceptance-report\n${invalidBody}\n\`\`\``;
    const output = `prose\n${validFence}\n${invalidFence}`;

    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(analysis.status, "invalid", "terminal invalid fence must win");
    // Remedy directive must appear before the condensed diagnosis and the raw error.
    const remedyStart = analysis.error.indexOf("Your real report must be last");
    const diagnosisStart = analysis.error.indexOf("Terminal fence displaced");
    const rawErrorStart = analysis.error.indexOf("expected at least one acceptance report field");
    assert.ok(remedyStart !== -1, "remedy directive must be present in error");
    assert.ok(diagnosisStart !== -1, "displacement diagnosis must be present in error");
    assert.ok(rawErrorStart !== -1, "raw validator error must be present in error");
    assert.ok(
      remedyStart < diagnosisStart,
      `remedy must appear before diagnosis: remedy at ${remedyStart}, diagnosis at ${diagnosisStart}`,
    );
    assert.ok(
      diagnosisStart < rawErrorStart,
      `diagnosis must appear before raw error: diagnosis at ${diagnosisStart}, error at ${rawErrorStart}`,
    );
    // 'prose example' and 'earlier' must still be present for the matrix tests
    assert.ok(analysis.error.includes("earlier"), "must mention displaced earlier candidate");
    assert.ok(analysis.error.includes("prose example"), "must mention prose example trigger");
  });

  // tlhm-ilsw: budget survival — placement instruction must survive REJECTION_REASON_MAX_LENGTH truncation
  it("displacement annotation: placement instruction survives 200-char budget truncation", () => {
    // Construct valid-then-invalid output to trigger the displacement annotation.
    // This is the scenario measured in the original incident (tlhm-bqj9 landed a 316-char reason).
    const validBody = JSON.stringify({
      criteriaSatisfied: [{ id: "c1", status: "satisfied", evidence: "done" }],
      changedFiles: ["src/file.ts"],
      commandsRun: [{ command: "npm test", result: "passed", summary: "ok" }],
      residualRisks: ["none"],
      noStagedFiles: true,
    });
    const invalidBody = JSON.stringify({}); // triggers: no acceptance report field
    const validFence = `\`\`\`acceptance-report\n${validBody}\n\`\`\``;
    const invalidFence = `\`\`\`acceptance-report\n${invalidBody}\n\`\`\``;
    const output = `prose\n${validFence}\n${invalidFence}`;

    const analysis = analyzeAcceptanceOutput(output);
    assert.equal(analysis.status, "invalid");

    // Simulate what parseAcceptanceReport does: prepend the parse-failure prefix.
    const rawReason = `Failed to parse acceptance-report: ${analysis.error}`;
    // Apply formatRejectionReason (normalize + truncate to REJECTION_REASON_MAX_LENGTH = 200).
    const rendered = formatRejectionReason(rawReason);

    // The placement instruction must be readable in the truncated string.
    // A supervisor reading this must know WHERE to put their report without
    // needing to see the untruncated version.
    assert.ok(
      rendered.includes("must be last"),
      `directive 'must be last' must survive the 200-char budget; got: "${rendered}"`,
    );
    assert.ok(
      rendered.includes("move it before"),
      `relocation instruction 'move it before' must survive the 200-char budget; got: "${rendered}"`,
    );
    // The rendered string must not exceed the budget.
    assert.ok(
      rendered.length <= 200,
      `rendered reason must be at most 200 chars; got ${rendered.length}`,
    );
  });

  it("isCommandsRunArray remains strict for json-family shape-sniffing", () => {
    // A json fence whose commandsRun has a non-enum result is still validated.
    // The strict check means it is a candidate (criteriaSatisfied + commandsRun
    // with wrong result type) but the parse fails.
    // Actually: isCommandsRunArray is used to detect the SIGNAL (candidate),
    // not to validate. The signal check accepts any array for commandsRun,
    // but validateAcceptanceReport validates the field properly and rejects bad result.
    const badCommands = {
      criteriaSatisfied: [{ id: "c1", status: "satisfied", evidence: "done" }],
      changedFiles: ["src/file.ts"],
      // commandsRun: result is not in the strict enum — isCommandsRunArray returns false.
      commandsRun: [{ command: "npm test", result: 42, summary: "ok" }],
      residualRisks: [],
      noStagedFiles: true,
    };
    const output = `done\n\`\`\`json\n${JSON.stringify(badCommands)}\n\`\`\``;
    // The signal check uses isCommandsRunArray which is strict; result:42 fails.
    // With criteriaSatisfied + changedFiles present, signal still fires (other fields pass).
    // The parse then fails validation on commandsRun[0].result.
    const parsed = parseAcceptanceReport(output);
    // commandsRun[0].result: 42 is not a string — validateAcceptanceReport rejects it.
    // But the SIGNAL fires (changedFiles is a string array), so it IS a candidate.
    // Since it's the only terminal candidate and it fails parse: status "invalid".
    const analysis = analyzeAcceptanceOutput(output);
    // Either invalid (signal fires, validation fails) or missing (signal doesn't fire).
    // The key: report must not be returned.
    assert.equal(parsed.report, undefined, "strict validation must reject non-string result");
    assert.notEqual(analysis.status, "valid", "bad commandsRun must not produce a valid result");
  });
});
