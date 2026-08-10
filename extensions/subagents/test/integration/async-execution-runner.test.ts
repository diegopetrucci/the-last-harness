/**
 * Integration tests for async execution – runner spawn/availability, readStatus,
 * ceilings, launch receipts, acceptance/task-shape conversion, and tool errors.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createEventBus,
	createMockPi,
	createTempDir,
	makeAgent,
	makeMinimalCtx,
	removeTempDir,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { deliverInterruptRequest } from "../../src/runs/background/control-channel.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import { writeAtomicJson } from "../../src/shared/atomic-json.ts";
import {
	ASYNC_DIR,
	type AsyncResultPayload,
	type AsyncStatusPayload,
	RESULTS_DIR,
	TEMP_ROOT_DIR,
	createSubagentExecutor,
	executeAsyncChain,
	executeAsyncSingle,
	isAsyncAvailable,
	readAsyncPayload,
	readMockPiArgs,
	readMockPiArgsMatching,
	readStatus,
	waitForAsyncControlCondition,
	waitForAsyncResultFile,
	waitForMockPiArgs,
	waitForMockPiCall,
} from "../support/async-execution-helpers.ts";

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
			state: {
				baseCwd: tempDir,
				currentSessionId: null,
				asyncJobs: new Map(),
				foregroundControls: new Map(),
				lastForegroundControlId: null,
			},
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents }),
		});
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
		process.execPath = path.join(
			tempDir,
			"deleted-node-install",
			"bin",
			process.platform === "win32" ? "node.exe" : "node",
		);
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
		mockPi.onCall({
			echoEnv: [
				"PI_SUBAGENT_INTERCOM_SESSION_NAME",
				"PI_SUBAGENT_ORCHESTRATOR_TARGET",
				"PI_SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH",
				"PI_SUBAGENT_RUN_ID",
				"PI_SUBAGENT_CHILD_AGENT",
				"PI_SUBAGENT_CHILD_INDEX",
			],
		});
		const id = `async-supervisor-reply-path-${Date.now().toString(36)}`;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Echo supervisor metadata",
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
			chain: [
				{
					parallel: [
						{ agent: "worker", task: "Do one" },
						{ agent: "reviewer", task: "Do two" },
					],
				},
			],
			resultMode: "parallel",
			agents: [makeAgent("worker"), makeAgent("reviewer")],
			...commonParams,
		});
		assert.match(parallelResult.content[0]?.text ?? "", /^Async parallel: .+ \[[^\]\n]+\]$/);
		assert.doesNotMatch(parallelResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.equal(parallelResult.content[0]?.text?.includes("\n"), false);
		const parallelResultPath = await waitForAsyncResultFile(parallelId, 10_000);
		const parallelPayload = JSON.parse(fs.readFileSync(parallelResultPath, "utf-8")) as {
			agent?: string;
			mode?: string;
		};
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
		const patchPayload = await readAsyncPayload(patchId);
		assert.equal(patchPayload.results[0]?.acceptance?.effectiveAcceptance?.level, "checked");

		const reviewId = `async-role-task-template-review-${Date.now().toString(36)}`;
		executeAsyncChain(reviewId, {
			task: "Review only; do not edit files",
			chain: [{ agent: "implementer", task: "{task}" }],
			agents: [makeAgent("implementer", { acceptanceRole: "writer" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-role-task-review" },
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
		const reviewPayload = await readAsyncPayload(reviewId);
		assert.equal(reviewPayload.results[0]?.acceptance?.effectiveAcceptance?.level, "attested");
	});

	it("top-level async parallel conversion preserves output, reads, and progress", async () => {
		mockPi.onCall({ output: "Async top-level report" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: {
				baseCwd: tempDir,
				currentSessionId: null,
				asyncJobs: new Map(),
				foregroundControls: new Map(),
				lastForegroundControlId: null,
			},
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
		const outputPath = path.join(
			tempDir,
			"parent-session",
			"subagent-artifacts",
			"outputs",
			asyncId,
			"async-top-output.md",
		);
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
			state: {
				baseCwd: tempDir,
				currentSessionId: null,
				asyncJobs: new Map(),
				foregroundControls: new Map(),
				lastForegroundControlId: null,
			},
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
			agents: [
				makeAgent("scout-a"),
				makeAgent("scout-b"),
				makeAgent("synthesizer"),
				makeAgent("review-a"),
				makeAgent("review-b"),
			],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-parallel-funnel-fanout" },
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

		assert.ok(!result.isError, `should launch: ${JSON.stringify(result.content)}`);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.success, true);
		assert.deepEqual(
			payload.results.map((entry) => entry.output),
			[
				"Scout A async findings",
				"Scout B async findings",
				"Async funnel synthesis",
				"Async reviewer A done",
				"Async reviewer B done",
			],
		);
		assert.deepEqual(
			status.steps?.map((step) => step.status),
			["complete", "complete", "complete", "complete", "complete"],
		);
		assert.deepEqual(status.parallelGroups, [
			{ start: 0, count: 2, stepIndex: 0 },
			{ start: 3, count: 2, stepIndex: 2 },
		]);
		const funnelTask = readMockPiArgsMatching(mockPi, "Synthesize:").at(-1) ?? "";
		assert.match(funnelTask, /=== Parallel Task 1 \(scout-a\) ===/);
		assert.match(funnelTask, /Scout A async findings/);
		assert.match(funnelTask, /=== Parallel Task 2 \(scout-b\) ===/);
		assert.match(funnelTask, /Scout B async findings/);
		assert.match(
			readMockPiArgsMatching(mockPi, "Review funnel A:").at(-1) ?? "",
			/Review funnel A:\nAsync funnel synthesis/,
		);
		assert.match(
			readMockPiArgsMatching(mockPi, "Review funnel B:").at(-1) ?? "",
			/Review funnel B:\nAsync funnel synthesis/,
		);
		assert.equal(payload.workflowGraph?.nodes?.[0]?.kind, "parallel-group");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.kind, "step");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[2]?.kind, "parallel-group");
		assert.equal(payload.workflowGraph?.nodes?.[2]?.status, "completed");
	});

	it("paused sequential resumes keep the later child session instead of a pre-launch sibling session", {
		skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined,
	}, async () => {
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

		const asyncDir = path.join(ASYNC_DIR, id);
		const statusPath = path.join(asyncDir, "status.json");
		const sessionDir = path.join(sessionRoot, `async-${id}`);
		const firstSessionFile = path.join(sessionDir, "first.jsonl");
		const secondSessionFile = path.join(sessionDir, "second.jsonl");

		await waitForAsyncControlCondition(asyncDir, (status) => status.steps?.[0]?.status === "running", 10_000);
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(firstSessionFile, "", "utf-8");
		await waitForAsyncControlCondition(
			asyncDir,
			(status) => status.steps?.[0]?.status === "complete" && status.steps?.[1]?.status === "running",
			10_000,
		);
		fs.writeFileSync(secondSessionFile, "", "utf-8");

		const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & {
			pid?: number;
		};
		deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

		const { status } = await waitForAsyncControlCondition(
			asyncDir,
			(current) => current.state === "paused" && current.steps?.[1]?.status === "paused",
			10_000,
		);
		assert.equal(status.steps?.[0]?.sessionFile, path.resolve(firstSessionFile));
		assert.equal(status.steps?.[1]?.sessionFile, path.resolve(secondSessionFile));
		const target = resolveAsyncResumeTarget({ id, index: 1 }, { asyncDirRoot: ASYNC_DIR, resultsDir: RESULTS_DIR });
		assert.equal(target.kind, "revive");
		assert.equal(target.sessionFile, path.resolve(secondSessionFile));
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
});
