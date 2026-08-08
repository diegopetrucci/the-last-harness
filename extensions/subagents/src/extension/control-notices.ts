import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { controlNotificationKey, formatControlNoticeMessage } from "../runs/shared/subagent-control.ts";
import type { ControlEvent, SubagentState } from "../shared/types.ts";

export const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";

const NUDGE_TEXT = "[tlh] Subagent run needs attention — see notice above.";

export interface SubagentControlMessageDetails {
	event: ControlEvent;
	source?: "foreground" | "async";
	asyncDir?: string;
	childIntercomTarget?: string;
	noticeText?: string;
}

export function controlNoticeTarget(details: SubagentControlMessageDetails): string | undefined {
	return details.childIntercomTarget;
}

export function formatSubagentControlNotice(details: SubagentControlMessageDetails, content?: string): string {
	return details.noticeText ?? content ?? formatControlNoticeMessage(details.event, controlNoticeTarget(details));
}

function noticeTimerKey(details: SubagentControlMessageDetails): string {
	const childIntercomTarget = controlNoticeTarget(details);
	return `${details.event.runId}:${controlNotificationKey(details.event, childIntercomTarget)}`;
}

export function clearPendingForegroundControlNotices(state: SubagentState, runId?: string): void {
	const pending = state.pendingForegroundControlNotices;
	if (!pending) return;
	for (const [key, timer] of pending) {
		if (runId !== undefined && !key.startsWith(`${runId}:`)) continue;
		clearTimeout(timer);
		pending.delete(key);
	}
}

function deliverControlNotice(input: {
	pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">;
	visibleControlNotices: Set<string>;
	details: SubagentControlMessageDetails;
	isIdle?: () => boolean;
}): void {
	if (input.details.event.reason === "completion_guard") return;
	const childIntercomTarget = controlNoticeTarget(input.details);
	const key = controlNotificationKey(input.details.event, childIntercomTarget);
	if (input.visibleControlNotices.has(key)) return;
	input.visibleControlNotices.add(key);
	const noticeText = input.details.noticeText ?? formatControlNoticeMessage(input.details.event, childIntercomTarget);
	input.pi.sendMessage({
		customType: SUBAGENT_CONTROL_MESSAGE_TYPE,
		content: noticeText,
		display: true,
		details: { ...input.details, childIntercomTarget, noticeText },
	});
	// When the session is idle and this is an async notice, wake the agent
	// through prompt() so before_agent_start fires and the TLH system prompt
	// is restored. deliverAs:'followUp' is safe under a streaming race: it
	// queues a benign followUp rather than throwing. When streaming, Pi steers
	// the turn via the custom message alone; no nudge is needed. Idleness is
	// read live at send time; when no session context has been captured yet,
	// assume idle (the nudge degrades to a benign followUp if that assumption
	// is wrong).
	if (input.details.source !== "foreground" && (input.isIdle?.() ?? true)) {
		input.pi.sendUserMessage(NUDGE_TEXT, { deliverAs: "followUp" });
	}
}

function isForegroundNoticeStillActionable(state: SubagentState, details: SubagentControlMessageDetails): boolean {
	const control = state.foregroundControls.get(details.event.runId);
	if (!control) return false;
	if (control.currentAgent && control.currentAgent !== details.event.agent) return false;
	if (details.event.index !== undefined && control.currentIndex !== details.event.index) return false;
	return control.currentActivityState === "needs_attention";
}

export function handleSubagentControlNotice(input: {
	pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">;
	state: SubagentState;
	visibleControlNotices: Set<string>;
	details: SubagentControlMessageDetails;
	foregroundDelayMs?: number;
	isIdle?: () => boolean;
}): void {
	if (!input.details?.event || input.details.event.type === "active_long_running") return;
	if (input.details.source !== "foreground") {
		deliverControlNotice(input);
		return;
	}

	const pending = input.state.pendingForegroundControlNotices ?? new Map<string, ReturnType<typeof setTimeout>>();
	input.state.pendingForegroundControlNotices = pending;
	const timerKey = noticeTimerKey(input.details);
	const existing = pending.get(timerKey);
	if (existing) clearTimeout(existing);
	const timer = setTimeout(() => {
		pending.delete(timerKey);
		if (!isForegroundNoticeStillActionable(input.state, input.details)) return;
		deliverControlNotice(input);
	}, input.foregroundDelayMs ?? 1000);
	timer.unref?.();
	pending.set(timerKey, timer);
}
