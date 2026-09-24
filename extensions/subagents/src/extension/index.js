import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, defineTool, getAgentDir, keyText, } from "@earendil-works/pi-coding-agent";
import { Text, isKeyRelease, matchesKey, visibleWidth, wrapTextWithAnsi, } from "@earendil-works/pi-tui";
import { discoverAgents } from "../agents/agents.js";
import { getTlhProjectAgentAccess } from "../../../the-last-harness/project-agent-access.mjs";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir, resolveArtifactConfig, } from "../shared/artifacts.js";
import { resolveCurrentSessionId } from "../shared/session-identity.js";
import { handlePauseAllShortcut } from "./pause-all-shortcut.js";
import { handleSubagentLiveDetailShortcut } from "./live-detail-shortcut.js";
import { externalSubagentCoexistenceWarning, findConfiguredExternalSubagentPackages, } from "./external-package-guard.js";
import { cleanupRuntimeDirs } from "./runtime-cleanup.js";
import { createSubagentLiveDetailController, SUBAGENT_LIVE_DETAIL_SHORTCUT, SUBAGENT_PAUSE_ALL_SHORTCUT, } from "../shared/subagent-shortcuts.js";
import { clearLegacyResultAnimationTimer, renderWidget, renderSubagentResult, } from "../tui/render.js";
import { SubagentParams } from "./schemas.js";
import { createSubagentExecutor, normalizeProjectAgentAccess, } from "./subagent-executor.js";
import { createAsyncJobTracker } from "../runs/background/async-job-tracker.js";
import { createResultWatcher } from "../runs/background/result-watcher.js";
import { disposeAwaitedRuns } from "../runs/background/awaited-run-registry.js";
import { registerSlashCommands } from "../slash/slash-commands.js";
import { createNativeSupervisorChannel } from "../supervisor/native-supervisor-channel.js";
import registerSubagentNotify, { boundedReference, MAX_DISPLAY_SUMMARY_CHARS, } from "../runs/background/notify.js";
import { SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV } from "../runs/shared/pi-args.js";
import { formatDuration, shortenPath } from "../shared/formatters.js";
import { loadConfig } from "./config.js";
import { resolveExecutionPolicy } from "../agents/execution-ceiling.js";
import { COMPACT_SUBAGENT_TOOL_DESCRIPTION } from "./tool-description.js";
import { ASYNC_DIR, RESULTS_DIR, SLASH_TEXT_RESULT_TYPE, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_CONTROL_EVENT, WIDGET_KEY, } from "../shared/types.js";
import { formatSubagentControlNotice, handleSubagentControlNotice, SUBAGENT_CONTROL_MESSAGE_TYPE, } from "./control-notices.js";
import { registerCacheWarmingDecision } from "./cache-warming-decision.js";
export { loadConfig } from "./config.js";
export function createSubagentToolResultBridge() {
    const failedResults = new Map();
    return {
        normalize(toolCallId, toolName, result) {
            const { isError, ...normalized } = result;
            if (isError === true)
                failedResults.set(toolCallId, { toolName, details: normalized.details });
            else
                failedResults.delete(toolCallId);
            return normalized;
        },
        errorPatch(toolCallId, toolName, details) {
            const failed = failedResults.get(toolCallId);
            if (!failed || failed.toolName !== toolName)
                return undefined;
            failedResults.delete(toolCallId);
            return failed.details === details ? { isError: true } : undefined;
        },
        clear() {
            failedResults.clear();
        },
    };
}
function getSubagentSessionRoot(parentSessionFile) {
    if (parentSessionFile) {
        const baseName = path.basename(parentSessionFile, ".jsonl");
        const sessionsDir = path.dirname(parentSessionFile);
        return path.join(sessionsDir, baseName);
    }
    return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}
function expandTilde(p) {
    return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}
function ensureAccessibleDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    try {
        fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
    }
    catch {
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
        }
        catch {
        }
        fs.mkdirSync(dirPath, { recursive: true });
        fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
    }
}
function subagentResultIsRunning(result) {
    return (result.details?.progress?.some((entry) => entry.status === "running") ||
        result.details?.results.some((entry) => entry.progress?.status === "running") ||
        false);
}
function ensureSubagentResultAnimation(context) {
    const state = context.state;
    if (state.subagentResultAnimationTimer)
        return;
    if (typeof context.invalidate !== "function")
        return;
    if (state.frame === undefined)
        state.frame = 0;
    state.subagentResultAnimationTimer = setInterval(() => {
        state.frame = ((state.frame ?? 0) + 1) % 10;
        try {
            context.invalidate?.();
        }
        catch {
            void 0;
        }
    }, 80);
}
function isStaleExtensionContextError(error) {
    return error instanceof Error && error.message.includes("Extension context no longer active");
}
function parseSubagentNotifyContent(content) {
    const lines = content.split("\n");
    const header = lines[0] ?? "";
    const match = header.match(/^Background task (completed|failed|paused): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/);
    if (!match)
        return undefined;
    const body = lines.slice(2);
    const summaryHeading = body.indexOf("Summary:");
    const factsIndex = body.findIndex((line) => /^Facts:\s*/.test(line));
    const artifactLines = body.filter((line) => /^Output artifact:\s+\S/.test(line));
    const childSessionLines = body.filter((line) => /^Session:\s+\S/.test(line));
    const metadataLines = body.filter((line) => /^(Async id:\s+\S|Revive(?: child)?:\s+subagent\(|No child process is running\.|Resume(?: unchanged| with guidance):\s+subagent\(|Cancel:\s+subagent\()/.test(line));
    let resultPreview;
    let factsPreview;
    if (summaryHeading >= 0) {
        const summaryStart = summaryHeading + 1;
        const summaryEnd = [
            factsIndex,
            ...body
                .map((line, index) => ({ line, index }))
                .filter(({ line, index }) => index > summaryStart &&
                /^(Session|Async id:|Revive(?: child)?:|No child process is running\.|Resume(?: unchanged| with guidance):|Cancel:)/.test(line))
                .map(({ index }) => index),
        ]
            .filter((index) => index >= summaryStart)
            .sort((a, b) => a - b)[0] ?? body.length;
        resultPreview =
            body
                .slice(summaryStart, summaryEnd)
                .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
                .join("\n")
                .trim() || "(no output)";
        if (factsIndex >= 0) {
            const factsEnd = body
                .map((line, index) => ({ line, index }))
                .filter(({ line, index }) => index > factsIndex &&
                /^(Session|Async id:|Revive(?: child)?:|No child process is running\.|Resume(?: unchanged| with guidance):|Cancel:)/.test(line))
                .map(({ index }) => index)
                .sort((a, b) => a - b)[0] ?? body.length;
            const factsLine = body[factsIndex].replace(/^Facts:\s*/, "");
            const trailingFacts = body
                .slice(factsIndex + 1, factsEnd)
                .join("\n")
                .trim();
            factsPreview = [factsLine, trailingFacts].filter(Boolean).join("\n") || undefined;
        }
    }
    else {
        const resultLines = [...body];
        while (resultLines[0] &&
            (/^Async id:\s+\S/.test(resultLines[0]) ||
                /^Revive(?: child)?:\s+subagent\(/.test(resultLines[0]) ||
                resultLines[0].trim() === "")) {
            resultLines.shift();
        }
        resultPreview =
            resultLines
                .filter((line) => !/^Output artifact:\s+/.test(line) &&
                !/^Facts:\s*/.test(line) &&
                !/^Session(?: file| share error)?:\s+/.test(line))
                .join("\n")
                .trim() || "(no output)";
    }
    const sessionLines = body.filter((line) => /^(Session file|Session share error):\s+\S/.test(line));
    const sessionLine = sessionLines.at(-1);
    let sessionLabel;
    let sessionValue;
    if (sessionLine) {
        const separator = sessionLine.indexOf(":");
        sessionLabel = sessionLine.slice(0, separator).toLowerCase();
        sessionValue = boundedReference(sessionLine.slice(separator + 1).trim());
    }
    return {
        details: {
            agent: match[2],
            status: match[1],
            ...(match[3] ? { taskInfo: match[3] } : {}),
            resultPreview,
            ...(factsPreview ? { factsPreview } : {}),
            ...(artifactLines.length > 0
                ? {
                    artifactPaths: artifactLines.map((line) => boundedReference(line.slice("Output artifact:".length).trim())),
                }
                : {}),
            ...(childSessionLines.length > 0
                ? {
                    sessionPaths: childSessionLines.map((line) => boundedReference(line.slice("Session:".length).trim())),
                }
                : {}),
            ...(sessionLabel && sessionValue ? { sessionLabel, sessionValue } : {}),
        },
        referenceLines: [
            ...artifactLines,
            ...(factsIndex >= 0 ? [body[factsIndex]] : []),
            ...metadataLines,
            ...childSessionLines,
        ],
    };
}
function isSafeNotifyAsyncId(value) {
    return (typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= 200 &&
        !/[\\/]/.test(value) &&
        !value.includes("..") &&
        ![...value].some((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029;
        }));
}
function structuredNotifyReferenceLines(details) {
    const lines = [];
    if (Array.isArray(details.artifactPaths)) {
        for (const value of details.artifactPaths) {
            if (typeof value === "string" && value.length > 0)
                lines.push(`Output artifact: ${boundedReference(value)}`);
        }
    }
    if (typeof details.factsPreview === "string" && details.factsPreview.length > 0) {
        const facts = details.factsPreview.split("\n");
        lines.push(`Facts: ${facts.shift()}`, ...facts.map((line) => `  ${line}`));
    }
    if (Array.isArray(details.sessionPaths)) {
        for (const value of details.sessionPaths) {
            if (typeof value === "string" && value.length > 0)
                lines.push(`Session: ${boundedReference(value)}`);
        }
    }
    const asyncId = isSafeNotifyAsyncId(details.asyncId) ? details.asyncId : undefined;
    if (!asyncId)
        return lines;
    lines.push(`Async id: ${asyncId}`);
    const target = details.resumeTarget;
    if (!target)
        return lines;
    const hasIndex = target.index !== undefined;
    const validIndex = typeof target.index === "number" &&
        Number.isInteger(target.index) &&
        target.index >= 0 &&
        typeof target.childCount === "number" &&
        Number.isInteger(target.childCount) &&
        target.index < target.childCount;
    if (hasIndex && !validIndex)
        return lines;
    if (!details.awaitingSupervisor && !target.sessionPath)
        return lines;
    const idLiteral = JSON.stringify(asyncId);
    if (details.awaitingSupervisor) {
        lines.push("No child process is running.");
        if (!hasIndex) {
            lines.push(`Resume unchanged: subagent({ action: "resume", id: ${idLiteral} })`, `Resume with guidance: subagent({ action: "resume", id: ${idLiteral}, message: "Supervisor replied: ..." })`, `Cancel: subagent({ action: "interrupt", id: ${idLiteral} })`);
        }
        else {
            lines.push(`Resume unchanged: subagent({ action: "resume", id: ${idLiteral}, index: ${target.index} })`, `Resume with guidance: subagent({ action: "resume", id: ${idLiteral}, index: ${target.index}, message: "Supervisor replied: ..." })`, `Cancel: subagent({ action: "interrupt", id: ${idLiteral}, index: ${target.index} })`);
        }
    }
    else if (!hasIndex) {
        lines.push(`Revive: subagent({ action: "resume", id: ${idLiteral}, message: "..." })`);
    }
    else {
        lines.push(`Revive child: subagent({ action: "resume", id: ${idLiteral}, index: ${target.index}, message: "..." })`);
    }
    return lines;
}
class SubagentControlNoticeComponent {
    details;
    theme;
    constructor(details, theme) {
        this.details = details;
        this.theme = theme;
    }
    invalidate() { }
    render(width) {
        const eventLabel = this.details.event.type.replaceAll("_", " ");
        if (width < 3)
            return wrapTextWithAnsi(`Subagent ${eventLabel}`, Math.max(1, width));
        const bodyWidth = Math.max(1, width - 2);
        const borderChar = "─";
        const header = ` ⚠ Subagent ${eventLabel}: ${this.details.event.agent} `;
        const headerLines = wrapTextWithAnsi(header, bodyWidth);
        const padLine = (line) => `${line}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(line)))}`;
        const firstHeaderLine = headerLines[0] ?? "";
        const topBorderPadding = borderChar.repeat(Math.max(0, bodyWidth - visibleWidth(firstHeaderLine)));
        const lines = [this.theme.fg("accent", `╭${firstHeaderLine}${topBorderPadding}╮`)];
        for (const line of headerLines.slice(1))
            lines.push(this.theme.fg("accent", `│${padLine(line)}│`));
        for (const line of wrapTextWithAnsi(formatSubagentControlNotice(this.details), bodyWidth)) {
            lines.push(this.theme.fg("accent", `│${padLine(line)}│`));
        }
        lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));
        return lines;
    }
}
export default function registerSubagentExtension(pi) {
    if (process.env[SUBAGENT_CHILD_ENV] === "1") {
        return;
    }
    const externalPackages = findConfiguredExternalSubagentPackages({
        agentDir: getAgentDir(),
        cwd: process.cwd(),
        configDirName: CONFIG_DIR_NAME,
    });
    if (externalPackages.length > 0) {
        const warning = externalSubagentCoexistenceWarning(externalPackages);
        let warned = false;
        pi.on("session_start", (_event, ctx) => {
            if (warned)
                return;
            warned = true;
            if (ctx.hasUI)
                ctx.ui.notify(warning, "warning");
            if (!ctx.hasUI || ctx.mode === "rpc")
                process.stderr.write(`${warning}\n`);
        });
        return;
    }
    const globalStore = globalThis;
    const runtimeCleanupStoreKey = "__piSubagentRuntimeCleanup";
    const previousRuntimeCleanup = globalStore[runtimeCleanupStoreKey];
    if (typeof previousRuntimeCleanup === "function") {
        try {
            previousRuntimeCleanup();
        }
        catch {
        }
    }
    ensureAccessibleDir(RESULTS_DIR);
    ensureAccessibleDir(ASYNC_DIR);
    cleanupRuntimeDirs();
    const config = loadConfig();
    const artifactConfig = resolveArtifactConfig(config.artifacts);
    const executionPolicy = resolveExecutionPolicy(config.execution);
    const tempArtifactsDir = getArtifactsDir(null);
    cleanupAllArtifactDirs(artifactConfig.cleanupDays);
    const liveDetailController = createSubagentLiveDetailController();
    const state = {
        baseCwd: "",
        currentSessionId: null,
        subagentInProgress: false,
        asyncJobs: new Map(),
        cleanupTimers: new Map(),
        lastUiContext: null,
        liveDetailController,
        poller: null,
        watcher: null,
        watcherRestartTimer: null,
        resultFileCoalescer: {
            schedule: () => false,
            clear: () => { },
        },
    };
    const toolResultBridge = createSubagentToolResultBridge();
    const toggleLiveDetail = (ctx) => {
        handleSubagentLiveDetailShortcut(liveDetailController, ctx, () => renderWidget(ctx, Array.from(state.asyncJobs.values()), liveDetailController));
    };
    let liveDetailTerminalInputUnsubscribe = null;
    const removeLiveDetailTerminalInput = () => {
        const unsubscribe = liveDetailTerminalInputUnsubscribe;
        liveDetailTerminalInputUnsubscribe = null;
        if (!unsubscribe)
            return;
        try {
            unsubscribe();
        }
        catch {
        }
    };
    const installLiveDetailTerminalInput = (ctx) => {
        removeLiveDetailTerminalInput();
        if (!ctx.hasUI || typeof ctx.ui.onTerminalInput !== "function")
            return;
        liveDetailTerminalInputUnsubscribe = ctx.ui.onTerminalInput((input) => {
            if (!matchesKey(input, SUBAGENT_LIVE_DETAIL_SHORTCUT))
                return undefined;
            if (!isKeyRelease(input))
                toggleLiveDetail(ctx);
            return { consume: true };
        });
    };
    const supervisorChannel = createNativeSupervisorChannel(pi, state);
    const { startResultWatcher, primeExistingResults, stopResultWatcher } = createResultWatcher(pi, state, RESULTS_DIR);
    startResultWatcher();
    primeExistingResults();
    const runtimeCleanup = () => {
        disposeAwaitedRuns();
        removeLiveDetailTerminalInput();
        liveDetailController.clearToolRows();
        toolResultBridge.clear();
        stopResultWatcher();
        supervisorChannel.dispose();
        if (state.poller) {
            clearInterval(state.poller);
            state.poller = null;
        }
    };
    globalStore[runtimeCleanupStoreKey] = runtimeCleanup;
    const { ensurePoller, handleStarted, handleComplete, resetJobs, restoreActiveJobs } = createAsyncJobTracker(pi, state, ASYNC_DIR);
    const executor = createSubagentExecutor({
        pi,
        state,
        config,
        artifactConfig,
        executionPolicy,
        tempArtifactsDir,
        getSubagentSessionRoot,
        expandTilde,
        discoverAgents,
        getProjectAgentAccess: (request) => normalizeProjectAgentAccess(getTlhProjectAgentAccess(request)),
    });
    pi.registerMessageRenderer(SLASH_TEXT_RESULT_TYPE, (message, _options, _theme) => {
        const content = typeof message.content === "string"
            ? message.content
            : message.content
                .filter((entry) => entry.type === "text")
                .map((entry) => entry.text)
                .join("\n");
        return new Text(content, 0, 0);
    });
    pi.registerMessageRenderer("subagent-notify", (message, options, theme) => {
        const content = typeof message.content === "string" ? message.content : "";
        const parsedContent = parseSubagentNotifyContent(content);
        const structuredDetails = message.details;
        const rawParsedPreview = parsedContent?.details.resultPreview;
        const displayParsedPreview = rawParsedPreview !== undefined
            ? rawParsedPreview.length <= MAX_DISPLAY_SUMMARY_CHARS
                ? rawParsedPreview
                : `${rawParsedPreview.slice(0, MAX_DISPLAY_SUMMARY_CHARS - "… [preview truncated]".length)}… [preview truncated]`
            : undefined;
        const boundStructuredPreview = (value) => {
            const preview = typeof value === "string" ? value : "(no output)";
            return preview.length <= MAX_DISPLAY_SUMMARY_CHARS
                ? preview
                : `${preview.slice(0, MAX_DISPLAY_SUMMARY_CHARS - "… [preview truncated]".length)}… [preview truncated]`;
        };
        const details = structuredDetails
            ? {
                ...structuredDetails,
                resultPreview: boundStructuredPreview(structuredDetails.resultPreview),
                ...(structuredDetails.sessionValue
                    ? { sessionValue: boundedReference(structuredDetails.sessionValue) }
                    : {}),
            }
            : parsedContent?.details
                ? {
                    ...parsedContent.details,
                    resultPreview: displayParsedPreview ?? parsedContent.details.resultPreview,
                }
                : undefined;
        if (!details) {
            const displayContent = content.length <= MAX_DISPLAY_SUMMARY_CHARS
                ? content
                : `${content.slice(0, MAX_DISPLAY_SUMMARY_CHARS - "… [preview truncated]".length)}… [preview truncated]`;
            return new Text(displayContent, 0, 0);
        }
        const referenceLines = structuredDetails
            ? structuredNotifyReferenceLines(details)
            : (parsedContent?.referenceLines ?? []);
        const icon = details.status === "completed"
            ? theme.fg("success", "✓")
            : details.status === "paused"
                ? theme.fg("warning", "■")
                : theme.fg("error", "✗");
        const parts = [];
        if (details.taskInfo)
            parts.push(details.taskInfo);
        if (details.durationMs !== undefined)
            parts.push(formatDuration(details.durationMs));
        let text = `${icon} ${theme.bold(details.agent)} ${theme.fg("dim", details.status)}`;
        if (parts.length > 0)
            text += ` ${theme.fg("dim", "·")} ${parts.map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `)}`;
        const trimmedPreview = details.resultPreview.trim();
        const previewLines = options.expanded
            ? trimmedPreview.split("\n").filter((line) => line.trim())
            : [trimmedPreview.split("\n", 1)[0] ?? ""].filter((line) => line.trim());
        for (const line of previewLines.length > 0 ? previewLines : ["(no output)"]) {
            text += `\n  ${theme.fg("dim", `⎿  ${line}`)}`;
        }
        if (options.expanded) {
            for (const line of referenceLines) {
                text += `\n  ${theme.fg("muted", line)}`;
            }
        }
        else if (trimmedPreview.includes("\n") || referenceLines.length > 0) {
            const expandKey = keyText("app.tools.expand");
            text += `\n  ${theme.fg("dim", `${expandKey} full notification`)}`;
        }
        if (details.sessionLabel && details.sessionValue) {
            text += `\n  ${theme.fg("muted", `${details.sessionLabel}: ${shortenPath(details.sessionValue)}`)}`;
        }
        return new Text(text, 0, 0);
    });
    pi.registerMessageRenderer(SUBAGENT_CONTROL_MESSAGE_TYPE, (message, _options, theme) => {
        const details = message.details;
        if (!details?.event)
            return undefined;
        const content = typeof message.content === "string" ? message.content : undefined;
        return new SubagentControlNoticeComponent({ ...details, noticeText: formatSubagentControlNotice(details, content) }, theme);
    });
    const executeSubagent = (id, params, signal, onUpdate, ctx) => {
        return executor.execute(id, params, signal, onUpdate, ctx);
    };
    const parameters = SubagentParams;
    const tool = defineTool({
        name: "subagent",
        label: "Subagent",
        description: COMPACT_SUBAGENT_TOOL_DESCRIPTION,
        parameters,
        async execute(id, params, signal, onUpdate, ctx) {
            if (!signal)
                throw new Error("Subagent tool execution requires an abort signal.");
            const result = await executeSubagent(id, params, signal, onUpdate, ctx);
            return toolResultBridge.normalize(id, "subagent", result);
        },
        renderCall(args, theme) {
            if (args.action) {
                const target = args.agent || "";
                return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`, 0, 0);
            }
            const isParallel = (args.tasks?.length ?? 0) > 0;
            const asyncLabel = args.async === true ? theme.fg("warning", " [async]") : "";
            if (isParallel)
                return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))}${asyncLabel}`, 0, 0);
            return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "?")}${asyncLabel}`, 0, 0);
        },
        renderResult(result, options, theme, context) {
            const rendererState = context.state;
            const isLiveToolRow = state.lastUiContext?.hasUI === true &&
                Boolean(context.toolCallId) &&
                typeof rendererState === "object" &&
                rendererState !== null &&
                typeof context.invalidate === "function" &&
                liveDetailController.registerToolRow(context.toolCallId, rendererState, context.invalidate);
            if (subagentResultIsRunning(result) && isLiveToolRow) {
                ensureSubagentResultAnimation(context);
            }
            else {
                clearLegacyResultAnimationTimer(context);
            }
            const frame = context.state?.frame ?? 0;
            const expanded = isLiveToolRow ? liveDetailController.isExpanded() : options.expanded;
            return renderSubagentResult({ ...result, ...(context.isError ? { isError: true } : {}) }, { expanded }, theme, frame);
        },
    });
    pi.registerTool(tool);
    pi.registerShortcut(SUBAGENT_LIVE_DETAIL_SHORTCUT, {
        description: "Toggle subagent live detail",
        handler: toggleLiveDetail,
    });
    pi.registerShortcut(SUBAGENT_PAUSE_ALL_SHORTCUT, {
        description: "Pause all running subagent work",
        handler: (ctx) => {
            handlePauseAllShortcut(state, ctx);
        },
    });
    registerSlashCommands(pi, state, config, (cwd) => {
        const access = normalizeProjectAgentAccess(getTlhProjectAgentAccess({ cwd, sessionId: null, targetNames: [] }));
        return {
            ...(access?.agentDir ? { agentDir: access.agentDir } : {}),
            ...(access?.trustStore ? { trustStore: access.trustStore } : {}),
            ...(access?.createProjectTrustStore
                ? { createProjectTrustStore: access.createProjectTrustStore }
                : {}),
        };
    });
    registerCacheWarmingDecision(pi, state);
    const eventUnsubscribeStoreKey = "__piSubagentEventUnsubscribes";
    const controlNoticeSeenStoreKey = "__piSubagentVisibleControlNotices";
    const previousEventUnsubscribes = globalStore[eventUnsubscribeStoreKey];
    if (Array.isArray(previousEventUnsubscribes)) {
        for (const unsubscribe of previousEventUnsubscribes) {
            if (typeof unsubscribe !== "function")
                continue;
            try {
                unsubscribe();
            }
            catch {
            }
        }
    }
    registerSubagentNotify(pi, state);
    const existingVisibleControlNotices = globalStore[controlNoticeSeenStoreKey];
    const visibleControlNotices = existingVisibleControlNotices instanceof Set
        ? existingVisibleControlNotices
        : new Set();
    globalStore[controlNoticeSeenStoreKey] = visibleControlNotices;
    let controlNoticeSessionContext = null;
    const isControlNoticeIdle = () => controlNoticeSessionContext?.isIdle() ?? true;
    const controlEventHandler = (payload) => {
        handleSubagentControlNotice({
            pi,
            visibleControlNotices,
            details: payload,
            isIdle: isControlNoticeIdle,
        });
    };
    const eventUnsubscribes = [
        pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, handleStarted),
        pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete),
        pi.events.on(SUBAGENT_CONTROL_EVENT, controlEventHandler),
    ];
    globalStore[eventUnsubscribeStoreKey] = eventUnsubscribes;
    pi.on("tool_result", (event, ctx) => {
        if (event.toolName !== "subagent")
            return;
        const errorPatch = toolResultBridge.errorPatch(event.toolCallId, event.toolName, event.details);
        if (ctx.hasUI) {
            state.lastUiContext = ctx;
            if (state.asyncJobs.size > 0) {
                renderWidget(ctx, Array.from(state.asyncJobs.values()), liveDetailController);
                ensurePoller();
            }
        }
        return errorPatch;
    });
    const cleanupSessionArtifacts = (ctx) => {
        try {
            const sessionFile = ctx.sessionManager.getSessionFile();
            if (sessionFile) {
                cleanupOldArtifacts(getArtifactsDir(sessionFile), artifactConfig.cleanupDays);
            }
        }
        catch {
        }
    };
    const resetSessionState = (ctx) => {
        toolResultBridge.clear();
        state.baseCwd = ctx.cwd;
        state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
        if (!process.env[SUBAGENT_CHILD_ENV]) {
            const sessionId = ctx.sessionManager.getSessionId();
            if (sessionId) {
                process.env[SUBAGENT_PARENT_SESSION_ENV] = sessionId;
            }
        }
        state.lastUiContext = ctx;
        cleanupSessionArtifacts(ctx);
        liveDetailController.clearToolRows();
        resetJobs(ctx);
        restoreActiveJobs(ctx);
        primeExistingResults();
    };
    pi.on("session_start", (_event, ctx) => {
        controlNoticeSessionContext = ctx;
        removeLiveDetailTerminalInput();
        resetSessionState(ctx);
        installLiveDetailTerminalInput(ctx);
        supervisorChannel.start();
    });
    pi.on("session_tree", () => {
        liveDetailController.clearToolRows();
    });
    pi.on("session_compact", () => {
        liveDetailController.clearToolRows();
    });
    pi.on("session_shutdown", () => {
        disposeAwaitedRuns();
        removeLiveDetailTerminalInput();
        toolResultBridge.clear();
        delete process.env[SUBAGENT_PARENT_SESSION_ENV];
        for (const unsubscribe of eventUnsubscribes) {
            try {
                unsubscribe();
            }
            catch {
            }
        }
        if (globalStore[eventUnsubscribeStoreKey] === eventUnsubscribes) {
            delete globalStore[eventUnsubscribeStoreKey];
        }
        stopResultWatcher();
        if (state.poller)
            clearInterval(state.poller);
        state.poller = null;
        for (const timer of state.cleanupTimers.values()) {
            clearTimeout(timer);
        }
        state.cleanupTimers.clear();
        state.asyncJobs.clear();
        liveDetailController.clearToolRows();
        supervisorChannel.dispose();
        if (globalStore[runtimeCleanupStoreKey] === runtimeCleanup) {
            delete globalStore[runtimeCleanupStoreKey];
        }
        try {
            if (state.lastUiContext?.hasUI) {
                state.lastUiContext.ui.setWidget(WIDGET_KEY, undefined);
            }
        }
        catch (error) {
            if (!isStaleExtensionContextError(error))
                throw error;
        }
    });
}
