import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TlhEffectiveActivitySnapshot, TlhEffectiveActivityTracker } from "./activity-tracker.js";

const HERDR_SOURCE = "herdr:tlh";
const HERDR_AGENT = "pi";
const CMUX_STATUS_KEY = "tlh";
const DEFAULT_IDLE_DEBOUNCE_MS = 250;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20000;
const HERDR_SOCKET_ATTEMPT_TIMEOUTS_MS = [500, 1500] as const;

type TimeoutHandle = ReturnType<typeof setTimeout>;

type TimerApi = {
	setTimeout: typeof setTimeout;
	clearTimeout: typeof clearTimeout;
};

type StateSender = (state: "working" | "idle") => Promise<void>;

type TlhActivityReporter = {
	handleSessionStart(ctx: Pick<ExtensionContext, "mode" | "sessionManager">): void;
	handleSnapshot(snapshot: TlhEffectiveActivitySnapshot): void;
	handleSessionShutdown(): void;
	dispose(): void;
};

type TlhActivityReporterOptions = {
	idleDebounceMs?: number;
	timers?: Partial<TimerApi>;
};

type HerdrRequestSender = (request: unknown) => Promise<void>;
type HerdrSocket = Pick<ReturnType<typeof createConnection>, "on" | "removeListener" | "write" | "destroy">;
type HerdrSocketFactory = (path: string) => HerdrSocket;

type HerdrActivityReporterOptions = TlhActivityReporterOptions & {
	env?: NodeJS.ProcessEnv;
	sendRequest?: HerdrRequestSender;
	now?: () => number;
	agentDir?: string;
	createSocket?: HerdrSocketFactory;
};

type CommandRunner = (command: string, args: readonly string[]) => Promise<void>;

type CmuxActivityReporterOptions = TlhActivityReporterOptions & {
	env?: NodeJS.ProcessEnv;
	runner?: CommandRunner;
	cmuxBin?: string;
};

type ActivitySessionRef = {
	agentSessionId?: string;
	agentSessionPath?: string;
};

function parseDurationEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function createNoopReporter(): TlhActivityReporter {
	return {
		handleSessionStart() {},
		handleSnapshot() {},
		handleSessionShutdown() {},
		dispose() {},
	};
}

function createQueuedStateReporter(
	sendState: StateSender,
	options: TlhActivityReporterOptions = {},
): Pick<TlhActivityReporter, "handleSnapshot" | "handleSessionShutdown" | "dispose"> {
	const timers: TimerApi = {
		setTimeout: options.timers?.setTimeout ?? setTimeout,
		clearTimeout: options.timers?.clearTimeout ?? clearTimeout,
	};
	const idleDebounceMs = options.idleDebounceMs ?? DEFAULT_IDLE_DEBOUNCE_MS;
	let idleTimer: TimeoutHandle | undefined;
	let sendInFlight = false;
	let queuedState: "working" | "idle" | undefined;
	let lastQueuedState: "working" | "idle" | undefined;
	let disposed = false;

	const clearIdleTimer = (): void => {
		if (!idleTimer) return;
		timers.clearTimeout(idleTimer);
		idleTimer = undefined;
	};

	const queueState = (state: "working" | "idle"): void => {
		if (disposed || lastQueuedState === state) return;
		queuedState = state;
		lastQueuedState = state;
		if (!sendInFlight) {
			void drainQueue();
		}
	};

	const drainQueue = async (): Promise<void> => {
		if (sendInFlight || disposed) return;
		sendInFlight = true;
		try {
			while (!disposed && queuedState) {
				const nextState = queuedState;
				queuedState = undefined;
				try {
					await sendState(nextState);
				} catch {
					// Reporter failures must never block or crash TLH.
				}
			}
		} finally {
			sendInFlight = false;
			if (!disposed && queuedState) {
				void drainQueue();
			}
		}
	};

	return {
		handleSnapshot(snapshot) {
			if (disposed) return;
			if (snapshot.inProgress) {
				clearIdleTimer();
				queueState("working");
				return;
			}
			clearIdleTimer();
			idleTimer = timers.setTimeout(() => {
				idleTimer = undefined;
				queueState("idle");
			}, idleDebounceMs);
			(idleTimer as { unref?: () => void }).unref?.();
		},
		handleSessionShutdown() {
			clearIdleTimer();
		},
		dispose() {
			disposed = true;
			clearIdleTimer();
			queuedState = undefined;
		},
	};
}

