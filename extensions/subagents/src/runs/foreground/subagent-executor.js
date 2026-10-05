import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_AGENT_TERMINAL_RETENTION_MS, retainProjectAgentRunReference, releaseProjectAgentRunReference, } from "../../agents/project-agent-snapshot.js";
import { getArtifactsDir, resolveArtifactConfig } from "../../shared/artifacts.js";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.js";
import { handleManagementAction } from "../../agents/agent-management.js";
import { buildDoctorReport } from "../../extension/doctor.js";
import { clearPendingForegroundControlNotices } from "../../extension/control-notices.js";
import { buildParallelModeError, runParallelPath, runSinglePath, toExecutionErrorResult, } from "./execution-paths.js";
import { authorizeProjectInterruptTarget, authorizeProjectSteerTarget, buildManagementActionParams, buildRunStatusParams, buildResumeModelResolution, cancelPersistedPausedForegroundRun, clearForegroundMessageInbox, foregroundStatusResult, getAsyncInterruptTarget, getForegroundControl, getRequestedModeLabel, interruptAsyncRun, readModelRegistrySnapshot, registerForegroundMessageInbox, requestForegroundInterrupt, requestInterruptAllRunningSubagentRuns, projectInterruptAuthorizationResult, projectInterruptResolutionMismatch, resolveRememberedForegroundRun, resolveSingleRunOutputBaseDir, resolvedAsyncInterruptTarget, selectInterruptTarget, steerAsyncRun, unknownAgentMessage, trimRememberedForegroundRuns, providerFallbackModelsForTarget, resumeAsyncRun, unsupportedSavedChainInput, unsupportedSavedChainInputResult, } from "./foreground-control.js";
import { hasInMemoryProjectAgentCapture, isRecordValue, lookupPrivateProjectActionReference, normalizeProjectAgentAccess, privateProjectCaptureForTarget, projectAgentEntryIdentityError, projectRunAuthorizationError, resolveProjectAgentExecution, } from "./project-agent-control.js";
export { buildResumeModelResolution, clearForegroundMessageInbox, normalizeProjectAgentAccess, projectAgentEntryIdentityError, registerForegroundMessageInbox, trimRememberedForegroundRuns, requestInterruptAllRunningSubagentRuns, };
import { pausedForegroundStatusPath } from "./foreground-pause-state.js";
import { resolveSubagentModelOverride } from "../shared/model-fallback.js";
import { resolveExecutionPolicy, } from "../../agents/execution-ceiling.js";
import { executeAsyncParallel, executeAsyncSingle, isAsyncAvailable, } from "../background/async-execution.js";
import { resolveCurrentSessionId } from "../../shared/session-identity.js";
import { resolveControlConfig } from "../shared/subagent-control.js";
import { normalizeSingleOutputOverride } from "../shared/single-output.js";
import { readStatus } from "../../shared/utils.js";
import { retiredNestedLaunchError } from "../shared/pi-args.js";
import { resolveSubagentRunId } from "../background/run-id-resolver.js";
import { inspectSubagentStatus } from "../background/run-status.js";
import { SUBAGENT_ACTIONS, checkSubagentDepth, resolveTopLevelParallelConcurrency, resolveTopLevelParallelMaxTasks, resolveChildMaxSubagentDepth, resolveCurrentMaxSubagentDepth, } from "../../shared/types.js";
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
function retiredExecutionControlError(params) {
    const input = params;
    const topLevelGuidance = {
        timeoutMs: "Configure `execution.maxRunTimeMs` in `<agent-dir>/extensions/subagent/config.json`; caller-selected execution timeouts are no longer supported. Restart with a new direct run after removing `timeoutMs`.",
        concurrency: "Configure `parallel.concurrency` in `<agent-dir>/extensions/subagent/config.json`; per-call concurrency is no longer supported.",
        fallbackModels: "Configure fallbackModels in the agent definition; per-call fallback selection is no longer supported.",
        includeProgress: "Progress is tracked automatically and is not a caller-controlled execution option.",
        skills: "Configure skills in the agent definition; per-call skill selection is no longer supported.",
        skill: "Configure skills in the agent definition; per-call skill selection is no longer supported.",
        share: "Session publishing is retired; ordinary session persistence remains automatic.",
        acceptance: "Acceptance is inferred from the agent definition and persisted continuation contract.",
        toolBudget: "Configure toolBudget in the agent definition; per-call budgets are no longer supported.",
        control: "Configure control in the isolated extension config; per-call control is no longer supported.",
        sessionDir: "Session directories are managed internally; per-call sessionDir is no longer supported.",
        maxOutput: "Output bounds are managed internally; per-call maxOutput is no longer supported.",
        dir: "Run directories are resolved internally; public dir selectors are no longer supported.",
        view: "Status views are no longer caller-selectable; use the default status output.",
        lines: "Status line limits are no longer caller-selectable; use the default status output.",
    };
    for (const [key, guidance] of Object.entries(topLevelGuidance)) {
        if (Object.hasOwn(input, key))
            return `${key} is no longer supported. ${guidance}`;
    }
    if (Array.isArray(input.tasks)) {
        for (const [index, rawTask] of input.tasks.entries()) {
            if (!isRecordValue(rawTask))
                continue;
            const taskPrefix = `tasks[${index}]`;
            const taskGuidance = {
                skills: "Configure skills in the agent definition; per-task skill selection is no longer supported.",
                skill: "Configure skills in the agent definition; per-task skill selection is no longer supported.",
                share: "Session publishing is retired; ordinary session persistence remains automatic.",
                acceptance: "Acceptance is inferred from the agent definition and persisted continuation contract.",
                toolBudget: "Configure toolBudget in the agent definition; per-task budgets are no longer supported.",
                control: "Configure control in the isolated extension config; per-task control is no longer supported.",
                sessionDir: "Session directories are managed internally; per-task sessionDir is no longer supported.",
                maxOutput: "Output bounds are managed internally; per-task maxOutput is no longer supported.",
                dir: "Run directories are resolved internally; public dir selectors are no longer supported.",
                view: "Status views are no longer caller-selectable; use the default status output.",
                lines: "Status line limits are no longer caller-selectable; use the default status output.",
            };
            for (const [key, guidance] of Object.entries(taskGuidance)) {
                if (Object.hasOwn(rawTask, key))
                    return `${taskPrefix}.${key} is no longer supported. ${guidance}`;
            }
            if (Object.hasOwn(rawTask, "timeoutMs")) {
                return `${taskPrefix}.timeoutMs is no longer supported. Configure execution.maxRunTimeMs in <agent-dir>/extensions/subagent/config.json; caller-selected execution timeouts are no longer supported. Restart with a new direct run after removing timeoutMs.`;
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
function buildRequestedModeError(params, message) {
    return {
        content: [{ type: "text", text: message }],
        isError: true,
        details: { mode: getRequestedModeLabel(params), results: [] },
    };
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
function runAsyncPath(data, deps) {
    const { params, effectiveCwd, agents, ctx, sessionRoot, sessionFileForTask, artifactConfig, artifactsDir, effectiveAsync, controlConfig, } = data;
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
        }));
        return releaseAsyncProjectRunOnError(executeAsyncParallel(id, {
            tasks: parallelTasks,
            concurrency: resolveTopLevelParallelConcurrency(deps.config.parallel?.concurrency),
            agents,
            ctx: asyncCtx,
            availableModels,
            modelRegistry: modelRegistrySnapshot.evidence,
            cwd: effectiveCwd,
            artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
            artifactConfig,
            sessionRoot,
            sessionFilesByFlatIndex: params.tasks.map((task, index) => sessionFileForTask(task.agent, index)),
            maxSubagentDepth: currentMaxSubagentDepth,
            controlConfig,
            telemetryProvenance: data.telemetryProvenance,
            telemetryLineage: data.telemetryLineage,
            timeoutMs: data.timeoutMs,
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
        const skills = a.skills;
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
            artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
            artifactConfig,
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
            telemetryProvenance: data.telemetryProvenance,
            telemetryLineage: data.telemetryLineage,
            timeoutMs: data.timeoutMs,
            projectAgent: data.projectAgentCaptures?.find((capture) => capture.provenance.agent === params.agent),
        }));
    }
    if (projectRunRetained) {
        releaseProjectAgentRunReference(id);
        projectRunRetained = false;
    }
    return null;
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
                    currentSessionFile,
                    currentSessionId,
                    sessionError,
                }),
            },
        ],
        details: { mode: "management", results: [] },
    };
}
function executeStatusAction(params, _ctx, deps) {
    if (params.id) {
        try {
            const resolved = resolveSubagentRunId(params.id, { state: deps.state });
            if (resolved?.kind === "foreground") {
                const foreground = getForegroundControl(deps.state, resolved.id);
                if (foreground)
                    return foregroundStatusResult(foreground);
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
        if (foreground)
            return foregroundStatusResult(foreground);
    }
    return inspectSubagentStatus(buildRunStatusParams(params), { state: deps.state });
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
    if (!targetRunId)
        return {
            content: [{ type: "text", text: "action='steer' requires id." }],
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
function isPersistedCancellationState(status) {
    return (status?.state === "paused" || status?.state === "continued" || status?.state === "cancelled");
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
    const privateProjectLookup = targetRunId
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
            if (isPersistedCancellationState(persistedStatus)) {
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
        if (isPersistedCancellationState(persistedStatus)) {
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
        const retiredNestedError = retiredNestedLaunchError(paramsWithResolvedCwd);
        if (retiredNestedError)
            return buildRequestedModeError(paramsWithResolvedCwd, retiredNestedError);
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
                        text: `Subagent dispatch blocked at the configured recursion depth (depth=${depth}, max=${maxDepth}). ` +
                            "You are running at the maximum supported child depth. " +
                            "Complete your current task directly without delegating further.",
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
        const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;
        const hasSingle = !hasTasks && Boolean(effectiveParams.agent);
        const validationError = validateExecutionInput(effectiveParams, agents, discovered.agentDiagnostics, hasTasks, hasSingle);
        if (validationError)
            return validationError;
        const requestedAsync = effectiveParams.async ?? false;
        const effectiveAsync = requestedAsync;
        const controlConfig = resolveControlConfig(deps.config.control);
        const artifactConfig = {
            ...configuredArtifactConfig,
            enabled: effectiveParams.artifacts !== false,
        };
        const artifactsDir = getArtifactsDir(parentSessionFile);
        const baseSessionRoot = deps.getSubagentSessionRoot(parentSessionFile);
        const sessionRoot = path.join(baseSessionRoot, runId);
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
        const runStartedAt = Date.now();
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
            sessionRoot,
            sessionDirForIndex,
            sessionFileForIndex: childSessionFileForIndex,
            sessionFileForTask: childSessionFileForTask,
            artifactConfig,
            artifactsDir,
            effectiveAsync,
            controlConfig,
            telemetryProvenance: deps.telemetryProvenance,
            startedAt: runStartedAt,
            timeoutMs: runTimeoutMs,
            modelScope,
            runSync: deps.runSync,
        };
        const foregroundControl = effectiveAsync
            ? undefined
            : {
                runId,
                mode: foregroundMode,
                startedAt: runStartedAt,
                updatedAt: runStartedAt,
                currentAgent: undefined,
                currentIndex: undefined,
                currentActivityState: undefined,
                interrupt: undefined,
            };
        if (foregroundControl) {
            deps.state.foregroundControls.set(runId, foregroundControl);
            deps.state.lastForegroundControlId = runId;
        }
        try {
            const asyncResult = runAsyncPath(execData, deps);
            if (asyncResult)
                return asyncResult;
            if (hasTasks && effectiveParams.tasks) {
                const result = await runParallelPath(execData, deps);
                return releaseTerminalProjectRun(result);
            }
            if (hasSingle) {
                const result = await runSinglePath(execData, deps);
                return releaseTerminalProjectRun(result);
            }
        }
        catch (error) {
            if (projectRunRetained) {
                releaseProjectAgentRunReference(runId);
                projectRunRetained = false;
            }
            const errorResult = toExecutionErrorResult(effectiveParams, error);
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
