import { controlNotificationKey, formatControlNoticeMessage, } from "../runs/shared/subagent-control.js";
export const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";
export function formatSubagentControlNotice(details, content) {
    return details.noticeText ?? content ?? formatControlNoticeMessage(details.event);
}
function deliverControlNotice(input) {
    const key = controlNotificationKey(input.details.event);
    if (input.visibleControlNotices.has(key))
        return;
    input.visibleControlNotices.add(key);
    const noticeText = input.details.noticeText ?? formatControlNoticeMessage(input.details.event);
    const wake = input.isIdle?.() ?? true;
    input.pi.sendMessage({
        customType: SUBAGENT_CONTROL_MESSAGE_TYPE,
        content: noticeText,
        display: true,
        details: { ...input.details, noticeText, triggersTurn: wake },
    }, wake ? { triggerTurn: true } : undefined);
}
export function handleSubagentControlNotice(input) {
    if (!input.details?.event)
        return;
    deliverControlNotice(input);
}