function readSessionRef(ctx: Pick<ExtensionContext, "sessionManager">): ActivitySessionRef {
	let agentSessionPath: string | undefined;
	let agentSessionId: string | undefined;
	try {
		const candidatePath = ctx.sessionManager.getSessionFile();
		agentSessionPath = typeof candidatePath === "string" && candidatePath.startsWith("/") ? candidatePath : undefined;
	} catch {
		agentSessionPath = undefined;
	}
	try {
		const candidateId = ctx.sessionManager.getSessionId();
		agentSessionId = typeof candidateId === "string" && candidateId.length > 0 ? candidateId : undefined;
	} catch {
		agentSessionId = undefined;
	}
	return { agentSessionId, agentSessionPath };
}

function withSessionRef(params: Record<string, unknown>, sessionRef: ActivitySessionRef): Record<string, unknown> {
	if (sessionRef.agentSessionPath) {
		return { ...params, agent_session_path: sessionRef.agentSessionPath };
	}
	if (sessionRef.agentSessionId) {
		return { ...params, agent_session_id: sessionRef.agentSessionId };
	}
	return params;
}

function createHerdrSocketAttempt(
	socketPath: string,
	request: unknown,
	timeoutMs: number,
	options: {
		createSocket?: HerdrSocketFactory;
		timers?: Partial<TimerApi>;
	},
): Promise<boolean> {
	const timers: TimerApi = {
		setTimeout: options.timers?.setTimeout ?? setTimeout,
		clearTimeout: options.timers?.clearTimeout ?? clearTimeout,
	};
	const payload = `${JSON.stringify(request)}\n`;
	const createSocket = options.createSocket ?? ((path: string) => createConnection(path));
	return new Promise<boolean>((resolve) => {
		let settled = false;
		let socket: HerdrSocket | undefined;
		let timeout: TimeoutHandle | undefined;
		const finish = (delivered: boolean) => {
			if (settled) return;
			settled = true;
			if (timeout) {
				timers.clearTimeout(timeout);
				timeout = undefined;
			}
			socket?.removeListener?.("error", handleError);
			socket?.removeListener?.("connect", handleConnect);
			socket?.removeListener?.("data", handleData);
			socket?.removeListener?.("end", handleEnd);
			try {
				socket?.destroy();
			} catch {
				// Ignore teardown failures.
			}
			resolve(delivered);
		};
		const handleError = () => finish(false);
		const handleConnect = () => {
			try {
				socket?.write(payload);
			} catch {
				finish(false);
			}
		};
		const handleData = () => finish(true);
		const handleEnd = () => finish(false);
		try {
			socket = createSocket(socketPath);
		} catch {
			finish(false);
			return;
		}
		socket.on("error", handleError);
		socket.on("connect", handleConnect);
		socket.on("data", handleData);
		socket.on("end", handleEnd);
		timeout = timers.setTimeout(() => finish(false), timeoutMs);
		(timeout as { unref?: () => void }).unref?.();
	});
}

function defaultHerdrRequestSender(
	env: NodeJS.ProcessEnv,
	options: Pick<HerdrActivityReporterOptions, "createSocket" | "timers"> = {},
): HerdrRequestSender {
	return async (request) => {
		const socketPath = env.HERDR_SOCKET_PATH;
		if (!socketPath) return;
		for (const timeoutMs of HERDR_SOCKET_ATTEMPT_TIMEOUTS_MS) {
			const delivered = await createHerdrSocketAttempt(socketPath, request, timeoutMs, options);
			if (delivered) {
				return;
			}
		}
		// Exhausted retries resolve by design: this reporter is best-effort, and
		// heartbeats can recover delivery when the socket returns.
	};
}

