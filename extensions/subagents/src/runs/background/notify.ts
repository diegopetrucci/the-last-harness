/**
 * Subagent completion notifications.
 *
 * The result watcher owns detached completion delivery. Every detached result
 * produces one message immediately; there is no batching window and no
 * notification-level replay/dedupe.
 *
 * Trust boundary: the model-visible message content is built only from
 * runtime-generated facts (run id, agent names, per-child status and
 * runtime-measured post-run facts, counts, artifact/session paths, next-step hints). Child-authored text never enters
 * it; the model fetches output through the `result` action, which returns it
 * as a genuine tool result. Bounded child previews live only in `details`
 * (TUI/persisted), each child bounded independently.
 *
 * Notification shape:
 *
 *   Background task <status>: **<agent>**
 *
 *   Children: <n> (<count> <status>, ...)
 *   - #<index> <agent>: <status> | <runtime post-run facts>
 *
 *   Output artifact: <bounded path>       (when one exists)
 *   Session: <bounded path>
 *
 *   Async id: <id>
 *   Fetch output: subagent({ action: "result", id: "<id>" })
 *
 * Every field is bounded independently, so no input size can crowd the
 * artifact/session references out of the message.
 */

import { sendWakeAwareMessage, wakeFor } from "./wake-message.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  type SubagentState,
  type SubagentTerminalResult,
} from "../../shared/types.ts";
import { isProtectedPausedLifecycle } from "../shared/lifecycle-privacy.ts";
import {
  normalizeSubagentRunTelemetry,
  type SubagentRunTelemetry,
} from "../../shared/telemetry.ts";
import { sliceSafe, truncateWithMarker } from "../../shared/string-utils.ts";
import { safeTerminalDocumentLeaf, safeTerminalText } from "../../shared/display-text.ts";

export const MAX_DISPLAY_SUMMARY_CHARS = 1_200;
export const MAX_COMPLETION_FACTS_CHARS = 1_200;
/** Children whose status/preview are listed individually. */
export const MAX_NOTIFY_CHILDREN = 64;
/** Ceiling for the joined per-child preview text (each child is bounded separately). */
export const MAX_TOTAL_PREVIEW_CHARS = MAX_NOTIFY_CHILDREN * (MAX_DISPLAY_SUMMARY_CHARS + 200);
const MAX_REFERENCE_CHARS = 500;
const MAX_ARTIFACT_REFERENCES = 8;
const MAX_SESSION_REFERENCES = 8;
const MAX_LABEL_CHARS = 160;
const MAX_ASYNC_ID_CHARS = 200;
const MAX_SESSION_PATH_CHARS = 4_096;

export const BUDGET_EXHAUSTION_GUIDANCE =
  "Budget exhausted: this child instance is permanently expired. Inspect partial output, artifacts, and files before deciding on a fresh dispatch; do not resume or mechanically redispatch the unchanged task.";

interface SubagentChildResult {
  agent: string;
  sessionFile?: string;
  model?: string;
  modelAttempts?: Array<{ usage?: unknown }>;
  totalCost?: { inputTokens?: unknown; outputTokens?: unknown; costUsd?: unknown };
  output?: string;
  success?: boolean;
  status?: "completed" | "failed" | "paused";
  summary?: string;
  artifactPath?: string;
  sessionPath?: string;
  index?: number;
  terminalResult?: SubagentTerminalResult;
  timedOut?: boolean;
  timeoutOwner?: "role" | "run";
  terminationReason?: string;
}

interface ResumeTarget {
  sessionPath: string;
  index?: number;
  childCount?: number;
}

/** Runtime-generated per-child outcome; `preview` is child-derived and details-only. */
export interface SubagentNotifyChild {
  index: number;
  agent: string;
  status: "completed" | "failed" | "paused";
  budgetExhausted?: boolean;
  /** Bounded (per child) child-derived preview; never placed in model-visible content. */
  preview?: string;
  /**
   * Runtime-measured post-run facts (exit/signal, duration, tokens, tool counts,
   * workspace attribution), bounded per child. Safe for model-visible content.
   */
  facts?: string;
}

/** Machine-readable usage in the shape analyzers already normalize. */
export interface SubagentChildRecordUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  turns: number;
}

/**
 * Complete per-child machine record for session/usage analyzers (epic contract
 * C8). Persisted in `details` only; every field is runtime-measured or a
 * bounded identifier — never child-authored text — and none reaches `content`.
 */
