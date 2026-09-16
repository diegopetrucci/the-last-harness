import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acceptanceFailureMessage,
  evaluateAcceptanceWithReportRepair,
  resolveEffectiveAcceptance,
} from "../../src/runs/shared/acceptance.ts";
import type { AcceptanceLedger } from "../../src/shared/types.ts";

function validReport(): string {
  return [
    "```acceptance-report",
    JSON.stringify({
      criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "implemented" }],
      changedFiles: ["src/file.ts"],
      testsAddedOrUpdated: ["test/file.test.ts"],
      commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
      validationOutput: ["tests passed"],
      residualRisks: [],
      noStagedFiles: true,
      reviewFindings: [],
    }),
    "```",
  ].join("\n");
}

describe("acceptance failure message report-repair classification", () => {
  it("does not mask substantive rejection reasons with a spent repair marker", () => {
    const acceptance = resolveEffectiveAcceptance({
      agentName: "worker",
      task: "Implement a fix",
      explicit: { level: "checked" },
    });
    const rejected = (overrides: Partial<AcceptanceLedger> = {}): AcceptanceLedger => ({
      status: "rejected",
      explicit: acceptance.explicit,
      effectiveAcceptance: acceptance,
      inferredReason: acceptance.inferredReason,
      criteria: acceptance.criteria,
      childReport: {},
      runtimeChecks: [],
      verifyRuns: [],
      reportRepairAttempted: true,
      ...overrides,
    });
    const cases: Array<[Partial<AcceptanceLedger>, RegExp]> = [
      [
        {
          runtimeChecks: [{ id: "runtime", status: "failed", message: "runtime check failed" }],
        },
        /runtime check failed/,
      ],
      [
        {
          verifyRuns: [
            { id: "verify", command: "npm test", exitCode: 1, status: "failed", durationMs: 1 },
          ],
        },
        /Acceptance verification 'verify' failed/,
      ],
      [
        {
          runtimeChecks: [
            {
              id: "criterion:scope",
              status: "failed",
              message: "required criterion was not satisfied",
            },
          ],
        },
        /required criterion was not satisfied/,
      ],
      [{ reviewResult: { status: "blockers", findings: [] } }, /Acceptance review found blockers/],
      [
        { reviewResult: { status: "needs-parent-decision", findings: [] } },
        /Acceptance review required/,
      ],
    ];

    for (const [overrides, expected] of cases) {
      const message = acceptanceFailureMessage(rejected(overrides)) ?? "";
      assert.match(message, expected);
      assert.doesNotMatch(message, /implementation complete but acceptance unverified/i);
    }

    const failedRepair = rejected({
      childReport: undefined,
      childReportParseError: "Structured acceptance report not found.",
      reportRepairError: "Acceptance report repair failed: malformed report.",
      runtimeChecks: [
        { id: "attestation", status: "failed", message: "Structured report missing" },
      ],
    });
    assert.match(
      acceptanceFailureMessage(failedRepair) ?? "",
      /Implementation complete but acceptance unverified: Acceptance report repair failed/,
    );
  });

  it("retains the reviewed rejection reason after a successful report repair", async () => {
    const acceptance = resolveEffectiveAcceptance({
      agentName: "worker",
      task: "Implement a fix",
      explicit: { level: "reviewed", review: { agent: "reviewer", required: true } },
    });
    const ledger = await evaluateAcceptanceWithReportRepair({
      acceptance,
      output: "implementation completed without a report",
      cwd: process.cwd(),
      exitCode: 0,
      repair: async () => validReport(),
    });

    assert.equal(ledger.reportRepairAttempted, true);
    assert.ok(ledger.childReport);
    assert.equal(ledger.reviewResult?.status, "needs-parent-decision");
    assert.equal(
      acceptanceFailureMessage(ledger),
      "Acceptance review required but no automatic reviewer result is available.",
    );
  });
});