export function createHerdrActivityReporter(options: HerdrActivityReporterOptions = {}): TlhActivityReporter {
	const env = options.env ?? process.env;
	const paneId = env.HERDR_PANE_ID;
	if (!paneId || !env.HERDR_SOCKET_PATH) {
		return createNoopReporter();
	}
	if (env.HERDR_ENV !== undefined && env.HERDR_ENV !== "1") {
		return createNoopReporter();
	}
	const agentDir = options.agentDir ?? env.PI_CODING_AGENT_DIR;
	if (agentDir && existsSync(join(agentDir, "extensions", "herdr-agent-state.ts"))) {
		return createNoopReporter();
	}
	const sendRequest = options.sendRequest ?? defaultHerdrRequestSender(env, options);
	const now = options.now ?? Date.now;
	let reportSeq = now() * 1000;
	let sessionRef: ActivitySessionRef = {};
	let rootSession = false;
	let disposed = false;

	const heartbeatIntervalMs = parseDurationEnv(env, "HERDR_TLH_HEARTBEAT_MS", DEFAULT_HEARTBEAT_INTERVAL_MS);
	const heartbeatTimers: TimerApi = {
		setTimeout: options.timers?.setTimeout ?? setTimeout,
		clearTimeout: options.timers?.clearTimeout ?? clearTimeout,
	};
	let desiredState: "working" | "idle" | undefined;
	let lastReportedState: "working" | "idle" | undefined;
	let heartbeatTimer: TimeoutHandle | undefined;
	let heartbeatStopped = false;
	let heartbeatStarted = false;
	let outboundChain: Promise<void> = Promise.resolve();

	const nextReportSeq = (): number => {
		reportSeq += 1;
		return reportSeq;
	};

	// State and heartbeat deliveries share this chain. Sequence numbers are
	// allocated by each task only when it reaches the front of the chain.
	const enqueueOutbound = (task: () => Promise<void>): Promise<void> => {
		const delivery = outboundChain.then(task);
		outboundChain = delivery.catch(() => {});
		return delivery;
	};

	const sendStateCore = async (state: "working" | "idle"): Promise<void> => {
		await sendRequest({
			id: `${HERDR_SOURCE}:${now()}:${Math.random().toString(36).slice(2)}`,
			method: "pane.report_agent",
			params: withSessionRef({
				pane_id: paneId,
				source: HERDR_SOURCE,
				agent: HERDR_AGENT,
				state,
				seq: nextReportSeq(),
			}, sessionRef),
		});
	};

	const stopHeartbeat = (): void => {
		heartbeatStopped = true;
		if (heartbeatTimer) {
			heartbeatTimers.clearTimeout(heartbeatTimer);
			heartbeatTimer = undefined;
		}
	};

	const scheduleHeartbeat = (): void => {
		if (heartbeatStopped || !rootSession || disposed) return;
		heartbeatTimer = heartbeatTimers.setTimeout(() => {
			heartbeatTimer = undefined;
			if (heartbeatStopped || !rootSession || disposed) return;
			const heartbeatDelivery = enqueueOutbound(async () => {
				// Shutdown/dispose may happen while this heartbeat waits behind an
				// earlier delivery; do not send after the session has ended.
				if (heartbeatStopped || !rootSession || disposed) return;
				// Read desiredState here, not when the timer fires, so a queued
				// heartbeat cannot replay a stale state after a newer snapshot.
				const state = desiredState ?? lastReportedState;
				if (state === undefined) return;
				await sendStateCore(state);
				lastReportedState = state;
			});
			// A heartbeat failure must not break the outbound chain; schedule the
			// next recovery attempt only after this delivery settles.
			void heartbeatDelivery.catch(() => undefined).finally(() => {
				if (!heartbeatStopped && rootSession && !disposed) scheduleHeartbeat();
			});
		}, heartbeatIntervalMs);
		(heartbeatTimer as { unref?: () => void }).unref?.();
	};

	const sendState = (state: "working" | "idle"): Promise<void> => {
		// Update only when the debounced reporter commits a transition. Setting
		// this from handleSnapshot would let a heartbeat bypass idle debounce.
		desiredState = state;
		return enqueueOutbound(async () => {
			if (!rootSession || disposed) return;
			await sendStateCore(state);
			lastReportedState = state;
			if (!heartbeatStarted) {
				heartbeatStarted = true;
				// The default sender resolves after exhausted socket retries on
				// purpose, so this still starts best-effort recovery heartbeats.
				scheduleHeartbeat();
			}
		});
	};

	const queuedReporter = createQueuedStateReporter(sendState, {
		idleDebounceMs: options.idleDebounceMs ?? parseDurationEnv(env, "HERDR_TLH_IDLE_DEBOUNCE_MS", DEFAULT_IDLE_DEBOUNCE_MS),
		timers: options.timers,
	});

	return {
		handleSessionStart(ctx) {
			if (disposed || ctx.mode !== "tui") {
				rootSession = false;
				return;
			}
			rootSession = true;
			sessionRef = readSessionRef(ctx);
			if (!sessionRef.agentSessionId && !sessionRef.agentSessionPath) return;
			const startedSessionRef = sessionRef;
			void sendRequest({
				id: `${HERDR_SOURCE}:session:${now()}:${Math.random().toString(36).slice(2)}`,
				method: "pane.report_agent_session",
				params: withSessionRef({
					pane_id: paneId,
					source: HERDR_SOURCE,
					agent: HERDR_AGENT,
					seq: nextReportSeq(),
				}, startedSessionRef),
			}).catch(() => undefined);
		},
		handleSnapshot(snapshot) {
			if (!rootSession || disposed) return;
			queuedReporter.handleSnapshot(snapshot);
		},
		handleSessionShutdown() {
			if (!rootSession) return;
			rootSession = false;
			stopHeartbeat();
			queuedReporter.handleSessionShutdown();
			// No pane.release_agent: herdr v0.8.0 (commit e608a751) made pane
			// ownership release process-owned on confirmed agent exit. Sending
			// an explicit release here clears the pane's hook authority
			// mid-session, causing the pane to show idle while the architect
			// is still working. Do not re-add this call.
		},
		dispose() {
			disposed = true;
			rootSession = false;
			stopHeartbeat();
			queuedReporter.dispose();
		},
	};
}

