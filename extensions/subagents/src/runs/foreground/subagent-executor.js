import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_AGENT_TERMINAL_RETENTION_MS, retainProjectAgentRunReference, releaseProjectAgentRunReference, } from "../../agents/project-agent-snapshot.js";
import { getArtifactsDir, resolveArtifactConfig } from "../../shared/artifacts.js";
import { formatForegroundPauseMessage, formatForegroundSupervisorPauseMessage, } from "../../shared/foreground-pause.js";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.js";
import { handleManagementAction } from "../../agents/agent-management.js";
import { buildDoctorReport } from "../../extension/doctor.js";
import { clearPendingForegroundControlNotices } from "../../extension/control-notices.js";
import { runSync } from "./execution.js";
import { authorizeProjectInterruptTarget, authorizeProjectSteerTarget, buildManagementActionParams, buildRunStatusParams, buildResumeModelResolution, cancelPersistedPausedForegroundRun, clearForegroundMessageInbox, emitControlNotification, enrichPersistedPausedForegroundSingleRun, foregroundStatusResult, getAsyncInterruptTarget, getForegroundControl, getRequestedModeLabel, interruptAsyncRun, readModelRegistrySnapshot, recoverFailedPausedForegroundTransition, registerForegroundMessageInbox, rememberForegroundRun, requestForegroundInterrupt, requestInterruptAllRunningSubagentRuns, interruptNestedRun, projectInterruptAuthorizationResult, projectInterruptResolutionMismatch, resolveRememberedForegroundRun, resolveSingleRunOutputBaseDir, resolvedAsyncInterruptTarget, selectInterruptTarget, steerAsyncRun, steerNestedRun, trustedSessionRootsForStatus, unknownAgentMessage, trimRememberedForegroundRuns, updateRememberedForegroundChild, providerFallbackModelsForTarget, resumeAsyncRun, unsupportedSavedChainInput, unsupportedSavedChainInputResult, } from "./foreground-control.js";
import { hasInMemoryProjectAgentCapture, hasMalformedProjectAgentControlMarker, hasProjectAgentControlMarker, isRecordValue, lookupPrivateProjectActionReference, normalizeProjectAgentAccess, privateProjectCaptureForTarget, projectAgentEntryIdentityError, projectRunAuthorizationError, resolveProjectAgentExecution, } from "./project-agent-control.js";
export { buildResumeModelResolution, clearForegroundMessageInbox, normalizeProjectAgentAccess, projectAgentEntryIdentityError, registerForegroundMessageInbox, trimRememberedForegroundRuns, requestInterruptAllRunningSubagentRuns, };
import { buildCohortPauseStep, buildPausedStepFromResult, isTerminalForegroundResultSnapshot, pausedForegroundStatusPath, persistPausedForegroundCohortRun, persistPausedForegroundSingleRun, } from "./foreground-pause-state.js";
import { resolveSubagentModelOverride, } from "../shared/model-fallback.js";
import { aggregateParallelOutputs } from "../shared/parallel-utils.js";
import { clearForegroundInterrupt, registerForegroundInterrupt, } from "../shared/foreground-interrupts.js";
import { buildExecutionInstructions, writeInitialProgressFile, resolveStepBehavior, suppressProgressForReadOnlyTask, } from "../../shared/settings.js";
import { normalizeSkillInput } from "../../agents/skills.js";
import { resolveExecutionPolicy, } from "../../agents/execution-ceiling.js";
import { executeAsyncParallel, executeAsyncSingle, isAsyncAvailable, } from "../background/async-execution.js";
import { validateAcceptanceInput, validateDispatchAcceptanceInput } from "../shared/acceptance.js";
import { resolveCurrentSessionId } from "../../shared/session-identity.js";
import { resolveControlConfig } from "../shared/subagent-control.js";
import { validateToolBudgetConfig } from "../shared/tool-budget.js";
import { resolveTkTicketMetadata, resolveTkTicketTaskContext } from "../shared/tk-ticket.js";
import { resolveAsyncRunLocation } from "../background/async-resume.js";
import { finalizeSingleOutput, injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode, } from "../shared/single-output.js";
import { compactForegroundDetails, getSingleResultOutput, mapConcurrent, readStatus, resolveChildCwd, sumResultsCost, sumResultsUsage, } from "../../shared/utils.js";
import { DEFAULT_GLOBAL_CONCURRENCY_LIMIT, Semaphore } from "../shared/parallel-utils.js";
import { attachNestedChildrenToResultChildren, formatForegroundNativeSubagentResult, resolveSubagentResultStatus, } from "../../shared/result-formatting.js";
import { attachRootChildrenToSteps, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv, updateForegroundNestedProjection, writeNestedEvent, } from "../shared/nested-events.js";
import { resolveSubagentRunId } from "../background/run-id-resolver.js";
import { safeTerminalDocument, safeTerminalText } from "../../shared/display-text.js";
import { inspectSubagentStatus } from "../background/run-status.js";
import { ASYNC_DIR, RESULTS_DIR, SUBAGENT_ACTIONS, checkSubagentDepth, resolveTopLevelParallelConcurrency, resolveTopLevelParallelMaxTasks, resolveChildMaxSubagentDepth, resolveCurrentMaxSubagentDepth, } from "../../shared/types.js";
function resolveRequestedCwd(runtimeCwd, requestedCwd) {
    return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}
