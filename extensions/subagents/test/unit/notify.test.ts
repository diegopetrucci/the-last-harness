import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import registerSubagentNotify, {
	MAX_COMPLETION_MESSAGE_CHARS,
	MAX_DISPLAY_SUMMARY_CHARS,
	buildCompletionDetails,
	formatGroupedCompletion,
	formatSingleCompletion,
	type RegisterSubagentNotifyOptions,
	type SubagentNotifyDetails,
} from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";

const NUDGE_TEXT = "[tlh] Background subagent completed — see notification above.";

function createPi(currentSessionId = "session-1", registerOptions: RegisterSubagentNotifyOptions = {}) {
	const events = new EventEmitter();
	const sentMessages: Array<{ message: unknown; options: unknown }> = [];
	const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
	const lifecycleHandlers = new Map<string, (...args: unknown[]) => void>();
	const pi = {
		events,
		on(event: string, handler: (...args: unknown[]) => void) {
			lifecycleHandlers.set(event, handler);
		},
		sendMessage(message: unknown, options?: unknown) {
			sentMessages.push({ message, options });
		},
		sendUserMessage(content: unknown, options?: unknown) {
			sentUserMessages.push({ content, options });
		},
	};

	// Formatting-focused tests run with batching disabled so single completions
	// emit synchronously. Batching behavior is covered by the dedicated suite below.
	registerSubagentNotify(pi as never, { currentSessionId }, { batchConfig: { enabled: false }, ...registerOptions });

	return { events, sentMessages, sentUserMessages, lifecycleHandlers };
}

function createBatchingPi(clock: ReturnType<typeof createFakeClock>, currentSessionId = "session-a") {
	const events = new EventEmitter();
	const sentMessages: Array<{ message: unknown; options: unknown }> = [];
	const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
	const lifecycleHandlers = new Map<string, (...args: unknown[]) => void>();
	const state = { currentSessionId };
	const pi = {
		events,
		on(event: string, handler: (...args: unknown[]) => void) {
			lifecycleHandlers.set(event, handler);
		},
		sendMessage(message: unknown, options?: unknown) {
			sentMessages.push({ message, options });
		},
		sendUserMessage(content: unknown, options?: unknown) {
			sentUserMessages.push({ content, options });
		},
	};
	registerSubagentNotify(pi as never, state, {
		batchConfig: {
			enabled: true,
			debounceMs: 150,
			maxWaitMs: 1000,
			stragglerDebounceMs: 75,
			stragglerMaxWaitMs: 400,
			stragglerWindowMs: 2000,
		},
		timers: clock.api,
		now: clock.now,
	});
	return { events, sentMessages, sentUserMessages, state, lifecycleHandlers };
}

interface FakeJob {
	id: number;
	fireAt: number;
	handler: () => void;
}

function createFakeClock() {
	let now = 0;
	let nextId = 1;
	const jobs = new Map<number, FakeJob>();
	const api = {
		setTimeout(handler: () => void, delayMs: number): unknown {
			const id = nextId++;
			jobs.set(id, { id, fireAt: now + delayMs, handler });
			return id;
		},
		clearTimeout(handle: unknown): void {
			if (typeof handle === "number") jobs.delete(handle);
		},
	};
	return {
		api,
		now: () => now,
		advance(ms: number): void {
			now += ms;
			const due = [...jobs.values()].filter((job) => job.fireAt <= now).sort((a, b) => a.fireAt - b.fireAt);
			for (const job of due) {
				if (!jobs.has(job.id)) continue;
				jobs.delete(job.id);
				job.handler();
			}
		},
	};
}

function completionResult(overrides: Record<string, unknown> = {}) {
	return {
		id: `notify-${Math.random().toString(36).slice(2)}`,
		agent: "worker",
		success: true,
		summary: "Done",
		exitCode: 0,
		timestamp: 123,
		sessionId: "session-a",
		...overrides,
	};
}

