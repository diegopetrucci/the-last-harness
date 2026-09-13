import {} from "../../shared/types.js";
import { normalizeIdleEpisodeId } from "./health-transition.js";
const CONTROL_EVENT_TYPES = ["needs_attention"];
const CONTROL_NOTIFICATION_CHANNELS = ["event", "async"];
const CONTROL_EVENT_REASONS = {
    idle: true,
    completion_guard: true,
    tool_failures: true,
    context_pressure: true,
};
function isControlEventReason(value) {
    return typeof value === "string" && Object.hasOwn(CONTROL_EVENT_REASONS, value);
}
const DEFAULT_NOTIFY_CHANNELS = ["event", "async"];
const DEFAULT_NOTIFY_ON = ["needs_attention"];
const RETIRED_CONTROL_EVENT_TYPES = ["active_long_running"];
export const DEFAULT_CONTROL_CONFIG = {
    enabled: true,
    needsAttentionAfterMs: 180_000,
    failedToolAttemptsBeforeAttention: 3,
    notifyOn: DEFAULT_NOTIFY_ON,
    notifyChannels: DEFAULT_NOTIFY_CHANNELS,
};
function parsePositiveInt(value) {
    if (typeof value !== "number")
        return undefined;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1)
        return undefined;
    return value;
}
function parseFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function parseControlList(value, allowed, retired = []) {
    if (!Array.isArray(value))
        return undefined;
    if (value.length === 0)
        return [];
    const allowedSet = new Set(allowed);
    const parsed = value.filter((entry) => typeof entry === "string" && allowedSet.has(entry));
    if (parsed.length > 0)
        return Array.from(new Set(parsed));
    return value.some((entry) => typeof entry === "string" && retired.includes(entry))
        ? []
        : undefined;
}
export function resolveControlConfig(globalConfig, override) {
    const enabled = override?.enabled ?? globalConfig?.enabled ?? DEFAULT_CONTROL_CONFIG.enabled;
    const needsAttentionAfterMs = parsePositiveInt(override?.needsAttentionAfterMs) ??
        parsePositiveInt(globalConfig?.needsAttentionAfterMs) ??
        DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs;
    const failedToolAttemptsBeforeAttention = parsePositiveInt(override?.failedToolAttemptsBeforeAttention) ??
        parsePositiveInt(globalConfig?.failedToolAttemptsBeforeAttention) ??
        DEFAULT_CONTROL_CONFIG.failedToolAttemptsBeforeAttention;
    const notifyOn = parseControlList(override?.notifyOn, CONTROL_EVENT_TYPES, RETIRED_CONTROL_EVENT_TYPES) ??
        parseControlList(globalConfig?.notifyOn, CONTROL_EVENT_TYPES, RETIRED_CONTROL_EVENT_TYPES) ??
        DEFAULT_CONTROL_CONFIG.notifyOn;
    const notifyChannels = parseControlList(override?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS) ??
        parseControlList(globalConfig?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS) ??
        DEFAULT_CONTROL_CONFIG.notifyChannels;
    return {
        enabled,
        needsAttentionAfterMs,
        failedToolAttemptsBeforeAttention,
        notifyOn: [...notifyOn],
        notifyChannels: [...notifyChannels],
    };
}
export function deriveActivityState(input) {
    if (!input.config.enabled || input.toolCallInFlight)
        return undefined;
    const now = input.now ?? Date.now();
    const lastActivity = input.lastActivityAt ?? input.startedAt;
    const ageMs = Math.max(0, now - lastActivity);
    return ageMs > input.config.needsAttentionAfterMs ? "needs_attention" : undefined;
}
export function buildControlEvent(input) {
    const ts = input.ts ?? Date.now();
    const type = input.type ?? "needs_attention";
    const reason = input.reason ?? "idle";
    const idleEpisodeId = input.to === "needs_attention" && reason === "idle"
        ? normalizeIdleEpisodeId(input.idleEpisodeId)
        : undefined;
    const elapsedMs = input.elapsedMs ?? (input.lastActivityAt ? Math.max(0, ts - input.lastActivityAt) : undefined);
    const elapsedSeconds = elapsedMs !== undefined ? Math.floor(elapsedMs / 1000) : undefined;
    const message = input.message ??
        (elapsedSeconds !== undefined
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
        ...(idleEpisodeId ? { idleEpisodeId } : {}),
        reason,
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
export function shouldNotifyControlEvent(config, event) {
    return config.enabled && config.notifyOn.includes(event.type);
}
export function parseControlEvent(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const raw = value;
    if (raw.type !== "needs_attention" ||
        raw.to !== "needs_attention" ||
        typeof raw.runId !== "string" ||
        typeof raw.agent !== "string" ||
        typeof raw.message !== "string" ||
        typeof raw.ts !== "number" ||
        !Number.isFinite(raw.ts))
        return undefined;
    const severity = raw.contextPressureSeverity;
    const threshold = raw.contextPressureThreshold;
    if ((severity !== undefined && severity !== "warning" && severity !== "critical") ||
        (threshold !== undefined && threshold !== "warning" && threshold !== "critical"))
        return undefined;
    const turns = parseFiniteNumber(raw.turns);
    const tokens = parseFiniteNumber(raw.tokens);
    const toolCount = parseFiniteNumber(raw.toolCount);
    const currentToolDurationMs = parseFiniteNumber(raw.currentToolDurationMs);
    const elapsedMs = parseFiniteNumber(raw.elapsedMs);
    const reason = isControlEventReason(raw.reason) ? raw.reason : undefined;
    const idleEpisodeId = raw.type === "needs_attention" && raw.to === "needs_attention" && reason === "idle"
        ? normalizeIdleEpisodeId(raw.idleEpisodeId)
        : undefined;
    return {
        type: "needs_attention",
        ...(raw.from === "needs_attention" ? { from: raw.from } : {}),
        to: "needs_attention",
        ts: raw.ts,
        runId: raw.runId,
        agent: raw.agent,
        ...(typeof raw.index === "number" && Number.isInteger(raw.index) ? { index: raw.index } : {}),
        message: raw.message,
        ...(severity ? { contextPressureSeverity: severity } : {}),
        ...(threshold ? { contextPressureThreshold: threshold } : {}),
        ...(idleEpisodeId ? { idleEpisodeId } : {}),
        ...(reason ? { reason } : {}),
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
export function controlNotificationKey(event) {
    const childKey = event.index !== undefined ? `${event.runId}:${event.index}` : event.runId;
    const pressureKey = event.reason === "context_pressure"
        ? `:${event.contextPressureSeverity ?? ""}:${event.contextPressureThreshold ?? ""}`
        : "";
    const idleEpisodeKey = event.type === "needs_attention" && event.reason === "idle"
        ? normalizeIdleEpisodeId(event.idleEpisodeId)
        : undefined;
    return `${childKey}:${event.type}:${event.reason ?? "idle"}${pressureKey}${idleEpisodeKey ? `:${idleEpisodeKey}` : ""}`;
}
export function claimControlNotification(config, event, seenKeys) {
    if (!shouldNotifyControlEvent(config, event))
        return false;
    const key = controlNotificationKey(event);
    if (seenKeys.has(key))
        return false;
    seenKeys.add(key);
    return true;
}
export function formatControlNoticeMessage(event) {
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
    const nudgeMessage = "What are you blocked on? Reply with the smallest next step or ask for a decision.";
    const nudgeCommand = `subagent({ action: "resume", id: "${runTarget}", ${event.index !== undefined ? `index: ${event.index}, ` : ""}message: "${nudgeMessage}" })`;
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
