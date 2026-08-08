import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";

function createState(sessionId: string): SubagentState {
	return {
		baseCwd: "/repo",
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = scaleTestTimeout(1000)): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for watcher-to-notify delivery");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function createNotifyHarness(): {
	pi: {
		events: {
			on: (event: string, handler: (payload: unknown) => void) => () => void;
			emit: (event: string, data: unknown) => void;
		};
		on: (_event: string, _handler: (...args: unknown[]) => void) => void;
		sendMessage: (message: { content?: string }) => void;
		sendUserMessage: (content: string, options?: { deliverAs?: string }) => void;
	};
	sent: string[];
	sentUserMessages: Array<{ content: string; options?: { deliverAs?: string } }>;
} {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const sent: string[] = [];
	const sentUserMessages: Array<{ content: string; options?: { deliverAs?: string } }> = [];
	return {
		pi: {
			events: {
				on(event: string, handler: (payload: unknown) => void) {
					const handlers = listeners.get(event) ?? new Set();
					handlers.add(handler);
					listeners.set(event, handlers);
					return () => handlers.delete(handler);
				},
				emit(event: string, data: unknown) {
					for (const handler of listeners.get(event) ?? []) handler(data);
				},
			},
			on(_event: string, _handler: (...args: unknown[]) => void) {},
			sendMessage(message: { content?: string }) {
				sent.push(message.content ?? "");
			},
			sendUserMessage(content: string, options?: { deliverAs?: string }) {
				sentUserMessages.push({ content, options });
			},
		},
		sent,
		sentUserMessages,
	};
}

