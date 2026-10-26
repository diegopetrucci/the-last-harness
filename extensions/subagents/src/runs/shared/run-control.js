// Generated from extensions/subagents/src/runs/shared/run-control.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAsyncRunLocation } from "../background/async-resume.js";
import { deliverInterruptRequest, requestAsyncSteer } from "../background/control-channel.js";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.js";
import { resolveSubagentRunId } from "../background/run-id-resolver.js";
import { readStatus } from "../../shared/utils.js";
import { ASYNC_DIR, RESULTS_DIR } from "../../shared/types.js";
import { projectRunAuthorizationError, authorizePersistedProjectAgentRun, embeddedControlRestrictionError, } from "./project-agent-control.js";
import { asyncRunOwnerRejectionMessage, authorizeAsyncRunOwner, } from "../background/async-owner-authorization.js";
import { resolveCurrentSessionId } from "../../shared/session-identity.js";
export { buildResumeModelResolution, resumeAsyncRun } from "../background/async-control-resume.js";
export { cancelPersistedPausedAsyncRun } from "../background/async-cancellation.js";
export { registerForegroundMessageInbox, clearForegroundMessageInbox, } from "./foreground-message-inbox.js";
export function trustedSessionRootsForStatus(ctx, deps) {
    let currentSessionId;
    let parentSessionFile;
    try {
        currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
        parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
    }
    catch {
        return [];
    }
    if (!parentSessionFile)
        return [];
    if (deps.state?.currentSessionId !== currentSessionId)
        return [];
    return [deps.getSubagentSessionRoot(parentSessionFile)];
}
export { readModelRegistrySnapshot, providerFallbackModelsForTarget, resolveSingleRunOutputBaseDir, unknownAgentMessage, } from "./run-support.js";
function isAsyncInterruptFailure(result) {
    return !result.ok;
}
function isAsyncInterruptNotRunning(result) {
    return result.kind === "not_running";
}
export function buildRunStatusParams(params) {
    return {
        action: "status",
        id: params.id,
        dir: params.dir,
        index: params.index,
    };
}
export function buildManagementActionParams(params) {
    return {
        action: params.action,
        agent: params.agent,
        chainName: params.chainName,
        agentScope: params.agentScope,
        config: params.config,
    };
}
const UNSUPPORTED_SAVED_CHAIN_INPUT_MESSAGE = "Saved chains are deliberately unsupported in The Last Harness; existing .chain.md/.chain.json files are left untouched.";
export function unsupportedSavedChainInputResult(params, detail) {
    const text = detail.startsWith("The Last Harness")
        ? detail
        : `${UNSUPPORTED_SAVED_CHAIN_INPUT_MESSAGE} ${detail}`;
    return {
        content: [{ type: "text", text }],
        isError: true,
        details: { mode: params.action ? "management" : getRequestedModeLabel(params), results: [] },
    };
}
export function unsupportedSavedChainInput(params) {
    if (params.chain !== undefined)
        return "Omit 'chain'.";
    if (params.chainName !== undefined)
        return "Omit 'chainName'.";
    if (params.chainDir !== undefined)
        return "Omit 'chainDir'.";
    if (params.clarify !== undefined)
        return "The Last Harness does not support the chain clarify UI; omit 'clarify'.";
    return undefined;
}
export function getRequestedModeLabel(params) {
    if ((params.tasks?.length ?? 0) > 0)
        return "parallel";
    if (params.agent)
        return "single";
    return "single";
}
function getAsyncInterruptTarget(state, runId, location, callerKey) {
    if (location) {
        if (location.asyncDir) {
            return {
                asyncId: location.resolvedId ?? runId ?? path.basename(location.asyncDir),
                asyncDir: location.asyncDir,
            };
        }
        if (runId) {
            const direct = state.asyncJobs.get(runId);
            if (direct)
                return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
        }
        return undefined;
    }
    if (runId) {
        const direct = state.asyncJobs.get(runId);
        if (direct)
            return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
        return undefined;
    }
    let newest;
    for (const job of state.asyncJobs.values()) {
        if (job.status !== "running")
            continue;
        if (authorizeAsyncRunOwner({ callerKey, asyncDir: job.asyncDir, runId: job.asyncId }).outcome !==
            "owned")
            continue;
        if (!newest || (job.updatedAt ?? 0) > newest.updatedAt) {
            newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt: job.updatedAt ?? 0 };
        }
    }
    return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
}
function resolvedAsyncInterruptTarget(target) {
    return {
        kind: "async",
        id: target.asyncId,
        location: {
            asyncDir: target.asyncDir,
            resultPath: null,
            resolvedId: target.asyncId,
        },
    };
}
export function selectInterruptTarget(params, state, callerKey = state.currentSessionId ?? undefined) {
    const requestedId = params.id?.trim();
    if (requestedId) {
        const resolved = resolveSubagentRunId(requestedId, { state, callerKey });
        if (resolved)
            return { target: resolved, params: { ...params, id: resolved.id } };
        const asyncTarget = getAsyncInterruptTarget(state, requestedId);
        if (asyncTarget) {
            const target = resolvedAsyncInterruptTarget(asyncTarget);
            return {
                target,
                params: { ...params, id: target.id, dir: asyncTarget.asyncDir },
            };
        }
        return { target: undefined, params };
    }
    const asyncTarget = getAsyncInterruptTarget(state, undefined, undefined, callerKey);
    if (!asyncTarget)
        return { target: undefined, params };
    const target = resolvedAsyncInterruptTarget(asyncTarget);
    return {
        target,
        params: { ...params, id: target.id, dir: asyncTarget.asyncDir },
    };
}
function requestAsyncInterruptForTarget(state, target, callerKey, kill) {
    const authorizeTarget = () => authorizeAsyncRunOwner({ callerKey, asyncDir: target.asyncDir, runId: target.asyncId });
    const preAuthorization = authorizeTarget();
    if (preAuthorization.outcome !== "owned")
        return { ok: false, kind: "unauthorized", authorization: preAuthorization };
    const status = reconcileAsyncRun(target.asyncDir, { kill }).status;
    if (!status || status.state !== "running" || typeof status.pid !== "number") {
        return { ok: false, kind: "not_running" };
    }
    const deliveryAuthorization = authorizeTarget();
    if (deliveryAuthorization.outcome !== "owned")
        return { ok: false, kind: "unauthorized", authorization: deliveryAuthorization };
    try {
        deliverInterruptRequest({
            asyncDir: target.asyncDir,
            pid: status.pid,
            kill,
            source: "interrupt-action",
        });
        const tracked = state.asyncJobs.get(target.asyncId);
        if (tracked) {
            tracked.activityState = undefined;
            tracked.updatedAt = Date.now();
        }
        return { ok: true };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, kind: "error", error: message };
    }
}
function isNotFoundError(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function discoverDiskOnlyRunningAsyncTargets(callerKey, knownAsyncDirs) {
    const targets = [];
    const errors = [];
    const candidates = [];
    try {
        for (const entry of fs.readdirSync(ASYNC_DIR, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            candidates.push({ asyncDir: path.join(ASYNC_DIR, entry.name), fallbackId: entry.name });
        }
    }
    catch (error) {
        if (!isNotFoundError(error)) {
            return {
                targets,
                errors: [
                    `Failed to list async runs in '${ASYNC_DIR}': ${error instanceof Error ? error.message : String(error)}`,
                ],
            };
        }
    }
    for (const candidate of candidates) {
        if (knownAsyncDirs.has(candidate.asyncDir))
            continue;
        try {
            const authorization = authorizeAsyncRunOwner({
                callerKey,
                asyncDir: candidate.asyncDir,
                runId: candidate.fallbackId,
            });
            if (authorization.outcome !== "owned")
                continue;
        }
        catch {
            continue;
        }
        try {
            const rawStatus = readStatus(candidate.asyncDir);
            if (!rawStatus || rawStatus.state !== "running")
                continue;
            const status = reconcileAsyncRun(candidate.asyncDir).status;
            if (status?.state === "running") {
                targets.push({
                    asyncId: typeof status.runId === "string" && status.runId ? status.runId : candidate.fallbackId,
                    asyncDir: candidate.asyncDir,
                });
            }
        }
        catch (error) {
            errors.push(`Failed to inspect async run ${candidate.fallbackId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { targets, errors };
}
export function requestInterruptAllRunningSubagentRuns(state, callerKey) {
    const result = {
        asyncRunIds: [],
        skippedAsyncRunIds: [],
        errors: [],
    };
    if (typeof callerKey !== "string" || callerKey.length === 0)
        return result;
    const knownAsyncDirs = new Set();
    for (const job of state.asyncJobs.values()) {
        knownAsyncDirs.add(job.asyncDir);
        const interruptResult = requestAsyncInterruptForTarget(state, { asyncId: job.asyncId, asyncDir: job.asyncDir }, callerKey);
        if (!isAsyncInterruptFailure(interruptResult)) {
            result.asyncRunIds.push(job.asyncId);
        }
        else if (interruptResult.kind === "unauthorized") {
            continue;
        }
        else if (interruptResult.kind === "error") {
            result.errors.push(`Failed to interrupt async run ${job.asyncId}: ${interruptResult.error ?? "unknown error"}`);
        }
        else {
            result.skippedAsyncRunIds.push(job.asyncId);
        }
    }
    const diskOnly = discoverDiskOnlyRunningAsyncTargets(callerKey, knownAsyncDirs);
    for (const target of diskOnly.targets) {
        const interruptResult = requestAsyncInterruptForTarget(state, target, callerKey);
        if (!isAsyncInterruptFailure(interruptResult)) {
            result.asyncRunIds.push(target.asyncId);
        }
        else if (interruptResult.kind === "unauthorized") {
            continue;
        }
        else if (interruptResult.kind === "error") {
            result.errors.push(`Failed to interrupt async run ${target.asyncId}: ${interruptResult.error ?? "unknown error"}`);
        }
        else {
            result.skippedAsyncRunIds.push(target.asyncId);
        }
    }
    result.errors.push(...diskOnly.errors);
    return result;
}
export function interruptAsyncRun(state, runId, kill, location, callerKey) {
    const target = getAsyncInterruptTarget(state, runId, location, callerKey);
    if (!target)
        return null;
    const interruptResult = requestAsyncInterruptForTarget(state, target, callerKey, kill);
    if (!isAsyncInterruptFailure(interruptResult)) {
        return {
            content: [{ type: "text", text: `Interrupt requested for async run ${target.asyncId}.` }],
            details: { mode: "management", results: [] },
        };
    }
    return {
        content: [
            {
                type: "text",
                text: interruptResult.kind === "unauthorized"
                    ? asyncRunOwnerRejectionMessage(interruptResult.authorization, target.asyncId, "interrupted")
                    : isAsyncInterruptNotRunning(interruptResult)
                        ? `No running async run with an interrupt-capable pid was found for '${runId ?? "current"}'.`
                        : `Failed to interrupt async run ${target.asyncId}: ${interruptResult.error ?? "unknown error"}`,
            },
        ],
        isError: true,
        details: { mode: "management", results: [] },
    };
}
export function steerAsyncRun(input) {
    if (!input.location.asyncDir) {
        return {
            content: [
                { type: "text", text: `Async run '${input.runId}' has no live run directory to steer.` },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const steerDir = input.location.asyncDir;
    const authorizeTarget = () => authorizeAsyncRunOwner({
        callerKey: input.callerKey,
        asyncDir: steerDir,
        runId: input.runId,
    });
    const steerRejection = (authorization) => ({
        content: [
            {
                type: "text",
                text: asyncRunOwnerRejectionMessage(authorization, input.runId, "steered"),
            },
        ],
        isError: true,
        details: { mode: "management", results: [] },
    });
    const preAuthorization = authorizeTarget();
    if (preAuthorization.outcome !== "owned")
        return steerRejection(preAuthorization);
    const status = reconcileAsyncRun(steerDir, { kill: input.kill }).status;
    if (!status || (status.state !== "running" && status.state !== "queued")) {
        return {
            content: [
                {
                    type: "text",
                    text: `Async run '${input.runId}' is not running or queued and cannot be steered.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const steps = status.steps ?? [];
    if (input.index !== undefined) {
        if (input.index < 0 || input.index >= steps.length) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Async run '${status.runId}' has ${steps.length} children. Index ${input.index} is out of range.`,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        const targetStep = steps[input.index];
        if (targetStep && targetStep.status !== "running" && targetStep.status !== "pending") {
            return {
                content: [
                    {
                        type: "text",
                        text: `Async run '${status.runId}' child ${input.index} is ${targetStep.status} and cannot be steered.`,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
    }
    else {
        const running = steps.filter((step) => step.status === "running");
        if (running.length === 0 && steps.length > 1) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Async run '${status.runId}' has no running child yet. Provide index to steer a queued child.`,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
    }
    const deliveryAuthorization = authorizeTarget();
    if (deliveryAuthorization.outcome !== "owned")
        return steerRejection(deliveryAuthorization);
    requestAsyncSteer(steerDir, {
        message: input.message,
        targetIndex: input.index,
        source: "steer-action",
    });
    const tracked = input.state.asyncJobs.get(status.runId);
    if (tracked)
        tracked.updatedAt = Date.now();
    const childText = input.index !== undefined ? ` child ${input.index}` : " running child";
    return {
        content: [
            {
                type: "text",
                text: `Steering queued for async run ${status.runId}${childText}. Delivery requires a live Pi child session that supports mid-run steering.`,
            },
        ],
        details: { mode: "management", results: [] },
    };
}
export async function authorizeProjectSteerTarget(input) {
    let location;
    try {
        location = resolveAsyncRunLocation(input.params, ASYNC_DIR, RESULTS_DIR, input.deps.state.currentSessionId ?? undefined);
    }
    catch (error) {
        throw projectRunAuthorizationError(error instanceof Error ? error.message : "the persisted control target is invalid.");
    }
    const status = location.asyncDir ? readStatus(location.asyncDir) : null;
    const known = Boolean(location.asyncDir && status && status.runId === location.resolvedId);
    const steps = known ? (status?.steps ?? []) : [];
    const selected = input.params.index !== undefined
        ? steps.slice(input.params.index, input.params.index + 1)
        : steps.length === 1
            ? steps
            : steps.filter((step) => step.status === "running" || step.status === "pending");
    const restriction = await embeddedControlRestrictionError({
        action: "steer",
        targets: selected.map((step) => ({
            runId: status?.runId ?? "",
            agent: step.agent,
            cwd: step.cwd ?? status?.cwd,
            projectAgent: step.projectAgent,
        })),
        ctx: input.ctx,
        deps: input.deps,
    });
    if (restriction)
        throw new Error(restriction);
    if (!known || !status)
        return;
    for (const step of selected) {
        if (!step.agent.startsWith("embedded."))
            continue;
        await authorizePersistedProjectAgentRun({
            target: {
                runId: status.runId,
                agent: step.agent,
                cwd: step.cwd ?? status.cwd,
                projectAgent: step.projectAgent,
            },
            ctx: input.ctx,
            deps: input.deps,
        });
    }
}
export async function authorizeProjectInterruptTarget(input) {
    let location;
    try {
        location = resolveAsyncRunLocation(input.params, ASYNC_DIR, RESULTS_DIR, input.deps.state.currentSessionId ?? undefined);
    }
    catch (error) {
        throw projectRunAuthorizationError(error instanceof Error ? error.message : "the persisted interrupt target is invalid.");
    }
    if (!location.asyncDir)
        return;
    const status = readStatus(location.asyncDir);
    if (!status || status.runId !== location.resolvedId)
        return;
    for (const step of status.steps ?? []) {
        if (!step.agent.startsWith("embedded."))
            continue;
        await authorizePersistedProjectAgentRun({
            target: {
                runId: status.runId,
                agent: step.agent,
                cwd: step.cwd ?? status.cwd,
                projectAgent: step.projectAgent,
            },
            ctx: input.ctx,
            deps: input.deps,
            requireArchitect: false,
        });
    }
}
