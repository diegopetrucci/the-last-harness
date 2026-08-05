/**
 * Regression guard: native supervisor channel and control-notice delivery
 * must work without pi-intercom installed.
 *
 * TLH is retiring pi-intercom; this file asserts:
 *   (a) contact_supervisor round-trip (need_decision) completes end-to-end
 *       when no external 'intercom' tool is present.
 *   (b) needs_attention notices delivered via handleSubagentControlNotice
 *       do NOT emit subagent:control-intercom or subagent:result-intercom
 *       events on the pi event bus.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
	NATIVE_SUPERVISOR_TOOL_NAME,
	createNativeSupervisorChannel,
	ensureSupervisorChannelDir,
	registerNativeSupervisorClient,
	resolveSupervisorChannelDir,
} from "../../src/intercom/native-supervisor-channel.ts";
import {
	handleSubagentControlNotice,
} from "../../src/extension/control-notices.ts";
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
} from "../../src/runs/shared/pi-args.ts";
import {
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
} from "../../src/shared/types.ts";
import type { ControlEvent, SubagentState } from "../../src/shared/types.ts";

// ─── env save/restore ────────────────────────────────────────────────────────

const ENV_KEYS = [
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
] as const;

type SavedEnv = Record<(typeof ENV_KEYS)[number], string | undefined>;

function saveEnv(): SavedEnv {
	return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as SavedEnv;
}

function restoreEnv(saved: SavedEnv): void {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = saved[key];
		}
	}
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(predicate: () => boolean, timeoutMs = 3000, intervalMs = 50): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await wait(intervalMs);
	}
}

function makeParentState(sessionId: string | null, ctx: unknown): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: ctx as SubagentState["lastUiContext"],
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function makeControlState(): SubagentState {
	return {
		baseCwd: "/tmp/project",
		currentSessionId: null,
		asyncJobs: new Map(),
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

function needsAttentionEvent(overrides: Partial<ControlEvent> = {}): ControlEvent {
	return {
		type: "needs_attention",
		to: "needs_attention",
		ts: 1,
		runId: "run-nointercom-1",
		agent: "worker",
		index: 0,
		message: "worker needs attention",
		reason: "idle",
		...overrides,
	};
}

// ─── describe ────────────────────────────────────────────────────────────────

describe("no-pi-intercom regression guard", () => {
	// ── (a) contact_supervisor round-trip without intercom ────────────────────

	describe("contact_supervisor round-trip with no intercom tool installed", () => {
		let savedEnv: SavedEnv;

		afterEach(() => {
			if (savedEnv) restoreEnv(savedEnv);
		});

		it("completes a need_decision request/reply cycle using only the native channel", async () => {
			savedEnv = saveEnv();

			const runId = `run-${randomUUID()}`;
			const agent = "worker";
			const childIndex = 0;
			const orchestratorSessionId = `session-${randomUUID()}`;
			const channelDir = resolveSupervisorChannelDir(runId, agent, childIndex);

			ensureSupervisorChannelDir(channelDir);

			// Wire env so readChildMetadata() resolves
			process.env[SUBAGENT_RUN_ID_ENV] = runId;
			process.env[SUBAGENT_CHILD_AGENT_ENV] = agent;
			process.env[SUBAGENT_CHILD_INDEX_ENV] = String(childIndex);
			process.env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = orchestratorSessionId;
			process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = channelDir;

			// Child side: mock pi with NO 'intercom' tool pre-installed
			const childTools = new Map<string, { execute: (_id: string, params: unknown, signal?: AbortSignal) => Promise<unknown> }>();
			const childPi = {
				getAllTools: () => [...childTools.keys()].map((name) => ({ name })),
				registerTool: (tool: { name: string; execute: (_id: string, params: unknown, signal?: AbortSignal) => Promise<unknown> }) => {
					childTools.set(tool.name, tool);
				},
				sendMessage: () => {},
				getSessionName: () => "child-session",
			};

			// Register native supervisor client — no intercom tool present
			registerNativeSupervisorClient(childPi as never, { includeIntercomFallback: false });

			assert.ok(childTools.has("contact_supervisor"), "contact_supervisor should be registered");
			assert.ok(!childTools.has("intercom"), "intercom must NOT be registered when includeIntercomFallback is false");

			// Parent side: real native supervisor channel scoped to the SAME
			// orchestrator session id the child env points at. No intercom tool
			// pre-installed here either; sendMessage is a recorder no-op for the
			// proactive parent notice channel.start()/polling may deliver.
			const parentTools = new Map<string, { execute: (_id: string, params: { action: string; replyTo?: string; message?: string }) => Promise<unknown> }>();
			const parentCtx = {
				cwd: process.cwd(),
				hasUI: false,
				sessionManager: {
					getSessionId: () => orchestratorSessionId,
					getSessionFile: () => null,
					getEntries: () => [],
				},
			};
			const parentPi = {
				getAllTools: () => [...parentTools.keys()].map((name) => ({ name })),
				registerTool: (tool: { name: string; execute: (_id: string, params: { action: string; replyTo?: string; message?: string }) => Promise<unknown> }) => {
					parentTools.set(tool.name, tool);
				},
				sendMessage: () => {},
				getSessionName: () => "parent-session",
			};
			const parentChannel = createNativeSupervisorChannel(parentPi as never, makeParentState(orchestratorSessionId, parentCtx));

			try {
				parentChannel.start();
				assert.ok(parentTools.has(NATIVE_SUPERVISOR_TOOL_NAME), "parent subagent_supervisor tool should be registered");

				// Kick off the child-side request in the background
				const contactSupervisorTool = childTools.get("contact_supervisor")!;
				const resultPromise = contactSupervisorTool.execute("req-id", {
					reason: "need_decision",
					message: "Should I proceed with option A?",
				});

				// Wait for the request file to appear in the channel dir
				const requestsDir = path.join(channelDir, "requests");
				const repliesDir = path.join(channelDir, "replies");
				let requestId: string | undefined;
				await pollUntil(() => {
					const entries = fs.readdirSync(requestsDir).filter((f) => f.endsWith(".json"));
					if (entries.length > 0) {
						requestId = entries[0]!.replace(/\.json$/, "");
						return true;
					}
					return false;
				}, 4000);

				assert.ok(requestId, "Request file should have appeared in the channel dir");

				// Verify the request content
				const requestFile = path.join(requestsDir, `${requestId}.json`);
				const request = JSON.parse(fs.readFileSync(requestFile, "utf-8")) as {
					type?: string;
					reason?: string;
					expectsReply?: boolean;
					runId?: string;
				};
				assert.equal(request.type, "subagent.supervisor.request");
				assert.equal(request.reason, "need_decision");
				assert.equal(request.expectsReply, true);
				assert.equal(request.runId, runId);

				// Wait for the parent channel poller to discover the request
				// (new request files are picked up by the poll loop, ≤500ms).
				await pollUntil(() => parentChannel.pending.has(requestId!), 4000);

				// Parent replies through the REAL subagent_supervisor reply path
				// (refreshes pending requests before replying), not a hand-written
				// reply file — so format drift in the parent-side writer is caught.
				await parentTools.get(NATIVE_SUPERVISOR_TOOL_NAME)!.execute("reply", {
					action: "reply",
					replyTo: requestId,
					message: "Proceed with option A — approved.",
				});
				assert.ok(fs.existsSync(path.join(repliesDir, `${requestId}.json`)), "parent reply file should exist");

				// Child side receives reply
				const result = await resultPromise as { content?: Array<{ type: string; text: string }>; details?: { requestId?: string; reason?: string } };

				assert.ok(Array.isArray(result.content) && result.content.length > 0, "Result should have content");
				const text = result.content![0]!.text;
				assert.ok(text.includes("Proceed with option A — approved."), `Reply text should contain supervisor message; got: ${text}`);
				assert.equal(result.details?.requestId, requestId);
				assert.equal(result.details?.reason, "need_decision");
			} finally {
				parentChannel.dispose();
				fs.rmSync(channelDir, { recursive: true, force: true });
			}
		});
	});

	// ── (b) needs_attention notice emits no intercom events ──────────────────

	describe("needs_attention notice intercom-independence", () => {
		it("delivers notice via pi.sendMessage without emitting any *-intercom events on the event bus", () => {
			const state = makeControlState();

			// Event bus that records emitted events
			const emittedEvents: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const sent: Array<{ message: unknown; options: unknown }> = [];

			const mockPi = {
				sendMessage(message: unknown, options: unknown) {
					// Delivery goes here — not to the event bus
					sent.push({ message, options });
				},
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const handlers = listeners.get(event) ?? new Set();
						handlers.add(handler);
						listeners.set(event, handlers);
						return () => handlers.delete(handler);
					},
					emit(event: string, data: unknown) {
						emittedEvents.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
					},
				},
			};

			handleSubagentControlNotice({
				pi: mockPi as never,
				state,
				visibleControlNotices: new Set(),
				details: { source: "async", event: needsAttentionEvent() },
				foregroundDelayMs: 20,
			});

			// The control notice must have been delivered via sendMessage…
			assert.equal(sent.length, 1, `Expected exactly one delivered control notice; got ${sent.length}`);

			// …but must NOT have produced any intercom event-bus emissions.
			const controlIntercomEmissions = emittedEvents.filter((e) => e.event === SUBAGENT_CONTROL_INTERCOM_EVENT);
			const resultIntercomEmissions = emittedEvents.filter((e) => e.event === SUBAGENT_RESULT_INTERCOM_EVENT);

			assert.equal(
				controlIntercomEmissions.length,
				0,
				`Expected zero ${SUBAGENT_CONTROL_INTERCOM_EVENT} emissions; got ${controlIntercomEmissions.length}`,
			);
			assert.equal(
				resultIntercomEmissions.length,
				0,
				`Expected zero ${SUBAGENT_RESULT_INTERCOM_EVENT} emissions; got ${resultIntercomEmissions.length}`,
			);
		});
	});
});
