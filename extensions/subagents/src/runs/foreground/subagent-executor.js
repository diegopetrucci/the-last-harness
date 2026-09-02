import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgentsWithProjectSnapshot, } from "../../agents/agents.js";
import { PROJECT_AGENT_DIRECTORY, PROJECT_AGENT_PACKAGE, resolveCanonicalGitWorktreeRoot, validateProjectAgentCwdContainment, } from "../../agents/project-agent-loader.js";
import { resolveProjectAgentSnapshot, createProjectAgentRunCapture, projectAgentRunCaptureEquals, PROJECT_AGENT_TERMINAL_RETENTION_MS, normalizeProjectAgentRunCapture, retainProjectAgentRunReference, retainProjectAgentRunReferenceFrom, releaseProjectAgentRunReference, resolveProjectAgentRunReference, lookupProjectAgentRunReference, } from "../../agents/project-agent-snapshot.js";
import { getArtifactsDir } from "../../shared/artifacts.js";
import { FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE, formatForegroundPauseMessage, formatForegroundSupervisorPauseMessage, UNCHANGED_SUPERVISOR_RESUME_MESSAGE, } from "../../shared/foreground-pause.js";
import { toModelInfo } from "../../shared/model-info.js";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.js";
import { handleManagementAction } from "../../agents/agent-management.js";
import { buildDoctorReport } from "../../extension/doctor.js";
import { clearPendingForegroundControlNotices } from "../../extension/control-notices.js";
import { runSync } from "./execution.js";
import { canonicalSubagentModelIdentity, modelReferenceFromIdentity, resolveSubagentModelOverride, sanitizeSubagentModelIdentity, sanitizeSubagentModelResolution, } from "../shared/model-fallback.js";
import { aggregateParallelOutputs } from "../shared/parallel-utils.js";
import { clearForegroundInterrupt, registerForegroundInterrupt, } from "../shared/foreground-interrupts.js";
import { buildExecutionInstructions, writeInitialProgressFile, resolveStepBehavior, suppressProgressForReadOnlyTask, } from "../../shared/settings.js";
import { normalizeSkillInput } from "../../agents/skills.js";
import { remainingExecutionTimeMs } from "../../agents/execution-ceiling.js";
import { executeAsyncParallel, executeAsyncSingle, formatAsyncStartedMessage, isAsyncAvailable, } from "../background/async-execution.js";
import { validateAcceptanceInput, validateDispatchAcceptanceInput } from "../shared/acceptance.js";
import { resolveCurrentSessionId } from "../../shared/session-identity.js";
import { formatControlNoticeMessage, resolveControlConfig, shouldNotifyControlEvent, } from "../shared/subagent-control.js";
import { validateToolBudgetConfig } from "../shared/tool-budget.js";
import { resolveTkTicketMetadata, resolveTkTicketTaskContext } from "../shared/tk-ticket.js";
import { finalizeSingleOutput, injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode, } from "../shared/single-output.js";
import { compactForegroundDetails, getSingleResultOutput, mapConcurrent, readStatus, resolveChildCwd, sumResultsCost, sumResultsUsage, } from "../../shared/utils.js";
import { DEFAULT_GLOBAL_CONCURRENCY_LIMIT, Semaphore } from "../shared/parallel-utils.js";
import { attachNestedChildrenToResultChildren, formatForegroundNativeSubagentResult, resolveSubagentResultStatus, } from "../../shared/result-formatting.js";
import { buildRevivedAsyncTask, resolveAsyncResumeTarget, resolveAsyncRunLocation, } from "../background/async-resume.js";
import { lifecycleContinuationForIndex, lifecycleGeneration, markLifecycleContinuationSpawned, recoverStaleLifecycleContinuationClaim, recoverStaleLifecycleContinuationStatus, transitionLifecycleStatus, withLifecycleContinuation, withLifecycleStatusLock, writeNormalizedLifecycleStatus, } from "../shared/lifecycle-state.js";
import { childMessageAckPath, deliverInterruptRequest, requestAsyncResume, requestAsyncSteer, waitForChildMessageAcceptance, } from "../background/control-channel.js";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.js";
import { attachRootChildrenToSteps, resolveInheritedNestedRouteFromEnv, resolveNestedAsyncDir, resolveNestedParentAddressFromEnv, updateForegroundNestedProjection, writeNestedEvent, } from "../shared/nested-events.js";
import { resolveSubagentRunId } from "../background/run-id-resolver.js";
import { assessDurableResumeContext, formatDurableResumeContextBlock, parseContextPressureCrossedThresholds, parseContextPressureProjection, parseContextUsageDiagnostics, resolveEffectiveContextWindow, } from "../../shared/context-diagnostics.js";
import { safeTerminalDocument, safeTerminalText } from "../../shared/display-text.js";
import { formatNestedRunStatusLines } from "../shared/nested-render.js";
import { inspectSubagentStatus } from "../background/run-status.js";
import { ASYNC_DIR, DEFAULT_ARTIFACT_CONFIG, RESULTS_DIR, SUBAGENT_ACTIONS, TEMP_ROOT_DIR, SUBAGENT_CONTROL_EVENT, checkSubagentDepth, resolveTopLevelParallelConcurrency, resolveTopLevelParallelMaxTasks, resolveChildMaxSubagentDepth, resolveCurrentMaxSubagentDepth, } from "../../shared/types.js";
const NESTED_ASYNC_RUNS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-runs");
const FOREGROUND_LIVE_MESSAGE_INBOXES_DIR = path.join(TEMP_ROOT_DIR, "foreground-live-message-inboxes");
function readModelRegistrySnapshot(ctx) {
    const optionalRegistry = ctx.modelRegistry;
    const availableModels = ctx.modelRegistry.getAvailable().map(toModelInfo);
    let allModels;
    let error;
    if (typeof optionalRegistry.getAll === "function") {
        try {
            allModels = optionalRegistry.getAll().map(toModelInfo);
        }
        catch {
            error = "model catalog unavailable";
        }
    }
    if (typeof optionalRegistry.getError === "function") {
        try {
            error ??= optionalRegistry.getError();
        }
        catch {
            error = "model availability status unavailable";
        }
    }
    return {
        availableModels,
        evidence: {
            ...(allModels ? { allModels } : {}),
            ...(error ? { error } : {}),
        },
    };
}
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
const EMBEDDED_PROJECT_AGENT_NAME_PATTERN = /^embedded\.[a-z0-9][a-z0-9-]*$/;
function isEmbeddedProjectAgentName(value) {
    return EMBEDDED_PROJECT_AGENT_NAME_PATTERN.test(value.trim());
}
function executionTargetIdentities(params) {
    const identities = [];
    const add = (value) => {
        if (typeof value !== "string" || value.length === 0)
            return;
        identities.push({ raw: value, normalized: value.trim() });
    };
    add(params.agent);
    for (const task of params.tasks ?? [])
        add(task.agent);
    return identities;
}
function executionTargetNames(params) {
    return [...new Set(executionTargetIdentities(params).map((identity) => identity.normalized))];
}
function projectExecutionError(message) {
    return { error: message };
}
function isRecordValue(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asProjectAgentCapability(value) {
    return value;
}
function isProjectAgentExpected(value) {
    return (typeof value.projectRoot === "string" &&
        value.projectRoot.trim().length > 0 &&
        typeof value.sessionId === "string" &&
        value.sessionId.trim().length > 0 &&
        typeof value.generationId === "string" &&
        value.generationId.trim().length > 0 &&
        typeof value.processInstanceId === "string" &&
        value.processInstanceId.trim().length > 0);
}
export function normalizeProjectAgentAccess(value) {
    if (!isRecordValue(value))
        return undefined;
    if (!isRecordValue(value.capability) || !isRecordValue(value.expected))
        return undefined;
    if (!isProjectAgentExpected(value.expected) || typeof value.architect !== "boolean") {
        return undefined;
    }
    const canInitiate = typeof value.canInitiate === "boolean" ? value.canInitiate : value.architect;
    return {
        capability: asProjectAgentCapability(value.capability),
        expected: value.expected,
        architect: value.architect,
        canInitiate,
        ...(typeof value.reauthorize === "function"
            ? { reauthorize: value.reauthorize }
            : {}),
        ...(typeof value.rebind === "function"
            ? {
                rebind: value.rebind,
            }
            : {}),
    };
}
export function projectAgentEntryIdentityError(projectRoot, entry) {
    const agent = entry.agent;
    const runtimeName = agent.name;
    if (!EMBEDDED_PROJECT_AGENT_NAME_PATTERN.test(runtimeName)) {
        return `runtime name '${runtimeName}' is not a valid embedded project-agent identity`;
    }
    const localName = runtimeName.slice("embedded.".length);
    if (agent.localName !== localName || agent.packageName !== PROJECT_AGENT_PACKAGE) {
        return `runtime name '${runtimeName}' does not match its embedded package/local identity`;
    }
    if (agent.source !== "project") {
        return `runtime name '${runtimeName}' is not sourced from the project snapshot`;
    }
    if (!Array.isArray(agent.tools) || agent.tools.length === 0) {
        return `project agent '${runtimeName}' does not carry an explicit usable tools list`;
    }
    if (agent.extensions !== undefined || agent.subagentOnlyExtensions !== undefined) {
        return `project agent '${runtimeName}' carries a prohibited extension surface`;
    }
    if (typeof agent.filePath !== "string" || !path.isAbsolute(agent.filePath)) {
        return `project agent '${runtimeName}' does not carry an absolute definition path`;
    }
    const expectedDirectory = path.join(projectRoot, PROJECT_AGENT_DIRECTORY);
    const expectedFileName = `${localName.toUpperCase()}.md`;
    if (path.dirname(agent.filePath) !== expectedDirectory ||
        path.basename(agent.filePath) !== expectedFileName) {
        return `project agent '${runtimeName}' definition path is not the canonical ${PROJECT_AGENT_DIRECTORY}/${expectedFileName} path`;
    }
    return undefined;
}
function projectAgentConfigMatches(left, right) {
    const stable = (value) => {
        if (Array.isArray(value))
            return `[${value.map(stable).join(",")}]`;
        if (isRecordValue(value)) {
            return `{${Object.keys(value)
                .filter((key) => value[key] !== undefined)
                .sort()
                .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
                .join(",")}}`;
        }
        return JSON.stringify(value);
    };
    try {
        return stable(left) === stable(right);
    }
    catch {
        return false;
    }
}
function resolveProjectAgentExecution(params, effectiveCwd, scope, sessionId, deps) {
    const targetIdentities = executionTargetIdentities(params);
    const embeddedTargets = [
        ...new Set(targetIdentities.map((identity) => identity.normalized).filter(isEmbeddedProjectAgentName)),
    ];
    const whitespaceEmbeddedTargets = targetIdentities.filter((identity) => identity.raw !== identity.normalized && isEmbeddedProjectAgentName(identity.normalized));
    if (whitespaceEmbeddedTargets.length > 0) {
        const details = whitespaceEmbeddedTargets
            .map((identity) => `'${identity.raw}' (use '${identity.normalized}')`)
            .join(", ");
        return projectExecutionError(`TLH project-agent execution rejected: target identity has surrounding whitespace: ${details}.`);
    }
    if (embeddedTargets.length === 0) {
        return {
            params,
            effectiveCwd,
            discovered: deps.discoverAgents(effectiveCwd, scope),
        };
    }
    const requestedScope = typeof params.agentScope === "string" ? params.agentScope.trim() : params.agentScope;
    if (params.agentScope !== undefined && requestedScope !== "" && requestedScope !== "project") {
        return projectExecutionError(`TLH project-agent execution requires agentScope: "project"; received '${String(requestedScope)}'.`);
    }
    let rawAccess;
    try {
        rawAccess = deps.getProjectAgentAccess?.({
            cwd: effectiveCwd,
            sessionId,
            targetNames: executionTargetNames(params),
        });
    }
    catch {
        return projectExecutionError("TLH project-agent execution was rejected: the active snapshot capability is unavailable.");
    }
    const access = normalizeProjectAgentAccess(rawAccess);
    if (!access) {
        return projectExecutionError("TLH project-agent execution was rejected: the active snapshot capability is unavailable or invalid.");
    }
    let manifest;
    try {
        manifest = resolveProjectAgentSnapshot(access.capability, access.expected);
    }
    catch {
        return projectExecutionError("TLH project-agent execution was rejected: the active snapshot capability is invalid.");
    }
    const manifestNames = new Set([
        ...manifest.entries.map((entry) => entry.agent.name),
        ...manifest.tombstones,
    ]);
    const missingTargets = embeddedTargets.filter((target) => !manifestNames.has(target));
    if (missingTargets.length > 0) {
        return projectExecutionError(`TLH project-agent execution is unavailable for ${missingTargets.join(", ")}; no matching active snapshot entry exists.`);
    }
    if (access.canInitiate !== true) {
        return projectExecutionError(`TLH project-agent execution requires the architect or disabled primary mode. Target(s): ${embeddedTargets.join(", ")}.`);
    }
    if (sessionId === null || sessionId !== manifest.provenance.sessionId) {
        return projectExecutionError("TLH project-agent execution was rejected because the active snapshot does not belong to this session.");
    }
    const cwdValidation = validateProjectAgentCwdContainment(manifest.provenance.projectRoot, effectiveCwd, (params.tasks ?? []).map((task) => task.cwd));
    if (!cwdValidation.valid) {
        return projectExecutionError(`TLH project-agent execution blocked: ${cwdValidation.reason}`);
    }
    const trustedRoot = resolveCanonicalGitWorktreeRoot(cwdValidation.canonicalCwd);
    const manifestRoot = resolveCanonicalGitWorktreeRoot(manifest.provenance.projectRoot);
    if (!trustedRoot ||
        !manifestRoot ||
        trustedRoot !== cwdValidation.canonicalRoot ||
        manifestRoot !== trustedRoot) {
        return projectExecutionError("TLH project-agent execution was rejected because the execution cwd is not in the trusted snapshot worktree.");
    }
    for (const [index, taskCwd] of cwdValidation.canonicalTaskCwds.entries()) {
        const taskRoot = resolveCanonicalGitWorktreeRoot(taskCwd);
        if (!taskRoot || taskRoot !== trustedRoot) {
            return projectExecutionError(`TLH project-agent execution blocked: task ${index + 1} cwd is not in the one trusted snapshot worktree.`);
        }
    }
    for (const target of embeddedTargets) {
        if (manifest.tombstones.includes(target)) {
            return projectExecutionError(`TLH project-agent execution is blocked for ${target}; the active snapshot tombstone prevents profile fallback.`);
        }
    }
    const canonicalParams = {
        ...params,
        agentScope: "project",
        cwd: cwdValidation.canonicalCwd,
        ...(params.tasks
            ? {
                tasks: params.tasks.map((task, index) => ({
                    ...task,
                    cwd: cwdValidation.canonicalTaskCwds[index],
                })),
            }
            : {}),
    };
    let discovered;
    try {
        discovered = discoverAgentsWithProjectSnapshot(cwdValidation.canonicalCwd, access.capability, access.expected);
    }
    catch (error) {
        return projectExecutionError(error instanceof Error ? error.message : String(error));
    }
    if (!discovered.projectSnapshot) {
        return projectExecutionError("TLH project-agent execution was rejected because snapshot metadata was unavailable.");
    }
    for (const target of embeddedTargets) {
        const expectedEntry = manifest.entries.find((entry) => entry.agent.name === target);
        const selectedAgent = discovered.agents.find((agent) => agent.name === target);
        const selectedMetadata = discovered.projectSnapshot.entries.find((entry) => entry.name === target);
        const identityError = expectedEntry
            ? projectAgentEntryIdentityError(manifestRoot, expectedEntry)
            : "the snapshot entry is missing";
        if (!expectedEntry ||
            identityError ||
            !selectedAgent ||
            selectedAgent.source !== "project" ||
            selectedAgent.filePath !== expectedEntry.agent.filePath ||
            !selectedMetadata ||
            selectedMetadata.digest !== expectedEntry.digest ||
            !projectAgentConfigMatches(selectedAgent, expectedEntry.agent)) {
            return projectExecutionError(`TLH project-agent execution was rejected for ${target}: ${identityError ?? "the selected snapshot entry or digest is not active"}.`);
        }
    }
    const projectAgentCaptures = embeddedTargets.flatMap((target) => {
        const selectedAgent = discovered.agents.find((agent) => agent.name === target);
        if (!selectedAgent)
            return [];
        try {
            return [createProjectAgentRunCapture(manifest, selectedAgent)];
        }
        catch {
            return [];
        }
    });
    if (projectAgentCaptures.length !== embeddedTargets.length) {
        return projectExecutionError("TLH project-agent execution was rejected: an approved project-agent capture could not be created.");
    }
    return {
        params: canonicalParams,
        effectiveCwd: cwdValidation.canonicalCwd,
        projectAgentCapability: access.capability,
        projectAgentCaptures,
        discovered,
    };
}
function projectRunAuthorizationError(message) {
    return new Error(`TLH project-agent control rejected: ${message}`);
}
function requestedProjectActionRunId(params) {
    const id = params.id?.trim();
    if (id)
        return id;
    const dir = params.dir?.trim();
    return dir ? path.basename(path.resolve(dir)) : undefined;
}
function lookupPrivateProjectActionReference(params) {
    const runId = requestedProjectActionRunId(params);
    return runId ? lookupProjectAgentRunReference(runId) : { status: "missing" };
}
function hasProjectAgentControlMarker(value) {
    if (!isRecordValue(value))
        return false;
    if (Object.hasOwn(value, "projectAgent") ||
        Object.hasOwn(value, "projectAgents") ||
        Object.hasOwn(value, "projectAgentMarker"))
        return true;
    for (const field of ["steps", "results", "children", "nestedChildren"]) {
        const children = value[field];
        if (Array.isArray(children) && children.some((child) => hasProjectAgentControlMarker(child))) {
            return true;
        }
    }
    return false;
}
function hasMalformedProjectAgentControlMarker(value) {
    if (!isRecordValue(value))
        return false;
    if (Object.hasOwn(value, "projectAgentMarker"))
        return true;
    if (Object.hasOwn(value, "projectAgent") &&
        !normalizeProjectAgentRunCapture(value.projectAgent)) {
        return true;
    }
    if (Object.hasOwn(value, "projectAgents")) {
        const captures = value.projectAgents;
        if (captures !== undefined) {
            if (!Array.isArray(captures) || captures.length === 0)
                return true;
            if (captures.some((capture) => !normalizeProjectAgentRunCapture(capture)))
                return true;
        }
    }
    for (const field of ["steps", "results", "children", "nestedChildren"]) {
        const children = value[field];
        if (Array.isArray(children) &&
            children.some((child) => hasMalformedProjectAgentControlMarker(child))) {
            return true;
        }
    }
    return false;
}
function hasInMemoryProjectAgentCapture(value) {
    return (isRecordValue(value) && Array.isArray(value.projectAgents) && value.projectAgents.length > 0);
}
function rejectMissingPrivateProjectReference(lookup, target, options = {}) {
    const freshChildCapture = isRecordValue(target) &&
        Object.hasOwn(target, "projectAgent") &&
        normalizeProjectAgentRunCapture(target.projectAgent) !== undefined;
    if (lookup.status === "missing" &&
        !(options.allowFreshResume && freshChildCapture) &&
        hasProjectAgentControlMarker(target)) {
        throw projectRunAuthorizationError("the persisted run carries a project-agent marker, but its process-private reference is unavailable; refusing profile fallback.");
    }
}
function privateProjectCaptureForTarget(lookup, target) {
    if (lookup.status === "missing")
        return undefined;
    if (lookup.status === "ambiguous") {
        throw projectRunAuthorizationError(`the requested run id is ambiguous in the retained project-agent registry (${lookup.runIds.join(", ")}). Provide a full run id.`);
    }
    if (target.runId !== lookup.runId) {
        throw projectRunAuthorizationError("the resolved run id does not match the retained run reference.");
    }
    const retainedCapture = lookup.captures.find((capture) => capture.provenance.agent === target.agent);
    if (!retainedCapture) {
        throw projectRunAuthorizationError(`the selected child '${target.agent}' has no matching retained project-agent capture; ordinary siblings in a mixed run cannot be controlled safely.`);
    }
    const persistedCapture = normalizeProjectAgentRunCapture(target.projectAgent);
    if (!persistedCapture || !projectAgentRunCaptureEquals(persistedCapture, retainedCapture)) {
        throw projectRunAuthorizationError("the selected child is missing or has corrupt persisted project-agent provenance/config.");
    }
    return retainedCapture;
}
function requirePersistedProjectCaptureForTarget(lookup, target) {
    const retainedCapture = privateProjectCaptureForTarget(lookup, target);
    if (!retainedCapture || !("asyncDir" in target) || !target.asyncDir)
        return retainedCapture;
    let status;
    try {
        status = readStatus(target.asyncDir);
    }
    catch {
        throw projectRunAuthorizationError("the persisted control status is unavailable.");
    }
    const persistedCapture = normalizeProjectAgentRunCapture(status?.steps?.[target.index]?.projectAgent);
    if (!persistedCapture || !projectAgentRunCaptureEquals(persistedCapture, retainedCapture)) {
        throw projectRunAuthorizationError("the selected child is missing or has corrupt persisted project-agent provenance/config.");
    }
    return retainedCapture;
}
async function authorizeRetainedProjectAgentRun(input) {
    const persisted = normalizeProjectAgentRunCapture(input.target.projectAgent);
    if (!persisted)
        throw projectRunAuthorizationError("persisted provenance/config is corrupt.");
    if (persisted.provenance.agent !== input.target.agent) {
        throw projectRunAuthorizationError("the selected entry does not match persisted provenance.");
    }
    const currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
    if (currentSessionId !== persisted.provenance.sessionId) {
        throw projectRunAuthorizationError("the run belongs to a different session.");
    }
    const currentRoot = resolveCanonicalGitWorktreeRoot(input.ctx.cwd);
    const persistedRoot = resolveCanonicalGitWorktreeRoot(persisted.provenance.projectRoot);
    if (!currentRoot || !persistedRoot || currentRoot !== persistedRoot) {
        throw projectRunAuthorizationError("the current canonical project root does not match the run.");
    }
    if (typeof input.target.cwd !== "string") {
        throw projectRunAuthorizationError("the persisted execution cwd is missing.");
    }
    const cwdValidation = validateProjectAgentCwdContainment(persisted.provenance.projectRoot, input.target.cwd);
    if (!cwdValidation.valid)
        throw projectRunAuthorizationError(cwdValidation.reason);
    const targetRoot = resolveCanonicalGitWorktreeRoot(cwdValidation.canonicalCwd);
    if (!targetRoot || targetRoot !== persistedRoot) {
        throw projectRunAuthorizationError("the persisted execution cwd is not inside the one trusted project worktree.");
    }
    let activeAccess;
    try {
        activeAccess = normalizeProjectAgentAccess(input.deps.getProjectAgentAccess?.({
            cwd: input.ctx.cwd,
            sessionId: currentSessionId,
            targetNames: [input.target.agent],
        }));
    }
    catch {
        activeAccess = undefined;
    }
    if (!activeAccess) {
        throw projectRunAuthorizationError("the current trusted project snapshot is unavailable.");
    }
    if (!activeAccess.architect) {
        throw projectRunAuthorizationError("the current primary agent is not the architect.");
    }
    let activeManifest;
    try {
        activeManifest = resolveProjectAgentSnapshot(activeAccess.capability, activeAccess.expected);
    }
    catch {
        throw projectRunAuthorizationError("the current snapshot capability is invalid.");
    }
    const activeManifestRoot = resolveCanonicalGitWorktreeRoot(activeManifest.provenance.projectRoot);
    if (!activeManifestRoot ||
        activeManifestRoot !== currentRoot ||
        activeManifest.provenance.sessionId !== currentSessionId ||
        activeManifest.provenance.processInstanceId !== persisted.provenance.processInstanceId) {
        throw projectRunAuthorizationError("current root, session, or process identity is stale.");
    }
    if (typeof activeAccess.reauthorize !== "function") {
        throw projectRunAuthorizationError("current project trust cannot be reauthorized safely.");
    }
    let trusted = false;
    try {
        trusted = await activeAccess.reauthorize();
    }
    catch {
        trusted = false;
    }
    if (!trusted)
        throw projectRunAuthorizationError("current project trust has been revoked.");
    let retained;
    try {
        retained = resolveProjectAgentRunReference(input.target.runId, persisted.provenance);
    }
    catch {
        throw projectRunAuthorizationError("the retained project-agent generation is missing or does not match this run.");
    }
    const capture = retained.captures.find((candidate) => candidate.provenance.agent === persisted.provenance.agent);
    if (!capture ||
        !projectAgentRunCaptureEquals(persisted, capture) ||
        capture.provenance.source !== "project" ||
        capture.provenance.digest !== persisted.provenance.digest) {
        throw projectRunAuthorizationError("the selected source, digest, or captured config is corrupt.");
    }
    const entry = retained.manifest.entries.find((candidate) => candidate.agent.name === persisted.provenance.agent);
    const identityError = entry
        ? projectAgentEntryIdentityError(persistedRoot, entry)
        : "the retained generation entry is missing";
    if (!entry ||
        identityError ||
        entry.digest !== persisted.provenance.digest ||
        entry.agent.source !== "project" ||
        entry.agent.filePath !== capture.config.filePath) {
        throw projectRunAuthorizationError(`the retained generation entry or digest is invalid${identityError ? `: ${identityError}` : "."}`);
    }
    let modelScope;
    try {
        modelScope = discoverAgentsWithProjectSnapshot(cwdValidation.canonicalCwd, activeAccess.capability, activeAccess.expected).modelScope;
    }
    catch {
        throw projectRunAuthorizationError("the current profile model scope is unavailable.");
    }
    return {
        capture,
        agentConfig: capture.config,
        capability: retained.capability,
        canonicalCwd: cwdValidation.canonicalCwd,
        freshRebind: false,
        modelScope,
    };
}
async function authorizePersistedProjectAgentRun(input) {
    const persisted = normalizeProjectAgentRunCapture(input.target.projectAgent);
    if (!persisted)
        throw projectRunAuthorizationError("persisted provenance/config is corrupt.");
    if (persisted.provenance.agent !== input.target.agent) {
        throw projectRunAuthorizationError("the selected entry does not match persisted provenance.");
    }
    const currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
    if (currentSessionId !== persisted.provenance.sessionId) {
        throw projectRunAuthorizationError("the run belongs to a different session.");
    }
    const currentRoot = resolveCanonicalGitWorktreeRoot(input.ctx.cwd);
    const persistedRoot = resolveCanonicalGitWorktreeRoot(persisted.provenance.projectRoot);
    if (!currentRoot || !persistedRoot || currentRoot !== persistedRoot) {
        throw projectRunAuthorizationError("the current canonical project root does not match the run.");
    }
    if (typeof input.target.cwd !== "string") {
        throw projectRunAuthorizationError("the persisted execution cwd is missing.");
    }
    const cwdValidation = validateProjectAgentCwdContainment(persisted.provenance.projectRoot, input.target.cwd);
    if (!cwdValidation.valid)
        throw projectRunAuthorizationError(cwdValidation.reason);
    const targetRoot = resolveCanonicalGitWorktreeRoot(cwdValidation.canonicalCwd);
    if (!targetRoot || targetRoot !== persistedRoot) {
        throw projectRunAuthorizationError("the persisted execution cwd is not inside the one trusted project worktree.");
    }
    let activeAccess;
    try {
        activeAccess = normalizeProjectAgentAccess(input.deps.getProjectAgentAccess?.({
            cwd: input.ctx.cwd,
            sessionId: currentSessionId,
            targetNames: [input.target.agent],
        }));
    }
    catch {
        activeAccess = undefined;
    }
    if (!activeAccess) {
        throw projectRunAuthorizationError("the current trusted project snapshot is unavailable.");
    }
    if (!activeAccess.architect) {
        throw projectRunAuthorizationError("the current primary agent is not the architect.");
    }
    let activeManifest;
    try {
        activeManifest = resolveProjectAgentSnapshot(activeAccess.capability, activeAccess.expected);
    }
    catch {
        throw projectRunAuthorizationError("the current snapshot capability is invalid.");
    }
    const activeManifestRoot = resolveCanonicalGitWorktreeRoot(activeManifest.provenance.projectRoot);
    if (!activeManifestRoot ||
        activeManifestRoot !== currentRoot ||
        activeManifest.provenance.sessionId !== currentSessionId) {
        throw projectRunAuthorizationError("current root or session identity is stale.");
    }
    if (typeof activeAccess.reauthorize !== "function") {
        throw projectRunAuthorizationError("current project trust cannot be reauthorized safely.");
    }
    let trusted = false;
    try {
        trusted = await activeAccess.reauthorize();
    }
    catch {
        trusted = false;
    }
    if (!trusted)
        throw projectRunAuthorizationError("current project trust has been revoked.");
    const privateReference = lookupProjectAgentRunReference(input.target.runId);
    if (privateReference.status === "ambiguous") {
        throw projectRunAuthorizationError(`the requested run id is ambiguous in the retained project-agent registry (${privateReference.runIds.join(", ")}). Provide a full run id.`);
    }
    if (privateReference.status === "found") {
        return authorizeRetainedProjectAgentRun(input);
    }
    if (activeManifest.provenance.processInstanceId === persisted.provenance.processInstanceId) {
        throw projectRunAuthorizationError("the persisted project-agent run has no process-private reference; refusing profile fallback.");
    }
    if (typeof activeAccess.rebind !== "function") {
        throw projectRunAuthorizationError("the prior process-private project-agent reference is unavailable and the current runtime cannot perform a fresh rebind.");
    }
    let rebound;
    try {
        rebound = await activeAccess.rebind({
            projectRoot: persistedRoot,
            cwd: cwdValidation.canonicalCwd,
            sessionId: currentSessionId,
            agent: input.target.agent,
        });
    }
    catch {
        rebound = undefined;
    }
    if (!rebound) {
        throw projectRunAuthorizationError("the current project definition could not be reauthorized safely; verify trust and the canonical custom-agent file.");
    }
    let reboundManifest;
    try {
        reboundManifest = resolveProjectAgentSnapshot(rebound.capability, rebound.expected);
    }
    catch {
        throw projectRunAuthorizationError("the fresh project-agent snapshot capability is invalid.");
    }
    const reboundRoot = resolveCanonicalGitWorktreeRoot(reboundManifest.provenance.projectRoot);
    if (!reboundRoot ||
        reboundRoot !== currentRoot ||
        reboundManifest.provenance.sessionId !== currentSessionId ||
        reboundManifest.provenance.processInstanceId !== activeManifest.provenance.processInstanceId) {
        throw projectRunAuthorizationError("the fresh project-agent snapshot has stale root, session, or process identity.");
    }
    const reboundCapture = normalizeProjectAgentRunCapture(rebound.capture);
    if (!reboundCapture || reboundCapture.provenance.agent !== input.target.agent) {
        throw projectRunAuthorizationError("the fresh project-agent capture is invalid.");
    }
    const reboundEntry = reboundManifest.entries.find((candidate) => candidate.agent.name === input.target.agent);
    const identityError = reboundEntry
        ? projectAgentEntryIdentityError(reboundRoot, reboundEntry)
        : "the current custom-agent definition is missing";
    if (!reboundEntry || identityError || reboundEntry.digest !== reboundCapture.provenance.digest) {
        throw projectRunAuthorizationError(`the current project-agent definition is unsafe${identityError ? `: ${identityError}` : "."}`);
    }
    let capture;
    try {
        capture = createProjectAgentRunCapture(reboundManifest, reboundEntry.agent);
    }
    catch {
        throw projectRunAuthorizationError("the current project-agent capture could not be created.");
    }
    if (!projectAgentRunCaptureEquals(reboundCapture, capture)) {
        throw projectRunAuthorizationError("the fresh project-agent capture does not match the current validated definition.");
    }
    let modelScope;
    try {
        modelScope = discoverAgentsWithProjectSnapshot(cwdValidation.canonicalCwd, rebound.capability, rebound.expected).modelScope;
    }
    catch {
        throw projectRunAuthorizationError("the current profile model scope is unavailable.");
    }
    const digestChangeNotice = persisted.provenance.digest !== capture.provenance.digest
        ? `Project agent '${input.target.agent}' changed since the original run (digest ${persisted.provenance.digest} → ${capture.provenance.digest}). The resumed child uses the current validated definition; review the change if it was unexpected.`
        : undefined;
    return {
        capture,
        agentConfig: capture.config,
        capability: rebound.capability,
        canonicalCwd: cwdValidation.canonicalCwd,
        freshRebind: true,
        ...(digestChangeNotice ? { digestChangeNotice } : {}),
        modelScope,
    };
}
function indexedLifecycleContinuation(status, index = 0) {
    return lifecycleContinuationForIndex(status, index);
}
function isClaimedPausedLifecycle(status, index = 0) {
    const continuation = indexedLifecycleContinuation(status, index);
    return (status?.state === "paused" &&
        typeof continuation?.claimToken === "string" &&
        continuation.claimToken.length > 0);
}
function pausedForegroundStatusPath(runId) {
    return path.join(ASYNC_DIR, runId);
}
function releaseProjectSourceAfterContinuation(target) {
    if (!("projectAgent" in target) || !target.projectAgent)
        return;
    const sourceStatus = "asyncDir" in target && target.asyncDir ? readStatus(target.asyncDir) : undefined;
    const state = sourceStatus?.state ?? target.state;
    if (state === "paused" || state === "pausing" || state === "running" || state === "queued") {
        return;
    }
    if (state === "complete" || state === "failed") {
        const releaseTimer = setTimeout(() => releaseProjectAgentRunReference(target.runId), PROJECT_AGENT_TERMINAL_RETENTION_MS);
        releaseTimer.unref?.();
        return;
    }
    releaseProjectAgentRunReference(target.runId);
}
function pausedForegroundStepStatus(result) {
    if (result.cancel?.cancelledAt)
        return "cancelled";
    if (result.pause)
        return "paused";
    if (result.interrupted && !result.sessionFile && !result.pause)
        return "pending";
    if (result.interrupted)
        return "paused";
    if (result.exitCode === 0)
        return "completed";
    return "failed";
}
function isTerminalForegroundResultSnapshot(result, progress) {
    if (result.cancel?.cancelledAt || result.pause || result.interrupted)
        return true;
    if (progress?.status === "completed" || progress?.status === "failed")
        return true;
    return result.exitCode !== 0;
}
function persistPausedForegroundCohortRun(input) {
    const asyncDir = pausedForegroundStatusPath(input.runId);
    const now = Date.now();
    const derivedPause = input.pause ??
        input.results?.find((result) => result.pause?.kind === "awaiting_supervisor")?.pause;
    const pause = derivedPause
        ? {
            kind: derivedPause.kind,
            ...(derivedPause.summary ? { summary: derivedPause.summary } : {}),
            ...(derivedPause.requestedAt !== undefined
                ? { requestedAt: derivedPause.requestedAt }
                : {}),
            ...(input.stage === "pausing" && input.ownerPid !== undefined
                ? { ownerPid: input.ownerPid }
                : {}),
            ...(input.stage === "paused"
                ? { pausedAt: derivedPause.pausedAt ?? now, ownerPid: undefined }
                : {}),
            ...(derivedPause.request ? { request: derivedPause.request } : {}),
        }
        : undefined;
    const steps = (input.steps ??
        input.results?.map((result) => ({
            agent: result.agent,
            ...(result.projectAgent ? { projectAgent: result.projectAgent } : {}),
            status: input.stage === "pausing" && result.pause ? "pausing" : pausedForegroundStepStatus(result),
            sessionFile: result.sessionFile,
            transcriptPath: result.transcriptPath,
            transcriptError: result.transcriptError,
            startedAt: result.progress?.durationMs !== undefined
                ? Math.max(0, now - result.progress.durationMs)
                : undefined,
            endedAt: input.stage === "paused" ? now : undefined,
            durationMs: result.progress?.durationMs,
            activeRuntimeMs: result.activeRuntimeMs ?? result.progress?.durationMs,
            model: result.model,
            thinking: result.modelIdentity?.thinking ?? result.thinking,
            ...(result.modelIdentity ? { modelIdentity: result.modelIdentity } : {}),
            ...(result.modelResolution ? { modelResolution: result.modelResolution } : {}),
            ...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
            ...(result.contextPressure ? { contextPressure: { ...result.contextPressure } } : {}),
            ...(result.contextPressureCrossedThresholds
                ? { contextPressureCrossedThresholds: [...result.contextPressureCrossedThresholds] }
                : {}),
            ...(pausedForegroundTerminationReason(result)
                ? { terminationReason: pausedForegroundTerminationReason(result) }
                : {}),
            exitCode: result.pause || result.interrupted ? 0 : result.exitCode,
            ...(result.acceptance ? { acceptance: result.acceptance } : {}),
            ...(result.pause
                ? {
                    pause: {
                        kind: result.pause.kind,
                        ...(result.pause.summary ? { summary: result.pause.summary } : {}),
                        ...(result.pause.requestedAt !== undefined
                            ? { requestedAt: result.pause.requestedAt }
                            : {}),
                        ...(input.stage === "paused" ? { pausedAt: result.pause.pausedAt ?? now } : {}),
                        ...(result.pause.request ? { request: result.pause.request } : {}),
                    },
                }
                : {}),
            ...(result.cancel ? { cancel: result.cancel } : {}),
        })) ??
        []).map((step) => (step.status === "pausing" || step.status === "paused") && step.pause
        ? { ...step, terminationReason: "paused" }
        : step);
    for (let attempt = 0; attempt < 3; attempt++) {
        const current = readStatus(asyncDir);
        if (!current) {
            writeNormalizedLifecycleStatus(asyncDir, {
                runId: input.runId,
                ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                mode: input.mode,
                state: input.stage,
                startedAt: input.startedAt ?? now,
                lastUpdate: now,
                ...(input.stage === "paused" ? { endedAt: now } : {}),
                cwd: input.cwd,
                ...(pause ? { pause } : {}),
                ...(input.currentStep !== undefined ? { currentStep: input.currentStep } : {}),
                pid: input.stage === "pausing" ? input.ownerPid : undefined,
                steps,
            });
            return;
        }
        try {
            transitionLifecycleStatus({
                asyncDir,
                expectedGeneration: lifecycleGeneration(current),
                mutate: (status) => {
                    const nextStage = status.state === "paused" && input.stage === "pausing" ? "paused" : input.stage;
                    return {
                        ...status,
                        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                        state: nextStage,
                        pid: nextStage === "pausing" ? input.ownerPid : undefined,
                        lastUpdate: now,
                        ...(nextStage === "paused" ? { endedAt: now } : {}),
                        cwd: input.cwd,
                        ...(pause ? { pause } : {}),
                        ...(input.currentStep !== undefined ? { currentStep: input.currentStep } : {}),
                        steps,
                    };
                },
            });
            return;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes("expected generation") &&
                !message.includes("persisted status was not found"))
                throw error;
        }
    }
    throw new Error(`Foreground cohort lifecycle update failed for run '${input.runId}'.`);
}
function pausedForegroundTerminationReason(result, pauseProjected = false) {
    return pauseProjected || result.pause ? "paused" : result.terminationReason;
}
function buildPausedStepFromResult(result, now, options = { stage: "paused" }) {
    const status = options.status ??
        (options.stage === "pausing" && result.pause ? "pausing" : pausedForegroundStepStatus(result));
    return {
        agent: result.agent,
        ...(result.projectAgent ? { projectAgent: result.projectAgent } : {}),
        status,
        sessionFile: result.sessionFile,
        transcriptPath: result.transcriptPath,
        transcriptError: result.transcriptError,
        startedAt: result.progress?.durationMs !== undefined
            ? Math.max(0, now - result.progress.durationMs)
            : undefined,
        endedAt: options.stage === "paused" ||
            status === "paused" ||
            status === "completed" ||
            status === "failed" ||
            status === "cancelled"
            ? now
            : undefined,
        durationMs: result.progress?.durationMs,
        activeRuntimeMs: result.activeRuntimeMs ?? result.progress?.durationMs,
        model: result.model,
        thinking: result.modelIdentity?.thinking ?? result.thinking,
        ...(result.modelIdentity ? { modelIdentity: result.modelIdentity } : {}),
        ...(result.modelResolution ? { modelResolution: result.modelResolution } : {}),
        exitCode: result.pause || result.interrupted ? 0 : result.exitCode,
        ...(result.acceptance ? { acceptance: result.acceptance } : {}),
        ...(result.pause
            ? {
                pause: {
                    kind: result.pause.kind,
                    ...(result.pause.summary ? { summary: result.pause.summary } : {}),
                    ...(result.pause.requestedAt !== undefined
                        ? { requestedAt: result.pause.requestedAt }
                        : {}),
                    ...(status === "pausing" &&
                        options.ownerPid !== undefined &&
                        result.pause.kind === "awaiting_supervisor"
                        ? { ownerPid: options.ownerPid }
                        : {}),
                    ...(status === "paused" ? { pausedAt: result.pause.pausedAt ?? now } : {}),
                    ...(result.pause.request ? { request: result.pause.request } : {}),
                },
            }
            : {}),
        ...(result.cancel ? { cancel: result.cancel } : {}),
        ...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
        ...(result.contextPressure ? { contextPressure: { ...result.contextPressure } } : {}),
        ...(result.contextPressureCrossedThresholds
            ? { contextPressureCrossedThresholds: [...result.contextPressureCrossedThresholds] }
            : {}),
        ...(pausedForegroundTerminationReason(result, status === "paused" || status === "pausing")
            ? {
                terminationReason: pausedForegroundTerminationReason(result, status === "paused" || status === "pausing"),
            }
            : {}),
    };
}
function buildCohortPauseStep(input) {
    const modelIdentity = input.modelIdentity ?? canonicalSubagentModelIdentity(input.model, input.thinking);
    return {
        agent: input.agent,
        ...(input.projectAgent ? { projectAgent: input.projectAgent } : {}),
        status: input.status,
        sessionFile: input.sessionFile,
        ...(input.model ? { model: input.model } : {}),
        ...(input.thinking ? { thinking: input.thinking } : {}),
        ...(modelIdentity ? { modelIdentity } : {}),
        ...(input.modelResolution ? { modelResolution: input.modelResolution } : {}),
        ...(input.contextUsage ? { contextUsage: input.contextUsage } : {}),
        ...(input.contextPressure ? { contextPressure: { ...input.contextPressure } } : {}),
        ...(input.contextPressureCrossedThresholds
            ? { contextPressureCrossedThresholds: [...input.contextPressureCrossedThresholds] }
            : {}),
        ...(input.status === "pausing" || input.status === "paused"
            ? {
                pause: {
                    kind: "cohort_pause",
                    summary: "Paused because another child in this cohort is awaiting supervisor.",
                    requestedAt: input.now,
                    ...(input.status === "paused" ? { pausedAt: input.now } : {}),
                },
                terminationReason: "paused",
            }
            : {}),
    };
}
function persistPausedForegroundSingleRun(input) {
    const asyncDir = pausedForegroundStatusPath(input.runId);
    const now = input.stage === "paused"
        ? (input.result.pause?.pausedAt ?? Date.now())
        : (input.result.pause?.requestedAt ?? Date.now());
    const pause = input.result.pause
        ? {
            kind: input.result.pause.kind,
            ...(input.result.pause.summary ? { summary: input.result.pause.summary } : {}),
            ...(input.result.pause.requestedAt !== undefined
                ? { requestedAt: input.result.pause.requestedAt }
                : {}),
            ...(input.stage === "paused" ? { pausedAt: now } : {}),
            ...(input.stage === "pausing" && input.ownerPid !== undefined
                ? { ownerPid: input.ownerPid }
                : {}),
            ...(input.result.pause.request ? { request: input.result.pause.request } : {}),
        }
        : undefined;
    const current = readStatus(asyncDir);
    if (!current) {
        if (input.stage !== "pausing")
            throw new Error(`Cannot finalize paused foreground run '${input.runId}' before its pausing checkpoint exists.`);
        writeNormalizedLifecycleStatus(asyncDir, {
            runId: input.runId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            mode: "single",
            state: input.stage,
            startedAt: input.result.progress?.durationMs !== undefined
                ? Math.max(0, now - input.result.progress.durationMs)
                : now,
            lastUpdate: now,
            cwd: input.cwd,
            ...(pause ? { pause } : {}),
            steps: [
                {
                    agent: input.result.agent,
                    ...(input.result.projectAgent ? { projectAgent: input.result.projectAgent } : {}),
                    status: input.stage,
                    sessionFile: input.result.sessionFile,
                    transcriptPath: input.result.transcriptPath,
                    transcriptError: input.result.transcriptError,
                    durationMs: input.result.progress?.durationMs,
                    model: input.result.model,
                    thinking: input.result.modelIdentity?.thinking ?? input.result.thinking,
                    ...(input.result.modelIdentity ? { modelIdentity: input.result.modelIdentity } : {}),
                    ...(input.result.modelResolution
                        ? { modelResolution: input.result.modelResolution }
                        : {}),
                    exitCode: 0,
                    ...(input.result.contextUsage ? { contextUsage: input.result.contextUsage } : {}),
                    ...(input.result.contextPressure
                        ? { contextPressure: { ...input.result.contextPressure } }
                        : {}),
                    ...(input.result.contextPressureCrossedThresholds
                        ? {
                            contextPressureCrossedThresholds: [
                                ...input.result.contextPressureCrossedThresholds,
                            ],
                        }
                        : {}),
                    ...(pausedForegroundTerminationReason(input.result)
                        ? { terminationReason: pausedForegroundTerminationReason(input.result) }
                        : {}),
                    ...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
                },
            ],
            sessionFile: input.result.sessionFile,
            ...(input.stage === "pausing" && input.ownerPid !== undefined ? { pid: input.ownerPid } : {}),
        });
        return;
    }
    transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: lifecycleGeneration(current),
        mutate: (status) => ({
            ...status,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            state: input.stage,
            pid: input.stage === "pausing" ? input.ownerPid : undefined,
            lastUpdate: now,
            ...(input.stage === "paused" ? { endedAt: now } : {}),
            cwd: input.cwd,
            ...(pause ? { pause } : {}),
            sessionFile: input.result.sessionFile ?? status.sessionFile,
            steps: status.steps?.map((step, index) => index === 0
                ? {
                    ...step,
                    agent: input.result.agent,
                    ...(input.result.projectAgent ? { projectAgent: input.result.projectAgent } : {}),
                    status: input.stage,
                    sessionFile: input.result.sessionFile ?? step.sessionFile,
                    transcriptPath: input.result.transcriptPath ?? step.transcriptPath,
                    transcriptError: input.result.transcriptError ?? step.transcriptError,
                    ...(input.stage === "paused" ? { endedAt: now } : {}),
                    durationMs: input.result.progress?.durationMs ?? step.durationMs,
                    model: input.result.model ?? step.model,
                    thinking: input.result.modelIdentity?.thinking ?? input.result.thinking ?? step.thinking,
                    ...(input.result.modelIdentity ? { modelIdentity: input.result.modelIdentity } : {}),
                    ...(input.result.modelResolution
                        ? { modelResolution: input.result.modelResolution }
                        : {}),
                    exitCode: 0,
                    ...(input.result.contextUsage ? { contextUsage: input.result.contextUsage } : {}),
                    ...(input.result.contextPressure
                        ? { contextPressure: { ...input.result.contextPressure } }
                        : {}),
                    ...(input.result.contextPressureCrossedThresholds
                        ? {
                            contextPressureCrossedThresholds: [
                                ...input.result.contextPressureCrossedThresholds,
                            ],
                        }
                        : {}),
                    ...(pausedForegroundTerminationReason(input.result)
                        ? { terminationReason: pausedForegroundTerminationReason(input.result) }
                        : {}),
                    ...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
                }
                : step),
        }),
    });
}
function getForegroundControl(state, runId) {
    if (runId)
        return state.foregroundControls.get(runId);
    if (state.lastForegroundControlId) {
        const latest = state.foregroundControls.get(state.lastForegroundControlId);
        if (latest)
            return latest;
    }
    let newest;
    for (const control of state.foregroundControls.values()) {
        if (!newest || control.updatedAt > newest.updatedAt)
            newest = control;
    }
    return newest;
}
function formatForegroundActivity(control) {
    const facts = [];
    if (control.currentTool && control.currentToolStartedAt)
        facts.push(`tool ${control.currentTool} for ${Math.floor(Math.max(0, Date.now() - control.currentToolStartedAt) / 1000)}s`);
    else if (control.currentTool)
        facts.push(`tool ${control.currentTool}`);
    if (control.currentPath)
        facts.push(`path ${control.currentPath}`);
    if (control.turnCount !== undefined)
        facts.push(`${control.turnCount} turns`);
    if (control.tokens !== undefined)
        facts.push(`${control.tokens} tokens`);
    if (control.toolCount !== undefined)
        facts.push(`${control.toolCount} tools`);
    if (!control.lastActivityAt) {
        if (control.currentActivityState === "needs_attention")
            return ["needs attention", ...facts].join(" | ");
        if (control.currentActivityState === "active_long_running")
            return ["active but long-running", ...facts].join(" | ");
        return facts.length ? facts.join(" | ") : undefined;
    }
    const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
    if (control.currentActivityState === "needs_attention")
        return [`no activity for ${seconds}s`, ...facts].join(" | ");
    if (control.currentActivityState === "active_long_running")
        return [`active but long-running; last activity ${seconds}s ago`, ...facts].join(" | ");
    return [`active ${seconds}s ago`, ...facts].join(" | ");
}
function trustedSessionRootsForStatus(ctx, deps) {
    const roots = [];
    const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
    if (parentSessionFile)
        roots.push(deps.getSubagentSessionRoot(parentSessionFile));
    return [...new Set(roots)];
}
function foregroundStatusResult(control) {
    let nestedWarning;
    try {
        updateForegroundNestedProjection(control);
    }
    catch (error) {
        nestedWarning = `Nested status unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    const activity = formatForegroundActivity(control);
    const lines = [
        `Run: ${control.runId}`,
        "State: running",
        `Mode: ${control.mode}`,
        control.currentAgent
            ? `Current: ${control.currentAgent}${control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""}`
            : undefined,
        activity ? `Activity: ${activity}` : undefined,
    ].filter((line) => Boolean(line));
    lines.push(...formatNestedRunStatusLines(control.nestedChildren, {
        indent: "",
        commandHints: true,
        maxLines: 20,
    }));
    if (nestedWarning)
        lines.push(`Warning: ${nestedWarning}`);
    return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { mode: "management", results: [] },
    };
}
function foregroundRunHasResumableState(run) {
    const persistedPath = pausedForegroundStatusPath(run.runId);
    try {
        const status = readStatus(persistedPath);
        if (status) {
            if (status.state === "paused" || status.state === "pausing" || status.state === "running") {
                return true;
            }
            if (status.steps?.some((step) => step.status !== "continued" &&
                step.status !== "cancelled" &&
                (step.status === "paused" ||
                    step.status === "pausing" ||
                    step.status === "pending" ||
                    step.status === "running" ||
                    step.sessionFile !== undefined))) {
                return true;
            }
            return false;
        }
    }
    catch {
        return true;
    }
    return (run.children.length === 0 ||
        run.children.some((child) => child.status === "paused" ||
            child.status === "pausing" ||
            child.status === "pending" ||
            child.status === "running" ||
            ((child.status === "completed" || child.status === "failed") &&
                child.sessionFile !== undefined)));
}
function scheduleForegroundProjectReferenceRelease(runId) {
    const releaseTimer = setTimeout(() => releaseProjectAgentRunReference(runId), PROJECT_AGENT_TERMINAL_RETENTION_MS);
    releaseTimer.unref?.();
}
export function trimRememberedForegroundRuns(state) {
    if (!state.foregroundRuns)
        return;
    while (state.foregroundRuns.size > 50) {
        const oldest = [...state.foregroundRuns.values()].sort((left, right) => left.updatedAt - right.updatedAt)[0];
        if (!oldest)
            break;
        state.foregroundRuns.delete(oldest.runId);
        if (!foregroundRunHasResumableState(oldest)) {
            scheduleForegroundProjectReferenceRelease(oldest.runId);
        }
    }
}
function rememberForegroundRun(state, input) {
    state.foregroundRuns ??= new Map();
    const updatedAt = Date.now();
    state.foregroundRuns.set(input.runId, {
        runId: input.runId,
        mode: input.mode,
        cwd: input.cwd,
        updatedAt,
        children: input.results.map((result, index) => {
            const activeRuntimeMs = result.activeRuntimeMs ?? result.progress?.durationMs;
            const child = {
                agent: result.agent,
                ...(result.projectAgent ? { projectAgent: result.projectAgent } : {}),
                index,
                status: resolveSubagentResultStatus({
                    exitCode: result.exitCode,
                    interrupted: result.interrupted,
                }),
                updatedAt,
                ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
                ...(result.model ? { model: result.model } : {}),
                ...(result.thinking ? { thinking: result.thinking } : {}),
                ...(result.modelIdentity ? { modelIdentity: result.modelIdentity } : {}),
                ...(result.modelResolution ? { modelResolution: result.modelResolution } : {}),
                ...(result.finalOutput ? { finalOutput: result.finalOutput } : {}),
                ...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
                ...(result.artifactPaths ? { artifactPaths: result.artifactPaths } : {}),
                ...(result.transcriptPath ? { transcriptPath: result.transcriptPath } : {}),
                ...(result.transcriptError ? { transcriptError: result.transcriptError } : {}),
                ...(result.acceptance ? { acceptance: result.acceptance } : {}),
                ...(result.pause ? { pause: result.pause } : {}),
                ...(result.cancel ? { cancel: result.cancel } : {}),
                ...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
                ...(result.contextPressure ? { contextPressure: { ...result.contextPressure } } : {}),
                ...(result.contextPressureCrossedThresholds
                    ? { contextPressureCrossedThresholds: [...result.contextPressureCrossedThresholds] }
                    : {}),
                ...(pausedForegroundTerminationReason(result)
                    ? { terminationReason: pausedForegroundTerminationReason(result) }
                    : {}),
                ...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
            };
            return child;
        }),
    });
    trimRememberedForegroundRuns(state);
}
function updateRememberedForegroundChild(state, input) {
    state.foregroundRuns ??= new Map();
    const updatedAt = Date.now();
    let run = state.foregroundRuns.get(input.runId);
    if (!run) {
        run = { runId: input.runId, mode: input.mode, cwd: input.cwd, updatedAt, children: [] };
        state.foregroundRuns.set(input.runId, run);
    }
    run.updatedAt = updatedAt;
    const child = run.children[input.index] ?? {
        agent: input.result.agent,
        index: input.index,
    };
    const activeRuntimeMs = input.result.activeRuntimeMs ?? input.result.progress?.durationMs;
    run.children[input.index] = {
        ...child,
        agent: input.result.agent,
        ...(input.result.projectAgent ? { projectAgent: input.result.projectAgent } : {}),
        index: input.index,
        status: resolveSubagentResultStatus({
            exitCode: input.result.exitCode,
            interrupted: input.result.interrupted,
        }),
        updatedAt,
        ...(input.result.exitCode !== undefined ? { exitCode: input.result.exitCode } : {}),
        ...(input.result.model ? { model: input.result.model } : {}),
        ...(input.result.thinking ? { thinking: input.result.thinking } : {}),
        ...(input.result.modelIdentity ? { modelIdentity: input.result.modelIdentity } : {}),
        ...(input.result.modelResolution ? { modelResolution: input.result.modelResolution } : {}),
        ...(input.result.finalOutput ? { finalOutput: input.result.finalOutput } : {}),
        ...(input.result.sessionFile ? { sessionFile: input.result.sessionFile } : {}),
        ...(input.result.artifactPaths ? { artifactPaths: input.result.artifactPaths } : {}),
        ...(input.result.transcriptPath ? { transcriptPath: input.result.transcriptPath } : {}),
        ...(input.result.transcriptError ? { transcriptError: input.result.transcriptError } : {}),
        ...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
        ...(input.result.pause ? { pause: input.result.pause } : {}),
        ...(input.result.cancel ? { cancel: input.result.cancel } : {}),
        ...(input.result.contextUsage ? { contextUsage: input.result.contextUsage } : {}),
        ...(input.result.contextPressure
            ? { contextPressure: { ...input.result.contextPressure } }
            : {}),
        ...(input.result.contextPressureCrossedThresholds
            ? { contextPressureCrossedThresholds: [...input.result.contextPressureCrossedThresholds] }
            : {}),
        ...(pausedForegroundTerminationReason(input.result)
            ? { terminationReason: pausedForegroundTerminationReason(input.result) }
            : {}),
        ...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
    };
    trimRememberedForegroundRuns(state);
}
function resolveRememberedForegroundRun(params, state) {
    const requested = params.id?.trim();
    if (!requested || !state.foregroundRuns?.size)
        return undefined;
    const direct = state.foregroundRuns.get(requested);
    const matches = direct
        ? [direct]
        : [...state.foregroundRuns.values()].filter((run) => run.runId.startsWith(requested));
    if (matches.length === 0)
        return undefined;
    if (matches.length > 1)
        throw new Error(`Ambiguous foreground run id prefix '${requested}' matched: ${matches.map((run) => run.runId).join(", ")}. Provide a longer id.`);
    const run = matches[0];
    if (run.children.length > 1 && params.index === undefined)
        throw new Error(`Foreground run '${run.runId}' has ${run.children.length} children. Provide index to choose one.`);
    const index = params.index ?? 0;
    if (!Number.isInteger(index))
        throw new Error(`Foreground run '${run.runId}' index must be an integer.`);
    if (index < 0 || index >= run.children.length)
        throw new Error(`Foreground run '${run.runId}' has ${run.children.length} children. Index ${index} is out of range.`);
    return { run, index, child: run.children[index] };
}
function resolveForegroundResumeTarget(params, state) {
    const resolved = resolveRememberedForegroundRun(params, state);
    if (!resolved)
        return undefined;
    const { run, index, child } = resolved;
    if (child.cancel?.cancelledAt)
        throw new Error(`Foreground run '${run.runId}' child ${index} was cancelled while paused and cannot be resumed. Inspect status or transcript artifacts if needed.`);
    if (!child.sessionFile)
        throw new Error(`Foreground run '${run.runId}' child ${index} does not have a persisted session file to resume from.`);
    if (path.extname(child.sessionFile) !== ".jsonl")
        throw new Error(`Foreground run '${run.runId}' child ${index} session file must be a .jsonl file.`);
    const sessionFile = path.resolve(child.sessionFile);
    if (!fs.existsSync(sessionFile))
        throw new Error(`Foreground run '${run.runId}' child ${index} session file is missing.`);
    const childState = child.status === "completed" ? "complete" : child.status;
    const projectAgentMarker = Object.hasOwn(child, "projectAgent")
        ? normalizeProjectAgentRunCapture(child.projectAgent)
        : undefined;
    if (Object.hasOwn(child, "projectAgent") && !projectAgentMarker) {
        throw projectRunAuthorizationError(`Foreground run '${run.runId}' child ${index} has an invalid project-agent marker.`);
    }
    const projectAgentMarkers = run.children.flatMap((candidate) => {
        if (!Object.hasOwn(candidate, "projectAgent"))
            return [];
        const marker = normalizeProjectAgentRunCapture(candidate.projectAgent);
        if (!marker) {
            throw projectRunAuthorizationError(`Foreground run '${run.runId}' has an invalid project-agent marker on child ${candidate.index}.`);
        }
        return [marker];
    });
    const childModelIdentity = child.modelIdentity ?? canonicalSubagentModelIdentity(child.model, child.thinking);
    const continuationAcceptance = childState === "paused" && child.acceptance?.status === "skipped"
        ? child.acceptance.effectiveAcceptance
        : undefined;
    return {
        runId: run.runId,
        mode: run.mode,
        state: childState,
        agent: child.agent,
        ...(projectAgentMarker ? { projectAgent: projectAgentMarker } : {}),
        index,
        cwd: run.cwd,
        sessionFile,
        ...(fs.existsSync(pausedForegroundStatusPath(run.runId))
            ? { asyncDir: pausedForegroundStatusPath(run.runId) }
            : {}),
        ...(child.pause?.kind ? { pauseKind: child.pause.kind } : {}),
        ...(continuationAcceptance ? { continuationAcceptance } : {}),
        ...(childModelIdentity ? { modelIdentity: childModelIdentity } : {}),
        ...(projectAgentMarkers.length > 0 ? { projectAgents: projectAgentMarkers } : {}),
        ...(child.modelResolution ? { modelResolution: child.modelResolution } : {}),
        ...(parseContextUsageDiagnostics(child.contextUsage)
            ? { contextUsage: parseContextUsageDiagnostics(child.contextUsage) }
            : {}),
        ...(parseContextPressureProjection(child.contextPressure)
            ? { contextPressure: parseContextPressureProjection(child.contextPressure) }
            : {}),
        ...(parseContextPressureCrossedThresholds(child.contextPressureCrossedThresholds)
            ? {
                contextPressureCrossedThresholds: parseContextPressureCrossedThresholds(child.contextPressureCrossedThresholds),
            }
            : {}),
        ...(child.activeRuntimeMs !== undefined ? { activeRuntimeMs: child.activeRuntimeMs } : {}),
    };
}
function isAsyncInterruptFailure(result) {
    return !result.ok;
}
function isAsyncInterruptNotRunning(result) {
    return "kind" in result && result.kind === "not_running";
}
function buildRunStatusParams(params) {
    return {
        action: "status",
        id: params.id,
        dir: params.dir,
        index: params.index,
        view: params.view,
        lines: params.lines,
    };
}
function buildManagementActionParams(params) {
    return {
        action: params.action,
        agent: params.agent,
        chainName: params.chainName,
        agentScope: params.agentScope,
        config: params.config,
    };
}
const UNSUPPORTED_SAVED_CHAIN_INPUT_MESSAGE = "Saved chains are deliberately unsupported in The Last Harness; existing .chain.md/.chain.json files are left untouched.";
function unsupportedSavedChainInputResult(params, detail) {
    const text = detail.startsWith("The Last Harness")
        ? detail
        : `${UNSUPPORTED_SAVED_CHAIN_INPUT_MESSAGE} ${detail}`;
    return {
        content: [{ type: "text", text }],
        isError: true,
        details: { mode: params.action ? "management" : getRequestedModeLabel(params), results: [] },
    };
}
function unsupportedSavedChainInput(params) {
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
function isAsyncRunNotFound(error) {
    return error instanceof Error && error.message.startsWith("Async run not found.");
}
function isResumeAmbiguity(error) {
    return error instanceof Error && /Ambiguous .*run id prefix/.test(error.message);
}
function resumeTargetExact(target, requested) {
    return target?.runId === requested;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isExactResumeError(error, source, requested) {
    if (!(error instanceof Error) || !requested)
        return false;
    return new RegExp(`\\b${source} run '${escapeRegExp(requested)}'`, "i").test(error.message);
}
function resolveResumeTarget(params, state, options = {}) {
    const requested = params.id?.trim() ?? "";
    let foregroundTarget;
    let foregroundError;
    let asyncTarget;
    let asyncError;
    try {
        const target = resolveForegroundResumeTarget(params, state);
        if (target)
            foregroundTarget = { kind: "revive", source: "foreground", ...target };
    }
    catch (error) {
        foregroundError = error;
    }
    try {
        asyncTarget = {
            source: "async",
            ...resolveAsyncResumeTarget(params, {}, {
                requireSessionFile: options.asyncRequireSessionFile,
                readOnly: options.readOnly,
            }),
        };
    }
    catch (error) {
        asyncError = error;
    }
    if (foregroundTarget && asyncTarget) {
        const foregroundExact = resumeTargetExact(foregroundTarget, requested);
        const asyncExact = resumeTargetExact(asyncTarget, requested);
        if (foregroundExact && asyncExact && foregroundTarget.runId === asyncTarget.runId)
            return foregroundTarget;
        if (foregroundExact && !asyncExact)
            return foregroundTarget;
        if (asyncExact && !foregroundExact)
            return asyncTarget;
        throw new Error(`Resume id '${requested}' is ambiguous between foreground run '${foregroundTarget.runId}' and async run '${asyncTarget.runId}'. Provide a full run id.`);
    }
    if (foregroundTarget) {
        if (isExactResumeError(asyncError, "async", requested) &&
            !resumeTargetExact(foregroundTarget, requested))
            throw asyncError;
        if (isResumeAmbiguity(asyncError) && !resumeTargetExact(foregroundTarget, requested))
            throw asyncError;
        return foregroundTarget;
    }
    if (asyncTarget) {
        if (isExactResumeError(foregroundError, "foreground", requested))
            throw foregroundError;
        if (isResumeAmbiguity(foregroundError) && !resumeTargetExact(asyncTarget, requested))
            throw foregroundError;
        return asyncTarget;
    }
    if (foregroundError && !isAsyncRunNotFound(asyncError))
        throw foregroundError;
    if (foregroundError)
        throw foregroundError;
    if (asyncError)
        throw asyncError;
    throw new Error("Run not found. Provide id.");
}
function claimPausedAwaitingSupervisorTarget(target, continuationRunId, effectiveContextWindow) {
    if (target.kind !== "revive" || !("asyncDir" in target) || !target.asyncDir)
        return undefined;
    const asyncDir = target.asyncDir;
    if (!fs.existsSync(asyncDir)) {
        if (target.state === "paused")
            throw new Error(`Paused run '${target.runId}' was not found.`);
        return undefined;
    }
    const decision = withLifecycleStatusLock(asyncDir, (persisted) => {
        if (!persisted) {
            if (target.state === "paused")
                throw new Error(`Paused run '${target.runId}' was not found.`);
            return undefined;
        }
        let current = persisted;
        const recovered = recoverStaleLifecycleContinuationStatus(current, asyncDir, target.index);
        if (recovered.recovered)
            current = recovered.status;
        const currentStep = current.steps?.[target.index];
        if (current.state === "cancelled" || currentStep?.status === "cancelled")
            throw new Error(`Paused run '${target.runId}' child ${target.index} was cancelled and cannot be resumed.`);
        if (current.state === "continued" || currentStep?.status === "continued")
            throw new Error(`Paused run '${target.runId}' child ${target.index} already launched its continuation and cannot be resumed again.`);
        const latestContextUsage = parseContextUsageDiagnostics(currentStep?.contextUsage) ?? target.contextUsage;
        const contextAssessment = assessDurableResumeContext(latestContextUsage, effectiveContextWindow);
        if (contextAssessment.blocked)
            return { blockedMessage: formatDurableResumeContextBlock(contextAssessment) };
        if (current.state !== "paused" ||
            !currentStep ||
            (currentStep.status !== "paused" && currentStep.status !== "pausing")) {
            if (isClaimedPausedLifecycle(current, target.index))
                throw new Error(`Paused run '${target.runId}' child ${target.index} was already claimed for continuation and cannot be resumed again.`);
            if (target.state === "paused")
                throw new Error(`Paused run '${target.runId}' child ${target.index} is not paused and cannot be resumed.`);
            return undefined;
        }
        if (isClaimedPausedLifecycle(current, target.index))
            throw new Error(`Paused run '${target.runId}' child ${target.index} was already claimed for continuation and cannot be resumed again.`);
        const claimToken = `claim-${target.runId}-${target.index}-${Date.now()}`;
        const claimedAt = Date.now();
        const nextStatus = {
            ...current,
            lastUpdate: claimedAt,
            pause: current.pause ? { ...current.pause, ownerPid: undefined } : current.pause,
            lifecycle: {
                ...withLifecycleContinuation(current, target.index, {
                    phase: "reserved",
                    claimToken,
                    claimedAt,
                    ownerPid: process.pid,
                    continuationRunId,
                }),
                generation: lifecycleGeneration(current) + 1,
            },
        };
        writeNormalizedLifecycleStatus(asyncDir, nextStatus);
        return { claimToken };
    });
    if (!decision || "blockedMessage" in decision)
        return decision;
    return {
        asyncDir,
        claimToken: decision.claimToken,
        rollbackReserved: () => {
            const latest = readStatus(asyncDir);
            if (!latest || latest.state !== "paused")
                return;
            const latestContinuation = indexedLifecycleContinuation(latest, target.index);
            if (latestContinuation?.claimToken !== decision.claimToken ||
                latestContinuation.continuationRunId !== continuationRunId ||
                latestContinuation.phase !== "reserved")
                return;
            transitionLifecycleStatus({
                asyncDir,
                expectedGeneration: lifecycleGeneration(latest),
                mutate: (status) => ({
                    ...status,
                    lastUpdate: Date.now(),
                    lifecycle: withLifecycleContinuation(status, target.index, undefined),
                }),
            });
        },
        markSpawned: () => {
            markLifecycleContinuationSpawned(asyncDir, target.index, decision.claimToken, continuationRunId);
        },
    };
}
function recoverFailedPausedForegroundTransition(input) {
    const asyncDir = pausedForegroundStatusPath(input.runId);
    const message = FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
    try {
        const current = readStatus(asyncDir);
        if (!current || current.state !== "pausing")
            return;
        const failedAt = Date.now();
        transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: lifecycleGeneration(current),
            mutate: (status) => ({
                ...status,
                state: "failed",
                pid: undefined,
                lastUpdate: failedAt,
                endedAt: failedAt,
                error: message,
                pause: status.pause ? { ...status.pause, ownerPid: undefined } : status.pause,
                steps: status.steps?.map((step, index) => index === 0 && (step.status === "pausing" || step.status === "paused")
                    ? {
                        ...step,
                        status: "failed",
                        endedAt: failedAt,
                        exitCode: 1,
                        terminationReason: "process_exit",
                        error: step.error ?? message,
                    }
                    : step),
            }),
        });
    }
    catch {
    }
}
function enrichPersistedPausedForegroundSingleRun(input) {
    const asyncDir = pausedForegroundStatusPath(input.runId);
    const current = readStatus(asyncDir);
    if (current?.pause?.kind === "awaiting_supervisor" &&
        (current.state === "paused" || current.state === "pausing")) {
        transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: lifecycleGeneration(current),
            mutate: (status) => ({
                ...status,
                lastUpdate: Date.now(),
                sessionFile: input.result.sessionFile ?? status.sessionFile,
                steps: status.steps?.map((step, index) => index === 0
                    ? {
                        ...step,
                        projectAgent: input.result.projectAgent ?? step.projectAgent,
                        sessionFile: input.result.sessionFile ?? step.sessionFile,
                        transcriptPath: input.result.transcriptPath ?? step.transcriptPath,
                        transcriptError: input.result.transcriptError ?? step.transcriptError,
                        terminationReason: step.terminationReason ?? "paused",
                        ...(input.result.contextUsage ? { contextUsage: input.result.contextUsage } : {}),
                        ...(input.result.contextPressure
                            ? { contextPressure: { ...input.result.contextPressure } }
                            : {}),
                        ...(input.result.contextPressureCrossedThresholds
                            ? {
                                contextPressureCrossedThresholds: [
                                    ...input.result.contextPressureCrossedThresholds,
                                ],
                            }
                            : {}),
                        ...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
                    }
                    : step),
            }),
        });
    }
}
function getAsyncInterruptTarget(state, runId, location) {
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
function selectInterruptTarget(params, state) {
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
function requestForegroundInterrupt(control) {
    if (!control?.interrupt)
        return false;
    const interrupted = control.interrupt();
    if (interrupted) {
        control.updatedAt = Date.now();
        control.currentActivityState = undefined;
    }
    return interrupted;
}
function updateRememberedForegroundCancellation(state, runId, cancelledAt, summary, index = 0) {
    const run = state.foregroundRuns?.get(runId);
    const child = run?.children[index];
    if (!run || !child)
        return;
    run.updatedAt = cancelledAt;
    run.children[index] = {
        ...child,
        cancel: { summary, cancelledAt },
        terminationReason: "cancelled",
    };
}
function hasResumableSiblingStep(steps, targetIndex) {
    return (steps?.some((step, stepIndex) => stepIndex !== targetIndex && step.status !== "continued" && step.status !== "cancelled") ?? false);
}
function cancelPersistedPausedForegroundRun(state, asyncDir, runId, index) {
    try {
        let current = readStatus(asyncDir);
        if (!current) {
            return {
                content: [{ type: "text", text: `Paused foreground run '${runId}' was not found.` }],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        const stepCount = current.steps?.length ?? 0;
        const targetIndex = index ?? (stepCount <= 1 ? 0 : undefined);
        if (stepCount > 1 && targetIndex === undefined) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Foreground run '${runId}' has ${stepCount} children. Provide index to cancel one paused child.`,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        if (targetIndex === undefined || targetIndex < 0 || targetIndex >= stepCount) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Foreground run '${runId}' has ${stepCount} children. Index ${targetIndex ?? -1} is out of range.`,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        const recovered = recoverStaleLifecycleContinuationClaim(asyncDir, targetIndex);
        if (recovered.recovered && recovered.status)
            current = recovered.status;
        const targetStep = current.steps?.[targetIndex];
        const targetPause = targetStep?.pause ?? (stepCount <= 1 ? current.pause : undefined);
        if (targetStep?.status === "cancelled") {
            return {
                content: [
                    {
                        type: "text",
                        text: `Foreground run '${runId}' child ${targetIndex} is already cancelled.`,
                    },
                ],
                details: { mode: "management", results: [] },
            };
        }
        if (targetStep?.status === "continued") {
            return {
                content: [
                    {
                        type: "text",
                        text: `Foreground run '${runId}' child ${targetIndex} already continued and cannot be cancelled.`,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        if (current.state === "continued" && stepCount <= 1) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Foreground run '${runId}' already continued into '${lifecycleContinuationForIndex(current, targetIndex)?.continuationRunId ?? current.lifecycle?.continuation?.continuationRunId ?? "unknown"}' and can no longer be cancelled from the paused supervisor lifecycle.`,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        if (isClaimedPausedLifecycle(current, targetIndex)) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Foreground run '${runId}' child ${targetIndex} is already claimed for continuation and cannot be cancelled through the paused supervisor lifecycle.`,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        if (current.state !== "paused" ||
            !targetStep ||
            (targetStep.status !== "paused" && targetStep.status !== "pausing") ||
            !targetPause) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Foreground run '${runId}' child ${targetIndex} is not a paused child.`,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        const cancelledAt = Date.now();
        const summary = targetPause.kind === "awaiting_supervisor"
            ? "Cancelled while paused awaiting supervisor."
            : "Cancelled while paused with the cohort.";
        const transitioned = transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: lifecycleGeneration(current),
            mutate: (status) => {
                const nextSteps = status.steps?.map((step, stepIndex) => stepIndex === targetIndex
                    ? {
                        ...step,
                        status: "cancelled",
                        endedAt: cancelledAt,
                        exitCode: 0,
                        cancel: { summary, cancelledAt },
                        terminationReason: "cancelled",
                    }
                    : step);
                const remainingActionable = nextSteps?.some((step) => step.status === "paused" || step.status === "pausing" || step.status === "pending") ?? false;
                const remainingResumable = hasResumableSiblingStep(nextSteps, targetIndex);
                return {
                    ...status,
                    state: remainingActionable || remainingResumable ? "paused" : "cancelled",
                    pid: undefined,
                    ...(remainingActionable || remainingResumable
                        ? {}
                        : { cancel: { summary, cancelledAt } }),
                    pause: remainingActionable
                        ? nextSteps?.find((step) => step.pause?.kind === "awaiting_supervisor" &&
                            (step.status === "paused" || step.status === "pausing"))?.pause
                        : undefined,
                    lastUpdate: cancelledAt,
                    endedAt: cancelledAt,
                    lifecycle: withLifecycleContinuation(status, targetIndex, undefined),
                    steps: nextSteps,
                };
            },
        });
        if (transitioned.status.state === "cancelled")
            releaseProjectAgentRunReference(runId);
        updateRememberedForegroundCancellation(state, runId, cancelledAt, summary, targetIndex);
        return {
            content: [
                {
                    type: "text",
                    text: `Cancelled paused foreground run ${runId} child ${targetIndex}. Existing artifacts and transcript were preserved; resume is no longer available for that child.`,
                },
            ],
            details: { mode: "management", results: [] },
        };
    }
    catch {
        return {
            content: [
                {
                    type: "text",
                    text: `Paused foreground run '${runId}' could not be updated safely. ${FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE}`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
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
function emitControlNotification(input) {
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
function interruptAsyncRun(state, runId, kill, location) {
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
function steerAsyncRun(input) {
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
function nestedRunSessionFile(run) {
    return run.sessionFile ?? (run.steps?.length === 1 ? run.steps[0]?.sessionFile : undefined);
}
function nestedRunAgent(run) {
    return (run.agent ?? run.agents?.[0] ?? (run.steps?.length === 1 ? run.steps[0]?.agent : undefined));
}
function pathWithin(base, candidate) {
    const resolvedBase = path.resolve(base);
    const resolvedCandidate = path.resolve(candidate);
    return (resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`));
}
function validateNestedSessionFile(run, trustedSessionRoots) {
    const sessionFile = nestedRunSessionFile(run);
    if (!sessionFile)
        throw new Error(`Nested run '${run.id}' does not have a persisted session file to resume from.`);
    if (path.extname(sessionFile) !== ".jsonl")
        throw new Error(`Nested run '${run.id}' session file must be a .jsonl file: ${sessionFile}`);
    const resolved = path.resolve(sessionFile);
    if (!path.isAbsolute(sessionFile))
        throw new Error(`Nested run '${run.id}' session file must be absolute: ${sessionFile}`);
    if (!fs.existsSync(resolved))
        throw new Error(`Nested run '${run.id}' session file does not exist: ${sessionFile}`);
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`Nested run '${run.id}' session file is not a regular file: ${sessionFile}`);
    const realSessionFile = fs.realpathSync(resolved);
    const trustedRoots = trustedSessionRoots
        .filter((root) => fs.existsSync(root))
        .map((root) => fs.realpathSync(root));
    if (!trustedRoots.some((root) => pathWithin(root, realSessionFile))) {
        throw new Error(`Nested run '${run.id}' session file is outside trusted nested session roots: ${sessionFile}`);
    }
    if (!realSessionFile.split(path.sep).includes(run.id)) {
        throw new Error(`Nested run '${run.id}' session file is not under that nested run's session directory: ${sessionFile}`);
    }
    return realSessionFile;
}
function readNestedResumeStatusStep(runId, asyncDir) {
    if (!asyncDir)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
    }
    catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
        if (code === "ENOENT")
            return undefined;
        throw new Error(`Nested run '${runId}' persisted status could not be read safely.`, {
            cause: error,
        });
    }
    if (!Array.isArray(parsed.steps))
        throw new Error(`Nested run '${runId}' persisted status has invalid steps metadata.`);
    const malformedProjectAgentMarker = hasMalformedProjectAgentControlMarker(parsed);
    const step = parsed.steps[0];
    if (!step || typeof step !== "object" || Array.isArray(step))
        throw new Error(`Nested run '${runId}' persisted status does not have a valid step at index 0.`);
    const activeRuntimeMs = step.activeRuntimeMs;
    if (activeRuntimeMs !== undefined &&
        (typeof activeRuntimeMs !== "number" ||
            !Number.isFinite(activeRuntimeMs) ||
            activeRuntimeMs < 0)) {
        throw new Error(`Nested run '${runId}' persisted step activeRuntimeMs must be a non-negative finite number.`);
    }
    const raw = step;
    const modelIdentity = sanitizeSubagentModelIdentity(raw.modelIdentity) ??
        canonicalSubagentModelIdentity(typeof raw.model === "string" ? raw.model : undefined, typeof raw.thinking === "string" ? raw.thinking : undefined);
    const modelResolution = sanitizeSubagentModelResolution(raw.modelResolution);
    const contextUsage = parseContextUsageDiagnostics(raw.contextUsage);
    const contextPressure = parseContextPressureProjection(raw.contextPressure);
    const contextPressureCrossedThresholds = parseContextPressureCrossedThresholds(raw.contextPressureCrossedThresholds);
    return {
        ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
        ...(typeof raw.status === "string" ? { status: raw.status } : {}),
        ...(modelIdentity ? { modelIdentity } : {}),
        ...(modelResolution ? { modelResolution } : {}),
        ...(contextUsage ? { contextUsage } : {}),
        ...(contextPressure ? { contextPressure } : {}),
        ...(contextPressureCrossedThresholds ? { contextPressureCrossedThresholds } : {}),
        ...(typeof activeRuntimeMs === "number" ? { activeRuntimeMs } : {}),
        ...(malformedProjectAgentMarker ? { projectAgentMarker: true } : {}),
        ...(raw.acceptance
            ? { acceptance: raw.acceptance }
            : {}),
    };
}
function resolveNestedContinuationAcceptance(runId, step) {
    const failClosed = () => new Error(`Nested run '${runId}' is paused but its skipped acceptance ledger could not be read. Retry the resume once pause metadata is persisted.`);
    if (!step?.acceptance)
        throw failClosed();
    return step.acceptance.status === "skipped" ? step.acceptance.effectiveAcceptance : undefined;
}
function resolveTrustedNestedResumeCwd(asyncDir) {
    if (!asyncDir)
        return undefined;
    try {
        const canonicalRoot = fs.realpathSync(NESTED_ASYNC_RUNS_DIR);
        const canonicalParent = fs.realpathSync(path.dirname(asyncDir));
        if (!pathWithin(canonicalRoot, canonicalParent))
            return undefined;
        return fs.statSync(canonicalParent).isDirectory() ? canonicalParent : undefined;
    }
    catch {
        return undefined;
    }
}
function resolveNestedResumeTarget(match, trustedSessionRoots) {
    const run = match.match.run;
    if (run.state === "running" || run.state === "queued")
        throw new Error(`Nested run '${run.id}' is live; route the follow-up to the owner process instead.`);
    const agent = nestedRunAgent(run);
    if (!agent)
        throw new Error(`Could not determine child agent for nested run '${run.id}'.`);
    const state = run.state === "complete" || run.state === "failed" || run.state === "paused"
        ? run.state
        : "failed";
    if (hasMalformedProjectAgentControlMarker(run)) {
        throw projectRunAuthorizationError(`Nested run '${run.id}' has a malformed project-agent marker.`);
    }
    const projectAgentMarker = Object.hasOwn(run, "projectAgent")
        ? normalizeProjectAgentRunCapture(run.projectAgent)
        : undefined;
    const asyncDir = resolveNestedAsyncDir(match.match.rootRunId, run);
    const statusStep = readNestedResumeStatusStep(run.id, asyncDir);
    if (statusStep?.projectAgentMarker) {
        throw projectRunAuthorizationError(`Nested run '${run.id}' has a malformed project-agent marker in persisted status.`);
    }
    const statusModelIdentity = statusStep?.modelIdentity;
    const statusModelResolution = statusStep?.modelResolution;
    const contextUsage = statusStep?.contextUsage;
    const contextPressure = statusStep?.contextPressure;
    const contextPressureCrossedThresholds = statusStep?.contextPressureCrossedThresholds;
    const continuationAcceptance = state === "paused" ? resolveNestedContinuationAcceptance(run.id, statusStep) : undefined;
    let cwd = resolveTrustedNestedResumeCwd(asyncDir);
    if (projectAgentMarker) {
        const persistedCwd = statusStep?.cwd ?? run.cwd;
        const cwdValidation = validateProjectAgentCwdContainment(projectAgentMarker.provenance.projectRoot, persistedCwd);
        if (!cwdValidation.valid) {
            throw projectRunAuthorizationError(`Nested project-agent run '${run.id}' has an invalid persisted execution cwd: ${cwdValidation.reason}`);
        }
        cwd = cwdValidation.canonicalCwd;
    }
    return {
        kind: "revive",
        source: "nested",
        runId: run.id,
        state,
        agent,
        index: 0,
        ...(projectAgentMarker ? { projectAgent: projectAgentMarker } : {}),
        ...(continuationAcceptance ? { continuationAcceptance } : {}),
        ...(statusModelIdentity ? { modelIdentity: statusModelIdentity } : {}),
        ...(statusModelResolution ? { modelResolution: statusModelResolution } : {}),
        ...(contextUsage ? { contextUsage } : {}),
        ...(contextPressure ? { contextPressure: { ...contextPressure } } : {}),
        ...(contextPressureCrossedThresholds
            ? { contextPressureCrossedThresholds: [...contextPressureCrossedThresholds] }
            : {}),
        ...(statusStep?.activeRuntimeMs !== undefined
            ? { activeRuntimeMs: statusStep.activeRuntimeMs }
            : {}),
        ...(asyncDir ? { asyncDir } : {}),
        ...(run.state === "paused" ? { pauseKind: "cohort_pause" } : {}),
        ...(cwd ? { cwd } : {}),
        sessionFile: validateNestedSessionFile(run, trustedSessionRoots),
    };
}
function directNestedAsyncInterrupt(target) {
    const run = target.match.run;
    const asyncDir = resolveNestedAsyncDir(target.match.rootRunId, run);
    if (!asyncDir)
        return undefined;
    const status = reconcileAsyncRun(asyncDir, {
        resultsDir: path.join(RESULTS_DIR, "nested", target.match.rootRunId),
    }).status;
    if (status && hasMalformedProjectAgentControlMarker(status)) {
        return {
            content: [
                {
                    type: "text",
                    text: projectRunAuthorizationError("the nested target has a malformed project-agent marker; refusing interrupt fallback.").message,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const pid = typeof status?.pid === "number" && status.pid > 0 ? status.pid : run.pid;
    if (!status || status.state !== "running" || typeof pid !== "number" || pid <= 0)
        return undefined;
    try {
        deliverInterruptRequest({ asyncDir, pid, source: "nested-interrupt" });
        return {
            content: [{ type: "text", text: `Interrupt requested for nested async run ${run.id}.` }],
            details: { mode: "management", results: [] },
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [
                { type: "text", text: `Failed to interrupt nested async run ${run.id}: ${message}` },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
}
export function registerForegroundMessageInbox(control, _runId, index) {
    control.messageInboxRoot ??= path.join(FOREGROUND_LIVE_MESSAGE_INBOXES_DIR, randomUUID());
    const dir = path.join(control.messageInboxRoot, String(index));
    fs.mkdirSync(dir, { recursive: true });
    if (!control.activeMessageInboxes)
        control.activeMessageInboxes = new Map();
    control.activeMessageInboxes.set(index, dir);
    return dir;
}
export function clearForegroundMessageInbox(control, index) {
    const dir = control.activeMessageInboxes?.get(index);
    if (dir) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        catch {
        }
    }
    control.activeMessageInboxes?.delete(index);
    if (control.activeMessageInboxes?.size === 0) {
        control.activeMessageInboxes = undefined;
        if (control.messageInboxRoot) {
            try {
                fs.rmSync(control.messageInboxRoot, { recursive: true, force: true });
            }
            catch {
            }
        }
        control.messageInboxRoot = undefined;
    }
}
function directNestedAsyncSteer(input) {
    const run = input.target.match.run;
    const asyncDir = resolveNestedAsyncDir(input.target.match.rootRunId, run);
    if (!asyncDir)
        return undefined;
    const status = reconcileAsyncRun(asyncDir, {
        resultsDir: path.join(RESULTS_DIR, "nested", input.target.match.rootRunId),
    }).status;
    if (status && hasMalformedProjectAgentControlMarker(status)) {
        return {
            content: [
                {
                    type: "text",
                    text: projectRunAuthorizationError("the nested target has a malformed project-agent marker; refusing steer fallback.").message,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    if (!status || (status.state !== "running" && status.state !== "queued"))
        return undefined;
    const steps = status.steps ?? [];
    if (input.index !== undefined) {
        if (input.index < 0 || input.index >= steps.length)
            return {
                content: [
                    {
                        type: "text",
                        text: `Nested async run ${run.id} has ${steps.length} children. Index ${input.index} is out of range.`,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        const step = steps[input.index];
        if (step && step.status !== "running" && step.status !== "pending")
            return {
                content: [
                    {
                        type: "text",
                        text: `Nested async run ${run.id} child ${input.index} is ${step.status} and cannot be steered.`,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
    }
    requestAsyncSteer(asyncDir, {
        message: input.message,
        targetIndex: input.index,
        source: "nested-steer",
    });
    return {
        content: [
            {
                type: "text",
                text: `Steering queued for nested async run ${run.id}. Delivery requires a live Pi child session that supports mid-run steering.`,
            },
        ],
        details: { mode: "management", results: [] },
    };
}
function interruptNestedRun(target) {
    const run = target.match.run;
    if (run.state === "complete")
        return {
            content: [
                {
                    type: "text",
                    text: `Nested run ${run.id} is already complete and cannot be interrupted.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    if (run.state === "failed")
        return {
            content: [
                { type: "text", text: `Nested run ${run.id} has failed and cannot be interrupted.` },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    if (run.state === "paused")
        return {
            content: [{ type: "text", text: `Nested run ${run.id} is already paused.` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    const direct = directNestedAsyncInterrupt(target);
    if (direct)
        return direct;
    return {
        content: [
            {
                type: "text",
                text: `Nested run ${run.id} has no live async target (async run directory/pid), so no safe direct interrupt is available.`,
            },
        ],
        isError: true,
        details: { mode: "management", results: [] },
    };
}
function resumeLiveNestedRun(target) {
    const run = target.match.run;
    return {
        content: [
            {
                type: "text",
                text: `Nested run ${run.id} is live; no supported live nested resume path is available. Wait for completion, then retry action='resume' with a follow-up message.`,
            },
        ],
        isError: true,
        details: { mode: "management", results: [] },
    };
}
function steerNestedRun(input) {
    const run = input.target.match.run;
    if (run.state !== "running" && run.state !== "queued")
        return {
            content: [
                { type: "text", text: `Nested run ${run.id} is ${run.state} and cannot be steered.` },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    const direct = directNestedAsyncSteer(input);
    if (direct)
        return direct;
    return {
        content: [
            {
                type: "text",
                text: `Nested run ${run.id} is not a live async Pi child session with a steering inbox. action='steer' cannot target foreground nested runs.`,
            },
        ],
        isError: true,
        details: { mode: "management", results: [] },
    };
}
async function queueLiveAsyncResume(input) {
    if (!input.target.asyncDir) {
        return {
            content: [
                {
                    type: "text",
                    text: `Async run '${input.target.runId}' has no live run directory to resume.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const status = reconcileAsyncRun(input.target.asyncDir, {
        kill: input.kill,
        resultsDir: RESULTS_DIR,
    }).status;
    if (!status || status.state !== "running") {
        return {
            content: [
                {
                    type: "text",
                    text: `Async run '${input.target.runId}' is not running and cannot accept a live resume follow-up.`,
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
                    text: `Async run '${status.runId}' is owned by another session and cannot be resumed from this session.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const step = status.steps?.[input.target.index];
    if (!step) {
        return {
            content: [
                {
                    type: "text",
                    text: `Async run '${status.runId}' no longer has child ${input.target.index}. Wait for completion, then retry action='resume' if revival is still needed.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    if (step.status !== "running") {
        return {
            content: [
                {
                    type: "text",
                    text: `Async run '${status.runId}' child ${input.target.index} is ${step.status} and cannot accept a live resume follow-up.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const requestId = randomUUID();
    const requestPath = requestAsyncResume(input.target.asyncDir, {
        id: requestId,
        message: input.followUp,
        targetIndex: input.target.index,
        source: "async-resume",
    });
    const acceptance = await waitForChildMessageAcceptance({
        asyncDir: input.target.asyncDir,
        requestId,
        isRunnerAlive: () => {
            if (typeof status.pid !== "number" || status.pid <= 0)
                return false;
            try {
                (input.kill ?? process.kill)(status.pid, 0);
                return true;
            }
            catch {
                return false;
            }
        },
    });
    if (acceptance.outcome !== "acknowledged" ||
        acceptance.acceptance.status !== "accepted" ||
        !acceptance.acceptance.acceptedIndexes.includes(input.target.index)) {
        try {
            fs.rmSync(requestPath, { force: true });
        }
        catch {
        }
        const lateAckPath = childMessageAckPath(input.target.asyncDir, requestId);
        try {
            fs.rmSync(lateAckPath, { force: true });
        }
        catch {
        }
        const lateAckCleanup = setTimeout(() => {
            try {
                fs.rmSync(lateAckPath, { force: true });
            }
            catch {
            }
        }, 2_500);
        lateAckCleanup.unref?.();
        const reason = acceptance.outcome === "runner_gone"
            ? "the runner disappeared before accepting it"
            : acceptance.outcome === "timeout"
                ? "the runner did not acknowledge it before the acceptance timeout"
                : (acceptance.acceptance.reason ??
                    acceptance.acceptance.rejected?.[0]?.reason ??
                    "the target child rejected it");
        return {
            content: [
                {
                    type: "text",
                    text: `Live resume follow-up for async run '${status.runId}' child ${input.target.index} was not accepted: ${reason}.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const tracked = input.state.asyncJobs.get(status.runId);
    if (tracked)
        tracked.updatedAt = Date.now();
    return {
        content: [
            {
                type: "text",
                text: `Resume follow-up accepted for live async run ${status.runId} child ${input.target.index} and queued in its native inbox.`,
            },
        ],
        details: { mode: "management", results: [] },
    };
}
function explicitResumeModel(value) {
    const trimmed = value?.trim();
    return trimmed && trimmed !== "inherit" ? trimmed : undefined;
}
export function buildResumeModelResolution(target, requestedModel) {
    const persisted = target.kind === "revive" ? target.modelResolution : undefined;
    const persistedEffective = target.kind === "revive" ? (target.modelIdentity ?? persisted?.resumed) : undefined;
    const persistedOriginal = target.kind === "revive" ? (persisted?.original ?? persistedEffective) : undefined;
    const explicit = explicitResumeModel(requestedModel);
    if (explicit) {
        const explicitIdentity = canonicalSubagentModelIdentity(explicit);
        const reference = persistedEffective ?? persistedOriginal;
        return {
            kind: "override",
            ...(reference ? { original: reference } : {}),
            ...(explicitIdentity ? { resumed: explicitIdentity } : {}),
            reason: [
                persisted?.reason,
                reference
                    ? `Caller explicitly overrode persisted selection ${reference.provider}/${reference.model}${reference.thinking ? `:${reference.thinking}` : ""} with '${explicit}'.`
                    : `Caller explicitly selected '${explicit}' for the resumed child.`,
            ]
                .filter(Boolean)
                .join(" "),
        };
    }
    if (!persistedEffective)
        return undefined;
    const restoration = `Restored persisted child selection ${persistedEffective.provider}/${persistedEffective.model}${persistedEffective.thinking ? `:${persistedEffective.thinking}` : ""} instead of the current parent model.`;
    return persisted?.kind === "fallback"
        ? {
            ...persisted,
            ...(persistedOriginal ? { original: persistedOriginal } : {}),
            resumed: persistedEffective,
            reason: [persisted.reason, restoration].join(" "),
        }
        : {
            kind: "restored",
            original: persistedOriginal,
            resumed: persistedEffective,
            reason: [persisted?.reason, restoration].filter(Boolean).join(" "),
        };
}
async function authorizeProjectSteerTarget(input) {
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
function projectInterruptResolutionMismatch(lookup, resolvedId) {
    if (lookup.status !== "found" || lookup.runId === resolvedId)
        return undefined;
    return projectRunAuthorizationError(resolvedId
        ? `the retained project-agent run '${lookup.runId}' does not match the resolved interrupt target '${resolvedId}'; refusing cancellation.`
        : "the retained project-agent run could not be resolved to a cancellable target; refusing cancellation.");
}
function projectInterruptAuthorizationResult(error) {
    return {
        content: [{ type: "text", text: error.message }],
        isError: true,
        details: { mode: "management", results: [] },
    };
}
async function authorizeProjectInterruptTarget(input) {
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
async function resolveResumeActionTarget(input) {
    let target;
    try {
        let resolved;
        try {
            resolved = input.requestedId
                ? resolveSubagentRunId(input.requestedId, { state: input.deps.state })
                : undefined;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "";
            const asyncMatches = message.match(/async:/g)?.length ?? 0;
            if (!isResumeAmbiguity(error) || !message.includes("foreground:") || asyncMatches !== 1)
                throw error;
        }
        if (resolved?.kind === "nested") {
            if (input.privateProjectLookup.status === "found") {
                throw projectRunAuthorizationError("the retained project-agent run resolved to an unsupported nested control target.");
            }
            if (resolved.match.run.state === "running" || resolved.match.run.state === "queued") {
                return resumeLiveNestedRun(resolved);
            }
            const trustedSessionRoots = input.parentSessionFile
                ? [input.deps.getSubagentSessionRoot(input.parentSessionFile)]
                : [];
            target = resolveNestedResumeTarget(resolved, trustedSessionRoots);
        }
        else if (resolved?.kind === "async" || input.params.dir) {
            const preResolutionDir = resolved?.kind === "async"
                ? resolved.location.asyncDir
                : input.params.dir
                    ? path.resolve(input.params.dir)
                    : null;
            const preResolutionStatus = preResolutionDir ? readStatus(preResolutionDir) : undefined;
            const hadLiveResumeIntent = Boolean(input.requestedFollowUp && preResolutionStatus?.state === "running");
            const asyncTarget = {
                source: "async",
                ...resolveAsyncResumeTarget(input.privateProjectLookup.status === "found"
                    ? { ...input.params, id: input.privateProjectLookup.runId }
                    : input.params, { kill: input.deps.kill, resultsDir: RESULTS_DIR }, { requireSessionFile: true, readOnly: preResolutionStatus?.state !== "running" }),
            };
            rejectMissingPrivateProjectReference(input.privateProjectLookup, asyncTarget, {
                allowFreshResume: asyncTarget.kind === "revive",
            });
            if (hadLiveResumeIntent && asyncTarget.kind !== "live") {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Async run '${asyncTarget.runId}' was running when resume began, but its runner or selected child went stale before the live follow-up could be accepted. No durable revival was started.`,
                        },
                    ],
                    isError: true,
                    details: { mode: "management", results: [] },
                };
            }
            if (asyncTarget.kind === "live") {
                if (!input.requestedFollowUp)
                    return {
                        content: [{ type: "text", text: "action='resume' requires message." }],
                        isError: true,
                        details: { mode: "management", results: [] },
                    };
                if (input.privateProjectLookup.status === "found") {
                    try {
                        requirePersistedProjectCaptureForTarget(input.privateProjectLookup, asyncTarget);
                        await authorizePersistedProjectAgentRun({
                            target: asyncTarget,
                            ctx: input.ctx,
                            deps: input.deps,
                        });
                    }
                    catch (error) {
                        return {
                            content: [
                                { type: "text", text: error instanceof Error ? error.message : String(error) },
                            ],
                            isError: true,
                            details: { mode: "management", results: [] },
                        };
                    }
                }
                return queueLiveAsyncResume({
                    target: asyncTarget,
                    followUp: input.requestedFollowUp,
                    state: input.deps.state,
                    kill: input.deps.kill,
                });
            }
            target = asyncTarget;
        }
        else {
            target = resolveResumeTarget(input.params, input.deps.state, {
                asyncRequireSessionFile: true,
                readOnly: true,
            });
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
    return target;
}
async function resumeAsyncRun(input) {
    const requestedFollowUp = (input.params.message ?? input.params.task ?? "").trim();
    input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
    const privateProjectLookup = lookupPrivateProjectActionReference(input.params);
    if (privateProjectLookup.status === "ambiguous") {
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
    }
    const resolutionParams = privateProjectLookup.status === "found"
        ? { ...input.params, id: privateProjectLookup.runId }
        : input.params;
    const requestedId = resolutionParams.id;
    const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
    const targetResolution = await resolveResumeActionTarget({
        params: resolutionParams,
        requestedId,
        requestedFollowUp,
        privateProjectLookup,
        ctx: input.ctx,
        deps: input.deps,
        requestCwd: input.requestCwd,
        parentSessionFile,
    });
    if ("content" in targetResolution)
        return targetResolution;
    const target = targetResolution;
    try {
        rejectMissingPrivateProjectReference(privateProjectLookup, target, {
            allowFreshResume: target.kind === "revive",
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: message }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const followUp = requestedFollowUp ||
        (target.kind === "revive" &&
            target.state === "paused" &&
            target.pauseKind === "awaiting_supervisor"
            ? UNCHANGED_SUPERVISOR_RESUME_MESSAGE
            : "");
    if (!followUp) {
        return {
            content: [{ type: "text", text: "action='resume' requires message." }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    let persistedProjectAuthorization;
    const targetProjectCapture = "projectAgent" in target ? target.projectAgent : undefined;
    if (privateProjectLookup.status === "found" || targetProjectCapture !== undefined) {
        try {
            requirePersistedProjectCaptureForTarget(privateProjectLookup, target);
            persistedProjectAuthorization = await authorizePersistedProjectAgentRun({
                target,
                ctx: input.ctx,
                deps: input.deps,
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
    const { blocked, depth, maxDepth } = checkSubagentDepth(input.deps.config.maxSubagentDepth);
    if (blocked) {
        return {
            content: [
                {
                    type: "text",
                    text: `Nested subagent resume blocked (depth=${depth}, max=${maxDepth}). Complete the follow-up directly instead.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
    const effectiveCwd = persistedProjectAuthorization?.canonicalCwd ?? target.cwd ?? input.requestCwd;
    const scope = resolveExecutionAgentScope(input.params.agentScope);
    const discovered = persistedProjectAuthorization
        ? {
            agents: [persistedProjectAuthorization.agentConfig],
            modelScope: persistedProjectAuthorization.modelScope,
        }
        : input.deps.discoverAgents(effectiveCwd, scope);
    const discoveredAgents = discovered.agents;
    const modelScope = discovered.modelScope;
    const agents = discoveredAgents;
    const agentConfig = agents.find((agent) => agent.name === target.agent) ??
        persistedProjectAuthorization?.agentConfig;
    if (!agentConfig) {
        return {
            content: [
                {
                    type: "text",
                    text: unknownAgentMessage(target.agent, discovered.agentDiagnostics, "Unknown agent for resume"),
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const callerTimeout = resolveForegroundTimeout(input.params);
    if (callerTimeout.error) {
        return {
            content: [{ type: "text", text: callerTimeout.error }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const activeRuntimeMs = Math.max(0, target.activeRuntimeMs ?? 0);
    const remainingAgentTimeMs = remainingExecutionTimeMs(agentConfig.maxExecutionTimeMs, activeRuntimeMs);
    if (remainingAgentTimeMs === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: `Agent '${target.agent}' has exhausted its maxExecutionTimeMs ceiling after ${activeRuntimeMs}ms of active runtime.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const modelRegistrySnapshot = readModelRegistrySnapshot(input.ctx);
    const { availableModels } = modelRegistrySnapshot;
    let modelContextWindow;
    if (target.kind === "revive") {
        const selectedModel = explicitResumeModel(input.params.model) ??
            (target.modelIdentity ? modelReferenceFromIdentity(target.modelIdentity) : undefined) ??
            agentConfig.model ??
            (input.ctx.model ? `${input.ctx.model.provider}/${input.ctx.model.id}` : undefined);
        modelContextWindow = resolveEffectiveContextWindow(selectedModel, availableModels, input.ctx.model?.provider);
        const contextAssessment = assessDurableResumeContext(target.contextUsage, modelContextWindow ?? target.contextUsage?.contextWindow);
        if (contextAssessment.blocked) {
            return {
                content: [{ type: "text", text: formatDurableResumeContextBlock(contextAssessment) }],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
    }
    const continuationRunId = randomUUID().slice(0, 8);
    let claimedPause;
    try {
        const claimDecision = claimPausedAwaitingSupervisorTarget(target, continuationRunId, modelContextWindow);
        if (claimDecision && "blockedMessage" in claimDecision) {
            return {
                content: [{ type: "text", text: claimDecision.blockedMessage }],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        claimedPause = claimDecision;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: message }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const runId = continuationRunId;
    const artifactConfig = {
        ...DEFAULT_ARTIFACT_CONFIG,
        enabled: input.params.artifacts !== false,
    };
    const artifactsDir = getArtifactsDir(parentSessionFile);
    const resumeModelResolution = buildResumeModelResolution(target, input.params.model);
    const restoredModelIdentity = explicitResumeModel(input.params.model) || target.kind !== "revive"
        ? undefined
        : target.modelIdentity;
    let projectRunTransferred = false;
    if (persistedProjectAuthorization) {
        try {
            if (persistedProjectAuthorization.freshRebind) {
                retainProjectAgentRunReference(persistedProjectAuthorization.capability, runId, [
                    persistedProjectAuthorization.capture,
                ]);
            }
            else {
                retainProjectAgentRunReferenceFrom(target.runId, runId);
            }
            projectRunTransferred = true;
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `TLH project-agent control rejected: could not retain the authorized generation: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
    }
    let result;
    try {
        result = (input.deps.executeAsyncSingle ?? executeAsyncSingle)(runId, {
            agent: target.agent,
            ...(claimedPause
                ? {
                    continuationSource: {
                        asyncDir: claimedPause.asyncDir,
                        runId: target.runId,
                        index: target.index,
                        claimToken: claimedPause.claimToken,
                        ...(persistedProjectAuthorization
                            ? { projectAgent: persistedProjectAuthorization.capture }
                            : {}),
                    },
                }
                : {}),
            ...(target.source === "async" && target.tkTicket
                ? { inheritedTkTicket: target.tkTicket }
                : {}),
            task: buildRevivedAsyncTask(target, followUp),
            modelOverride: input.params.model,
            ...(restoredModelIdentity ? { restoredModelIdentity } : {}),
            ...(resumeModelResolution ? { modelResolution: resumeModelResolution } : {}),
            ...(target.kind === "revive" && "contextUsage" in target && target.contextUsage
                ? { contextUsage: target.contextUsage }
                : {}),
            ...(target.kind === "revive" && !claimedPause && "contextPressure" in target
                ? { contextPressure: target.contextPressure }
                : {}),
            ...(target.kind === "revive" && !claimedPause && "contextPressureCrossedThresholds" in target
                ? { contextPressureCrossedThresholds: target.contextPressureCrossedThresholds }
                : {}),
            agentConfig,
            projectAgent: persistedProjectAuthorization?.capture,
            ctx: {
                pi: input.deps.pi,
                cwd: persistedProjectAuthorization?.canonicalCwd ?? input.requestCwd,
                currentSessionId: input.deps.state.currentSessionId,
                parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
                currentModelProvider: input.ctx.model?.provider,
                currentModel: input.ctx.model,
                modelScope,
            },
            cwd: effectiveCwd,
            maxOutput: input.params.maxOutput,
            artifactsDir,
            artifactConfig,
            shareEnabled: input.params.share === true,
            sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile),
            sessionFile: target.sessionFile,
            acceptance: input.params.acceptance,
            continuationAcceptance: target.state === "paused" ? target.continuationAcceptance : undefined,
            activeRuntimeMs,
            timeoutMs: callerTimeout.timeoutMs,
            outputBaseDir: resolveSingleRunOutputBaseDir(artifactsDir, runId),
            maxSubagentDepth: resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth),
            controlConfig: resolveControlConfig(input.deps.config.control, input.params.control),
            availableModels,
            modelRegistry: modelRegistrySnapshot.evidence,
            fallbackModels: input.params.fallbackModels,
            modelFallbackNotice: input.params.modelFallbackNotice,
        });
    }
    catch (error) {
        claimedPause?.rollbackReserved();
        if (projectRunTransferred)
            releaseProjectAgentRunReference(runId);
        throw error;
    }
    if (result.isError) {
        claimedPause?.rollbackReserved();
        if (projectRunTransferred)
            releaseProjectAgentRunReference(runId);
        return result;
    }
    const revivedId = result.details.asyncId ?? runId;
    claimedPause?.markSpawned();
    if (persistedProjectAuthorization)
        releaseProjectSourceAfterContinuation(target);
    if (target.source === "foreground")
        input.deps.state.foregroundRuns?.delete(target.runId);
    const sourceLabel = target.source;
    const privacySafeSupervisorResume = target.kind === "revive" &&
        target.state === "paused" &&
        target.pauseKind === "awaiting_supervisor";
    const lines = [
        `Revived ${sourceLabel} subagent from ${target.runId}.`,
        `Revived run: ${revivedId}`,
        `Agent: ${target.agent}`,
        persistedProjectAuthorization?.digestChangeNotice
            ? `Notice: ${persistedProjectAuthorization.digestChangeNotice}`
            : undefined,
        privacySafeSupervisorResume ? undefined : `Session: ${target.sessionFile}`,
        !privacySafeSupervisorResume && result.details.asyncDir
            ? `Async dir: ${result.details.asyncDir}`
            : undefined,
        `Status if needed: subagent({ action: "status", id: "${revivedId}" })`,
    ].filter((line) => Boolean(line));
    return {
        content: [{ type: "text", text: formatAsyncStartedMessage(lines.join("\n")) }],
        details: result.details,
    };
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
function diagnosticMatchesAgent(diagnostic, agentName) {
    if (diagnostic.error.includes(`Agent '${agentName}'`))
        return true;
    const localName = diagnostic.error.match(/Agent '([^']+)'/)?.[1];
    if (localName !== undefined && agentName.endsWith(`.${localName}`))
        return true;
    const fileName = path.basename(diagnostic.filePath, path.extname(diagnostic.filePath));
    return agentName === fileName || agentName.endsWith(`.${fileName}`);
}
function unknownAgentMessage(agentName, agentDiagnostics, prefix = "Unknown agent") {
    const diagnostic = agentDiagnostics?.find((candidate) => diagnosticMatchesAgent(candidate, agentName));
    if (!diagnostic)
        return `${prefix}: ${agentName}`;
    return `${prefix}: ${agentName}. Malformed definition at '${diagnostic.filePath}': ${diagnostic.error}`;
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
function getRequestedModeLabel(params) {
    if ((params.tasks?.length ?? 0) > 0)
        return "parallel";
    if (params.agent)
        return "single";
    return "single";
}
function buildRequestedModeError(params, message) {
    return {
        content: [{ type: "text", text: message }],
        isError: true,
        details: { mode: getRequestedModeLabel(params), results: [] },
    };
}
function resolveForegroundTimeout(params) {
    const rawTimeout = params.timeoutMs;
    if (rawTimeout === undefined)
        return {};
    if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout <= 0) {
        return { error: "timeoutMs must be a positive integer." };
    }
    return { timeoutMs: rawTimeout };
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
            ...(task.fallbackModels ? { fallbackModels: task.fallbackModels } : {}),
            ...(task.modelFallbackNotice ? { modelFallbackNotice: task.modelFallbackNotice } : {}),
            ...(task.output === true
                ? agentConfigs[index]?.output
                    ? { output: agentConfigs[index].output }
                    : {}
                : task.output !== undefined
                    ? { output: task.output }
                    : {}),
            ...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
            ...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
            ...(task.progress !== undefined ? { progress: task.progress } : {}),
            ...(task.toolBudget !== undefined ? { toolBudget: task.toolBudget } : {}),
            ...(task.acceptance !== undefined ? { acceptance: task.acceptance } : {}),
        }));
        return releaseAsyncProjectRunOnError(executeAsyncParallel(id, {
            tasks: parallelTasks,
            concurrency: resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency),
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
        const effectiveTimeoutMs = resolveEffectiveSingleTimeout(data.timeoutMs, a.maxExecutionTimeMs);
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
            fallbackModels: params.fallbackModels,
            modelFallbackNotice: params.modelFallbackNotice,
            maxSubagentDepth,
            controlConfig,
            nestedRoute,
            acceptance: params.acceptance,
            timeoutMs: effectiveTimeoutMs,
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
function resolveSingleRunOutputBaseDir(artifactsDir, runId) {
    return path.join(artifactsDir, "outputs", runId);
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
            fallbackModels: behavior?.fallbackModels,
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
    const allProgress = [];
    const allArtifactPaths = [];
    const tasks = params.tasks;
    const tkTicketContext = resolveTkTicketTaskContext({ runnerCwd: effectiveCwd, tasks });
    const tkTicket = tkTicketContext
        ? resolveTkTicketMetadata(tkTicketContext.task, { cwd: tkTicketContext.cwd })
        : undefined;
    const tkTicketIndex = tkTicketContext?.taskIndex;
    const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
    const parallelConcurrency = resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency);
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
        ...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
        ...(task.progress !== undefined ? { progress: task.progress } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(task.fallbackModels ? { fallbackModels: task.fallbackModels } : {}),
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
        if (result.progress)
            allProgress.push(result.progress);
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
        progress: params.includeProgress ? allProgress : undefined,
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
    const allProgress = [];
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
    const fallbackModels = params.fallbackModels;
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
    const deadlineAt = data.deadlineAt ??
        (effectiveTimeoutMs !== undefined ? Date.now() + effectiveTimeoutMs : undefined);
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
            fallbackModels,
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
    if (r.progress)
        allProgress.push(r.progress);
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
        progress: params.includeProgress ? allProgress : undefined,
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
                                    text: "Live foreground transcript is already visible in the expanded running subagent result. Persisted session transcript becomes inspectable after the foreground run completes when sessions are enabled.",
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
                        text: "Live foreground transcript is already visible in the expanded running subagent result. Pass an async run id to inspect a background transcript.",
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
    const execute = async (_id, params, signal, onUpdate, ctx) => {
        deps.state.baseCwd = ctx.cwd;
        deps.state.foregroundRuns ??= new Map();
        deps.state.foregroundControls ??= new Map();
        deps.state.lastForegroundControlId ??= null;
        const requestParams = params;
        const requestCwd = resolveRequestedCwd(ctx.cwd, requestParams.cwd);
        const paramsWithResolvedCwd = requestParams.cwd === undefined ? requestParams : { ...requestParams, cwd: requestCwd };
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
                return resumeAsyncRun({ params: paramsWithResolvedCwd, requestCwd, ctx, deps });
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
        const foregroundTimeout = resolveForegroundTimeout(effectiveParams);
        if (foregroundTimeout.error)
            return buildRequestedModeError(effectiveParams, foregroundTimeout.error);
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
            ...DEFAULT_ARTIFACT_CONFIG,
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
            timeoutMs: foregroundTimeout.timeoutMs,
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
