import test from "node:test";
import assert from "node:assert/strict";

import type { Message } from "@earendil-works/pi-ai";

import {
	evaluateCompletionMutationGuard,
	expectsImplementationMutation,
	hasMutationToolCall,
} from "../../src/runs/shared/completion-guard.ts";
import { isMutatingBashCommand } from "../../src/runs/shared/long-running-guard.ts";
import { injectSingleOutputInstruction } from "../../src/runs/shared/single-output.ts";

function assistantToolCall(name: string, args: Record<string, unknown> = {}): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", name, arguments: args }],
	} as unknown as Message;
}

function assistantText(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	} as unknown as Message;
}

test("implementation task with no mutation triggers the completion guard", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Implement the approved fix",
		messages: [assistantText("Plan: update the files...")],
	});

	assert.deepEqual(result, {
		expectedMutation: true,
		attemptedMutation: false,
		triggered: true,
	});
});

test("declared read-only builtin tools suppress implementation-word false positives", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "architect",
		task: "Produce a proposal that implements the approved fix",
		messages: [assistantText("Proposal only")],
		tools: ["read", "grep", "find", "ls"],
	});

	assert.deepEqual(result, {
		expectedMutation: false,
		attemptedMutation: false,
		triggered: false,
	});
});

test("read-only issue drafting tasks do not trigger on suggested fix wording", () => {
	const task = "Draft GitHub issue for pi-subagents bug from current conversation. Include title, environment/context, reproduction steps, actual/expected, logs excerpt, suspected cause, suggested fix. Terse but complete. No tools needed.";
	const result = evaluateCompletionMutationGuard({
		agent: "delegate",
		task,
		messages: [assistantText("Title: completionGuard false positive\n\nSuggested fix: model read-only intent.")],
		tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
	});

	assert.deepEqual(result, {
		expectedMutation: false,
		attemptedMutation: false,
		triggered: false,
	});
	assert.equal(expectsImplementationMutation("worker", task), false);
	assert.equal(
		expectsImplementationMutation("worker", "Draft GitHub issue for a bug. Include suspected cause and suggested fix."),
		false,
	);
});

test("omitted, empty, bash, unknown, write, and MCP tool capabilities stay conservative", () => {
	const base = {
		agent: "architect",
		task: "Implement the approved source fix",
		messages: [assistantText("Validation only")],
	};

	assert.equal(evaluateCompletionMutationGuard(base).triggered, true);
	assert.equal(evaluateCompletionMutationGuard({ ...base, tools: [] }).triggered, true);
	assert.equal(evaluateCompletionMutationGuard({ ...base, tools: ["read", "bash", "ls"] }).triggered, true);
	assert.equal(evaluateCompletionMutationGuard({ ...base, tools: ["read", "custom_lookup"] }).triggered, true);
	assert.equal(evaluateCompletionMutationGuard({ ...base, tools: ["read", "write"] }).triggered, true);
	assert.equal(evaluateCompletionMutationGuard({ ...base, tools: ["read", "grep"], mcpDirectTools: ["github/search"] }).triggered, true);
});

test("worker with mutating-capable tools still triggers when no mutation is observed", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Fix the test implementation",
		messages: [assistantText("I will edit it next")],
		tools: ["read", "edit"],
	});

	assert.deepEqual(result, {
		expectedMutation: true,
		attemptedMutation: false,
		triggered: true,
	});
});

test("review-only, research, and framework output instructions do not expect mutation", () => {
	assert.equal(expectsImplementationMutation("worker", "Review only: return findings, do not edit"), false);
	assert.equal(expectsImplementationMutation("worker", "Do not edit files. Tell me how to fix the bug."), false);
	assert.equal(expectsImplementationMutation("worker", "Review the diff and suggest fixes only. Do not edit files."), false);
	assert.equal(expectsImplementationMutation("worker", "Implement this. Do not edit files outside this repo. Do not edit files."), false);
	assert.equal(expectsImplementationMutation("worker", "Investigate why this failed"), false);
	assert.equal(expectsImplementationMutation("researcher", "Research the API behavior"), false);
	assert.equal(expectsImplementationMutation("researcher", "Research this and patch the bug"), false);
	assert.equal(expectsImplementationMutation("reviewer", "Review this and fix any real issues"), false);
	assert.equal(expectsImplementationMutation("reviewer", "Review this and fix any real issues; regardless of findings, apply changes directly"), true);
	assert.equal(expectsImplementationMutation("worker", "[Write to: /tmp/result.md]\n\nSummarize findings"), false);
	assert.equal(expectsImplementationMutation("worker", injectSingleOutputInstruction("Summarize findings", "/tmp/fix.md")), false);
	assert.equal(expectsImplementationMutation("worker", "Write report"), false);
	assert.equal(expectsImplementationMutation("worker", "Create a report"), false);
	assert.equal(expectsImplementationMutation("worker", "Create a summary"), false);
	assert.equal(expectsImplementationMutation("worker", "Add a report"), false);
	assert.equal(expectsImplementationMutation("worker", "Update a summary"), false);
	assert.equal(expectsImplementationMutation("worker", "Write to {chain_dir}"), false);
	assert.equal(
		expectsImplementationMutation("worker", "Do async work\nUpdate progress at: /tmp/progress.md\n**Output:**\nWrite your findings to exactly this path: /tmp/out.md\nThis path is authoritative for this run.\nIgnore any other output filename or output path mentioned elsewhere."),
		false,
	);
	assert.equal(
		expectsImplementationMutation("worker", "Do async work\nThe harness will save your final response to: /tmp/legacy-out.md"),
		false,
	);
	assert.equal(
		expectsImplementationMutation("worker", "Do async work\nWrite your findings to: /tmp/legacy-short.md"),
		false,
	);
});

