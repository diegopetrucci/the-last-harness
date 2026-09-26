export const SUBAGENT_ASYNC_RESTORED_EVENT = "subagent:async-restored";

const RESTORE_PROVIDER_STATE_KEY = "__tlhBundledSubagentRestoreProvider";

type RestoreProviderState = {
  generation: number;
  active: boolean;
};

export type SubagentAsyncRestoredJob = {
  runId: string;
  asyncDir: string;
  sessionId: string;
  pid?: number;
};

export type SubagentAsyncRestoredEvent = {
  sessionId: string;
  jobs: readonly SubagentAsyncRestoredJob[];
};

function restoreProviderState(): RestoreProviderState | undefined {
  const value = (globalThis as Record<string, unknown>)[RESTORE_PROVIDER_STATE_KEY];
  if (typeof value !== "object" || value === null) return undefined;
  const state = value as Partial<RestoreProviderState>;
  return typeof state.generation === "number" && typeof state.active === "boolean"
    ? { generation: state.generation, active: state.active }
    : undefined;
}

/**
 * Start a fresh extension-registration generation. TLH loads before subagents,
 * so this reset makes a later disabled/external registration fall back safely.
 */
export function resetBundledSubagentRestoreProvider(): void {
  const previous = restoreProviderState();
  (globalThis as Record<string, unknown>)[RESTORE_PROVIDER_STATE_KEY] = {
    generation: (previous?.generation ?? 0) + 1,
    active: false,
  } satisfies RestoreProviderState;
}

/** Mark the bundled subagents restore producer as synchronously available. */
export function announceBundledSubagentRestoreProvider(): void {
  const previous = restoreProviderState();
  (globalThis as Record<string, unknown>)[RESTORE_PROVIDER_STATE_KEY] = {
    generation: previous?.generation ?? 1,
    active: true,
  } satisfies RestoreProviderState;
}

export function isBundledSubagentRestoreProviderActive(): boolean {
  return restoreProviderState()?.active === true;
}
