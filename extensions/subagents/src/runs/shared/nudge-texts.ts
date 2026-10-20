/**
 * Legacy synthetic user-message texts. Runtime code no longer sends them: background
 * completions and async control notices now wake the parent natively via
 * sendMessage(..., { triggerTurn: true }) (Pi 1.2.0, #470). The constants remain only so
 * session analysis can recognise and attribute older transcripts that contain them.
 */

export const BACKGROUND_COMPLETION_NUDGE_TEXT =
  "[tlh] Background subagent completed — see notification above.";

export const CONTROL_NOTICE_NUDGE_TEXT = "[tlh] Subagent run needs attention — see notice above.";
