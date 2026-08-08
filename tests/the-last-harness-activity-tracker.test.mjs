import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTlhEffectiveActivityTracker, registerTlhEffectiveActivityTracker } = await jiti.import(
	"../extensions/the-last-harness/activity-tracker.ts",
);

function createFakeTimers() {
	let now = 0;
	let nextId = 1;
	const timers = new Map();
	return {
		now: () => now,
		setTimeout(fn, delay = 0) {
			const id = nextId++;
			timers.set(id, { fn, at: now + delay });
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
		advance(ms) {
			now += ms;
			let ran = true;
			while (ran) {
				ran = false;
				for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
					if (timer.at > now) continue;
					timers.delete(id);
					timer.fn();
					ran = true;
				}
			}
		},
	};
}

test("tracker keeps primary activity busy through retry grace and compaction retry", () => {
	const timers = createFakeTimers();
	const tracker = createTlhEffectiveActivityTracker({
		now: timers.now,
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		retryGraceMs: 25,
	});

	tracker.handleBeforeAgentStart();
	assert.equal(tracker.isInProgress(), true);
	assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:pending-start"]);

	tracker.handleAgentStart();
	assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:agent-loop"]);

	tracker.handleAgentEnd({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "retry me" }] });
	assert.equal(tracker.isInProgress(), true);
	assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:retry-grace"]);

	tracker.handleSessionBeforeCompact({ reason: "overflow", willRetry: true });
	assert.deepEqual(tracker.getSnapshot().primaryReasons.sort(), ["primary:compaction:overflow"]);

	tracker.handleSessionCompact({ reason: "overflow", willRetry: true });
	assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:retry-grace"]);

	tracker.handleTurnStart();
	assert.deepEqual(tracker.getSnapshot().primaryReasons, []);

	tracker.handleAgentEnd({ messages: [{ role: "assistant", stopReason: "error" }] });
	assert.equal(tracker.isInProgress(), true);
	assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:retry-grace"]);

	timers.advance(24);
	assert.equal(tracker.isInProgress(), true);
	timers.advance(1);
	assert.equal(tracker.isInProgress(), false);
});

test("tracker treats duplicate retry-grace scheduling for the same key as idempotent", () => {
	const timers = createFakeTimers();
	const tracker = createTlhEffectiveActivityTracker({
		now: timers.now,
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		retryGraceMs: 25,
	});

	tracker.handleAgentEnd({ messages: [{ role: "assistant", stopReason: "error" }] });
	tracker.handleAgentEnd({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "duplicate" }] });
	assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:retry-grace"]);

	timers.advance(25);
	assert.equal(tracker.isInProgress(), false);

	tracker.handleSessionCompact({ reason: "overflow", willRetry: true });
	tracker.handleSessionCompact({ reason: "overflow", willRetry: true });
	assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:retry-grace"]);

	timers.advance(25);
	assert.equal(tracker.isInProgress(), false);
});

test("tracker clears retry grace after concurrent distinct grace keys expire", () => {
	const timers = createFakeTimers();
	const tracker = createTlhEffectiveActivityTracker({
		now: timers.now,
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		retryGraceMs: 25,
	});

	tracker.handleSessionCompact({ reason: "overflow", willRetry: true });
	tracker.handleAgentEnd({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "retry me" }] });
	assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:retry-grace"]);
	assert.equal(tracker.isInProgress(), true);

	timers.advance(24);
	assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:retry-grace"]);
	assert.equal(tracker.isInProgress(), true);

	timers.advance(1);
	assert.deepEqual(tracker.getSnapshot().primaryReasons, []);
	assert.equal(tracker.isInProgress(), false);
});

test("tracker keeps concurrent async jobs active across duplicate, out-of-order, and shutdown events", () => {
	const timers = createFakeTimers();
	const tracker = createTlhEffectiveActivityTracker({
		now: timers.now,
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
	});

	tracker.handleAsyncStarted({ id: "job-1", asyncDir: "/tmp/job-1" });
	tracker.handleAsyncStarted({ id: "job-1", asyncDir: "/tmp/job-1" });
	tracker.handleAsyncControl({ event: { runId: "job-2" }, asyncDir: "/tmp/job-2" });
	assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, ["job-1", "job-2"]);
	assert.equal(tracker.isInProgress(), true);

	tracker.handleAsyncComplete({ id: "job-1" });
	assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, ["job-2"]);
	assert.equal(tracker.isInProgress(), true);

	tracker.handleAsyncComplete({ runId: "job-2" });
	assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);
	assert.equal(tracker.isInProgress(), false);

	tracker.handleAsyncStarted({ id: "job-2", asyncDir: "/tmp/job-2" });
	assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);

	tracker.handleAsyncComplete({ id: "job-missing" });
	assert.equal(tracker.isInProgress(), false);

	tracker.dispose();
	assert.deepEqual(tracker.getSnapshot(), { inProgress: false, primaryReasons: [], activeAsyncJobIds: [] });
});

test("tracker ignores foreground control notices and only tracks safe async control contexts", () => {
	const tracker = createTlhEffectiveActivityTracker();

	tracker.handleAsyncControl({ event: { runId: "foreground-source", source: "foreground" } });
	tracker.handleAsyncControl({ event: { runId: "foreground-mode", mode: "foreground" } });
	tracker.handleAsyncControl({ event: { runId: "missing-context" } });
	assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);

	tracker.handleAsyncControl({ event: { runId: "job-background", mode: "background" } });
	tracker.handleAsyncControl({ event: { runId: "job-async" }, asyncDir: "/tmp/job-async" });
	assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, ["job-async", "job-background"]);
});

