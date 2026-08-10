/**
 * Regression guard: native supervisor channel and control-notice delivery
 * must work without pi-intercom installed.
 *
 * TLH is retiring pi-intercom; this file asserts:
 *   (a) needs_attention notices delivered via handleSubagentControlNotice
 *       do NOT emit subagent:control-intercom or subagent:result-intercom
 *       events on the pi event bus.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleSubagentControlNotice } from "../../src/extension/control-notices.ts";
import { SUBAGENT_CONTROL_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_EVENT } from "../../src/shared/types.ts";
import type { ControlEvent, SubagentState } from "../../src/shared/types.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

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
	// ── (a) needs_attention notice emits no intercom events ──────────────────

	describe("needs_attention notice intercom-independence", () => {
		it("delivers notice via pi.sendMessage without emitting any *-intercom events on the event bus", () => {
			const state = makeControlState();

			// Event bus that records emitted events
			const emittedEvents: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const sent: Array<{ message: unknown; options: unknown }> = [];

			const nudges: Array<{ text: string; options: unknown }> = [];
			const mockPi = {
				sendMessage(message: unknown, options?: unknown) {
					// Delivery goes here — not to the event bus
					sent.push({ message, options });
				},
				sendUserMessage(text: string, options?: unknown) {
					nudges.push({ text, options });
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
