import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  controlNotificationKey,
  formatControlNoticeMessage,
} from "../runs/shared/subagent-control.ts";
import type { ControlEvent } from "../shared/types.ts";
import { CONTROL_NOTICE_NUDGE_TEXT } from "../runs/shared/nudge-texts.ts";

export const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";

const NUDGE_TEXT = CONTROL_NOTICE_NUDGE_TEXT;

export interface SubagentControlMessageDetails {
  event: ControlEvent;
  source?: "async";
  asyncDir?: string;
  noticeText?: string;
}

export function formatSubagentControlNotice(
  details: SubagentControlMessageDetails,
  content?: string,
): string {
  return details.noticeText ?? content ?? formatControlNoticeMessage(details.event);
}

function deliverControlNotice(input: {
  pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">;
  visibleControlNotices: Set<string>;
  details: SubagentControlMessageDetails;
  isIdle?: () => boolean;
}): void {
  const key = controlNotificationKey(input.details.event);
  if (input.visibleControlNotices.has(key)) return;
  input.visibleControlNotices.add(key);
  const noticeText = input.details.noticeText ?? formatControlNoticeMessage(input.details.event);
  input.pi.sendMessage({
    customType: SUBAGENT_CONTROL_MESSAGE_TYPE,
    content: noticeText,
    display: true,
    details: { ...input.details, noticeText },
  });
  // When the session is idle, wake the agent through prompt() so
  // before_agent_start fires and the TLH system prompt is restored.
  // deliverAs:'followUp' is safe under a streaming race: it queues a benign
  // followUp rather than throwing. When streaming, Pi steers the turn via the
  // custom message alone; no nudge is needed. Idleness is read live at send
  // time; when no session context has been captured yet, assume idle (the
  // nudge degrades to a benign followUp if that assumption is wrong).
  if (input.isIdle?.() ?? true) {
    input.pi.sendUserMessage(NUDGE_TEXT, { deliverAs: "followUp" });
  }
}

export function handleSubagentControlNotice(input: {
  pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">;
  visibleControlNotices: Set<string>;
  details: SubagentControlMessageDetails;
  isIdle?: () => boolean;
}): void {
  if (!input.details?.event) return;
  deliverControlNotice(input);
}