export interface SubagentChildRecord {
  runId: string;
  index: number;
  agent: string;
  /** Runtime-resolved terminal state, shaped like the telemetry outcome envelope. */
  outcome: { state: "completed" | "failed" | "paused" | "cancelled" };
  /** Full (unabbreviated) child session path; omitted when absent or over the path bound. */
  sessionFile?: string;
  model?: string;
  usage?: SubagentChildRecordUsage;
}

export interface SubagentNotifyDetails {
  agent: string;
  status: "completed" | "failed" | "paused";
  taskInfo?: string;
  /**
   * Child-derived summary text for TUI display only. Each child's portion is
   * bounded independently; the model-visible content never includes it.
   */
  resultPreview: string;
  /** Per-child outcomes in index order; absent for single results without child entries. */
  children?: SubagentNotifyChild[];
  /** Complete per-child machine records (lineage/usage), capped at MAX_NOTIFY_CHILDREN. */
  childRecords?: SubagentChildRecord[];
  /** Number of children beyond the cap that have no record. */
  childRecordsOmitted?: number;
  /** True when lifecycle privacy hides child details. */
  privacySafe?: boolean;
  /** Set at send time on the persisted completion message. */
  triggersTurn?: boolean;
  /** Bounded child-derived A1c facts body (TUI/details only; each child bounded independently). */
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
  /** True when this notice represents an exhausted, permanently expired instance. */
  budgetExhausted?: boolean;
  /** Privacy-safe run telemetry envelope, when available. */
  telemetry?: SubagentRunTelemetry;
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
  pause?: { kind?: string };
  terminalResult?: SubagentTerminalResult;
  telemetry?: SubagentRunTelemetry | Record<string, unknown>;
  timedOut?: boolean;
  timeoutOwner?: "role" | "run";
  terminationReason?: string;
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

function isRoleBudgetExhausted(value: {
  timedOut?: unknown;
  timeoutOwner?: unknown;
  terminationReason?: unknown;
}): boolean {
  return (
    value.timeoutOwner === "role" &&
    (value.timedOut === true || value.terminationReason === "timed_out")
  );
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
    details.budgetExhausted ||
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

function childPreview(child: SubagentChildResult): string {
  return boundedSummary(
    safeTerminalDocumentLeaf(childSummarySource(child)).trim() || "(no output)",
  );
}

function buildSummary(result: SubagentResult, children: SubagentChildResult[]): string {
  if (isProtectedPausedLifecycle(result)) return "Paused awaiting supervisor.";
  if (children.length === 0)
    return boundedSummary(
      (typeof result.summary === "string" ? result.summary : "").trim() || "(no output)",
    );
  // Each child is bounded on its own so one long child cannot crowd out the rest.
  return children
    .slice(0, MAX_NOTIFY_CHILDREN)
    .map((child) => {
      const preview = childPreview(child);
      return children.length === 1
        ? preview
        : `${boundedLabel(child.agent || "worker")}: ${preview}`;
    })
    .join("\n");
}

function buildChildren(children: SubagentChildResult[]): SubagentNotifyChild[] | undefined {
  if (children.length === 0) return undefined;
  return children.slice(0, MAX_NOTIFY_CHILDREN).map((child, position) => {
    const factsBody = formatTerminalFactsBody(child.terminalResult);
    return {
      index: isValidChildIndex(child.index, children.length) ? child.index : position,
      agent: boundedLabel(child.agent || "worker"),
      status: resolveChildStatus(child),
      ...(isRoleBudgetExhausted(child) ? { budgetExhausted: true } : {}),
      preview: childPreview(child),
      ...(factsBody ? { facts: boundedFacts(factsBody) } : {}),
    };
  });
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function childRecordUsage(child: SubagentChildResult): SubagentChildRecordUsage | undefined {
  const attempts = (Array.isArray(child.modelAttempts) ? child.modelAttempts : []).filter(
    (attempt): attempt is { usage: Record<string, unknown> } =>
      typeof attempt?.usage === "object" && attempt.usage !== null,
  );
  let usage: Omit<SubagentChildRecordUsage, "total"> | undefined;
  if (attempts.length > 0) {
    usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
    for (const { usage: u } of attempts) {
      usage.input += finiteNonNegative(u.input);
      usage.output += finiteNonNegative(u.output);
      usage.cacheRead += finiteNonNegative(u.cacheRead);
      usage.cacheWrite += finiteNonNegative(u.cacheWrite);
      usage.cost += finiteNonNegative(u.cost);
      usage.turns += finiteNonNegative(u.turns);
    }
  } else if (child.totalCost) {
    usage = {
      input: finiteNonNegative(child.totalCost.inputTokens),
      output: finiteNonNegative(child.totalCost.outputTokens),
      cacheRead: 0,
      cacheWrite: 0,
      cost: finiteNonNegative(child.totalCost.costUsd),
      turns: 0,
    };
  } else {
    // Fall back to provider-reported per-attempt tokens when nothing richer exists.
    let input = 0;
    let output = 0;
    let found = false;
    for (const attempt of child.terminalResult?.facts.attempts ?? []) {
      if (attempt.providerTokens.status !== "available") continue;
      found = true;
      input += finiteNonNegative(attempt.providerTokens.usage.input);
      output += finiteNonNegative(attempt.providerTokens.usage.output);
    }
    if (found) usage = { input, output, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  }
  if (!usage) return undefined;
  return { ...usage, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite };
}

function buildChildRecords(
  runId: string | undefined,
  children: SubagentChildResult[],
): SubagentChildRecord[] | undefined {
  if (!runId || children.length === 0) return undefined;
  return children.slice(0, MAX_NOTIFY_CHILDREN).map((child, position) => {
    const sessionFile =
      typeof child.sessionFile === "string" ? child.sessionFile : child.sessionPath;
    const usage = childRecordUsage(child);
    return {
      runId,
      index: isValidChildIndex(child.index, children.length) ? child.index : position,
      agent: boundedLabel(child.agent || "worker"),
      outcome: { state: child.terminalResult?.state ?? resolveChildStatus(child) },
      ...(sessionFile && sessionFile.length <= MAX_SESSION_PATH_CHARS ? { sessionFile } : {}),
      ...(typeof child.model === "string" && child.model
        ? { model: boundedLabel(child.model) }
        : {}),
      ...(usage ? { usage } : {}),
    };
  });
}

function buildFacts(children: SubagentChildResult[]): string | undefined {
  const facts = children
    .slice(0, MAX_NOTIFY_CHILDREN)
    .map((child) => {
      const body = formatTerminalFactsBody(child.terminalResult);
      if (!body) return undefined;
      const bounded = boundedFacts(body);
      return children.length === 1
        ? bounded
        : `${boundedLabel(child.agent || "worker")}: ${bounded}`;
    })
    .filter((value): value is string => Boolean(value))
    .join("; ");
  return facts || undefined;
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
  if (children.length === 0) {
    if (isRoleBudgetExhausted(result)) return undefined;
    const sessionPath = normalizeSessionPath(result.sessionFile);
    return sessionPath && fs.existsSync(sessionPath) ? { sessionPath } : undefined;
  }
  if (children.length === 1) {
    if (isRoleBudgetExhausted(result) || isRoleBudgetExhausted(children[0])) return undefined;
    const sessionPath = normalizeSessionPath(children[0].sessionPath ?? result.sessionFile);
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
          !isRoleBudgetExhausted(child) &&
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

function formatChildrenLines(details: SubagentNotifyDetails): string[] {
  const children = details.children;
  if (!children || children.length === 0) return [];
  const counts = new Map<string, number>();
  for (const child of children) counts.set(child.status, (counts.get(child.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(", ");
  const lines = [`Children: ${children.length} (${summary})`];
  for (const child of children.slice(0, MAX_NOTIFY_CHILDREN)) {
    const index = Number.isInteger(child.index) ? child.index : 0;
    // Facts are runtime-measured only (see formatTerminalFactsBody); never child text.
    const facts = child.facts ? ` | ${boundedFacts(child.facts)}` : "";
    lines.push(
      `- #${index} ${boundedLabel(child.agent)}: ${child.status}${child.budgetExhausted ? " (budget exhausted)" : ""}${facts}`,
    );
  }
  return lines;
}

/**
 * Model-visible completion text. Built exclusively from runtime-generated
 * facts; `details.resultPreview` and `children[].preview` are child-derived
 * and intentionally never read here. `children[].facts` are runtime-measured.
 */
export function formatSingleCompletion(details: SubagentNotifyDetails): string {
  const artifactLines = (details.artifactPaths ?? [])
    .slice(0, MAX_ARTIFACT_REFERENCES)
    .map((value) => `Output artifact: ${boundedReference(value)}`);
  const sessionPathLines = (details.sessionPaths ?? [])
    .slice(0, MAX_SESSION_REFERENCES)
    .map((value) => `Session: ${boundedReference(value)}`);
  const asyncId = normalizeAsyncIdentifier(details.asyncId);
  const asyncIdLine = formatAsyncIdLine(details);
  const resumeLine = formatResumeLine(details);
  const pausedSupervisorActionLines = formatPausedSupervisorActionLines(details);
  const sessionLine = formatSessionLine(details);
  const childrenLines = formatChildrenLines(details);
  const lines: string[] = [
    `Background task ${details.status}: **${boundedLabel(details.agent)}**${details.taskInfo ?? ""}`,
    "",
  ];
  if (details.privacySafe) lines.push("Paused awaiting supervisor.", "");
  if (childrenLines.length > 0) lines.push(...childrenLines, "");
  if (artifactLines.length > 0) lines.push(...artifactLines, "");
  if (sessionPathLines.length > 0) lines.push(...sessionPathLines, "");
  if (asyncIdLine) lines.push(asyncIdLine);
  if (asyncId && !details.privacySafe)
    lines.push(
      `Fetch output (bounded per child): subagent({ action: "result", id: ${JSON.stringify(asyncId)} })`,
    );
  if (details.budgetExhausted) lines.push("", BUDGET_EXHAUSTION_GUIDANCE);
  if (pausedSupervisorActionLines.length > 0) {
    lines.push("", ...pausedSupervisorActionLines);
  } else if (resumeLine) {
    lines.push("", resumeLine);
  }
  if (sessionLine) lines.push("", sessionLine);
  while (lines.at(-1) === "") lines.pop();
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
    // Each child's portion is already bounded independently; this is only a ceiling.
    resultPreview: truncateWithMarker(
      details.resultPreview,
      MAX_TOTAL_PREVIEW_CHARS,
      "… [summary truncated]",
    ),
    ...(details.children
      ? {
          children: details.children.slice(0, MAX_NOTIFY_CHILDREN).map((child) => ({
            ...child,
            agent: boundedLabel(child.agent),
            ...(child.preview ? { preview: boundedSummary(child.preview) } : {}),
            ...(child.facts ? { facts: boundedFacts(child.facts) } : {}),
          })),
        }
      : {}),
    ...(details.childRecords
      ? { childRecords: details.childRecords.slice(0, MAX_NOTIFY_CHILDREN) }
      : {}),
    ...(details.factsPreview
      ? {
          factsPreview: truncateWithMarker(
            details.factsPreview,
            MAX_NOTIFY_CHILDREN * (MAX_COMPLETION_FACTS_CHARS + 200),
            "… [facts truncated]",
          ),
        }
      : {}),
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
    ...(normalizeSubagentRunTelemetry(details.telemetry)
      ? { telemetry: normalizeSubagentRunTelemetry(details.telemetry) }
      : {}),
  };
}

function sendCompletion(
  pi: Pick<ExtensionAPI, "sendMessage">,
  details: SubagentNotifyDetails,
  options: { triggerTurn: boolean; isIdle?: () => boolean } = { triggerTurn: true },
): void {
  const serializable = serializableDetails(details);
  const wake = wakeFor(options);
  sendWakeAwareMessage(
    pi,
    {
      customType: "subagent-notify",
      content: formatSingleCompletion(details),
      display: true,
      // Persisted so session analysis can tell a wake from a steer.
      details: { ...serializable, triggersTurn: wake },
    },
    wake,
  );
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
  // Parallel results carry authoritative exhaustion per child; a single-child
  // result may also retain the outer marker.
  const budgetExhausted =
    children.some(isRoleBudgetExhausted) || (children.length <= 1 && isRoleBudgetExhausted(result));
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
  const childDetails = privacySafe ? undefined : buildChildren(children);
  // Machine lineage stays in persisted (non-model-visible) details even when protected.
  const childRecords = buildChildRecords(asyncId, children);

  return {
    agent,
    status,
    ...(taskInfo ? { taskInfo } : {}),
    resultPreview: privacySafe ? "Paused awaiting supervisor." : buildSummary(result, children),
    ...(childDetails ? { children: childDetails } : {}),
    ...(childRecords ? { childRecords } : {}),
    ...(childRecords && children.length > childRecords.length
      ? { childRecordsOmitted: children.length - childRecords.length }
      : {}),
    ...(privacySafe ? { privacySafe: true } : {}),
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
    ...(budgetExhausted ? { budgetExhausted: true } : {}),
    ...(normalizeSubagentRunTelemetry(result.telemetry)
      ? { telemetry: normalizeSubagentRunTelemetry(result.telemetry) }
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
  // at registration time. This preserves completion-before-wake ordering even
  // when a session changes while a child is finishing.
  let sessionContext: Pick<ExtensionContext, "isIdle"> | null = null;
  const isIdle = () => sessionContext?.isIdle() ?? true;
  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
  });

  const handleComplete = (data: unknown) => {
    const result = data as SubagentResult;
    if (typeof result.sessionId !== "string" || result.sessionId !== state.currentSessionId) return;
    sendCompletion(pi, buildCompletionDetails(result), { triggerTurn: true, isIdle });
  };

  globalStore[unsubscribeStoreKey] = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete);
}
