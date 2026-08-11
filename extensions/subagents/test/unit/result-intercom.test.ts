import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	attachNestedChildrenToResultChildren,
	formatForegroundNativeSubagentResult,
	resolveSubagentResultStatus,
} from "../../src/intercom/result-intercom.ts";

describe("result intercom formatter", () => {
	it("attaches compact nested children under their parent result child without route secrets", () => {
		const children = attachNestedChildrenToResultChildren(
			"root-run",
			[
				{ agent: "owner-a", status: "completed", summary: "done", index: 0 },
				{ agent: "owner-b", status: "completed", summary: "done", index: 1 },
			],
			[
				{
					id: "nested-a",
					parentRunId: "root-run",
					parentStepIndex: 1,
					depth: 1,
					path: [{ runId: "root-run", stepIndex: 1 }],
					state: "complete",
					agent: "reviewer",
					sessionFile: path.join(os.tmpdir(), "nested-a.jsonl"),
					controlInbox: "/tmp/should-not-leak",
					capabilityToken: "secret-token",
					children: [
						{
							id: "nested-grandchild",
							parentRunId: "nested-a",
							depth: 2,
							path: [{ runId: "root-run", stepIndex: 1 }, { runId: "nested-a" }],
							state: "complete",
							agent: "auditor",
							controlInbox: "/tmp/grandchild-should-not-leak",
							capabilityToken: "grandchild-secret",
						},
					],
				},
			],
		);

		const nested = children[1]?.children?.[0];
		const grandchild = nested?.children?.[0];
		assert.equal(children[0]?.children, undefined);
		assert.equal(nested?.id, "nested-a");
		assert.equal(Object.hasOwn(nested ?? {}, "controlInbox"), false);
		assert.equal(Object.hasOwn(nested ?? {}, "capabilityToken"), false);
		assert.equal(grandchild?.id, "nested-grandchild");
		assert.equal(Object.hasOwn(grandchild ?? {}, "controlInbox"), false);
		assert.equal(Object.hasOwn(grandchild ?? {}, "capabilityToken"), false);
	});

	it("formats native foreground results with bounded failed-first previews and explicit omissions", () => {
		const grouped = formatForegroundNativeSubagentResult({
			runId: "run-native",
			mode: "parallel",
			children: [
				{
					agent: "completed-1",
					status: "completed",
					summary: "done",
					artifactPath: "/tmp/a.md",
					intercomTarget: "subagent-a-run-native-1",
					index: 0,
				},
				{ agent: "failed-1", status: "failed", summary: "failed badly", sessionPath: "/tmp/b.jsonl", index: 1 },
				{ agent: "paused-1", status: "paused", summary: "paused output", index: 2 },
				{ agent: "completed-2", status: "completed", summary: "done", index: 3 },
				{ agent: "completed-3", status: "completed", summary: "done", index: 4 },
				{ agent: "completed-4", status: "completed", summary: "done", index: 5 },
				{ agent: "completed-5", status: "completed", summary: "done", index: 6 },
				{ agent: "completed-6", status: "completed", summary: "done", index: 7 },
				{ agent: "completed-7", status: "completed", summary: "done", index: 8 },
			],
		});

		assert.equal(grouped.status, "failed");
		assert.equal(grouped.summary, "7 completed, 1 failed, 1 paused");
		assert.match(grouped.text, /^subagent results/m);
		assert.match(grouped.text, /Run: run-native/);
		assert.match(grouped.text, /Mode: parallel/);
		assert.match(grouped.text, /Status: failed/);
		assert.match(grouped.text, /Children: 7 completed, 1 failed, 1 paused/);
		assert.match(
			grouped.text,
			/2\/9\. failed-1 — failed[\s\S]*3\/9\. paused-1 — paused[\s\S]*1\/9\. completed-1 — completed/,
		);
		assert.match(
			grouped.text,
			/… \[1 child results omitted; highest-priority results shown first, inspect retained details for the full set\]/,
		);
		assert.match(grouped.text, /Output artifact: \/tmp\/a\.md/);
		assert.match(grouped.text, /Session: \/tmp\/b\.jsonl/);
		assert.doesNotMatch(grouped.text, /intercom target/i);
		assert.doesNotMatch(grouped.text, /Intercom targets below/i);
		assert.ok(grouped.text.length <= 8_000);
	});

	it("bounds native foreground errors, child summaries, and nested previews", () => {
		const grouped = formatForegroundNativeSubagentResult({
			runId: "run-chain-native-error",
			mode: "chain",
			chainSteps: 2,
			statusOverride: "failed",
			errorSummary: `Collected output validation failed: ${"E".repeat(2_000)}`,
			children: [
				{
					agent: "reviewer",
					status: "failed",
					summary: "s".repeat(2_000),
					artifactPath: "/tmp/reviewer-output.md",
					children: Array.from({ length: 9 }, (_, index) => ({
						id: `nested-${index}`,
						parentRunId: "run-chain-native-error",
						parentStepIndex: 0,
						depth: 1,
						path: [{ runId: "run-chain-native-error", stepIndex: 0 }],
						state: "complete",
						agent: `nested-agent-${index}`,
						children: [
							{
								id: `nested-${index}-child`,
								parentRunId: `nested-${index}`,
								depth: 2,
								path: [{ runId: "run-chain-native-error", stepIndex: 0 }, { runId: `nested-${index}` }],
								state: "complete",
								agent: `nested-child-${index}`,
								children: [
									{
										id: `nested-${index}-grandchild`,
										parentRunId: `nested-${index}-child`,
										depth: 3,
										path: [
											{ runId: "run-chain-native-error", stepIndex: 0 },
											{ runId: `nested-${index}` },
											{ runId: `nested-${index}-child` },
										],
										state: "complete",
										agent: `nested-grandchild-${index}`,
									},
								],
							},
						],
					})),
				},
			],
		});

		assert.equal(grouped.status, "failed");
		assert.equal(grouped.summary, "1 failed");
		assert.match(grouped.text, /Chain steps: 2/);
		assert.match(grouped.text, /Error:\nCollected output validation failed:/);
		assert.match(grouped.text, /\[error truncated; inspect retained details for full text\]/);
		assert.match(grouped.text, /Summary:\ns+[\s\S]*\[summary truncated; see references below for full output\]/);
		assert.match(grouped.text, /Nested subagents:/);
		assert.match(grouped.text, /… \[nested depth limit reached; inspect retained details for full tree\]/);
		assert.match(grouped.text, /… \[additional nested entries omitted; inspect retained details for full tree\]/);
		assert.equal(grouped.text.match(/Collected output validation failed/g)?.length ?? 0, 1);
		assert.ok(grouped.text.length <= 8_000);
	});

	it("resolves paused and detached statuses", () => {
		assert.equal(resolveSubagentResultStatus({ interrupted: true }), "paused");
		assert.equal(resolveSubagentResultStatus({ detached: true }), "detached");
		assert.equal(resolveSubagentResultStatus({ success: true }), "completed");
		assert.equal(resolveSubagentResultStatus({ exitCode: 1 }), "failed");
	});
});
