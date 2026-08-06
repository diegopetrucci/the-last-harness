/**
 * Integration tests for async (background) agent execution.
 *
 * Tests the async support utilities: jiti availability check,
 * status file reading/caching.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeAgentConfigs, makeMinimalCtx, removeTempDir, tryImport } from "../support/helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import type { MockPi } from "../support/helpers.ts";
import { deliverInterruptRequest } from "../../src/runs/background/control-channel.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import { reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import { writeNormalizedLifecycleStatus } from "../../src/runs/shared/lifecycle-state.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { writeAtomicJson } from "../../src/shared/atomic-json.ts";
import { getThinkingLevelDropNote } from "../../src/runs/shared/pi-args.ts";

interface AsyncExecutionResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details: { asyncId?: string; timeoutMs?: number; deadlineAt?: number };
}

interface AsyncResultPayload {
	lifecycleArtifactVersion?: number;
	success: boolean;
	state?: string;
	exitCode?: number;
	sessionId?: string;
	mode?: string;
	summary?: string;
	error?: string;
	pause?: { kind?: string };
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; exceededAtTurn?: number };
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	totalTokens?: { input: number; output: number; total: number };
	totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
	results: Array<{
		agent?: string;
		output?: string;
		success?: boolean;
		error?: string;
		interrupted?: boolean;
		sessionFile?: string;
		timedOut?: boolean;
		turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; exceededAtTurn?: number };
		turnBudgetExceeded?: boolean;
		wrapUpRequested?: boolean;
		model?: string;
		attemptedModels?: string[];
		modelAttempts?: Array<{ success?: boolean; error?: string }>;
		modelFallbackNotice?: string;
		totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
		structuredOutput?: unknown;
		intercomTarget?: string;
		activeRuntimeMs?: number;
		artifactPaths?: { metadataPath?: string };
		acceptance?: { status?: string; effectiveAcceptance?: { level?: string }; childReport?: unknown; runtimeChecks?: Array<{ id?: string; status?: string; message?: string }> };
		processCleanup?: {
			attempted?: boolean;
			terminated?: boolean;
			processGroupId?: number;
			liveProcessesDetected?: boolean;
			skippedReason?: string;
		};
	}>;
	outputs?: Record<string, { text?: string; structured?: unknown }>;
	workflowGraph?: { nodes?: Array<{ kind?: string; label?: string; phase?: string; status?: string; acceptanceStatus?: string; error?: string; outputName?: string; structured?: boolean; children?: Array<{ label?: string; outputName?: string; itemKey?: string; status?: string; acceptanceStatus?: string; error?: string }> }> };
}

interface AsyncStatusPayload {
	lifecycleArtifactVersion?: number;
	sessionId?: string;
	activityState?: string;
	currentTool?: string;
	currentPath?: string;
	state?: string;
	error?: string;
	tkTicket?: { id: string; title: string };
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; exceededAtTurn?: number };
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	totalTokens?: { total: number };
	totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
	parallelGroups?: Array<{ start: number; count: number; stepIndex: number }>;
	steps?: Array<{
		label?: string;
		phase?: string;
		outputName?: string;
		structured?: boolean;
		skills?: string[];
		activityState?: string;
		currentTool?: string;
		status?: string;
		exitCode?: number;
		timedOut?: boolean;
		activeRuntimeMs?: number;
		startedAt?: number;
		timeoutMs?: number;
		deadlineAt?: number;
		error?: string;
		model?: string;
		thinking?: string;
		tokens?: { total: number };
		totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
		acceptance?: { status?: string };
		turnBudget?: { maxTurns: number; graceTurns: number; outcome: string; turnCount: number; wrapUpRequestedAtTurn?: number; exceededAtTurn?: number };
		turnBudgetExceeded?: boolean;
		wrapUpRequested?: boolean;
		sessionFile?: string;
		recentOutput?: string[];
	}>;
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

interface AsyncExecutionModule {
	isAsyncAvailable(): boolean;
	executeAsyncSingle(id: string, params: Record<string, unknown>): AsyncExecutionResult;
	executeAsyncChain(id: string, params: Record<string, unknown>): AsyncExecutionResult;
}

interface UtilsModule {
	readStatus(dir: string): { runId: string; state: string; mode: string } | null;
}

interface TypesModule {
	ASYNC_DIR: string;
	RESULTS_DIR: string;
	TEMP_ROOT_DIR: string;
}

interface ExecutorModule {
	createSubagentExecutor: (...args: unknown[]) => {
		execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean; details?: { asyncId?: string } }>;
	};
}

interface ControlChannelModule {
	requestAsyncInterrupt(asyncDir: string, payload?: { ts?: number; source?: string; reason?: string }): string;
}

const asyncMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
const typesMod = await tryImport<TypesModule>("./src/shared/types.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const controlChannelMod = await tryImport<ControlChannelModule>("./src/runs/background/control-channel.ts");

const isAsyncAvailable = asyncMod.isAsyncAvailable;
const executeAsyncSingle = asyncMod.executeAsyncSingle;
const executeAsyncChain = asyncMod.executeAsyncChain;
const readStatus = utils.readStatus;
const ASYNC_DIR = typesMod.ASYNC_DIR;
const RESULTS_DIR = typesMod.RESULTS_DIR;
const TEMP_ROOT_DIR = typesMod.TEMP_ROOT_DIR;
const createSubagentExecutor = executorMod.createSubagentExecutor;
const requestAsyncInterrupt = controlChannelMod.requestAsyncInterrupt;
assert.equal(isAsyncAvailable(), true, "required async runner module is unavailable");

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function createRepo(prefix: string): string {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repoDir, ["init"]);
	git(repoDir, ["config", "user.email", "tests@example.com"]);
	git(repoDir, ["config", "user.name", "Async Tests"]);
	fs.writeFileSync(path.join(repoDir, "input.md"), "input\n", "utf-8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-m", "initial commit"]);
	return repoDir;
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

async function waitForAsyncResultFile(id: string, timeoutMs = scaleTestTimeout(15_000)): Promise<string> {
	const resultPath = path.join(RESULTS_DIR, `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(resultPath)) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return resultPath;
}

async function waitForAsyncState(asyncDir: string, state: string, timeoutMs = scaleTestTimeout(15_000)): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (readStatus(asyncDir)?.state !== state) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async state '${state}' in ${asyncDir}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function waitForAsyncStatusPredicate(asyncDir: string, predicate: (status: AsyncStatusPayload) => boolean, label: string, timeoutMs = scaleTestTimeout(15_000)): Promise<AsyncStatusPayload> {
	const statusPath = path.join(asyncDir, "status.json");
	const deadline = Date.now() + timeoutMs;
	while (true) {
		if (fs.existsSync(statusPath)) {
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			if (predicate(status)) return status;
		}
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async status predicate '${label}' in ${asyncDir}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function waitForAsyncControlCondition(
	asyncDir: string,
	predicate: (status: AsyncStatusPayload, eventText: string) => boolean,
	timeoutMs = scaleTestTimeout(10_000),
): Promise<{ status: AsyncStatusPayload; eventText: string }> {
	const eventsPath = path.join(asyncDir, "events.jsonl");
	const statusPath = path.join(asyncDir, "status.json");
	const resultPath = path.join(RESULTS_DIR, `${path.basename(asyncDir)}.json`);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const eventText = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "";
		if (fs.existsSync(statusPath)) {
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			if (predicate(status, eventText)) return { status, eventText };
		}
		if (fs.existsSync(resultPath)) {
			assert.fail(`run completed before control condition was observed in ${asyncDir}`);
		}
		if (Date.now() > deadline) assert.fail(`Timed out waiting for control condition in ${asyncDir}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function waitForMockPiCall(mockPi: MockPi, index: number, timeoutMs = scaleTestTimeout(30_000)): Promise<{ args: string[]; systemPrompts: NonNullable<MockPiCallRecord["systemPrompts"]> }> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(index);
		if (callFile) {
			const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
			assert.ok(Array.isArray(payload.args), "expected recorded args");
			return { args: payload.args, systemPrompts: payload.systemPrompts ?? [] };
		}
		if (Date.now() > deadline) assert.fail(`Timed out waiting for recorded mock pi call ${index}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function waitForMockPiArgs(mockPi: MockPi, index: number, timeoutMs = scaleTestTimeout(30_000)): Promise<string[]> {
	return (await waitForMockPiCall(mockPi, index, timeoutMs)).args;
}

function readLastMockPiArgs(mockPi: MockPi): string[] {
	const callFile = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(-1);
	assert.ok(callFile, "expected a recorded mock pi call");
	const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
	assert.ok(Array.isArray(payload.args), "expected recorded args");
	return payload.args;
}

function readMockPiArgs(mockPi: MockPi, index: number): string[] {
	const callFile = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(index);
	assert.ok(callFile, `expected recorded call ${index}`);
	const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
	assert.ok(Array.isArray(payload.args), "expected recorded args");
	return payload.args;
}

function readMockPiArgsMatching(mockPi: MockPi, text: string): string[] {
	const callFiles = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort();
	for (const callFile of callFiles) {
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[] };
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		if (payload.args.join("\n").includes(text)) return payload.args;
	}
	assert.fail(`expected recorded call containing ${text}`);
}

function startedMockPiPids(mockPi: MockPi): number[] {
	return fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.map((name) => Number(name.split("-")[2]))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function waitForMockPiSignal(mockPi: MockPi, pid: number, signal: "SIGINT" | "SIGTERM", timeoutMs = scaleTestTimeout(10_000)): Promise<void> {
	const signalLogPath = path.join(mockPi.dir, `signals-${pid}.jsonl`);
	const deadline = Date.now() + timeoutMs;
	while (true) {
		if (fs.existsSync(signalLogPath)) {
			const entries = fs.readFileSync(signalLogPath, "utf-8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { signal?: string });
			if (entries.some((entry) => entry.signal === signal)) return;
		}
		if (Date.now() > deadline) assert.fail(`Timed out waiting for mock pid ${pid} to record ${signal}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function assertPidExited(pid: number | undefined, label: string): void {
	assert.ok(typeof pid === "number" && pid > 0, `expected pid for ${label}`);
	try {
		process.kill(pid, 0);
		assert.fail(`Expected ${label} pid ${pid} to be gone`);
	} catch (error) {
		assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
	}
}

async function waitForPidsToExit(pids: Array<number | undefined>, label: string, timeoutMs = scaleTestTimeout(10_000)): Promise<void> {
	const live = pids.filter((pid): pid is number => typeof pid === "number" && pid > 0);
	const deadline = Date.now() + timeoutMs;
	while (live.some((pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return !(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH");
		}
	})) {
		if (Date.now() > deadline) {
			assert.fail(`Timed out waiting for ${label} to exit: ${live.join(", ")}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function lifecycleLockDir(asyncDir: string): string {
	return path.join(asyncDir, ".lifecycle-transition.lock");
}

function writeLifecycleLock(asyncDir: string): void {
	const lockDir = lifecycleLockDir(asyncDir);
	fs.mkdirSync(lockDir, { recursive: true });
	fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: 999999, acquiredAt: Date.now() }, null, 2), "utf-8");
}

function removeLifecycleLock(asyncDir: string): void {
	fs.rmSync(lifecycleLockDir(asyncDir), { recursive: true, force: true });
}

describe("async execution utilities", () => {
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

	function makeAsyncExecutor(agents = [makeAgent("worker")]) {
		return createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents }),
		});
	}

	async function readAsyncPayload(id: string): Promise<AsyncResultPayload> {
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		return JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
	}

	it("reports the required async runner as available", () => {
		assert.equal(isAsyncAvailable(), true);
	});

	it("spawns the async runner with node when process.execPath is not node", async () => {
		const originalExecPath = process.execPath;
		process.execPath = path.join(tempDir, process.platform === "win32" ? "pi.exe" : "pi");
		try {
			mockPi.onCall({ output: "non-node exec async done" });
			const id = `async-non-node-exec-${Date.now().toString(36)}`;
			const result = executeAsyncSingle(id, {
				agent: "worker",
				task: "Say non-node exec async done. Do not edit files.",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			assert.equal(result.isError, undefined);
			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "non-node exec async done");
		} finally {
			process.execPath = originalExecPath;
		}
	});

	it("falls back to PATH node when node-like process.execPath is stale", async () => {
		const originalExecPath = process.execPath;
		process.execPath = path.join(tempDir, "deleted-node-install", "bin", process.platform === "win32" ? "node.exe" : "node");
		try {
			mockPi.onCall({ output: "stale node exec async done" });
			const id = `async-stale-node-exec-${Date.now().toString(36)}`;
			const result = executeAsyncSingle(id, {
				agent: "worker",
				task: "Say stale node exec async done. Do not edit files.",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			assert.equal(result.isError, undefined);
			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "stale node exec async done");
		} finally {
			process.execPath = originalExecPath;
		}
	});

	it("does not fire or retain an above-Node-boundary async agent ceiling", async () => {
		mockPi.onCall({ output: "agent ceiling async done" });
		const id = `async-agent-ceiling-${Date.now().toString(36)}`;
		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Say agent ceiling async done. Do not edit files.",
			agentConfig: makeAgent("worker", { maxExecutionTimeMs: 2_147_483_648 }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, undefined);
		assert.equal(result.details.timeoutMs, 2_147_483_648);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.timeoutMs, 2_147_483_648);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.timedOut, undefined);
	});

	it("keeps a shorter async caller timeout below the agent ceiling with a coherent deadline", async () => {
		mockPi.onCall({ output: "caller timeout async done" });
		const id = `async-caller-timeout-${Date.now().toString(36)}`;
		const startedAt = Date.now();
		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Say caller timeout async done. Do not edit files.",
			agentConfig: makeAgent("worker", { maxExecutionTimeMs: 2000 }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			timeoutMs: 500,
		});

		assert.equal(result.isError, undefined);
		assert.equal(result.details.timeoutMs, 500);
		assert.ok(result.details.deadlineAt !== undefined);
		assert.ok(result.details.deadlineAt >= startedAt + 500);
		assert.ok(result.details.deadlineAt <= Date.now() + 500);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.timeoutMs, 500);
		assert.equal(payload.deadlineAt, result.details.deadlineAt);
	});

	it("readStatus returns null for missing directory", () => {
		const status = readStatus("/nonexistent/path/abc123");
		assert.equal(status, null);
	});

	it("readStatus parses valid status file", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "test-123",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{ agent: "test", status: "running" }],
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const status = readStatus(dir);
			assert.ok(status, "should parse status");
			assert.equal(status.runId, "test-123");
			assert.equal(status.state, "running");
			assert.equal(status.mode, "single");
		} finally {
			removeTempDir(dir);
		}
	});

	it("background runs mark supervisor reply paths as live for child intercom metadata", async () => {
		mockPi.onCall({ echoEnv: [
			"PI_SUBAGENT_INTERCOM_SESSION_NAME",
			"PI_SUBAGENT_ORCHESTRATOR_TARGET",
			"PI_SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH",
			"PI_SUBAGENT_RUN_ID",
			"PI_SUBAGENT_CHILD_AGENT",
			"PI_SUBAGENT_CHILD_INDEX",
		] });
		const id = `async-supervisor-reply-path-${Date.now().toString(36)}`;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Echo supervisor metadata",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			controlIntercomTarget: "subagent-chat-parent",
			childIntercomTarget: (agent, index) => `subagent-${agent}-${id}-${index + 1}`,
		});
		assert.equal(run.isError, undefined);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.deepEqual(JSON.parse(payload.results[0]?.output ?? "{}"), {
			PI_SUBAGENT_INTERCOM_SESSION_NAME: `subagent-worker-${id}-1`,
			PI_SUBAGENT_ORCHESTRATOR_TARGET: "subagent-chat-parent",
			PI_SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH: "live",
			PI_SUBAGENT_RUN_ID: id,
			PI_SUBAGENT_CHILD_AGENT: "worker",
			PI_SUBAGENT_CHILD_INDEX: "0",
		});
	});

	it("interrupts every active async parallel child", { skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "one done" });
		mockPi.onCall({ delay: 5_000, output: "two done" });
		mockPi.onCall({ delay: 5_000, output: "three done" });
		const id = `async-interrupt-parallel-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{
				parallel: [
					{ agent: "one", task: "Wait", acceptance: { level: "checked", criteria: ["Complete one"] } },
					{ agent: "two", task: "Wait", acceptance: { level: "checked", criteria: ["Complete two"] } },
					{ agent: "three", task: "Wait", acceptance: { level: "checked", criteria: ["Complete three"] } },
				],
				concurrency: 3,
			}],
			resultMode: "parallel",
			agents: [makeAgent("one"), makeAgent("two"), makeAgent("three")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		await waitForMockPiCall(mockPi, 2, 10_000);
		const asyncDir = path.join(ASYNC_DIR, id);
		const statusPath = path.join(asyncDir, "status.json");
		const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & { pid?: number };
		deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

		const resultPath = await waitForAsyncResultFile(id, 30_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		const eventLog = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
		assert.equal(payload.state, "paused");
		assert.equal(payload.success, false);
		assert.deepEqual(payload.results.map((result) => result.acceptance?.status), ["skipped", "skipped", "skipped"]);
		assert.deepEqual(status.steps?.map((step) => step.status), ["paused", "paused", "paused"]);
		assert.deepEqual(status.steps?.map((step) => step.acceptance?.status), ["skipped", "skipped", "skipped"]);
		assert.match(eventLog, /"type":"subagent.step.paused"/);
		assert.doesNotMatch(eventLog, /"type":"subagent.parallel.completed"/);
		assert.equal(mockPi.callCount(), 3);
	});

	it("parallel interrupt: each paused child retains its own discovered session file (F1+F2)", { skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined }, async () => {
		// Opt in to the mock's --session-dir file creation so the runner has a
		// discoverable per-child session file to track. Restored in finally so no
		// other test's token-tracking behavior is perturbed.
		const originalSessionDirFile = process.env.MOCK_PI_SESSION_DIR_FILE;
		process.env.MOCK_PI_SESSION_DIR_FILE = "1";
		try {
			mockPi.onCall({ delay: 5_000, output: "alpha done" });
			mockPi.onCall({ delay: 5_000, output: "beta done" });
			const sessionRoot = path.join(tempDir, "sessions");
			fs.mkdirSync(sessionRoot, { recursive: true });
			const id = `async-interrupt-parallel-session-${Date.now().toString(36)}`;
			executeAsyncChain(id, {
				chain: [{
					parallel: [
						{ agent: "alpha", task: "Wait", acceptance: { level: "checked", criteria: ["Complete alpha"] } },
						{ agent: "beta", task: "Wait", acceptance: { level: "checked", criteria: ["Complete beta"] } },
					],
					concurrency: 2,
				}],
				resultMode: "parallel",
				agents: [makeAgent("alpha"), makeAgent("beta")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-f1f2" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				maxSubagentDepth: 2,
				sessionRoot,
			});

			// Wait for both children to be running before delivering the interrupt.
			await waitForMockPiCall(mockPi, 1, 10_000);
			const asyncDir = path.join(ASYNC_DIR, id);
			const statusPath = path.join(asyncDir, "status.json");
			const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & { pid?: number };
			deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

			const resultPath = await waitForAsyncResultFile(id, 30_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;

			// Both children must be paused with skipped acceptance.
			assert.deepEqual(status.steps?.map((s) => s.status), ["paused", "paused"]);
			assert.deepEqual(status.steps?.map((s) => s.acceptance?.status), ["skipped", "skipped"]);
			assert.equal(payload.state, "paused");

			// F1: each paused child in the status file has its OWN distinct session file.
			const stepSessionFiles = status.steps?.map((s) => s.sessionFile);
			assert.ok(stepSessionFiles?.[0], "paused child 0 must have a session file in status");
			assert.ok(stepSessionFiles?.[1], "paused child 1 must have a session file in status");
			assert.notEqual(stepSessionFiles?.[0], stepSessionFiles?.[1], "each paused child must have its OWN session file, not a shared one");

			// F2: the result artifact also carries each child's discovered session file.
			const resultSessionFiles = payload.results.map((r) => r.sessionFile);
			assert.ok(resultSessionFiles[0], "result artifact child 0 must carry a session file");
			assert.ok(resultSessionFiles[1], "result artifact child 1 must carry a session file");
			assert.notEqual(resultSessionFiles[0], resultSessionFiles[1], "result artifact per-child session files must be distinct");

			// Cross-check: result session files match status session files.
			assert.equal(resultSessionFiles[0], stepSessionFiles?.[0]);
			assert.equal(resultSessionFiles[1], stepSessionFiles?.[1]);
		} finally {
			if (originalSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
			else process.env.MOCK_PI_SESSION_DIR_FILE = originalSessionDirFile;
		}
	});

	it("result-only revival reads session + paused state from result artifact when status dir is absent (F3)", { skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined }, async () => {
		// Opt in to the mock's --session-dir file creation so each paused child has a
		// discoverable session file that reaches the result artifact for revival.
		const originalSessionDirFile = process.env.MOCK_PI_SESSION_DIR_FILE;
		process.env.MOCK_PI_SESSION_DIR_FILE = "1";
		try {
			mockPi.onCall({ delay: 5_000, output: "revival alpha done" });
			mockPi.onCall({ delay: 5_000, output: "revival beta done" });
			const sessionRoot = path.join(tempDir, "sessions-f3");
			fs.mkdirSync(sessionRoot, { recursive: true });
			const id = `async-result-only-revival-${Date.now().toString(36)}`;
			executeAsyncChain(id, {
				chain: [{
					parallel: [
						{ agent: "alpha", task: "Wait", acceptance: { level: "checked", criteria: ["Complete alpha"] } },
						{ agent: "beta", task: "Wait", acceptance: { level: "checked", criteria: ["Complete beta"] } },
					],
					concurrency: 2,
				}],
				resultMode: "parallel",
				agents: [makeAgent("alpha"), makeAgent("beta")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-f3" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				maxSubagentDepth: 2,
				sessionRoot,
			});

			await waitForMockPiCall(mockPi, 1, 10_000);
			const runAsyncDir = path.join(ASYNC_DIR, id);
			const statusPath = path.join(runAsyncDir, "status.json");
			const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & { pid?: number };
			deliverInterruptRequest({ asyncDir: runAsyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

			// Wait for the result artifact (state: "complete" is the persisted string).
			const resultPath = await waitForAsyncResultFile(id, 30_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.state, "paused");

			// Simulate result-only revival: rename the async status directory so
			// resolveAsyncResumeTarget falls through to the result artifact.
			const renamedDir = `${runAsyncDir}-renamed-for-f3-test`;
			fs.renameSync(runAsyncDir, renamedDir);
			try {
				const resumeTarget = resolveAsyncResumeTarget(
					{ id, index: 0 },
					{ asyncDirRoot: ASYNC_DIR, resultsDir: RESULTS_DIR },
				);
				assert.equal(resumeTarget.kind, "revive");
				assert.equal(resumeTarget.state, "paused");
				// F3(a): session context is present from the result artifact.
				assert.ok(resumeTarget.sessionFile, "session file must be present from result artifact");
				// F3(b): paused child correctly identified via interrupted flag.
				// F3(c): continuationAcceptance applied with monotonic-merge contract.
				assert.ok(resumeTarget.continuationAcceptance, "continuationAcceptance must be present from result artifact");
				assert.equal(resumeTarget.continuationAcceptance.level, "checked");
			} finally {
				// Restore the async dir so afterEach cleanup does not leave orphans.
				try { fs.renameSync(renamedDir, runAsyncDir); } catch { /* best effort */ }
			}
		} finally {
			if (originalSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
			else process.env.MOCK_PI_SESSION_DIR_FILE = originalSessionDirFile;
		}
	});

	it("marks interrupted async chain steps as paused with skipped acceptance", { skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "chain done" });
		const id = `async-interrupt-chain-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Wait", acceptance: { level: "checked", criteria: ["Complete chain step"] } }],
			resultMode: "chain",
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		await waitForMockPiCall(mockPi, 0, 10_000);
		const asyncDir = path.join(ASYNC_DIR, id);
		const statusPath = path.join(asyncDir, "status.json");
		const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & { pid?: number };
		deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

		const resultPath = await waitForAsyncResultFile(id, 30_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		const eventLog = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
		assert.equal(payload.state, "paused");
		assert.equal(payload.results[0]?.acceptance?.status, "skipped");
		assert.equal(status.steps?.[0]?.status, "paused");
		assert.equal(status.steps?.[0]?.acceptance?.status, "skipped");
		assert.match(eventLog, /"type":"subagent.step.paused"/);
	});

	it("enforces mixed async child ceilings independently", { skip: process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ matchArgIncludes: "Short async ceiling", delay: 5_000 });
		mockPi.onCall({ matchArgIncludes: "Long async ceiling", output: "long ceiling completed" });
		const id = `async-mixed-ceilings-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{
				parallel: [
					{ agent: "short", task: "Short async ceiling" },
					{ agent: "long", task: "Long async ceiling" },
				],
				concurrency: 2,
			}],
			resultMode: "parallel",
			agents: [makeAgent("short", { maxExecutionTimeMs: 100 }), makeAgent("long", { maxExecutionTimeMs: 2_147_483_648 })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactsDir: path.join(tempDir, "artifacts-mixed-ceilings"),
			artifactConfig: { enabled: true, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: true, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = await readAsyncPayload(id);
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.results[0]?.timedOut, true);
		assert.equal(payload.results[0]?.error, "Subagent timed out after 100ms.");
		assert.equal(payload.results[1]?.timedOut, undefined);
		assert.equal(payload.results[1]?.output, "long ceiling completed");
		assert.equal(status.steps?.[0]?.timeoutMs, 100);
		assert.equal(status.steps?.[1]?.timeoutMs, 2_147_483_648);
		assert.ok((status.steps?.[0]?.activeRuntimeMs ?? 0) >= 100);
		assert.ok((status.steps?.[1]?.activeRuntimeMs ?? 0) > 0);
		assert.equal(status.steps?.[0]?.deadlineAt, status.steps?.[0]?.startedAt! + 100);
		assert.equal(status.steps?.[1]?.deadlineAt, status.steps?.[1]?.startedAt! + 2_147_483_648);
		for (const [index, result] of payload.results.entries()) {
			assert.ok(result.artifactPaths?.metadataPath);
			const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as { timeoutMs?: number; deadlineAt?: number };
			assert.equal(metadata.timeoutMs, status.steps?.[index]?.timeoutMs);
			assert.equal(metadata.deadlineAt, status.steps?.[index]?.deadlineAt);
		}
	});

	it("marks async parallel runs that exceed timeoutMs as timed out", { skip: process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "one done" });
		mockPi.onCall({ delay: 5_000, output: "two done" });
		const id = `async-timeout-parallel-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{
				parallel: [
					{ agent: "one", task: "Wait" },
					{ agent: "two", task: "Wait" },
				],
				concurrency: 2,
			}],
			resultMode: "parallel",
			agents: [makeAgent("one"), makeAgent("two")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
			timeoutMs: 1_500,
		});

		await waitForMockPiCall(mockPi, 1, 10_000);
		const resultPath = await waitForAsyncResultFile(id, 8_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.state, "failed");
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.timeoutMs, 1_500);
		assert.equal(payload.timedOut, true);
		assert.match(payload.summary ?? "", /Subagent timed out after 1500ms\./);
		assert.equal(status.state, "failed");
		assert.equal(status.timeoutMs, 1_500);
		assert.equal(status.timedOut, true);
		assert.match(status.error ?? "", /Subagent timed out after 1500ms\./);
		assert.deepEqual(status.steps?.map((step) => step.status), ["failed", "failed"]);
		assert.deepEqual(status.steps?.map((step) => step.timedOut), [true, true]);
		assert.deepEqual(status.steps?.map((step) => step.error), ["Subagent timed out after 1500ms.", "Subagent timed out after 1500ms."]);
		assert.deepEqual(payload.results.map((result) => result.timedOut), [true, true]);
		assert.equal(mockPi.callCount(), 2);
	});

	it("hard-kills async children that ignore timeout SIGTERM", async () => {
		mockPi.onCall({ delay: 60_000, ignoreSigterm: true, output: "too late" });
		const id = `async-timeout-hard-kill-${Date.now().toString(36)}`;
		const timeoutMs = 1_500;
		const startedAt = Date.now();
		executeAsyncSingle(id, {
			agent: "stubborn",
			task: "Ignore soft termination",
			agentConfig: makeAgent("stubborn", { model: "primary-model", fallbackModels: ["fallback-model"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
			timeoutMs,
		});

		await waitForMockPiCall(mockPi, 0, 10_000);
		const resultPath = await waitForAsyncResultFile(id, 8_000);
		const elapsedMs = Date.now() - startedAt;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.state, "failed");
		assert.equal(payload.timedOut, true);
		assert.equal(payload.results[0]?.timedOut, true);
		assert.equal(payload.results[0]?.error, `Subagent timed out after ${timeoutMs}ms.`);
		assert.equal(status.timedOut, true);
		assert.equal(status.steps?.[0]?.timedOut, true);
		assert.ok(elapsedMs < 7_000, `timeout result should settle after hard kill, elapsed ${elapsedMs}ms`);
		assert.equal(mockPi.callCount(), 1);
	});

	it("cancels async acceptance verification when the run times out", async () => {
		mockPi.onCall({ output: "implementation complete" });
		const id = `async-timeout-acceptance-${Date.now().toString(36)}`;
		const timeoutMs = 1_000;
		const startedAt = Date.now();
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement with verified acceptance",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
			timeoutMs,
			acceptance: {
				level: "verified",
				verify: [{ id: "slow", command: `${process.execPath} -e "setTimeout(()=>process.exit(0), 30000)"`, timeoutMs: 60_000 }],
			},
		});

		const resultPath = await waitForAsyncResultFile(id, 5_000);
		const elapsedMs = Date.now() - startedAt;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.state, "failed");
		assert.equal(payload.timedOut, true);
		assert.equal(payload.results[0]?.timedOut, true);
		assert.equal(payload.results[0]?.acceptance, undefined);
		assert.equal(status.steps?.[0]?.timedOut, true);
		assert.ok(elapsedMs < timeoutMs + 4_000, `timeout should cancel acceptance verification well before the verify command completes, elapsed ${elapsedMs}ms`);
	});

	it("interrupts async acceptance verification and returns a paused result", { skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "implementation complete" });
		const id = `async-interrupt-acceptance-${Date.now().toString(36)}`;
		const startedAt = Date.now();
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement with verified acceptance",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: {
				level: "verified",
				verify: [{ id: "slow", command: `${process.execPath} -e "setTimeout(()=>process.exit(0), 5000)"`, timeoutMs: 10_000 }],
			},
		});

		const asyncDir = path.join(ASYNC_DIR, id);
		const statusPath = path.join(asyncDir, "status.json");
		await waitForMockPiCall(mockPi, 0, 10_000);
		await waitForAsyncState(asyncDir, "running");
		const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & { pid?: number };
		deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

		const resultPath = await waitForAsyncResultFile(id, 8_000);
		await waitForAsyncState(asyncDir, "paused", 8_000);
		const elapsedMs = Date.now() - startedAt;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.state, "paused");
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0]?.error, undefined);
		assert.equal(payload.results[0]?.acceptance?.status, "skipped");
		assert.equal(status.steps?.[0]?.status, "paused");
		assert.equal(status.steps?.[0]?.acceptance?.status, "skipped");
		assert.ok(elapsedMs < 3_000, `interrupt should abort async verification promptly, elapsed ${elapsedMs}ms`);
	});

	it("async turn budget allows a terminal final grace turn", async () => {
		mockPi.onCall({
			jsonl: [
				mockAssistantMessage("working before wrap-up", "tool_use"),
				mockAssistantMessage("final wrapped output", "stop"),
			],
		});
		const id = `async-turn-budget-soft-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Use the final grace turn to wrap up.",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			turnBudget: { maxTurns: 1, graceTurns: 1 },
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.state, "complete");
		assert.equal(payload.turnBudgetExceeded, undefined);
		assert.equal(payload.wrapUpRequested, true);
		assert.equal(payload.turnBudget?.outcome, "wrap-up-requested");
		assert.equal(payload.turnBudget?.turnCount, 2);
		assert.equal(payload.results[0]?.wrapUpRequested, true);
		assert.equal(payload.results[0]?.turnBudget?.turnCount, 2);
		assert.match(payload.results[0]?.output ?? "", /Turn budget wrap-up was requested after 1 assistant turn/);
		assert.match(payload.results[0]?.output ?? "", /final wrapped output/);
		assert.equal(status.wrapUpRequested, true);
		assert.equal(status.turnBudgetExceeded, undefined);
		assert.equal(status.steps?.[0]?.wrapUpRequested, true);
		assert.equal(status.steps?.[0]?.turnBudget?.turnCount, 2);
	});

	it("async turn budget hard-aborts a non-terminal final grace turn", async () => {
		mockPi.onCall({
			jsonl: [
				mockAssistantMessage("working before wrap-up", "tool_use"),
				mockAssistantMessage("still starting more tool work", "tool_use"),
			],
		});
		const id = `async-turn-budget-hard-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Exceed the turn budget.",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			turnBudget: { maxTurns: 1, graceTurns: 1 },
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.turnBudgetExceeded, true);
		assert.equal(payload.wrapUpRequested, true);
		assert.equal(payload.turnBudget?.outcome, "exceeded");
		assert.equal(payload.turnBudget?.turnCount, 2);
		assert.equal(payload.turnBudget?.exceededAtTurn, 2);
		assert.equal(payload.results[0]?.turnBudgetExceeded, true);
		assert.match(payload.results[0]?.output ?? "", /Partial output before turn-budget abort:/);
		assert.match(payload.results[0]?.output ?? "", /still starting more tool work/);
		assert.equal(status.state, "failed");
		assert.equal(status.turnBudgetExceeded, true);
		assert.equal(status.steps?.[0]?.turnBudgetExceeded, true);
		assert.equal(status.steps?.[0]?.turnBudget?.outcome, "exceeded");
	});

	it("async launch messages stay concise one-line receipts", async () => {
		const artifactConfig = {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 7,
		};
		const commonParams = {
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
		};
		mockPi.onCall({ output: "single done" });
		const singleId = `async-handoff-single-${Date.now().toString(36)}`;
		const singleResult = executeAsyncSingle(singleId, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			...commonParams,
		});
		assert.match(singleResult.content[0]?.text ?? "", /^Async: worker \[[^\]\n]+\]$/);
		assert.doesNotMatch(singleResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.equal(singleResult.content[0]?.text?.includes("\n"), false);
		await waitForAsyncResultFile(singleId, 30_000);

		mockPi.onCall({ output: "parallel one done" });
		mockPi.onCall({ output: "parallel two done" });
		const parallelId = `async-handoff-parallel-${Date.now().toString(36)}`;
		const parallelResult = executeAsyncChain(parallelId, {
			chain: [{ parallel: [{ agent: "worker", task: "Do one" }, { agent: "reviewer", task: "Do two" }] }],
			resultMode: "parallel",
			agents: [makeAgent("worker"), makeAgent("reviewer")],
			...commonParams,
		});
		assert.match(parallelResult.content[0]?.text ?? "", /^Async parallel: .+ \[[^\]\n]+\]$/);
		assert.doesNotMatch(parallelResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.equal(parallelResult.content[0]?.text?.includes("\n"), false);
		const parallelResultPath = await waitForAsyncResultFile(parallelId, 10_000);
		const parallelPayload = JSON.parse(fs.readFileSync(parallelResultPath, "utf-8")) as { agent?: string; mode?: string };
		assert.equal(parallelPayload.mode, "parallel");
		assert.equal(parallelPayload.agent, "parallel:worker+reviewer");

		mockPi.onCall({ output: "chain done" });
		const chainId = `async-handoff-chain-${Date.now().toString(36)}`;
		const chainResult = executeAsyncChain(chainId, {
			chain: [{ agent: "worker", task: "Do chained work" }],
			agents: [makeAgent("worker")],
			...commonParams,
		});
		assert.match(chainResult.content[0]?.text ?? "", /^Async chain: .+ \[[^\]\n]+\]$/);
		assert.doesNotMatch(chainResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.equal(chainResult.content[0]?.text?.includes("\n"), false);
		await waitForAsyncResultFile(chainId, 10_000);
	});

	it("applies agent acceptance roles to inferred async acceptance", async () => {
		mockPi.onCall({ output: "writer-role complete" });
		const executor = makeAsyncExecutor([makeAgent("reviewer", { acceptanceRole: "writer" })]);

		const result = await executor.execute(
			"async-agent-acceptance-role",
			{ agent: "reviewer", task: "Handle the authentication flow", async: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const payload = await readAsyncPayload(asyncId);
		assert.equal(payload.results[0]?.acceptance?.effectiveAcceptance?.level, "checked");
	});

	it("applies agent acceptance roles to inferred async parallel acceptance", async () => {
		mockPi.onCall({ output: "parallel exploration complete" });
		const executor = makeAsyncExecutor([makeAgent("worker", { acceptanceRole: "read-only" })]);

		const result = await executor.execute(
			"async-parallel-agent-acceptance-role",
			{ tasks: [{ agent: "worker", task: "Explore the authentication flow" }], async: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const payload = await readAsyncPayload(asyncId);
		assert.equal(payload.results[0]?.acceptance?.effectiveAcceptance?.level, "attested");
	});

	it("infers async chain acceptance after expanding top-level task templates", async () => {
		mockPi.onCall({ output: "patched" });
		mockPi.onCall({ output: "reviewed" });

		const patchId = `async-role-task-template-patch-${Date.now().toString(36)}`;
		executeAsyncChain(patchId, {
			task: "Patch src/auth.ts",
			chain: [{ agent: "explorer", task: "{task}" }],
			agents: [makeAgent("explorer", { acceptanceRole: "read-only" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-role-task-patch" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});
		const patchPayload = await readAsyncPayload(patchId);
		assert.equal(patchPayload.results[0]?.acceptance?.effectiveAcceptance?.level, "checked");

		const reviewId = `async-role-task-template-review-${Date.now().toString(36)}`;
		executeAsyncChain(reviewId, {
			task: "Review only; do not edit files",
			chain: [{ agent: "implementer", task: "{task}" }],
			agents: [makeAgent("implementer", { acceptanceRole: "writer" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-role-task-review" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});
		const reviewPayload = await readAsyncPayload(reviewId);
		assert.equal(reviewPayload.results[0]?.acceptance?.effectiveAcceptance?.level, "attested");
	});

	it("top-level async parallel conversion preserves output, reads, and progress", async () => {
		mockPi.onCall({ output: "Async top-level report" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker", { defaultProgress: true })] }),
		});

		const parentSessionFile = path.join(tempDir, "parent-session", "session.jsonl");
		const ctx = {
			...makeMinimalCtx(tempDir),
			sessionManager: {
				getSessionId: () => "session-123",
				getSessionFile: () => parentSessionFile,
			},
		};
		const result = await executor.execute(
			"async-parallel-fields",
			{
				tasks: [{ agent: "worker", task: "Do async work", output: "async-top-output.md", reads: ["input.md"] }],
				async: true,
			},
			new AbortController().signal,
			undefined,
			ctx,
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
		const statusPath = path.join(ASYNC_DIR, asyncId, "status.json");
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.mode, "parallel");
			assert.equal(payload.sessionId, parentSessionFile);
			assert.equal(payload.results[0]?.acceptance?.status, "checked");
			assert.equal(status.sessionId, parentSessionFile);
			assert.equal(status.steps?.[0]?.acceptance?.status, "checked");
		const outputPath = path.join(tempDir, "parent-session", "subagent-artifacts", "outputs", asyncId, "async-top-output.md");
		const outputDeadline = Date.now() + 5_000;
		while (!fs.existsSync(outputPath)) {
			if (Date.now() > outputDeadline) {
				assert.fail(`Timed out waiting for saved output file: ${outputPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Async top-level report");
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
		const taskArg = args.at(-1) ?? "";
		const progressPath = path.join(tempDir, "parent-session", "subagent-artifacts", "progress", asyncId, "progress.md");
		assert.ok(taskArg.includes(`[Read from: ${path.join(tempDir, "input.md")}]`));
		assert.ok(taskArg.includes(`Update progress at: ${progressPath}`));
		assert.ok(taskArg.includes(`Write your findings to exactly this path: ${outputPath}`));
		assert.equal(fs.existsSync(progressPath), true);
		assert.equal(fs.existsSync(path.join(tempDir, ".pi-subagents", "artifacts")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("async single rejects explicit reviewed acceptance before spawning a child", async () => {
		mockPi.onCall({ output: "should not run" });
		const artifactConfig = {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 7,
		};
		const id = `async-acceptance-${Date.now().toString(36)}`;
		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement acceptance-covered fix",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-acceptance" },
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: { level: "reviewed", criteria: ["Patch bug"], review: false },
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /reviewed/);
		assert.match(result.content[0]?.text ?? "", /verified/);
		assert.match(result.content[0]?.text ?? "", /verify commands/);
		assert.match(result.content[0]?.text ?? "", /checked/);
		assert.equal(mockPi.callCount(), 0);
		assert.equal(fs.existsSync(path.join(ASYNC_DIR, id)), false);
		assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${id}.json`)), false);
	});

	it("top-level async single suppresses progress for review-only tasks", async () => {
		mockPi.onCall({ output: "Async review" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("reviewer", { defaultProgress: true })] }),
		});

		const result = await executor.execute(
			"async-single-read-only-progress",
			{
				agent: "reviewer",
				task: "Review-only. Do not edit files. Return findings.",
				async: true,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
		assert.doesNotMatch(args.at(-1) ?? "", /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("async chains reject malformed named output references before spawning", async () => {
		const id = `async-malformed-output-ref-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [{ agent: "consumer", task: "Use {outputs.bad-name}" }],
			agents: [makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-malformed" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Invalid chain output reference '\{outputs\.bad-name\}'/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("async chains persist structured outputs, named outputs, and graph labels", async () => {
		const schema = {
			type: "object",
			required: ["value"],
			properties: { value: { type: "string" } },
		};
		mockPi.onCall({ structuredOutput: { value: "Alpha structured" } });
		mockPi.onCall({ output: "used named output" });
		const id = `async-structured-chain-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{
					agent: "producer",
					task: "Produce data",
					phase: "Collect",
					label: "Produce structured data",
					as: "data",
					outputSchema: schema,
				},
				{ agent: "consumer", task: "Use {outputs.data}", phase: "Use", label: "Consume data" },
			],
			agents: [makeAgent("producer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-structured" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.deepEqual(payload.results[0]?.structuredOutput, { value: "Alpha structured" });
		assert.deepEqual(payload.outputs?.data?.structured, { value: "Alpha structured" });
		assert.match(readMockPiArgs(mockPi, 1).at(-1) ?? "", /Alpha structured/);
		assert.equal(status.steps?.[0]?.label, "Produce structured data");
		assert.equal(status.steps?.[0]?.phase, "Collect");
		assert.equal(status.steps?.[0]?.outputName, "data");
		assert.equal(status.steps?.[0]?.structured, true);
		assert.equal(payload.workflowGraph?.nodes?.[0]?.label, "Produce structured data");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.outputName, "data");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "completed");
	});

	it("async chains can start parallel, funnel into one step, then fan back out", async () => {
		mockPi.onCall({ matchArgIncludes: "Scout API", output: "Scout A async findings" });
		mockPi.onCall({ matchArgIncludes: "Scout UI", output: "Scout B async findings" });
		mockPi.onCall({ matchArgIncludes: "Synthesize:", output: "Async funnel synthesis" });
		mockPi.onCall({ matchArgIncludes: "Review funnel A:", output: "Async reviewer A done" });
		mockPi.onCall({ matchArgIncludes: "Review funnel B:", output: "Async reviewer B done" });
		const id = `async-parallel-funnel-fanout-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{
					parallel: [
						{ agent: "scout-a", task: "Scout API" },
						{ agent: "scout-b", task: "Scout UI" },
					],
					concurrency: 2,
				},
				{ agent: "synthesizer", task: "Synthesize:\n{previous}" },
				{
					parallel: [
						{ agent: "review-a", task: "Review funnel A:\n{previous}" },
						{ agent: "review-b", task: "Review funnel B:\n{previous}" },
					],
					concurrency: 2,
				},
			],
			agents: [makeAgent("scout-a"), makeAgent("scout-b"), makeAgent("synthesizer"), makeAgent("review-a"), makeAgent("review-b")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-parallel-funnel-fanout" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError, `should launch: ${JSON.stringify(result.content)}`);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results.map((entry) => entry.output), [
			"Scout A async findings",
			"Scout B async findings",
			"Async funnel synthesis",
			"Async reviewer A done",
			"Async reviewer B done",
		]);
		assert.deepEqual(status.steps?.map((step) => step.status), ["complete", "complete", "complete", "complete", "complete"]);
		assert.deepEqual(status.parallelGroups, [
			{ start: 0, count: 2, stepIndex: 0 },
			{ start: 3, count: 2, stepIndex: 2 },
		]);
		const funnelTask = readMockPiArgsMatching(mockPi, "Synthesize:").at(-1) ?? "";
		assert.match(funnelTask, /=== Parallel Task 1 \(scout-a\) ===/);
		assert.match(funnelTask, /Scout A async findings/);
		assert.match(funnelTask, /=== Parallel Task 2 \(scout-b\) ===/);
		assert.match(funnelTask, /Scout B async findings/);
		assert.match(readMockPiArgsMatching(mockPi, "Review funnel A:").at(-1) ?? "", /Review funnel A:\nAsync funnel synthesis/);
		assert.match(readMockPiArgsMatching(mockPi, "Review funnel B:").at(-1) ?? "", /Review funnel B:\nAsync funnel synthesis/);
		assert.equal(payload.workflowGraph?.nodes?.[0]?.kind, "parallel-group");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.kind, "step");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[2]?.kind, "parallel-group");
		assert.equal(payload.workflowGraph?.nodes?.[2]?.status, "completed");
	});

	it("async dynamic status shows a placeholder before materialization", async () => {
		mockPi.onCall({ delay: 800, output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "used reviews" });
		const id = `async-dynamic-placeholder-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", label: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-placeholder" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const statusPath = path.join(ASYNC_DIR, id, "status.json");
		const deadline = Date.now() + 5_000;
		let status: AsyncStatusPayload | undefined;
		while (!status) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async status file: ${statusPath}`);
			if (fs.existsSync(statusPath)) status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			else await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.deepEqual(status.steps?.map((step) => step.agent), ["producer", "expand:reviewer", "consumer"]);
		assert.equal(status.steps?.[1]?.label, "Review {target.path}");
		assert.equal(status.steps?.[1]?.outputName, "reviews");
		assert.deepEqual(status.parallelGroups, [{ start: 1, count: 1, stepIndex: 1 }]);

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const finalStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.deepEqual(finalStatus.steps?.map((step) => step.agent), ["producer", "reviewer", "reviewer", "consumer"]);
		assert.deepEqual(finalStatus.parallelGroups, [{ start: 1, count: 2, stepIndex: 1 }]);
	});

	it("async chains expand dynamic fanout and persist collected output", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "used reviews" });
		const id = `async-dynamic-chain-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: {
						agent: "reviewer",
						task: "Review {target.path}",
						label: "Review {target.path}",
						outputSchema: { type: "object" },
				},
				collect: { as: "reviews" },
				concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.success, true);
		assert.equal(mockPi.callCount(), 4);
		assert.match(readMockPiArgs(mockPi, 1).at(-1) ?? "", /Review src\/a\.ts/);
		assert.match(readMockPiArgs(mockPi, 2).at(-1) ?? "", /Review src\/b\.ts/);
		assert.match(readMockPiArgs(mockPi, 3).at(-1) ?? "", /"key":"src\/a\.ts"/);
		const collected = payload.outputs?.reviews?.structured as Array<{ key: string; structured: unknown }>;
		assert.deepEqual(collected.map((item) => item.key), ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(collected.map((item) => item.structured), [{ ok: "a" }, { ok: "b" }]);
		assert.equal(status.steps?.length, 4);
		assert.deepEqual(status.parallelGroups, [{ start: 1, count: 2, stepIndex: 1 }]);
		assert.equal(payload.workflowGraph?.nodes?.[1]?.kind, "dynamic-parallel-group");
		assert.deepEqual(payload.workflowGraph?.nodes?.[1]?.children?.map((child) => child.itemKey), ["src/a.ts", "src/b.ts"]);
		assert.equal(payload.workflowGraph?.nodes?.[2]?.flatIndex, 3);
	});

	it("materializes and enforces an agent ceiling for each async dynamic child", { skip: process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ matchArgIncludes: "Review src/a.ts", delay: 5_000 });
		const id = `async-dynamic-ceiling-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", maxItems: 1 },
					parallel: { agent: "reviewer", task: "Review {target.path}" },
					collect: { as: "reviews" },
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer", { maxExecutionTimeMs: 100 })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-ceiling" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError, result.content?.[0]?.text);
		const payload = await readAsyncPayload(id);
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(mockPi.callCount(), 2);
		assert.equal(payload.results[1]?.timedOut, true);
		assert.equal(payload.results[1]?.error, "Subagent timed out after 100ms.");
		assert.equal(status.steps?.[1]?.timeoutMs, 100);
		assert.equal(status.steps?.[1]?.deadlineAt, status.steps?.[1]?.startedAt! + 100);
	});

	it("keeps dynamic file-only output instructions singular through materialization", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "review-a" });
		const id = `async-dynamic-file-only-${Date.now().toString(36)}`;
		const outputPath = path.join(tempDir, "dynamic-review.md");
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", maxItems: 1 },
					parallel: {
						agent: "reviewer",
						task: "Review {target.path}",
						output: outputPath,
						outputMode: "file-only",
					},
					collect: { as: "reviews" },
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-file-only" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		await waitForAsyncResultFile(id, 10_000);
		const call = await waitForMockPiCall(mockPi, 1);
		const instruction = `Write your findings to exactly this path: ${outputPath}`;
		const taskArg = call.args.at(-1) ?? "";
		const systemPrompt = call.systemPrompts.map((prompt) => prompt.text ?? "").join("\n");
		assert.equal(taskArg.split(instruction).length - 1, 1);
		assert.equal(systemPrompt.split(instruction).length - 1, 1);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "review-a");
	});

	it("async dynamic fanout applies fork session files and thinking overrides to materialized children", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		const id = `async-dynamic-fork-thinking-${Date.now().toString(36)}`;
		const sessionA = path.join(tempDir, "dynamic-a.jsonl");
		const sessionB = path.join(tempDir, "dynamic-b.jsonl");
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 2 },
					parallel: {
						agent: "reviewer",
						task: "Review {target.path}",
						label: "Review {target.path}",
						outputSchema: { type: "object" },
					},
					collect: { as: "reviews" },
					concurrency: 1,
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer", { model: "anthropic/claude-sonnet-4-5:high", thinking: "high" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionFilesByFlatIndex: [undefined, sessionA, sessionB],
			thinkingOverridesByFlatIndex: [undefined, "off", "off"],
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		const firstDynamicArgs = readMockPiArgs(mockPi, 1);
		const secondDynamicArgs = readMockPiArgs(mockPi, 2);
		assert.equal(payload.success, true);
		assert.equal(firstDynamicArgs[firstDynamicArgs.indexOf("--session") + 1], sessionA);
		assert.equal(secondDynamicArgs[secondDynamicArgs.indexOf("--session") + 1], sessionB);
		assert.equal(firstDynamicArgs[firstDynamicArgs.indexOf("--model") + 1], "anthropic/claude-sonnet-4-5:off");
		assert.equal(secondDynamicArgs[secondDynamicArgs.indexOf("--model") + 1], "anthropic/claude-sonnet-4-5:off");
		assert.deepEqual(status.steps?.slice(1).map((step) => step.sessionFile), [sessionA, sessionB]);
		assert.deepEqual(status.steps?.slice(1).map((step) => step.thinking), ["off", "off"]);
	});

	it("applies read-only acceptance roles to async dynamic children and their aggregate group", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		const readOnlyReport = [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "inspection complete" }],
				changedFiles: [],
				testsAddedOrUpdated: [],
				commandsRun: [],
				validationOutput: [],
				reviewFindings: ["No blocking findings"],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		mockPi.onCall({ output: readOnlyReport, structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: readOnlyReport, structuredOutput: { ok: "b" } });
		const id = `async-dynamic-acceptance-role-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 2 },
					parallel: { agent: "explorer", task: "Explore {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
			],
			agents: [makeAgent("producer"), makeAgent("explorer", { acceptanceRole: "read-only" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-role" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const payload = await readAsyncPayload(id);
		const explorerResults = payload.results.filter((child) => child.agent === "explorer");
		assert.deepEqual(explorerResults.map((child) => child.acceptance?.effectiveAcceptance?.level), ["attested", "attested"]);
		const dynamicNode = payload.workflowGraph?.nodes?.[1];
		assert.equal(dynamicNode?.acceptanceStatus, "attested");
		assert.deepEqual(dynamicNode?.children?.map((child) => child.acceptanceStatus), ["attested", "attested"]);
	});

	it("infers async dynamic acceptance after materializing item templates", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		const writerReport = [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patch complete" }],
				changedFiles: ["src/a.ts"],
				testsAddedOrUpdated: ["test/a.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["tests passed"],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		mockPi.onCall({ output: writerReport, structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: writerReport, structuredOutput: { ok: "b" } });
		const id = `async-dynamic-role-item-template-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 2 },
					parallel: { agent: "explorer", task: "Patch {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
			],
			agents: [makeAgent("producer"), makeAgent("explorer", { acceptanceRole: "read-only" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-role-item" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = await readAsyncPayload(id);
		const explorerResults = payload.results.filter((child) => child.agent === "explorer");
		assert.deepEqual(explorerResults.map((child) => child.acceptance?.effectiveAcceptance?.level), ["checked", "checked"]);
		const dynamicNode = payload.workflowGraph?.nodes?.[1];
		assert.equal(payload.success, true);
		assert.equal(dynamicNode?.acceptanceStatus, "checked");
		assert.deepEqual(dynamicNode?.children?.map((child) => child.acceptanceStatus), ["checked", "checked"]);
	});

	it("keeps async dynamic risk context when explicit acceptance is spelled auto or empty", async () => {
		const report = [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "explored" }],
				changedFiles: ["src/a.ts"],
				testsAddedOrUpdated: [],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["tests passed"],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		for (const [suffix, acceptance] of [["auto", "auto"], ["empty", {}]] as const) {
			mockPi.reset();
			mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
			mockPi.onCall({ output: report, structuredOutput: { ok: "a" } });
			mockPi.onCall({ output: report, structuredOutput: { ok: "b" } });
			const id = `async-dynamic-auto-spelling-${suffix}-${Date.now().toString(36)}`;
			executeAsyncChain(id, {
				chain: [
					{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 2 },
						parallel: { agent: "explorer", task: "Explore {target.path}", outputSchema: { type: "object" }, acceptance },
						collect: { as: "reviews" },
						concurrency: 1,
					},
				],
				agents: [makeAgent("producer"), makeAgent("explorer")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: `session-dynamic-auto-${suffix}` },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				maxSubagentDepth: 2,
			});

			const payload = await readAsyncPayload(id);
			const explorerResults = payload.results.filter((child) => child.agent === "explorer");
			// Explicit auto/{} spellings must not clear the dynamic fanout risk context.
			assert.deepEqual(explorerResults.map((child) => child.acceptance?.effectiveAcceptance?.level), ["checked", "checked"], suffix);
		}
	});

	it("cancels dynamic fanout aggregate acceptance when the run times out", { skip: process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		const id = `async-dynamic-acceptance-timeout-${Date.now().toString(36)}`;
		const startedAt = Date.now();
		executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" }, acceptance: { level: "checked" } },
					collect: { as: "reviews" },
					acceptance: {
						level: "verified",
						verify: [{ id: "slow", command: `${process.execPath} -e "setTimeout(()=>process.exit(0), 5000)"`, timeoutMs: 10_000 }],
					},
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-acceptance-timeout" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			timeoutMs: 1_000,
		});

		const resultPath = await waitForAsyncResultFile(id, 5_000);
		const elapsedMs = Date.now() - startedAt;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		const dynamicNode = payload.workflowGraph?.nodes?.[1] as { status?: string; error?: string; acceptanceStatus?: string } | undefined;
		assert.equal(payload.state, "failed");
		assert.equal(payload.timedOut, true);
		assert.equal(payload.results.at(-1)?.timedOut, true);
		assert.equal(payload.results.at(-1)?.acceptance, undefined);
		assert.equal(dynamicNode?.status, "failed");
		assert.match(dynamicNode?.error ?? "", /Subagent timed out after 1000ms\./);
		assert.notEqual(dynamicNode?.acceptanceStatus, "verified");
		assert.equal(status.timedOut, true);
		assert.ok(elapsedMs < 3_000, `timeout should cancel dynamic aggregate acceptance promptly, elapsed ${elapsedMs}ms`);
	});

	it("paused sequential resumes keep the later child session instead of a pre-launch sibling session", { skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 500, output: "first done" });
		mockPi.onCall({ delay: 5_000, output: "second done" });
		const id = `async-paused-sequential-session-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "session-root-sequential");
		executeAsyncChain(id, {
			chain: [
				{ agent: "worker", task: "First step" },
				{ agent: "worker", task: "Second step" },
			],
			resultMode: "chain",
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-sequential" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const asyncDir = path.join(ASYNC_DIR, id);
		const statusPath = path.join(asyncDir, "status.json");
		const sessionDir = path.join(sessionRoot, `async-${id}`);
		const firstSessionFile = path.join(sessionDir, "first.jsonl");
		const secondSessionFile = path.join(sessionDir, "second.jsonl");

		await waitForAsyncControlCondition(asyncDir, (status) => status.steps?.[0]?.status === "running", 10_000);
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(firstSessionFile, "", "utf-8");
		await waitForAsyncControlCondition(asyncDir, (status) => status.steps?.[0]?.status === "complete" && status.steps?.[1]?.status === "running", 10_000);
		fs.writeFileSync(secondSessionFile, "", "utf-8");

		const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & { pid?: number };
		deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

		const { status } = await waitForAsyncControlCondition(asyncDir, (current) => current.state === "paused" && current.steps?.[1]?.status === "paused", 10_000);
		assert.equal(status.steps?.[0]?.sessionFile, path.resolve(firstSessionFile));
		assert.equal(status.steps?.[1]?.sessionFile, path.resolve(secondSessionFile));
		const target = resolveAsyncResumeTarget({ id, index: 1 }, { asyncDirRoot: ASYNC_DIR, resultsDir: RESULTS_DIR });
		assert.equal(target.kind, "revive");
		assert.equal(target.sessionFile, path.resolve(secondSessionFile));
	});

	it("paused dynamic resumes keep the materialized child session after expansion", { skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ delay: 500, output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ delay: 5_000, output: "review-b", structuredOutput: { ok: "b" } });
		const id = `async-paused-dynamic-session-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "session-root-dynamic");
		executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 2 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
			],
			resultMode: "chain",
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const asyncDir = path.join(ASYNC_DIR, id);
		const statusPath = path.join(asyncDir, "status.json");
		const sessionDir = path.join(sessionRoot, `async-${id}`);
		const firstDynamicSessionFile = path.join(sessionDir, "dynamic-1-0", "review-a.jsonl");
		const secondDynamicSessionFile = path.join(sessionDir, "dynamic-1-1", "review-b.jsonl");

		await waitForAsyncControlCondition(asyncDir, (status) => status.steps?.[1]?.status === "running", 10_000);
		fs.mkdirSync(path.dirname(firstDynamicSessionFile), { recursive: true });
		fs.writeFileSync(firstDynamicSessionFile, "", "utf-8");
		await waitForAsyncControlCondition(asyncDir, (status) => status.steps?.[1]?.status === "complete" && status.steps?.[2]?.status === "running", 10_000);
		fs.mkdirSync(path.dirname(secondDynamicSessionFile), { recursive: true });
		fs.writeFileSync(secondDynamicSessionFile, "", "utf-8");

		const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & { pid?: number };
		deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

		const { status } = await waitForAsyncControlCondition(asyncDir, (current) => current.state === "paused" && current.steps?.[2]?.status === "paused", 10_000);
		assert.equal(status.steps?.[1]?.sessionFile, path.resolve(firstDynamicSessionFile));
		assert.equal(status.steps?.[2]?.sessionFile, path.resolve(secondDynamicSessionFile));
		const target = resolveAsyncResumeTarget({ id, index: 2 }, { asyncDirRoot: ASYNC_DIR, resultsDir: RESULTS_DIR });
		assert.equal(target.kind, "revive");
		assert.equal(target.sessionFile, path.resolve(secondDynamicSessionFile));
	});

	it("interrupts dynamic aggregate acceptance without emitting a completed event or synthetic rejected result", { skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		const id = `async-dynamic-acceptance-interrupt-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" }, acceptance: { level: "checked" } },
					collect: { as: "reviews" },
					acceptance: {
						level: "verified",
						verify: [{ id: "slow", command: `${process.execPath} -e "setTimeout(()=>process.exit(0), 5000)"`, timeoutMs: 10_000 }],
					},
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-acceptance-interrupt" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const asyncDir = path.join(ASYNC_DIR, id);
		const statusPath = path.join(asyncDir, "status.json");
		await waitForMockPiCall(mockPi, 1, 10_000);
		await waitForAsyncState(asyncDir, "running");
		const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & { pid?: number };
		deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

		const resultPath = await waitForAsyncResultFile(id, 8_000);
		await waitForAsyncState(asyncDir, "paused", 8_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		const eventLog = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
		const dynamicNode = payload.workflowGraph?.nodes?.[1] as { status?: string; acceptanceStatus?: string } | undefined;
		assert.equal(payload.state, "paused");
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results.filter((result) => result.error && /Acceptance verification 'slow' timed-out/.test(result.error)).length, 0);
		assert.equal(dynamicNode?.status, "paused");
		assert.equal(dynamicNode?.acceptanceStatus, "skipped");
		assert.equal(status.state, "paused");
		assert.doesNotMatch(eventLog, /"type":"subagent.dynamic.completed"/);
		assert.equal(status.error, undefined);
		assert.equal(payload.results.length, 2);
		assert.ok(payload.results.every((result) => result.acceptance?.status !== "rejected"));
	});

	it("async dynamic fanout recomputes later child intercom targets by final flat index", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_INTERCOM_SESSION_NAME"] });
		const id = `async-dynamic-targets-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-targets" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			controlIntercomTarget: "subagent-orchestrator-test",
			childIntercomTarget: (agent: string, index: number) => `subagent-${agent}-${id}-${index + 1}`,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const expectedConsumerTarget = `subagent-consumer-${id}-4`;
		assert.equal(payload.success, true);
		assert.equal(payload.results[3]?.intercomTarget, expectedConsumerTarget);
		assert.deepEqual(JSON.parse(payload.results[3]?.output ?? "{}"), { PI_SUBAGENT_INTERCOM_SESSION_NAME: expectedConsumerTarget });
	});

	it("async dynamic pre-spawn failures persist failed graph status and error", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		const id = `async-dynamic-prespawn-fail-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 1 },
					parallel: { agent: "reviewer", task: "Review {target.path}" },
					collect: { as: "reviews" },
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-fail" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload & { workflowGraph?: AsyncResultPayload["workflowGraph"]; error?: string };
		assert.equal(payload.success, false);
		assert.match(payload.results.at(-1)?.error ?? "", /exceeding maxItems 1/);
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "failed");
		assert.match(payload.workflowGraph?.nodes?.[1]?.error ?? "", /exceeding maxItems 1/);
		assert.equal(status.state, "failed");
		assert.match(status.error ?? "", /exceeding maxItems 1/);
		assert.equal(status.workflowGraph?.nodes?.[1]?.status, "failed");
	});

	it("async dynamic collect schema failures persist failed graph status and details", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		const id = `async-dynamic-collect-fail-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews", outputSchema: { type: "object" } },
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-collect-fail" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results.at(-1)?.error ?? "", /Collected output validation failed/);
		assert.ok(Array.isArray(payload.results.at(-1)?.structuredOutput), "failed collect result should preserve ordered collection details");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "failed");
		assert.match(payload.workflowGraph?.nodes?.[1]?.error ?? "", /Collected output validation failed/);
	});

	it("top-level async worktree parallel resolves reads against the worktree and output under the parent session artifacts", { skip: process.platform === "win32" ? "worktree path separators unreliable on Windows CI" : undefined }, async () => {
		const repoDir = createRepo("pi-subagent-async-worktree-");
		try {
			mockPi.onCall({ output: "Worktree report" });
			const executor = createSubagentExecutor!({
				pi: { events: createEventBus(), getSessionName: () => undefined },
				state: { baseCwd: repoDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
				config: {},
				asyncByDefault: false,
				tempArtifactsDir: repoDir,
				getSubagentSessionRoot: () => repoDir,
				expandTilde: (p: string) => p,
				discoverAgents: () => ({ agents: [makeAgent("worker")] }),
			});

			const parentSessionFile = path.join(repoDir, "parent-session", "session.jsonl");
			const ctx = {
				...makeMinimalCtx(repoDir),
				sessionManager: {
					getSessionId: () => "session-123",
					getSessionFile: () => parentSessionFile,
				},
			};
			const result = await executor.execute(
				"async-parallel-worktree-fields",
				{
					tasks: [{ agent: "worker", task: "Do worktree work", output: "report.md", reads: ["input.md"] }],
					async: true,
					worktree: true,
				},
				new AbortController().signal,
				undefined,
				ctx,
			);

			const asyncId = result.details?.asyncId;
			assert.ok(asyncId, "expected asyncId");

			const worktreeCwd = path.join(os.tmpdir(), `pi-worktree-${asyncId}-s0-0`);
			const args = await waitForMockPiArgs(mockPi, 0);
			const taskArg = args.at(-1) ?? "";
			const expectedOutputPath = path.join(repoDir, "parent-session", "subagent-artifacts", "outputs", asyncId, "report.md");
			assert.ok(taskArg.includes(`[Read from: ${path.join(worktreeCwd, "input.md")}]`));
			assert.ok(taskArg.includes(`Write your findings to exactly this path: ${expectedOutputPath}`));
			await waitForAsyncResultFile(asyncId, 90_000);
			assert.equal(fs.existsSync(path.join(repoDir, ".pi-subagents", "artifacts")), false);
		} finally {
			removeTempDir(repoDir);
		}
	});

	it("readStatus caches unchanged files and invalidates same-mtime replacements", () => {
		const dir = createTempDir();
		try {
			const statusPath = path.join(dir, "status.json");
			const fixedTimestamp = new Date(1_700_000_000_000);
			const statusData = {
				runId: "cache-test",
				state: "running",
				mode: "single",
				startedAt: fixedTimestamp.getTime(),
			};
			fs.writeFileSync(statusPath, JSON.stringify(statusData));
			fs.utimesSync(statusPath, fixedTimestamp, fixedTimestamp);

			const cached = readStatus(dir);
			assert.ok(cached);
			assert.strictEqual(readStatus(dir), cached);

			writeAtomicJson(statusPath, { ...statusData, state: "stopped" });
			fs.utimesSync(statusPath, fixedTimestamp, fixedTimestamp);
			assert.equal(fs.statSync(statusPath).mtimeMs, fixedTimestamp.getTime());
			const replaced = readStatus(dir);
			assert.ok(replaced);
			assert.equal(replaced.state, "stopped");
			assert.notStrictEqual(replaced, cached);
		} finally {
			removeTempDir(dir);
		}
	});

	it("readStatus throws for malformed status files", () => {
		const dir = createTempDir();
		try {
			fs.writeFileSync(path.join(dir, "status.json"), "{bad-json", "utf-8");
			assert.throws(() => readStatus(dir), /Failed to parse async status file/);
		} finally {
			removeTempDir(dir);
		}
	});

	it("background runs record fallback attempts and final model", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered asynchronously" });
		const id = `async-fallback-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);

		const started = Date.now();
		while (!fs.existsSync(resultPath)) {
			if (Date.now() - started > 15000) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.lifecycleArtifactVersion, 1);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "anthropic/claude-sonnet-4:low");
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high", "anthropic/claude-sonnet-4:low"]);
		assert.equal(payload.results[0].modelAttempts.length, 2);
		assert.deepEqual(payload.results[0].totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		assert.deepEqual(payload.totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.lifecycleArtifactVersion, 1);
		assert.equal(statusPayload.steps[0]?.model, "anthropic/claude-sonnet-4:low");
		assert.equal(statusPayload.steps[0]?.thinking, "low");
		assert.ok(statusPayload.totalTokens!.total > 0);
		assert.ok(statusPayload.steps[0]?.tokens!.total > 0);
		assert.deepEqual(statusPayload.steps[0]?.totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		assert.deepEqual(statusPayload.totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(events.find((event) => event.type === "subagent.run.started")?.lifecycleArtifactVersion, 1);
		const completed = events.find((event) => event.type === "subagent.run.completed");
		assert.equal(completed?.lifecycleArtifactVersion, 1);
		assert.deepEqual(completed?.totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		assert.match(fs.readFileSync(path.join(asyncDir, "output-0.log"), "utf-8"), /Recovered asynchronously/);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runs surface a dropped thinking level once without changing the model arg", async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const id = `async-thinking-drop-${Date.now().toString(36)}`;
		const availableModels = [{
			provider: "openai",
			id: "gpt-5",
			fullId: "openai/gpt-5",
			reasoning: true,
			thinkingLevelMap: { max: null },
		}];
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5", thinking: "max" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const statusPayload = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		const note = getThinkingLevelDropNote("openai/gpt-5", "max", false, { availableModels });
		assert.ok(note);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, "openai/gpt-5");
		assert.equal(payload.results[0]?.output?.split(note).length - 1, 1);
		assert.equal(statusPayload.steps?.[0]?.recentOutput?.filter((line) => line === note).length, 1);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5");
	});

	it("background runs preserve a max thinking suffix when capability metadata is missing", async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const id = `async-thinking-metadata-missing-${Date.now().toString(36)}`;
		const model = "anthropic/claude-sonnet-4-5";
		const availableModels = [{
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			fullId: model,
			reasoning: true,
		}];
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model, thinking: "max" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const payload = JSON.parse(fs.readFileSync((await waitForAsyncResultFile(id)), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, `${model}:max`);
		assert.equal(getThinkingLevelDropNote(model, "max", false, { availableModels }), undefined);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], `${model}:max`);
	});

	it("background runs try per-dispatch fallback models before agent fallback models and only persist notices after a retry", async () => {
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
		});
		mockPi.onCall({ output: "Recovered asynchronously on dispatch fallback" });
		const id = `async-dispatch-fallback-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini",
				fallbackModels: ["google/gemini-2.5-pro"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			fallbackModels: ["anthropic/claude-sonnet-4"],
			modelFallbackNotice: "Dispatch fallback engaged",
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const started = Date.now();
		while (!fs.existsSync(resultPath)) {
			if (Date.now() - started > 15000) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(payload.results[0].modelFallbackNotice, "Dispatch fallback engaged");
		assert.match(payload.results[0].output ?? "", /^\[fallback\]/);
		assert.match(payload.results[0].output ?? "", /Notice: Dispatch fallback engaged/);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background single thinking override replaces primary and fallback suffixes", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered asynchronously" });
		const id = `async-fallback-thinking-off-${Date.now().toString(36)}`;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
				thinking: "high",
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			thinkingOverride: "off",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const firstArgs = readMockPiArgs(mockPi, 0);
		const secondArgs = readMockPiArgs(mockPi, 1);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "anthropic/claude-sonnet-4:off");
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:off", "anthropic/claude-sonnet-4:off"]);
		assert.equal(firstArgs[firstArgs.indexOf("--model") + 1], "openai/gpt-5-mini:off");
		assert.equal(secondArgs[secondArgs.indexOf("--model") + 1], "anthropic/claude-sonnet-4:off");
	});

	it("background runs retry fallback models when a zero-exit attempt has empty output", async () => {
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
		mockPi.onCall({ output: "Recovered asynchronously from empty output" });
		const id = `async-empty-output-fallback-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini",
				fallbackModels: ["anthropic/claude-sonnet-4"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, "anthropic/claude-sonnet-4");
		assert.match(payload.results[0]?.output ?? "", /Recovered asynchronously from empty output/);
		assert.match(payload.results[0]?.modelAttempts?.[0]?.error ?? "", /no output/i);
		assert.deepEqual(payload.results[0]?.modelAttempts?.map((attempt) => attempt.success), [false, true]);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runs fail zero-exit provider errors when no fallback succeeds", async () => {
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
		const id = `async-zero-exit-provider-error-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results[0]?.error ?? "", /429 quota exceeded/);
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.state, "failed");
		assert.match(statusPayload.steps?.[0]?.error ?? "", /429 quota exceeded/);
	});

	it("background runs treat recovered child errors as successful", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolResult("read", "EISDIR: illegal operation on a directory", true),
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
				events.assistantMessage("Recovered asynchronously"),
			],
		});
		const id = `async-recovered-child-error-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.state, "complete");
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0]?.success, true);
		assert.equal(payload.results[0]?.error, undefined);
		assert.equal(payload.results[0]?.output, "Recovered asynchronously");
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.state, "complete");
		assert.equal(statusPayload.steps?.[0]?.status, "complete");
		assert.equal(statusPayload.steps?.[0]?.exitCode, 0);
	});

	it("background runs keep provider errors failed when followed only by empty assistant output", async () => {
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
		const id = `async-provider-error-empty-stop-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0]?.success, false);
		assert.match(payload.results[0]?.error ?? "", /provider transport failed/);
		assert.equal(payload.results[0]?.output, "");
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.state, "failed");
		assert.equal(statusPayload.steps?.[0]?.status, "failed");
		assert.equal(statusPayload.steps?.[0]?.exitCode, 1);
	});

	it("background file-only runs write full output but return only a file reference", async () => {
		mockPi.onCall({ output: "async full output\nwith details" });
		const id = `async-file-only-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const outputPath = path.join(tempDir, "async-file-only.md");
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			outputMode: "file-only",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.match(payload.summary ?? "", /Output saved to:/);
		assert.match(payload.summary ?? "", /2 lines/);
		assert.doesNotMatch(payload.summary ?? "", /async full output/);
		assert.match(payload.results[0]?.output ?? "", /Output saved to:/);
		assert.doesNotMatch(payload.results[0]?.output ?? "", /async full output/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "async full output\nwith details");
	});

	it("background single runs route relative outputs to outputBaseDir", async () => {
		mockPi.onCall({ output: "async configured report" });
		const id = `async-configured-output-base-${Date.now().toString(36)}`;
		const outputBaseDir = path.join(tempDir, "async-configured-outputs");
		const run = executeAsyncSingle(id, {
			agent: "researcher",
			task: "Write report",
			agentConfig: makeAgent("researcher", { output: "context.md" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: "context.md",
			outputBaseDir,
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const outputPath = path.join(outputBaseDir, "context.md");
		const call = await waitForMockPiCall(mockPi, 0);
		const taskArg = call.args.at(-1) ?? "";
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`));
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "async configured report");
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
	});

	it("background single runs make output overrides authoritative in the child system prompt", async () => {
		mockPi.onCall({ output: "async override report" });
		const id = `async-output-override-system-prompt-${Date.now().toString(36)}`;
		const outputPath = path.join(tempDir, "async-custom-report.md");
		const run = executeAsyncSingle(id, {
			agent: "researcher",
			task: "Write report",
			agentConfig: makeAgent("researcher", {
				output: "default-report.md",
				systemPrompt: "Output format (`default-report.md`):\n\nWrite the full report to default-report.md.",
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const call = await waitForMockPiCall(mockPi, 0);
		const taskArg = call.args.at(-1) ?? "";
		const systemPrompt = call.systemPrompts[0]?.text ?? "";
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`));
		assert.match(systemPrompt, /Output format \(`default-report\.md`\):/);
		assert.match(systemPrompt, /Runtime output path override:/);
		assert.match(systemPrompt, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(outputPath)}`));
		assert.match(systemPrompt, /Ignore any other output filename or output path mentioned elsewhere/);
		await waitForAsyncResultFile(id);
	});

	it("background single runs treat string false as disabled output", async () => {
		mockPi.onCall({ output: "async inline report" });
		const id = `async-string-false-output-${Date.now().toString(36)}`;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { output: "default-report.md" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: "false",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "async inline report");
		assert.doesNotMatch(payload.summary ?? "", /Output saved to:/);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readLastMockPiArgs(mockPi).at(-1) ?? "", /Write your findings to(?: exactly this path)?:/);
	});

	it("background runs detect hidden tool failures even when the child exits 0", async () => {
		mockPi.onCall({
			jsonl: [events.toolResult("bash", "connection refused")],
		});

		const id = `async-hidden-failure-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Deploy app",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
	});

	it("background implementation runs fail when no mutation attempt occurred", async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });

		const id = `async-no-mutation-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
		assert.match(String(payload.results[0].error ?? ""), /completed without making edits/);
		assert.match(String(payload.results[0].modelAttempts?.[0]?.error ?? ""), /completed without making edits/);

		const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
		const eventsText = fs.readFileSync(eventsPath, "utf-8");
		assert.match(eventsText, /"reason":"completion_guard"/);
		assert.match(eventsText, /Subagent failed: worker/);
		assert.doesNotMatch(eventsText, /Status:/);
		assert.doesNotMatch(eventsText, /Interrupt:/);
	});

	it("background bash-enabled non-implementation agents can opt out of the completion guard", async () => {
		mockPi.onCall({ output: "cold start test after patch" });

		const id = `async-completion-guard-optout-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "test-runner",
			task: "Run cold start test after patch",
			agentConfig: makeAgent("test-runner", { tools: ["read", "grep", "bash", "ls"], completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "cold start test after patch");

		const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
		const eventsText = fs.readFileSync(eventsPath, "utf-8");
		assert.doesNotMatch(eventsText, /"reason":"completion_guard"/);
	});

	it("background runs prefer the parent session provider for ambiguous bare model ids", async () => {
		mockPi.onCall({ output: "Done asynchronously" });

		const id = `async-provider-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "gpt-5-mini" }),
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "github-copilot",
			},
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "github-copilot/gpt-5-mini");
		assert.deepEqual(payload.results[0].attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("background single runs inherit the parent session model when no model is set", async () => {
		mockPi.onCall({ output: "Done asynchronously" });

		const id = `async-single-parent-model-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "deepseek",
				currentModel: { provider: "deepseek", id: "deepseek-v4-flash" },
			},
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "deepseek/deepseek-v4-flash");
		assert.deepEqual(payload.results[0].attemptedModels, ["deepseek/deepseek-v4-flash"]);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
	});

	it("background chains inherit the parent session model when no step or agent model is set", async () => {
		mockPi.onCall({ output: "Done asynchronously" });

		const id = `async-chain-parent-model-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "deepseek",
				currentModel: { provider: "deepseek", id: "deepseek-v4-flash" },
			},
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "deepseek/deepseek-v4-flash");
		assert.deepEqual(payload.results[0].attemptedModels, ["deepseek/deepseek-v4-flash"]);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
	});

	it("background single runs propagate tk ticket metadata from the effective task cwd", async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const ticketRoot = createTempDir("pi-subagent-async-ticket-cwd-");
		const taskCwd = path.join(ticketRoot, "child", "nested");
		const id = `async-ticket-single-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const emitted: Array<{ channel: string; payload: unknown }> = [];
		const originalTicketsDir = process.env.TICKETS_DIR;

		try {
			delete process.env.TICKETS_DIR;
			fs.mkdirSync(path.join(ticketRoot, ".tickets"), { recursive: true });
			fs.mkdirSync(taskCwd, { recursive: true });
			fs.writeFileSync(path.join(ticketRoot, ".tickets", "psr-raw4.md"), "---\nid: psr-raw4\n---\n# Show active tk title\n", "utf-8");
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Run `tk show psr-raw4` first.",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit(channel: string, payload: unknown) { emitted.push({ channel, payload }); } } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: taskCwd,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			await waitForAsyncResultFile(id, 10_000);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
			assert.deepEqual(status.tkTicket, { id: "psr-raw4", title: "Show active tk title" });
			assert.deepEqual((emitted.find((entry) => entry.channel === "subagent:async-started")?.payload as { tkTicket?: unknown } | undefined)?.tkTicket, { id: "psr-raw4", title: "Show active tk title" });
		} finally {
			if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
			else process.env.TICKETS_DIR = originalTicketsDir;
			removeTempDir(ticketRoot);
		}
	});

	it("background continuation launches preserve inherited tk ticket metadata when the follow-up omits tk show", async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const id = `async-ticket-continuation-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Continue from the paused work.",
			inheritedTkTicket: { id: "psr-raw4", title: "Show active tk title" },
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: tempDir,
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		await waitForAsyncResultFile(id, 10_000);
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.deepEqual(status.tkTicket, { id: "psr-raw4", title: "Show active tk title" });
	});

	it("background parallel launches propagate step-cwd tk tickets and fail open for ambiguous matches", async () => {
		mockPi.onCall({ output: "parallel one done" });
		mockPi.onCall({ output: "parallel two done" });
		const ticketRoot = createTempDir("pi-subagent-async-parallel-ticket-");
		const ticketCwd = path.join(ticketRoot, "tasks", "alpha");
		const id = `async-ticket-parallel-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const emitted: Array<{ channel: string; payload: unknown }> = [];
		const originalTicketsDir = process.env.TICKETS_DIR;

		try {
			delete process.env.TICKETS_DIR;
			fs.mkdirSync(path.join(ticketRoot, ".tickets"), { recursive: true });
			fs.mkdirSync(ticketCwd, { recursive: true });
			fs.writeFileSync(path.join(ticketRoot, ".tickets", "psr-raw4.md"), "---\nid: psr-raw4\n---\n# Show active tk title\n", "utf-8");
			executeAsyncChain(id, {
				chain: [{ parallel: [{ agent: "worker", task: "Run `tk show psr-raw4` first.", cwd: ticketCwd }, { agent: "reviewer", task: "Do the review" }] }],
				resultMode: "parallel",
				agents: [makeAgent("worker"), makeAgent("reviewer")],
				ctx: { pi: { events: { emit(channel: string, payload: unknown) { emitted.push({ channel, payload }); } } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			await waitForAsyncResultFile(id, 10_000);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
			assert.deepEqual(status.tkTicket, { id: "psr-raw4", title: "Show active tk title" });
			assert.deepEqual((emitted.find((entry) => entry.channel === "subagent:async-started")?.payload as { tkTicket?: unknown } | undefined)?.tkTicket, { id: "psr-raw4", title: "Show active tk title" });

			mockPi.onCall({ output: "ambiguous one done" });
			mockPi.onCall({ output: "ambiguous two done" });
			const ambiguousId = `async-ticket-parallel-ambiguous-${Date.now().toString(36)}`;
			executeAsyncChain(ambiguousId, {
				chain: [{ parallel: [{ agent: "worker", task: "Run `tk show psr-raw4` first.", cwd: ticketCwd }, { agent: "reviewer", task: "Run `tk show psr-other` first.", cwd: ticketCwd }] }],
				resultMode: "parallel",
				agents: [makeAgent("worker"), makeAgent("reviewer")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});
			await waitForAsyncResultFile(ambiguousId, 10_000);
			const ambiguousStatus = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, ambiguousId, "status.json"), "utf-8")) as AsyncStatusPayload;
			assert.equal(ambiguousStatus.tkTicket, undefined);
		} finally {
			if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
			else process.env.TICKETS_DIR = originalTicketsDir;
			removeTempDir(ticketRoot);
		}
	});

	it("background runs resolve skills from the effective task cwd", async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const taskCwd = createTempDir("pi-subagent-async-task-cwd-");
		const id = `async-skill-cwd-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");

		try {
			writePackageSkill(taskCwd, "async-task-cwd-skill");
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker", { skills: ["async-task-cwd-skill"] }),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: taskCwd,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					assert.fail(`Timed out waiting for async result file: ${resultPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, true);
			assert.deepEqual(status.steps?.[0]?.skills, ["async-task-cwd-skill"]);
		} finally {
			removeTempDir(taskCwd);
		}
	});

	it("background single runs report unavailable pi-subagents skill requests", () => {
		const id = `async-pi-subagents-skill-${Date.now().toString(36)}`;
		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: tempDir,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			skills: ["pi-subagents"],
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Skills not found: pi-subagents/);
	});

	it("background chains report unavailable pi-subagents skill requests", () => {
		const id = `async-chain-pi-subagents-skill-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work", skill: ["pi-subagents"] }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: tempDir,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Skills not found: pi-subagents/);
	});

	it("background chains resolve relative step cwd values against the shared cwd", async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const chainCwd = createTempDir("pi-subagent-async-chain-cwd-");
		const id = `async-chain-skill-cwd-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");

		try {
			writePackageSkill(path.join(chainCwd, "packages", "app"), "async-chain-step-skill");
			executeAsyncChain(id, {
				chain: [{ agent: "worker", task: "Do work", cwd: "packages/app", skill: ["async-chain-step-skill"] }],
				agents: [makeAgent("worker")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: chainCwd,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					assert.fail(`Timed out waiting for async result file: ${resultPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.sessionId, "session-1");
			assert.equal(status.sessionId, "session-1");
			assert.deepEqual(status.steps?.[0]?.skills, ["async-chain-step-skill"]);
		} finally {
			removeTempDir(chainCwd);
		}
	});

	it("keeps top-level current tool/path aligned with still-running parallel children", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "README.md" })] },
				{ delay: 900, jsonl: [events.toolEnd("read"), events.toolResult("read", "done"), events.assistantMessage("reader done")] },
			],
		});
		mockPi.onCall({
			steps: [
				{ delay: 100, jsonl: [events.toolStart("edit", { path: "docs.md" })] },
				{ delay: 100, jsonl: [events.toolEnd("edit"), events.toolResult("edit", "ok")] },
				{ delay: 700, jsonl: [events.assistantMessage("editor done")] },
			],
		});

		const id = `async-parallel-tool-sync-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "reader", task: "Read" }, { agent: "editor", task: "Edit" }] }],
			agents: [makeAgent("reader"), makeAgent("editor")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const statusPath = path.join(asyncDir, "status.json");
		const doneDeadline = Date.now() + 10_000;
		let sawRunningTool = false;
		let invariantViolated = false;
		while (!fs.existsSync(resultPath) && Date.now() < doneDeadline) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				const runningTools = (status.steps ?? [])
					.filter((step) => step.status === "running" && typeof step.currentTool === "string")
					.map((step) => step.currentTool as string);
				if (runningTools.length > 0) {
					sawRunningTool = true;
					if (!status.currentTool || !runningTools.includes(status.currentTool)) {
						invariantViolated = true;
						break;
					}
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (!fs.existsSync(resultPath)) {
			assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		}
		assert.equal(sawRunningTool, true, "expected at least one polling interval with a running step tool");
		assert.equal(invariantViolated, false, "top-level currentTool drifted from running step tools");
	});

	it("returns a tool error when the detached runner config cannot be written", () => {
		const id = `async-write-fail-${Date.now().toString(36)}`;
		assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
		assert.match(result.content[0]?.text ?? "", /async-cfg-/);
	});

	it("returns a tool error when an async run uses a missing cwd", () => {
		const id = `async-missing-cwd-${Date.now().toString(36)}`;
		const missingCwd = path.join(tempDir, "missing-cwd");

		const singleResult = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: missingCwd,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(singleResult.isError, true);
		assert.match(singleResult.content[0]?.text ?? "", /Failed to start async run/);
		assert.match(singleResult.content[0]?.text ?? "", /cwd does not exist/);

		const chainId = `async-missing-cwd-chain-${Date.now().toString(36)}`;
		const chainResult = executeAsyncChain(chainId, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: missingCwd,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(chainResult.isError, true);
		assert.match(chainResult.content[0]?.text ?? "", /Failed to start async chain/);
		assert.match(chainResult.content[0]?.text ?? "", /cwd does not exist/);
	});

	it("returns a tool error when the async runner process cannot spawn", () => {
		const originalExecPath = process.execPath;
		const pathKey = process.platform === "win32" ? "Path" : "PATH";
		const originalPath = process.env[pathKey];
		process.execPath = path.join(tempDir, process.platform === "win32" ? "pi.exe" : "pi");
		process.env[pathKey] = tempDir;
		try {
			const id = `async-spawn-fail-${Date.now().toString(36)}`;
			const result = executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
			assert.match(result.content[0]?.text ?? "", /async runner did not produce a pid/);
		} finally {
			process.execPath = originalExecPath;
			if (originalPath === undefined) {
				delete process.env[pathKey];
			} else {
				process.env[pathKey] = originalPath;
			}
		}
	});

	it("returns a tool error when an async chain cannot write its detached runner config", () => {
		const id = `async-chain-write-fail-${Date.now().toString(36)}`;
		assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

		const result = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to start async chain/);
		assert.match(result.content[0]?.text ?? "", /async-cfg-/);
	});

	it("background forced drain after final assistant output is cleanup success", async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("async-done-before-drain")],
			stderr: "Done after 1 turn(s). Ready for input.\n",
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		const start = Date.now();
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 9000, `should clean up async child before the mock's natural keepalive exit, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "async-done-before-drain");
	});

	it("background forced drain after empty terminal assistant output is cleanup success", async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("")],
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-empty-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		const start = Date.now();
		executeAsyncSingle(id, {
			agent: "scout",
			task: "Inspect something",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 9000, `should clean up async child before the mock's natural keepalive exit, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "");
	});

	it("background final-drain cleanup preserves explicit assistant errors", async () => {
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

		const id = `async-final-drain-error-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
		assert.equal(payload.results[0].error, "provider exploded");
	});

	it("background interrupted runs still clean up owned process groups", {
		skip: process.platform === "win32"
			? "owned process-group cleanup unsupported on win32"
			: undefined,
	}, async () => {
		mockPi.onCall({ delay: 10_000 });

		const id = `async-interrupt-cleanup-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			acceptance: { level: "checked", criteria: ["Complete the work"] },
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		await waitForMockPiCall(mockPi, 0);
		await waitForAsyncState(asyncDir, "running");
		requestAsyncInterrupt(asyncDir, { source: "async-execution-test" });

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		const processCleanup = payload.results[0]?.processCleanup;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "paused");
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0]?.acceptance?.status, "skipped");
		assert.equal(status.steps?.[0]?.status, "paused");
		assert.equal(status.steps?.[0]?.acceptance?.status, "skipped");
		assert.equal(payload.summary, "Paused after interrupt. Waiting for explicit next action.");
		assert.ok(processCleanup, "expected background result to report process cleanup");
		assert.equal(processCleanup?.attempted, true);
		assert.equal(processCleanup?.terminated, true);
		assert.equal(processCleanup?.skippedReason, undefined);
		assert.equal(typeof processCleanup?.processGroupId, "number");
	});

	it("background runs emit active-long-running control events from child turns", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.assistantMessage("still working")] },
				{ delay: 2_000, jsonl: [events.assistantMessage("done")] },
			],
		});

		const id = `async-active-long-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "scout",
			task: "Investigate behavior",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 1,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
			}
			if (eventText.includes('"type":"active_long_running"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "active_long_running" && status.steps?.[0]?.activityState === "active_long_running") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"type":"active_long_running"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed active_long_running");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"active_long_running"/);
		assert.match(eventText, /"reason":"turn_threshold"/);
		assert.ok(statusDuringEvent, "expected status.json to expose active_long_running while the run is still active");
		assert.equal(statusDuringEvent.activityState, "active_long_running");
		assert.equal(statusDuringEvent.steps?.[0]?.activityState, "active_long_running");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background runs do not emit idle attention while a tool call is still running", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("bash", { command: "echo still running" })] },
				{ delay: 1_300, jsonl: [events.toolEnd("bash")] },
				{ jsonl: [events.assistantMessage("Done after the tool finished.")] },
			],
		});

		const id = `async-tool-inflight-idle-guard-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "scout",
			task: "Investigate behavior",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 200,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const eventText = fs.existsSync(path.join(asyncDir, "events.jsonl")) ? fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8") : "";
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.doesNotMatch(eventText, /"reason":"idle"/);
		assert.equal(status.activityState, undefined);
		assert.equal(status.steps?.[0]?.activityState, undefined);
		assert.equal(payload.state, "complete");
		assert.equal(payload.success, true);
	});

	it("background runs still emit idle attention after a tool finishes and the child goes silent", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("bash", { command: "echo done" })] },
				{ delay: 1_300, jsonl: [events.toolEnd("bash")] },
				{ delay: 1_300, jsonl: [events.assistantMessage("Done after an idle gap.")] },
			],
		});

		const id = `async-post-tool-idle-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "scout",
			task: "Investigate behavior",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 200,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const observed = await waitForAsyncControlCondition(asyncDir, (status, eventText) => {
			return eventText.includes('"reason":"idle"')
				&& status.activityState === "needs_attention"
				&& status.steps?.[0]?.activityState === "needs_attention";
		});
		assert.match(observed.eventText, /"type":"needs_attention"/);
		assert.match(observed.eventText, /"reason":"idle"/);

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.state, "complete");
		assert.equal(payload.success, true);
	});

	it("background runs escalate repeated mutating tool failures", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ delay: 2_000, jsonl: [events.assistantMessage("I need another attempt.")] },
			],
		});

		const id = `async-tool-failures-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
			}
			if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "needs_attention" && status.steps?.[0]?.activityState === "needs_attention") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed needs_attention");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"needs_attention"/);
		assert.match(eventText, /"reason":"tool_failures"/);
		assert.match(eventText, /subagent-runner\.ts/);
		assert.ok(statusDuringEvent, "expected status.json to expose needs_attention while the run is still active");
		assert.equal(statusDuringEvent.activityState, "needs_attention");
		assert.equal(statusDuringEvent.steps?.[0]?.activityState, "needs_attention");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background event logs drop noisy message updates and cap child diagnostics", async () => {
		const previousMaxBytes = process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES;
		process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES = "900";
		try {
			mockPi.onCall({
				steps: [
					{
						jsonl: [
							{
								type: "message_update",
								assistantMessageEvent: {
									type: "thinking_delta",
									delta: "NOISY_PARTIAL_DELTA",
									partial: { role: "assistant", content: [{ type: "text", text: "NOISY_PARTIAL_SNAPSHOT".repeat(200) }] },
								},
								message: { role: "assistant", content: [{ type: "text", text: "NOISY_PARTIAL_MESSAGE".repeat(200) }] },
							},
							events.toolStart("bash", { command: `echo ${"BIG_COMMAND_PAYLOAD".repeat(200)}` }),
							events.assistantMessage("Done after noisy stream"),
						],
					},
				],
			});

			const id = `async-noisy-events-${Date.now().toString(36)}`;
			const asyncDir = path.join(ASYNC_DIR, id);
			const sessionRoot = path.join(tempDir, "sessions");

			executeAsyncSingle(id, {
				agent: "worker",
				task: "Stream noisy diagnostics",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot,
				maxSubagentDepth: 2,
			});

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "Done after noisy stream");

			const eventsText = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
			assert.doesNotMatch(eventsText, /"type":"message_update"/);
			assert.doesNotMatch(eventsText, /NOISY_PARTIAL_/);
			assert.doesNotMatch(eventsText, /BIG_COMMAND_PAYLOAD/);
			assert.match(eventsText, /"type":"subagent\.events\.truncated"/);
			assert.match(eventsText, /"droppedEventType":"tool_execution_start"/);
		} finally {
			if (previousMaxBytes === undefined) delete process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES;
			else process.env.PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES = previousMaxBytes;
		}
	});

	it("background runs stream child events and live output while active", async () => {
		mockPi.onCall({
			steps: [
				{ delay: 200, jsonl: [events.toolStart("bash", { command: "ls" })] },
				{ delay: 600, jsonl: [events.toolEnd("bash"), events.toolResult("bash", "file-a\nfile-b")] },
				{ delay: 600, jsonl: [events.assistantMessage("Done streaming")], stderr: "warning: mock stderr\n" },
			],
		});

		const id = `async-stream-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const outputPath = path.join(asyncDir, "output-0.log");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Stream detailed progress",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const liveDeadline = Date.now() + 10_000;
		let sawChildEvent = false;
		let sawLiveOutput = false;
		while (Date.now() < liveDeadline && (!sawChildEvent || !sawLiveOutput)) {
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, "utf-8");
				sawChildEvent = content.includes('"type":"tool_execution_start"')
					&& content.includes('"subagentSource":"child"');
			}
			if (fs.existsSync(outputPath)) {
				const content = fs.readFileSync(outputPath, "utf-8");
				sawLiveOutput = content.includes("bash: ls") || content.includes("file-a") || content.includes("warning: mock stderr");
			}
			if (sawChildEvent && sawLiveOutput) break;
			assert.equal(fs.existsSync(resultPath), false, "run finished before live observability was written");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.equal(sawChildEvent, true, "expected child JSON events to be streamed into events.jsonl");
		assert.equal(sawLiveOutput, true, "expected output-0.log to receive live child output");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].output, "Done streaming");

		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
		assert.deepEqual(status.steps[0].recentTools.map((tool: { tool: string; args: string }) => ({ tool: tool.tool, args: tool.args })), [{ tool: "bash", args: "ls" }]);
		assert.deepEqual(status.steps[0].recentOutput, ["file-a", "file-b", "Done streaming"]);
	});

	it("pauses async supervisor requests durably and reload resume stays single-claim", { skip: process.platform === "win32" ? "cross-process supervisor pause delivery unreliable on Windows CI" : undefined }, async () => {
		const originalSessionDirFile = process.env.MOCK_PI_SESSION_DIR_FILE;
		process.env.MOCK_PI_SESSION_DIR_FILE = "1";
		try {
			const id = `async-supervisor-pause-${Date.now().toString(36)}`;
			let runnerPid: number | undefined;
			mockPi.onCall({
			steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] }],
			keepAliveAfterFinalMessageMs: 5_000,
		});
		const started = executeAsyncSingle!(id, {
			agent: "worker",
			task: "Ask for a supervisor decision and stop there.",
			agentConfig: makeAgent("worker", { acceptance: { level: "checked" }, maxExecutionTimeMs: 5_000 }),
			ctx: {
				pi: {
					events: {
						emit(event: string, payload: unknown) {
							if (event === "subagent:async-started" && payload && typeof payload === "object" && "pid" in payload) {
								runnerPid = (payload as { pid?: number }).pid;
							}
						},
					},
				},
				cwd: tempDir,
				currentSessionId: "session-1",
			},
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});
		assert.equal(started.isError, undefined);
		const asyncDir = path.join(ASYNC_DIR, id);
		assert.ok(runnerPid, "expected async runner pid from started event");
		await waitForMockPiCall(mockPi, 0, 10_000);
		const childPids = startedMockPiPids(mockPi);
		assert.equal(childPids.length, 1);
		await waitForAsyncState(asyncDir, "paused", 10_000);
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as any;
		assert.equal(status.state, "paused");
		assert.equal(status.pid, undefined);
		assert.equal(status.pause?.kind, "awaiting_supervisor");
		assert.equal(status.pause?.ownerPid, undefined);
		assert.equal(status.pause?.request?.tool, "contact_supervisor");
		assert.equal(status.steps?.[0]?.status, "paused");
		assert.equal(status.steps?.[0]?.pause?.kind, "awaiting_supervisor");
		assert.equal(status.steps?.[0]?.acceptance?.status, "skipped");
		assert.ok((status.steps?.[0]?.activeRuntimeMs ?? 0) > 0);
		const pausedActiveRuntimeMs = status.steps[0].activeRuntimeMs;
		const payload = await readAsyncPayload(id) as any;
		assert.equal(payload.state, "paused");
		assert.equal(payload.pause?.kind, "awaiting_supervisor");
		assert.equal(payload.results?.[0]?.pause?.kind, "awaiting_supervisor");
		await waitForPidsToExit([runnerPid, ...childPids], `paused async supervisor run ${id}`);
		assert.equal(mockPi.callCount(), 1);

		const resumeTarget = resolveAsyncResumeTarget({ id });
		assert.equal(resumeTarget.kind, "revive");
		assert.equal(resumeTarget.pauseKind, "awaiting_supervisor");
		mockPi.onCall({ output: "resumed after supervisor reply" });
		const reloaded = makeAsyncExecutor([makeAgent("worker", { acceptance: { level: "checked" }, maxExecutionTimeMs: 5_000 })]);
		await reloaded.execute(
			"async-supervisor-resume",
			{ action: "resume", id, message: "Supervisor replied: continue.", timeoutMs: 500 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		await waitForMockPiCall(mockPi, 1);
		await waitForAsyncState(asyncDir, "continued", 10_000);
		assert.equal(mockPi.callCount(), 2);
		const continuedStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as any;
		assert.equal(continuedStatus.state, "continued");
		assert.equal(typeof continuedStatus.lifecycle?.continuation?.continuationRunId, "string");
		assert.equal(continuedStatus.pid, undefined);
		const continuationPayload = await readAsyncPayload(continuedStatus.lifecycle.continuation.continuationRunId);
		assert.equal(continuationPayload.state, "complete");
		assert.equal(continuationPayload.results[0]?.output, "resumed after supervisor reply");
		assert.equal(continuationPayload.timeoutMs, 500);
		assert.ok((continuationPayload.results[0]?.activeRuntimeMs ?? 0) >= pausedActiveRuntimeMs);
		const continuationStatus = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, continuedStatus.lifecycle.continuation.continuationRunId, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(continuationStatus.steps?.[0]?.timeoutMs, 500);
		assert.ok((continuationStatus.steps?.[0]?.activeRuntimeMs ?? 0) >= pausedActiveRuntimeMs);
		assert.notEqual(continuationPayload.results[0]?.acceptance?.status, "skipped");
		assert.equal(continuationPayload.results[0]?.acceptance?.status, "checked");

		const duplicate = await reloaded.execute(
			"async-supervisor-resume-duplicate",
			{ action: "resume", id, message: "Supervisor replied: continue." },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
			assert.equal(duplicate.isError, true);
			assert.match(duplicate.content[0]?.text ?? "", /already launched continuation|already claimed/i);
			assert.equal(mockPi.callCount(), 2);
		} finally {
			if (originalSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
			else process.env.MOCK_PI_SESSION_DIR_FILE = originalSessionDirFile;
		}
	});

	it("resumes paused async supervisor runs unchanged after disk reload and evaluates continuation acceptance once", { skip: process.platform === "win32" ? "cross-process supervisor pause delivery unreliable on Windows CI" : undefined }, async () => {
		const originalSessionDirFile = process.env.MOCK_PI_SESSION_DIR_FILE;
		process.env.MOCK_PI_SESSION_DIR_FILE = "1";
		try {
			const id = `async-supervisor-resume-unchanged-${Date.now().toString(36)}`;
			mockPi.onCall({
				steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] }],
				keepAliveAfterFinalMessageMs: 5_000,
			});
			executeAsyncSingle!(id, {
				agent: "worker",
				task: "Ask for a supervisor decision and stop there.",
				agentConfig: makeAgent("worker", { acceptance: { level: "checked" } }),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});
			const asyncDir = path.join(ASYNC_DIR, id);
			await waitForAsyncState(asyncDir, "paused", 10_000);
			const pausedPayload = await readAsyncPayload(id);
			assert.equal(pausedPayload.results[0]?.acceptance?.status, "skipped");
			mockPi.onCall({ output: "resumed unchanged after reload" });
			const reloaded = makeAsyncExecutor([makeAgent("worker", { acceptance: { level: "checked" } })]);
			const resumed = await reloaded.execute(
				"async-supervisor-resume-unchanged",
				{ action: "resume", id },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(resumed.isError, undefined);
			await waitForAsyncState(asyncDir, "continued", 10_000);
			const continuedStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as any;
			const continuationRunId = continuedStatus.lifecycle?.continuation?.continuationRunId;
			assert.equal(typeof continuationRunId, "string");
			const continuationPayload = await readAsyncPayload(continuationRunId);
			assert.equal(continuationPayload.state, "complete");
			assert.equal(continuationPayload.results[0]?.output, "resumed unchanged after reload");
			assert.notEqual(continuationPayload.results[0]?.acceptance?.status, "skipped");
			assert.equal(continuationPayload.results[0]?.acceptance?.status, "checked");
		} finally {
			if (originalSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
			else process.env.MOCK_PI_SESSION_DIR_FILE = originalSessionDirFile;
		}
	});

	it("cancels paused async supervisor runs after disk reload without reviving them", { skip: process.platform === "win32" ? "cross-process supervisor pause delivery unreliable on Windows CI" : undefined }, async () => {
		const id = `async-supervisor-cancel-${Date.now().toString(36)}`;
		mockPi.onCall({
			steps: [{ jsonl: [events.toolStart("intercom", { action: "ask", to: "main", message: "Need input" })] }],
			keepAliveAfterFinalMessageMs: 5_000,
		});
		executeAsyncSingle!(id, {
			agent: "worker",
			task: "Ask on intercom and wait.",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});
		const asyncDir = path.join(ASYNC_DIR, id);
		await waitForAsyncState(asyncDir, "paused", 10_000);
		const reloaded = makeAsyncExecutor();
		const cancelled = await reloaded.execute(
			"async-supervisor-cancelled",
			{ action: "interrupt", id },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(cancelled.isError, undefined);
		assert.match(cancelled.content[0]?.text ?? "", /cancelled/i);
		assert.equal(mockPi.callCount(), 1);
		const cancelledStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as any;
		assert.equal(cancelledStatus.state, "cancelled");
		assert.equal(cancelledStatus.pid, undefined);
		assert.equal(cancelledStatus.pause?.ownerPid, undefined);
		const cancelledAgain = await reloaded.execute(
			"async-supervisor-cancelled-again",
			{ action: "interrupt", id },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(cancelledAgain.isError, undefined);
		assert.match(cancelledAgain.content[0]?.text ?? "", /already cancelled/i);
	});

	it("recovers dead-owner paused continuation claims before async resume after reload", { skip: process.platform === "win32" ? "cross-process supervisor pause delivery unreliable on Windows CI" : undefined }, async () => {
		const originalSessionDirFile = process.env.MOCK_PI_SESSION_DIR_FILE;
		process.env.MOCK_PI_SESSION_DIR_FILE = "1";
		try {
			const id = `async-supervisor-resume-recover-${Date.now().toString(36)}`;
			mockPi.onCall({
				steps: [{ jsonl: [events.toolStart("intercom", { action: "ask", to: "main", message: "Need input" })] }],
				keepAliveAfterFinalMessageMs: 5_000,
			});
			executeAsyncSingle!(id, {
				agent: "worker",
				task: "Ask on intercom and wait.",
				agentConfig: makeAgent("worker", { acceptance: { level: "checked" } }),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});
			const asyncDir = path.join(ASYNC_DIR, id);
			await waitForAsyncState(asyncDir, "paused", 10_000);
			const pausedStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as any;
			pausedStatus.lifecycle = { ...(pausedStatus.lifecycle ?? {}), continuation: { claimToken: `claim-${id}`, claimedAt: Date.now(), ownerPid: 999999 } };
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(pausedStatus, null, 2), "utf-8");
			mockPi.onCall({ output: "resumed after dead-owner recovery" });
			const reloaded = makeAsyncExecutor([makeAgent("worker", { acceptance: { level: "checked" } })]);
			const resumed = await reloaded.execute(
				"async-supervisor-resume-recover",
				{ action: "resume", id, message: "Continue." },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			assert.equal(resumed.isError, undefined);
			await waitForAsyncState(asyncDir, "continued", 10_000);
			const continuedStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as any;
			assert.equal(continuedStatus.state, "continued");
			assert.equal(typeof continuedStatus.lifecycle?.continuation?.continuationRunId, "string");
		} finally {
			if (originalSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
			else process.env.MOCK_PI_SESSION_DIR_FILE = originalSessionDirFile;
		}
	});

	it("recovers dead-owner paused continuation claims before async cancel after reload", { skip: process.platform === "win32" ? "cross-process supervisor pause delivery unreliable on Windows CI" : undefined }, async () => {
		const id = `async-supervisor-cancel-recover-${Date.now().toString(36)}`;
		mockPi.onCall({
			steps: [{ jsonl: [events.toolStart("intercom", { action: "ask", to: "main", message: "Need input" })] }],
			keepAliveAfterFinalMessageMs: 5_000,
		});
		executeAsyncSingle!(id, {
			agent: "worker",
			task: "Ask on intercom and wait.",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});
		const asyncDir = path.join(ASYNC_DIR, id);
		await waitForAsyncState(asyncDir, "paused", 10_000);
		const pausedStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as any;
		pausedStatus.lifecycle = { ...(pausedStatus.lifecycle ?? {}), continuation: { claimToken: `claim-${id}`, claimedAt: Date.now(), ownerPid: 999999 } };
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(pausedStatus, null, 2), "utf-8");
		const reloaded = makeAsyncExecutor();
		const cancelled = await reloaded.execute(
			"async-supervisor-cancel-recover",
			{ action: "interrupt", id },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(cancelled.isError, undefined);
		const cancelledStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as any;
		assert.equal(cancelledStatus.state, "cancelled");
		assert.equal(cancelledStatus.lifecycle?.continuation, undefined);
	});

	it("makes paused async resume versus cancel races deterministic after reload", { skip: process.platform === "win32" ? "cross-process supervisor pause delivery unreliable on Windows CI" : undefined }, async () => {
		const id = `async-supervisor-race-${Date.now().toString(36)}`;
		mockPi.onCall({
			steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] }],
			keepAliveAfterFinalMessageMs: 5_000,
		});
		executeAsyncSingle!(id, {
			agent: "worker",
			task: "Ask for a supervisor decision and stop there.",
			agentConfig: makeAgent("worker", { acceptance: { level: "checked" } }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});
		const asyncDir = path.join(ASYNC_DIR, id);
		await waitForAsyncState(asyncDir, "paused", 10_000);
		mockPi.onCall({ output: "resumed race winner" });
		const reloaded = makeAsyncExecutor([makeAgent("worker", { acceptance: { level: "checked" } })]);
		const [resumeResult, cancelResult] = await Promise.allSettled([
			reloaded.execute("async-supervisor-race-resume", { action: "resume", id, message: "Supervisor replied: continue." }, new AbortController().signal, undefined, makeMinimalCtx(tempDir)),
			reloaded.execute("async-supervisor-race-cancel", { action: "interrupt", id }, new AbortController().signal, undefined, makeMinimalCtx(tempDir)),
		]);
		const settledStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as any;
		assert.ok(["continued", "cancelled"].includes(settledStatus.state));
		assert.ok(mockPi.callCount() <= 2, `expected at most one continuation spawn, saw ${mockPi.callCount()}`);
		const successCount = [resumeResult, cancelResult].filter((entry) => entry.status === "fulfilled" && entry.value.isError === undefined).length;
		assert.equal(successCount, 1);
		if (settledStatus.state === "continued") {
			assert.equal(mockPi.callCount(), 2);
			assert.equal(typeof settledStatus.lifecycle?.continuation?.continuationRunId, "string");
			const continuationPayload = await readAsyncPayload(settledStatus.lifecycle.continuation.continuationRunId);
			assert.equal(continuationPayload.state, "complete");
		} else {
			assert.equal(mockPi.callCount(), 1);
		}
	});

	it("hard-kills an async supervisor-paused child that ignores SIGINT and SIGTERM and reaps owned pids", { skip: process.platform === "win32" ? "cross-process supervisor pause delivery unreliable on Windows CI" : undefined }, async () => {
		const id = `async-supervisor-hard-kill-${Date.now().toString(36)}`;
		let runnerPid: number | undefined;
		mockPi.onCall({
			steps: [{ delay: 250, jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] }],
			ignoreSigint: true,
			ignoreSigterm: true,
			spawnStubbornDescendants: true,
			keepAliveAfterFinalMessageMs: 30_000,
		});
		const startedAt = Date.now();
		executeAsyncSingle!(id, {
			agent: "worker",
			task: "Ask for a supervisor decision and stop there.",
			agentConfig: makeAgent("worker"),
			ctx: {
				pi: {
					events: {
						emit(event: string, payload: unknown) {
							if (event === "subagent:async-started" && payload && typeof payload === "object" && "pid" in payload) {
								runnerPid = (payload as { pid?: number }).pid;
							}
						},
					},
				},
				cwd: tempDir,
				currentSessionId: "session-1",
			},
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});
		const asyncDir = path.join(ASYNC_DIR, id);
		const pausingStatus = await waitForAsyncStatusPredicate(asyncDir, (status) => status.state === "pausing" && typeof (status as AsyncStatusPayload & { pid?: number }).pid === "number", "pausing before interrupt hard kill");
		await waitForMockPiCall(mockPi, 0, 10_000);
		const childPids = startedMockPiPids(mockPi);
		assert.equal(childPids.length, 1);
		await waitForMockPiSignal(mockPi, childPids[0]!, "SIGTERM", 10_000);
		const payload = await readAsyncPayload(id);
		const elapsedMs = Date.now() - startedAt;
		assert.equal(payload.state, "paused");
		assert.equal(payload.pause?.kind, "awaiting_supervisor");
		assert.ok(elapsedMs < 10_000, `expected bounded interrupt hard kill, took ${elapsedMs}ms`);
		const descendants = JSON.parse(fs.readFileSync(path.join(mockPi.dir, `descendants-${childPids[0]}.json`), "utf-8")) as { childPid: number; grandchildPid: number };
		await waitForPidsToExit([runnerPid, pausingStatus.pid as number | undefined, ...childPids, descendants.childPid, descendants.grandchildPid], `hard-killed async supervisor pause ${id}`);
		assertPidExited(runnerPid, "runner");
		assertPidExited(childPids[0], "child");
		assertPidExited(descendants.childPid, "descendant child");
		assertPidExited(descendants.grandchildPid, "descendant grandchild");
	});

	it("publishes privacy-safe failed state after a pre-checkpoint supervisor lifecycle lock failure", { skip: process.platform === "win32" ? "cross-process supervisor pause delivery unreliable on Windows CI" : undefined }, async () => {
		const id = `async-supervisor-lock-pre-${Date.now().toString(36)}`;
		mockPi.onCall({
			steps: [
				{ delay: 1_000, jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
			],
			keepAliveAfterFinalMessageMs: 5_000,
		});
		executeAsyncSingle!(id, {
			agent: "worker",
			task: "Ask for a supervisor decision and stop there.",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});
		const asyncDir = path.join(ASYNC_DIR, id);
		const runningStatus = await waitForAsyncStatusPredicate(asyncDir, (status) => status.state === "running" && typeof (status as AsyncStatusPayload & { pid?: number }).pid === "number", "running pid before lock contention");
		await waitForMockPiCall(mockPi, 0, 10_000);
		const childPids = startedMockPiPids(mockPi);
		assert.equal(childPids.length, 1);
		writeLifecycleLock(asyncDir);
		const payload = await readAsyncPayload(id);
		const lockedStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.state, "failed");
		assert.equal(lockedStatus.state, "failed");
		assert.equal((lockedStatus as AsyncStatusPayload & { pid?: number }).pid, undefined);
		assert.equal(lockedStatus.pause, undefined);
		assert.match(payload.error ?? "", /supervisor lifecycle update failed/i);
		assert.equal(payload.pause, undefined);
		assert.equal(fs.readdirSync(RESULTS_DIR).filter((name) => name === `${id}.json`).length, 1);
		await waitForPidsToExit([runningStatus.pid as number | undefined, ...childPids], `failed async supervisor lock contention ${id}`);
		removeLifecycleLock(asyncDir);
	});

	it("fails closed instead of publishing paused awaiting-supervisor while a nested descendant remains active", { skip: process.platform === "win32" ? "cross-process supervisor pause delivery unreliable on Windows CI" : undefined }, async () => {
		const id = `async-supervisor-nested-active-${Date.now().toString(36)}`;
		const nestedRoute = createNestedRoute(id);
		try {
			mockPi.onCall({
				steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] }],
				ignoreSigint: true,
				keepAliveAfterFinalMessageMs: 5_000,
			});
			executeAsyncSingle!(id, {
				agent: "worker",
				task: "Ask for a supervisor decision and stop there.",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
				nestedRoute,
			});
			const asyncDir = path.join(ASYNC_DIR, id);
			const pausingStatus = await waitForAsyncStatusPredicate(asyncDir, (status) => status.state === "pausing" && typeof (status as AsyncStatusPayload & { pid?: number }).pid === "number", "pausing before nested descendant gate");
			writeNestedEvent(nestedRoute, {
				type: "subagent.nested.started",
				ts: Date.now(),
				parentRunId: id,
				parentStepIndex: 0,
				child: {
					id: `${id}-nested-live`,
					parentRunId: id,
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: id, stepIndex: 0 }],
					asyncDir: path.join(asyncDir, "nested-live"),
					state: "running",
					agent: "nested-worker",
					startedAt: Date.now(),
					lastUpdate: Date.now(),
				},
			});
			const payload = await readAsyncPayload(id);
			const persistedStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.state, "failed");
			assert.equal(payload.pause, undefined);
			assert.equal(payload.summary, "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.");
			assert.equal(payload.error, "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.");
			assert.equal(persistedStatus.state, "failed");
			assert.equal((persistedStatus as AsyncStatusPayload & { pid?: number }).pid, undefined);
			assert.equal(persistedStatus.pause, undefined);
			assert.equal(persistedStatus.steps?.[0]?.processCleanup?.terminated, true);
			await waitForPidsToExit([pausingStatus.pid as number | undefined, ...startedMockPiPids(mockPi)], `failed async supervisor nested descendant ${id}`);
		} finally {
			fs.rmSync(path.dirname(nestedRoute.eventSink), { recursive: true, force: true });
		}
	});

	it("reconciles a post-checkpoint supervisor finalization lock failure to the paused awaiting-supervisor outcome", { skip: process.platform === "win32" ? "cross-process supervisor pause delivery unreliable on Windows CI" : undefined }, async () => {
		const id = `async-supervisor-lock-final-${Date.now().toString(36)}`;
		mockPi.onCall({
			steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] }],
			ignoreSigint: true,
			ignoreSigterm: true,
			keepAliveAfterFinalMessageMs: 30_000,
		});
		executeAsyncSingle!(id, {
			agent: "worker",
			task: "Ask for a supervisor decision and stop there.",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});
		const asyncDir = path.join(ASYNC_DIR, id);
		const pausingStatus = await waitForAsyncStatusPredicate(asyncDir, (status) => status.state === "pausing" && typeof (status as AsyncStatusPayload & { pid?: number }).pid === "number", "pausing pid before finalization lock contention");
		await waitForMockPiCall(mockPi, 0, 10_000);
		const childPids = startedMockPiPids(mockPi);
		assert.equal(childPids.length, 1);
		await waitForMockPiSignal(mockPi, childPids[0]!, "SIGTERM", 10_000);
		writeLifecycleLock(asyncDir);
		const lockedStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(lockedStatus.state, "pausing");
		const payload = await readAsyncPayload(id);
		assert.equal(payload.state, "paused");
		assert.equal(payload.pause?.kind, "awaiting_supervisor");
		assert.equal(fs.readdirSync(RESULTS_DIR).filter((name) => name === `${id}.json`).length, 1);
		await waitForPidsToExit([pausingStatus.pid as number | undefined, ...childPids], `paused async supervisor finalization ${id}`);
		removeLifecycleLock(asyncDir);
		const repaired = reconcileAsyncRun(asyncDir, { resultsDir: RESULTS_DIR, now: () => Date.now() });
		assert.equal(typeof repaired.repaired, "boolean");
		assert.equal(repaired.status?.state, "paused");
		assert.equal(repaired.status?.pause?.kind, "awaiting_supervisor");
		const reconciledStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(reconciledStatus.state, "paused");
		assert.equal(reconciledStatus.pause?.kind, "awaiting_supervisor");
	});

	it("preserves an adopted concurrent terminal winner during supervisor pause finalization", { skip: process.platform === "win32" ? "cross-process supervisor pause delivery unreliable on Windows CI" : undefined }, async () => {
		const id = `async-supervisor-concurrent-terminal-${Date.now().toString(36)}`;
		mockPi.onCall({
			steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] }],
			ignoreSigint: true,
			keepAliveAfterFinalMessageMs: 5_000,
		});
		executeAsyncSingle!(id, {
			agent: "worker",
			task: "Ask for a supervisor decision and stop there.",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});
		const asyncDir = path.join(ASYNC_DIR, id);
		const pausingStatus = await waitForAsyncStatusPredicate(asyncDir, (status) => status.state === "pausing", "pausing before concurrent terminal winner");
		writeLifecycleLock(asyncDir);
		await waitForAsyncStatusPredicate(asyncDir, (status) => status.state === "pausing" && status.steps?.[0]?.status === "paused", "paused step before concurrent terminal winner");
		writeNormalizedLifecycleStatus(asyncDir, {
			...pausingStatus,
			state: "cancelled",
			pid: undefined,
			endedAt: Date.now(),
			lastUpdate: Date.now(),
			cancel: { summary: "Cancelled by test", cancelledAt: Date.now() },
			pause: pausingStatus.pause ? { ...pausingStatus.pause, ownerPid: undefined } : pausingStatus.pause,
			steps: pausingStatus.steps?.map((step) => ({
				...step,
				status: step.status === "complete" || step.status === "completed" ? step.status : "cancelled",
				exitCode: step.exitCode ?? 0,
				pause: step.pause ? { ...step.pause, ownerPid: undefined } : step.pause,
			})),
			lifecycle: { generation: ((pausingStatus as AsyncStatusPayload & { lifecycle?: { generation?: number } }).lifecycle?.generation ?? 0) + 1 },
		});
		const payload = await readAsyncPayload(id);
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.state, "cancelled");
		assert.equal(status.state, "cancelled");
	});

	it("keeps supervisor-first versus external-interrupt outcomes deterministic", { skip: process.platform === "win32" ? "cross-process supervisor pause delivery unreliable on Windows CI" : undefined }, async () => {
		const supervisorFirstId = `async-supervisor-first-${Date.now().toString(36)}`;
		mockPi.onCall({
			steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] }],
			ignoreSigint: true,
			keepAliveAfterFinalMessageMs: 5_000,
		});
		executeAsyncSingle!(supervisorFirstId, {
			agent: "worker",
			task: "Ask for a supervisor decision and stop there.",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});
		const supervisorFirstDir = path.join(ASYNC_DIR, supervisorFirstId);
		const pausing = await waitForAsyncStatusPredicate(supervisorFirstDir, (status) => status.state === "pausing" && typeof (status as AsyncStatusPayload & { pid?: number }).pid === "number", "supervisor-first pausing");
		deliverInterruptRequest({ asyncDir: supervisorFirstDir, pid: (pausing as AsyncStatusPayload & { pid?: number }).pid, source: "test-race" });
		const supervisorFirstPayload = await readAsyncPayload(supervisorFirstId);
		assert.equal(supervisorFirstPayload.state, "paused");
		assert.equal(supervisorFirstPayload.pause?.kind, "awaiting_supervisor");

		const interruptFirstId = `async-interrupt-first-${Date.now().toString(36)}`;
		mockPi.onCall({
			steps: [{ delay: 800, jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] }],
			keepAliveAfterFinalMessageMs: 5_000,
		});
		executeAsyncSingle!(interruptFirstId, {
			agent: "worker",
			task: "Ask for a supervisor decision and stop there.",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});
		const interruptFirstDir = path.join(ASYNC_DIR, interruptFirstId);
		const running = await waitForAsyncStatusPredicate(interruptFirstDir, (status) => status.state === "running" && typeof (status as AsyncStatusPayload & { pid?: number }).pid === "number", "interrupt-first running");
		deliverInterruptRequest({ asyncDir: interruptFirstDir, pid: (running as AsyncStatusPayload & { pid?: number }).pid, source: "test-race" });
		const interruptFirstPayload = await readAsyncPayload(interruptFirstId);
		assert.equal(interruptFirstPayload.state, "paused");
		assert.equal(interruptFirstPayload.pause, undefined);
		assert.equal(interruptFirstPayload.summary, "Paused after interrupt. Waiting for explicit next action.");
	});

	it("keeps non-blocking supervisor updates live and pauses only active cohort children for supervisor blocks", { skip: process.platform === "win32" ? "cross-process supervisor pause delivery unreliable on Windows CI" : undefined }, async () => {
		mockPi.onCall({ steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "progress_update", message: "FYI" }), events.toolResult("contact_supervisor", "sent"), events.toolEnd("contact_supervisor")] }, { jsonl: [events.assistantMessage("non-blocking update finished")] }] });
		const progressId = `async-non-blocking-update-${Date.now().toString(36)}`;
		executeAsyncSingle!(progressId, {
			agent: "worker",
			task: "Provide a short non-blocking status update only. Do not edit files.",
			agentConfig: makeAgent("worker", { acceptanceRole: "read-only" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});
		const progressPayload = await readAsyncPayload(progressId) as any;
		assert.equal(progressPayload.state, "complete");
		assert.equal(progressPayload.pause, undefined);

		mockPi.onCall({ steps: [{ jsonl: [events.toolStart("intercom", { action: "send", to: "main", message: "FYI" }), events.toolResult("intercom", "sent"), events.toolEnd("intercom")] }, { jsonl: [events.assistantMessage("intercom update finished")] }] });
		const intercomId = `async-non-blocking-intercom-${Date.now().toString(36)}`;
		executeAsyncSingle!(intercomId, {
			agent: "worker",
			task: "Provide a short non-blocking status update only. Do not edit files.",
			agentConfig: makeAgent("worker", { acceptanceRole: "read-only" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});
		const intercomPayload = await readAsyncPayload(intercomId) as any;
		assert.equal(intercomPayload.state, "complete");
		assert.equal(intercomPayload.pause, undefined);
		const existingPids = new Set(startedMockPiPids(mockPi));

		const cohortId = `async-supervisor-cohort-${Date.now().toString(36)}`;
		let runnerPid: number | undefined;
		mockPi.onCall({ matchArgIncludes: "complete setup", output: "setup complete" });
		mockPi.onCall({
			matchArgIncludes: "ask supervisor",
			steps: [{ delay: 200, jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need direction" })] }],
			keepAliveAfterFinalMessageMs: 5_000,
		});
		mockPi.onCall({ matchArgIncludes: "work in parallel", delay: 2_000, jsonl: [events.assistantMessage("parallel sibling should be interrupted")] });
		const started = executeAsyncChain!(cohortId, {
			chain: [
				{ agent: "a", task: "complete setup" },
				{ parallel: [{ agent: "b", task: "ask supervisor" }, { agent: "c", task: "work in parallel" }] },
				{ agent: "d", task: "must remain pending" },
			],
			agents: makeAgentConfigs(["a", "b", "c", "d"]),
			ctx: {
				pi: {
					events: {
						emit(event: string, payload: unknown) {
							if (event === "subagent:async-started" && payload && typeof payload === "object" && "pid" in payload) {
								runnerPid = (payload as { pid?: number }).pid;
							}
						},
					},
				},
				cwd: tempDir,
				currentSessionId: "session-1",
			},
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});
		assert.equal(started.isError, undefined);
		const asyncDir = path.join(ASYNC_DIR, cohortId);
		assert.ok(runnerPid, "expected async runner pid from started event");
		await waitForMockPiCall(mockPi, 4, 10_000);
		const childPids = startedMockPiPids(mockPi).filter((pid) => !existingPids.has(pid));
		assert.equal(childPids.length, 3);
		await waitForAsyncState(asyncDir, "paused", 10_000);
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as any;
		assert.deepEqual(status.steps?.map((step: any) => step.status), ["complete", "paused", "paused", "pending"]);
		const requesterIndex = status.steps?.findIndex((step: any) => step.pause?.kind === "awaiting_supervisor") ?? -1;
		assert.ok(requesterIndex >= 0);
		const cohortIndex = status.steps?.findIndex((step: any, index: number) => index !== requesterIndex && step.pause?.kind === "cohort_pause") ?? -1;
		assert.ok(cohortIndex >= 0);
		assert.equal(status.pid, undefined);
		await readAsyncPayload(cohortId);
		await waitForPidsToExit([runnerPid, ...childPids], `paused async cohort ${cohortId}`);
	});
});
