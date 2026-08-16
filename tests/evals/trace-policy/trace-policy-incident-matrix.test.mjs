import assert from "node:assert/strict";
import test from "node:test";

import { TRACE_POLICY_FIXTURES } from "./trace-policy-fixtures.mjs";
import { TRACE_POLICY_INCIDENT_MATRIX } from "./trace-policy-incident-matrix.mjs";

const REQUIRED_MATRIX_IDS = [
  "gh-205-final-validation-no-edit",
  "gh-217-subagent-agentdirs-preserved",
  "architect-direct-source-mutation-boundary",
  "architect-ticket-approval-boundary",
  "architect-paused-subagent-recovery-boundary",
  "architect-review-digest-boundary",
  "architect-deterministic-research-routing",
  "developer-ticket-source-before-edit",
  "developer-blocking-contact-supervisor-stop-boundary",
  "developer-pre-existing-changes-preservation-boundary",
  "code-reviewer-read-only-diff-inspection",
  "web-scout-citation-discipline",
  "installer-profile-isolation-safety",
];

const ALLOWED_SOURCE_KINDS = new Set([
  "live-smoke",
  "repo-test",
  "settings-fixture",
  "synthetic",
  "transcribed",
]);
const ALLOWED_COVERAGE_STATUSES = new Set(["covered", "planned"]);

function fixtureIdsByMatrixId() {
  const index = new Map();

  for (const fixture of TRACE_POLICY_FIXTURES) {
    for (const matrixId of fixture.incidentMatrixIds || []) {
      const fixtureIds = index.get(matrixId) || [];
      fixtureIds.push(fixture.id);
      index.set(matrixId, fixtureIds);
    }
  }

  return index;
}

const ALLOWED_RESEARCH_TARGETS = new Set(["librarian", "repo-scout", "web-scout"]);

test("trace-policy fixtures have stable ids and deterministic expected results", () => {
  const fixtureIds = new Set();

  for (const fixture of TRACE_POLICY_FIXTURES) {
    assert.match(fixture.id, /^[a-z0-9-]+$/);
    assert.equal(fixtureIds.has(fixture.id), false, `duplicate fixture id: ${fixture.id}`);
    fixtureIds.add(fixture.id);
    assert.ok(fixture.name);
    assert.ok(fixture.transcript);
    assert.ok(fixture.expectedResult === "allow" || fixture.expectedResult === "reject");
    assert.equal(fixture.valid, fixture.expectedResult === "allow");

    const expectedResearchTarget = fixture.transcript.metadata?.expectedResearchTarget;
    if (expectedResearchTarget !== undefined) {
      assert.ok(
        ALLOWED_RESEARCH_TARGETS.has(expectedResearchTarget),
        `fixture ${fixture.id} has unsupported expected research target ${expectedResearchTarget}`,
      );
    }
  }
});

test("workflow incident matrix is present and well-formed", () => {
  const matrixIds = TRACE_POLICY_INCIDENT_MATRIX.map((entry) => entry.id);

  assert.deepEqual(matrixIds, REQUIRED_MATRIX_IDS);

  for (const entry of TRACE_POLICY_INCIDENT_MATRIX) {
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert.ok(entry.incident);
    assert.ok(entry.invariant);
    assert.ok(
      ALLOWED_SOURCE_KINDS.has(entry.sourceKind),
      `unsupported source kind for ${entry.id}`,
    );
    assert.ok(entry.coverage);
    assert.ok(
      ALLOWED_COVERAGE_STATUSES.has(entry.coverage.status),
      `unsupported coverage status for ${entry.id}`,
    );

    if (entry.coverage.status === "covered") {
      assert.ok(Array.isArray(entry.coverage.fixtureIds));
      assert.ok(
        entry.coverage.fixtureIds.length > 0,
        `covered entry missing fixtureIds: ${entry.id}`,
      );
      assert.ok(
        typeof entry.coverage.ownerTicket === "string" && entry.coverage.ownerTicket.length > 0,
        `covered entry missing ownerTicket: ${entry.id}`,
      );
      continue;
    }

    assert.equal(
      Array.isArray(entry.coverage.fixtureIds),
      false,
      `planned entry should not declare fixtureIds: ${entry.id}`,
    );
    assert.ok(
      (typeof entry.coverage.ownerTicket === "string" && entry.coverage.ownerTicket.length > 0) ||
        (typeof entry.coverage.owner === "string" && entry.coverage.owner.length > 0),
      `planned entry missing owner or ownerTicket: ${entry.id}`,
    );
  }
});

test("fixture incident metadata resolves to known matrix entries", () => {
  const matrixIds = new Set(TRACE_POLICY_INCIDENT_MATRIX.map((entry) => entry.id));

  for (const fixture of TRACE_POLICY_FIXTURES) {
    for (const matrixId of fixture.incidentMatrixIds || []) {
      assert.ok(
        matrixIds.has(matrixId),
        `fixture ${fixture.id} references unknown matrix id ${matrixId}`,
      );
    }
  }
});

test("covered matrix entries resolve to tagged fixtures", () => {
  const fixturesById = new Map(TRACE_POLICY_FIXTURES.map((fixture) => [fixture.id, fixture]));
  const coverageIndex = fixtureIdsByMatrixId();

  for (const entry of TRACE_POLICY_INCIDENT_MATRIX) {
    if (entry.coverage.status !== "covered") {
      continue;
    }

    assert.deepEqual(
      (entry.coverage.fixtureIds || []).slice().sort(),
      (coverageIndex.get(entry.id) || []).slice().sort(),
      `covered matrix entry mismatch for ${entry.id}`,
    );

    for (const fixtureId of entry.coverage.fixtureIds) {
      assert.ok(
        fixturesById.has(fixtureId),
        `matrix entry ${entry.id} references unknown fixture ${fixtureId}`,
      );
    }
  }
});
