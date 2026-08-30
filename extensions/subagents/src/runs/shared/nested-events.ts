import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  RESULTS_DIR,
  TEMP_ROOT_DIR,
  type AsyncJobState,
  type AsyncStatus,
  type ContextPressureProjection,
  type ContextPressureThreshold,
  type ContextUsageDiagnostics,
  type NestedRouteInfo,
  type TurnBudgetState,
  type NestedRunSummary,
  type NestedRunState,
  type NestedStepSummary,
  type SubagentRunMode,
  type SubagentTerminationReason,
  type SubagentState,
} from "../../shared/types.ts";
import {
  isSafeNestedPathId,
  parseNestedPathEnv,
  sanitizeNestedPath,
  type NestedPathEntry,
} from "./nested-path.ts";
import {
  SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
  SUBAGENT_PARENT_CHILD_INDEX_ENV,
  SUBAGENT_PARENT_CONTROL_INBOX_ENV,
  SUBAGENT_PARENT_DEPTH_ENV,
  SUBAGENT_PARENT_EVENT_SINK_ENV,
  SUBAGENT_PARENT_PATH_ENV,
  SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
  SUBAGENT_PARENT_RUN_ID_ENV,
} from "./pi-args.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import {
  normalizeProjectAgentRunCapture,
  type ProjectAgentRunCapture,
} from "../../agents/project-agent-snapshot.ts";
import {
  parseContextPressureCrossedThresholds,
  parseContextPressureProjection,
  parseContextUsageDiagnostics,
  parseSubagentTerminationReason,
} from "../../shared/context-diagnostics.ts";

export const NESTED_EVENTS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-events");
const ROUTE_FILE = "route.json";
const REGISTRY_FILE = "registry.json";
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_STEPS = 12;
const MAX_CHILDREN = 16;
const MAX_DEPTH = 3;

type NestedStatusEventType =
  | "subagent.nested.started"
  | "subagent.nested.updated"
  | "subagent.nested.completed";

export type NestedRoute = NestedRouteInfo;

interface NestedEventRecord {
  type: NestedStatusEventType;
  ts: number;
  rootRunId: string;
  parentRunId: string;
  parentStepIndex?: number;
  capabilityToken: string;
  child: NestedRunSummary;
}

interface NestedRegistry {
  rootRunId: string;
  updatedAt: number;
  children: NestedRunSummary[];
  processedEvents: string[];
}

function isSafeNestedId(value: unknown): value is string {
  return isSafeNestedPathId(value);
}

export function assertSafeNestedId(label: string, value: string): void {
  if (!isSafeNestedId(value)) throw new Error(`${label} must be a non-empty safe id token.`);
}

function assertSafeId(label: string, value: string): void {
  assertSafeNestedId(label, value);
}

