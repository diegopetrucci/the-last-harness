export const MAX_NODE_TIMEOUT_DELAY_MS = 2_147_483_647;

type TimeoutHandle = ReturnType<typeof setTimeout>;

function unrefTimeout(handle: TimeoutHandle | undefined): void {
	if (!handle || typeof handle !== "object" || !("unref" in handle)) return;
	(handle as NodeJS.Timeout).unref();
}

export interface DeadlineTimer {
	cancel(): void;
}

export interface DeadlineTimerOptions {
	now?: () => number;
	setTimeout?: (handler: () => void, delayMs: number) => TimeoutHandle;
	clearTimeout?: (handle: TimeoutHandle) => void;
}

/**
 * Schedule an absolute deadline without passing an overflowing delay to Node.
 * Long deadlines are re-armed in bounded chunks; cancellation prevents a
 * queued chunk callback from arming another timer.
 */
export function scheduleDeadline(
	deadlineAt: number,
	onDeadline: () => void,
	options: DeadlineTimerOptions = {},
): DeadlineTimer {
	const now = options.now ?? Date.now;
	const schedule: (handler: () => void, delayMs: number) => TimeoutHandle = options.setTimeout
		?? ((handler, delayMs) => setTimeout(handler, delayMs));
	const clear: (handle: TimeoutHandle) => void = options.clearTimeout ?? clearTimeout;
	let handle: TimeoutHandle | undefined;
	let cancelled = false;
	let fired = false;

	const arm = (): void => {
		if (cancelled || fired) return;
		const remainingMs = deadlineAt - now();
		if (remainingMs <= 0) {
			handle = schedule(() => {
				handle = undefined;
				if (cancelled || fired) return;
				fired = true;
				onDeadline();
			}, 0);
			unrefTimeout(handle);
			return;
		}
		handle = schedule(() => {
			handle = undefined;
			arm();
		}, Math.min(remainingMs, MAX_NODE_TIMEOUT_DELAY_MS));
		unrefTimeout(handle);
	};

	arm();
	return {
		cancel(): void {
			if (cancelled) return;
			cancelled = true;
			if (handle !== undefined) {
				clear(handle);
				handle = undefined;
			}
		},
	};
}
