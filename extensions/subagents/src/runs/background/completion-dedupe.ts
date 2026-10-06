interface CompletionDataLike {
  id?: unknown;
  agent?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  taskIndex?: unknown;
  totalTasks?: unknown;
  success?: unknown;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  return Number.isFinite(value) ? value : undefined;
}

export function buildCompletionKey(data: CompletionDataLike, fallback: string): string {
  const id = asNonEmptyString(data.id);
  if (id) return `id:${id}`;
  const sessionId = asNonEmptyString(data.sessionId) ?? "no-session";
  const agent = asNonEmptyString(data.agent) ?? "unknown";
  const timestamp = asFiniteNumber(data.timestamp);
  const taskIndex = asFiniteNumber(data.taskIndex);
  const totalTasks = asFiniteNumber(data.totalTasks);
  const success = typeof data.success === "boolean" ? (data.success ? "1" : "0") : "?";
  return [
    "meta",
    sessionId,
    agent,
    timestamp !== undefined ? String(timestamp) : "no-ts",
    taskIndex !== undefined ? String(taskIndex) : "-",
    totalTasks !== undefined ? String(totalTasks) : "-",
    success,
    fallback,
  ].join(":");
}

function pruneSeenMap(seen: Map<string, number>, now: number, ttlMs: number): void {
  for (const [key, ts] of seen.entries()) {
    if (now - ts > ttlMs) seen.delete(key);
  }
}

export function markSeenWithTtl(
  seen: Map<string, number>,
  key: string,
  now: number,
  ttlMs: number,
): boolean {
  pruneSeenMap(seen, now, ttlMs);
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

/**
 * Check if a key is already seen (pruning expired entries) WITHOUT marking it.
 * Use this when you want to test for prior delivery before committing to
 * marking, e.g. when the mark should only happen after the delivery itself succeeds.
 */
export function isSeenWithTtl(
  seen: Map<string, number>,
  key: string,
  now: number,
  ttlMs: number,
): boolean {
  pruneSeenMap(seen, now, ttlMs);
  return seen.has(key);
}

/**
 * Record a key as seen at the given timestamp without a duplicate check.
 * Must be paired with a prior `isSeenWithTtl` check.
 */
export function markSeen(seen: Map<string, number>, key: string, now: number): void {
  seen.set(key, now);
}

// ─── Delivery acknowledgement metadata ───────────────────────────────────────

/**
 * Symbol key used to attach delivery-ack metadata to SUBAGENT_ASYNC_COMPLETE_EVENT
 * payloads.  Symbol-keyed so the value is never serialised into message details,
 * session entries, or telemetry — even if the payload is spread into a plain
 * object.
 */
export const COMPLETION_DELIVERY: unique symbol = Symbol("completion-delivery");

/**
 * Metadata attached to each watcher-sourced SUBAGENT_ASYNC_COMPLETE_EVENT.
 * Consumers must use `getCompletionDelivery()` to read it.
 */
export type CompletionDeliveryMetadata = {
  /** Durable identity for the result file (from data.eventId or sha256 digest). */
  readonly eventId: string;
  /**
   * Call once after the completion is successfully persisted (sendMessage returned).
   * Idempotent — repeated calls are ignored.
   */
  readonly acknowledgeDelivery: () => void;
  /**
   * Register a callback that fires synchronously inside `acknowledgeDelivery`.
   * Used by the async-job-tracker to defer project-reference management to
   * after confirmed delivery.
   */
  readonly onAcknowledged: (cb: () => void) => void;
};

/**
 * Typed accessor for COMPLETION_DELIVERY metadata on an event payload.
 * Returns undefined when the event was not emitted by the result-watcher
 * (e.g. direct test injections or legacy emissions without metadata).
 */
export function getCompletionDelivery(data: unknown): CompletionDeliveryMetadata | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const meta = (data as Record<symbol, unknown>)[COMPLETION_DELIVERY];
  if (meta === null || typeof meta !== "object") return undefined;
  const m = meta as Record<string, unknown>;
  if (
    typeof m["eventId"] === "string" &&
    typeof m["acknowledgeDelivery"] === "function" &&
    typeof m["onAcknowledged"] === "function"
  ) {
    return meta as CompletionDeliveryMetadata;
  }
  return undefined;
}

export function getGlobalSeenMap(storeKey: string): Map<string, number> {
  const globalStore = globalThis as Record<string, unknown>;
  const existing = globalStore[storeKey];
  if (existing instanceof Map) return existing as Map<string, number>;
  const map = new Map<string, number>();
  globalStore[storeKey] = map;
  return map;
}
