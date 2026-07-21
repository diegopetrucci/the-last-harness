import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";

const helperSource = readFileSync(
	new URL("../extensions/annotate-git-diff/web/review-state.js", import.meta.url),
	"utf8",
);

function loadReconcileHelper() {
	const context = vm.createContext({});
	vm.runInContext(helperSource, context, { filename: "review-state.js" });
	return context.__reconcileReviewCommitState;
}

function commit(sha, kind = "commit") {
	return { sha, kind };
}

function file(id) {
	return { id };
}

test("review-data commit reconciliation preserves only retained immutable success and pending state", () => {
	const reconcile = loadReconcileHelper();
	const workingTreeSha = "__tlh_working_tree__";
	const previousCommits = [commit("retained"), commit("completed-removed"), commit("pending-removed"), commit(workingTreeSha, "working-tree")];
	const nextCommits = [commit("retained"), commit(workingTreeSha, "working-tree")];
	const state = {
		commitFilesBySha: {
			retained: [file("retained.txt")],
			"completed-removed": [file("completed.txt")],
			[workingTreeSha]: [file("working.txt")],
		},
		commitErrors: {
			retained: "retry commit",
			"completed-removed": "old commit error",
			[workingTreeSha]: "old working error",
		},
		commitRequestIds: {
			retained: "retained-commit-request",
			"pending-removed": "removed-commit-request",
			[workingTreeSha]: "working-commit-request",
		},
		fileContents: {
			"commits:retained:retained.txt": { modifiedContent: "retained" },
			"commits:completed-removed:completed.txt": { modifiedContent: "stale" },
			[`commits:${workingTreeSha}:working.txt`]: { modifiedContent: "mutable" },
		},
		fileErrors: {
			"commits:retained:failed.txt": "retry file",
			"commits:completed-removed:failed.txt": "stale file error",
			[`commits:${workingTreeSha}:failed.txt`]: "working file error",
		},
		pendingRequestIds: {
			"commits:retained:pending.txt": "retained-file-request",
			"commits:pending-removed:pending.txt": "removed-file-request",
			[`commits:${workingTreeSha}:pending.txt`]: "working-file-request",
		},
		comments: [
			{ id: "retained-comment", scope: "commits", commitSha: "retained" },
			{ id: "completed-comment", scope: "commits", commitSha: "completed-removed" },
			{ id: "pending-comment", scope: "commits", commitSha: "pending-removed" },
			{ id: "working-comment", scope: "commits", commitSha: workingTreeSha },
		],
		reviewedFiles: {
			"retained.txt": true,
			"completed.txt": true,
			"working.txt": true,
		},
		scrollPositions: {
			"commits:retained:retained.txt": { modifiedTop: 1 },
			"commits:completed-removed:completed.txt": { modifiedTop: 2 },
			"commits:pending-removed:pending.txt": { modifiedTop: 3 },
			[`commits:${workingTreeSha}:working.txt`]: { modifiedTop: 4 },
		},
	};

	reconcile(state, previousCommits, nextCommits);

	assert.deepEqual(state.commitFilesBySha, { retained: [file("retained.txt")] });
	assert.deepEqual(state.commitRequestIds, { retained: "retained-commit-request" });
	assert.deepEqual(state.commitErrors, {});
	assert.deepEqual(state.fileContents, {
		"commits:retained:retained.txt": { modifiedContent: "retained" },
	});
	assert.deepEqual(state.fileErrors, {});
	assert.deepEqual(state.pendingRequestIds, {
		"commits:retained:pending.txt": "retained-file-request",
	});
	assert.deepEqual(state.comments, [{ id: "retained-comment", scope: "commits", commitSha: "retained" }]);
	assert.deepEqual(state.reviewedFiles, { "retained.txt": true });
	assert.deepEqual(state.scrollPositions, {
		"commits:retained:retained.txt": { modifiedTop: 1 },
	});

	const readdedCommits = [commit("retained"), commit("completed-removed"), commit("pending-removed")];
	reconcile(state, nextCommits, readdedCommits);
	assert.equal(state.commitFilesBySha["completed-removed"], undefined);
	assert.equal(state.commitRequestIds["pending-removed"], undefined);
	assert.equal(state.fileContents["commits:completed-removed:completed.txt"], undefined);
	assert.equal(state.pendingRequestIds["commits:pending-removed:pending.txt"], undefined);
});

test("review UI inlines commit reconciliation before app refresh handling", async () => {
	const jiti = createJiti(import.meta.url);
	const { buildReviewHtml } = await jiti.import("../extensions/annotate-git-diff/ui.ts");
	const html = buildReviewHtml({
		repoRoot: "/repo",
		files: [],
		commits: [],
		branchBaseRef: null,
		branchMergeBaseSha: null,
		repositoryHasHead: true,
	});
	const helperIndex = html.indexOf("global.__reconcileReviewCommitState = reconcileReviewCommitState");
	const appCallIndex = html.indexOf("window.__reconcileReviewCommitState(state, reviewData.commits, nextCommits)");
	assert.ok(helperIndex >= 0, "built review HTML must inline the state reconciliation helper");
	assert.ok(appCallIndex > helperIndex, "app refresh handling must call the helper after it is defined");
	assert.doesNotMatch(html, /__INLINE_REVIEW_STATE_JS__/);
});
