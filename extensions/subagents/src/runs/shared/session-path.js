// Generated from extensions/subagents/src/runs/shared/session-path.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
export function allocateChildSessionFile(sessionDir, now = new Date()) {
    fs.mkdirSync(sessionDir, { recursive: true });
    const canonicalDir = fs.realpathSync(sessionDir);
    const fileTimestamp = now.toISOString().replace(/[:.]/g, "-");
    for (;;) {
        const candidate = path.join(canonicalDir, `${fileTimestamp}_${randomUUID()}.jsonl`);
        if (!fs.existsSync(candidate))
            return candidate;
    }
}
