/**
 * Subagent completion notifications.
 *
 * The result watcher owns detached completion delivery. Every detached result
 * produces one message immediately; there is no batching window and no
 * notification-level replay/dedupe. A live awaited owner consumes its result
 * privately; an awaited marker without that owner is eligible for recovery.
 *
 * Notification shape:
 *
 *   Background task <status>: **<agent>**
 *
 *   Output artifact: <bounded path>       (when one exists)
 *   Summary:                              (bounded child-derived text)
 *   Facts: <bounded A1c facts>             (when validated facts exist)
 *   ... recovery/session references ...
 *
 * Artifact and session references are bounded independently so a long child
 * result cannot crowd the recovery pointers out of the message.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  type SubagentState,
  type SubagentTerminalResult,
} from "../../shared/types.ts";
import { isProtectedPausedLifecycle } from "../shared/lifecycle-privacy.ts";
import { BACKGROUND_COMPLETION_NUDGE_TEXT } from "../shared/nudge-texts.ts";
import { sliceSafe, truncateWithMarker } from "../../shared/string-utils.ts";
import { safeTerminalDocumentLeaf, safeTerminalText } from "../../shared/display-text.ts";
import { dispatchAwaitedRunCompletion } from "./awaited-run-registry.ts";

// These limits are display/message trust boundaries for text originating in a
// child result. They are deliberately independent of the awaited-result limit.
export const MAX_DISPLAY_SUMMARY_CHARS = 1_200;
export const MAX_COMPLETION_FACTS_CHARS = 1_200;
const MAX_REFERENCE_CHARS = 500;
const MAX_ARTIFACT_REFERENCES = 8;
const MAX_SESSION_REFERENCES = 8;
const MAX_LABEL_CHARS = 160;
const MAX_ASYNC_ID_CHARS = 200;
const MAX_SESSION_PATH_CHARS = 4_096;

interface SubagentChildResult {
  agent: string;
  output?: string;
  success?: boolean;
  status?: "completed" | "failed" | "paused";
  summary?: string;
  artifactPath?: string;
  sessionPath?: string;
  index?: number;
  terminalResult?: SubagentTerminalResult;
}

interface ResumeTarget {
  sessionPath: string;
  index?: number;
  childCount?: number;
}

export interface SubagentNotifyDetails {
  agent: string;
  status: "completed" | "failed" | "paused";
  taskInfo?: string;
  /** Bounded child-derived summary text. */
  resultPreview: string;
  /** Bounded child-derived A1c facts body (without the Facts: label). */
  factsPreview?: string;
  /** Bounded output artifact paths, in display order. */
  artifactPaths?: string[];
  /** Bounded session pointers for child results, in display order. */
  sessionPaths?: string[];
  durationMs?: number;
  asyncId?: string;
  resumeTarget?: ResumeTarget;
  sessionLabel?: string;
  sessionValue?: string;
  awaitingSupervisor?: boolean;
}

interface SubagentResult {
  id: string | null;
  runId?: string | null;
  agent: string | null;
  success: boolean;
  summary: string;
  exitCode?: number;
  state?: string;
  timestamp: number;
  durationMs?: number;
  cwd?: string;
  sessionFile?: string;
  shareUrl?: string;
  gistUrl?: string;
  shareError?: string;
  results?: SubagentChildResult[];
  taskIndex?: number;
  totalTasks?: number;
  sessionId?: string | null;
  generation?: number;
  awaited?: boolean;
  pause?: { kind?: string };
  terminalResult?: SubagentTerminalResult;
}

function boundedSummary(value: string): string {
  return truncateWithMarker(
    safeTerminalDocumentLeaf(value),
    MAX_DISPLAY_SUMMARY_CHARS,
    "… [summary truncated]",
  );
}

function boundedFacts(value: string): string {
  return truncateWithMarker(
    safeTerminalText(value),
    MAX_COMPLETION_FACTS_CHARS,
    "… [facts truncated]",
  );
}

/**
 * Bounds a path-like reference by keeping root context and the identifying
 * tail. All path-like values cross the terminal sanitization boundary before
 * they are displayed; this also prevents a child newline from forging a field.
 */
