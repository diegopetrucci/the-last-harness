import { controlNotificationKey, formatControlNoticeMessage, } from "../runs/shared/subagent-control.js";
import { CONTROL_NOTICE_NUDGE_TEXT } from "../runs/shared/nudge-texts.js";
export const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";
const NUDGE_TEXT = CONTROL_NOTICE_NUDGE_TEXT;
export function formatSubagentControlNotice(details, content) {
    return details.noticeText ?? content ?? formatControlNoticeMessage(details.event);
}
function deliverControlNotice(input) {
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
    if (input.isIdle?.() ?? true) {
        input.pi.sendUserMessage(NUDGE_TEXT, { deliverAs: "followUp" });
    }
}
export function handleSubagentControlNotice(input) {
    if (!input.details?.event)
        return;
    deliverControlNotice(input);
}
