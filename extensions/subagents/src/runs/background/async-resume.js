import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, RESULTS_DIR, } from "../../shared/types.js";
import { lifecycleContinuationForIndex, recoverStaleLifecycleContinuationClaim, } from "../shared/lifecycle-state.js";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.js";
import { deliverInterruptRequest } from "./control-channel.js";
import { reconcileAsyncRun } from "./stale-run-reconciler.js";
import { normalizeTkTicketMetadata } from "../shared/tk-ticket.js";
import { canonicalSubagentModelIdentity, sanitizeSubagentModelIdentity, sanitizeSubagentModelResolution, } from "../shared/model-fallback.js";
import { parseContextPressureCrossedThresholds, parseContextPressureProjection, parseContextUsageDiagnostics, parseSubagentTerminationReason, } from "../../shared/context-diagnostics.js";
import { parseThinkingLevel } from "../../shared/model-info.js";
import { readStatus } from "../../shared/utils.js";
export const ASYNC_RESUME_INTERRUPT_SIGNAL = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";
function isStringArray(x) {
    return Array.isArray(x) && x.every((el) => typeof el === "string");
}
function isWellFormedResolvedAcceptance(x) {
    if (typeof x !== "object" || x === null || Array.isArray(x))
        return false;
    const c = x;
    return (typeof c.level === "string" &&
        typeof c.explicit === "boolean" &&
        isStringArray(c.inferredReason) &&
        isStringArray(c.evidence) &&
        isStringArray(c.stopRules) &&
        Array.isArray(c.criteria) &&
        c.criteria.every((el) => typeof el === "object" &&
            el !== null &&
            !Array.isArray(el) &&
            typeof el.id === "string") &&
        Array.isArray(c.verify) &&
        c.verify.every((el) => typeof el === "object" &&
            el !== null &&
            !Array.isArray(el) &&
            typeof el.command === "string"));
}
function resolvePausedContinuationAcceptance(runId, acceptance) {
    if (typeof acceptance !== "object" || acceptance === null || Array.isArray(acceptance)) {
        throw new Error(`Async run '${runId}' is paused but its persisted acceptance ledger is incomplete or malformed; refusing to resume with an unverified acceptance contract.`);
    }
    const ledger = acceptance;
    if (!isWellFormedResolvedAcceptance(ledger.effectiveAcceptance)) {
        throw new Error(`Async run '${runId}' is paused but its persisted acceptance ledger is incomplete or malformed; refusing to resume with an unverified acceptance contract.`);
    }
    if (ledger.status === "skipped") {
        if (ledger.effectiveAcceptance.level === "none") {
            throw new Error(`Async run '${runId}' is paused but its persisted acceptance ledger is incompatible with continuation resume: status 'skipped' cannot carry effective level 'none'.`);
        }
        return ledger.effectiveAcceptance;
    }
    if (ledger.status === "not-required") {
        if (ledger.effectiveAcceptance.level !== "none") {
            throw new Error(`Async run '${runId}' is paused but its persisted acceptance ledger is incompatible with continuation resume: status 'not-required' must carry effective level 'none'.`);
        }
        return undefined;
    }
    const persistedStatus = typeof ledger.status === "string" ? ledger.status : "unknown";
    throw new Error(`Async run '${runId}' is paused but its persisted acceptance ledger status '${persistedStatus}' is incompatible with continuation resume; expected 'skipped' or 'not-required'.`);
}
export function interruptLiveAsyncResumeTarget(input) {
    const asyncId = input.target.runId;
    if (!input.target.asyncDir) {
        return {
            ok: false,
            message: `Async run ${asyncId} is live but does not have an async directory to interrupt.`,
        };
    }
    const status = reconcileAsyncRun(input.target.asyncDir, {
        resultsDir: input.resultsDir,
        kill: input.kill,
        now: input.now,
    }).status;
    if (!status || status.state !== "running" || typeof status.pid !== "number") {
        return {
            ok: false,
            message: `Async run ${asyncId} is live but no interrupt-capable runner pid was found.`,
        };
    }
    try {
        deliverInterruptRequest({
            asyncDir: input.target.asyncDir,
            pid: status.pid,
            kill: input.kill,
            signal: ASYNC_RESUME_INTERRUPT_SIGNAL,
            now: input.now,
            source: "async-resume",
        });
        const tracked = input.state?.asyncJobs.get(asyncId);
        if (tracked) {
            tracked.activityState = undefined;
            tracked.updatedAt = input.now?.() ?? Date.now();
        }
        return { ok: true, asyncId };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, message: `Failed to interrupt async run ${asyncId}: ${message}` };
    }
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function ensureObject(value, source) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Async result file '${source}' must contain a JSON object.`);
    }
    return value;
}
function validateOptionalString(value, field, source, displayField = field) {
    const fieldValue = value[field];
    if (fieldValue === undefined)
        return undefined;
    if (typeof fieldValue !== "string")
        throw new Error(`Invalid async result file '${source}': ${displayField} must be a string.`);
    return fieldValue;
}
function validateModelIdentity(value, source, field) {
    if (value === undefined)
        return undefined;
    const identity = sanitizeSubagentModelIdentity(value);
    if (!identity) {
        throw new Error(`Invalid async result file '${source}': ${field} must contain a provider and model.`);
    }
    return identity;
}
function validateModelResolution(value, source, field) {
    if (value === undefined)
        return undefined;
    const resolution = sanitizeSubagentModelResolution(value);
    if (!resolution) {
        throw new Error(`Invalid async result file '${source}': ${field} is invalid.`);
    }
    return resolution;
}
function parseResultModelIdentity(value, source, field) {
    try {
        return validateModelIdentity(value, source, field);
    }
    catch {
        return undefined;
    }
}
function parseResultModelResolution(value, source, field) {
    try {
        return validateModelResolution(value, source, field);
    }
    catch {
        return undefined;
    }
}
function validateResultFile(value, resultPath) {
    const data = ensureObject(value, resultPath);
    const resultsValue = data.results;
    let results;
    if (resultsValue !== undefined) {
        if (!Array.isArray(resultsValue))
            throw new Error(`Invalid async result file '${resultPath}': results must be an array.`);
        results = resultsValue.map((entry, index) => {
            const child = ensureObject(entry, `${resultPath} results[${index}]`);
            const agent = validateOptionalString(child, "agent", resultPath, `results[${index}].agent`);
            const sessionFile = validateOptionalString(child, "sessionFile", resultPath, `results[${index}].sessionFile`);
            const intercomTarget = validateOptionalString(child, "intercomTarget", resultPath, `results[${index}].intercomTarget`);
            const model = validateOptionalString(child, "model", resultPath, `results[${index}].model`);
            const thinking = parseThinkingLevel(child.thinking);
            const modelIdentity = parseResultModelIdentity(child.modelIdentity, resultPath, `results[${index}].modelIdentity`);
            const modelResolution = parseResultModelResolution(child.modelResolution, resultPath, `results[${index}].modelResolution`);
            const contextUsage = parseContextUsageDiagnostics(child.contextUsage);
            const contextPressure = parseContextPressureProjection(child.contextPressure);
            const contextPressureCrossedThresholds = parseContextPressureCrossedThresholds(child.contextPressureCrossedThresholds);
            const terminationReason = parseSubagentTerminationReason(child.terminationReason);
            const success = child.success;
            if (success !== undefined && typeof success !== "boolean")
                throw new Error(`Invalid async result file '${resultPath}': results[${index}].success must be a boolean.`);
            const interrupted = child.interrupted;
            if (interrupted !== undefined && typeof interrupted !== "boolean")
                throw new Error(`Invalid async result file '${resultPath}': results[${index}].interrupted must be a boolean.`);
            const activeRuntimeMs = child.activeRuntimeMs;
            if (activeRuntimeMs !== undefined &&
                (typeof activeRuntimeMs !== "number" ||
                    !Number.isFinite(activeRuntimeMs) ||
                    activeRuntimeMs < 0)) {
                throw new Error(`Invalid async result file '${resultPath}': results[${index}].activeRuntimeMs must be a non-negative finite number.`);
            }
            const acceptance = child.acceptance !== undefined &&
                typeof child.acceptance === "object" &&
                !Array.isArray(child.acceptance)
                ? child.acceptance
                : undefined;
            return {
                agent,
                sessionFile,
                intercomTarget,
                ...(typeof success === "boolean" ? { success } : {}),
                ...(typeof interrupted === "boolean" ? { interrupted } : {}),
                ...(model ? { model } : {}),
                ...(thinking ? { thinking } : {}),
                ...(modelIdentity ? { modelIdentity } : {}),
                ...(modelResolution ? { modelResolution } : {}),
                ...(contextUsage ? { contextUsage } : {}),
                ...(contextPressure ? { contextPressure } : {}),
                ...(contextPressureCrossedThresholds ? { contextPressureCrossedThresholds } : {}),
                ...(terminationReason ? { terminationReason } : {}),
                ...(typeof activeRuntimeMs === "number" ? { activeRuntimeMs } : {}),
                ...(acceptance ? { acceptance } : {}),
            };
        });
    }
    const success = data.success;
    if (success !== undefined && typeof success !== "boolean")
        throw new Error(`Invalid async result file '${resultPath}': success must be a boolean.`);
    return {
        id: validateOptionalString(data, "id", resultPath),
        runId: validateOptionalString(data, "runId", resultPath),
        agent: validateOptionalString(data, "agent", resultPath),
        mode: validateOptionalString(data, "mode", resultPath),
        state: validateOptionalString(data, "state", resultPath),
        cwd: validateOptionalString(data, "cwd", resultPath),
        sessionFile: validateOptionalString(data, "sessionFile", resultPath),
        model: validateOptionalString(data, "model", resultPath),
        thinking: parseThinkingLevel(data.thinking),
        modelIdentity: parseResultModelIdentity(data.modelIdentity, resultPath, "modelIdentity"),
        modelResolution: parseResultModelResolution(data.modelResolution, resultPath, "modelResolution"),
        ...(parseContextUsageDiagnostics(data.contextUsage)
            ? { contextUsage: parseContextUsageDiagnostics(data.contextUsage) }
            : {}),
        ...(parseContextPressureProjection(data.contextPressure)
            ? { contextPressure: parseContextPressureProjection(data.contextPressure) }
            : {}),
        ...(parseContextPressureCrossedThresholds(data.contextPressureCrossedThresholds)
            ? {
                contextPressureCrossedThresholds: parseContextPressureCrossedThresholds(data.contextPressureCrossedThresholds),
            }
            : {}),
        ...(typeof success === "boolean" ? { success } : {}),
        ...(results ? { results } : {}),
    };
}
function readResultFile(resultPath) {
    let raw;
    try {
        raw = fs.readFileSync(resultPath, "utf-8");
    }
    catch (error) {
        throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
            cause: error,
        });
    }
    try {
        return validateResultFile(JSON.parse(raw), resultPath);
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`Failed to parse async result file '${resultPath}': ${getErrorMessage(error)}`, {
                cause: error,
            });
        }
        throw error;
    }
}
function assertRunId(value, field) {
    if (value === undefined)
        return undefined;
    if (value.trim() === "")
        throw new Error(`${field} must not be empty.`);
    if (path.isAbsolute(value) || /[\\/]/.test(value) || value.includes("..")) {
        throw new Error(`${field} must be an async run id or prefix, not a path.`);
    }
    return value;
}
function assertInsideRoot(root, target, label) {
    const rootPath = path.resolve(root);
    const targetPath = path.resolve(target);
    const relative = path.relative(rootPath, targetPath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))
        return;
    throw new Error(`${label} must be inside ${rootPath}.`);
}
function prefixedRunIds(dir, prefix, suffix = "") {
    if (!fs.existsSync(dir))
        return [];
    return fs
        .readdirSync(dir)
        .filter((entry) => entry.startsWith(prefix) && (!suffix || entry.endsWith(suffix)))
        .map((entry) => (suffix ? entry.slice(0, -suffix.length) : entry))
        .sort();
}
function exactResultPath(resultsDir, runId) {
    const resultPath = path.join(resultsDir, `${runId}.json`);
    assertInsideRoot(resultsDir, resultPath, "Async result file");
    return fs.existsSync(resultPath) ? resultPath : null;
}
export function findAsyncRunPrefixMatches(prefix, asyncDirRoot, resultsDir) {
    const requestedId = assertRunId(prefix, "id");
    if (!requestedId)
        return [];
    const asyncRoot = path.resolve(asyncDirRoot);
    const resultRoot = path.resolve(resultsDir);
    const matchingIds = [
        ...new Set([
            ...prefixedRunIds(asyncRoot, requestedId),
            ...prefixedRunIds(resultRoot, requestedId, ".json"),
        ]),
    ].sort();
    return matchingIds.map((id) => {
        const asyncDir = path.join(asyncRoot, id);
        assertInsideRoot(asyncRoot, asyncDir, "Async run directory");
        return {
            id,
            location: {
                asyncDir: fs.existsSync(asyncDir) ? asyncDir : null,
                resultPath: exactResultPath(resultRoot, id),
                resolvedId: id,
            },
        };
    });
}
export function resolveAsyncRunLocation(params, asyncDirRoot, resultsDir) {
    const asyncRoot = path.resolve(asyncDirRoot);
    const resultRoot = path.resolve(resultsDir);
    const requestedId = assertRunId(params.id, "id");
    if (params.dir) {
        const asyncDir = path.resolve(params.dir);
        assertInsideRoot(asyncRoot, asyncDir, "Async run directory");
        const resolvedId = requestedId ?? path.basename(asyncDir);
        if (requestedId && requestedId !== path.basename(asyncDir)) {
            throw new Error(`Async run id '${requestedId}' does not match directory '${path.basename(asyncDir)}'.`);
        }
        return { asyncDir, resultPath: exactResultPath(resultRoot, resolvedId), resolvedId };
    }
    if (!requestedId)
        return { asyncDir: null, resultPath: null };
    const directAsyncDir = path.join(asyncRoot, requestedId);
    assertInsideRoot(asyncRoot, directAsyncDir, "Async run directory");
    const directResultPath = exactResultPath(resultRoot, requestedId);
    if (fs.existsSync(directAsyncDir) || directResultPath) {
        return {
            asyncDir: fs.existsSync(directAsyncDir) ? directAsyncDir : null,
            resultPath: directResultPath,
            resolvedId: requestedId,
        };
    }
    const matching = findAsyncRunPrefixMatches(requestedId, asyncRoot, resultRoot);
    if (matching.length === 0)
        return { asyncDir: null, resultPath: null, resolvedId: requestedId };
    if (matching.length > 1) {
        throw new Error(`Ambiguous async run id prefix '${requestedId}' matched: ${matching.map((match) => match.id).join(", ")}. Provide a longer id.`);
    }
    return matching[0].location;
}
function persistedModelIdentity(input) {
    return (sanitizeSubagentModelIdentity(input.identity) ??
        canonicalSubagentModelIdentity(input.model, parseThinkingLevel(input.thinking)));
}
function resultState(result) {
    if (result.state === "complete" ||
        result.state === "failed" ||
        result.state === "paused" ||
        result.state === "cancelled" ||
        result.state === "continued" ||
        result.state === "running" ||
        result.state === "queued" ||
        result.state === "pausing") {
        return result.state;
    }
    return result.success ? "complete" : "failed";
}
function validateStatusForResume(status, source) {
    if (!status)
        return;
    if (typeof status.runId !== "string")
        throw new Error(`Invalid async status '${source}': runId must be a string.`);
    if (status.sessionId !== undefined && typeof status.sessionId !== "string")
        throw new Error(`Invalid async status '${source}': sessionId must be a string.`);
    if (status.cwd !== undefined && typeof status.cwd !== "string")
        throw new Error(`Invalid async status '${source}': cwd must be a string.`);
    if (status.sessionFile !== undefined && typeof status.sessionFile !== "string")
        throw new Error(`Invalid async status '${source}': sessionFile must be a string.`);
    if (status.steps !== undefined) {
        if (!Array.isArray(status.steps))
            throw new Error(`Invalid async status '${source}': steps must be an array.`);
        status.steps.forEach((step, index) => {
            if (!step || typeof step !== "object" || Array.isArray(step))
                throw new Error(`Invalid async status '${source}': steps[${index}] must be an object.`);
            if (typeof step.agent !== "string")
                throw new Error(`Invalid async status '${source}': steps[${index}].agent must be a string.`);
            if (step.sessionFile !== undefined && typeof step.sessionFile !== "string")
                throw new Error(`Invalid async status '${source}': steps[${index}].sessionFile must be a string.`);
            if (step.model !== undefined && typeof step.model !== "string")
                throw new Error(`Invalid async status '${source}': steps[${index}].model must be a string.`);
            if (step.thinking !== undefined && typeof step.thinking !== "string")
                throw new Error(`Invalid async status '${source}': steps[${index}].thinking must be a string.`);
            validateModelIdentity(step.modelIdentity, source, `steps[${index}].modelIdentity`);
            validateModelResolution(step.modelResolution, source, `steps[${index}].modelResolution`);
            if (step.contextUsage !== undefined && !parseContextUsageDiagnostics(step.contextUsage))
                throw new Error(`Invalid async status '${source}': steps[${index}].contextUsage is invalid.`);
            if (step.contextPressure !== undefined &&
                !parseContextPressureProjection(step.contextPressure))
                throw new Error(`Invalid async status '${source}': steps[${index}].contextPressure is invalid.`);
            if (step.contextPressureCrossedThresholds !== undefined &&
                !parseContextPressureCrossedThresholds(step.contextPressureCrossedThresholds))
                throw new Error(`Invalid async status '${source}': steps[${index}].contextPressureCrossedThresholds is invalid.`);
            if (step.terminationReason !== undefined &&
                !parseSubagentTerminationReason(step.terminationReason))
                throw new Error(`Invalid async status '${source}': steps[${index}].terminationReason is invalid.`);
        });
    }
}
function validateResumeSessionFile(runId, sessionFile, options = {}) {
    if (path.extname(sessionFile) !== ".jsonl")
        throw new Error(`Async run '${runId}' session file must be a .jsonl file: ${sessionFile}`);
    const resolved = path.resolve(sessionFile);
    if (!fs.existsSync(resolved)) {
        if (options.allowMissing)
            return undefined;
        throw new Error(`Async run '${runId}' session file does not exist: ${sessionFile}`);
    }
    return resolved;
}
export function resolveAsyncResumeTarget(params, deps = {}, options = {}) {
    const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
    const resultsDir = deps.resultsDir ?? RESULTS_DIR;
    const requireSessionFile = options.requireSessionFile ?? true;
    const location = resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
    if (!location.asyncDir && !location.resultPath) {
        throw new Error("Async run not found. Provide id or dir.");
    }
    const reconciliation = location.asyncDir && !options.readOnly
        ? reconcileAsyncRun(location.asyncDir, { resultsDir, kill: deps.kill, now: deps.now })
        : undefined;
    let status = reconciliation?.status ??
        (options.readOnly && location.asyncDir ? readStatus(location.asyncDir) : null);
    validateStatusForResume(status, location.asyncDir ? path.join(location.asyncDir, "status.json") : "status.json");
    const result = location.resultPath ? readResultFile(location.resultPath) : undefined;
    const runId = status?.runId ??
        result?.runId ??
        result?.id ??
        location.resolvedId ??
        (location.asyncDir ? path.basename(location.asyncDir) : "unknown");
    const state = status?.state ?? (result ? resultState(result) : undefined);
    const tkTicket = normalizeTkTicketMetadata(status?.tkTicket);
    if (!state)
        throw new Error(`Status file not found for async run '${runId}'.`);
    if (state === "cancelled")
        throw new Error(`Async run '${runId}' was cancelled and cannot be resumed.`);
    if (state === "pausing")
        throw new Error(`Async run '${runId}' is still pausing and cannot be resumed yet.`);
    let statusSteps = status?.steps ?? [];
    const resultSteps = result?.results ?? [];
    const stepCount = statusSteps.length || resultSteps.length || (result?.agent ? 1 : 0);
    const requestedIndex = params.index;
    if (requestedIndex !== undefined && !Number.isInteger(requestedIndex))
        throw new Error(`Async run '${runId}' index must be an integer.`);
    const terminalStepStatuses = new Set(["complete", "completed", "failed", "paused"]);
    const modelIdentityForStep = (index, step = statusSteps[index]) => {
        const resultStep = resultSteps[index];
        return (persistedModelIdentity({
            identity: step?.modelIdentity,
            model: step?.model,
            thinking: step?.thinking,
        }) ??
            persistedModelIdentity({
                identity: resultStep?.modelIdentity,
                model: resultStep?.model,
                thinking: resultStep?.thinking,
            }) ??
            persistedModelIdentity({
                identity: result?.modelIdentity,
                model: result?.model,
                thinking: result?.thinking,
            }));
    };
    const modelResolutionForStep = (index, step = statusSteps[index]) => sanitizeSubagentModelResolution(step?.modelResolution) ??
        sanitizeSubagentModelResolution(resultSteps[index]?.modelResolution) ??
        sanitizeSubagentModelResolution(result?.modelResolution);
    const contextUsageForStep = (index, step = statusSteps[index]) => parseContextUsageDiagnostics(step?.contextUsage) ??
        parseContextUsageDiagnostics(resultSteps[index]?.contextUsage) ??
        parseContextUsageDiagnostics(result?.contextUsage);
    const contextPressureForStep = (index, step = statusSteps[index]) => parseContextPressureProjection(step?.contextPressure) ??
        parseContextPressureProjection(resultSteps[index]?.contextPressure) ??
        parseContextPressureProjection(result?.contextPressure);
    const crossedPressureThresholdsForStep = (index, step = statusSteps[index]) => parseContextPressureCrossedThresholds(step?.contextPressureCrossedThresholds) ??
        parseContextPressureCrossedThresholds(resultSteps[index]?.contextPressureCrossedThresholds) ??
        parseContextPressureCrossedThresholds(result?.contextPressureCrossedThresholds);
    const terminationReasonForStep = (index, step = statusSteps[index]) => step?.terminationReason ?? resultSteps[index]?.terminationReason;
    if (state === "running") {
        if (requestedIndex !== undefined) {
            if (requestedIndex < 0 || requestedIndex >= stepCount)
                throw new Error(`Async run '${runId}' has ${stepCount} children. Index ${requestedIndex} is out of range.`);
            const selectedStep = statusSteps[requestedIndex];
            if (selectedStep?.status === "running") {
                return {
                    kind: "live",
                    runId,
                    asyncDir: location.asyncDir ?? undefined,
                    state,
                    agent: selectedStep.agent,
                    index: requestedIndex,
                    intercomTarget: resolveSubagentIntercomTarget(runId, selectedStep.agent, requestedIndex),
                    cwd: status?.cwd ?? result?.cwd,
                    sessionFile: selectedStep.sessionFile ?? status?.sessionFile ?? result?.sessionFile,
                    ...(modelIdentityForStep(requestedIndex, selectedStep)
                        ? { modelIdentity: modelIdentityForStep(requestedIndex, selectedStep) }
                        : {}),
                    ...(modelResolutionForStep(requestedIndex, selectedStep)
                        ? { modelResolution: modelResolutionForStep(requestedIndex, selectedStep) }
                        : {}),
                    ...(tkTicket ? { tkTicket } : {}),
                };
            }
            if (selectedStep?.status === "pending")
                throw new Error(`Async run '${runId}' child ${requestedIndex} is pending and has not started yet. Wait for it to run or complete before resuming.`);
            if (selectedStep && !terminalStepStatuses.has(selectedStep.status))
                throw new Error(`Async run '${runId}' child ${requestedIndex} is ${selectedStep.status} and cannot be revived yet.`);
        }
        else {
            const running = statusSteps
                .map((step, index) => ({ step, index }))
                .filter(({ step }) => step.status === "running");
            const selected = running.length === 1 ? running[0] : undefined;
            if (!selected) {
                throw new Error(`Async run '${runId}' has ${running.length} running children. Provide index to choose one.`);
            }
            return {
                kind: "live",
                runId,
                asyncDir: location.asyncDir ?? undefined,
                state,
                agent: selected.step.agent,
                index: selected.index,
                intercomTarget: resolveSubagentIntercomTarget(runId, selected.step.agent, selected.index),
                cwd: status?.cwd ?? result?.cwd,
                sessionFile: selected.step.sessionFile ?? status?.sessionFile ?? result?.sessionFile,
                ...(modelIdentityForStep(selected.index, selected.step)
                    ? { modelIdentity: modelIdentityForStep(selected.index, selected.step) }
                    : {}),
                ...(modelResolutionForStep(selected.index, selected.step)
                    ? { modelResolution: modelResolutionForStep(selected.index, selected.step) }
                    : {}),
                ...(tkTicket ? { tkTicket } : {}),
            };
        }
    }
    if (stepCount > 1 && requestedIndex === undefined) {
        throw new Error(`Async run '${runId}' has ${stepCount} children. Provide index to choose one.`);
    }
    const index = requestedIndex ?? 0;
    if (!Number.isInteger(index))
        throw new Error(`Async run '${runId}' index must be an integer.`);
    if (index < 0 || index >= stepCount)
        throw new Error(`Async run '${runId}' has ${stepCount} children. Index ${index} is out of range.`);
    let selectedStatusStep = statusSteps[index];
    let selectedContinuation = lifecycleContinuationForIndex(status, index);
    if (!options.readOnly &&
        typeof selectedContinuation?.claimToken === "string" &&
        selectedContinuation.claimToken.length > 0 &&
        location.asyncDir) {
        const recovered = recoverStaleLifecycleContinuationClaim(location.asyncDir, index, {
            kill: deps.kill,
            now: deps.now,
            asyncDirRoot,
            resultsDir,
        });
        if (recovered.recovered) {
            status = recovered.status ?? status;
            statusSteps = status?.steps ?? [];
            selectedStatusStep = statusSteps[index];
            selectedContinuation = lifecycleContinuationForIndex(status, index);
        }
    }
    if (state === "continued")
        throw new Error(`Async run '${runId}' already launched continuation '${selectedContinuation?.continuationRunId ?? status?.lifecycle?.continuation?.continuationRunId ?? "unknown"}' and cannot be resumed again.`);
    if (selectedStatusStep?.status === "cancelled")
        throw new Error(`Async run '${runId}' child ${index} was cancelled and cannot be resumed.`);
    if (selectedStatusStep?.status === "continued")
        throw new Error(`Async run '${runId}' child ${index} already launched its continuation and cannot be resumed again.`);
    if (!options.readOnly &&
        typeof selectedContinuation?.claimToken === "string" &&
        selectedContinuation.claimToken.length > 0) {
        const continuationRunId = selectedContinuation.continuationRunId;
        if ((selectedContinuation.phase === "reserved" || selectedContinuation.phase === "launched") &&
            continuationRunId) {
            throw new Error(`Async run '${runId}' child ${index} already launched continuation '${continuationRunId}' and cannot be resumed again.`);
        }
        throw new Error(`Async run '${runId}' child ${index} was already claimed for continuation and cannot be resumed again.`);
    }
    const agent = selectedStatusStep?.agent ?? resultSteps[index]?.agent ?? result?.agent;
    if (!agent)
        throw new Error(`Could not determine child agent for async run '${runId}'.`);
    const sessionFile = statusSteps[index]?.sessionFile ??
        resultSteps[index]?.sessionFile ??
        (stepCount === 1 ? (status?.sessionFile ?? result?.sessionFile) : undefined);
    const selectedChildPaused = statusSteps[index]?.status === "paused" ||
        (statusSteps.length === 0 && state === "paused" && resultSteps[index]?.interrupted === true);
    if (!sessionFile && requireSessionFile)
        throw new Error(`Async run '${runId}' child ${index} does not have a persisted session file to resume from.`);
    const resolvedSessionFile = sessionFile
        ? validateResumeSessionFile(runId, sessionFile, { allowMissing: selectedChildPaused })
        : undefined;
    const pausedStepAcceptance = statusSteps.length > 0 ? statusSteps[index]?.acceptance : resultSteps[index]?.acceptance;
    if (selectedChildPaused && pausedStepAcceptance === undefined) {
        throw new Error(`Async run '${runId}' is paused but its skipped acceptance ledger has not been persisted yet. Retry the resume once pause metadata is written.`);
    }
    const continuationAcceptance = selectedChildPaused
        ? resolvePausedContinuationAcceptance(runId, pausedStepAcceptance)
        : undefined;
    return {
        kind: "revive",
        runId,
        asyncDir: location.asyncDir ?? undefined,
        state,
        agent,
        index,
        intercomTarget: resolveSubagentIntercomTarget(runId, agent, index),
        cwd: status?.cwd ?? result?.cwd,
        ...(resolvedSessionFile ? { sessionFile: resolvedSessionFile } : {}),
        ...(modelIdentityForStep(index, selectedStatusStep)
            ? { modelIdentity: modelIdentityForStep(index, selectedStatusStep) }
            : {}),
        ...(modelResolutionForStep(index, selectedStatusStep)
            ? { modelResolution: modelResolutionForStep(index, selectedStatusStep) }
            : {}),
        ...(tkTicket ? { tkTicket } : {}),
        ...(selectedStatusStep?.pause?.kind
            ? { pauseKind: selectedStatusStep.pause.kind }
            : status?.pause?.kind
                ? { pauseKind: status.pause.kind }
                : {}),
        ...(typeof selectedContinuation?.claimToken === "string" &&
            selectedContinuation.claimToken.length > 0
            ? { claimed: true }
            : {}),
        ...(continuationAcceptance ? { continuationAcceptance } : {}),
        ...(contextUsageForStep(index, selectedStatusStep)
            ? { contextUsage: contextUsageForStep(index, selectedStatusStep) }
            : {}),
        ...(contextPressureForStep(index, selectedStatusStep)
            ? { contextPressure: contextPressureForStep(index, selectedStatusStep) }
            : {}),
        ...(crossedPressureThresholdsForStep(index, selectedStatusStep)
            ? {
                contextPressureCrossedThresholds: crossedPressureThresholdsForStep(index, selectedStatusStep),
            }
            : {}),
        ...(terminationReasonForStep(index, selectedStatusStep)
            ? { terminationReason: terminationReasonForStep(index, selectedStatusStep) }
            : {}),
        ...(selectedStatusStep?.activeRuntimeMs !== undefined
            ? { activeRuntimeMs: selectedStatusStep.activeRuntimeMs }
            : resultSteps[index]?.activeRuntimeMs !== undefined
                ? { activeRuntimeMs: resultSteps[index].activeRuntimeMs }
                : {}),
    };
}
export function buildRevivedAsyncTask(target, message) {
    return [
        "You are reviving a previous subagent conversation.",
        "",
        `Original run: ${target.runId}`,
        `Original agent: ${target.agent}`,
        target.sessionFile ? `Original session file: ${target.sessionFile}` : undefined,
        "",
        "Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.",
        "",
        "Follow-up:",
        message,
    ]
        .filter((line) => line !== undefined)
        .join("\n");
}