describe("result watcher to native notify", () => {
	it("delivers terminal result types only to the exact owner without result intercom", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-notify-"));
		const listeners = new Map<string, Set<(payload: unknown) => void>>();
		const emitted: Array<{ event: string; data: unknown }> = [];
		const sent: Array<{
			message: { customType?: string; content?: string; display?: boolean };
		}> = [];
		const sentUserMessages: Array<{ content: string; options?: { deliverAs?: string } }> = [];
		const events = {
			on(event: string, handler: (payload: unknown) => void) {
				const handlers = listeners.get(event) ?? new Set();
				handlers.add(handler);
				listeners.set(event, handlers);
				return () => handlers.delete(handler);
			},
			emit(event: string, data: unknown) {
				emitted.push({ event, data });
				for (const handler of listeners.get(event) ?? []) handler(data);
			},
		};
		const pi = {
			events,
			on(_event: string, _handler: (...args: unknown[]) => void) {},
			sendMessage(message: { customType?: string; content?: string; display?: boolean }) {
				sent.push({ message });
			},
			sendUserMessage(content: string, options?: { deliverAs?: string }) {
				sentUserMessages.push({ content, options });
			},
		};
		const state = createState("session-owner");
		registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
		const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
		const writeResult = (name: string, data: Record<string, unknown>) => {
			fs.writeFileSync(path.join(resultsDir, name), JSON.stringify(data), "utf-8");
		};

		const singleSession = path.join(resultsDir, "single-session.jsonl");
		const childSession = path.join(resultsDir, "child-9-session.jsonl");
		const pausedChildSession = path.join(resultsDir, "paused-child-session.jsonl");
		fs.writeFileSync(singleSession, "session\n", "utf-8");
		fs.writeFileSync(childSession, "session\n", "utf-8");
		fs.writeFileSync(pausedChildSession, "session\n", "utf-8");
		try {
			writeResult("01-completed.json", {
				id: "completed-event",
				runId: "completed-run",
				agent: "single-worker",
				success: true,
				state: "complete",
				summary: "single done",
				sessionFile: singleSession,
				shareUrl: "https://share/completed-run",
				results: [{ agent: "single-worker", output: "single done", success: true }],
				sessionId: "session-owner",
				intercomTarget: "stale-owner-target",
			});
			writeResult("02-mixed-failed.json", {
				id: "mixed-failed-event",
				runId: "mixed-failed-run",
				agent: "parallel:a+b",
				success: true,
				state: "complete",
				summary: "mixed outer summary",
				results: [
					...Array.from({ length: 8 }, (_, index) => ({
						agent: `ok-${index}`,
						output: `ok-${index} done`,
						success: true,
					})),
					{
						agent: "late-failure",
						output: "late failure output",
						error: "late failure",
						success: false,
						sessionFile: childSession,
					},
				],
				sessionId: "session-owner",
				intercomTarget: "stale-owner-target",
			});
			writeResult("03-paused.json", {
				id: "paused",
				agent: "chain:a+b",
				success: false,
				state: "paused",
				summary: "Paused after interrupt.",
				results: [
					{ agent: "a", output: "a done", success: true, exitCode: 0 },
					{ agent: "b", output: "b done", success: true, exitCode: 0 },
					{ agent: "c", output: "c done", success: true, exitCode: 0 },
					{ agent: "d", output: "d done", success: true, exitCode: 0 },
					{
						agent: "e",
						output: "Paused after interrupt.",
						success: false,
						exitCode: 0,
						interrupted: true,
						sessionFile: pausedChildSession,
					},
				],
				sessionId: "session-owner",
				intercomTarget: "stale-owner-target",
			});
			writeResult("04-missing-session.json", {
				id: "missing-session-event",
				runId: "missing-session-run",
				agent: "missing-session-worker",
				success: true,
				summary: "missing session done",
				sessionFile: path.join(resultsDir, "missing-session.jsonl"),
				sessionId: "session-owner",
			});
			writeResult("05-foreign.json", {
				id: "foreign",
				agent: "foreign-worker",
				success: true,
				summary: "must not deliver",
				sessionId: "session-other",
			});

			watcher.primeExistingResults();
			await waitUntil(() => sent.length === 4);
		} finally {
			watcher.stopResultWatcher();
		}

		assert.equal(sent.length, 4);
		// E′ protocol: sendMessage is called without options (no triggerTurn); nudge comes via sendUserMessage
		assert.equal(
			sent.every((entry) => entry.message.customType === "subagent-notify" && entry.message.display === true),
			true,
		);
		// Four sendUserMessage nudges (one per completion, all on idle path with batching disabled)
		assert.equal(sentUserMessages.length, 4);
		assert.ok(
			sentUserMessages.every(
				(entry) =>
					entry.content === "[tlh] Background subagent completed — see notification above." &&
					entry.options?.deliverAs === "followUp",
			),
			"every nudge must use the E\u2032 wake-up text and deliverAs:followUp",
		);
		const contents = sent.map((entry) => entry.message.content ?? "");
		assert.equal(
			contents.some(
				(content) =>
					/^Background task completed: \*\*single-worker\*\*/.test(content) &&
					/Async id: completed-event/.test(content) &&
					/Revive: subagent\({ action: "resume", id: "completed-event", message: "\.\.\." }\)/.test(content) &&
					/Session: https:\/\/share\/completed-run$/.test(content),
			),
			true,
		);
		assert.equal(
			contents.some(
				(content) =>
					/^Background task failed: \*\*parallel:a\+b\*\*/.test(content) &&
					/Children: 8 completed, 1 failed/.test(content) &&
					/9\/9\. late-failure — failed/.test(content) &&
					/Revive child: subagent\({ action: "resume", id: "mixed-failed-event", index: 8, message: "\.\.\." }\)/.test(
						content,
					),
			),
			true,
		);
		assert.equal(
			contents.some(
				(content) =>
					/^Background task paused: \*\*chain:a\+b\*\*/.test(content) &&
					/Async id: paused/.test(content) &&
					/Revive child: subagent\({ action: "resume", id: "paused", index: 4, message: "\.\.\." }\)/.test(content),
			),
			true,
		);
		assert.equal(
			contents.some(
				(content) =>
					/^Background task completed: \*\*missing-session-worker\*\*/.test(content) &&
					/Async id: missing-session-event/.test(content) &&
					!/subagent\({ action: "resume"/.test(content),
			),
			true,
		);
		assert.equal(
			contents.some((content) => content.includes("must not deliver")),
			false,
		);
		assert.equal(
			contents.some((content) => content.includes("stale-owner-target")),
			false,
		);
		assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 4);
		assert.equal(
			emitted.some(
				(entry) =>
					entry.event === "subagent:async-complete" &&
					typeof entry.data === "object" &&
					entry.data !== null &&
					"id" in entry.data &&
					"runId" in entry.data &&
					(entry.data as { id?: unknown }).id === "completed-event" &&
					(entry.data as { runId?: unknown }).runId === "completed-run" &&
					(entry.data as { shareUrl?: unknown }).shareUrl === "https://share/completed-run",
			),
			true,
		);
		assert.equal(listeners.has("subagent:result-intercom"), false);
		assert.equal(
			emitted.some((entry) => entry.event === "subagent:result-intercom"),
			false,
		);
		assert.equal(fs.existsSync(path.join(resultsDir, "05-foreign.json")), true);
		fs.rmSync(resultsDir, { recursive: true, force: true });
	});

	it("notifies an awaiting_supervisor paused result exactly once across repeated scans", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-paused-once-"));
		const resultsDir = path.join(root, "results");
		const asyncDir = path.join(root, "async", "paused-awaiting-supervisor");
		fs.mkdirSync(resultsDir, { recursive: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		const listeners = new Map<string, Set<(payload: unknown) => void>>();
		const emitted: Array<{ event: string; data: unknown }> = [];
		const sent: Array<{ message: { content?: string } }> = [];
		const pi = {
			events: {
				on(event: string, handler: (payload: unknown) => void) {
					const handlers = listeners.get(event) ?? new Set();
					handlers.add(handler);
					listeners.set(event, handlers);
					return () => handlers.delete(handler);
				},
				emit(event: string, data: unknown) {
					emitted.push({ event, data });
					for (const handler of listeners.get(event) ?? []) handler(data);
				},
			},
			on(_event: string, _handler: (...args: unknown[]) => void) {},
			sendMessage(message: { content?: string }) {
				sent.push({ message });
			},
			sendUserMessage(_content: string, _options?: { deliverAs?: string }) {},
		};
		const state = createState("session-owner");
		registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
		const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
		const pausedSession = path.join(resultsDir, "paused-session.jsonl");
		fs.writeFileSync(pausedSession, "session\n", "utf-8");
		fs.writeFileSync(
			path.join(asyncDir, "status.json"),
			JSON.stringify(
				{
					runId: "paused-awaiting-supervisor",
					mode: "single",
					state: "paused",
					startedAt: 100,
					sessionId: "session-owner",
					steps: [
						{
							agent: "worker",
							status: "paused",
							sessionFile: pausedSession,
							pause: { kind: "awaiting_supervisor", pausedAt: 200 },
						},
					],
					pause: { kind: "awaiting_supervisor", pausedAt: 200 },
				},
				null,
				2,
			),
			"utf-8",
		);
		const pausedResult = {
			lifecycleArtifactVersion: 1,
			id: "paused-awaiting-supervisor",
			runId: "paused-awaiting-supervisor",
			agent: "worker",
			success: false,
			state: "paused",
			summary: "Paused awaiting supervisor.",
			pause: { kind: "awaiting_supervisor" },
			results: [
				{
					agent: "worker",
					success: false,
					interrupted: true,
					output: "Paused awaiting supervisor.",
					sessionFile: pausedSession,
				},
			],
			sessionId: "session-owner",
			asyncDir,
		};
		try {
			const resultPath = path.join(resultsDir, "paused-awaiting-supervisor.json");
			fs.writeFileSync(resultPath, JSON.stringify(pausedResult), "utf-8");
			watcher.primeExistingResults();
			await waitUntil(() => sent.length === 1);
			assert.match(sent[0]!.message.content ?? "", /^Background task paused:/);
			assert.match(sent[0]!.message.content ?? "", /No child process is running\./);
			assert.match(
				sent[0]!.message.content ?? "",
				/Resume unchanged: subagent\(\{ action: "resume", id: "paused-awaiting-supervisor" \}\)/,
			);
			assert.match(
				sent[0]!.message.content ?? "",
				/Resume with guidance: subagent\(\{ action: "resume", id: "paused-awaiting-supervisor", message: "Supervisor replied: \.\.\." \}\)/,
			);
			assert.match(
				sent[0]!.message.content ?? "",
				/Cancel: subagent\(\{ action: "interrupt", id: "paused-awaiting-supervisor" \}\)/,
			);
			assert.doesNotMatch(
				sent[0]!.message.content ?? "",
				/detached for intercom coordination|fresh follow-up|fresh-redispatch/i,
			);
			assert.doesNotMatch(
				sent[0]!.message.content ?? "",
				new RegExp(pausedSession.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			);
			assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);

			fs.writeFileSync(resultPath, JSON.stringify(pausedResult), "utf-8");
			watcher.primeExistingResults();
			watcher.primeExistingResults();
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(sent.length, 1);
			assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
		} finally {
			watcher.stopResultWatcher();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("discards stale paused artifacts when resume wins before the watcher decision", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-resume-first-"));
		const resultsDir = path.join(root, "results");
		const asyncDir = path.join(root, "async", "resume-first");
		fs.mkdirSync(resultsDir, { recursive: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		const sessionPath = path.join(resultsDir, "resume-first-session.jsonl");
		fs.writeFileSync(sessionPath, "session\n", "utf-8");
		fs.writeFileSync(
			path.join(asyncDir, "status.json"),
			JSON.stringify(
				{
					runId: "resume-first",
					mode: "parallel",
					state: "paused",
					startedAt: 100,
					sessionId: "session-owner",
					steps: [
						{ agent: "a", status: "continued", sessionFile: sessionPath },
						{ agent: "b", status: "paused", pause: { kind: "awaiting_supervisor", pausedAt: 200 } },
					],
					pause: { kind: "awaiting_supervisor", pausedAt: 200 },
					lifecycle: {
						generation: 3,
						continuationsByIndex: {
							"0": { phase: "continued", claimToken: "claim-1", continuationRunId: "resume-first-child" },
						},
					},
				},
				null,
				2,
			),
			"utf-8",
		);
		const { pi, sent } = createNotifyHarness();
		const state = createState("session-owner");
		registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
		const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
		try {
			const resultPath = path.join(resultsDir, "resume-first.json");
			fs.writeFileSync(
				resultPath,
				JSON.stringify({
					lifecycleArtifactVersion: 1,
					id: "resume-first",
					runId: "resume-first",
					agent: "parallel:a+b",
					success: false,
					state: "paused",
					summary: "Paused awaiting supervisor.",
					results: [
						{
							agent: "a",
							success: false,
							interrupted: true,
							output: "Paused awaiting supervisor.",
							sessionFile: sessionPath,
						},
						{ agent: "b", success: false, interrupted: true, output: "Still paused." },
					],
					sessionId: "session-owner",
					asyncDir,
				}),
				"utf-8",
			);
			watcher.primeExistingResults();
			await waitUntil(() => !fs.existsSync(resultPath));
			assert.deepEqual(sent, []);
		} finally {
			watcher.stopResultWatcher();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("notifies once when the watcher wins before resume continues the paused child", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-resume-second-"));
		const resultsDir = path.join(root, "results");
		const asyncDir = path.join(root, "async", "resume-second");
		fs.mkdirSync(resultsDir, { recursive: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		const sessionPath = path.join(resultsDir, "resume-second-session.jsonl");
		fs.writeFileSync(sessionPath, "session\n", "utf-8");
		fs.writeFileSync(
			path.join(asyncDir, "status.json"),
			JSON.stringify(
				{
					runId: "resume-second",
					mode: "single",
					state: "paused",
					startedAt: 100,
					sessionId: "session-owner",
					steps: [
						{
							agent: "worker",
							status: "paused",
							sessionFile: sessionPath,
							pause: { kind: "awaiting_supervisor", pausedAt: 200 },
						},
					],
					pause: { kind: "awaiting_supervisor", pausedAt: 200 },
				},
				null,
				2,
			),
			"utf-8",
		);
		const { pi, sent } = createNotifyHarness();
		const state = createState("session-owner");
		registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
		const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
		try {
			const resultPath = path.join(resultsDir, "resume-second.json");
			fs.writeFileSync(
				resultPath,
				JSON.stringify({
					lifecycleArtifactVersion: 1,
					id: "resume-second",
					runId: "resume-second",
					agent: "worker",
					success: false,
					state: "paused",
					summary: "Paused awaiting supervisor.",
					results: [
						{
							agent: "worker",
							success: false,
							interrupted: true,
							output: "Paused awaiting supervisor.",
							sessionFile: sessionPath,
						},
					],
					sessionId: "session-owner",
					asyncDir,
				}),
				"utf-8",
			);
			watcher.primeExistingResults();
			await waitUntil(() => sent.length === 1);
			assert.match(sent[0] ?? "", /^Background task paused:/);
			fs.writeFileSync(
				path.join(asyncDir, "status.json"),
				JSON.stringify(
					{
						runId: "resume-second",
						mode: "single",
						state: "continued",
						startedAt: 100,
						sessionId: "session-owner",
						steps: [{ agent: "worker", status: "continued", sessionFile: sessionPath }],
						lifecycle: {
							generation: 1,
							continuation: { phase: "continued", claimToken: "claim-2", continuationRunId: "resume-second-child" },
						},
					},
					null,
					2,
				),
				"utf-8",
			);
			watcher.primeExistingResults();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(sent.length, 1);
		} finally {
			watcher.stopResultWatcher();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("discards stale paused artifacts when cancel wins before the watcher decision", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-cancel-first-"));
		const resultsDir = path.join(root, "results");
		const asyncDir = path.join(root, "async", "cancel-first");
		fs.mkdirSync(resultsDir, { recursive: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		const sessionPath = path.join(resultsDir, "cancel-first-session.jsonl");
		fs.writeFileSync(sessionPath, "session\n", "utf-8");
		fs.writeFileSync(
			path.join(asyncDir, "status.json"),
			JSON.stringify(
				{
					runId: "cancel-first",
					mode: "parallel",
					state: "paused",
					startedAt: 100,
					sessionId: "session-owner",
					steps: [
						{
							agent: "a",
							status: "cancelled",
							sessionFile: sessionPath,
							cancel: { summary: "Cancelled", cancelledAt: 250 },
						},
						{ agent: "b", status: "paused", pause: { kind: "awaiting_supervisor", pausedAt: 200 } },
					],
					pause: { kind: "awaiting_supervisor", pausedAt: 200 },
					lifecycle: { generation: 2 },
				},
				null,
				2,
			),
			"utf-8",
		);
		const { pi, sent } = createNotifyHarness();
		const state = createState("session-owner");
		registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
		const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
		try {
			const resultPath = path.join(resultsDir, "cancel-first.json");
			fs.writeFileSync(
				resultPath,
				JSON.stringify({
					lifecycleArtifactVersion: 1,
					id: "cancel-first",
					runId: "cancel-first",
					agent: "parallel:a+b",
					success: false,
					state: "paused",
					summary: "Paused awaiting supervisor.",
					results: [
						{
							agent: "a",
							success: false,
							interrupted: true,
							output: "Paused awaiting supervisor.",
							sessionFile: sessionPath,
						},
						{ agent: "b", success: false, interrupted: true, output: "Still paused." },
					],
					sessionId: "session-owner",
					asyncDir,
				}),
				"utf-8",
			);
			watcher.primeExistingResults();
			await waitUntil(() => !fs.existsSync(resultPath));
			assert.deepEqual(sent, []);
		} finally {
			watcher.stopResultWatcher();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("notifies once when the watcher wins before cancel removes the paused child", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-cancel-second-"));
		const resultsDir = path.join(root, "results");
		const asyncDir = path.join(root, "async", "cancel-second");
		fs.mkdirSync(resultsDir, { recursive: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		const sessionPath = path.join(resultsDir, "cancel-second-session.jsonl");
		fs.writeFileSync(sessionPath, "session\n", "utf-8");
		fs.writeFileSync(
			path.join(asyncDir, "status.json"),
			JSON.stringify(
				{
					runId: "cancel-second",
					mode: "single",
					state: "paused",
					startedAt: 100,
					sessionId: "session-owner",
					steps: [
						{
							agent: "worker",
							status: "paused",
							sessionFile: sessionPath,
							pause: { kind: "awaiting_supervisor", pausedAt: 200 },
						},
					],
					pause: { kind: "awaiting_supervisor", pausedAt: 200 },
				},
				null,
				2,
			),
			"utf-8",
		);
		const { pi, sent } = createNotifyHarness();
		const state = createState("session-owner");
		registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
		const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
		try {
			const resultPath = path.join(resultsDir, "cancel-second.json");
			fs.writeFileSync(
				resultPath,
				JSON.stringify({
					lifecycleArtifactVersion: 1,
					id: "cancel-second",
					runId: "cancel-second",
					agent: "worker",
					success: false,
					state: "paused",
					summary: "Paused awaiting supervisor.",
					results: [
						{
							agent: "worker",
							success: false,
							interrupted: true,
							output: "Paused awaiting supervisor.",
							sessionFile: sessionPath,
						},
					],
					sessionId: "session-owner",
					asyncDir,
				}),
				"utf-8",
			);
			watcher.primeExistingResults();
			await waitUntil(() => sent.length === 1);
			assert.match(sent[0] ?? "", /^Background task paused:/);
			fs.writeFileSync(
				path.join(asyncDir, "status.json"),
				JSON.stringify(
					{
						runId: "cancel-second",
						mode: "single",
						state: "cancelled",
						startedAt: 100,
						sessionId: "session-owner",
						steps: [
							{
								agent: "worker",
								status: "cancelled",
								sessionFile: sessionPath,
								cancel: { summary: "Cancelled", cancelledAt: 250 },
							},
						],
						cancel: { summary: "Cancelled", cancelledAt: 250 },
						lifecycle: { generation: 1 },
					},
					null,
					2,
				),
				"utf-8",
			);
			watcher.primeExistingResults();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(sent.length, 1);
		} finally {
			watcher.stopResultWatcher();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("retries paused artifacts while canonical state is still uncertain", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-pausing-retry-"));
		const resultsDir = path.join(root, "results");
		const asyncDir = path.join(root, "async", "pausing-retry");
		fs.mkdirSync(resultsDir, { recursive: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		const sessionPath = path.join(resultsDir, "pausing-retry-session.jsonl");
		fs.writeFileSync(sessionPath, "session\n", "utf-8");
		fs.writeFileSync(
			path.join(asyncDir, "status.json"),
			JSON.stringify(
				{
					runId: "pausing-retry",
					mode: "single",
					state: "pausing",
					startedAt: 100,
					sessionId: "session-owner",
					steps: [
						{
							agent: "worker",
							status: "pausing",
							sessionFile: sessionPath,
							pause: { kind: "awaiting_supervisor", requestedAt: 150 },
						},
					],
					pause: { kind: "awaiting_supervisor", requestedAt: 150 },
				},
				null,
				2,
			),
			"utf-8",
		);
		const { pi, sent } = createNotifyHarness();
		const state = createState("session-owner");
		registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
		const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
		try {
			const resultPath = path.join(resultsDir, "pausing-retry.json");
			const pausedResult = {
				lifecycleArtifactVersion: 1,
				id: "pausing-retry",
				runId: "pausing-retry",
				agent: "worker",
				success: false,
				state: "paused",
				summary: "Paused awaiting supervisor.",
				results: [
					{
						agent: "worker",
						success: false,
						interrupted: true,
						output: "Paused awaiting supervisor.",
						sessionFile: sessionPath,
					},
				],
				sessionId: "session-owner",
				asyncDir,
			};
			fs.writeFileSync(resultPath, JSON.stringify(pausedResult), "utf-8");
			watcher.primeExistingResults();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(sent.length, 0);
			assert.equal(fs.existsSync(resultPath), true);
			fs.writeFileSync(
				path.join(asyncDir, "status.json"),
				JSON.stringify(
					{
						runId: "pausing-retry",
						mode: "single",
						state: "paused",
						startedAt: 100,
						sessionId: "session-owner",
						steps: [
							{
								agent: "worker",
								status: "paused",
								sessionFile: sessionPath,
								pause: { kind: "awaiting_supervisor", pausedAt: 200 },
							},
						],
						pause: { kind: "awaiting_supervisor", pausedAt: 200 },
					},
					null,
					2,
				),
				"utf-8",
			);
			watcher.primeExistingResults();
			await waitUntil(() => sent.length === 1);
		} finally {
			watcher.stopResultWatcher();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("retries paused artifact consumption after a post-notify unlink failure without duplicating the notification", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-unlink-retry-"));
		const resultsDir = path.join(root, "results");
		const asyncDir = path.join(root, "async", "unlink-retry");
		fs.mkdirSync(resultsDir, { recursive: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		const sessionPath = path.join(resultsDir, "unlink-retry-session.jsonl");
		fs.writeFileSync(sessionPath, "session\n", "utf-8");
		fs.writeFileSync(
			path.join(asyncDir, "status.json"),
			JSON.stringify(
				{
					runId: "unlink-retry",
					mode: "single",
					state: "paused",
					startedAt: 100,
					sessionId: "session-owner",
					steps: [
						{
							agent: "worker",
							status: "paused",
							sessionFile: sessionPath,
							pause: { kind: "awaiting_supervisor", pausedAt: 200 },
						},
					],
					pause: { kind: "awaiting_supervisor", pausedAt: 200 },
				},
				null,
				2,
			),
			"utf-8",
		);
		let firstUnlinkFailure = true;
		const fsProxy = {
			existsSync: fs.existsSync.bind(fs),
			readFileSync: fs.readFileSync.bind(fs),
			unlinkSync(filePath: fs.PathLike) {
				if (firstUnlinkFailure && String(filePath).endsWith("unlink-retry.json")) {
					firstUnlinkFailure = false;
					throw new Error("simulated unlink failure");
				}
				return fs.unlinkSync(filePath);
			},
			readdirSync: fs.readdirSync.bind(fs),
			mkdirSync: fs.mkdirSync.bind(fs),
			realpathSync: fs.realpathSync.bind(fs),
			watch: fs.watch.bind(fs),
		};
		const { pi, sent } = createNotifyHarness();
		const state = createState("session-owner");
		registerSubagentNotify(pi as never, state, { batchConfig: { enabled: false } });
		const watcher = createResultWatcher(pi, state, resultsDir, 60_000, { fs: fsProxy });
		try {
			const resultPath = path.join(resultsDir, "unlink-retry.json");
			fs.writeFileSync(
				resultPath,
				JSON.stringify({
					lifecycleArtifactVersion: 1,
					id: "unlink-retry",
					runId: "unlink-retry",
					agent: "worker",
					success: false,
					state: "paused",
					summary: "Paused awaiting supervisor.",
					results: [
						{
							agent: "worker",
							success: false,
							interrupted: true,
							output: "Paused awaiting supervisor.",
							sessionFile: sessionPath,
						},
					],
					sessionId: "session-owner",
					asyncDir,
				}),
				"utf-8",
			);
			watcher.primeExistingResults();
			await waitUntil(() => sent.length === 1);
			assert.equal(fs.existsSync(resultPath), true);
			watcher.primeExistingResults();
			await waitUntil(() => !fs.existsSync(resultPath));
			assert.equal(sent.length, 1);
		} finally {
			watcher.stopResultWatcher();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("delivers an exact all-completed-child stale repair immediately while success remains batchable", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-stale-notify-"));
		const resultsDir = path.join(root, "results");
		const asyncDir = path.join(root, "async", "stale-completed-children");
		fs.mkdirSync(resultsDir, { recursive: true });
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(
			path.join(asyncDir, "status.json"),
			JSON.stringify(
				{
					runId: "stale-completed-children",
					sessionId: "session-owner",
					mode: "parallel",
					state: "running",
					pid: 424242,
					startedAt: 1_000,
					lastUpdate: 1_500,
					steps: [
						{ agent: "alpha", status: "complete", startedAt: 1_000, endedAt: 1_200, exitCode: 0 },
						{ agent: "beta", status: "complete", startedAt: 1_000, endedAt: 1_300, exitCode: 0 },
					],
				},
				null,
				2,
			),
			"utf-8",
		);

		const listeners = new Map<string, Set<(payload: unknown) => void>>();
		const sent: Array<{ message: { content?: string } }> = [];
		const sentUserMessages: Array<{ content: string; options?: { deliverAs?: string } }> = [];
		const pi = {
			events: {
				on(event: string, handler: (payload: unknown) => void) {
					const handlers = listeners.get(event) ?? new Set();
					handlers.add(handler);
					listeners.set(event, handlers);
					return () => handlers.delete(handler);
				},
				emit(event: string, data: unknown) {
					for (const handler of listeners.get(event) ?? []) handler(data);
				},
			},
			on(_event: string, _handler: (...args: unknown[]) => void) {},
			sendMessage(message: { content?: string }) {
				sent.push({ message });
			},
			sendUserMessage(content: string, options?: { deliverAs?: string }) {
				sentUserMessages.push({ content, options });
			},
		};
		const state = createState("session-owner");
		registerSubagentNotify(pi as never, state, {
			batchConfig: {
				enabled: true,
				debounceMs: 1_000,
				maxWaitMs: 2_000,
				stragglerDebounceMs: 1_000,
				stragglerMaxWaitMs: 2_000,
				stragglerWindowMs: 2_000,
			},
		});
		const watcher = createResultWatcher(pi, state, resultsDir, 60_000);

		try {
			const successPath = path.join(resultsDir, "01-batched-success.json");
			fs.writeFileSync(
				successPath,
				JSON.stringify({
					id: "batched-success",
					agent: "ordinary-worker",
					success: true,
					state: "complete",
					summary: "ordinary success",
					sessionId: "session-owner",
				}),
				"utf-8",
			);
			watcher.primeExistingResults();
			await waitUntil(() => !fs.existsSync(successPath));
			assert.equal(sent.length, 0, "the successful completion should still be held by batching");

			const repaired = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => {
					const error = new Error("missing") as NodeJS.ErrnoException;
					error.code = "ESRCH";
					throw error;
				},
				now: () => 2_000,
			});
			assert.equal(repaired.repaired, true);
			const repairedPath = path.join(resultsDir, "stale-completed-children.json");
			const repairedResult = JSON.parse(fs.readFileSync(repairedPath, "utf-8"));
			assert.deepEqual(
				repairedResult.results.map((child: { success?: boolean }) => child.success),
				[true, true],
			);
			assert.equal(repairedResult.success, false);
			assert.equal(repairedResult.state, "failed");
			assert.equal(
				repairedResult.summary,
				"Async runner process 424242 exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.",
			);

			watcher.primeExistingResults();
			await waitUntil(() => sent.length === 2);
			assert.match(sent[0]!.message.content ?? "", /^Background task completed: \*\*ordinary-worker\*\*/);
			const failure = sent[1]!.message.content ?? "";
			assert.match(failure, /^Background task failed: \*\*alpha\*\*/);
			assert.ok(failure.indexOf(repairedResult.summary) < failure.indexOf("Children: 2 completed"));
			// E′ protocol: no triggerTurn on sendMessage; the failure flushes the
			// held success in the same synchronous burst, so exactly one nudge.
			assert.equal(sentUserMessages.length, 1);
			assert.deepEqual(sentUserMessages[0], {
				content: "[tlh] Background subagent completed — see notification above.",
				options: { deliverAs: "followUp" },
			});
		} finally {
			watcher.stopResultWatcher();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