describe("registerSubagentNotify", () => {
	it("uses a fallback summary when a background completion is empty", () => {
		const { events, sentMessages, sentUserMessages } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-empty-1",
			agent: "worker",
			success: true,
			summary: "",
			exitCode: 0,
			timestamp: 123,
			sessionId: "session-1",
		});

		// E′ protocol: one sendMessage (no options) + one sendUserMessage nudge (idle path)
		assert.equal(sentMessages.length, 1);
		assert.equal(sentUserMessages.length, 1);
		assert.deepEqual(sentMessages[0], {
			message: {
				customType: "subagent-notify",
				content: "Background task completed: **worker**\n\nAsync id: notify-empty-1\n\n(no output)",
				display: true,
				details: { agent: "worker", status: "completed", resultPreview: "", asyncId: "notify-empty-1" },
			},
			options: undefined,
		});
		assert.deepEqual(sentUserMessages[0], {
			content: NUDGE_TEXT,
			options: { deliverAs: "followUp" },
		});
	});

	it("preserves non-empty completion summaries", () => {
		const { events, sentMessages, sentUserMessages } = createPi();
		const summary = "  Done streaming\nAll clear  ";

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-summary-1",
			agent: "worker",
			success: true,
			summary,
			exitCode: 0,
			timestamp: 456,
			taskIndex: 1,
			totalTasks: 3,
			sessionId: "session-1",
		});

		assert.equal(sentMessages.length, 1);
		assert.equal(sentUserMessages.length, 1);
		assert.deepEqual(sentMessages[0], {
			message: {
				customType: "subagent-notify",
				content: `Background task completed: **worker** (2/3)\n\nAsync id: notify-summary-1\n\n${summary}`,
				display: true,
				details: {
					agent: "worker",
					status: "completed",
					taskInfo: " (2/3)",
					resultPreview: summary,
					asyncId: "notify-summary-1",
				},
			},
			options: undefined,
		});
		assert.deepEqual(sentUserMessages[0], {
			content: NUDGE_TEXT,
			options: { deliverAs: "followUp" },
		});
	});

	it("shows async id and top-level resume guidance only when the session file exists", () => {
		const { events, sentMessages, sentUserMessages } = createPi();
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-single-session-"));
		const sessionFile = path.join(resultsDir, "session.jsonl");
		fs.writeFileSync(sessionFile, "session\n", "utf-8");

		try {
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				id: "notify-event-1",
				runId: "notify-run-1",
				agent: "worker",
				success: true,
				summary: "Done",
				exitCode: 0,
				timestamp: 456,
				sessionFile,
				sessionId: "session-1",
			});
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}

		assert.equal(sentMessages.length, 1);
		assert.equal(sentUserMessages.length, 1);
		assert.deepEqual(sentMessages[0], {
			message: {
				customType: "subagent-notify",
				content: `Background task completed: **worker**\n\nAsync id: notify-event-1\nRevive: subagent({ action: "resume", id: "notify-event-1", message: "..." })\n\nDone\n\nSession file: ${sessionFile}`,
				display: true,
				details: {
					agent: "worker",
					status: "completed",
					resultPreview: "Done",
					asyncId: "notify-event-1",
					resumeTarget: { sessionPath: sessionFile },
					sessionLabel: "Session file",
					sessionValue: sessionFile,
				},
			},
			options: undefined,
		});
		assert.deepEqual(sentUserMessages[0], {
			content: NUDGE_TEXT,
			options: { deliverAs: "followUp" },
		});
	});

	it("does not advertise resume guidance when the session file is missing", () => {
		const { events, sentMessages, sentUserMessages } = createPi();
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-missing-session-"));
		const missingSession = path.join(resultsDir, "missing-session.jsonl");

		try {
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				id: null,
				runId: "notify-run-fallback",
				agent: "worker",
				success: true,
				summary: "Done",
				exitCode: 0,
				timestamp: 456,
				sessionFile: missingSession,
				sessionId: "session-1",
			});

			assert.equal(sentMessages.length, 1);
			assert.equal(sentUserMessages.length, 1);
			assert.deepEqual(sentMessages[0], {
				message: {
					customType: "subagent-notify",
					content: `Background task completed: **worker**\n\nAsync id: notify-run-fallback\n\nDone\n\nSession file: ${missingSession}`,
					display: true,
					details: {
						agent: "worker",
						status: "completed",
						resultPreview: "Done",
						asyncId: "notify-run-fallback",
						sessionLabel: "Session file",
						sessionValue: missingSession,
					},
				},
				options: undefined,
			});
			assert.deepEqual(sentUserMessages[0], {
				content: NUDGE_TEXT,
				options: { deliverAs: "followUp" },
			});
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("labels paused completions as paused even without an exit code", () => {
		const { events, sentMessages, sentUserMessages } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-paused-1",
			agent: "worker",
			success: false,
			state: "paused",
			summary: "Paused after interrupt. Waiting for explicit next action.",
			timestamp: 789,
			sessionId: "session-1",
		});

		// Paused runs bypass grouping and emit immediately; idle path → nudge
		assert.equal(sentMessages.length, 1);
		assert.equal(sentUserMessages.length, 1);
		assert.deepEqual(sentMessages[0], {
			message: {
				customType: "subagent-notify",
				content:
					"Background task paused: **worker**\n\nAsync id: notify-paused-1\n\nPaused after interrupt. Waiting for explicit next action.",
				display: true,
				details: {
					agent: "worker",
					status: "paused",
					resultPreview: "Paused after interrupt. Waiting for explicit next action.",
					asyncId: "notify-paused-1",
				},
			},
			options: undefined,
		});
		assert.deepEqual(sentUserMessages[0], {
			content: NUDGE_TEXT,
			options: { deliverAs: "followUp" },
		});
	});

	it("formats normalized child results into one native completion notice", () => {
		const { events, sentMessages, sentUserMessages } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-grouped-1",
			agent: "parallel:a+b",
			success: false,
			state: "failed",
			summary: "Combined summary",
			timestamp: 100,
			sessionId: "session-1",
			results: [
				{
					agent: "a",
					status: "completed",
					summary: "Result from a",
					sessionPath: "/tmp/a-session.jsonl",
					artifactPath: "/tmp/a-output.md",
				},
				{
					agent: "b",
					status: "failed",
					summary: "B failed\n\nOutput:\nResult from b",
					children: [{ agent: "nested-b", state: "failed" }],
				},
			],
		});

		assert.equal(sentMessages.length, 1);
		assert.equal(sentUserMessages.length, 1);
		const content = (sentMessages[0]!.message as { content: string }).content;
		assert.match(content, /^Background task failed: \*\*parallel:a\+b\*\*/);
		assert.match(content, /Children: 1 completed, 1 failed/);
		assert.match(
			content,
			/1\/2\. a — completed\nResult from a\nOutput artifact: \/tmp\/a-output\.md\nSession: \/tmp\/a-session\.jsonl/,
		);
		assert.match(
			content,
			/2\/2\. b — failed\nB failed\n\nOutput:\nResult from b\nNested subagents:\n   ↳ nested-b — failed/,
		);
		// sendMessage has no options (no triggerTurn)
		assert.equal(sentMessages[0]!.options, undefined);
		// nudge is sent once (idle path, fails bypass grouping)
		assert.deepEqual(sentUserMessages[0], { content: NUDGE_TEXT, options: { deliverAs: "followUp" } });
	});

	it("prioritizes failed and paused children with original numbering and resumable indexes", () => {
		const { events, sentMessages, sentUserMessages } = createPi();
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-urgent-children-"));
		const completedSession = path.join(resultsDir, "child-1.jsonl");
		const failedSession = path.join(resultsDir, "child-9.jsonl");
		fs.writeFileSync(completedSession, "session\n", "utf-8");
		fs.writeFileSync(failedSession, "session\n", "utf-8");
		const results = Array.from({ length: 10 }, (_, index) => ({
			agent: `worker-${index}`,
			status: index === 8 ? "failed" : index === 9 ? "paused" : "completed",
			// Sized above the per-child budget at this fan-out (8 displayed -> 4 000 each) so the
			// notice still exercises a capped scenario, as it did against the original 1 200 cap.
			summary: `${index}: ${"x".repeat(4_500)}`,
			...(index === 0
				? { sessionPath: completedSession, index }
				: index === 8
					? { sessionPath: failedSession, index }
					: { index }),
		}));

		try {
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				id: "notify-urgent-1",
				runId: "notify-urgent-run-1",
				agent: "parallel:urgent",
				success: true,
				summary: "outer",
				timestamp: 100,
				sessionId: "session-1",
				results,
			});
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}

		assert.equal(sentMessages.length, 1);
		assert.equal(sentUserMessages.length, 1);
		const content = (sentMessages[0]!.message as { content: string }).content;
		assert.ok(content.length <= MAX_COMPLETION_MESSAGE_CHARS);
		assert.match(content, /^Background task failed: \*\*parallel:urgent\*\*/);
		assert.match(content, /Children: 8 completed, 1 failed, 1 paused/);
		assert.match(content, /… \[2 child results omitted\]/);
		assert.match(content, /9\/10\. worker-8 — failed/);
		assert.match(content, /10\/10\. worker-9 — paused/);
		assert.match(content, /Async id: notify-urgent-1/);
		assert.match(
			content,
			/Revive child: subagent\({ action: "resume", id: "notify-urgent-1", index: 8, message: "\.\.\." }\)/,
		);
		assert.doesNotMatch(content, /Async id: notify-urgent-run-1/);
		assert.ok(
			content.indexOf("Async id: notify-urgent-1") < content.indexOf("Children: 8 completed, 1 failed, 1 paused"),
		);
		assert.ok(content.indexOf("9/10. worker-8 — failed") < content.indexOf("1/10. worker-0 — completed"));
		assert.ok(
			content.includes("9/10. worker-8 — failed"),
			"urgent child details must survive the final completion cap",
		);
		// Tail-preserving truncation shrinks the preview body rather than end-cutting the
		// assembled message, so the absolute backstop marker stays unreachable even at this
		// fan-out. Per-summary truncation still applies (see marker below).
		assert.ok(
			!content.includes("… [completion message truncated]"),
			"tail-preserving truncation must keep the absolute backstop unreachable",
		);
		assert.match(content, /… \[summary truncated\]/);
		// sendMessage no options; nudge once (idle, failed — immediate path)
		assert.equal(sentMessages[0]!.options, undefined);
		assert.deepEqual(sentUserMessages[0], { content: NUDGE_TEXT, options: { deliverAs: "followUp" } });
	});

	it("bounds oversized single-notice content and attached preview while retaining status and safe references", () => {
		const { events, sentMessages, sentUserMessages } = createPi();
		const deepNested = [
			{
				agent: "nested-root",
				state: "complete",
				children: [
					{
						agent: "nested-level-2",
						state: "complete",
						children: [{ agent: "nested-too-deep", state: "complete" }],
					},
				],
			},
			...Array.from({ length: 10 }, (_, index) => ({ agent: `nested-sibling-${index}`, state: "complete" })),
		];
		const results = Array.from({ length: 10 }, (_, index) => ({
			agent: `worker-${index}`,
			status: index === 9 ? "failed" : "completed",
			summary: `${index}: ${"x".repeat(4_000)}`,
			...(index === 0
				? {
						artifactPath: "/safe/artifacts/worker-0.md",
						sessionPath: "/safe/sessions/worker-0.jsonl",
						intercomTarget: "stale-target-must-not-appear",
						children: deepNested,
					}
				: {}),
		}));

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-oversized-1",
			agent: "parallel:oversized",
			success: true,
			summary: "outer",
			timestamp: 100,
			sessionId: "session-1",
			intercomTarget: "stale-owner-target-must-not-appear",
			results,
		});

		assert.equal(sentMessages.length, 1);
		assert.equal(sentUserMessages.length, 1);
		// No options on sendMessage
		assert.equal(sentMessages[0]!.options, undefined);
		const message = sentMessages[0]!.message as { content: string; details?: SubagentNotifyDetails };
		const content = message.content;
		assert.ok(content.length <= MAX_COMPLETION_MESSAGE_CHARS);
		assert.ok(message.details, "single notices must retain structured metadata");
		assert.equal(message.details.asyncId, "notify-oversized-1");
		assert.ok(message.details.resultPreview.length <= MAX_DISPLAY_SUMMARY_CHARS);
		assert.match(message.details.resultPreview, /… \[summary truncated\]$/);
		assert.match(content, /^Background task failed: \*\*parallel:oversized\*\*/);
		assert.match(content, /Children: 9 completed, 1 failed/);
		assert.match(content, /… \[2 child results omitted\]/);
		assert.match(content, /… \[summary truncated\]/);
		assert.match(content, /Output artifact: \/safe\/artifacts\/worker-0\.md/);
		assert.match(content, /Session: \/safe\/sessions\/worker-0\.jsonl/);
		assert.match(content, /… \[nested depth limit reached\]/);
		assert.match(content, /… \[additional nested entries omitted\]/);
		// Oversized per-child summaries are clamped to the pool-derived per-child budget, so the
		// assembled message fits the envelope without the backstop firing. This is what keeps the
		// trailing recovery references (asserted above) from being truncated away.
		assert.ok(
			!content.includes("… [completion message truncated]"),
			"pool-budgeted summaries must leave envelope headroom so the backstop does not fire",
		);
		assert.ok(content.length <= MAX_COMPLETION_MESSAGE_CHARS);
		assert.doesNotMatch(content, /stale-target/);
		// nudge sent once (idle, failed — immediate path)
		assert.deepEqual(sentUserMessages[0], { content: NUDGE_TEXT, options: { deliverAs: "followUp" } });
	});

	it("redacts protected paused lifecycle paths from content and structured details", () => {
		const { events, sentMessages, sentUserMessages } = createPi();
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-paused-private-"));
		const sessionPath = path.join(resultsDir, "private-session.jsonl");
		fs.writeFileSync(sessionPath, "session\n", "utf-8");
		try {
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				id: "notify-paused-private",
				agent: "parallel:a+b",
				success: false,
				state: "paused",
				pause: { kind: "awaiting_supervisor" },
				summary: "Paused awaiting supervisor at /private/root/project after pid 43210.",
				timestamp: 100,
				sessionId: "session-1",
				shareUrl: "https://share/private-run",
				results: [
					{
						agent: "a",
						status: "completed",
						summary: "done at /private/root/a.ts",
						artifactPath: "/private/artifacts/a.md",
						sessionPath,
						index: 0,
					},
					{
						agent: "b",
						status: "paused",
						summary: "paused pgid 54321",
						sessionPath,
						index: 1,
						children: [{ agent: "nested-b", state: "paused" }],
					},
				],
			});
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}

		assert.equal(sentMessages.length, 1);
		assert.equal(sentUserMessages.length, 1);
		assert.equal(sentMessages[0]!.options, undefined);
		const message = sentMessages[0]!.message as { content: string; details?: SubagentNotifyDetails };
		assert.match(message.content, /^Background task paused: \*\*parallel:a\+b\*\*/);
		assert.match(message.content, /Async id: notify-paused-private/);
		assert.match(
			message.content,
			/Resume unchanged: subagent\({ action: "resume", id: "notify-paused-private", index: 1 }\)/,
		);
		assert.doesNotMatch(
			message.content,
			/private-run|private-session|\/private\/|pid 43210|pgid 54321|Output artifact:|Session:/,
		);
		assert.equal(message.details?.sessionValue, undefined);
		assert.deepEqual(message.details?.resumeTarget, { index: 1, childCount: 2 });
		assert.equal("sessionPath" in (message.details?.resumeTarget ?? {}), false);
		assert.doesNotMatch(
			JSON.stringify(message.details),
			/private-run|private-session|\/private\/|pid 43210|pgid 54321/,
		);
		assert.doesNotMatch(
			message.details?.resultPreview ?? "",
			/private-run|private-session|\/private\/|pid 43210|pgid 54321/,
		);
		assert.match(message.details?.resultPreview ?? "", /Children: 1 completed, 1 paused/);
		assert.deepEqual(sentUserMessages[0], { content: NUDGE_TEXT, options: { deliverAs: "followUp" } });
	});

	it("bounds oversized share errors from a normalized chain in content and attached details", () => {
		const { events, sentMessages, sentUserMessages } = createPi();
		const shareError = `share failed: ${"sensitive-detail-".repeat(400)}unbounded-tail`;

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-oversized-share-error",
			agent: "chain:a+b",
			success: false,
			summary: "Done with a share failure",
			shareError,
			results: [
				{ agent: "a", status: "completed", summary: "a done" },
				{ agent: "b", status: "failed", summary: "Done with a share failure" },
			],
			timestamp: 100,
			sessionId: "session-1",
		});

		assert.equal(sentMessages.length, 1);
		assert.equal(sentUserMessages.length, 1);
		assert.equal(sentMessages[0]!.options, undefined);
		const message = sentMessages[0]!.message as { content: string; details?: SubagentNotifyDetails };
		assert.ok(message.details);
		assert.equal(message.details.sessionLabel, "Session share error");
		assert.ok((message.details.sessionValue?.length ?? 0) <= 500);
		assert.match(message.details.sessionValue ?? "", /… \[reference truncated\]$/);
		assert.doesNotMatch(message.details.sessionValue ?? "", /unbounded-tail/);
		assert.match(message.content, /Session share error: .*… \[reference truncated\]$/);
		assert.doesNotMatch(message.content, /unbounded-tail/);
		assert.deepEqual(sentUserMessages[0], { content: NUDGE_TEXT, options: { deliverAs: "followUp" } });
	});

	it("ignores completions for other or missing session ids", () => {
		const { events, sentMessages, sentUserMessages } = createPi("session-owner");

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-other-session",
			agent: "worker",
			success: true,
			summary: "Other done",
			timestamp: 100,
			sessionId: "session-other",
		});
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-sessionless",
			agent: "worker",
			success: true,
			summary: "Legacy cwd-scoped done",
			timestamp: 101,
			cwd: "/repo",
		});

		assert.deepEqual(sentMessages, []);
		assert.deepEqual(sentUserMessages, []);
	});

	it("reads idleness live at send time and sends no nudge while streaming", () => {
		const { events, sentMessages, sentUserMessages, lifecycleHandlers } = createPi("session-1");

		// Capture a session context whose isIdle() reads live state, mirroring
		// how Pi context methods are closures over the runner.
		let idle = false;
		lifecycleHandlers.get("session_start")?.({}, { isIdle: () => idle });

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-streaming-1",
			agent: "worker",
			success: true,
			summary: "Done while streaming",
			exitCode: 0,
			timestamp: 123,
			sessionId: "session-1",
		});

		// Custom message sent, but NO nudge (streaming path)
		assert.equal(sentMessages.length, 1);
		assert.equal(sentUserMessages.length, 0, "no nudge must be sent when session is streaming");
		assert.equal(sentMessages[0]!.options, undefined);
		const content = (sentMessages[0]!.message as { content: string }).content;
		assert.match(content, /^Background task completed: \*\*worker\*\*/);

		// The same captured context reports idle again — no re-capture needed;
		// the next completion must send the nudge.
		idle = true;

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-after-settle-1",
			agent: "worker",
			success: true,
			summary: "Done after settle",
			exitCode: 0,
			timestamp: 124,
			sessionId: "session-1",
		});

		assert.equal(sentMessages.length, 2);
		assert.equal(sentUserMessages.length, 1, "nudge must be sent once the live idleness read reports idle");
		assert.deepEqual(sentUserMessages[0], { content: NUDGE_TEXT, options: { deliverAs: "followUp" } });
	});

	it("nudges when no session context has been captured yet (assumed idle)", () => {
		const { events, sentMessages, sentUserMessages } = createPi("session-1");

		// No session_start fired — sendCompletion must assume idle and nudge.
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-no-ctx-1",
			agent: "worker",
			success: true,
			summary: "Done",
			exitCode: 0,
			timestamp: 123,
			sessionId: "session-1",
		});

		assert.equal(sentMessages.length, 1);
		assert.equal(sentUserMessages.length, 1);
		assert.deepEqual(sentUserMessages[0], { content: NUDGE_TEXT, options: { deliverAs: "followUp" } });
	});

	it("emits failed completions immediately even while successes are held", () => {
		const clock = createFakeClock();
		const { events, sentMessages, sentUserMessages } = createBatchingPi(clock);

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "ok-1", agent: "ok-1", summary: "ok-1 done" }));
		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({ id: "fail-1", agent: "fail-1", success: false, summary: "boom", exitCode: 1 }),
		);

		// The failure must arrive immediately, and the held success must be
		// flushed ahead of it rather than waiting on the debounce timer.
		assert.equal(sentMessages.length, 2);
		assert.match((sentMessages[0]!.message as { content: string }).content, /Background task completed: \*\*ok-1\*\*/);
		assert.match((sentMessages[1]!.message as { content: string }).content, /Background task failed: \*\*fail-1\*\*/);
		// Both messages sent without options (no triggerTurn)
		assert.equal(sentMessages[0]!.options, undefined);
		assert.equal(sentMessages[1]!.options, undefined);
		// Exactly one nudge for the whole synchronous burst (flush + failure)
		assert.equal(sentUserMessages.length, 1);
		assert.deepEqual(sentUserMessages[0], { content: NUDGE_TEXT, options: { deliverAs: "followUp" } });

		// No deferred emission should arrive later.
		clock.advance(1000);
		assert.equal(sentMessages.length, 2);
		assert.equal(sentUserMessages.length, 1);
	});

	it("sends exactly one nudge when a non-completion signal flushes held successes in one burst", () => {
		const clock = createFakeClock();
		const { events, sentMessages, sentUserMessages } = createBatchingPi(clock);

		// Two pending successes are held by the batcher.
		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({ id: "held-1", agent: "held-1", summary: "held-1 done" }),
		);
		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({ id: "held-2", agent: "held-2", summary: "held-2 done" }),
		);
		assert.equal(sentMessages.length, 0);
		assert.equal(sentUserMessages.length, 0);

		// A paused signal bypasses grouping: it flushes the held successes and
		// then emits itself, all in one synchronous burst.
		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({
				id: "paused-signal",
				agent: "paused-worker",
				success: false,
				state: "paused",
				summary: "Paused after interrupt.",
			}),
		);

		// Both messages delivered: the grouped successes and the paused signal.
		assert.equal(sentMessages.length, 2);
		assert.match(
			(sentMessages[0]!.message as { content: string }).content,
			/^Background tasks completed \(2\): \*\*held-1\*\*, \*\*held-2\*\*/,
		);
		assert.match(
			(sentMessages[1]!.message as { content: string }).content,
			/^Background task paused: \*\*paused-worker\*\*/,
		);
		// Exactly one nudge for the whole burst, carried by the trailing signal.
		assert.equal(sentUserMessages.length, 1, "a flush+signal burst must produce exactly one nudge");
		assert.deepEqual(sentUserMessages[0], { content: NUDGE_TEXT, options: { deliverAs: "followUp" } });

		clock.advance(1000);
		assert.equal(sentMessages.length, 2);
		assert.equal(sentUserMessages.length, 1);
	});

	it("treats an outer-success grouped result with a failed child as an immediate failure", () => {
		const clock = createFakeClock();
		const { events, sentMessages, sentUserMessages } = createBatchingPi(clock);
		const groupedFailure = completionResult({
			id: "grouped-child-failure-1",
			agent: "parallel:a+b",
			success: true,
			summary: "Combined summary",
			results: [
				{ agent: "a", status: "completed", summary: "a done" },
				{ agent: "b", status: "failed", summary: "b failed" },
			],
		});

		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({ id: "held-before-grouped-failure", agent: "held", summary: "held done" }),
		);
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, groupedFailure);
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, groupedFailure);

		assert.equal(sentMessages.length, 2);
		assert.match((sentMessages[0]!.message as { content: string }).content, /^Background task completed: \*\*held\*\*/);
		const failureContent = (sentMessages[1]!.message as { content: string }).content;
		assert.match(failureContent, /^Background task failed: \*\*parallel:a\+b\*\*/);
		assert.match(failureContent, /Children: 1 completed, 1 failed/);
		// No options on either sendMessage call
		assert.equal(sentMessages[0]!.options, undefined);
		assert.equal(sentMessages[1]!.options, undefined);
		// One nudge for the whole burst: the flush's nudge is suppressed and the
		// immediate failure carries it.
		assert.equal(sentUserMessages.length, 1);
		assert.deepEqual(sentUserMessages[0], { content: NUDGE_TEXT, options: { deliverAs: "followUp" } });

		clock.advance(1000);
		assert.equal(sentMessages.length, 2, "the grouped failed run must notify exactly once");
		assert.equal(sentUserMessages.length, 1);
	});

	it("delivers an outer-failed grouped result immediately instead of success batching", () => {
		const clock = createFakeClock();
		const { events, sentMessages, sentUserMessages } = createBatchingPi(clock);

		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({
				id: "outer-failed-completed-children",
				agent: "parallel:a+b",
				success: false,
				state: "failed",
				summary: "runner disappeared after children completed",
				results: [
					{ agent: "a", status: "completed", summary: "a done" },
					{ agent: "b", status: "completed", summary: "b done" },
				],
			}),
		);

		assert.equal(sentMessages.length, 1);
		assert.equal(sentMessages[0]!.options, undefined);
		const content = (sentMessages[0]!.message as { content: string }).content;
		assert.match(content, /^Background task failed: \*\*parallel:a\+b\*\*/);
		assert.ok(
			content.indexOf("runner disappeared after children completed") < content.indexOf("Children: 2 completed"),
		);
		// Nudge sent (idle, immediate path)
		assert.equal(sentUserMessages.length, 1);
		assert.deepEqual(sentUserMessages[0], { content: NUDGE_TEXT, options: { deliverAs: "followUp" } });
		clock.advance(1000);
		assert.equal(sentMessages.length, 1);
		assert.equal(sentUserMessages.length, 1);
	});

	it("rechecks resumable session existence when a deferred success is delivered", () => {
		const clock = createFakeClock();
		const { events, sentMessages, sentUserMessages } = createBatchingPi(clock);
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-deferred-session-"));
		const sessionFile = path.join(resultsDir, "session.jsonl");
		fs.writeFileSync(sessionFile, "session\n", "utf-8");

		try {
			events.emit(
				SUBAGENT_ASYNC_COMPLETE_EVENT,
				completionResult({
					id: "deferred-session-check",
					sessionFile,
				}),
			);
			assert.equal(sentMessages.length, 0);
			fs.unlinkSync(sessionFile);
			clock.advance(150);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}

		assert.equal(sentMessages.length, 1);
		assert.equal(sentMessages[0]!.options, undefined);
		const content = (sentMessages[0]!.message as { content: string }).content;
		assert.match(content, /Async id: deferred-session-check/);
		assert.doesNotMatch(content, /subagent\({ action: "resume"/);
		// Nudge sent (idle path, deferred batch)
		assert.equal(sentUserMessages.length, 1);
		assert.deepEqual(sentUserMessages[0], { content: NUDGE_TEXT, options: { deliverAs: "followUp" } });
	});

	it("groups sibling successes and emits exactly one nudge per flush", () => {
		const clock = createFakeClock();
		const { events, sentMessages, sentUserMessages } = createBatchingPi(clock);

		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({
				id: "g-1",
				agent: "alpha",
				summary: "alpha done",
				sessionId: "session-a",
				shareUrl: "https://share/alpha",
				results: [{ agent: "alpha", status: "completed", summary: "alpha done" }],
			}),
		);
		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({
				id: "g-2",
				agent: "beta",
				summary: "beta done",
				sessionId: "session-a",
				shareUrl: "https://share/beta",
				results: [{ agent: "beta", status: "completed", summary: "beta done" }],
			}),
		);
		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({ id: "g-3", agent: "gamma", summary: "gamma done", sessionId: "session-a" }),
		);
		assert.equal(sentMessages.length, 0);
		assert.equal(sentUserMessages.length, 0);

		clock.advance(150);
		// One sendMessage for the grouped batch, one nudge (idle, one per flush — not per subagent)
		assert.equal(sentMessages.length, 1);
		assert.equal(sentUserMessages.length, 1, "exactly one nudge per flush for grouped completions");
		const groupedMessage = sentMessages[0]!.message as { content: string; details?: SubagentNotifyDetails };
		const content = groupedMessage.content;
		assert.equal(groupedMessage.details, undefined, "grouped message shape must remain unchanged");
		assert.match(content, /^Background tasks completed \(3\): \*\*alpha\*\*, \*\*beta\*\*, \*\*gamma\*\*/);
		assert.match(content, /1\. alpha\nAsync id: g-1\nalpha done\nSession: https:\/\/share\/alpha/);
		assert.match(content, /2\. beta\nAsync id: g-2\nbeta done\nSession: https:\/\/share\/beta/);
		assert.match(content, /3\. gamma\nAsync id: g-3\ngamma done/);
		// No options on sendMessage
		assert.equal(sentMessages[0]!.options, undefined);
		// Nudge once for the whole grouped flush
		assert.deepEqual(sentUserMessages[0], { content: NUDGE_TEXT, options: { deliverAs: "followUp" } });
	});

	it("retains the owner batcher so late siblings use the shorter straggler debounce", () => {
		const clock = createFakeClock();
		const { events, sentMessages, sentUserMessages } = createBatchingPi(clock, "session-a");

		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({ id: "first-group", agent: "alpha", sessionId: "session-a" }),
		);
		clock.advance(150);
		assert.equal(sentMessages.length, 1);
		assert.equal(sentUserMessages.length, 1);

		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({ id: "late-sibling", agent: "beta", sessionId: "session-a" }),
		);
		clock.advance(74);
		assert.equal(sentMessages.length, 1, "the straggler must remain held before the shorter debounce expires");
		assert.equal(sentUserMessages.length, 1);
		clock.advance(1);

		assert.equal(sentMessages.length, 2);
		assert.match((sentMessages[1]!.message as { content: string }).content, /^Background task completed: \*\*beta\*\*/);
		// No options on sendMessage; nudge sent (idle)
		assert.equal(sentMessages[1]!.options, undefined);
		assert.equal(sentUserMessages.length, 2);
		assert.deepEqual(sentUserMessages[1], { content: NUDGE_TEXT, options: { deliverAs: "followUp" } });
	});

	it("drops a deferred success batch when its owning session is no longer current", () => {
		const clock = createFakeClock();
		const { events, sentMessages, sentUserMessages, state } = createBatchingPi(clock, "session-a");

		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({
				id: "stale-owner-success",
				agent: "session-a-worker",
				summary: "session A done",
				sessionId: "session-a",
			}),
		);
		assert.equal(sentMessages.length, 0);

		state.currentSessionId = "session-b";
		clock.advance(150);

		assert.equal(sentMessages.length, 0, "a stale owner batch must neither send nor trigger a turn in the new session");
		assert.equal(sentUserMessages.length, 0);
	});

	it("flushes a deferred owner success during session shutdown without triggering a new turn or duplicating it later", () => {
		const clock = createFakeClock();
		const { events, sentMessages, sentUserMessages, state, lifecycleHandlers } = createBatchingPi(clock, "session-a");

		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({
				id: "shutdown-flush-success",
				agent: "session-a-worker",
				summary: "session A done",
				sessionId: "session-a",
			}),
		);
		assert.equal(sentMessages.length, 0);

		lifecycleHandlers.get("session_shutdown")?.({ reason: "switch" });
		assert.equal(sentMessages.length, 1);
		assert.match(
			(sentMessages[0]!.message as { content: string }).content,
			/^Background task completed: \*\*session-a-worker\*\*/,
		);
		// Shutdown flush: triggerTurn:false → no nudge
		assert.equal(sentMessages[0]!.options, undefined);
		assert.equal(sentUserMessages.length, 0, "no nudge must be sent during session shutdown flush");

		state.currentSessionId = "session-b";
		clock.advance(1000);
		assert.equal(
			sentMessages.length,
			1,
			"the shutdown flush must persist exactly once and never re-deliver into the replacement session",
		);
		assert.equal(sentUserMessages.length, 0);
	});

	it("ignores successes from other sessions instead of grouping them", () => {
		const clock = createFakeClock();
		const { events, sentMessages, sentUserMessages } = createBatchingPi(clock, "session-a");

		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({ id: "s-1", agent: "alpha", summary: "alpha done", sessionId: "session-a" }),
		);
		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({ id: "s-2", agent: "beta", summary: "beta done", sessionId: "session-b" }),
		);
		clock.advance(150);

		assert.equal(sentMessages.length, 1);
		assert.match(
			(sentMessages[0]!.message as { content: string }).content,
			/^Background task completed: \*\*alpha\*\*/,
		);
		assert.doesNotMatch((sentMessages[0]!.message as { content: string }).content, /beta done/);
		assert.equal(sentUserMessages.length, 1);
	});

	it("does not let another session failure flush held successes", () => {
		const clock = createFakeClock();
		const { events, sentMessages, sentUserMessages } = createBatchingPi(clock, "session-a");

		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({ id: "held-a-1", agent: "alpha", summary: "alpha done", sessionId: "session-a" }),
		);
		events.emit(
			SUBAGENT_ASYNC_COMPLETE_EVENT,
			completionResult({
				id: "fail-b-1",
				agent: "beta",
				success: false,
				summary: "boom",
				exitCode: 1,
				sessionId: "session-b",
			}),
		);
		assert.equal(sentMessages.length, 0);

		clock.advance(150);
		assert.equal(sentMessages.length, 1);
		assert.match(
			(sentMessages[0]!.message as { content: string }).content,
			/^Background task completed: \*\*alpha\*\*/,
		);
		assert.doesNotMatch((sentMessages[0]!.message as { content: string }).content, /boom/);
		assert.equal(sentUserMessages.length, 1);
	});
});

