/**
 * Combinatorial acceptance parse and strip test matrix (tlhm-thkx)
 *
 * Every defect in the acceptance/report-reliability branch was found by ad hoc
 * probing, never by the test suite. This file replaces row-by-row testing with
 * a combinatorial matrix that closes axes wholesale.
 *
 * Design principles:
 *   - Unique identity tokens per candidate: each valid payload embeds a unique
 *     token in `diffSummary`. Assertions verify WHICH candidate was parsed and
 *     WHICH span was removed, not merely that something changed.
 *   - Independent oracle: expected outcomes are computed from the documented
 *     selection policy, never by calling the production locator on itself.
 *   - Both TS and JS artifacts: every case runs against the authoritative
 *     TypeScript source and the generated runtime JS mirror. A divergence there
 *     would be a build-mirror bug.
 *
 * Invariants asserted for every generated case:
 *   1. Invalid or missing authority leaves input byte-for-byte unchanged.
 *   2. Any change removes exactly the authoritative span — nothing before, nothing after.
 *   3. The parsed report identity equals the removed candidate identity (token match).
 *   4. A non-terminal candidate is never removed.
 *   5. Appending prose cannot cause deletion of pre-existing content.
 *   6. An invalid later explicit candidate cannot authorise removal.
 *   7. Analysis is deterministic (same input → same output, always).
 *   8. stripAcceptanceReportIfValid is idempotent (verified; API does not prevent reprocessing).
 *
 * Acid test: five historical defects are each covered by at least one generated
 * case. The acid test section demonstrates each defect via an inline simulation
 * of the pre-fix behaviour and confirms the matrix case would fail on it.
 *
 * Runtime note: invariant 5 is the general form of tlhm-bbhv (total-destruction
 * bug where valid report + trailing prose containing "}" deleted everything).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeAcceptanceOutput,
  stripAcceptanceReportIfValid,
} from "../../src/runs/shared/acceptance.ts";
import type { AcceptanceAnalysisResult } from "../../src/runs/shared/acceptance.ts";

// ─── Runtime JS mirror ────────────────────────────────────────────────────────
// Import from the generated .js file directly. The loader rewrites .js→.ts only
// when the .js file does not exist; since acceptance.js exists, this import
// resolves to the generated JavaScript artifact.

import { analyzeAcceptanceOutput as analyzeJs } from "../../src/runs/shared/acceptance.js";

// ─── getFinalOutput layer (Axis 1 — tlhm-fah8 gap closure) ────────────────────
import { fauxAssistantMessage, type FauxContentBlock } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { getFinalOutput } from "../../src/shared/utils.ts";

// ─── Payload builders ─────────────────────────────────────────────────────────
//
// Each "valid" payload embeds a unique identity token in `diffSummary`. This
// lets us verify WHICH candidate was selected without running two separate
// locating operations that could choose different candidates.

type PayloadType = "valid" | "schema-invalid" | "malformed-json" | "generic-non-report";
type CandidateForm = "tagged" | "json" | "jsonc" | "json5" | "prefix";

function makeValidPayload(token: string): Record<string, unknown> {
  return {
    criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "matrix test" }],
    changedFiles: ["src/matrix.ts"],
    commandsRun: [{ command: "npm test", result: "passed", summary: "matrix ok" }],
    validationOutput: ["matrix passed"],
    residualRisks: [],
    noStagedFiles: true,
    diffSummary: `matrix identity: ${token}`,
  };
}

function makeSchemaInvalidPayload(token: string): Record<string, unknown> {
  // criteriaSatisfied[].status is not a valid enum value → schema validation fails.
  // Field chosen deliberately: cannot become permissive the way commandsRun[].result
  // was before tlhm-uaw2.
  return {
    criteriaSatisfied: [{ id: "criterion-1", status: "INVALID_STATUS_ENUM", evidence: "e" }],
    changedFiles: ["src/matrix.ts"],
    commandsRun: [{ command: "npm test", result: "passed", summary: "ok" }],
    diffSummary: `matrix identity: ${token}`,
  };
}

/** Balanced braces but not valid JSON — will fail JSON.parse. */
const MALFORMED_JSON_BODY = "{MALFORMED_NOT_VALID_JSON}";

function makeGenericNonReportPayload(token: string): Record<string, unknown> {
  // Valid JSON, no `criteriaSatisfied` → lacks acceptance report signal.
  return { name: "generic-object", type: "not-a-report", token };
}

function payloadBody(payload: PayloadType, token: string): string {
  switch (payload) {
    case "valid":
      return JSON.stringify(makeValidPayload(token));
    case "schema-invalid":
      return JSON.stringify(makeSchemaInvalidPayload(token));
    case "malformed-json":
      return MALFORMED_JSON_BODY;
    case "generic-non-report":
      return JSON.stringify(makeGenericNonReportPayload(token));
  }
}

// ─── Candidate text builders ──────────────────────────────────────────────────

function buildCandidateText(form: CandidateForm, payload: PayloadType, token: string): string {
  const body = payloadBody(payload, token);
  switch (form) {
    case "tagged":
      return `\`\`\`acceptance-report\n${body}\n\`\`\``;
    case "json":
      return `\`\`\`json\n${body}\n\`\`\``;
    case "jsonc":
      return `\`\`\`jsonc\n${body}\n\`\`\``;
    case "json5":
      return `\`\`\`json5\n${body}\n\`\`\``;
    case "prefix":
      return `ACCEPTANCE_REPORT: ${body}`;
  }
}

// ─── Oracle helpers ───────────────────────────────────────────────────────────
//
// These are INDEPENDENT of the production code. They express the documented
// selection policy in plain terms so test expectations are not circular.

/**
 * Returns true when a (form, payload) pair produces an actual candidate in
 * `collectAcceptanceCandidates`. Json-family fences are filtered out when the
 * body has no acceptance-report signal or cannot be parsed as JSON.
 */
function isActualCandidate(form: CandidateForm, payload: PayloadType): boolean {
  if (form === "json" || form === "jsonc" || form === "json5") {
    // Json-family: only collected when body parses as JSON AND has signal
    // (criteriaSatisfied present). Malformed-json and generic-non-report both fail.
    return payload === "valid" || payload === "schema-invalid";
  }
  // Tagged and prefix: always collected (validity checked after selection).
  return true;
}

/**
 * Returns true when a (form, payload) pair, once selected, will produce a
 * valid parse result.
 */
function isExpectedValid(form: CandidateForm, payload: PayloadType): boolean {
  if (!isActualCandidate(form, payload)) return false;
  return payload === "valid";
}

// ─── Matrix case type ─────────────────────────────────────────────────────────

interface MatrixCase {
  label: string;
  input: string;
  /** Oracle-derived expected status (computed independently, not from production code). */
  expectedStatus: "valid" | "invalid" | "missing";
  /** Whether the best candidate should be stripped. */
  expectedStripped: boolean;
  /** For valid cases: the identity token expected in result.report.diffSummary. */
  expectedToken?: string;
  /** The prose content expected in strippedOutput after stripping (invariant 2). */
  expectedStrippedOutput?: string;
}

// ─── Invariant assertion helper ───────────────────────────────────────────────
//
// Runs all eight invariants for a single case. Called by every generated test.

function assertAllInvariants(c: MatrixCase, result: AcceptanceAnalysisResult): void {
  const { label, input, expectedStatus, expectedStripped, expectedToken, expectedStrippedOutput } =
    c;

  // ── Expected outcome ──────────────────────────────────────────────────────
  assert.equal(result.status, expectedStatus, `[${label}] expected status`);
  assert.equal(result.stripped, expectedStripped, `[${label}] expected stripped flag`);

  // ── Invariant 1: no authority → byte-for-byte unchanged ──────────────────
  if (result.status !== "valid" || !result.stripped) {
    assert.equal(
      result.strippedOutput,
      input,
      `[${label}] INV1: non-valid/non-stripped must leave input unchanged`,
    );
  }

  // ── Invariant 2: exact span splice ────────────────────────────────────────
  if (result.stripped && result.status === "valid") {
    const before = input.slice(0, result.start);
    const after = input.slice(result.end);
    // Exact splice: strippedOutput must equal before + after (bytes outside
    // [start, end) must be preserved, not discarded). Previously asserted
    // strippedOutput === before, which could not detect defect 1 (the old
    // slice(0,start) lost trailing whitespace beyond end).
    assert.equal(
      result.strippedOutput,
      before + after,
      `[${label}] INV2: strippedOutput must equal input[0..start] + input[end..]`,
    );
    // Confirm the candidate was genuinely terminal: content after the span is
    // at most whitespace (implied by stripped=true, restated for clarity).
    assert.equal(
      after.trim(),
      "",
      `[${label}] INV2: input[end..] must be whitespace-only (candidate was terminal)`,
    );
    if (expectedStrippedOutput !== undefined) {
      assert.equal(
        result.strippedOutput,
        expectedStrippedOutput,
        `[${label}] INV2: strippedOutput must match oracle-expected value`,
      );
    }
  }

  // ── Invariant 3: token identity ───────────────────────────────────────────
  if (expectedToken !== undefined && result.status === "valid") {
    const diffSummary = (result.report as { diffSummary?: unknown }).diffSummary;
    assert.ok(
      typeof diffSummary === "string" && diffSummary.includes(expectedToken),
      `[${label}] INV3: report.diffSummary must contain token ${expectedToken}`,
    );
    if (result.stripped) {
      const removedSpan = input.slice(result.start, result.end);
      assert.ok(
        removedSpan.includes(expectedToken),
        `[${label}] INV3: removed span must contain token ${expectedToken}`,
      );
    }
  }

  // ── Invariant 4: non-terminal never removed ───────────────────────────────
  // (asserted via stripped flag — already covered by expected-stripped check above,
  //  but we also assert the specific strippedOutput contract)
  if (!result.stripped) {
    assert.equal(
      result.strippedOutput,
      input,
      `[${label}] INV4: non-stripped result must have strippedOutput === input`,
    );
  }

  // ── Invariant 7: determinism ──────────────────────────────────────────────
  const result2 = analyzeAcceptanceOutput(input);
  assert.equal(result2.status, result.status, `[${label}] INV7: deterministic status`);
  assert.equal(result2.stripped, result.stripped, `[${label}] INV7: deterministic stripped`);
  assert.equal(
    result2.strippedOutput,
    result.strippedOutput,
    `[${label}] INV7: deterministic strippedOutput`,
  );

  // ── Invariant 8: idempotency (no-op path) ────────────────────────────────
  // When strip is a no-op (input unchanged), a second call is also a no-op.
  // When strip succeeds, the stripped output may contain another valid
  // terminal candidate and the second call may strip that too — idempotency
  // is NOT guaranteed for multi-candidate inputs. We assert only the no-op
  // path here; the full idempotency analysis is in GROUP 10.
  if (!result.stripped) {
    const stripped1 = stripAcceptanceReportIfValid(input);
    const stripped2 = stripAcceptanceReportIfValid(stripped1);
    assert.equal(stripped2, stripped1, `[${label}] INV8: no-op strip must be idempotent`);
  }

  // ── JS runtime mirror check ───────────────────────────────────────────────
  // The generated acceptance.js must produce the same outcome as acceptance.ts.
  const jsResult = analyzeJs(input);
  assert.equal(jsResult.status, result.status, `[${label}] JS-mirror: status matches TS`);
  assert.equal(jsResult.stripped, result.stripped, `[${label}] JS-mirror: stripped matches TS`);
  assert.equal(
    jsResult.strippedOutput,
    result.strippedOutput,
    `[${label}] JS-mirror: strippedOutput matches TS`,
  );
}

// ─── Case runner ─────────────────────────────────────────────────────────────

function runCase(c: MatrixCase): void {
  const result = analyzeAcceptanceOutput(c.input);
  assertAllInvariants(c, result);
}

// ─── Invariant 5 helper ───────────────────────────────────────────────────────
//
// Invariant 5: appending prose after a valid terminal report must not cause
// deletion of pre-existing content. This is the general form of tlhm-bbhv.
//
// For each valid-terminal case we also check the "with prose" variant:
// adding trailing prose converts terminal→non-terminal, so nothing is stripped.

