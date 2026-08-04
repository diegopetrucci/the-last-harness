import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	acceptanceFailureMessage,
	aggregateAcceptanceReport,
	appendAcceptanceReportDigest,
	buildAcceptanceReportDigest,
	evaluateAcceptance,
	formatAcceptancePrompt,
	mergeContinuationAcceptance,
	parseAcceptanceReport,
	resolveEffectiveAcceptance,
	stripAcceptanceReport,
	validateAcceptanceInput,
	validateDispatchAcceptanceInput,
} from "../../src/runs/shared/acceptance.ts";
import type { AcceptanceReport } from "../../src/shared/types.ts";

function reportData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "verified in test" }],
		changedFiles: ["src/file.ts"],
		testsAddedOrUpdated: ["test/file.test.ts"],
		commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
		validationOutput: ["tests passed"],
		residualRisks: [],
		noStagedFiles: true,
		notes: "complete",
		...overrides,
	};
}

function report(overrides: Record<string, unknown> = {}, fence = "acceptance-report"): string {
	return [
		"done",
		`\`\`\`${fence}`,
		JSON.stringify(reportData(overrides)),
		"```",
	].join("\n");
}

function tempRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-acceptance-"));
	fs.writeFileSync(path.join(dir, "file.txt"), "hello\n", "utf-8");
	return dir;
}