function containedPath(base: string, candidate: string): boolean {
  const resolvedBase = path.resolve(base);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`)
  );
}

function commonRouteRoot(route: Pick<NestedRoute, "eventSink" | "controlInbox">): string {
  return path.dirname(path.resolve(route.eventSink));
}

function validateNestedRoute(route: NestedRoute): void {
  assertSafeId("rootRunId", route.rootRunId);
  assertSafeId("capabilityToken", route.capabilityToken);
  if (!containedPath(NESTED_EVENTS_DIR, route.eventSink))
    throw new Error("Nested event sink is outside the subagent nested event root.");
  if (!containedPath(NESTED_EVENTS_DIR, route.controlInbox))
    throw new Error("Nested control inbox is outside the subagent nested event root.");
  if (commonRouteRoot(route) !== path.dirname(path.resolve(route.controlInbox)))
    throw new Error("Nested event sink and control inbox must share one route root.");
}

export function createNestedRoute(rootRunId: string): NestedRoute {
  assertSafeId("rootRunId", rootRunId);
  const capabilityToken = randomUUID();
  const routeRoot = path.join(NESTED_EVENTS_DIR, `${rootRunId}-${capabilityToken}`);
  const eventSink = path.join(routeRoot, "events");
  const controlInbox = path.join(routeRoot, "controls");
  fs.mkdirSync(eventSink, { recursive: true, mode: 0o700 });
  fs.mkdirSync(controlInbox, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(routeRoot, ROUTE_FILE),
    `${JSON.stringify({ rootRunId, capabilityToken, createdAt: Date.now() })}\n`,
    { mode: 0o600 },
  );
  return { rootRunId, eventSink, controlInbox, capabilityToken };
}

export function resolveNestedRouteFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): NestedRoute | undefined {
  const rootRunId = env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV];
  const eventSink = env[SUBAGENT_PARENT_EVENT_SINK_ENV];
  const controlInbox = env[SUBAGENT_PARENT_CONTROL_INBOX_ENV];
  const capabilityToken = env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV];
  if (!rootRunId || !eventSink || !controlInbox || !capabilityToken) return undefined;
  const route = { rootRunId, eventSink, controlInbox, capabilityToken };
  validateNestedRoute(route);
  const routeFile = path.join(commonRouteRoot(route), ROUTE_FILE);
  const metadata = JSON.parse(fs.readFileSync(routeFile, "utf-8")) as {
    rootRunId?: unknown;
    capabilityToken?: unknown;
  };
  if (metadata.rootRunId !== rootRunId || metadata.capabilityToken !== capabilityToken) {
    throw new Error(
      "Nested event route metadata does not match the provided root id and capability token.",
    );
  }
  return route;
}

export function resolveInheritedNestedRouteFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): NestedRoute | undefined {
  try {
    return resolveNestedRouteFromEnv(env);
  } catch (error) {
    console.error("Ignoring invalid nested subagent event route:", error);
    return undefined;
  }
}

export function resolveNestedParentAddressFromEnv(
  env: NodeJS.ProcessEnv = process.env,
):
  | { parentRunId: string; parentStepIndex?: number; depth: number; path: NestedPathEntry[] }
  | undefined {
  const parentRunId = env[SUBAGENT_PARENT_RUN_ID_ENV];
  if (!isSafeNestedId(parentRunId)) return undefined;
  const rawIndex = env[SUBAGENT_PARENT_CHILD_INDEX_ENV];
  const parentStepIndex = rawIndex && /^\d+$/.test(rawIndex) ? Number(rawIndex) : undefined;
  const depth = Math.min(
    Math.max(1, clampNumber(Number(env[SUBAGENT_PARENT_DEPTH_ENV])) ?? 1),
    MAX_DEPTH,
  );
  const parsedPath = parseNestedPathEnv(env[SUBAGENT_PARENT_PATH_ENV]);
  const nestedPath = parsedPath.length
    ? parsedPath
    : [
        {
          runId: parentRunId,
          ...(parentStepIndex !== undefined ? { stepIndex: parentStepIndex } : {}),
        },
      ];
  return {
    parentRunId,
    ...(parentStepIndex !== undefined ? { parentStepIndex } : {}),
    depth,
    path: nestedPath,
  };
}

export function resolveNestedAsyncDir(
  rootRunId: string,
  run: NestedRunSummary,
): string | undefined {
  if (!run.asyncDir) return undefined;
  const resolved = path.resolve(run.asyncDir);
  const nestedRoot = path.resolve(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId, run.id);
  const relative = path.relative(nestedRoot, resolved);
  return resolved === nestedRoot || (!relative.startsWith("..") && !path.isAbsolute(relative))
    ? resolved
    : undefined;
}

function clampNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown, max = 512): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

// Prefer absence over a silently truncated value for fields that are consumed
// programmatically (opened, resolved, or used to locate a directory). A truncated
// path still looks valid and fails later as a confusing not-found; an absent field
// is detectably absent and can be handled at the point of use.
function pathValue(value: unknown, max = 512): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.length > max) return undefined;
  return value;
}

// Display-only string fields: visible middle-truncation is acceptable because
// the value is shown to a human or the model, not used to locate files.
function displayStringValue(value: unknown, max = 512): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.length <= max) return value;
  // Back up by one code unit when the cut would fall between a UTF-16 surrogate
  // pair, ensuring the returned string is always well-formed.
  const cut = max - 1;
  const sliced = value.slice(0, cut);
  const last = sliced.charCodeAt(sliced.length - 1);
  const safe = last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
  return `${safe}…`;
}

function sanitizeTokenUsage(value: unknown): NestedRunSummary["totalTokens"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const input = clampNumber(raw.input);
  const output = clampNumber(raw.output);
  const total = clampNumber(raw.total);
  return input !== undefined && output !== undefined && total !== undefined
    ? { input, output, total }
    : undefined;
}

function sanitizeCost(value: unknown): NestedRunSummary["totalCost"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const inputTokens = clampNumber(raw.inputTokens);
  const outputTokens = clampNumber(raw.outputTokens);
  const costUsd = clampNumber(raw.costUsd);
  return inputTokens !== undefined && outputTokens !== undefined && costUsd !== undefined
    ? { inputTokens, outputTokens, costUsd }
    : undefined;
}

function sanitizeTurnBudget(value: unknown): TurnBudgetState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const maxTurns = clampNumber(raw.maxTurns);
  const graceTurns = clampNumber(raw.graceTurns);
  const turnCount = clampNumber(raw.turnCount);
  const outcome =
    raw.outcome === "within-budget" ||
    raw.outcome === "wrap-up-requested" ||
    raw.outcome === "exceeded"
      ? raw.outcome
      : undefined;
  if (maxTurns === undefined || graceTurns === undefined || turnCount === undefined || !outcome)
    return undefined;
  return {
    maxTurns,
    graceTurns,
    turnCount,
    outcome,
    ...(clampNumber(raw.wrapUpRequestedAtTurn) !== undefined
      ? { wrapUpRequestedAtTurn: clampNumber(raw.wrapUpRequestedAtTurn) }
      : {}),
    ...(clampNumber(raw.exceededAtTurn) !== undefined
      ? { exceededAtTurn: clampNumber(raw.exceededAtTurn) }
      : {}),
  };
}

function sanitizeState(value: unknown, fallback: NestedRunState): NestedRunState {
  return value === "queued" ||
    value === "running" ||
    value === "complete" ||
    value === "failed" ||
    value === "paused"
    ? value
    : fallback;
}

type ProjectAgentProjection = {
  capture?: ProjectAgentRunCapture;
  malformed: boolean;
};

/**
 * Preserve malformed project-agent fields as deny-only metadata. The capture
 * itself remains omitted unless it passes the normal persisted-boundary
 * validator, so this never grants authority to untrusted nested data.
 */
function projectAgentProjection(value: unknown): ProjectAgentProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { malformed: false };
  }
  const raw = value as Record<string, unknown>;
  const hasCapture = Object.hasOwn(raw, "projectAgent");
  const capture = hasCapture ? normalizeProjectAgentRunCapture(raw.projectAgent) : undefined;
  return {
    ...(capture ? { capture } : {}),
    malformed: Object.hasOwn(raw, "projectAgentMarker") || (hasCapture && !capture),
  };
}

function sanitizeStep(input: unknown, depth: number): NestedStepSummary | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const agent = stringValue(raw.agent, 128);
  if (!agent) return undefined;
  const status =
    raw.status === "pending" ||
    raw.status === "running" ||
    raw.status === "complete" ||
    raw.status === "completed" ||
    raw.status === "failed" ||
    raw.status === "paused"
      ? raw.status
      : "pending";
  const terminationReason = parseSubagentTerminationReason(raw.terminationReason);
  const projectAgent = projectAgentProjection(raw);
  return {
    agent,
    ...(projectAgent.capture ? { projectAgent: projectAgent.capture } : {}),
    ...(projectAgent.malformed ? { projectAgentMarker: true as const } : {}),
    status,
    ...(terminationReason
      ? { terminationReason: terminationReason as SubagentTerminationReason }
      : {}),
    ...(pathValue(raw.sessionFile, 2048) ? { sessionFile: pathValue(raw.sessionFile, 2048) } : {}),
    ...(raw.activityState === "active_long_running" || raw.activityState === "needs_attention"
      ? { activityState: raw.activityState }
      : {}),
    ...(clampNumber(raw.lastActivityAt) !== undefined
      ? { lastActivityAt: clampNumber(raw.lastActivityAt) }
      : {}),
    ...(stringValue(raw.currentTool, 128)
      ? { currentTool: stringValue(raw.currentTool, 128) }
      : {}),
    ...(clampNumber(raw.currentToolStartedAt) !== undefined
      ? { currentToolStartedAt: clampNumber(raw.currentToolStartedAt) }
      : {}),
    ...(displayStringValue(raw.currentPath, 2048)
      ? { currentPath: displayStringValue(raw.currentPath, 2048) }
      : {}),
    ...(clampNumber(raw.turnCount) !== undefined ? { turnCount: clampNumber(raw.turnCount) } : {}),
    ...(clampNumber(raw.toolCount) !== undefined ? { toolCount: clampNumber(raw.toolCount) } : {}),
    ...(clampNumber(raw.startedAt) !== undefined ? { startedAt: clampNumber(raw.startedAt) } : {}),
    ...(clampNumber(raw.endedAt) !== undefined ? { endedAt: clampNumber(raw.endedAt) } : {}),
    ...(stringValue(raw.error, 1024) ? { error: stringValue(raw.error, 1024) } : {}),
    ...(raw.timedOut === true ? { timedOut: true } : {}),
    ...(sanitizeTurnBudget(raw.turnBudget)
      ? { turnBudget: sanitizeTurnBudget(raw.turnBudget) }
      : {}),
    ...(raw.turnBudgetExceeded === true ? { turnBudgetExceeded: true } : {}),
    ...(raw.wrapUpRequested === true ? { wrapUpRequested: true } : {}),
    ...(parseContextUsageDiagnostics(raw.contextUsage)
      ? { contextUsage: parseContextUsageDiagnostics(raw.contextUsage) as ContextUsageDiagnostics }
      : {}),
    ...(parseContextPressureProjection(raw.contextPressure)
      ? {
          contextPressure: parseContextPressureProjection(
            raw.contextPressure,
          ) as ContextPressureProjection,
        }
      : {}),
    ...(parseContextPressureCrossedThresholds(raw.contextPressureCrossedThresholds)
      ? {
          contextPressureCrossedThresholds: parseContextPressureCrossedThresholds(
            raw.contextPressureCrossedThresholds,
          ) as ContextPressureThreshold[],
        }
      : {}),
    ...(depth < MAX_DEPTH && Array.isArray(raw.children)
      ? {
          children: raw.children
            .map((child) => sanitizeSummary(child, depth + 1))
            .filter((child): child is NestedRunSummary => Boolean(child))
            .slice(0, MAX_CHILDREN),
        }
      : {}),
  };
}

export function sanitizeSummary(input: unknown, depth = 0): NestedRunSummary | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (!isSafeNestedId(raw.id) || !isSafeNestedId(raw.parentRunId)) return undefined;
  const pathParts = sanitizeNestedPath(raw.path);
  const steps = Array.isArray(raw.steps)
    ? raw.steps
        .map((step) => sanitizeStep(step, depth + 1))
        .filter((step): step is NestedStepSummary => Boolean(step))
        .slice(0, MAX_STEPS)
    : undefined;
  const totalTokens = sanitizeTokenUsage(raw.totalTokens);
  const totalCost = sanitizeCost(raw.totalCost);
  const projectAgent = projectAgentProjection(raw);
  return {
    id: raw.id,
    parentRunId: raw.parentRunId,
    ...(clampNumber(raw.parentStepIndex) !== undefined
      ? { parentStepIndex: clampNumber(raw.parentStepIndex) }
      : {}),
    ...(stringValue(raw.parentAgent, 128)
      ? { parentAgent: stringValue(raw.parentAgent, 128) }
      : {}),
    depth: Math.min(Math.max(0, clampNumber(raw.depth) ?? 0), MAX_DEPTH),
    path: pathParts,
    state: sanitizeState(raw.state, "running"),
    ...(projectAgent.capture ? { projectAgent: projectAgent.capture } : {}),
    ...(projectAgent.malformed ? { projectAgentMarker: true as const } : {}),
    ...(pathValue(raw.cwd, 2048) ? { cwd: pathValue(raw.cwd, 2048) } : {}),
    ...(pathValue(raw.asyncDir, 2048) ? { asyncDir: pathValue(raw.asyncDir, 2048) } : {}),
    ...(clampNumber(raw.pid) !== undefined &&
    clampNumber(raw.pid)! > 0 &&
    Number.isInteger(clampNumber(raw.pid))
      ? { pid: clampNumber(raw.pid) }
      : {}),
    ...(stringValue(raw.sessionId, 256) ? { sessionId: stringValue(raw.sessionId, 256) } : {}),
    ...(pathValue(raw.sessionFile, 2048) ? { sessionFile: pathValue(raw.sessionFile, 2048) } : {}),
    ...(stringValue(raw.intercomTarget, 256)
      ? { intercomTarget: stringValue(raw.intercomTarget, 256) }
      : {}),
    ...(stringValue(raw.ownerIntercomTarget, 256)
      ? { ownerIntercomTarget: stringValue(raw.ownerIntercomTarget, 256) }
      : {}),
    ...(stringValue(raw.leafIntercomTarget, 256)
      ? { leafIntercomTarget: stringValue(raw.leafIntercomTarget, 256) }
      : {}),
    ...(raw.ownerState === "live" || raw.ownerState === "gone" || raw.ownerState === "unknown"
      ? { ownerState: raw.ownerState }
      : {}),
    ...(displayStringValue(raw.controlInbox, 2048)
      ? { controlInbox: displayStringValue(raw.controlInbox, 2048) }
      : {}),
    ...(stringValue(raw.capabilityToken, 128)
      ? { capabilityToken: stringValue(raw.capabilityToken, 128) }
      : {}),
    ...(raw.mode === "single" || raw.mode === "parallel" || raw.mode === "chain"
      ? { mode: raw.mode }
      : {}),
    ...(stringValue(raw.agent, 128) ? { agent: stringValue(raw.agent, 128) } : {}),
    ...(Array.isArray(raw.agents)
      ? {
          agents: raw.agents
            .map((agent) => stringValue(agent, 128))
            .filter((agent): agent is string => Boolean(agent))
            .slice(0, MAX_STEPS),
        }
      : {}),
    ...(clampNumber(raw.currentStep) !== undefined
      ? { currentStep: clampNumber(raw.currentStep) }
      : {}),
    ...(clampNumber(raw.chainStepCount) !== undefined
      ? { chainStepCount: clampNumber(raw.chainStepCount) }
      : {}),
    ...(raw.activityState === "active_long_running" || raw.activityState === "needs_attention"
      ? { activityState: raw.activityState }
      : {}),
    ...(clampNumber(raw.lastActivityAt) !== undefined
      ? { lastActivityAt: clampNumber(raw.lastActivityAt) }
      : {}),
    ...(stringValue(raw.currentTool, 128)
      ? { currentTool: stringValue(raw.currentTool, 128) }
      : {}),
    ...(clampNumber(raw.currentToolStartedAt) !== undefined
      ? { currentToolStartedAt: clampNumber(raw.currentToolStartedAt) }
      : {}),
    ...(displayStringValue(raw.currentPath, 2048)
      ? { currentPath: displayStringValue(raw.currentPath, 2048) }
      : {}),
    ...(clampNumber(raw.turnCount) !== undefined ? { turnCount: clampNumber(raw.turnCount) } : {}),
    ...(clampNumber(raw.toolCount) !== undefined ? { toolCount: clampNumber(raw.toolCount) } : {}),
    ...(totalTokens ? { totalTokens } : {}),
    ...(totalCost ? { totalCost } : {}),
    ...(clampNumber(raw.startedAt) !== undefined ? { startedAt: clampNumber(raw.startedAt) } : {}),
    ...(clampNumber(raw.endedAt) !== undefined ? { endedAt: clampNumber(raw.endedAt) } : {}),
    ...(clampNumber(raw.lastUpdate) !== undefined
      ? { lastUpdate: clampNumber(raw.lastUpdate) }
      : {}),
    ...(clampNumber(raw.timeoutMs) !== undefined ? { timeoutMs: clampNumber(raw.timeoutMs) } : {}),
    ...(clampNumber(raw.deadlineAt) !== undefined
      ? { deadlineAt: clampNumber(raw.deadlineAt) }
      : {}),
    ...(raw.timedOut === true ? { timedOut: true } : {}),
    ...(sanitizeTurnBudget(raw.turnBudget)
      ? { turnBudget: sanitizeTurnBudget(raw.turnBudget) }
      : {}),
    ...(raw.turnBudgetExceeded === true ? { turnBudgetExceeded: true } : {}),
    ...(raw.wrapUpRequested === true ? { wrapUpRequested: true } : {}),
    ...(stringValue(raw.error, 1024) ? { error: stringValue(raw.error, 1024) } : {}),
    ...(steps && steps.length > 0 ? { steps } : {}),
    ...(depth < MAX_DEPTH && Array.isArray(raw.children)
      ? {
          children: raw.children
            .map((child) => sanitizeSummary(child, depth + 1))
            .filter((child): child is NestedRunSummary => Boolean(child))
            .slice(0, MAX_CHILDREN),
        }
      : {}),
  };
}

function parseRecord(content: string, route: NestedRoute): NestedEventRecord | undefined {
  if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const raw = parsed as Record<string, unknown>;
  if (
    raw.type !== "subagent.nested.started" &&
    raw.type !== "subagent.nested.updated" &&
    raw.type !== "subagent.nested.completed"
  )
    return undefined;
  if (raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken)
    return undefined;
  if (!isSafeNestedId(raw.parentRunId)) return undefined;
  const ts = clampNumber(raw.ts);
  if (ts === undefined) return undefined;
  const child = sanitizeSummary(raw.child);
  if (!child || child.id === route.rootRunId) return undefined;
  const routedChild: NestedRunSummary = {
    ...child,
    controlInbox: route.controlInbox,
    capabilityToken: route.capabilityToken,
    ownerState: child.ownerState ?? "unknown",
  };
  return {
    type: raw.type,
    ts,
    rootRunId: route.rootRunId,
    parentRunId: raw.parentRunId,
    ...(clampNumber(raw.parentStepIndex) !== undefined
      ? { parentStepIndex: clampNumber(raw.parentStepIndex) }
      : {}),
    capabilityToken: route.capabilityToken,
    child: routedChild,
  };
}

export function parseNestedEventRecords(content: string, route: NestedRoute): NestedEventRecord[] {
  if (!content.includes("\n")) {
    const record = parseRecord(content.trim(), route);
    return record ? [record] : [];
  }
  return content
    .split("\n")
    .slice(0, content.endsWith("\n") ? undefined : -1)
    .map((line) => (line.trim() ? parseRecord(line, route) : undefined))
    .filter((event): event is NestedEventRecord => Boolean(event));
}

function terminal(state: NestedRunState): boolean {
  return state === "complete" || state === "failed" || state === "paused";
}

function nestedStateFromAsyncState(state: AsyncStatus["state"]): NestedRunState {
  switch (state) {
    case "queued":
      return "queued";
    case "running":
    case "pausing":
      return "running";
    case "complete":
    case "continued":
      return "complete";
    case "failed":
    case "cancelled":
      return "failed";
    case "paused":
      return "paused";
  }
}

function nestedStepStatusFromAsyncStepStatus(
  status: NonNullable<AsyncStatus["steps"]>[number]["status"],
): NestedStepSummary["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
    case "pausing":
      return "running";
    case "complete":
    case "continued":
      return "complete";
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
    case "paused":
      return "paused";
  }
}

function mergeSummary(
  existing: NestedRunSummary | undefined,
  event: NestedEventRecord,
): NestedRunSummary {
  const incomingState =
    event.type === "subagent.nested.completed" && event.child.state === "running"
      ? "complete"
      : event.child.state;
  const incoming = {
    ...event.child,
    state: incomingState,
    lastUpdate: event.child.lastUpdate ?? event.ts,
  };
  if (!existing) return incoming;
  const existingUpdate = existing.lastUpdate ?? 0;
  const incomingUpdate = incoming.lastUpdate ?? event.ts;
  if (incomingUpdate < existingUpdate) return existing;
  if (terminal(existing.state) && !terminal(incoming.state)) return existing;
  if (terminal(existing.state) && terminal(incoming.state) && incomingUpdate === existingUpdate)
    return existing;
  return {
    ...existing,
    ...incoming,
    state: incoming.state,
    lastUpdate: Math.max(existingUpdate, incomingUpdate),
  };
}

function attachChild(children: NestedRunSummary[], event: NestedEventRecord): NestedRunSummary[] {
  let updated = false;
  const walk = (items: NestedRunSummary[]): NestedRunSummary[] =>
    items.map((item) => {
      if (item.id === event.parentRunId) {
        const existingChildren = item.children ?? [];
        const childIndex = existingChildren.findIndex((child) => child.id === event.child.id);
        const nextChild = mergeSummary(
          childIndex >= 0 ? existingChildren[childIndex] : undefined,
          event,
        );
        const nextChildren =
          childIndex >= 0
            ? existingChildren.map((child, index) => (index === childIndex ? nextChild : child))
            : [...existingChildren, nextChild];
        updated = true;
        return {
          ...item,
          children: nextChildren.slice(0, MAX_CHILDREN),
          lastUpdate: Math.max(item.lastUpdate ?? 0, event.ts),
        };
      }
      if (!item.children?.length) return item;
      const nextChildren = walk(item.children);
      return nextChildren === item.children ? item : { ...item, children: nextChildren };
    });
  const next = walk(children);
  if (updated) return next;
  const childIndex = next.findIndex((child) => child.id === event.child.id);
  const nextChild = mergeSummary(childIndex >= 0 ? next[childIndex] : undefined, event);
  return childIndex >= 0
    ? next.map((child, index) => (index === childIndex ? nextChild : child))
    : [...next, nextChild].slice(0, MAX_CHILDREN);
}

function applyNestedEvent(registry: NestedRegistry, event: NestedEventRecord): NestedRegistry {
  return {
    ...registry,
    updatedAt: Math.max(registry.updatedAt, event.ts),
    children: attachChild(registry.children, event),
  };
}

function registryPath(route: NestedRoute): string {
  return path.join(commonRouteRoot(route), REGISTRY_FILE);
}

export function findNestedRouteForRootId(rootRunId: string): NestedRoute | undefined {
  assertSafeId("rootRunId", rootRunId);
  let entries: string[];
  try {
    entries = fs.readdirSync(NESTED_EVENTS_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${rootRunId}-`)) continue;
    const routeRoot = path.join(NESTED_EVENTS_DIR, entry);
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, ROUTE_FILE), "utf-8")) as {
        rootRunId?: unknown;
        capabilityToken?: unknown;
      };
      if (metadata.rootRunId !== rootRunId || typeof metadata.capabilityToken !== "string")
        continue;
      const route = {
        rootRunId,
        eventSink: path.join(routeRoot, "events"),
        controlInbox: path.join(routeRoot, "controls"),
        capabilityToken: metadata.capabilityToken,
      };
      validateNestedRoute(route);
      return route;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Scan the nested-events directory once and index every route by its root run
 * id. Use this when resolving routes for many runs (e.g. listAsyncRuns) so the
 * cost is O(routes) total instead of O(runs * routes) from calling
 * findNestedRouteForRootId per run.
 */
