import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  acceptanceFailureMessage,
  appendAcceptanceReportDigest,
  buildAcceptanceReportDigest,
  evaluateAcceptance,
  formatAcceptancePrompt,
  mergeContinuationAcceptance,
  parseAcceptanceReport,
  parseAndStripAcceptanceReport,
  isEffectivelyEmpty,
  resolveEffectiveAcceptance,
  validateAcceptanceInput,
  validateDispatchAcceptanceInput,
} from "../../src/runs/shared/acceptance.ts";
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
    assert.equal(parseAndStripAcceptanceReport(invalidSignalJson).stripped, invalidSignalJson);

    const partialWrapperJson = `done\n\
\
\`\`\`json\n{"acceptance":{"changedFiles":["src/file.ts"]}}\n\`\`\``;
    const genericJsonWithPartialWrapper = parseAcceptanceReport(partialWrapperJson);
    assert.equal(genericJsonWithPartialWrapper.report, undefined);
    assert.match(
      genericJsonWithPartialWrapper.error ?? "",
      /Structured acceptance report not found/,
    );
    assert.equal(parseAndStripAcceptanceReport(partialWrapperJson).stripped, partialWrapperJson);

    const reportPayloadJson = `done\n\
\
\`\`\`json\n{"changedFiles":["src/file.ts"]}\n\`\`\``;
    const genericReportPayloadJson = parseAcceptanceReport(reportPayloadJson);
    assert.equal(genericReportPayloadJson.report, undefined);
    assert.match(genericReportPayloadJson.error ?? "", /Structured acceptance report not found/);
    assert.equal(parseAndStripAcceptanceReport(reportPayloadJson).stripped, reportPayloadJson);

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
      assert.equal(parseAndStripAcceptanceReport(output).stripped, "done");
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
      parseAndStripAcceptanceReport(output).stripped,
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
    assert.equal(parseAndStripAcceptanceReport(output).stripped, "done");
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

  it('commandsRun[].result accepts annotated strings like "failed as expected"', () => {
    // Regression: the field was previously a closed enum that rejected correct
    // work when agents wrote honest annotations. Validate the incident value.
    const parsed = parseAcceptanceReport(
      report({
        commandsRun: [
          { command: "npm test", result: "failed as expected", summary: "negative control" },
        ],
      }),
    );
    assert.notEqual(parsed.report, undefined);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.report?.commandsRun?.[0]?.result, "failed as expected");
  });

  it("commandsRun[].result rejects non-string values (number, null, object)", () => {
    for (const badResult of [42, null, { status: "ok" }]) {
      const parsed = parseAcceptanceReport(
        report({ commandsRun: [{ command: "npm test", result: badResult, summary: "x" }] }),
      );
      assert.equal(
        parsed.report,
        undefined,
        `expected failure for result=${JSON.stringify(badResult)}`,
      );
      assert.match(
        parsed.error ?? "",
        /commandsRun\[0\]\.result: expected string/,
        `expected type error for result=${JSON.stringify(badResult)}`,
      );
    }
  });

  it("untagged-JSON shape sniffing requires strict literals while tagged validation accepts any string", () => {
    // The strict/permissive split is intentional: isCommandsRunArray uses
    // exact literals to detect probable acceptance reports in generic JSON
    // fences; validateAcceptanceReport is permissive so annotated results
    // don't reject correct work. Keep these two behaviours distinct.
    const annotatedResult = "failed as expected";

    // Tagged fence: permissive validation — must succeed.
    const tagged = parseAcceptanceReport(
      report({ commandsRun: [{ command: "cmd", result: annotatedResult, summary: "ok" }] }),
    );
    assert.notEqual(tagged.report, undefined, "tagged fence with annotated result must parse");

    // Untagged JSON fence whose sole non-criteriaSatisfied signal is commandsRun
    // with a non-literal result — isCommandsRunArray should not match it.
    const untaggedOnly = [
      "done",
      "```json",
      JSON.stringify({
        criteriaSatisfied: [{ id: "c1", status: "satisfied", evidence: "ok" }],
        commandsRun: [{ command: "cmd", result: annotatedResult, summary: "ok" }],
      }),
      "```",
    ].join("\n");
    const untagged = parseAcceptanceReport(untaggedOnly);
    // No tagged fence present, so falls through to untagged detection;
    // commandsRun with annotated result is the only signal → not detected.
    assert.equal(
      untagged.report,
      undefined,
      "untagged fence with only annotated commandsRun must not be detected as acceptance report",
    );

    // Positive control: the same shape with a strict literal IS detected.
    const untaggedLiteral = parseAcceptanceReport(
      untaggedOnly.replace(`"result":"${annotatedResult}"`, '"result":"passed"'),
    );
    assert.notEqual(
      untaggedLiteral.report,
      undefined,
      "untagged fence with strict literal result must be detected",
    );
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

  it("gate and strip act on the same trailing candidate (system-level)", async () => {
    // Case 1: both fences valid — gate and strip must both pick the trailing one.
    // Case 2: first fence valid, trailing fence INVALID — gate must reject with the
    //   trailing fence's parse error, never accept on the earlier valid fence.
    //   (Previously: evaluateAcceptance fell back to first-valid, producing a false accept.)
    const cwd = tempRepo();
    try {
      const firstContent = reportData({ notes: "FENCE-1-EXAMPLE" });
      const secondContent = reportData({ notes: "FENCE-2-REAL" });

      // --- Case 1: valid trailing fence ---
      const validOutput = [
        "prose with an illustrative example",
        "```acceptance-report",
        JSON.stringify(firstContent),
        "```",
        "the real report follows",
        "```acceptance-report",
        JSON.stringify(secondContent),
        "```",
      ].join("\n");

      const { stripped, report: trailingReport } = parseAndStripAcceptanceReport(validOutput);
      assert.equal(trailingReport?.notes, "FENCE-2-REAL", "strip must pick the trailing fence");
      assert.ok(!stripped.includes("FENCE-2-REAL"), "trailing fence must be removed");
      assert.ok(stripped.includes("FENCE-1-EXAMPLE"), "first fence must remain");

      const acceptance = resolveEffectiveAcceptance({
        agentName: "worker",
        task: "Implement the fix",
        explicit: { level: "attested" },
      });
      const ledger = await evaluateAcceptance({ acceptance, output: validOutput, cwd });
      assert.equal(
        ledger.childReport?.notes,
        "FENCE-2-REAL",
        "gate must evaluate the trailing candidate, not the first fence",
      );
      assert.notEqual(ledger.status, "rejected", "valid trailing fence must not be rejected");

      // --- Case 2: INVALID trailing fence — must reject, never accept on the earlier fence ---
      // criteriaSatisfied must be an array; passing an object triggers a validation error.
      const invalidTrailingJson = JSON.stringify(reportData({ criteriaSatisfied: "not-an-array" }));
      const invalidOutput = [
        "prose with an illustrative example",
        "```acceptance-report",
        JSON.stringify(firstContent),
        "```",
        "the real report follows (malformed)",
        "```acceptance-report",
        invalidTrailingJson,
        "```",
      ].join("\n");

      const { report: noReport, error: parseErr } = parseAndStripAcceptanceReport(invalidOutput);
      assert.equal(noReport, undefined, "invalid trailing fence must not produce a report");
      assert.ok(parseErr, "must carry a parse error for the trailing fence");
      assert.match(parseErr ?? "", /criteriaSatisfied/, "error must name the failing field");

      const invalidLedger = await evaluateAcceptance({ acceptance, output: invalidOutput, cwd });
      assert.equal(
        invalidLedger.status,
        "rejected",
        "gate must reject when the trailing fence is invalid — not accept on the earlier valid fence",
      );
      assert.ok(
        invalidLedger.childReportParseError,
        "gate must surface the trailing fence's parse error",
      );
      assert.match(
        invalidLedger.childReportParseError ?? "",
        /criteriaSatisfied/,
        "gate error must identify the invalid field in the trailing fence",
      );
      // Confirm the earlier valid fence did NOT cause a false accept.
      assert.equal(
        invalidLedger.childReport,
        undefined,
        "gate must not populate childReport from the earlier illustrative fence",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
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

  it("parseAndStripAcceptanceReport is remove-only — does not inject digest", () => {
    // parseAndStripAcceptanceReport must stay a pure remove-only function;
    // appendAcceptanceReportDigest is the only sanctioned way to inject digest
    // content onto the supervisor-facing surface.
    const output = ["done", "```acceptance-report", JSON.stringify(reportData()), "```"].join("\n");
    const { stripped } = parseAndStripAcceptanceReport(output);
    assert.equal(stripped, "done");
    assert.doesNotMatch(stripped, /Validation evidence/);
    assert.doesNotMatch(stripped, /commandsRun/);
  });

  it("leaves a present-but-invalid acceptance-report fence intact", () => {
    // Regression guard: an unvalidated strip previously deleted present-but-invalid
    // reports while the compensating digest was appended only on the valid path.
    const invalid = [
      "some prose",
      "```acceptance-report",
      JSON.stringify({ changedFiles: "wrong-type" }), // changedFiles must be string[]
      "```",
    ].join("\n");
    const { stripped, report, error } = parseAndStripAcceptanceReport(invalid);
    // Must NOT strip — the fence must remain intact.
    assert.equal(stripped, invalid);
    assert.equal(report, undefined);
    assert.ok(error, "error must describe the validation failure");
    assert.match(error ?? "", /changedFiles/);

    // Positive control: a valid report IS stripped.
    const valid = ["some prose", "```acceptance-report", JSON.stringify(reportData()), "```"].join(
      "\n",
    );
    const { stripped: validStripped, report: validReport } = parseAndStripAcceptanceReport(valid);
    assert.notEqual(validStripped, valid, "valid report must be stripped");
    assert.equal(validStripped, "some prose");
    assert.ok(validReport, "valid report must be returned");
  });

  it("parse and strip agree on the trailing candidate — they cannot diverge by construction", () => {
    // When two valid acceptance-report fences are present, the old unpaired
    // parseAcceptanceReport (first-valid rule) + stripAcceptanceReport (trailing
    // rule) would act on DIFFERENT fences. parseAndStripAcceptanceReport uses the
    // trailing rule for both, so parse and strip always agree.
    const firstReport = reportData({ notes: "first" });
    const secondReport = reportData({ notes: "second" });
    const output = [
      "prose",
      "```acceptance-report",
      JSON.stringify(firstReport),
      "```",
      "middle text",
      "```acceptance-report",
      JSON.stringify(secondReport),
      "```",
    ].join("\n");

    const { stripped, report } = parseAndStripAcceptanceReport(output);

    // Trailing (second) fence was stripped; first fence is still present.
    assert.ok(stripped.includes(JSON.stringify(firstReport)), "first fence must survive");
    assert.ok(!stripped.includes(JSON.stringify(secondReport)), "second fence must be stripped");
    // The returned report matches the trailing (second) fence.
    assert.equal(report?.notes, "second");
  });

  it("ACCEPTANCE_REPORT marker: only strips when truly trailing; preserves suffix prose", () => {
    // Regression: the previous implementation used output.search() (first occurrence)
    // and output.slice(0, markerIndex) (discards everything after the marker),
    // meaning a non-trailing marker stripped all following prose.
    const validJson = JSON.stringify(reportData());

    // Non-trailing marker — suffix prose must survive untouched.
    const withSuffix = `Work done.\nACCEPTANCE_REPORT: ${validJson}\nIMPORTANT SUFFIX that must survive.`;
    const { stripped: suffixStripped, report: suffixReport } =
      parseAndStripAcceptanceReport(withSuffix);
    assert.equal(suffixReport, undefined, "non-trailing marker must not be the candidate");
    assert.equal(
      suffixStripped,
      withSuffix,
      "output must be returned unchanged when marker is not trailing",
    );
    assert.ok(suffixStripped.includes("IMPORTANT SUFFIX"), "suffix prose must survive");

    // Positive control: genuinely trailing marker IS stripped.
    const trailing = `Work done.\nACCEPTANCE_REPORT: ${validJson}`;
    const { stripped: trailingStripped, report: trailingReport } =
      parseAndStripAcceptanceReport(trailing);
    assert.ok(trailingReport, "trailing marker must produce a report");
    assert.equal(trailingStripped, "Work done.", "trailing marker must be stripped");
  });

  it("ACCEPTANCE_REPORT marker mentioned in prose is not the candidate when trailing fence exists", () => {
    // A marker in prose must not supersede a genuine trailing acceptance-report fence.
    // Regression: output.search() found the first occurrence regardless of position.
    const proseMarker =
      "See the ACCEPTANCE_REPORT: format for details.\n" +
      "```acceptance-report\n" +
      JSON.stringify(reportData({ notes: "real-report" })) +
      "\n```";
    const { stripped, report } = parseAndStripAcceptanceReport(proseMarker);
    assert.equal(report?.notes, "real-report", "trailing fence must be the candidate");
    assert.ok(!stripped.includes("real-report"), "trailing fence must be stripped");
    assert.ok(stripped.includes("ACCEPTANCE_REPORT"), "prose mention must survive");
  });
});

describe("appendAcceptanceReportDigest", () => {
  function parsedReport(): AcceptanceReport {
    const parsed = parseAcceptanceReport(report());
    assert.ok(parsed.report);
    return parsed.report;
  }

  it("appends the digest after the already-stripped output", () => {
    const stripped = parseAndStripAcceptanceReport(report()).stripped;
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

describe("isEffectivelyEmpty", () => {
  // Positive cases: strings that should be treated as effectively empty.
  it("returns true for an empty string", () => {
    assert.equal(isEffectivelyEmpty(""), true);
  });

  it("returns true for whitespace-only strings", () => {
    assert.equal(isEffectivelyEmpty("   "), true);
    assert.equal(isEffectivelyEmpty("\n\n"), true);
    assert.equal(isEffectivelyEmpty("  \t  \n  "), true);
  });

  it("returns true for a bare horizontal rule (the observed incident value)", () => {
    assert.equal(isEffectivelyEmpty("---"), true);
  });

  it("returns true for horizontal rules with surrounding whitespace", () => {
    assert.equal(isEffectivelyEmpty("\n---\n"), true);
    assert.equal(isEffectivelyEmpty("  ---  "), true);
    assert.equal(isEffectivelyEmpty("---\n\n---"), true);
  });

  it("returns true for all three Markdown horizontal-rule forms", () => {
    assert.equal(isEffectivelyEmpty("---"), true);
    assert.equal(isEffectivelyEmpty("***"), true);
    assert.equal(isEffectivelyEmpty("___"), true);
    assert.equal(isEffectivelyEmpty("----"), true);
    assert.equal(isEffectivelyEmpty("****"), true);
    assert.equal(isEffectivelyEmpty("____"), true);
  });

  // Negative (control) cases: strings with real content that must NOT be treated
  // as effectively empty.  Deleting the predicate or making it always return true
  // causes these to fail.
  it("returns false for a string with real content", () => {
    assert.equal(isEffectivelyEmpty("some output"), false);
  });

  it("returns false when a horizontal rule is followed by content", () => {
    assert.equal(isEffectivelyEmpty("---\nValidation evidence (from acceptance report):"), false);
  });

  it("returns false for an acceptance-report digest (starts and ends with --- but has content)", () => {
    const digest =
      "---\nValidation evidence (from acceptance report):\n\n  [passed] npm test \u2014 passed\n---";
    assert.equal(isEffectivelyEmpty(digest), false);
  });

  it("returns false for a string that mixes a rule line with content lines", () => {
    assert.equal(isEffectivelyEmpty("---\nactual findings here"), false);
    assert.equal(isEffectivelyEmpty("Implementation complete.\n\n---"), false);
  });

  it("returns false for single-dash or double-dash (not a valid hr)", () => {
    assert.equal(isEffectivelyEmpty("-"), false);
    assert.equal(isEffectivelyEmpty("--"), false);
  });
});