test("developer validation-only tasks with conditional source-change exceptions do not expect mutation", () => {
	for (const task of [
		[
			"Validate exactly one approved ticket: <ticket-id>.",
			"",
			"Before doing any work, run `tk show <ticket-id>` and follow it. This is a final-validation ticket for the <feature> fix; do not make source changes unless validation exposes a clear issue, and do not commit or push.",
			"",
			"Required validation:",
			"- Run `npm test`.",
			"- Inspect the targeted git diff for accidental behavior changes.",
			"- Confirm no ticket metadata files are staged or intended for the PR.",
			"- Report current branch, changed files, validation results, and any risks.",
			"",
			"If you find a problem, report it instead of broad refactoring.",
		].join("\n"),
		"Implement final validation ticket <ticket-id> only. First run `tk show <ticket-id>` and treat it as the source of truth. Do not make source changes unless a validation failure is caused by the current ticket changes and the fix is obviously within scope; if so, report the fix. Run `npm run validate` and report the exact result.",
	]) {
		const result = evaluateCompletionMutationGuard({
			agent: "developer",
			task,
			messages: [assistantText("Validation complete; no issues found.")],
		});

		assert.deepEqual(result, {
			expectedMutation: false,
			attemptedMutation: false,
			triggered: false,
		}, task);
	}
});

test("developer validation-only tasks do not treat observational docs/config/package mentions as edit requests", () => {
	for (const task of [
		"Validate the auth fix and confirm the docs still build. Do not make source changes unless validation exposes a clear issue.",
		"Validate the fix; confirm no config drift. Do not make source changes unless validation exposes a clear issue.",
		"Verify the package builds and the fix holds. Do not make source changes unless validation exposes a clear issue.",
	]) {
		const result = evaluateCompletionMutationGuard({
			agent: "developer",
			task,
			messages: [assistantText("Validation complete; no issues found.")],
		});

		assert.deepEqual(result, {
			expectedMutation: false,
			attemptedMutation: false,
			triggered: false,
		}, task);
	}
});

test("developer validation and docs tasks still expect mutation when repair or non-source edits are requested", () => {
	for (const task of [
		"Validate the fix and correct any issues you find.",
		"Validate the fix and fix any issues the tests expose.",
		"Update README and config docs for the validation workflow. Do not make source changes unless validation exposes a clear issue.",
		"Update the package manifest for the validation workflow. Do not make source changes unless validation exposes a clear issue.",
	]) {
		const result = evaluateCompletionMutationGuard({
			agent: "developer",
			task,
			messages: [assistantText("Plan: inspect and report back.")],
		});

		assert.deepEqual(result, {
			expectedMutation: true,
			attemptedMutation: false,
			triggered: true,
		}, task);
	}
});

test("worker implementation verbs win over investigative wording", () => {
	assert.equal(expectsImplementationMutation("worker", "Investigate why the worker did not edit files and fix it"), true);
	assert.equal(expectsImplementationMutation("worker", "Research the current code path and patch the bug"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix the bug where no edits were made"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix lint"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix the build"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix TypeScript errors"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix CI"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix the failing test"), true);
	assert.equal(expectsImplementationMutation("worker", "Patch the cold start test"), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the fix and return findings."), true);
});

test("non-worker implementation tasks still expect mutation", () => {
	assert.equal(expectsImplementationMutation("delegate", "Fix the bug where no edits were made"), true);
	assert.equal(expectsImplementationMutation("delegate", "Apply the suggested fix to src/runs/shared/completion-guard.ts"), true);
	assert.equal(expectsImplementationMutation("worker", "Draft a GitHub issue, then implement the fix"), true);
});

test("worker edit intent covers common docs, config, and source tasks", () => {
	assert.equal(expectsImplementationMutation("worker", "Update README to mention the native tool"), true);
	assert.equal(expectsImplementationMutation("worker", "Remove share functionality and all Vercel references"), true);
	assert.equal(expectsImplementationMutation("worker", "Replace the registered command with a render tool"), true);
	assert.equal(expectsImplementationMutation("worker", "Create completion-guard.ts"), true);
	assert.equal(expectsImplementationMutation("worker", "Add tests for the completion guard"), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the approved fixes. Do not edit files outside this repo."), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the fix. Do not edit unrelated files."), true);
});

