/**
 * Integration tests for single (sync) agent execution.
 *
 * Uses the local createMockPi() helper to simulate the pi CLI.
 * Tests the full spawn→parse→result pipeline in runSync without a real LLM.
 *
 * These tests require pi packages to be importable (they run inside a pi
 * environment or with pi packages installed). If unavailable, tests skip
 * gracefully.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	createEventBus,
	removeTempDir,
	makeAgentConfigs,
	makeAgent,
	makeMinimalCtx,
	events,
	tryImport,
} from "../support/helpers.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT } from "../../src/shared/types.ts";
import { getThinkingLevelDropNote } from "../../src/runs/shared/pi-args.ts";

interface ModelAttempt {
	success?: boolean;
	exitCode?: number;
	error?: string;
}

interface ProgressSummary {
	agent: string;
	index: number;
	status: string;
	activityState?: string;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	tokens?: number;
	durationMs: number;
	toolCount: number;
	recentOutput: string[];
}

interface ArtifactPaths {
	inputPath: string;
	outputPath: string;
	jsonlPath: string;
	metadataPath: string;
	transcriptPath?: string;
}

interface RunSyncResult {
	exitCode: number;
	agent: string;
	messages: unknown[];
	error?: string;
	model?: string;
	skills?: string[];
	skillsWarning?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	usage: { turns: number; input: number; output: number };
	progress: ProgressSummary;
	controlEvents?: Array<{ type?: string; message: string; reason?: string; turns?: number; tokens?: number; currentPath?: string; recentFailureSummary?: string }>;
	artifactPaths?: ArtifactPaths;
	transcriptPath?: string;
	transcriptError?: string;
	finalOutput?: string;
	interrupted?: boolean;
	timedOut?: boolean;
	turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; exceededAtTurn?: number };
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	detached?: boolean;
	detachedReason?: string;
	pause?: { kind?: string; summary?: string; requestedAt?: number; pausedAt?: number; ownerPid?: number; request?: { tool?: string; action?: string; reason?: string; requestId?: string; summary?: string } };
	cancel?: { summary?: string; cancelledAt?: number };
	savedOutputPath?: string;
	outputMode?: "inline" | "file-only";
	outputReference?: { path: string; bytes: number; lines: number; message: string };
	outputSaveError?: string;
	sessionFile?: string;
	acceptance?: {
		status?: string;
		verifyRuns?: Array<{ status?: string }>;
		runtimeChecks?: Array<{ id?: string; status?: string; message?: string }>;
	};
}

interface MockPiCallRecord {
	args?: string[];
	systemPrompts?: Array<{ mode?: string; path?: string; text?: string; error?: string }>;
}

function mockAssistantMessage(text: string, stopReason: "stop" | "tool_use" = "stop") {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: stopReason === "tool_use"
				? [{ type: "text", text }, { type: "toolCall", name: "bash", arguments: { command: "echo test" } }]
				: [{ type: "text", text }],
			model: "mock/test-model",
			stopReason,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.001 },
			},
		},
	};
}

interface ExecutionModule {
	runSync(
		runtimeCwd: string,
		agents: ReturnType<typeof makeAgentConfigs>,
		agentName: string,
		task: string,
		options: Record<string, unknown>,
	): Promise<RunSyncResult>;
}

interface UtilsModule {
	getFinalOutput(messages: unknown[]): string;
}

interface ExecutorToolResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details?: {
		totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
		timeoutMs?: number;
		deadlineAt?: number;
	};
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (...args: unknown[]) => Promise<ExecutorToolResult>;
	};
}

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!(execution && utils);

const runSync = execution?.runSync;
const getFinalOutput = utils?.getFinalOutput;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writePackageSkill(packageRoot: string, skillName: string): void {
	const skillDir = path.join(packageRoot, "skills", skillName);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } }, null, 2),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
		"utf-8",
	);
}

describe("single sync execution", { skip: !available ? "pi packages not available" : undefined }, () => {
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

	function readCall(): { args: string[]; systemPrompts: NonNullable<MockPiCallRecord["systemPrompts"]> } {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(-1);
		assert.ok(callFile, "expected a recorded mock pi call");
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		return { args: payload.args, systemPrompts: payload.systemPrompts ?? [] };
	}

	function readCallArgs(): string[] {
		return readCall().args;
	}

	function makeExecutor(
		agents = [makeAgent("echo")],
		config: Record<string, unknown> = {},
		state = { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
	) {
		return createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config,
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
	}

	it("spawns agent and captures output", async () => {
		mockPi.onCall({ output: "Hello from mock agent" });
		const agents = makeAgentConfigs(["echo"]);

		const sessionFile = path.join(tempDir, "child-session.jsonl");
		const result = await runSync(tempDir, agents, "echo", "Say hello", { sessionFile });

		assert.equal(result.exitCode, 0);
		assert.equal(result.agent, "echo");
		assert.equal(result.sessionFile, sessionFile);
		assert.ok(result.messages.length > 0, "should have messages");

		const output = getFinalOutput(result.messages);
		assert.equal(output, "Hello from mock agent");
	});

	it("treats action='single' with execution fields as single execution", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "single alias finished" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-alias",
			{ action: "single", agent: "echo", task: "Run through alias" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /single alias finished/);
	});

	it("rejects unknown action strings at runtime", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"unknown-action",
			{ action: "not-a-real-action" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Unknown action: not-a-real-action/);
		assert.match(result.content[0]?.text ?? "", /Valid:/);
	});

	it("rejects duplicate concurrent subagent execution calls", async () => {
		mockPi.onCall({ output: "first call completed", delay: 100 });
		const executor = makeExecutor([makeAgent("echo")]);
		const ctx = makeMinimalCtx(tempDir);

		const first = executor.execute("first", { agent: "echo", task: "First call" }, new AbortController().signal, undefined, ctx);
		const second = await executor.execute("second", { agent: "echo", task: "Duplicate call" }, new AbortController().signal, undefined, ctx);
		const firstResult = await first;

		assert.equal(firstResult.isError, undefined);
		assert.equal(second.isError, true);
		assert.match(second.content[0]?.text ?? "", /Issue exactly ONE subagent call per turn/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("ignores legacy per-session spawn quota config and env values", async () => {
		const savedMaxSpawns = process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION;
		process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION = "0";
		try {
			mockPi.onCall({ output: "first call completed" });
			mockPi.onCall({ output: "second call completed" });
			const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 1 });
			const ctx = makeMinimalCtx(tempDir);

			const first = await executor.execute("first", { agent: "echo", task: "First call" }, new AbortController().signal, undefined, ctx);
			const second = await executor.execute("second", { agent: "echo", task: "Second call" }, new AbortController().signal, undefined, ctx);

			assert.equal(first.isError, undefined);
			assert.match(first.content[0]?.text ?? "", /first call completed/);
			assert.equal(second.isError, undefined);
			assert.match(second.content[0]?.text ?? "", /second call completed/);
			assert.equal(mockPi.callCount(), 2);
		} finally {
			if (savedMaxSpawns === undefined) delete process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION;
			else process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION = savedMaxSpawns;
		}
	});

	it("allows management actions while an execution call is in progress", async () => {
		mockPi.onCall({ output: "first call completed", delay: 100 });
		const executor = makeExecutor([makeAgent("echo")]);
		const ctx = makeMinimalCtx(tempDir);

		const first = executor.execute("first", { agent: "echo", task: "First call" }, new AbortController().signal, undefined, ctx);
		const status = await executor.execute("status", { action: "status" }, new AbortController().signal, undefined, ctx);
		const firstResult = await first;

		assert.equal(firstResult.isError, undefined);
		assert.equal(status.isError, undefined);
		assert.doesNotMatch(status.content[0]?.text ?? "", /Rejected: a subagent call is already in progress/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("allows intentional parallel tasks inside one subagent execution call", async () => {
		mockPi.onCall({ output: "first parallel result" });
		mockPi.onCall({ output: "second parallel result" });
		const executor = makeExecutor([makeAgent("echo"), makeAgent("second")]);

		const result = await executor.execute(
			"parallel",
			{ tasks: [{ agent: "echo", task: "First task" }, { agent: "second", task: "Second task" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 2);
		assert.deepEqual(result.details?.totalCost, { inputTokens: 200, outputTokens: 100, costUsd: 0.002 });
	});

	it("reports total cost for foreground single runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "single result" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-cost",
			{ agent: "echo", task: "Single task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details?.totalCost, { inputTokens: 100, outputTokens: 50, costUsd: 0.001 });
	});

	it("carries resolved tk ticket metadata through active foreground single updates", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const originalTicketsDir = process.env.TICKETS_DIR;
		process.env.TICKETS_DIR = path.join(tempDir, ".tickets");
		try {
			fs.mkdirSync(path.join(tempDir, ".tickets"), { recursive: true });
			fs.writeFileSync(path.join(tempDir, ".tickets", "psr-raw4.md"), "---\nid: psr-raw4\n---\n# Show active tk title\n", "utf-8");
			mockPi.onCall({ steps: [
				{ jsonl: [events.toolStart("read", { path: "README.md" })], delay: 60 },
				{ jsonl: [events.assistantMessage("single ticket done")] },
			] });
			const executor = makeExecutor([makeAgent("echo")]);
			const updates: Array<{ details?: { results?: Array<{ tkTicket?: { id: string; title: string }; progress?: { status?: string } }> } }> = [];
			const runPromise = executor.execute(
				"single-ticket",
				{ agent: "echo", task: "Run `tk show psr-raw4` first." },
				new AbortController().signal,
				(update) => updates.push(update as typeof updates[number]),
				makeMinimalCtx(tempDir),
			);

			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline && !updates.some((update) => update.details?.results?.some((result) => result.progress?.status === "running"))) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const running = updates.find((update) => update.details?.results?.some((result) => result.progress?.status === "running"));
			assert.deepEqual(running?.details?.results?.[0]?.tkTicket, { id: "psr-raw4", title: "Show active tk title" });

			const result = await runPromise;
			assert.deepEqual(result.details?.results?.[0]?.tkTicket, { id: "psr-raw4", title: "Show active tk title" });
		} finally {
			if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
			else process.env.TICKETS_DIR = originalTicketsDir;
		}
	});

	it("fails implementation runs that complete without mutation attempts", async () => {
		mockPi.onCall({ output: "Validation:\nlet rawFilename = params.filename.trim();" });
		const agents = [makeAgent("worker")];
		const controlEvents: Array<{ message: string }> = [];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "guard-run",
			onControlEvent: (event: { message: string }) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /completed without making edits/);
		assert.equal(result.finalOutput, "Validation:\nlet rawFilename = params.filename.trim();");
		assert.equal(result.progress.status, "failed");
		assert.deepEqual(controlEvents.map((event) => event.message), [
			"worker completed without making edits for an implementation task",
		]);
		assert.deepEqual(result.controlEvents?.map((event) => event.message), [
			"worker completed without making edits for an implementation task",
		]);
	});

	it("does not fail advisory oracle runs that finish without edits", async () => {
		mockPi.onCall({ output: "Oracle review:\n- finding one\n- finding two" });
		const executor = makeExecutor([makeAgent("oracle")]);

		const result = await executor.execute(
			"failed-single-output",
			{ agent: "oracle", task: "Implement the approved file changes" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.match(text, /^subagent results/m);
		assert.match(text, /Mode: single/);
		assert.match(text, /Status: completed/);
		assert.match(text, /Children: 1 completed/);
		assert.match(text, /1\/1\. oracle — completed/);
		assert.match(text, /Summary:\nOracle review:\n- finding one\n- finding two/);
		assert.equal(text.match(/Oracle review:\n- finding one\n- finding two/g)?.length ?? 0, 1);
	});

	it("fails future-tense implementation summaries when no mutation attempt occurred", async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
			runId: "guard-future-tense",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /completed without making edits/);
	});

	it("allows declared read-only agents to mention implementation words without edits", async () => {
		mockPi.onCall({ output: "Validation report after the patch" });
		const agents = [makeAgent("architect", { tools: ["read", "grep", "find", "ls"] })];

		const result = await runSync(tempDir, agents, "architect", "Produce a proposal that implements the approved fix", {
			runId: "guard-readonly-tools",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.status, "completed");
		assert.equal(result.finalOutput, "Validation report after the patch");
	});

	it("keeps bash-enabled implementation tasks conservative unless completion guard is disabled", async () => {
		mockPi.onCall({ output: "cold start test after patch" });
		mockPi.onCall({ output: "cold start test after patch" });
		const agents = [
			makeAgent("test-runner", { tools: ["read", "grep", "bash", "ls"] }),
			makeAgent("test-runner-optout", { tools: ["read", "grep", "bash", "ls"], completionGuard: false }),
		];

		const withoutOptOut = await runSync(tempDir, agents, "test-runner", "Patch the cold start test", {
			runId: "guard-bash-conservative",
		});
		assert.equal(withoutOptOut.exitCode, 1);
		assert.match(withoutOptOut.error ?? "", /completed without making edits/);

		const withOptOut = await runSync(tempDir, agents, "test-runner-optout", "Patch the cold start test", {
			runId: "guard-bash-optout",
		});
		assert.equal(withOptOut.exitCode, 0);
		assert.equal(withOptOut.progress.status, "completed");
	});

	it("allows implementation runs when parsed messages include a real edit tool call", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", name: "edit", arguments: { path: "src/file.ts", oldText: "a", newText: "b" } }],
						model: "mock/test-model",
						stopReason: "toolUse",
						usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					},
				},
				events.assistantMessage("Applied edit"),
			],
		});
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "guard-success",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.status, "completed");
		assert.equal(result.finalOutput, "Applied edit");
	});

	it("returns error for unknown agent", async () => {
		const agents = makeAgentConfigs(["echo"]);
		const result = await runSync(tempDir, agents, "nonexistent", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Unknown agent"));
	});


	it("emits an active-long-running notice after the turn threshold", async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
			runId: "run-active",
			controlConfig: { enabled: true, activeNoticeAfterTurns: 2, activeNoticeAfterMs: 999_999, activeNoticeAfterTokens: 999_999, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(controlEvents.length, 1);
		assert.equal(controlEvents[0]?.type, "active_long_running");
		assert.equal(controlEvents[0]?.reason, "turn_threshold");
		assert.equal(controlEvents[0]?.turns, 2);
		assert.equal(result.controlEvents?.[0]?.type, "active_long_running");
		assert.equal(result.progress.activityState, "active_long_running");
	});

	it("does not emit idle attention while a tool call is still running", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("bash", { command: "echo still running" })] },
				{ delay: 1_300, jsonl: [events.toolEnd("bash")] },
				{ jsonl: [events.assistantMessage("Done after the tool finished.")] },
			],
		});
		const agents = [makeAgent("scout")];
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "scout", "Investigate behavior", {
			runId: "run-tool-inflight-idle-guard",
			controlConfig: { enabled: true, needsAttentionAfterMs: 200, activeNoticeAfterMs: 999_999, activeNoticeAfterTurns: 999_999, activeNoticeAfterTokens: 999_999, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(controlEvents.find((event) => event.reason === "idle"), undefined);
		assert.equal(result.controlEvents?.find((event) => event.reason === "idle"), undefined);
		assert.equal(result.progress.activityState, undefined);
	});

	it("still emits idle attention after the tool finishes and the child goes silent", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("bash", { command: "echo done" })] },
				{ delay: 1_300, jsonl: [events.toolEnd("bash")] },
				{ delay: 1_300, jsonl: [events.assistantMessage("Done after an idle gap.")] },
			],
		});
		const agents = [makeAgent("scout")];
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "scout", "Investigate behavior", {
			runId: "run-post-tool-idle",
			controlConfig: { enabled: true, needsAttentionAfterMs: 200, activeNoticeAfterMs: 999_999, activeNoticeAfterTurns: 999_999, activeNoticeAfterTokens: 999_999, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		const idleEvent = controlEvents.find((event) => event.reason === "idle");
		assert.equal(idleEvent?.type, "needs_attention");
		assert.equal(result.controlEvents?.find((event) => event.reason === "idle")?.type, "needs_attention");
		assert.equal(result.progress.activityState, "needs_attention");
	});

	it("escalates repeated mutating tool failures to needs attention", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.assistantMessage("I need to retry the same edit."),
			],
		});
		const agents = [makeAgent("worker")];
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
			runId: "run-failures",
			controlConfig: { enabled: true, failedToolAttemptsBeforeAttention: 3, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		const failureEvent = controlEvents.find((event) => event.reason === "tool_failures");
		assert.equal(failureEvent?.type, "needs_attention");
		assert.equal(failureEvent?.currentPath, "src/runs/background/async-status.ts");
		assert.match(failureEvent?.recentFailureSummary ?? "", /No exact match/);
		assert.equal(result.progress.activityState, "needs_attention");
	});

	it("does not surface control state or events when control is disabled", async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
			runId: "run-control-disabled",
			controlConfig: { enabled: false, activeNoticeAfterTurns: 1, activeNoticeAfterMs: 1, activeNoticeAfterTokens: 1, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.activityState, undefined);
		assert.equal(result.controlEvents, undefined);
		assert.equal(controlEvents.length, 0);
	});

	it("captures non-zero exit code", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Something went wrong" });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Something went wrong"));
	});

	it("handles long tasks via temp file (ENAMETOOLONG prevention)", async () => {
		mockPi.onCall({ output: "Got it" });
		const longTask = "Analyze ".repeat(2000); // ~16KB
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", longTask, {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.equal(output, "Got it");
	});

	it("uses agent model config", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
		// result.model is set from agent config via applyThinkingSuffix, then
		// overwritten by the first message_end event only if result.model is unset.
		// Since agent has model config, it stays as the configured value.
		assert.equal(result.model, "anthropic/claude-sonnet-4");
	});

	it("model override from options takes precedence", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			modelOverride: "openai/gpt-4o",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "openai/gpt-4o");
	});

	it("foreground single runs inherit the parent session model when no model is set", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Done" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-parent-model",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			{
				...makeMinimalCtx(tempDir),
				model: { provider: "deepseek", id: "deepseek-v4-flash" },
			},
		);

		assert.equal(result.isError, undefined);
		const args = readCallArgs();
		assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
	});

	it("foreground single explicit model overrides remain authoritative over the parent session model", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Done" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-explicit-model-override",
			{ agent: "echo", task: "Task", model: "openai/gpt-5-mini" },
			new AbortController().signal,
			undefined,
			{
				...makeMinimalCtx(tempDir),
				model: { provider: "deepseek", id: "deepseek-v4-flash" },
			},
		);

		assert.equal(result.isError, undefined);
		const args = readCallArgs();
		assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5-mini");
	});

	it("prefers the parent session provider for ambiguous bare model ids", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			preferredModelProvider: "github-copilot",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "github-copilot/gpt-5-mini");
		assert.deepEqual(result.attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("surfaces a dropped thinking level in foreground progress without changing the model arg", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "openai/gpt-5", thinking: "max" })];
		const availableModels = [{
			provider: "openai",
			id: "gpt-5",
			fullId: "openai/gpt-5",
			reasoning: true,
			thinkingLevelMap: { max: null },
		}];

		const result = await runSync(tempDir, agents, "echo", "Task", { availableModels, runId: "foreground-thinking-drop" });
		const note = getThinkingLevelDropNote("openai/gpt-5", "max", false, { availableModels });
		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "openai/gpt-5");
		const args = readCallArgs();
		assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5");
		assert.ok(note);
		assert.equal(result.progress.recentOutput.filter((line) => line === note).length, 1);
	});

	it("preserves a max thinking suffix for resolved foreground models without capability metadata", async () => {
		mockPi.onCall({ output: "Done" });
		const model = "anthropic/claude-sonnet-4-5";
		const agents = [makeAgent("echo", { model, thinking: "max" })];
		const availableModels = [{
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			fullId: model,
			reasoning: true,
		}];

		const result = await runSync(tempDir, agents, "echo", "Task", { availableModels, runId: "foreground-thinking-metadata-missing" });
		assert.equal(result.exitCode, 0);
		assert.equal(result.model, `${model}:max`);
		const args = readCallArgs();
		assert.equal(args[args.indexOf("--model") + 1], `${model}:max`);
		assert.equal(getThinkingLevelDropNote(model, "max", false, { availableModels }), undefined);
	});

	it("tracks usage from message events", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 100); // from mock
		assert.equal(result.usage.output, 50); // from mock
	});

	it("retries with fallback models on retryable provider failures", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "temporary provider failure" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered on fallback" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-sync",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.deepEqual(result.attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(result.modelAttempts?.length, 2);
		assert.equal(result.modelAttempts?.[0]?.success, false);
		assert.equal(result.modelAttempts?.[1]?.success, true);
		assert.equal(result.usage.turns, 2);
		assert.equal(mockPi.callCount(), 2);
	});

	it("tries per-dispatch fallback models before agent fallback models and only shows notices after a retry", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered on the dispatch fallback" });
		const executor = makeExecutor([
			makeAgent("echo", {
				model: "openai/gpt-5-mini",
				fallbackModels: ["google/gemini-2.5-pro"],
			}),
		]);

		const result = await executor.execute(
			"single-dispatch-fallback-order",
			{
				agent: "echo",
				task: "Task",
				fallbackModels: ["anthropic/claude-sonnet-4"],
				modelFallbackNotice: "Quota fallback engaged",
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Summary:\nNotice: Quota fallback engaged\n\nRecovered on the dispatch fallback/);
		assert.deepEqual(result.details?.results?.[0]?.attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(result.details?.results?.[0]?.modelFallbackNotice, "Quota fallback engaged");
		assert.equal(mockPi.callCount(), 2);
	});

	it("suppresses fallback notices when the primary attempt succeeds", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Done without retry" });
		const executor = makeExecutor([makeAgent("echo", { model: "openai/gpt-5-mini", fallbackModels: ["anthropic/claude-sonnet-4"] })]);

		const result = await executor.execute(
			"single-fallback-notice-no-retry",
			{ agent: "echo", task: "Task", modelFallbackNotice: "Should stay hidden" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Notice: Should stay hidden/);
		assert.equal(result.details?.results?.[0]?.modelFallbackNotice, undefined);
	});

	it("retries with fallback models when provider errors exit zero", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "weekly quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 you have reached your weekly usage limit / quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered on fallback" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-zero-exit-provider-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, true]);
	});

	it("retries with fallback models when a zero-exit attempt has empty output", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: "openai/gpt-5-mini",
					stopReason: "error",
					usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered from empty output" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-zero-exit-empty-output",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.equal(result.finalOutput, "Recovered from empty output");
		assert.match(result.modelAttempts?.[0]?.error ?? "", /no output/i);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, true]);
		assert.equal(mockPi.callCount(), 2);
	});

	it("fails zero-exit provider errors when no fallback succeeds", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "weekly quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		const agents = [makeAgent("echo", { model: "openai/gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "zero-exit-provider-error-no-fallback",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /429 quota exceeded/);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false]);
	});

	it("treats recovered child tool errors as successful foreground runs", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolResult("read", "EISDIR: illegal operation on a directory", true),
				events.assistantMessage("Done"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Inspect files", {
			runId: "recovered-tool-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "Done");
		assert.equal(getFinalOutput(result.messages), "Done");
		assert.equal(result.progress.status, "completed");
	});

	it("treats recovered assistant provider errors as successful foreground runs", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage("Recovered"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
			runId: "recovered-provider-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "Recovered");
		assert.equal(getFinalOutput(result.messages), "Recovered");
		assert.equal(result.progress.status, "completed");
	});

	it("keeps provider errors failed when followed only by empty assistant output", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage(""),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
			runId: "provider-error-empty-stop",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /provider transport failed/);
		assert.equal(result.finalOutput, "");
		assert.equal(result.progress.status, "failed");
	});

	it("fails when all fallback model attempts report provider errors", async () => {
		for (const model of ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]) {
			mockPi.onCall({
				jsonl: [{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: `${model} quota hit` }],
						model,
						errorMessage: "429 quota exceeded",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				}],
				exitCode: 0,
			});
		}
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "zero-exit-provider-error-all-fallbacks-fail",
		});

		assert.equal(result.exitCode, 1);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, false]);
		assert.match(result.error ?? "", /429 quota exceeded/);
	});

	it("baselines output files per fallback attempt", async () => {
		const outputPath = path.join(tempDir, "fallback-output.md");
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
			delay: 100,
		});
		mockPi.onCall({ output: "fallback assistant output" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const runPromise = runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-output-per-attempt",
			outputPath,
		});
		setTimeout(() => {
			fs.writeFileSync(outputPath, "stale partial output from failed primary", "utf-8");
		}, 20);

		const result = await runPromise;

		assert.equal(result.exitCode, 0);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "fallback assistant output");
	});

	it("does not retry on ordinary task/tool failures", async () => {
		mockPi.onCall({
			jsonl: [events.toolResult("bash", "process exited with code 127")],
			exitCode: 0,
		});
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "no-fallback-task-failure",
		});

		assert.equal(result.exitCode, 127);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("tracks progress during execution", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", { index: 3 });

		assert.ok(result.progress, "should have progress");
		assert.equal(result.progress.agent, "echo");
		assert.equal(result.progress.index, 3);
		assert.equal(result.progress.status, "completed");
		assert.ok(result.progress.durationMs > 0, "should track duration");
	});

	it("tracks live activity updates and exposes artifact paths while running", async () => {
		const updates: Array<{ details?: { results?: Array<{ artifactPaths?: ArtifactPaths }>; progress?: ProgressSummary[] } }> = [];
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "package.json" })], delay: 20 },
				{ jsonl: [events.toolEnd("read"), events.toolResult("read", "{\"name\":\"pkg\"}")], delay: 20 },
				{ jsonl: [events.assistantMessage("Done")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "live-progress",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
			onUpdate: (update: { details?: { results?: Array<{ artifactPaths?: ArtifactPaths }>; progress?: ProgressSummary[] } }) => {
				updates.push(update);
			},
		});

		assert.ok(updates.length > 0, "expected at least one live progress update");
		assert.equal(
			updates.some((update) => update.details?.results?.[0]?.artifactPaths?.outputPath.endsWith("_output.md") === true),
			true,
		);
		const runningToolUpdate = updates.find((update) => update.details?.progress?.[0]?.currentTool === "read");
		assert.ok(runningToolUpdate, "expected a live progress update for the running tool");
		assert.equal(runningToolUpdate?.details?.progress?.[0]?.currentTool, "read");
		assert.equal(typeof runningToolUpdate?.details?.progress?.[0]?.currentToolStartedAt, "number");
		assert.equal(typeof result.progress.lastActivityAt, "number");
		assert.equal(result.progress.currentToolStartedAt, undefined);
	});

	it("sets progress.status to failed on non-zero exit", async () => {
		mockPi.onCall({ exitCode: 1 });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Task", {});

		assert.equal(result.progress.status, "failed");
	});

	it("handles multi-turn conversation from JSONL", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("bash", { command: "ls" }),
				events.toolEnd("bash"),
				events.toolResult("bash", "file1.txt\nfile2.txt"),
				events.assistantMessage("Found 2 files: file1.txt and file2.txt"),
			],
		});
		const agents = makeAgentConfigs(["scout"]);

		const result = await runSync(tempDir, agents, "scout", "List files", {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.ok(output.includes("file1.txt"), "should capture assistant text");
		assert.equal(result.progress.toolCount, 1, "should count tool calls");
	});

	it("resolves skills from the effective task cwd", async () => {
		const taskCwd = createTempDir("pi-subagent-task-cwd-");
		try {
			writePackageSkill(taskCwd, "task-cwd-skill");
			mockPi.onCall({ output: "Done" });
			const agents = [makeAgent("echo", { skills: ["task-cwd-skill"] })];

			const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

			assert.equal(result.exitCode, 0);
			assert.deepEqual(result.skills, ["task-cwd-skill"]);
			assert.equal(result.skillsWarning, undefined);
		} finally {
			removeTempDir(taskCwd);
		}
	});

	it("falls back to the runtime cwd when the task cwd lacks a skill", async () => {
		const taskCwd = path.join(tempDir, "nested");
		fs.mkdirSync(taskCwd, { recursive: true });
		writePackageSkill(tempDir, "runtime-fallback-skill");
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { skills: ["runtime-fallback-skill"] })];

		const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.skills, ["runtime-fallback-skill"]);
		assert.equal(result.skillsWarning, undefined);
	});

	it("fails foreground runs on explicit unavailable pi-subagents skill requests without spawning", async () => {
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Task", { skills: ["pi-subagents"] });

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Skills not found: pi-subagents");
		assert.equal(mockPi.callCount(), 0);
	});

	it("fails foreground runs when an agent default requests pi-subagents skill", async () => {
		const agents = [makeAgent("worker", { skills: ["pi-subagents"] })];

		const result = await runSync(tempDir, agents, "worker", "Task", {});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Skills not found: pi-subagents");
		assert.equal(mockPi.callCount(), 0);
	});

	it("writes artifacts when configured", async () => {
		mockPi.onCall({ output: "Result text" });
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "test-run",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		assert.equal(result.exitCode, 0);
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.ok(result.transcriptPath, "should expose transcript path on the result");
		assert.equal(result.transcriptPath, result.artifactPaths.transcriptPath);
		assert.ok(fs.existsSync(result.transcriptPath), "transcript should be written");
		const transcript = fs.readFileSync(result.transcriptPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { recordType?: string; source?: string; text?: string });
		assert.equal(transcript[0]?.recordType, "message");
		assert.equal(transcript[0]?.source, "foreground");
		assert.match(transcript.at(-1)?.text ?? "", /^Result text/);
		assert.equal(result.transcriptError, undefined);
		assert.ok(fs.existsSync(artifactsDir), "artifacts dir should exist");
	});

	it("does not surface transcript paths when transcript artifacts are disabled", async () => {
		mockPi.onCall({ output: "Result text" });
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts-disabled-transcript");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "test-run-no-transcript",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeTranscript: false, includeMetadata: true },
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.transcriptPath, undefined);
		assert.equal(result.transcriptError, undefined);
		assert.ok(result.artifactPaths?.metadataPath, "should have metadata path");
		const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as { transcriptPath?: string; transcriptError?: string };
		assert.equal(metadata.transcriptPath, undefined);
		assert.equal(metadata.transcriptError, undefined);
		assert.equal(fs.existsSync(result.artifactPaths.transcriptPath!), false);
	});

	it("preserves agent-written output files instead of overwriting them with the final receipt", async () => {
		const outputPath = path.join(tempDir, "report.md");
		const artifactsDir = path.join(tempDir, "artifacts");
		mockPi.onCall({ output: `Wrote to ${outputPath}`, delay: 100 });
		const agents = makeAgentConfigs(["echo"]);

		const runPromise = runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-preserved",
			outputPath,
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		setTimeout(() => {
			fs.writeFileSync(outputPath, "real file content", "utf-8");
		}, 20);

		const result = await runPromise;
		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "real file content");
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "real file content");
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), "real file content");
	});

	it("falls back to persisting assistant output when the target file was not changed", async () => {
		const outputPath = path.join(tempDir, "report.md");
		fs.writeFileSync(outputPath, "stale content", "utf-8");
		mockPi.onCall({ output: "fresh assistant output" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-fallback",
			outputPath,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "fresh assistant output");
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "fresh assistant output");
	});

	it("routes foreground single relative outputs to the parent session artifact directory by default", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "default report" });
		const executor = makeExecutor([makeAgent("researcher", { output: "context.md" })]);
		const parentSessionFile = path.join(tempDir, "parent-session", "session.jsonl");
		const ctx = {
			...makeMinimalCtx(tempDir),
			sessionManager: {
				getSessionId: () => "session-123",
				getSessionFile: () => parentSessionFile,
			},
		};

		const result = await executor.execute(
			"single-default-output-base",
			{ agent: "researcher", task: "Write report" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		const outputRoot = path.join(tempDir, "parent-session", "subagent-artifacts", "outputs");
		const taskArg = readCallArgs().at(-1) ?? "";
		assert.equal(result.isError, undefined);
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputRoot)}.*context\\.md`));
		const outputPath = taskArg.match(/Write your findings to exactly this path: (\S+)/)?.[1];
		assert.ok(outputPath, "expected output path in child task");
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "default report");
		assert.equal(fs.existsSync(path.join(tempDir, ".pi-subagents", "artifacts")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
	});

	it("routes foreground single relative outputs to configured singleRunOutputBaseDir", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "configured report" });
		const configuredBase = path.join(tempDir, "configured-outputs");
		const executor = makeExecutor(
			[makeAgent("researcher", { output: "context.md" })],
			{ singleRunOutputBaseDir: configuredBase },
		);

		const result = await executor.execute(
			"single-configured-output-base",
			{ agent: "researcher", task: "Write report" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const expectedOutputPath = path.join(configuredBase, "context.md");
		const taskArg = readCallArgs().at(-1) ?? "";
		assert.equal(result.isError, undefined);
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(expectedOutputPath)}`));
		assert.equal(fs.readFileSync(expectedOutputPath, "utf-8"), "configured report");
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
	});

	it("makes task-level output overrides authoritative in the child system prompt", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "override report" });
		const overridePath = path.join(tempDir, "custom-report.md");
		const executor = makeExecutor([
			makeAgent("researcher", {
				output: "default-report.md",
				systemPrompt: "Output format (`default-report.md`):\n\nWrite the full report to default-report.md.",
			}),
		]);

		const result = await executor.execute(
			"single-output-override-system-prompt",
			{ agent: "researcher", task: "Write report", output: overridePath },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const call = readCall();
		const taskArg = call.args.at(-1) ?? "";
		const systemPrompt = call.systemPrompts[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(overridePath)}`));
		assert.match(systemPrompt, /Output format \(`default-report\.md`\):/);
		assert.match(systemPrompt, /Runtime output path override:/);
		assert.match(systemPrompt, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(overridePath)}`));
		assert.match(systemPrompt, /Ignore any other output filename or output path mentioned elsewhere/);
	});

	it("treats string false as disabled output in foreground single runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "inline report" });
		const executor = makeExecutor([makeAgent("echo", { output: "default-report.md" })]);

		const result = await executor.execute(
			"single-string-false-output",
			{ agent: "echo", task: "Write report", output: "false" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /inline report/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Output saved to:/);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /Write your findings to(?: exactly this path)?:/);
	});

	it("rejects mismatched foreground timeout aliases before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"timeout-alias-validation",
			{ agent: "echo", task: "Task", timeoutMs: 100, maxRuntimeMs: 200 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /aliases/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("allows timeout settings for async runs before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"timeout-async-validation",
			{ agent: "echo", task: "Task", async: true, timeoutMs: 1_000 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Async:/);
		assert.equal(result.details?.timeoutMs, 1_000);
	});

	it("clamps async timeout requests to the agent execution ceiling", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo", { maxExecutionTimeMs: 600 })]);

		const result = await executor.execute(
			"timeout-async-clamped",
			{ agent: "echo", task: "Task", async: true, timeoutMs: 1_000 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.timeoutMs, 600);
	});

	it("clamps an ordinary resume from runtime remembered by a real foreground pause", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ delay: 10_000 });
		mockPi.onCall({ output: "resumed" });
		const maxExecutionTimeMs = 5_000;
		const state = {
			baseCwd: tempDir,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundRuns: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const executor = makeExecutor([makeAgent("echo", { maxExecutionTimeMs })], {}, state);
		const runPromise = executor.execute(
			"producer-pause-run",
			{ agent: "echo", task: "Pause after starting" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const readyDeadline = Date.now() + 5_000;
		while (Date.now() < readyDeadline) {
			if (mockPi.callCount() === 1 && typeof ([...state.foregroundControls.values()][0] as { interrupt?: unknown } | undefined)?.interrupt === "function") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		await executor.execute("producer-pause-interrupt", { action: "interrupt" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		const paused = await runPromise;
		assert.equal(paused.isError, undefined);

		const remembered = [...state.foregroundRuns.values()][0];
		const activeRuntimeMs = remembered?.children[0]?.activeRuntimeMs;
		assert.ok(typeof activeRuntimeMs === "number" && activeRuntimeMs > 0 && activeRuntimeMs < maxExecutionTimeMs);
		const result = await executor.execute(
			"resume-timeout-forwarding",
			{ action: "resume", id: remembered!.runId, message: "Continue.", maxRuntimeMs: 10_000 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.timeoutMs, maxExecutionTimeMs - activeRuntimeMs);
		assert.ok(result.details?.deadlineAt !== undefined);
	});

	it("rejects an ordinary resume once accumulated runtime exhausts the agent ceiling", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		// The run phase and the resume phase deliberately use different ceilings.
		// A generous run ceiling means the child completes on its own instead of
		// racing a kill, so activeRuntimeMs is a real duration (>= runDelayMs).
		// The resume ceiling is far below that duration, so
		// remainingExecutionTimeMs(resumeCeilingMs, activeRuntimeMs) is 0 and the
		// pre-spawn guard rejects the resume. CPU contention only makes
		// activeRuntimeMs larger, which pushes the precondition further into the
		// passing region rather than the failing one.
		const runDelayMs = 150;
		const runCeilingMs = 10_000;
		const resumeCeilingMs = 50;
		mockPi.onCall({ delay: runDelayMs, output: "finished under the generous ceiling" });
		const state = {
			baseCwd: tempDir,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundRuns: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const executor = makeExecutor([makeAgent("echo", { maxExecutionTimeMs: runCeilingMs })], {}, state);
		const completed = await executor.execute(
			"producer-exhausted-run",
			{ agent: "echo", task: "Run under a generous ceiling" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.ok(!completed.isError, "producer run should complete successfully under the generous ceiling");

		const remembered = [...state.foregroundRuns.values()][0];
		const activeRuntimeMs = remembered?.children[0]?.activeRuntimeMs;
		assert.ok(typeof activeRuntimeMs === "number" && activeRuntimeMs >= resumeCeilingMs);
		// Same run state, but the agent is now declared with a ceiling the run has
		// already burned through.
		const resumeExecutor = makeExecutor([makeAgent("echo", { maxExecutionTimeMs: resumeCeilingMs })], {}, state);
		const result = await resumeExecutor.execute(
			"resume-ceiling-exhausted",
			{ action: "resume", id: remembered!.runId, message: "Continue.", timeoutMs: 1_000 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", new RegExp(`exhausted its maxExecutionTimeMs ceiling after ${activeRuntimeMs}ms`));
		assert.equal(mockPi.callCount(), 1);
	});

	it("rejects file-only mode without an output path before spawning", async () => {
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-only-missing-path",
			outputMode: "file-only",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("returns only a saved-output reference in file-only mode", async () => {
		const outputPath = path.join(tempDir, "file-only-report.md");
		const artifactsDir = path.join(tempDir, "file-only-artifacts");
		mockPi.onCall({ output: "full saved output\nwith details" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-only",
			outputPath,
			outputMode: "file-only",
			artifactsDir,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.outputMode, "file-only");
		assert.equal(result.savedOutputPath, outputPath);
		assert.equal(result.outputReference?.path, outputPath);
		assert.match(result.finalOutput ?? "", /^Output saved to:/);
		assert.match(result.finalOutput ?? "", /2 lines/);
		assert.doesNotMatch(result.finalOutput ?? "", /full saved output/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "full saved output\nwith details");
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), "full saved output\nwith details");
	});

	it("passes maxSubagentDepth through to child execution env", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
		const agents = makeAgentConfigs(["echo"]);
		const prevDepth = process.env.PI_SUBAGENT_DEPTH;
		const prevMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;

		try {
			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: "depth-env",
				maxSubagentDepth: 1,
			});

			assert.equal(result.exitCode, 0);
			assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
				PI_SUBAGENT_DEPTH: "1",
				PI_SUBAGENT_MAX_DEPTH: "1",
			});
		} finally {
			if (prevDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = prevDepth;
			if (prevMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
			else process.env.PI_SUBAGENT_MAX_DEPTH = prevMaxDepth;
		}
	});

	it("passes prompt inheritance env flags through to child execution", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_INHERIT_PROJECT_CONTEXT", "PI_SUBAGENT_INHERIT_SKILLS"] });
		const agents = [makeAgent("echo", {
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "prompt-inheritance-env",
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
			PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: "0",
			PI_SUBAGENT_INHERIT_SKILLS: "0",
		});
	});

	it("passes supervisor metadata through to child execution", async () => {
		mockPi.onCall({ echoEnv: [
			"PI_SUBAGENT_INTERCOM_SESSION_NAME",
			"PI_SUBAGENT_ORCHESTRATOR_TARGET",
			"PI_SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH",
			"PI_SUBAGENT_RUN_ID",
			"PI_SUBAGENT_CHILD_AGENT",
			"PI_SUBAGENT_CHILD_INDEX",
		] });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "78f659a3",
			index: 2,
			intercomSessionName: "subagent-echo-78f659a3-3",
			orchestratorIntercomTarget: "subagent-chat-parent",
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
			PI_SUBAGENT_INTERCOM_SESSION_NAME: "subagent-echo-78f659a3-3",
			PI_SUBAGENT_ORCHESTRATOR_TARGET: "subagent-chat-parent",
			PI_SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH: "unavailable",
			PI_SUBAGENT_RUN_ID: "78f659a3",
			PI_SUBAGENT_CHILD_AGENT: "echo",
			PI_SUBAGENT_CHILD_INDEX: "2",
		});
	});

	it("passes custom tool extensions through even when explicit extensions are allowlisted", { skip: process.platform === "win32" ? "extension path resolution intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", {
			tools: ["read", "./custom-tool.ts"],
			extensions: ["./allowed-ext.ts"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "tool-extension-allowlist",
		});

		assert.equal(result.exitCode, 0);
		const args = readCallArgs();
		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.ok(extensionArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("custom-tool.ts")));
		assert.ok(extensionArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("allowed-ext.ts")));
	});

	it("passes subagent-only extensions through to child execution", { skip: process.platform === "win32" ? "extension path resolution intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", {
			tools: ["read"],
			subagentOnlyExtensions: ["./child-only-tool.ts"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "subagent-only-extension",
		});

		assert.equal(result.exitCode, 0);
		const args = readCallArgs();
		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.ok(extensionArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("child-only-tool.ts")));
	});

	it("treats forced drain after final assistant output as cleanup success", async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("done-before-drain")],
			stderr: "Done after 1 turn(s). Ready for input.\n",
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "echo", "Task", {});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 4000, `should clean up shortly after terminal stop, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "done-before-drain");
		assert.ok(!(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")));
	});

	it("treats forced drain after empty terminal assistant output as cleanup success", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: "mock/test-model",
					stopReason: "stop",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "echo", "Task", {});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 4000, `should clean up shortly after empty terminal stop, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "");
		assert.equal(result.progress.status, "completed");
		assert.ok(!(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")));
	});

	it("keeps explicit assistant errors as failures during final-drain cleanup", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "failed" }],
					model: "mock/test-model",
					stopReason: "stop",
					errorMessage: "provider exploded",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "provider exploded");
		assert.equal(result.progress.status, "failed");
	});

	it("handles abort signal (completes faster than delay)", async () => {
		mockPi.onCall({ delay: 10000 }); // Long delay — process should be killed before this
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		await runSync(tempDir, agents, "slow", "Slow task", {
			signal: controller.signal,
		});
		const elapsed = Date.now() - start;

		// The key assertion: the run should complete much faster than the 10s delay,
		// proving the abort signal terminated the process early.
		assert.ok(elapsed < 5000, `should abort early, took ${elapsed}ms`);
		// Exit code is platform-dependent (Windows: often 1 or 0, Linux: null/143)
	});

	it("marks foreground runs that exceed timeoutMs as timed out", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.assistantMessage("partial timeout update"), events.toolStart("read", { path: "README.md" })] },
				{ delay: 10000 },
			],
		});
		const agents = makeAgentConfigs(["slow"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			runId: "timeout-single",
			timeoutMs: 150,
		});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should time out early, took ${elapsed}ms`);
		assert.notEqual(result.exitCode, 0);
		assert.equal(result.timedOut, true);
		assert.equal(result.error, "Subagent timed out after 150ms.");
		assert.match(result.finalOutput ?? "", /Subagent timed out after 150ms\./);
		assert.match(result.finalOutput ?? "", /Run id: timeout-single/);
		assert.match(result.finalOutput ?? "", /Current tool: read/);
		assert.match(result.finalOutput ?? "", /Current path: README\.md/);
		assert.match(result.finalOutput ?? "", /Recent child output:\n- partial timeout update/);
		assert.equal(result.progress.status, "failed");
	});

	it("applies the agent execution ceiling to foreground timeouts", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.assistantMessage("partial timeout update")] },
				{ delay: 10000 },
			],
		});
		const agents = [makeAgent("slow", { maxExecutionTimeMs: 75 })];

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			runId: "timeout-single-agent-ceiling",
			timeoutMs: 150,
		});

		assert.equal(result.timedOut, true);
		assert.equal(result.error, "Subagent timed out after 75ms.");
	});

	it("does not fire or retain an above-Node-boundary foreground ceiling", async () => {
		mockPi.onCall({ output: "completed under long ceiling" });
		const agents = [makeAgent("long", { maxExecutionTimeMs: 2_147_483_648 })];

		const result = await runSync(tempDir, agents, "long", "Quick task", {
			runId: "timeout-single-above-node-boundary",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.timedOut, undefined);
		assert.equal(result.finalOutput, "completed under long ceiling");
	});

	it("keeps a shorter foreground caller timeout below the agent ceiling", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = [makeAgent("slow", { maxExecutionTimeMs: 150 })];

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			runId: "timeout-single-caller-shorter",
			timeoutMs: 75,
		});

		assert.equal(result.timedOut, true);
		assert.equal(result.error, "Subagent timed out after 75ms.");
	});

	it("writes timeout metadata with the resolved session file before artifact finalization", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.assistantMessage("partial output before timeout"), events.toolStart("read", { path: "src/runs/foreground/execution.ts" })] },
				{ delay: 10000 },
			],
		});
		const agents = makeAgentConfigs(["slow"]);
		const sessionFile = path.join(tempDir, "child-session.jsonl");
		const artifactsDir = path.join(tempDir, "artifacts");

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			runId: "timeout-artifact-metadata",
			timeoutMs: 150,
			sessionFile,
			artifactsDir,
			artifactConfig: { enabled: true, includeOutput: true, includeMetadata: true },
		});

		assert.equal(result.timedOut, true);
		assert.equal(result.sessionFile, sessionFile);
		assert.ok(result.artifactPaths, "should have artifact paths");
		const artifactText = fs.readFileSync(result.artifactPaths.outputPath, "utf-8");
		assert.match(artifactText, /Subagent timed out after 150ms\./);
		assert.match(artifactText, /Run id: timeout-artifact-metadata/);
		assert.match(artifactText, new RegExp(`Session file: ${sessionFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(artifactText, new RegExp(`Artifact output: ${result.artifactPaths.outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(artifactText, /Recent child output:\n- partial output before timeout/);

		const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as {
			timedOut?: boolean;
			sessionFile?: string;
		};
		assert.equal(metadata.timedOut, true);
		assert.equal(metadata.sessionFile, sessionFile);
	});

	it("does not advertise a jsonl timeout artifact when includeJsonl is false", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.assistantMessage("partial output before timeout"), events.toolStart("read", { path: "src/runs/foreground/execution.ts" })] },
				{ delay: 10000 },
			],
		});
		const agents = makeAgentConfigs(["slow"]);
		const artifactsDir = path.join(tempDir, "artifacts-no-jsonl");

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			runId: "timeout-no-jsonl-artifact",
			timeoutMs: 150,
			artifactsDir,
			artifactConfig: { enabled: true, includeOutput: true, includeMetadata: true, includeJsonl: false },
		});

		assert.equal(result.timedOut, true);
		assert.ok(result.artifactPaths, "should have artifact paths");
		const artifactText = fs.readFileSync(result.artifactPaths.outputPath, "utf-8");
		assert.doesNotMatch(artifactText, /Artifact jsonl:/);
	});

	it("does not advertise an output timeout artifact when includeOutput is false", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.assistantMessage("partial output before timeout"), events.toolStart("read", { path: "src/runs/foreground/execution.ts" })] },
				{ delay: 10000 },
			],
		});
		const agents = makeAgentConfigs(["slow"]);
		const artifactsDir = path.join(tempDir, "artifacts-no-output");

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			runId: "timeout-no-output-artifact",
			timeoutMs: 150,
			artifactsDir,
			artifactConfig: { enabled: true, includeOutput: false, includeMetadata: true },
		});

		assert.equal(result.timedOut, true);
		assert.doesNotMatch(result.finalOutput ?? "", /Artifact output:/);
	});

	it("does not add sessionFile to non-timeout metadata", async () => {
		mockPi.onCall({ output: "Hello from mock agent" });
		const agents = makeAgentConfigs(["echo"]);
		const sessionFile = path.join(tempDir, "child-session-success.jsonl");
		const artifactsDir = path.join(tempDir, "artifacts-success-session-metadata");

		const result = await runSync(tempDir, agents, "echo", "Say hello", {
			runId: "success-session-metadata",
			sessionFile,
			artifactsDir,
			artifactConfig: { enabled: true, includeOutput: true, includeMetadata: true },
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.sessionFile, sessionFile);
		assert.ok(result.artifactPaths, "should have artifact paths");
		const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as {
			timedOut?: boolean;
			sessionFile?: string;
		};
		assert.equal(metadata.timedOut, undefined);
		assert.equal(metadata.sessionFile, undefined);
	});

	it("allows a foreground run to finish on the final turn-budget grace turn", async () => {
		mockPi.onCall({
			jsonl: [
				mockAssistantMessage("working before wrap-up", "tool_use"),
				mockAssistantMessage("final wrapped output", "stop"),
			],
		});
		const agents = makeAgentConfigs(["worker"]);

		const result = await runSync(tempDir, agents, "worker", "Use the final grace turn to wrap up.", {
			turnBudget: { maxTurns: 1, graceTurns: 1 },
			runId: "foreground-turn-budget-soft",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.turnBudgetExceeded, undefined);
		assert.equal(result.wrapUpRequested, true);
		assert.equal(result.turnBudget?.outcome, "wrap-up-requested");
		assert.equal(result.turnBudget?.turnCount, 2);
		assert.match(result.finalOutput ?? "", /Turn budget wrap-up was requested after 1 assistant turn/);
		assert.match(result.finalOutput ?? "", /final wrapped output/);
	});

	it("does not run acceptance verification after a foreground timeout", async () => {
		const markerPath = path.join(tempDir, "verify-ran.txt");
		const report = [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "integration test evidence" }],
				changedFiles: ["src/a.ts"],
				testsAddedOrUpdated: ["test/a.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["validation passed"],
				residualRisks: [],
				noStagedFiles: true,
				notes: "complete",
			}),
			"```",
		].join("\n");
		mockPi.onCall({ jsonl: [events.assistantMessage(report)], keepAliveAfterFinalMessageMs: 10000 });
		const agents = makeAgentConfigs(["slow"]);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			timeoutMs: 150,
			acceptance: {
				level: "verified",
				verify: [{
					id: "marker",
					command: "node -e \"require('node:fs').writeFileSync(process.env.VERIFY_MARKER, 'ran')\"",
					env: { VERIFY_MARKER: markerPath },
					timeoutMs: 10_000,
				}],
			},
		});

		assert.equal(result.timedOut, true);
		assert.equal(result.acceptance?.status, "rejected");
		assert.equal(result.acceptance?.runtimeChecks?.[0]?.id, "timeout");
		assert.equal(result.acceptance?.verifyRuns?.length, 0);
		assert.equal(fs.existsSync(markerPath), false);
	});

	it("appends the acceptance digest to the artifact but not to finalOutput for timed-out runs", async () => {
		// Regression: the timeout branch unconditionally replaced the artifact content with
		// plain timeoutDiagnostics, discarding the digest that was appended at the earlier
		// artifact-set site. finalOutput must stay exactly timeoutDiagnostics; the artifact
		// copy is the only surface that receives the digest.
		const reportBody = JSON.stringify({
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "integration test evidence" }],
			changedFiles: ["src/a.ts"],
			testsAddedOrUpdated: ["test/a.test.ts"],
			commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
			validationOutput: ["validation passed"],
			residualRisks: [],
			noStagedFiles: true,
		});
		const report = ["Done", "```acceptance-report", reportBody, "```"].join("\n");
		mockPi.onCall({ jsonl: [events.assistantMessage(report)], keepAliveAfterFinalMessageMs: 10000 });
		const agents = makeAgentConfigs(["slow"]);
		const digestArtifactsDir = path.join(tempDir, "artifacts-timeout-digest");

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			runId: "timeout-digest-split",
			timeoutMs: 150,
			artifactsDir: digestArtifactsDir,
			artifactConfig: { enabled: true, includeOutput: true, includeMetadata: false },
		});

		assert.equal(result.timedOut, true);
		// finalOutput must be exactly the timeout diagnostics — no digest
		assert.match(result.finalOutput ?? "", /Recovery diagnostics:/);
		assert.doesNotMatch(result.finalOutput ?? "", /Validation evidence \(from acceptance report\):/);
		// The artifact must carry the digest
		assert.ok(result.artifactPaths, "should have artifact paths");
		const artifactContent = fs.readFileSync(result.artifactPaths!.outputPath, "utf-8");
		assert.match(artifactContent, /Validation evidence \(from acceptance report\):/);
		// The artifact starts with the timeout diagnostics content (finalOutput is the prefix)
		assert.ok(
			artifactContent.startsWith(result.finalOutput!),
			`artifact should start with finalOutput (timeout diagnostics); finalOutput=${JSON.stringify(result.finalOutput?.slice(0, 200))}`,
		);
	});

	it("interrupts acceptance verification and returns a paused foreground result", async () => {
		const report = [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "integration test evidence" }],
				changedFiles: ["src/a.ts"],
				testsAddedOrUpdated: ["test/a.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["validation passed"],
				residualRisks: [],
				noStagedFiles: true,
				notes: "complete",
			}),
			"```",
		].join("\n");
		mockPi.onCall({ jsonl: [events.assistantMessage(report)] });
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const startedAt = Date.now();

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			interruptSignal: controller.signal,
			acceptance: {
				level: "verified",
				verify: [{ id: "slow", command: `${process.execPath} -e "setTimeout(()=>process.exit(0), 5000)"`, timeoutMs: 10_000 }],
			},
		});

		assert.ok(Date.now() - startedAt < 3_000, "interrupt should abort verification promptly");
		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.error, undefined);
		assert.equal(result.acceptance?.status, "skipped");
		assert.equal(result.acceptance?.runtimeChecks?.[0]?.id, "paused");
		assert.equal(result.acceptance?.verifyRuns?.[0]?.status, undefined);
		assert.match(result.finalOutput ?? "", /Interrupted/);
	});

	it("soft-interrupts the current turn and returns a paused result", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();
		const controlEvents: Array<{ type?: string; to?: string }> = [];

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			runId: "interrupt-run",
			interruptSignal: controller.signal,
			acceptance: { level: "checked", criteria: ["Finish the slow task"] },
			onControlEvent: (event: { type?: string; to?: string }) => {
				controlEvents.push(event);
			},
		});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should interrupt early, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.progress.activityState, undefined);
		assert.equal(result.acceptance?.status, "skipped");
		assert.equal(result.acceptance?.runtimeChecks?.[0]?.id, "paused");
		assert.equal(result.acceptance?.runtimeChecks?.[0]?.status, "not-applicable");
		assert.deepEqual(controlEvents, []);
		assert.match(result.finalOutput ?? "", /Interrupted/);
	});

	it("returns paused foreground single guidance with resume and redispatch commands", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ delay: 10000 });
		const state = { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
		const executor = makeExecutor([makeAgent("slow")], {}, state);
		const runPromise = executor.execute(
			"single-pause-run",
			{ agent: "slow", task: "Slow task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const readyDeadline = Date.now() + 5000;
		while (Date.now() < readyDeadline) {
			if (mockPi.callCount() === 1 && typeof ([...state.foregroundControls.values()][0] as { interrupt?: unknown } | undefined)?.interrupt === "function") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(mockPi.callCount(), 1);

		const interruptResult = await executor.execute(
			"single-pause-interrupt",
			{ action: "interrupt" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.match(interruptResult.content[0]?.text ?? "", /Interrupt requested for foreground run/);

		const result = await runPromise;
		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.match(text, /^Foreground run [a-z0-9-]+ paused after interrupt \(slow\)\./);
		assert.match(text, /Pause succeeded; this foreground run is paused and waiting for your explicit next action, not a dispatch error\./);
		assert.match(text, /Resume: subagent\(\{ action: "resume", id: "[a-z0-9-]+", message: "\.\.\." \}\)/);
		assert.match(text, /Replace\/re-dispatch: subagent\(\{ agent: "slow", task: "\.\.\." \}\)/);
	});

	it("preserves manual interrupt semantics when a timeout is also configured", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();

		setTimeout(() => controller.abort(), 100);
		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			interruptSignal: controller.signal,
			timeoutMs: 500,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.timedOut, undefined);
		assert.equal(result.error, undefined);
		assert.match(result.finalOutput ?? "", /Interrupted/);
	});

	for (const toolName of ["intercom", "contact_supervisor"]) {
		it(`pauses cleanly on ${toolName} handoff and reaps the child before returning`, async () => {
			const eventBus = createEventBus();
			let accepted = false;
			eventBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
				if (!payload || typeof payload !== "object") return;
				accepted = (payload as { accepted?: unknown }).accepted === true;
			});
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(toolName, toolName === "intercom" ? { action: "ask", to: "orchestrator" } : { reason: "need_decision", message: "Need a decision" })] },
					{ delay: 1000, jsonl: [events.assistantMessage("received pong")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			// Emit the detach request the moment we observe the coordination tool start
			// in a progress update — this is the signal the parent has set
			// `intercomStarted=true`. Using a fixed delay here races the mock's
			// cold spawn and flakes under load.
			let detachEmitted = false;
			const runPromise = runSync(tempDir, agents, "echo", "Task", {
				runId: `${toolName}-detach`,
				allowIntercomDetach: true,
				pauseBlockingSupervisor: true,
				intercomEvents: eventBus,
				onUpdate: (update) => {
					if (detachEmitted) return;
					const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
					const sawCoordinationTool = Array.isArray(progress) && progress.some((p) => p?.currentTool === toolName);
					if (!sawCoordinationTool) return;
					detachEmitted = true;
					eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "test-request" });
				},
			});

			const callDeadline = Date.now() + 5_000;
			let childPid: number | undefined;
			while (Date.now() < callDeadline && childPid === undefined) {
				const callFiles = fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-") && name.endsWith(".json")).sort();
				const match = callFiles.at(-1)?.match(/^call-\d+-(\d+)-/);
				if (match) childPid = Number(match[1]);
				if (childPid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
			}

			const result = await runPromise;

			assert.equal(result.exitCode, 0);
			assert.equal(result.detached, undefined);
			assert.equal(result.interrupted, true);
			assert.equal(result.pause?.kind, "awaiting_supervisor");
			assert.equal(result.pause?.ownerPid, undefined);
			assert.match(result.finalOutput ?? "", /Resume unchanged: subagent\(\{ action: "resume", id: "/);
			assert.match(result.finalOutput ?? "", /No child process is running\./);
			assert.match(result.finalOutput ?? "", /Cancel: subagent\(\{ action: "interrupt", id: /);
			assert.doesNotMatch(result.finalOutput ?? "", /detached for intercom coordination|fresh follow-up|fresh-redispatch/i);
			assert.equal(accepted, true);
			assert.ok(childPid, "expected mock child pid");
			assert.throws(() => process.kill(childPid!, 0), /ESRCH/);
		});
	}

	for (const testCase of [
		{ name: "intercom ask", toolName: "intercom", args: { action: "ask", to: "orchestrator" } },
		{ name: "contact_supervisor need_decision", toolName: "contact_supervisor", args: { reason: "need_decision", message: "Need a decision" } },
		{ name: "contact_supervisor interview_request", toolName: "contact_supervisor", args: { reason: "interview_request", message: "Need input", interview: { questions: [] } } },
	]) {
		it(`pauses foreground children on blocking ${testCase.name}`, async () => {
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(testCase.toolName, testCase.args)] },
					{ delay: 1000, jsonl: [events.assistantMessage("received pong")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: `${testCase.toolName}-blocking-detach`,
				allowIntercomDetach: true,
				pauseBlockingSupervisor: true,
			});

			assert.equal(result.exitCode, 0);
			assert.equal(result.detached, undefined);
			assert.equal(result.interrupted, true);
			assert.equal(result.pause?.kind, "awaiting_supervisor");
			assert.equal(result.pause?.ownerPid, undefined);
			if (testCase.toolName === "intercom") {
				assert.deepEqual(result.pause?.request, { tool: "intercom", action: "ask" });
			} else if (testCase.args.reason === "interview_request") {
				assert.deepEqual(result.pause?.request, {
					tool: "contact_supervisor",
					reason: "interview_request",
					summary: "Need input",
				});
				assert.equal(JSON.stringify(result.pause?.request).includes("questions"), false);
			} else {
				assert.deepEqual(result.pause?.request, {
					tool: "contact_supervisor",
					reason: "need_decision",
					summary: "Need a decision",
				});
			}
			assert.match(result.finalOutput ?? "", /Resume unchanged: subagent\(\{ action: "resume", id: "/);
			assert.match(result.finalOutput ?? "", /No child process is running\./);
			assert.match(result.finalOutput ?? "", /Cancel: subagent\(\{ action: "interrupt", id: /);
			assert.doesNotMatch(result.finalOutput ?? "", /detached for intercom coordination|fresh follow-up|fresh-redispatch/i);
		});
	}

	it("reaps stubborn child and grandchild through the full owned-group escalation before publishing paused", { skip: process.platform === "win32" ? "POSIX process groups are unavailable" : undefined }, async () => {
		mockPi.onCall({
			ignoreSigint: true,
			ignoreSigterm: true,
			spawnStubbornDescendants: true,
			steps: [
				{ delay: 250, jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 10_000, jsonl: [events.assistantMessage("should not complete")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "stubborn-owned-group-pause",
			allowIntercomDetach: true,
			pauseBlockingSupervisor: true,
		});

		assert.equal(result.pause?.kind, "awaiting_supervisor");
		assert.equal(result.processCleanup?.terminated, true);
		assert.deepEqual(result.processCleanup?.signals, ["SIGINT", "SIGTERM", "SIGKILL"]);
		const parentPid = result.processCleanup?.processGroupId;
		assert.ok(parentPid, "expected owned process group id from this spawn");
		const signalLog = fs.readFileSync(path.join(mockPi.dir, `signals-${parentPid}.jsonl`), "utf-8");
		assert.match(signalLog, /SIGINT/);
		assert.match(signalLog, /SIGTERM/);
		const descendants = JSON.parse(fs.readFileSync(path.join(mockPi.dir, `descendants-${parentPid}.json`), "utf-8")) as { childPid: number; grandchildPid: number };
		for (const pid of [parentPid, descendants.childPid, descendants.grandchildPid]) {
			assert.throws(() => process.kill(pid, 0), /ESRCH/);
		}
	});

	it("persists supervisor pause transitions before signaling and clears owned pid after close", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("received pong")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const transitions: Array<{ stage: "pausing" | "paused"; ownerPid?: number; result: RunSyncResult }> = [];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "pause-ordering",
			allowIntercomDetach: true,
			pauseBlockingSupervisor: true,
			onSupervisorPauseTransition: (transition) => {
				transitions.push(transition as { stage: "pausing" | "paused"; ownerPid?: number; result: RunSyncResult });
			},
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(transitions.map((entry) => entry.stage), ["pausing", "paused"]);
		assert.equal(typeof transitions[0]?.ownerPid, "number");
		assert.ok((transitions[0]?.ownerPid ?? 0) > 0);
		assert.equal(transitions[0]?.result.pause?.ownerPid, transitions[0]?.ownerPid);
		assert.equal(transitions[1]?.result.pause?.ownerPid, undefined);
		assert.equal(typeof transitions[1]?.result.pause?.pausedAt, "number");
		assert.equal(result.pause?.ownerPid, undefined);
	});

	it("fails explicitly when pre-signal supervisor pause persistence fails", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("received pong")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const secret = "/private/root/pause-persist-secret";
		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "pause-persist-fails",
			allowIntercomDetach: true,
			pauseBlockingSupervisor: true,
			onSupervisorPauseTransition: ({ stage }) => {
				if (stage === "pausing") throw new Error(`pause persistence failed at ${secret}`);
			},
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.pause, undefined);
		assert.equal(result.interrupted, false);
		assert.match(result.error ?? "", /Foreground supervisor lifecycle update failed/);
		assert.match(result.finalOutput ?? "", /Foreground supervisor lifecycle update failed/);
		assert.doesNotMatch(result.finalOutput ?? "", new RegExp(escapeRegExp(secret)));
		assert.equal(result.progress.status, "failed");
	});

	it("fails explicitly when post-reap supervisor pause finalization fails", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("received pong")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const secret = "/private/root/pause-finalize-secret";
		const runPromise = runSync(tempDir, agents, "echo", "Task", {
			runId: "pause-finalize-fails",
			allowIntercomDetach: true,
			pauseBlockingSupervisor: true,
			onSupervisorPauseTransition: ({ stage }) => {
				if (stage === "paused") throw new Error(`pause finalization failed at ${secret}`);
			},
		});

		const callDeadline = Date.now() + 5_000;
		let childPid: number | undefined;
		while (Date.now() < callDeadline && childPid === undefined) {
			const callFiles = fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-") && name.endsWith(".json")).sort();
			const match = callFiles.at(-1)?.match(/^call-\d+-(\d+)-/);
			if (match) childPid = Number(match[1]);
			if (childPid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
		}

		const result = await runPromise;

		assert.ok(childPid, "expected mock child pid");
		assert.throws(() => process.kill(childPid!, 0), /ESRCH/);
		assert.equal(result.exitCode, 1);
		assert.equal(result.pause, undefined);
		assert.equal(result.interrupted, false);
		assert.match(result.error ?? "", /Foreground supervisor lifecycle update failed/);
		assert.match(result.finalOutput ?? "", /Foreground supervisor lifecycle update failed/);
		assert.doesNotMatch(result.finalOutput ?? "", new RegExp(escapeRegExp(secret)));
		assert.doesNotMatch(result.finalOutput ?? "", /Resume unchanged|awaiting supervisor/);
		assert.equal(result.progress.status, "failed");
	});

	for (const testCase of [
		{ name: "intercom send", toolName: "intercom", args: { action: "send", to: "orchestrator", message: "FYI" } },
		{ name: "contact_supervisor progress_update", toolName: "contact_supervisor", args: { reason: "progress_update", message: "FYI" } },
	]) {
		it(`does not proactively detach foreground children on non-blocking ${testCase.name}`, async () => {
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(testCase.toolName, testCase.args)] },
					{ jsonl: [events.toolEnd(testCase.toolName)] },
					{ jsonl: [events.assistantMessage("done")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: `${testCase.toolName}-nonblocking`,
				allowIntercomDetach: true,
			});

			assert.equal(result.exitCode, 0);
			assert.equal(result.detached, undefined);
			assert.equal(result.finalOutput, "done");
			assert.equal(result.progress?.status, "completed");
		});
	}

	it("lets an active intercom child accept detach when another child is listening", async () => {
		const eventBus = createEventBus();
		let firstDetachResponse: boolean | undefined;
		eventBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
			if (!payload || typeof payload !== "object") return;
			if ((payload as { requestId?: unknown }).requestId !== "parallel-request") return;
			firstDetachResponse ??= (payload as { accepted?: unknown }).accepted === true;
		});
		mockPi.onCall({ delay: 500, output: "quiet child done" });
		const agents = makeAgentConfigs(["quiet", "intercom"]);

		const quietRun = runSync(tempDir, agents, "quiet", "Quiet task", {
			runId: "quiet-listener",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
		});
		for (let attempt = 0; attempt < 50 && mockPi.callCount() < 1; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(mockPi.callCount(), 1);
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("intercom", { action: "send", to: "orchestrator" })] },
				{ delay: 500, jsonl: [events.assistantMessage("after intercom")] },
			],
		});

		let detachEmitted = false;
		const intercomRun = runSync(tempDir, agents, "intercom", "Intercom task", {
			runId: "active-intercom",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				const sawIntercom = Array.isArray(progress) && progress.some((p) => p?.currentTool === "intercom");
				if (!sawIntercom) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "parallel-request" });
			},
		});

		const [quietResult, intercomResult] = await Promise.all([quietRun, intercomRun]);

		assert.equal(quietResult.exitCode, 0);
		assert.equal(quietResult.detached, undefined);
		assert.equal(intercomResult.exitCode, 0);
		assert.equal(intercomResult.detached, true);
		assert.equal(firstDetachResponse, true);
	});

	it("handles stderr without exit code as info (not error)", async () => {
		mockPi.onCall({ output: "Success", stderr: "Warning: something", exitCode: 0 });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
	});

});
