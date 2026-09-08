import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeProjectAgentRunCapture, projectAgentRunCaptureEquals, } from "../../agents/project-agent-snapshot.js";
import { resolveAsyncRunLocation } from "../background/async-resume.js";
import { deliverInterruptRequest, requestAsyncSteer } from "../background/control-channel.js";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.js";
import { resolveSubagentRunId } from "../background/run-id-resolver.js";
import { formatControlNoticeMessage, shouldNotifyControlEvent, } from "../shared/subagent-control.js";
import { readStatus } from "../../shared/utils.js";
import { ASYNC_DIR, RESULTS_DIR, SUBAGENT_CONTROL_EVENT, } from "../../shared/types.js";
import { hasProjectAgentControlMarker, isRecordValue, projectRunAuthorizationError, authorizePersistedProjectAgentRun, } from "./project-agent-control.js";
import { NESTED_ASYNC_RUNS_DIR } from "./foreground-nested-control.js";
import { getForegroundControl } from "./foreground-run-state.js";
export { getForegroundControl, foregroundStatusResult, trustedSessionRootsForStatus, trimRememberedForegroundRuns, rememberForegroundRun, updateRememberedForegroundChild, resolveRememberedForegroundRun, cancelPersistedPausedForegroundRun, } from "./foreground-run-state.js";
export { registerForegroundMessageInbox, clearForegroundMessageInbox, interruptNestedRun, steerNestedRun, } from "./foreground-nested-control.js";
export { buildResumeModelResolution, enrichPersistedPausedForegroundSingleRun, recoverFailedPausedForegroundTransition, resumeAsyncRun, } from "./foreground-resume.js";
export { readModelRegistrySnapshot, providerFallbackModelsForTarget, resolveSingleRunOutputBaseDir, unknownAgentMessage, } from "./foreground-support.js";
function isAsyncInterruptFailure(result) {
    return !result.ok;
}
function isAsyncInterruptNotRunning(result) {
    return "kind" in result && result.kind === "not_running";
}
export function buildRunStatusParams(params) {
    return {
        action: "status",
        id: params.id,
        dir: params.dir,
        index: params.index,
        view: params.view,
        lines: params.lines,
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
export function getAsyncInterruptTarget(state, runId, location) {
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
        if (!newest || (job.updatedAt ?? 0) > newest.updatedAt) {
            newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt: job.updatedAt ?? 0 };
        }
    }
    return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
}
export function resolvedAsyncInterruptTarget(target) {
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
export function selectInterruptTarget(params, state) {
    const requestedId = params.id?.trim();
    if (params.dir) {
        const location = resolveAsyncRunLocation(params, ASYNC_DIR, RESULTS_DIR);
        const runId = location.resolvedId ?? path.basename(path.resolve(params.dir));
        if (!runId)
            return { target: undefined, params };
        return {
            target: { kind: "async", id: runId, location },
            params: { ...params, id: runId },
        };
    }
    if (requestedId) {
        const resolved = resolveSubagentRunId(requestedId, { state });
        if (resolved)
            return { target: resolved, params: { ...params, id: resolved.id } };
        const foreground = getForegroundControl(state, requestedId);
        if (foreground) {
            const target = { kind: "foreground", id: foreground.runId };
            return { target, params: { ...params, id: target.id } };
        }
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
    const foreground = getForegroundControl(state, undefined);
    if (foreground) {
        const target = { kind: "foreground", id: foreground.runId };
        return { target, params: { ...params, id: target.id } };
    }
    const asyncTarget = getAsyncInterruptTarget(state, undefined);
    if (!asyncTarget)
        return { target: undefined, params };
    const target = resolvedAsyncInterruptTarget(asyncTarget);
    return {
        target,
        params: { ...params, id: target.id, dir: asyncTarget.asyncDir },
    };
}
export function requestForegroundInterrupt(control) {
    if (!control?.interrupt)
        return false;
    const interrupted = control.interrupt();
    if (interrupted) {
        control.updatedAt = Date.now();
        control.currentActivityState = undefined;
    }
    return interrupted;
}
function resolveAsyncResultsDir(asyncDir) {
    const relative = path.relative(NESTED_ASYNC_RUNS_DIR, path.resolve(asyncDir));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        return undefined;
    const [rootRunId, runId] = relative.split(path.sep).filter(Boolean);
    if (!rootRunId || !runId)
        return undefined;
    return path.join(RESULTS_DIR, "nested", rootRunId);
}
function requestAsyncInterruptForTarget(state, target, kill) {
    const resultsDir = resolveAsyncResultsDir(target.asyncDir);
    const status = reconcileAsyncRun(target.asyncDir, resultsDir ? { kill, resultsDir } : { kill }).status;
    if (!status || status.state !== "running" || typeof status.pid !== "number") {
        return { ok: false, kind: "not_running" };
    }
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
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT");
}
function normalizeComparableCwd(cwd) {
    const resolved = path.resolve(cwd);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function diskOnlyAsyncStatusBelongsElsewhere(state, status) {
    if (state.currentSessionId && status.sessionId)
        return state.currentSessionId !== status.sessionId;
    if (state.baseCwd &&
        status.cwd &&
        normalizeComparableCwd(state.baseCwd) !== normalizeComparableCwd(status.cwd))
        return true;
    return false;
}
function discoverDiskOnlyRunningAsyncTargets(state, knownAsyncDirs) {
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
    try {
        for (const rootEntry of fs.readdirSync(NESTED_ASYNC_RUNS_DIR, { withFileTypes: true })) {
            if (!rootEntry.isDirectory())
                continue;
            const rootDir = path.join(NESTED_ASYNC_RUNS_DIR, rootEntry.name);
            try {
                for (const runEntry of fs.readdirSync(rootDir, { withFileTypes: true })) {
                    if (!runEntry.isDirectory())
                        continue;
                    candidates.push({
                        asyncDir: path.join(rootDir, runEntry.name),
                        fallbackId: runEntry.name,
                    });
                }
            }
            catch (error) {
                if (isNotFoundError(error))
                    continue;
                errors.push(`Failed to list nested async runs in '${rootDir}': ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    catch (error) {
        if (!isNotFoundError(error)) {
            errors.push(`Failed to list nested async runs in '${NESTED_ASYNC_RUNS_DIR}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    for (const candidate of candidates) {
        if (knownAsyncDirs.has(candidate.asyncDir))
            continue;
        try {
            const rawStatus = readStatus(candidate.asyncDir);
            if (!rawStatus ||
                rawStatus.state !== "running" ||
                diskOnlyAsyncStatusBelongsElsewhere(state, rawStatus))
                continue;
            const resultsDir = resolveAsyncResultsDir(candidate.asyncDir);
            const status = reconcileAsyncRun(candidate.asyncDir, resultsDir ? { resultsDir } : {}).status;
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
export function requestInterruptAllRunningSubagentRuns(state) {
    const result = {
        foregroundRunIds: [],
        asyncRunIds: [],
        skippedForegroundRunIds: [],
        skippedAsyncRunIds: [],
        errors: [],
    };
    for (const control of state.foregroundControls.values()) {
        if (requestForegroundInterrupt(control))
            result.foregroundRunIds.push(control.runId);
        else
            result.skippedForegroundRunIds.push(control.runId);
    }
    const knownAsyncDirs = new Set();
    for (const job of state.asyncJobs.values()) {
        knownAsyncDirs.add(job.asyncDir);
        const interruptResult = requestAsyncInterruptForTarget(state, {
            asyncId: job.asyncId,
            asyncDir: job.asyncDir,
        });
        if (!isAsyncInterruptFailure(interruptResult)) {
            result.asyncRunIds.push(job.asyncId);
        }
        else if (interruptResult.kind === "error") {
            result.errors.push(`Failed to interrupt async run ${job.asyncId}: ${interruptResult.error ?? "unknown error"}`);
        }
        else {
            result.skippedAsyncRunIds.push(job.asyncId);
        }
    }
    const diskOnly = discoverDiskOnlyRunningAsyncTargets(state, knownAsyncDirs);
    for (const target of diskOnly.targets) {
        const interruptResult = requestAsyncInterruptForTarget(state, target);
        if (!isAsyncInterruptFailure(interruptResult)) {
            result.asyncRunIds.push(target.asyncId);
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
export function emitControlNotification(input) {
    if (!shouldNotifyControlEvent(input.controlConfig, input.event))
        return;
    if (!input.controlConfig.notifyChannels.includes("event"))
        return;
    input.pi.events.emit(SUBAGENT_CONTROL_EVENT, {
        event: input.event,
        source: "foreground",
        noticeText: formatControlNoticeMessage(input.event),
    });
}
export function interruptAsyncRun(state, runId, kill, location) {
    const target = getAsyncInterruptTarget(state, runId, location);
    if (!target)
        return null;
    const interruptResult = requestAsyncInterruptForTarget(state, target, kill);
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
                text: isAsyncInterruptNotRunning(interruptResult)
                    ? `No running async run with an interrupt-capable pid was found for '${runId ?? "current"}'.`
                    : `Failed to interrupt async run ${target.asyncId}: ${interruptResult.error ?? "unknown error"}`,
            },
        ],
        isError: true,
        details: { mode: "management", results: [] },
    };
}
function asyncControlOwnedByCurrentSession(state, status) {
    return (typeof state.currentSessionId === "string" &&
        state.currentSessionId.length > 0 &&
        typeof status.sessionId === "string" &&
        status.sessionId === state.currentSessionId);
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
    const status = reconcileAsyncRun(input.location.asyncDir, { kill: input.kill }).status;
    if (input.projectLookup.status === "missing" && hasProjectAgentControlMarker(status)) {
        return {
            content: [
                {
                    type: "text",
                    text: projectRunAuthorizationError("the persisted run carries a project-agent marker, but its process-private reference is unavailable; refusing ordinary control fallback.").message,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
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
    if (!asyncControlOwnedByCurrentSession(input.state, status)) {
        return {
            content: [
                {
                    type: "text",
                    text: `Async run '${status.runId}' is owned by another session and cannot be steered from this session.`,
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
    requestAsyncSteer(input.location.asyncDir, {
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
    if (input.lookup.status === "missing")
        return;
    if (input.lookup.status === "ambiguous") {
        throw projectRunAuthorizationError(`the requested run id is ambiguous in the retained project-agent registry (${input.lookup.runIds.join(", ")}). Provide a full run id.`);
    }
    const runId = input.lookup.runId;
    let location;
    try {
        location = resolveAsyncRunLocation({ id: runId, dir: input.params.dir, index: input.params.index }, ASYNC_DIR, RESULTS_DIR);
    }
    catch (error) {
        throw projectRunAuthorizationError(error instanceof Error ? error.message : "the persisted control target is invalid.");
    }
    if (!location.asyncDir) {
        throw projectRunAuthorizationError("the retained run has no live async control directory.");
    }
    const status = readStatus(location.asyncDir);
    if (!status)
        throw projectRunAuthorizationError("the persisted control status is unavailable.");
    if (status.runId !== runId) {
        throw projectRunAuthorizationError("the persisted control status does not match the retained run.");
    }
    const candidateSteps = status.steps ?? [];
    if (candidateSteps.length === 0) {
        throw projectRunAuthorizationError("the persisted run has no selectable child steps.");
    }
    let candidates;
    if (input.params.index !== undefined) {
        if (!Number.isInteger(input.params.index) ||
            input.params.index < 0 ||
            input.params.index >= candidateSteps.length) {
            throw projectRunAuthorizationError(`the selected child index ${input.params.index} is out of range for the retained run.`);
        }
        candidates = [candidateSteps[input.params.index]];
    }
    else if (candidateSteps.length === 1) {
        candidates = [candidateSteps[0]];
    }
    else {
        candidates = candidateSteps.filter((step) => step.status === "running" || step.status === "pending");
        if (candidates.length === 0) {
            throw projectRunAuthorizationError("the retained run has no running or pending child selected for steering; refusing ordinary control fallback.");
        }
    }
    for (const candidate of candidates) {
        const retainedCapture = input.lookup.captures.find((capture) => capture.provenance.agent === candidate.agent);
        if (!retainedCapture) {
            throw projectRunAuthorizationError(`the selected child '${candidate.agent}' has no matching retained project-agent capture; ordinary siblings in a mixed run cannot be controlled safely.`);
        }
        const persistedCapture = normalizeProjectAgentRunCapture(candidate.projectAgent);
        if (!persistedCapture || !projectAgentRunCaptureEquals(persistedCapture, retainedCapture)) {
            throw projectRunAuthorizationError(`the selected child '${candidate.agent}' is missing or has corrupt persisted project-agent provenance/config.`);
        }
        await authorizePersistedProjectAgentRun({
            target: {
                runId,
                agent: candidate.agent,
                cwd: status.cwd,
                projectAgent: persistedCapture,
            },
            ctx: input.ctx,
            deps: input.deps,
        });
    }
}
export function projectInterruptResolutionMismatch(lookup, resolvedId) {
    if (lookup.status !== "found" || lookup.runId === resolvedId)
        return undefined;
    return projectRunAuthorizationError(resolvedId
        ? `the retained project-agent run '${lookup.runId}' does not match the resolved interrupt target '${resolvedId}'; refusing cancellation.`
        : "the retained project-agent run could not be resolved to a cancellable target; refusing cancellation.");
}
export function projectInterruptAuthorizationResult(error) {
    return {
        content: [{ type: "text", text: error.message }],
        isError: true,
        details: { mode: "management", results: [] },
    };
}
export async function authorizeProjectInterruptTarget(input) {
    let location;
    try {
        location = resolveAsyncRunLocation(input.lookup.status === "found"
            ? { id: input.lookup.runId, dir: input.params.dir }
            : input.params, ASYNC_DIR, RESULTS_DIR);
    }
    catch (error) {
        throw projectRunAuthorizationError(error instanceof Error ? error.message : "the persisted interrupt target is invalid.");
    }
    let status;
    let statusReadError = false;
    let rawStatusMarker = false;
    if (location.asyncDir) {
        try {
            status = readStatus(location.asyncDir);
        }
        catch {
            statusReadError = true;
            try {
                rawStatusMarker = /["']projectAgents?["']\s*:/u.test(fs.readFileSync(path.join(location.asyncDir, "status.json"), "utf8"));
            }
            catch {
            }
        }
    }
    let result;
    if (!status && location.resultPath) {
        try {
            result = JSON.parse(fs.readFileSync(location.resultPath, "utf8"));
        }
        catch {
            try {
                result = /["']projectAgents?["']\s*:/u.test(fs.readFileSync(location.resultPath, "utf8"))
                    ? { projectAgents: [] }
                    : undefined;
            }
            catch {
                result = undefined;
            }
        }
    }
    if (input.lookup.status === "missing") {
        if (rawStatusMarker ||
            hasProjectAgentControlMarker(status) ||
            hasProjectAgentControlMarker(result)) {
            throw projectRunAuthorizationError("the persisted run carries a project-agent marker, but its process-private reference is unavailable; refusing ordinary interrupt fallback.");
        }
        return;
    }
    if (input.lookup.status === "ambiguous") {
        throw projectRunAuthorizationError(`the requested run id is ambiguous in the retained project-agent registry (${input.lookup.runIds.join(", ")}). Provide a full run id.`);
    }
    if (!location.asyncDir || !status || statusReadError) {
        throw projectRunAuthorizationError("the retained run has no persisted interrupt status.");
    }
    if (status.runId !== input.lookup.runId) {
        throw projectRunAuthorizationError("the persisted interrupt status does not match the retained run.");
    }
    const projectSteps = (status.steps ?? []).filter((step) => step.projectAgent !== undefined);
    const projectMarkers = [
        ...projectSteps.map((step) => ({ agent: step.agent, projectAgent: step.projectAgent })),
        ...(status.projectAgents ?? []).map((projectAgent) => ({
            agent: isRecordValue(projectAgent) &&
                isRecordValue(projectAgent.provenance) &&
                typeof projectAgent.provenance.agent === "string"
                ? projectAgent.provenance.agent
                : undefined,
            projectAgent,
        })),
    ];
    if (projectMarkers.length === 0) {
        if (hasProjectAgentControlMarker(status)) {
            throw projectRunAuthorizationError("the persisted project-agent interrupt marker has no selectable child capture.");
        }
        return;
    }
    for (const marker of projectMarkers) {
        const persistedCapture = normalizeProjectAgentRunCapture(marker.projectAgent);
        if (!persistedCapture) {
            throw projectRunAuthorizationError("the persisted project-agent interrupt capture is invalid.");
        }
        const agent = marker.agent ?? persistedCapture.provenance.agent;
        const retainedCapture = input.lookup.captures.find((capture) => capture.provenance.agent === agent);
        if (!retainedCapture || !projectAgentRunCaptureEquals(persistedCapture, retainedCapture)) {
            throw projectRunAuthorizationError(`the project-agent interrupt child '${agent}' is missing or has corrupt persisted provenance/config.`);
        }
    }
}
