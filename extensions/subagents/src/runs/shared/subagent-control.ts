import {
  type ActivityState,
  type ControlConfig,
  type ContextPressureSeverity,
  type ContextPressureThreshold,
  type ControlEvent,
  type ControlEventType,
  type ControlNotificationChannel,
  type ResolvedControlConfig,
} from "../../shared/types.ts";

const CONTROL_EVENT_TYPES: ControlEventType[] = ["active_long_running", "needs_attention"];
const CONTROL_NOTIFICATION_CHANNELS: ControlNotificationChannel[] = ["event", "async"];
type ControlEventReason = NonNullable<ControlEvent["reason"]>;
const CONTROL_EVENT_REASONS: Record<ControlEventReason, true> = {
  idle: true,
  completion_guard: true,
  active_long_running: true,
  tool_failures: true,
  time_threshold: true,
  turn_threshold: true,
  token_threshold: true,
  context_pressure: true,
};

function isControlEventReason(value: unknown): value is ControlEventReason {
  return typeof value === "string" && Object.hasOwn(CONTROL_EVENT_REASONS, value);
}

const DEFAULT_NOTIFY_CHANNELS: ControlNotificationChannel[] = ["event", "async"];
const DEFAULT_NOTIFY_ON: ControlEventType[] = ["active_long_running", "needs_attention"];

export const DEFAULT_CONTROL_CONFIG: ResolvedControlConfig = {
  enabled: true,
  needsAttentionAfterMs: 60_000,
  activeNoticeAfterMs: 240_000,
  failedToolAttemptsBeforeAttention: 3,
  notifyOn: DEFAULT_NOTIFY_ON,
  notifyChannels: DEFAULT_NOTIFY_CHANNELS,
};

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function parseFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseControlList<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];
  const allowedSet = new Set(allowed);
  const parsed = value.filter(
    (entry): entry is T => typeof entry === "string" && allowedSet.has(entry as T),
  );
  return parsed.length > 0 ? Array.from(new Set(parsed)) : undefined;
}

export function resolveControlConfig(
  globalConfig?: ControlConfig,
  override?: ControlConfig,
): ResolvedControlConfig {
  const enabled = override?.enabled ?? globalConfig?.enabled ?? DEFAULT_CONTROL_CONFIG.enabled;
  const needsAttentionAfterMs =
    parsePositiveInt(override?.needsAttentionAfterMs) ??
    parsePositiveInt(globalConfig?.needsAttentionAfterMs) ??
    DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs;
  const activeNoticeAfterMs =
    parsePositiveInt(override?.activeNoticeAfterMs) ??
    parsePositiveInt(globalConfig?.activeNoticeAfterMs) ??
    DEFAULT_CONTROL_CONFIG.activeNoticeAfterMs;
  const activeNoticeAfterTurns =
    parsePositiveInt(override?.activeNoticeAfterTurns) ??
    parsePositiveInt(globalConfig?.activeNoticeAfterTurns);
  const activeNoticeAfterTokens =
    parsePositiveInt(override?.activeNoticeAfterTokens) ??
    parsePositiveInt(globalConfig?.activeNoticeAfterTokens);
  const failedToolAttemptsBeforeAttention =
    parsePositiveInt(override?.failedToolAttemptsBeforeAttention) ??
    parsePositiveInt(globalConfig?.failedToolAttemptsBeforeAttention) ??
    DEFAULT_CONTROL_CONFIG.failedToolAttemptsBeforeAttention;
  const notifyOn =
    parseControlList(override?.notifyOn, CONTROL_EVENT_TYPES) ??
    parseControlList(globalConfig?.notifyOn, CONTROL_EVENT_TYPES) ??
    DEFAULT_CONTROL_CONFIG.notifyOn;
  const notifyChannels =
    parseControlList(override?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS) ??
    parseControlList(globalConfig?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS) ??
    DEFAULT_CONTROL_CONFIG.notifyChannels;
  return {
    enabled,
    needsAttentionAfterMs,
    activeNoticeAfterMs,
    activeNoticeAfterTurns,
    activeNoticeAfterTokens,
    failedToolAttemptsBeforeAttention,
    notifyOn: [...notifyOn],
    notifyChannels: [...notifyChannels],
  };
}

export function deriveActivityState(input: {
  config: ResolvedControlConfig;
  startedAt: number;
  lastActivityAt?: number;
  toolCallInFlight?: boolean;
  now?: number;
}): ActivityState | undefined {
  if (!input.config.enabled || input.toolCallInFlight) return undefined;
  const now = input.now ?? Date.now();
  const lastActivity = input.lastActivityAt ?? input.startedAt;
  const ageMs = Math.max(0, now - lastActivity);
  return ageMs > input.config.needsAttentionAfterMs ? "needs_attention" : undefined;
}