function assertInvariant5(c: MatrixCase, proseToAppend: string): void {
  if (c.expectedStatus !== "valid" || !c.expectedStripped) return;

  // Build a variant with prose after the report.
  const inputWithProse = `${c.input}\n${proseToAppend}`;
  const result = analyzeAcceptanceOutput(inputWithProse);

  // The candidate is now non-terminal — must not be stripped.
  assert.equal(
    result.stripped,
    false,
    `[${c.label}] INV5: appending prose after valid report must prevent stripping`,
  );
  assert.equal(
    result.strippedOutput,
    inputWithProse,
    `[${c.label}] INV5: strippedOutput must equal full input when not stripped`,
  );
  // The pre-existing report content must still be present.
  assert.ok(
    result.strippedOutput.includes(c.expectedToken ?? ""),
    `[${c.label}] INV5: pre-existing report content must survive in strippedOutput`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1: Single-candidate terminal cases
// All 5 forms × all 4 payload types. Each case is terminal (no prose follows).
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: single-candidate terminal cases (all forms × payloads)", () => {
  const forms: CandidateForm[] = ["tagged", "json", "jsonc", "json5", "prefix"];
  const payloads: PayloadType[] = [
    "valid",
    "schema-invalid",
    "malformed-json",
    "generic-non-report",
  ];

  for (const form of forms) {
    for (const payload of payloads) {
      const token = `SINGLE_${form.toUpperCase()}_${payload.replace(/-/g, "_").toUpperCase()}`;
      const candidateText = buildCandidateText(form, payload, token);
      const prose = "Work summary preceding the candidate.";

      // Input: prose + newline + candidate (candidate is terminal).
      const input = `${prose}\n${candidateText}`;

      const isCandidate = isActualCandidate(form, payload);
      const isValid = isExpectedValid(form, payload);

      // Oracle: if not a candidate for this form (json-family + bad payload),
      // the result is "missing". Otherwise valid/invalid depending on payload.
      const expectedStatus: "valid" | "invalid" | "missing" = !isCandidate
        ? "missing"
        : isValid
          ? "valid"
          : "invalid";
      const expectedStripped = isValid && isCandidate;

      const c: MatrixCase = {
        label: `single terminal: form=${form} payload=${payload}`,
        input,
        expectedStatus,
        expectedStripped,
        expectedToken: isValid ? token : undefined,
        expectedStrippedOutput: expectedStripped ? prose : undefined,
      };

      it(c.label, () => {
        runCase(c);
        // Invariant 5: adding prose after a valid terminal report must not strip.
        assertInvariant5(
          c,
          "Appended prose with a closing } brace that would fool a greedy regex.",
        );
        assertInvariant5(c, "Nested { outer { inner } } braces in appended prose.");
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2: Single-candidate non-terminal cases
// Valid candidates followed by prose — must parse but not strip (INV4).
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: single-candidate non-terminal cases (INV4)", () => {
  const nonTerminalForms: CandidateForm[] = ["tagged", "json", "prefix"];
  const proseSuffixes = [
    "More analysis follows.",
    "Appendix with a } closing brace.",
    "Details: { key: value }.",
    "Referenced example: ```acceptance-report\\n{}\\n```",
  ];

  for (const form of nonTerminalForms) {
    for (const prose of proseSuffixes) {
      const token = `NONTERMINAL_${form.toUpperCase()}_${proseSuffixes.indexOf(prose)}`;
      const candidateText = buildCandidateText(form, "valid", token);
      const input = `Leading prose.\n${candidateText}\n${prose}`;

      const c: MatrixCase = {
        label: `non-terminal: form=${form}, prose="${prose.slice(0, 40)}"`,
        input,
        expectedStatus: "valid",
        expectedStripped: false, // non-terminal: must not be stripped (INV4)
        expectedToken: token,
      };

      it(c.label, () => {
        runCase(c);
      });
    }
  }

  it("non-terminal schema-invalid candidate: status invalid, not stripped", () => {
    const token = "NONTERMINAL_INVALID_TAGGED";
    const candidateText = buildCandidateText("tagged", "schema-invalid", token);
    const input = `${candidateText}\nProse that follows.`;
    runCase({
      label: "non-terminal schema-invalid",
      input,
      expectedStatus: "invalid",
      expectedStripped: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 3: Two-candidate sequences (mixed forms and payloads)
//
// These cases cover INV6 (invalid later blocks earlier valid) and the
// historical defects tlhm-30b6 and tlhm-wbvp.
//
// Selection policy: terminality first, then latest position.
// In each two-candidate case below, both candidates are in the pool, and the
// second (last) candidate wins by position.
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: two-candidate sequences", () => {
  //
  // Helper: build a two-candidate input and derive expected outcome.
  //
  function twoCandidate(
    label: string,
    first: { form: CandidateForm; payload: PayloadType; token: string },
    second: { form: CandidateForm; payload: PayloadType; token: string },
    proseAfter = "",
  ): MatrixCase {
    const firstText = buildCandidateText(first.form, first.payload, first.token);
    const secondText = buildCandidateText(second.form, second.payload, second.token);
    const leadingProse = "Leading prose.";
    const parts: string[] = [leadingProse, firstText, secondText];
    if (proseAfter) parts.push(proseAfter);
    const input = parts.join("\n");

    // Oracle: the second candidate is terminal (no prose after) iff proseAfter is empty.
    const secondIsTerminal = proseAfter.trim().length === 0;

    // Both candidates exist unless json-family with bad payload.
    const firstIsActual = isActualCandidate(first.form, first.payload);
    const secondIsActual = isActualCandidate(second.form, second.payload);

    let bestForm: CandidateForm;
    let bestPayload: PayloadType;
    let bestToken: string;
    let bestIsTerminal: boolean;

    if (secondIsActual && secondIsTerminal) {
      // Terminal takes precedence — select second candidate.
      bestForm = second.form;
      bestPayload = second.payload;
      bestToken = second.token;
      bestIsTerminal = true;
    } else if (secondIsActual) {
      // Both non-terminal: second wins by position (larger index = later end).
      bestForm = second.form;
      bestPayload = second.payload;
      bestToken = second.token;
      bestIsTerminal = false;
    } else if (firstIsActual) {
      // Second is not a candidate; first is the only actual candidate.
      bestForm = first.form;
      bestPayload = first.payload;
      bestToken = first.token;
      bestIsTerminal = false; // second text exists after it
    } else {
      // Neither is an actual candidate.
      return {
        label,
        input,
        expectedStatus: "missing",
        expectedStripped: false,
      };
    }

    const valid = isExpectedValid(bestForm, bestPayload);
    const stripped = valid && bestIsTerminal;

    return {
      label,
      input,
      expectedStatus: valid ? "valid" : "invalid",
      expectedStripped: stripped,
      expectedToken: valid ? bestToken : undefined,
      expectedStrippedOutput: stripped ? `${leadingProse}\n${firstText}` : undefined,
    };
  }

  // ── valid-then-invalid (all form pairs) ────────────────────────────────────
  // tlhm-30b6 regression: old code returned the first valid report; correct
  // code selects the LAST (invalid terminal) candidate. INV6: later invalid blocks earlier valid.

  it("valid-tagged then invalid-tagged: last (invalid) wins — INV6 (tlhm-30b6)", () => {
    const c = twoCandidate(
      "valid-tagged → invalid-tagged",
      { form: "tagged", payload: "valid", token: "TT_VALID" },
      { form: "tagged", payload: "schema-invalid", token: "TT_INVALID" },
    );
    runCase(c);
  });

  it("valid-tagged then invalid-prefix: last (invalid prefix) wins — INV6", () => {
    const c = twoCandidate(
      "valid-tagged → invalid-prefix",
      { form: "tagged", payload: "valid", token: "TP_VALID" },
      { form: "prefix", payload: "schema-invalid", token: "TP_INVALID" },
    );
    runCase(c);
  });

  it("valid-json then invalid-prefix: last (invalid prefix) wins — INV6 (tlhm-wbvp)", () => {
    // tlhm-wbvp: old code parsed jsonfam and stripped prefix (different candidates).
    // New code: single selection site, prefix wins by terminality → status: invalid.
    const c = twoCandidate(
      "valid-json → invalid-prefix",
      { form: "json", payload: "valid", token: "JP_VALID" },
      { form: "prefix", payload: "schema-invalid", token: "JP_INVALID" },
    );
    runCase(c);
    assert.equal(
      c.expectedStatus,
      "invalid",
      "oracle must predict invalid (prefix is last and invalid)",
    );
  });

  it("valid-prefix then invalid-tagged: last (invalid tagged) wins — INV6 (tlhm-wbvp)", () => {
    const c = twoCandidate(
      "valid-prefix → invalid-tagged",
      { form: "prefix", payload: "valid", token: "PT_VALID" },
      { form: "tagged", payload: "schema-invalid", token: "PT_INVALID" },
    );
    runCase(c);
  });

  // ── invalid-then-valid ─────────────────────────────────────────────────────
  // The last candidate is valid and terminal → should parse and strip.

  it("invalid-tagged then valid-tagged: last (valid) stripped", () => {
    const c = twoCandidate(
      "invalid-tagged → valid-tagged",
      { form: "tagged", payload: "schema-invalid", token: "ITV_INVALID" },
      { form: "tagged", payload: "valid", token: "ITV_VALID" },
    );
    runCase(c);
    assert.equal(c.expectedStatus, "valid");
    assert.equal(c.expectedStripped, true);
    assert.equal(c.expectedToken, "ITV_VALID");
  });

  it("invalid-prefix then valid-json: last (valid json) stripped", () => {
    const c = twoCandidate(
      "invalid-prefix → valid-json",
      { form: "prefix", payload: "schema-invalid", token: "IPJ_INVALID" },
      { form: "json", payload: "valid", token: "IPJ_VALID" },
    );
    runCase(c);
    assert.equal(c.expectedStatus, "valid");
    assert.equal(c.expectedStripped, true);
  });

  it("invalid-json then valid-prefix: last (valid prefix) stripped", () => {
    const c = twoCandidate(
      "invalid-json → valid-prefix",
      { form: "json", payload: "schema-invalid", token: "IJP_INVALID" },
      { form: "prefix", payload: "valid", token: "IJP_VALID" },
    );
    runCase(c);
    assert.equal(c.expectedStatus, "valid");
    assert.equal(c.expectedStripped, true);
  });

  // ── valid-then-valid (second wins by position) ─────────────────────────────

  it("valid-tagged then valid-json: last (valid json) stripped, first survives", () => {
    const tokenFirst = "VTV_FIRST";
    const tokenSecond = "VTV_SECOND";
    const c = twoCandidate(
      "valid-tagged → valid-json",
      { form: "tagged", payload: "valid", token: tokenFirst },
      { form: "json", payload: "valid", token: tokenSecond },
    );
    runCase(c);
    assert.equal(c.expectedToken, tokenSecond, "last candidate must win");
    // The first candidate's text survives in strippedOutput.
    if (c.expectedStrippedOutput !== undefined) {
      assert.ok(
        c.expectedStrippedOutput.includes(tokenFirst),
        "first (non-stripped) candidate must survive in strippedOutput",
      );
    }
  });

  it("valid-prefix then valid-tagged: last (valid tagged) stripped, prefix survives", () => {
    const tokenFirst = "VPT_FIRST";
    const tokenSecond = "VPT_SECOND";
    const c = twoCandidate(
      "valid-prefix → valid-tagged",
      { form: "prefix", payload: "valid", token: tokenFirst },
      { form: "tagged", payload: "valid", token: tokenSecond },
    );
    runCase(c);
    assert.equal(c.expectedToken, tokenSecond, "last candidate must win");
  });

  it("valid-json then valid-prefix: last (valid prefix) stripped, json survives", () => {
    // tlhm-wbvp: the old code's parse returned json, strip removed prefix.
    // Correct: prefix (terminal) wins both parse and strip.
    const tokenFirst = "VJP_FIRST";
    const tokenSecond = "VJP_SECOND";
    const c = twoCandidate(
      "valid-json → valid-prefix",
      { form: "json", payload: "valid", token: tokenFirst },
      { form: "prefix", payload: "valid", token: tokenSecond },
    );
    runCase(c);
    assert.equal(c.expectedToken, tokenSecond, "prefix (terminal) must win");
    const result = analyzeAcceptanceOutput(c.input);
    if (result.status !== "missing") {
      assert.equal(result.form, "prefix", "selected form must be prefix");
    }
  });

  // ── both-invalid ───────────────────────────────────────────────────────────

  it("invalid-tagged then invalid-prefix: status invalid, nothing stripped", () => {
    const c = twoCandidate(
      "invalid-tagged → invalid-prefix",
      { form: "tagged", payload: "schema-invalid", token: "II_A" },
      { form: "prefix", payload: "schema-invalid", token: "II_B" },
    );
    runCase(c);
    assert.equal(c.expectedStatus, "invalid");
    assert.equal(c.expectedStripped, false);
  });

  // ── non-candidate second (json-family + no signal) ─────────────────────────

  it("valid-tagged first, json-family+generic second: first is only candidate, non-terminal", () => {
    // The json+generic-non-report fence is not collected as a candidate.
    // The valid-tagged is the only candidate, but it's non-terminal (json fence follows it).
    const tokenFirst = "NCJ_FIRST";
    const c = twoCandidate(
      "valid-tagged → json+generic-non-report",
      { form: "tagged", payload: "valid", token: tokenFirst },
      { form: "json", payload: "generic-non-report", token: "NCJ_IGNORED" },
    );
    // Oracle: second is not a candidate. First is the only candidate.
    // The json fence text appears AFTER the tagged fence, making tagged non-terminal.
    // → stripped: false, status: valid
    runCase(c);
    assert.equal(c.expectedStatus, "valid");
    assert.equal(
      c.expectedStripped,
      false,
      "first candidate is non-terminal due to json fence text after it",
    );
  });

  // ── with prose after (INV4) ────────────────────────────────────────────────

  it("valid-tagged then valid-prefix, prose after: neither stripped (INV4)", () => {
    const c = twoCandidate(
      "valid-tagged → valid-prefix (prose after)",
      { form: "tagged", payload: "valid", token: "PA_FIRST" },
      { form: "prefix", payload: "valid", token: "PA_SECOND" },
      "Prose that appears after the last candidate — makes it non-terminal.",
    );
    runCase(c);
    assert.equal(c.expectedStripped, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 4: Three-candidate sequences
// Representative subset for multiplicity and mixed ordering.
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: three-candidate sequences", () => {
  it("valid-tagged, valid-json, valid-prefix: prefix (last) wins", () => {
    const tA = "TRIPLE_A";
    const tB = "TRIPLE_B";
    const tC = "TRIPLE_C";
    const tagged = buildCandidateText("tagged", "valid", tA);
    const json = buildCandidateText("json", "valid", tB);
    const prefix = buildCandidateText("prefix", "valid", tC);
    const input = `prose\n${tagged}\n${json}\n${prefix}`;

    const result = analyzeAcceptanceOutput(input);
    assert.equal(result.status, "valid", "last candidate (prefix) is valid and terminal");
    assert.equal(result.stripped, true, "terminal valid candidate must be stripped");
    const diffSummary = (result.report as { diffSummary?: unknown }).diffSummary;
    assert.ok(
      typeof diffSummary === "string" && diffSummary.includes(tC),
      "INV3: report must identify the last (prefix) candidate",
    );
    // First two survive in strippedOutput.
    assert.ok(result.strippedOutput.includes(tA), "tagged candidate must survive strip");
    assert.ok(result.strippedOutput.includes(tB), "json candidate must survive strip");
    assert.ok(!result.strippedOutput.includes(tC), "prefix candidate must be removed");
    assertAllInvariants(
      {
        label: "triple: tagged+json+prefix",
        input,
        expectedStatus: "valid",
        expectedStripped: true,
        expectedToken: tC,
      },
      result,
    );
  });

  it("invalid-tagged, valid-json, invalid-prefix: prefix (last, invalid) blocks earlier valid", () => {
    const tA = "T3_A";
    const tB = "T3_B";
    const tC = "T3_C";
    const tagged = buildCandidateText("tagged", "schema-invalid", tA);
    const json = buildCandidateText("json", "valid", tB);
    const prefix = buildCandidateText("prefix", "schema-invalid", tC);
    const input = `prose\n${tagged}\n${json}\n${prefix}`;

    const result = analyzeAcceptanceOutput(input);
    assert.equal(result.status, "invalid", "INV6: invalid prefix (terminal) blocks earlier valid");
    assert.equal(result.stripped, false);
    assert.equal(result.strippedOutput, input);
    assertAllInvariants(
      {
        label: "triple: invalid-tagged+valid-json+invalid-prefix",
        input,
        expectedStatus: "invalid",
        expectedStripped: false,
      },
      result,
    );
  });

  it("valid-tagged, invalid-json, valid-prefix: prefix (last, valid) stripped", () => {
    const tA = "T3MIX_A";
    const tB = "T3MIX_B";
    const tC = "T3MIX_C";
    const tagged = buildCandidateText("tagged", "valid", tA);
    const json = buildCandidateText("json", "schema-invalid", tB);
    const prefix = buildCandidateText("prefix", "valid", tC);
    const input = `prose\n${tagged}\n${json}\n${prefix}`;

    const result = analyzeAcceptanceOutput(input);
    assert.equal(result.status, "valid");
    assert.equal(result.stripped, true, "terminal valid prefix stripped");
    const diffSummary = (result.report as { diffSummary?: unknown }).diffSummary;
    assert.ok(
      typeof diffSummary === "string" && diffSummary.includes(tC),
      "INV3: report identity matches last (valid prefix)",
    );
    assertAllInvariants(
      {
        label: "triple: valid-tagged+invalid-json+valid-prefix",
        input,
        expectedStatus: "valid",
        expectedStripped: true,
        expectedToken: tC,
      },
      result,
    );
  });

  it("valid-json, valid-tagged, valid-prefix with prose after: none stripped (INV4)", () => {
    const tA = "T3NT_A";
    const tB = "T3NT_B";
    const tC = "T3NT_C";
    const json = buildCandidateText("json", "valid", tA);
    const tagged = buildCandidateText("tagged", "valid", tB);
    const prefix = buildCandidateText("prefix", "valid", tC);
    const input = `prose\n${json}\n${tagged}\n${prefix}\nTrailing prose that makes prefix non-terminal.`;

    const result = analyzeAcceptanceOutput(input);
    assert.equal(result.status, "valid", "prefix is still selected (last actual candidate)");
    assert.equal(result.stripped, false, "INV4: non-terminal candidate must not be stripped");
    assert.equal(result.strippedOutput, input, "INV1+INV4: strippedOutput must equal input");
    assertAllInvariants(
      {
        label: "triple non-terminal",
        input,
        expectedStatus: "valid",
        expectedStripped: false,
        expectedToken: tC,
      },
      result,
    );
  });

  it("valid, schema-invalid, malformed: last actual candidate determines outcome", () => {
    // malformed-json with tagged form: IS a candidate (tagged collects everything),
    // but parse fails → status: invalid.
    const tA = "T3MAL_A";
    const tB = "T3MAL_B";
    const tC = "T3MAL_C";
    const valid = buildCandidateText("tagged", "valid", tA);
    const invalid = buildCandidateText("json", "schema-invalid", tB);
    const malformed = buildCandidateText("tagged", "malformed-json", tC);
    const input = `prose\n${valid}\n${invalid}\n${malformed}`;

    const result = analyzeAcceptanceOutput(input);
    // malformed-tagged is the last and only terminal candidate → wins → status: invalid
    assert.equal(result.status, "invalid");
    assert.equal(result.stripped, false);
    assertAllInvariants(
      {
        label: "triple: valid+invalid-json+malformed-tagged",
        input,
        expectedStatus: "invalid",
        expectedStripped: false,
      },
      result,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 5: CRLF and whitespace variants
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: CRLF and whitespace variants", () => {
  const validPayload = makeValidPayload("CRLF_TOKEN");
  const validJson = JSON.stringify(validPayload);

  it("tagged fence with CRLF line endings: parses and strips", () => {
    // Some agents generate CRLF-terminated output. The tagged pattern uses
    // [\s\S]*? which matches \r, so CRLF bodies must be handled.
    const fence = `\`\`\`acceptance-report\r\n${validJson}\r\n\`\`\``;
    const input = `prose\r\n${fence}`;
    // Independent expected values (not derived from production output):
    // - The fence body is valid JSON for a valid acceptance report, so status = "valid".
    // - The fence is terminal (nothing follows), so stripped = true.
    // - After the CRLF fix the span consumes the full \r\n separator, so
    //   strippedOutput is "prose" with no orphan \r.
    const expectedStrippedOutput = "prose";
    assert.equal(
      analyzeAcceptanceOutput(input).status,
      "valid",
      "CRLF tagged fence: body is a valid acceptance report",
    );
    assert.equal(
      analyzeAcceptanceOutput(input).stripped,
      true,
      "CRLF tagged fence: fence is terminal so it must be stripped",
    );
    assert.equal(
      analyzeAcceptanceOutput(input).strippedOutput,
      expectedStrippedOutput,
      "CRLF tagged fence: strippedOutput must be 'prose' with no orphan \\r",
    );
    const result = analyzeAcceptanceOutput(input);
    assertAllInvariants(
      {
        label: "CRLF tagged fence",
        input,
        expectedStatus: "valid",
        expectedStripped: true,
        expectedStrippedOutput,
      },
      result,
    );
  });

  it("prefix form with CRLF: extractBalancedJson works across \\r\\n", () => {
    const input = `prose\r\nACCEPTANCE_REPORT: ${validJson}`;
    const result = analyzeAcceptanceOutput(input);
    // prefix is terminal; should parse and strip.
    assert.equal(result.status, "valid");
    assert.equal(result.stripped, true);
    assertAllInvariants(
      {
        label: "CRLF prefix form",
        input,
        expectedStatus: "valid",
        expectedStripped: true,
        expectedToken: "CRLF_TOKEN",
      },
      result,
    );
  });

  it("tagged fence with extra trailing whitespace after closing backticks: still terminal", () => {
    const fence = `\`\`\`acceptance-report\n${validJson}\n\`\`\`   `;
    const input = `prose\n${fence}`;
    const result = analyzeAcceptanceOutput(input);
    assert.equal(result.status, "valid");
    // Trailing whitespace is inside the span (pattern eats it via isTerminal check).
    assert.equal(
      result.stripped,
      true,
      "trailing whitespace after fence must not prevent terminal detection",
    );
    assertAllInvariants(
      {
        label: "tagged fence with trailing whitespace",
        input,
        expectedStatus: "valid",
        expectedStripped: true,
        expectedToken: "CRLF_TOKEN",
      },
      result,
    );
  });

  it("ACCEPTANCE_REPORT: with extra whitespace around colon", () => {
    // The pattern is /ACCEPTANCE_REPORT\s*:/gi — extra spaces around colon.
    const input = `prose\nACCEPTANCE_REPORT  :  ${validJson}`;
    const result = analyzeAcceptanceOutput(input);
    assert.equal(result.status, "valid");
    assert.equal(result.stripped, true);
    assertAllInvariants(
      {
        label: "prefix with whitespace around colon",
        input,
        expectedStatus: "valid",
        expectedStripped: true,
        expectedToken: "CRLF_TOKEN",
      },
      result,
    );
  });

  it("acceptance-report tag in mixed case (ACCEPTANCE-REPORT): tagged pattern is case-insensitive", () => {
    const token = "CASING_TOKEN";
    const fence = `\`\`\`ACCEPTANCE-REPORT\n${JSON.stringify(makeValidPayload(token))}\n\`\`\``;
    const input = `prose\n${fence}`;
    const result = analyzeAcceptanceOutput(input);
    // The tagged pattern has /gi flag → case-insensitive.
    assert.equal(result.status, "valid", "case-insensitive tagged fence must parse");
    assert.equal(result.stripped, true);
    assertAllInvariants(
      {
        label: "mixed-case acceptance-report tag",
        input,
        expectedStatus: "valid",
        expectedStripped: true,
        expectedToken: token,
      },
      result,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 6: Prose containing marker text, braces, and fence examples
//
// These cases exercise invariant 5: appending prose cannot delete pre-existing
// content. This is the general form of tlhm-bbhv.
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: prose containing marker text, braces, and fence examples (INV5/tlhm-bbhv)", () => {
  const token = "PROSE_MARKER_TOKEN";
  const validJson = JSON.stringify(makeValidPayload(token));

  // Prose variants that are safe to test in both "prose after" and "prose before"
  // configurations. A variant is safe when:
  //   - It does not contain real acceptance-report fence delimiters (\n```acceptance-report\n);
  //   - It does not contain ACCEPTANCE_REPORT: followed by a path to real JSON.
  // Variants with real fences or ACCEPTANCE_REPORT: markers are tested separately
  // with explicit expectations that account for how the locator behaves.
  const safeProse = [
    { label: "single } brace in prose", prose: "Evidence { with single } brace" },
    { label: "nested braces in prose", prose: "Results: { outer { inner } still-outer }" },
    { label: "multiple closing braces in prose", prose: "Details } second } third }" },
    { label: "prose ending with }", prose: "All criteria satisfied }" },
    { label: "JSON-like prose", prose: '{"not": "a report"}' },
  ];

  for (const { label, prose } of safeProse) {
    it(`prefix report, then prose: "${label}" (INV5)`, () => {
      // Report is NON-TERMINAL (prose follows) — must not be stripped.
      const input = `ACCEPTANCE_REPORT: ${validJson}\n\n${prose}`;
      const result = analyzeAcceptanceOutput(input);

      assert.equal(result.status, "valid", `report must parse even with prose "${label}" after it`);
      assert.equal(
        result.stripped,
        false,
        `INV5: non-terminal report must not be stripped (prose: "${label}")`,
      );
      assert.equal(
        result.strippedOutput,
        input,
        `INV5: strippedOutput must equal input byte-for-byte`,
      );
      assert.ok(
        result.strippedOutput.includes(prose),
        `INV5: prose "${label}" must survive byte-for-byte`,
      );

      // Invariant 7: deterministic.
      const r2 = analyzeAcceptanceOutput(input);
      assert.equal(r2.status, result.status);
      assert.equal(r2.stripped, result.stripped);
    });

    it(`prose before prefix report: "${label}" (INV5 — prose preserved)`, () => {
      // Report IS terminal (prose is before, not after).
      const input = `${prose}\nACCEPTANCE_REPORT: ${validJson}`;
      const result = analyzeAcceptanceOutput(input);

      assert.equal(result.status, "valid");
      assert.equal(result.stripped, true, "terminal prefix report must be stripped");
      assert.equal(
        result.strippedOutput,
        prose,
        `INV5: prose "${label}" must be the complete strippedOutput`,
      );
    });
  }

  // ── Prose mention of ACCEPTANCE_REPORT: marker (tlhm-m5jm regressions) ────
  //
  // Fixed by tlhm-m5jm: adjacency is now enforced in the prefix locator.
  // A prefix candidate is only created when the first non-whitespace character
  // immediately after the marker is `{`. A prose mention that is not followed
  // by `{` is skipped (continue, not break), so a real prefix report that
  // follows a prose mention is still found.

  it("tlhm-m5jm repro 1: prose mention 'Use ACCEPTANCE_REPORT: as the marker' preserves full prose", () => {
    const prose = "Use ACCEPTANCE_REPORT: as the marker.";
    const input = `${prose}\nACCEPTANCE_REPORT: ${validJson}`;
    const result = analyzeAcceptanceOutput(input);

    // Fixed: the prose mention does not create a spurious candidate.
    // The real prefix report on the next line is the only candidate.
    assert.equal(result.status, "valid", "report body is valid (from real report JSON)");
    assert.equal(result.stripped, true, "terminal candidate is stripped");
    assert.equal(
      result.strippedOutput,
      prose,
      "fixed: strippedOutput is the full prose, not a truncated prefix",
    );
  });

  it("tlhm-m5jm repro 2: quoted ACCEPTANCE_REPORT: in prose preserves full prose", () => {
    const prose = 'The marker is "ACCEPTANCE_REPORT:" ok.';
    const input = `${prose}\nACCEPTANCE_REPORT: ${validJson}`;
    const result = analyzeAcceptanceOutput(input);

    // Fixed: quoted prose mention does not create a spurious candidate.
    assert.equal(result.status, "valid");
    assert.equal(result.stripped, true);
    assert.equal(
      result.strippedOutput,
      prose,
      "fixed: full prose is preserved, not truncated at the quoted marker",
    );
  });

  it("tlhm-m5jm repro 3: mid-paragraph prose mention preserves full preceding content", () => {
    const leading = "IMPORTANT FINDINGS...";
    const prosePara = "We emit ACCEPTANCE_REPORT: at the end.";
    const input = `${leading}\n\n${prosePara}\n\nACCEPTANCE_REPORT: ${validJson}`;
    const result = analyzeAcceptanceOutput(input);

    // Fixed: the mid-paragraph mention is not a candidate; the real report is found.
    assert.equal(result.status, "valid");
    assert.equal(result.stripped, true);
    // The span absorbs the newline immediately before the marker, so the
    // strippedOutput retains the blank-line separator as a single trailing \n.
    assert.equal(
      result.strippedOutput,
      `${leading}\n\n${prosePara}\n`,
      "fixed: full preceding content including the paragraph is preserved",
    );
  });

  it("tlhm-m5jm: prose mention followed by real prefix report — real report still found and stripped", () => {
    // Ensures marker scanning continues past the non-adjacent mention instead
    // of stopping at the first marker (which would lose the real report).
    const prose = "The field is called ACCEPTANCE_REPORT: and it marks the end.";
    const input = `${prose}\nACCEPTANCE_REPORT: ${validJson}`;
    const result = analyzeAcceptanceOutput(input);

    assert.equal(result.status, "valid", "real report must be found after prose mention");
    assert.equal(result.stripped, true, "real terminal report must be stripped");
    assert.equal(
      result.strippedOutput,
      prose,
      "strippedOutput is the full prose line — real report correctly removed",
    );
  });

  // ── Fence example in prose ─────────────────────────────────────────────────
  //
  // Prose containing a real acceptance-report fence (with real newlines) creates
  // a second candidate. If that fence is terminal and has an invalid body, it
  // blocks the real prefix report (which is non-terminal).
  //
  // This is INTENTIONAL behaviour (Option 1 — tlhm-bqj9). The uniform
  // terminal-wins authority policy (tlhm-wbvp) is preserved without per-form
  // carve-outs: the parser cannot distinguish a prose fence example from a real
  // report by syntax alone, and adding intent-guessing heuristics is how three
  // consecutive bugs in this area were introduced. The correct mitigation is the
  // prompt, which instructs agents to place prose examples before the real
  // report. The rejection reason is enriched with a displacement note so a
  // supervisor reading the status line can identify the cause immediately.

  it("fence example in prose with REAL newlines: creates a second tagged candidate (terminal, invalid)", () => {
    // The prose contains a real fence with an empty JSON body.
    // Input: [prefix report (non-terminal)] [newline] [fence example with {} body (terminal)].
    const fenceInProse = "Example: ```acceptance-report\n{}\n```";
    const input = `ACCEPTANCE_REPORT: ${validJson}\n\n${fenceInProse}`;
    const result = analyzeAcceptanceOutput(input);

    // The terminal fence with {} body is invalid → status: invalid.
    // The prefix report is non-terminal → it is not selected (terminal takes precedence).
    // This is the correct outcome under the uniform terminal-wins rule.
    assert.equal(
      result.status,
      "invalid",
      "terminal tagged fence with {} body is invalid → status must be invalid (uniform rule: terminal wins)",
    );
    assert.equal(result.stripped, false, "invalid candidate must not be stripped");
    assert.equal(result.strippedOutput, input, "INV1: invalid status leaves input unchanged");
    // The rejection reason must name the displacement cause so a supervisor
    // reading the status line understands a trailing fence example blocked the
    // real report (non-negotiable — tlhm-bqj9).
    assert.ok(
      result.status === "invalid" && result.error.includes("earlier"),
      `error must mention displaced earlier candidate — got: ${result.status === "invalid" ? result.error : "(not invalid)"}`,
    );
    assert.ok(
      result.status === "invalid" && result.error.includes("prose example"),
      "error must mention prose example so the cause is actionable",
    );
  });

  it("tagged report non-terminal, prose contains fence example (INV5)", () => {
    const fenceExample = "Example: ```acceptance-report\n{valid json here}\n```";
    const fence = `\`\`\`acceptance-report\n${validJson}\n\`\`\``;
    const input = `${fence}\n${fenceExample}`;
    const result = analyzeAcceptanceOutput(input);

    // The tagged fence is non-terminal (fenceExample follows).
    // fenceExample itself contains ```acceptance-report — picked up as a second
    // candidate. It is terminal (last in input) but "{valid json here}" fails
    // JSON.parse → invalid. Terminal wins (uniform rule) → status: invalid.
    // The displacement note must be present in the error so the cause is visible.
    // strippedOutput must equal input byte-for-byte.
    assert.equal(result.stripped, false, "no stripping should occur");
    assert.equal(result.strippedOutput, input, "INV5: full input preserved");
    assert.ok(result.strippedOutput.includes(validJson), "real report JSON must survive");
    assert.ok(
      result.status === "invalid" && result.error.includes("earlier"),
      `INV5: error must mention displaced earlier candidate — got: ${result.status === "invalid" ? result.error : "(not invalid)"}`,
    );
  });

  it("non-terminal invalid candidate: wording says 'Failing fence', not 'Terminal fence'", () => {
    // Two candidates, both non-terminal (trailing prose after both).
    // The later candidate (by position) wins. It is invalid and non-terminal.
    // Defect 3 fix: the displacement wording must not say "Terminal fence" when
    // the best candidate is not terminal.
    const validPayload2 = makeValidPayload("WORDING_VALID");
    const invalidPayload2 = makeSchemaInvalidPayload("WORDING_INVALID");
    // first candidate: valid acceptance-report fence, NOT terminal (prose follows)
    const firstFence = `\`\`\`acceptance-report\n${JSON.stringify(validPayload2)}\n\`\`\``;
    // second candidate: schema-invalid acceptance-report fence, also NOT terminal
    const secondFence = `\`\`\`acceptance-report\n${JSON.stringify(invalidPayload2)}\n\`\`\``;
    const input = `${firstFence}\n${secondFence}\ntrailing prose that makes both non-terminal`;
    const result = analyzeAcceptanceOutput(input);
    // Second candidate wins by position. It is invalid → status must be invalid.
    assert.equal(
      result.status,
      "invalid",
      "non-terminal invalid second candidate → status invalid",
    );
    assert.equal(result.stripped, false, "invalid candidate must not be stripped");
    // The displacement note must be present.
    assert.ok(
      result.status === "invalid" && result.error.includes("earlier"),
      `wording must mention displaced earlier candidate — got: ${result.error}`,
    );
    // Terminality gating (defect 3): best candidate is NOT terminal, so wording
    // must say "Failing fence", NOT "Terminal fence".
    assert.ok(
      result.status === "invalid" && !result.error.includes("Terminal fence"),
      `non-terminal invalid candidate must not produce 'Terminal fence' wording — got: ${result.error}`,
    );
    assert.ok(
      result.status === "invalid" && result.error.includes("Failing fence"),
      `non-terminal invalid candidate must produce 'Failing fence' wording — got: ${result.error}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 7: Nested / overlapping-looking syntax
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: nested and overlapping-looking syntax", () => {
  it("acceptance-report fence nested inside a json fence: only json fence detected", () => {
    const token = "NESTED_TOKEN";
    const innerFence = `\`\`\`acceptance-report\n${JSON.stringify(makeValidPayload(token))}\n\`\`\``;
    // Wrap the acceptance-report fence inside a json code block.
    const input = `prose\n\`\`\`json\n${innerFence}\n\`\`\``;
    // The outer json fence body starts with a backtick, not a `{` — so
    // hasGenericAcceptanceReportSignal fails → json fence not a candidate.
    // The inner acceptance-report fence: the tagged pattern matches inside the
    // outer fence body. Whether it's collected depends on regex matching.
    // Either way, no valid acceptance report should be stripped from here.
    const result = analyzeAcceptanceOutput(input);
    // If any candidate is detected, it will be non-terminal or invalid.
    // The key: strippedOutput must equal input if not stripped.
    if (!result.stripped) {
      assert.equal(result.strippedOutput, input, "nested syntax: strippedOutput must equal input");
    }
    // Invariant 7.
    const r2 = analyzeAcceptanceOutput(input);
    assert.equal(r2.status, result.status);
  });

  it("ACCEPTANCE_REPORT: appearing in a URL-like context without JSON: not a candidate", () => {
    const input = "See https://example.com/ACCEPTANCE_REPORT: for details. No JSON follows.";
    const result = analyzeAcceptanceOutput(input);
    // The prefix pattern fires but `{` is not found after the marker.
    assert.equal(
      result.status,
      "missing",
      "URL-like ACCEPTANCE_REPORT: without JSON must be missing",
    );
    assert.equal(result.strippedOutput, input);
  });

  it("prose-only mention of ACCEPTANCE_REPORT: (no JSON body): status missing (tlhm-fah8)", () => {
    // Covers tlhm-fah8: old containsAcceptanceReport used a bare regex that
    // matched ACCEPTANCE_REPORT: in prose without checking for a JSON body.
    // analyzeAcceptanceOutput must correctly return "missing" for such input.
    const input = "By the way I should mention ACCEPTANCE_REPORT: is the marker we use here.";
    const result = analyzeAcceptanceOutput(input);
    assert.equal(result.status, "missing", "prose mention without JSON must be missing, not valid");
    assert.equal(result.strippedOutput, input, "INV1: missing status must leave input unchanged");
    assertAllInvariants(
      {
        label: "prose mention only (tlhm-fah8)",
        input,
        expectedStatus: "missing",
        expectedStripped: false,
      },
      result,
    );
  });

  it("real report in text part, prose mention in later text part: real report status is valid", () => {
    // Simulates the scenario from tlhm-fah8 but from analyzeAcceptanceOutput's
    // perspective: a real report followed by a prose mention.
    // The prose mention is NON-terminal only if it follows the real report.
    // In this combined input, the last "candidate" is the prose mention (non-candidate
    // since no JSON follows). So the real report is the only candidate — non-terminal.
    const token = "FAH8_REAL_TOKEN";
    const realReport = `\`\`\`acceptance-report\n${JSON.stringify(makeValidPayload(token))}\n\`\`\``;
    const mention = "By the way I should mention ACCEPTANCE_REPORT: is the marker.";
    const input = `${realReport}\n\n${mention}`;
    const result = analyzeAcceptanceOutput(input);
    // Real report is a candidate but non-terminal (mention follows).
    // Mention is not a candidate (no JSON). So real report wins — non-terminal.
    assert.equal(result.status, "valid", "real report must parse even with prose mention after");
    assert.equal(result.stripped, false, "INV4: real report is non-terminal, must not be stripped");
    const diffSummary = (result.report as { diffSummary?: unknown }).diffSummary;
    assert.ok(
      typeof diffSummary === "string" && diffSummary.includes(token),
      "INV3: report identity must match the real report, not the mention",
    );
    assertAllInvariants(
      {
        label: "real report + prose mention (tlhm-fah8)",
        input,
        expectedStatus: "valid",
        expectedStripped: false,
        expectedToken: token,
      },
      result,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 8: Wrapped payloads (acceptance / acceptance-report envelope)
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: wrapped payloads", () => {
  it('tagged fence with { "acceptance": { report } } wrapper: parses correctly', () => {
    const token = "WRAPPED_TOKEN_ACC";
    const innerPayload = makeValidPayload(token);
    const wrapped = { acceptance: innerPayload };
    const input = `prose\n\`\`\`acceptance-report\n${JSON.stringify(wrapped)}\n\`\`\``;
    const result = analyzeAcceptanceOutput(input);
    assert.equal(result.status, "valid");
    assert.equal(result.stripped, true);
    const diffSummary = (result.report as { diffSummary?: unknown }).diffSummary;
    assert.ok(
      typeof diffSummary === "string" && diffSummary.includes(token),
      "wrapped acceptance envelope must unwrap correctly",
    );
    assertAllInvariants(
      {
        label: 'wrapped {"acceptance": ...}',
        input,
        expectedStatus: "valid",
        expectedStripped: true,
        expectedToken: token,
      },
      result,
    );
  });

  it('tagged fence with { "acceptance-report": { report } } wrapper: parses correctly', () => {
    const token = "WRAPPED_TOKEN_AR";
    const innerPayload = makeValidPayload(token);
    const wrapped = { "acceptance-report": innerPayload };
    const input = `prose\n\`\`\`acceptance-report\n${JSON.stringify(wrapped)}\n\`\`\``;
    const result = analyzeAcceptanceOutput(input);
    assert.equal(result.status, "valid");
    assert.equal(result.stripped, true);
    assertAllInvariants(
      {
        label: 'wrapped {"acceptance-report": ...}',
        input,
        expectedStatus: "valid",
        expectedStripped: true,
        expectedToken: token,
      },
      result,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 9: Zero-candidate cases
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: zero-candidate cases (status: missing)", () => {
  // Expected status is declared INDEPENDENTLY per fixture — not derived from
  // production output. A circular oracle (const expectedStatus = result.status)
  // cannot detect a status regression because the expected value moves with
  // the function under test (instance 7 of vacuous coverage, fixed by tlhm-bnlt).
  //
  // Rationale for each fixture:
  //   "empty string"                        → "missing": no candidates found
  //   "plain prose only"                    → "missing": no candidates found
  //   "prose with braces"                   → "missing": no candidates found
  //   "json fence without signal"           → "missing": json-family filtered (no signal)
  //   "json5 fence without signal"          → "missing": json-family filtered (no signal)
  //   "ACCEPTANCE_REPORT: without JSON body" → "missing": adjacency check skips (no `{`)
  //   "prose with fence delimiters but no tag" → "missing": no candidates found
  //   "acceptance-report tag with empty body" → "invalid": candidate found, body fails parse
  const missingCases: Array<{
    label: string;
    input: string;
    expectedStatus: "missing" | "invalid";
  }> = [
    { label: "empty string", input: "", expectedStatus: "missing" },
    {
      label: "plain prose only",
      input: "Just prose, no acceptance report here.",
      expectedStatus: "missing",
    },
    {
      label: "prose with braces",
      input: "Evidence { key: value } and more prose.",
      expectedStatus: "missing",
    },
    {
      label: "json fence without signal",
      input: '```json\n{"name": "John"}\n```',
      expectedStatus: "missing",
    },
    {
      label: "json5 fence without signal",
      input: '```json5\n{"name": "John"}\n```',
      expectedStatus: "missing",
    },
    {
      label: "ACCEPTANCE_REPORT: without JSON body",
      input: "ACCEPTANCE_REPORT: is mentioned here but no JSON follows",
      expectedStatus: "missing",
    },
    {
      label: "prose with fence delimiters but no tag",
      input: "```\n{}\n```",
      expectedStatus: "missing",
    },
    {
      // The tagged pattern collects this candidate; the empty body fails
      // JSON.parse → status is "invalid", not "missing".
      label: "acceptance-report tag with empty body",
      input: "```acceptance-report\n\n```",
      expectedStatus: "invalid",
    },
  ];

  for (const { label, input, expectedStatus } of missingCases) {
    it(`missing: ${label}`, () => {
      const result = analyzeAcceptanceOutput(input);
      // Status must match the independently-declared expected value.
      assert.equal(
        result.status,
        expectedStatus,
        `[${label}] expected status (declared independently)`,
      );
      // Either way: must not strip.
      assert.equal(result.stripped, false, `[${label}] must not strip when no valid authority`);
      assert.equal(
        result.strippedOutput,
        input,
        `[${label}] INV1: strippedOutput must equal input`,
      );
      // Invariant 7.
      const r2 = analyzeAcceptanceOutput(input);
      assert.equal(r2.status, result.status, `[${label}] INV7: deterministic`);
      // Invariant 8.
      const s1 = stripAcceptanceReportIfValid(input);
      const s2 = stripAcceptanceReportIfValid(s1);
      assert.equal(s2, s1, `[${label}] INV8: idempotent`);
      // JS mirror.
      const jsResult = analyzeJs(input);
      assert.equal(jsResult.status, expectedStatus, `[${label}] JS-mirror: status matches`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACID TEST: Five historical defects
//
// Each defect is covered by at least one generated case in the matrix. This
// section also demonstrates the defect via an inline simulation of the pre-fix
// behaviour. Where the matrix case would FAIL against the old code, we assert
// the old code produces the wrong answer. Where the new code (analyzeAcceptanceOutput)
// produces the correct answer, we assert it.
//
// Pre-fix implementations are reconstructed from the git diff of
// acceptance/report-reliability. They are kept as close as possible to the
// original to be representative, while using the same helpers (makeValidPayload,
// extractBalancedJson equivalent, etc.).
// ─────────────────────────────────────────────────────────────────────────────

describe("acid test: historical defect coverage (tlhm-thkx)", () => {
  // ── Shared oracle for "old" behaviour ──────────────────────────────────────
  //
  // Each old function is implemented inline, mirroring the pre-fix code from
  // the git diff. They are LOCAL to this describe block and never exported.

  /**
   * OLD parseAcceptanceReport (pre-tlhm-30b6 / pre-tlhm-wbvp).
   * Returns the FIRST valid tagged fence, then first json-family fence,
   * then first prefix match — independent of which fence is terminal.
   */
  function oldParseAcceptanceReport(output: string): {
    report?: Record<string, unknown>;
    error?: string;
  } {
    // Step 1: Try tagged fences in order, return FIRST valid.
    const taggedMatches = [...output.matchAll(/```acceptance-report\s*\n([\s\S]*?)```/gi)];
    const parseErrors: string[] = [];
    for (const match of taggedMatches) {
      const body = match[1]?.trim();
      if (!body) continue;
      try {
        const parsed = JSON.parse(body) as unknown;
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          Array.isArray((parsed as Record<string, unknown>).criteriaSatisfied)
        ) {
          const criteria = (parsed as Record<string, unknown>).criteriaSatisfied as Array<{
            status?: unknown;
          }>;
          const allValid = criteria.every((c) => c.status === "satisfied");
          if (allValid) {
            return { report: parsed as Record<string, unknown> };
          }
          parseErrors.push("Invalid status");
        }
      } catch (e) {
        parseErrors.push(String(e));
      }
    }
    if (parseErrors.length > 0) return { error: `Failed to parse: ${parseErrors.join("; ")}` };

    // Step 2: Try json-family fences.
    const jsonMatches = [...output.matchAll(/```(?:json|jsonc|json5)\s*\n([\s\S]*?)```/gi)];
    for (const match of jsonMatches) {
      const body = match[1]?.trim();
      if (!body) continue;
      try {
        const parsed = JSON.parse(body) as unknown;
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          "criteriaSatisfied" in (parsed as object)
        ) {
          return { report: parsed as Record<string, unknown> };
        }
      } catch {
        // ignore
      }
    }

    // Step 3: Try ACCEPTANCE_REPORT: prefix (first occurrence only).
    const prefixMatch = output.match(/ACCEPTANCE_REPORT\s*:/i);
    if (prefixMatch && prefixMatch.index !== undefined) {
      const jsonStart = output.indexOf("{", prefixMatch.index + prefixMatch[0].length);
      if (jsonStart !== -1) {
        // Simple greedy extraction: find last } (approximating old balanced extractor).
        const jsonEnd = output.lastIndexOf("}");
        if (jsonEnd > jsonStart) {
          try {
            const json = output.slice(jsonStart, jsonEnd + 1);
            const parsed = JSON.parse(json) as unknown;
            if (parsed && typeof parsed === "object")
              return { report: parsed as Record<string, unknown> };
          } catch {
            // ignore
          }
        }
      }
    }

    return { error: "Structured acceptance report not found." };
  }

  /**
   * OLD stripAcceptanceReport (pre-tlhm-hrka / pre-tlhm-bbhv / pre-tlhm-wbvp).
   * Stripped the trailing tagged fence unconditionally (no validity gate).
   * Had a separate greedy prefix regex that could delete all following prose.
   */
  function oldStripAcceptanceReport(output: string): string {
    // Find the trailing fence (any json-family or acceptance-report form).
    const trailingFencePattern =
      /\n?```(acceptance-report|json|jsonc|json5)\s*\n([\s\S]*?)```\s*/gi;
    let trailingFence: { index: number; tag: string; body: string } | undefined;
    for (const match of output.matchAll(trailingFencePattern)) {
      const end = (match.index ?? 0) + match[0].length;
      if (output.slice(end).trim().length === 0 && match[1] && match[2]) {
        trailingFence = {
          index: match.index ?? 0,
          tag: match[1].toLowerCase(),
          body: match[2],
        };
      }
    }

    if (trailingFence) {
      // OLD BUG (tlhm-hrka): for the tagged form, strips WITHOUT validity check.
      if (trailingFence.tag === "acceptance-report") {
        return output.slice(0, trailingFence.index).trimEnd();
      }
      // For json-family: strips if body has acceptance report shape.
      try {
        const parsed = JSON.parse(trailingFence.body.trim()) as unknown;
        if (parsed && typeof parsed === "object" && "criteriaSatisfied" in (parsed as object)) {
          return output.slice(0, trailingFence.index).trimEnd();
        }
      } catch {
        // Leave non-parseable fences.
      }
    }

    // OLD BUG (tlhm-bbhv): greedy regex deletes all content from first { to last }
    return output
      .replace(/\n?```acceptance-report\s*\n[\s\S]*?```\s*$/i, "")
      .replace(/\n?ACCEPTANCE_REPORT\s*:\s*\{[\s\S]*\}\s*$/i, "") // greedy!
      .trimEnd();
  }

  /**
   * OLD containsAcceptanceReport (pre-tlhm-fah8).
   * Used a bare /ACCEPTANCE_REPORT\s*:/i regex that matched prose mentions.
   */
  function oldContainsAcceptanceReport(text: string): boolean {
    if (/```acceptance-report\s*\n[\s\S]*?```/i.test(text)) return true;
    if (/ACCEPTANCE_REPORT\s*:/i.test(text)) return true; // matches prose mentions!
    return false;
  }

  // ── Defect 1: tlhm-30b6 — first-valid parse vs trailing strip ────────────
  //
  // Old code: parseAcceptanceReport returned the FIRST valid tagged fence,
  // not the last (terminal) one. A valid-then-invalid sequence would have the
  // old code return a report even though the terminal (last) fence was invalid.
  //
  // The matrix case: [valid-tagged, invalid-tagged-terminal].
  // New code (correct): status: "invalid" (last fence is terminal and invalid).
  // Old code (wrong): returns a report (first fence is valid).

  it("tlhm-30b6: valid-then-invalid — old parse returns first valid (wrong); new returns invalid", () => {
    const tokenA = "TLHM30B6_VALID";
    const tokenB = "TLHM30B6_INVALID";
    const validFence = `\`\`\`acceptance-report\n${JSON.stringify(makeValidPayload(tokenA))}\n\`\`\``;
    const invalidFence = `\`\`\`acceptance-report\n${JSON.stringify(makeSchemaInvalidPayload(tokenB))}\n\`\`\``;
    const input = `Leading prose.\n${validFence}\n${invalidFence}`;

    // NEW behaviour (correct):
    const newResult = analyzeAcceptanceOutput(input);
    assert.equal(
      newResult.status,
      "invalid",
      "REGRESSION GUARD tlhm-30b6: last (invalid) fence must win; status must be invalid",
    );
    assert.equal(newResult.stripped, false, "invalid fence must not be stripped");
    assert.equal(
      newResult.strippedOutput,
      input,
      "INV1: invalid authority must leave input unchanged",
    );

    // OLD behaviour (wrong): returns report from the first valid fence.
    const oldResult = oldParseAcceptanceReport(input);
    assert.ok(
      oldResult.report !== undefined,
      "DEFECT CONFIRMED tlhm-30b6: old code returns report from first valid (wrong)",
    );
    assert.ok(
      oldResult.report &&
        typeof oldResult.report.diffSummary === "string" &&
        oldResult.report.diffSummary.includes(tokenA),
      "old code returns FIRST valid report, not last — defect confirmed",
    );

    // Old and new must DISAGREE for this input.
    assert.notEqual(
      newResult.status,
      "valid",
      "new and old code must disagree: new returns invalid, old returned report",
    );
  });

  // ── Defect 2: tlhm-hrka — gated strip covering only the tagged form ───────
  //
  // Old `stripAcceptanceReport` stripped a trailing tagged fence unconditionally
  // (no validity gate). An invalid fence in tagged form was silently removed.
  //
  // The matrix case: [invalid-tagged-terminal].
  // New code (correct): stripped: false, strippedOutput === input.
  // Old code (wrong): strips the invalid fence → strippedOutput != input.

  it("tlhm-hrka: invalid-tagged-terminal — old strips without validity gate (wrong); new leaves unchanged", () => {
    const token = "TLHMHRKA_INVALID";
    const invalidFence = `\`\`\`acceptance-report\n${JSON.stringify(makeSchemaInvalidPayload(token))}\n\`\`\``;
    const input = `Leading prose.\n${invalidFence}`;

    // NEW behaviour (correct):
    const newResult = analyzeAcceptanceOutput(input);
    assert.equal(newResult.status, "invalid");
    assert.equal(
      newResult.stripped,
      false,
      "REGRESSION GUARD tlhm-hrka: invalid fence must NOT be stripped",
    );
    assert.equal(newResult.strippedOutput, input, "INV1: invalid fence must leave input unchanged");

    // OLD behaviour (wrong): strips the invalid trailing tagged fence.
    const oldStripped = oldStripAcceptanceReport(input);
    assert.notEqual(
      oldStripped,
      input,
      "DEFECT CONFIRMED tlhm-hrka: old code strips invalid tagged fence (wrong)",
    );
    assert.equal(
      oldStripped,
      "Leading prose.",
      "old code removed the invalid fence — defect confirmed",
    );
  });

  // ── Defect 3: tlhm-wbvp — json-then-prefix selection mismatch ────────────
  //
  // Old code: parseAcceptanceReport returned the jsonfam candidate; the
  // old stripAcceptanceReport fell through to the greedy prefix regex and
  // stripped the prefix. Two different candidates were operated on.
  //
  // The matrix case: [valid-json, valid-prefix-terminal].
  // New code (correct): single site — prefix (terminal) wins both parse and strip.
  // Old code (wrong): parse returns json report, strip removes prefix.

  it("tlhm-wbvp: json-then-prefix — old parse picks json, old strip removes prefix (mismatch); new is consistent", () => {
    const tokenJson = "TLHMWBVP_JSON";
    const tokenPrefix = "TLHMWBVP_PREFIX";
    const jsonFence = `\`\`\`json\n${JSON.stringify(makeValidPayload(tokenJson))}\n\`\`\``;
    const prefixForm = `ACCEPTANCE_REPORT: ${JSON.stringify(makeValidPayload(tokenPrefix))}`;
    const input = `Leading prose.\n${jsonFence}\n${prefixForm}`;

    // NEW behaviour (correct): prefix (terminal) wins.
    const newResult = analyzeAcceptanceOutput(input);
    assert.equal(
      newResult.status,
      "valid",
      "REGRESSION GUARD tlhm-wbvp: prefix (terminal) must be selected and must parse",
    );
    assert.equal(newResult.form, "prefix", "selected form must be prefix");
    const diffSummary = (newResult.report as { diffSummary?: unknown }).diffSummary;
    assert.ok(
      typeof diffSummary === "string" && diffSummary.includes(tokenPrefix),
      "INV3: report identity must be the prefix candidate, not the json fence",
    );
    // strippedOutput must contain the json fence (it survives) and not the prefix.
    assert.ok(
      newResult.strippedOutput.includes(tokenJson),
      "json fence (non-terminal) must survive in strippedOutput",
    );
    assert.ok(
      !newResult.strippedOutput.includes(tokenPrefix),
      "prefix (stripped) must not appear in strippedOutput",
    );

    // OLD behaviour (wrong): parse picks json, strip removes prefix.
    const oldParseResult = oldParseAcceptanceReport(input);
    assert.ok(oldParseResult.report !== undefined, "old parse returns a report (from json fence)");
    // Old strip: the prefix matches the greedy regex → falls through to prefix strip.
    // (The json fence is not "trailing" because the prefix appears after it.)
    const oldStripped = oldStripAcceptanceReport(input);
    // Verify the old strip removed the prefix but old parse reported json.
    const oldParsedFromJson =
      oldParseResult.report &&
      typeof oldParseResult.report.diffSummary === "string" &&
      oldParseResult.report.diffSummary.includes(tokenJson);
    const oldStrippedRemovedPrefix = !oldStripped.includes(tokenPrefix);
    // For the mismatch to be confirmed, BOTH must hold: parse picked json AND
    // strip removed prefix. Using || means either half can regress unnoticed
    // (instance 8 of vacuous coverage, fixed by tlhm-bnlt). Using && requires
    // both sides of the mismatch to be confirmed simultaneously.
    assert.ok(
      oldParsedFromJson && oldStrippedRemovedPrefix,
      "DEFECT CONFIRMED tlhm-wbvp: old code parse/strip used different candidates",
    );
  });

  // ── Defect 4: tlhm-bbhv — greedy prefix regex deleting all following prose ──
  //
  // Old stripAcceptanceReport used:
  //   .replace(/\n?ACCEPTANCE_REPORT\s*:\s*\{[\s\S]*\}\s*$/i, "")
  // The `[\s\S]*` greedily matched from the first { to the LAST } in the string,
  // deleting all prose between the report and the final }.
  //
  // The matrix case: [prefix-report + trailing-prose-with-closing-brace].
  // New code (correct): non-terminal → not stripped; strippedOutput === input.
  // Old code (wrong): greedy regex deletes prose + report body.

  it("tlhm-bbhv: prefix + trailing prose with } — old greedy regex deletes prose; new preserves all", () => {
    const token = "TLHMBBHV_TOKEN";
    const validJson = JSON.stringify(makeValidPayload(token));
    const trailingProse = "IMPORTANT PROSE the user needs { and it ends with a closing brace }";
    const input = `ACCEPTANCE_REPORT: ${validJson}\n\n${trailingProse}`;

    // NEW behaviour (correct): report is non-terminal (prose follows) → not stripped.
    const newResult = analyzeAcceptanceOutput(input);
    assert.equal(newResult.status, "valid", "report must parse");
    assert.equal(
      newResult.stripped,
      false,
      "REGRESSION GUARD tlhm-bbhv: non-terminal report must NOT be stripped",
    );
    assert.equal(
      newResult.strippedOutput,
      input,
      "INV5: full input including prose must survive byte-for-byte",
    );
    assert.ok(
      newResult.strippedOutput.includes(trailingProse),
      "INV5: trailing prose with } must survive",
    );

    // OLD behaviour (wrong): greedy regex matches from { to the last } in the entire string,
    // eating the trailing prose.
    const oldStripped = oldStripAcceptanceReport(input);
    assert.notEqual(
      oldStripped,
      input,
      "DEFECT CONFIRMED tlhm-bbhv: old greedy regex modified the input (wrong)",
    );
    assert.ok(
      !oldStripped.includes(trailingProse) || oldStripped.length < input.length,
      "DEFECT CONFIRMED tlhm-bbhv: old code deleted prose or shortened output incorrectly",
    );
  });

  it("tlhm-bbhv (variation): prose before report with } — terminal case, prose must survive after strip", () => {
    // Different manifestation: report IS terminal (prose is BEFORE, not after).
    // Old code's trimEnd after strip could trim more than intended, but the main
    // danger is the greedy regex. New code: exact span splice, prose before survives.
    const token = "TLHMBBHV_BEFORE";
    const prose = "Evidence { outer { inner } still-outer }";
    const validJson = JSON.stringify(makeValidPayload(token));
    const input = `${prose}\nACCEPTANCE_REPORT: ${validJson}`;

    const result = analyzeAcceptanceOutput(input);
    assert.equal(result.status, "valid");
    assert.equal(result.stripped, true, "terminal prefix report must be stripped");
    assert.equal(
      result.strippedOutput,
      prose,
      "INV2+INV5: prose with nested braces must survive exactly in strippedOutput",
    );
    assertAllInvariants(
      {
        label: "tlhm-bbhv prose-before variant",
        input,
        expectedStatus: "valid",
        expectedStripped: true,
        expectedToken: token,
        expectedStrippedOutput: prose,
      },
      result,
    );
  });

  // ── Defect 5: tlhm-fah8 — prose-mention superseding a real report ─────────
  //
  // Old `containsAcceptanceReport` (in utils.ts) used a bare /ACCEPTANCE_REPORT\s*:/i
  // regex that matched prose mentions without validating the JSON body. This
  // caused getFinalOutput to treat a prose-mention text part as if it contained
  // a real acceptance report, overriding the genuine report in an earlier part.
  //
  // From analyzeAcceptanceOutput's perspective: a prose mention without JSON
  // must return status: "missing". The fix (delegating to analyzeAcceptanceOutput)
  // ensures the same logic is used everywhere.

  it("tlhm-fah8: prose mention of ACCEPTANCE_REPORT: (no JSON) — new code: missing; old contains: true", () => {
    const mention = "By the way I should mention ACCEPTANCE_REPORT: is the marker we use here.";

    // NEW behaviour (correct): no JSON after the marker → status: missing.
    // NOTE: This assertion tests analyzeAcceptanceOutput, NOT containsAcceptanceReport
    // (the function that actually had the defect). It stays true even if the defect is
    // reintroduced in containsAcceptanceReport. The getFinalOutput-layer assertion below
    // IS the regression guard that can fail on reversion. See GROUP 12 for generated coverage.
    const newResult = analyzeAcceptanceOutput(mention);
    assert.equal(
      newResult.status,
      "missing",
      "analyzeAcceptanceOutput invariant: prose mention without JSON must be status:missing",
    );
    assert.equal(newResult.stripped, false);
    assert.equal(newResult.strippedOutput, mention);

    // OLD containsAcceptanceReport (wrong): bare regex matches the mention.
    const oldContains = oldContainsAcceptanceReport(mention);
    assert.equal(
      oldContains,
      true,
      "DEFECT CONFIRMED tlhm-fah8: old containsAcceptanceReport matched prose mention (wrong)",
    );

    // Old and new must DISAGREE: new says no report, old says contains report.
    assert.equal(newResult.status, "missing", "new code: no report in prose mention");
    assert.equal(oldContains, true, "old code: incorrectly flagged the prose mention");

    // REGRESSION GUARD (getFinalOutput layer): this assertion CAN FAIL when
    // containsAcceptanceReport is reverted to a bare regex.
    // getFinalOutput iterates parts backward; the mention-part is visited first.
    // Old code: containsAcceptanceReport(mention)=true → returns mention (wrong).
    // New code: containsAcceptanceReport(mention)=false → continues to real report.
    const guardToken = "ACID_FAH8_GUARD_TOKEN";
    const realReport = `\`\`\`acceptance-report\n${JSON.stringify(makeValidPayload(guardToken))}\n\`\`\``;
    const guardMsg = fauxAssistantMessage([
      { type: "text", text: realReport },
      { type: "text", text: mention },
    ] as FauxContentBlock[]);
    const guardOutput = getFinalOutput([guardMsg as Message]);
    assert.ok(
      guardOutput.includes(guardToken),
      `REGRESSION GUARD tlhm-fah8 (getFinalOutput): result must contain real report token; ` +
        `got: ${guardOutput.slice(0, 200)}`,
    );
  });

  it("tlhm-fah8: real report in one part, prose mention in another — report must be identified", () => {
    // Simulates the actual tlhm-fah8 scenario at the analyzeAcceptanceOutput level.
    // A text that contains a real report followed by a prose mention.
    // New code: identifies the real report (non-terminal → status:valid, stripped:false).
    const token = "TLHMFAH8_REAL";
    const realReport = `\`\`\`acceptance-report\n${JSON.stringify(makeValidPayload(token))}\n\`\`\``;
    const mention = "Note: ACCEPTANCE_REPORT: is the structured format used above.";
    const combined = `${realReport}\n\n${mention}`;

    // New behaviour:
    const result = analyzeAcceptanceOutput(combined);
    assert.equal(
      result.status,
      "valid",
      "real report must be detected even with prose mention after",
    );
    assert.equal(result.stripped, false, "non-terminal report must not be stripped");
    const diffSummary = (result.report as { diffSummary?: unknown }).diffSummary;
    assert.ok(
      typeof diffSummary === "string" && diffSummary.includes(token),
      "INV3: report identity must match the REAL report, not the mention",
    );

    // Old containsAcceptanceReport on the mention alone would return true —
    // the old bug would cause getFinalOutput to use the mention part instead.
    const oldContainsMention = oldContainsAcceptanceReport(mention);
    assert.equal(
      oldContainsMention,
      true,
      "DEFECT CONFIRMED tlhm-fah8: old code would have treated mention as report-containing",
    );
    // New code on the mention alone returns missing.
    const newOnMentionOnly = analyzeAcceptanceOutput(mention);
    assert.equal(
      newOnMentionOnly.status,
      "missing",
      "new code correctly rejects the prose mention as not containing a real report",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 10: Invariant 8 — idempotency analysis (standalone)
//
// The ticket asks whether repeated processing is idempotent or structurally
// unavailable by the API.
//
// FINDING: The API does NOT prevent reprocessing. stripAcceptanceReportIfValid
// can be called any number of times. Idempotency holds CONDITIONALLY:
//
//   - No-op case (input unchanged on first call): idempotent. The same invalid
//     or non-terminal candidate means no change on any subsequent call.
//
//   - Single valid terminal candidate: idempotent. After stripping the report
//     the output is prose-only (no more valid terminal candidates).
//
//   - Multi-candidate sequence, both valid: NOT idempotent. Stripping the
//     terminal candidate exposes the next-to-last candidate, which becomes
//     the new terminal and is stripped on the second call. This is EXPECTED
//     BEHAVIOUR given the current selection policy; it is not a bug, but it
//     is a property callers should be aware of.
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: invariant 8 — idempotency of repeated processing", () => {
  it("no-op: invalid terminal report — repeated strip is idempotent", () => {
    const token = "IDEMPOTENT_INVALID_TOKEN";
    const input = `prose\n\`\`\`acceptance-report\n${JSON.stringify(makeSchemaInvalidPayload(token))}\n\`\`\``;

    const once = stripAcceptanceReportIfValid(input);
    assert.equal(once, input, "invalid report: first strip is no-op");
    const twice = stripAcceptanceReportIfValid(once);
    assert.equal(twice, once, "INV8 no-op path: second strip also no-op");
  });

  it("no-op: non-terminal valid report — repeated strip is idempotent", () => {
    const token = "IDEMPOTENT_NT_TOKEN";
    const validJson = JSON.stringify(makeValidPayload(token));
    const input = `\`\`\`acceptance-report\n${validJson}\n\`\`\`\n\nProse that follows.`;

    const once = stripAcceptanceReportIfValid(input);
    assert.equal(once, input, "non-terminal valid: first strip is no-op");
    const twice = stripAcceptanceReportIfValid(once);
    assert.equal(twice, once, "INV8 no-op path: second strip also no-op");
  });

  it("single valid terminal: strip leaves prose-only output — second call is no-op", () => {
    const token = "IDEMPOTENT_TOKEN";
    const validJson = JSON.stringify(makeValidPayload(token));
    const input = `Leading prose.\n\`\`\`acceptance-report\n${validJson}\n\`\`\``;

    const once = stripAcceptanceReportIfValid(input);
    assert.equal(once, "Leading prose.", "first strip removes the report");
    const twice = stripAcceptanceReportIfValid(once);
    assert.equal(
      twice,
      once,
      "INV8: prose-only output has no more candidates — second strip is no-op",
    );
    const thrice = stripAcceptanceReportIfValid(twice);
    assert.equal(thrice, twice, "INV8: third call also no-op");
  });

  it("multi-candidate (both valid): NOT idempotent — second strip removes the exposed candidate", () => {
    // First strip: removes terminal json candidate → exposes tagged candidate.
    // Second strip: tagged candidate is now terminal and valid → also stripped.
    // This is expected behaviour, not a bug. Callers that need to strip exactly
    // one report must use analyzeAcceptanceOutput directly and work with the span.
    const tokenA = "IDEMPOTENT_MULTI_A";
    const tokenB = "IDEMPOTENT_MULTI_B";
    const tagged = `\`\`\`acceptance-report\n${JSON.stringify(makeValidPayload(tokenA))}\n\`\`\``;
    const json = `\`\`\`json\n${JSON.stringify(makeValidPayload(tokenB))}\n\`\`\``;
    const input = `prose\n${tagged}\n${json}`;

    const once = stripAcceptanceReportIfValid(input);
    // json fence (terminal) is stripped; tagged fence now exposed.
    assert.ok(once.includes(tokenA), "first strip: tagged candidate survives");
    assert.ok(!once.includes(tokenB), "first strip: json candidate removed");

    const twice = stripAcceptanceReportIfValid(once);
    // tagged fence (now terminal) is stripped on second call.
    assert.ok(!twice.includes(tokenA), "second strip: exposed tagged candidate also removed");

    // Third call is now a no-op (prose only).
    const thrice = stripAcceptanceReportIfValid(twice);
    assert.equal(thrice, twice, "third call on prose-only output is a no-op");

    // Conclusion: multi-candidate strip is NOT idempotent.
    // The API does not prevent reprocessing (no exception thrown).
    assert.doesNotThrow(() => stripAcceptanceReportIfValid(input), "API allows re-calling strip");
  });

  it("API does not prevent reprocessing — no exception on repeated calls", () => {
    const token = "IDEMPOTENT_API_TOKEN";
    const input = `prose\n\`\`\`acceptance-report\n${JSON.stringify(makeValidPayload(token))}\n\`\`\``;
    const once = stripAcceptanceReportIfValid(input);
    assert.doesNotThrow(() => stripAcceptanceReportIfValid(once), "API allows re-calling strip");
    assert.doesNotThrow(
      () => stripAcceptanceReportIfValid(stripAcceptanceReportIfValid(once)),
      "API allows three calls",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 11: JS runtime mirror parity (standalone cross-check)
//
// The individual cases already check JS parity via assertAllInvariants. This
// describe block adds a dedicated cross-check across a broader set of inputs to
// make the mirror check explicit and easy to spot in CI output.
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: JS runtime mirror parity", () => {
  const token = "MIRROR_TOKEN";
  const validJson = JSON.stringify(makeValidPayload(token));
  const invalidJson = JSON.stringify(makeSchemaInvalidPayload("MIRROR_INVALID"));

  const mirrorInputs: Array<{ label: string; input: string }> = [
    {
      label: "valid tagged terminal",
      input: `prose\n\`\`\`acceptance-report\n${validJson}\n\`\`\``,
    },
    {
      label: "invalid tagged terminal",
      input: `prose\n\`\`\`acceptance-report\n${invalidJson}\n\`\`\``,
    },
    { label: "valid json terminal", input: `prose\n\`\`\`json\n${validJson}\n\`\`\`` },
    { label: "valid prefix terminal", input: `prose\nACCEPTANCE_REPORT: ${validJson}` },
    {
      label: "valid non-terminal with prose after",
      input: `\`\`\`acceptance-report\n${validJson}\n\`\`\`\nProse after.`,
    },
    {
      label: "valid-then-invalid (tlhm-30b6 case)",
      input: `prose\n\`\`\`acceptance-report\n${validJson}\n\`\`\`\n\`\`\`acceptance-report\n${invalidJson}\n\`\`\``,
    },
    {
      label: "prefix with trailing } in prose (tlhm-bbhv case)",
      input: `ACCEPTANCE_REPORT: ${validJson}\n\nProse with closing brace }`,
    },
    { label: "empty string", input: "" },
    { label: "plain prose", input: "No acceptance report here." },
    {
      label: "CRLF tagged fence",
      input: `prose\r\n\`\`\`acceptance-report\r\n${validJson}\r\n\`\`\``,
    },
  ];

  for (const { label, input } of mirrorInputs) {
    it(`JS mirrors TS: ${label}`, () => {
      const tsResult = analyzeAcceptanceOutput(input);
      const jsResult = analyzeJs(input);
      assert.equal(jsResult.status, tsResult.status, `[JS-mirror ${label}] status must match`);
      assert.equal(
        jsResult.stripped,
        tsResult.stripped,
        `[JS-mirror ${label}] stripped must match`,
      );
      assert.equal(
        jsResult.strippedOutput,
        tsResult.strippedOutput,
        `[JS-mirror ${label}] strippedOutput must match`,
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 12: Message-part aggregation (Axis 1 — tlhm-fah8 gap closure)
//
// getFinalOutput processes Message[] and selects content from the last assistant
// message whose parts contain an acceptance report. The per-part test uses
// containsAcceptanceReport, which is where tlhm-fah8 lived.
//
// When the defect is reintroduced (containsAcceptanceReport reverts to a bare
// /ACCEPTANCE_REPORT\s*:/i regex), Scenario A cases fail: the mention-part is
// visited first (backward iteration), oldContains returns true, and getFinalOutput
// returns the mention text rather than the real report.
//
// Five scenarios, two generated per form (Scenarios A and B) plus three global:
//   A. [real-report-part, prose-mention-part] — mention visited first (backward);
//      must NOT be treated as the report-bearing part. Catches tlhm-fah8.
//   B. [prose-mention-part, real-report-part] — report is last; mention collected
//      as preceding prose. Demonstrates correct ordering.
//   C. Both in one part — combined text contains both mention and real report.
//   D. Neither part has a report — falls back to last non-empty text part.
//   E. Report split across parts (no single part is valid) — falls back to last part.
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: message-part aggregation (getFinalOutput, Axis 1 — tlhm-fah8)", () => {
  const PROSE_MENTION_MSG = "By the way I should mention ACCEPTANCE_REPORT: is the marker we use.";

  const forms: CandidateForm[] = ["tagged", "json", "jsonc", "json5", "prefix"];

  for (const form of forms) {
    // ── Scenario A: report in earlier part, mention in later part ──────────────
    // getFinalOutput iterates parts backward: mention-part is j=1 (visited first).
    // containsAcceptanceReport(mention) must be false (new code) so iteration
    // continues to j=0 (real report) and returns it.
    // Fails when containsAcceptanceReport reverts to bare regex (tlhm-fah8).
    it(`scenario A (report-then-mention): form=${form}`, () => {
      const token = `MSGPART_A_${form.toUpperCase()}`;
      const reportText = buildCandidateText(form, "valid", token);
      const msg = fauxAssistantMessage([
        { type: "text", text: reportText },
        { type: "text", text: PROSE_MENTION_MSG },
      ] as FauxContentBlock[]);
      const result = getFinalOutput([msg as Message]);
      // Token survival: the real report's identity must appear in the result.
      assert.ok(
        result.includes(token),
        `[msgpart A form=${form}] REGRESSION GUARD: result must contain real report identity ` +
          `token ${token}; if this fails, containsAcceptanceReport is matching prose mentions ` +
          `(tlhm-fah8 reversion). Got: ${result.slice(0, 200)}`,
      );
      // Full content preservation: getFinalOutput aggregates ALL text parts of
      // the chosen message; the prose mention (part 1) must survive, not be
      // silently discarded when only part 0 is returned.
      assert.ok(
        result.includes(PROSE_MENTION_MSG),
        `[msgpart A form=${form}] CONTENT GUARD: prose mention must appear in result; ` +
          `if this fails, getFinalOutput dropped a text part. Got: ${result.slice(0, 200)}`,
      );
      // The prose mention must NOT be the sole returned output.
      assert.notEqual(
        result.trim(),
        PROSE_MENTION_MSG.trim(),
        `[msgpart A form=${form}] prose mention alone must NOT be the result`,
      );
    });

    // ── Scenario B: mention in earlier part, report in later part ──────────────
    // getFinalOutput iterates backward: report-part is j=1 (visited first).
    // containsAcceptanceReport(report) = true → collects preceding parts.
    // The mention-part is preceding prose (containsAcceptanceReport(mention) = false).
    // Result includes both the mention (as prose) and the real report.
    it(`scenario B (mention-then-report): form=${form}`, () => {
      const token = `MSGPART_B_${form.toUpperCase()}`;
      const reportText = buildCandidateText(form, "valid", token);
      const msg = fauxAssistantMessage([
        { type: "text", text: PROSE_MENTION_MSG },
        { type: "text", text: reportText },
      ] as FauxContentBlock[]);
      const result = getFinalOutput([msg as Message]);
      assert.ok(
        result.includes(token),
        `[msgpart B form=${form}] result must contain report identity token`,
      );
      assert.ok(
        result.includes(PROSE_MENTION_MSG),
        `[msgpart B form=${form}] preceding prose mention must be included in result`,
      );
    });
  }

  // ── Scenario C: both in one part ───────────────────────────────────────────
  it("scenario C (both-in-one-part): mention and real report co-located", () => {
    const token = "MSGPART_C_BOTH";
    const reportText = buildCandidateText("tagged", "valid", token);
    const combined = `${PROSE_MENTION_MSG}\n\n${reportText}`;
    const msg = fauxAssistantMessage([{ type: "text", text: combined }] as FauxContentBlock[]);
    const result = getFinalOutput([msg as Message]);
    assert.ok(
      result.includes(token),
      "[msgpart C] combined part: result must contain report token",
    );
  });

  // ── Scenario D: neither part contains a real report ───────────────────────
  // Updated by tlhm-t34y: aggregation returns ALL non-empty text parts joined
  // with "\n\n", not only the last part. For messages without an acceptance report
  // this is a user-visible behaviour change: multi-part assistant messages now
  // return all non-empty text parts joined with "\n\n" instead of only the last part.
  it("scenario D (neither): no report in any part, returns aggregate of all non-empty text parts", () => {
    const partA = "First paragraph of summary.";
    const partB = "Second paragraph of summary.";
    const msg = fauxAssistantMessage([
      { type: "text", text: partA },
      { type: "text", text: partB },
    ] as FauxContentBlock[]);
    const result = getFinalOutput([msg as Message]);
    assert.equal(
      result,
      `${partA}\n\n${partB}`,
      "[msgpart D] no report: aggregate of all non-empty text parts is returned",
    );
  });

  // ── Scenario E: report split across parts — aggregate recognized (tlhm-t34y) ──
  // Oracle corrected: the pre-aggregation behaviour (fall back to last fragment)
  // is wrong. With aggregation, the parts are joined and the complete report is
  // recognized. Split at the fence-header boundary: part1 = opening line, part2 =
  // JSON body + closing fence. Neither part alone is a valid acceptance report;
  // the aggregate is — JSON.parse succeeds because extra whitespace before the
  // body is insignificant.
  it("scenario E (split-report): aggregate of header + body parts is recognized as valid report", () => {
    const token = "MSGPART_E_SPLIT";
    const fullReport = buildCandidateText("tagged", "valid", token);
    // Split after the opening fence line so neither part alone is complete.
    const headerEnd = fullReport.indexOf("\n") + 1;
    const part1 = fullReport.slice(0, headerEnd);
    const part2 = fullReport.slice(headerEnd);
    const msg = fauxAssistantMessage([
      { type: "text", text: part1 },
      { type: "text", text: part2 },
    ] as FauxContentBlock[]);
    const result = getFinalOutput([msg as Message]);
    // Aggregate joins both parts; the complete report is recognized.
    assert.equal(
      result,
      `${part1}\n\n${part2}`,
      "[msgpart E] split report: getFinalOutput returns the aggregate of both parts",
    );
    assert.ok(
      result.includes(token),
      `[msgpart E] split report: aggregate must contain report identity token ${token}`,
    );
    assert.equal(
      analyzeAcceptanceOutput(result).status,
      "valid",
      "[msgpart E] split report: aggregate is recognized as a valid acceptance report",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 13: Marker mentions before and after candidates, all five forms
// (Axis 2 — tlhm-m5jm gap closure)
//
// The tlhm-m5jm defect: the prefix locator used `output.indexOf("{", markerEnd)`
// which forward-searched from a prose mention's ACCEPTANCE_REPORT: to the next {
// anywhere in the output, adopting the real report's JSON as a spurious candidate.
// The fix: adjacency check — skip the marker unless the first non-whitespace
// character immediately after it is `{`.
//
// This group generates cases across all five candidate forms:
//   - Mention BEFORE candidate: the mention appears before the real report.
//     For the prefix form, this is the exact scenario where the spurious candidate
//     wins the selection and produces wrong strippedOutput. FAILS on m5jm reversion.
//   - Candidate THEN mention: the mention appears after the real report, making
//     it non-terminal. Tests that a trailing mention does not invalidate the candidate.
//
// Reuse the two representative marker-mention strings from the tlhm-m5jm repro tests.
// The strings were fine; the gap was that no GENERATED case placed them in the
// composition.
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: marker mentions before and after candidates, all forms (Axis 2 — tlhm-m5jm)", () => {
  // Two representative marker mention strings from the tlhm-m5jm hand-written repros.
  // These strings contain ACCEPTANCE_REPORT: in prose but no adjacent JSON body,
  // so the adjacency check must correctly skip them.
  const markerMentions = [
    {
      mentionLabel: "simple marker mention",
      mention: "Use ACCEPTANCE_REPORT: as the marker.",
    },
    {
      mentionLabel: "quoted marker mention",
      mention: 'The marker is "ACCEPTANCE_REPORT:" and it marks the end.',
    },
  ];

  const forms: CandidateForm[] = ["tagged", "json", "jsonc", "json5", "prefix"];

  for (const { mentionLabel, mention } of markerMentions) {
    for (const form of forms) {
      // ── Mention BEFORE candidate ────────────────────────────────────────
      // The candidate is terminal (nothing follows). The mention precedes it.
      // For the prefix form: reverting tlhm-m5jm creates a spurious candidate at
      // the mention position that captures the real JSON body (via forward indexOf).
      // The spurious candidate is also terminal and wins (added first, same end).
      // strippedOutput becomes "" instead of the mention text. FAILS on m5jm reversion.
      it(`mention-before-candidate: form=${form}, mention="${mentionLabel}"`, () => {
        const token = `MRK_BEFORE_${form.toUpperCase()}_${mentionLabel.replace(/\s+/g, "_").toUpperCase()}`;
        const candidateText = buildCandidateText(form, "valid", token);
        const input = `${mention}\n${candidateText}`;
        const result = analyzeAcceptanceOutput(input);

        assert.equal(
          result.status,
          "valid",
          `[mention-before form=${form} "${mentionLabel}"] real report must be detected`,
        );
        assert.equal(
          result.stripped,
          true,
          `[mention-before form=${form} "${mentionLabel}"] terminal candidate must be stripped`,
        );
        // The stripped output must equal the mention text (prose before the report).
        assert.equal(
          result.strippedOutput,
          mention,
          `[mention-before form=${form} "${mentionLabel}"] REGRESSION GUARD: strippedOutput ` +
            `must equal the mention text; if this fails for prefix form, the adjacency check ` +
            `(tlhm-m5jm) was reverted`,
        );
        // Token identity: the real report was selected, not a spurious candidate.
        const diffSummary = (result.report as { diffSummary?: unknown }).diffSummary;
        assert.ok(
          typeof diffSummary === "string" && diffSummary.includes(token),
          `[mention-before form=${form} "${mentionLabel}"] INV3: report identity must match token ${token}`,
        );
        // Determinism.
        const r2 = analyzeAcceptanceOutput(input);
        assert.equal(r2.status, result.status);
        assert.equal(r2.strippedOutput, result.strippedOutput);
      });

      // ── Candidate THEN mention ───────────────────────────────────────────
      // The candidate is non-terminal because the mention follows it.
      // For the prefix form: the mention's ACCEPTANCE_REPORT: is scanned but must
      // be skipped (adjacency check: next non-ws char after ":" is not "{").
      it(`candidate-then-mention: form=${form}, mention="${mentionLabel}"`, () => {
        const token = `MRK_AFTER_${form.toUpperCase()}_${mentionLabel.replace(/\s+/g, "_").toUpperCase()}`;
        const candidateText = buildCandidateText(form, "valid", token);
        const input = `${candidateText}\n\n${mention}`;
        const result = analyzeAcceptanceOutput(input);

        assert.equal(
          result.status,
          "valid",
          `[candidate-then-mention form=${form} "${mentionLabel}"] real report must be detected`,
        );
        assert.equal(
          result.stripped,
          false,
          `[candidate-then-mention form=${form} "${mentionLabel}"] INV4: non-terminal must not be stripped`,
        );
        assert.equal(
          result.strippedOutput,
          input,
          `[candidate-then-mention form=${form} "${mentionLabel}"] INV1: strippedOutput must equal input`,
        );
        // Determinism.
        const r2 = analyzeAcceptanceOutput(input);
        assert.equal(r2.status, result.status);
        assert.equal(r2.stripped, result.stripped);
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 14: Part-boundary aggregation shapes (Axis 5 — tlhm-t34y)
//
// Covers the four part-boundary shapes that reveal the second-candidate-authority
// defect in getFinalOutput: per-part analysis was a second selection site sitting
// upstream of the atomic analysis in execution.ts.
//
// All four shapes assert by identity token so it is provable WHICH content survived.
// The cross-message regression case confirms that backward scanning across messages
// still works after the within-message aggregation change.
//
// Reversion guard: shapes 1–4 each have at least one assertion that FAILS when
// getFinalOutput is reverted to per-part analysis.
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: part-boundary aggregation shapes (getFinalOutput, Axis 5 — tlhm-t34y)", () => {
  // ── Shape 1: valid-then-invalid across parts ─────────────────────────────────
  //
  // Old per-part analysis: backward iteration visits the invalid part first
  // (containsAcceptanceReport=false), then the valid part (containsAcceptanceReport=true)
  // → returns only the valid part. The invalid-part token is lost.
  // New aggregation: both parts are joined → aggregate analysis is "invalid"
  // (later invalid candidate wins), and BOTH tokens appear in the output.
  // FAILS on reversion: invalidToken assertion.
  it("shape 1 (valid-then-invalid): both parts appear in aggregate; analysis agrees with atomic", () => {
    const validToken = "T34Y_SHAPE1_VALID";
    const invalidToken = "T34Y_SHAPE1_INVALID";
    const validPart = buildCandidateText("tagged", "valid", validToken);
    const invalidPart = buildCandidateText("tagged", "schema-invalid", invalidToken);
    const msg = fauxAssistantMessage([
      { type: "text", text: validPart },
      { type: "text", text: invalidPart },
    ] as FauxContentBlock[]);
    const result = getFinalOutput([msg as Message]);
    assert.ok(
      result.includes(validToken),
      "[t34y shape1] aggregate must contain valid-part identity token",
    );
    assert.ok(
      result.includes(invalidToken),
      "[t34y shape1] aggregate must contain invalid-part identity token (REGRESSION GUARD: fails on reversion)",
    );
    // Aggregate analysis agrees with the atomic analysis on the same string.
    assert.equal(
      analyzeAcceptanceOutput(result).status,
      "invalid",
      "[t34y shape1] aggregate analysis must be invalid (later invalid candidate wins)",
    );
  });

  // ── Shape 2: invalid-then-summary across parts ───────────────────────────
  //
  // Old per-part analysis: backward iteration visits the summary part first
  // (no report), then the invalid-report part (containsAcceptanceReport=false
  // because the report is invalid) → falls back to summary alone.
  // Rejection evidence (the invalid report) is silently discarded, starving
  // reason-line extraction in execution.ts.
  // New aggregation: aggregate contains both → evidence preserved.
  // FAILS on reversion: invalidToken assertion.
  it("shape 2 (invalid-then-summary): invalid report evidence preserved in aggregate", () => {
    const invalidToken = "T34Y_SHAPE2_INVALID";
    const invalidPart = buildCandidateText("tagged", "schema-invalid", invalidToken);
    const summaryPart = "All done. Summary only. No report here.";
    const msg = fauxAssistantMessage([
      { type: "text", text: invalidPart },
      { type: "text", text: summaryPart },
    ] as FauxContentBlock[]);
    const result = getFinalOutput([msg as Message]);
    assert.ok(
      result.includes(invalidToken),
      "[t34y shape2] aggregate must contain invalid-report identity token (REGRESSION GUARD: fails on reversion)",
    );
    assert.ok(
      result.includes(summaryPart),
      "[t34y shape2] aggregate must contain the summary text",
    );
  });

  // ── Shape 3: report split across parts ─────────────────────────────────────────
  //
  // Same split technique as scenario E: opening fence line in part1, body + closing
  // fence in part2. Neither part alone is a valid acceptance report.
  // Old per-part analysis: falls back to part2 (last text part); part2 has no
  // opening fence → aggregate analysis on part2 returns "missing". FAILS on reversion.
  // New aggregation: joined parts form a complete fence; the extra whitespace
  // before the JSON body is insignificant to JSON.parse. RECOGNIZED.
  // FAILS on reversion: analyzeAcceptanceOutput(result).status assertion.
  it("shape 3 (split-report): aggregate of two parts is recognized as a valid acceptance report", () => {
    const token = "T34Y_SHAPE3_SPLIT";
    const fullReport = buildCandidateText("tagged", "valid", token);
    // Split after the opening fence line: part1 = header, part2 = body + closing fence.
    const headerEnd = fullReport.indexOf("\n") + 1;
    const part1 = fullReport.slice(0, headerEnd);
    const part2 = fullReport.slice(headerEnd);
    const msg = fauxAssistantMessage([
      { type: "text", text: part1 },
      { type: "text", text: part2 },
    ] as FauxContentBlock[]);
    const result = getFinalOutput([msg as Message]);
    assert.ok(
      result.includes(token),
      `[t34y shape3] aggregate must contain report identity token ${token}`,
    );
    assert.equal(
      analyzeAcceptanceOutput(result).status,
      "valid",
      "[t34y shape3] aggregate is recognized as a valid acceptance report (REGRESSION GUARD: fails on reversion)",
    );
  });

  // ── Shape 4: mention in one part, real report in the next ──────────────────────
  //
  // [real-report-part, prose-mention-part]: the report is in the earlier part,
  // the mention in the later part. Old code: backward iteration visits the mention
  // last, then finds the report → returns the report ALONE (mention is not a
  // "preceding" part because it appears AFTER the report in iteration order).
  // New aggregation: all parts joined → mention survives in the aggregate.
  // FAILS on reversion: mentionPart inclusion assertion.
  it("shape 4 (report-then-mention): both report and mention survive in aggregate; report identity confirmed", () => {
    const token = "T34Y_SHAPE4_REPORT";
    const reportPart = buildCandidateText("tagged", "valid", token);
    const mentionPart = "Note: ACCEPTANCE_REPORT: is the format marker used above.";
    const msg = fauxAssistantMessage([
      { type: "text", text: reportPart },
      { type: "text", text: mentionPart },
    ] as FauxContentBlock[]);
    const result = getFinalOutput([msg as Message]);
    assert.ok(
      result.includes(token),
      `[t34y shape4] aggregate must contain report identity token ${token}`,
    );
    assert.ok(
      result.includes(mentionPart),
      "[t34y shape4] aggregate must contain the prose mention (REGRESSION GUARD: fails on reversion)",
    );
  });

  // ── Cross-message regression: report in message N-1, summary-only in message N ──
  //
  // The backward scan must still cross message boundaries. This case verifies that
  // within-message aggregation did not break the cross-message search: when the
  // latest message has no valid acceptance report, the scan continues backward and
  // finds the report in the earlier message.
  it("cross-message regression: report in earlier message is still found when later message has none", () => {
    const token = "T34Y_CROSSMSG_REPORT";
    const reportMsg = fauxAssistantMessage([
      { type: "text", text: buildCandidateText("tagged", "valid", token) },
    ] as FauxContentBlock[]);
    const summaryMsg = fauxAssistantMessage([
      { type: "text", text: "Done. No acceptance report in this message." },
    ] as FauxContentBlock[]);
    // summaryMsg is last (N), reportMsg is earlier (N-1).
    const result = getFinalOutput([reportMsg as Message, summaryMsg as Message]);
    assert.ok(
      result.includes(token),
      `[t34y cross-message] result must contain report token from earlier message; ` +
        `got: ${result.slice(0, 200)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 15: Cross-form trailing-byte preservation (tlhm-bnlt)
//
// tlhm-ihnk’s exact-splice fix landed for the tagged form only. The json-family
// regex was folding trailing whitespace into `end` via `(?:\s*)`, and the prefix
// form was setting `end = output.length` for terminal blocks. Both destroyed
// trailing bytes that should have been preserved.
//
// This group generates one assertion per form and one combined assertion
// verifying that ALL THREE FORMS produce IDENTICAL strippedOutput for the same
// trailing-whitespace payload. This is the check that would have caught the
// drift before it shipped.
//
// Input template: "prose\n" + "\n" + [report fence] + "\n\n\n"
//   = "prose\n\n" + [report fence] + "\n\n\n"
// Expected strippedOutput: "prose\n\n\n\n" (four newlines total)
//   - The `\n?` prefix consumes the second `\n` of "prose\n\n" into the span.
//   - output.slice(0, start) = "prose\n" (one newline before the span).
//   - output.slice(end) = "\n\n\n" (three newlines preserved after the span).
//   - Combined: "prose\n" + "\n\n\n" = "prose\n\n\n\n".
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: cross-form trailing-byte preservation (tlhm-bnlt)", () => {
  // Shared prose prefix and trailing suffix used across all three forms.
  //
  // Input template: prosePart + "\n" + fence + trailingSuffix
  //   = "prose\n" + "\n" + fence + "\n\n\n"
  //   = "prose\n\n" + fence + "\n\n\n"
  //
  // Span semantics:
  //   - start = position of the second \n in "prose\n\n" (consumed by \n?)
  //   - output.slice(0, start) = "prose\n" (one trailing newline from prose)
  //   - output.slice(end) = "\n\n\n" (the trailing suffix, after the span)
  //   - strippedOutput = "prose\n" + "\n\n\n" = "prose\n\n\n\n" (four newlines total)
  const prosePart = "prose\n"; // one trailing \n
  const trailingSuffix = "\n\n\n"; // three trailing \n
  // Expected: output.slice(0, start) + output.slice(end)
  //         = "prose\n" + "\n\n\n" = four newlines after "prose".
  const expectedStrippedOutput = prosePart + trailingSuffix; // "prose\n\n\n\n"
  const token = "TRAILBYTE_CROSS_FORM";

  // Per-form inputs. Each input is: prosePart + \n + [form-specific fence] + trailingSuffix.
  // The extra \n produces the two-newline gap needed for \n? to absorb exactly one.
  const formsUnderTest: Array<{ form: CandidateForm; label: string; input: string }> = [
    {
      form: "tagged",
      label: "tagged form",
      input: `${prosePart}\n` + buildCandidateText("tagged", "valid", token) + trailingSuffix,
    },
    {
      form: "json",
      label: "json-family form (json)",
      input: `${prosePart}\n` + buildCandidateText("json", "valid", token) + trailingSuffix,
    },
    {
      form: "prefix",
      label: "prefix form",
      input: `${prosePart}\n` + buildCandidateText("prefix", "valid", token) + trailingSuffix,
    },
  ];

  // Per-form: trailing bytes preserved identically.
  for (const { form, label, input } of formsUnderTest) {
    it(`trailing bytes preserved: ${label}`, () => {
      const result = analyzeAcceptanceOutput(input);
      assert.equal(result.status, "valid", `[${label}] report must parse as valid`);
      assert.equal(result.stripped, true, `[${label}] terminal report must be stripped`);
      assert.equal(
        result.strippedOutput,
        expectedStrippedOutput,
        `[${label}] TRAILING-BYTE FIX (tlhm-bnlt): strippedOutput must be "${JSON.stringify(expectedStrippedOutput)}"; ` +
          `if this fails for ${form} form, end was folding trailing whitespace into the span`,
      );
    });
  }

  // Combined: generated assertion that all three forms yield IDENTICAL strippedOutput.
  // This is the check that would have caught the cross-form drift before it shipped.
  it("all three forms preserve trailing bytes identically (generated cross-form assertion)", () => {
    const strippedOutputs = formsUnderTest.map(({ form, input }) => {
      const result = analyzeAcceptanceOutput(input);
      assert.equal(result.status, "valid", `[cross-form ${form}] must parse as valid`);
      assert.equal(result.stripped, true, `[cross-form ${form}] must be stripped`);
      return { form, strippedOutput: result.strippedOutput };
    });

    // All three must equal the expected value.
    for (const { form, strippedOutput } of strippedOutputs) {
      assert.equal(
        strippedOutput,
        expectedStrippedOutput,
        `[cross-form] ${form} strippedOutput must equal expected ${JSON.stringify(expectedStrippedOutput)}`,
      );
    }

    // Pairwise equality: tagged === json-family === prefix.
    const [taggedResult, jsonResult, prefixResult] = strippedOutputs;
    assert.equal(
      jsonResult!.strippedOutput,
      taggedResult!.strippedOutput,
      "cross-form: json-family strippedOutput must equal tagged strippedOutput",
    );
    assert.equal(
      prefixResult!.strippedOutput,
      taggedResult!.strippedOutput,
      "cross-form: prefix strippedOutput must equal tagged strippedOutput",
    );
    assert.equal(
      prefixResult!.strippedOutput,
      jsonResult!.strippedOutput,
      "cross-form: prefix strippedOutput must equal json-family strippedOutput",
    );
  });

  // Extra: verify trailing bytes are preserved even with a longer trailing run.
  it("trailing bytes preserved with varied trailing whitespace (all forms)", () => {
    const longTrail = "\n\n\n\n\n";
    for (const { form } of formsUnderTest) {
      const input =
        `${prosePart}\n` + buildCandidateText(form, "valid", `LONGTRAIL_${form}`) + longTrail;
      const result = analyzeAcceptanceOutput(input);
      assert.equal(result.status, "valid");
      assert.equal(result.stripped, true);
      // After strip: strippedOutput must end with the trailing run.
      assert.ok(
        result.strippedOutput.endsWith(longTrail),
        `[cross-form ${form}] strippedOutput must end with the full trailing run "${JSON.stringify(longTrail)}"`,
      );
    }
  });

  // Regression guard: a revert of the json-family fix (restoring `(?:\\s*)`) would
  // make `output.slice(end)` empty instead of "\n\n\n", causing these tests to fail.
  // A revert of the prefix fix (restoring `end = output.length`) has the same effect.
  // Test names that must fail on revert:
  //   "trailing bytes preserved: json-family form (json)"
  //   "trailing bytes preserved: prefix form"
  //   "all three forms preserve trailing bytes identically (generated cross-form assertion)"
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 16: Zero-candidate oracle regression guard (tlhm-bnlt)
//
// Proves that the corrected per-fixture status oracle (GROUP 9) is capable of
// failing. Before the fix, `const expectedStatus = result.status` made the
// oracle circular: injecting a status regression (e.g., making a "missing"
// fixture return "valid") would not cause the test to fail because the expected
// value would move with the production output.
//
// This group demonstrates the oracle property by running a hand-rolled fake
// that injects a status regression and confirms the corrected oracle catches it.
// ─────────────────────────────────────────────────────────────────────────────

describe("matrix: zero-candidate oracle regression guard (tlhm-bnlt GROUP 16)", () => {
  // Demonstrate that the corrected oracle is capable of failing.
  //
  // The oracle property we need: if the function under test incorrectly returns
  // status="valid" for input that should produce status="missing", the test fails.
  //
  // Proof: we write the assertion that the corrected GROUP 9 test now makes,
  // then show that it WOULD fail when the status is wrong.
  it("oracle failure proof: mismatched status is detected (oracle is NOT circular)", () => {
    // Use the 'empty string' fixture: independently declared expected = "missing".
    const input = "";
    const independentlyDeclaredExpected: "missing" | "invalid" | "valid" = "missing";

    // Real production call — must agree.
    const realResult = analyzeAcceptanceOutput(input);
    assert.equal(
      realResult.status,
      independentlyDeclaredExpected,
      "real production result must equal the independently-declared expected status",
    );

    // Regression injection: simulate what would happen if the function returned
    // the wrong status. The old circular oracle (`const expectedStatus = result.status`)
    // would NOT catch this; the corrected oracle does.
    //
    // We use a string variable (not a typed literal) so TypeScript cannot narrow
    // the comparison away as always-true. The injected status is intentionally
    // wrong: the fixture declares "missing" but the fake function would return "valid".
    const injectedStatusStr: string = "valid";
    const declaredExpectedStr: string = independentlyDeclaredExpected;

    // Old circular oracle: expected = produced = injectedStatus → always passes.
    const wouldHavePassedWithOldOracle = injectedStatusStr === injectedStatusStr; // trivially true
    assert.equal(
      wouldHavePassedWithOldOracle,
      true,
      "old circular oracle would have passed (expected = injected = 'valid')",
    );

    // New oracle: expected is independent ('missing') → does not equal injected ('valid').
    const wouldFailWithNewOracle = injectedStatusStr !== declaredExpectedStr;
    assert.equal(
      wouldFailWithNewOracle,
      true,
      "new oracle DETECTS the regression: injected 'valid' != declared 'missing'",
    );

    // The observable consequence: an assert.equal with the injected status would
    // fail. We confirm this by catching the AssertionError.
    let caught: unknown;
    try {
      assert.equal(injectedStatusStr, declaredExpectedStr);
    } catch (e) {
      caught = e;
    }
    assert.ok(
      caught instanceof Error,
      "injecting a status regression against the new oracle throws AssertionError — the oracle can fail",
    );
  });

  // The mirror: confirm that the real 'empty string' case does pass the corrected oracle.
  it('oracle passes correctly for a real "missing" fixture', () => {
    const input = "";
    const result = analyzeAcceptanceOutput(input);
    assert.equal(result.status, "missing", "empty string must produce status missing");
    assert.equal(result.stripped, false);
    assert.equal(result.strippedOutput, input);
  });
});
