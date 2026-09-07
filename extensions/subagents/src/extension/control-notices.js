import { controlNotificationKey, formatControlNoticeMessage, } from "../runs/shared/subagent-control.js";
import { CONTROL_NOTICE_NUDGE_TEXT } from "../runs/shared/nudge-texts.js";
export const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";
const NUDGE_TEXT = CONTROL_NOTICE_NUDGE_TEXT;
export function formatSubagentControlNotice(details, content) {
    return details.noticeText ?? content ?? formatControlNoticeMessage(details.event);
}
function noticeTimerKey(details) {
    return `${details.event.runId}:${controlNotificationKey(details.event)}`;
}
export function clearPendingForegroundControlNotices(state, runId) {
    const pending = state.pendingForegroundControlNotices;
    if (!pending)
        return;
    for (const [key, timer] of pending) {
        if (runId !== undefined && !key.startsWith(`${runId}:`))
            continue;
        clearTimeout(timer);
        pending.delete(key);
    }
}
function deliverControlNotice(input) {
    if (input.details.event.reason === "completion_guard")
        return;
    const key = controlNotificationKey(input.details.event);
    if (input.visibleControlNotices.has(key))
        return;
    input.visibleControlNotices.add(key);
    const noticeText = input.details.noticeText ?? formatControlNoticeMessage(input.details.event);
    input.pi.sendMessage({
        customType: SUBAGENT_CONTROL_MESSAGE_TYPE,
        content: noticeText,
        display: true,
        details: { ...input.details, noticeText },
    });
    if (input.details.source !== "foreground" && (input.isIdle?.() ?? true)) {
        input.pi.sendUserMessage(NUDGE_TEXT, { deliverAs: "followUp" });
    }
}
function isForegroundNoticeStillActionable(state, details) {
    const control = state.foregroundControls.get(details.event.runId);
    if (!control)
        return false;
    if (control.currentAgent && control.currentAgent !== details.event.agent)
        return false;
    if (details.event.index !== undefined && control.currentIndex !== details.event.index)
        return false;
    return control.currentActivityState === "needs_attention";
}
export function handleSubagentControlNotice(input) {
    if (!input.details?.event || input.details.event.type === "active_long_running")
        return;
    if (input.details.source !== "foreground") {
        deliverControlNotice(input);
        return;
    }
    const pending = input.state.pendingForegroundControlNotices ?? new Map();
    input.state.pendingForegroundControlNotices = pending;
    const timerKey = noticeTimerKey(input.details);
    const existing = pending.get(timerKey);
    if (existing)
        clearTimeout(existing);
    const timer = setTimeout(() => {
        pending.delete(timerKey);
        if (!isForegroundNoticeStillActionable(input.state, input.details))
            return;
        deliverControlNotice(input);
    }, input.foregroundDelayMs ?? 1000);
    timer.unref?.();
    pending.set(timerKey, timer);
}