test("tracker rehydrates only matching running async jobs and ignores malformed artifacts", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "tlh-activity-tracker-"));
	const asyncDir = join(tempDir, "async-subagent-runs");
	mkdirSync(asyncDir, { recursive: true });
	const writeStatus = (dirName, status) => {
		const dir = join(asyncDir, dirName);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
	};

	try {
		writeStatus("run-1", {
			runId: "run-1",
			state: "running",
			cwd: "/repo",
			sessionId: "session-1",
			mode: "single",
			startedAt: 1,
		});
		writeStatus("run-2", {
			runId: "run-2",
			state: "running",
			cwd: "/elsewhere",
			sessionId: "session-1",
			mode: "single",
			startedAt: 1,
		});
		writeStatus("run-3", {
			runId: "run-3",
			state: "running",
			cwd: "/repo",
			sessionId: "session-2",
			mode: "single",
			startedAt: 1,
		});
		writeStatus("run-4", {
			runId: "run-4",
			state: "complete",
			cwd: "/repo",
			sessionId: "session-1",
			mode: "single",
			startedAt: 1,
		});
		mkdirSync(join(asyncDir, "bad-json"), { recursive: true });
		writeFileSync(join(asyncDir, "bad-json", "status.json"), "{not json\n");

		const tracker = createTlhEffectiveActivityTracker({ asyncDir });
		tracker.rehydrateFromArtifacts({
			cwd: "/repo",
			sessionManager: { getSessionId: () => "session-1" },
		});
		assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, ["run-1"]);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("tracker notifies snapshot listeners only when effective state changes", () => {
	const timers = createFakeTimers();
	const tracker = createTlhEffectiveActivityTracker({
		now: timers.now,
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		retryGraceMs: 25,
	});
	const snapshots = [];
	const unsubscribe = tracker.subscribe((snapshot) => snapshots.push(snapshot));

	tracker.handleBeforeAgentStart();
	tracker.handleBeforeAgentStart();
	tracker.handleAgentStart();
	tracker.handleAgentEnd({ messages: [{ role: "assistant", stopReason: "error" }] });
	timers.advance(25);
	unsubscribe();
	tracker.handleAsyncStarted({ id: "job-1" });

	assert.deepEqual(snapshots, [
		{ inProgress: true, primaryReasons: ["primary:pending-start"], activeAsyncJobIds: [] },
		{ inProgress: true, primaryReasons: ["primary:agent-loop", "primary:pending-start"], activeAsyncJobIds: [] },
		{ inProgress: true, primaryReasons: ["primary:retry-grace"], activeAsyncJobIds: [] },
		{ inProgress: false, primaryReasons: [], activeAsyncJobIds: [] },
	]);
});

test("registered tracker listens to pi events and cleans up on session shutdown", () => {
	const eventHandlers = new Map();
	const channelHandlers = new Map();
	const pi = {
		on(event, handler) {
			eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
		},
		events: {
			on(channel, handler) {
				channelHandlers.set(channel, [...(channelHandlers.get(channel) ?? []), handler]);
				return () => {
					channelHandlers.set(
						channel,
						(channelHandlers.get(channel) ?? []).filter((candidate) => candidate !== handler),
					);
				};
			},
		},
	};
	const tracker = registerTlhEffectiveActivityTracker(pi);
	const fireEvent = (name, event = {}, ctx = undefined) => {
		for (const handler of eventHandlers.get(name) ?? []) {
			handler(event, ctx);
		}
	};
	const emitChannel = (name, payload) => {
		for (const handler of channelHandlers.get(name) ?? []) {
			handler(payload);
		}
	};

	fireEvent("before_agent_start", {});
	assert.equal(tracker.isInProgress(), true);
	fireEvent("agent_start", {});
	fireEvent("tool_execution_start", { toolCallId: "tool-1" });
	assert.equal(tracker.isInProgress(), true);
	fireEvent("tool_execution_end", { toolCallId: "tool-1" });
	fireEvent("agent_end", { messages: [] });
	assert.equal(tracker.isInProgress(), false);

	emitChannel("subagent:async-started", { id: "job-1" });
	assert.equal(tracker.isInProgress(), true);
	fireEvent("session_shutdown", {});
	assert.equal(tracker.isInProgress(), false);
	assert.deepEqual(channelHandlers.get("subagent:async-started"), []);
});

test("tracker ignores late async mutations after dispose", () => {
	const tracker = createTlhEffectiveActivityTracker();
	tracker.handleAsyncStarted({ id: "job-1" });
	assert.equal(tracker.isInProgress(), true);

	tracker.dispose();
	tracker.handleAsyncStarted({ id: "job-2" });
	tracker.handleAsyncComplete({ id: "job-1" });
	assert.deepEqual(tracker.getSnapshot(), { inProgress: false, primaryReasons: [], activeAsyncJobIds: [] });
});

test("registered tracker tolerates runtimes without the optional event bus", () => {
	const eventHandlers = new Map();
	const pi = {
		on(event, handler) {
			eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
		},
	};
	const tracker = registerTlhEffectiveActivityTracker(pi);
	for (const handler of eventHandlers.get("before_agent_start") ?? []) {
		handler({});
	}
	assert.equal(tracker.isInProgress(), true);
	for (const handler of eventHandlers.get("session_shutdown") ?? []) {
		handler({});
	}
	assert.equal(tracker.isInProgress(), false);
});