test("edit and write tool calls count as mutation attempts", () => {
	assert.equal(hasMutationToolCall([assistantToolCall("edit", { path: "a.ts" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("write", { path: "a.ts" })]), true);
});

test("obvious mutating bash commands count as mutation attempts", () => {
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "mkdir -p src && cat > src/file.ts <<'EOF'\nhi\nEOF" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "cat <<'EOF' > src/file.ts\nhi\nEOF" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "python3 -c \"from pathlib import Path; Path('x').write_text('hi')\"" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "python3 <<'PY'\nfrom pathlib import Path\nPath('x').write_text('hi')\nPY" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "node <<'JS'\nfs.writeFileSync('x', 'hi')\nJS" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "node script.js > generated.txt" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "echo 'a > b'" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "node -e \"console.log(a > b)\"" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "python3 <<'PY'\nprint('inspect only')\nPY" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "cat <<'EOF'\nfrom pathlib import Path\nPath('x').write_text('hi')\nEOF" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "cat <<'EOF'\ngh pr create --fill\nEOF" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "cat <<'EOF'\nrm -rf build\nEOF" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "echo 'rm file'" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "printf \"mkdir x\"" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "git apply patch.diff" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "patch -p0 < fix.patch" })]), true);
});

test("VCS, PR, and release bash commands are classified narrowly", () => {
	for (const command of [
		"git add src/runs/shared/long-running-guard.ts",
		"git commit -m 'Teach completion guard about VCS mutations'",
		"git -C repo commit -m 'Teach completion guard about VCS mutations'",
		"git -c user.name=tlh commit -m 'Teach completion guard about VCS mutations'",
		"git push origin HEAD",
		"git merge origin/main",
		"git rebase origin/main",
		"git reset --hard HEAD~1",
		"git clean -fd",
		"git restore src/runs/shared/long-running-guard.ts",
		"git cherry-pick abc1234",
		"git revert abc1234 --no-edit",
		"git rm src/runs/shared/long-running-guard.ts",
		"git mv old.ts new.ts",
		"git branch tlh-zt7e-completion-guard-vcs",
		"git branch -d tlh-zt7e-completion-guard-vcs",
		"git branch -m old-branch new-branch",
		"git stash",
		"git stash push -m 'checkpoint'",
		"git stash pop",
		"git stash apply stash@{0}",
		"git stash drop stash@{0}",
		"git stash clear",
		"git tag v0.26.1",
		"git checkout -b tlh-zt7e-completion-guard-vcs",
		"git checkout -B tlh-zt7e-completion-guard-vcs",
		"git switch -c tlh-zt7e-completion-guard-vcs",
		"git switch -C tlh-zt7e-completion-guard-vcs",
		"gh pr create --fill",
		"gh -R owner/repo pr create --fill",
		"gh pr close 123 --comment 'done'",
		"gh pr reopen 123",
		"gh pr ready 123 --undo=false",
		"gh pr edit 123 --title 'Updated title'",
		"gh pr comment 123 --body 'done'",
		"gh pr review 123 --approve",
		"gh pr merge 123 --squash",
		"gh api repos/octo/repo/pulls --method POST -f title='Fix guard'",
		"gh --repo owner/repo api repos/octo/repo/pulls -X POST -f title='Fix guard'",
		"gh api repos/octo/repo/pulls -XPATCH -f title='Fix guard'",
		"gh api repos/octo/repo/pulls --method PUT -f title='Fix guard'",
		"gh api repos/octo/repo/pulls/123 --request DELETE",
		"gh api repos/octo/repo/pulls -f title='Fix guard'",
		"gh api repos/octo/repo/pulls -F title='Fix guard'",
		"gh api repos/octo/repo/pulls --raw-field title='Fix guard'",
		"gh api repos/octo/repo/pulls --field title='Fix guard'",
		"gh release create v0.26.1 --notes 'release notes'",
		"gh release edit v0.26.1 --draft=false",
		"gh release delete v0.26.1 --yes",
		"gh release delete-asset v0.26.1 dist.tgz --yes",
		"gh release upload v0.26.1 dist.tgz",
	]) {
		assert.equal(isMutatingBashCommand(command), true, command);
	}

	for (const command of [
		"git status --short",
		"git diff --stat",
		"git log --oneline -5",
		"git show HEAD~1",
		"git --no-pager status --short",
		"git tag",
		"git tag -l 'v0.*'",
		"git branch",
		"git branch --show-current",
		"git branch --merged main",
		"git stash list",
		"git stash show stash@{0}",
		"git grep rm src",
		"git reset",
		"git clean -nfd",
		"gh pr view 123 --json url",
		"gh -R owner/repo pr view 123 --json url",
		"gh api rate_limit",
		"gh api repos/octo/repo/pulls --method GET -f title='Fix guard'",
		"gh api repos/octo/repo/pulls -X GET --field title='Fix guard'",
		"gh release view v0.26.1",
		"git --help commit",
		"git --version commit",
		"gh --help pr create",
		"gh --version pr create",
	]) {
		assert.equal(isMutatingBashCommand(command), false, command);
	}
});

