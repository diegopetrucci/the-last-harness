import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	KeybindingsManager,
	type KeyId,
} from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import type { AsyncJobState } from "../../src/shared/types.ts";
import {
	createSubagentLiveDetailController,
	type SubagentLiveDetailController,
} from "../../src/shared/subagent-shortcuts.ts";
import { buildWidgetLines, clearLegacyResultAnimationTimer, renderWidget } from "../../src/tui/render.ts";
import { WHIMSICAL_THINKING_PHRASES, whimsicalThinkingPhrase } from "../../src/tui/whimsical-phrases.ts";

// Theme is an SDK class with private colour-table fields; a plain object with
// the two methods the render functions actually call is sufficient for tests.
// Casting to the real Theme type (not a handwritten local shape) means the
// compiler still validates everything except the theme argument itself.
const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const runningGlyphPattern = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function outputPathPattern(posixPath: string): RegExp {
	return new RegExp(`output: ${posixPath.split("/").map(escapeRegExp).join("[\\\\/]")}`);
}

function firstGrapheme(text: string): string {
	return Array.from(text.trimStart())[0] ?? "";
}

function firstRunningGlyph(text: string): string {
	return text.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]/)?.[0] ?? "";
}

function createUiContext() {
	const widgets: unknown[] = [];
	let renderRequests = 0;
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			setWidget: (_key: string, value: unknown) => {
				widgets.push(value);
			},
			requestRender: () => {
				renderRequests += 1;
			},
		},
	};
	return {
		ctx,
		widgets,
		get renderRequests() {
			return renderRequests;
		},
	};
}

function renderWidgetLines(widget: unknown, width = 180): string[] {
	return (widget as (_tui: unknown, widgetTheme: typeof theme) => { render(width: number): string[] })(
		undefined,
		theme,
	).render(width);
}

function widgetContent(line: string): string {
	return line.slice(1).trimEnd();
}

function wrappedText(lines: string[], padded = false): string {
	return lines
		.map((line) => (padded ? widgetContent(line) : line))
		.join("")
		.replace(/\s/g, "");
}

function assertWrappedSource(lines: string[], source: string, padded = false): void {
	assert.ok(
		wrappedText(lines, padded).includes(source.replace(/\s/g, "")),
		`wrapped output should preserve ${JSON.stringify(source)}`,
	);
}

function renderWithRealPiTui(lines: string[], width: number): string[] {
	const container = new Container();
	for (const line of lines) container.addChild(new Text(line, 1, 0));
	return container.render(width);
}

function renderWidgetHarnessLines(widget: unknown): string[] {
	const component = (widget as (_tui: unknown, widgetTheme: typeof theme) => Container)(undefined, theme);
	return component.children.map((child) => {
		const text = (child as unknown as { text?: unknown }).text;
		assert.equal(typeof text, "string", "widget harness should expose Text children");
		return text as string;
	});
}

function restoreDescriptor(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	Reflect.deleteProperty(target, key);
}

function withStdoutSize<T>(rows: number, columns: number, fn: () => T): T {
	const stdout = process.stdout as NodeJS.WriteStream & { rows?: number; columns?: number };
	const rowsDescriptor = Object.getOwnPropertyDescriptor(stdout, "rows");
	const columnsDescriptor = Object.getOwnPropertyDescriptor(stdout, "columns");
	Object.defineProperty(stdout, "rows", { configurable: true, value: rows });
	Object.defineProperty(stdout, "columns", { configurable: true, value: columns });
	try {
		return fn();
	} finally {
		restoreDescriptor(stdout, "rows", rowsDescriptor);
		restoreDescriptor(stdout, "columns", columnsDescriptor);
	}
}

function resetWidgetLayout(): void {
	renderWidget(createUiContext().ctx as never, []);
}

const originalKeybindings = getKeybindings();
const configuredExpandKeybindings = new KeybindingsManager({ "app.tools.expand": "configured+expand+key" as KeyId });

function useConfiguredExpandKey(): void {
	setKeybindings(configuredExpandKeybindings);
}

function useDefaultKeybindings(): void {
	setKeybindings(originalKeybindings);
}

beforeEach(() => {
	useConfiguredExpandKey();
	resetWidgetLayout();
});

afterEach(() => {
	useDefaultKeybindings();
	resetWidgetLayout();
});

