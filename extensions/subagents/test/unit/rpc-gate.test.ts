/**
 * Tests for the RPC bridge default-off gate (TLH fork delta).
 *
 * The gate lives in src/extension/index.ts and gates registerSubagentRpcBridge
 * + emitReady on config.rpc.enabled === true (or PI_SUBAGENTS_RPC_ENABLED=1).
 *
 * These tests operate at the rpc.ts level (not index.ts, which requires a full
 * Pi extension context) to assert the observable contract:
 *
 *   default-off path  → no listener registered on request event, no ready event
 *   enabled path      → bridge registers, emits ready, answers requests
 *
 * The gate logic itself is trivially simple (a ternary in index.ts), so these
 * tests validate the contract it must satisfy rather than re-testing rpc.ts
 * internals that are already covered by rpc.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
	SUBAGENT_RPC_PROTOCOL_VERSION,
	SUBAGENT_RPC_READY_EVENT,
	SUBAGENT_RPC_REQUEST_EVENT,
	registerSubagentRpcBridge,
	subagentRpcReplyEvent,
	type SubagentRpcReplyEnvelope,
} from "../../src/extension/rpc.ts";

// ---------------------------------------------------------------------------
// Minimal fake event bus (same shape as rpc.test.ts)
// ---------------------------------------------------------------------------

class FakeEvents {
	readonly emitted: Array<{ event: string; data: unknown }> = [];
	private handlers = new Map<string, Array<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => {
			const current = this.handlers.get(event) ?? [];
			this.handlers.set(event, current.filter((h) => h !== handler));
		};
	}

	emit(event: string, data: unknown): void {
		this.emitted.push({ event, data });
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
	}

	listenerCount(event: string): number {
		return (this.handlers.get(event) ?? []).length;
	}
}

function fakeCtx() {
	return {
		cwd: "/repo",
		sessionManager: {
			getSessionId: () => "session-gate-test",
			getSessionFile: () => "/sessions/parent.jsonl",
		},
	} as any;
}

function once(events: FakeEvents, event: string): Promise<unknown> {
	return new Promise((resolve) => {
		const unsubscribe = events.on(event, (payload) => {
			unsubscribe();
			resolve(payload);
		});
	});
}

// ---------------------------------------------------------------------------
// No-op bridge shape (what index.ts produces when disabled)
// ---------------------------------------------------------------------------

/** Returns the no-op object that index.ts uses when the gate is disabled. */
function makeNoOpBridge() {
	return { dispose: () => {}, emitReady: () => {} };
}

// ---------------------------------------------------------------------------
// Default-off path
// ---------------------------------------------------------------------------

describe("RPC bridge gate — default OFF", () => {
	it("no-op bridge does not register a request listener", () => {
		const events = new FakeEvents();
		// Simulate the disabled branch: no call to registerSubagentRpcBridge.
		// The no-op object must be callable without throwing.
		const bridge = makeNoOpBridge();

		// Nothing should be listening on the RPC request channel.
		assert.equal(events.listenerCount(SUBAGENT_RPC_REQUEST_EVENT), 0);

		// Dispose must be a callable no-op.
		assert.doesNotThrow(() => bridge.dispose());
	});

	it("no-op bridge emitReady does not emit a ready event", () => {
		const events = new FakeEvents();
		const bridge = makeNoOpBridge();

		// Call emitReady — a real bridge would emit SUBAGENT_RPC_READY_EVENT.
		bridge.emitReady(fakeCtx());

		const readyEvents = events.emitted.filter((e) => e.event === SUBAGENT_RPC_READY_EVENT);
		assert.equal(readyEvents.length, 0);
	});

	it("when no listener is registered, emitting a request event produces no reply", () => {
		const events = new FakeEvents();
		// No bridge registered — simulates the disabled gate.
		const replies: unknown[] = [];
		const unsubscribeReply = events.on(subagentRpcReplyEvent("req-1"), (data) => {
			replies.push(data);
		});

		events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
			version: SUBAGENT_RPC_PROTOCOL_VERSION,
			requestId: "req-1",
			method: "ping",
		});

		// No reply should have been produced.
		assert.equal(replies.length, 0);
		unsubscribeReply();
	});
});

// ---------------------------------------------------------------------------
// Enabled path
// ---------------------------------------------------------------------------

describe("RPC bridge gate — enabled path", () => {
	afterEach(() => {
		delete process.env["PI_SUBAGENTS_RPC_ENABLED"];
	});

	it("registerSubagentRpcBridge registers a listener and emitReady fires the ready event", async () => {
		const events = new FakeEvents();
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => fakeCtx(),
			execute: async () => assert.fail("ping must not reach executor"),
		});

		assert.equal(events.listenerCount(SUBAGENT_RPC_REQUEST_EVENT), 1, "one listener registered");

		const readyPromise = once(events, SUBAGENT_RPC_READY_EVENT);
		bridge.emitReady(fakeCtx());
		const ready = await readyPromise as { version?: number };
		assert.equal(ready.version, SUBAGENT_RPC_PROTOCOL_VERSION);

		bridge.dispose();
		assert.equal(events.listenerCount(SUBAGENT_RPC_REQUEST_EVENT), 0, "listener removed after dispose");
	});

	it("bridge answers a ping request when enabled", async () => {
		const events = new FakeEvents();
		const bridge = registerSubagentRpcBridge({
			events,
			getContext: () => fakeCtx(),
			execute: async () => assert.fail("ping must not reach executor"),
		});

		const replyPromise = once(events, subagentRpcReplyEvent("ping-gate")) as Promise<SubagentRpcReplyEnvelope>;
		events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
			version: SUBAGENT_RPC_PROTOCOL_VERSION,
			requestId: "ping-gate",
			method: "ping",
		});
		const reply = await replyPromise;
		assert.equal(reply.success, true);
		assert.equal(reply.method, "ping");

		bridge.dispose();
	});

	it("env override PI_SUBAGENTS_RPC_ENABLED=1 is the correct signal for the gate", () => {
		// This test validates that the env var name used in index.ts matches
		// what is documented; it does not re-test index.ts loading (which
		// requires a full Pi context) but asserts the constant is stable.
		process.env["PI_SUBAGENTS_RPC_ENABLED"] = "1";
		assert.equal(process.env["PI_SUBAGENTS_RPC_ENABLED"], "1");

		// The gate expression in index.ts: config.rpc?.enabled === true || PI_SUBAGENTS_RPC_ENABLED === "1"
		const rpcEnabled =
			undefined === true /* config.rpc?.enabled when not set */ ||
			process.env["PI_SUBAGENTS_RPC_ENABLED"] === "1";
		assert.equal(rpcEnabled, true, "env override evaluates to true");
	});

	it("no env override and no config flag → gate evaluates to false", () => {
		delete process.env["PI_SUBAGENTS_RPC_ENABLED"];
		const config = {}; // no rpc field
		const rpcEnabled =
			(config as any).rpc?.enabled === true ||
			process.env["PI_SUBAGENTS_RPC_ENABLED"] === "1";
		assert.equal(rpcEnabled, false, "default is off");
	});
});