function defaultCommandRunner(command: string, args: readonly string[]): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		let child: ReturnType<typeof spawn> | undefined;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		try {
			child = spawn(command, [...args], {
				stdio: "ignore",
				windowsHide: true,
			});
		} catch {
			finish();
			return;
		}
		child.on("error", finish);
		child.on("close", finish);
	});
}

function cmuxStatusValue(_snapshot: TlhEffectiveActivitySnapshot): string {
	return "working";
}

function sanitizeCmuxStatusKeySegment(value: string): string | undefined {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized.length > 0 ? sanitized : undefined;
}

function getCmuxStatusKey(
	env: NodeJS.ProcessEnv,
	ctx: Pick<ExtensionContext, "sessionManager">,
): string {
	const surfaceSegment = typeof env.CMUX_SURFACE_ID === "string" ? sanitizeCmuxStatusKeySegment(env.CMUX_SURFACE_ID) : undefined;
	if (surfaceSegment) {
		return `${CMUX_STATUS_KEY}-${surfaceSegment}`;
	}
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionSegment = typeof sessionId === "string" ? sanitizeCmuxStatusKeySegment(sessionId) : undefined;
		if (sessionSegment) {
			return `${CMUX_STATUS_KEY}-${sessionSegment}`;
		}
	} catch {
		// Ignore session id lookup failures and fall back to the global key.
	}
	return CMUX_STATUS_KEY;
}

export function createCmuxActivityReporter(options: CmuxActivityReporterOptions = {}): TlhActivityReporter {
	const env = options.env ?? process.env;
	if (!env.CMUX_WORKSPACE_ID) {
		return createNoopReporter();
	}
	const cmuxBin = options.cmuxBin ?? env.CMUX_PI_CMUX_BIN ?? env.CMUX_BUNDLED_CLI_PATH ?? env.CMUX_BIN ?? "cmux";
	const runner = options.runner ?? defaultCommandRunner;
	let rootSession = false;
	let lastValue: string | undefined;
	let statusKey = CMUX_STATUS_KEY;
	const sendState = async (state: "working" | "idle"): Promise<void> => {
		if (state === "idle") {
			lastValue = undefined;
			await runner(cmuxBin, ["clear-status", statusKey]);
			return;
		}
		const value = lastValue ?? "working";
		await runner(cmuxBin, ["set-status", statusKey, value]);
	};
	const queuedReporter = createQueuedStateReporter(sendState, options);
	return {
		handleSessionStart(ctx) {
			rootSession = ctx.mode === "tui";
			if (!rootSession) return;
			statusKey = getCmuxStatusKey(env, ctx);
		},
		handleSnapshot(snapshot) {
			if (!rootSession) return;
			lastValue = snapshot.inProgress ? cmuxStatusValue(snapshot) : undefined;
			queuedReporter.handleSnapshot(snapshot);
		},
		handleSessionShutdown() {
			if (!rootSession) return;
			queuedReporter.handleSessionShutdown();
			void runner(cmuxBin, ["clear-status", statusKey]).catch(() => undefined);
		},
		dispose() {
			queuedReporter.dispose();
		},
	};
}

export function registerTlhActivityReporters(
	pi: Pick<ExtensionAPI, "on">,
	tracker: TlhEffectiveActivityTracker,
	options: {
		herdr?: HerdrActivityReporterOptions;
		cmux?: CmuxActivityReporterOptions;
	} = {},
): void {
	const reporters = [createHerdrActivityReporter(options.herdr), createCmuxActivityReporter(options.cmux)];
	const unsubscribe = tracker.subscribe((snapshot) => {
		for (const reporter of reporters) {
			reporter.handleSnapshot(snapshot);
		}
	});
	pi.on("session_start", (_event, ctx) => {
		for (const reporter of reporters) {
			reporter.handleSessionStart(ctx);
		}
		const snapshot = tracker.getSnapshot();
		for (const reporter of reporters) {
			reporter.handleSnapshot(snapshot);
		}
	});
	pi.on("session_shutdown", () => {
		unsubscribe();
		for (const reporter of reporters) {
			reporter.handleSessionShutdown();
			reporter.dispose();
		}
	});
}
