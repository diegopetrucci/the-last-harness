import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { discoverAgents } from "../agents/agents.ts";
import { getArtifactsDir } from "../shared/artifacts.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { childMessageAckPath, requestAsyncResume, waitForChildMessageAcceptance, writeChildMessageRequestToDir, type ResumeRequest } from "../runs/background/control-channel.ts";
import { reconcileAsyncRun } from "../runs/background/stale-run-reconciler.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import { claimNestedControlRequest, findNestedRun, nestedControlRequestOwnedBy, NESTED_RUNNER_ACCEPTANCE_TIMEOUT_MS, projectNestedEvents, readNestedControlRequests, resolveNestedAsyncDir, resolveNestedParentAddressFromEnv, resolveNestedRouteFromEnv, writeNestedControlResult, type NestedControlRequestRecord, type NestedRoute } from "../runs/shared/nested-events.ts";
import { SubagentParams } from "./schemas.ts";
import { loadConfig } from "./config.ts";
import { RESULTS_DIR, type Details, type NestedRunSummary, type SubagentState } from "../shared/types.ts";

function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}

function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function createChildSafeState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		subagentInProgress: false,
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
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

function boundedNestedControlResult(request: NestedControlRequestRecord, ok: boolean, message: string) {
	return { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok, message };
}

function resolveLiveTargetIndex(input: {
	requestedIndex?: number;
	eligibleIndexes: number[];
	runId: string;
	label: string;
}) {
	const eligible = [...input.eligibleIndexes].sort((left, right) => left - right);
	if (input.requestedIndex !== undefined) {
		if (eligible.includes(input.requestedIndex)) return { index: input.requestedIndex };
		return { error: `${input.label} ${input.runId} child ${input.requestedIndex} is not live and cannot accept a resume follow-up.` };
	}
	if (eligible.length === 1) return { index: eligible[0]! };
	if (eligible.length > 1) return { error: `${input.label} ${input.runId} has multiple live children (${eligible.join(", ")}); action='resume' requires index.` };
	return { error: `${input.label} ${input.runId} has no live child that can accept a resume follow-up.` };
}

async function routeNestedAsyncResume(route: NestedRoute, request: NestedControlRequestRecord, run: NestedRunSummary, kill: (pid: number, signal?: NodeJS.Signals | 0) => unknown = process.kill) {
	const asyncDir = resolveNestedAsyncDir(route.rootRunId, run);
	if (!asyncDir) return boundedNestedControlResult(request, false, `Nested async run ${run.id} has no valid live run directory to resume.`);
	const status = reconcileAsyncRun(asyncDir, { resultsDir: path.join(RESULTS_DIR, "nested", route.rootRunId) }).status;
	if (!status || status.runId !== run.id || status.state !== "running") return boundedNestedControlResult(request, false, `Nested async run ${run.id} is not running and cannot accept a live resume follow-up.`);
	const resolved = resolveLiveTargetIndex({
		requestedIndex: request.targetIndex,
		eligibleIndexes: (status.steps ?? []).map((step, index) => step.status === "running" ? index : -1).filter((index) => index >= 0),
		runId: run.id,
		label: "Nested async run",
	});
	if (resolved.error) return boundedNestedControlResult(request, false, resolved.error);
	const requestPath = requestAsyncResume(asyncDir, { id: request.requestId, message: request.message!, targetIndex: resolved.index, deliveryDeadlineAt: request.deliveryDeadlineAt, source: "nested-resume" });
	const remainingDeliveryMs = Math.max(0, request.deliveryDeadlineAt - Date.now());
	const acceptance = await waitForChildMessageAcceptance({
		asyncDir,
		requestId: request.requestId,
		timeoutMs: Math.min(NESTED_RUNNER_ACCEPTANCE_TIMEOUT_MS, remainingDeliveryMs),
		isRunnerAlive: () => {
			if (typeof status.pid !== "number" || status.pid <= 0) return false;
			try { kill(status.pid, 0); return true; } catch { return false; }
		},
	});
	if (acceptance.outcome === "acknowledged" && acceptance.acceptance.status === "accepted" && acceptance.acceptance.acceptedIndexes.includes(resolved.index!)) {
		return boundedNestedControlResult(request, true, `Resume follow-up accepted for live nested async run ${run.id} child ${resolved.index} and queued in its native inbox.`);
	}
	try { fs.rmSync(requestPath, { force: true }); } catch { /* Best effort request cleanup after failed acceptance. */ }
	const lateAckPath = childMessageAckPath(asyncDir, request.requestId);
	try { fs.rmSync(lateAckPath, { force: true }); } catch { /* Best effort immediate ack cleanup. */ }
	const lateAckCleanup = setTimeout(() => {
		try { fs.rmSync(lateAckPath, { force: true }); } catch { /* Best effort cleanup for an acknowledgement racing the timeout. */ }
	}, 2_500);
	lateAckCleanup.unref?.();
	const reason = acceptance.outcome === "runner_gone"
		? "the runner disappeared before accepting it"
		: acceptance.outcome === "timeout"
			? "the runner did not acknowledge it before the acceptance timeout"
			: acceptance.acceptance.reason ?? acceptance.acceptance.rejected?.[0]?.reason ?? "the target child rejected it";
	return boundedNestedControlResult(request, false, `Live resume follow-up for nested async run ${run.id} child ${resolved.index} was not accepted: ${reason}.`);
}

