import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_ROOT_DIR } from "../../shared/types.js";
const FOREGROUND_LIVE_MESSAGE_INBOXES_DIR = path.join(TEMP_ROOT_DIR, "foreground-live-message-inboxes");
export function registerForegroundMessageInbox(control, _runId, index) {
    control.messageInboxRoot ??= path.join(FOREGROUND_LIVE_MESSAGE_INBOXES_DIR, randomUUID());
    const dir = path.join(control.messageInboxRoot, String(index));
    fs.mkdirSync(dir, { recursive: true });
    control.activeMessageInboxes ??= new Map();
    control.activeMessageInboxes.set(index, dir);
    return dir;
}
export function clearForegroundMessageInbox(control, index) {
    const dir = control.activeMessageInboxes?.get(index);
    if (dir) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        catch {
        }
    }
    control.activeMessageInboxes?.delete(index);
    if (control.activeMessageInboxes?.size === 0) {
        control.activeMessageInboxes = undefined;
        if (control.messageInboxRoot) {
            try {
                fs.rmSync(control.messageInboxRoot, { recursive: true, force: true });
            }
            catch {
            }
        }
        control.messageInboxRoot = undefined;
    }
}
