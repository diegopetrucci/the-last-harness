/**
 * Integration tests for async execution – interrupt, timeout, hard-kill,
 * turn budget, drain/cleanup, and relocated supervisor lifecycle tests.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockPi, createTempDir, events, makeAgent, removeTempDir } from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { deliverInterruptRequest } from "../../src/runs/background/control-channel.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import { reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import {
	transitionLifecycleStatus,
	withLifecycleContinuation,
	lifecycleGeneration,
} from "../../src/runs/shared/lifecycle-state.ts";
import {
	ASYNC_DIR,
	type AsyncResultPayload,
	type AsyncStatusPayload,
	RESULTS_DIR,
	executeAsyncChain,
	executeAsyncSingle,
	mockAssistantMessage,
	readAsyncPayload,
	removeLifecycleLock,
	requestAsyncInterrupt,
	startedMockPiPids,
	waitForAsyncResultFile,
	waitForAsyncState,
	waitForAsyncStatusPredicate,
	waitForMockPiCall,
	waitForMockPiSignal,
	waitForPidsToExit,
	writeLifecycleLock,
} from "../support/async-execution-helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";

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

	it("interrupts every active async parallel child", {
		skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined,
	}, async () => {
		mockPi.onCall({ delay: 5_000, output: "one done" });
		mockPi.onCall({ delay: 5_000, output: "two done" });
		mockPi.onCall({ delay: 5_000, output: "three done" });
		const id = `async-interrupt-parallel-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [
				{
					parallel: [
						{ agent: "one", task: "Wait", acceptance: { level: "checked", criteria: ["Complete one"] } },
						{ agent: "two", task: "Wait", acceptance: { level: "checked", criteria: ["Complete two"] } },
						{ agent: "three", task: "Wait", acceptance: { level: "checked", criteria: ["Complete three"] } },
					],
					concurrency: 3,
				},
			],
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
		const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & {
			pid?: number;
		};
		deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

		const resultPath = await waitForAsyncResultFile(id, 30_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		const eventLog = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
		assert.equal(payload.state, "paused");
		assert.equal(payload.success, false);
		assert.deepEqual(
			payload.results.map((result) => result.acceptance?.status),
			["skipped", "skipped", "skipped"],
		);
		assert.deepEqual(
			status.steps?.map((step) => step.status),
			["paused", "paused", "paused"],
		);
		assert.deepEqual(
			status.steps?.map((step) => step.acceptance?.status),
			["skipped", "skipped", "skipped"],
		);
		assert.match(eventLog, /"type":"subagent.step.paused"/);
		assert.doesNotMatch(eventLog, /"type":"subagent.parallel.completed"/);
		assert.equal(mockPi.callCount(), 3);
	});

	it("parallel interrupt: each paused child retains its own discovered session file (F1+F2)", {
		skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined,
	}, async () => {
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
				chain: [
					{
						parallel: [
							{ agent: "alpha", task: "Wait", acceptance: { level: "checked", criteria: ["Complete alpha"] } },
							{ agent: "beta", task: "Wait", acceptance: { level: "checked", criteria: ["Complete beta"] } },
						],
						concurrency: 2,
					},
				],
				resultMode: "parallel",
				agents: [makeAgent("alpha"), makeAgent("beta")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-f1f2" },
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
				sessionRoot,
			});

			// Wait for both children to be running before delivering the interrupt.
			await waitForMockPiCall(mockPi, 1, 10_000);
			const asyncDir = path.join(ASYNC_DIR, id);
			const statusPath = path.join(asyncDir, "status.json");
			const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & {
				pid?: number;
			};
			deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

			const resultPath = await waitForAsyncResultFile(id, 30_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;

			// Both children must be paused with skipped acceptance.
			assert.deepEqual(
				status.steps?.map((s) => s.status),
				["paused", "paused"],
			);
			assert.deepEqual(
				status.steps?.map((s) => s.acceptance?.status),
				["skipped", "skipped"],
			);
			assert.equal(payload.state, "paused");

			// F1: each paused child in the status file has its OWN distinct session file.
			const stepSessionFiles = status.steps?.map((s) => s.sessionFile);
			assert.ok(stepSessionFiles?.[0], "paused child 0 must have a session file in status");
			assert.ok(stepSessionFiles?.[1], "paused child 1 must have a session file in status");
			assert.notEqual(
				stepSessionFiles?.[0],
				stepSessionFiles?.[1],
				"each paused child must have its OWN session file, not a shared one",
			);

			// F2: the result artifact also carries each child's discovered session file.
			const resultSessionFiles = payload.results.map((r) => r.sessionFile);
			assert.ok(resultSessionFiles[0], "result artifact child 0 must carry a session file");
			assert.ok(resultSessionFiles[1], "result artifact child 1 must carry a session file");
			assert.notEqual(
				resultSessionFiles[0],
				resultSessionFiles[1],
				"result artifact per-child session files must be distinct",
			);

			// Cross-check: result session files match status session files.
			assert.equal(resultSessionFiles[0], stepSessionFiles?.[0]);
			assert.equal(resultSessionFiles[1], stepSessionFiles?.[1]);
		} finally {
			if (originalSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
			else process.env.MOCK_PI_SESSION_DIR_FILE = originalSessionDirFile;
		}
	});

	it("result-only revival reads session + paused state from result artifact when status dir is absent (F3)", {
		skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined,
	}, async () => {
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
				chain: [
					{
						parallel: [
							{ agent: "alpha", task: "Wait", acceptance: { level: "checked", criteria: ["Complete alpha"] } },
							{ agent: "beta", task: "Wait", acceptance: { level: "checked", criteria: ["Complete beta"] } },
						],
						concurrency: 2,
					},
				],
				resultMode: "parallel",
				agents: [makeAgent("alpha"), makeAgent("beta")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-f3" },
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
				sessionRoot,
			});

			await waitForMockPiCall(mockPi, 1, 10_000);
			const runAsyncDir = path.join(ASYNC_DIR, id);
			const statusPath = path.join(runAsyncDir, "status.json");
			const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & {
				pid?: number;
			};
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
				try {
					fs.renameSync(renamedDir, runAsyncDir);
				} catch {
					/* best effort */
				}
			}
		} finally {
			if (originalSessionDirFile === undefined) delete process.env.MOCK_PI_SESSION_DIR_FILE;
			else process.env.MOCK_PI_SESSION_DIR_FILE = originalSessionDirFile;
		}
	});

	it("marks interrupted async chain steps as paused with skipped acceptance", {
		skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined,
	}, async () => {
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
		const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & {
			pid?: number;
		};
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

	it("enforces mixed async child ceilings independently", {
		skip: process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined,
	}, async () => {
		mockPi.onCall({ matchArgIncludes: "Short async ceiling", delay: 5_000 });
		mockPi.onCall({ matchArgIncludes: "Long async ceiling", output: "long ceiling completed" });
		const id = `async-mixed-ceilings-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [
				{
					parallel: [
						{ agent: "short", task: "Short async ceiling" },
						{ agent: "long", task: "Long async ceiling" },
					],
					concurrency: 2,
				},
			],
			resultMode: "parallel",
			agents: [
				makeAgent("short", { maxExecutionTimeMs: 100 }),
				makeAgent("long", { maxExecutionTimeMs: 2_147_483_648 }),
			],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactsDir: path.join(tempDir, "artifacts-mixed-ceilings"),
			artifactConfig: {
				enabled: true,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: true,
				cleanupDays: 7,
			},
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
			const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as {
				timeoutMs?: number;
				deadlineAt?: number;
			};
			assert.equal(metadata.timeoutMs, status.steps?.[index]?.timeoutMs);
			assert.equal(metadata.deadlineAt, status.steps?.[index]?.deadlineAt);
		}
	});

	it("marks async parallel runs that exceed timeoutMs as timed out", {
		skip: process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined,
	}, async () => {
		mockPi.onCall({ delay: 5_000, output: "one done" });
		mockPi.onCall({ delay: 5_000, output: "two done" });
		const id = `async-timeout-parallel-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [
				{
					parallel: [
						{ agent: "one", task: "Wait" },
						{ agent: "two", task: "Wait" },
					],
					concurrency: 2,
				},
			],
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
		assert.deepEqual(
			status.steps?.map((step) => step.status),
			["failed", "failed"],
		);
		assert.deepEqual(
			status.steps?.map((step) => step.timedOut),
			[true, true],
		);
		assert.deepEqual(
			status.steps?.map((step) => step.error),
			["Subagent timed out after 1500ms.", "Subagent timed out after 1500ms."],
		);
		assert.deepEqual(
			payload.results.map((result) => result.timedOut),
			[true, true],
		);
		assert.equal(mockPi.callCount(), 2);
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
				verify: [
					{ id: "slow", command: `${process.execPath} -e "setTimeout(()=>process.exit(0), 30000)"`, timeoutMs: 60_000 },
				],
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
		assert.ok(
			elapsedMs < timeoutMs + 4_000,
			`timeout should cancel acceptance verification well before the verify command completes, elapsed ${elapsedMs}ms`,
		);
	});

	it("interrupts async acceptance verification and returns a paused result", {
		skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined,
	}, async () => {
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
				verify: [
					{ id: "slow", command: `${process.execPath} -e "setTimeout(()=>process.exit(0), 5000)"`, timeoutMs: 10_000 },
				],
			},
		});

		const asyncDir = path.join(ASYNC_DIR, id);
		const statusPath = path.join(asyncDir, "status.json");
		await waitForMockPiCall(mockPi, 0, 10_000);
		await waitForAsyncState(asyncDir, "running");
		const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & {
			pid?: number;
		};
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
		assert.ok(
			elapsed < 9000,
			`should clean up async child before the mock's natural keepalive exit, took ${elapsed}ms`,
		);
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
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(
			elapsed < 9000,
			`should clean up async child before the mock's natural keepalive exit, took ${elapsed}ms`,
		);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "");
	});

	it("background final-drain cleanup preserves explicit assistant errors", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "failed" }],
						model: "mock/test-model",
						stopReason: "stop",
						errorMessage: "provider exploded",
						usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					},
				},
			],
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-error-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

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
		skip: process.platform === "win32" ? "owned process-group cleanup unsupported on win32" : undefined,
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

	it("fails closed instead of publishing paused awaiting-supervisor while a nested descendant remains active", {
		skip: process.platform === "win32" ? "cross-process supervisor pause delivery unreliable on Windows CI" : undefined,
	}, async () => {
		const id = `async-supervisor-nested-active-${Date.now().toString(36)}`;
		const nestedRoute = createNestedRoute(id);
		try {
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				],
				ignoreSigint: true,
				keepAliveAfterFinalMessageMs: 5_000,
			});
			executeAsyncSingle!(id, {
				agent: "worker",
				task: "Ask for a supervisor decision and stop there.",
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
				nestedRoute,
			});
			const asyncDir = path.join(ASYNC_DIR, id);
			const pausingStatus = await waitForAsyncStatusPredicate(
				asyncDir,
				(status) =>
					status.state === "pausing" && typeof (status as AsyncStatusPayload & { pid?: number }).pid === "number",
				"pausing before nested descendant gate",
			);
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
			const persistedStatus = JSON.parse(
				fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
			) as AsyncStatusPayload;
			assert.equal(payload.state, "failed");
			assert.equal(payload.pause, undefined);
			assert.equal(
				payload.summary,
				"Async supervisor lifecycle update failed. The run was stopped safely and marked failed.",
			);
			assert.equal(
				payload.error,
				"Async supervisor lifecycle update failed. The run was stopped safely and marked failed.",
			);
			assert.equal(persistedStatus.state, "failed");
			assert.equal((persistedStatus as AsyncStatusPayload & { pid?: number }).pid, undefined);
			assert.equal(persistedStatus.pause, undefined);
			assert.equal(persistedStatus.steps?.[0]?.processCleanup?.terminated, true);
			await waitForPidsToExit(
				[pausingStatus.pid as number | undefined, ...startedMockPiPids(mockPi)],
				`failed async supervisor nested descendant ${id}`,
			);
		} finally {
			fs.rmSync(path.dirname(nestedRoute.eventSink), { recursive: true, force: true });
		}
	});

	it("reconciles a post-checkpoint supervisor finalization lock failure to the paused awaiting-supervisor outcome", {
		skip: process.platform === "win32" ? "cross-process supervisor pause delivery unreliable on Windows CI" : undefined,
	}, async () => {
		const id = `async-supervisor-lock-final-${Date.now().toString(36)}`;
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
			],
			ignoreSigint: true,
			ignoreSigterm: true,
			keepAliveAfterFinalMessageMs: 30_000,
		});
		executeAsyncSingle!(id, {
			agent: "worker",
			task: "Ask for a supervisor decision and stop there.",
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
		const asyncDir = path.join(ASYNC_DIR, id);
		const pausingStatus = await waitForAsyncStatusPredicate(
			asyncDir,
			(status) =>
				status.state === "pausing" && typeof (status as AsyncStatusPayload & { pid?: number }).pid === "number",
			"pausing pid before finalization lock contention",
		);
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
		await waitForPidsToExit(
			[pausingStatus.pid as number | undefined, ...childPids],
			`paused async supervisor finalization ${id}`,
		);
		removeLifecycleLock(asyncDir);
		const repaired = reconcileAsyncRun(asyncDir, { resultsDir: RESULTS_DIR, now: () => Date.now() });
		assert.equal(typeof repaired.repaired, "boolean");
		assert.equal(repaired.status?.state, "paused");
		assert.equal(repaired.status?.pause?.kind, "awaiting_supervisor");
		const reconciledStatus = JSON.parse(
			fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
		) as AsyncStatusPayload;
		assert.equal(reconciledStatus.state, "paused");
		assert.equal(reconciledStatus.pause?.kind, "awaiting_supervisor");
	});

	// ── Regression test for tlhm-8typ: post-pause source-runner write race ───────
	//
	// When a source runner writes status after a paused checkpoint (e.g. after an
	// interrupted child settles), it must not clobber a continuation reservation
	// that a concurrent resume actor committed between the paused checkpoint and
	// the post-child write. The test exercises the REAL background runner and
	// coordinates via marker files — no wall-clock sleeps, no hardcoded counts.
	//
	// Proof of non-vacuousness: revert the `if (interrupted)` routing in
	// writeStatusPayload (using bare writeNormalizedLifecycleStatus instead of
	// mergeAndWriteSourceRunnerStatus) and this test FAILS with:
	//   "reservation must survive the post-child source-runner status write".
	// Restoring the routing makes it PASS.
	it("post-pause source-runner status write preserves a concurrent continuation reservation (tlhm-8typ)", {
		skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined,
	}, async () => {
		// Marker-file rendezvous: child signals when it is executing, then blocks
		// until the test releases it. This lets us insert the reservation after the
		// paused checkpoint but before the post-child write — deterministically.
		const markerDir = path.join(tempDir, "tlhm-8typ-markers");
		fs.mkdirSync(markerDir, { recursive: true });
		const readyMarker = path.join(markerDir, "child-ready");
		const releaseMarker = path.join(markerDir, "child-release");

		// Mock child writes the ready marker, then blocks until the release marker
		// appears. SIGINT is ignored so the child survives the interrupt and keeps
		// blocking; the test controls when it exits via the release marker.
		mockPi.onCall({
			ignoreSigint: true,
			ignoreSigterm: true,
			steps: [{ writeMarker: readyMarker }, { waitForMarker: releaseMarker }],
			output: "child work complete",
		});

		const id = `tlhm8typ-reservation-race-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-tlhm8typ" },
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

		const asyncDir = path.join(ASYNC_DIR, id);

		// ── Step 1: wait for the child to signal it is blocking (no sleep) ──────
		// Safety deadline scales with TLH_TEST_TIMEOUT_SCALE so CI (3x) gets the
		// same headroom as spawn-heavy helper defaults.
		{
			const deadline = Date.now() + scaleTestTimeout(20_000);
			while (!fs.existsSync(readyMarker)) {
				if (Date.now() > deadline) assert.fail("Timed out waiting for mock child ready marker");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}

		// ── Step 2: interrupt the source runner so it pauses ─────────────────────
		// requestAsyncInterrupt uses the control-channel file so it works across
		// platforms without sending OS signals to the test process.
		requestAsyncInterrupt(asyncDir, { source: "tlhm-8typ-test" });

		// ── Step 3: wait for the first paused checkpoint ─────────────────────────
		// This is the disk state the source runner holds in in-memory; any write
		// after this point that does not go through mergeAndWriteSourceRunnerStatus
		// would clobber a concurrent reservation.
		await waitForAsyncState(asyncDir, "paused");

		const pausedStatusRaw = JSON.parse(
			fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
		) as AsyncStatusPayload;
		const pausedGen = lifecycleGeneration(pausedStatusRaw as Parameters<typeof lifecycleGeneration>[0]);

		// ── Step 4: inject a continuation reservation (simulates resume actor) ───
		const reservedClaimToken = "tlhm8typ-test-claim";
		const reservedRunId = "tlhm8typ-test-continuation";
		transitionLifecycleStatus({
			asyncDir,
			expectedGeneration: pausedGen,
			mutate: (status) => ({
				...status,
				lifecycle: withLifecycleContinuation(status, 0, {
					phase: "reserved" as const,
					claimToken: reservedClaimToken,
					claimedAt: Date.now(),
					ownerPid: process.pid,
					continuationRunId: reservedRunId,
				}),
			}),
		});

		// Disk now has the reservation at pausedGen + 1.
		const afterReservation = JSON.parse(
			fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
		) as AsyncStatusPayload;
		assert.equal(
			afterReservation.lifecycle?.continuation?.phase,
			"reserved",
			"sanity: reservation must be on disk before releasing the child",
		);

		// ── Step 5: release the blocking child ───────────────────────────────────
		// The child exits normally. The source runner will call writeStatusPayload()
		// after the child settles (with interrupted=true), which is the write path
		// that used to clobber the reservation before the fix.
		fs.writeFileSync(releaseMarker, "", "utf-8");

		// ── Step 6: wait for the result artifact ─────────────────────────────────
		const resultPath = await waitForAsyncResultFile(id);

		// ── Assertions ───────────────────────────────────────────────────────────
		const finalStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		const resultPayload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;

		// The reservation must survive every post-child source-runner status write.
		// Without the fix (bare writeNormalizedLifecycleStatus), the reservation
		// would be erased here and the test would fail.
		assert.equal(
			finalStatus.lifecycle?.continuation?.phase,
			"reserved",
			"reservation must survive the post-child source-runner status write",
		);
		assert.equal(finalStatus.lifecycle?.continuation?.claimToken, reservedClaimToken);
		assert.equal(finalStatus.lifecycle?.continuation?.continuationRunId, reservedRunId);

		// The result artifact must exist: the source runner wrote it cleanly despite
		// the interrupted+reservation scenario.
		assert.equal(
			resultPayload.state,
			"paused",
			"result artifact must reflect the paused state from the interrupted run",
		);
		assert.ok(resultPayload.results.length > 0, "result artifact must carry child results");
	});

	// ── Regression test for tlhm-8typ round 5 FIX 10 + FIX 11: ordinary-interrupt
	// terminal-override path ────────────────────────────────────────────────────
	//
	// When a source runner with NO supervisorPauseRequest (ordinary interrupt) goes
	// through writeStatusPayload and the merge finds a concurrent terminal winner on
	// disk, adoptConcurrentTerminalStatus must be called in-memory immediately.
	// Before the fix the stale-generation trick only helped inside the
	// supervisorPauseRequest CAS block, which is skipped for ordinary interrupts, so
	// resultState fell through to `interrupted ? "paused" : ...` and the artifact
	// incorrectly said `state: "paused"` — contradicting the persisted terminal winner.
	//
	// Proof of non-vacuousness: revert the FIX 10 branch in writeStatusPayload to
	// the round-4 `if (!TERMINAL_RUN_STATES.has(merged.state) || merged.state ===
	// statusPayload.state)` form (which skips adoption) and this test FAILS with:
	//   "result artifact must reflect the adopted cancelled state, not stale paused".
	it("ordinary-interrupt terminal override: artifact reflects the concurrent terminal winner (tlhm-8typ r5)", {
		skip: process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined,
	}, async () => {
		const markerDir = path.join(tempDir, "tlhm-8typ-r5-markers");
		fs.mkdirSync(markerDir, { recursive: true });
		const readyMarker = path.join(markerDir, "child-ready");
		const releaseMarker = path.join(markerDir, "child-release");

		// Mock child writes the ready marker and blocks until the release marker
		// appears. SIGINT/SIGTERM are ignored so the child survives the ordinary
		// interrupt and remains blocked; the test controls exit via the release marker.
		mockPi.onCall({
			ignoreSigint: true,
			ignoreSigterm: true,
			steps: [{ writeMarker: readyMarker }, { waitForMarker: releaseMarker }],
			output: "child work complete",
		});

		const id = `tlhm8typ-r5-terminal-override-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-tlhm8typ-r5" },
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

		const asyncDir = path.join(ASYNC_DIR, id);

		// ── Step 1: wait for the child to signal it is blocking ──────────────────
		{
			const deadline = Date.now() + scaleTestTimeout(20_000);
			while (!fs.existsSync(readyMarker)) {
				if (Date.now() > deadline) assert.fail("Timed out waiting for mock child ready marker");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}

		// ── Step 2: ordinary interrupt (no supervisorPauseRequest) ───────────────
		requestAsyncInterrupt(asyncDir, { source: "tlhm-8typ-r5-test" });

		// ── Step 3: wait for the first paused checkpoint ─────────────────────────
		await waitForAsyncState(asyncDir, "paused");

		const pausedStatusRaw = JSON.parse(
			fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
		) as AsyncStatusPayload;
		const pausedGen = lifecycleGeneration(pausedStatusRaw as Parameters<typeof lifecycleGeneration>[0]);

		// ── Step 4: inject a concurrent cancelled terminal state via CAS ─────────
		// Simulates an external cancel action (e.g. from a cancel tool call) that
		// commits the terminal state after the paused checkpoint but before the
		// source runner's post-child write.
		const cancelledAt = Date.now();
		transitionLifecycleStatus({
			asyncDir,
			expectedGeneration: pausedGen,
			mutate: (status) => ({
				...status,
				state: "cancelled" as const,
				pid: undefined,
				cancel: { summary: "Test cancellation", cancelledAt },
				endedAt: cancelledAt,
				lastUpdate: cancelledAt,
				steps: status.steps?.map((step) => ({
					...step,
					status: "cancelled" as const,
					endedAt: cancelledAt,
					exitCode: 0,
					pause: undefined,
					cancel: { summary: "Test cancellation", cancelledAt },
				})),
			}),
		});

		// Sanity: verify the cancelled state is on disk before releasing the child.
		const afterCancel = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(afterCancel.state, "cancelled", "sanity: cancelled state must be on disk before releasing the child");

		// ── Step 5: release the blocking child ───────────────────────────────────
		// The child exits. The source runner calls writeStatusPayload() (with
		// interrupted=true, no supervisorPauseRequest), which is the write path that
		// must now adopt the terminal winner in-memory via FIX 10.
		fs.writeFileSync(releaseMarker, "", "utf-8");

		// ── Step 6: wait for the result artifact ─────────────────────────────────
		const resultPath = await waitForAsyncResultFile(id);

		// ── Assertions ───────────────────────────────────────────────────────────
		const resultPayload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;

		// FIX 10: adoption must happen in-memory at the writeStatusPayload call,
		// not deferred to a CAS block that only runs when supervisorPauseRequest
		// is set. Without the fix resultState falls through to `interrupted ? "paused"`
		// and the artifact says `state: "paused"`.
		assert.equal(
			resultPayload.state,
			"cancelled",
			"result artifact must reflect the adopted cancelled state, not stale paused",
		);
		// FIX 11: the adopted terminal state must also beat any stale turnBudgetExceeded
		// flag in resultState precedence. Even if a late message_end fired updateStepTurnBudget
		// before the interrupt write, concurrentTerminalStatusAdopted wins.
		assert.equal(
			resultPayload.state !== "failed",
			true,
			"result artifact must not be failed due to stale budget state",
		);
	});
});