export function buildNestedRouteIndex(): Map<string, NestedRoute> {
  let entries: string[];
  try {
    entries = fs.readdirSync(NESTED_EVENTS_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const index = new Map<string, NestedRoute>();
  for (const entry of entries) {
    const routeRoot = path.join(NESTED_EVENTS_DIR, entry);
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, ROUTE_FILE), "utf-8")) as {
        rootRunId?: unknown;
        capabilityToken?: unknown;
      };
      if (typeof metadata.rootRunId !== "string" || typeof metadata.capabilityToken !== "string")
        continue;
      if (index.has(metadata.rootRunId)) continue;
      const route: NestedRoute = {
        rootRunId: metadata.rootRunId,
        eventSink: path.join(routeRoot, "events"),
        controlInbox: path.join(routeRoot, "controls"),
        capabilityToken: metadata.capabilityToken,
      };
      validateNestedRoute(route);
      index.set(metadata.rootRunId, route);
    } catch {
      continue;
    }
  }
  return index;
}

export function projectNestedRegistryForRoot(rootRunId: string): NestedRegistry | undefined {
  const route = findNestedRouteForRootId(rootRunId);
  return route ? projectNestedEvents(route) : undefined;
}

export interface NestedRunMatch {
  rootRunId: string;
  route: NestedRoute;
  run: NestedRunSummary;
}

