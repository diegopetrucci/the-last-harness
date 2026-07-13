import { assert, decideBranchAction, test } from "./review-test-helpers.mjs";

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
