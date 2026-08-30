import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { applyThinkingSuffix, getThinkingLevelDropNote, validatePiToolPolicy, } from "../shared/pi-args.js";
import { injectOutputPathSystemPrompt, injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode, } from "../shared/single-output.js";
import { buildChainInstructions, isParallelStep, resolveStepBehavior, suppressProgressForReadOnlyTask, writeInitialProgressFile, } from "../../shared/settings.js";
import { isParallelGroup, } from "../shared/parallel-utils.js";
import { resolvePiPackageRoot } from "../shared/pi-spawn.js";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.js";
import { remainingExecutionTimeMs } from "../../agents/execution-ceiling.js";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV, resolveChildCwd } from "../../shared/utils.js";
import { buildFallbackModelList, buildModelCandidatePlan, canonicalSubagentModelIdentity, modelReferenceFromIdentity, resolveSubagentModelOverride, } from "../shared/model-fallback.js";
import { resolveEffectiveThinking } from "../../shared/model-info.js";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.js";
import { ChainOutputValidationError, validateChainOutputBindings, } from "../shared/chain-outputs.js";
import { createStructuredOutputRuntime } from "../shared/structured-output.js";
import { mergeContinuationAcceptance, resolveEffectiveAcceptance, validateAcceptanceInput, validateDispatchAcceptanceInput, } from "../shared/acceptance.js";
import { ASYNC_DIR, RESULTS_DIR, SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION, TEMP_ROOT_DIR, getAsyncConfigPath, resolveChildMaxSubagentDepth, } from "../../shared/types.js";
import { nestedResultsPath, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv, writeNestedEvent, } from "../shared/nested-events.js";
import { initialTurnBudgetState } from "../shared/turn-budget.js";
import { parseContextPressureCrossedThresholds, parseContextPressureProjection, parseContextUsageDiagnostics, } from "../../shared/context-diagnostics.js";
import { validateToolBudgetConfig } from "../shared/tool-budget.js";
import { detectTkTicketId, normalizeTkTicketMetadata, resolveTkTicketMetadata, resolveTkTicketTaskContext, } from "../shared/tk-ticket.js";
import { isCanonicalPackagedMinorAgent } from "../../../../shared/project-agent-guidance.js";
const piPackageRoot = resolvePiPackageRoot();
export function formatAsyncStartedMessage(headline) {
    return headline;
}
function resolveAsyncRunnerModulePath(moduleUrl = import.meta.url) {
    const modulePath = fileURLToPath(moduleUrl);
    const runnerExtension = path.extname(modulePath) === ".ts" ? ".ts" : ".js";
    return path.join(path.dirname(modulePath), `subagent-runner${runnerExtension}`);
}
export function isAsyncAvailable() {
    return fs.existsSync(resolveAsyncRunnerModulePath());
}
function isNodeExecutableName(execPath) {
    const basename = path.basename(execPath).toLowerCase();
    return (basename === "node" ||
        basename === "node.exe" ||
        basename === "nodejs" ||
        basename === "nodejs.exe");
}
function canUseCurrentNodeExecutable(execPath) {
    try {
        fs.accessSync(execPath, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function resolveAsyncRunnerNodeCommand() {
    if (isNodeExecutableName(process.execPath) && canUseCurrentNodeExecutable(process.execPath)) {
        return process.execPath;
    }
    return process.platform === "win32" ? "node.exe" : "node";
}
export function resolveAsyncRunnerLogPaths(cfg) {
    const asyncDir = typeof cfg.asyncDir === "string" ? cfg.asyncDir : undefined;
    if (!asyncDir)
        return undefined;
    return {
        stdoutPath: path.join(asyncDir, "runner.stdout.log"),
        stderrPath: path.join(asyncDir, "runner.stderr.log"),
    };
}
function closeFd(fd) {
    if (fd === undefined)
        return;
    try {
        fs.closeSync(fd);
    }
    catch {
    }
}
function spawnRunner(cfg, suffix, cwd) {
    const runner = resolveAsyncRunnerModulePath();
    if (!fs.existsSync(runner)) {
        return { error: `async runner module could not be found: ${runner}` };
    }
    try {
        const cwdStats = fs.statSync(cwd);
        if (!cwdStats.isDirectory()) {
            return { error: `cwd is not a directory: ${cwd}` };
        }
    }
    catch {
        return { error: `cwd does not exist: ${cwd}` };
    }
    fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
    const cfgPath = getAsyncConfigPath(suffix);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const nodeCommand = resolveAsyncRunnerNodeCommand();
    const runnerArgs = runner.endsWith(".ts")
        ? ["--experimental-strip-types", runner, cfgPath]
        : [runner, cfgPath];
    const logPaths = resolveAsyncRunnerLogPaths(cfg);
    let stdoutFd;
    let stderrFd;
    try {
        if (logPaths) {
            fs.mkdirSync(path.dirname(logPaths.stdoutPath), { recursive: true });
            stdoutFd = fs.openSync(logPaths.stdoutPath, "a");
            stderrFd = fs.openSync(logPaths.stderrPath, "a");
        }
        const proc = spawn(nodeCommand, runnerArgs, {
            cwd,
            detached: true,
            stdio: ["ignore", stdoutFd ?? "ignore", stderrFd ?? "ignore"],
            windowsHide: true,
            env: {
                ...process.env,
                ...(piPackageRoot ? { [PI_CODING_AGENT_PACKAGE_ROOT_ENV]: piPackageRoot } : {}),
            },
        });
        closeFd(stdoutFd);
        closeFd(stderrFd);
        proc.on("error", (error) => {
            console.error(`[pi-subagents] async spawn failed: ${error.message}`);
        });
        if (typeof proc.pid !== "number") {
            return { error: `async runner did not produce a pid for cwd: ${cwd}` };
        }
        proc.unref();
        return { pid: proc.pid };
    }
    catch (error) {
        closeFd(stdoutFd);
        closeFd(stderrFd);
        return { error: error instanceof Error ? error.message : String(error) };
    }
}
function formatAsyncStartError(mode, message) {
    return {
        content: [{ type: "text", text: message }],
        isError: true,
        details: { mode, results: [] },
    };
}
function resolveEffectiveSingleTimeout(callerTimeoutMs, agentTimeoutCeilingMs) {
    if (callerTimeoutMs === undefined)
        return agentTimeoutCeilingMs;
    if (agentTimeoutCeilingMs === undefined)
        return callerTimeoutMs;
    return Math.min(callerTimeoutMs, agentTimeoutCeilingMs);
}
const UNAVAILABLE_SUBAGENT_SKILL_ERROR = "Skills not found: pi-subagents";
class UnavailableSubagentSkillError extends Error {
}
class AsyncStartValidationError extends Error {
}
function appendThinkingDropNote(notes, droppedModels, model, thinking, replaceExisting, options) {
    const note = getThinkingLevelDropNote(model, thinking, replaceExisting, options);
    if (!note)
        return;
    if (!notes.includes(note))
        notes.push(note);
    if (model && !droppedModels.includes(model))
        droppedModels.push(model);
}
function dedupeRunnerAttemptNotes(steps) {
    const emitted = new Set();
    const dedupe = (step) => {
        if (!step.attemptNotes || step.attemptNotes.length === 0)
            return step;
        const attemptNotes = step.attemptNotes.filter((note) => {
            if (emitted.has(note))
                return false;
            emitted.add(note);
            return true;
        });
        return attemptNotes.length > 0
            ? { ...step, attemptNotes }
            : { ...step, attemptNotes: undefined };
    };
    return steps.map((step) => {
        if (isParallelGroup(step))
            return { ...step, parallel: step.parallel.map(dedupe) };
        return dedupe(step);
    });
}
function validateAsyncExecutionAcceptance(params) {
    const errors = [];
    if ("chain" in params) {
        for (const [stepIndex, step] of params.chain.entries()) {
            errors.push(...validateAcceptanceInput(step.acceptance, `chain[${stepIndex}].acceptance`));
            errors.push(...validateDispatchAcceptanceInput(step.acceptance, `chain[${stepIndex}].acceptance`));
            if (isParallelStep(step)) {
                for (const [taskIndex, task] of step.parallel.entries()) {
                    errors.push(...validateAcceptanceInput(task.acceptance, `chain[${stepIndex}].parallel[${taskIndex}].acceptance`));
                    errors.push(...validateDispatchAcceptanceInput(task.acceptance, `chain[${stepIndex}].parallel[${taskIndex}].acceptance`));
                }
            }
        }
        return errors;
    }
    errors.push(...validateAcceptanceInput(params.acceptance, "acceptance"));
    errors.push(...validateDispatchAcceptanceInput(params.acceptance, "acceptance"));
    return errors;
}
export function buildAsyncRunnerSteps(id, params) {
    const { chain, agents, ctx, cwd, sessionFilesByFlatIndex, thinkingOverridesByFlatIndex, maxSubagentDepth, asyncDir, } = params;
    const outputBaseDir = params.outputBaseDir;
    const resultMode = params.resultMode ?? "chain";
    const availableModels = params.availableModels;
    const thinkingSuffixOptions = {
        availableModels,
        preferredModelProvider: ctx.currentModelProvider,
    };
    const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
    const progressDir = params.progressDir ?? runnerCwd;
    const graphChain = chain;
    const firstStep = chain[0];
    const originalTask = params.task ??
        (firstStep
            ? isParallelStep(firstStep)
                ? firstStep.parallel[0]?.task
                : firstStep.task
            : undefined);
    try {
        if (params.validateOutputBindings !== false) {
            validateChainOutputBindings(chain);
        }
    }
    catch (error) {
        if (error instanceof ChainOutputValidationError)
            return { error: error.message };
        throw error;
    }
    const workflowGraph = buildWorkflowGraphSnapshot({
        runId: id,
        mode: resultMode,
        steps: graphChain,
    });
    for (const s of chain) {
        const stepAgents = isParallelStep(s)
            ? s.parallel.map((t) => t.agent)
            : [s.agent];
        for (const agentName of stepAgents) {
            if (!agents.find((x) => x.name === agentName)) {
                return { error: `Unknown agent: ${agentName}` };
            }
        }
    }
    let progressInstructionCreated = false;
    const buildStepOverrides = (s) => ({
        ...(s.output !== undefined ? { output: s.output } : {}),
        ...(s.outputMode !== undefined ? { outputMode: s.outputMode } : {}),
        ...(s.reads !== undefined ? { reads: s.reads } : {}),
        ...(s.progress !== undefined ? { progress: s.progress } : {}),
        ...(s.model ? { model: s.model } : {}),
        ...(s.fallbackModels ? { fallbackModels: s.fallbackModels } : {}),
        ...(s.modelFallbackNotice ? { modelFallbackNotice: s.modelFallbackNotice } : {}),
    });
    const buildSeqStep = (s, sessionFile, behaviorCwd, progressPrecreated = false, resolvedBehavior, flatIndex) => {
        const a = agents.find((x) => x.name === s.agent);
        const toolBudgetInput = s.toolBudget ?? params.toolBudget ?? a.toolBudget;
        const resolvedToolBudget = validateToolBudgetConfig(toolBudgetInput, s.toolBudget ? "toolBudget" : a.toolBudget ? "agent.toolBudget" : "toolBudget");
        if (resolvedToolBudget.error)
            throw new AsyncStartValidationError(resolvedToolBudget.error);
        const stepCwd = resolveChildCwd(runnerCwd, s.cwd);
        const instructionCwd = behaviorCwd ?? stepCwd;
        const behavior = suppressProgressForReadOnlyTask(resolvedBehavior ?? resolveStepBehavior(a, buildStepOverrides(s)), s.task, originalTask);
        const skillNames = behavior.skills === false ? [] : behavior.skills;
        const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, stepCwd, ctx.cwd);
        if (missingSkills.includes("pi-subagents"))
            throw new UnavailableSubagentSkillError(UNAVAILABLE_SUBAGENT_SKILL_ERROR);
        const toolPolicyError = validatePiToolPolicy({
            tools: a.tools,
            requireReadTool: a.inheritSkills || resolvedSkills.length > 0,
        });
        if (toolPolicyError)
            throw new AsyncStartValidationError(toolPolicyError);
        let systemPrompt = a.systemPrompt?.trim() ?? "";
        if (resolvedSkills.length > 0) {
            const injection = buildSkillInjection(resolvedSkills);
            systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
        }
        const readInstructions = buildChainInstructions({ ...behavior, output: false, progress: false }, instructionCwd, false);
        const isFirstProgressAgent = behavior.progress && !progressPrecreated && !progressInstructionCreated;
        if (behavior.progress)
            progressInstructionCreated = true;
        const progressInstructions = buildChainInstructions({ ...behavior, output: false, reads: false }, progressDir, isFirstProgressAgent);
        const outputPath = resolveSingleOutputPath(behavior.output, ctx.cwd, instructionCwd, outputBaseDir);
        systemPrompt = injectOutputPathSystemPrompt(systemPrompt, outputPath);
        const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Async step (${s.agent})`);
        if (validationError)
            throw new AsyncStartValidationError(validationError);
        let taskTemplate = s.task ?? "{previous}";
        taskTemplate = taskTemplate.replace(/\{task\}/g, originalTask ?? "");
        taskTemplate = taskTemplate.replace(/\{chain_dir\}/g, runnerCwd);
        const task = injectSingleOutputInstruction(`${readInstructions.prefix}${taskTemplate}${progressInstructions.suffix}`, outputPath);
        const requestedModel = behavior.model ?? a.model;
        const primaryModel = resolveSubagentModelOverride(requestedModel, ctx.currentModel, availableModels, ctx.currentModelProvider, { scope: ctx.modelScope, source: behavior.model ? "explicit" : "inherited" });
        const fallbackModels = buildFallbackModelList(behavior.fallbackModels, a.fallbackModels);
        const thinkingOverride = flatIndex === undefined ? undefined : thinkingOverridesByFlatIndex?.[flatIndex];
        const effectiveThinking = thinkingOverride !== undefined ? thinkingOverride : a.thinking;
        const attemptNotes = [];
        const thinkingDroppedModels = [];
        appendThinkingDropNote(attemptNotes, thinkingDroppedModels, primaryModel, effectiveThinking, thinkingOverride !== undefined, thinkingSuffixOptions);
        const model = applyThinkingSuffix(primaryModel, effectiveThinking, thinkingOverride !== undefined, thinkingSuffixOptions);
        const primaryThinkingDropped = Boolean(getThinkingLevelDropNote(primaryModel, effectiveThinking, thinkingOverride !== undefined, thinkingSuffixOptions));
        const modelIdentity = canonicalSubagentModelIdentity(model, primaryThinkingDropped ? undefined : resolveEffectiveThinking(model, effectiveThinking));
        const modelThinking = modelIdentity?.thinking ??
            (modelIdentity ? undefined : resolveEffectiveThinking(model, effectiveThinking));
        const candidatePlan = buildModelCandidatePlan(primaryModel, fallbackModels, availableModels, ctx.currentModelProvider, { scope: ctx.modelScope, registry: params.modelRegistry });
        const modelCandidates = candidatePlan.candidates
            .map((candidate) => {
            appendThinkingDropNote(attemptNotes, thinkingDroppedModels, candidate, effectiveThinking, thinkingOverride !== undefined, thinkingSuffixOptions);
            return applyThinkingSuffix(candidate, effectiveThinking, thinkingOverride !== undefined, thinkingSuffixOptions);
        })
            .filter((candidate) => candidate !== undefined);
        const projectAgent = params.projectAgentCaptures?.find((capture) => capture.provenance.agent === s.agent);
        return {
            parentSessionId: ctx.parentSessionId ?? ctx.currentSessionId,
            ...(projectAgent ? { projectAgent } : {}),
            agent: s.agent,
            projectAgentGuidance: isCanonicalPackagedMinorAgent(a),
            task,
            phase: s.phase,
            label: s.label,
            outputName: s.as,
            structured: Boolean(s.outputSchema),
            cwd: stepCwd,
            model,
            thinking: modelThinking,
            ...(modelIdentity ? { modelIdentity } : {}),
            modelCandidates,
            contextWindows: Object.fromEntries((availableModels ?? [])
                .filter((candidate) => typeof candidate.contextWindow === "number" && candidate.contextWindow > 0)
                .map((candidate) => [candidate.fullId, candidate.contextWindow])),
            ...(attemptNotes.length > 0 ? { attemptNotes } : {}),
            ...(thinkingDroppedModels.length > 0 ? { thinkingDroppedModels } : {}),
            ...(candidatePlan.filteringNotice
                ? { modelFallbackFilterNotice: candidatePlan.filteringNotice }
                : {}),
            modelFallbackNotice: behavior.modelFallbackNotice,
            tools: a.tools,
            extensions: a.extensions,
            subagentOnlyExtensions: a.subagentOnlyExtensions,
            completionGuard: a.completionGuard,
            systemPrompt,
            systemPromptMode: a.systemPromptMode,
            inheritProjectContext: a.inheritProjectContext,
            inheritSkills: a.inheritSkills,
            skills: resolvedSkills.map((r) => r.name),
            outputPath,
            outputMode: behavior.outputMode,
            sessionFile,
            maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, a.maxSubagentDepth),
            effectiveAcceptance: resolveEffectiveAcceptance({
                explicit: s.acceptance,
                agentName: s.agent,
                acceptanceRole: a.acceptanceRole,
                task,
                mode: resultMode,
                async: true,
            }),
            acceptanceInput: s.acceptance,
            acceptanceRole: a.acceptanceRole,
            ...(s.outputSchema ? { structuredOutputSchema: s.outputSchema } : {}),
            ...(s.outputSchema
                ? {
                    structuredOutput: createStructuredOutputRuntime(s.outputSchema, path.join(asyncDir, "structured-output")),
                }
                : {}),
            ...(resolvedToolBudget.budget ? { toolBudget: resolvedToolBudget.budget } : {}),
            ...(a.maxExecutionTimeMs !== undefined &&
                (params.timeoutMs === undefined || a.maxExecutionTimeMs < params.timeoutMs)
                ? { timeoutMs: a.maxExecutionTimeMs }
                : {}),
        };
    };
    let flatStepIndex = 0;
    const nextFlatStep = () => {
        const index = flatStepIndex;
        const sessionFile = sessionFilesByFlatIndex?.[flatStepIndex];
        const thinkingOverride = thinkingOverridesByFlatIndex?.[flatStepIndex];
        flatStepIndex++;
        return {
            index,
            ...(sessionFile ? { sessionFile } : {}),
            ...(thinkingOverride !== undefined ? { thinkingOverride } : {}),
        };
    };
    try {
        const builtSteps = chain.map((s) => {
            if (isParallelStep(s)) {
                const parallelBehaviors = s.parallel.map((task) => {
                    const agent = agents.find((candidate) => candidate.name === task.agent);
                    return suppressProgressForReadOnlyTask(resolveStepBehavior(agent, buildStepOverrides(task)), task.task, originalTask);
                });
                const progressPrecreated = parallelBehaviors.some((behavior) => behavior.progress);
                if (progressPrecreated) {
                    writeInitialProgressFile(progressDir);
                    progressInstructionCreated = true;
                }
                return {
                    parallel: s.parallel.map((t, taskIndex) => {
                        const staticStep = nextFlatStep();
                        return buildSeqStep(t, staticStep.sessionFile, undefined, progressPrecreated, parallelBehaviors[taskIndex], staticStep.index);
                    }),
                    concurrency: s.concurrency,
                    failFast: s.failFast,
                };
            }
            const staticStep = nextFlatStep();
            return buildSeqStep(s, staticStep.sessionFile, undefined, false, undefined, staticStep.index);
        });
        return {
            steps: dedupeRunnerAttemptNotes(builtSteps),
            runnerCwd,
            workflowGraph,
            eventChain: graphChain,
            ...(originalTask !== undefined ? { originalTask } : {}),
        };
    }
    catch (error) {
        if (error instanceof UnavailableSubagentSkillError ||
            error instanceof AsyncStartValidationError)
            return { error: error.message };
        throw error;
    }
}
export function executeAsyncChain(id, params) {
    const { chain, agents, ctx, cwd, maxOutput, artifactsDir, artifactConfig, shareEnabled, sessionRoot, sessionFilesByFlatIndex, thinkingOverridesByFlatIndex, maxSubagentDepth, controlConfig, controlIntercomTarget, childIntercomTarget, nestedRoute, } = params;
    const resultMode = params.resultMode ?? "chain";
    const acceptanceErrors = validateAsyncExecutionAcceptance({ chain });
    if (acceptanceErrors.length > 0)
        return formatAsyncStartError(resultMode, acceptanceErrors.join(" "));
    const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
    const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
    const asyncDir = inheritedNestedRoute
        ? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
        : path.join(ASYNC_DIR, id);
    try {
        fs.mkdirSync(asyncDir, { recursive: true });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [
                { type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` },
            ],
            isError: true,
            details: { mode: resultMode, results: [] },
        };
    }
    const built = buildAsyncRunnerSteps(id, {
        chain,
        task: params.task,
        resultMode,
        agents,
        ctx,
        availableModels: params.availableModels,
        modelRegistry: params.modelRegistry,
        cwd,
        sessionFilesByFlatIndex,
        thinkingOverridesByFlatIndex,
        progressDir: params.progressDir ??
            (artifactsDir
                ? path.join(artifactsDir, "progress", id)
                : resultMode === "parallel"
                    ? path.join(asyncDir, "progress")
                    : undefined),
        outputBaseDir: artifactsDir ? path.join(artifactsDir, "outputs", id) : undefined,
        maxSubagentDepth,
        asyncDir,
        timeoutMs: params.timeoutMs,
        toolBudget: params.toolBudget,
        projectAgentCaptures: params.projectAgentCaptures,
    });
    if ("error" in built) {
        try {
            fs.rmSync(asyncDir, { recursive: true, force: true });
        }
        catch {
        }
        return formatAsyncStartError(resultMode, built.error);
    }
    const { steps, runnerCwd, workflowGraph, eventChain } = built;
    const ticketTasks = chain.flatMap((step) => {
        if (isParallelStep(step))
            return step.parallel;
        return [step];
    });
    const tkTicketContext = resolveTkTicketTaskContext({
        topLevelTask: params.task,
        runnerCwd,
        tasks: ticketTasks,
    });
    const tkTicket = tkTicketContext
        ? resolveTkTicketMetadata(tkTicketContext.task, { cwd: tkTicketContext.cwd })
        : undefined;
    const deadlineAt = params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined;
    const initialTurnBudget = params.turnBudget
        ? initialTurnBudgetState(params.turnBudget)
        : undefined;
    let childTargetIndex = 0;
    const childIntercomTargets = childIntercomTarget
        ? steps.flatMap((step) => {
            if ("parallel" in step) {
                if (!Array.isArray(step.parallel)) {
                    childTargetIndex++;
                    return [undefined];
                }
                return step.parallel.map((task) => childIntercomTarget(task.agent, childTargetIndex++));
            }
            return [childIntercomTarget(step.agent, childTargetIndex++)];
        })
        : undefined;
    const projectAgents = [
        ...new Map(params.projectAgentCaptures?.map((capture) => [capture.provenance.agent, capture]) ?? []).values(),
    ];
    let spawnResult;
    try {
        spawnResult = spawnRunner({
            id,
            steps,
            resultPath: inheritedNestedRoute
                ? nestedResultsPath(inheritedNestedRoute.rootRunId, id)
                : path.join(RESULTS_DIR, `${id}.json`),
            cwd: runnerCwd,
            placeholder: "{previous}",
            maxOutput,
            artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
            artifactConfig,
            share: shareEnabled,
            sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
            asyncDir,
            sessionId: ctx.currentSessionId,
            piPackageRoot,
            piArgv1: process.argv[1],
            controlConfig,
            turnBudget: params.turnBudget,
            toolBudget: params.toolBudget,
            controlIntercomTarget,
            childIntercomTargets,
            resultMode,
            timeoutMs: params.timeoutMs,
            deadlineAt,
            workflowGraph,
            tkTicket,
            nestedRoute: nestedRoute ?? inheritedNestedRoute,
            ...(projectAgents.length > 0 ? { projectAgents } : {}),
            nestedSelf: inheritedNestedRoute && nestedAddress
                ? {
                    parentRunId: nestedAddress.parentRunId,
                    parentStepIndex: nestedAddress.parentStepIndex,
                    depth: nestedAddress.depth,
                    path: nestedAddress.path,
                }
                : undefined,
        }, id, runnerCwd);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${message}`);
    }
    if (spawnResult.error) {
        return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${spawnResult.error}`);
    }
    if (spawnResult.pid) {
        const eventFirstStep = eventChain[0];
        const firstAgents = isParallelStep(eventFirstStep)
            ? eventFirstStep.parallel.map((t) => t.agent)
            : [eventFirstStep.agent];
        const parallelGroups = [];
        const flatAgents = [];
        let flatStepStart = 0;
        for (let stepIndex = 0; stepIndex < eventChain.length; stepIndex++) {
            const step = eventChain[stepIndex];
            if (isParallelStep(step)) {
                parallelGroups.push({ start: flatStepStart, count: step.parallel.length, stepIndex });
                flatAgents.push(...step.parallel.map((task) => task.agent));
                flatStepStart += step.parallel.length;
            }
            else {
                flatAgents.push(step.agent);
                flatStepStart++;
            }
        }
        if (inheritedNestedRoute && nestedAddress) {
            const now = Date.now();
            try {
                writeNestedEvent(inheritedNestedRoute, {
                    type: "subagent.nested.started",
                    ts: now,
                    parentRunId: nestedAddress.parentRunId,
                    parentStepIndex: nestedAddress.parentStepIndex,
                    child: {
                        id,
                        parentRunId: nestedAddress.parentRunId,
                        parentStepIndex: nestedAddress.parentStepIndex,
                        depth: nestedAddress.depth,
                        path: nestedAddress.path,
                        cwd: runnerCwd,
                        asyncDir,
                        pid: spawnResult.pid,
                        ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
                        leafIntercomTarget: childIntercomTargets?.[0],
                        intercomTarget: childIntercomTargets?.[0],
                        ownerState: "live",
                        mode: resultMode,
                        state: "running",
                        agent: firstAgents[0],
                        agents: flatAgents,
                        chainStepCount: eventChain.length,
                        parallelGroups,
                        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}),
                        ...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
                        startedAt: now,
                        lastUpdate: now,
                    },
                });
            }
            catch (error) {
                console.error("Failed to emit nested async start event:", error);
            }
        }
        ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
            lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
            id,
            pid: spawnResult.pid,
            sessionId: ctx.currentSessionId,
            mode: resultMode,
            agent: firstAgents[0],
            agents: flatAgents,
            task: isParallelStep(eventFirstStep)
                ? eventFirstStep.parallel[0]?.task?.slice(0, 50)
                : eventFirstStep.task?.slice(0, 50),
            chain: eventChain.map((s) => isParallelStep(s)
                ? `[${s.parallel.map((t) => t.agent).join("+")}]`
                : s.agent),
            chainStepCount: eventChain.length,
            parallelGroups,
            workflowGraph,
            cwd: runnerCwd,
            asyncDir,
            ...(tkTicket ? { tkTicket } : {}),
            ...(projectAgents.length > 0 ? { projectAgents } : {}),
            ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}),
            ...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
            nestedRoute,
        });
    }
    const chainDesc = chain
        .map((s) => isParallelStep(s)
        ? `[${s.parallel.map((t) => t.agent).join("+")}]`
        : s.agent)
        .join(" -> ");
    return {
        content: [
            {
                type: "text",
                text: formatAsyncStartedMessage(`Async ${resultMode}: ${chainDesc} [${id}]`),
            },
        ],
        details: {
            mode: resultMode,
            runId: id,
            results: [],
            asyncId: id,
            asyncDir,
            workflowGraph,
            ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}),
            ...(params.turnBudget ? { turnBudget: params.turnBudget } : {}),
            ...(params.toolBudget ? { toolBudget: params.toolBudget } : {}),
        },
    };
}
export function executeAsyncSingle(id, params) {
    const { agent, agentConfig, ctx, cwd, maxOutput, artifactsDir, artifactConfig, shareEnabled, sessionRoot, sessionFile, maxSubagentDepth, controlConfig, controlIntercomTarget, childIntercomTarget, nestedRoute, } = params;
    const task = params.task ?? "";
    const acceptanceErrors = validateAsyncExecutionAcceptance({ acceptance: params.acceptance });
    if (acceptanceErrors.length > 0)
        return formatAsyncStartError("single", acceptanceErrors.join(" "));
    const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
    const skillNames = params.skills ?? agentConfig.skills ?? [];
    const availableModels = params.availableModels;
    const thinkingSuffixOptions = {
        availableModels,
        preferredModelProvider: ctx.currentModelProvider,
    };
    const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, runnerCwd, ctx.cwd);
    if (missingSkills.includes("pi-subagents"))
        return formatAsyncStartError("single", UNAVAILABLE_SUBAGENT_SKILL_ERROR);
    const toolPolicyError = validatePiToolPolicy({
        tools: agentConfig.tools,
        requireReadTool: agentConfig.inheritSkills || resolvedSkills.length > 0,
    });
    if (toolPolicyError)
        return formatAsyncStartError("single", toolPolicyError);
    let systemPrompt = agentConfig.systemPrompt?.trim() ?? "";
    if (resolvedSkills.length > 0) {
        const injection = buildSkillInjection(resolvedSkills);
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
    }
    const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
    const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
    const asyncDir = inheritedNestedRoute
        ? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
        : path.join(ASYNC_DIR, id);
    try {
        fs.mkdirSync(asyncDir, { recursive: true });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [
                { type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` },
            ],
            isError: true,
            details: { mode: "single", results: [] },
        };
    }
    const effectiveOutput = normalizeSingleOutputOverride(params.output, agentConfig.output);
    const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, runnerCwd, params.outputBaseDir ?? (artifactsDir ? path.join(artifactsDir, "outputs", id) : undefined));
    systemPrompt = injectOutputPathSystemPrompt(systemPrompt, outputPath);
    const outputMode = params.outputMode ?? "inline";
    const validationError = validateFileOnlyOutputMode(outputMode, outputPath, `Async single run (${agent})`);
    if (validationError)
        return formatAsyncStartError("single", validationError);
    const taskWithOutputInstruction = injectSingleOutputInstruction(task, outputPath);
    const durableResume = params.modelResolution !== undefined || params.restoredModelIdentity !== undefined;
    const explicitResumeModel = durableResume && typeof params.modelOverride === "string" && params.modelOverride.trim() !== ""
        ? params.modelOverride.trim() !== "inherit"
        : false;
    const restoringModel = Boolean(durableResume && !explicitResumeModel && params.restoredModelIdentity);
    const requestedPrimaryModel = restoringModel
        ? modelReferenceFromIdentity(params.restoredModelIdentity)
        : (params.modelOverride ?? agentConfig.model);
    const scopeWarnings = [];
    const primaryModel = resolveSubagentModelOverride(requestedPrimaryModel, ctx.currentModel, availableModels, ctx.currentModelProvider, durableResume
        ? {
            scope: ctx.modelScope,
            source: explicitResumeModel ? "explicit" : "inherited",
            onWarn: (violation) => scopeWarnings.push(violation.message),
        }
        : undefined);
    const fallbackModels = buildFallbackModelList(params.fallbackModels, agentConfig.fallbackModels);
    const effectiveThinking = restoringModel
        ? params.restoredModelIdentity?.thinking
        : (params.thinkingOverride ?? agentConfig.thinking);
    const replaceThinking = !restoringModel && params.thinkingOverride !== undefined;
    const attemptNotes = [];
    const thinkingDroppedModels = [];
    const primaryThinkingDropped = Boolean(getThinkingLevelDropNote(primaryModel, effectiveThinking, replaceThinking, thinkingSuffixOptions));
    appendThinkingDropNote(attemptNotes, thinkingDroppedModels, primaryModel, effectiveThinking, replaceThinking, thinkingSuffixOptions);
    const model = applyThinkingSuffix(primaryModel, effectiveThinking, replaceThinking, thinkingSuffixOptions);
    if (restoringModel &&
        availableModels &&
        availableModels.length > 0 &&
        params.restoredModelIdentity &&
        !availableModels.some((candidate) => candidate.fullId === primaryModel)) {
        attemptNotes.push(`Notice: Persisted model '${modelReferenceFromIdentity(params.restoredModelIdentity)}' was not present in the current model registry; retaining it so configured runtime fallback policy can apply.`);
    }
    const modelIdentity = canonicalSubagentModelIdentity(model, primaryThinkingDropped ? undefined : resolveEffectiveThinking(model, effectiveThinking));
    const candidatePlan = buildModelCandidatePlan(primaryModel, fallbackModels, availableModels, ctx.currentModelProvider, {
        scope: ctx.modelScope,
        registry: params.modelRegistry,
        ...(durableResume ? { onWarn: (violation) => scopeWarnings.push(violation.message) } : {}),
    });
    const modelCandidates = candidatePlan.candidates
        .map((candidate) => {
        appendThinkingDropNote(attemptNotes, thinkingDroppedModels, candidate, effectiveThinking, replaceThinking, thinkingSuffixOptions);
        return applyThinkingSuffix(candidate, effectiveThinking, replaceThinking, thinkingSuffixOptions);
    })
        .filter((candidate) => candidate !== undefined);
    const modelThinking = modelIdentity?.thinking ??
        (modelIdentity ? undefined : resolveEffectiveThinking(model, effectiveThinking));
    const modelResolution = params.modelResolution
        ? {
            ...params.modelResolution,
            ...(modelIdentity ? { resumed: modelIdentity } : {}),
            reason: [params.modelResolution.reason, ...scopeWarnings, ...attemptNotes].join(" "),
        }
        : undefined;
    const toolBudgetInput = params.toolBudget ?? agentConfig.toolBudget;
    const resolvedToolBudget = validateToolBudgetConfig(toolBudgetInput, params.toolBudget ? "toolBudget" : "agent.toolBudget");
    if (resolvedToolBudget.error)
        return formatAsyncStartError("single", resolvedToolBudget.error);
    const activeRuntimeMs = Math.max(0, params.activeRuntimeMs ?? 0);
    const remainingAgentTimeMs = remainingExecutionTimeMs(agentConfig.maxExecutionTimeMs, activeRuntimeMs);
    if (remainingAgentTimeMs === 0) {
        return formatAsyncStartError("single", `Agent '${agent}' has exhausted its maxExecutionTimeMs ceiling after ${activeRuntimeMs}ms of active runtime.`);
    }
    const effectiveTimeoutMs = resolveEffectiveSingleTimeout(params.timeoutMs, remainingAgentTimeMs);
    const deadlineAt = effectiveTimeoutMs !== undefined ? Date.now() + effectiveTimeoutMs : undefined;
    const tkTicket = detectTkTicketId(task)
        ? resolveTkTicketMetadata(task, { cwd: runnerCwd })
        : normalizeTkTicketMetadata(params.inheritedTkTicket);
    const initialTurnBudget = params.turnBudget
        ? initialTurnBudgetState(params.turnBudget)
        : undefined;
    let spawnResult;
    try {
        spawnResult = spawnRunner({
            id,
            steps: [
                {
                    parentSessionId: ctx.parentSessionId ?? ctx.currentSessionId,
                    ...(params.projectAgent ? { projectAgent: params.projectAgent } : {}),
                    agent,
                    projectAgentGuidance: isCanonicalPackagedMinorAgent(agentConfig),
                    task: taskWithOutputInstruction,
                    cwd: runnerCwd,
                    model,
                    thinking: modelThinking,
                    ...(modelIdentity ? { modelIdentity } : {}),
                    ...(modelResolution ? { modelResolution } : {}),
                    modelCandidates,
                    contextWindows: Object.fromEntries((availableModels ?? [])
                        .filter((candidate) => typeof candidate.contextWindow === "number" && candidate.contextWindow > 0)
                        .map((candidate) => [candidate.fullId, candidate.contextWindow])),
                    ...(attemptNotes.length > 0 ? { attemptNotes } : {}),
                    ...(thinkingDroppedModels.length > 0 ? { thinkingDroppedModels } : {}),
                    ...(candidatePlan.filteringNotice
                        ? { modelFallbackFilterNotice: candidatePlan.filteringNotice }
                        : {}),
                    modelFallbackNotice: params.modelFallbackNotice,
                    tools: agentConfig.tools,
                    extensions: agentConfig.extensions,
                    subagentOnlyExtensions: agentConfig.subagentOnlyExtensions,
                    completionGuard: agentConfig.completionGuard,
                    systemPrompt,
                    systemPromptMode: agentConfig.systemPromptMode,
                    inheritProjectContext: agentConfig.inheritProjectContext,
                    inheritSkills: agentConfig.inheritSkills,
                    skills: resolvedSkills.map((r) => r.name),
                    outputPath,
                    outputMode,
                    sessionFile,
                    ...(parseContextUsageDiagnostics(params.contextUsage)
                        ? { contextUsage: parseContextUsageDiagnostics(params.contextUsage) }
                        : {}),
                    ...(parseContextPressureProjection(params.contextPressure)
                        ? { contextPressure: parseContextPressureProjection(params.contextPressure) }
                        : {}),
                    ...(parseContextPressureCrossedThresholds(params.contextPressureCrossedThresholds)
                        ? {
                            contextPressureCrossedThresholds: parseContextPressureCrossedThresholds(params.contextPressureCrossedThresholds),
                        }
                        : {}),
                    maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, agentConfig.maxSubagentDepth),
                    effectiveAcceptance: params.continuationAcceptance
                        ? (mergeContinuationAcceptance(params.continuationAcceptance, params.acceptance) ??
                            params.continuationAcceptance)
                        : resolveEffectiveAcceptance({
                            explicit: params.acceptance,
                            agentName: agent,
                            acceptanceRole: agentConfig.acceptanceRole,
                            task,
                            mode: "single",
                            async: true,
                        }),
                    ...(resolvedToolBudget.budget ? { toolBudget: resolvedToolBudget.budget } : {}),
                    ...(activeRuntimeMs > 0 ? { activeRuntimeMs } : {}),
                },
            ],
            resultPath: inheritedNestedRoute
                ? nestedResultsPath(inheritedNestedRoute.rootRunId, id)
                : path.join(RESULTS_DIR, `${id}.json`),
            cwd: runnerCwd,
            placeholder: "{previous}",
            maxOutput,
            artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
            artifactConfig,
            share: shareEnabled,
            sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
            asyncDir,
            sessionId: ctx.currentSessionId,
            piPackageRoot,
            piArgv1: process.argv[1],
            controlConfig,
            timeoutMs: effectiveTimeoutMs,
            deadlineAt,
            turnBudget: params.turnBudget,
            toolBudget: params.toolBudget,
            controlIntercomTarget,
            childIntercomTargets: childIntercomTarget ? [childIntercomTarget(agent, 0)] : undefined,
            tkTicket,
            ...(params.projectAgent ? { projectAgents: [params.projectAgent] } : {}),
            ...(params.continuationSource ? { continuationSource: params.continuationSource } : {}),
            resultMode: "single",
            nestedRoute: nestedRoute ?? inheritedNestedRoute,
            nestedSelf: inheritedNestedRoute && nestedAddress
                ? {
                    parentRunId: nestedAddress.parentRunId,
                    parentStepIndex: nestedAddress.parentStepIndex,
                    depth: nestedAddress.depth,
                    path: nestedAddress.path,
                }
                : undefined,
        }, id, runnerCwd);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return formatAsyncStartError("single", `Failed to start async run '${id}': ${message}`);
    }
    if (spawnResult.error) {
        return formatAsyncStartError("single", `Failed to start async run '${id}': ${spawnResult.error}`);
    }
    if (spawnResult.pid) {
        if (inheritedNestedRoute && nestedAddress) {
            const now = Date.now();
            try {
                writeNestedEvent(inheritedNestedRoute, {
                    type: "subagent.nested.started",
                    ts: now,
                    parentRunId: nestedAddress.parentRunId,
                    parentStepIndex: nestedAddress.parentStepIndex,
                    child: {
                        id,
                        parentRunId: nestedAddress.parentRunId,
                        parentStepIndex: nestedAddress.parentStepIndex,
                        depth: nestedAddress.depth,
                        path: nestedAddress.path,
                        cwd: runnerCwd,
                        asyncDir,
                        pid: spawnResult.pid,
                        ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
                        leafIntercomTarget: childIntercomTarget?.(agent, 0),
                        intercomTarget: childIntercomTarget?.(agent, 0),
                        ownerState: "live",
                        mode: "single",
                        state: "running",
                        agent,
                        agents: [agent],
                        chainStepCount: 1,
                        ...(effectiveTimeoutMs !== undefined
                            ? { timeoutMs: effectiveTimeoutMs, deadlineAt }
                            : {}),
                        ...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
                        startedAt: now,
                        lastUpdate: now,
                    },
                });
            }
            catch (error) {
                console.error("Failed to emit nested async start event:", error);
            }
        }
        ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
            lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
            id,
            pid: spawnResult.pid,
            sessionId: ctx.currentSessionId,
            mode: "single",
            agent,
            task: task?.slice(0, 50),
            cwd: runnerCwd,
            asyncDir,
            ...(tkTicket ? { tkTicket } : {}),
            ...(params.projectAgent ? { projectAgents: [params.projectAgent] } : {}),
            ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs, deadlineAt } : {}),
            ...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
            nestedRoute,
        });
    }
    return {
        content: [{ type: "text", text: formatAsyncStartedMessage(`Async: ${agent} [${id}]`) }],
        details: {
            mode: "single",
            runId: id,
            results: [],
            asyncId: id,
            asyncDir,
            ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs, deadlineAt } : {}),
            ...(params.turnBudget ? { turnBudget: params.turnBudget } : {}),
            ...(params.toolBudget ? { toolBudget: params.toolBudget } : {}),
        },
    };
}