describe("acceptance gates", () => {
	it("infers only self-contained acceptance levels across reviewer, writer, async, dynamic, and risky contexts", () => {
		assert.equal(resolveEffectiveAcceptance({ agentName: "reviewer", task: "Review-only. Do not edit.", mode: "single" }).level, "attested");
		assert.equal(resolveEffectiveAcceptance({ agentName: "reviewer", task: "Review-only. Do not edit.", mode: "single", async: true }).level, "attested");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Review-only. Do not edit.", mode: "chain", dynamic: true }).level, "attested");
		assert.equal(resolveEffectiveAcceptance({ agentName: "reviewer", task: "Summarize findings without edits.", mode: "chain", dynamicGroup: true }).level, "attested");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "single" }).level, "checked");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "single", async: true }).level, "checked");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Fix each item", mode: "chain", dynamic: true }).level, "checked");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Run the migration", mode: "single" }).level, "checked");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "chain", dynamicGroup: true }).level, "checked");
	});

	it("uses explicit agent roles for ambiguous tasks while preserving task-intent precedence", () => {
		assert.equal(resolveEffectiveAcceptance({
			agentName: "explorer",
			acceptanceRole: "read-only",
			task: "Explore the authentication flow",
			mode: "single",
		}).level, "attested");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "reviewer",
			acceptanceRole: "writer",
			task: "Handle the authentication flow",
			mode: "single",
		}).level, "checked");
		for (const task of ["Implement the authentication fix", "Create a fixture", "Add coverage", "Replace the dependency", "Patch src/auth.ts"]) {
			assert.equal(resolveEffectiveAcceptance({
				agentName: "worker",
				acceptanceRole: "read-only",
				task,
				mode: "single",
			}).level, "checked", task);
		}
		assert.equal(resolveEffectiveAcceptance({
			agentName: "worker",
			acceptanceRole: "read-only",
			task: "Patch src/auth.ts",
			mode: "single",
			async: true,
		}).level, "checked");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "worker",
			acceptanceRole: "read-only",
			task: "Create a report",
			mode: "single",
		}).level, "attested");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "worker",
			acceptanceRole: "writer",
			task: "Review only; do not edit files",
			mode: "single",
		}).level, "attested");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "reviewer",
			acceptanceRole: "writer",
			task: "Handle the authentication flow",
			mode: "single",
			async: true,
		}).level, "checked");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "worker",
			acceptanceRole: "read-only",
			task: "Explore the authentication flow",
			mode: "single",
		}).level, "attested");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "explorer",
			acceptanceRole: "read-only",
			task: "Audit the security posture",
			mode: "single",
		}).level, "attested");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "explorer",
			acceptanceRole: "read-only",
			task: "Explore each target",
			mode: "chain",
			dynamic: true,
		}).level, "attested");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "worker",
			acceptanceRole: "writer",
			task: "Review only; do not edit files",
			mode: "chain",
			dynamicGroup: true,
		}).level, "attested");
		assert.equal(resolveEffectiveAcceptance({
			agentName: "reviewer",
			task: "Review each target",
			mode: "chain",
			dynamic: true,
		}).level, "attested");
	});

	it("preserves legacy inference byte-for-byte when acceptance role metadata is omitted", () => {
		// Pinned empirically against origin/main (parity worktree check, ts-zj05):
		// role-less inference must keep the fork's pre-role heuristics, where
		// read-only task wording ("inspect", "read-only") wins before risky keywords
		// and "write" counts as a write verb even for report deliverables.
		const matrix: Array<[string, string, "attested" | "checked"]> = [
			["worker", "Inspect the failure and implement the fix", "attested"],
			["worker", "Write a report on the API", "checked"],
			["worker", "Inspect the security posture", "attested"],
			["worker", "Read-only security audit", "attested"],
			["worker", "Do not modify tests; implement the fix", "checked"],
			["explorer", "Explore the repo structure", "attested"],
			["worker", "Migrate the database schema", "checked"],
			["code-reviewer", "Review the PR for regressions", "attested"],
		];
		for (const [agentName, task, level] of matrix) {
			assert.equal(resolveEffectiveAcceptance({ agentName, task }).level, level, `${agentName} :: ${task}`);
		}
		// Dynamic context still escalates role-less non-read-only agents unconditionally, as on main.
		assert.equal(resolveEffectiveAcceptance({ agentName: "explorer", task: "Explore each target", mode: "chain", dynamic: true }).level, "checked");
	});

	it("merge continuation retains inferred provenance for empty or auto overrides", () => {
		const base = resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "single" });
		assert.equal(base.explicit, false);

		assert.equal(mergeContinuationAcceptance(base, undefined)?.explicit, false);
		assert.equal(mergeContinuationAcceptance(base, {})?.explicit, false);
		assert.equal(mergeContinuationAcceptance(base, "auto")?.explicit, false);
		assert.equal(mergeContinuationAcceptance(base, { level: "auto" })?.explicit, false);

		const strengthenedLevel = mergeContinuationAcceptance(base, { level: "verified", verify: [{ id: "ok", command: "node --version" }] });
		assert.equal(strengthenedLevel?.explicit, true);
		assert.equal(strengthenedLevel?.level, "verified");
		const strengthenedCriteria = mergeContinuationAcceptance(base, { criteria: ["Keep the fix minimal"] });
		assert.equal(strengthenedCriteria?.explicit, true);

		const explicitBase = resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "single", explicit: { level: "checked" } });
		assert.equal(mergeContinuationAcceptance(explicitBase, {})?.explicit, true);
	});

	it("merge continuation dedupes verify commands by execution identity, not id", () => {
		const base = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement the fix",
			mode: "single",
			explicit: { level: "verified", verify: [{ id: "a", command: "npm test" }] },
		});

		const sameCommandNewId = mergeContinuationAcceptance(base, { verify: [{ id: "b", command: "npm test" }] });
		assert.equal(sameCommandNewId?.verify.length, 1);
		assert.equal(sameCommandNewId?.verify[0]?.id, "a");

		const distinctCwd = mergeContinuationAcceptance(base, { verify: [{ id: "c", command: "npm test", cwd: "/tmp" }] });
		assert.equal(distinctCwd?.verify.length, 2);

		const distinctEnv = mergeContinuationAcceptance(base, { verify: [{ id: "d", command: "npm test", env: { CI: "1" } }] });
		assert.equal(distinctEnv?.verify.length, 2);

		const distinctCommand = mergeContinuationAcceptance(base, { verify: [{ id: "e", command: "npm run lint" }] });
		assert.equal(distinctCommand?.verify.length, 2);
	});

	it("explicit acceptance can strengthen inferred policy", () => {
		const resolved = resolveEffectiveAcceptance({
			agentName: "reviewer",
			task: "Review-only.",
			explicit: { level: "verified", verify: [{ id: "ok", command: "node --version" }] },
		});

		assert.equal(resolved.level, "verified");
		assert.equal(resolved.verify[0]?.id, "ok");
	});

	it("formats a standardized child prompt section", () => {
		const resolved = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { level: "checked", criteria: ["Patch the bug"], stopRules: ["Do not stop after analysis"] },
		});
		const prompt = formatAcceptancePrompt(resolved);

		assert.match(prompt, /## Acceptance Contract/);
		assert.match(prompt, /Acceptance level: checked/);
		assert.match(prompt, /Patch the bug/);
		assert.match(prompt, /```acceptance-report/);
		assert.match(prompt, /array fields contain strings/);
		assert.match(prompt, /"reviewFindings": \[\n    "blocker:/);
	});

	it("parses acceptance-report fences and ignores unrelated json fences", () => {
		const parsed = parseAcceptanceReport(report());

		assert.ok(parsed.report);
		assert.deepEqual(parsed.report.changedFiles, ["src/file.ts"]);
		assert.equal(parsed.error, undefined);

		const genericJson = parseAcceptanceReport(`done\n\
\
\`\`\`json\n{\"notes\":\"not an acceptance report\"}\n\`\`\``);
		assert.equal(genericJson.report, undefined);
		assert.match(genericJson.error ?? "", /Structured acceptance report not found/);

		const criteriaOnlyJson = parseAcceptanceReport(`done\n\
\
\`\`\`json\n{\"criteriaSatisfied\":[{\"id\":\"criterion-1\",\"status\":\"satisfied\",\"evidence\":\"example\"}]}\n\`\`\``);
		assert.equal(criteriaOnlyJson.report, undefined);
		assert.match(criteriaOnlyJson.error ?? "", /Structured acceptance report not found/);

		const invalidSignalJson = `done\n\
\
\`\`\`json\n{\"criteriaSatisfied\":[{\"id\":\"criterion-1\",\"status\":\"satisfied\",\"evidence\":\"example\"}],\"changedFiles\":false}\n\`\`\``;
		const genericJsonWithInvalidSignal = parseAcceptanceReport(invalidSignalJson);
		assert.equal(genericJsonWithInvalidSignal.report, undefined);
		assert.match(genericJsonWithInvalidSignal.error ?? "", /Structured acceptance report not found/);
		assert.equal(stripAcceptanceReport(invalidSignalJson), invalidSignalJson);

		const partialWrapperJson = `done\n\
\
\`\`\`json\n{\"acceptance\":{\"changedFiles\":[\"src/file.ts\"]}}\n\`\`\``;
		const genericJsonWithPartialWrapper = parseAcceptanceReport(partialWrapperJson);
		assert.equal(genericJsonWithPartialWrapper.report, undefined);
		assert.match(genericJsonWithPartialWrapper.error ?? "", /Structured acceptance report not found/);
		assert.equal(stripAcceptanceReport(partialWrapperJson), partialWrapperJson);

		const reportShapedJson = `done\n\
\
\`\`\`json\n{\"changedFiles\":[\"src/file.ts\"]}\n\`\`\``;
		const genericReportShapedJson = parseAcceptanceReport(reportShapedJson);
		assert.equal(genericReportShapedJson.report, undefined);
		assert.match(genericReportShapedJson.error ?? "", /Structured acceptance report not found/);
		assert.equal(stripAcceptanceReport(reportShapedJson), reportShapedJson);

		const malformed = parseAcceptanceReport("```acceptance-report\n{bad-json\n```");
		assert.equal(malformed.report, undefined);
		assert.match(malformed.error ?? "", /Failed to parse acceptance-report/);
	});

	it("parses acceptance reports from json-family fences", () => {
		for (const fence of ["json", "jsonc", "json5"]) {
			const output = report({}, fence);
			const parsed = parseAcceptanceReport(output);

			assert.ok(parsed.report);
			assert.deepEqual(parsed.report.changedFiles, ["src/file.ts"]);
			assert.equal(parsed.error, undefined);
			assert.equal(stripAcceptanceReport(output), "done");
		}
	});

	it("strips trailing json-family reports after earlier unrelated json fences", () => {
		const output = [
			"metadata",
			"```json",
			JSON.stringify({ notes: "not an acceptance report" }),
			"```",
			"done",
			"```json",
			JSON.stringify(reportData()),
			"```",
		].join("\n");
		const parsed = parseAcceptanceReport(output);

		assert.ok(parsed.report);
		assert.equal(stripAcceptanceReport(output), [
			"metadata",
			"```json",
			JSON.stringify({ notes: "not an acceptance report" }),
			"```",
			"done",
		].join("\n"));
	});

	it("unwraps acceptance-report wrapper objects", () => {
		const output = [
			"done",
			"```json",
			JSON.stringify({ "acceptance-report": reportData() }),
			"```",
		].join("\n");
		const parsed = parseAcceptanceReport(output);

		assert.ok(parsed.report);
		assert.deepEqual(parsed.report.testsAddedOrUpdated, ["test/file.test.ts"]);
		assert.equal(stripAcceptanceReport(output), "done");
	});

	it("reports field-level validation errors for malformed acceptance-report fields", () => {
		const invalidReviewerReport = parseAcceptanceReport(report({
			reviewFindings: [{ id: "B-1", severity: "blocker", finding: "Missing evidence" }],
		}));
		assert.equal(invalidReviewerReport.report, undefined);
		assert.match(invalidReviewerReport.error ?? "", /reviewFindings\[0\]: expected string; got object/);

		const invalidCommandReport = parseAcceptanceReport(report({
			commandsRun: [{ command: "npm test", exitCode: 0 }],
		}));
		assert.equal(invalidCommandReport.report, undefined);
		assert.match(invalidCommandReport.error ?? "", /commandsRun\[0\]\.result: expected one of "passed", "failed", "not-run"; got missing/);
		assert.match(invalidCommandReport.error ?? "", /commandsRun\[0\]\.summary: expected string; got missing/);

		const invalidCriteriaReport = parseAcceptanceReport(report({
			criteriaSatisfied: [{ id: 7, status: "done", evidence: "" }],
		}));
		assert.equal(invalidCriteriaReport.report, undefined);
		assert.match(invalidCriteriaReport.error ?? "", /criteriaSatisfied\[0\]\.id: expected string; got number 7/);
		assert.match(invalidCriteriaReport.error ?? "", /criteriaSatisfied\[0\]\.status: expected one of "satisfied", "not-satisfied", "not-applicable"; got "done"/);
		assert.match(invalidCriteriaReport.error ?? "", /criteriaSatisfied\[0\]\.evidence: expected non-empty string; got ""/);
	});

	it("explicit none disables inferred gates when a reason is present", () => {
		const acceptance = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { level: "none", reason: "parent is doing manual acceptance" },
		});

		assert.equal(acceptance.level, "none");
		assert.deepEqual(acceptance.evidence, []);
	});

	it("checked mode rejects missing required evidence", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked" },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({ testsAddedOrUpdated: [] }),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /tests-added evidence missing/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("surfaces parse validation details in acceptance failure messages", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "reviewer",
				task: "Review-only. Do not edit.",
				explicit: { level: "attested", evidence: ["review-findings"] },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({ reviewFindings: [{ id: "B-1", finding: "Missing evidence" }] }),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /Failed to parse acceptance-report/);
			assert.match(acceptanceFailureMessage(ledger) ?? "", /reviewFindings\[0\]: expected string; got object/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("checked mode rejects not-satisfied required criteria", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked", criteria: [{ id: "regression", must: "Regression is covered" }] },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({ criteriaSatisfied: [{ id: "regression", status: "not-satisfied", evidence: "test missing" }] }),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /Required criterion 'regression' was reported as not-satisfied/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("verified mode records runtime command success and failure separately from child command claims", async () => {
		const cwd = tempRepo();
		try {
			const passing = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "verified", verify: [{ id: "pass", command: "node -e \"process.exit(0)\"", timeoutMs: 10_000 }] },
			});
			const passLedger = await evaluateAcceptance({ acceptance: passing, output: report(), cwd });
			assert.equal(passLedger.status, "verified");
			assert.equal(passLedger.verifyRuns[0]?.status, "passed");

			const failing = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "verified", verify: [{ id: "fail", command: "node -e \"process.exit(7)\"", timeoutMs: 10_000 }] },
			});
			const failLedger = await evaluateAcceptance({ acceptance: failing, output: report(), cwd });
			assert.equal(failLedger.status, "rejected");
			assert.equal(failLedger.childReport?.commandsRun?.[0]?.result, "passed");
			assert.equal(failLedger.verifyRuns[0]?.status, "failed");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("reviewed mode records no-blocker and blocker reviewer outcomes", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a risky fix",
				explicit: { level: "reviewed", review: { agent: "reviewer", required: true } },
			});
			const noBlockers = await evaluateAcceptance({
				acceptance,
				output: report(),
				cwd,
				reviewResult: { status: "no-blockers", findings: [] },
			});
			assert.equal(noBlockers.status, "reviewed");
			assert.equal(noBlockers.reviewResult?.status, "no-blockers");

			const blockers = await evaluateAcceptance({
				acceptance,
				output: report(),
				cwd,
				reviewResult: {
					status: "blockers",
					findings: [{ severity: "blocker", issue: "Missing test", rationale: "Acceptance requires test evidence." }],
				},
			});
			assert.equal(blockers.status, "rejected");
			assert.equal(blockers.reviewResult?.status, "blockers");

			const unavailable = await evaluateAcceptance({ acceptance, output: report(), cwd });
			assert.equal(unavailable.status, "rejected");
			assert.equal(unavailable.reviewResult?.status, "needs-parent-decision");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not make explicit checked acceptance a stronger inferred blocker in risky contexts", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement each dynamic item",
				dynamic: true,
				explicit: { level: "checked" },
			});

			assert.equal(acceptance.level, "checked");
			assert.equal(acceptance.review, undefined);
			const ledger = await evaluateAcceptance({ acceptance, output: report({ criteriaSatisfied: [
				{ id: "criterion-1", status: "satisfied", evidence: "implemented" },
			] }), cwd });
			assert.equal(ledger.status, "checked");
			assert.equal(ledger.reviewResult, undefined);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not mark reviewed without an independent reviewer result", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: {
					level: "reviewed",
					review: false,
				},
			});
			assert.equal(acceptance.level, "reviewed");

			const ledger = await evaluateAcceptance({ acceptance, output: report(), cwd });
			assert.equal(ledger.status, "rejected");
			assert.equal(ledger.reviewResult?.status, "needs-parent-decision");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /review required/i);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("acceptance failure messages ignore skipped ledgers", () => {
		const acceptance = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { level: "checked" },
		});

		assert.equal(acceptanceFailureMessage({
			status: "skipped",
			explicit: acceptance.explicit,
			effectiveAcceptance: acceptance,
			inferredReason: acceptance.inferredReason,
			criteria: acceptance.criteria,
			runtimeChecks: [{ id: "paused", status: "not-applicable", message: "Acceptance will run after resume." }],
			verifyRuns: [],
		}), undefined);
	});

	it("aggregate reports do not count paused skipped children as blockers", () => {
		const report = aggregateAcceptanceReport({
			results: [{
				agent: "worker",
				exitCode: 0,
				error: undefined,
				acceptance: {
					status: "skipped",
					explicit: true,
					effectiveAcceptance: resolveEffectiveAcceptance({ agentName: "worker", task: "Implement a fix", explicit: { level: "checked" } }),
					inferredReason: [],
					criteria: [],
					runtimeChecks: [{ id: "paused", status: "not-applicable", message: "Acceptance will run after resume." }],
					verifyRuns: [],
				},
			}],
		});

		assert.equal(report.criteriaSatisfied[0]?.status, "satisfied");
		assert.deepEqual(report.residualRisks, []);
	});

	it("zero-child aggregate reports do not fabricate required evidence", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement dynamic fanout fixes",
				explicit: { level: "checked" },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: "",
				report: aggregateAcceptanceReport({ results: [] }),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /criterion|changed-files|tests-added|commands-run|validation-output|no-staged-files/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects explicit reviewed at dispatch with actionable guidance while preserving parse compatibility", () => {
		assert.deepEqual(validateAcceptanceInput("reviewed"), []);
		const errors = validateDispatchAcceptanceInput({ level: "reviewed" });
		assert.equal(errors.length, 1);
		assert.match(errors[0] ?? "", /reviewed/);
		assert.match(errors[0] ?? "", /verified/);
		assert.match(errors[0] ?? "", /verify commands/);
		assert.match(errors[0] ?? "", /checked/);
	});

	it("explicit verified without verify commands still fails", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "verified" },
			});
			const ledger = await evaluateAcceptance({ acceptance, output: report(), cwd });
			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /verified acceptance requires runtime verify commands/i);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("validates invalid disable and verify shapes", () => {
		assert.deepEqual(validateAcceptanceInput({ level: "none" }), ["acceptance.reason is required when level is none."]);
		assert.deepEqual(validateAcceptanceInput({ verify: [{ id: "missing-command" }] }), ["acceptance.verify[0].command is required."]);
		assert.deepEqual(validateAcceptanceInput({ verify: [{ id: "fractional", command: "npm test", timeoutMs: 1.5 }] }), ["acceptance.verify[0].timeoutMs must be an integer >= 1."]);
		assert.deepEqual(validateAcceptanceInput(false), []);
		assert.deepEqual(validateAcceptanceInput("checked"), []);
		assert.deepEqual(validateAcceptanceInput({ criteria: ["ship the fix"], review: false, stopRules: ["stay scoped"] }), []);
		assert.match(validateAcceptanceInput({ criteria: [{ id: "missing-must" }] }).join("\n"), /acceptance\.criteria\[0\]\.must is required/);
		assert.match(validateAcceptanceInput({ criteria: [123] }).join("\n"), /acceptance\.criteria\[0\] must be a string or an object/);
		assert.match(validateAcceptanceInput({ evidence: ["bogus"] }).join("\n"), /acceptance\.evidence\[0\] is not a supported evidence kind/);
		assert.match(validateAcceptanceInput({ review: true }).join("\n"), /acceptance\.review must be false or an object/);
		assert.match(validateAcceptanceInput({ review: { required: "yes" } }).join("\n"), /acceptance\.review\.required must be a boolean/);
		assert.match(validateAcceptanceInput({ stopRules: [123] }).join("\n"), /acceptance\.stopRules\[0\] must be a string/);
		assert.match(validateAcceptanceInput({ surprise: true }).join("\n"), /acceptance\.surprise is not supported/);
	});
});

