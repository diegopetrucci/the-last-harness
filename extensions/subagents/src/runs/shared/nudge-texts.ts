/**
 * Shared nudge text constants used by background notification and control-notice
 * senders. When a new nudge text is introduced it MUST be registered here so
 * that `stripParentOnlySubagentMessages` in subagent-prompt-runtime.ts can
 * strip the corresponding user-role message from forked child subagent context.
 */

export const BACKGROUND_COMPLETION_NUDGE_TEXT =
  "[tlh] Background subagent completed — see notification above.";

export const CONTROL_NOTICE_NUDGE_TEXT = "[tlh] Subagent run needs attention — see notice above.";

/**
 * All registered nudge texts. Checked by `stripParentOnlySubagentMessages` to
 * detect and strip dangling nudge user messages from child context.
 */
export const PARENT_ONLY_NUDGE_TEXTS: ReadonlySet<string> = new Set([
  BACKGROUND_COMPLETION_NUDGE_TEXT,
  CONTROL_NOTICE_NUDGE_TEXT,
]);
