export function isProtectedPausedLifecycle(input) {
    if (!input)
        return false;
    if (input.state === "pausing")
        return true;
    return input.state !== "running" && input.pause?.kind === "awaiting_supervisor";
}
export function protectedLifecycleText(label) {
    switch (label) {
        case "error": return "Lifecycle status requires attention.";
        case "nested_warning": return "Nested status unavailable during the paused lifecycle.";
        case "diagnosis":
        default: return "Lifecycle state was refreshed for this paused run.";
    }
}
export function formatProtectedLifecycleCleanup(cleanup) {
    if (cleanup.terminated)
        return "confirmed.";
    if (cleanup.attempted || cleanup.escalatedToSigkill || cleanup.liveProcessesDetected !== undefined)
        return "unconfirmed.";
    return "pending confirmation.";
}
