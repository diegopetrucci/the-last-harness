import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatForegroundNativeSubagentResult } from "../../src/intercom/result-intercom.ts";

describe("foreground native suffix budgeting", () => {
	it("retains a separately bounded Full patches reference for adversarially long paths", () => {
		const patchesPath = `/tmp/${"deep-segment/".repeat(120)}worktree-diffs`;
		const grouped = formatForegroundNativeSubagentResult({
			runId: "run-adversarial-worktree-suffix",
			mode: "parallel",
			children: [{ agent: "worker", status: "completed", summary: "x".repeat(7_000) }],
			suffixText: [
				"=== Worktree Changes ===",
				...Array.from({ length: 60 }, (_, index) => `task-${index}.ts | ${"+".repeat(100)}`),
				`Full patches: ${patchesPath}`,
			].join("\n"),
		});

		const patchesLine = grouped.text.match(/^Full patches: (.+)$/m)?.[1];
		assert.ok(patchesLine, "expected a protected Full patches reference line");
		assert.match(patchesLine, /^\/tmp\/deep-segment\//);
		assert.match(patchesLine, /\[reference truncated\]$/);
		assert.ok(patchesLine.length <= 500);
		assert.match(
			grouped.text,
			/\[suffix truncated; inspect retained details, artifacts, or sessions for full appended output\]/,
		);
		assert.ok(grouped.text.length <= 8_000);
	});
});
