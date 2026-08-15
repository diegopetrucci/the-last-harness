import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSubagentLiveDetailController } from "../../src/shared/subagent-shortcuts.ts";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Dynamic imports preserve module-evaluation order: slash-live-state.ts
// initialises module-level Maps (liveSnapshots, finalSnapshots) that the
// tests reset via clearSlashSnapshots(); importing after other module code
// has run keeps that state isolated from any future top-level setup code
// added above these lines.
const {
	applySlashUpdate,
	buildSlashInitialResult,
	clearSlashSnapshots,
	finalizeSlashResult,
	getSlashRenderableSnapshot,
	restoreSlashFinalSnapshots,
} = await import("../../src/slash/slash-live-state.ts");
const { createSlashResultComponent } = await import("../../src/extension/index.ts");
const available = true;

describe("slash live state", { skip: !available ? "slash-live-state.ts not importable" : undefined }, () => {
	it("streams progress updates into the visible slash snapshot", () => {
		clearSlashSnapshots!();
		const details = buildSlashInitialResult!("req-1", {
			agent: "scout",
			task: "scan codebase",
		});

		applySlashUpdate!("req-1", {
			requestId: "req-1",
			currentTool: "find",
			toolCount: 2,
			progress: [
				{
					index: 0,
					agent: "scout",
					status: "running",
					task: "scan codebase",
					currentTool: "find",
					currentToolArgs: '{"pattern":"**/*.ts"}',
					recentTools: [{ tool: "ls", args: '{"path":"."}', endMs: 10 }],
					recentOutput: ["src/index.ts", "src/render.ts"],
					toolCount: 2,
					tokens: 120,
					durationMs: 400,
				},
			],
		});

		const snapshot = getSlashRenderableSnapshot!(details);
		const progress = snapshot.result.details.results[0]?.progress;
		assert.equal(progress?.currentTool, "find");
		assert.deepEqual(progress?.recentOutput, ["src/index.ts", "src/render.ts"]);
		assert.equal(snapshot.version > 0, true);
	});

	it("creates stable placeholders for parallel slash runs", () => {
		clearSlashSnapshots!();
		const details = buildSlashInitialResult!("req-parallel", {
			tasks: [
				{ agent: "worker", task: "Draft fix" },
				{ agent: "reviewer", task: "Review diff" },
			],
		});

		assert.equal(details.result.details.mode, "parallel");
		assert.equal(details.result.details.results.length, 2);
		assert.equal(details.result.details.progress?.length, 2);
		assert.equal(details.result.details.results[0]?.progress?.status, "running");
		assert.equal(details.result.details.results[1]?.agent, "reviewer");
		assert.equal(details.result.details.results[1]?.progress?.index, 1);
	});

	it("rerenders the active slash surface from shared live-detail state", () => {
		clearSlashSnapshots!();
		const details = buildSlashInitialResult!("req-live-render", {
			agent: "scout",
			task: "inspect the active slash result",
		});
		const longArgs = `{"path":"${"x".repeat(100)}"}`;
		applySlashUpdate!("req-live-render", {
			requestId: "req-live-render",
			currentTool: "read",
			toolCount: 1,
			progress: [
				{
					index: 0,
					agent: "scout",
					status: "running",
					task: "inspect the active slash result",
					currentTool: "read",
					currentToolArgs: longArgs,
					recentTools: [],
					recentOutput: [],
					toolCount: 1,
					tokens: 10,
					durationMs: 100,
				},
			],
		});

		const controller = createSubagentLiveDetailController();
		const theme = {
			fg: (_name: string, text: string) => text,
			bg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		};
		const component = createSlashResultComponent!(details, { expanded: true }, theme as never, controller);

		const collapsed = component.render(180).join("\n");
		assert.match(collapsed, /Ctrl\+Shift\+D/);
		assert.match(collapsed, new RegExp(escapeRegExp(longArgs)));
		assert.doesNotMatch(collapsed, /Task: inspect the active slash result/);

		assert.equal(controller.toggle(), true);
		const expanded = component.render(180).join("\n");
		assert.match(expanded, new RegExp(escapeRegExp(longArgs)));
		assert.match(expanded, /Task: inspect the active slash result/);
	});

	it("keeps finalized slash results on the live-detail controller", () => {
		clearSlashSnapshots!();
		const longArgs = `{"path":"${"x".repeat(100)}"}`;
		const collapsedDetails = buildSlashInitialResult!("req-final-collapsed", {
			agent: "scout",
			task: "inspect the finalized slash result",
		});
		finalizeSlashResult!({
			requestId: "req-final-collapsed",
			result: {
				content: [{ type: "text", text: "Done." }],
				details: {
					mode: "single",
					results: [
						{
							agent: "scout",
							task: "inspect the finalized slash result",
							exitCode: 0,
							finalOutput: "Done.",
							toolCalls: [{ text: "read", expandedText: longArgs }],
							usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
						},
					],
				},
			},
			isError: false,
		});
		const expandedDetails = buildSlashInitialResult!("req-final-expanded", {
			agent: "scout",
			task: "inspect the finalized slash result",
		});
		finalizeSlashResult!({
			requestId: "req-final-expanded",
			result: {
				content: [{ type: "text", text: "Done." }],
				details: {
					mode: "single",
					results: [
						{
							agent: "scout",
							task: "inspect the finalized slash result",
							exitCode: 0,
							finalOutput: "Done.",
							toolCalls: [{ text: "read", expandedText: longArgs }],
							usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
						},
					],
				},
			},
			isError: false,
		});

		const controller = createSubagentLiveDetailController();
		const theme = {
			fg: (_name: string, text: string) => text,
			bg: (_name: string, text: string) => text,
			bold: (text: string) => text,
		};
		const collapsed = createSlashResultComponent!(collapsedDetails, { expanded: true }, theme as never, controller);
		assert.doesNotMatch(collapsed.render(180).join("\n"), new RegExp(escapeRegExp(longArgs)));

		assert.equal(controller.toggle(), true);
		const expanded = createSlashResultComponent!(expandedDetails, { expanded: false }, theme as never, controller);
		assert.match(expanded.render(180).join("\n"), new RegExp(escapeRegExp(longArgs)));
	});

	it("prefers finalized snapshots and restores them from persisted custom messages", () => {
		clearSlashSnapshots!();
		const details = buildSlashInitialResult!("req-2", {
			agent: "scout",
			task: "scan codebase",
		});

		const finalDetails = finalizeSlashResult!({
			requestId: "req-2",
			result: {
				content: [{ type: "text", text: "Done." }],
				details: {
					mode: "single",
					results: [
						{
							agent: "scout",
							task: "scan codebase",
							exitCode: 0,
							messages: [],
							usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
						},
					],
				},
			},
			isError: false,
		});

		const liveFinal = getSlashRenderableSnapshot!(details);
		assert.equal((liveFinal.result.content[0] as { text: string }).text, "Done.");

		clearSlashSnapshots!();
		restoreSlashFinalSnapshots!([
			{
				type: "custom_message",
				customType: "subagent-slash-result",
				display: true,
				details: finalDetails,
			},
		]);

		const restored = getSlashRenderableSnapshot!(details);
		assert.equal((restored.result.content[0] as { text: string }).text, "Done.");
	});
});
