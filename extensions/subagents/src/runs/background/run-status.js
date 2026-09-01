import * as fs from "node:fs";
import * as path from "node:path";
import { formatAsyncRunList, formatAsyncRunOutputPath, formatAsyncRunProgressLabel, listAsyncRuns, } from "./async-status.js";
import { formatAsyncResultTranscript, formatAsyncRunTranscript, formatNestedRunTranscript, inspectSubagentFleet, } from "./fleet-view.js";
import { formatNestedRunStatusLines } from "../shared/nested-render.js";
import { formatModelThinking, shortenPath } from "../../shared/formatters.js";
import { formatActivityLabel } from "../../shared/status-format.js";
import { ASYNC_DIR, RESULTS_DIR, } from "../../shared/types.js";
import { resolveAsyncRunLocation } from "./async-resume.js";
import { resolveSubagentRunId } from "./run-id-resolver.js";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "./parallel-groups.js";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.js";
import { formatOwnedProcessGroupCleanup } from "../shared/process-group-cleanup.js";
import { attachRootChildrenToSteps, findNestedRouteForRootId, projectNestedRegistryForRoot, } from "../shared/nested-events.js";
import { formatForegroundSupervisorPauseMessage } from "../../shared/foreground-pause.js";
import { lifecycleContinuationForIndex } from "../shared/lifecycle-state.js";
import { formatProtectedLifecycleCleanup, isProtectedPausedLifecycle, protectedLifecycleText, } from "../shared/lifecycle-privacy.js";
import { safeTerminalDocument, safeTerminalText } from "../../shared/display-text.js";
import { acceptanceRejectionReason } from "../shared/acceptance.js";
import { formatRejectionReason } from "../../shared/string-utils.js";
function hasExistingSessionFile(value) {
    return typeof value === "string" && fs.existsSync(value);
}
function formatResumeGuidance(runId, children, fallbackSessionFile) {
    const knownChildren = children
        .map((child, index) => ({ child, index }))
        .filter(({ child }) => typeof child.agent === "string");
    if (!runId || knownChildren.length === 0)
        return "Resume: unavailable; no child session file was persisted.";
    const safeRunId = safeTerminalText(runId);
    const singleSessionFile = knownChildren[0]?.child.sessionFile ?? fallbackSessionFile;
    if (children.length === 1 &&
        knownChildren.length === 1 &&
        hasExistingSessionFile(singleSessionFile)) {
        return `Revive: subagent({ action: "resume", id: "${safeRunId}", message: "..." })`;
    }
    const childWithSession = knownChildren.find(({ child }) => hasExistingSessionFile(child.sessionFile));
    if (childWithSession) {
        return `Revive child: subagent({ action: "resume", id: "${safeRunId}", index: ${childWithSession.index}, message: "..." })`;
    }
    return "Resume: unavailable; no child session file was persisted.";
}
function isPausedAwaitingSupervisorStatus(status) {
    return status.state === "paused" && status.pause?.kind === "awaiting_supervisor";
}
function isPausedAwaitingSupervisorStep(status, step) {
    return (status.state === "paused" &&
        step.status === "paused" &&
        step.pause?.kind === "awaiting_supervisor");
}
function isPausedCohortStep(status, step) {
    return (status.state === "paused" && step.status === "paused" && step.pause?.kind === "cohort_pause");
}
function isPausingLifecycleStep(status, step) {
    return Boolean(step.pause?.kind) && (status.state === "pausing" || step.status === "pausing");
}
function stepLineLabel(status, index) {
    const steps = status.steps ?? [];
    if (status.mode === "parallel")
        return `Agent ${index + 1}/${steps.length || 1}`;
    if (status.mode === "chain") {
        const chainStepCount = status.chainStepCount ?? (steps.length || 1);
        const groups = normalizeParallelGroups(status.parallelGroups, steps.length, chainStepCount);
        const group = groups.find((candidate) => index >= candidate.start && index < candidate.start + candidate.count);
        if (group)
            return `Step ${group.stepIndex + 1}/${chainStepCount} Agent ${index - group.start + 1}/${group.count}`;
        return `Step ${flatToLogicalStepIndex(index, chainStepCount, groups) + 1}/${chainStepCount}`;
    }
    return `Step ${index + 1}`;
}
function nestedRunDisplayName(run) {
    if (run.agent)
        return run.agent;
    if (run.agents?.length)
        return run.agents.join(", ");
    return run.id;
}
function formatSteeringSummary(input) {
    const parts = [];
    if (input.steerCount !== undefined)
        parts.push(`${input.steerCount} steer${input.steerCount === 1 ? "" : "s"}`);
    if (typeof input.lastSteerAt === "number" && Number.isFinite(input.lastSteerAt))
        parts.push(`last ${new Date(input.lastSteerAt).toISOString()}`);
    return parts.length ? parts.join(", ") : undefined;
}
function formatAsyncStepStatusLines(status, step, index, asyncDir, outputPath, privacySafeAwaitingSupervisorLifecycle) {
    const lines = [];
    const stepActivityText = step.status === "running"
        ? formatActivityLabel(step.lastActivityAt, step.activityState)
        : undefined;
    const modelThinking = safeTerminalText(formatModelThinking(step.model, step.thinking));
    const modelText = modelThinking ? ` (${modelThinking})` : "";
    const steeringText = formatSteeringSummary(step);
    const steeringSuffix = steeringText ? `, steering: ${steeringText}` : "";
    const errorText = step.error
        ? `, error: ${privacySafeAwaitingSupervisorLifecycle ? protectedLifecycleText("error").replace(/\.$/, "") : safeTerminalText(step.error)}`
        : "";
    const acceptanceText = step.acceptance?.status
        ? `, acceptance: ${safeTerminalText(step.acceptance.status)}`
        : "";
    const display = step.label
        ? `${safeTerminalText(step.label)} (${safeTerminalText(step.agent)})`
        : safeTerminalText(step.agent);
    const phase = step.phase ? `[${safeTerminalText(step.phase)}] ` : "";
    lines.push(`${stepLineLabel(status, index)}: ${phase}${display} ${safeTerminalText(step.status)}${modelText}${stepActivityText ? `, ${safeTerminalText(stepActivityText)}` : ""}${steeringSuffix}${acceptanceText}${errorText}`);
    if (step.acceptance?.status === "rejected" && !privacySafeAwaitingSupervisorLifecycle) {
        const reason = acceptanceRejectionReason(step.acceptance);
        if (reason)
            lines.push(`  Acceptance reason: ${safeTerminalText(formatRejectionReason(reason))}`);
    }
    const stepContinuation = lifecycleContinuationForIndex(status, index);
    const stepClaimed = typeof stepContinuation?.claimToken === "string" && stepContinuation.claimToken.length > 0;
    if (isPausedAwaitingSupervisorStep(status, step)) {
        lines.push(`  Pause: awaiting supervisor${step.pause?.summary ? ` (${safeTerminalText(step.pause.summary)})` : ""}`);
        lines.push("  No child process is running.");
        if (stepClaimed) {
            lines.push("  Resume unchanged: unavailable; this paused child is already claimed for continuation.");
            lines.push("  Resume with guidance: unavailable; this paused child is already claimed for continuation.");
            lines.push("  Cancel: unavailable while continuation launch is finalizing.");
        }
        else {
            lines.push(`  Resume unchanged: subagent({ action: "resume", id: "${safeTerminalText(status.runId)}", index: ${index} })`);
            lines.push(`  Resume with guidance: subagent({ action: "resume", id: "${safeTerminalText(status.runId)}", index: ${index}, message: "Supervisor replied: ..." })`);
            lines.push(`  Cancel: subagent({ action: "interrupt", id: "${safeTerminalText(status.runId)}", index: ${index} })`);
        }
    }
    else if (isPausedCohortStep(status, step)) {
        lines.push("  Pause: cohort pause while another child awaited supervisor.");
        lines.push(`  Resume child: subagent({ action: "resume", id: "${safeTerminalText(status.runId)}", index: ${index}, message: "..." })`);
        lines.push(`  Cancel child: subagent({ action: "interrupt", id: "${safeTerminalText(status.runId)}", index: ${index} })`);
    }
    else if (isPausingLifecycleStep(status, step)) {
        if (step.pause?.kind === "awaiting_supervisor")
            lines.push(`  Pause: awaiting supervisor${step.pause.summary ? ` (${safeTerminalText(step.pause.summary)})` : ""}`);
        else
            lines.push("  Pause: cohort pause while another child awaited supervisor.");
        lines.push("  Stopping/reaping child; not resumable yet; check status again.");
    }
    if (step.exitCode !== undefined)
        lines.push(`  Exit code: ${step.exitCode}`);
    if (step.exitSignal)
        lines.push(`  Exit signal: ${step.exitSignal}`);
    if (step.processCleanup) {
        lines.push(`  Cleanup: ${privacySafeAwaitingSupervisorLifecycle ? formatProtectedLifecycleCleanup(step.processCleanup) : formatOwnedProcessGroupCleanup(step.processCleanup)}`);
        if (!privacySafeAwaitingSupervisorLifecycle)
            for (const warning of step.processCleanup.warnings ?? [])
                lines.push(`  Cleanup warning: ${safeTerminalText(warning)}`);
    }
    lines.push(...formatNestedRunStatusLines(step.children, {
        indent: "  ",
        commandHints: true,
        maxLines: 20,
        redactSensitiveDetails: privacySafeAwaitingSupervisorLifecycle,
    }));
    const stepOutputPath = path.join(asyncDir, `output-${index}.log`);
    if (!privacySafeAwaitingSupervisorLifecycle &&
        stepOutputPath !== outputPath &&
        fs.existsSync(stepOutputPath))
        lines.push(`  Output: ${safeTerminalText(stepOutputPath)}`);
    if (step.status === "running") {
        lines.push(`  Steer: subagent({ action: "steer", id: "${safeTerminalText(status.runId)}", index: ${index}, message: "..." })`);
    }
    return lines;
}
function rememberedForegroundChildOutput(child) {
    const outputPath = child.artifactPaths?.outputPath;
    if (outputPath && fs.existsSync(outputPath)) {
        try {
            const artifactOutput = fs.readFileSync(outputPath, "utf-8").trim();
            if (artifactOutput)
                return artifactOutput;
        }
        catch {
        }
    }
    return child.finalOutput ?? "";
}
function formatRememberedForegroundStatus(run) {
    const runId = safeTerminalText(run.runId);
    const lines = [
        `Run: ${runId}`,
        "State: remembered foreground",
        `Mode: ${safeTerminalText(run.mode)}`,
        `Updated: ${new Date(run.updatedAt).toISOString()}`,
    ];
    for (const child of run.children) {
        const output = safeTerminalText(rememberedForegroundChildOutput(child))
            .trim()
            .split(/\r?\n/)
            .find((line) => line.trim());
        const statusLabel = child.cancel?.cancelledAt ? "cancelled" : safeTerminalText(child.status);
        const parts = [
            `${child.index + 1}. ${safeTerminalText(child.agent)} ${statusLabel}`,
            child.exitCode !== undefined ? `exit ${child.exitCode}` : undefined,
            child.pause?.kind === "awaiting_supervisor" && !child.cancel?.cancelledAt
                ? "awaiting supervisor"
                : undefined,
            output ? `output: ${output.slice(0, 160)}` : undefined,
        ].filter(Boolean);
        lines.push(parts.join(", "));
        if (child.pause?.kind !== "awaiting_supervisor") {
            if (child.transcriptPath)
                lines.push(`  Transcript: ${safeTerminalText(shortenPath(child.transcriptPath))}`);
            if (child.artifactPaths?.outputPath)
                lines.push(`  Output: ${safeTerminalText(shortenPath(child.artifactPaths.outputPath))}`);
        }
        if (child.transcriptError)
            lines.push(`  Transcript warning: ${safeTerminalText(child.transcriptError)}`);
        if (child.pause?.kind === "awaiting_supervisor" && !child.cancel?.cancelledAt) {
            lines.push(...formatForegroundSupervisorPauseMessage({
                headline: `Child ${child.index + 1} is paused awaiting supervisor.`,
                runId,
                agent: safeTerminalText(child.agent),
                requestSummary: child.pause.summary
                    ? safeTerminalText(child.pause.summary)
                    : child.pause.summary,
                index: child.index,
            })
                .split("\n")
                .map((line) => `  ${line}`));
        }
    }
    lines.push("", `Status: subagent({ action: "status", id: "${runId}" })`);
    if (run.children.length === 1)
        lines.push(`Transcript: subagent({ action: "status", id: "${runId}", view: "transcript" })`);
    else
        lines.push(`Transcript: subagent({ action: "status", id: "${runId}", index: 0, view: "transcript" })`);
    const resumable = run.children.find((child) => !child.cancel?.cancelledAt && hasExistingSessionFile(child.sessionFile));
    const awaitingSupervisor = run.children.some((child) => child.pause?.kind === "awaiting_supervisor" && !child.cancel?.cancelledAt);
    if (resumable && !awaitingSupervisor) {
        lines.push(run.children.length === 1
            ? `Resume with guidance: subagent({ action: "resume", id: "${runId}", message: "..." })`
            : `Resume child with guidance: subagent({ action: "resume", id: "${runId}", index: ${resumable.index}, message: "..." })`);
    }
    else if (run.children.some((child) => child.cancel?.cancelledAt)) {
        lines.push("Resume: unavailable; this paused foreground run was cancelled and kept its existing artifacts.");
    }
    else {
        lines.push("Resume: unavailable; no child session file was persisted.");
    }
    return safeTerminalDocument(lines.join("\n"));
}
function formatRememberedForegroundTranscript(run, options) {
    let index = options.index;
    if (index !== undefined && !Number.isInteger(index))
        throw new Error("Transcript index must be an integer.");
    if (index === undefined && run.children.length === 1)
        index = 0;
    if (index === undefined)
        return `Transcript view requires index for foreground run '${safeTerminalText(run.runId)}' with ${run.children.length} children.`;
    if (index < 0 || index >= run.children.length)
        throw new Error(`Transcript index ${index} is out of range for ${run.children.length} foreground children.`);
    const child = run.children[index];
    const lineLimit = Math.max(1, Math.min(options.lines ?? 80, 1000));
    const outputLines = safeTerminalText(rememberedForegroundChildOutput(child))
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .slice(-lineLimit);
    const lines = [
        `Run: ${safeTerminalText(run.runId)}`,
        `State: ${safeTerminalText(child.cancel?.cancelledAt ? "cancelled" : child.status)}`,
        `Child: ${index} (${safeTerminalText(child.agent)})`,
        child.transcriptPath
            ? `Transcript: ${safeTerminalText(shortenPath(child.transcriptPath))}`
            : undefined,
        child.artifactPaths?.outputPath
            ? `Output: ${safeTerminalText(shortenPath(child.artifactPaths.outputPath))}`
            : undefined,
    ].filter((line) => Boolean(line));
    lines.push("Result transcript tail:");
    if (outputLines.length === 0)
        lines.push("  (no recovered final output available yet)");
    else
        for (const line of outputLines)
            lines.push(`  ${safeTerminalText(line)}`);
    return safeTerminalDocument(lines.join("\n"));
}
function formatNestedExactStatus(rootRunId, run) {
    const runId = safeTerminalText(run.id);
    const safeRootRunId = safeTerminalText(rootRunId);
    const lines = [
        `Nested run: ${runId}`,
        `Root: ${safeRootRunId}`,
        `Parent: ${safeTerminalText(run.parentRunId)}${run.parentStepIndex !== undefined ? ` step ${run.parentStepIndex + 1}` : ""}`,
        `State: ${safeTerminalText(run.state)}`,
        run.activityState || run.lastActivityAt
            ? `Activity: ${formatActivityLabel(run.lastActivityAt, run.activityState)}`
            : undefined,
        run.mode ? `Mode: ${safeTerminalText(run.mode)}` : undefined,
        `Agent: ${safeTerminalText(nestedRunDisplayName(run))}`,
        run.currentStep !== undefined
            ? `Progress: step ${run.currentStep + 1}/${run.chainStepCount ?? run.steps?.length ?? 1}`
            : undefined,
        run.asyncDir ? `Dir: ${safeTerminalText(run.asyncDir)}` : undefined,
        run.sessionFile ? `Session: ${safeTerminalText(run.sessionFile)}` : undefined,
        run.error ? `Error: ${safeTerminalText(run.error)}` : undefined,
    ].filter((line) => Boolean(line));
    if (run.path.length) {
        lines.push(`Path: ${safeTerminalText(run.path.map((part) => `${part.runId}${part.stepIndex !== undefined ? `:${part.stepIndex + 1}` : ""}${part.agent ? `:${part.agent}` : ""}`).join(" > "))} > ${runId}`);
    }
    if (run.steps?.length) {
        lines.push("Steps:");
        for (const [index, step] of run.steps.entries()) {
            const activity = step.status === "running"
                ? formatActivityLabel(step.lastActivityAt, step.activityState)
                : undefined;
            lines.push(`  ${index + 1}. ${safeTerminalText(step.agent)} ${safeTerminalText(step.status)}${activity ? `, ${activity}` : ""}${step.error ? `, error: ${safeTerminalText(step.error)}` : ""}`);
            lines.push(...formatNestedRunStatusLines(step.children, { indent: "    ", commandHints: true }));
        }
    }
    lines.push(...formatNestedRunStatusLines(run.children, { indent: "  ", commandHints: true }));
    lines.push("Commands:", `  Status: subagent({ action: "status", id: "${runId}" })`, `  Interrupt: subagent({ action: "interrupt", id: "${runId}" })`, `  Resume: subagent({ action: "resume", id: "${runId}", message: "..." })`, `  Steer: subagent({ action: "steer", id: "${runId}", message: "..." })`, `  Root status: subagent({ action: "status", id: "${safeRootRunId}" })`);
    return safeTerminalDocument(lines.join("\n"));
}
function formatDetailedAsyncStatus(status, asyncDir, outputPath, reconciliation, nestedChildren, nestedWarning, requestedIndex, logPath, eventsPath) {
    const progressLabel = formatAsyncRunProgressLabel({
        mode: status.mode,
        state: status.state,
        currentStep: status.currentStep,
        chainStepCount: status.chainStepCount,
        parallelGroups: status.parallelGroups,
        steps: (status.steps ?? []).map((step, index) => ({
            index,
            agent: step.agent,
            status: step.status,
        })),
    });
    const started = new Date(status.startedAt).toISOString();
    const updated = status.lastUpdate ? new Date(status.lastUpdate).toISOString() : "n/a";
    const statusActivityText = status.state === "running"
        ? formatActivityLabel(status.lastActivityAt, status.activityState)
        : undefined;
    const steeringText = formatSteeringSummary(status);
    const pausedAwaitingSupervisor = isPausedAwaitingSupervisorStatus(status);
    const privacySafeAwaitingSupervisorLifecycle = isProtectedPausedLifecycle(status);
    const lines = [
        `Run: ${safeTerminalText(status.runId)}`,
        `State: ${safeTerminalText(status.state)}`,
        status.error
            ? `Error: ${privacySafeAwaitingSupervisorLifecycle ? protectedLifecycleText("error") : safeTerminalText(status.error)}`
            : undefined,
        statusActivityText ? `Activity: ${statusActivityText}` : undefined,
        steeringText ? `Steering: ${steeringText}` : undefined,
        `Mode: ${safeTerminalText(status.mode)}`,
        !privacySafeAwaitingSupervisorLifecycle && typeof status.pid === "number"
            ? `PID: ${status.pid}`
            : undefined,
        !privacySafeAwaitingSupervisorLifecycle && status.cwd
            ? `Cwd: ${safeTerminalText(status.cwd)}`
            : undefined,
        `Progress: ${safeTerminalText(progressLabel)}`,
        status.pendingAppends ? `Pending appends: ${status.pendingAppends}` : undefined,
        `Started: ${started}`,
        `Updated: ${updated}`,
        !privacySafeAwaitingSupervisorLifecycle ? `Dir: ${safeTerminalText(asyncDir)}` : undefined,
        !privacySafeAwaitingSupervisorLifecycle && outputPath
            ? `Output: ${safeTerminalText(outputPath)}`
            : undefined,
        reconciliation.message
            ? `Diagnosis: ${privacySafeAwaitingSupervisorLifecycle ? protectedLifecycleText("diagnosis") : safeTerminalText(reconciliation.message)}`
            : undefined,
        !privacySafeAwaitingSupervisorLifecycle &&
            reconciliation.resultPath &&
            fs.existsSync(reconciliation.resultPath)
            ? `Result: ${safeTerminalText(reconciliation.resultPath)}`
            : undefined,
    ].filter((line) => Boolean(line));
    for (const [index, step] of (status.steps ?? []).entries())
        lines.push(...formatAsyncStepStatusLines(status, step, index, asyncDir, outputPath, privacySafeAwaitingSupervisorLifecycle));
    const attached = new Set((status.steps ?? []).flatMap((step) => step.children?.map((child) => child.id) ?? []));
    const unattached = nestedChildren.filter((child) => !attached.has(child.id));
    lines.push(...formatNestedRunStatusLines(unattached, {
        indent: "",
        commandHints: true,
        maxLines: 20,
        redactSensitiveDetails: privacySafeAwaitingSupervisorLifecycle,
    }));
    if (nestedWarning)
        lines.push(`Warning: ${privacySafeAwaitingSupervisorLifecycle ? protectedLifecycleText("nested_warning") : safeTerminalText(nestedWarning)}`);
    if (!privacySafeAwaitingSupervisorLifecycle && status.sessionFile)
        lines.push(`Session: ${safeTerminalText(status.sessionFile)}`);
    if (status.state === "running")
        lines.push(`Steer running child: subagent({ action: "steer", id: "${safeTerminalText(status.runId)}", message: "..." })`);
    if (pausedAwaitingSupervisor && (status.steps?.length ?? 0) <= 1) {
        lines.push(...formatForegroundSupervisorPauseMessage({
            headline: "Paused lifecycle actions:",
            runId: safeTerminalText(status.runId),
            agent: status.steps?.[0]?.agent ? safeTerminalText(status.steps[0].agent) : "subagent",
            requestSummary: status.pause?.summary
                ? safeTerminalText(status.pause.summary)
                : status.pause?.summary,
            claimUnavailable: typeof lifecycleContinuationForIndex(status, 0)?.claimToken === "string" &&
                lifecycleContinuationForIndex(status, 0).claimToken.length > 0,
            index: requestedIndex,
        }).split("\n"));
    }
    else if (pausedAwaitingSupervisor) {
        lines.push("Paused lifecycle actions are listed per child above.");
    }
    else if (status.state === "continued") {
        lines.push(`Continuation: ${safeTerminalText(lifecycleContinuationForIndex(status, requestedIndex ?? 0)?.continuationRunId ?? status.lifecycle?.continuation?.continuationRunId ?? "unknown")}`);
        lines.push("Resume: unavailable; this paused supervisor run already launched its continuation.");
    }
    else if (status.state !== "running" && status.state !== "pausing") {
        lines.push(formatResumeGuidance(status.runId, status.steps ?? [], status.sessionFile));
    }
    if (!privacySafeAwaitingSupervisorLifecycle && fs.existsSync(logPath))
        lines.push(`Log: ${safeTerminalText(logPath)}`);
    if (!privacySafeAwaitingSupervisorLifecycle && fs.existsSync(eventsPath))
        lines.push(`Events: ${safeTerminalText(eventsPath)}`);
    return safeTerminalDocument(lines.join("\n"));
}
function inspectAsyncResultFile(resultPath, params, resolvedId) {
    try {
        const raw = fs.readFileSync(resultPath, "utf-8");
        const data = JSON.parse(raw);
        if (params.view === "transcript") {
            try {
                return {
                    content: [
                        {
                            type: "text",
                            text: formatAsyncResultTranscript(data, resultPath, {
                                index: params.index,
                                lines: params.lines,
                            }),
                        },
                    ],
                    details: { mode: "single", results: [] },
                };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: "text", text: message }],
                    isError: true,
                    details: { mode: "single", results: [] },
                };
            }
        }
        const status = data.success
            ? "complete"
            : data.state === "cancelled" || data.state === "continued" || data.state === "pausing"
                ? data.state
                : data.state === "paused" || data.exitCode === 0
                    ? "paused"
                    : "failed";
        const runId = data.runId ?? data.id ?? resolvedId;
        const privacySafeResult = isProtectedPausedLifecycle({
            state: data.state,
            pause: data.pause,
        });
        const lines = [
            `Run: ${safeTerminalText(runId ?? "unknown")}`,
            `State: ${safeTerminalText(status)}`,
            ...(privacySafeResult ? [] : [`Result: ${safeTerminalText(resultPath)}`]),
        ];
        const children = Array.isArray(data.results)
            ? data.results
            : data.agent
                ? [{ agent: data.agent, sessionFile: data.sessionFile }]
                : [];
        lines.push(formatResumeGuidance(runId, children, data.sessionFile));
        if (data.summary)
            lines.push("", privacySafeResult ? "Paused awaiting supervisor." : safeTerminalText(data.summary));
        return {
            content: [{ type: "text", text: safeTerminalDocument(lines.join("\n")) }],
            details: { mode: "single", results: [] },
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: `Failed to read async result file: ${message}` }],
            isError: true,
            details: { mode: "single", results: [] },
        };
    }
}
export function inspectSubagentStatus(params, deps = {}) {
    const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
    const resultsDir = deps.resultsDir ?? RESULTS_DIR;
    const currentSessionId = deps.state?.currentSessionId ?? undefined;
    if (params.view && params.view !== "fleet" && params.view !== "transcript") {
        return {
            content: [
                { type: "text", text: `Unknown status view: ${params.view}. Valid: fleet, transcript.` },
            ],
            isError: true,
            details: { mode: "single", results: [] },
        };
    }
    if (params.view === "fleet") {
        return inspectSubagentFleet(params, {
            asyncDirRoot,
            resultsDir,
            kill: deps.kill,
            now: deps.now,
            state: deps.state,
            childSafe: Boolean(deps.nested),
        });
    }
    if (!params.id && !params.dir) {
        if (deps.nested) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Child-safe subagent status requires an id when no foreground run is active.",
                    },
                ],
                isError: true,
                details: { mode: "single", results: [] },
            };
        }
        try {
            const runs = listAsyncRuns(asyncDirRoot, {
                states: ["queued", "running"],
                sessionId: currentSessionId,
                resultsDir,
                kill: deps.kill,
                now: deps.now,
            });
            if (params.view === "transcript") {
                if (runs.length === 1)
                    return inspectSubagentStatus({ ...params, id: runs[0].id }, deps);
                return {
                    content: [
                        {
                            type: "text",
                            text: runs.length === 0
                                ? "No active async run transcript is available."
                                : `Transcript view requires an id when ${runs.length} active async runs exist. Use subagent({ action: "status", view: "fleet" }) to choose one.`,
                        },
                    ],
                    isError: true,
                    details: { mode: "single", results: [] },
                };
            }
            return {
                content: [{ type: "text", text: formatAsyncRunList(runs) }],
                details: { mode: "single", results: [] },
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: message }],
                isError: true,
                details: { mode: "single", results: [] },
            };
        }
    }
    let location;
    try {
        const requestedId = params.id;
        if (!params.dir && requestedId) {
            const resolved = resolveSubagentRunId(requestedId, {
                asyncDirRoot,
                resultsDir,
                state: deps.state,
                nested: deps.nested,
            });
            if (resolved?.kind === "foreground") {
                const run = deps.state?.foregroundRuns?.get(resolved.id);
                if (run) {
                    try {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: params.view === "transcript"
                                        ? formatRememberedForegroundTranscript(run, {
                                            index: params.index,
                                            lines: params.lines,
                                        })
                                        : formatRememberedForegroundStatus(run),
                                },
                            ],
                            details: { mode: "single", results: [] },
                        };
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return {
                            content: [{ type: "text", text: message }],
                            isError: true,
                            details: { mode: "single", results: [] },
                        };
                    }
                }
            }
            if (resolved?.kind === "nested") {
                reconcileNestedAsyncDescendants(resolved.match.route, {
                    resultsDir,
                    kill: deps.kill,
                    now: deps.now,
                });
                const refreshed = resolveSubagentRunId(requestedId, {
                    asyncDirRoot,
                    resultsDir,
                    state: deps.state,
                    nested: deps.nested,
                });
                const nested = refreshed?.kind === "nested" ? refreshed : resolved;
                if (params.view === "transcript") {
                    try {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: formatNestedRunTranscript(nested.match.run, {
                                        index: params.index,
                                        lines: params.lines,
                                        sessionRoots: deps.sessionRoots,
                                    }),
                                },
                            ],
                            details: { mode: "single", results: [] },
                        };
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return {
                            content: [{ type: "text", text: message }],
                            isError: true,
                            details: { mode: "single", results: [] },
                        };
                    }
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: formatNestedExactStatus(nested.match.rootRunId, nested.match.run),
                        },
                    ],
                    details: { mode: "single", results: [] },
                };
            }
            if (resolved?.kind === "async")
                location = resolved.location;
            else
                location = { asyncDir: null, resultPath: null, resolvedId: requestedId };
        }
        else {
            location = resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: message }],
            isError: true,
            details: { mode: "single", results: [] },
        };
    }
    const { asyncDir, resultPath, resolvedId } = location;
    if (!asyncDir && !resultPath) {
        return {
            content: [{ type: "text", text: "Async run not found. Provide id or dir." }],
            isError: true,
            details: { mode: "single", results: [] },
        };
    }
    if (asyncDir) {
        let reconciliation;
        try {
            reconciliation = reconcileAsyncRun(asyncDir, { resultsDir, kill: deps.kill, now: deps.now });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: message }],
                isError: true,
                details: { mode: "single", results: [] },
            };
        }
        const status = reconciliation.status;
        const effectiveRunId = status?.runId ?? resolvedId ?? "unknown";
        const logPath = path.join(asyncDir, `subagent-log-${effectiveRunId}.md`);
        const eventsPath = path.join(asyncDir, "events.jsonl");
        if (status) {
            if (params.view === "transcript") {
                if (currentSessionId && status.sessionId !== currentSessionId) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Transcript view is only available for async runs owned by the current session.",
                            },
                        ],
                        isError: true,
                        details: { mode: "single", results: [] },
                    };
                }
                try {
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatAsyncRunTranscript(status, asyncDir, {
                                    index: params.index,
                                    lines: params.lines,
                                    sessionRoots: deps.sessionRoots,
                                }),
                            },
                        ],
                        details: { mode: "single", results: [] },
                    };
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return {
                        content: [{ type: "text", text: message }],
                        isError: true,
                        details: { mode: "single", results: [] },
                    };
                }
            }
            let nestedChildren = [];
            let nestedWarning;
            try {
                const nestedRoute = findNestedRouteForRootId(status.runId);
                if (nestedRoute)
                    reconcileNestedAsyncDescendants(nestedRoute, {
                        resultsDir,
                        kill: deps.kill,
                        now: deps.now,
                    });
                nestedChildren = projectNestedRegistryForRoot(status.runId)?.children ?? [];
                attachRootChildrenToSteps(status.runId, status.steps, nestedChildren);
            }
            catch (error) {
                nestedWarning = `Nested status unavailable: ${error instanceof Error ? error.message : String(error)}`;
            }
            const outputPath = formatAsyncRunOutputPath({ asyncDir, outputFile: status.outputFile });
            return {
                content: [
                    {
                        type: "text",
                        text: formatDetailedAsyncStatus(status, asyncDir, outputPath, reconciliation, nestedChildren, nestedWarning, params.index, logPath, eventsPath),
                    },
                ],
                details: { mode: "single", results: [] },
            };
        }
    }
    if (resultPath)
        return inspectAsyncResultFile(resultPath, params, resolvedId);
    return {
        content: [{ type: "text", text: "Status file not found." }],
        isError: true,
        details: { mode: "single", results: [] },
    };
}
