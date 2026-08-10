import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_ORCHESTRATOR_TARGET_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
} from "../runs/shared/pi-args.ts";
import { POLL_INTERVAL_MS, TEMP_ROOT_DIR, type SubagentState } from "../shared/types.ts";
import { writeAtomicJson } from "../shared/atomic-json.ts";

const SUPERVISOR_CHANNEL_ROOT = path.join(TEMP_ROOT_DIR, "supervisor-channels");
const REQUESTS_DIR = "requests";
export const NATIVE_SUPERVISOR_TOOL_NAME = "subagent_supervisor";
const MAX_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const CHANNEL_POLL_MS = Math.min(POLL_INTERVAL_MS, 500);
const STALE_EMPTY_CHANNEL_AGE_MS = 60 * 1000;
const STALE_EMPTY_CHANNEL_CLEANUP_INTERVAL_MS = 60 * 1000;

type SupervisorReason = "need_decision" | "interview_request" | "progress_update";

interface SupervisorRequest {
	type: "subagent.supervisor.request";
	id: string;
	createdAt: number;
	expiresAt?: number;
	reason: SupervisorReason;
	message: string;
	expectsReply: boolean;
	orchestratorTarget?: string;
	orchestratorSessionId?: string;
	runId: string;
	agent: string;
	childIndex: number;
	childTarget?: string;
	interview?: unknown;
}

interface PendingSupervisorRequest extends SupervisorRequest {
	channelDir: string;
	requestFile: string;
}

interface ContactSupervisorParams {
	reason: SupervisorReason;
	message?: string;
	interview?: unknown;
}

interface IntercomParams {
	action: "list" | "send" | "ask" | "pending" | "status";
	message?: string;
}

const ContactSupervisorParamsSchema = Type.Object(
	{
		reason: Type.String({ enum: ["need_decision", "interview_request", "progress_update"] }),
		message: Type.Optional(Type.String()),
		interview: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true })),
	},
	{ additionalProperties: false },
);

