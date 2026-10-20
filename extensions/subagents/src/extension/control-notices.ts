import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  controlNotificationKey,
  formatControlNoticeMessage,
} from "../runs/shared/subagent-control.ts";
import type { ControlEvent } from "../shared/types.ts";

export const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";

export interface SubagentControlMessageDetails {
  event: ControlEvent;
  source?: "async";
  asyncDir?: string;
  noticeText?: string;
  /** True exactly when the notice was sent with { triggerTurn: true }. */
  triggersTurn?: boolean;
}

export function formatSubagentControlNotice(
  details: SubagentControlMessageDetails,
  content?: string,
): string {
  return details.noticeText ?? content ?? formatControlNoticeMessage(details.event);
}

function deliverControlNotice(input: {
  pi: Pick<ExtensionAPI, "sendMessage">;
  visibleControlNotices: Set<string>;
  details: SubagentControlMessageDetails;
  isIdle?: () => boolean;
}): void {
  const key = controlNotificationKey(input.details.event);
  if (input.visibleControlNotices.has(key)) return;
  input.visibleControlNotices.add(key);
  const noticeText = input.details.noticeText ?? formatControlNoticeMessage(input.details.event);
  // Async notices wake an idle parent natively: with { triggerTurn: true } Pi starts a
  // run from the custom message (before_agent_start fires, so the TLH system prompt
  // applies) and steers an active turn when streaming. Idleness is read live at send
  // time; when no session context has been captured yet, assume idle.
  // Non-wake sends pass no options (never triggerTurn:false, which defers
  // delivery while streaming).
  const wake = input.isIdle?.() ?? true;
  input.pi.sendMessage(
    {
      customType: SUBAGENT_CONTROL_MESSAGE_TYPE,
      content: noticeText,
      display: true,
      details: { ...input.details, noticeText, triggersTurn: wake },
    },
    wake ? { triggerTurn: true } : undefined,
  );
}

export function handleSubagentControlNotice(input: {
  pi: Pick<ExtensionAPI, "sendMessage">;
  visibleControlNotices: Set<string>;
  details: SubagentControlMessageDetails;
  isIdle?: () => boolean;
}): void {
  if (!input.details?.event) return;
  deliverControlNotice(input);
}
