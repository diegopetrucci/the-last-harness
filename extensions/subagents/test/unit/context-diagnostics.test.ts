import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	assessDurableResumeContext,
	assistantContextTokens,
	detectContextPressureCrossing,
	formatContextPressureGuidance,
	hasUsableSessionArtifact,
	classifyContextExhaustedTermination,
	formatDurableResumeContextBlock,
	parseContextUsageDiagnostics,
	parseSubagentTerminationReason,
	resolveSubagentTerminationReason,
	updateContextUsageDiagnostics,
} from "../../src/shared/context-diagnostics.ts";

function assistant(stopReason: string, usage: Record<string, unknown>) {
	return { role: "assistant", stopReason, usage };
}

describe("subagent context and termination diagnostics", () => {
	it("uses ordered 80/95 pressure boundaries and preserves crossed-band history", () => {
		const cases = [
			[799, [], undefined],
			[800, [], "warning"],
			[949.99, [], "warning"],
			[950, ["warning"], "critical"],
			[951, ["warning"], "critical"],
		] as const;
		for (const [tokens, history, expected] of cases) {
			const pressure = detectContextPressureCrossing({ contextTokens: tokens, contextWindow: 1000 }, history, 123);
			assert.equal(pressure?.severity, expected);
		}
		const warning = detectContextPressureCrossing({ contextTokens: 800, contextWindow: 1000 }, [], 123)!;
		assert.match(formatContextPressureGuidance(warning), /800\/1000 tokens \(80\.00%\)/);
		assert.match(formatContextPressureGuidance(warning), /fresh narrowly scoped dispatch/);
		assert.equal(detectContextPressureCrossing({ contextTokens: 800, contextWindow: 1000 }, ["warning"]), undefined);
		const critical = detectContextPressureCrossing({ contextTokens: 950, contextWindow: 1000 }, ["warning"])!;
		assert.equal(critical.crossedThreshold, "critical");
		assert.equal(
			detectContextPressureCrossing({ contextTokens: 800, contextWindow: 1000 }, ["warning", "critical"]),
			undefined,
		);
		assert.equal(detectContextPressureCrossing({ contextTokens: 700, contextWindow: 1000 }, ["warning"]), undefined);
		assert.equal(detectContextPressureCrossing({ contextTokens: 800, contextWindow: 1000 }, ["warning"]), undefined);
		assert.deepEqual(detectContextPressureCrossing({ contextTokens: 900, contextWindow: 0 }), undefined);
	});

	it("scans only a bounded first JSONL record and preserves safe artifact rejection", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-session-header-"));
		try {
			const validHeader = JSON.stringify({ type: "session", id: "session-123" });
			const largeTail = path.join(root, "large-tail.jsonl");
			fs.writeFileSync(largeTail, `${validHeader}\n${"x".repeat(2 * 1024 * 1024)}`, "utf-8");
			assert.equal(hasUsableSessionArtifact(largeTail), true);

			const chunkBoundaryPrefix = `${" ".repeat(64 * 1024 - 1)}\n`;
			const blankPrefix = path.join(root, "blank-prefix.jsonl");
			fs.writeFileSync(blankPrefix, `${chunkBoundaryPrefix}${validHeader}\ntrailing data`, "utf-8");
			assert.equal(hasUsableSessionArtifact(blankPrefix), true);

			const noNewline = path.join(root, "no-newline.jsonl");
			fs.writeFileSync(noNewline, validHeader, "utf-8");
			assert.equal(hasUsableSessionArtifact(noNewline), true);

			const malformed = path.join(root, "malformed.jsonl");
			fs.writeFileSync(malformed, `not json\n${validHeader}\n`, "utf-8");
			assert.equal(hasUsableSessionArtifact(malformed), false);
			assert.equal(hasUsableSessionArtifact(path.join(root, "missing.jsonl")), false);

			const empty = path.join(root, "empty.jsonl");
			fs.writeFileSync(empty, "\n  \n", "utf-8");
			assert.equal(hasUsableSessionArtifact(empty), false);

			const maxHeaderBytes = 1024 * 1024;
			const exactBoundaryHeader = `${validHeader}${" ".repeat(maxHeaderBytes - Buffer.byteLength(validHeader))}`;
			const exactBoundary = path.join(root, "exact-boundary.jsonl");
			fs.writeFileSync(exactBoundary, exactBoundaryHeader, "utf-8");
			assert.equal(hasUsableSessionArtifact(exactBoundary), true);

			const oneByteOver = path.join(root, "one-byte-over.jsonl");
			fs.writeFileSync(oneByteOver, `${exactBoundaryHeader} `, "utf-8");
			assert.equal(hasUsableSessionArtifact(oneByteOver), false);

			const oversizedWithNewline = path.join(root, "oversized-with-newline.jsonl");
			fs.writeFileSync(oversizedWithNewline, `${exactBoundaryHeader} \n`, "utf-8");
			assert.equal(hasUsableSessionArtifact(oversizedWithNewline), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("blocks exactly at the centralized unsafe threshold and uses the latest total, not peak", () => {
		const safe = assessDurableResumeContext({ contextTokens: 799, peakTokens: 950 }, 1000);
		assert.equal(safe.blocked, false);
		assert.equal(safe.remainingTokens, 201);
		const blocked = assessDurableResumeContext({ contextTokens: 800, peakTokens: 1200 }, 1000);
		assert.equal(blocked.blocked, true);
		assert.equal(blocked.contextPercent, 80);
		assert.equal(blocked.remainingTokens, 200);
		assert.match(formatDurableResumeContextBlock(blocked), /used tokens 800/);
		assert.match(formatDurableResumeContextBlock(blocked), /context window 1000/);
		assert.match(formatDurableResumeContextBlock(blocked), /80\.00%/);
		assert.match(formatDurableResumeContextBlock(blocked), /remaining tokens 200/);
		assert.match(formatDurableResumeContextBlock(blocked), /fresh narrowly scoped child/);
	});

	it("proceeds with unknown diagnostics instead of inventing measurements", () => {
		assert.deepEqual(assessDurableResumeContext({ peakTokens: 1000, contextPercent: 99 }, undefined), {
			blocked: false,
			measured: false,
		});
		assert.deepEqual(assessDurableResumeContext({ contextTokens: 800 }, 0), {
			blocked: false,
			measured: false,
		});
	});
	it("uses per-response Pi context totals and includes cached tokens without summing turns", () => {
		let diagnostics = updateContextUsageDiagnostics(
			undefined,
			assistant("toolUse", { input: 10, output: 5, cacheRead: 900, cacheWrite: 20 }),
			{ restored: true, contextWindow: 2000 },
		);
		diagnostics = updateContextUsageDiagnostics(
			diagnostics,
			assistant("stop", { totalTokens: 700, input: 500, output: 500, cacheRead: 500, cacheWrite: 500 }),
			{ restored: true, contextWindow: 2000 },
		);

		assert.deepEqual(diagnostics, {
			restoredTokens: 935,
			contextTokens: 700,
			peakTokens: 935,
			contextWindow: 2000,
			contextPercent: 35,
		});
	});

	it("seeds continuation diagnostics and keeps prior context when no response usage is valid", () => {
		const restored = {
			restoredTokens: 700,
			contextTokens: 700,
			peakTokens: 900,
			contextWindow: 2000,
			contextPercent: 35,
		};
		assert.deepEqual(
			updateContextUsageDiagnostics(restored, assistant("error", { totalTokens: 100 }), { restored: true }),
			restored,
		);
	});

	it("updates the latest context while retaining the continuation start and maximum peak", () => {
		let diagnostics = updateContextUsageDiagnostics(
			{ restoredTokens: 700, contextTokens: 700, peakTokens: 900, contextWindow: 2000, contextPercent: 35 },
			assistant("stop", { totalTokens: 800 }),
			{ restored: true },
		);
		assert.deepEqual(diagnostics, {
			restoredTokens: 700,
			contextTokens: 800,
			peakTokens: 900,
			contextWindow: 2000,
			contextPercent: 40,
		});
		diagnostics = updateContextUsageDiagnostics(diagnostics, assistant("stop", { totalTokens: 1200 }), {
			restored: true,
		});
		assert.equal(diagnostics?.contextTokens, 1200);
		assert.equal(diagnostics?.peakTokens, 1200);
		assert.equal(diagnostics?.restoredTokens, 700);
	});

	it("ignores aborted, error, all-zero, and malformed assistant usage", () => {
		assert.equal(assistantContextTokens(assistant("aborted", { totalTokens: 20 })), undefined);
		assert.equal(assistantContextTokens(assistant("error", { totalTokens: 20 })), undefined);
		assert.equal(
			assistantContextTokens(assistant("stop", { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })),
			undefined,
		);
		assert.equal(assistantContextTokens({ role: "assistant", stopReason: "stop", usage: "bad" }), undefined);
	});

	it("maps orchestration conditions before terminal model stops", () => {
		assert.equal(resolveSubagentTerminationReason({ cancelled: true, assistantStopReason: "stop" }), "cancelled");
		assert.equal(resolveSubagentTerminationReason({ paused: true, assistantStopReason: "error" }), "paused");
		assert.equal(resolveSubagentTerminationReason({ timedOut: true, assistantStopReason: "stop" }), "timed_out");
		assert.equal(
			resolveSubagentTerminationReason({ turnBudgetExceeded: true, assistantStopReason: "stop" }),
			"turn_budget_exceeded",
		);
		assert.equal(
			resolveSubagentTerminationReason({ toolBudgetBlocked: true, assistantStopReason: "stop" }),
			"tool_budget_blocked",
		);
		assert.equal(resolveSubagentTerminationReason({ interrupted: true, assistantStopReason: "stop" }), "interrupted");
		assert.equal(resolveSubagentTerminationReason({ assistantStopReason: "stop" }), "completed");
		assert.equal(resolveSubagentTerminationReason({ assistantStopReason: "length" }), "output_limit");
		assert.equal(resolveSubagentTerminationReason({ assistantStopReason: "error" }), "model_error");
		assert.equal(resolveSubagentTerminationReason({ assistantStopReason: "aborted" }), "interrupted");
		assert.equal(
			resolveSubagentTerminationReason({ assistantStopReason: "toolUse", processCompleted: true }),
			"process_exit",
		);
		assert.equal(resolveSubagentTerminationReason({ assistantStopReason: "deferred" }), "unknown");
	});

	it("classifies nonzero post-processing failures as process exits without hiding model stops", () => {
		const cases = [
			["completion guard", { assistantStopReason: "stop", effectiveExitCode: 1 }, "process_exit"],
			["missing structured output", { assistantStopReason: "stop", effectiveExitCode: 1 }, "process_exit"],
			["acceptance failure", { assistantStopReason: "stop", effectiveExitCode: 1 }, "process_exit"],
			["model error", { assistantStopReason: "error", effectiveExitCode: 1 }, "model_error"],
			["aborted model", { assistantStopReason: "aborted", effectiveExitCode: 1 }, "interrupted"],
			["output limit", { assistantStopReason: "length", effectiveExitCode: 1 }, "output_limit"],
		] as const;
		for (const [label, input, expected] of cases) {
			assert.equal(resolveSubagentTerminationReason(input), expected, label);
		}
	});

	it("classifies only the narrow adjacent #456 sequence with canonical ids", () => {
		const call = {
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "call-456", name: "edit", arguments: { path: "a.ts" } }],
		};
		const empty = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "  " }] };
		const base = {
			messages: [call, empty],
			exitCode: 0,
			terminationReason: "completed" as const,
			contextUsage: { contextPercent: 95 },
		};
		assert.equal(classifyContextExhaustedTermination(base), "context_exhausted");
		assert.equal(
			classifyContextExhaustedTermination({
				...base,
				messages: [call, { role: "assistant", stopReason: "stop", content: [] }],
			}),
			"context_exhausted",
		);
		assert.equal(classifyContextExhaustedTermination({ ...base, contextUsage: { contextPercent: 94.99 } }), undefined);
		assert.equal(
			classifyContextExhaustedTermination({ ...base, contextUsage: { peakTokens: 999, contextPercent: undefined } }),
			undefined,
		);

		// An old unresolved call is not evidence for the final turn.
		assert.equal(
			classifyContextExhaustedTermination({
				...base,
				messages: [call, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old" }] }, empty],
			}),
			undefined,
		);
		// Tool, assistant, and unrelated events all break the immediate sequence.
		for (const intervening of [
			{ role: "toolResult", toolCallId: "call-456", toolName: "edit", content: [], isError: false },
			{ role: "assistant", stopReason: "toolUse", content: [] },
			{ role: "user", content: "intervening" },
		]) {
			assert.equal(classifyContextExhaustedTermination({ ...base, messages: [call, intervening, empty] }), undefined);
		}
		// Multiple canonical calls are valid evidence when all ids are present.
		assert.equal(
			classifyContextExhaustedTermination({
				...base,
				messages: [
					{ ...call, content: [call.content[0], { type: "toolCall", id: "call-457", name: "read", arguments: {} }] },
					empty,
				],
			}),
			"context_exhausted",
		);
		// The predecessor must be a non-empty, all-tool-call array with Pi's
		// canonical fields; mixed, malformed, and duplicate calls are negative.
		for (const nonCanonicalCall of [
			{
				...call,
				content: [
					{ type: "toolCall", id: "call-456", name: "edit", arguments: {} },
					{ type: "text", text: "note" },
				],
			},
			{ ...call, content: [{ type: "toolCall", id: "call-456", name: "edit", arguments: {} }, { type: "bogus" }] },
			{ ...call, content: [{ type: "toolCall", id: "call-456", arguments: {} }] },
			{ ...call, content: [{ type: "toolCall", id: "call-456", name: "edit" }] },
			{ ...call, content: [{ type: "toolCall", id: "call-456", name: "edit", arguments: null }] },
			{ ...call, content: [{ type: "toolCall", id: "call-456", name: "", arguments: {} }] },
			{ ...call, content: [{ type: "toolCall", id: "call-456", name: "edit", arguments: [] }] },
			{
				...call,
				content: [
					{ type: "toolCall", id: "call-456", name: "edit", arguments: {} },
					{ type: "toolCall", id: "call-456", name: "read", arguments: {} },
				],
			},
			{ ...call, content: [{ type: "toolCall", id: "  ", name: "edit", arguments: {} }] },
			{ ...call, content: [{ type: "toolCall", id: 456, name: "edit", arguments: {} }] },
		]) {
			assert.equal(classifyContextExhaustedTermination({ ...base, messages: [nonCanonicalCall, empty] }), undefined);
		}
		// A result matched by id is never borrowed from arbitrary history.
		assert.equal(
			classifyContextExhaustedTermination({
				...base,
				messages: [
					call,
					{ role: "toolResult", toolCallId: "call-456", toolName: "edit", content: [], isError: false },
					empty,
				],
			}),
			undefined,
		);
		for (const finalContent of [
			undefined,
			"",
			[{ type: "thinking", thinking: "hidden" }],
			[{ type: "image", data: "x", mimeType: "image/png" }],
			[{ type: "toolCall", id: "call-458", name: "edit", arguments: {} }],
			[{ type: "unknown", value: "part" }],
			[{ type: "text" }],
			[{ type: "text", text: 1 }],
		]) {
			assert.equal(
				classifyContextExhaustedTermination({
					...base,
					messages: [call, { role: "assistant", stopReason: "stop", content: finalContent }],
				}),
				undefined,
			);
		}
		assert.equal(classifyContextExhaustedTermination({ ...base, error: "acceptance failed" }), undefined);
		assert.equal(classifyContextExhaustedTermination({ ...base, exitCode: 1 }), undefined);
	});

	it("does not infer context exhaustion from an ordinary empty terminal", () => {
		assert.equal(
			classifyContextExhaustedTermination({
				messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "" }] }],
				contextUsage: { contextPercent: 99 },
				exitCode: 0,
				terminationReason: "completed",
			}),
			undefined,
		);
	});

	it("validates optional diagnostics read from legacy/external artifacts", () => {
		assert.equal(parseContextUsageDiagnostics(undefined), undefined);
		assert.deepEqual(parseContextUsageDiagnostics({ contextTokens: 42, peakTokens: 50 }), {
			contextTokens: 42,
			peakTokens: 50,
		});
		assert.equal(parseContextUsageDiagnostics({ contextTokens: "42" }), undefined);
		assert.equal(parseSubagentTerminationReason(undefined), undefined);
		assert.equal(parseSubagentTerminationReason("completed"), "completed");
		assert.equal(parseSubagentTerminationReason("context_exhausted"), "context_exhausted");
	});
});
