/**
 * Integration tests for async execution – model fallback/thinking,
 * output routing, completion guards, tk metadata, skills, and control events.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockPi, createTempDir, events, makeAgent, removeTempDir } from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { getThinkingLevelDropNote } from "../../src/runs/shared/pi-args.ts";
import {
	ASYNC_DIR,
	type AsyncResultPayload,
	type AsyncStatusPayload,
	RESULTS_DIR,
	escapeRegExp,
	executeAsyncChain,
	executeAsyncSingle,
	readLastMockPiArgs,
	readMockPiArgs,
	waitForAsyncControlCondition,
	waitForAsyncResultFile,
	waitForAsyncStatusPredicate,
	waitForMockPiCall,
	writePackageSkill,
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

	it("background runs deliver warning and critical pressure controls exactly once", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "preserve progress" }],
						model: "mock/test-model",
						stopReason: "toolUse",
						usage: { totalTokens: 800, input: 700, output: 100, cacheRead: 0, cacheWrite: 0 },
					},
				},
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "finish narrowly" }],
						model: "mock/test-model",
						stopReason: "stop",
						usage: { totalTokens: 950, input: 850, output: 100, cacheRead: 0, cacheWrite: 0 },
					},
				},
			],
		});
		const id = `async-pressure-controls-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Preserve the work.",
			agentConfig: makeAgent("worker", { model: "mock/test-model", completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-pressure" },
			availableModels: [{ provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 1000 }],
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
		assert.equal(run.details.asyncId, id);
		await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload & {
			results?: Array<{ contextPressureCrossedThresholds?: string[] }>;
		};
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results?.[0]?.contextPressureCrossedThresholds, ["warning", "critical"]);
		const statusPayload = JSON.parse(
			fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
		) as AsyncStatusPayload;
		assert.deepEqual(statusPayload.steps[0]?.contextPressureCrossedThresholds, ["warning", "critical"]);
		assert.equal(statusPayload.steps[0]?.contextPressure?.severity, "critical");
		assert.equal(statusPayload.steps[0]?.contextPressure?.remainingTokens, 50);
		assert.equal(statusPayload.steps[0]?.contextUsage?.contextPercent, 95);
		const events = fs
			.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const controls = events.filter((event) => event.type === "subagent.control");
		assert.deepEqual(
			controls.map((event) => event.event.contextPressureSeverity),
			["warning", "critical"],
		);
		assert.deepEqual(
			controls.map((event) => event.event.contextPressureThreshold),
			["warning", "critical"],
		);
	});

	it("background runs record fallback attempts and final model", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "primary failed" }],
						model: "openai/gpt-5-mini",
						errorMessage: "rate limit exceeded",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
			],
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
			if (Date.now() - started > scaleTestTimeout(15_000)) {
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
		const statusPayload = JSON.parse(
			fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
		) as AsyncStatusPayload;
		assert.equal(statusPayload.lifecycleArtifactVersion, 1);
		assert.equal(statusPayload.steps[0]?.model, "anthropic/claude-sonnet-4:low");
		assert.equal(statusPayload.steps[0]?.thinking, "low");
		assert.ok(statusPayload.totalTokens!.total > 0);
		assert.ok(statusPayload.steps[0]?.tokens!.total > 0);
		assert.deepEqual(statusPayload.steps[0]?.totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		assert.deepEqual(statusPayload.totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		const events = fs
			.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(events.find((event) => event.type === "subagent.run.started")?.lifecycleArtifactVersion, 1);
		const completed = events.find((event) => event.type === "subagent.run.completed");
		assert.equal(completed?.lifecycleArtifactVersion, 1);
		assert.deepEqual(completed?.totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		assert.match(fs.readFileSync(path.join(asyncDir, "output-0.log"), "utf-8"), /Recovered asynchronously/);
		assert.equal(mockPi.callCount(), 2);
	});

	it("persists cached-token-heavy context diagnostics and termination reason", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Done" }],
						model: "mock/test-model",
						stopReason: "stop",
						usage: { input: 10, output: 5, cacheRead: 985, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			],
		});
		const id = `async-context-${Date.now().toString(36)}`;
		const restoredSessionFile = path.join(tempDir, "restored-context.jsonl");
		fs.writeFileSync(
			restoredSessionFile,
			'{"type":"session","version":1,"id":"restored-context","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n',
			"utf-8",
		);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "mock/test-model" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [{ provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 2000 }],
			sessionFile: restoredSessionFile,
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
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
		assert.deepEqual(payload.results[0]?.contextUsage, {
			restoredTokens: 1000,
			contextTokens: 1000,
			peakTokens: 1000,
			contextWindow: 2000,
			contextPercent: 50,
		});
		assert.equal(payload.results[0]?.terminationReason, "completed");
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.deepEqual(status.steps?.[0]?.contextUsage, payload.results[0]?.contextUsage);
		assert.equal(status.steps?.[0]?.terminationReason, "completed");
	});

	it("fresh async runs do not mark a preallocated session path as restored", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Fresh" }],
						model: "mock/test-model",
						stopReason: "stop",
						usage: { input: 10, output: 5, cacheRead: 985, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			],
		});
		const id = `async-context-fresh-${Date.now().toString(36)}`;
		const sessionFile = path.join(tempDir, "fresh-preallocated.jsonl");
		fs.writeFileSync(sessionFile, "", "utf-8");
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do fresh work",
			agentConfig: makeAgent("worker", { model: "mock/test-model" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [{ provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 2000 }],
			sessionFile,
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
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.results[0]?.contextUsage?.restoredTokens, undefined);
		assert.equal(payload.results[0]?.terminationReason, "completed");
	});

	it("background durable resumes let explicit model overrides beat the restored identity and label them overrides", async () => {
		mockPi.onCall({ output: "Resumed with explicit override" });
		const id = `async-resume-override-${Date.now().toString(36)}`;
		const availableModels = [
			{ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" },
			{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
		];
		const restored = { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" } as const;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Continue the paused work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels,
			modelOverride: "openai/gpt-5",
			restoredModelIdentity: restored,
			modelResolution: {
				kind: "override",
				original: restored,
				reason: "Caller explicitly overrode persisted selection anthropic/claude-sonnet-4:high with 'openai/gpt-5'.",
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

		assert.equal(run.details.asyncId, id);
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, "openai/gpt-5");
		assert.equal(payload.results[0]?.modelResolution?.kind, "override");
		assert.deepEqual(payload.results[0]?.modelResolution?.original, restored);
		assert.deepEqual(payload.results[0]?.modelResolution?.resumed, { provider: "openai", model: "gpt-5" });
		assert.match(payload.results[0]?.modelResolution?.reason ?? "", /explicitly overrode persisted selection/);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5");
	});

	it("background durable resumes keep unavailable restored models visible through runtime fallback", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "restored model failed" }],
						model: "anthropic/claude-sonnet-4",
						errorMessage: "rate limit exceeded",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
			],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered on fallback model" });
		const id = `async-resume-unavailable-${Date.now().toString(36)}`;
		const availableModels = [{ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" }];
		const restored = { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" } as const;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Continue the paused work",
			agentConfig: makeAgent("worker", { fallbackModels: ["openai/gpt-5"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels,
			restoredModelIdentity: restored,
			modelResolution: {
				kind: "restored",
				original: restored,
				resumed: restored,
				reason:
					"Restored persisted child selection anthropic/claude-sonnet-4:high instead of the current parent model.",
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

		assert.equal(run.details.asyncId, id);
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, "openai/gpt-5:high");
		assert.deepEqual(payload.results[0]?.attemptedModels, ["anthropic/claude-sonnet-4:high", "openai/gpt-5:high"]);
		assert.equal(payload.results[0]?.modelResolution?.kind, "fallback");
		assert.deepEqual(payload.results[0]?.modelResolution?.original, restored);
		assert.deepEqual(payload.results[0]?.modelResolution?.resumed, {
			provider: "openai",
			model: "gpt-5",
			thinking: "high",
		});
		const reason = payload.results[0]?.modelResolution?.reason ?? "";
		assert.match(reason, /not present in the current model registry/);
		assert.match(
			reason,
			/Runtime fallback selected 'openai\/gpt-5:high' after 'anthropic\/claude-sonnet-4:high' failed/,
		);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runtime fallback persists the full transition in status during the crash window", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "restored model failed" }],
						model: "anthropic/claude-sonnet-4",
						errorMessage: "rate limit exceeded",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
			],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered on fallback model", delay: 3000 });
		const id = `async-fallback-crash-window-${Date.now().toString(36)}`;
		const availableModels = [{ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" }];
		const restored = { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" } as const;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Continue the paused work",
			agentConfig: makeAgent("worker", { fallbackModels: ["openai/gpt-5"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels,
			restoredModelIdentity: restored,
			modelResolution: {
				kind: "restored",
				original: restored,
				resumed: restored,
				reason:
					"Restored persisted child selection anthropic/claude-sonnet-4:high instead of the current parent model.",
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

		// Simulated crash window: the second (fallback) attempt is running but the
		// terminal result has not been persisted yet. The last status write must
		// already carry the original identity, fallback reason, attempted models,
		// and completed attempt history so a durable resume after a crash cannot
		// mistake the fallback for the original selection.
		const crashWindowStatus = await waitForAsyncStatusPredicate(
			path.join(ASYNC_DIR, id),
			(status) =>
				status.steps?.[0]?.modelResolution?.kind === "fallback" && status.steps?.[0]?.modelAttempts?.length === 1,
			"fallback transition persisted before the terminal result",
		);
		assert.ok(
			!fs.existsSync(path.join(RESULTS_DIR, `${id}.json`)),
			"expected the crash-window snapshot before the terminal result was persisted",
		);
		const step = crashWindowStatus.steps?.[0];
		assert.equal(step?.model, "openai/gpt-5:high");
		assert.deepEqual(step?.modelIdentity, { provider: "openai", model: "gpt-5", thinking: "high" });
		assert.deepEqual(step?.modelResolution?.original, restored);
		assert.deepEqual(step?.modelResolution?.resumed, { provider: "openai", model: "gpt-5", thinking: "high" });
		assert.match(
			step?.modelResolution?.reason ?? "",
			/Runtime fallback selected 'openai\/gpt-5:high' after 'anthropic\/claude-sonnet-4:high' failed/,
		);
		assert.deepEqual(step?.attemptedModels, ["anthropic/claude-sonnet-4:high", "openai/gpt-5:high"]);
		assert.equal(step?.modelAttempts?.[0]?.success, false);

		// The run then completes normally with the terminal resolution intact.
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.modelResolution?.kind, "fallback");
		assert.deepEqual(payload.results[0]?.modelResolution?.original, restored);
	});

	it("background durable resumes surface model-scope violations for restored selections without silent switches", async () => {
		mockPi.onCall({ output: "Resumed outside the configured scope" });
		const id = `async-resume-scope-${Date.now().toString(36)}`;
		const availableModels = [
			{ provider: "openai", id: "gpt-5", fullId: "openai/gpt-5" },
			{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
		];
		const restored = { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" } as const;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Continue the paused work",
			agentConfig: makeAgent("worker"),
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				modelScope: { enforce: true, allow: ["openai/*"] },
			},
			availableModels,
			restoredModelIdentity: restored,
			modelResolution: {
				kind: "restored",
				original: restored,
				resumed: restored,
				reason:
					"Restored persisted child selection anthropic/claude-sonnet-4:high instead of the current parent model.",
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

		assert.equal(run.details.asyncId, id);
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, "anthropic/claude-sonnet-4:high");
		assert.equal(payload.results[0]?.modelResolution?.kind, "restored");
		assert.deepEqual(payload.results[0]?.modelResolution?.resumed, restored);
		const reason = payload.results[0]?.modelResolution?.reason ?? "";
		assert.match(reason, /Restored persisted child selection/);
		assert.match(reason, /outside the configured subagent model scope/);
		const statusPayload = JSON.parse(
			fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
		) as AsyncStatusPayload;
		assert.equal(statusPayload.steps?.[0]?.modelResolution?.kind, "restored");
		assert.deepEqual(statusPayload.steps?.[0]?.modelIdentity, restored);
		assert.equal(statusPayload.steps?.[0]?.thinking, "high");
	});

	it("background runs surface a dropped thinking level once without changing the model arg", async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const id = `async-thinking-drop-${Date.now().toString(36)}`;
		const availableModels = [
			{
				provider: "openai",
				id: "gpt-5",
				fullId: "openai/gpt-5",
				reasoning: true,
				thinkingLevelMap: { max: null },
			},
		];
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
		const statusPayload = JSON.parse(
			fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
		) as AsyncStatusPayload;
		const note = getThinkingLevelDropNote("openai/gpt-5", "max", false, { availableModels });
		assert.ok(note);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, "openai/gpt-5");
		assert.equal(payload.results[0]?.output?.split(note).length - 1, 1);
		assert.equal(statusPayload.steps?.[0]?.recentOutput?.filter((line) => line === note).length, 1);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5");
	});

	it("repeated chain steps keep the later step's identity thinking-free after its duplicate drop note is deduped", async () => {
		mockPi.onCall({ output: "Step one done" });
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "primary failed" }],
						model: "anthropic/claude-sonnet-4-5",
						errorMessage: "429 quota exceeded",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
			],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Step two recovered on fallback" });
		const id = `async-chain-thinking-drop-dedupe-${Date.now().toString(36)}`;
		const availableModels = [
			{
				provider: "anthropic",
				id: "claude-sonnet-4-5",
				fullId: "anthropic/claude-sonnet-4-5",
				reasoning: true,
			},
			{
				provider: "openai",
				id: "gpt-5",
				fullId: "openai/gpt-5",
				reasoning: true,
				thinkingLevelMap: { max: null },
			},
		];
		executeAsyncChain(id, {
			chain: [
				{ agent: "worker", task: "Step one" },
				{ agent: "worker", task: "Step two" },
			],
			agents: [
				makeAgent("worker", {
					model: "anthropic/claude-sonnet-4-5",
					fallbackModels: ["openai/gpt-5"],
					thinking: "max",
				}),
			],
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

		const resultPath = await waitForAsyncResultFile(id, 15_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const statusPayload = JSON.parse(
			fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
		) as AsyncStatusPayload;
		const note = getThinkingLevelDropNote("openai/gpt-5", "max", false, { availableModels });
		assert.ok(note);
		assert.equal(payload.success, true);
		// Human-facing notice deduplication is unchanged: only the first step
		// surfaces the shared drop note.
		assert.equal(payload.results[0]?.output?.split(note).length - 1, 1);
		assert.equal(payload.results[1]?.output?.includes(note), false);
		// The second step fell back to the unsupported model; even though its
		// duplicate note was deduped away, its persisted identity must stay
		// thinking-free in both the terminal result and the status file.
		assert.equal(payload.results[1]?.model, "openai/gpt-5");
		assert.deepEqual(payload.results[1]?.modelIdentity, { provider: "openai", model: "gpt-5" });
		assert.equal(payload.results[1]?.modelResolution?.kind, "fallback");
		assert.deepEqual(payload.results[1]?.modelResolution?.resumed, { provider: "openai", model: "gpt-5" });
		assert.deepEqual(statusPayload.steps?.[1]?.modelIdentity, { provider: "openai", model: "gpt-5" });
		assert.equal(statusPayload.steps?.[1]?.thinking, undefined);
		// The first step's supported primary keeps its thinking level.
		assert.deepEqual(payload.results[0]?.modelIdentity, {
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			thinking: "max",
		});
		const fallbackArgs = readMockPiArgs(mockPi, 2);
		assert.equal(fallbackArgs[fallbackArgs.indexOf("--model") + 1], "openai/gpt-5");
	});

	it("background runs preserve a max thinking suffix when capability metadata is missing", async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const id = `async-thinking-metadata-missing-${Date.now().toString(36)}`;
		const model = "anthropic/claude-sonnet-4-5";
		const availableModels = [
			{
				provider: "anthropic",
				id: "claude-sonnet-4-5",
				fullId: model,
				reasoning: true,
			},
		];
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
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, `${model}:max`);
		assert.equal(getThinkingLevelDropNote(model, "max", false, { availableModels }), undefined);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], `${model}:max`);
	});

	it("background runs try per-dispatch fallback models before agent fallback models and only persist notices after a retry", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "primary failed" }],
						model: "openai/gpt-5-mini",
						errorMessage: "429 quota exceeded",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
			],
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
			if (Date.now() - started > scaleTestTimeout(15_000)) {
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
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "primary failed" }],
						model: "openai/gpt-5-mini",
						errorMessage: "rate limit exceeded",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
			],
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
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
			],
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
		assert.deepEqual(
			payload.results[0]?.modelAttempts?.map((attempt) => attempt.success),
			[false, true],
		);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background fallback does not combine failed pressure diagnostics with a later empty attempt", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "failed-call", name: "edit", arguments: { path: "a.ts" } }],
						model: "openai/gpt-5-mini",
						stopReason: "toolUse",
						usage: { totalTokens: 990, input: 900, output: 90, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "429 quota exceeded",
					},
				},
			],
			exitCode: 0,
		});
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "successful-call", name: "edit", arguments: { path: "b.ts" } }],
						model: "anthropic/claude-sonnet-4",
						stopReason: "toolUse",
					},
				},
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "" }],
						model: "anthropic/claude-sonnet-4",
						stopReason: "stop",
					},
				},
			],
		});
		const id = `async-fallback-context-pressure-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini",
				fallbackModels: ["anthropic/claude-sonnet-4"],
				completionGuard: false,
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", contextWindow: 1000 },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4", contextWindow: 1000 },
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
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.notEqual(payload.results[0]?.terminationReason, "context_exhausted");
		assert.doesNotMatch(payload.results[0]?.error ?? "", /unfinished tool interaction under high context pressure/);
		assert.equal(payload.results[0]?.contextUsage?.contextPercent, 99);
		assert.deepEqual(
			payload.results[0]?.modelAttempts?.map((attempt) => attempt.success),
			[false, true],
		);
	});

	it("background acceptance reports do not become context-exhausted empty terminals", async () => {
		const acceptanceReport = [
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "terminal report" }],
				changedFiles: [],
				testsAddedOrUpdated: [],
				commandsRun: [],
				validationOutput: [],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-acceptance-bg", name: "edit", arguments: { path: "a.ts" } }],
						model: "mock/test-model",
						stopReason: "toolUse",
						usage: { totalTokens: 990, input: 900, output: 90, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: acceptanceReport }],
						model: "mock/test-model",
						stopReason: "stop",
						usage: { totalTokens: 990, input: 900, output: 90, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			],
		});
		const id = `async-context-acceptance-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Finish the edit.",
			agentConfig: makeAgent("worker", { model: "mock/test-model", completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			acceptance: false,
			availableModels: [{ provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 1000 }],
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

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.exitCode, 0);
		assert.equal(payload.results[0]?.terminationReason, "completed");
		assert.equal(payload.results[0]?.contextUsage?.contextPercent, 99);
		assert.equal(payload.results[0]?.output, "");
	});

	it("background runs fail zero-exit provider errors when no fallback succeeds", async () => {
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
		const statusPayload = JSON.parse(
			fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
		) as AsyncStatusPayload;
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
		const statusPayload = JSON.parse(
			fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
		) as AsyncStatusPayload;
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
		const statusPayload = JSON.parse(
			fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
		) as AsyncStatusPayload;
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
		const deadline = Date.now() + scaleTestTimeout(10_000);
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

		const deadline = Date.now() + scaleTestTimeout(10_000);
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

		const deadline = Date.now() + scaleTestTimeout(10_000);
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

		const resultPath = await waitForAsyncResultFile(id);
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

		const deadline = Date.now() + scaleTestTimeout(10_000);
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

		const resultPath = await waitForAsyncResultFile(id);
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

		const resultPath = await waitForAsyncResultFile(id);
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
			fs.writeFileSync(
				path.join(ticketRoot, ".tickets", "psr-raw4.md"),
				"---\nid: psr-raw4\n---\n# Show active tk title\n",
				"utf-8",
			);
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Run `tk show psr-raw4` first.",
				agentConfig: makeAgent("worker"),
				ctx: {
					pi: {
						events: {
							emit(channel: string, payload: unknown) {
								emitted.push({ channel, payload });
							},
						},
					},
					cwd: tempDir,
					currentSessionId: "session-1",
				},
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

			await waitForAsyncResultFile(id);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
			assert.deepEqual(status.tkTicket, { id: "psr-raw4", title: "Show active tk title" });
			assert.deepEqual(
				(
					emitted.find((entry) => entry.channel === "subagent:async-started")?.payload as
						| { tkTicket?: unknown }
						| undefined
				)?.tkTicket,
				{ id: "psr-raw4", title: "Show active tk title" },
			);
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

		await waitForAsyncResultFile(id);
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
			fs.writeFileSync(
				path.join(ticketRoot, ".tickets", "psr-raw4.md"),
				"---\nid: psr-raw4\n---\n# Show active tk title\n",
				"utf-8",
			);
			executeAsyncChain(id, {
				chain: [
					{
						parallel: [
							{ agent: "worker", task: "Run `tk show psr-raw4` first.", cwd: ticketCwd },
							{ agent: "reviewer", task: "Do the review" },
						],
					},
				],
				resultMode: "parallel",
				agents: [makeAgent("worker"), makeAgent("reviewer")],
				ctx: {
					pi: {
						events: {
							emit(channel: string, payload: unknown) {
								emitted.push({ channel, payload });
							},
						},
					},
					cwd: tempDir,
					currentSessionId: "session-1",
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

			await waitForAsyncResultFile(id);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
			assert.deepEqual(status.tkTicket, { id: "psr-raw4", title: "Show active tk title" });
			assert.deepEqual(
				(
					emitted.find((entry) => entry.channel === "subagent:async-started")?.payload as
						| { tkTicket?: unknown }
						| undefined
				)?.tkTicket,
				{ id: "psr-raw4", title: "Show active tk title" },
			);

			mockPi.onCall({ output: "ambiguous one done" });
			mockPi.onCall({ output: "ambiguous two done" });
			const ambiguousId = `async-ticket-parallel-ambiguous-${Date.now().toString(36)}`;
			executeAsyncChain(ambiguousId, {
				chain: [
					{
						parallel: [
							{ agent: "worker", task: "Run `tk show psr-raw4` first.", cwd: ticketCwd },
							{ agent: "reviewer", task: "Run `tk show psr-other` first.", cwd: ticketCwd },
						],
					},
				],
				resultMode: "parallel",
				agents: [makeAgent("worker"), makeAgent("reviewer")],
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
			await waitForAsyncResultFile(ambiguousId);
			const ambiguousStatus = JSON.parse(
				fs.readFileSync(path.join(ASYNC_DIR, ambiguousId, "status.json"), "utf-8"),
			) as AsyncStatusPayload;
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

			const deadline = Date.now() + scaleTestTimeout(10_000);
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
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker", { skills: ["pi-subagents"] })],
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
				chain: [{ agent: "worker", task: "Do work", cwd: "packages/app" }],
				agents: [makeAgent("worker", { skills: ["async-chain-step-skill"] })],
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

			const deadline = Date.now() + scaleTestTimeout(10_000);
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
				{
					delay: 900,
					jsonl: [events.toolEnd("read"), events.toolResult("read", "done"), events.assistantMessage("reader done")],
				},
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
			chain: [
				{
					parallel: [
						{ agent: "reader", task: "Read" },
						{ agent: "editor", task: "Edit" },
					],
				},
			],
			agents: [makeAgent("reader"), makeAgent("editor")],
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

		const statusPath = path.join(asyncDir, "status.json");
		const doneDeadline = Date.now() + scaleTestTimeout(10_000);
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
		const deadline = Date.now() + scaleTestTimeout(10_000);
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
			}
			if (eventText.includes('"type":"active_long_running"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (
					status.activityState === "active_long_running" &&
					status.steps?.[0]?.activityState === "active_long_running"
				) {
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

		const doneDeadline = Date.now() + scaleTestTimeout(10_000);
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

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const eventText = fs.existsSync(path.join(asyncDir, "events.jsonl"))
			? fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
			: "";
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
			return (
				eventText.includes('"reason":"idle"') &&
				status.activityState === "needs_attention" &&
				status.steps?.[0]?.activityState === "needs_attention"
			);
		});
		assert.match(observed.eventText, /"type":"needs_attention"/);
		assert.match(observed.eventText, /"reason":"idle"/);

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.state, "complete");
		assert.equal(payload.success, true);
	});

	it("background runs escalate repeated mutating tool failures", async () => {
		mockPi.onCall({
			steps: [
				{
					jsonl: [
						events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }),
						events.toolEnd("edit"),
						events.toolResult("edit", "No exact match found for subagent-runner.ts", true),
					],
				},
				{
					jsonl: [
						events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }),
						events.toolEnd("edit"),
						events.toolResult("edit", "No exact match found for subagent-runner.ts", true),
					],
				},
				{
					jsonl: [
						events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }),
						events.toolEnd("edit"),
						events.toolResult("edit", "No exact match found for subagent-runner.ts", true),
					],
				},
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
		const deadline = Date.now() + scaleTestTimeout(10_000);
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

		const doneDeadline = Date.now() + scaleTestTimeout(10_000);
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
									partial: {
										role: "assistant",
										content: [{ type: "text", text: "NOISY_PARTIAL_SNAPSHOT".repeat(200) }],
									},
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

			const resultPath = await waitForAsyncResultFile(id);
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

		const liveDeadline = Date.now() + scaleTestTimeout(10_000);
		let sawChildEvent = false;
		let sawLiveOutput = false;
		while (Date.now() < liveDeadline && (!sawChildEvent || !sawLiveOutput)) {
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, "utf-8");
				sawChildEvent =
					content.includes('"type":"tool_execution_start"') && content.includes('"subagentSource":"child"');
			}
			if (fs.existsSync(outputPath)) {
				const content = fs.readFileSync(outputPath, "utf-8");
				sawLiveOutput =
					content.includes("bash: ls") || content.includes("file-a") || content.includes("warning: mock stderr");
			}
			if (sawChildEvent && sawLiveOutput) break;
			assert.equal(fs.existsSync(resultPath), false, "run finished before live observability was written");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.equal(sawChildEvent, true, "expected child JSON events to be streamed into events.jsonl");
		assert.equal(sawLiveOutput, true, "expected output-0.log to receive live child output");

		const doneDeadline = Date.now() + scaleTestTimeout(10_000);
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
		assert.deepEqual(
			status.steps[0].recentTools.map((tool: { tool: string; args: string }) => ({ tool: tool.tool, args: tool.args })),
			[{ tool: "bash", args: "ls" }],
		);
		assert.deepEqual(status.steps[0].recentOutput, ["file-a", "file-b", "Done streaming"]);
	});

	it("keeps non-object child JSON in background output and preserves unknown object events", async () => {
		const unknownEvent = {
			type: "future_event",
			extraField: { nested: true },
			anotherField: ["preserve", 7],
		};
		mockPi.onCall({
			jsonl: [null, [1, "two"], JSON.stringify("primitive"), 42, unknownEvent],
		});

		const id = `async-json-guards-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Handle child JSON protocol lines",
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

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, ["null", '[1,"two"]', '"primitive"', "42"].join("\n"));

		const eventRecords = fs
			.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const rawLines = eventRecords.filter((event) => event.type === "subagent.child.stdout").map((event) => event.line);
		assert.deepEqual(rawLines, ["null", '[1,"two"]', '"primitive"', "42"]);
		const preservedEvent = eventRecords.find((event) => event.type === unknownEvent.type);
		assert.deepEqual(preservedEvent?.extraField, unknownEvent.extraField);
		assert.deepEqual(preservedEvent?.anotherField, unknownEvent.anotherField);
	});
});