describe("buildAcceptanceReportDigest", () => {
	it("includes commandsRun entries with their results", () => {
		const digest = buildAcceptanceReportDigest({
			commandsRun: [
				{ command: "npm run typecheck", result: "passed", summary: "0 errors" },
				{ command: "npm run test:unit", result: "failed", summary: "1 failing" },
			],
			residualRisks: [],
		});
		assert.match(digest, /\[passed\] npm run typecheck/);
		assert.match(digest, /0 errors/);
		assert.match(digest, /\[failed\] npm run test:unit/);
		assert.match(digest, /1 failing/);
	});

	it("includes residualRisks when non-empty and non-'none'", () => {
		const digest = buildAcceptanceReportDigest({
			commandsRun: [{ command: "npm test", result: "passed", summary: "ok" }],
			residualRisks: ["none", "potential flakiness on CI"],
		});
		assert.match(digest, /potential flakiness on CI/);
		// "none" sentinels must be filtered out
		assert.doesNotMatch(digest, /\bnone\b/i);
	});

	it("does not include residual-risks section when all entries are 'none'", () => {
		const digest = buildAcceptanceReportDigest({
			commandsRun: [{ command: "npm test", result: "passed", summary: "ok" }],
			residualRisks: ["none"],
		});
		assert.doesNotMatch(digest, /Residual risks/);
	});

	it("does not include residual-risks section when residualRisks is empty", () => {
		const digest = buildAcceptanceReportDigest({
			commandsRun: [{ command: "npm test", result: "passed", summary: "ok" }],
			residualRisks: [],
		});
		assert.doesNotMatch(digest, /Residual risks/);
	});

	it("is non-empty even for a report with no commandsRun", () => {
		const digest = buildAcceptanceReportDigest({});
		assert.ok(digest.length > 0);
		assert.match(digest, /Validation evidence/);
	});

	it("stripAcceptanceReport remains remove-only — does not inject digest", () => {
		// The progress/step-tail path (appendRecentStepOutput) and
		// stripAcceptanceReportsFromMessages both call stripAcceptanceReport directly.
		// It must stay a pure remove-only function so progress tails do not bloat.
		const output = [
			"done",
			"```acceptance-report",
			JSON.stringify(reportData()),
			"```",
		].join("\n");
		const stripped = stripAcceptanceReport(output);
		assert.equal(stripped, "done");
		assert.doesNotMatch(stripped, /Validation evidence/);
		assert.doesNotMatch(stripped, /commandsRun/);
	});
});