const IntercomParamsSchema = Type.Object(
	{
		action: Type.String({ enum: ["list", "send", "ask", "pending", "status"] }),
		message: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

function safeSegment(value: string): string {
	return (
		value
			.trim()
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "unknown"
	);
}

export function resolveSupervisorChannelDir(runId: string, agent: string, childIndex: number): string {
	return path.join(SUPERVISOR_CHANNEL_ROOT, `${safeSegment(runId)}-${safeSegment(agent)}-${childIndex}`);
}

export function ensureSupervisorChannelDir(channelDir: string): void {
	fs.mkdirSync(path.join(channelDir, REQUESTS_DIR), { recursive: true, mode: 0o700 });
}

function requestPath(channelDir: string, requestId: string): string {
	return path.join(channelDir, REQUESTS_DIR, `${safeSegment(requestId)}.json`);
}

function readTextEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

function readChildMetadata():
	| {
			channelDir: string;
			runId: string;
			agent: string;
			childIndex: number;
			orchestratorTarget?: string;
			orchestratorSessionId?: string;
			childTarget?: string;
	  }
	| undefined {
	const channelDir = readTextEnv(SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV);
	const runId = readTextEnv(SUBAGENT_RUN_ID_ENV);
	const agent = readTextEnv(SUBAGENT_CHILD_AGENT_ENV);
	const rawIndex = readTextEnv(SUBAGENT_CHILD_INDEX_ENV);
	const orchestratorSessionId = readTextEnv(SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV);
	if (!channelDir || !runId || !agent || !orchestratorSessionId || rawIndex === undefined || !/^\d+$/.test(rawIndex))
		return undefined;
	return {
		channelDir,
		runId,
		agent,
		childIndex: Number(rawIndex),
		orchestratorTarget: readTextEnv(SUBAGENT_ORCHESTRATOR_TARGET_ENV),
		orchestratorSessionId,
		childTarget: readTextEnv("PI_SUBAGENT_INTERCOM_SESSION_NAME"),
	};
}

function reasonHeading(reason: SupervisorReason): string {
	if (reason === "interview_request") return "Subagent requests a structured supervisor interview.";
	if (reason === "progress_update") return "Subagent progress update.";
	return "Subagent needs a supervisor decision.";
}

function formatChildMessage(input: {
	reason: SupervisorReason;
	message?: string;
	interview?: unknown;
	runId: string;
	agent: string;
	childIndex: number;
	childTarget?: string;
}): string {
	const lines = [
		reasonHeading(input.reason),
		`Run: ${input.runId}`,
		`Agent: ${input.agent}`,
		`Child index: ${input.childIndex}`,
	];
	if (input.childTarget) lines.push(`Child intercom target: ${input.childTarget}`);
	lines.push("");
	if (input.message?.trim()) lines.push(input.message.trim());
	if (input.reason === "interview_request") {
		lines.push(
			"",
			"Structured response requested. Reply with JSON, optionally fenced in ```json, matching the requested interview shape.",
		);
		if (input.interview !== undefined) lines.push(JSON.stringify(input.interview, null, "\t"));
	}
	return lines.join("\n").trimEnd();
}

function askTimeoutMs(): number {
	const parsed = Number(process.env.PI_INTERCOM_ASK_TIMEOUT_MS);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ASK_TIMEOUT_MS;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Supervisor request cancelled."));
			return;
		}
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new Error("Supervisor request cancelled."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// Keep this function alive and blocking until the deadline or abort.
// This is load-bearing: it keeps the child process blocked inside the
// contact_supervisor tool call so the Pi runner has time to durably pause
// (kill) the process. The runner kills the child before the deadline fires
// under normal operation; the timeout error is the safety net when the pause
// machinery fails. Do NOT make this return early — removing the block breaks
// the durable-pause contract.
async function waitForSupervisorPauseOrTimeout(deadline: number, signal?: AbortSignal): Promise<never> {
	while (Date.now() <= deadline) {
		if (signal?.aborted) throw new Error("Supervisor request cancelled.");
		await delay(250, signal);
	}
	throw new Error("Timed out waiting for supervisor reply.");
}

async function sendSupervisorRequest(
	params: ContactSupervisorParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<Record<string, unknown>>> {
	const metadata = readChildMetadata();
	if (!metadata) throw new Error("Native supervisor channel is not available for this subagent.");
	if (params.reason !== "progress_update" && !params.message?.trim() && params.reason !== "interview_request") {
		throw new Error("message is required for supervisor decisions.");
	}
	ensureSupervisorChannelDir(metadata.channelDir);
	const requestId = randomUUID();
	const expectsReply = params.reason !== "progress_update";
	const createdAt = Date.now();
	const replyDeadline = createdAt + askTimeoutMs();
	const expiresAt = expectsReply ? replyDeadline : undefined;
	const message = formatChildMessage({
		...metadata,
		reason: params.reason,
		message: params.message,
		interview: params.interview,
	});
	const request: SupervisorRequest = {
		type: "subagent.supervisor.request",
		id: requestId,
		createdAt,
		...(expiresAt !== undefined ? { expiresAt } : {}),
		reason: params.reason,
		message,
		expectsReply,
		...(metadata.orchestratorTarget ? { orchestratorTarget: metadata.orchestratorTarget } : {}),
		...(metadata.orchestratorSessionId ? { orchestratorSessionId: metadata.orchestratorSessionId } : {}),
		runId: metadata.runId,
		agent: metadata.agent,
		childIndex: metadata.childIndex,
		...(metadata.childTarget ? { childTarget: metadata.childTarget } : {}),
		...(params.interview !== undefined ? { interview: params.interview } : {}),
	};
	const serialized = JSON.stringify(request, null, "\t");
	if (Buffer.byteLength(serialized, "utf-8") > MAX_MESSAGE_BYTES) throw new Error("Supervisor request is too large.");
	writeAtomicJson(requestPath(metadata.channelDir, requestId), request);

	if (!expectsReply) {
		return {
			content: [{ type: "text", text: "Supervisor progress update queued." }],
			details: { delivered: true, requestId, reason: params.reason },
		};
	}

	return waitForSupervisorPauseOrTimeout(replyDeadline, signal).catch((error: unknown) => {
		removeRequestFile(requestPath(metadata.channelDir, requestId));
		throw error;
	});
}

function hasTool(pi: ExtensionAPI, name: string): boolean {
	try {
		return pi.getAllTools?.().some((tool: { name?: unknown }) => tool.name === name) === true;
	} catch {
		return false;
	}
}

export function registerNativeSupervisorClient(
	pi: ExtensionAPI,
	options: { includeIntercomFallback?: boolean } = {},
): void {
	if (!readChildMetadata()) return;
	const includeIntercomFallback = options.includeIntercomFallback !== false;
	const registerTool = (
		(pi as unknown as Record<string, unknown>).registerTool as (tool: {
			name: string;
			label: string;
			description: string;
			parameters: TSchema;
			execute: (id: string, params: unknown, signal: AbortSignal | undefined) => Promise<unknown>;
		}) => void
	).bind(pi);
	if (!hasTool(pi, "contact_supervisor")) {
		registerTool({
			name: "contact_supervisor",
			label: "Contact Supervisor",
			description:
				"Contact the parent/supervisor session for a blocking decision, structured interview, or progress update. Blocking decision requests durably pause the child until the parent resumes or cancels it; no child process keeps running while paused.",
			parameters: ContactSupervisorParamsSchema,
			execute(_id, params, signal) {
				return sendSupervisorRequest(params as ContactSupervisorParams, signal);
			},
		});
	}
	if (includeIntercomFallback && !hasTool(pi, "intercom")) {
		registerTool({
			name: "intercom",
			label: "Intercom",
			description:
				"Native supervisor-channel intercom fallback for subagents. Prefer contact_supervisor when available; blocking ask requests durably pause the child until the parent resumes or cancels it, and no child process keeps running while paused.",
			parameters: IntercomParamsSchema,
			async execute(_id, params, signal) {
				const action = (params as IntercomParams).action;
				if (action === "status")
					return {
						content: [{ type: "text", text: "Native supervisor channel is active." }],
						details: { active: true },
					};
				if (action === "list")
					return {
						content: [{ type: "text", text: "Supervisor session available through contact_supervisor." }],
						details: { sessions: [] },
					};
				if (action === "send")
					return sendSupervisorRequest(
						{ reason: "progress_update", message: (params as IntercomParams).message ?? "" },
						signal,
					);
				if (action === "ask")
					return sendSupervisorRequest(
						{ reason: "need_decision", message: (params as IntercomParams).message ?? "" },
						signal,
					);
				throw new Error(
					"Native child intercom supports status, list, send, and ask; to respond to a child request from the supervisor session, use subagent resume or subagent interrupt.",
				);
			},
		});
	}
}

function parseRequestFile(file: string, channelDir: string): PendingSupervisorRequest | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SupervisorRequest>;
		if (parsed.type !== "subagent.supervisor.request") return undefined;
		if (typeof parsed.id !== "string" || !parsed.id) return undefined;
		if (
			parsed.reason !== "need_decision" &&
			parsed.reason !== "interview_request" &&
			parsed.reason !== "progress_update"
		)
			return undefined;
		if (typeof parsed.message !== "string" || !parsed.message) return undefined;
		if (typeof parsed.runId !== "string" || typeof parsed.agent !== "string" || typeof parsed.childIndex !== "number")
			return undefined;
		return { ...(parsed as SupervisorRequest), channelDir, requestFile: file };
	} catch {
		return undefined;
	}
}

function listRequestFiles(): Array<{ channelDir: string; file: string }> {
	let channelEntries: fs.Dirent[];
	try {
		channelEntries = fs.readdirSync(SUPERVISOR_CHANNEL_ROOT, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const files: Array<{ channelDir: string; file: string }> = [];
	for (const entry of channelEntries) {
		if (!entry.isDirectory()) continue;
		const channelDir = path.join(SUPERVISOR_CHANNEL_ROOT, entry.name);
		const requestsDir = path.join(channelDir, REQUESTS_DIR);
		let requestEntries: fs.Dirent[];
		try {
			requestEntries = fs.readdirSync(requestsDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const requestEntry of requestEntries) {
			if (requestEntry.isFile() && requestEntry.name.endsWith(".json"))
				files.push({ channelDir, file: path.join(requestsDir, requestEntry.name) });
		}
	}
	return files;
}

function readDirectoryEntries(dir: string): fs.Dirent[] | undefined {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return undefined;
	}
}

function directoryMtimeMs(dir: string): number {
	try {
		return fs.statSync(dir).mtimeMs;
	} catch {
		return 0;
	}
}

function removeEmptyDirectory(dir: string): boolean {
	try {
		fs.rmdirSync(dir);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return true;
		if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM" || code === "EBUSY") return false;
		throw error;
	}
}

function removeStaleEmptySupervisorChannel(channelDir: string, nowMs: number): boolean {
	const requestsDir = path.join(channelDir, REQUESTS_DIR);
	const newestKnownMtimeMs = Math.max(directoryMtimeMs(channelDir), directoryMtimeMs(requestsDir));
	if (nowMs - newestKnownMtimeMs < STALE_EMPTY_CHANNEL_AGE_MS) return false;

	const requestEntries = readDirectoryEntries(requestsDir);
	if (!requestEntries || requestEntries.length > 0) return false;

	// One-time legacy-layout hygiene: older TLH versions created a replies/
	// subdirectory alongside requests/. Check it before any removal so we
	// never leave channelDir behind in a partial state.
	//   - replies/ exists with files → treat channel as in-use and bail.
	//   - replies/ exists and is empty → remove it as part of cleanup.
	//   - replies/ absent (new layout) → nothing to do, proceed as normal.
	const repliesDir = path.join(channelDir, "replies");
	const repliesEntries = fs.existsSync(repliesDir) ? readDirectoryEntries(repliesDir) : undefined;
	if (repliesEntries !== undefined && repliesEntries.length > 0) return false;

	if (!removeEmptyDirectory(requestsDir)) return false;
	if (repliesEntries !== undefined && !removeEmptyDirectory(repliesDir)) return false;
	if (!removeEmptyDirectory(channelDir)) return false;
	return true;
}

function cleanupStaleEmptySupervisorChannels(nowMs = Date.now()): number {
	let channelEntries: fs.Dirent[];
	try {
		channelEntries = fs.readdirSync(SUPERVISOR_CHANNEL_ROOT, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}

	let removed = 0;
	for (const entry of channelEntries) {
		if (!entry.isDirectory()) continue;
		try {
			if (removeStaleEmptySupervisorChannel(path.join(SUPERVISOR_CHANNEL_ROOT, entry.name), nowMs)) removed++;
		} catch {
			// Cleanup is opportunistic; active writers can race with us and will be picked up by a later pass.
		}
	}
	return removed;
}

function currentContextSessionId(
	state: Pick<SubagentState, "currentSessionId">,
	ctx: ExtensionContext,
): string | undefined {
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId) return sessionId;
	} catch {
		// Fall through to the last known identity.
	}
	return state.currentSessionId ?? undefined;
}

function requestMatchesContext(
	request: SupervisorRequest,
	state: Pick<SubagentState, "currentSessionId">,
	ctx: ExtensionContext,
): boolean {
	const currentSessionId = currentContextSessionId(state, ctx);
	return Boolean(currentSessionId && request.orchestratorSessionId === currentSessionId);
}

function removeRequestFile(file: string): void {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// Request cleanup is best-effort; reply files and timeout errors remain authoritative.
	}
}

type SupervisorRequestLifecycle = "pending" | "expired" | "inactive" | "missing" | "wrong-session";
type BlockingRequestPhase = "pausing" | "paused";
type RequestTerminalState = "continued" | "cancelled" | "completed" | "failed";

function requestExpiresAt(request: SupervisorRequest, now: number): number {
	const expiresAt = (request as { expiresAt?: unknown }).expiresAt;
	if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) return expiresAt;
	return Number.isFinite(request.createdAt) ? request.createdAt + askTimeoutMs() : now;
}

function isAwaitingSupervisorPause(pause: unknown): boolean {
	return Boolean(pause && typeof pause === "object" && (pause as { kind?: unknown }).kind === "awaiting_supervisor");
}

function requestBlockingPhase(
	request: PendingSupervisorRequest,
	state: SubagentState,
): BlockingRequestPhase | undefined {
	if (state.foregroundControls.has(request.runId)) return "pausing";
	const foregroundRun = state.foregroundRuns?.get(request.runId);
	const foregroundChild =
		foregroundRun?.children.find((child) => child.index === request.childIndex && child.agent === request.agent) ??
		foregroundRun?.children[request.childIndex];
	if (foregroundChild && isAwaitingSupervisorPause(foregroundChild.pause)) {
		return foregroundChild.status === "paused" ? "paused" : "pausing";
	}

	const asyncJob = state.asyncJobs.get(request.runId);
	const step = asyncJob?.steps?.[request.childIndex];
	if (step?.pause?.kind === "awaiting_supervisor") {
		if (asyncJob?.status === "paused" && step.status === "paused") return "paused";
		if (asyncJob?.status === "pausing" || step.status === "pausing" || step.status === "paused") return "pausing";
	}
	return undefined;
}

function requestTerminalState(request: SupervisorRequest, state: SubagentState): RequestTerminalState | undefined {
	const foregroundRun = state.foregroundRuns?.get(request.runId);
	const foregroundChild =
		foregroundRun?.children.find((child) => child.index === request.childIndex && child.agent === request.agent) ??
		foregroundRun?.children[request.childIndex];
	if (foregroundChild?.cancel?.cancelledAt) return "cancelled";
	if (foregroundChild?.status === "completed") return "completed";
	if (foregroundChild?.status === "failed") return "failed";

	const asyncJob = state.asyncJobs.get(request.runId);
	const step = asyncJob?.steps?.[request.childIndex];
	if (step?.status === "continued" || asyncJob?.status === "continued") return "continued";
	if (step?.status === "cancelled" || asyncJob?.status === "cancelled") return "cancelled";
	if (step?.status === "failed" || asyncJob?.status === "failed") return "failed";
	if (step?.status === "complete" || step?.status === "completed" || asyncJob?.status === "complete")
		return "completed";
	return undefined;
}

function requestLifecycle(
	request: PendingSupervisorRequest,
	state: SubagentState,
	ctx: ExtensionContext | undefined,
	now: number,
): SupervisorRequestLifecycle {
	if (ctx && !requestMatchesContext(request, state, ctx)) return "wrong-session";
	if (!fs.existsSync(request.requestFile)) return "missing";
	const blockingPhase = requestBlockingPhase(request, state);
	if (request.expectsReply && blockingPhase) return "pending";
	if (request.expectsReply && now > requestExpiresAt(request, now)) return "expired";
	if (request.expectsReply && requestTerminalState(request, state)) return "inactive";
	return "pending";
}

function cleanupRequestLifecycle(request: PendingSupervisorRequest, lifecycle: SupervisorRequestLifecycle): void {
	if (lifecycle === "expired" || lifecycle === "inactive") removeRequestFile(request.requestFile);
}

function refreshPendingRequests(
	pending: Map<string, PendingSupervisorRequest>,
	state: SubagentState,
	ctx: ExtensionContext | undefined,
): void {
	const now = Date.now();
	for (const request of pending.values()) {
		const lifecycle = requestLifecycle(request, state, ctx, now);
		if (lifecycle === "pending") continue;
		pending.delete(request.id);
		cleanupRequestLifecycle(request, lifecycle);
	}
}

function blockingRequestActionLines(request: PendingSupervisorRequest, phase: BlockingRequestPhase): string[] {
	const actionLines = [
		`Resume unchanged: subagent({ action: "resume", id: "${request.runId}", index: ${request.childIndex} })`,
		`Resume with guidance: subagent({ action: "resume", id: "${request.runId}", index: ${request.childIndex}, message: "Supervisor replied: ..." })`,
		`Cancel: subagent({ action: "interrupt", id: "${request.runId}", index: ${request.childIndex} })`,
	];
	if (phase === "paused") return ["No child process is running.", ...actionLines];
	return [
		"Blocking request is entering durable pause; wait until subagent status reports paused.",
		"Once paused, no child process is running. Then use these exact actions:",
		...actionLines.map((line) => `When paused: ${line}`),
	];
}

function formatPendingLine(request: PendingSupervisorRequest, state: SubagentState): string {
	if (!request.expectsReply)
		return `- ${request.id}: ${request.agent} [${request.runId}#${request.childIndex}] ${request.reason}.`;
	const phase = requestBlockingPhase(request, state) ?? "pausing";
	return `- ${request.id}: ${request.agent} [${request.runId}#${request.childIndex}] ${request.reason}. ${blockingRequestActionLines(request, phase).join(" ")}`;
}

function requestVisibleText(request: PendingSupervisorRequest, state: SubagentState): string {
	const lines = [request.message];
	if (request.expectsReply) {
		const phase = requestBlockingPhase(request, state) ?? "pausing";
		lines.push(
			"",
			phase === "paused"
				? `Child ${request.childIndex} is durably paused awaiting supervisor guidance.`
				: `Child ${request.childIndex} has a blocking request entering durable pause.`,
			...blockingRequestActionLines(request, phase),
		);
	}
	return lines.join("\n");
}

function publicPendingRequests(pending: Map<string, PendingSupervisorRequest>): Array<Record<string, unknown>> {
	return [...pending.values()].map((request) => ({
		id: request.id,
		runId: request.runId,
		agent: request.agent,
		childIndex: request.childIndex,
		reason: request.reason,
		expectsReply: request.expectsReply,
	}));
}

function buildParentSupervisorTool(pending: Map<string, PendingSupervisorRequest>, state: SubagentState) {
	return {
		name: NATIVE_SUPERVISOR_TOOL_NAME,
		label: "Subagent Supervisor",
		description:
			"Native pi-subagents supervisor channel. Use pending/status to inspect paused child requests, then resume them with subagent resume or cancel them with interrupt.",
		parameters: IntercomParamsSchema,
		async execute(_id: string, params: unknown) {
			refreshPendingRequests(pending, state, state.lastUiContext ?? undefined);
			const input = params as IntercomParams;
			if (input.action === "status") {
				return {
					content: [{ type: "text", text: `Native supervisor channel active. Pending replies: ${pending.size}.` }],
					details: { active: true, pending: pending.size, root: SUPERVISOR_CHANNEL_ROOT },
				};
			}
			if (input.action === "pending" || input.action === "list") {
				const lines = [...pending.values()]
					.filter((request) => request.expectsReply)
					.map((request) => formatPendingLine(request, state));
				return {
					content: [{ type: "text", text: lines.length ? lines.join("\n") : "No pending supervisor requests." }],
					details: { pending: publicPendingRequests(pending) },
				};
			}
			if (input.action === "send" || input.action === "ask") {
				throw new Error(
					"Native pi-subagents intercom handles pending/status inspection. Child agents initiate asks with contact_supervisor.",
				);
			}
			throw new Error(`Unsupported intercom action: ${input.action}`);
		},
	};
}

export function createNativeSupervisorChannel(
	pi: ExtensionAPI,
	state: SubagentState,
): { start: () => void; dispose: () => void; pending: Map<string, PendingSupervisorRequest> } {
	const pending = new Map<string, PendingSupervisorRequest>();
	const seenFiles = new Set<string>();
	let poller: ReturnType<typeof setInterval> | undefined;
	let lastStaleCleanupAt = 0;
	const registerTool = (
		(pi as unknown as Record<string, unknown>).registerTool as (
			tool: ReturnType<typeof buildParentSupervisorTool>,
		) => void
	).bind(pi);

	const registerParentTools = (): void => {
		if (!hasTool(pi, NATIVE_SUPERVISOR_TOOL_NAME)) registerTool(buildParentSupervisorTool(pending, state));
	};

	const cleanupStaleChannelsIfDue = (): void => {
		const nowMs = Date.now();
		if (nowMs - lastStaleCleanupAt < STALE_EMPTY_CHANNEL_CLEANUP_INTERVAL_MS) return;
		lastStaleCleanupAt = nowMs;
		try {
			cleanupStaleEmptySupervisorChannels(nowMs);
		} catch {
			// Supervisor delivery must not fail because best-effort temp cleanup failed.
		}
	};

	const poll = (): void => {
		cleanupStaleChannelsIfDue();
		const ctx = state.lastUiContext;
		if (!ctx) return;
		refreshPendingRequests(pending, state, ctx);
		const now = Date.now();
		for (const { channelDir, file } of listRequestFiles()) {
			if (seenFiles.has(file)) continue;
			const request = parseRequestFile(file, channelDir);
			if (!request || !requestMatchesContext(request, state, ctx)) continue;
			const lifecycle = requestLifecycle(request, state, undefined, now);
			if (lifecycle !== "pending") {
				seenFiles.add(file);
				cleanupRequestLifecycle(request, lifecycle);
				continue;
			}
			seenFiles.add(file);
			if (request.expectsReply) pending.set(request.id, request);
			else {
				removeRequestFile(request.requestFile);
			}
			pi.sendMessage({
				customType: "subagent_supervisor_request",
				content: requestVisibleText(request, state),
				display: true,
				details: {
					id: request.id,
					reason: request.reason,
					expectsReply: request.expectsReply,
					runId: request.runId,
					agent: request.agent,
					childIndex: request.childIndex,
				},
			});
		}
	};

	return {
		start: () => {
			if (poller) return;
			registerParentTools();
			poll();
			poller = setInterval(poll, CHANNEL_POLL_MS);
			poller.unref?.();
		},
		dispose: () => {
			if (poller) clearInterval(poller);
			poller = undefined;
			pending.clear();
			seenFiles.clear();
		},
		pending,
	};
}