export interface NestedRunResolutionScope {
  routes: NestedRoute[];
  descendantOf?: { parentRunId: string; parentStepIndex?: number };
}

function collectNestedRuns(
  children: NestedRunSummary[] | undefined,
  output: NestedRunSummary[] = [],
): NestedRunSummary[] {
  for (const child of children ?? []) {
    output.push(child);
    collectNestedRuns(child.children, output);
    collectNestedRuns(
      child.steps?.flatMap((step) => step.children ?? []),
      output,
    );
  }
  return output;
}

function collectScopedNestedRuns(
  children: NestedRunSummary[] | undefined,
  scope: NestedRunResolutionScope["descendantOf"],
  output: NestedRunSummary[] = [],
): NestedRunSummary[] {
  if (!scope) return collectNestedRuns(children, output);
  for (const child of children ?? []) {
    if (
      child.parentRunId === scope.parentRunId &&
      (scope.parentStepIndex === undefined || child.parentStepIndex === scope.parentStepIndex)
    ) {
      collectNestedRuns([child], output);
      continue;
    }
    collectScopedNestedRuns(child.children, scope, output);
    collectScopedNestedRuns(
      child.steps?.flatMap((step) => step.children ?? []),
      scope,
      output,
    );
  }
  return output;
}

function listNestedRoutes(): NestedRoute[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(NESTED_EVENTS_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const routes: NestedRoute[] = [];
  for (const entry of entries) {
    const routeRoot = path.join(NESTED_EVENTS_DIR, entry);
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, ROUTE_FILE), "utf-8")) as {
        rootRunId?: unknown;
        capabilityToken?: unknown;
      };
      if (typeof metadata.rootRunId !== "string" || typeof metadata.capabilityToken !== "string")
        continue;
      const route = {
        rootRunId: metadata.rootRunId,
        eventSink: path.join(routeRoot, "events"),
        controlInbox: path.join(routeRoot, "controls"),
        capabilityToken: metadata.capabilityToken,
      };
      validateNestedRoute(route);
      routes.push(route);
    } catch {
      continue;
    }
  }
  return routes;
}

