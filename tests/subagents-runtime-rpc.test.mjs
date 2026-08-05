import assert from "node:assert/strict";
import test from "node:test";

import {
	registerSubagentRpcBridge,
	subagentRpcReplyEvent,
	SUBAGENT_RPC_PROTOCOL_VERSION,
	SUBAGENT_RPC_READY_EVENT,
	SUBAGENT_RPC_REQUEST_EVENT,
} from "../extensions/subagents/src/extension/rpc.js";

class FakeEvents {
	#handlers = new Map();

	on(event, handler) {
		const handlers = this.#handlers.get(event) ?? [];
		handlers.push(handler);
		this.#handlers.set(event, handlers);
		return () => {
			const current = this.#handlers.get(event) ?? [];
			this.#handlers.set(event, current.filter((candidate) => candidate !== handler));
		};
	}

	emit(event, data) {
		for (const handler of this.#handlers.get(event) ?? []) void handler(data);
	}
}

function createContext() {
	return {
		cwd: "/tmp/tlh-runtime-rpc",
		sessionManager: {
			getSessionId: () => "session-smoke",
			getSessionFile: () => null,
		},
	};
}

test("generated subagents RPC bridge loads and registers ping through its event protocol", async () => {
	const events = new FakeEvents();
	const context = createContext();
	const bridge = registerSubagentRpcBridge({
		events,
		getContext: () => context,
		execute: async () => {
			throw new Error("ping smoke must not execute a subagent");
		},
	});

	try {
		const ready = new Promise((resolve) => {
			events.on(SUBAGENT_RPC_READY_EVENT, resolve);
		});
		bridge.emitReady(context);
		const readyData = await ready;
		assert.equal(readyData.version, SUBAGENT_RPC_PROTOCOL_VERSION);
		assert.deepEqual(readyData.methods, ["ping", "status", "spawn", "interrupt", "stop"]);

		const reply = new Promise((resolve) => {
			events.on(subagentRpcReplyEvent("smoke"), resolve);
		});
		events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
			version: SUBAGENT_RPC_PROTOCOL_VERSION,
			requestId: "smoke",
			method: "ping",
		});
		const envelope = await reply;
		assert.equal(envelope.success, true);
		assert.equal(envelope.requestId, "smoke");
		assert.deepEqual(envelope.data.session, {
			cwd: "/tmp/tlh-runtime-rpc",
			sessionId: "session-smoke",
			sessionFile: null,
		});
	} finally {
		bridge.dispose();
	}
});
