import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	createHerdrActivityReporter,
	createCmuxActivityReporter,
} = await jiti.import("../extensions/the-last-harness/activity-reporters.ts");

function createFakeTimers() {
	let now = 0;
	let nextId = 1;
	const timers = new Map();
	return {
		now: () => now,
		setTimeout(fn, delay = 0) {
			const id = nextId++;
			timers.set(id, { fn, at: now + delay, delay });
			return { id, unref() {} };
		},
		clearTimeout(handle) {
			timers.delete(handle.id ?? handle);
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
		getPendingDelays() {
			return [...timers.values()].map((timer) => timer.delay).sort((a, b) => a - b);
		},
	};
}

function createFakeSocket(path) {
	const socket = new EventEmitter();
	socket.path = path;
	socket.writes = [];
	socket.destroyCalls = 0;
	socket.write = (chunk) => {
		socket.writes.push(chunk);
		return true;
	};
	socket.destroy = () => {
		socket.destroyCalls += 1;
	};
	return socket;
}

async function flushAsyncWork() {
	await Promise.resolve();
	await Promise.resolve();
}

test("Herdr reporter no-ops without required env and when official reporter is installed", async () => {
	const calls = [];
	const noopReporter = createHerdrActivityReporter({
		env: {},
		sendRequest: async (request) => {
			calls.push(request);
		},
	});
	noopReporter.handleSessionStart({ hasUI: true, sessionManager: { getSessionFile: () => "/tmp/s.json", getSessionId: () => "s" } });
	noopReporter.handleSnapshot({ inProgress: true, primaryReasons: ["primary:agent-loop"], activeAsyncJobIds: [] });
	await flushAsyncWork();
	assert.deepEqual(calls, []);

	const agentDir = mkdtempSync(join(tmpdir(), "tlh-herdr-agent-dir-"));
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "herdr-agent-state.ts"), "// installed by herdr\n");
	const singleWriterCalls = [];
	const singleWriterReporter = createHerdrActivityReporter({
		env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane-1", PI_CODING_AGENT_DIR: agentDir },
		sendRequest: async (request) => {
			singleWriterCalls.push(request);
		},
	});

	singleWriterReporter.handleSessionStart({ hasUI: true, sessionManager: { getSessionFile: () => "/tmp/s.json", getSessionId: () => "s" } });
	singleWriterReporter.handleSnapshot({ inProgress: true, primaryReasons: ["primary:agent-loop"], activeAsyncJobIds: [] });
	await flushAsyncWork();
	assert.deepEqual(singleWriterCalls, []);
});

test("Herdr reporter retries timed out activity socket delivery once", async () => {
	const timers = createFakeTimers();
	const sockets = [];
	const reporter = createHerdrActivityReporter({
		env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane-1" },
		createSocket: (path) => {
			const socket = createFakeSocket(path);
			sockets.push(socket);
			return socket;
		},
		timers,
		now: timers.now,
	});

	reporter.handleSessionStart({
		hasUI: true,
		sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
	});
	reporter.handleSnapshot({ inProgress: true, primaryReasons: ["primary:agent-loop"], activeAsyncJobIds: [] });
	await flushAsyncWork();
	assert.equal(sockets.length, 1);
	assert.deepEqual(timers.getPendingDelays(), [500]);

	sockets[0].emit("connect");
	assert.equal(sockets[0].writes.length, 1);

	timers.advance(499);
	await flushAsyncWork();
	assert.equal(sockets.length, 1);
	assert.equal(sockets[0].destroyCalls, 0);

	timers.advance(1);
	await flushAsyncWork();
	assert.equal(sockets[0].destroyCalls, 1);
	assert.equal(sockets.length, 2);
	assert.deepEqual(timers.getPendingDelays(), [1500]);

	sockets[1].emit("connect");
	assert.equal(sockets[1].writes.length, 1);
	assert.equal(JSON.parse(sockets[1].writes[0]).method, "pane.report_agent");
	sockets[1].emit("data", Buffer.from("ok"));
	await flushAsyncWork();
	assert.equal(sockets[1].destroyCalls, 1);
	assert.deepEqual(timers.getPendingDelays(), []);
	assert.deepEqual(JSON.parse(sockets[0].writes[0]), JSON.parse(sockets[1].writes[0]));
});

test("Herdr reporter does not retry after first activity socket response", async () => {
	const timers = createFakeTimers();
	const sockets = [];
	const reporter = createHerdrActivityReporter({
		env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane-1" },
		createSocket: (path) => {
			const socket = createFakeSocket(path);
			sockets.push(socket);
			return socket;
		},
		timers,
		now: timers.now,
	});

	reporter.handleSessionStart({
		hasUI: true,
		sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
	});
	reporter.handleSnapshot({ inProgress: true, primaryReasons: ["primary:agent-loop"], activeAsyncJobIds: [] });
	await flushAsyncWork();
	assert.equal(sockets.length, 1);
	assert.deepEqual(timers.getPendingDelays(), [500]);

	sockets[0].emit("connect");
	assert.equal(sockets[0].writes.length, 1);
	sockets[0].emit("data", Buffer.from("ok"));
	await flushAsyncWork();
	assert.equal(sockets[0].destroyCalls, 1);
	assert.deepEqual(timers.getPendingDelays(), []);

	timers.advance(5000);
	await flushAsyncWork();
	assert.equal(sockets.length, 1);
	assert.equal(JSON.parse(sockets[0].writes[0]).method, "pane.report_agent");
});