export async function routeNestedResumeRequest(route: NestedRoute, state: SubagentState, request: NestedControlRequestRecord) {
	if (!request.message?.trim()) return boundedNestedControlResult(request, false, "Nested resume requires message.");
	const run = findNestedRun(projectNestedEvents(route).children, request.targetRunId);
	if (!run) return boundedNestedControlResult(request, false, `Nested run ${request.targetRunId} is no longer routed by this owner.`);
	if (run.parentRunId !== request.ownerParentRunId || run.parentStepIndex !== request.ownerParentStepIndex) {
		return boundedNestedControlResult(request, false, `Nested run ${run.id} does not belong to the requested fanout owner address.`);
	}
	if (run.ownerState && run.ownerState !== "live") return boundedNestedControlResult(request, false, `Nested run ${run.id} owner is ${run.ownerState} and cannot accept a live resume follow-up.`);
	if (run.asyncDir) return routeNestedAsyncResume(route, request, run);
	const control = state.foregroundControls.get(request.targetRunId);
	if (!control) return boundedNestedControlResult(request, false, `Nested run ${request.targetRunId} is not active in this fanout child.`);
	const inboxes = control.activeMessageInboxes ? [...control.activeMessageInboxes.entries()].sort(([left], [right]) => left - right) : [];
	const resolved = resolveLiveTargetIndex({
		requestedIndex: request.targetIndex,
		eligibleIndexes: inboxes.map(([index]) => index),
		runId: request.targetRunId,
		label: "Nested run",
	});
	if (resolved.error) return boundedNestedControlResult(request, false, resolved.error);
	const inbox = control.activeMessageInboxes?.get(resolved.index!);
	if (!inbox) return boundedNestedControlResult(request, false, `Nested run ${request.targetRunId} child ${resolved.index} is no longer live and cannot accept a resume follow-up.`);
	if (Date.now() >= request.deliveryDeadlineAt) return boundedNestedControlResult(request, false, `Nested resume delivery deadline expired for run ${request.targetRunId}; no follow-up was queued.`);
	const resumeRequest: ResumeRequest = { type: "resume", id: request.requestId, ts: Date.now(), message: request.message.trim(), targetIndex: resolved.index, deliveryDeadlineAt: request.deliveryDeadlineAt, source: "nested-resume" };
	writeChildMessageRequestToDir(inbox, resumeRequest);
	return boundedNestedControlResult(request, true, `Resume follow-up queued for live nested run ${request.targetRunId} child ${resolved.index} in its native inbox.`);
}

