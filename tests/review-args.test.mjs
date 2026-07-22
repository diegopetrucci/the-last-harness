import { assert, parseReviewArgs, test } from "./review-test-helpers.mjs";

test("parseReviewArgs: empty argv requests the picker", () => {
	assert.deepEqual(parseReviewArgs([]), { pickerRequested: true });
});

test("parseReviewArgs: typed review args are rejected with picker-only guidance", () => {
	for (const argv of [
		["uncommitted"],
		["branch", "feature/parent"],
		["commit", "abc123"],
		["pr", "42"],
		["folder", "src"],
		["uncommitted", "--extra", "focus on perf"],
	]) {
		assert.deepEqual(parseReviewArgs(argv), {
			pickerRequested: false,
			message:
				"/review is picker-only. Run /review with no arguments, then choose a mode in the picker. Typed shortcuts like `/review pr 123` and `--extra` are no longer supported.",
		});
	}
});