describe("appendAcceptanceReportDigest", () => {
	function parsedReport(): AcceptanceReport {
		const parsed = parseAcceptanceReport(report());
		assert.ok(parsed.report);
		return parsed.report;
	}

	it("appends the digest after the already-stripped output", () => {
		const stripped = stripAcceptanceReport(report());
		const joined = appendAcceptanceReportDigest(stripped, parsedReport());

		assert.equal(stripped, "done");
		assert.ok(joined.startsWith("done\n\n"), "original output must be preserved verbatim at the head");
		assert.match(joined, /Validation evidence/);
		assert.match(joined, /\[passed\] npm test/);
	});

	it("appends deterministically regardless of output length", () => {
		// No length threshold or magic-number gating: a 4-character output and a long
		// one both receive the digest.
		const shortJoined = appendAcceptanceReportDigest("ok", parsedReport());
		const longJoined = appendAcceptanceReportDigest("x".repeat(5000), parsedReport());

		assert.match(shortJoined, /Validation evidence/);
		assert.match(longJoined, /Validation evidence/);
	});

	it("emits the digest alone when the stripped output is empty", () => {
		const joined = appendAcceptanceReportDigest("", parsedReport());

		assert.ok(!joined.startsWith("\n"), "must not emit leading blank lines");
		assert.match(joined, /Validation evidence/);
	});

	it("never removes or rewrites the caller's output", () => {
		const original = "line one\nline two\n\n  indented";
		const joined = appendAcceptanceReportDigest(original, parsedReport());

		assert.ok(joined.startsWith(original), "append-only");
	});
});