describe("completion formatting helpers", () => {
	it("formatSingleCompletion mirrors the in-handler single message shape", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-format-session-"));
		const sessionFile = path.join(resultsDir, "session.jsonl");
		fs.writeFileSync(sessionFile, "session\n", "utf-8");
		try {
			const content = formatSingleCompletion({
				agent: "worker",
				status: "completed",
				taskInfo: " (2/3)",
				resultPreview: "Done",
				asyncId: "notify-1",
				resumeTarget: { sessionPath: sessionFile },
				sessionLabel: "Session file",
				sessionValue: sessionFile,
			});
			assert.equal(
				content,
				`Background task completed: **worker** (2/3)\n\nAsync id: notify-1\nRevive: subagent({ action: "resume", id: "notify-1", message: "..." })\n\nDone\n\nSession file: ${sessionFile}`,
			);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("retains normalized single and multi-child share URLs while suppressing only duplicate top-level session files", () => {
		const sessionFile = "/sessions/worker.jsonl";
		const single = buildCompletionDetails({
			id: "shared-single",
			agent: "worker",
			success: true,
			summary: "done",
			timestamp: 1,
			shareUrl: "https://share/single",
			shareError: "must lose to shareUrl",
			sessionFile,
			results: [{ agent: "worker", status: "completed", summary: "done", sessionPath: sessionFile }],
		});
		assert.equal(single.sessionLabel, "Session");
		assert.equal(single.sessionValue, "https://share/single");
		const singleContent = formatSingleCompletion(single);
		assert.match(singleContent, /Session: https:\/\/share\/single$/);
		assert.equal(
			singleContent.split(sessionFile).length - 1,
			1,
			"the child reference must not be duplicated as a top-level session file",
		);
		assert.doesNotMatch(singleContent, /Session file:/);
		assert.doesNotMatch(singleContent, /must lose to shareUrl/);

		const multi = buildCompletionDetails({
			id: "shared-multi",
			agent: "parallel:a+b",
			success: true,
			summary: "done",
			timestamp: 1,
			shareUrl: "https://share/multi",
			sessionFile: "/sessions/top-level.jsonl",
			results: [
				{ agent: "a", status: "completed", summary: "a done" },
				{ agent: "b", status: "completed", summary: "b done" },
			],
		});
		assert.equal(multi.sessionLabel, "Session");
		assert.equal(multi.sessionValue, "https://share/multi");
		assert.match(formatSingleCompletion(multi), /Session: https:\/\/share\/multi$/);

		const unshared = buildCompletionDetails({
			id: "unshared-single",
			agent: "worker",
			success: true,
			summary: "done",
			timestamp: 1,
			sessionFile,
			results: [{ agent: "worker", status: "completed", summary: "done", sessionPath: sessionFile }],
		});
		assert.equal(unshared.sessionValue, undefined);
		const unsharedContent = formatSingleCompletion(unshared);
		assert.equal(unsharedContent.split(sessionFile).length - 1, 1);
		assert.doesNotMatch(unsharedContent, /Session file:/);
	});

	it("formatGroupedCompletion lists each agent with its summary and session", () => {
		const content = formatGroupedCompletion([
			{ agent: "alpha", status: "completed", resultPreview: "alpha done", asyncId: "alpha-id" },
			{
				agent: "beta",
				status: "completed",
				taskInfo: " (1/2)",
				resultPreview: "",
				asyncId: "beta-id",
				sessionLabel: "Session",
				sessionValue: "https://share/abc",
			},
		]);
		assert.equal(
			content,
			"Background tasks completed (2): **alpha**, **beta** (1/2)\n\n" +
				"1. alpha\nAsync id: alpha-id\nalpha done\n\n" +
				"2. beta (1/2)\nAsync id: beta-id\n(no output)\nSession: https://share/abc",
		);
	});

	it("validates bounded async ids and safely quotes resumable commands", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-safe-id-"));
		const sessionFile = path.join(resultsDir, "session.jsonl");
		fs.writeFileSync(sessionFile, "session\n", "utf-8");
		try {
			const quotedId = 'notify-"quoted';
			const quotedDetails = buildCompletionDetails({
				id: quotedId,
				runId: "unused-run-id",
				agent: "worker",
				success: true,
				summary: "done",
				timestamp: 1,
				sessionFile,
			});
			const quotedContent = formatSingleCompletion(quotedDetails);
			assert.equal(quotedDetails.asyncId, quotedId);
			assert.ok(quotedContent.includes(`id: ${JSON.stringify(quotedId)}`));

			const whitespaceId = "  spaced-id  ";
			const whitespaceDetails = buildCompletionDetails({
				id: whitespaceId,
				runId: "unused-whitespace-fallback",
				agent: "worker",
				success: true,
				summary: "done",
				timestamp: 1,
				sessionFile,
			});
			assert.equal(whitespaceDetails.asyncId, whitespaceId);
			assert.ok(formatSingleCompletion(whitespaceDetails).includes(`id: ${JSON.stringify(whitespaceId)}`));

			for (const rejectedId of ["/tmp/run", "folder/run", "folder\\run", "run..suffix", "   "]) {
				const fallbackDetails = buildCompletionDetails({
					id: rejectedId,
					runId: "resolver-valid-fallback",
					agent: "worker",
					success: true,
					summary: "done",
					timestamp: 1,
					sessionFile,
				});
				assert.equal(fallbackDetails.asyncId, "resolver-valid-fallback");
				const fallbackContent = formatSingleCompletion(fallbackDetails);
				assert.ok(fallbackContent.includes('id: "resolver-valid-fallback"'));
				assert.equal(fallbackContent.includes(`id: ${JSON.stringify(rejectedId)}`), false);
			}

			assert.equal(
				buildCompletionDetails({
					id: "x".repeat(201),
					runId: "bounded-fallback",
					agent: "worker",
					success: true,
					summary: "done",
					timestamp: 1,
				}).asyncId,
				"bounded-fallback",
			);
			assert.equal(
				buildCompletionDetails({
					id: "malformed\nid",
					runId: "safe-fallback",
					agent: "worker",
					success: true,
					summary: "done",
					timestamp: 1,
				}).asyncId,
				"safe-fallback",
			);
			assert.equal(
				buildCompletionDetails({
					id: "x".repeat(201),
					runId: "y".repeat(201),
					agent: "worker",
					success: true,
					summary: "done",
					timestamp: 1,
				}).asyncId,
				undefined,
			);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("omits resume guidance for invalid normalized child indexes", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-invalid-index-"));
		const sessionFile = path.join(resultsDir, "session.jsonl");
		fs.writeFileSync(sessionFile, "session\n", "utf-8");
		try {
			for (const index of [-1, 2, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
				const details = buildCompletionDetails({
					id: "invalid-index-run",
					agent: "parallel:a+b",
					success: true,
					summary: "done",
					timestamp: 1,
					results: [
						{ agent: "a", status: "completed", summary: "a", index, sessionPath: sessionFile },
						{ agent: "b", status: "completed", summary: "b" },
					],
				});
				assert.equal(details.resumeTarget, undefined);
				assert.doesNotMatch(formatSingleCompletion(details), /subagent\({ action: "resume"/);
			}
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("prefers the paused child resume target when normalized results preserve the original interrupted index", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-paused-resume-index-"));
		const pausedSessionFile = path.join(resultsDir, "paused-session.jsonl");
		fs.writeFileSync(pausedSessionFile, "session\n", "utf-8");
		try {
			const details = buildCompletionDetails({
				id: "paused-index-run",
				agent: "chain:a+b",
				success: false,
				state: "paused",
				summary: "Paused after interrupt.",
				timestamp: 1,
				results: [
					{ agent: "a", status: "completed", summary: "done", index: 0 },
					{ agent: "b", status: "completed", summary: "done", index: 1 },
					{ agent: "c", status: "completed", summary: "done", index: 2 },
					{ agent: "d", status: "completed", summary: "done", index: 3 },
					{
						agent: "e",
						status: "paused",
						summary: "Paused after interrupt.",
						index: 4,
						sessionPath: pausedSessionFile,
					},
				],
			});
			assert.deepEqual(details.resumeTarget, { sessionPath: pausedSessionFile, index: 4, childCount: 5 });
			assert.match(
				formatSingleCompletion(details),
				/Revive child: subagent\({ action: "resume", id: "paused-index-run", index: 4, message: "\.\.\." }\)/,
			);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("buildCompletionDetails derives paused status from state and summary", () => {
		assert.equal(
			buildCompletionDetails({
				id: "x",
				agent: "w",
				success: false,
				state: "paused",
				summary: "Paused after interrupt.",
				timestamp: 1,
			}).status,
			"paused",
		);
		assert.equal(
			buildCompletionDetails({ id: "x", agent: "w", success: false, summary: "boom", exitCode: 1, timestamp: 1 })
				.status,
			"failed",
		);
		assert.equal(
			buildCompletionDetails({ id: "x", agent: "w", success: true, summary: "ok", exitCode: 0, timestamp: 1 }).status,
			"completed",
		);
	});

	it("buildCompletionDetails prioritizes child failure, outer failure, pause, completion, then all-detached failure", () => {
		const base = { id: "grouped", agent: "parallel", success: true, summary: "outer", timestamp: 1 };
		assert.equal(
			buildCompletionDetails({
				...base,
				results: [
					{ agent: "a", status: "paused", summary: "paused" },
					{ agent: "b", status: "failed", summary: "failed" },
				],
			}).status,
			"failed",
		);
		assert.equal(
			buildCompletionDetails({
				...base,
				success: false,
				state: "failed",
				results: [
					{ agent: "a", status: "completed", summary: "done" },
					{ agent: "b", status: "paused", summary: "paused" },
				],
			}).status,
			"failed",
		);
		assert.equal(
			buildCompletionDetails({
				...base,
				success: false,
				state: "paused",
				results: [
					{ agent: "a", status: "completed", summary: "done" },
					{ agent: "b", status: "completed", summary: "done" },
				],
			}).status,
			"paused",
		);
		assert.equal(
			buildCompletionDetails({
				...base,
				results: [
					{ agent: "a", status: "completed", summary: "done" },
					{ agent: "b", status: "paused", summary: "paused" },
				],
			}).status,
			"paused",
		);
		assert.equal(
			buildCompletionDetails({
				...base,
				results: [
					{ agent: "a", status: "completed", summary: "done" },
					{ agent: "b", status: "detached", summary: "detached" },
				],
			}).status,
			"completed",
		);
		assert.equal(
			buildCompletionDetails({ ...base, results: [{ agent: "a", status: "detached", summary: "detached" }] }).status,
			"failed",
		);
	});

	it("prepends a bounded unrepresented outer failure while preserving a paused child resume target", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-outer-failure-paused-child-"));
		const pausedSessionFile = path.join(resultsDir, "paused-session.jsonl");
		fs.writeFileSync(pausedSessionFile, "session\n", "utf-8");
		try {
			// Use a summary longer than MAX_SUMMARY_CHARS (8 000 chars) to verify
			// that the outer failure is still bounded at the per-child budget.
			const outerCrash = `runner crashed: ${"x".repeat(8_100)}`;
			const details = buildCompletionDetails({
				id: "outer-failed-paused-child",
				agent: "chain:a+b",
				success: false,
				state: "failed",
				summary: outerCrash,
				timestamp: 1,
				results: [
					{ agent: "a", status: "completed", summary: "a done", index: 0 },
					{
						agent: "b",
						status: "paused",
						summary: "Paused after interrupt.",
						index: 1,
						sessionPath: pausedSessionFile,
					},
				],
			});

			assert.equal(details.status, "failed");
			assert.deepEqual(details.resumeTarget, { sessionPath: pausedSessionFile, index: 1, childCount: 2 });
			assert.match(details.resultPreview, /^runner crashed: x+/);
			// Summary exceeds MAX_SUMMARY_CHARS so it should be truncated with the
			// marker, followed immediately by the children section.
			assert.match(details.resultPreview, /… \[summary truncated\]\n\nChildren: 1 completed, 1 paused/);
			assert.match(
				formatSingleCompletion(details),
				/Revive child: subagent\({ action: "resume", id: "outer-failed-paused-child", index: 1, message: "\.\.\." }\)/,
			);

			const singleChildDiagnostic = "runner exited after its child completed";
			const singleChild = buildCompletionDetails({
				id: "outer-failed-single-empty-child",
				agent: "single-worker",
				success: false,
				state: "failed",
				summary: singleChildDiagnostic,
				timestamp: 1,
				results: [{ agent: "single-worker", status: "completed" }],
			});
			assert.equal(singleChild.resultPreview, `${singleChildDiagnostic}\n\n(no output)`);
			assert.equal(singleChild.resultPreview.split(singleChildDiagnostic).length - 1, 1);

			const represented = buildCompletionDetails({
				id: "represented-outer-failure",
				agent: "parallel:a+b",
				success: false,
				state: "failed",
				summary: "outer diagnostic must not duplicate a failed child",
				timestamp: 1,
				results: [
					{ agent: "a", status: "failed", summary: "child failure represents the run" },
					{ agent: "b", status: "completed", summary: "done" },
				],
			});
			assert.doesNotMatch(represented.resultPreview, /outer diagnostic/);
			assert.match(represented.resultPreview, /^Children: 1 completed, 1 failed/);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("buildCompletionDetails falls back to the unknown agent label", () => {
		const details: SubagentNotifyDetails = buildCompletionDetails({
			id: "x",
			agent: null,
			success: true,
			summary: "ok",
			timestamp: 1,
		});
		assert.equal(details.agent, "unknown");
		assert.equal(details.status, "completed");
	});

	it("single-result notice carries summary up to the single-result budget and still respects the envelope", () => {
		// A summary between MAX_DISPLAY_SUMMARY_CHARS (1 200) and MAX_SUMMARY_CHARS
		// (~6 000) must reach the model in full via content while structuredDetails.resultPreview
		// is still capped at MAX_DISPLAY_SUMMARY_CHARS for the TUI.
		const { events, sentMessages } = createPi();
		const longSummary = `rich result: ${"r".repeat(4_000)}`;

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "budget-single-1",
			agent: "worker",
			success: true,
			summary: longSummary,
			exitCode: 0,
			timestamp: 1,
			sessionId: "session-1",
		});

		assert.equal(sentMessages.length, 1);
		const message = sentMessages[0]!.message as { content: string; details?: SubagentNotifyDetails };
		// content carries the full summary (no truncation — well under MAX_COMPLETION_MESSAGE_CHARS)
		assert.ok(
			message.content.includes(longSummary),
			"model-facing content must carry the full summary beyond the old 1 200-char cap",
		);
		assert.ok(message.content.length <= MAX_COMPLETION_MESSAGE_CHARS);
		// structuredDetails.resultPreview is bounded at MAX_DISPLAY_SUMMARY_CHARS for the TUI
		assert.ok(message.details, "single notice must include structuredDetails");
		assert.ok(
			message.details!.resultPreview.length <= MAX_DISPLAY_SUMMARY_CHARS,
			"TUI details.resultPreview must be bounded at MAX_DISPLAY_SUMMARY_CHARS",
		);
		assert.ok(
			!message.content.includes("… [summary truncated]"),
			"a summary within the single-result budget must not be truncated in content",
		);
	});

	it("grouped notice divides the summary pool across displayed children rather than a fixed per-child cap", () => {
		// Two children each with a summary between MAX_DISPLAY_SUMMARY_CHARS (1 200) and the
		// per-child budget (MAX_SUMMARY_CHARS = 8 000 at this fan-out). Both appear untruncated,
		// proving each child gets the full per-child budget rather than a divided share.
		const { events, sentMessages } = createPi();
		const summaryA = `child-a result: ${"a".repeat(2_000)}`;
		const summaryB = `child-b result: ${"b".repeat(2_000)}`;

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "budget-grouped-1",
			agent: "parallel:a+b",
			success: true,
			summary: "outer done",
			timestamp: 1,
			sessionId: "session-1",
			results: [
				{ agent: "a", status: "completed", summary: summaryA, index: 0 },
				{ agent: "b", status: "completed", summary: summaryB, index: 1 },
			],
		});

		assert.equal(sentMessages.length, 1);
		const message = sentMessages[0]!.message as { content: string };
		assert.ok(
			message.content.includes(summaryA),
			"grouped content must carry child-a summary beyond the old 1 200-char cap",
		);
		assert.ok(
			message.content.includes(summaryB),
			"grouped content must carry child-b summary beyond the old 1 200-char cap",
		);
		assert.ok(message.content.length <= MAX_COMPLETION_MESSAGE_CHARS);
		assert.ok(
			!message.content.includes("… [summary truncated]"),
			"child summaries within the per-child budget must not be truncated in content",
		);
	});

	// Regression guard for the grouped budget shape. Each displayed child gets the full
	// per-child MAX_SUMMARY_CHARS budget; a child's report must not shrink merely because
	// it has siblings. The trailing `Session:` recovery pointer must survive in every case,
	// because formatSingleCompletion emits it LAST and a naive end-cut would destroy it,
	// turning a "truncated but recoverable" notice into a "truncated and unrecoverable" one.
	for (const childCount of [2, 8]) {
		it(`grouped notice with ${childCount} children filling their budget keeps the recovery pointer inside the ceiling`, () => {
			const { events, sentMessages } = createPi();
			const shareUrl = `https://share/grouped-capacity-${childCount}`;
			// Oversized summaries so boundedSummary clamps each child to EXACTLY the per-child
			// budget. This fills the budget to capacity without the test needing to know the
			// constant's value. Child artifact/session references are populated too, since those
			// are real scaffolding that competes for the same ceiling.
			const results = Array.from({ length: childCount }, (_, index) => ({
				agent: `worker-${index}`,
				status: "completed",
				summary: "s".repeat(MAX_COMPLETION_MESSAGE_CHARS),
				index,
				artifactPath: `/tmp/artifacts/worker-${index}.md`,
				sessionPath: `/tmp/sessions/worker-${index}.jsonl`,
			}));

			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				id: `grouped-capacity-${childCount}`,
				agent: "parallel:capacity",
				success: true,
				summary: "outer done",
				timestamp: 1,
				sessionId: "session-1",
				shareUrl,
				results,
			});

			assert.equal(sentMessages.length, 1);
			const content = (sentMessages[0]!.message as { content: string }).content;

			// 1. The assembled message must fit the ceiling.
			assert.ok(
				content.length <= MAX_COMPLETION_MESSAGE_CHARS,
				`assembled grouped message (${content.length}) must fit MAX_COMPLETION_MESSAGE_CHARS`,
			);

			// 2. The trailing recovery pointer must survive. This is the assertion with teeth.
			assert.ok(
				content.includes(`Session: ${shareUrl}`),
				"the trailing Session line must survive; a naive end-cut would truncate the recovery pointer away",
			);
		});
	}

	// Direct regression test for tail-preserving truncation. Deliberately forces an overflow
	// PAST the ceiling (8 children at full per-child budget plus long reference lines), which
	// the per-child budget alone cannot prevent: at n=8 the equal-share fallback already
	// allocates 8 x 4 000 = 32 000 chars of summary, exactly the ceiling, leaving nothing for
	// scaffolding. The assembled message therefore MUST be clamped, and the clamp must cut
	// from the preview body rather than from the tail, so the trailing Session line and the
	// child artifact references both survive. Without tail preservation the final
	// truncateWithMarker cuts from the end and destroys exactly those recovery pointers.
	it("clamps an over-ceiling notice while preserving the trailing session line and child references", () => {
		const { events, sentMessages } = createPi();
		const shareUrl = "https://share/tail-preservation-overflow";
		// Long reference lines on every child, pushing well past the ceiling once the 8 full
		// per-child summaries are laid down.
		const results = Array.from({ length: 8 }, (_, index) => ({
			agent: `worker-${index}`,
			// Urgency ordering puts the failed child first, so its references sit at the front.
			status: index === 0 ? "failed" : "completed",
			summary: "s".repeat(MAX_COMPLETION_MESSAGE_CHARS),
			index,
			artifactPath: `/tmp/artifacts/${"deep-path-segment/".repeat(10)}worker-${index}.md`,
			sessionPath: `/tmp/sessions/${"deep-path-segment/".repeat(10)}worker-${index}.jsonl`,
		}));

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "tail-preservation-overflow",
			agent: "parallel:overflow",
			success: true,
			summary: "outer done",
			timestamp: 1,
			sessionId: "session-1",
			shareUrl,
			results,
		});

		assert.equal(sentMessages.length, 1);
		const content = (sentMessages[0]!.message as { content: string }).content;

		// 1. Clamped to the ceiling.
		assert.ok(
			content.length <= MAX_COMPLETION_MESSAGE_CHARS,
			`over-ceiling message (${content.length}) must be clamped to MAX_COMPLETION_MESSAGE_CHARS`,
		);

		// 2. The trailing recovery pointer survives the clamp. This is the assertion with teeth:
		// a naive end-cut removes it, because it is the very last line of the assembled message.
		assert.ok(
			content.includes(`Session: ${shareUrl}`),
			"tail-preserving truncation must keep the trailing Session line even when the ceiling is hit",
		);

		// 3. Child artifact references survive for the urgent (first-displayed) child, so the
		// architect retains a pointer to the full output of the result that matters most.
		assert.ok(content.includes("worker-0.md"), "the urgent child's artifact reference must survive the clamp");
		assert.ok(content.includes("worker-0.jsonl"), "the urgent child's session reference must survive the clamp");
	});

	// -------------------------------------------------------------------------
	// Defect 1 regression: formatGroupedCompletion ceiling-overshoot fix.
	//
	// These tests call formatGroupedCompletion directly with MULTIPLE
	// SubagentNotifyDetails entries (the batched path). The earlier tests at
	// ~1568 emit ONE SubagentResult with children, which routes through
	// formatSingleCompletion/buildCompletionDetails and never hits this path.
	//
	// Each entry is "saturated" — its resultPreview is longer than previewCeiling,
	// so it fills every available char. The fix adds the per-entry \n separator
	// cost (entries.length - 2) to the budget reservation so the assembled string
	// is always exactly <= MAX_COMPLETION_MESSAGE_CHARS.
	// -------------------------------------------------------------------------
	for (const entryCount of [2, 3, 4, 8, 16, 40]) {
		it(`formatGroupedCompletion with ${entryCount} saturated entries stays within the ceiling and preserves all session pointers`, () => {
			// Each detail has a session pointer (worst-case scaffolding), and a resultPreview
			// much larger than any possible previewCeiling so it saturates the budget exactly.
			const details: SubagentNotifyDetails[] = Array.from({ length: entryCount }, (_, i) => ({
				agent: `worker-${i}`,
				status: "completed" as const,
				resultPreview: "s".repeat(MAX_COMPLETION_MESSAGE_CHARS),
				sessionLabel: "Session",
				sessionValue: `https://share/worker-${i}`,
			}));
			const result = formatGroupedCompletion(details);

			// 1. Assembled string must fit the ceiling.
			assert.ok(
				result.length <= MAX_COMPLETION_MESSAGE_CHARS,
				`formatGroupedCompletion(${entryCount}) produced ${result.length} chars, exceeding MAX_COMPLETION_MESSAGE_CHARS`,
			);

			// 2. Every DISPLAYED entry's session pointer must survive.
			// Entries beyond MAX_GROUPED_ENTRIES=8 are omitted, so only check those shown.
			const displayedCount = Math.min(entryCount, 8);
			for (let i = 0; i < displayedCount; i++) {
				assert.ok(
					result.includes(`Session: https://share/worker-${i}`),
					`session pointer for displayed entry ${i} missing from grouped output at n=${entryCount}`,
				);
			}
		});
	}

	it("formatGroupedCompletion caps displayed entries at 8 and emits an omission marker for the rest", () => {
		// Defect 2: batch size was unbounded. Verify the cap is applied and the omission
		// marker uses the same wording as existing child-result omission notices.
		const details: SubagentNotifyDetails[] = Array.from({ length: 12 }, (_, i) => ({
			agent: `worker-${i}`,
			status: "completed" as const,
			resultPreview: "done",
			sessionLabel: "Session",
			sessionValue: `https://share/worker-${i}`,
		}));
		const result = formatGroupedCompletion(details);

		// Ceiling holds.
		assert.ok(result.length <= MAX_COMPLETION_MESSAGE_CHARS);

		// The total count in the header shows all 12.
		assert.ok(result.includes("Background tasks completed (12):"), "header must show total count");

		// First 8 displayed.
		assert.ok(result.includes("Session: https://share/worker-0"), "first entry must be shown");
		assert.ok(result.includes("Session: https://share/worker-7"), "eighth entry must be shown");

		// Entries 9-12 are omitted.
		assert.ok(!result.includes("Session: https://share/worker-8"), "ninth entry must be omitted");
		assert.ok(result.includes("[4 entries omitted]"), "omission marker must appear for the 4 dropped entries");
	});

	it("batched send-time path routes multiple completions through formatGroupedCompletion and respects the ceiling", () => {
		// End-to-end test: MULTIPLE SubagentResult events batch together and are
		// emitted as one grouped message. This exercises the send-time cap on top
		// of the per-entry budget fix.
		const clock = createFakeClock();
		const { events, sentMessages } = createBatchingPi(clock);

		// Emit 4 separate completions with saturated summaries. The batcher holds
		// them and emits as one group when the debounce fires.
		for (let i = 0; i < 4; i++) {
			events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				id: `batched-ceiling-${i}`,
				agent: `parallel-worker-${i}`,
				success: true,
				summary: "s".repeat(MAX_COMPLETION_MESSAGE_CHARS),
				timestamp: 1,
				sessionId: "session-a",
				shareUrl: `https://share/batched-${i}`,
			});
		}
		// Advance past debounce to trigger grouped emit.
		clock.advance(200);

		assert.equal(sentMessages.length, 1, "4 batched completions must produce exactly 1 grouped message");
		const content = (sentMessages[0]!.message as { content: string }).content;

		// 1. The grouped message fits the ceiling.
		assert.ok(
			content.length <= MAX_COMPLETION_MESSAGE_CHARS,
			`batched grouped message (${content.length}) must fit MAX_COMPLETION_MESSAGE_CHARS`,
		);

		// 2. Each entry's session pointer survives (they are the last line of each block).
		for (let i = 0; i < 4; i++) {
			assert.ok(
				content.includes(`Session: https://share/batched-${i}`),
				`session pointer for worker-${i} must survive the send-time ceiling in the batched path`,
			);
		}
	});
});