export function findNestedRunMatchesById(
  id: string,
  options: { prefix?: boolean; scope?: NestedRunResolutionScope } = {},
): NestedRunMatch[] {
  assertSafeId("id", id);
  const matches: NestedRunMatch[] = [];
  for (const route of options.scope?.routes ?? listNestedRoutes()) {
    try {
      const registry = projectNestedEvents(route);
      for (const run of collectScopedNestedRuns(registry.children, options.scope?.descendantOf)) {
        if (options.prefix ? run.id.startsWith(id) : run.id === id)
          matches.push({ rootRunId: route.rootRunId, route, run });
      }
    } catch {
      continue;
    }
  }
  return matches;
}

function readNestedRegistry(route: NestedRoute): NestedRegistry {
  validateNestedRoute(route);
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(route), "utf-8")) as NestedRegistry;
    return {
      rootRunId: route.rootRunId,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      children: Array.isArray(parsed.children)
        ? parsed.children
            .map((child) => sanitizeSummary(child))
            .filter((child): child is NestedRunSummary => Boolean(child))
        : [],
      processedEvents: Array.isArray(parsed.processedEvents)
        ? parsed.processedEvents.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { rootRunId: route.rootRunId, updatedAt: 0, children: [], processedEvents: [] };
  }
}

export function projectNestedEvents(route: NestedRoute): NestedRegistry {
  validateNestedRoute(route);
  let registry = readNestedRegistry(route);
  const seen = new Set(registry.processedEvents);
  let changed = false;
  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(route.eventSink)
      .filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    if (seen.has(entry)) continue;
    const eventPath = path.join(route.eventSink, entry);
    if (!containedPath(route.eventSink, eventPath)) continue;
    let content: string;
    try {
      const stat = fs.statSync(eventPath);
      if (!stat.isFile() || stat.size > MAX_EVENT_BYTES) continue;
      content = fs.readFileSync(eventPath, "utf-8");
    } catch {
      continue;
    }
    for (const event of parseNestedEventRecords(content, route)) {
      registry = applyNestedEvent(registry, event);
    }
    seen.add(entry);
    changed = true;
  }
  if (changed) {
    registry = { ...registry, processedEvents: [...seen].slice(-1000) };
    // Parent projection is the only writer to this sidecar registry. Child and
    // runner processes only create immutable event files, so parent status.json
    // remains owned by the existing runner writer and is never rewritten here.
    writeAtomicJson(registryPath(route), registry);
  }
  return registry;
}

