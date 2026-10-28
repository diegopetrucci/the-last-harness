import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CustomMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

/**
 * Sends a custom message that wakes an idle parent and steers a streaming one.
 * Idleness is read live at send time; when unknown, assume idle. { triggerTurn: true }
 * is safe either way: Pi starts a run from the custom message when idle
 * (before_agent_start fires, so the TLH system prompt applies) and steers the active
 * turn when streaming. Never pass triggerTurn:false: while streaming it defers
 * delivery instead of steering. Returns whether the send was a wake, so callers can
 * persist it (details.triggersTurn).
 */
export function wakeFor(options: { triggerTurn?: boolean; isIdle?: () => boolean }): boolean {
  return (options.triggerTurn ?? true) && (options.isIdle?.() ?? true);
}

export function sendWakeAwareMessage(
  pi: Pick<ExtensionAPI, "sendMessage">,
  message: CustomMessage,
  wake: boolean,
): void {
  pi.sendMessage(message, wake ? { triggerTurn: true } : undefined);
}
