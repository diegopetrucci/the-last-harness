import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SubagentState } from "../../shared/types.ts";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";

const FOREGROUND_LIVE_MESSAGE_INBOXES_DIR = path.join(
  TEMP_ROOT_DIR,
  "foreground-live-message-inboxes",
);

type ForegroundControl =
  SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;

/** Register the live steering inbox used by supported foreground children. */
export function registerForegroundMessageInbox(
  control: ForegroundControl,
  _runId: string,
  index: number,
): string {
  control.messageInboxRoot ??= path.join(FOREGROUND_LIVE_MESSAGE_INBOXES_DIR, randomUUID());
  const dir = path.join(control.messageInboxRoot, String(index));
  fs.mkdirSync(dir, { recursive: true });
  control.activeMessageInboxes ??= new Map();
  control.activeMessageInboxes.set(index, dir);
  return dir;
}

/** Remove a foreground steering inbox after its child execution ends. */
export function clearForegroundMessageInbox(control: ForegroundControl, index: number): void {
  const dir = control.activeMessageInboxes?.get(index);
  if (dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort foreground inbox cleanup.
    }
  }
  control.activeMessageInboxes?.delete(index);
  if (control.activeMessageInboxes?.size === 0) {
    control.activeMessageInboxes = undefined;
    if (control.messageInboxRoot) {
      try {
        fs.rmSync(control.messageInboxRoot, { recursive: true, force: true });
      } catch {
        // Best effort foreground inbox-root cleanup.
      }
    }
    control.messageInboxRoot = undefined;
  }
}
