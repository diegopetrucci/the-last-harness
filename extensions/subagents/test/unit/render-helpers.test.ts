import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFooter, renderHeader, row } from "../../src/tui/render-helpers.ts";
import { renderSubagentResult } from "../../src/tui/render.ts";

const theme = {
	fg(_name: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
};

function componentText(component: unknown): string {
	if (typeof component !== "object" || component === null) return "";
	if ("text" in component && typeof component.text === "string") return component.text;
	if ("children" in component && Array.isArray(component.children))
		return component.children.map(componentText).filter(Boolean).join("\n");
	return "";
}

function assertWrappedSource(lines: string[], source: string): void {
	assert.ok(
		stripVTControlCharacters(lines.join("")).replace(/\s/g, "").includes(source.replace(/\s/g, "")),
		`wrapped output should preserve ${JSON.stringify(source)}`,
	);
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

function result(agent: string, output: string) {
	return {
		agent,
		task: `${agent} task`,
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		finalOutput: output,
	};
}

test("row wraps long content without clipping source text", () => {
	const rendered = row("abcdef", 6, theme as any).split("\n");
	assert.ok(rendered.length > 1);
	assert.equal(
		rendered.map(visibleWidth).every((width) => width === 6),
		true,
	);
	assert.equal(rendered.map((line) => line.replace(/[│ ]/g, "")).join(""), "abcdef");
	assert.doesNotMatch(rendered.join(""), /…|\.\.\./);
});

test("row preserves content at widths too narrow for borders", () => {
	const rendered = row("abcdef", 2, theme as any).split("\n");
	assert.ok(rendered.every((line) => visibleWidth(line) <= 2));
	assertWrappedSource(rendered, "abcdef");
	assert.equal(row("abcdef", 0, theme as any), "");
});

test("row wraps explicit newlines and normalizes tabs", () => {
	const rendered = row("bash failed: line 1\nline 2\tvalue", 20, theme as any).split("\n");
	assert.ok(rendered.length >= 2);
	assert.equal(
		rendered.map(visibleWidth).every((width) => width === 20),
		true,
	);
	assert.doesNotMatch(rendered.join(""), /[\r\t]/);
	const normalized = rendered.join("").replace(/[│ ]/g, "");
	assert.match(normalized, /bashfailed:line1/);
	assert.match(normalized, /line2value/);
});

test("row keeps styled multiline content within the available width", () => {
	const rendered = row("\u001b[31merror line 1\nline 2\tvalue\u001b[39m", 18, theme as any).split("\n");
	assert.equal(
		rendered.map(visibleWidth).every((width) => width === 18),
		true,
	);
	assert.doesNotMatch(rendered.join(""), /[\r\n\t]/);
	const normalized = rendered.join("").replace(/[│ ]/g, "");
	assert.match(normalized, /errorline1/);
	assert.match(normalized, /line2value/);
});

test("headers and footers wrap complete text within the requested width", () => {
	const source = `complete-${"header-footer-".repeat(8)}`;
	for (const render of [renderHeader, renderFooter]) {
		const lines = render(source, 18, theme as any).split("\n");
		assert.ok(lines.length > 1);
		assert.ok(lines.every((line) => visibleWidth(line) === 18));
		const content = lines
			.join("")
			.replace(/[╭╮╰╯─│]/g, "")
			.replace(/\s/g, "");
		assert.ok(content.includes(source.replace(/\s/g, "")));
	}
});

test("compact multi-result rendering shows total cost in the header", () => {
	const text = renderSubagentResult(
		{
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "parallel",
				results: [result("scout", "a"), result("reviewer", "b")],
				totalCost: { inputTokens: 30, outputTokens: 12, costUsd: 0.04 },
			},
		},
		{ expanded: false },
		theme as any,
	)
		.render(120)
		.join("\n");

	assert.match(text, /2\/2 done/);
	assert.doesNotMatch(text, /in:30 out:12|token|tool use|duration/);
	assert.match(text, /\$0\.0400/);

	const expanded = componentText(
		renderSubagentResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {
					mode: "parallel",
					results: [result("scout", "a"), result("reviewer", "b")],
					totalCost: { inputTokens: 30, outputTokens: 12, costUsd: 0.04 },
				},
			},
			{ expanded: true },
			theme as any,
		),
	);
	assert.match(expanded, /in:30 out:12 \$0\.0400/);
});