test("Herdr reporter sends monotonic working/idle state with session refs", async () => {
	const timers = createFakeTimers();
	const calls = [];
	const reporter = createHerdrActivityReporter({
		env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane-1", HERDR_ENV: "1" },
		sendRequest: async (request) => {
			calls.push(request);
		},
		now: timers.now,
		timers,
		idleDebounceMs: 25,
	});

	reporter.handleSessionStart({
		hasUI: true,
		sessionManager: { getSessionFile: () => "/tmp/session.jsonl", getSessionId: () => "session-1" },
	});
	await flushAsyncWork();
	assert.equal(calls[0].method, "pane.report_agent_session");
	assert.equal(calls[0].params.agent_session_path, "/tmp/session.jsonl");

	const workingSnapshot = { inProgress: true, primaryReasons: ["primary:agent-loop"], activeAsyncJobIds: [] };
	reporter.handleSnapshot(workingSnapshot);
	reporter.handleSnapshot(workingSnapshot);
	await flushAsyncWork();
	assert.equal(calls.filter((call) => call.method === "pane.report_agent").length, 1);
	assert.equal(calls.at(-1).params.state, "working");
	assert.equal(calls.at(-1).params.agent_session_path, "/tmp/session.jsonl");

	reporter.handleSnapshot({ inProgress: false, primaryReasons: [], activeAsyncJobIds: [] });
	timers.advance(24);
	await flushAsyncWork();
	assert.equal(calls.filter((call) => call.method === "pane.report_agent").length, 1);

	timers.advance(1);
	await flushAsyncWork();
	const stateCalls = calls.filter((call) => call.method === "pane.report_agent");
	assert.deepEqual(stateCalls.map((call) => call.params.state), ["working", "idle"]);
	assert.ok(stateCalls[1].params.seq > stateCalls[0].params.seq);

	reporter.handleSessionShutdown();
	await flushAsyncWork();
	assert.equal(calls.at(-1).method, "pane.release_agent");
});

test("cmux reporter uses per-surface status keys and status-only commands", async () => {
	const timers = createFakeTimers();
	const commands = [];
	const reporter = createCmuxActivityReporter({
		env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "pane 1:/left", CMUX_BIN: "cmux" },
		runner: async (command, args) => {
			commands.push({ command, args: [...args] });
		},
		timers,
		idleDebounceMs: 25,
	});

	reporter.handleSessionStart({ hasUI: true, sessionManager: { getSessionFile: () => undefined, getSessionId: () => "session-1" } });
	reporter.handleSnapshot({ inProgress: true, primaryReasons: [], activeAsyncJobIds: ["job-1"] });
	reporter.handleSnapshot({ inProgress: true, primaryReasons: [], activeAsyncJobIds: ["job-1"] });
	await flushAsyncWork();
	assert.deepEqual(commands, [{ command: "cmux", args: ["set-status", "tlh-pane-1-left", "working"] }]);

	reporter.handleSnapshot({ inProgress: false, primaryReasons: [], activeAsyncJobIds: [] });
	timers.advance(25);
	await flushAsyncWork();
	assert.deepEqual(commands.at(-1), { command: "cmux", args: ["clear-status", "tlh-pane-1-left"] });
	assert.equal(commands.some(({ args }) => args.includes("hooks") || args.includes("prompt-submit") || args.includes("stop")), false);

	reporter.handleSessionShutdown();
	await flushAsyncWork();
	assert.deepEqual(commands.at(-1), { command: "cmux", args: ["clear-status", "tlh-pane-1-left"] });
});


test("cmux reporter falls back to session id then global key", async () => {
	const sessionCommands = [];
	const sessionReporter = createCmuxActivityReporter({
		env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_BIN: "cmux" },
		runner: async (command, args) => {
			sessionCommands.push({ command, args: [...args] });
		},
	});
	sessionReporter.handleSessionStart({
		hasUI: true,
		sessionManager: { getSessionFile: () => undefined, getSessionId: () => "session:/two pane" },
	});
	sessionReporter.handleSnapshot({ inProgress: true, primaryReasons: [], activeAsyncJobIds: ["job-1"] });
	await flushAsyncWork();
	assert.deepEqual(sessionCommands, [{ command: "cmux", args: ["set-status", "tlh-session-two-pane", "working"] }]);

	const fallbackCommands = [];
	const fallbackReporter = createCmuxActivityReporter({
		env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "///", CMUX_BIN: "cmux" },
		runner: async (command, args) => {
			fallbackCommands.push({ command, args: [...args] });
		},
	});
	fallbackReporter.handleSessionStart({
		hasUI: true,
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => {
				throw new Error("missing session");
			},
		},
	});
	fallbackReporter.handleSnapshot({ inProgress: true, primaryReasons: [], activeAsyncJobIds: ["job-2"] });
	await flushAsyncWork();
	assert.deepEqual(fallbackCommands, [{ command: "cmux", args: ["set-status", "tlh", "working"] }]);
});

test("cmux reporter no-ops without workspace env", async () => {
	const commands = [];
	const reporter = createCmuxActivityReporter({
		env: {},
		runner: async (command, args) => {
			commands.push({ command, args: [...args] });
		},
	});
	reporter.handleSessionStart({ hasUI: true, sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s" } });
	reporter.handleSnapshot({ inProgress: true, primaryReasons: ["primary:agent-loop"], activeAsyncJobIds: [] });
	await flushAsyncWork();
	assert.deepEqual(commands, []);
});
