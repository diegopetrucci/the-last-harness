import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_NODE_TIMEOUT_DELAY_MS, scheduleDeadline } from "../../src/runs/shared/deadline-timer.ts";

describe("deadline timer", () => {
	it("chunks above-boundary deadlines and cancellation prevents re-arming", () => {
		let now = 100;
		let fired = 0;
		const scheduled: Array<{ handler: () => void; delayMs: number; handle: ReturnType<typeof setTimeout> }> = [];
		const cleared: Array<ReturnType<typeof setTimeout>> = [];
		const timer = scheduleDeadline(now + MAX_NODE_TIMEOUT_DELAY_MS + 25, () => { fired++; }, {
			now: () => now,
			setTimeout: (handler, delayMs) => {
				const handle = { unref() {} } as ReturnType<typeof setTimeout>;
				scheduled.push({ handler, delayMs, handle });
				return handle;
			},
			clearTimeout: (handle) => { cleared.push(handle); },
		});

		assert.equal(scheduled[0]?.delayMs, MAX_NODE_TIMEOUT_DELAY_MS);
		now += MAX_NODE_TIMEOUT_DELAY_MS;
		scheduled[0]!.handler();
		assert.equal(fired, 0);
		assert.equal(scheduled[1]?.delayMs, 25);

		timer.cancel();
		assert.deepEqual(cleared, [scheduled[1]!.handle]);
		now += 25;
		scheduled[1]!.handler();
		assert.equal(fired, 0);
		assert.equal(scheduled.length, 2);
	});

	it("fires once when the final chunk reaches the deadline", () => {
		let now = 0;
		let fired = 0;
		const handlers: Array<() => void> = [];
		scheduleDeadline(MAX_NODE_TIMEOUT_DELAY_MS + 1, () => { fired++; }, {
			now: () => now,
			setTimeout: (handler) => {
				handlers.push(handler);
				return { unref() {} } as ReturnType<typeof setTimeout>;
			},
		});

		now = MAX_NODE_TIMEOUT_DELAY_MS;
		handlers.shift()!();
		assert.equal(fired, 0);
		now++;
		handlers.shift()!();
		assert.equal(fired, 0);
		handlers.shift()!();
		assert.equal(fired, 1);
	});
});