export function boundedReference(value: string): string {
  const safeValue = safeTerminalText(value);
  if (safeValue.length <= MAX_REFERENCE_CHARS) return safeValue;
  const middleMarker = "… [reference truncated] …";
  let tailStart = -1;
  let separator = safeValue.lastIndexOf("/");
  while (separator >= 0) {
    if (MAX_REFERENCE_CHARS - middleMarker.length - (safeValue.length - separator) < 1) break;
    tailStart = separator;
    separator = safeValue.lastIndexOf("/", separator - 1);
  }
  if (tailStart >= 0) {
    const leadingBudget =
      MAX_REFERENCE_CHARS - middleMarker.length - (safeValue.length - tailStart);
    return `${sliceSafe(safeValue, leadingBudget)}${middleMarker}${safeValue.slice(tailStart)}`;
  }
  return truncateWithMarker(safeValue, MAX_REFERENCE_CHARS, "… [reference truncated]");
}

function boundedLabel(value: string): string {
  return truncateWithMarker(safeTerminalText(value), MAX_LABEL_CHARS, "… [label truncated]");
}

function formatSessionLine(details: SubagentNotifyDetails): string | undefined {
  if (!details.sessionValue) return undefined;
  const value = boundedReference(details.sessionValue);
  const label = details.sessionLabel ? boundedLabel(details.sessionLabel) : undefined;
  return label ? `${label}: ${value}` : value;
}

function hasUnsafeIdentifierCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029;
  });
}

function normalizeAsyncIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (
    value.trim() === "" ||
    value.length > MAX_ASYNC_ID_CHARS ||
    hasUnsafeIdentifierCharacters(value)
  )
    return undefined;
  if (path.isAbsolute(value) || /[\\/]/.test(value) || value.includes("..")) return undefined;
  return value;
}

function formatAsyncIdLine(details: SubagentNotifyDetails): string | undefined {
  const asyncId = normalizeAsyncIdentifier(details.asyncId);
  return asyncId ? `Async id: ${asyncId}` : undefined;
}

function normalizeSessionPath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION_PATH_CHARS
    ? value
    : undefined;
}

function hasExistingSessionFile(value: unknown): value is string {
  const sessionPath = normalizeSessionPath(value);
  return sessionPath !== undefined && fs.existsSync(sessionPath);
}

function formatResumeLine(details: SubagentNotifyDetails): string | undefined {
  const asyncId = normalizeAsyncIdentifier(details.asyncId);
  const target = details.resumeTarget;
  if (!asyncId || !target || !hasExistingSessionFile(target.sessionPath)) return undefined;
  if (target.index !== undefined) {
    if (
      typeof target.childCount !== "number" ||
      !Number.isInteger(target.childCount) ||
      !isValidChildIndex(target.index, target.childCount)
    )
      return undefined;
  }
  const idLiteral = JSON.stringify(asyncId);
  return target.index === undefined
    ? `Revive: subagent({ action: "resume", id: ${idLiteral}, message: "..." })`
    : `Revive child: subagent({ action: "resume", id: ${idLiteral}, index: ${target.index}, message: "..." })`;
}

function formatPausedSupervisorActionLines(details: SubagentNotifyDetails): string[] {
  const asyncId = normalizeAsyncIdentifier(details.asyncId);
  const target = details.resumeTarget;
  if (
    !details.awaitingSupervisor ||
    !asyncId ||
    !target ||
    !hasExistingSessionFile(target.sessionPath)
  )
    return [];
  const idLiteral = JSON.stringify(asyncId);
  if (target.index === undefined) {
    return [
      "No child process is running.",
      `Resume unchanged: subagent({ action: "resume", id: ${idLiteral} })`,
      `Resume with guidance: subagent({ action: "resume", id: ${idLiteral}, message: "Supervisor replied: ..." })`,
      `Cancel: subagent({ action: "interrupt", id: ${idLiteral} })`,
    ];
  }
  if (
    typeof target.childCount !== "number" ||
    !Number.isInteger(target.childCount) ||
    !isValidChildIndex(target.index, target.childCount)
  )
    return [];
  return [
    "No child process is running.",
    `Resume unchanged: subagent({ action: "resume", id: ${idLiteral}, index: ${target.index} })`,
    `Resume with guidance: subagent({ action: "resume", id: ${idLiteral}, index: ${target.index}, message: "Supervisor replied: ..." })`,
    `Cancel: subagent({ action: "interrupt", id: ${idLiteral}, index: ${target.index} })`,
  ];
}

function isValidChildIndex(value: unknown, childCount: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < childCount
  );
}

function resolveAsyncIdentifier(result: SubagentResult): string | undefined {
  return normalizeAsyncIdentifier(result.id) ?? normalizeAsyncIdentifier(result.runId);
}

function resolveChildStatus(
  child: SubagentChildResult,
): NonNullable<SubagentChildResult["status"]> {
  return child.status ?? (child.success === false ? "failed" : "completed");
}

