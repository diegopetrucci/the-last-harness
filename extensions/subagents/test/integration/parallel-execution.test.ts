/**
 * Integration tests for parallel execution.
 *
 * Tests the mapConcurrent utility and parallel agent spawning via runSync.
 * The top-level parallel mode (params.tasks) lives in index.ts and uses
 * mapConcurrent + runSync — we test both pieces here.
 *
 * mapConcurrent tests always run. runSync tests require pi packages.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
	createEventBus,
	createMockPi,
	createTempDir,
	events,
	makeAgent,
	makeAgentConfigs,
	makeMinimalCtx,
	removeTempDir,
	tryImport,
} from "../support/helpers.ts";

// Top-level await: try importing pi-dependent modules
const utils = await tryImport<any>("./src/shared/utils.ts");
const execution = await tryImport<any>("./src/runs/foreground/execution.ts");
const executorMod = await tryImport<any>("./src/runs/foreground/subagent-executor.ts");
const piAvailable = !!(execution && utils);

const runSync = execution?.runSync;
const mapConcurrent = utils?.mapConcurrent;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// mapConcurrent — always runs (pure logic, no pi deps beyond utils.ts)
// ---------------------------------------------------------------------------

describe("mapConcurrent", { skip: !mapConcurrent ? "utils not importable" : undefined }, () => {
	it("processes all items", async () => {
		const items = [1, 2, 3, 4, 5];
		const results = await mapConcurrent(items, 2, async (item: number) => item * 2);
		assert.deepEqual(results, [2, 4, 6, 8, 10]);
	});

	it("preserves order regardless of completion time", async () => {
		const items = [80, 10, 40]; // delays in ms
		const results = await mapConcurrent(items, 3, async (ms: number, i: number) => {
			await new Promise((r) => setTimeout(r, ms));
			return i;
		});
		assert.deepEqual(results, [0, 1, 2], "results should be in original order");
	});

	it("respects concurrency limit", async () => {
		let running = 0;
		let maxRunning = 0;
		const items = [1, 2, 3, 4, 5, 6];

		await mapConcurrent(items, 2, async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 20));
			running--;
		});

		assert.ok(maxRunning <= 2, `max concurrent should be ≤ 2, got ${maxRunning}`);
	});

	it("handles empty array", async () => {
		const results = await mapConcurrent([], 4, async (item: unknown) => item);
		assert.deepEqual(results, []);
	});

	it("propagates errors", async () => {
		await assert.rejects(
			() =>
				mapConcurrent([1, 2, 3], 2, async (item: number) => {
					if (item === 2) throw new Error("boom");
					return item;
				}),
			/boom/,
		);
	});
});

// ---------------------------------------------------------------------------
// Parallel agent execution via runSync
// ---------------------------------------------------------------------------

describe("parallel agent execution", { skip: !piAvailable ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeExecutor(agents = [makeAgent("echo")]) {
		return createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: {
				baseCwd: tempDir,
				currentSessionId: null,
				asyncJobs: new Map(),
				foregroundControls: new Map(),
				lastForegroundControlId: null,
			},
			config: {},
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
	}

	function readRecordedArgs(callFile: string): string[] {
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8"));
		assert.equal(typeof payload, "object", "expected recorded args payload");
		assert.notEqual(payload, null, "expected recorded args payload");
		assert.ok("args" in payload, "expected recorded args payload");
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		return payload.args;
	}

	function readAllCallArgs(): string[][] {
		return fs
			.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.map(readRecordedArgs);
	}

	function readLastCallArgs(): string[] {
		const callFile = fs
			.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(-1);
		assert.ok(callFile, "expected a recorded mock pi call");
		return readRecordedArgs(callFile);
	}

	function readRequiredOptionValue(args: string[], option: string): string {
		const optionIndex = args.indexOf(option);
		assert.notEqual(optionIndex, -1, `expected ${option} in mock pi args`);
		const optionValue = args[optionIndex + 1];
		assert.ok(optionValue, `expected a value after ${option}`);
		return optionValue;
	}

	it("runs multiple agents concurrently via mapConcurrent + runSync", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["agent-a", "agent-b", "agent-c"]);
		const tasks = ["Task A", "Task B", "Task C"];

		const results = await mapConcurrent(
			tasks.map((task, i) => ({ agent: agents[i].name, task, index: i })),
			3,
			async ({ agent, task, index }: any) => {
				return runSync(tempDir, agents, agent, task, { index });
			},
		);

		assert.equal(results.length, 3);
		assert.ok(results.every((r: any) => r.exitCode === 0));
		assert.equal(results[0].agent, "agent-a");
		assert.equal(results[1].agent, "agent-b");
		assert.equal(results[2].agent, "agent-c");
	});

	it("all agents get independent results", async () => {
		mockPi.onCall({ output: "Result" });
		const agents = makeAgentConfigs(["a", "b"]);

		const results = await mapConcurrent(
			[
				{ agent: "a", task: "Task A" },
				{ agent: "b", task: "Task B" },
			],
			2,
			async ({ agent, task }: any, i: number) => runSync(tempDir, agents, agent, task, { index: i }),
		);

		assert.equal(results.length, 2);
		assert.equal(results[0].agent, "a");
		assert.equal(results[1].agent, "b");
		const ok = results.filter((r: any) => r.exitCode === 0).length;
		assert.equal(ok, 2);
	});

	it("carries one resolved tk ticket to the matching active foreground parallel child", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		const originalTicketsDir = process.env.TICKETS_DIR;
		process.env.TICKETS_DIR = path.join(tempDir, ".tickets");
		try {
			fs.mkdirSync(path.join(tempDir, ".tickets"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".tickets", "psr-raw4.md"),
				"---\nid: psr-raw4\n---\n# Show active tk title\n",
				"utf-8",
			);
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart("read", { path: "README.md" })], delay: 60 },
					{ jsonl: [events.assistantMessage("ticketed parallel done")] },
				],
			});
			mockPi.onCall({ output: "plain parallel done" });
			const executor = makeExecutor([makeAgent("developer", { tkTicketRequired: true }), makeAgent("plain")]);
			const updates: Array<{
				details?: {
					results?: Array<{ agent?: string; tkTicket?: { id: string; title: string }; progress?: { status?: string } }>;
				};
			}> = [];
			const runPromise = executor.execute(
				"parallel-ticket",
				{
					tasks: [
						{ agent: "developer", task: "Implement the ticketed work.", ticket: "psr-raw4" },
						{ agent: "plain", task: "Review the result." },
					],
				},
				new AbortController().signal,
				(update) => updates.push(update as (typeof updates)[number]),
				makeMinimalCtx(tempDir),
			);

			const deadline = Date.now() + 5_000;
			while (
				Date.now() < deadline &&
				!updates.some((update) =>
					update.details?.results?.some((result) => result.tkTicket && result.progress?.status === "running"),
				)
			) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const running = updates.find((update) =>
				update.details?.results?.some((result) => result.tkTicket && result.progress?.status === "running"),
			);
			const runningResults = running?.details?.results ?? [];
			assert.deepEqual(runningResults.find((result) => result.tkTicket)?.tkTicket, {
				id: "psr-raw4",
				title: "Show active tk title",
			});
			assert.equal(runningResults.filter((result) => result.tkTicket).length, 1);

			const result = await runPromise;
			assert.deepEqual(result.details?.results?.[0]?.tkTicket, { id: "psr-raw4", title: "Show active tk title" });
			assert.equal(result.details?.results?.[1]?.tkTicket, undefined);
		} finally {
			if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
			else process.env.TICKETS_DIR = originalTicketsDir;
		}
	});

	it("carries independently resolved explicit tickets through active parallel child updates", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		const originalTicketsDir = process.env.TICKETS_DIR;
		process.env.TICKETS_DIR = path.join(tempDir, ".tickets");
		try {
			fs.mkdirSync(path.join(tempDir, ".tickets"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".tickets", "psr-dev-a.md"),
				"---\nid: psr-dev-a\n---\n# Developer A title\n",
				"utf-8",
			);
			fs.writeFileSync(
				path.join(tempDir, ".tickets", "psr-dev-b.md"),
				"---\nid: psr-dev-b\n---\n# Developer B \u001b[31mtitle\u001b[0m\n",
				"utf-8",
			);
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart("read", { path: "README.md" })], delay: 60 },
					{ jsonl: [events.assistantMessage("developer A done")] },
				],
			});
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart("read", { path: "README.md" })], delay: 60 },
					{ jsonl: [events.assistantMessage("developer B done")] },
				],
			});
			const executor = makeExecutor([makeAgent("developer", { tkTicketRequired: true })]);
			const updates: Array<{
				details?: {
					results?: Array<{
						agent?: string;
						tkTicket?: { id: string; title: string };
						progress?: { status?: string };
					}>;
				};
			}> = [];
			const runPromise = executor.execute(
				"parallel-explicit-tickets",
				{
					tasks: [
						{ agent: "developer", task: "Work A", ticket: "psr-dev-a" },
						{ agent: "developer", task: "Work B", ticket: "psr-dev-b" },
					],
				},
				new AbortController().signal,
				(update) => updates.push(update as (typeof updates)[number]),
				makeMinimalCtx(tempDir),
			);

			const runningByTicket = new Map<string, { id: string; title: string }>();
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline && runningByTicket.size < 2) {
				for (const update of updates) {
					for (const result of update.details?.results ?? []) {
						if (result.progress?.status === "running" && result.tkTicket) {
							runningByTicket.set(result.tkTicket.id, result.tkTicket);
						}
					}
				}
				if (runningByTicket.size < 2) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.deepEqual(runningByTicket.get("psr-dev-a"), { id: "psr-dev-a", title: "Developer A title" });
			assert.deepEqual(runningByTicket.get("psr-dev-b"), { id: "psr-dev-b", title: "Developer B title" });

			const result = await runPromise;
			assert.deepEqual(
				result.details?.results.map((child) => child.tkTicket),
				[
					{ id: "psr-dev-a", title: "Developer A title" },
					{ id: "psr-dev-b", title: "Developer B title" },
				],
			);
		} finally {
			if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
			else process.env.TICKETS_DIR = originalTicketsDir;
		}
	});

	it("repeated parallel tasks inherit their task ticket", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		const originalTicketsDir = process.env.TICKETS_DIR;
		process.env.TICKETS_DIR = path.join(tempDir, ".tickets");
		try {
			fs.mkdirSync(path.join(tempDir, ".tickets"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".tickets", "psr-repeat.md"),
				"---\nid: psr-repeat\n---\n# Repeated ticket title\n",
				"utf-8",
			);
			mockPi.onCall({ output: "first repeat" });
			mockPi.onCall({ output: "second repeat" });
			const executor = makeExecutor([makeAgent("developer", { tkTicketRequired: true })]);
			const result = await executor.execute(
				"parallel-repeated-ticket",
				{ tasks: [{ agent: "developer", task: "Repeat work", count: 2, ticket: "psr-repeat" }] },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.equal(result.details?.results.length, 2);
			assert.deepEqual(
				result.details?.results.map((child) => child.tkTicket),
				[
					{ id: "psr-repeat", title: "Repeated ticket title" },
					{ id: "psr-repeat", title: "Repeated ticket title" },
				],
			);
		} finally {
			if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
			else process.env.TICKETS_DIR = originalTicketsDir;
		}
	});

	it("rejects a missing explicit parallel ticket before starting any child", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		const originalTicketsDir = process.env.TICKETS_DIR;
		process.env.TICKETS_DIR = path.join(tempDir, ".tickets");
		try {
			fs.mkdirSync(path.join(tempDir, ".tickets"), { recursive: true });
			const executor = makeExecutor([makeAgent("developer", { tkTicketRequired: true })]);
			const result = await executor.execute(
				"parallel-missing-ticket",
				{ tasks: [{ agent: "developer", task: "Work A", ticket: "missing-ticket" }] },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Invalid ticket for tasks\[0\]/);
			assert.match(result.content[0]?.text ?? "", /not found/);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
			else process.env.TICKETS_DIR = originalTicketsDir;
		}
	});

	it("validates every developer task before starting mixed parallel work", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		const originalTicketsDir = process.env.TICKETS_DIR;
		process.env.TICKETS_DIR = path.join(tempDir, ".tickets");
		try {
			fs.mkdirSync(path.join(tempDir, ".tickets"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".tickets", "psr-valid.md"),
				"---\nid: psr-valid\n---\n# Valid ticket\n",
				"utf-8",
			);
			const executor = makeExecutor([makeAgent("developer", { tkTicketRequired: true }), makeAgent("reviewer")]);
			const result = await executor.execute(
				"parallel-mixed-ticket-validation",
				{
					tasks: [
						{ agent: "developer", task: "Work A", ticket: "psr-valid" },
						{ agent: "developer", task: "Work B" },
						{ agent: "reviewer", task: "Review the result." },
					],
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Invalid ticket for tasks\[1\]/);
			assert.match(result.content[0]?.text ?? "", /requires.*explicit ticket/i);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
			else process.env.TICKETS_DIR = originalTicketsDir;
		}
	});

	it("top-level parallel inherits the parent session model for unconfigured tasks and keeps explicit overrides authoritative", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		mockPi.onCall({ output: "Inherited model task" });
		mockPi.onCall({ output: "Explicit model task" });
		const executor = makeExecutor([makeAgent("inherit"), makeAgent("explicit")]);

		const result = await executor.execute(
			"parallel-parent-model",
			{
				tasks: [
					{ agent: "inherit", task: "Task A" },
					{ agent: "explicit", task: "Task B", model: "openai/gpt-5-mini" },
				],
			},
			new AbortController().signal,
			undefined,
			{
				...makeMinimalCtx(tempDir),
				model: { provider: "deepseek", id: "deepseek-v4-flash" },
			},
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 2);
		const recordedModels = readAllCallArgs()
			.map((args) => readRequiredOptionValue(args, "--model"))
			.sort();
		assert.deepEqual(recordedModels, ["deepseek/deepseek-v4-flash", "openai/gpt-5-mini"]);
	});

	it("top-level parallel surfaces fallback notices after a retry", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "quota hit" }],
						model: "openai/gpt-5-mini",
						errorMessage: "429 quota exceeded",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
			],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered on the dispatch fallback" });
		const executor = makeExecutor([makeAgent("echo", { model: "openai/gpt-5-mini" })]);

		const result = await executor.execute(
			"parallel-fallback-notice",
			{
				tasks: [
					{
						agent: "echo",
						task: "Task",
						fallbackModels: ["anthropic/claude-sonnet-4"],
						modelFallbackNotice: "Quota fallback engaged",
					},
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(
			result.content[0]?.text ?? "",
			/Summary:\nNotice: Quota fallback engaged\n\nRecovered on the dispatch fallback/,
		);
		assert.deepEqual(result.details?.results?.[0]?.attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(result.details?.results?.[0]?.modelFallbackNotice, "Quota fallback engaged");
		assert.equal(mockPi.callCount(), 2);
	});

	it("rejects parallel execution action aliases instead of normalizing them", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		for (const action of ["parallel", "PARALLEL", "tasks"]) {
			mockPi.reset();
			const executor = makeExecutor();

			const result = await executor.execute(
				`parallel-alias-${action}`,
				{ action, tasks: [{ agent: "echo", task: `Run ${action}` }] },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", new RegExp(`Unknown action: ${action}`));
			assert.equal(mockPi.callCount(), 0);
		}
	});

	it("applies agent acceptance roles to inferred parallel acceptance", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		mockPi.onCall({ output: "exploration complete" });
		const executor = makeExecutor([makeAgent("worker", { acceptanceRole: "read-only" })]);

		const result = await executor.execute(
			"parallel-agent-acceptance-role",
			{ tasks: [{ agent: "worker", task: "Explore the authentication flow" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.details?.results?.[0]?.acceptance?.effectiveAcceptance.level, "attested");
	});

	it("top-level parallel output saves use per-task output paths", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		mockPi.onCall({ output: "Saved report" });
		const executor = makeExecutor();
		const parentSessionFile = path.join(tempDir, "parent-session", "session.jsonl");

		const result = await executor.execute(
			"parallel-output",
			{ tasks: [{ agent: "echo", task: "Write report", output: "parallel-output.md" }] },
			new AbortController().signal,
			undefined,
			{
				...makeMinimalCtx(tempDir),
				sessionManager: {
					getSessionId: () => "session-123",
					getSessionFile: () => parentSessionFile,
				},
			},
		);

		const runId = result.details?.runId;
		assert.ok(runId, "expected run id in details");
		const outputPath = path.join(
			tempDir,
			"parent-session",
			"subagent-artifacts",
			"outputs",
			runId,
			"parallel-output.md",
		);
		const taskArg = readLastCallArgs().at(-1) ?? "";
		assert.equal(result.isError, undefined);
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`));
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Saved report");
		assert.equal(result.details?.results?.[0]?.savedOutputPath, outputPath);
		assert.equal(fs.existsSync(path.join(tempDir, ".pi-subagents", "artifacts")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "parallel-output.md")), false);
	});

	it("top-level parallel preserves completed siblings and marks timed-out children", {
		skip: !createSubagentExecutor
			? "executor not importable"
			: process.platform === "win32"
				? "timeout signal delivery intermittent on Windows CI"
				: undefined,
	}, async () => {
		mockPi.onCall({
			matchArgIncludes: "Slow review",
			steps: [
				{ jsonl: [events.assistantMessage("slow partial update"), events.toolStart("read", { path: "README.md" })] },
				{ delay: 10000 },
			],
		});
		mockPi.onCall({ matchArgIncludes: "Fast review", output: "fast done" });
		const executor = makeExecutor();

		const start = Date.now();
		const result = await executor.execute(
			"parallel-timeout",
			{
				tasks: [
					{ agent: "echo", task: "Slow review" },
					{ agent: "echo", task: "Fast review" },
				],
				concurrency: 2,
				timeoutMs: 300,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should time out early, took ${elapsed}ms`);
		assert.equal(result.isError, undefined);
		assert.equal(result.details?.results?.length, 2);
		assert.equal(result.details?.results?.[0]?.timedOut, true);
		assert.equal(result.details?.results?.[0]?.error, "Subagent timed out after 300ms.");
		assert.match(result.details?.results?.[0]?.finalOutput ?? "", /Child index: 0/);
		assert.match(result.details?.results?.[0]?.finalOutput ?? "", /Current tool: read/);
		assert.match(result.details?.results?.[0]?.finalOutput ?? "", /Recent child output:\n- slow partial update/);
		assert.equal(result.details?.results?.[1]?.exitCode, 0);
		assert.equal(result.details?.results?.[1]?.finalOutput, "fast done");
		const text = result.content[0]?.text ?? "";
		assert.match(text, /^subagent results/m);
		assert.match(text, /Mode: parallel/);
		assert.match(text, /Status: failed/);
		assert.match(text, /Children: 1 completed, 1 failed/);
		assert.match(text, /1\/2\. echo — failed/);
		assert.match(text, /2\/2\. echo — completed/);
		assert.equal(text.match(/Subagent timed out after 300ms\./g)?.length ?? 0, 1);
		assert.match(text, /Summary:\nSubagent timed out after 300ms\.\n\nRecovery diagnostics:/);
		assert.match(text, /Child index: 0/);
		assert.match(text, /Recent child output:\n- slow partial update/);
		assert.match(text, /Summary:\nfast done/);
	});

	it("enforces mixed foreground agent ceilings independently", {
		skip: !createSubagentExecutor
			? "executor not importable"
			: process.platform === "win32"
				? "timeout signal delivery intermittent on Windows CI"
				: undefined,
	}, async () => {
		mockPi.onCall({ matchArgIncludes: "Short ceiling", delay: 10000 });
		mockPi.onCall({ matchArgIncludes: "Long ceiling", delay: 10000 });
		const executor = makeExecutor([
			makeAgent("short", { maxExecutionTimeMs: 75 }),
			makeAgent("long", { maxExecutionTimeMs: 180 }),
		]);

		const result = await executor.execute(
			"parallel-mixed-agent-ceilings",
			{
				tasks: [
					{ agent: "short", task: "Short ceiling" },
					{ agent: "long", task: "Long ceiling" },
				],
				concurrency: 2,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.details?.results?.[0]?.timedOut, true);
		assert.equal(result.details?.results?.[0]?.error, "Subagent timed out after 75ms.");
		assert.equal(result.details?.results?.[1]?.timedOut, true);
		assert.equal(result.details?.results?.[1]?.error, "Subagent timed out after 180ms.");
	});

	it("top-level parallel file-only output aggregates concise file references", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		mockPi.onCall({ output: "Parallel full report\nwith details" });
		const executor = makeExecutor();
		const parentSessionFile = path.join(tempDir, "parent-session", "session.jsonl");

		const result = await executor.execute(
			"parallel-file-only-output",
			{ tasks: [{ agent: "echo", task: "Write report", output: "parallel-file-only.md", outputMode: "file-only" }] },
			new AbortController().signal,
			undefined,
			{
				...makeMinimalCtx(tempDir),
				sessionManager: {
					getSessionId: () => "session-123",
					getSessionFile: () => parentSessionFile,
				},
			},
		);

		const runId = result.details?.runId;
		assert.ok(runId, "expected run id in details");
		const outputPath = path.join(
			tempDir,
			"parent-session",
			"subagent-artifacts",
			"outputs",
			runId,
			"parallel-file-only.md",
		);
		const text = result.content[0]?.text ?? "";
		const taskArg = readLastCallArgs().at(-1) ?? "";
		assert.equal(result.isError, undefined);
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`));
		assert.match(text, /Output saved to:/);
		assert.match(text, /2 lines/);
		assert.doesNotMatch(text, /Parallel full report/);
		assert.match(result.details?.results?.[0]?.finalOutput ?? "", /Output saved to:/);
		assert.doesNotMatch(result.details?.results?.[0]?.finalOutput ?? "", /Parallel full report/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Parallel full report\nwith details");
		assert.equal(fs.existsSync(path.join(tempDir, ".pi-subagents", "artifacts")), false);
	});

	it("rejects top-level parallel file-only output without an output path", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-file-only-missing-output",
			{ tasks: [{ agent: "echo", task: "Write report", outputMode: "file-only" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects duplicate top-level parallel output paths", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-duplicate-output",
			{
				tasks: [
					{ agent: "echo", task: "Write A", output: "same.md" },
					{ agent: "echo", task: "Write B", output: "same.md" },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /same path/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("treats string false as disabled output in top-level parallel runs", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		mockPi.onCall({ output: "Review done" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-string-false-output",
			{
				tasks: [
					{ agent: "echo", task: "Review A", output: "false" },
					{ agent: "echo", task: "Review B", output: "false" },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 2);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
	});

	it("top-level parallel reads are injected once with chain-style prefix", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		mockPi.onCall({ output: "Read done" });
		const executor = makeExecutor();

		await executor.execute(
			"parallel-reads",
			{ tasks: [{ agent: "echo", task: "Inspect", reads: ["a.md", "b.md"] }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const args = readLastCallArgs();
		const taskArg = args.at(-1) ?? "";
		assert.ok(
			taskArg.startsWith(`Task: [Read from: ${path.join(tempDir, "a.md")}, ${path.join(tempDir, "b.md")}]

Inspect

## Acceptance Contract`),
		);
	});

	it("top-level parallel defaultProgress uses isolated run storage", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		mockPi.onCall({ output: "Progress done" });
		const executor = makeExecutor([makeAgent("echo", { defaultProgress: true })]);
		const parentSessionFile = path.join(tempDir, "parent-session", "session.jsonl");

		const result = await executor.execute(
			"parallel-progress",
			{ tasks: [{ agent: "echo", task: "Track work" }] },
			new AbortController().signal,
			undefined,
			{
				...makeMinimalCtx(tempDir),
				sessionManager: {
					getSessionId: () => "session-123",
					getSessionFile: () => parentSessionFile,
				},
			},
		);
		const runId = result.details?.runId;
		assert.ok(runId, "expected run id in details");
		const expectedProgressPath = path.join(
			tempDir,
			"parent-session",
			"subagent-artifacts",
			"progress",
			runId,
			"progress.md",
		);

		const args = readLastCallArgs();
		const taskArg = args.at(-1) ?? "";
		assert.ok(taskArg.includes(`Update progress at: ${expectedProgressPath}`), taskArg);
		assert.equal(fs.existsSync(expectedProgressPath), true);
		assert.equal(fs.existsSync(path.join(tempDir, ".pi-subagents", "artifacts")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("top-level parallel suppresses progress when the task is review-only", {
		skip: !createSubagentExecutor ? "executor not importable" : undefined,
	}, async () => {
		mockPi.onCall({ output: "Review done" });
		const executor = makeExecutor([makeAgent("reviewer", { defaultProgress: true })]);

		await executor.execute(
			"parallel-read-only-progress",
			{ tasks: [{ agent: "reviewer", task: "Review-only. Do not edit files. Return findings." }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const taskArg = readLastCallArgs().at(-1) ?? "";
		assert.doesNotMatch(taskArg, /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});
});
