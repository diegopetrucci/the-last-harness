import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { composeReviewPrompt } = await jiti.import("../extensions/diff-review/prompt.ts");

test("composeReviewPrompt renders trimmed overall feedback across branch, commit, and all-files scopes", () => {
	const files = [
		{
			id: "renamed-file",
			path: "src/new-name.ts",
			gitDiff: { displayPath: "src/old-name.ts -> src/new-name.ts" },
		},
		{
			id: "readme",
			path: "README.md",
			gitDiff: null,
		},
	];

	assert.equal(
		composeReviewPrompt(files, {
			type: "submit",
			overallComment: "  Tighten naming and docs.  ",
			comments: [
				{
					id: "comment-1",
					fileId: "renamed-file",
					scope: "branch",
					side: "modified",
					startLine: 3,
					endLine: 5,
					body: "  tighten types  ",
				},
				{
					id: "comment-2",
					fileId: "renamed-file",
					scope: "commits",
					commitShort: "abc1234",
					commitKind: "commit",
					side: "original",
					startLine: 9,
					endLine: 9,
					body: "  revisit rename  ",
				},
				{
					id: "comment-3",
					fileId: "readme",
					scope: "all",
					side: "file",
					startLine: null,
					endLine: null,
					body: "  add release note  ",
				},
			],
		}),
		[
			"Please address the following feedback",
			"",
			"Tighten naming and docs.",
			"",
			"1. [branch diff] src/old-name.ts -> src/new-name.ts:3-5 (new)",
			"   tighten types",
			"",
			"2. [commit abc1234] src/old-name.ts -> src/new-name.ts:9 (old)",
			"   revisit rename",
			"",
			"3. [all files] README.md",
			"   add release note",
		].join("\n"),
	);
});

test("composeReviewPrompt falls back safely for missing files and working-tree commit comments", () => {
	assert.equal(
		composeReviewPrompt([], {
			type: "submit",
			overallComment: "   ",
			comments: [
				{
					id: "comment-1",
					fileId: "missing-file",
					scope: "commits",
					commitKind: "working-tree",
					side: "modified",
					startLine: 12,
					endLine: 12,
					body: "  verify the current file  ",
				},
				{
					id: "comment-2",
					fileId: "missing-file",
					scope: "all",
					side: "file",
					startLine: null,
					endLine: null,
					body: "  general note  ",
				},
			],
		}),
		[
			"Please address the following feedback",
			"",
			"1. [working tree changes] (unknown file):12 (new)",
			"   verify the current file",
			"",
			"2. [all files] (unknown file)",
			"   general note",
		].join("\n"),
	);
});
