/**
 * Subagent Tool
 *
 * Full-featured subagent with sync and async modes.
 * - Sync (default): Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Modes: single (agent + task), parallel (tasks[]), and management/control actions
 * Toggle: async parameter (default: false)
 *
 * Config file: ~/.pi/agent/extensions/subagent/config.json
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  CONFIG_DIR_NAME,
  defineTool,
  getAgentDir,
  keyText,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  isKeyRelease,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { discoverAgents } from "../agents/agents.ts";
import { getTlhProjectAgentAccess } from "../../../the-last-harness/project-agent-access.mjs";
import {
  cleanupAllArtifactDirs,
  cleanupOldArtifacts,
  getArtifactsDir,
} from "../shared/artifacts.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { cleanupOldChainDirs } from "../shared/settings.ts";
import { handlePauseAllShortcut } from "./pause-all-shortcut.ts";
import { handleSubagentLiveDetailShortcut } from "./live-detail-shortcut.ts";
import {
  externalSubagentCoexistenceWarning,
  findConfiguredExternalSubagentPackages,
} from "./external-package-guard.ts";
import { cleanupRuntimeDirs } from "./runtime-cleanup.ts";
import {
  createSubagentLiveDetailController,
  SUBAGENT_LIVE_DETAIL_SHORTCUT,
  SUBAGENT_PAUSE_ALL_SHORTCUT,
} from "../shared/subagent-shortcuts.ts";
import {
  clearLegacyResultAnimationTimer,
  renderWidget,
  renderSubagentResult,
} from "../tui/render.ts";
import { SubagentParams } from "./schemas.ts";
import { createHeartbeatWiring, countLiveAsyncRuns } from "./heartbeat-wiring.ts";
import { resolveHeartbeatConfig } from "../runs/shared/heartbeat-config.ts";
import {
  createSubagentExecutor,
  normalizeProjectAgentAccess,
  type SubagentParamsLike,
} from "../runs/foreground/subagent-executor.ts";
import { createAsyncJobTracker } from "../runs/background/async-job-tracker.ts";
import { createResultWatcher } from "../runs/background/result-watcher.ts";
import { PROJECT_AGENT_TERMINAL_RETENTION_MS } from "../agents/project-agent-snapshot.ts";
import { registerSlashCommands } from "../slash/slash-commands.ts";
import { createNativeSupervisorChannel } from "../supervisor/native-supervisor-channel.ts";
import registerSubagentNotify, {
  boundedReference,
  MAX_DISPLAY_SUMMARY_CHARS,
  type SubagentNotifyDetails,
} from "../runs/background/notify.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV } from "../runs/shared/pi-args.ts";
import { formatDuration, shortenPath } from "../shared/formatters.ts";
import { loadConfig } from "./config.ts";
import { COMPACT_SUBAGENT_TOOL_DESCRIPTION } from "./tool-description.ts";
import {
  type Details,
  type SubagentState,
  type SubagentToolResult,
  ASYNC_DIR,
  DEFAULT_ARTIFACT_CONFIG,
  RESULTS_DIR,
  SLASH_TEXT_RESULT_TYPE,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_ASYNC_STARTED_EVENT,
  SUBAGENT_CONTROL_EVENT,
  WIDGET_KEY,
} from "../shared/types.ts";
import {
  clearPendingForegroundControlNotices,
  formatSubagentControlNotice,
  handleSubagentControlNotice,
  SUBAGENT_CONTROL_MESSAGE_TYPE,
  type SubagentControlMessageDetails,
} from "./control-notices.ts";

export { loadConfig } from "./config.ts";

type PiToolWithInternalFailure = "subagent";

/**
 * Apply the same session boundary as createAsyncJobTracker to the heartbeat's
 * open event payloads. Only sessionId is consumed here; unknown fields remain
 * untouched. A missing sessionId is accepted only when there is no string
 * current session ID, matching the tracker rule without inventing attribution.
 */
function isCurrentHeartbeatEvent(
  data: unknown,
  currentSessionId: string | null,
): data is Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  return (
    typeof currentSessionId !== "string" ||
    ("sessionId" in data && data.sessionId === currentSessionId)
  );
}

/**
 * Pi 0.83 represents tool failure separately from AgentToolResult. Keep the
 * extension's rich internal result until execute() returns, then strip the
 * private flag and restore it through the supported tool_result patch hook.
 */
