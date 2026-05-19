import assert from "node:assert/strict";
import test from "node:test";

import {
	formatGitStatusFooterSegment,
	formatPullRequestFooterSegment,
	formatTlhGitFooterSegments,
	parseGitStatusPorcelainV2,
} from "../extensions/the-last-harness/footer-git.mjs";

const HASH = "1234567890abcdef1234567890abcdef12345678";

function ordinaryStatusLine(xy, path) {
	return `1 ${xy} N... 100644 100644 100644 ${HASH} ${HASH} ${path}`;
}

function renameOrCopyStatusLine(xy, score, path, originalPath) {
	return `2 ${xy} N... 100644 100644 100644 ${HASH} ${HASH} ${score} ${path}\t${originalPath}`;
}

test("parses clean porcelain-v2 status without formatting a clean marker", () => {
	const status = parseGitStatusPorcelainV2(`# branch.oid ${HASH}
# branch.head main
`);

	assert.deepEqual(status, {
		branch: "main",
		staged: 0,
		unstaged: 0,
		untracked: 0,
		conflict: 0,
		ahead: 0,
		behind: 0,
	});
	assert.equal(formatGitStatusFooterSegment(status), undefined);
	assert.deepEqual(formatTlhGitFooterSegments(status), ["main"]);
	assert.equal(formatTlhGitFooterSegments(status).join(" • "), "main");
});

test("parses and formats staged, unstaged, and untracked porcelain-v2 status", () => {
	const status = parseGitStatusPorcelainV2(`# branch.oid ${HASH}
# branch.head feature/git-footer
${ordinaryStatusLine("M.", "staged.txt")}
${ordinaryStatusLine(".M", "unstaged.txt")}
${ordinaryStatusLine("MM", "both.txt")}
? untracked.txt
`);

	assert.deepEqual(status, {
		branch: "feature/git-footer",
		staged: 2,
		unstaged: 2,
		untracked: 1,
		conflict: 0,
		ahead: 0,
		behind: 0,
	});
	assert.equal(formatGitStatusFooterSegment(status), "+2 ~2 ?1");
	assert.deepEqual(formatTlhGitFooterSegments(status), ["feature/git-footer", "+2 ~2 ?1"]);
});

test("parses CRLF detached status with rename/copy entries in stable marker order", () => {
	const status = parseGitStatusPorcelainV2(
		[
			"# branch.ab +1 -2",
			`u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} conflicted.txt`,
			"? untracked.txt",
			renameOrCopyStatusLine("R.", "R100", "renamed.txt", "old.txt"),
			"# branch.head (detached)",
			renameOrCopyStatusLine("CM", "C75", "copied.txt", "source.txt"),
		].join("\r\n") + "\r\n",
	);

	assert.deepEqual(status, {
		branch: "detached",
		staged: 2,
		unstaged: 1,
		untracked: 1,
		conflict: 1,
		ahead: 1,
		behind: 2,
	});
	assert.equal(formatGitStatusFooterSegment(status), "!1 +2 ~1 ?1 ↑1 ↓2");
	assert.deepEqual(formatTlhGitFooterSegments(status), ["detached", "!1 +2 ~1 ?1 ↑1 ↓2"]);
});

test("parses and formats conflicted porcelain-v2 status", () => {
	const status = parseGitStatusPorcelainV2(`# branch.head merge-branch
u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} conflicted.txt
`);

	assert.deepEqual(status, {
		branch: "merge-branch",
		staged: 0,
		unstaged: 0,
		untracked: 0,
		conflict: 1,
		ahead: 0,
		behind: 0,
	});
	assert.equal(formatGitStatusFooterSegment(status), "!1");
	assert.deepEqual(formatTlhGitFooterSegments(status), ["merge-branch", "!1"]);
});

test("parses and formats ahead and behind counts", () => {
	const status = parseGitStatusPorcelainV2(`# branch.oid ${HASH}
# branch.head main
# branch.upstream origin/main
# branch.ab +3 -2
`);

	assert.equal(status.ahead, 3);
	assert.equal(status.behind, 2);
	assert.equal(formatGitStatusFooterSegment(status), "↑3 ↓2");
	assert.equal(formatTlhGitFooterSegments(status).join(" • "), "main • ↑3 ↓2");
});

test("formats pull request metadata as a footer segment", () => {
	const status = parseGitStatusPorcelainV2(`# branch.head feature/pr
# branch.ab +1 -0
${ordinaryStatusLine("M.", "staged.txt")}
${ordinaryStatusLine(".M", "unstaged-1.txt")}
${ordinaryStatusLine(".M", "unstaged-2.txt")}
? untracked.txt
`);

	assert.equal(formatPullRequestFooterSegment({ number: 42, state: "OPEN", isDraft: false }), "PR #42");
	assert.equal(formatPullRequestFooterSegment({ number: " 9007199254740993 " }), "PR #9007199254740993");
	assert.deepEqual(formatTlhGitFooterSegments(status, { number: 42, title: "Improve footer" }), [
		"feature/pr",
		"+1 ~2 ?1 ↑1",
		"PR #42",
	]);
	assert.equal(formatTlhGitFooterSegments(status, { number: 42 }).join(" • "), "feature/pr • +1 ~2 ?1 ↑1 • PR #42");
});
