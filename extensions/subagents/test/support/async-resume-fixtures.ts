import type { AcceptanceLedgerFixture } from "./async-artifact-fixtures.ts";
import type { ResolvedAcceptanceConfig } from "../../src/shared/types.ts";

export const pausedCheckedAcceptance: ResolvedAcceptanceConfig = {
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
};

export const pausedNoneAcceptance: ResolvedAcceptanceConfig = {
  level: "none",
  explicit: false,
  inferredReason: [],
  criteria: [],
  evidence: [],
  verify: [],
  stopRules: [],
};

export function skippedPausedAcceptanceLedger(
  effectiveAcceptance = pausedCheckedAcceptance,
): AcceptanceLedgerFixture {
  return {
    status: "skipped",
    effectiveAcceptance,
    inferredReason: effectiveAcceptance.inferredReason,
    criteria: effectiveAcceptance.criteria,
    runtimeChecks: [
      {
        id: "paused",
        status: "not-applicable",
        message:
          "Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
      },
    ],
    verifyRuns: [],
  };
}

export function notRequiredPausedAcceptanceLedger(
  effectiveAcceptance = pausedNoneAcceptance,
): AcceptanceLedgerFixture {
  return {
    status: "not-required",
    effectiveAcceptance,
    inferredReason: effectiveAcceptance.inferredReason,
    criteria: effectiveAcceptance.criteria,
    runtimeChecks: [
      {
        id: "acceptance-disabled",
        status: "not-applicable",
        message: "Acceptance level none does not require evaluation.",
      },
    ],
    verifyRuns: [],
  };
}