function hasExplicitProjectModel(target) {
    if (!isRecordValue(target))
        return false;
    const model = target.model;
    if (typeof model !== "string")
        return false;
    const normalized = model.trim();
    return normalized.length > 0 && normalized !== "inherit";
}
function applyProjectAgentOpenRouterModel(params, captures, currentModel) {
    if (!captures?.length || currentModel?.provider !== "openrouter")
        return params;
    const projectTargets = new Set(captures.map((capture) => capture.provenance.agent));
    const apply = (target) => {
        if (!isRecordValue(target) ||
            typeof target.agent !== "string" ||
            !projectTargets.has(target.agent.trim()) ||
            hasExplicitProjectModel(target)) {
            return;
        }
        target.model = `${currentModel.provider}/${currentModel.id}`;
    };
    const next = { ...params };
    apply(next);
    if (Array.isArray(next.tasks)) {
        next.tasks = next.tasks.map((task) => {
            const copy = { ...task };
            apply(copy);
            return copy;
        });
    }
    return next;
}
const MAX_NATIVE_FOREGROUND_SAVE_ERROR_CHARS = 600;
function boundedNativeForegroundSaveError(error) {
    const marker = "… [save error truncated; full diagnostic is unavailable]";
    if (error.length <= MAX_NATIVE_FOREGROUND_SAVE_ERROR_CHARS)
        return error;
    return `${error.slice(0, MAX_NATIVE_FOREGROUND_SAVE_ERROR_CHARS - marker.length)}${marker}`;
}
function splitFinalizeSingleOutputSaveErrorBlock(displayOutput, saveError) {
    const saveErrorSuffix = `\n${saveError}`;
    if (!displayOutput.endsWith(saveErrorSuffix))
        return { output: displayOutput };
    const prefix = "\n\nOutput file error: ";
    const withoutSaveError = displayOutput.slice(0, -saveErrorSuffix.length);
    const blockStart = withoutSaveError.lastIndexOf(prefix);
    if (blockStart === -1)
        return { output: displayOutput };
    const pathLine = withoutSaveError.slice(blockStart + prefix.length);
    if (pathLine.includes("\n"))
        return { output: displayOutput };
    return {
        output: displayOutput.slice(0, blockStart),
        header: `Output file error: ${pathLine}`,
    };
}
function resultSummaryForNativeForeground(result, displayOutput) {
    const hasSavedOutputReference = result.exitCode === 0 && Boolean(result.savedOutputPath && result.outputReference);
    const rawOutput = hasSavedOutputReference && result.outputMode === "file-only"
        ? getSingleResultOutput(result)
        : (displayOutput ?? result.truncation?.text) || getSingleResultOutput(result);
    const singleSaveError = result.outputSaveError
        ? splitFinalizeSingleOutputSaveErrorBlock(rawOutput, result.outputSaveError)
        : undefined;
    const output = singleSaveError?.output ?? rawOutput;
    const lines = [];
    if (result.outputSaveError) {
        lines.push(`${singleSaveError?.header ?? "Output file error:"}\n${boundedNativeForegroundSaveError(result.outputSaveError)}`);
    }
    if (result.modelFallbackNotice)
        lines.push(`Notice: ${result.modelFallbackNotice}`);
    if (result.exitCode !== 0 && result.error) {
        const error = result.error.trim();
        const selected = output.trim();
        const summary = selected === error || selected.startsWith(`${error}\n`)
            ? selected
            : selected
                ? `${result.error}\n\nOutput:\n${output}`
                : result.error;
        lines.push(summary);
    }
    else {
        lines.push(output || result.error || "(no output)");
    }
    return lines.join("\n\n");
}
function formatFailedSingleRunOutput(result, displayOutput) {
    const error = safeTerminalText(result.error || "Failed");
    const output = safeTerminalText(displayOutput).trim();
    const lines = [error];
    if (output && output !== error.trim()) {
        lines.push("", "Output:", output);
    }
    if (result.artifactPaths?.outputPath) {
        lines.push("", `Output artifact: ${safeTerminalText(result.artifactPaths.outputPath)}`);
    }
    return safeTerminalDocument(lines.join("\n"));
}
function createForegroundControlNotifier(data, deps) {
    return (event) => emitControlNotification({
        pi: deps.pi,
        controlConfig: data.controlConfig,
        event,
    });
}
function buildForegroundNativeResult(input) {
    const visibleResults = input.details.results.map((result, index) => ({ result, index }));
    if (visibleResults.length === 0)
        return null;
    const children = visibleResults.map(({ result, index }, visibleIndex) => ({
        agent: result.agent,
        status: resolveSubagentResultStatus({
            exitCode: result.exitCode,
            interrupted: result.interrupted,
        }),
        summary: resultSummaryForNativeForeground(result, input.displayOutputs?.[index]),
        index,
        displayIndex: visibleIndex + 1,
        displayTotal: visibleResults.length,
        artifactPath: result.artifactPaths?.outputPath,
        sessionPath: result.sessionFile,
    }));
    const grouped = formatForegroundNativeSubagentResult({
        runId: input.runId,
        mode: input.mode,
        children: attachNestedChildrenToResultChildren(input.runId, children, input.nestedChildren),
        ...(input.statusOverride ? { statusOverride: input.statusOverride } : {}),
        ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
    });
    return {
        text: grouped.text,
        details: input.details,
    };
}
function retiredExecutionControlError(params) {
    const input = params;
    const topLevelGuidance = {
        timeoutMs: "Configure `execution.maxRunTimeMs` in `<agent-dir>/extensions/subagent/config.json`; caller-selected execution timeouts are no longer supported. Restart with a new direct run after removing `timeoutMs`.",
        concurrency: "Configure `parallel.concurrency` in `<agent-dir>/extensions/subagent/config.json`; per-call concurrency is no longer supported.",
        fallbackModels: "Configure fallbackModels in the agent definition; per-call fallback selection is no longer supported.",
        includeProgress: "Progress is tracked automatically and is not a caller-controlled execution option.",
    };
    for (const [key, guidance] of Object.entries(topLevelGuidance)) {
        if (Object.hasOwn(input, key))
            return `${key} is no longer supported. ${guidance}`;
    }
    if (Array.isArray(input.tasks)) {
        for (const [index, rawTask] of input.tasks.entries()) {
            if (!isRecordValue(rawTask))
                continue;
            if (Object.hasOwn(rawTask, "timeoutMs")) {
                return `tasks[${index}].timeoutMs is no longer supported. Configure execution.maxRunTimeMs in <agent-dir>/extensions/subagent/config.json; caller-selected execution timeouts are no longer supported. Restart with a new direct run after removing timeoutMs.`;
            }
            if (Object.hasOwn(rawTask, "reads")) {
                return `tasks[${index}].reads is no longer supported. Configure defaultReads in the agent definition instead.`;
            }
            if (Object.hasOwn(rawTask, "progress")) {
                return `tasks[${index}].progress is no longer supported. Configure defaultProgress in the agent definition instead.`;
            }
            if (Object.hasOwn(rawTask, "fallbackModels")) {
                return `tasks[${index}].fallbackModels is no longer supported. Configure fallbackModels in the agent definition instead.`;
            }
        }
    }
    return undefined;
}
function validateExecutionInput(params, agents, agentDiagnostics, hasTasks, hasSingle) {
    if (Number(hasTasks) + Number(hasSingle) !== 1) {
        return {
            content: [
                {
                    type: "text",
                    text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
                },
            ],
            isError: true,
            details: { mode: "single", results: [] },
        };
    }
    const acceptanceErrors = validateExecutionAcceptance(params);
    if (acceptanceErrors.length > 0) {
        return {
            content: [{ type: "text", text: acceptanceErrors.join(" ") }],
            isError: true,
            details: { mode: getRequestedModeLabel(params), results: [] },
        };
    }
    if (hasSingle && params.agent && !agents.find((agent) => agent.name === params.agent)) {
        return {
            content: [{ type: "text", text: unknownAgentMessage(params.agent, agentDiagnostics) }],
            isError: true,
            details: { mode: "single", results: [] },
        };
    }
    if (hasTasks && params.tasks) {
        for (let i = 0; i < params.tasks.length; i++) {
            const task = params.tasks[i];
            if (!agents.find((agent) => agent.name === task.agent)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `${unknownAgentMessage(task.agent, agentDiagnostics)} (task ${i + 1})`,
                        },
                    ],
                    isError: true,
                    details: { mode: "parallel", results: [] },
                };
            }
        }
    }
    return null;
}
function validateExecutionAcceptance(params) {
    const errors = [];
    errors.push(...validateAcceptanceInput(params.acceptance, "acceptance"));
    errors.push(...validateDispatchAcceptanceInput(params.acceptance, "acceptance"));
    for (const [index, task] of (params.tasks ?? []).entries()) {
        errors.push(...validateAcceptanceInput(task.acceptance, `tasks[${index}].acceptance`));
        errors.push(...validateDispatchAcceptanceInput(task.acceptance, `tasks[${index}].acceptance`));
    }
    return errors;
}
function buildRequestedModeError(params, message) {
    return {
        content: [{ type: "text", text: message }],
        isError: true,
        details: { mode: getRequestedModeLabel(params), results: [] },
    };
}
function resolveEffectiveSingleTimeout(callerTimeoutMs, agentTimeoutCeilingMs) {
    if (callerTimeoutMs === undefined)
        return agentTimeoutCeilingMs;
    if (agentTimeoutCeilingMs === undefined)
        return callerTimeoutMs;
    return Math.min(callerTimeoutMs, agentTimeoutCeilingMs);
}
function resolveToolBudget(raw, label = "toolBudget") {
    const resolved = validateToolBudgetConfig(raw, label);
    return { toolBudget: resolved.budget, error: resolved.error };
}
function resolveEffectiveToolBudget(input) {
    if (input.stepBudget !== undefined)
        return resolveToolBudget(input.stepBudget, "toolBudget");
    if (input.runBudget !== undefined)
        return { toolBudget: input.runBudget };
    return resolveToolBudget(input.agentBudget, "agent.toolBudget");
}
function expandTopLevelTaskCounts(tasks) {
    const expanded = [];
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
        const task = tasks[taskIndex];
        const rawCount = task.count;
        if (rawCount !== undefined &&
            (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
            return { error: `tasks[${taskIndex}].count must be an integer >= 1` };
        }
        const concreteTask = { ...task };
        delete concreteTask.count;
        for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
            expanded.push({ ...concreteTask });
        }
    }
    return { tasks: expanded };
}
function normalizeRepeatedParallelCounts(params) {
    if (params.tasks) {
        const expandedTasks = expandTopLevelTaskCounts(params.tasks);
        if (expandedTasks.error) {
            return { error: buildRequestedModeError(params, expandedTasks.error) };
        }
        return { params: { ...params, tasks: expandedTasks.tasks } };
    }
    return { params };
}
function toExecutionErrorResult(params, error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
        content: [{ type: "text", text: message }],
        isError: true,
        details: { mode: getRequestedModeLabel(params), results: [] },
    };
}
function runAsyncPath(data, deps) {
    const { params, effectiveCwd, agents, ctx, shareEnabled, sessionRoot, sessionFileForTask, artifactConfig, artifactsDir, effectiveAsync, controlConfig, nestedRoute, } = data;
    const hasTasks = (params.tasks?.length ?? 0) > 0;
    const hasSingle = !hasTasks && Boolean(params.agent);
    if (!effectiveAsync)
        return null;
    if (hasTasks && params.tasks) {
        const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
        if (params.tasks.length > maxParallelTasks) {
            return buildParallelModeError(`Max ${maxParallelTasks} tasks`);
        }
    }
    if (!isAsyncAvailable()) {
        return {
            content: [
                {
                    type: "text",
                    text: "Async mode requires the detached runner module, but it could not be found. Ensure the generated TLH runtime files are installed.",
                },
            ],
            isError: true,
            details: { mode: "single", results: [] },
        };
    }
    const id = randomUUID();
    const asyncCtx = {
        pi: deps.pi,
        cwd: ctx.cwd,
        currentSessionId: deps.state.currentSessionId,
        parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
        currentModelProvider: ctx.model?.provider,
        currentModel: ctx.model,
        modelScope: data.modelScope,
    };
    const modelRegistrySnapshot = readModelRegistrySnapshot(ctx);
    const { availableModels } = modelRegistrySnapshot;
    const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
    const currentProvider = ctx.model?.provider;
    let projectRunRetained = false;
    if (data.projectAgentCaptures?.length) {
        try {
            retainProjectAgentRunReference(data.projectAgentCapability, id, data.projectAgentCaptures);
            projectRunRetained = true;
        }
        catch (error) {
            return toExecutionErrorResult(params, new Error(`TLH project-agent run retention failed: ${error instanceof Error ? error.message : String(error)}`));
        }
    }
    const releaseAsyncProjectRunOnError = (result) => {
        if (projectRunRetained && result.isError) {
            releaseProjectAgentRunReference(id);
            projectRunRetained = false;
        }
        return result;
    };
    if (hasTasks && params.tasks) {
        const agentConfigs = params.tasks.map((task) => agents.find((agent) => agent.name === task.agent));
        const modelOverrides = params.tasks.map((task, index) => resolveSubagentModelOverride(task.model ?? agentConfigs[index]?.model, ctx.model, availableModels, currentProvider, { scope: data.modelScope, source: task.model ? "explicit" : "inherited" }));
        const parallelTasks = params.tasks.map((task, index) => ({
            agent: task.agent,
            task: task.task,
            cwd: task.cwd,
            ...(modelOverrides[index] ? { model: modelOverrides[index] } : {}),
            ...(providerFallbackModelsForTarget(task)
                ? { providerFallbackModels: providerFallbackModelsForTarget(task) }
                : {}),
            ...(task.modelFallbackNotice ? { modelFallbackNotice: task.modelFallbackNotice } : {}),
            ...(task.output === true
                ? agentConfigs[index]?.output
                    ? { output: agentConfigs[index].output }
                    : {}
                : task.output !== undefined
                    ? { output: task.output }
                    : {}),
            ...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
            ...(task.toolBudget !== undefined ? { toolBudget: task.toolBudget } : {}),
            ...(task.acceptance !== undefined ? { acceptance: task.acceptance } : {}),
        }));
        return releaseAsyncProjectRunOnError(executeAsyncParallel(id, {
            tasks: parallelTasks,
            concurrency: resolveTopLevelParallelConcurrency(deps.config.parallel?.concurrency),
            agents,
            ctx: asyncCtx,
            availableModels,
            modelRegistry: modelRegistrySnapshot.evidence,
            cwd: effectiveCwd,
            maxOutput: params.maxOutput,
            artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
            artifactConfig,
            shareEnabled,
            sessionRoot,
            sessionFilesByFlatIndex: params.tasks.map((task, index) => sessionFileForTask(task.agent, index)),
            maxSubagentDepth: currentMaxSubagentDepth,
            controlConfig,
            nestedRoute,
            timeoutMs: data.timeoutMs,
            toolBudget: data.toolBudget,
            projectAgentCaptures: data.projectAgentCaptures,
        }));
    }
    if (hasSingle) {
        const a = agents.find((x) => x.name === params.agent);
        if (!a) {
            return {
                content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
                isError: true,
                details: { mode: "single", results: [] },
            };
        }
        const rawOutput = params.output !== undefined ? params.output : a.output;
        const effectiveOutput = normalizeSingleOutputOverride(rawOutput, a.output);
        const effectiveOutputMode = params.outputMode ?? "inline";
        const normalizedSkills = normalizeSkillInput(params.skill);
        const skills = normalizedSkills === false ? [] : normalizedSkills;
        const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, a.maxSubagentDepth);
        const modelOverride = resolveSubagentModelOverride(params.model ?? a.model, ctx.model, availableModels, currentProvider, {
            scope: data.modelScope,
            source: params.model ? "explicit" : "inherited",
        });
        return releaseAsyncProjectRunOnError(executeAsyncSingle(id, {
            agent: params.agent,
            task: params.task ?? "",
            agentConfig: a,
            ctx: asyncCtx,
            availableModels,
            modelRegistry: modelRegistrySnapshot.evidence,
            cwd: effectiveCwd,
            maxOutput: params.maxOutput,
            artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
            artifactConfig,
            shareEnabled,
            sessionRoot,
            sessionFile: sessionFileForTask(params.agent, 0),
            skills,
            output: effectiveOutput,
            outputMode: effectiveOutputMode,
            outputBaseDir: resolveSingleRunOutputBaseDir(artifactsDir, id),
            modelOverride,
            providerFallbackModels: providerFallbackModelsForTarget(params),
            modelFallbackNotice: params.modelFallbackNotice,
            maxSubagentDepth,
            controlConfig,
            nestedRoute,
            acceptance: params.acceptance,
            timeoutMs: data.timeoutMs,
            toolBudget: data.toolBudget,
            projectAgent: data.projectAgentCaptures?.find((capture) => capture.provenance.agent === params.agent),
        }));
    }
    if (projectRunRetained) {
        releaseProjectAgentRunReference(id);
        projectRunRetained = false;
    }
    return null;
}
function buildParallelModeError(message) {
    return {
        content: [{ type: "text", text: message }],
        isError: true,
        details: { mode: "parallel", results: [] },
    };
}
function resolveParallelTaskCwd(task, paramsCwd) {
    return resolveChildCwd(paramsCwd, task.cwd);
}
function findDuplicateParallelOutputPath(input) {
    const seen = new Map();
    for (let index = 0; index < input.tasks.length; index++) {
        const behavior = input.behaviors[index];
        if (!behavior?.output)
            continue;
        const task = input.tasks[index];
        const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd);
        const outputPath = resolveSingleOutputPath(behavior.output, input.ctxCwd, taskCwd, input.outputBaseDir);
        if (!outputPath)
            continue;
        const previous = seen.get(outputPath);
        if (previous) {
            return `Parallel tasks ${previous.index + 1} (${previous.agent}) and ${index + 1} (${task.agent}) resolve output to the same path: ${outputPath}. Use distinct output paths.`;
        }
        seen.set(outputPath, { index, agent: task.agent });
    }
    return undefined;
}
async function runForegroundParallelTasks(input) {
    let interrupted = false;
    let supervisorPauseIndex;
    const interruptControllers = new Map();
    const startedIndexes = new Set();
    const writeParallelPauseCheckpoint = (requesterIndex, requester, ownerPid, options) => {
        const now = Date.now();
        const steps = input.tasks.map((task, index) => {
            const liveResult = input.liveResults[index];
            const liveProgress = input.liveProgress[index];
            const result = liveResult ?? (index === requesterIndex ? requester : undefined);
            if (index === requesterIndex && result) {
                return buildPausedStepFromResult(result, now, {
                    stage: options.rootStage,
                    ownerPid,
                    ...(options.requesterStatus ? { status: options.requesterStatus } : {}),
                });
            }
            if (result &&
                options.rootStage === "paused" &&
                isTerminalForegroundResultSnapshot(result, liveProgress ?? result.progress)) {
                return buildPausedStepFromResult(result, now, { stage: "paused" });
            }
            if (liveResult && isTerminalForegroundResultSnapshot(liveResult, liveProgress)) {
                return buildPausedStepFromResult(liveResult, now, { stage: "paused" });
            }
            if (startedIndexes.has(index) ||
                interruptControllers.has(index) ||
                liveProgress?.status === "running") {
                return buildCohortPauseStep({
                    agent: task.agent,
                    sessionFile: input.sessionFileForTask(task.agent, index) ?? input.sessionFileForIndex(index),
                    status: options.rootStage === "paused" ? "paused" : "pausing",
                    now,
                    model: result?.model ?? task.model,
                    thinking: result?.thinking,
                    modelIdentity: result?.modelIdentity,
                    modelResolution: result?.modelResolution,
                    contextUsage: result?.contextUsage,
                    contextPressure: result?.contextPressure,
                    contextPressureCrossedThresholds: result?.contextPressureCrossedThresholds,
                    projectAgent: result?.projectAgent ??
                        input.projectAgentCaptures?.find((capture) => capture.provenance.agent === task.agent),
                });
            }
            return buildCohortPauseStep({
                agent: task.agent,
                sessionFile: input.sessionFileForTask(task.agent, index) ?? input.sessionFileForIndex(index),
                status: "pending",
                now,
                model: result?.model ?? task.model,
                thinking: result?.thinking,
                modelIdentity: result?.modelIdentity,
                modelResolution: result?.modelResolution,
                contextUsage: result?.contextUsage,
                contextPressure: result?.contextPressure,
                contextPressureCrossedThresholds: result?.contextPressureCrossedThresholds,
                projectAgent: result?.projectAgent ??
                    input.projectAgentCaptures?.find((capture) => capture.provenance.agent === task.agent),
            });
        });
        persistPausedForegroundCohortRun({
            runId: input.runId,
            cwd: input.paramsCwd,
            sessionId: input.state.currentSessionId,
            mode: "parallel",
            stage: options.rootStage,
            ownerPid,
            startedAt: input.foregroundControl?.startedAt,
            pause: requester.pause,
            steps,
        });
    };
    const requestCohortPause = (requesterIndex, requester, ownerPid) => {
        if (supervisorPauseIndex !== undefined)
            return;
        writeParallelPauseCheckpoint(requesterIndex, requester, ownerPid, {
            rootStage: "pausing",
            requesterStatus: "pausing",
        });
        supervisorPauseIndex = requesterIndex;
        interrupted = true;
        for (const [index, controller] of interruptControllers.entries()) {
            if (index === requesterIndex || controller.signal.aborted)
                continue;
            controller.abort();
        }
    };
    for (let i = 0; i < input.tasks.length; i++) {
        input.sessionFileForIndex(i);
    }
    return mapConcurrent(input.tasks, input.concurrencyLimit, async (task, index) => {
        if (interrupted) {
            return {
                agent: task.agent,
                task: input.taskTexts[index],
                exitCode: 0,
                interrupted: true,
                messages: [],
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
                finalOutput: "Interrupted before starting queued task.",
            };
        }
        const behavior = input.behaviors[index];
        const effectiveSkills = behavior?.skills;
        const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd);
        const readInstructions = behavior
            ? buildExecutionInstructions({ ...behavior, output: false, progress: false }, taskCwd, false)
            : { prefix: "", suffix: "" };
        const progressInstructions = behavior
            ? buildExecutionInstructions({ ...behavior, output: false, reads: false }, input.progressDir, index === input.firstProgressIndex)
            : { prefix: "", suffix: "" };
        const outputPath = resolveSingleOutputPath(behavior?.output, input.ctx.cwd, taskCwd, input.outputBaseDir);
        const taskText = injectSingleOutputInstruction(`${readInstructions.prefix}${input.taskTexts[index]}${progressInstructions.suffix}`, outputPath);
        const interruptController = new AbortController();
        interruptControllers.set(index, interruptController);
        startedIndexes.add(index);
        const steerInboxDir = input.foregroundControl
            ? registerForegroundMessageInbox(input.foregroundControl, input.runId, index)
            : undefined;
        if (input.foregroundControl) {
            input.foregroundControl.currentAgent = task.agent;
            input.foregroundControl.currentIndex = index;
            input.foregroundControl.currentActivityState = undefined;
            input.foregroundControl.updatedAt = Date.now();
            registerForegroundInterrupt(input.foregroundControl, index, () => {
                interrupted = true;
                if (interruptController.signal.aborted)
                    return false;
                interruptController.abort();
                input.foregroundControl.currentActivityState = undefined;
                input.foregroundControl.updatedAt = Date.now();
                return true;
            });
        }
        const agentConfig = input.agents.find((agent) => agent.name === task.agent);
        const supervisorBridgeActive = agentConfig?.supervisorBridge !== false;
        return (input.runSync ?? runSync)(input.ctx.cwd, input.agents, task.agent, taskText, {
            onSupervisorPauseTransition: (transition) => {
                const { stage, result } = transition;
                if (result.pause?.kind !== "awaiting_supervisor")
                    return;
                if (stage === "pausing") {
                    requestCohortPause(index, result, transition.ownerPid);
                    return;
                }
                input.liveResults[index] = result;
                writeParallelPauseCheckpoint(index, result, undefined, {
                    rootStage: "pausing",
                    requesterStatus: "paused",
                });
            },
            parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
            projectAgent: input.projectAgentCaptures?.find((capture) => capture.provenance.agent === task.agent),
            cwd: taskCwd,
            signal: input.signal,
            interruptSignal: interruptController.signal,
            pauseBlockingSupervisor: supervisorBridgeActive,
            runId: input.runId,
            index,
            sessionDir: input.sessionDirForIndex(index),
            sessionFile: input.sessionFileForTask(task.agent, index),
            share: input.shareEnabled,
            artifactsDir: input.artifactConfig.enabled ? input.artifactsDir : undefined,
            artifactConfig: input.artifactConfig,
            maxOutput: input.maxOutput,
            outputPath,
            outputMode: behavior?.outputMode,
            maxSubagentDepth: input.maxSubagentDepths[index],
            controlConfig: input.controlConfig,
            onControlEvent: input.onControlEvent,
            steerInboxDir,
            nestedRoute: input.foregroundControl?.nestedRoute,
            modelOverride: input.modelOverrides[index],
            providerFallbackModels: input.providerFallbackModels[index],
            modelFallbackNotice: behavior?.modelFallbackNotice,
            availableModels: input.availableModels,
            modelRegistry: input.modelRegistry,
            preferredModelProvider: input.ctx.model?.provider,
            modelScope: input.modelScope,
            ...(input.tkTicket && input.tkTicketIndex === index ? { tkTicket: input.tkTicket } : {}),
            skills: effectiveSkills === false ? [] : effectiveSkills,
            acceptance: task.acceptance,
            acceptanceContext: { mode: "parallel" },
            timeoutMs: input.timeoutMs,
            deadlineAt: input.deadlineAt,
            toolBudget: input.toolBudgets[index],
            onUpdate: input.onUpdate
                ? (progressUpdate) => {
                    const stepResults = progressUpdate.details?.results || [];
                    const stepProgress = progressUpdate.details?.progress || [];
                    if (input.foregroundControl && stepProgress.length > 0) {
                        const current = stepProgress[0];
                        input.foregroundControl.currentAgent = task.agent;
                        input.foregroundControl.currentIndex = index;
                        input.foregroundControl.currentActivityState = current?.activityState;
                        input.foregroundControl.lastActivityAt = current?.lastActivityAt;
                        input.foregroundControl.currentTool = current?.currentTool;
                        input.foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
                        input.foregroundControl.currentPath = current?.currentPath;
                        input.foregroundControl.turnCount = current?.turnCount;
                        input.foregroundControl.tokens = current?.tokens;
                        input.foregroundControl.toolCount = current?.toolCount;
                        input.foregroundControl.updatedAt = Date.now();
                    }
                    if (stepResults.length > 0)
                        input.liveResults[index] = stepResults[0];
                    if (stepProgress.length > 0)
                        input.liveProgress[index] = stepProgress[0];
                    const mergedResults = input.liveResults.filter((result) => result !== undefined);
                    const mergedProgress = input.liveProgress.filter((progress) => progress !== undefined);
                    input.onUpdate?.({
                        content: progressUpdate.content,
                        details: {
                            mode: "parallel",
                            results: mergedResults,
                            progress: mergedProgress,
                            controlEvents: progressUpdate.details?.controlEvents,
                            totalSteps: input.tasks.length,
                        },
                    });
                }
                : undefined,
        })
            .then((result) => {
            input.liveResults[index] = result;
            startedIndexes.delete(index);
            if (supervisorPauseIndex !== undefined &&
                index !== supervisorPauseIndex &&
                result.interrupted &&
                !result.pause &&
                result.sessionFile) {
                result.pause = {
                    kind: "cohort_pause",
                    requestedAt: Date.now(),
                    pausedAt: Date.now(),
                    summary: "Paused because another child is awaiting supervisor.",
                };
                result.error = undefined;
                result.finalOutput =
                    "Paused because another child in this cohort is awaiting supervisor.";
            }
            return result;
        })
            .finally(() => {
            startedIndexes.delete(index);
            interruptControllers.delete(index);
            if (input.foregroundControl) {
                clearForegroundInterrupt(input.foregroundControl, index);
                clearForegroundMessageInbox(input.foregroundControl, index);
                input.foregroundControl.updatedAt = Date.now();
            }
        });
    }, input.globalSemaphore);
}
async function runParallelPath(data, deps) {
    const { params, effectiveCwd, agents, ctx, signal, runId, sessionDirForIndex, sessionFileForIndex, sessionFileForTask, shareEnabled, artifactConfig, artifactsDir, onUpdate, controlConfig, } = data;
    const onControlEvent = createForegroundControlNotifier(data, deps);
    const allArtifactPaths = [];
    const tasks = params.tasks;
    const tkTicketContext = resolveTkTicketTaskContext({ runnerCwd: effectiveCwd, tasks });
    const tkTicket = tkTicketContext
        ? resolveTkTicketMetadata(tkTicketContext.task, { cwd: tkTicketContext.cwd })
        : undefined;
    const tkTicketIndex = tkTicketContext?.taskIndex;
    const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
    const parallelConcurrency = resolveTopLevelParallelConcurrency(deps.config.parallel?.concurrency);
    if (tasks.length > maxParallelTasks)
        return {
            content: [{ type: "text", text: `Max ${maxParallelTasks} tasks` }],
            isError: true,
            details: { mode: "parallel", results: [] },
        };
    const agentConfigs = [];
    for (const t of tasks) {
        const config = agents.find((a) => a.name === t.agent);
        if (!config) {
            return {
                content: [{ type: "text", text: `Unknown agent: ${t.agent}` }],
                isError: true,
                details: { mode: "parallel", results: [] },
            };
        }
        agentConfigs.push(config);
    }
    const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
    const maxSubagentDepths = agentConfigs.map((config) => resolveChildMaxSubagentDepth(currentMaxSubagentDepth, config.maxSubagentDepth));
    const toolBudgets = [];
    for (let index = 0; index < tasks.length; index++) {
        const resolved = resolveEffectiveToolBudget({
            stepBudget: tasks[index]?.toolBudget,
            runBudget: data.toolBudget,
            agentBudget: agentConfigs[index]?.toolBudget,
        });
        if (resolved.error)
            return buildParallelModeError(resolved.error);
        toolBudgets.push(resolved.toolBudget);
    }
    const currentProvider = ctx.model?.provider;
    const modelRegistrySnapshot = readModelRegistrySnapshot(ctx);
    const { availableModels } = modelRegistrySnapshot;
    const taskTexts = tasks.map((t) => t.task);
    const behaviorOverrides = tasks.map((task, index) => ({
        ...(task.output !== undefined
            ? { output: task.output === true ? (agentConfigs[index]?.output ?? false) : task.output }
            : {}),
        ...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(task.modelFallbackNotice ? { modelFallbackNotice: task.modelFallbackNotice } : {}),
    }));
    const modelOverrides = tasks.map((_, i) => resolveSubagentModelOverride(behaviorOverrides[i]?.model ?? agentConfigs[i]?.model, ctx.model, availableModels, currentProvider, { scope: data.modelScope, source: behaviorOverrides[i]?.model ? "explicit" : "inherited" }));
    const behaviors = agentConfigs.map((config, index) => suppressProgressForReadOnlyTask(resolveStepBehavior(config, behaviorOverrides[index]), taskTexts[index]));
    const firstProgressIndex = behaviors.findIndex((behavior) => behavior.progress);
    const liveResults = Array.from({ length: tasks.length }, () => undefined);
    const liveProgress = Array.from({ length: tasks.length }, () => undefined);
    const foregroundControl = deps.state.foregroundControls.get(runId);
    const outputBaseDir = path.join(artifactsDir, "outputs", runId);
    const duplicateOutputError = findDuplicateParallelOutputPath({
        tasks,
        behaviors,
        paramsCwd: effectiveCwd,
        ctxCwd: ctx.cwd,
        outputBaseDir,
    });
    if (duplicateOutputError)
        return buildParallelModeError(duplicateOutputError);
    for (let index = 0; index < tasks.length; index++) {
        const taskCwd = resolveParallelTaskCwd(tasks[index], effectiveCwd);
        const outputPath = resolveSingleOutputPath(behaviors[index]?.output, ctx.cwd, taskCwd, outputBaseDir);
        const validationError = validateFileOnlyOutputMode(behaviors[index]?.outputMode, outputPath, `Parallel task ${index + 1} (${tasks[index].agent})`);
        if (validationError)
            return buildParallelModeError(validationError);
    }
    const parallelProgressPrecreated = firstProgressIndex !== -1;
    const parallelProgressDir = path.join(artifactsDir, "progress", runId);
    if (parallelProgressPrecreated)
        writeInitialProgressFile(parallelProgressDir);
    const deadlineAt = data.deadlineAt ?? (data.timeoutMs !== undefined ? Date.now() + data.timeoutMs : undefined);
    const results = await runForegroundParallelTasks({
        tasks,
        taskTexts,
        agents,
        ctx,
        state: deps.state,
        signal,
        runId,
        sessionDirForIndex,
        sessionFileForIndex,
        sessionFileForTask,
        shareEnabled,
        artifactConfig,
        artifactsDir,
        outputBaseDir,
        maxOutput: params.maxOutput,
        paramsCwd: effectiveCwd,
        progressDir: parallelProgressDir,
        availableModels,
        modelRegistry: modelRegistrySnapshot.evidence,
        modelScope: data.modelScope,
        modelOverrides,
        providerFallbackModels: tasks.map((task) => providerFallbackModelsForTarget(task)),
        behaviors,
        firstProgressIndex: parallelProgressPrecreated ? -1 : firstProgressIndex,
        controlConfig,
        onControlEvent,
        foregroundControl,
        concurrencyLimit: parallelConcurrency,
        globalSemaphore: new Semaphore(DEFAULT_GLOBAL_CONCURRENCY_LIMIT),
        maxSubagentDepths,
        liveResults,
        liveProgress,
        onUpdate,
        timeoutMs: data.timeoutMs,
        deadlineAt,
        toolBudgets,
        ...(tkTicket ? { tkTicket } : {}),
        ...(tkTicketIndex !== undefined && tkTicketIndex >= 0 ? { tkTicketIndex } : {}),
        projectAgentCaptures: data.projectAgentCaptures,
        runSync: data.runSync,
    });
    for (const result of results) {
        if (result.artifactPaths)
            allArtifactPaths.push(result.artifactPaths);
    }
    if (foregroundControl) {
        updateForegroundNestedProjection(foregroundControl);
        attachRootChildrenToSteps(runId, results, foregroundControl.nestedChildren);
    }
    const interrupted = results.find((result) => result.interrupted);
    const details = compactForegroundDetails({
        mode: "parallel",
        runId,
        results,
        artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
        totalChildUsage: sumResultsUsage(results),
        totalCost: sumResultsCost(results),
    });
    rememberForegroundRun(deps.state, {
        runId,
        mode: "parallel",
        cwd: effectiveCwd,
        results: details.results,
    });
    if (results.some((result) => result.pause)) {
        persistPausedForegroundCohortRun({
            runId,
            cwd: effectiveCwd,
            sessionId: deps.state.currentSessionId,
            mode: "parallel",
            stage: "paused",
            results: details.results,
            startedAt: foregroundControl?.startedAt,
        });
    }
    if (interrupted) {
        const interruptedIndex = results.findIndex((result) => result === interrupted);
        const pausedChildren = results.filter((result) => result.interrupted).length;
        const text = interrupted.pause?.kind === "awaiting_supervisor"
            ? formatForegroundSupervisorPauseMessage({
                headline: `Foreground parallel run ${runId} paused awaiting supervisor (${interrupted.agent}).`,
                runId,
                agent: interrupted.agent,
                requestSummary: interrupted.pause.summary,
                index: interruptedIndex >= 0 ? interruptedIndex : 0,
            })
            : formatForegroundPauseMessage({
                headline: `Foreground parallel run ${runId} paused after interrupt (${interrupted.agent}).`,
                runId,
                resume: {
                    kind: "indexed",
                    index: interruptedIndex >= 0 ? interruptedIndex : 0,
                    ...(pausedChildren > 1 ? { example: true } : {}),
                },
                redispatch: "subagent({ tasks: [...] })",
            });
        return {
            content: [{ type: "text", text }],
            details,
        };
    }
    if (foregroundControl)
        updateForegroundNestedProjection(foregroundControl);
    const nativeResult = buildForegroundNativeResult({
        runId,
        mode: "parallel",
        details,
        ...(foregroundControl?.nestedChildren?.length
            ? { nestedChildren: foregroundControl.nestedChildren }
            : {}),
    });
    if (nativeResult) {
        return {
            content: [{ type: "text", text: nativeResult.text }],
            details: nativeResult.details,
        };
    }
    const ok = results.filter((result) => result.exitCode === 0).length;
    const aggregatedOutput = aggregateParallelOutputs(results.map((result) => ({
        agent: result.agent,
        output: result.truncation?.text || getSingleResultOutput(result),
        exitCode: result.exitCode,
        error: result.error,
        timedOut: result.timedOut,
        modelFallbackNotice: result.modelFallbackNotice,
    })), (i, agent) => `=== Task ${i + 1}: ${agent} ===`);
    const summary = `${ok}/${results.length} succeeded`;
    return {
        content: [{ type: "text", text: `${summary}\n\n${aggregatedOutput}` }],
        details,
    };
}
async function runSinglePath(data, deps) {
    const { params, effectiveCwd, agents, ctx, signal, runId, sessionDirForIndex, sessionFileForTask, shareEnabled, artifactConfig, artifactsDir, onUpdate, controlConfig, } = data;
    const onControlEvent = createForegroundControlNotifier(data, deps);
    const allArtifactPaths = [];
    const agentConfig = agents.find((a) => a.name === params.agent);
    if (!agentConfig) {
        return {
            content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
            isError: true,
            details: { mode: "single", results: [] },
        };
    }
    const supervisorBridgeActive = agentConfig.supervisorBridge !== false;
    const effectiveToolBudget = resolveEffectiveToolBudget({
        runBudget: data.toolBudget,
        agentBudget: agentConfig.toolBudget,
    });
    if (effectiveToolBudget.error)
        return toExecutionErrorResult(params, new Error(effectiveToolBudget.error));
    const currentProvider = ctx.model?.provider;
    const modelRegistrySnapshot = readModelRegistrySnapshot(ctx);
    const { availableModels } = modelRegistrySnapshot;
    let task = params.task ?? "";
    const tkTicket = resolveTkTicketMetadata(params.task, { cwd: effectiveCwd });
    const modelOverride = resolveSubagentModelOverride(params.model ?? agentConfig.model, ctx.model, availableModels, currentProvider, {
        scope: data.modelScope,
        source: params.model ? "explicit" : "inherited",
    });
    const skillOverride = normalizeSkillInput(params.skill);
    const providerFallbackModels = providerFallbackModelsForTarget(params);
    const modelFallbackNotice = params.modelFallbackNotice;
    const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
    const effectiveOutput = normalizeSingleOutputOverride(rawOutput, agentConfig.output);
    const effectiveOutputMode = params.outputMode ?? "inline";
    const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
    const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth);
    const effectiveTimeoutMs = resolveEffectiveSingleTimeout(data.timeoutMs, agentConfig.maxExecutionTimeMs);
    const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, effectiveCwd, resolveSingleRunOutputBaseDir(artifactsDir, runId));
    const validationError = validateFileOnlyOutputMode(effectiveOutputMode, outputPath, `Single run (${params.agent})`);
    if (validationError) {
        return {
            content: [{ type: "text", text: validationError }],
            isError: true,
            details: { mode: "single", results: [] },
        };
    }
    task = injectSingleOutputInstruction(task, outputPath);
    let effectiveSkills;
    if (skillOverride === false) {
        effectiveSkills = [];
    }
    else {
        effectiveSkills = skillOverride;
    }
    const interruptController = new AbortController();
    const foregroundControl = deps.state.foregroundControls.get(runId);
    const steerInboxDir = foregroundControl
        ? registerForegroundMessageInbox(foregroundControl, runId, 0)
        : undefined;
    if (foregroundControl) {
        foregroundControl.currentAgent = params.agent;
        foregroundControl.currentIndex = 0;
        foregroundControl.currentActivityState = undefined;
        foregroundControl.updatedAt = Date.now();
        registerForegroundInterrupt(foregroundControl, 0, () => {
            if (interruptController.signal.aborted)
                return false;
            interruptController.abort();
            foregroundControl.currentActivityState = undefined;
            foregroundControl.updatedAt = Date.now();
            return true;
        });
    }
    const forwardSingleUpdate = onUpdate
        ? (update) => {
            if (foregroundControl) {
                const firstProgress = update.details?.progress?.[0];
                foregroundControl.currentAgent = params.agent;
                foregroundControl.currentIndex = firstProgress?.index ?? 0;
                foregroundControl.currentActivityState = firstProgress?.activityState;
                foregroundControl.lastActivityAt = firstProgress?.lastActivityAt;
                foregroundControl.currentTool = firstProgress?.currentTool;
                foregroundControl.currentToolStartedAt = firstProgress?.currentToolStartedAt;
                foregroundControl.currentPath = firstProgress?.currentPath;
                foregroundControl.turnCount = firstProgress?.turnCount;
                foregroundControl.tokens = firstProgress?.tokens;
                foregroundControl.toolCount = firstProgress?.toolCount;
                foregroundControl.updatedAt = Date.now();
            }
            onUpdate(update);
        }
        : undefined;
    const deadlineAt = data.deadlineAt ?? (data.timeoutMs !== undefined ? Date.now() + data.timeoutMs : undefined);
    let r;
    try {
        r = await (data.runSync ?? runSync)(ctx.cwd, agents, params.agent, task, {
            parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
            projectAgent: data.projectAgentCaptures?.find((capture) => capture.provenance.agent === params.agent),
            cwd: effectiveCwd,
            signal,
            interruptSignal: interruptController.signal,
            pauseBlockingSupervisor: supervisorBridgeActive,
            runId,
            sessionDir: sessionDirForIndex(0),
            sessionFile: sessionFileForTask(params.agent, 0),
            share: shareEnabled,
            artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
            artifactConfig,
            maxOutput: params.maxOutput,
            outputPath,
            outputMode: effectiveOutputMode,
            maxSubagentDepth,
            onUpdate: forwardSingleUpdate,
            controlConfig,
            onControlEvent,
            steerInboxDir,
            nestedRoute: foregroundControl?.nestedRoute,
            onSupervisorPauseTransition: (transition) => {
                const { stage, result } = transition;
                try {
                    persistPausedForegroundSingleRun({
                        runId,
                        cwd: effectiveCwd,
                        sessionId: deps.state.currentSessionId,
                        stage,
                        ownerPid: stage === "pausing" ? transition.ownerPid : undefined,
                        result,
                    });
                }
                catch (error) {
                    if (stage === "paused")
                        recoverFailedPausedForegroundTransition({ runId, error });
                    throw error;
                }
                if (stage === "paused")
                    updateRememberedForegroundChild(deps.state, {
                        runId,
                        mode: "single",
                        cwd: effectiveCwd,
                        index: 0,
                        result,
                    });
            },
            index: 0,
            modelOverride,
            providerFallbackModels,
            modelFallbackNotice,
            availableModels,
            modelRegistry: modelRegistrySnapshot.evidence,
            preferredModelProvider: currentProvider,
            modelScope: data.modelScope,
            ...(tkTicket ? { tkTicket } : {}),
            skills: effectiveSkills,
            acceptance: params.acceptance,
            acceptanceContext: { mode: "single" },
            timeoutMs: effectiveTimeoutMs,
            deadlineAt,
            toolBudget: effectiveToolBudget.toolBudget,
        });
    }
    finally {
        if (foregroundControl)
            clearForegroundMessageInbox(foregroundControl, 0);
    }
    if (foregroundControl) {
        clearForegroundInterrupt(foregroundControl, 0);
        foregroundControl.currentActivityState = r.progress?.activityState;
        foregroundControl.lastActivityAt = r.progress?.lastActivityAt;
        foregroundControl.currentTool = r.progress?.currentTool;
        foregroundControl.currentToolStartedAt = r.progress?.currentToolStartedAt;
        foregroundControl.currentPath = r.progress?.currentPath;
        foregroundControl.turnCount = r.progress?.turnCount;
        foregroundControl.tokens = r.progress?.tokens;
        foregroundControl.toolCount = r.progress?.toolCount;
        foregroundControl.updatedAt = Date.now();
    }
    if (r.artifactPaths)
        allArtifactPaths.push(r.artifactPaths);
    const fullOutput = getSingleResultOutput(r);
    const finalizedOutput = finalizeSingleOutput({
        fullOutput,
        truncatedOutput: r.truncation?.text,
        outputPath,
        outputMode: r.outputMode,
        exitCode: r.exitCode,
        savedPath: r.savedOutputPath,
        outputReference: r.outputReference,
        saveError: r.outputSaveError,
        acceptanceRejected: r.acceptance?.status === "rejected" && Boolean(r.savedOutputPath),
    });
    if (foregroundControl) {
        updateForegroundNestedProjection(foregroundControl);
        attachRootChildrenToSteps(runId, [r], foregroundControl.nestedChildren);
    }
    const details = compactForegroundDetails({
        mode: "single",
        runId,
        results: [r],
        ...(effectiveToolBudget.toolBudget ? { toolBudget: effectiveToolBudget.toolBudget } : {}),
        artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
        truncation: r.truncation,
        totalChildUsage: sumResultsUsage([r]),
        totalCost: sumResultsCost([r]),
    });
    rememberForegroundRun(deps.state, {
        runId,
        mode: "single",
        cwd: effectiveCwd,
        results: details.results,
    });
    if (r.pause?.kind === "awaiting_supervisor")
        enrichPersistedPausedForegroundSingleRun({ runId, result: r });
    if (!r.interrupted) {
        if (foregroundControl)
            updateForegroundNestedProjection(foregroundControl);
        const nativeResult = buildForegroundNativeResult({
            runId,
            mode: "single",
            details,
            displayOutputs: [finalizedOutput.displayOutput],
            ...(foregroundControl?.nestedChildren?.length
                ? { nestedChildren: foregroundControl.nestedChildren }
                : {}),
        });
        if (nativeResult) {
            return {
                content: [{ type: "text", text: nativeResult.text }],
                details: nativeResult.details,
                ...(r.exitCode !== 0 ? { isError: true } : {}),
            };
        }
    }
    if (r.pause?.kind === "awaiting_supervisor") {
        return {
            content: [
                {
                    type: "text",
                    text: safeTerminalDocument(formatForegroundSupervisorPauseMessage({
                        headline: `Foreground run ${runId} paused awaiting supervisor (${params.agent}).`,
                        runId,
                        agent: params.agent,
                        requestSummary: r.pause.summary,
                    })),
                },
            ],
            details,
        };
    }
    if (r.interrupted) {
        return {
            content: [
                {
                    type: "text",
                    text: safeTerminalDocument(formatForegroundPauseMessage({
                        headline: `Foreground run ${runId} paused after interrupt (${params.agent}).`,
                        runId,
                        resume: { kind: "single" },
                        redispatch: `subagent({ agent: "${params.agent}", task: "..." })`,
                    })),
                },
            ],
            details,
        };
    }
    const noticePrefix = r.modelFallbackNotice
        ? `Notice: ${safeTerminalText(r.modelFallbackNotice)}\n\n`
        : "";
    if (r.exitCode !== 0)
        return {
            content: [
                {
                    type: "text",
                    text: `${noticePrefix}${formatFailedSingleRunOutput(r, finalizedOutput.displayOutput)}`,
                },
            ],
            details,
            isError: true,
        };
    return {
        content: [
            { type: "text", text: `${noticePrefix}${finalizedOutput.displayOutput || "(no output)"}` },
        ],
        details,
    };
}
function inferExecutionMode(params) {
    if ((params.tasks?.length ?? 0) > 0)
        return "parallel";
    return "single";
}
function duplicateSubagentCallResult(params) {
    return {
        content: [
            {
                type: "text",
                text: "Rejected: a subagent call is already in progress. Issue exactly ONE subagent call per turn.",
            },
        ],
        isError: true,
        details: { mode: inferExecutionMode(params), results: [] },
    };
}
function executeDoctorAction(params, requestCwd, ctx, deps) {
    let currentSessionFile = null;
    let currentSessionId = deps.state.currentSessionId;
    let sessionError;
    try {
        currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
        currentSessionId = ctx.sessionManager.getSessionId();
    }
    catch (error) {
        sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    return {
        content: [
            {
                type: "text",
                text: buildDoctorReport({
                    cwd: requestCwd,
                    config: deps.config,
                    state: deps.state,
                    requestedSessionDir: params.sessionDir,
                    currentSessionFile,
                    currentSessionId,
                    sessionError,
                    expandTilde: deps.expandTilde,
                    ...(deps.getHeartbeatSummary ? { heartbeat: deps.getHeartbeatSummary() } : {}),
                }),
            },
        ],
        details: { mode: "management", results: [] },
    };
}
function executeStatusAction(params, ctx, deps) {
    const targetRunId = params.id;
    const sessionRoots = trustedSessionRootsForStatus(ctx, deps);
    if (params.view === "fleet") {
        return inspectSubagentStatus(buildRunStatusParams(params), {
            state: deps.state,
            sessionRoots,
        });
    }
    if (targetRunId) {
        try {
            const resolved = resolveSubagentRunId(targetRunId, { state: deps.state });
            if (resolved?.kind === "foreground") {
                const foreground = getForegroundControl(deps.state, resolved.id);
                if (foreground) {
                    if (params.view === "transcript") {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Live foreground status transcript is already visible in the expanded running subagent result. The canonical session becomes inspectable after the foreground run completes when sessions are enabled; this view is not the optional _transcript.jsonl diagnostic artifact.",
                                },
                            ],
                            details: { mode: "management", results: [] },
                        };
                    }
                    return foregroundStatusResult(foreground);
                }
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: message }],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
    }
    else {
        const foreground = getForegroundControl(deps.state, undefined);
        if (foreground && params.view !== "transcript")
            return foregroundStatusResult(foreground);
        if (foreground && params.view === "transcript") {
            return {
                content: [
                    {
                        type: "text",
                        text: "Live foreground status transcript is already visible in the expanded running subagent result. Pass an async run id to inspect a background status transcript; neither view is the optional _transcript.jsonl diagnostic artifact.",
                    },
                ],
                details: { mode: "management", results: [] },
            };
        }
    }
    return inspectSubagentStatus(buildRunStatusParams(params), {
        state: deps.state,
        sessionRoots,
    });
}
async function executeSteerAction(params, ctx, deps) {
    deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
    const privateProjectLookup = lookupPrivateProjectActionReference(params);
    if (privateProjectLookup.status === "ambiguous")
        return {
            content: [
                {
                    type: "text",
                    text: projectRunAuthorizationError(`the requested run id is ambiguous in the retained project-agent registry (${privateProjectLookup.runIds.join(", ")}). Provide a full run id.`).message,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    const message = (params.message ?? params.task ?? "").trim();
    if (!message)
        return {
            content: [{ type: "text", text: "action='steer' requires message." }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    const targetRunId = params.id;
    const retainedRunId = privateProjectLookup.status === "found" ? privateProjectLookup.runId : undefined;
    if (params.dir) {
        try {
            const location = resolveAsyncRunLocation(retainedRunId ? { ...params, id: retainedRunId } : params, ASYNC_DIR, RESULTS_DIR);
            const runId = retainedRunId ??
                location.resolvedId ??
                targetRunId ??
                path.basename(location.asyncDir ?? params.dir);
            await authorizeProjectSteerTarget({
                params: { ...params, id: runId, dir: location.asyncDir ?? params.dir },
                lookup: privateProjectLookup,
                ctx,
                deps,
            });
            return steerAsyncRun({
                state: deps.state,
                runId,
                message,
                index: params.index,
                kill: deps.kill,
                location,
                projectLookup: privateProjectLookup,
            });
        }
        catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text }],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
    }
    if (!targetRunId)
        return {
            content: [{ type: "text", text: "action='steer' requires id or dir." }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    let resolved;
    try {
        resolved = resolveSubagentRunId(retainedRunId ?? targetRunId, { state: deps.state });
    }
    catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    if (privateProjectLookup.status === "found" && resolved?.kind !== "async")
        return {
            content: [
                {
                    type: "text",
                    text: projectRunAuthorizationError("the retained project-agent run is not an async control target.").message,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    if (resolved?.kind === "nested") {
        if (privateProjectLookup.status === "missing" &&
            hasProjectAgentControlMarker(resolved.match.run))
            return {
                content: [
                    {
                        type: "text",
                        text: projectRunAuthorizationError("the nested target carries a project-agent marker, but its process-private reference is unavailable; refusing nested control fallback.").message,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        return steerNestedRun({ target: resolved, message, index: params.index });
    }
    if (resolved?.kind === "foreground")
        return {
            content: [
                {
                    type: "text",
                    text: "action='steer' currently supports live async Pi child sessions only; use action='interrupt' or action='resume' for foreground runs.",
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    if (resolved?.kind !== "async")
        return {
            content: [{ type: "text", text: `No async run found for '${targetRunId}'.` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    try {
        await authorizeProjectSteerTarget({
            params: { ...params, ...(retainedRunId ? { id: retainedRunId } : {}) },
            lookup: privateProjectLookup,
            ctx,
            deps,
        });
    }
    catch (error) {
        return {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    return steerAsyncRun({
        state: deps.state,
        runId: resolved.id,
        message,
        index: params.index,
        kill: deps.kill,
        location: resolved.location,
        projectLookup: privateProjectLookup,
    });
}
async function executeInterruptAction(params, ctx, deps) {
    deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
    const requestedProjectLookup = lookupPrivateProjectActionReference(params);
    if (requestedProjectLookup.status === "ambiguous") {
        return {
            content: [
                {
                    type: "text",
                    text: projectRunAuthorizationError(`the requested run id is ambiguous in the retained project-agent registry (${requestedProjectLookup.runIds.join(", ")}). Provide a full run id.`).message,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const targetRunId = params.id;
    const rememberedPaused = resolveRememberedForegroundRun(params, deps.state);
    if (rememberedPaused?.child.status === "paused" &&
        rememberedPaused.child.pause &&
        !getForegroundControl(deps.state, rememberedPaused.run.runId)) {
        const pausedAsyncDir = pausedForegroundStatusPath(rememberedPaused.run.runId);
        if (fs.existsSync(pausedAsyncDir)) {
            const projectResolutionError = projectInterruptResolutionMismatch(requestedProjectLookup, rememberedPaused.run.runId);
            if (projectResolutionError)
                return projectInterruptAuthorizationResult(projectResolutionError);
            try {
                await authorizeProjectInterruptTarget({
                    params: { ...params, id: rememberedPaused.run.runId },
                    lookup: requestedProjectLookup,
                    ctx,
                    deps,
                });
            }
            catch (error) {
                return {
                    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                    isError: true,
                    details: { mode: "management", results: [] },
                };
            }
            return cancelPersistedPausedForegroundRun(deps.state, pausedAsyncDir, rememberedPaused.run.runId, rememberedPaused.index);
        }
    }
    let resolved;
    let selectedParams = params;
    try {
        const selected = selectInterruptTarget(params, deps.state);
        resolved = selected.target;
        selectedParams = selected.params;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: message }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const privateProjectLookup = targetRunId || params.dir
        ? requestedProjectLookup
        : lookupPrivateProjectActionReference(selectedParams);
    if (privateProjectLookup.status === "ambiguous") {
        return {
            content: [
                {
                    type: "text",
                    text: projectRunAuthorizationError(`the selected run id is ambiguous in the retained project-agent registry (${privateProjectLookup.runIds.join(", ")}). Provide a full run id.`).message,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const projectResolutionError = projectInterruptResolutionMismatch(privateProjectLookup, resolved?.id);
    if (projectResolutionError)
        return projectInterruptAuthorizationResult(projectResolutionError);
    let asyncInterruptTarget = resolved?.kind === "async" ? resolved : undefined;
    let asyncInterruptParams = selectedParams;
    let asyncInterruptLookup = privateProjectLookup;
    if (resolved?.kind === "nested") {
        if (hasMalformedProjectAgentControlMarker(resolved.match.run) ||
            (privateProjectLookup.status === "missing" &&
                hasProjectAgentControlMarker(resolved.match.run))) {
            return {
                content: [
                    {
                        type: "text",
                        text: projectRunAuthorizationError("the nested target carries a malformed or unavailable project-agent marker; refusing nested interrupt fallback.").message,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        if (privateProjectLookup.status === "found" && resolved.match.run.projectAgent) {
            try {
                privateProjectCaptureForTarget(privateProjectLookup, {
                    runId: resolved.id,
                    agent: resolved.match.run.agent ?? resolved.match.run.projectAgent.provenance.agent,
                    projectAgent: resolved.match.run.projectAgent,
                });
            }
            catch (error) {
                return {
                    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                    isError: true,
                    details: { mode: "management", results: [] },
                };
            }
        }
        return interruptNestedRun(resolved);
    }
    if (resolved?.kind === "foreground") {
        const foregroundRun = deps.state.foregroundRuns?.get(resolved.id);
        const foregroundProjectChildren = (foregroundRun?.children ?? []).filter((child) => child.projectAgent !== undefined);
        if (foregroundProjectChildren.length > 0 && privateProjectLookup.status === "missing") {
            return {
                content: [
                    {
                        type: "text",
                        text: projectRunAuthorizationError("the foreground target carries a project-agent marker, but its process-private reference is unavailable; refusing interrupt fallback.").message,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        if (foregroundProjectChildren.length > 0 && privateProjectLookup.status === "found") {
            try {
                for (const foregroundChild of foregroundProjectChildren) {
                    privateProjectCaptureForTarget(privateProjectLookup, {
                        runId: resolved.id,
                        agent: foregroundChild.agent,
                        projectAgent: foregroundChild.projectAgent,
                    });
                }
            }
            catch (error) {
                return {
                    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                    isError: true,
                    details: { mode: "management", results: [] },
                };
            }
        }
        const foreground = getForegroundControl(deps.state, resolved.id);
        if (foreground) {
            if (requestForegroundInterrupt(foreground)) {
                return {
                    content: [
                        { type: "text", text: `Interrupt requested for foreground run ${foreground.runId}.` },
                    ],
                    details: { mode: "management", results: [] },
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `Foreground run ${foreground.runId} has no active child step to interrupt.`,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        const asyncTarget = getAsyncInterruptTarget(deps.state, resolved.id);
        if (asyncTarget) {
            asyncInterruptTarget = resolvedAsyncInterruptTarget(asyncTarget);
            asyncInterruptParams = {
                ...selectedParams,
                id: asyncInterruptTarget.id,
                dir: asyncTarget.asyncDir,
            };
            asyncInterruptLookup = lookupPrivateProjectActionReference(asyncInterruptParams);
            if (asyncInterruptLookup.status === "ambiguous") {
                return {
                    content: [
                        {
                            type: "text",
                            text: projectRunAuthorizationError(`the selected async run id is ambiguous in the retained project-agent registry (${asyncInterruptLookup.runIds.join(", ")}). Provide a full run id.`).message,
                        },
                    ],
                    isError: true,
                    details: { mode: "management", results: [] },
                };
            }
            const asyncProjectResolutionError = projectInterruptResolutionMismatch(asyncInterruptLookup, asyncInterruptTarget.id);
            if (asyncProjectResolutionError)
                return projectInterruptAuthorizationResult(asyncProjectResolutionError);
        }
        else {
            const pausedAsyncDir = pausedForegroundStatusPath(resolved.id);
            const persistedStatus = readStatus(pausedAsyncDir);
            if (persistedStatus?.state === "paused" ||
                persistedStatus?.state === "continued" ||
                persistedStatus?.state === "cancelled") {
                return cancelPersistedPausedForegroundRun(deps.state, pausedAsyncDir, resolved.id, params.index);
            }
        }
    }
    if (asyncInterruptTarget) {
        const selectedAsyncJob = deps.state.asyncJobs.get(asyncInterruptTarget.id);
        if (asyncInterruptLookup.status === "missing" &&
            hasInMemoryProjectAgentCapture(selectedAsyncJob)) {
            return projectInterruptAuthorizationResult(projectRunAuthorizationError("the selected async run carries a project-agent marker, but its process-private reference is unavailable; refusing interrupt fallback."));
        }
        try {
            await authorizeProjectInterruptTarget({
                params: asyncInterruptParams,
                lookup: asyncInterruptLookup,
                ctx,
                deps,
            });
        }
        catch (error) {
            return {
                content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
    }
    if (asyncInterruptTarget &&
        resolved?.kind === "async" &&
        targetRunId?.trim() &&
        asyncInterruptTarget.location.asyncDir) {
        const persistedStatus = readStatus(asyncInterruptTarget.location.asyncDir);
        if (persistedStatus?.state === "paused" ||
            persistedStatus?.state === "continued" ||
            persistedStatus?.state === "cancelled") {
            return cancelPersistedPausedForegroundRun(deps.state, asyncInterruptTarget.location.asyncDir, asyncInterruptTarget.id, params.index);
        }
    }
    const asyncInterruptResult = asyncInterruptTarget
        ? interruptAsyncRun(deps.state, asyncInterruptTarget.id, deps.kill, asyncInterruptTarget.location)
        : null;
    if (asyncInterruptResult)
        return asyncInterruptResult;
    return {
        content: [{ type: "text", text: "No interrupt-capable run found in this session." }],
        isError: true,
        details: { mode: "management", results: [] },
    };
}
export function createSubagentExecutor(deps) {
    const configuredArtifactConfig = deps.artifactConfig ?? resolveArtifactConfig(deps.config.artifacts);
    const executionPolicy = deps.executionPolicy ?? resolveExecutionPolicy(deps.config.execution);
    const execute = async (_id, params, signal, onUpdate, ctx) => {
        deps.state.baseCwd = ctx.cwd;
        deps.state.foregroundRuns ??= new Map();
        deps.state.foregroundControls ??= new Map();
        deps.state.lastForegroundControlId ??= null;
        const requestParams = params;
        const requestCwd = resolveRequestedCwd(ctx.cwd, requestParams.cwd);
        const paramsWithResolvedCwd = requestParams.cwd === undefined ? requestParams : { ...requestParams, cwd: requestCwd };
        const retiredControlDetail = retiredExecutionControlError(paramsWithResolvedCwd);
        if (retiredControlDetail)
            return buildRequestedModeError(paramsWithResolvedCwd, retiredControlDetail);
        const unsupportedSavedChainDetail = unsupportedSavedChainInput(paramsWithResolvedCwd);
        if (unsupportedSavedChainDetail)
            return unsupportedSavedChainInputResult(paramsWithResolvedCwd, unsupportedSavedChainDetail);
        const action = paramsWithResolvedCwd.action;
        if (action) {
            if (action === "doctor")
                return executeDoctorAction(paramsWithResolvedCwd, requestCwd, ctx, deps);
            if (action === "status")
                return executeStatusAction(paramsWithResolvedCwd, ctx, deps);
            if (action === "resume") {
                return resumeAsyncRun({
                    params: paramsWithResolvedCwd,
                    requestCwd,
                    ctx,
                    deps,
                    artifactConfig: {
                        ...configuredArtifactConfig,
                        enabled: paramsWithResolvedCwd.artifacts !== false,
                    },
                    executionPolicy,
                });
            }
            if (action === "steer")
                return executeSteerAction(paramsWithResolvedCwd, ctx, deps);
            if (action === "interrupt")
                return executeInterruptAction(paramsWithResolvedCwd, ctx, deps);
            if (!SUBAGENT_ACTIONS.includes(action)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Unknown action: ${action}. Valid: ${SUBAGENT_ACTIONS.join(", ")}`,
                        },
                    ],
                    isError: true,
                    details: { mode: "management", results: [] },
                };
            }
            return handleManagementAction(action, buildManagementActionParams(paramsWithResolvedCwd), {
                ...ctx,
                cwd: requestCwd,
                config: deps.config,
            });
        }
        const { blocked, depth, maxDepth } = checkSubagentDepth(deps.config.maxSubagentDepth);
        if (blocked) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Nested subagent call blocked (depth=${depth}, max=${maxDepth}). ` +
                            "You are running at the maximum subagent nesting depth. " +
                            "Complete your current task directly without delegating to further subagents.",
                    },
                ],
                isError: true,
                details: { mode: "single", results: [] },
            };
        }
        const normalized = normalizeRepeatedParallelCounts(paramsWithResolvedCwd);
        if (normalized.error)
            return normalized.error;
        const normalizedParams = normalized.params;
        let effectiveParams = normalizedParams;
        const runTimeoutMs = executionPolicy.maxRunTimeMs === false ? undefined : executionPolicy.maxRunTimeMs;
        const runToolBudget = resolveToolBudget(effectiveParams.toolBudget, "toolBudget");
        if (runToolBudget.error)
            return buildRequestedModeError(effectiveParams, runToolBudget.error);
        const scope = resolveExecutionAgentScope(effectiveParams.agentScope);
        const requestedExecutionCwd = effectiveParams.cwd ?? ctx.cwd;
        const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
        deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
        const projectResolution = resolveProjectAgentExecution(effectiveParams, requestedExecutionCwd, scope, deps.state.currentSessionId, deps);
        if ("error" in projectResolution) {
            return toExecutionErrorResult(effectiveParams, new Error(projectResolution.error));
        }
        effectiveParams = applyProjectAgentOpenRouterModel(projectResolution.params, projectResolution.projectAgentCaptures, ctx.model);
        const effectiveCwd = projectResolution.effectiveCwd;
        const discovered = projectResolution.discovered;
        const discoveredAgents = discovered.agents;
        const modelScope = discovered.modelScope;
        const agents = discoveredAgents;
        const runId = randomUUID().slice(0, 8);
        const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
        const nestedParentAddress = inheritedNestedRoute
            ? resolveNestedParentAddressFromEnv()
            : undefined;
        const nestedRoute = inheritedNestedRoute;
        const shareEnabled = effectiveParams.share === true;
        const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;
        const hasSingle = !hasTasks && Boolean(effectiveParams.agent);
        const validationError = validateExecutionInput(effectiveParams, agents, discovered.agentDiagnostics, hasTasks, hasSingle);
        if (validationError)
            return validationError;
        const requestedAsync = effectiveParams.async ?? false;
        const effectiveAsync = requestedAsync;
        const controlConfig = resolveControlConfig(deps.config.control, effectiveParams.control);
        const artifactConfig = {
            ...configuredArtifactConfig,
            enabled: effectiveParams.artifacts !== false,
        };
        const artifactsDir = getArtifactsDir(parentSessionFile);
        let sessionRoot;
        if (effectiveParams.sessionDir) {
            sessionRoot = path.resolve(deps.expandTilde(effectiveParams.sessionDir));
        }
        else {
            const baseSessionRoot = deps.getSubagentSessionRoot(parentSessionFile);
            sessionRoot = path.join(baseSessionRoot, runId);
        }
        try {
            fs.mkdirSync(sessionRoot, { recursive: true });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return toExecutionErrorResult(effectiveParams, new Error(`Failed to create session directory '${sessionRoot}': ${message}`));
        }
        const sessionDirForIndex = (idx) => path.join(sessionRoot, `run-${idx ?? 0}`);
        const childSessionFileForTask = (_agentName, idx) => path.join(sessionDirForIndex(idx), "session.jsonl");
        const childSessionFileForIndex = (idx) => path.join(sessionDirForIndex(idx), "session.jsonl");
        let projectRunRetained = false;
        if (!effectiveAsync && projectResolution.projectAgentCaptures?.length) {
            try {
                retainProjectAgentRunReference(projectResolution.projectAgentCapability, runId, projectResolution.projectAgentCaptures);
                projectRunRetained = true;
            }
            catch (error) {
                return toExecutionErrorResult(effectiveParams, new Error(`TLH project-agent run retention failed: ${error instanceof Error ? error.message : String(error)}`));
            }
        }
        const releaseTerminalProjectRun = (result) => {
            if (projectRunRetained &&
                !result.details?.results.some((child) => child.pause || child.interrupted)) {
                const releaseTimer = setTimeout(() => releaseProjectAgentRunReference(runId), PROJECT_AGENT_TERMINAL_RETENTION_MS);
                releaseTimer.unref?.();
                projectRunRetained = false;
            }
            return result;
        };
        const onUpdateWithContext = onUpdate;
        const foregroundMode = hasTasks ? "parallel" : "single";
        const execData = {
            params: effectiveParams,
            effectiveCwd,
            ctx,
            signal,
            onUpdate: onUpdateWithContext,
            agents,
            ...(projectResolution.projectAgentCapability
                ? { projectAgentCapability: projectResolution.projectAgentCapability }
                : {}),
            ...(projectResolution.projectAgentCaptures
                ? { projectAgentCaptures: projectResolution.projectAgentCaptures }
                : {}),
            runId,
            shareEnabled,
            sessionRoot,
            sessionDirForIndex,
            sessionFileForIndex: childSessionFileForIndex,
            sessionFileForTask: childSessionFileForTask,
            artifactConfig,
            artifactsDir,
            effectiveAsync,
            controlConfig,
            nestedRoute,
            timeoutMs: runTimeoutMs,
            toolBudget: runToolBudget.toolBudget,
            modelScope,
            runSync: deps.runSync,
        };
        const foregroundControl = effectiveAsync
            ? undefined
            : {
                runId,
                mode: foregroundMode,
                startedAt: Date.now(),
                updatedAt: Date.now(),
                currentAgent: undefined,
                currentIndex: undefined,
                currentActivityState: undefined,
                nestedRoute,
                interrupt: undefined,
            };
        if (foregroundControl) {
            deps.state.foregroundControls.set(runId, foregroundControl);
            deps.state.lastForegroundControlId = runId;
        }
        const writeNestedForegroundEvent = (type, result) => {
            if (!inheritedNestedRoute || !nestedParentAddress)
                return;
            const now = Date.now();
            const details = result?.details;
            const state = type === "subagent.nested.started"
                ? "running"
                : result?.isError || details?.results.some((child) => child.exitCode !== 0)
                    ? "failed"
                    : details?.results.some((child) => child.interrupted)
                        ? "paused"
                        : "complete";
            const errorText = result?.isError
                ? result.content.find((item) => item.type === "text")?.text
                : undefined;
            const agentsForSummary = hasTasks && effectiveParams.tasks
                ? effectiveParams.tasks.map((task) => task.agent)
                : effectiveParams.agent
                    ? [effectiveParams.agent]
                    : [];
            try {
                writeNestedEvent(inheritedNestedRoute, {
                    type,
                    ts: now,
                    parentRunId: nestedParentAddress.parentRunId,
                    parentStepIndex: nestedParentAddress.parentStepIndex,
                    child: {
                        id: runId,
                        parentRunId: nestedParentAddress.parentRunId,
                        parentStepIndex: nestedParentAddress.parentStepIndex,
                        depth: nestedParentAddress.depth,
                        path: nestedParentAddress.path,
                        cwd: effectiveCwd,
                        ownerState: state === "running" ? "live" : "gone",
                        mode: foregroundMode,
                        state,
                        agent: agentsForSummary[0],
                        ...(details?.results[0]?.projectAgent
                            ? { projectAgent: details.results[0].projectAgent }
                            : {}),
                        agents: agentsForSummary,
                        startedAt: foregroundControl?.startedAt ?? now,
                        ...(state !== "running" ? { endedAt: now } : {}),
                        lastUpdate: now,
                        ...(details?.totalCost ? { totalCost: details.totalCost } : {}),
                        ...(errorText ? { error: errorText } : {}),
                        ...(details?.results.length
                            ? {
                                steps: details.results.map((child) => ({
                                    agent: child.agent,
                                    ...(child.projectAgent ? { projectAgent: child.projectAgent } : {}),
                                    status: child.interrupted
                                        ? "paused"
                                        : child.exitCode === 0
                                            ? "complete"
                                            : "failed",
                                    ...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
                                    ...(child.error ? { error: child.error } : {}),
                                    ...(child.contextUsage ? { contextUsage: child.contextUsage } : {}),
                                    ...(child.terminationReason
                                        ? { terminationReason: child.terminationReason }
                                        : {}),
                                })),
                            }
                            : {}),
                    },
                });
            }
            catch (error) {
                console.error("Failed to emit nested foreground status event:", error);
            }
        };
        let nestedForegroundStarted = false;
        try {
            const asyncResult = runAsyncPath(execData, deps);
            if (asyncResult)
                return asyncResult;
            if (foregroundControl) {
                writeNestedForegroundEvent("subagent.nested.started");
                nestedForegroundStarted = true;
            }
            if (hasTasks && effectiveParams.tasks) {
                const result = await runParallelPath(execData, deps);
                writeNestedForegroundEvent("subagent.nested.completed", result);
                return releaseTerminalProjectRun(result);
            }
            if (hasSingle) {
                const result = await runSinglePath(execData, deps);
                writeNestedForegroundEvent("subagent.nested.completed", result);
                return releaseTerminalProjectRun(result);
            }
        }
        catch (error) {
            if (projectRunRetained) {
                releaseProjectAgentRunReference(runId);
                projectRunRetained = false;
            }
            const errorResult = toExecutionErrorResult(effectiveParams, error);
            if (nestedForegroundStarted)
                writeNestedForegroundEvent("subagent.nested.completed", errorResult);
            return errorResult;
        }
        finally {
            if (foregroundControl) {
                clearPendingForegroundControlNotices(deps.state, runId);
                deps.state.foregroundControls.delete(runId);
                if (deps.state.lastForegroundControlId === runId) {
                    deps.state.lastForegroundControlId = null;
                }
            }
        }
        if (projectRunRetained) {
            releaseProjectAgentRunReference(runId);
            projectRunRetained = false;
        }
        return {
            content: [{ type: "text", text: "Invalid params" }],
            isError: true,
            details: { mode: "single", results: [] },
        };
    };
    const executeWithSingleDispatchGuard = async (id, params, signal, onUpdate, ctx) => {
        const requestParams = params;
        if (requestParams.action)
            return execute(id, requestParams, signal, onUpdate, ctx);
        if (deps.state.subagentInProgress === true)
            return duplicateSubagentCallResult(requestParams);
        deps.state.subagentInProgress = true;
        try {
            return await execute(id, requestParams, signal, onUpdate, ctx);
        }
        finally {
            deps.state.subagentInProgress = false;
        }
    };
    return { execute: executeWithSingleDispatchGuard };
}