test("oracle, librarian, web-scout, and contrarian advisory agents do not expect mutation regardless of task verbs", () => {
	assert.equal(expectsImplementationMutation("oracle", "Please fix the broken test"), false);
	assert.equal(expectsImplementationMutation("oracle", "Implement a review of this PR"), false);
	assert.equal(expectsImplementationMutation("librarian", "Research this and patch the bug"), false);
	assert.equal(expectsImplementationMutation("web-scout", "Fix the failing search results"), false);
	assert.equal(expectsImplementationMutation("web_scout", "Fix the failing search results"), false);
	assert.equal(expectsImplementationMutation("contrarian", "Implement the guard fix"), false);
	assert.equal(expectsImplementationMutation("team.contrarian", "Fix the failing search results"), false);
});

test("evaluateCompletionMutationGuard returns triggered:false for advisory runs without edits", () => {
	for (const agent of ["oracle", "librarian", "web-scout", "contrarian"]) {
		const result = evaluateCompletionMutationGuard({
			agent,
			task: "Fix the failing test — provide your analysis",
			messages: [assistantText("Here is my analysis of the failure...")],
		});

		assert.deepEqual(result, {
			expectedMutation: false,
			attemptedMutation: false,
			triggered: false,
		}, agent);
	}
});

test("implementation task with mutation attempts does not trigger", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Fix the failing test",
		messages: [assistantToolCall("edit", { path: "test.ts" })],
	});

	assert.equal(result.triggered, false);
});

test("implementation task completed through VCS or PR bash mutations does not trigger", () => {
	for (const command of [
		"git commit -m 'Implement approved fix'",
		"git clean -fd",
		"git rm src/runs/shared/long-running-guard.ts",
		"gh pr close 123 --comment 'Implemented approved fix'",
		"gh pr create --fill",
		"gh api repos/octo/repo/pulls -f title='Implement approved fix'",
	]) {
		const result = evaluateCompletionMutationGuard({
			agent: "worker",
			task: "Implement the approved fix",
			messages: [assistantToolCall("bash", { command })],
		});

		assert.deepEqual(result, {
			expectedMutation: true,
			attemptedMutation: true,
			triggered: false,
		}, command);
	}
});

test("read-only git and gh bash commands do not satisfy the completion guard", () => {
	for (const command of [
		"git --help commit",
		"git --version commit",
		"git grep rm src",
		"gh --help pr create",
		"gh --version pr create",
	]) {
		const result = evaluateCompletionMutationGuard({
			agent: "worker",
			task: "Implement the approved fix",
			messages: [assistantToolCall("bash", { command })],
		});

		assert.deepEqual(result, {
			expectedMutation: true,
			attemptedMutation: false,
			triggered: true,
		}, command);
	}
});

test("qualified agent names are classified by local name", () => {
	assert.equal(expectsImplementationMutation("oracle.worker", "Fix the broken test"), true);
	assert.equal(expectsImplementationMutation("librarian.editor", "Implement the change"), true);
	assert.equal(expectsImplementationMutation("code-analysis.scout", "Fix the indexer"), false);
	assert.equal(expectsImplementationMutation("code-analysis.reviewer", "Review and fix issues"), false);
	assert.equal(expectsImplementationMutation("code-analysis.reviewer", "Review and fix issues; regardless of findings, apply changes directly"), true);
	assert.equal(expectsImplementationMutation("reviewer.worker", "Fix the bug"), true);
	assert.equal(expectsImplementationMutation("contrarian.worker", "Fix the bug"), true);
});
