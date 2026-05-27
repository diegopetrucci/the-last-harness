import assert from "node:assert/strict";
import test from "node:test";

import { buildReviewEnvelope, decideBranchAction, parseReviewArgs } from "../extensions/the-last-harness/review.ts";

// ─── (a) parseReviewArgs ───────────────────────────────────────────────────────

test("parseReviewArgs: empty argv returns pickerRequested", () => {
	assert.deepEqual(parseReviewArgs([]), { mode: null, pickerRequested: true });
});

test("parseReviewArgs: uncommitted mode with no extra", () => {
	assert.deepEqual(parseReviewArgs(["uncommitted"]), { mode: "uncommitted", extra: undefined });
});

test("parseReviewArgs: branch mode with base", () => {
	assert.deepEqual(parseReviewArgs(["branch", "main"]), { mode: "branch", base: "main", extra: undefined });
});

test("parseReviewArgs: branch mode without base yields undefined base", () => {
	assert.deepEqual(parseReviewArgs(["branch"]), { mode: "branch", base: undefined, extra: undefined });
});

test("parseReviewArgs: commit mode with sha", () => {
	assert.deepEqual(parseReviewArgs(["commit", "abc123"]), { mode: "commit", sha: "abc123", extra: undefined });
});

test("parseReviewArgs: pr mode with number string", () => {
	assert.deepEqual(parseReviewArgs(["pr", "42"]), { mode: "pr", nOrUrl: "42", extra: undefined });
});

test("parseReviewArgs: pr mode with full URL", () => {
	assert.deepEqual(parseReviewArgs(["pr", "https://github.com/o/r/pull/9"]), {
		mode: "pr",
		nOrUrl: "https://github.com/o/r/pull/9",
		extra: undefined,
	});
});

test("parseReviewArgs: folder mode with multiple paths", () => {
	assert.deepEqual(parseReviewArgs(["folder", "src", "docs"]), {
		mode: "folder",
		paths: ["src", "docs"],
		extra: undefined,
	});
});

test("parseReviewArgs: folder mode without paths yields empty array", () => {
	assert.deepEqual(parseReviewArgs(["folder"]), { mode: "folder", paths: [], extra: undefined });
});

test("parseReviewArgs: uncommitted mode with --extra flag", () => {
	assert.deepEqual(parseReviewArgs(["uncommitted", "--extra", "focus on perf"]), {
		mode: "uncommitted",
		extra: "focus on perf",
	});
});

test("parseReviewArgs: branch mode with base and --extra flag", () => {
	assert.deepEqual(parseReviewArgs(["branch", "main", "--extra", "x"]), {
		mode: "branch",
		base: "main",
		extra: "x",
	});
});

test("parseReviewArgs: --extra before mode positional is captured regardless of position", () => {
	assert.deepEqual(parseReviewArgs(["--extra", "x", "uncommitted"]), {
		mode: "uncommitted",
		extra: "x",
	});
});

test("parseReviewArgs: unknown mode falls back to pickerRequested", () => {
	assert.deepEqual(parseReviewArgs(["wat"]), { mode: null, pickerRequested: true });
});

// ─── (b) buildReviewEnvelope ───────────────────────────────────────────────────

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

test("buildReviewEnvelope: checkout ctx produces switched-from line", () => {
	const envelope = buildReviewEnvelope(
		{ mode: "pr", nOrUrl: "42", extra: undefined },
		{ checkout: { performed: true, priorBranch: "main" } },
	);
	const lines = envelope.split("\n");
	assert.ok(lines.includes("checkout: switched-from main"), "contains checkout: switched-from main");
});

test("buildReviewEnvelope: extra value appears after extra: label (not the none literal)", () => {
	const envelope = buildReviewEnvelope(
		{ mode: "uncommitted", extra: "watch perf" },
	);
	const lines = envelope.split("\n");
	const extraLabelIdx = lines.indexOf("extra:");
	assert.notEqual(extraLabelIdx, -1, "extra: label line is present");
	assert.equal(lines[extraLabelIdx + 1], "watch perf", "extra value is on the next line");
	assert.ok(!envelope.includes("extra: (none)"), "does not contain the none literal");
});

test("buildReviewEnvelope: multi-line extra is preserved verbatim", () => {
	const multiLineExtra = "line one\nline two\nline three";
	const envelope = buildReviewEnvelope(
		{ mode: "uncommitted", extra: multiLineExtra },
	);
	assert.ok(envelope.includes(multiLineExtra), "multi-line extra is preserved verbatim");
});

// ─── (c) decideBranchAction ────────────────────────────────────────────────────

// Regression: ensure the pure helper still produces all four expected outcomes
// after the gather-layer changes introduced by the review-fixes pass.
test("decideBranchAction regression: all four outcomes are stable", () => {
	// Same branch → always proceed regardless of dirty/confirm
	assert.equal(
		decideBranchAction({ currentBranch: "feat", prHead: "feat", isDirty: true, userConfirm: false }),
		"proceed",
	);
	// Mismatched + dirty → abort-dirty regardless of confirm
	assert.equal(
		decideBranchAction({ currentBranch: "main", prHead: "feat", isDirty: true, userConfirm: true }),
		"abort-dirty",
	);
	// Mismatched + clean + confirmed → switch
	assert.equal(
		decideBranchAction({ currentBranch: "main", prHead: "feat", isDirty: false, userConfirm: true }),
		"switch",
	);
	// Mismatched + clean + not confirmed → abort-cancelled
	assert.equal(
		decideBranchAction({ currentBranch: "main", prHead: "feat", isDirty: false, userConfirm: false }),
		"abort-cancelled",
	);
});

test("decideBranchAction: on-head branch returns proceed", () => {
	assert.equal(
		decideBranchAction({ currentBranch: "feature/x", prHead: "feature/x", isDirty: false, userConfirm: false }),
		"proceed",
	);
});

test("decideBranchAction: mismatched branch with dirty tree returns abort-dirty", () => {
	assert.equal(
		decideBranchAction({ currentBranch: "main", prHead: "feature/x", isDirty: true, userConfirm: false }),
		"abort-dirty",
	);
});

test("decideBranchAction: clean mismatch with user confirmation returns switch", () => {
	assert.equal(
		decideBranchAction({ currentBranch: "main", prHead: "feature/x", isDirty: false, userConfirm: true }),
		"switch",
	);
});

test("decideBranchAction: clean mismatch with no confirmation returns abort-cancelled", () => {
	assert.equal(
		decideBranchAction({ currentBranch: "main", prHead: "feature/x", isDirty: false, userConfirm: false }),
		"abort-cancelled",
	);
});