function startNestedControlInboxListener(_pi: ExtensionAPI, state: SubagentState): NodeJS.Timeout | undefined {
	let route;
	try {
		route = resolveNestedRouteFromEnv();
	} catch {
		return undefined;
	}
	const owner = resolveNestedParentAddressFromEnv();
	if (!route || !owner) return undefined;
	const claimantId = `${process.pid}-${randomUUID()}`;
	const pending = new Map<string, {
		request: NestedControlRequestRecord & { filePath: string };
		claimPath: string;
		result?: Parameters<typeof writeNestedControlResult>[1];
		inFlight?: boolean;
	}>();
	const processClaim = (claim: (typeof pending extends Map<string, infer T> ? T : never)): void => {
		if (claim.inFlight) return;
		claim.inFlight = true;
		void (async () => {
			const { request } = claim;
			try {
				if (!claim.result) {
					try {
						if (request.action === "interrupt") {
							const control = state.foregroundControls.get(request.targetRunId);
							if (!control) {
								claim.result = boundedNestedControlResult(request, false, `Nested run ${request.targetRunId} is not active in this fanout child.`);
							} else {
								const ok = control.interrupt?.() === true;
								claim.result = boundedNestedControlResult(request, ok, ok
									? `Interrupt requested for nested run ${request.targetRunId}.`
									: `Nested run ${request.targetRunId} has no active child step to interrupt.`);
							}
						} else {
							claim.result = await routeNestedResumeRequest(route, state, request);
						}
					} catch (error) {
						claim.result = boundedNestedControlResult(request, false, error instanceof Error ? error.message : String(error));
					}
				}
				try {
					writeNestedControlResult(route, claim.result);
				} catch (error) {
					console.error(`Failed to write nested control result for request '${request.requestId}' targeting '${request.targetRunId}' via inbox '${route.controlInbox}'; keeping request for retry:`, error);
					return;
				}
				pending.delete(request.requestId);
				try { fs.unlinkSync(claim.claimPath); } catch {}
			} finally {
				claim.inFlight = false;
			}
		})();
	};
	const timer = setInterval(() => {
		try {
			for (const claim of pending.values()) processClaim(claim);
			for (const request of readNestedControlRequests(route)) {
				if (!nestedControlRequestOwnedBy(request, owner) || pending.has(request.requestId)) continue;
				const claimPath = claimNestedControlRequest(route, request, claimantId);
				if (!claimPath) continue;
				const claim = { request, claimPath };
				pending.set(request.requestId, claim);
				processClaim(claim);
			}
		} catch (error) {
			console.error(`Failed to poll nested control inbox '${route.controlInbox}' for root '${route.rootRunId}':`, error);
		}
	}, 200);
	timer.unref?.();
	return timer;
}

export default function registerFanoutChildSubagentExtension(pi: ExtensionAPI): void {
	if (process.env[SUBAGENT_CHILD_ENV] !== "1" || process.env[SUBAGENT_FANOUT_CHILD_ENV] !== "1") return;

	const globalStore = globalThis as Record<string, unknown>;
	const registeredKey = "__piSubagentFanoutChildRegisteredApis";
	const registeredApis = globalStore[registeredKey] instanceof WeakSet
		? globalStore[registeredKey] as WeakSet<ExtensionAPI>
		: new WeakSet<ExtensionAPI>();
	globalStore[registeredKey] = registeredApis;
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);

	const config = loadConfig();
	const state = createChildSafeState();
	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		asyncByDefault: config.asyncByDefault === true,
		tempArtifactsDir: getArtifactsDir(null),
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents,
		allowMutatingManagementActions: false,
	});

	const parameters: TSchema = SubagentParams;
	const tool = {
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate to subagents from child-safe fanout mode using the TLH minimal contract.",
			"Execution supports SINGLE { agent, task? } and PARALLEL { tasks:[...] } with the same schema fields as the parent tool.",
			"Allowed actions: list, get, models, status, interrupt, resume, steer, doctor.",
			"Ordinary child subagents are not orchestrators; only explicit fanout children may use this tool.",
		].join("\n"),
		parameters,
		execute(id, params, signal, onUpdate, ctx) {
			return executor.execute(id, params as SubagentParamsLike, signal, onUpdate, ctx);
		},
	};
	const registerTool = (((pi as unknown as Record<string, unknown>).registerTool) as (tool: {
		name: string;
		label: string;
		description: string;
		parameters: TSchema;
		execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
	}) => void).bind(pi);
	registerTool(tool);
	startNestedControlInboxListener(pi, state);
}
