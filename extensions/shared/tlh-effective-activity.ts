/**
 * Shared constants and types for the TLH effective-activity bus event.
 *
 * Published by: extensions/the-last-harness/activity-tracker.ts
 * Consumed by:  extensions/notify/index.ts
 *
 * Keep this module minimal — it is a boundary contract, not an implementation.
 */

/** Event name emitted on pi.events when the effective-activity snapshot changes. */
export const TLH_EFFECTIVE_ACTIVITY_EVENT = "tlh:effective-activity";

/** Payload carried by TLH_EFFECTIVE_ACTIVITY_EVENT. */
export type TlhEffectiveActivityPayload = {
	/** True when primary agent work or background async subagents are in flight. */
	inProgress: boolean;
	/** Sorted IDs of async subagent jobs currently tracked as active. */
	activeAsyncJobIds: string[];
};