function resolveOuterStatus(result: SubagentResult): SubagentNotifyDetails["status"] {
  const summary = typeof result.summary === "string" ? result.summary : "";
  const paused =
    result.state === "paused" ||
    (result.state !== "failed" &&
      !result.success &&
      (result.exitCode === 0 || summary.startsWith("Paused after interrupt.")));
  if (paused) return "paused";
  if (
    !result.success ||
    result.state === "failed" ||
    (typeof result.exitCode === "number" && result.exitCode !== 0)
  )
    return "failed";
  return "completed";
}

function resolveCompletionStatus(result: SubagentResult): SubagentNotifyDetails["status"] {
  const children = Array.isArray(result.results) ? result.results : [];
  if (children.length > 0) {
    const statuses = children.map(resolveChildStatus);
    if (statuses.includes("failed") || resolveOuterStatus(result) === "failed") return "failed";
    if (statuses.includes("paused") || resolveOuterStatus(result) === "paused") return "paused";
    return "completed";
  }
  return resolveOuterStatus(result);
}

function formatTerminalFactsBody(result: SubagentTerminalResult | undefined): string | undefined {
  const attempts = result?.facts.attempts;
  if (!attempts?.length) return undefined;
  return attempts
    .slice(0, 64)
    .map((attempt) => {
      const exit = attempt.exit.signal
        ? `signal=${boundedLabel(attempt.exit.signal)}`
        : `exit=${attempt.exit.code === null ? "?" : attempt.exit.code}`;
      const tokens =
        attempt.providerTokens.status === "available"
          ? `tokens=${attempt.providerTokens.usage.total}`
          : "tokens=?";
      const tools = `tools=${attempt.requestedToolCalls.edit}/${attempt.requestedToolCalls.write}/${attempt.requestedToolCalls.bash}`;
      const workspace = `workspace=${safeTerminalText(attempt.workspace.attribution)}`;
      return `#${attempt.attempt} ${exit}, duration=${Math.round(attempt.durationMs)}ms, ${tokens}, ${tools}, ${workspace}`;
    })
    .join("; ");
}

function childSummarySource(child: SubagentChildResult): string {
  const summary = child.summary ?? child.output ?? "";
  return typeof summary === "string" ? summary : "";
}

function buildSummary(result: SubagentResult, children: SubagentChildResult[]): string {
  if (isProtectedPausedLifecycle(result)) return "Paused awaiting supervisor.";
  const pieces = children.length
    ? children.map((child) => {
        const label = boundedLabel(child.agent || "worker");
        const summary = safeTerminalDocumentLeaf(childSummarySource(child)).trim() || "(no output)";
        return children.length === 1 ? summary : `${label}: ${summary}`;
      })
    : [typeof result.summary === "string" ? result.summary : ""];
  const summary = pieces.join("\n").trim();
  return boundedSummary(summary || "(no output)");
}

function buildFacts(children: SubagentChildResult[]): string | undefined {
  const facts = children
    .map((child) => {
      const body = formatTerminalFactsBody(child.terminalResult);
      if (!body) return undefined;
      return children.length === 1 ? body : `${boundedLabel(child.agent || "worker")}: ${body}`;
    })
    .filter((value): value is string => Boolean(value))
    .join("; ");
  return facts ? boundedFacts(facts) : undefined;
}

function boundedReferenceList(values: unknown[], maxEntries: number): string[] | undefined {
  const references = values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .slice(0, maxEntries)
    .map((value) => boundedReference(value));
  return references.length > 0 ? references : undefined;
}

function resolveResumeTarget(
  result: SubagentResult,
  asyncId: string | undefined,
): ResumeTarget | undefined {
  if (!asyncId) return undefined;
  const children = Array.isArray(result.results) ? result.results : [];
  if (children.length <= 1) {
    const sessionPath = normalizeSessionPath(children[0]?.sessionPath ?? result.sessionFile);
    return sessionPath && fs.existsSync(sessionPath) ? { sessionPath } : undefined;
  }
  const statusPriority: Array<NonNullable<SubagentChildResult["status"]>> = [
    "failed",
    "paused",
    "completed",
  ];
  const resumableChild = statusPriority
    .map((status) =>
      children.find(
        (child) =>
          resolveChildStatus(child) === status &&
          isValidChildIndex(child.index, children.length) &&
          hasExistingSessionFile(child.sessionPath),
      ),
    )
    .find((child) => child !== undefined);
  const sessionPath = normalizeSessionPath(resumableChild?.sessionPath);
  if (
    !resumableChild ||
    sessionPath === undefined ||
    !isValidChildIndex(resumableChild.index, children.length)
  )
    return undefined;
  return { sessionPath, index: resumableChild.index, childCount: children.length };
}