test("collapsed foreground single and multi cards budget wrapped physical lines while expanded keeps exact args", () => {
	const width = 36;
	const singleCurrentArgs = `--single-current=${"current-segment-".repeat(360)}single-current-tail`;
	const singleRetainedArgs = `--single-retained=${"retained-segment-".repeat(320)}single-retained-tail`;
	const multiCurrentArgs = [
		`--multi-a-current=${"alpha-segment-".repeat(340)}multi-a-current-tail`,
		`--multi-b-current=${"beta-segment-".repeat(380)}multi-b-current-tail`,
	];
	const multiRetainedArgs = [
		`--multi-a-retained=${"retained-alpha-".repeat(330)}multi-a-retained-tail`,
		`--multi-b-retained=${"retained-beta-".repeat(370)}multi-b-retained-tail`,
	];
	const makeRunningResult = (agent: string, currentArgs: string, retainedArgs: string) => ({
		agent,
		task: `Review exact arguments for ${agent}`,
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		finalOutput: `${agent} output`,
		progress: {
			status: "running" as const,
			currentTool: "grep",
			currentToolArgs: currentArgs,
			recentTools: [{ tool: "read", args: retainedArgs, endMs: 1 }],
			recentOutput: [],
			toolCount: 2,
			tokens: 0,
			durationMs: 0,
		},
	});
	const singleResult = makeRunningResult("single-worker", singleCurrentArgs, singleRetainedArgs);
	const singleDetails = { mode: "single" as const, results: [singleResult] };
	const multiResults = [
		makeRunningResult("multi-worker-a", multiCurrentArgs[0]!, multiRetainedArgs[0]!),
		makeRunningResult("multi-worker-b", multiCurrentArgs[1]!, multiRetainedArgs[1]!),
	];
	const multiDetails = { mode: "parallel" as const, results: multiResults };

	for (const [name, details] of [
		["single", singleDetails],
		["multi", multiDetails],
	] as const) {
		const compact = withStdoutSize(12, width + 4, () =>
			renderSubagentResult(
				{ content: [{ type: "text", text: "running" }], details },
				{ expanded: false },
				theme as any,
			).render(width),
		);
		assert.ok(compact.length <= 5, `${name} compact card should honor the short-terminal budget`);
		assert.ok(compact.every((line) => visibleWidth(line) <= width));
		const compactText = stripVTControlCharacters(compact.join("\n"));
		const hiddenMatch = compactText.match(/… (\d+) lines hidden/);
		assert.ok(hiddenMatch, `${name} compact card should summarize hidden physical lines`);
		assert.ok(Number(hiddenMatch[1]) > 100, `${name} compact card should count the multi-KB wrapped overflow`);
		assert.match(
			compactText.replace(/\s/g, ""),
			/Ctrl\+Shift\+Dexpands/,
			`${name} compact card should retain the expansion affordance`,
		);

		const expanded = withStdoutSize(12, width + 4, () =>
			renderSubagentResult(
				{ content: [{ type: "text", text: "running" }], details },
				{ expanded: true },
				theme as any,
			).render(width),
		);
		assert.ok(expanded.every((line) => visibleWidth(line) <= width));
		assert.doesNotMatch(stripVTControlCharacters(expanded.join("\n")), /lines hidden/);
		if (name === "single") {
			assertWrappedSource(expanded, singleCurrentArgs);
			assertWrappedSource(expanded, singleRetainedArgs);
		} else {
			for (const args of [...multiCurrentArgs, ...multiRetainedArgs]) assertWrappedSource(expanded, args);
		}
	}
});

test("renderSubagentResult ANSI wrapping preserves styled source and complete escape sequences", () => {
	const width = 28;
	const styledArgs = `--styled=${"ansi value ".repeat(55)}styled-tail`;
	const ansiTheme = {
		fg(_name: string, text: string): string {
			return `\u001b[31m${text}\u001b[39m`;
		},
		bold(text: string): string {
			return `\u001b[1m${text}\u001b[22m`;
		},
	};
	const lines = renderSubagentResult(
		{
			content: [{ type: "text", text: "running" }],
			details: {
				mode: "single",
				results: [
					{
						agent: "styled-worker",
						task: "Keep styled arguments exact",
						exitCode: 0,
						messages: [],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
						finalOutput: "running",
						progress: {
							status: "running",
							currentTool: "grep",
							currentToolArgs: styledArgs,
							recentTools: [],
							recentOutput: [],
							toolCount: 1,
							tokens: 0,
							durationMs: 0,
						},
					},
				],
			},
		},
		{ expanded: true },
		ansiTheme as any,
	).render(width);

	assert.ok(lines.length > 10);
	assert.ok(lines.every((line) => visibleWidth(line) <= width));
	const ansiEscape = String.fromCharCode(27);
	assert.ok(lines.filter((line) => line.includes(`${ansiEscape}[`)).length > 1);
	assertWrappedSource(lines, styledArgs);
	const completeAnsiSequence = new RegExp(`${ansiEscape}\\[[0-?]*[ -/]*[@-~]`, "g");
	for (const line of lines) {
		assert.equal(
			line.replace(completeAnsiSequence, "").includes(ansiEscape),
			false,
			`broken ANSI sequence in ${JSON.stringify(line)}`,
		);
	}
});

test("sequential chain rendering uses result agent names", () => {
	const sequential = renderSubagentResult(
		{
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "chain",
				totalSteps: 2,
				results: [result("scout", "a"), result("writer", "b")],
			},
		},
		{ expanded: false },
		theme as any,
	)
		.render(120)
		.join("\n");
	assert.match(sequential, /Step 1: scout/);
	assert.match(sequential, /Step 2: writer/);
});

test("parallel chain rendering uses workflowGraph for group labels", () => {
	const parallel = renderSubagentResult(
		{
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "chain",
				totalSteps: 3,
				results: [result("scout", "a"), result("reviewer", "b"), result("auditor", "c"), result("writer", "d")],
				workflowGraph: {
					runId: "test-run",
					mode: "chain",
					phases: [],
					nodes: [
						{ id: "s0", kind: "step", label: "scout", status: "completed", stepIndex: 0, flatIndex: 0 },
						{
							id: "p1",
							kind: "parallel-group",
							label: "reviewer+auditor",
							status: "completed",
							stepIndex: 1,
							children: [
								{ id: "p1a", kind: "agent", label: "reviewer", status: "completed", flatIndex: 1 },
								{ id: "p1b", kind: "agent", label: "auditor", status: "completed", flatIndex: 2 },
							],
						},
						{ id: "s2", kind: "step", label: "writer", status: "completed", stepIndex: 2, flatIndex: 3 },
					],
				},
			},
		},
		{ expanded: false },
		theme as any,
	)
		.render(120)
		.join("\n");
	assert.match(parallel, /Step 1: scout/);
	assert.match(parallel, /Agent 1\/2: reviewer/);
	assert.match(parallel, /Agent 2\/2: auditor/);
	assert.match(parallel, /Step 3: writer/);
});