describe("subagent async widget rendering", () => {
	it("orders running jobs before queued summaries and completions", () => {
		const lines = buildWidgetLines(
			[
				{
					asyncId: "done-1",
					asyncDir: "/tmp/done",
					status: "complete",
					agents: ["reviewer"],
					startedAt: 0,
					updatedAt: 1000,
				},
				{
					asyncId: "queued-1",
					asyncDir: "/tmp/queued",
					status: "queued",
					agents: ["planner"],
					startedAt: 0,
					updatedAt: 1000,
				},
				{
					asyncId: "run-1",
					asyncDir: "/tmp/run",
					status: "running",
					agents: ["scout"],
					currentStep: 0,
					stepsTotal: 2,
					startedAt: Date.now() - 1000,
					updatedAt: Date.now(),
					currentTool: "read",
					currentToolStartedAt: Date.now() - 500,
				},
			],
			theme,
			120,
		);

		const text = lines.join("\n");
		assert.match(text, new RegExp(`^${runningGlyphPattern} Async agents(?:\\n|$)`));
		assert.doesNotMatch(text, /\b(?:agents?|jobs?) running\b/);
		assert.ok(text.indexOf("scout") < text.indexOf("queued"), "running row should precede queued summary");
		assert.ok(text.indexOf("queued") < text.indexOf("reviewer"), "queued summary should precede completions");
		assert.match(text, /⎿  read/);
	});

	it("keeps simultaneous single-job summaries free of step terminology", () => {
		const now = Date.now();
		const text = buildWidgetLines(
			[
				{
					asyncId: "single-first",
					asyncDir: "/tmp/single-first",
					status: "running",
					mode: "single",
					agents: ["first"],
					currentStep: 0,
					stepsTotal: 1,
					turnCount: 5,
					toolCount: 1,
					totalTokens: { input: 8000, output: 4000, total: 12_000 },
					lastActivityAt: now,
					startedAt: now - 2000,
					updatedAt: now,
				},
				{
					asyncId: "single-second",
					asyncDir: "/tmp/single-second",
					status: "running",
					mode: "single",
					agents: ["second"],
					currentStep: 0,
					stepsTotal: 1,
					turnCount: 6,
					toolCount: 2,
					lastActivityAt: now - 2_000,
					startedAt: now - 3000,
					updatedAt: now,
				},
			],
			theme,
			180,
		).join("\n");

		assert.match(text, /first/);
		assert.match(text, /second/);
		assert.match(text, new RegExp(`⎿  ${escapeRegExp(whimsicalThinkingPhrase(5))}\\n[^\\n]*active now`));
		assert.match(text, new RegExp(`⎿  ${escapeRegExp(whimsicalThinkingPhrase(6))}\\n[^\\n]*active 2s ago`));
		assert.doesNotMatch(text, /5 turns|6 turns|1 tool use|2 tool uses|12k token|3\.0s|\bsteps?\b|\bchain\b/i);
	});

	it("shows the resolved tk ticket title before the live-detail hint", () => {
		const lines = buildWidgetLines(
			[
				{
					asyncId: "run-ticket",
					asyncDir: "/tmp/run-ticket",
					status: "running",
					mode: "single",
					agents: ["worker"],
					tkTicket: { id: "psr-raw4", title: "Show active tk title" },
					steps: [{ index: 0, agent: "worker", status: "running", currentTool: "read" }],
					stepsTotal: 1,
					startedAt: Date.now() - 1000,
					updatedAt: Date.now(),
				},
			],
			theme,
			160,
		);

		const text = lines.join("\n");
		assert.match(text, /working on tk: Show active tk title/);
		assert.ok(text.indexOf("working on tk: Show active tk title") < text.indexOf("Press Ctrl+Shift+D for live detail"));
	});

	it("shows the tk ticket title for mixed chain layouts before live detail", () => {
		const text = buildWidgetLines(
			[
				{
					asyncId: "run-chain-ticket",
					asyncDir: "/tmp/run-chain-ticket",
					status: "running",
					mode: "chain",
					agents: ["scout", "reviewer", "writer"],
					tkTicket: { id: "psr-raw4", title: "Show active tk title" },
					activeParallelGroup: false,
					currentStep: 2,
					chainStepCount: 2,
					parallelGroups: [{ start: 0, count: 2, stepIndex: 0 }],
					stepsTotal: 3,
					steps: [
						{ index: 0, agent: "scout", status: "complete" },
						{ index: 1, agent: "reviewer", status: "complete" },
						{ index: 2, agent: "writer", status: "running", currentTool: "read" },
					],
				},
			],
			theme,
			180,
		).join("\n");

		assert.match(text, /working on tk: Show active tk title/);
		assert.match(text, /Step 1\/2: parallel group · 2\/2 done/);
		assert.ok(text.indexOf("working on tk: Show active tk title") < text.indexOf("Press Ctrl+Shift+D for live detail"));
		assert.equal(text.match(/working on tk: Show active tk title/g)?.length, 1);
	});

	it("shows tk ticket titles once in active multi-job rows before live detail", () => {
		const text = buildWidgetLines(
			[
				{
					asyncId: "run-ticket",
					asyncDir: "/tmp/run-ticket",
					status: "running",
					mode: "parallel",
					activeParallelGroup: true,
					agents: ["ticketed"],
					tkTicket: { id: "psr-raw4", title: "Show active tk title" },
					steps: [{ index: 0, agent: "ticketed", status: "running", currentTool: "read" }],
					stepsTotal: 1,
				},
				{
					asyncId: "run-plain",
					asyncDir: "/tmp/run-plain",
					status: "running",
					mode: "parallel",
					activeParallelGroup: true,
					agents: ["plain"],
					steps: [{ index: 0, agent: "plain", status: "running", currentTool: "grep" }],
					stepsTotal: 1,
				},
			],
			theme,
			180,
		).join("\n");

		assert.equal(text.match(/working on tk: Show active tk title/g)?.length, 1);
		assert.doesNotMatch(text, /plain[\s\S]*working on tk:/);
		assert.ok(text.indexOf("working on tk: Show active tk title") < text.indexOf("⎿  read"));
	});

	it("uses spinner and done wording for async jobs with parallel groups", () => {
		const lines = buildWidgetLines(
			[
				{
					asyncId: "run-1",
					asyncDir: "/tmp/1",
					status: "running",
					mode: "parallel",
					agents: ["scout", "reviewer", "worker"],
					hasParallelGroups: true,
					activeParallelGroup: true,
					runningSteps: 3,
					completedSteps: 0,
					stepsTotal: 3,
				},
			],
			theme,
			120,
		);

		const text = lines.join("\n");
		assert.match(text, /0\/3 done/);
		assert.doesNotMatch(text, /\b(?:agents?|jobs?) running\b/);
		assert.match(text, new RegExp(`⎿  ${escapeRegExp(whimsicalThinkingPhrase(0))}`));
		assert.doesNotMatch(text, /parallel · scout, reviewer, worker/);
		assert.doesNotMatch(text, /step 1\/3/);
	});

	it("collapses repeated async parallel agent names", () => {
		const lines = buildWidgetLines(
			[
				{
					asyncId: "run-1",
					asyncDir: "/tmp/1",
					status: "running",
					mode: "parallel",
					agents: ["reviewer", "reviewer", "reviewer"],
					activeParallelGroup: true,
					runningSteps: 3,
					completedSteps: 0,
					stepsTotal: 3,
				},
			],
			theme,
			120,
		);

		const text = lines.join("\n");
		assert.match(text, /0\/3 done/);
		assert.doesNotMatch(text, /\b(?:agents?|jobs?) running\b/);
		assert.doesNotMatch(text, /parallel · reviewer ×3/);
		assert.doesNotMatch(text, /reviewer → reviewer → reviewer/);
	});

	it("keeps parallel aggregate rows free of step terminology", () => {
		const text = buildWidgetLines(
			[
				{
					asyncId: "parallel-pending",
					asyncDir: "/tmp/parallel-pending",
					status: "running",
					mode: "parallel",
					agents: ["scout", "reviewer"],
					currentStep: 0,
					stepsTotal: 2,
				},
			],
			theme,
			140,
		).join("\n");

		assert.match(text, /async subagents \(2\)/);
		assert.match(text, /0\/2 done/);
		assert.doesNotMatch(text, /\b(?:agents?|jobs?) running\b/);
		assert.doesNotMatch(text, /\bsteps?\b|\bchain\b/i);
	});

	it("hides protected paused lifecycle paths from widget activity", () => {
		const lines = buildWidgetLines(
			[
				{
					asyncId: "paused-1",
					asyncDir: "/tmp/paused-1",
					status: "paused",
					agents: ["worker"],
					currentPath: "/private/root/project/file.ts",
					steps: [
						{
							index: 0,
							agent: "worker",
							status: "paused",
							currentPath: "/private/root/project/file.ts",
							children: [
								{
									id: "nested-private",
									parentRunId: "paused-1",
									depth: 1,
									path: [],
									state: "paused",
									error: "cleanup failed at /private/root/nested.log for pid 54321",
								},
							],
						},
					],
				},
			],
			theme,
			160,
			true,
		);

		const text = lines.join("\n");
		assert.match(text, /paused/);
		assert.match(text, /lifecycle status requires attention/);
		assert.doesNotMatch(text, /\/private\/|54321|cleanup failed/);
	});

	it("suppresses whimsical phrases while surfacing async and parallel health warnings", () => {
		const now = 20_000;
		const jobs: AsyncJobState[] = [
			{
				asyncId: "health-attention",
				asyncDir: "/tmp/health-attention",
				status: "running",
				mode: "single",
				agents: ["attention"],
				activityState: "needs_attention",
				turnCount: 11,
				lastActivityAt: now - 5_000,
				updatedAt: now,
			},
			{
				asyncId: "health-long-running",
				asyncDir: "/tmp/health-long-running",
				status: "running",
				mode: "single",
				agents: ["long-running"],
				activityState: "active_long_running",
				turnCount: 12,
				lastActivityAt: now - 5_000,
				updatedAt: now,
			},
			{
				asyncId: "health-parallel",
				asyncDir: "/tmp/health-parallel",
				status: "running",
				mode: "parallel",
				agents: ["parallel-worker"],
				activeParallelGroup: true,
				runningSteps: 1,
				completedSteps: 0,
				stepsTotal: 1,
				updatedAt: now,
				steps: [
					{
						index: 0,
						agent: "parallel-worker",
						status: "running",
						activityState: "needs_attention",
						turnCount: 13,
						toolCount: 7,
						tokens: { input: 8_000, output: 5_000, total: 13_000 },
						durationMs: 9_000,
						lastActivityAt: now - 5_000,
					},
				],
			},
		];
		const text = buildWidgetLines(jobs, theme, 180).join("\n");

		assert.match(text, /no activity for 5s/);
		assert.match(text, /active but long-running · last activity 5s ago/);
		for (const turnCount of [11, 12, 13])
			assert.doesNotMatch(text, new RegExp(escapeRegExp(whimsicalThinkingPhrase(turnCount))));

		const expanded = buildWidgetLines(jobs, theme, 180, true).join("\n");
		assert.match(expanded, /Agent 1\/1: parallel-worker · no activity for 5s · 13 turns · 7 tools · 13k token · 9\.0s/);
		assert.doesNotMatch(expanded, new RegExp(escapeRegExp(whimsicalThinkingPhrase(13))));
	});

	it("suppresses health phrases in the constrained progressive row", () => {
		resetWidgetLayout();
		withStdoutSize(22, 120, () => {
			const now = 20_000;
			const ui = createUiContext();
			renderWidget(ui.ctx as never, [
				{
					asyncId: "progressive-health",
					asyncDir: "/tmp/progressive-health",
					status: "running",
					mode: "single",
					agents: ["attention"],
					activityState: "needs_attention",
					turnCount: 21,
					lastActivityAt: now - 5_000,
					updatedAt: now,
				},
				{
					asyncId: "progressive-read",
					asyncDir: "/tmp/progressive-read",
					status: "running",
					mode: "single",
					agents: ["reader"],
					currentTool: "read",
				},
				{
					asyncId: "progressive-edit",
					asyncDir: "/tmp/progressive-edit",
					status: "running",
					mode: "single",
					agents: ["editor"],
					currentTool: "edit",
				},
			]);
			const text = renderWidgetLines(ui.widgets.at(-1)).join("\n");
			assert.match(text, /attention · no activity for 5s/);
			assert.doesNotMatch(text, new RegExp(escapeRegExp(whimsicalThinkingPhrase(21))));
		});
		resetWidgetLayout();
	});

	it("keeps pausing visible when compact health warnings are present", () => {
		const now = 20_000;
		const parallelText = buildWidgetLines(
			[
				{
					asyncId: "pausing-health-parallel",
					asyncDir: "/tmp/pausing-health-parallel",
					status: "running",
					mode: "parallel",
					agents: ["worker"],
					activeParallelGroup: true,
					runningSteps: 1,
					completedSteps: 0,
					stepsTotal: 1,
					updatedAt: now,
					steps: [
						{
							index: 0,
							agent: "worker",
							status: "running",
							interruptRequestedAt: now - 100,
							activityState: "needs_attention",
							turnCount: 23,
							lastActivityAt: now - 5_000,
						},
					],
				},
				{
					asyncId: "pausing-health-finished",
					asyncDir: "/tmp/pausing-health-finished",
					status: "complete",
					mode: "single",
					agents: ["done"],
				},
			],
			theme,
			180,
		).join("\n");
		assert.match(parallelText, /Agent 1\/1: worker · pausing · pausing…/);
		const parallelStep = parallelText.split("\n").find((line) => line.includes("Agent 1/1")) ?? "";
		assert.doesNotMatch(parallelStep, /no activity for|active but long-running/);
		assert.doesNotMatch(parallelText, new RegExp(escapeRegExp(whimsicalThinkingPhrase(23))));

		resetWidgetLayout();
		withStdoutSize(22, 120, () => {
			const ui = createUiContext();
			renderWidget(ui.ctx as never, [
				{
					asyncId: "pausing-health-progressive",
					asyncDir: "/tmp/pausing-health-progressive",
					status: "running",
					mode: "single",
					agents: ["pausing-worker"],
					interruptRequestedAt: now - 100,
					activityState: "needs_attention",
					turnCount: 24,
					lastActivityAt: now - 5_000,
					updatedAt: now,
				},
				{
					asyncId: "pausing-health-read",
					asyncDir: "/tmp/pausing-health-read",
					status: "running",
					mode: "single",
					agents: ["reader"],
					currentTool: "read",
				},
				{
					asyncId: "pausing-health-edit",
					asyncDir: "/tmp/pausing-health-edit",
					status: "running",
					mode: "single",
					agents: ["editor"],
					currentTool: "edit",
				},
			]);
			const text = renderWidgetLines(ui.widgets.at(-1)).join("\n");
			const progressiveRow = text.split("\n").find((line) => line.includes("pausing-worker")) ?? "";
			assert.match(progressiveRow, /pausing-worker · pausing…/);
			assert.doesNotMatch(progressiveRow, /no activity for|active but long-running/);
			assert.doesNotMatch(progressiveRow, new RegExp(escapeRegExp(whimsicalThinkingPhrase(24))));
		});
		resetWidgetLayout();
	});

	it("keeps step-level pausing over each health warning in real progressive rows", () => {
		const now = 20_000;
		const healthCases = [
			{ state: "needs_attention", turnCount: 25, warning: /no activity for 5s/ },
			{ state: "active_long_running", turnCount: 26, warning: /active but long-running · last activity 5s ago/ },
		] as const;

		for (const { state, turnCount, warning } of healthCases) {
			resetWidgetLayout();
			withStdoutSize(22, 120, () => {
				const ui = createUiContext();
				renderWidget(ui.ctx as never, [
					{
						asyncId: `step-pausing-${state}`,
						asyncDir: `/tmp/step-pausing-${state}`,
						status: "running",
						mode: "single",
						agents: ["step-pausing-worker"],
						updatedAt: now,
						steps: [
							{
								index: 0,
								agent: "step-pausing-worker",
								status: "running",
								interruptRequestedAt: now - 100,
								activityState: state,
								turnCount,
								lastActivityAt: now - 5_000,
							},
						],
					},
					{
						asyncId: `step-pausing-read-${state}`,
						asyncDir: "/tmp/step-pausing-read",
						status: "running",
						mode: "single",
						agents: ["reader"],
						currentTool: "read",
					},
					{
						asyncId: `step-pausing-edit-${state}`,
						asyncDir: "/tmp/step-pausing-edit",
						status: "running",
						mode: "single",
						agents: ["editor"],
						currentTool: "edit",
					},
				]);

				const harnessLines = renderWidgetHarnessLines(ui.widgets.at(-1));
				const harnessRow = harnessLines.find((line) => line.includes("step-pausing-worker")) ?? "";
				assert.match(harnessRow, /step-pausing-worker · pausing…/);
				assert.doesNotMatch(harnessRow, warning);
				assert.doesNotMatch(harnessRow, /needs attention/);
				assert.doesNotMatch(harnessRow, new RegExp(escapeRegExp(whimsicalThinkingPhrase(turnCount))));

				const realLines = renderWithRealPiTui(harnessLines, 120);
				const realRow = realLines.find((line) => line.includes("step-pausing-worker")) ?? "";
				assert.match(realRow, /step-pausing-worker · pausing…/);
				assert.doesNotMatch(realRow, warning);
				assert.doesNotMatch(realRow, /needs attention/);
				assert.doesNotMatch(realRow, new RegExp(escapeRegExp(whimsicalThinkingPhrase(turnCount))));
			});
		}
		resetWidgetLayout();
	});

	it("shows aggregate N agents pausing cue while suppressing running labels", () => {
		const now = 20_000;
		const text = buildWidgetLines(
			[
				{
					asyncId: "parallel-pausing-aggregate",
					asyncDir: "/tmp/parallel-pausing-aggregate",
					status: "running" as const,
					mode: "parallel" as const,
					agents: ["worker-1", "worker-2", "worker-3"],
					activeParallelGroup: true,
					runningSteps: 2,
					completedSteps: 1,
					stepsTotal: 3,
					interruptRequestedAt: now - 100,
					updatedAt: now,
					steps: [
						{ index: 0, agent: "worker-1", status: "running" as const, interruptRequestedAt: now - 100 },
						{ index: 1, agent: "worker-2", status: "running" as const, interruptRequestedAt: now - 100 },
						{ index: 2, agent: "worker-3", status: "complete" as const },
					],
				},
			],
			theme,
			180,
		).join("\n");
		// Aggregate pausing cue must be visible
		assert.match(text, /2 agents pausing/);
		// Running labels must be suppressed even when running steps exist
		assert.doesNotMatch(text, /\b(?:\d+(?:\/\d+)?|(?:agent|job|run)s?)\s+running\b/);
	});

	it("shows step-level pausing label while suppressing running label for non-pausing steps", () => {
		const now = 20_000;
		const text = buildWidgetLines(
			[
				{
					asyncId: "step-pausing-mixed",
					asyncDir: "/tmp/step-pausing-mixed",
					status: "running" as const,
					mode: "parallel" as const,
					agents: ["pausing-worker", "active-worker"],
					activeParallelGroup: true,
					runningSteps: 2,
					completedSteps: 0,
					stepsTotal: 2,
					updatedAt: now,
					steps: [
						{ index: 0, agent: "pausing-worker", status: "running" as const, interruptRequestedAt: now - 100 },
						{ index: 1, agent: "active-worker", status: "running" as const },
					],
				},
			],
			theme,
			180,
		).join("\n");
		// Step-level pausing label must be visible for the interrupt-requested step
		assert.match(text, /Agent 1\/2: pausing-worker · pausing/);
		// The non-pausing running step must not show a running label
		assert.doesNotMatch(text, /active-worker · running/);
		// No running labels anywhere in output
		assert.doesNotMatch(text, /\b(?:\d+(?:\/\d+)?|(?:agent|job|run)s?)\s+running\b/);
	});

	it("does not leak pausing child activity into a multi-job aggregate", () => {
		const now = 20_000;
		const text = buildWidgetLines(
			[
				{
					asyncId: "pausing-child-aggregate",
					asyncDir: "/tmp/pausing-child-aggregate",
					status: "running",
					mode: "parallel",
					agents: ["worker"],
					activeParallelGroup: true,
					runningSteps: 1,
					completedSteps: 0,
					stepsTotal: 1,
					updatedAt: now,
					steps: [
						{
							index: 0,
							agent: "worker",
							status: "running",
							interruptRequestedAt: now - 100,
							currentTool: "child-secret-tool",
							currentToolArgs: "--secret-child-args",
							currentToolStartedAt: now - 4_000,
							currentPath: "/private/child/project/secret.ts",
						},
					],
				},
				{
					asyncId: "pausing-child-finished",
					asyncDir: "/tmp/pausing-child-finished",
					status: "complete",
					mode: "single",
					agents: ["done"],
				},
			],
			theme,
			180,
		).join("\n");

		assert.match(text, /⎿  pausing…/);
		assert.match(text, /Agent 1\/1: worker · pausing · pausing…/);
		assert.doesNotMatch(text, /child-secret-tool|secret-child-args|private\/child|4\.0s/);
	});

	it("uses only job-level tool data while showing a pausing activity", () => {
		const now = 20_000;
		const childOnly = buildWidgetLines(
			[
				{
					asyncId: "pausing-child-only",
					asyncDir: "/tmp/pausing-child-only",
					status: "running",
					mode: "single",
					agents: ["worker"],
					interruptRequestedAt: now - 100,
					updatedAt: now,
					steps: [
						{
							index: 0,
							agent: "worker",
							status: "running",
							currentTool: "child-secret",
							currentToolStartedAt: now - 4_000,
						},
					],
				},
				{
					asyncId: "pausing-finished",
					asyncDir: "/tmp/pausing-finished",
					status: "complete",
					mode: "single",
					agents: ["done"],
				},
			],
			theme,
			180,
		).join("\n");
		assert.match(childOnly, /pausing…/);
		assert.doesNotMatch(childOnly, /child-secret/);

		const jobTool = buildWidgetLines(
			[
				{
					asyncId: "pausing-job-tool",
					asyncDir: "/tmp/pausing-job-tool",
					status: "running",
					mode: "single",
					agents: ["worker"],
					interruptRequestedAt: now - 100,
					currentTool: "job-tool",
					currentToolStartedAt: now - 2_000,
					updatedAt: now,
					steps: [
						{
							index: 0,
							agent: "worker",
							status: "running",
							currentTool: "child-secret",
							currentToolStartedAt: now - 4_000,
						},
					],
				},
				{
					asyncId: "pausing-finished-2",
					asyncDir: "/tmp/pausing-finished-2",
					status: "complete",
					mode: "single",
					agents: ["done"],
				},
			],
			theme,
			180,
		).join("\n");
		assert.match(jobTool, /pausing… · job-tool 2\.0s/);
		assert.doesNotMatch(jobTool, /child-secret/);
	});

	it("renders a compact component widget for three active parallel agents without core truncation", () => {
		const now = Date.now();
		const ui = createUiContext();
		renderWidget(ui.ctx as never, [
			{
				asyncId: "run-1",
				asyncDir: "/tmp/1",
				status: "running",
				mode: "parallel",
				agents: ["reviewer", "reviewer", "reviewer"],
				activeParallelGroup: true,
				runningSteps: 3,
				completedSteps: 0,
				stepsTotal: 3,
				updatedAt: now,
				steps: [
					{
						index: 0,
						agent: "reviewer",
						status: "running",
						lastActivityAt: now,
						turnCount: 5,
						toolCount: 18,
						tokens: { input: 30_000, output: 10_000, total: 44_000 },
					},
					{
						index: 1,
						agent: "reviewer",
						status: "running",
						lastActivityAt: now - 2000,
						turnCount: 4,
						toolCount: 13,
						tokens: { input: 16_000, output: 4_000, total: 22_000 },
					},
					{
						index: 2,
						agent: "reviewer",
						status: "running",
						currentTool: "grep",
						currentToolStartedAt: now - 1000,
						turnCount: 3,
						toolCount: 11,
						tokens: { input: 14_000, output: 3_000, total: 19_000 },
					},
				],
			},
		]);
		const widget = ui.widgets.at(-1);
		assert.equal(
			typeof widget,
			"function",
			"renderWidget should install a component widget, not a capped string-array widget",
		);
		const lines = (widget as (_tui: unknown, widgetTheme: typeof theme) => { render(width: number): string[] })(
			undefined,
			theme,
		)
			.render(180)
			.map((line) => line.trimEnd());
		const text = lines.join("\n");
		assert.match(text, /async subagents \(3\)/);
		assert.match(text, new RegExp(`Agent 1/3: reviewer · ${escapeRegExp(whimsicalThinkingPhrase(5))} · active now`));
		assert.match(text, new RegExp(`Agent 2/3: reviewer · ${escapeRegExp(whimsicalThinkingPhrase(4))} · active 2s ago`));
		assert.match(text, /Agent 3\/3: reviewer · grep \| 1\.0s/);
		assert.doesNotMatch(
			text,
			/5 turns|18 tool uses|44k token|4 turns|13 tool uses|22k token|3 turns|11 tool uses|19k token/,
		);
		assert.match(text, /Press Ctrl\+Shift\+D for live detail/);
		assert.doesNotMatch(text, /widget truncated/);
		assert.ok(
			lines.length <= 10,
			"collapsed component should stay under Pi's string-widget cap even though it bypasses it",
		);
	});

	it("preserves freshness while fitting long phrases into 60-column parallel rows", () => {
		resetWidgetLayout();
		withStdoutSize(60, 60, () => {
			const now = 20_000;
			const ui = createUiContext();
			renderWidget(ui.ctx as never, [
				{
					asyncId: "run-narrow-parallel",
					asyncDir: "/tmp/run-narrow-parallel",
					status: "running",
					mode: "parallel",
					agents: ["reviewer", "reviewer", "reviewer"],
					activeParallelGroup: true,
					runningSteps: 3,
					completedSteps: 0,
					stepsTotal: 3,
					updatedAt: now,
					steps: Array.from({ length: 3 }, (_, index) => ({
						index,
						agent: "reviewer",
						status: "running",
						turnCount: 19,
						lastActivityAt: now,
					})),
				},
			]);

			const lines = renderWidgetLines(ui.widgets.at(-1), 60);
			const row = lines.find((line) => line.includes("Agent 1/3")) ?? "";
			assert.match(row, /Agent 1\/3: reviewer/);
			assertWrappedSource(lines, whimsicalThinkingPhrase(19));
			assertWrappedSource(lines, "active now");
			for (const line of lines)
				assert.ok(visibleWidth(line) <= 58, `parallel row should fit 58 columns: ${JSON.stringify(line)}`);
		});
		resetWidgetLayout();
	});

	it("keeps compactSingleWidgetLines health identity in 40/50-column parallel rows", () => {
		const now = 20_000;
		const healthCases = [
			{ state: "needs_attention", turnCount: 27, warning: "no activity for 5s" },
			{
				state: "active_long_running",
				turnCount: 28,
				warning: "active but long-running · last activity 5s ago",
			},
		] as const;

		for (const width of [40, 50]) {
			for (const { state, turnCount, warning } of healthCases) {
				resetWidgetLayout();
				withStdoutSize(60, width, () => {
					const ui = createUiContext();
					renderWidget(ui.ctx as never, [
						{
							asyncId: `narrow-health-${state}`,
							asyncDir: `/tmp/narrow-health-${state}`,
							status: "running",
							mode: "parallel",
							agents: ["worker", "worker", "worker", "worker"],
							activeParallelGroup: true,
							runningSteps: 4,
							completedSteps: 0,
							stepsTotal: 4,
							updatedAt: now,
							steps: Array.from({ length: 4 }, (_, index) => ({
								index,
								agent: "worker",
								status: "running",
								activityState: state,
								turnCount,
								lastActivityAt: now - 5_000,
							})),
						},
					]);

					const harnessLines = renderWidgetHarnessLines(ui.widgets.at(-1));
					const harnessRow = harnessLines.find((line) => line.includes("Agent 1/4")) ?? "";
					assert.match(harnessRow, /Agent 1\/4/);
					assertWrappedSource(harnessLines, warning);
					assert.doesNotMatch(harnessLines.join(""), new RegExp(escapeRegExp(whimsicalThinkingPhrase(turnCount))));
					for (const line of harnessLines)
						assert.ok(
							visibleWidth(line) <= width - 2,
							`harness row should fit ${width - 2} columns: ${JSON.stringify(line)}`,
						);

					const realLines = renderWithRealPiTui(harnessLines, width);
					assert.equal(
						realLines.length,
						harnessLines.length,
						`real pi-tui Text must not add continuation rows at ${width} columns for ${state}`,
					);
					const realRow = realLines.find((line) => line.includes("Agent 1/4")) ?? "";
					assert.match(realRow, /Agent 1\/4/);
					assertWrappedSource(realLines, warning, true);
					assert.doesNotMatch(realLines.join(""), new RegExp(escapeRegExp(whimsicalThinkingPhrase(turnCount))));
					for (const line of realLines)
						assert.equal(
							visibleWidth(line),
							width,
							`real pi-tui should pad each row to ${width} columns: ${JSON.stringify(line)}`,
						);
				});
			}
		}
		resetWidgetLayout();
	});

	it("wraps complete progressive health warnings at 40/50 columns", () => {
		const now = 20_000;
		for (const width of [40, 50]) {
			resetWidgetLayout();
			withStdoutSize(24, width, () => {
				const ui = createUiContext();
				renderWidget(ui.ctx as never, [
					{
						asyncId: "progressive-health",
						asyncDir: "/tmp/progressive-health",
						status: "running",
						mode: "single",
						agents: ["health-job"],
						activityState: "active_long_running",
						lastActivityAt: now - 5_000,
						updatedAt: now,
					},
					{
						asyncId: "progressive-read",
						asyncDir: "/tmp/progressive-read",
						status: "running",
						mode: "single",
						agents: ["reader"],
						currentTool: "read",
					},
					{
						asyncId: "progressive-edit",
						asyncDir: "/tmp/progressive-edit",
						status: "running",
						mode: "single",
						agents: ["editor"],
						currentTool: "edit",
					},
					{
						asyncId: "progressive-write",
						asyncDir: "/tmp/progressive-write",
						status: "running",
						mode: "single",
						agents: ["writer"],
						currentTool: "write",
					},
				]);

				const harnessLines = renderWidgetHarnessLines(ui.widgets.at(-1));
				const harnessRow = harnessLines.find((line) => line.includes("health-job")) ?? "";
				assert.match(harnessRow, /health-job/);
				assertWrappedSource(harnessLines, "active but long-running · last activity 5s ago");
				assert.match(harnessLines.join(""), /\+\d+ more/);
				for (const line of harnessLines)
					assert.ok(
						visibleWidth(line) <= width - 2,
						`harness row should fit ${width - 2} columns: ${JSON.stringify(line)}`,
					);

				const realLines = renderWithRealPiTui(harnessLines, width);
				assert.equal(
					realLines.length,
					harnessLines.length,
					`real pi-tui Text must not add continuation rows at ${width} columns`,
				);
				const realRow = realLines.find((line) => line.includes("health-job")) ?? "";
				assert.match(realRow, /health-job/);
				assertWrappedSource(realLines, "active but long-running · last activity 5s ago", true);
				for (const line of realLines)
					assert.equal(
						visibleWidth(line),
						width,
						`real pi-tui should pad each row to ${width} columns: ${JSON.stringify(line)}`,
					);
			});
		}
		resetWidgetLayout();
	});

	it("keeps widgetParallelAgentDetails identity with compact health warnings at 40/50 columns", () => {
		const now = 20_000;
		const healthCases = [
			{ state: "needs_attention", warning: "no activity for 5s" },
			{ state: "active_long_running", warning: "active but long-running · last activity 5s ago" },
		] as const;
		for (const width of [40, 50]) {
			for (const { state, warning } of healthCases) {
				const lines = buildWidgetLines(
					[
						{
							asyncId: `parallel-detail-health-${state}`,
							asyncDir: `/tmp/parallel-detail-health-${state}`,
							status: "running",
							mode: "parallel",
							agents: ["worker", "worker", "worker", "worker"],
							activeParallelGroup: true,
							runningSteps: 4,
							completedSteps: 0,
							stepsTotal: 4,
							updatedAt: now,
							steps: Array.from({ length: 4 }, (_, index) => ({
								index,
								agent: "worker",
								status: "running",
								activityState: state,
								lastActivityAt: now - 5_000,
							})),
						},
						{
							asyncId: `parallel-detail-done-${state}`,
							asyncDir: "/tmp/parallel-detail-done",
							status: "complete",
							mode: "single",
							agents: ["done"],
						},
					],
					theme,
					width,
				);
				const harnessRow = lines.find((line) => line.includes("Agent 1/4")) ?? "";
				assert.match(harnessRow, /Agent 1\/4/);
				assertWrappedSource(lines, warning);
				for (const line of lines)
					assert.ok(
						visibleWidth(line) <= width - 2,
						`harness row should fit ${width - 2} columns: ${JSON.stringify(line)}`,
					);

				const realLines = renderWithRealPiTui(lines, width);
				assert.equal(
					realLines.length,
					lines.length,
					`real pi-tui Text must not add continuation rows at ${width} columns for ${state}`,
				);
				const realRow = realLines.find((line) => line.includes("Agent 1/4")) ?? "";
				assert.match(realRow, /Agent 1\/4/);
				assertWrappedSource(realLines, warning, true);
				for (const line of realLines)
					assert.equal(
						visibleWidth(line),
						width,
						`real pi-tui should pad each row to ${width} columns: ${JSON.stringify(line)}`,
					);
			}
		}
	});

	it("budgets multi-job branch and detail rows for real Text padding at 40/50 columns", () => {
		const now = 20_000;
		const jobs: AsyncJobState[] = [
			{
				asyncId: "multi-job-width",
				asyncDir: "/tmp/multi-job-width",
				status: "running",
				mode: "single",
				agents: ["header-agent-name-that-is-deliberately-long"],
				turnCount: 41,
				lastActivityAt: now - 2_000,
				updatedAt: now,
			},
			{
				asyncId: "multi-job-width-done",
				asyncDir: "/tmp/multi-job-width-done",
				status: "complete",
				mode: "single",
				agents: ["done"],
			},
		];

		for (const width of [40, 50]) {
			const lines = buildWidgetLines(jobs, theme, width);
			const contentWidth = Math.max(1, width - 2);
			assert.ok(
				lines.some((line) => line.includes(whimsicalThinkingPhrase(41).slice(0, 20))),
				"long thinking phrase should remain in the harness output",
			);
			assert.ok(
				lines.some((line) => line.includes("header-agent-name")),
				"long job header should remain in the harness output",
			);
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= contentWidth,
					`multi-job line should fit ${contentWidth} columns at ${width}: ${JSON.stringify(line)}`,
				);
			}

			const realLines = renderWithRealPiTui(lines, width);
			assert.equal(
				realLines.length,
				lines.length,
				`real pi-tui Text must not add continuation rows at ${width} columns`,
			);
			for (const line of realLines)
				assert.equal(visibleWidth(line), width, `real pi-tui should pad each row to ${width} columns`);
		}
	});

	it("locks crowded widget rows at the reviewer narrow-width probes", () => {
		const now = 20_000;
		const jobs: AsyncJobState[] = Array.from(
			{ length: 8 },
			(_, index): AsyncJobState => ({
				asyncId: `crowded-width-${index}`,
				asyncDir: `/tmp/crowded-width-${index}`,
				status: "running",
				mode: "single",
				agents: [`crowded-agent-with-a-long-name-${index}`],
				lastActivityAt: now - index * 1_000,
				updatedAt: now,
			}),
		);

		for (const { rows, columns, expectedRows, description, jobs: probeJobs } of [
			{ rows: 22, columns: 20, expectedRows: 3, description: "progressive", jobs },
			{ rows: 6, columns: 20, expectedRows: 1, description: "single-line", jobs: jobs.slice(0, 6) },
		] as const) {
			resetWidgetLayout();
			withStdoutSize(rows, columns, () => {
				const ui = createUiContext();
				renderWidget(ui.ctx as never, probeJobs);
				const harnessLines = renderWidgetHarnessLines(ui.widgets.at(-1));
				assert.equal(harnessLines.length, expectedRows, `${description} harness row count`);
				for (const line of harnessLines)
					assert.ok(
						visibleWidth(line) <= columns - 2,
						`${description} harness line should fit ${columns - 2} columns: ${JSON.stringify(line)}`,
					);
				if (description === "progressive") assert.match(harnessLines.join("\n"), /\+\d+ more/);
				if (description === "single-line") {
					assert.match(harnessLines[0] ?? "", /subagents/);
					assert.doesNotMatch(harnessLines[0] ?? "", /\d+ running|\brunning\b/);
				}

				const realLines = renderWithRealPiTui(harnessLines, columns);
				assert.equal(
					realLines.length,
					harnessLines.length,
					`${description} real pi-tui row count must match the harness`,
				);
				for (const line of realLines)
					assert.equal(
						visibleWidth(line),
						columns,
						`${description} real pi-tui row should be padded to ${columns} columns`,
					);
			});
		}

		resetWidgetLayout();
		withStdoutSize(22, 120, () => {
			const ui = createUiContext();
			renderWidget(ui.ctx as never, jobs);
			const normalWidthText = renderWidgetHarnessLines(ui.widgets.at(-1)).join("\n");
			assert.match(normalWidthText, /Async agents/);
			assert.doesNotMatch(normalWidthText, /\b(?:agents?|jobs?) running\b/);
			assert.match(normalWidthText, /crowded-agent-with-a-long-name-0/);
		});
		resetWidgetLayout();
	});

	it("keeps expanded one-job telemetry rows unwrapped at real 40/50-column widths", () => {
		const now = 20_000;
		for (const width of [40, 50]) {
			resetWidgetLayout();
			withStdoutSize(40, width, () => {
				const ui = createUiContext();
				const liveDetailController = createSubagentLiveDetailController(true);
				renderWidget(
					ui.ctx as never,
					[
						{
							asyncId: `expanded-width-${width}`,
							asyncDir: `/tmp/expanded-width-${width}`,
							status: "running",
							mode: "single",
							agents: ["w"],
							stepsTotal: 1,
							startedAt: now - 9_000,
							updatedAt: now,
							steps: [
								{
									index: 0,
									agent: "w",
									status: "running",
									turnCount: 5,
									toolCount: 7,
									tokens: { input: 8_000, output: 5_000, total: 13_000 },
									durationMs: 9_000,
									currentTool: "read-long-tool-name",
									currentToolArgs: "src/tui/render.ts --very-long-argument-here",
									currentToolStartedAt: now - 2_000,
									recentTools: [{ tool: "grep", args: "long args", endMs: 1 }],
									recentOutput: ["expanded telemetry output"],
								},
							],
						},
					],
					liveDetailController,
				);

				const harnessLines = renderWidgetHarnessLines(ui.widgets.at(-1));
				const harnessText = harnessLines.join("\n");
				assert.match(harnessText, /5 turns/);
				assert.match(harnessText, /7 tool/);
				assert.match(harnessText, /output:/);
				for (const line of harnessLines)
					assert.ok(
						visibleWidth(line) <= width - 2,
						`expanded harness line should fit ${width - 2} columns: ${JSON.stringify(line)}`,
					);

				const realLines = renderWithRealPiTui(harnessLines, width);
				assert.equal(
					realLines.length,
					harnessLines.length,
					`expanded real pi-tui row count must match at ${width} columns`,
				);
				assert.match(realLines.join("\n"), /5 turns/);
				assert.match(realLines.join("\n"), /7 tool/);
				for (const line of realLines)
					assert.equal(visibleWidth(line), width, `expanded real pi-tui row should be padded to ${width} columns`);
			});
		}
		resetWidgetLayout();
	});

	it("reserves every physical row of a wrapped hidden-line label", () => {
		resetWidgetLayout();
		withStdoutSize(22, 20, () => {
			const ui = createUiContext();
			const liveDetailController = createSubagentLiveDetailController(true);
			renderWidget(
				ui.ctx as never,
				[
					{
						asyncId: "expanded-hidden-label",
						asyncDir: "/tmp/expanded-hidden-label",
						status: "running",
						mode: "single",
						agents: ["worker"],
						stepsTotal: 1,
						steps: [
							{
								index: 0,
								agent: "worker",
								status: "running",
								recentTools: [],
								recentOutput: Array.from({ length: 5 }, (_, index) => `output-${index}-${"long-value-".repeat(8)}`),
							},
						],
					},
				],
				liveDetailController,
			);

			const lines = renderWidgetHarnessLines(ui.widgets.at(-1));
			assert.equal(lines.length, 12);
			assert.match(wrappedText(lines), /…\d+live-detaillineshidden/);
			assert.ok(lines.every((line) => visibleWidth(line) <= 18));
		});
		resetWidgetLayout();
	});

	it("locks crowded collapsed widget height for the current terminal session", () => {
		resetWidgetLayout();
		withStdoutSize(30, 120, () => {
			const now = 20_000;
			const crowdedJobs: AsyncJobState[] = Array.from(
				{ length: 3 },
				(_, jobIndex): AsyncJobState => ({
					asyncId: `run-${jobIndex + 1}`,
					asyncDir: `/tmp/run-${jobIndex + 1}`,
					status: "running",
					mode: "parallel",
					agents: ["scout", "reviewer"],
					activeParallelGroup: true,
					runningSteps: 2,
					completedSteps: 0,
					stepsTotal: 2,
					updatedAt: now + jobIndex,
					steps: [
						{ index: 0, agent: "scout", status: "running", currentTool: "read", currentToolStartedAt: now - 1000 },
						{ index: 1, agent: "reviewer", status: "running", currentTool: "grep", currentToolStartedAt: now - 2000 },
					],
				}),
			);
			const ui = createUiContext();

			renderWidget(ui.ctx as never, crowdedJobs);
			const crowdedLines = renderWidgetLines(ui.widgets.at(-1));
			assert.equal(crowdedLines.length, 10, "30 terminal rows should keep the compact widget cap while locking height");
			assert.match(crowdedLines.join("\n"), /Async agents/);
			assert.doesNotMatch(crowdedLines.join("\n"), /\b(?:agents?|jobs?) running\b/);

			renderWidget(ui.ctx as never, [
				{
					...crowdedJobs[0]!,
					status: "complete",
					runningSteps: 0,
					completedSteps: 2,
					steps: [
						{ index: 0, agent: "scout", status: "complete" },
						{ index: 1, agent: "reviewer", status: "complete" },
					],
				},
			]);
			const settledLines = renderWidgetLines(ui.widgets.at(-1));
			assert.equal(settledLines.length, 10, "collapsed widget keeps its locked row count until cleared or resized");
			assert.match(settledLines.join("\n"), /parallel · done/);

			renderWidget(ui.ctx as never, []);
			renderWidget(ui.ctx as never, [
				{ asyncId: "small", asyncDir: "/tmp/small", status: "running", agents: ["worker"], currentTool: "read" },
			]);
			const resetLines = renderWidgetLines(ui.widgets.at(-1));
			assert.ok(resetLines.length < 10, "clearing the widget starts a fresh layout session");
		});
		resetWidgetLayout();
	});

	it("keeps medium terminal progressive fallback within the compact cap", () => {
		resetWidgetLayout();
		withStdoutSize(50, 120, () => {
			const ui = createUiContext();
			const jobs: AsyncJobState[] = [
				{
					asyncId: "run-wide",
					asyncDir: "/tmp/run-wide",
					status: "running",
					mode: "parallel",
					agents: Array.from({ length: 40 }, (_, index) => `agent-${index}`),
					activeParallelGroup: true,
					runningSteps: 40,
					completedSteps: 0,
					stepsTotal: 40,
					steps: Array.from({ length: 40 }, (_, index) => ({
						index,
						agent: `agent-${index}`,
						status: "running",
						currentTool: "read",
					})),
				},
			];

			renderWidget(ui.ctx as never, jobs);
			const lines = renderWidgetLines(ui.widgets.at(-1));
			assert.equal(lines.length, 14);
			assert.match(lines.join("\n"), /parallel · 0\/40 done/);
			assert.doesNotMatch(lines.join("\n"), /· running\b/);
		});
		resetWidgetLayout();
	});

	it("keeps constrained progressive single-job rows focused and step-free", () => {
		resetWidgetLayout();
		withStdoutSize(22, 120, () => {
			const now = Date.now();
			const ui = createUiContext();
			const jobs: AsyncJobState[] = [
				{
					asyncId: "run-1",
					asyncDir: "/tmp/run-1",
					status: "running",
					mode: "single",
					agents: ["first"],
					currentStep: 0,
					stepsTotal: 1,
					toolCount: 1,
					currentTool: "read",
					startedAt: now - 2000,
					updatedAt: now,
				},
				{
					asyncId: "run-2",
					asyncDir: "/tmp/run-2",
					status: "running",
					mode: "single",
					agents: ["second"],
					currentStep: 0,
					stepsTotal: 1,
					currentTool: "grep",
				},
				{
					asyncId: "run-3",
					asyncDir: "/tmp/run-3",
					status: "running",
					mode: "single",
					agents: ["third"],
					currentStep: 0,
					stepsTotal: 1,
					currentTool: "edit",
				},
			];
			renderWidget(ui.ctx as never, jobs);
			const firstText = renderWidgetLines(ui.widgets.at(-1)).join("\n");
			assert.match(firstText, /first · read/);
			assert.doesNotMatch(firstText, new RegExp(escapeRegExp(whimsicalThinkingPhrase(0))));
			assert.doesNotMatch(firstText, /1 tool use|2\.0s|token|turn/);
			assert.match(firstText, /\+2 more/);
			assert.doesNotMatch(firstText, /\bsteps?\b|\bchain\b/i);

			renderWidget(ui.ctx as never, [{ ...jobs[0]!, status: "complete", currentTool: undefined }, jobs[1]!, jobs[2]!]);
			const updatedText = renderWidgetLines(ui.widgets.at(-1)).join("\n");
			assert.match(updatedText, /second/);
			assert.doesNotMatch(updatedText, /first · done/);
			assert.match(updatedText, /\+2 more/);
			assert.doesNotMatch(updatedText, /\bsteps?\b|\bchain\b/i);
		});
		resetWidgetLayout();
	});

	it("keeps thinking freshness and hides telemetry in constrained progressive rows", () => {
		resetWidgetLayout();
		withStdoutSize(22, 120, () => {
			const now = Date.now();
			const ui = createUiContext();
			renderWidget(ui.ctx as never, [
				{
					asyncId: "run-thinking",
					asyncDir: "/tmp/run-thinking",
					status: "running",
					mode: "single",
					agents: ["thinker"],
					turnCount: 5,
					toolCount: 18,
					totalTokens: { input: 30_000, output: 10_000, total: 44_000 },
					lastActivityAt: now,
					startedAt: now - 7_000,
					updatedAt: now,
				},
				{
					asyncId: "run-read",
					asyncDir: "/tmp/run-read",
					status: "running",
					mode: "single",
					agents: ["reader"],
					currentTool: "read",
				},
				{
					asyncId: "run-edit",
					asyncDir: "/tmp/run-edit",
					status: "running",
					mode: "single",
					agents: ["editor"],
					currentTool: "edit",
				},
			]);

			const text = renderWidgetLines(ui.widgets.at(-1)).join("\n");
			assert.match(text, new RegExp(`thinker · ${escapeRegExp(whimsicalThinkingPhrase(5))} · active now`));
			assert.doesNotMatch(text, /5 turns|18 tool uses|44k token|7\.0s/);
			assert.match(text, /\+2 more/);
		});
		resetWidgetLayout();
	});

	it("wraps complete thinking and freshness text in 40/50/60-column progressive rows", () => {
		for (const width of [40, 50, 60]) {
			resetWidgetLayout();
			withStdoutSize(24, width, () => {
				const now = 20_000;
				const ui = createUiContext();
				renderWidget(ui.ctx as never, [
					{
						asyncId: "run-thinking",
						asyncDir: "/tmp/run-thinking",
						status: "running",
						mode: "single",
						agents: ["thinker"],
						turnCount: 19,
						lastActivityAt: now - 2_000,
						updatedAt: now,
					},
					{
						asyncId: "run-read",
						asyncDir: "/tmp/run-read",
						status: "running",
						mode: "single",
						agents: ["reader"],
						currentTool: "read",
					},
					{
						asyncId: "run-edit",
						asyncDir: "/tmp/run-edit",
						status: "running",
						mode: "single",
						agents: ["editor"],
						currentTool: "edit",
					},
					{
						asyncId: "run-write",
						asyncDir: "/tmp/run-write",
						status: "running",
						mode: "single",
						agents: ["writer"],
						currentTool: "write",
					},
				]);

				const lines = renderWidgetLines(ui.widgets.at(-1), width);
				const row = lines.find((line) => line.includes("thinker")) ?? "";
				assert.match(row, /thinker ·/);
				assertWrappedSource(lines, whimsicalThinkingPhrase(19));
				assertWrappedSource(lines, "active 2s ago");
				assert.match(lines.join(""), /\+\d+ more/);
				for (const line of lines)
					assert.ok(
						visibleWidth(line) <= width - 2,
						`progressive row should fit ${width - 2} columns: ${JSON.stringify(line)}`,
					);
				assert.equal(
					wrappedText(lines).match(/active2sago/g)?.length,
					1,
					`freshness must appear once at ${width} columns`,
				);
			});
		}
		resetWidgetLayout();
	});

	it("shows tk ticket titles in progressive widget rows without changing non-ticket jobs", () => {
		resetWidgetLayout();
		withStdoutSize(22, 120, () => {
			const ui = createUiContext();
			renderWidget(ui.ctx as never, [
				{
					asyncId: "run-ticket",
					asyncDir: "/tmp/run-ticket",
					status: "running",
					mode: "single",
					agents: ["ticketed"],
					tkTicket: { id: "psr-raw4", title: "Show active tk title" },
					currentTool: "read",
				},
				{
					asyncId: "run-plain",
					asyncDir: "/tmp/run-plain",
					status: "running",
					mode: "single",
					agents: ["plain"],
					currentTool: "grep",
				},
				{
					asyncId: "run-hidden",
					asyncDir: "/tmp/run-hidden",
					status: "running",
					mode: "single",
					agents: ["hidden"],
					currentTool: "edit",
				},
			]);

			const text = renderWidgetLines(ui.widgets.at(-1)).join("\n");
			assert.match(text, /ticketed · working on tk: Show active tk title/);
			assert.doesNotMatch(text, /plain · working on tk:/);
			assert.equal(text.match(/working on tk: Show active tk title/g)?.length, 1);
		});
		resetWidgetLayout();
	});

	it("sanitizes and wraps complete direct tk ticket widget state", () => {
		const safeTitle = `Unsafe title now ${"x".repeat(120)}`;
		const lines = buildWidgetLines(
			[
				{
					asyncId: "run-unsafe-ticket",
					asyncDir: "/tmp/run-unsafe-ticket",
					status: "running",
					agents: ["worker"],
					tkTicket: { id: "psr-raw4", title: `Unsafe\u009b title\u001b[31m now\u001b[0m ${"x".repeat(120)}` },
					currentTool: "read",
				},
			],
			theme,
			90,
		);

		assertWrappedSource(lines, safeTitle);
		assert.ok(lines.every((line) => visibleWidth(line) <= 88));
		assert.doesNotMatch(lines.join(""), /…|\u009b|\u001b\[31m/);
	});

	it("uses a single collapsed widget line when the terminal has almost no spare rows", () => {
		resetWidgetLayout();
		withStdoutSize(20, 120, () => {
			const ui = createUiContext();
			renderWidget(ui.ctx as never, [
				{
					asyncId: "run-tiny",
					asyncDir: "/tmp/run-tiny",
					status: "running",
					agents: ["worker"],
					currentTool: "read",
				},
			]);

			const lines = renderWidgetLines(ui.widgets.at(-1));
			assert.equal(lines.length, 1);
			assert.match(lines[0] ?? "", /subagents/);
			assert.doesNotMatch(lines[0] ?? "", /\b(?:\d+(?:\/\d+)?|(?:agent|job|run)s?)\s+running\b/);
		});
		resetWidgetLayout();
	});

	it("keeps expanded async widgets on the full-detail path", () => {
		resetWidgetLayout();
		withStdoutSize(20, 120, () => {
			const ui = createUiContext();
			const liveDetailController = createSubagentLiveDetailController(true);
			renderWidget(
				ui.ctx as never,
				[
					{
						asyncId: "run-expanded",
						asyncDir: "/tmp/run-expanded",
						status: "running",
						mode: "parallel",
						agents: ["reviewer"],
						activeParallelGroup: true,
						runningSteps: 1,
						completedSteps: 0,
						stepsTotal: 1,
						steps: [{ index: 0, agent: "reviewer", status: "running", currentTool: "read" }],
					},
				],
				liveDetailController,
			);

			const text = renderWidgetLines(ui.widgets.at(-1)).join("\n");
			assert.match(text, /async subagents \(1\)/);
			assert.match(text, /Agent 1\/1: reviewer/);
			assert.doesNotMatch(text, /· running\b/);
			assert.doesNotMatch(text, /subagents \(1\/1 running\)/);
		});
		resetWidgetLayout();
	});

	it("shows per-agent detail for active async parallel widget rows", () => {
		const now = Date.now();
		const lines = buildWidgetLines(
			[
				{
					asyncId: "run-1",
					asyncDir: "/tmp/1",
					status: "running",
					mode: "parallel",
					agents: ["reviewer", "reviewer", "reviewer"],
					activeParallelGroup: true,
					runningSteps: 2,
					completedSteps: 1,
					stepsTotal: 3,
					updatedAt: now,
					steps: [
						{ agent: "reviewer", status: "running", lastActivityAt: now, toolCount: 2 },
						{ agent: "reviewer", status: "running", currentTool: "read", currentToolStartedAt: now - 2000 },
						{ agent: "reviewer", status: "complete", tokens: { input: 1000, output: 500, total: 1500 } },
					],
				},
			],
			theme,
			160,
		);

		const text = lines.join("\n");
		assert.match(text, /async subagents \(3\)/);
		assert.match(text, /1\/3 done/);
		assert.doesNotMatch(text, /\b(?:agents?|jobs?) running\b/);
		assert.match(
			text,
			new RegExp(`Agent 1/3: reviewer\\n\\s+⎿  ${escapeRegExp(whimsicalThinkingPhrase(0))}\\n\\s+active now`),
		);
		assert.match(text, /Agent 2\/3: reviewer[\s\S]*⎿  read \| 2\.0s/);
		assert.match(text, /Press Ctrl\+Shift\+D for live detail/);
		assert.match(text, /Agent 3\/3: reviewer · complete/);
		assert.doesNotMatch(text, /2 tool uses|1\.5k token/);
	});

	it("preserves freshness for compact parallel details in narrow multi-job rows", () => {
		const now = 20_000;
		const lines = buildWidgetLines(
			[
				{
					asyncId: "parallel-narrow",
					asyncDir: "/tmp/parallel-narrow",
					status: "running",
					mode: "parallel",
					agents: ["reviewer", "reviewer"],
					activeParallelGroup: true,
					runningSteps: 1,
					completedSteps: 1,
					stepsTotal: 2,
					updatedAt: now,
					steps: [
						{ index: 0, agent: "reviewer", status: "running", turnCount: 19, lastActivityAt: now - 2_000 },
						{ index: 1, agent: "reviewer", status: "complete" },
					],
				},
				{
					asyncId: "other-job",
					asyncDir: "/tmp/other-job",
					status: "complete",
					mode: "single",
					agents: ["other"],
					updatedAt: now,
				},
			],
			theme,
			60,
		);

		const row = lines.find((line) => line.includes("Agent 1/2")) ?? "";
		assert.match(row, /Agent 1\/2: reviewer/);
		assertWrappedSource(lines, whimsicalThinkingPhrase(19));
		assertWrappedSource(lines, "active 2s ago");
		assert.ok(lines.every((line) => visibleWidth(line) <= 58));
	});

	it("shows model and thinking for active async widget rows", () => {
		const lines = buildWidgetLines(
			[
				{
					asyncId: "run-1",
					asyncDir: "/tmp/1",
					status: "running",
					mode: "parallel",
					agents: ["reviewer", "scout"],
					activeParallelGroup: true,
					runningSteps: 2,
					completedSteps: 0,
					stepsTotal: 2,
					steps: [
						{ agent: "reviewer", status: "running", model: "openai-codex/gpt-5.5:high" },
						{ agent: "scout", status: "running", model: "anthropic/claude-haiku-4-5", thinking: "low" },
					],
				},
			],
			theme,
			180,
		);

		const text = lines.join("\n");
		assert.match(text, /Agent 1\/2: reviewer \(gpt-5\.5 · thinking high\)/);
		assert.match(text, /Agent 2\/2: scout \(claude-haiku-4-5 · thinking low\)/);
		assert.doesNotMatch(text, /openai-codex\/gpt-5\.5/);
		assert.doesNotMatch(text, /gpt-5\.5:high/);
	});

	it("cycles compact async thinking phrases per turn while expanded rows retain telemetry", () => {
		assert.equal(WHIMSICAL_THINKING_PHRASES.length, 453);
		const now = Date.now();
		const job: AsyncJobState = {
			asyncId: "run-thinking",
			asyncDir: "/tmp/thinking",
			status: "running",
			mode: "single",
			agents: ["worker"],
			stepsTotal: 1,
			startedAt: now - 7_000,
			updatedAt: now,
			steps: [
				{
					index: 0,
					agent: "worker",
					status: "running",
					lastActivityAt: now,
					turnCount: 5,
					toolCount: 18,
					tokens: { input: 30_000, output: 10_000, total: 44_000 },
					durationMs: 7_000,
				},
			],
		};

		const collapsed = buildWidgetLines([job], theme, 180).join("\n");
		assert.match(collapsed, new RegExp(`⎿  ${escapeRegExp(whimsicalThinkingPhrase(5))}\\n\\s+active now`));
		assert.doesNotMatch(collapsed, /5 turns|18 tool uses|44k token|7\.0s/);

		const next = buildWidgetLines([{ ...job, steps: [{ ...job.steps![0]!, turnCount: 6 }] }], theme, 180).join("\n");
		assert.match(next, new RegExp(escapeRegExp(whimsicalThinkingPhrase(6))));
		assert.doesNotMatch(next, new RegExp(escapeRegExp(whimsicalThinkingPhrase(5))));

		const expanded = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.match(expanded, /5 turns · 18 tool uses · 44k token · 7\.0s/);
		assert.match(expanded, /active now/);

		const activeTool = buildWidgetLines(
			[{ ...job, steps: [{ ...job.steps![0]!, currentTool: "read", currentToolStartedAt: now - 2_000 }] }],
			theme,
			180,
		).join("\n");
		assert.match(activeTool, /read \| 2\.0s/);
		assert.doesNotMatch(activeTool, new RegExp(escapeRegExp(whimsicalThinkingPhrase(5))));
	});

	it("keeps async row status visible before long model badges on narrow widgets", () => {
		const lines = buildWidgetLines(
			[
				{
					asyncId: "run-1",
					asyncDir: "/tmp/1",
					status: "running",
					mode: "parallel",
					agents: ["reviewer"],
					activeParallelGroup: true,
					runningSteps: 1,
					completedSteps: 0,
					stepsTotal: 1,
					steps: [
						{
							agent: "reviewer",
							status: "running",
							model: "anthropic/claude-opus-4-5-20260501-super-long-model-name:high",
						},
					],
				},
			],
			theme,
			68,
		);

		const row = lines.find((line) => line.includes("Agent 1/1")) ?? "";
		assert.match(row, /Agent 1\/1: reviewer/);
		assert.doesNotMatch(row, /Agent 1\/1: reviewer \(/);
	});

	it("shows inline live detail for expanded async parallel widget rows", () => {
		const now = Date.now();
		const job: AsyncJobState = {
			asyncId: "run-1",
			asyncDir: "/tmp/1",
			status: "running",
			mode: "parallel",
			agents: ["reviewer"],
			activeParallelGroup: true,
			runningSteps: 1,
			completedSteps: 0,
			stepsTotal: 1,
			updatedAt: now,
			steps: [
				{
					index: 0,
					agent: "reviewer",
					status: "running",
					currentTool: "read",
					currentToolArgs: "src/tui/render.ts",
					currentToolStartedAt: now - 2000,
					recentTools: [{ tool: "grep", args: "async widget", endMs: now - 3000 }],
					recentOutput: ["found renderWidget", "checking expanded state"],
				},
			],
		};

		const collapsedText = buildWidgetLines([job], theme, 180).join("\n");
		assert.match(collapsedText, /Press Ctrl\+Shift\+D for live detail/);
		assert.doesNotMatch(collapsedText, outputPathPattern("/tmp/1/output-0.log"));
		assert.doesNotMatch(collapsedText, /found renderWidget/);

		const expandedText = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.doesNotMatch(expandedText, /Press Configured\+Expand\+Key for live detail/);
		assert.match(expandedText, /⎿  read: src\/tui\/render\.ts \| 2\.0s/);
		assert.match(expandedText, outputPathPattern("/tmp/1/output-0.log"));
		assert.match(expandedText, /grep: async widget/);
		assert.match(expandedText, /found renderWidget/);
		assert.match(expandedText, /checking expanded state/);
	});

	it("shows a generic title and one unnumbered agent summary for running single async jobs", () => {
		const now = Date.now();
		const job: AsyncJobState = {
			asyncId: "single-run",
			asyncDir: "/tmp/single-run",
			status: "running",
			mode: "single",
			agents: ["developer"],
			stepsTotal: 1,
			startedAt: now - 4000,
			updatedAt: now,
			steps: [
				{
					index: 0,
					agent: "developer",
					status: "running",
					model: "openai-codex/gpt-5.5:high",
					thinking: "high",
					turnCount: 2,
					toolCount: 3,
					tokens: { input: 8_000, output: 4_000, total: 12_000 },
					currentTool: "read",
					currentToolArgs: "src/tui/render.ts",
					currentToolStartedAt: now - 2000,
					recentOutput: ["reading render widget"],
				},
			],
		};

		const collapsedText = buildWidgetLines([job], theme, 180).join("\n");
		assert.match(collapsedText, /async subagent/);
		assert.match(collapsedText, new RegExp(`${runningGlyphPattern} developer \\(gpt-5\\.5 · thinking high\\)`));
		assert.doesNotMatch(collapsedText, /2 turns|3 tool uses|12k token|4\.0s/);
		assert.match(collapsedText, /⎿  read: src\/tui\/render\.ts \| 2\.0s/);
		assert.match(collapsedText, /Press Ctrl\+Shift\+D for live detail/);
		assert.doesNotMatch(collapsedText, /(?:Agent|Step) 1\/1/);
		assert.doesNotMatch(collapsedText, outputPathPattern("/tmp/single-run/output-0.log"));
		assert.doesNotMatch(collapsedText, /reading render widget/);

		const expandedText = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.match(expandedText, /developer \(gpt-5\.5 · thinking high\)/);
		assert.doesNotMatch(expandedText, /(?:Agent|Step) 1\/1/);
		assert.doesNotMatch(expandedText, /Press Configured\+Expand\+Key for live detail/);
		assert.match(expandedText, outputPathPattern("/tmp/single-run/output-0.log"));
		assert.match(expandedText, /reading render widget/);

		useDefaultKeybindings();
		const fallbackText = buildWidgetLines([job], theme, 180).join("\n");
		assert.match(fallbackText, /Press Ctrl\+Shift\+D for live detail/);
		assert.doesNotMatch(fallbackText, /Press Ctrl\+O for live detail/);
	});

	it("does not duplicate job elapsed time when a terminal single step has duration", () => {
		const now = Date.now();
		const text = buildWidgetLines(
			[
				{
					asyncId: "single-complete",
					asyncDir: "/tmp/single-complete",
					status: "complete",
					mode: "single",
					agents: ["developer"],
					stepsTotal: 1,
					startedAt: now - 9000,
					updatedAt: now,
					steps: [
						{
							index: 0,
							agent: "developer",
							status: "complete",
							toolCount: 3,
							durationMs: 4000,
						},
					],
				},
			],
			theme,
			180,
		).join("\n");

		assert.doesNotMatch(text, /\b4\.0s\b|\b9\.0s\b/);
		const expanded = buildWidgetLines(
			[
				{
					asyncId: "single-complete",
					asyncDir: "/tmp/single-complete",
					status: "complete",
					mode: "single",
					agents: ["developer"],
					stepsTotal: 1,
					startedAt: now - 9000,
					updatedAt: now,
					steps: [{ index: 0, agent: "developer", status: "complete", toolCount: 3, durationMs: 4000 }],
				},
			],
			theme,
			180,
			true,
		).join("\n");
		assert.equal(expanded.match(/\b4\.0s\b/g)?.length, 1);
		assert.doesNotMatch(expanded, /\b9\.0s\b/);
	});

	it("uses terminal job status when a retained single step still reports running", () => {
		const now = Date.now();
		const job: AsyncJobState = {
			asyncId: "single-terminal-before-step-refresh",
			asyncDir: "/tmp/single-terminal-before-step-refresh",
			status: "complete",
			mode: "single",
			agents: ["developer"],
			stepsTotal: 1,
			startedAt: now - 9000,
			updatedAt: now,
			steps: [
				{
					index: 0,
					agent: "developer",
					status: "running",
					model: "openai-codex/gpt-5.5:high",
					thinking: "high",
					turnCount: 2,
					toolCount: 3,
					tokens: { input: 8_000, output: 4_000, total: 12_000 },
					currentTool: "read",
					currentToolArgs: "src/tui/render.ts",
					currentToolStartedAt: now - 2000,
					recentTools: [{ tool: "grep", args: "stale detail", endMs: now - 1000 }],
					recentOutput: ["stale live output"],
					children: [
						{
							id: "retained-child",
							parentRunId: "single-terminal-before-step-refresh",
							parentStepIndex: 0,
							depth: 1,
							path: [{ runId: "single-terminal-before-step-refresh", stepIndex: 0 }],
							state: "complete",
							agent: "retained-child",
							lastUpdate: now,
						},
					],
				},
			],
		};

		for (const [status, glyph] of [
			["complete", "✓"],
			["failed", "✗"],
		] as const) {
			const collapsedText = buildWidgetLines([{ ...job, status }], theme, 180).join("\n");
			assert.match(collapsedText, new RegExp(`${glyph} developer · ${status} \\(gpt-5\\.5 · thinking high\\)`));
			assert.doesNotMatch(collapsedText, /2 turns|3 tool uses|12k token|9\.0s/);
			assert.doesNotMatch(collapsedText, /developer · running/);
			assert.doesNotMatch(collapsedText, /Press (?:Configured\+Expand\+Key|Ctrl\+O) for live detail/);

			const expandedText = buildWidgetLines([{ ...job, status }], theme, 180, true).join("\n");
			assert.match(expandedText, /2 turns · 3 tool uses · 12k token/);
			assert.match(expandedText, /retained-child · complete/);
			assert.doesNotMatch(expandedText, /output-0\.log|stale detail|stale live output|⎿  read/);
		}
	});

	it("keeps a generic status and activity fallback for single async jobs without steps", () => {
		const now = Date.now();
		useDefaultKeybindings();
		const text = buildWidgetLines(
			[
				{
					asyncId: "single-no-steps",
					asyncDir: "/tmp/single-no-steps",
					status: "running",
					mode: "single",
					agents: ["worker"],
					currentStep: 0,
					toolCount: 2,
					totalTokens: { input: 3000, output: 2000, total: 5000 },
					currentTool: "read",
					currentToolStartedAt: now - 1000,
					startedAt: now - 3000,
					updatedAt: now,
				},
			],
			theme,
			180,
		).join("\n");

		assert.match(text, /async subagent/);
		assert.match(text, new RegExp(`${runningGlyphPattern} worker`));
		assert.doesNotMatch(text, /· running\b/);
		assert.doesNotMatch(text, /2 tool uses|5\.0k token|3\.0s/);
		assert.match(text, /⎿  read 1\.0s/);
		assert.doesNotMatch(text, /\bsteps?\b|\bchain\b/i);
		assert.doesNotMatch(text, /Press Configured\+Expand\+Key for live detail/);
	});

	it("includes logical chain context for active async chain parallel groups", () => {
		const lines = buildWidgetLines(
			[
				{
					asyncId: "run-chain",
					asyncDir: "/tmp/chain",
					status: "running",
					mode: "chain",
					agents: ["reviewer", "auditor"],
					activeParallelGroup: true,
					currentStep: 1,
					chainStepCount: 3,
					parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
					runningSteps: 1,
					completedSteps: 1,
					stepsTotal: 2,
				},
			],
			theme,
			160,
		);

		const text = lines.join("\n");
		assert.match(text, /step 2\/3 · parallel group: 1\/2 done/);
	});

	it("uses logical chain steps after an async chain parallel group finishes", () => {
		const job: AsyncJobState = {
			asyncId: "run-chain",
			asyncDir: "/tmp/chain",
			status: "running",
			mode: "chain",
			agents: ["scout", "reviewer", "auditor", "writer"],
			activeParallelGroup: false,
			currentStep: 3,
			chainStepCount: 2,
			parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
			stepsTotal: 4,
			steps: [
				{ index: 0, agent: "scout", status: "complete" },
				{ index: 1, agent: "reviewer", status: "complete" },
				{ index: 2, agent: "auditor", status: "complete" },
				{ index: 3, agent: "writer", status: "running", toolCount: 1 },
			],
		};
		const text = buildWidgetLines([job], theme, 180).join("\n");
		assert.match(text, /async subagent chain \(2\)/);
		assert.match(text, /chain · step 2\/2/);
		assert.match(text, /Step 1\/2: parallel group · 3\/3 done/);
		assert.match(text, /Step 2\/2: writer/);
		assert.doesNotMatch(text, /1 tool use|duration|token|turn/);
		assert.match(text, /Press Ctrl\+Shift\+D for live detail/);
		assert.doesNotMatch(text, outputPathPattern("/tmp/chain/output-3.log"));
		assert.doesNotMatch(text, /step 4\/4/);
		assert.doesNotMatch(text, /Step 4\/4/);

		const expandedText = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.match(expandedText, outputPathPattern("/tmp/chain/output-3.log"));
	});

	it("omits zero-running labels for pending active async parallel groups", () => {
		const lines = buildWidgetLines(
			[
				{
					asyncId: "parallel-pending",
					asyncDir: "/tmp/parallel-pending",
					status: "running",
					mode: "parallel",
					agents: ["scout", "reviewer", "worker"],
					activeParallelGroup: true,
					runningSteps: 0,
					completedSteps: 0,
					stepsTotal: 3,
				},
				{
					asyncId: "chain-pending",
					asyncDir: "/tmp/chain-pending",
					status: "running",
					mode: "chain",
					agents: ["reviewer", "auditor"],
					activeParallelGroup: true,
					currentStep: 0,
					chainStepCount: 2,
					parallelGroups: [{ start: 0, count: 2, stepIndex: 0 }],
					runningSteps: 0,
					completedSteps: 0,
					stepsTotal: 2,
				},
			],
			theme,
			180,
		);

		const text = lines.join("\n");
		assert.match(text, /parallel · 0\/3 done/);
		assert.match(text, /chain · step 1\/2 · parallel group: 0\/2 done/);
		assert.doesNotMatch(text, /0 agents running/);
	});

	it("shows explicit overflow counts for hidden work", () => {
		const lines = buildWidgetLines(
			[
				{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", agents: ["a1"] },
				{ asyncId: "run-2", asyncDir: "/tmp/2", status: "running", agents: ["a2"] },
				{ asyncId: "run-3", asyncDir: "/tmp/3", status: "running", agents: ["a3"] },
				{ asyncId: "run-4", asyncDir: "/tmp/4", status: "running", agents: ["a4"] },
				{ asyncId: "run-5", asyncDir: "/tmp/5", status: "running", agents: ["a5"] },
			],
			theme,
			120,
		);

		assert.match(lines.join("\n"), /\+1 more/);
		assert.doesNotMatch(lines.join("\n"), /\b(?:\d+(?:\/\d+)?|(?:agent|job|run)s?)\s+running\b/);
	});

	it("counts hidden queued work even when a visible running agent name contains queued", () => {
		const lines = buildWidgetLines(
			[
				{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", agents: ["queued-scanner"] },
				{ asyncId: "run-2", asyncDir: "/tmp/2", status: "running", agents: ["a2"] },
				{ asyncId: "run-3", asyncDir: "/tmp/3", status: "running", agents: ["a3"] },
				{ asyncId: "run-4", asyncDir: "/tmp/4", status: "running", agents: ["a4"] },
				{ asyncId: "queued-1", asyncDir: "/tmp/q", status: "queued", agents: ["planner"] },
			],
			theme,
			120,
		);

		assert.match(lines.join("\n"), /\+1 more \(1 queued\)/);
	});

	it("advances running widget glyphs when progress seed changes", () => {
		const first = buildWidgetLines(
			[
				{ asyncId: "run-progress", asyncDir: "/tmp/run", status: "running", agents: ["worker"], updatedAt: 11 },
				{ asyncId: "run-other", asyncDir: "/tmp/other", status: "running", agents: ["scout"], updatedAt: 0 },
			],
			theme,
			120,
		);
		const second = buildWidgetLines(
			[
				{ asyncId: "run-progress", asyncDir: "/tmp/run", status: "running", agents: ["worker"], updatedAt: 12 },
				{ asyncId: "run-other", asyncDir: "/tmp/other", status: "running", agents: ["scout"], updatedAt: 0 },
			],
			theme,
			120,
		);

		assert.notEqual(
			firstGrapheme(first[0] ?? ""),
			firstGrapheme(second[0] ?? ""),
			"header glyph should advance from changed progress",
		);
		assert.notEqual(
			firstRunningGlyph(first[1] ?? ""),
			firstRunningGlyph(second[1] ?? ""),
			"job glyph should advance from changed progress",
		);

		const firstStep = buildWidgetLines(
			[
				{
					asyncId: "run-step-progress",
					asyncDir: "/tmp/run-step",
					status: "running",
					agents: ["worker"],
					stepsTotal: 1,
					updatedAt: 20,
					steps: [{ agent: "worker", status: "running", currentToolStartedAt: 10 }],
				},
			],
			theme,
			120,
		);
		const secondStep = buildWidgetLines(
			[
				{
					asyncId: "run-step-progress",
					asyncDir: "/tmp/run-step",
					status: "running",
					agents: ["worker"],
					stepsTotal: 1,
					updatedAt: 20,
					steps: [{ agent: "worker", status: "running", currentToolStartedAt: 11 }],
				},
			],
			theme,
			120,
		);
		assert.notEqual(
			firstRunningGlyph(firstStep.find((line) => line.includes("Step 1/1")) ?? ""),
			firstRunningGlyph(secondStep.find((line) => line.includes("Step 1/1")) ?? ""),
			"step glyph should advance from changed step progress",
		);
	});

	it("keeps running widget output stable when progress seed is unchanged", async () => {
		const job: AsyncJobState = {
			asyncId: "run-stable",
			asyncDir: "/tmp/run",
			status: "running",
			agents: ["worker"],
			startedAt: 1_000,
			updatedAt: 3_000,
			currentTool: "read",
			currentToolStartedAt: 2_000,
			lastActivityAt: 2_500,
		};
		const first = buildWidgetLines([job], theme, 120);
		await new Promise((resolve) => setTimeout(resolve, 120));
		const second = buildWidgetLines([job], theme, 120);

		assert.deepEqual(second, first);
		assert.equal(firstGrapheme(first[1] ?? ""), firstGrapheme(second[1] ?? ""));
	});

	it("wraps complete long arguments and output in narrow compact and expanded widgets", () => {
		const width = 42;
		const longArgs = `--path=${"src/deep/".repeat(14)}report.json --query=${"needle-".repeat(18)}`;
		const longOutput = `recent-output-${"value-".repeat(18)}`;
		const longTicket = `Wrap ${"complete-ticket-title-".repeat(10)}`;
		const job: AsyncJobState = {
			asyncId: "narrow-wrap",
			asyncDir: "/tmp/narrow-wrap",
			status: "running",
			mode: "single",
			agents: ["worker"],
			stepsTotal: 1,
			updatedAt: 20_000,
			tkTicket: { id: "tlh-narrow", title: longTicket },
			steps: [
				{
					index: 0,
					agent: "worker",
					status: "running",
					currentTool: "grep",
					currentToolArgs: longArgs,
					recentTools: [{ tool: "grep", args: longArgs, endMs: 1 }],
					recentOutput: [longOutput],
				},
			],
		};

		const compact = buildWidgetLines([job], theme, width, false);
		assert.ok(compact.length > 3);
		assert.ok(compact.every((line) => visibleWidth(line) <= width - 2));
		assertWrappedSource(compact, longArgs);
		assertWrappedSource(compact, longTicket);
		assert.doesNotMatch(compact.join(""), /…|\.\.\./);

		const expanded = buildWidgetLines([job], theme, width, true);
		assert.ok(expanded.length > compact.length);
		assert.ok(expanded.every((line) => visibleWidth(line) <= width - 2));
		assertWrappedSource(expanded, longArgs);
		assertWrappedSource(expanded, longOutput);
		assertWrappedSource(expanded, longTicket);
		assert.doesNotMatch(expanded.join(""), /…|\.\.\./);
	});

	it("does not animate queued-only widgets", async () => {
		const ui = createUiContext();
		renderWidget(ui.ctx as never, [
			{ asyncId: "queued-only", asyncDir: "/tmp/queued", status: "queued", agents: ["planner"] },
		]);
		const initialWidgetCount = ui.widgets.length;
		await new Promise((resolve) => setTimeout(resolve, 190));
		assert.equal(ui.widgets.length, initialWidgetCount, "static queued widget should not refresh at animation cadence");
		assert.equal(ui.renderRequests, 0);
	});

	it("clears legacy result row animation timers", async () => {
		let ticks = 0;
		const context = {
			state: {
				subagentResultAnimationTimer: setInterval(() => {
					ticks += 1;
				}, 10),
			},
		};
		try {
			clearLegacyResultAnimationTimer(context);
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(context.state.subagentResultAnimationTimer, undefined);
			assert.equal(ticks, 0, "legacy timer should be cleared before it can tick");
		} finally {
			if (context.state.subagentResultAnimationTimer) clearInterval(context.state.subagentResultAnimationTimer);
		}
	});

	it("does not refresh running widgets at animation cadence", async () => {
		const ui = createUiContext();
		renderWidget(ui.ctx as never, [
			{ asyncId: "run-static", asyncDir: "/tmp/run", status: "running", agents: ["scout"] },
		]);
		const initialWidgetCount = ui.widgets.length;
		await new Promise((resolve) => setTimeout(resolve, 190));
		assert.equal(
			ui.widgets.length,
			initialWidgetCount,
			"running widget should wait for status updates instead of animation ticks",
		);
		assert.equal(ui.renderRequests, 0);

		renderWidget(ui.ctx as never, []);
		const afterClearCount = ui.widgets.length;
		await new Promise((resolve) => setTimeout(resolve, 190));
		assert.equal(ui.widgets.length, afterClearCount, "cleared widget should stay quiet");
		assert.equal(ui.widgets.at(-1), undefined);
	});
});
