/** Process-local ownership markers used to suppress watcher notifications for awaited runs. */
export type AwaitedRunRegistrationToken = symbol;
type AwaitedRunCompletionHandler = (data: unknown) => boolean;
type AwaitedRunCompletionGuard = (data: unknown) => boolean;
type AwaitedRunDisposer = () => void;
type AwaitedRunSupersededHandler = () => void;

interface AwaitedRunRegistration {
  token: AwaitedRunRegistrationToken;
  generation?: number;
  onCompletion?: AwaitedRunCompletionHandler;
  onCompletionGuard?: AwaitedRunCompletionGuard;
  onDispose?: AwaitedRunDisposer;
  onSuperseded?: AwaitedRunSupersededHandler;
}

const awaitedRuns = new Map<string, AwaitedRunRegistration>();

/**
 * Register an awaited run. Every registration receives a unique token so a
 * superseded owner cannot consume or unregister a replacement registration.
 * `generation` is retained for exact-generation dispatch and conditional
 * cleanup; completion dispatch applies that exact generation unless a live
 * owner supplies a dynamic completion guard.
 *
 * The optional disposer is process-local lifecycle wiring. It is deliberately
 * not part of the completion handler so extension/session teardown can request
 * cleanup without making a detached notification look consumed. A superseded
 * callback retires the previous owner after the replacement is installed.
 */
export function registerAwaitedRun(
  runId: string,
  onCompletion?: AwaitedRunCompletionHandler,
  generation?: number,
  onDispose?: AwaitedRunDisposer,
  onCompletionGuard?: AwaitedRunCompletionGuard,
  onSuperseded?: AwaitedRunSupersededHandler,
): AwaitedRunRegistrationToken {
  const previous = awaitedRuns.get(runId);
  const token = Symbol("awaited-run-registration");
  awaitedRuns.set(runId, {
    token,
    ...(generation !== undefined ? { generation } : {}),
    ...(onCompletion ? { onCompletion } : {}),
    ...(onCompletionGuard ? { onCompletionGuard } : {}),
    ...(onDispose ? { onDispose } : {}),
    ...(onSuperseded ? { onSuperseded } : {}),
  });
  if (previous?.onSuperseded) {
    try {
      previous.onSuperseded();
    } catch (error) {
      console.error(`[pi-subagents] awaited run owner supersession failed for '${runId}':`, error);
    }
  }
  return token;
}

/** Return whether this token still owns the live registration for `runId`. */
export function isAwaitedRunOwner(runId: string, token: AwaitedRunRegistrationToken): boolean {
  return awaitedRuns.get(runId)?.token === token;
}

/** Existence-only lookup used by status projections. */
export function isAwaitedRun(runId: string): boolean {
  return awaitedRuns.has(runId);
}

/**
 * Dispose all live awaited owners. Late-artifact sinks intentionally have no
 * disposer and are left to their bounded retention timers.
 */
export function disposeAwaitedRuns(): void {
  const registrations: AwaitedRunRegistration[] = [];
  awaitedRuns.forEach((registration) => registrations.push(registration));
  for (const registration of registrations) {
    if (!registration.onDispose) continue;
    try {
      registration.onDispose();
    } catch (error) {
      console.error("[pi-subagents] awaited run owner disposal failed:", error);
    }
  }
}

function explicitGeneration(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const direct = record.generation;
  if (typeof direct === "number" && Number.isSafeInteger(direct) && direct >= 0) return direct;
  const lifecycle = record.lifecycle;
  if (typeof lifecycle !== "object" || lifecycle === null || Array.isArray(lifecycle))
    return undefined;
  const nested = (lifecycle as Record<string, unknown>).generation;
  return typeof nested === "number" && Number.isSafeInteger(nested) && nested >= 0
    ? nested
    : undefined;
}

/**
 * Give a watcher-owned artifact to its in-process awaited owner. Completion
 * artifacts must carry an explicit valid generation. Returning false means the
 * owner rejected it or no live owner exists, so the watcher should use the
 * detached completion event path instead.
 */
export function dispatchAwaitedRunCompletion(runId: string, data: unknown): boolean {
  const registration = awaitedRuns.get(runId);
  const handler = registration?.onCompletion;
  if (!handler) return false;
  try {
    const generation = explicitGeneration(data);
    if (generation === undefined) return false;
    const accepted = registration.onCompletionGuard
      ? registration.onCompletionGuard(data)
      : registration.generation !== undefined && generation === registration.generation;
    if (!accepted) return false;
    return handler(data) === true;
  } catch (error) {
    console.error(`[pi-subagents] awaited completion handler failed for '${runId}':`, error);
    return false;
  }
}

/**
 * Remove a registration only if it still belongs to the expected generation
 * and token. This prevents a settled or superseded owner from unregistering a
 * replacement owner that reused the same run id and generation.
 */
export function unregisterAwaitedRun(
  runId: string,
  generation?: number,
  token?: AwaitedRunRegistrationToken,
): void {
  const registration = awaitedRuns.get(runId);
  if (!registration) return;
  if (generation !== undefined && registration.generation !== generation) return;
  if (token !== undefined && registration.token !== token) return;
  awaitedRuns.delete(runId);
}
