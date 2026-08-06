import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { clearForegroundMessageInbox, createSubagentExecutor, registerForegroundMessageInbox } from "../../src/runs/foreground/subagent-executor.ts";
import { createNestedRoute, NESTED_CONTROL_DELIVERY_TIMEOUT_MS, NESTED_CONTROL_RESULT_TIMEOUT_MS, NESTED_RUNNER_ACCEPTANCE_TIMEOUT_MS, projectNestedEvents, readNestedControlRequests, writeNestedControlResult, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import {
	SUBAGENT_CHILD_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { consumeSteerRequests } from "../../src/runs/background/control-channel.ts";
import { RESULTS_DIR, SUBAGENT_CONTROL_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_EVENT, TEMP_ROOT_DIR, type SubagentState } from "../../src/shared/types.ts";

const routeRoots: string[] = [];
const savedEnv = {
	[SUBAGENT_CHILD_ENV]: process.env[SUBAGENT_CHILD_ENV],
	[SUBAGENT_PARENT_EVENT_SINK_ENV]: process.env[SUBAGENT_PARENT_EVENT_SINK_ENV],
	[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV],
	[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV],
	[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV],
	[SUBAGENT_PARENT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_RUN_ID_ENV],
	[SUBAGENT_PARENT_CHILD_INDEX_ENV]: process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV],
};

afterEach(() => {
	for (const root of routeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
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

function createExecutor(state = createState(), agents: Array<Record<string, unknown>> = [], events: any = { emit() {}, on() { return () => {}; } }) {
	return createSubagentExecutor({
		pi: { events, getSessionName() { return "parent"; } } as any,
		state,
		config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as any,
		asyncByDefault: false,
		tempArtifactsDir: os.tmpdir(),
		getSubagentSessionRoot: (parentSessionFile) => parentSessionFile ? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl")) : os.tmpdir(),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: agents as any }),
	});
}

function ctx(root: string, sessionFile: string | null = null) {
	return {
		cwd: root,
		hasUI: false,
		sessionManager: { getSessionId() { return "session"; }, getSessionFile() { return sessionFile; } },
		modelRegistry: { getAvailable() { return []; } },
	} as any;
}

function createNestedRun(id = "nested-live", state: "running" | "complete" | "failed" | "paused" = "running", extras: Record<string, unknown> = {}) {
	const route = createNestedRoute("root-control");
	routeRoots.push(path.dirname(route.eventSink));
	writeNestedEvent(route, {
		type: state === "running" ? "subagent.nested.updated" : "subagent.nested.completed",
		ts: 100,
		parentRunId: "root-control",
		parentStepIndex: 0,
		child: { id, parentRunId: "root-control", parentStepIndex: 0, depth: 1, path: [{ runId: "root-control", stepIndex: 0 }], state, agent: "worker", ownerState: state === "running" ? "live" : "gone", ...extras },
	});
	return route;
}

function stateWithNestedRoute(route: ReturnType<typeof createNestedRoute>): SubagentState {
	const state = createState();
	state.foregroundControls.set(route.rootRunId, {
		runId: route.rootRunId,
		mode: "single",
		startedAt: 1,
		updatedAt: 1,
		nestedRoute: route,
	});
	state.lastForegroundControlId = route.rootRunId;
	return state;
}

function setNestedRouteEnv(route: ReturnType<typeof createNestedRoute>, parentRunId = route.rootRunId) {
	process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
	process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
	process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
	process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;
	process.env[SUBAGENT_PARENT_RUN_ID_ENV] = parentRunId;
	process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "0";
}

function text(result: Awaited<ReturnType<ReturnType<typeof createExecutor>["execute"]>>): string {
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

describe("nested control routing", () => {
	it("isolates foreground message inboxes across control lifecycles and removes the lifecycle root", () => {
		const first = { runId: "same-run", mode: "single" as const, startedAt: 1, updatedAt: 1 };
		const firstInbox = registerForegroundMessageInbox(first, first.runId, 0);
		fs.writeFileSync(path.join(firstInbox, "stale.json"), "{}", "utf-8");
		const firstRoot = first.messageInboxRoot!;

		const second = { runId: "same-run", mode: "single" as const, startedAt: 2, updatedAt: 2 };
		const secondInbox = registerForegroundMessageInbox(second, second.runId, 0);
		assert.notEqual(second.messageInboxRoot, firstRoot);
		assert.equal(fs.existsSync(path.join(secondInbox, "stale.json")), false);

		clearForegroundMessageInbox(first, 0);
		clearForegroundMessageInbox(second, 0);
		assert.equal(fs.existsSync(firstRoot), false);
		assert.equal(fs.existsSync(path.dirname(secondInbox)), false);
	});

	it("routes interrupt to an explicit nested id through the control inbox", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-control-"));
		try {
			const route = createNestedRun();
			const executor = createExecutor(stateWithNestedRoute(route));
			setTimeout(() => {
				const request = readNestedControlRequests(route)[0];
				assert.ok(request, "expected a nested control request");
				writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "nested interrupt accepted" });
			}, 50);

			const result = await executor.execute("interrupt", { action: "interrupt", id: "nested-live" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(result.isError, undefined);
			assert.match(text(result), /nested interrupt accepted/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("routes steer to an explicit nested id through the steer-request path", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-steer-"));
		const runId = "nested-live-steer";
		const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", runId);
		const nestedResultFile = path.join(RESULTS_DIR, "nested", "root-control", `${runId}.json`);
		try {
			fs.rmSync(nestedResultFile, { force: true });
			fs.mkdirSync(nestedAsyncDir, { recursive: true });
			fs.writeFileSync(path.join(nestedAsyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "running",
				pid: process.pid,
				cwd: root,
				startedAt: 100,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");

			const route = createNestedRun(runId, "running", { asyncDir: nestedAsyncDir });
			const executor = createExecutor(stateWithNestedRoute(route));

			const result = await executor.execute("steer", { action: "steer", id: runId, message: "adjust focus" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(result.isError, undefined, `unexpected error: ${text(result)}`);
			assert.match(text(result), /Steering queued/);

			const requests = consumeSteerRequests(nestedAsyncDir);
			assert.equal(requests.length, 1);
			assert.equal(requests[0]?.message, "adjust focus");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
			fs.rmSync(nestedResultFile, { force: true });
		}
	});

	it("renders nested children in foreground status output", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-foreground-status-"));
		try {
			const route = createNestedRun("nested-foreground");
			const state = createState();
			state.foregroundControls.set("root-control", {
				runId: "root-control",
				mode: "single",
				startedAt: 1,
				updatedAt: 1,
				currentAgent: "orchestrator",
				currentIndex: 0,
				nestedRoute: route,
			});
			state.lastForegroundControlId = "root-control";

			const result = await createExecutor(state).execute("status", { action: "status", id: "root-control" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.match(text(result), /Run: root-control/);
			assert.match(text(result), /↳ worker \[nested-foreground\] running/);
			assert.match(text(result), /Status: subagent\(\{ action: "status", id: "nested-foreground" \}\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not let bare interrupt target hidden nested descendants", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-bare-interrupt-"));
		try {
			createNestedRun("nested-only");
			const result = await createExecutor().execute("interrupt", { action: "interrupt" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(result.isError, true);
			assert.match(text(result), /No interrupt-capable run found/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("times out owner-gone nested control and ignores late results", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-timeout-"));
		try {
			const route = createNestedRun("nested-timeout");
			const executor = createExecutor(stateWithNestedRoute(route));
			setTimeout(() => {
				const request = readNestedControlRequests(route)[0];
				if (request) writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "late success" });
			}, 1_200);
			const result = await executor.execute("interrupt", { action: "interrupt", id: "nested-timeout" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(result.isError, true);
			assert.match(text(result), /owner is not reachable/);
			assert.doesNotMatch(text(result), /late success/);
			assert.equal(readNestedControlRequests(route).length, 0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("waits beyond the bounded owner acceptance window for a nested control result", async () => {
		assert.ok(NESTED_CONTROL_RESULT_TIMEOUT_MS > NESTED_CONTROL_DELIVERY_TIMEOUT_MS);
		assert.ok(NESTED_CONTROL_DELIVERY_TIMEOUT_MS > NESTED_RUNNER_ACCEPTANCE_TIMEOUT_MS);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-owner-bound-"));
		try {
			const route = createNestedRun("nested-owner-bound");
			const executor = createExecutor(stateWithNestedRoute(route));
			setTimeout(() => {
				const request = readNestedControlRequests(route)[0];
				if (request) writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "owner completed within parent bound" });
			}, NESTED_RUNNER_ACCEPTANCE_TIMEOUT_MS + 100);
			const result = await executor.execute("resume", { action: "resume", id: "nested-owner-bound", message: "continue" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(result.isError, undefined);
			assert.match(text(result), /owner completed within parent bound/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("routes resume for live nested runs through the control inbox", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-live-resume-"));
		try {
			const emitted: Array<{ name: string; payload: unknown }> = [];
			const events = { emit(name: string, payload: unknown) { emitted.push({ name, payload }); }, on() { return () => {}; } };
			const route = createNestedRun("nested-live-resume", "running", { intercomTarget: "attacker-target", leafIntercomTarget: "attacker-leaf" });
			const executor = createExecutor(stateWithNestedRoute(route), [], events);
			setTimeout(() => {
				const request = readNestedControlRequests(route)[0];
				assert.ok(request, "expected a nested resume request");
				assert.equal(request.action, "resume");
				assert.equal(request.targetIndex, 1);
				assert.equal(request.deliveryDeadlineAt, request.ts + NESTED_CONTROL_DELIVERY_TIMEOUT_MS);
				assert.equal(request.message, "continue please");
				writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "nested resume accepted" });
			}, 50);

			const result = await executor.execute("resume", { action: "resume", id: "nested-live-resume", index: 1, message: "continue please" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.match(text(result), /nested resume accepted/);
			assert.equal(emitted.some((event) => {
				const payload = event.payload as { to?: unknown };
				return payload.to === "attacker-target" || payload.to === "attacker-leaf";
			}), false);
			assert.equal(emitted.some((event) => event.name === SUBAGENT_CONTROL_INTERCOM_EVENT), false);
			assert.equal(emitted.some((event) => event.name === SUBAGENT_RESULT_INTERCOM_EVENT), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("validates terminal nested resume session files before revive", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-resume-"));
		try {
			const route = createNestedRun("nested-terminal-resume", "complete", { sessionFile: path.join(root, "missing-session.jsonl") });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("resume", { action: "resume", id: "nested-terminal-resume", message: "continue" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, true);
			assert.match(text(result), /session file does not exist/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("clamps terminal nested resume to persisted index-0 active runtime", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-runtime-"));
		const runId = "nested-terminal-runtime";
		const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", runId);
		try {
			const parentSessionFile = path.join(root, "parent.jsonl");
			const sessionFile = path.join(root, "parent", runId, "run-0", "session.jsonl");
			fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
			fs.writeFileSync(parentSessionFile, "");
			fs.writeFileSync(sessionFile, "");
			fs.mkdirSync(nestedAsyncDir, { recursive: true });
			fs.writeFileSync(path.join(nestedAsyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "complete",
				steps: [{ agent: "worker", status: "complete", sessionFile, activeRuntimeMs: 75 }],
			}), "utf-8");
			const route = createNestedRun(runId, "complete", { asyncDir: nestedAsyncDir, sessionFile });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work", maxExecutionTimeMs: 100 }])
				.execute("resume", { action: "resume", id: runId, message: "continue", timeoutMs: 1_000 }, new AbortController().signal, undefined, ctx(root, parentSessionFile));

			assert.equal(result.isError, undefined, text(result));
			assert.equal(result.details?.timeoutMs, 25);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
		}
	});

	it("rejects paused nested resume when persisted index-0 active runtime exhausts the ceiling", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-paused-runtime-"));
		const runId = "nested-paused-runtime";
		const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", runId);
		try {
			const parentSessionFile = path.join(root, "parent.jsonl");
			const sessionFile = path.join(root, "parent", runId, "run-0", "session.jsonl");
			fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
			fs.writeFileSync(parentSessionFile, "");
			fs.writeFileSync(sessionFile, "");
			fs.mkdirSync(nestedAsyncDir, { recursive: true });
			fs.writeFileSync(path.join(nestedAsyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "paused",
				steps: [{
					agent: "worker",
					status: "paused",
					sessionFile,
					activeRuntimeMs: 100,
					acceptance: {
						status: "skipped",
						effectiveAcceptance: { level: "checked", explicit: true, criteria: [], evidence: [], verify: [], stopRules: [] },
						criteria: [],
						runtimeChecks: [],
						verifyRuns: [],
					},
				}],
			}), "utf-8");
			const route = createNestedRun(runId, "paused", { asyncDir: nestedAsyncDir, sessionFile });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work", maxExecutionTimeMs: 100 }])
				.execute("resume", { action: "resume", id: runId, message: "continue", timeoutMs: 1_000 }, new AbortController().signal, undefined, ctx(root, parentSessionFile));

			assert.equal(result.isError, true);
			assert.match(text(result), /exhausted its maxExecutionTimeMs ceiling after 100ms/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
		}
	});

	it("fails safely when nested resume status has malformed active runtime metadata", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-malformed-runtime-"));
		const runId = "nested-malformed-runtime";
		const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", runId);
		try {
			fs.mkdirSync(nestedAsyncDir, { recursive: true });
			fs.writeFileSync(path.join(nestedAsyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "complete",
				steps: [{ agent: "worker", status: "complete", activeRuntimeMs: "75" }],
			}), "utf-8");
			const route = createNestedRun(runId, "complete", { asyncDir: nestedAsyncDir, sessionFile: path.join(root, "missing-session.jsonl") });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work", maxExecutionTimeMs: 100 }])
				.execute("resume", { action: "resume", id: runId, message: "continue" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, true);
			assert.match(text(result), /activeRuntimeMs must be a non-negative finite number/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
		}
	});

	it("fails closed when reviving a paused nested run without a readable skipped acceptance ledger", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-paused-no-ledger-"));
		try {
			const route = createNestedRun("nested-paused-no-ledger", "paused", { sessionFile: path.join(root, "missing-session.jsonl") });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("resume", { action: "resume", id: "nested-paused-no-ledger", message: "continue" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, true);
			assert.match(text(result), /skipped acceptance ledger could not be read/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads the paused nested skipped acceptance ledger before session validation", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-paused-ledger-"));
		const runId = "nested-paused-ledger";
		const nestedAsyncDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", "root-control", runId);
		try {
			fs.mkdirSync(nestedAsyncDir, { recursive: true });
			fs.writeFileSync(path.join(nestedAsyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "paused",
				steps: [{
					agent: "worker",
					status: "paused",
					acceptance: {
						status: "skipped",
						effectiveAcceptance: { level: "checked", explicit: true, criteria: [], evidence: [], verify: [], stopRules: [] },
						criteria: [],
						runtimeChecks: [],
						verifyRuns: [],
					},
				}],
			}), "utf-8");
			const route = createNestedRun(runId, "paused", { asyncDir: nestedAsyncDir, sessionFile: path.join(root, "missing-session.jsonl") });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("resume", { action: "resume", id: runId, message: "continue" }, new AbortController().signal, undefined, ctx(root));

			// The ledger was read successfully, so resolution proceeds past the
			// fail-closed acceptance guard to session-file validation.
			assert.equal(result.isError, true);
			assert.match(text(result), /session file does not exist/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(nestedAsyncDir, { recursive: true, force: true });
		}
	});

	it("rejects terminal nested resume session files outside trusted roots", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-untrusted-"));
		try {
			const parentSessionFile = path.join(root, "parent.jsonl");
			const attackerSessionFile = path.join(root, "outside", "session.jsonl");
			fs.mkdirSync(path.dirname(attackerSessionFile), { recursive: true });
			fs.writeFileSync(parentSessionFile, "");
			fs.writeFileSync(attackerSessionFile, "");
			const route = createNestedRun("nested-untrusted-resume", "complete", { sessionFile: attackerSessionFile });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("resume", { action: "resume", id: "nested-untrusted-resume", message: "continue" }, new AbortController().signal, undefined, ctx(root, parentSessionFile));

			assert.equal(result.isError, true);
			assert.match(text(result), /outside trusted nested session roots/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects terminal nested resume session files from sibling run directories", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-sibling-"));
		try {
			const parentSessionFile = path.join(root, "parent.jsonl");
			const siblingSessionFile = path.join(root, "parent", "other-run", "run-0", "session.jsonl");
			fs.mkdirSync(path.dirname(siblingSessionFile), { recursive: true });
			fs.writeFileSync(parentSessionFile, "");
			fs.writeFileSync(siblingSessionFile, "");
			const route = createNestedRun("nested-sibling-resume", "complete", { sessionFile: siblingSessionFile });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("resume", { action: "resume", id: "nested-sibling-resume", message: "continue" }, new AbortController().signal, undefined, ctx(root, parentSessionFile));

			assert.equal(result.isError, true);
			assert.match(text(result), /not under that nested run's session directory/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("emits a failed completed nested event when foreground execution throws after start", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-foreground-throw-"));
		try {
			const route = createNestedRoute("root-parent");
			routeRoots.push(path.dirname(route.eventSink));
			setNestedRouteEnv(route, "root-parent");
			const throwingCtx = {
				...ctx(root),
				modelRegistry: { getAvailable() { throw new Error("model registry exploded"); } },
			};

			const result = await createExecutor(createState(), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("run", { agent: "worker", task: "go" }, new AbortController().signal, undefined, throwingCtx);

			assert.equal(result.isError, true);
			assert.match(text(result), /model registry exploded/);
			const registry = projectNestedEvents(route);
			assert.equal(registry.children.length, 1);
			assert.equal(registry.children[0]?.state, "failed");
			assert.match(registry.children[0]?.error ?? "", /model registry exploded/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

});
