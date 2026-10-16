export const SUBAGENT_ASYNC_RESTORED_EVENT = "subagent:async-restored";
const RESTORE_PROVIDER_STATE_KEY = "__tlhBundledSubagentRestoreProvider";
function restoreProviderState() {
    const value = globalThis[RESTORE_PROVIDER_STATE_KEY];
    if (typeof value !== "object" || value === null)
        return undefined;
    const state = value;
    return typeof state.generation === "number" && typeof state.active === "boolean"
        ? { generation: state.generation, active: state.active }
        : undefined;
}
export function resetBundledSubagentRestoreProvider() {
    const previous = restoreProviderState();
    globalThis[RESTORE_PROVIDER_STATE_KEY] = {
        generation: (previous?.generation ?? 0) + 1,
        active: false,
    };
}
export function announceBundledSubagentRestoreProvider() {
    const previous = restoreProviderState();
    globalThis[RESTORE_PROVIDER_STATE_KEY] = {
        generation: previous?.generation ?? 1,
        active: true,
    };
}
export function isBundledSubagentRestoreProviderActive() {
    return restoreProviderState()?.active === true;
}
