/**
 * Shared infrastructure for the async-execution integration test suite.
 *
 * Extracted from async-execution.test.ts to allow the suite to be split into
 * multiple thematic files without duplicating setup code.  This module is NOT
 * a test file (no *.test.ts suffix) so suite-discovery in
 * scripts/run-subagents-tests.mjs does not pick it up.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tryImport } from "./helpers.ts";
import type { MockPi } from "./helpers.ts";
import { scaleTestTimeout } from "./scale-timeout.ts";

export type { MockPi };

// ---------------------------------------------------------------------------
// Shared interfaces
// ---------------------------------------------------------------------------

export interface AsyncExecutionResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details: { asyncId?: string; timeoutMs?: number; deadlineAt?: number };
}

export interface AsyncResultPayload {
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
	turnBudget?: {
		maxTurns: number;
		graceTurns: number;
		outcome: string;
		turnCount: number;
		wrapUpRequestedAtTurn?: number;
		exceededAtTurn?: number;
	};
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
		turnBudget?: {
			maxTurns: number;
			graceTurns: number;
			outcome: string;
			turnCount: number;
			wrapUpRequestedAtTurn?: number;
			exceededAtTurn?: number;
		};
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
		acceptance?: {
			status?: string;
			effectiveAcceptance?: { level?: string };
			childReport?: unknown;
			runtimeChecks?: Array<{ id?: string; status?: string; message?: string }>;
		};
		processCleanup?: {
			attempted?: boolean;
			terminated?: boolean;
			processGroupId?: number;
			liveProcessesDetected?: boolean;
			skippedReason?: string;
		};
	}>;
	outputs?: Record<string, { text?: string; structured?: unknown }>;
	workflowGraph?: {
		nodes?: Array<{
			kind?: string;
			label?: string;
			phase?: string;
			status?: string;
			acceptanceStatus?: string;
			error?: string;
			outputName?: string;
			structured?: boolean;
			children?: Array<{
				label?: string;
				outputName?: string;
				itemKey?: string;
				status?: string;
				acceptanceStatus?: string;
				error?: string;
			}>;
		}>;
	};
}

export interface AsyncStatusPayload {
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
	turnBudget?: {
		maxTurns: number;
		graceTurns: number;
		outcome: string;
		turnCount: number;
		wrapUpRequestedAtTurn?: number;
		exceededAtTurn?: number;
	};
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
		turnBudget?: {
			maxTurns: number;
			graceTurns: number;
			outcome: string;
			turnCount: number;
			wrapUpRequestedAtTurn?: number;
			exceededAtTurn?: number;
		};
		turnBudgetExceeded?: boolean;
		wrapUpRequested?: boolean;
		sessionFile?: string;
		recentOutput?: string[];
	}>;
}

export interface MockPiCallRecord {
	args?: string[];
	systemPrompts?: Array<{ mode?: string; path?: string; text?: string; error?: string }>;
}

// ---------------------------------------------------------------------------
// Private module-level interfaces for tryImport
// ---------------------------------------------------------------------------

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
		execute: (
			...args: unknown[]
		) => Promise<{ content: Array<{ text?: string }>; isError?: boolean; details?: { asyncId?: string } }>;
	};
}

interface ControlChannelModule {
	requestAsyncInterrupt(asyncDir: string, payload?: { ts?: number; source?: string; reason?: string }): string;
}

// ---------------------------------------------------------------------------
// Module-level imports (shared across all test files)
// ---------------------------------------------------------------------------

const asyncMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
const typesMod = await tryImport<TypesModule>("./src/shared/types.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const controlChannelMod = await tryImport<ControlChannelModule>("./src/runs/background/control-channel.ts");

export const isAsyncAvailable = asyncMod.isAsyncAvailable;
export const executeAsyncSingle = asyncMod.executeAsyncSingle;
export const executeAsyncChain = asyncMod.executeAsyncChain;
export const readStatus = utils.readStatus;
export const ASYNC_DIR = typesMod.ASYNC_DIR;
export const RESULTS_DIR = typesMod.RESULTS_DIR;
export const TEMP_ROOT_DIR = typesMod.TEMP_ROOT_DIR;
export const createSubagentExecutor = executorMod.createSubagentExecutor;
export const requestAsyncInterrupt = controlChannelMod.requestAsyncInterrupt;

assert.equal(isAsyncAvailable(), true, "required async runner module is unavailable");

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

export function mockAssistantMessage(text: string, stopReason: "stop" | "tool_use" = "stop") {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content:
				stopReason === "tool_use"
					? [
							{ type: "text", text },
							{ type: "toolCall", name: "bash", arguments: { command: "echo test" } },
						]
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

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

export function createRepo(prefix: string): string {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repoDir, ["init"]);
	git(repoDir, ["config", "user.email", "tests@example.com"]);
	git(repoDir, ["config", "user.name", "Async Tests"]);
	fs.writeFileSync(path.join(repoDir, "input.md"), "input\n", "utf-8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-m", "initial commit"]);
	return repoDir;
}

export function writePackageSkill(packageRoot: string, skillName: string): void {
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

// ---------------------------------------------------------------------------
// Wait / polling helpers
// ---------------------------------------------------------------------------

export async function waitForAsyncResultFile(id: string, timeoutMs = scaleTestTimeout(15_000)): Promise<string> {
	const resultPath = path.join(RESULTS_DIR, `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(resultPath)) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return resultPath;
}

export async function waitForAsyncState(
	asyncDir: string,
	state: string,
	timeoutMs = scaleTestTimeout(15_000),
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (readStatus(asyncDir)?.state !== state) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async state '${state}' in ${asyncDir}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

export async function waitForAsyncStatusPredicate(
	asyncDir: string,
	predicate: (status: AsyncStatusPayload) => boolean,
	label: string,
	timeoutMs = scaleTestTimeout(15_000),
): Promise<AsyncStatusPayload> {
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

export async function waitForAsyncControlCondition(
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

export async function waitForMockPiCall(
	mockPi: MockPi,
	index: number,
	timeoutMs = scaleTestTimeout(30_000),
): Promise<{ args: string[]; systemPrompts: NonNullable<MockPiCallRecord["systemPrompts"]> }> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const callFile = fs
			.readdirSync(mockPi.dir)
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

export async function waitForMockPiArgs(
	mockPi: MockPi,
	index: number,
	timeoutMs = scaleTestTimeout(30_000),
): Promise<string[]> {
	return (await waitForMockPiCall(mockPi, index, timeoutMs)).args;
}

export function readLastMockPiArgs(mockPi: MockPi): string[] {
	const callFile = fs
		.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(-1);
	assert.ok(callFile, "expected a recorded mock pi call");
	const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
	assert.ok(Array.isArray(payload.args), "expected recorded args");
	return payload.args;
}

export function readMockPiArgs(mockPi: MockPi, index: number): string[] {
	const callFile = fs
		.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(index);
	assert.ok(callFile, `expected recorded call ${index}`);
	const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
	assert.ok(Array.isArray(payload.args), "expected recorded args");
	return payload.args;
}

export function readMockPiArgsMatching(mockPi: MockPi, text: string): string[] {
	const callFiles = fs
		.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort();
	for (const callFile of callFiles) {
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[] };
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		if (payload.args.join("\n").includes(text)) return payload.args;
	}
	assert.fail(`expected recorded call containing ${text}`);
}

export function startedMockPiPids(mockPi: MockPi): number[] {
	return fs
		.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.map((name) => Number(name.split("-")[2]))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function waitForMockPiSignal(
	mockPi: MockPi,
	pid: number,
	signal: "SIGINT" | "SIGTERM",
	timeoutMs = scaleTestTimeout(10_000),
): Promise<void> {
	const signalLogPath = path.join(mockPi.dir, `signals-${pid}.jsonl`);
	const deadline = Date.now() + timeoutMs;
	while (true) {
		if (fs.existsSync(signalLogPath)) {
			const entries = fs
				.readFileSync(signalLogPath, "utf-8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { signal?: string });
			if (entries.some((entry) => entry.signal === signal)) return;
		}
		if (Date.now() > deadline) assert.fail(`Timed out waiting for mock pid ${pid} to record ${signal}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

export function assertPidExited(pid: number | undefined, label: string): void {
	assert.ok(typeof pid === "number" && pid > 0, `expected pid for ${label}`);
	try {
		process.kill(pid, 0);
		assert.fail(`Expected ${label} pid ${pid} to be gone`);
	} catch (error) {
		assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
	}
}

export async function waitForPidsToExit(
	pids: Array<number | undefined>,
	label: string,
	timeoutMs = scaleTestTimeout(10_000),
): Promise<void> {
	const live = pids.filter((pid): pid is number => typeof pid === "number" && pid > 0);
	const deadline = Date.now() + timeoutMs;
	while (
		live.some((pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch (error) {
				return !(
					error &&
					typeof error === "object" &&
					"code" in error &&
					(error as NodeJS.ErrnoException).code === "ESRCH"
				);
			}
		})
	) {
		if (Date.now() > deadline) {
			assert.fail(`Timed out waiting for ${label} to exit: ${live.join(", ")}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

// ---------------------------------------------------------------------------
// Lifecycle lock helpers
// ---------------------------------------------------------------------------

export function lifecycleLockDir(asyncDir: string): string {
	return path.join(asyncDir, ".lifecycle-transition.lock");
}

export function writeLifecycleLock(asyncDir: string): void {
	const lockDir = lifecycleLockDir(asyncDir);
	fs.mkdirSync(lockDir, { recursive: true });
	fs.writeFileSync(
		path.join(lockDir, "owner.json"),
		JSON.stringify({ pid: 999999, acquiredAt: Date.now() }, null, 2),
		"utf-8",
	);
}

export function removeLifecycleLock(asyncDir: string): void {
	fs.rmSync(lifecycleLockDir(asyncDir), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// readAsyncPayload – thin wrapper used across all suites
// ---------------------------------------------------------------------------

export async function readAsyncPayload(id: string): Promise<AsyncResultPayload> {
	const resultPath = await waitForAsyncResultFile(id, 10_000);
	return JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
}
