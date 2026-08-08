import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { executeAsyncChain, executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import { ASYNC_DIR, RESULTS_DIR, SUBAGENT_ASYNC_STARTED_EVENT, type SubagentState } from "../../src/shared/types.ts";
import { makeAgent, makeMinimalCtx } from "../support/helpers.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

function createState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function createEvents() {
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	return {
		emitted,
		api: {
			emit(channel: string, payload: unknown) {
				emitted.push({ channel, payload });
			},
			on() {
				return () => {};
			},
		},
	};
}

function createExecutor(
	root: string,
	events = createEvents(),
	agents = [makeAgent("worker"), makeAgent("producer"), makeAgent("reviewer")],
) {
	return {
		events,
		executor: createSubagentExecutor({
			pi: {
				events: events.api,
				getSessionName() {
					return "parent";
				},
			} as any,
			state: createState(),
			config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as any,
			asyncByDefault: false,
			tempArtifactsDir: root,
			getSubagentSessionRoot: (parentSessionFile) =>
				parentSessionFile
					? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl"))
					: root,
			expandTilde: (value) => value,
			discoverAgents: () => ({ agents }),
			kill: () => true,
		}),
	};
}

function assertReviewedRejection(text: string): void {
	assert.match(text, /reviewed/);
	assert.match(text, /verified/);
	assert.match(text, /verify commands/);
	assert.match(text, /checked/);
}

describe("reviewed dispatch route preflight", () => {
	it("rejects reviewed acceptance through supported foreground single and parallel routes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reviewed-foreground-"));
		tempDirs.push(root);
		const { executor } = createExecutor(root);
		const cases: Array<{ label: string; params: Record<string, unknown> }> = [
			{
				label: "single",
				params: { agent: "worker", task: "Implement fix", acceptance: { level: "reviewed", review: false } },
			},
			{
				label: "parallel",
				params: { tasks: [{ agent: "worker", task: "Implement fix", acceptance: "reviewed" }] },
			},
		];

		for (const testCase of cases) {
			const result = await executor.execute(
				`reviewed-${testCase.label}`,
				testCase.params,
				new AbortController().signal,
				undefined,
				makeMinimalCtx(root),
			);
			assert.equal(result.isError, true, testCase.label);
			assertReviewedRejection(result.content[0]?.text ?? "");
		}
	});

	it("rejects reviewed acceptance through direct async single and chain entry points before artifacts are created", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reviewed-async-"));
		tempDirs.push(root);
		const singleId = `reviewed-single-${Date.now().toString(36)}`;
		const single = executeAsyncSingle(singleId, {
			agent: "worker",
			task: "Implement fix",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: root, currentSessionId: "session" },
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
			acceptance: { level: "reviewed", review: false },
		});
		assert.equal(single.isError, true);
		assertReviewedRejection(single.content[0]?.text ?? "");
		assert.equal(fs.existsSync(path.join(ASYNC_DIR, singleId)), false);
		assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${singleId}.json`)), false);

		const chainCases: Array<{ id: string; chain: Array<Record<string, unknown>> }> = [
			{
				id: `reviewed-chain-sequential-${Date.now().toString(36)}`,
				chain: [{ agent: "worker", task: "Implement fix", acceptance: "reviewed" }],
			},
			{
				id: `reviewed-chain-static-${Date.now().toString(36)}`,
				chain: [{ parallel: [{ agent: "worker", task: "Implement fix", acceptance: "reviewed" }] }],
			},
		];

		for (const testCase of chainCases) {
			const result = executeAsyncChain(testCase.id, {
				chain: testCase.chain as any,
				agents: [makeAgent("worker"), makeAgent("producer"), makeAgent("reviewer")],
				ctx: { pi: { events: { emit() {} } }, cwd: root, currentSessionId: "session" },
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
			assert.equal(result.isError, true, testCase.id);
			assertReviewedRejection(result.content[0]?.text ?? "");
			assert.equal(fs.existsSync(path.join(ASYNC_DIR, testCase.id)), false, testCase.id);
			assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${testCase.id}.json`)), false, testCase.id);
		}
	});

	it("rejects unsupported chain attachment on resume before launching async work", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reviewed-resume-"));
		tempDirs.push(root);
		const sourceRunId = `resume-reviewed-${Date.now().toString(36)}`;
		const sourceAsyncDir = path.join(ASYNC_DIR, sourceRunId);
		const sourceSession = path.join(root, "child-session.jsonl");
		const sourceResultPath = path.join(RESULTS_DIR, `${sourceRunId}.json`);
		fs.mkdirSync(sourceAsyncDir, { recursive: true });
		fs.mkdirSync(RESULTS_DIR, { recursive: true });
		fs.writeFileSync(sourceSession, "", "utf-8");
		fs.writeFileSync(
			path.join(sourceAsyncDir, "status.json"),
			JSON.stringify(
				{
					runId: sourceRunId,
					mode: "single",
					state: "running",
					pid: process.pid,
					startedAt: 1,
					lastUpdate: 1,
					cwd: root,
					steps: [{ agent: "worker", status: "running", sessionFile: sourceSession }],
				},
				null,
				2,
			),
			"utf-8",
		);
		fs.writeFileSync(
			sourceResultPath,
			JSON.stringify(
				{
					id: sourceRunId,
					agent: "worker",
					mode: "single",
					success: true,
					state: "complete",
					results: [{ agent: "worker", output: "root output", success: true, sessionFile: sourceSession }],
				},
				null,
				2,
			),
			"utf-8",
		);
		const { executor, events } = createExecutor(root);

		const result = await executor.execute(
			"resume-reviewed-attach",
			{
				action: "resume",
				id: sourceRunId,
				chain: [{ agent: "reviewer", task: "Review the attached root", acceptance: "reviewed" }],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(root),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Saved chains are deliberately unsupported in The Last Harness/);
		assert.equal(result.details?.asyncId, undefined);
		assert.equal(
			events.emitted.some((entry) => entry.channel === SUBAGENT_ASYNC_STARTED_EVENT),
			false,
		);
	});
});