function collectArtifactPaths(
  result: SubagentResult,
  children: SubagentChildResult[],
): string[] | undefined {
  if (isProtectedPausedLifecycle(result)) return undefined;
  return boundedReferenceList(
    children.map((child) => child.artifactPath),
    MAX_ARTIFACT_REFERENCES,
  );
}

function collectSessionPaths(
  result: SubagentResult,
  children: SubagentChildResult[],
): string[] | undefined {
  if (isProtectedPausedLifecycle(result)) return undefined;
  return boundedReferenceList(
    children.map((child) => child.sessionPath),
    MAX_SESSION_REFERENCES,
  );
}

export function formatSingleCompletion(details: SubagentNotifyDetails): string {
  const artifactLines = (details.artifactPaths ?? [])
    .slice(0, MAX_ARTIFACT_REFERENCES)
    .map((value) => `Output artifact: ${boundedReference(value)}`);
  const sessionPathLines = (details.sessionPaths ?? [])
    .slice(0, MAX_SESSION_REFERENCES)
    .map((value) => `Session: ${boundedReference(value)}`);
  const summary = boundedSummary(details.resultPreview.trim() || "(no output)");
  const indentedSummary = summary
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  const facts = details.factsPreview ? boundedFacts(details.factsPreview) : undefined;
  const asyncIdLine = formatAsyncIdLine(details);
  const resumeLine = formatResumeLine(details);
  const pausedSupervisorActionLines = formatPausedSupervisorActionLines(details);
  const sessionLine = formatSessionLine(details);
  const lines: string[] = [
    `Background task ${details.status}: **${boundedLabel(details.agent)}**${details.taskInfo ?? ""}`,
    "",
    ...artifactLines,
  ];
  if (artifactLines.length > 0) lines.push("");
  lines.push("Summary:", indentedSummary);
  if (facts) lines.push("", `Facts: ${facts}`);
  if (sessionPathLines.length > 0) lines.push("", ...sessionPathLines);
  if (asyncIdLine) lines.push("", asyncIdLine);
  if (pausedSupervisorActionLines.length > 0) {
    lines.push("", ...pausedSupervisorActionLines);
  } else if (resumeLine) {
    lines.push("", resumeLine);
  }
  if (sessionLine) lines.push("", sessionLine);
  return lines.join("\n");
}

function serializableDetails(details: SubagentNotifyDetails): Record<string, unknown> {
  const asyncId = normalizeAsyncIdentifier(details.asyncId);
  const resumeTarget = details.resumeTarget
    ? details.awaitingSupervisor
      ? {
          ...(details.resumeTarget.index !== undefined
            ? { index: details.resumeTarget.index }
            : {}),
          ...(details.resumeTarget.childCount !== undefined
            ? { childCount: details.resumeTarget.childCount }
            : {}),
        }
      : {
          ...(typeof details.resumeTarget.sessionPath === "string"
            ? { sessionPath: boundedReference(details.resumeTarget.sessionPath) }
            : {}),
          ...(details.resumeTarget.index !== undefined
            ? { index: details.resumeTarget.index }
            : {}),
          ...(details.resumeTarget.childCount !== undefined
            ? { childCount: details.resumeTarget.childCount }
            : {}),
        }
    : undefined;
  return {
    ...details,
    agent: boundedLabel(details.agent),
    resultPreview: boundedSummary(details.resultPreview),
    ...(details.factsPreview ? { factsPreview: boundedFacts(details.factsPreview) } : {}),
    ...(details.artifactPaths
      ? {
          artifactPaths: details.artifactPaths
            .slice(0, MAX_ARTIFACT_REFERENCES)
            .map(boundedReference),
        }
      : {}),
    ...(details.sessionPaths
      ? {
          sessionPaths: details.sessionPaths.slice(0, MAX_SESSION_REFERENCES).map(boundedReference),
        }
      : {}),
    ...(details.sessionLabel ? { sessionLabel: boundedLabel(details.sessionLabel) } : {}),
    ...(details.sessionValue ? { sessionValue: boundedReference(details.sessionValue) } : {}),
    ...(asyncId ? { asyncId } : {}),
    ...(resumeTarget ? { resumeTarget } : {}),
  };
}

const NUDGE_TEXT = BACKGROUND_COMPLETION_NUDGE_TEXT;