function writeRouteRecord(dir: string, ts: number, payload: NestedEventRecord): string {
  const content = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES)
    throw new Error("Nested route record exceeds the maximum size.");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${String(ts).padStart(13, "0")}-${randomUUID()}.json`;
  const tmp = path.join(dir, `.${name}.tmp`);
  const finalPath = path.join(dir, name);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, finalPath);
  return finalPath;
}

export function writeNestedEvent(
  route: NestedRoute,
  event: Omit<NestedEventRecord, "rootRunId" | "capabilityToken">,
): void {
  validateNestedRoute(route);
  const record: NestedEventRecord = {
    ...event,
    rootRunId: route.rootRunId,
    capabilityToken: route.capabilityToken,
  };
  const sanitized = parseRecord(JSON.stringify(record), route);
  if (!sanitized) throw new Error("Nested event record failed validation.");
  writeRouteRecord(route.eventSink, sanitized.ts, sanitized);
}

export function attachRootChildrenToSteps<
  T extends { children?: NestedRunSummary[]; index?: number },
>(rootRunId: string, steps: T[] | undefined, children: NestedRunSummary[] | undefined): void {
  if (!steps?.length) return;
  for (const step of steps) {
    step.children = undefined;
  }
  if (!children?.length) return;
  for (const child of children) {
    if (child.parentRunId !== rootRunId || child.parentStepIndex === undefined) continue;
    const step = steps.find(
      (candidate, index) => (candidate.index ?? index) === child.parentStepIndex,
    );
    if (!step) continue;
    step.children ??= [];
    step.children = [...step.children.filter((existing) => existing.id !== child.id), child].slice(
      0,
      MAX_CHILDREN,
    );
  }
}

export function updateAsyncJobNestedProjection(job: AsyncJobState): void {
  if (!job.nestedRoute) return;
  const registry = projectNestedEvents(job.nestedRoute);
  job.nestedChildren = registry.children;
  attachRootChildrenToSteps(job.asyncId, job.steps, registry.children);
}

export function updateForegroundNestedProjection(
  control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
): void {
  if (!control.nestedRoute) return;
  const registry = projectNestedEvents(control.nestedRoute);
  control.nestedChildren = registry.children;
}

export function hasLiveNestedDescendants(children: NestedRunSummary[] | undefined): boolean {
  if (!children?.length) return false;
  for (const child of children) {
    if (!terminal(child.state)) return true;
    if (hasLiveNestedDescendants(child.children)) return true;
    if (hasLiveNestedDescendants(child.steps?.flatMap((step) => step.children ?? []))) return true;
  }
  return false;
}

function projectAgentProjectionFromAsyncStatus(status: AsyncStatus): ProjectAgentProjection {
  const statusProjection = projectAgentProjection(status);
  let capture = statusProjection.capture;
  let malformed = statusProjection.malformed;
  const projectAgents = status.projectAgents;
  if (projectAgents !== undefined) {
    if (!Array.isArray(projectAgents) || projectAgents.length === 0) {
      malformed = true;
    } else {
      for (const candidate of projectAgents) {
        const normalized = normalizeProjectAgentRunCapture(candidate);
        if (normalized) capture ??= normalized;
        else malformed = true;
      }
    }
  }
  for (const step of status.steps ?? []) {
    const stepProjection = projectAgentProjection(step);
    capture ??= stepProjection.capture;
    malformed ||= stepProjection.malformed;
  }
  return {
    ...(capture ? { capture } : {}),
    malformed,
  };
}

export function nestedSummaryFromAsyncStatus(
  status: AsyncStatus,
  asyncDir: string,
  fallback: {
    id: string;
    parentRunId: string;
    parentStepIndex?: number;
    depth: number;
    path?: Array<{ runId: string; stepIndex?: number; agent?: string }>;
    mode?: SubagentRunMode;
    ts: number;
  },
): NestedRunSummary {
  const projectAgent = projectAgentProjectionFromAsyncStatus(status);
  return {
    id: status.runId || fallback.id,
    parentRunId: fallback.parentRunId,
    ...(fallback.parentStepIndex !== undefined
      ? { parentStepIndex: fallback.parentStepIndex }
      : {}),
    depth: fallback.depth,
    path: fallback.path ?? [
      {
        runId: fallback.parentRunId,
        ...(fallback.parentStepIndex !== undefined ? { stepIndex: fallback.parentStepIndex } : {}),
      },
    ],
    ...(status.cwd ? { cwd: status.cwd } : {}),
    asyncDir,
    ...(status.pid ? { pid: status.pid } : {}),
    ...(status.sessionId ? { sessionId: status.sessionId } : {}),
    mode: status.mode ?? fallback.mode,
    state: nestedStateFromAsyncState(status.state),
    ...(status.currentStep !== undefined ? { currentStep: status.currentStep } : {}),
    ...(status.chainStepCount !== undefined ? { chainStepCount: status.chainStepCount } : {}),
    ...(status.activityState ? { activityState: status.activityState } : {}),
    ...(status.lastActivityAt !== undefined ? { lastActivityAt: status.lastActivityAt } : {}),
    ...(status.currentTool ? { currentTool: status.currentTool } : {}),
    ...(status.currentToolStartedAt !== undefined
      ? { currentToolStartedAt: status.currentToolStartedAt }
      : {}),
    ...(status.currentPath ? { currentPath: status.currentPath } : {}),
    ...(status.turnCount !== undefined ? { turnCount: status.turnCount } : {}),
    ...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
    ...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
    ...(status.timeoutMs !== undefined ? { timeoutMs: status.timeoutMs } : {}),
    ...(status.deadlineAt !== undefined ? { deadlineAt: status.deadlineAt } : {}),
    ...(status.timedOut !== undefined ? { timedOut: status.timedOut } : {}),
    ...(status.turnBudget ? { turnBudget: status.turnBudget } : {}),
    ...(status.turnBudgetExceeded !== undefined
      ? { turnBudgetExceeded: status.turnBudgetExceeded }
      : {}),
    ...(status.wrapUpRequested !== undefined ? { wrapUpRequested: status.wrapUpRequested } : {}),
    ...(status.error ? { error: status.error } : {}),
    ...(status.startedAt !== undefined
      ? { startedAt: status.startedAt }
      : { startedAt: fallback.ts }),
    ...(status.endedAt !== undefined ? { endedAt: status.endedAt } : {}),
    lastUpdate: status.lastUpdate ?? fallback.ts,
    ...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
    ...(projectAgent.capture ? { projectAgent: projectAgent.capture } : {}),
    ...(projectAgent.malformed ? { projectAgentMarker: true as const } : {}),
    ...(status.steps?.length
      ? {
          steps: status.steps
            .map((step) => {
              const stepProjectAgent = projectAgentProjection(step);
              return {
                agent: step.agent,
                ...(stepProjectAgent.capture ? { projectAgent: stepProjectAgent.capture } : {}),
                ...(stepProjectAgent.malformed ? { projectAgentMarker: true as const } : {}),
                status: nestedStepStatusFromAsyncStepStatus(step.status),
                ...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
                ...(step.activityState ? { activityState: step.activityState } : {}),
                ...(step.lastActivityAt !== undefined
                  ? { lastActivityAt: step.lastActivityAt }
                  : {}),
                ...(step.currentTool ? { currentTool: step.currentTool } : {}),
                ...(step.currentToolStartedAt !== undefined
                  ? { currentToolStartedAt: step.currentToolStartedAt }
                  : {}),
                ...(step.currentPath ? { currentPath: step.currentPath } : {}),
                ...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
                ...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
                ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
                ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
                ...(step.error ? { error: step.error } : {}),
                ...(step.timedOut !== undefined ? { timedOut: step.timedOut } : {}),
                ...(step.terminationReason ? { terminationReason: step.terminationReason } : {}),
                ...(step.turnBudget ? { turnBudget: step.turnBudget } : {}),
                ...(step.turnBudgetExceeded !== undefined
                  ? { turnBudgetExceeded: step.turnBudgetExceeded }
                  : {}),
                ...(step.wrapUpRequested !== undefined
                  ? { wrapUpRequested: step.wrapUpRequested }
                  : {}),
                ...(step.contextUsage ? { contextUsage: step.contextUsage } : {}),
                ...(step.contextPressure ? { contextPressure: step.contextPressure } : {}),
                ...(step.contextPressureCrossedThresholds
                  ? { contextPressureCrossedThresholds: [...step.contextPressureCrossedThresholds] }
                  : {}),
              };
            })
            .slice(0, MAX_STEPS),
        }
      : {}),
  };
}

export function nestedResultsPath(rootRunId: string, id: string): string {
  assertSafeId("rootRunId", rootRunId);
  assertSafeId("id", id);
  return path.join(RESULTS_DIR, "nested", rootRunId, `${id}.json`);
}
