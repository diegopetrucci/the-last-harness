import { assert, buildReviewEnvelope, test } from "./review-test-helpers.mjs";

test("buildReviewEnvelope: first line is exactly [/review]", () => {
  const envelope = buildReviewEnvelope({ mode: "uncommitted", extra: undefined });
  const firstLine = envelope.split("\n")[0];
  assert.equal(firstLine, "[/review]");
});

test("buildReviewEnvelope: branch+base with currentBranch ctx and no body contains expected metadata and pending fence", () => {
  const envelope = buildReviewEnvelope(
    { mode: "branch", base: "main", extra: undefined },
    { currentBranch: "feature/x" },
  );
  const lines = envelope.split("\n");

  assert.ok(lines.includes("mode: branch"), "contains mode: branch");
  assert.ok(lines.includes("base: main"), "contains base: main");
  assert.ok(lines.includes("current-branch: feature/x"), "contains current-branch: feature/x");
  assert.ok(lines.includes("extra: (none)"), "contains extra: (none) when extra is undefined");
  assert.ok(lines.includes("--- begin (pending) ---"), "contains begin pending fence");
  assert.ok(lines.includes("--- end (pending) ---"), "contains end pending fence");
});

test("buildReviewEnvelope: diff body is included verbatim inside diff fence", () => {
  const body = "DIFF\nBODY";
  const envelope = buildReviewEnvelope(
    { mode: "uncommitted", extra: undefined },
    { body, bodyKind: "diff" },
  );
  assert.ok(envelope.includes("--- begin diff ---"), "contains begin diff fence");
  assert.ok(envelope.includes("--- end diff ---"), "contains end diff fence");
  assert.ok(envelope.includes(body), "body is present verbatim");
  // Ensure body appears between the fences
  const beginIdx = envelope.indexOf("--- begin diff ---");
  const endIdx = envelope.indexOf("--- end diff ---");
  const bodyIdx = envelope.indexOf(body);
  assert.ok(beginIdx < bodyIdx && bodyIdx < endIdx, "body is between fence markers");
});

test("buildReviewEnvelope: snapshot body uses snapshot fence", () => {
  const envelope = buildReviewEnvelope(
    { mode: "folder", paths: ["src"], extra: undefined },
    { body: "SNAP", bodyKind: "snapshot" },
  );
  assert.ok(envelope.includes("--- begin snapshot ---"), "contains begin snapshot fence");
  assert.ok(envelope.includes("--- end snapshot ---"), "contains end snapshot fence");
  assert.ok(envelope.includes("SNAP"), "snapshot body is present");
});

test("buildReviewEnvelope: exact diff fence lines inside the body are escaped", () => {
  const envelope = buildReviewEnvelope(
    { mode: "uncommitted", extra: undefined },
    { body: "before\n--- end diff ---\nafter", bodyKind: "diff" },
  );
  assert.match(envelope, /\\--- end diff ---/);
});

test("buildReviewEnvelope: checkout ctx produces switched-from line", () => {
  const envelope = buildReviewEnvelope(
    { mode: "pr", nOrUrl: "42", extra: undefined },
    { checkout: { performed: true, priorBranch: "main" } },
  );
  const lines = envelope.split("\n");
  assert.ok(
    lines.includes("checkout: switched-from main"),
    "contains checkout: switched-from main",
  );
});

test("buildReviewEnvelope: extra value appears after extra: label (not the none literal)", () => {
  const envelope = buildReviewEnvelope({ mode: "uncommitted", extra: "watch perf" });
  const lines = envelope.split("\n");
  const extraLabelIdx = lines.indexOf("extra:");
  assert.notEqual(extraLabelIdx, -1, "extra: label line is present");
  assert.equal(lines[extraLabelIdx + 1], "watch perf", "extra value is on the next line");
  assert.ok(!envelope.includes("extra: (none)"), "does not contain the none literal");
});

test("buildReviewEnvelope: multi-line extra is preserved verbatim", () => {
  const multiLineExtra = "line one\nline two\nline three";
  const envelope = buildReviewEnvelope({ mode: "uncommitted", extra: multiLineExtra });
  assert.ok(envelope.includes(multiLineExtra), "multi-line extra is preserved verbatim");
});