function sendCompletion(
  pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">,
  details: SubagentNotifyDetails,
  options: { triggerTurn: boolean; isIdle?: () => boolean } = { triggerTurn: true },
): void {
  const serializable = serializableDetails(details);
  pi.sendMessage({
    customType: "subagent-notify",
    content: formatSingleCompletion(details),
    display: true,
    details: serializable,
  });
  // Keep completion projection before the wake nudge. When idle, the follow-up
  // turn sees the notification in the transcript; while streaming, the custom
  // message is enough and a second turn would race the active response.
  if (options.triggerTurn && (options.isIdle?.() ?? true)) {
    pi.sendUserMessage(NUDGE_TEXT, { deliverAs: "followUp" });
  }
}

export function buildCompletionDetails(result: SubagentResult): SubagentNotifyDetails {
  const children = Array.isArray(result.results) ? result.results : [];
  const agent = boundedLabel(result.agent ?? "unknown");
  const status = resolveCompletionStatus(result);
  const taskInfo =
    typeof result.taskIndex === "number" &&
    Number.isInteger(result.taskIndex) &&
    typeof result.totalTasks === "number" &&
    Number.isInteger(result.totalTasks) &&
    result.taskIndex >= 0 &&
    result.totalTasks > result.taskIndex
      ? ` (${result.taskIndex + 1}/${result.totalTasks})`
      : undefined;
  const privacySafe = isProtectedPausedLifecycle(result);
  const session = privacySafe
    ? undefined
    : result.shareUrl
      ? { label: "Session", value: result.shareUrl }
      : result.shareError
        ? { label: "Session share error", value: result.shareError }
        : children.length === 0 && result.sessionFile
          ? { label: "Session file", value: result.sessionFile }
          : undefined;
  const asyncId = resolveAsyncIdentifier(result);
  const resumeTarget = resolveResumeTarget(result, asyncId);
  const artifactPaths = collectArtifactPaths(result, children);
  const sessionPaths = collectSessionPaths(result, children);
  const factsPreview = privacySafe ? undefined : buildFacts(children);

  return {
    agent,
    status,
    ...(taskInfo ? { taskInfo } : {}),
    resultPreview: privacySafe ? "Paused awaiting supervisor." : buildSummary(result, children),
    ...(factsPreview ? { factsPreview } : {}),
    ...(artifactPaths ? { artifactPaths } : {}),
    ...(sessionPaths ? { sessionPaths } : {}),
    ...(typeof result.durationMs === "number" && Number.isFinite(result.durationMs)
      ? { durationMs: result.durationMs }
      : {}),
    ...(asyncId ? { asyncId } : {}),
    ...(resumeTarget ? { resumeTarget } : {}),
    ...(session
      ? { sessionLabel: session.label, sessionValue: boundedReference(session.value) }
      : {}),
    ...(result.state === "paused" && result.pause?.kind === "awaiting_supervisor"
      ? { awaitingSupervisor: true }
      : {}),
  };
}

export default function registerSubagentNotify(
  pi: ExtensionAPI,
  state: Pick<SubagentState, "currentSessionId">,
): void {
  const unsubscribeStoreKey = "__pi_subagents_notify_unsubscribe__";
  const globalStore = globalThis as Record<string, unknown>;
  const previousUnsubscribe = globalStore[unsubscribeStoreKey];
  if (typeof previousUnsubscribe === "function") {
    try {
      previousUnsubscribe();
    } catch {
      // Best effort cleanup for a stale handler from an older reload.
    }
  }

  // Capture a session context so idleness is read at delivery time rather than
  // at registration time. This preserves completion-before-nudge ordering even
  // when a session changes while a child is finishing.
  let sessionContext: Pick<ExtensionContext, "isIdle"> | null = null;
  const isIdle = () => sessionContext?.isIdle() ?? true;
  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
  });

  const handleComplete = (data: unknown) => {
    const result = data as SubagentResult;
    if (typeof result.sessionId !== "string" || result.sessionId !== state.currentSessionId) return;
    // Let the live owner validate and privately consume the completion before
    // projecting a detached notification. A persisted `awaited` flag alone
    // cannot prove that an owner still exists after a reload, so those
    // artifacts remain eligible for recovery notifications.
    const completionRunId =
      typeof result.id === "string"
        ? result.id
        : typeof result.runId === "string"
          ? result.runId
          : undefined;
    if (completionRunId && dispatchAwaitedRunCompletion(completionRunId, result)) return;
    sendCompletion(pi, buildCompletionDetails(result), { triggerTurn: true, isIdle });
  };

  globalStore[unsubscribeStoreKey] = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete);
}