export function buildControlEvent(input: {
  type?: ControlEventType;
  from?: ActivityState;
  to: ActivityState;
  runId: string;
  agent: string;
  index?: number;
  ts?: number;
  lastActivityAt?: number;
  message?: string;
  reason?: ControlEvent["reason"];
  contextPressureSeverity?: ContextPressureSeverity;
  contextPressureThreshold?: ContextPressureThreshold;
  turns?: number;
  tokens?: number;
  toolCount?: number;
  currentTool?: string;
  currentToolDurationMs?: number;
  currentPath?: string;
  elapsedMs?: number;
  recentFailureSummary?: string;
}): ControlEvent {
  const ts = input.ts ?? Date.now();
  const type =
    input.type ?? (input.to === "active_long_running" ? "active_long_running" : "needs_attention");
  const elapsedMs =
    input.elapsedMs ?? (input.lastActivityAt ? Math.max(0, ts - input.lastActivityAt) : undefined);
  const elapsedSeconds = elapsedMs !== undefined ? Math.floor(elapsedMs / 1000) : undefined;
  const message =
    input.message ??
    (type === "active_long_running"
      ? `${input.agent} is still active but long-running`
      : elapsedSeconds !== undefined
        ? `${input.agent} needs attention (no observed activity for ${elapsedSeconds}s)`
        : `${input.agent} needs attention`);
  return {
    type,
    ...(input.from ? { from: input.from } : {}),
    to: input.to,
    ts,
    runId: input.runId,
    agent: input.agent,
    ...(input.index !== undefined ? { index: input.index } : {}),
    message,
    ...(input.contextPressureSeverity
      ? { contextPressureSeverity: input.contextPressureSeverity }
      : {}),
    ...(input.contextPressureThreshold
      ? { contextPressureThreshold: input.contextPressureThreshold }
      : {}),
    reason: input.reason ?? (type === "active_long_running" ? "active_long_running" : "idle"),
    ...(input.turns !== undefined ? { turns: input.turns } : {}),
    ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
    ...(input.toolCount !== undefined ? { toolCount: input.toolCount } : {}),
    ...(input.currentTool ? { currentTool: input.currentTool } : {}),
    ...(input.currentToolDurationMs !== undefined
      ? { currentToolDurationMs: input.currentToolDurationMs }
      : {}),
    ...(input.currentPath ? { currentPath: input.currentPath } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(input.recentFailureSummary ? { recentFailureSummary: input.recentFailureSummary } : {}),
  };
}

export function shouldNotifyControlEvent(
  config: ResolvedControlConfig,
  event: ControlEvent,
): boolean {
  return config.enabled && config.notifyOn.includes(event.type);
}

/** Parse the untrusted JSON event boundary while retaining pressure identity. */
export function parseControlEvent(value: unknown): ControlEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    (raw.type !== "active_long_running" && raw.type !== "needs_attention") ||
    (raw.to !== "active_long_running" && raw.to !== "needs_attention") ||
    typeof raw.runId !== "string" ||
    typeof raw.agent !== "string" ||
    typeof raw.message !== "string" ||
    typeof raw.ts !== "number" ||
    !Number.isFinite(raw.ts)
  )
    return undefined;
  const severity = raw.contextPressureSeverity;
  const threshold = raw.contextPressureThreshold;
  if (
    (severity !== undefined && severity !== "warning" && severity !== "critical") ||
    (threshold !== undefined && threshold !== "warning" && threshold !== "critical")
  )
    return undefined;
  const turns = parseFiniteNumber(raw.turns);
  const tokens = parseFiniteNumber(raw.tokens);
  const toolCount = parseFiniteNumber(raw.toolCount);
  const currentToolDurationMs = parseFiniteNumber(raw.currentToolDurationMs);
  const elapsedMs = parseFiniteNumber(raw.elapsedMs);
  return {
    type: raw.type,
    ...(raw.from === "active_long_running" || raw.from === "needs_attention"
      ? { from: raw.from }
      : {}),
    to: raw.to,
    ts: raw.ts,
    runId: raw.runId,
    agent: raw.agent,
    ...(typeof raw.index === "number" && Number.isInteger(raw.index) ? { index: raw.index } : {}),
    message: raw.message,
    ...(severity ? { contextPressureSeverity: severity } : {}),
    ...(threshold ? { contextPressureThreshold: threshold } : {}),
    ...(isControlEventReason(raw.reason) ? { reason: raw.reason } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(toolCount !== undefined ? { toolCount } : {}),
    ...(typeof raw.currentTool === "string" ? { currentTool: raw.currentTool } : {}),
    ...(currentToolDurationMs !== undefined ? { currentToolDurationMs } : {}),
    ...(typeof raw.currentPath === "string" ? { currentPath: raw.currentPath } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(typeof raw.recentFailureSummary === "string"
      ? { recentFailureSummary: raw.recentFailureSummary }
      : {}),
  };
}

export function controlNotificationKey(event: ControlEvent): string {
  const childKey = event.index !== undefined ? `${event.runId}:${event.index}` : event.runId;
  const pressureKey =
    event.reason === "context_pressure"
      ? `:${event.contextPressureSeverity ?? ""}:${event.contextPressureThreshold ?? ""}`
      : "";
  return `${childKey}:${event.type}:${event.reason ?? "idle"}${pressureKey}`;
}

export function claimControlNotification(
  config: ResolvedControlConfig,
  event: ControlEvent,
  seenKeys: Set<string>,
): boolean {
  if (!shouldNotifyControlEvent(config, event)) return false;
  const key = controlNotificationKey(event);
  if (seenKeys.has(key)) return false;
  seenKeys.add(key);
  return true;
}

function formatLongRunningFacts(event: ControlEvent): string | undefined {
  const facts: string[] = [];
  if (event.elapsedMs !== undefined)
    facts.push(`elapsed ${Math.floor(Math.max(0, event.elapsedMs) / 1000)}s`);
  if (event.turns !== undefined) facts.push(`${event.turns} turns`);
  if (event.tokens !== undefined) facts.push(`${event.tokens} tokens`);
  if (event.toolCount !== undefined) facts.push(`${event.toolCount} tools`);
  if (event.currentTool)
    facts.push(
      `tool ${event.currentTool}${event.currentToolDurationMs !== undefined ? ` ${Math.floor(Math.max(0, event.currentToolDurationMs) / 1000)}s` : ""}`,
    );
  if (event.currentPath) facts.push(`path ${event.currentPath}`);
  return facts.length > 0 ? facts.join(" | ") : undefined;
}

export function formatControlNoticeMessage(event: ControlEvent): string {
  const runTarget = event.runId;
  if (event.reason === "completion_guard") {
    return [
      `Subagent failed: ${event.agent}`,
      `Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
      `Signal: ${event.message}`,
      "Next: read the output artifact or session from the subagent result, then retry with a more explicit implementation prompt or handle the fix directly.",
    ].join("\n");
  }

  if (event.reason === "context_pressure") {
    return [
      `Subagent context pressure: ${event.agent}`,
      `Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
      `Signal: ${event.message}`,
      "Do not interrupt or compact automatically; inspect status and preserve the child’s progress.",
      `Status: subagent({ action: "status", id: "${runTarget}" })`,
    ].join("\n");
  }

  const nudgeMessage =
    "What are you blocked on? Reply with the smallest next step or ask for a decision.";
  const nudgeCommand = `subagent({ action: "resume", id: "${runTarget}", ${event.index !== undefined ? `index: ${event.index}, ` : ""}message: "${nudgeMessage}" })`;
  if (event.type === "active_long_running") {
    const facts = formatLongRunningFacts(event);
    return [
      `Subagent active but long-running: ${event.agent}`,
      `Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
      `Signal: ${event.message}`,
      ...(facts ? [`Facts: ${facts}`] : []),
      "Hint: Inspect status, then nudge if the work seems stuck. Live async nudges interrupt the child before sending the follow-up.",
      `Nudge: ${nudgeCommand}`,
      `Status: subagent({ action: "status", id: "${runTarget}" })`,
      `Interrupt: subagent({ action: "interrupt", id: "${runTarget}" })`,
    ].join("\n");
  }

  return [
    `Subagent needs attention: ${event.agent}`,
    `Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
    `Signal: ${event.message}`,
    ...(event.recentFailureSummary ? [`Recent failures: ${event.recentFailureSummary}`] : []),
    "Hint: Inspect status first unless the run is clearly blocked. Live async nudges interrupt the child before sending the follow-up.",
    `Nudge: ${nudgeCommand}`,
    `Status: subagent({ action: "status", id: "${runTarget}" })`,
    `Interrupt: subagent({ action: "interrupt", id: "${runTarget}" })`,
  ].join("\n");
}