export function createSubagentToolResultBridge() {
  const failedResults = new Map<
    string,
    { toolName: PiToolWithInternalFailure; details: unknown }
  >();

  return {
    normalize<T>(
      toolCallId: string,
      toolName: PiToolWithInternalFailure,
      result: SubagentToolResult<T>,
    ): AgentToolResult<T> {
      const { isError, ...normalized } = result;
      if (isError === true)
        failedResults.set(toolCallId, { toolName, details: normalized.details });
      else failedResults.delete(toolCallId);
      return normalized;
    },
    errorPatch(
      toolCallId: string,
      toolName: string,
      details: unknown,
    ): { isError: true } | undefined {
      const failed = failedResults.get(toolCallId);
      if (!failed || failed.toolName !== toolName) return undefined;
      failedResults.delete(toolCallId);
      return failed.details === details ? { isError: true } : undefined;
    },
    clear(): void {
      failedResults.clear();
    },
  };
}

/**
 * Derive subagent session base directory from parent session file.
 * If parent session is ~/.pi/agent/sessions/abc123.jsonl,
 * returns ~/.pi/agent/sessions/abc123/ as the base.
 * Callers add runId to create the actual session root: abc123/{runId}/
 * Falls back to a unique temp directory if no parent session.
 */
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

/**
 * Create a directory and verify it is actually accessible.
 * On Windows with Azure AD/Entra ID, directories created shortly after
 * wake-from-sleep can end up with broken NTFS ACLs (null DACL) when the
 * cloud SID cannot be resolved without network connectivity. This leaves
 * the directory completely inaccessible to the creating user.
 */
function ensureAccessibleDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  try {
    fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
      // Best effort: retry mkdir/access even if cleanup fails.
    }
    fs.mkdirSync(dirPath, { recursive: true });
    fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
  }
}

// Drives the inline running-indicator braille animation for foreground subagent
// results. Foreground runs receive progress only on child events, so the glyph
// (derived from progress fields) would freeze between events. While a result is
// running we tick a frame counter + invalidate() every 80ms so renderSubagentResult
// can blend the frame into runningGlyph and produce a smooth spinner.
function subagentResultIsRunning(result: { details?: Details }): boolean {
  return (
    result.details?.progress?.some((entry) => entry.status === "running") ||
    result.details?.results.some((entry) => entry.progress?.status === "running") ||
    false
  );
}

function ensureSubagentResultAnimation(context: {
  state: Record<string, unknown>;
  invalidate?: () => void;
}): void {
  const state = context.state as {
    subagentResultAnimationTimer?: ReturnType<typeof setInterval>;
    frame?: number;
  };
  if (state.subagentResultAnimationTimer) return;
  if (typeof context.invalidate !== "function") return;
  if (state.frame === undefined) state.frame = 0;
  state.subagentResultAnimationTimer = setInterval(() => {
    state.frame = ((state.frame ?? 0) + 1) % 10;
    try {
      context.invalidate?.();
    } catch {
      void 0;
    }
  }, 80);
}

function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Extension context no longer active");
}

interface ParsedSubagentNotifyContent {
  details: SubagentNotifyDetails;
  referenceLines: string[];
}

