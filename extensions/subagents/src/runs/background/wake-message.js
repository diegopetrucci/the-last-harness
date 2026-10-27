// Generated from extensions/subagents/src/runs/background/wake-message.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
export function wakeFor(options) {
    return (options.triggerTurn ?? true) && (options.isIdle?.() ?? true);
}
export function sendWakeAwareMessage(pi, message, wake) {
    pi.sendMessage(message, wake ? { triggerTurn: true } : undefined);
}