function parseSubagentNotifyContent(content: string): ParsedSubagentNotifyContent | undefined {
  const lines = content.split("\n");
  const header = lines[0] ?? "";
  const match = header.match(
    /^Background task (completed|failed|paused): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/,
  );
  if (!match) return undefined;
  const body = lines.slice(2);
  let sessionIndex = -1;
  for (let i = body.length - 1; i >= 1; i--) {
    if (
      body[i - 1]?.trim() === "" &&
      /^(Session|Session file|Session share error):\s+/.test(body[i]!)
    ) {
      sessionIndex = i;
      break;
    }
  }
  const sessionLine = sessionIndex >= 0 ? body[sessionIndex] : undefined;
  const resultLines = sessionIndex >= 0 ? body.slice(0, sessionIndex) : body;
  const referenceLines: string[] = [];
  if (/^Async id:\s+\S/.test(resultLines[0] ?? "")) {
    referenceLines.push(resultLines.shift()!);
    if (/^Revive(?: child)?:\s+subagent\(/.test(resultLines[0] ?? "")) {
      referenceLines.push(resultLines.shift()!);
    }
    if (resultLines[0]?.trim() === "") resultLines.shift();
  }
  const resultPreview = resultLines.join("\n").trim() || "(no output)";
  let sessionLabel: string | undefined;
  let sessionValue: string | undefined;
  if (sessionLine) {
    const separator = sessionLine.indexOf(":");
    sessionLabel = sessionLine.slice(0, separator).toLowerCase();
    sessionValue = boundedReference(sessionLine.slice(separator + 1).trim());
  }
  return {
    details: {
      agent: match[2]!,
      status: match[1] as SubagentNotifyDetails["status"],
      ...(match[3] ? { taskInfo: match[3] } : {}),
      resultPreview,
      ...(sessionLabel && sessionValue ? { sessionLabel, sessionValue } : {}),
    },
    referenceLines,
  };
}

class SubagentControlNoticeComponent implements Component {
  private readonly details: SubagentControlMessageDetails;
  private readonly theme: ExtensionContext["ui"]["theme"];

  constructor(details: SubagentControlMessageDetails, theme: ExtensionContext["ui"]["theme"]) {
    this.details = details;
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const eventLabel = this.details.event.type.replaceAll("_", " ");
    if (width < 3) return wrapTextWithAnsi(`Subagent ${eventLabel}`, Math.max(1, width));
    const bodyWidth = Math.max(1, width - 2);
    const borderChar = "─";
    const header = ` ⚠ Subagent ${eventLabel}: ${this.details.event.agent} `;
    const headerLines = wrapTextWithAnsi(header, bodyWidth);
    const padLine = (line: string): string =>
      `${line}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(line)))}`;
    const firstHeaderLine = headerLines[0] ?? "";
    const topBorderPadding = borderChar.repeat(
      Math.max(0, bodyWidth - visibleWidth(firstHeaderLine)),
    );
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

export default function registerSubagentExtension(pi: ExtensionAPI): void {
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
      if (warned) return;
      warned = true;
      if (ctx.hasUI) ctx.ui.notify(warning, "warning");
      if (!ctx.hasUI || ctx.mode === "rpc") process.stderr.write(`${warning}\n`);
    });
    return;
  }

  const globalStore = globalThis as Record<string, unknown>;
  const runtimeCleanupStoreKey = "__piSubagentRuntimeCleanup";
  const previousRuntimeCleanup = globalStore[runtimeCleanupStoreKey];
  if (typeof previousRuntimeCleanup === "function") {
    try {
      previousRuntimeCleanup();
    } catch {
      // Best effort cleanup for stale timers from an older reload.
    }
  }

  ensureAccessibleDir(RESULTS_DIR);
  ensureAccessibleDir(ASYNC_DIR);
  cleanupOldChainDirs();
  cleanupRuntimeDirs();

  const config = loadConfig();
  const resolvedHbConfig = resolveHeartbeatConfig(config.heartbeat);
  // Lazily captured session context for modelRegistry access.
  // ctx is not available at extension setup; we capture it from the session_start
  // event handler and hold a reference so the heartbeat controller can resolve
  // the live registry at beat time — the same pattern used for control notices.
  let heartbeatSessionCtx: Pick<
    import("@earendil-works/pi-coding-agent").ExtensionContext,
    "modelRegistry"
  > | null = null;
  const hbWiring = createHeartbeatWiring(pi, config, {
    getModelRegistry: () => heartbeatSessionCtx?.modelRegistry,
  });
  const tempArtifactsDir = getArtifactsDir(null);
  cleanupAllArtifactDirs(DEFAULT_ARTIFACT_CONFIG.cleanupDays);
  const liveDetailController = createSubagentLiveDetailController();

  const state: SubagentState = {
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
    liveDetailController,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {},
    },
  };
  const toolResultBridge = createSubagentToolResultBridge();

  const toggleLiveDetail = (ctx: ExtensionContext): void => {
    handleSubagentLiveDetailShortcut(liveDetailController, ctx, () =>
      renderWidget(ctx, Array.from(state.asyncJobs.values()), liveDetailController),
    );
  };
  let liveDetailTerminalInputUnsubscribe: (() => void) | null = null;
  const removeLiveDetailTerminalInput = (): void => {
    const unsubscribe = liveDetailTerminalInputUnsubscribe;
    liveDetailTerminalInputUnsubscribe = null;
    if (!unsubscribe) return;
    try {
      unsubscribe();
    } catch {
      // Pi may already have cleared extension listeners while resetting its UI.
    }
  };
  const installLiveDetailTerminalInput = (ctx: ExtensionContext): void => {
    removeLiveDetailTerminalInput();
    if (!ctx.hasUI || typeof ctx.ui.onTerminalInput !== "function") return;
    // Raw listeners run before Pi's hard-coded Ctrl+Shift+D debug handler.
    // Consuming the match also prevents downstream shortcut dispatch from toggling twice.
    liveDetailTerminalInputUnsubscribe = ctx.ui.onTerminalInput((input) => {
      if (!matchesKey(input, SUBAGENT_LIVE_DETAIL_SHORTCUT)) return undefined;
      if (!isKeyRelease(input)) toggleLiveDetail(ctx);
      return { consume: true };
    });
  };

  const supervisorChannel = createNativeSupervisorChannel(pi, state);
  const { startResultWatcher, primeExistingResults, stopResultWatcher } = createResultWatcher(
    pi,
    state,
    RESULTS_DIR,
    PROJECT_AGENT_TERMINAL_RETENTION_MS,
  );
  startResultWatcher();
  primeExistingResults();

  const runtimeCleanup = () => {
    // Disarm heartbeat gap (with summary) on extension reload so any active gap is
    // closed before the new extension instance takes over.  The session is still
    // active at this point so the session entry CAN be emitted.
    // Then destroy to abort any in-flight beat and fully tear down the controller.
    hbWiring.disarm();
    hbWiring.destroy();
    removeLiveDetailTerminalInput();
    liveDetailController.clearToolRows();
    toolResultBridge.clear();
    stopResultWatcher();
    supervisorChannel.dispose();
    clearPendingForegroundControlNotices(state);
    if (state.poller) {
      clearInterval(state.poller);
      state.poller = null;
    }
  };
  globalStore[runtimeCleanupStoreKey] = runtimeCleanup;

  const { ensurePoller, handleStarted, handleComplete, resetJobs, restoreActiveJobs } =
    createAsyncJobTracker(pi, state, ASYNC_DIR);
  const executor = createSubagentExecutor({
    pi,
    state,
    config,
    tempArtifactsDir,
    getSubagentSessionRoot,
    expandTilde,
    discoverAgents,
    getHeartbeatSummary: () => hbWiring.getSessionSummary(),
    getProjectAgentAccess: (request) =>
      normalizeProjectAgentAccess(getTlhProjectAgentAccess(request)),
  });

  pi.registerMessageRenderer<undefined>(SLASH_TEXT_RESULT_TYPE, (message, _options, _theme) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((entry) => entry.type === "text")
            .map((entry) => entry.text)
            .join("\n");
    return new Text(content, 0, 0);
  });

  pi.registerMessageRenderer<SubagentNotifyDetails>(
    "subagent-notify",
    (message, options, theme) => {
      const content = typeof message.content === "string" ? message.content : "";
      const parsedContent = parseSubagentNotifyContent(content);
      const structuredDetails = message.details as SubagentNotifyDetails | undefined;
      const parsedSession =
        parsedContent?.details.sessionLabel && parsedContent.details.sessionValue
          ? {
              sessionLabel: parsedContent.details.sessionLabel,
              sessionValue: parsedContent.details.sessionValue,
            }
          : undefined;
      // Bound the parsed content preview at render time so that a larger content
      // string (model-facing) does not produce a wall of text in the TUI.
      const rawParsedPreview = parsedContent?.details.resultPreview;
      const displayPreview =
        rawParsedPreview !== undefined
          ? rawParsedPreview.length <= MAX_DISPLAY_SUMMARY_CHARS
            ? rawParsedPreview
            : `${rawParsedPreview.slice(0, MAX_DISPLAY_SUMMARY_CHARS - "… [preview truncated]".length)}… [preview truncated]`
          : undefined;
      const details = structuredDetails
        ? {
            ...structuredDetails,
            resultPreview: displayPreview ?? structuredDetails.resultPreview,
            ...(structuredDetails.sessionValue
              ? { sessionValue: boundedReference(structuredDetails.sessionValue) }
              : {}),
            ...parsedSession,
          }
        : parsedContent?.details
          ? {
              ...parsedContent.details,
              resultPreview: displayPreview ?? parsedContent.details.resultPreview,
            }
          : undefined;
      // Fallback for content the parser cannot handle (e.g. grouped notices whose
      // header does not match the singular-completion regex, or future header shapes).
      // Bound display to MAX_DISPLAY_SUMMARY_CHARS so any unparsed content—regardless of
      // the model-facing envelope size—does not produce a wall of text in the TUI.
      if (!details) {
        const displayContent =
          content.length <= MAX_DISPLAY_SUMMARY_CHARS
            ? content
            : `${content.slice(0, MAX_DISPLAY_SUMMARY_CHARS - "… [preview truncated]".length)}… [preview truncated]`;
        return new Text(displayContent, 0, 0);
      }
      const referenceLines = parsedContent?.referenceLines ?? [];
      const icon =
        details.status === "completed"
          ? theme.fg("success", "✓")
          : details.status === "paused"
            ? theme.fg("warning", "■")
            : theme.fg("error", "✗");
      const parts: string[] = [];
      if (details.taskInfo) parts.push(details.taskInfo);
      if (details.durationMs !== undefined) parts.push(formatDuration(details.durationMs));
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
      } else if (trimmedPreview.includes("\n") || referenceLines.length > 0) {
        const expandKey = keyText("app.tools.expand");
        text += `\n  ${theme.fg("dim", `${expandKey} full notification`)}`;
      }
      if (details.sessionLabel && details.sessionValue) {
        text += `\n  ${theme.fg("muted", `${details.sessionLabel}: ${shortenPath(details.sessionValue)}`)}`;
      }
      return new Text(text, 0, 0);
    },
  );

  pi.registerMessageRenderer<SubagentControlMessageDetails>(
    SUBAGENT_CONTROL_MESSAGE_TYPE,
    (message, _options, theme) => {
      const details = message.details as SubagentControlMessageDetails | undefined;
      if (!details?.event) return undefined;
      const content = typeof message.content === "string" ? message.content : undefined;
      return new SubagentControlNoticeComponent(
        { ...details, noticeText: formatSubagentControlNotice(details, content) },
        theme,
      );
    },
  );

  const executeSubagent = (
    id: string,
    params: SubagentParamsLike,
    signal: AbortSignal,
    onUpdate: ((result: SubagentToolResult<Details>) => void) | undefined,
    ctx: ExtensionContext,
  ) => {
    return executor.execute(id, params, signal, onUpdate, ctx);
  };

  const parameters = SubagentParams;
  const tool = defineTool<typeof parameters, Details>({
    name: "subagent",
    label: "Subagent",
    description: COMPACT_SUBAGENT_TOOL_DESCRIPTION,
    parameters,

    async execute(id, params, signal, onUpdate, ctx) {
      if (!signal) throw new Error("Subagent tool execution requires an abort signal.");
      const result = await executeSubagent(id, params as SubagentParamsLike, signal, onUpdate, ctx);
      return toolResultBridge.normalize(id, "subagent", result);
    },

    renderCall(args, theme) {
      if (args.action) {
        const target = args.agent || "";
        return new Text(
          `${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`,
          0,
          0,
        );
      }
      const isParallel = (args.tasks?.length ?? 0) > 0;
      const asyncLabel = args.async === true ? theme.fg("warning", " [async]") : "";
      if (isParallel)
        return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))}${asyncLabel}`, 0, 0);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "?")}${asyncLabel}`,
        0,
        0,
      );
    },

    renderResult(result, options, theme, context) {
      // Pi gives the live ToolExecutionComponent and the HTML exporter separate,
      // stable renderer-state objects. Unknown states remain non-live for this render
      // and get one deferred probe: live rows re-enter and claim the controller after
      // container composition finishes, while export no-ops keep using expanded.
      const rendererState = context.state as unknown;
      const isLiveToolRow =
        state.lastUiContext?.hasUI === true &&
        Boolean(context.toolCallId) &&
        typeof rendererState === "object" &&
        rendererState !== null &&
        typeof context.invalidate === "function" &&
        liveDetailController.registerToolRow(context.toolCallId, rendererState, context.invalidate);
      if (subagentResultIsRunning(result) && isLiveToolRow) {
        ensureSubagentResultAnimation(context);
      } else {
        clearLegacyResultAnimationTimer(context);
      }
      const frame = (context.state as { frame?: number } | undefined)?.frame ?? 0;
      const expanded = isLiveToolRow ? liveDetailController.isExpanded() : options.expanded;
      return renderSubagentResult(
        { ...result, ...(context.isError ? { isError: true } : {}) },
        { expanded },
        theme,
        frame,
      );
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

  registerSlashCommands(pi, state, config, () => hbWiring.getSessionSummary());

  // Heartbeat-specific Pi event hooks: only register when heartbeat is enabled.
  // When disabled, no before_provider_request payload capture (memory/PII risk)
  // and no idle-state or model-change hooks.  The wiring is already a no-op
  // when disabled, but not registering these hooks avoids any unnecessary
  // callbacks and satisfies the zero-hook requirement.
  if (resolvedHbConfig.enabled) {
    // Capture provider payload for ghost-stream replay.
    pi.on("before_provider_request", (event, ctx) => {
      if (ctx.model) {
        hbWiring.onProviderRequest(event.payload, ctx.model);
      }
    });

    // Disarm on real turn start (before_agent_start) and notify the
    // controller of idle-state transitions.
    pi.on("before_agent_start", () => {
      hbWiring.onIdle(false);
      hbWiring.disarm();
    });
    pi.on("agent_settled", () => {
      hbWiring.onIdle(true);
      // Re-arm if live async runs are still active — the gap was disarmed during
      // the parent turn and must resume once the parent is idle again.
      hbWiring.tryRearm(countLiveAsyncRuns(state.asyncJobs), state.currentSessionId);
    });

    // Disarm on model or thinking-level changes (prompt-cache state
    // may shift when provider/parameters change).
    pi.on("model_select", () => {
      hbWiring.disarm();
    });
    pi.on("thinking_level_select", () => {
      hbWiring.disarm();
    });
  }

  const eventUnsubscribeStoreKey = "__piSubagentEventUnsubscribes";
  const controlNoticeSeenStoreKey = "__piSubagentVisibleControlNotices";
  const previousEventUnsubscribes = globalStore[eventUnsubscribeStoreKey];
  if (Array.isArray(previousEventUnsubscribes)) {
    for (const unsubscribe of previousEventUnsubscribes) {
      if (typeof unsubscribe !== "function") continue;
      try {
        unsubscribe();
      } catch {
        // Best effort cleanup for stale handlers from an older reload.
      }
    }
  }
  // Register heartbeat async-lifecycle handlers BEFORE registerSubagentNotify so
  // that disarm fires synchronously before the wake nudge in notify.ts.
  // Only subscribe when heartbeat is enabled: when disabled, the wiring is a
  // no-op but these subscriptions still add live callbacks for every async event.
  const hbCompleteHandler = (data: unknown) => {
    if (!isCurrentHeartbeatEvent(data, state.currentSessionId)) return;
    const id = data.id;
    if (typeof id !== "string" || id.length === 0) return;
    hbWiring.notifyAsyncComplete(id, state.asyncJobs);
  };
  const hbStartedHandler = (data: unknown) => {
    if (!isCurrentHeartbeatEvent(data, state.currentSessionId)) return;
    const liveRunsBefore = countLiveAsyncRuns(state.asyncJobs);
    hbWiring.notifyAsyncStarted(liveRunsBefore, state.currentSessionId);
  };
  const noop = () => {};
  const hbCompleteUnsub = resolvedHbConfig.enabled
    ? pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, hbCompleteHandler)
    : noop;
  const hbStartedUnsub = resolvedHbConfig.enabled
    ? pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, hbStartedHandler)
    : noop;

  registerSubagentNotify(pi, state, {});

  const existingVisibleControlNotices = globalStore[controlNoticeSeenStoreKey];
  const visibleControlNotices =
    existingVisibleControlNotices instanceof Set
      ? (existingVisibleControlNotices as Set<string>)
      : new Set<string>();
  globalStore[controlNoticeSeenStoreKey] = visibleControlNotices;
  // Capture a session context so idleness can be read live at send time.
  // Mirrors the pattern in registerSubagentNotify (notify.ts): a hand-rolled
  // streaming flag would stick if prompt() threw between before_agent_start
  // and the run starting, silently suppressing every future nudge.
  let controlNoticeSessionContext: Pick<ExtensionContext, "isIdle"> | null = null;
  const isControlNoticeIdle = () => controlNoticeSessionContext?.isIdle() ?? true;
  const controlEventHandler = (payload: unknown) => {
    handleSubagentControlNotice({
      pi,
      state,
      visibleControlNotices,
      details: payload as SubagentControlMessageDetails,
      isIdle: isControlNoticeIdle,
    });
  };
  const eventUnsubscribes = [
    hbCompleteUnsub,
    hbStartedUnsub,
    pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, handleStarted),
    pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete),
    pi.events.on(SUBAGENT_CONTROL_EVENT, controlEventHandler),
  ];
  globalStore[eventUnsubscribeStoreKey] = eventUnsubscribes;

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "subagent") return;
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

  const cleanupSessionArtifacts = (ctx: ExtensionContext) => {
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile) {
        cleanupOldArtifacts(getArtifactsDir(sessionFile), DEFAULT_ARTIFACT_CONFIG.cleanupDays);
      }
    } catch {
      // Cleanup failures should not block session lifecycle events.
    }
  };

  const resetSessionState = (ctx: ExtensionContext) => {
    toolResultBridge.clear();
    state.baseCwd = ctx.cwd;
    state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
    // Set PI_SUBAGENT_PARENT_SESSION for permission-system forwarding.
    // Only set in the root session (the interactive UI session), not in
    // child subagent processes — children inherit the parent's value
    // through the process environment at spawn time and must not overwrite
    // it with their own session identity.
    if (!process.env[SUBAGENT_CHILD_ENV]) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (sessionId) {
        process.env[SUBAGENT_PARENT_SESSION_ENV] = sessionId;
      }
    }
    state.lastUiContext = ctx;
    cleanupSessionArtifacts(ctx);
    clearPendingForegroundControlNotices(state);
    liveDetailController.clearToolRows();
    resetJobs(ctx);
    restoreActiveJobs(ctx);
    primeExistingResults();
  };

  pi.on("session_start", (_event, ctx) => {
    if (resolvedHbConfig.enabled) {
      // Reset session-scoped state (error breaker, consecutive errors, session
      // totals) for the new session.  Must run before capturing ctx so stale
      // state from the previous session does not persist into this one.
      hbWiring.resetSession();
      // Heartbeat: capture live session ctx so the controller can resolve the
      // model registry lazily at beat time (same captured-ctx pattern as control
      // notices; ctx is not available at extension setup time).
      heartbeatSessionCtx = ctx;
      // Forward initial idle state. Use optional call in case the ctx is a
      // minimal stub in tests.
      hbWiring.onIdle((ctx as { isIdle?: () => boolean }).isIdle?.() ?? true);
    }
    controlNoticeSessionContext = ctx;
    removeLiveDetailTerminalInput();
    resetSessionState(ctx);
    if (resolvedHbConfig.enabled) {
      // Re-arm heartbeat for any live async jobs restored by resetSessionState.
      hbWiring.tryRearm(countLiveAsyncRuns(state.asyncJobs), state.currentSessionId);
    }
    installLiveDetailTerminalInput(ctx);
    supervisorChannel.start();
  });

  // Heartbeat: synchronously disarm (with session-entry disclosure) before
  // session replacement or fork so beat-bearing gaps are never silently lost.
  // Only register when enabled: these are heartbeat-specific hooks.
  if (resolvedHbConfig.enabled) {
    pi.on("session_before_switch", () => {
      hbWiring.disarm();
    });
    pi.on("session_before_fork", () => {
      hbWiring.disarm();
    });
  }

  // Tree navigation and compaction rebuild ToolExecutionComponents with fresh
  // renderer state. Release old row identities before Pi renders the new chat.
  // Heartbeat: disarm on tree/compact since prompt-cache state may have changed.
  pi.on("session_tree", () => {
    hbWiring.disarm();
    liveDetailController.clearToolRows();
  });
  pi.on("session_compact", () => {
    hbWiring.disarm();
    liveDetailController.clearToolRows();
  });

  pi.on("session_shutdown", () => {
    // Heartbeat: destroy (cancel timers, abort in-flight, close gap without
    // session entry since session is going away).
    hbWiring.destroy();
    removeLiveDetailTerminalInput();
    toolResultBridge.clear();
    delete process.env[SUBAGENT_PARENT_SESSION_ENV];
    for (const unsubscribe of eventUnsubscribes) {
      try {
        unsubscribe();
      } catch {
        // Best effort cleanup during shutdown.
      }
    }
    if (globalStore[eventUnsubscribeStoreKey] === eventUnsubscribes) {
      delete globalStore[eventUnsubscribeStoreKey];
    }
    stopResultWatcher();
    if (state.poller) clearInterval(state.poller);
    state.poller = null;
    clearPendingForegroundControlNotices(state);
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
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
    }
  });
}
