import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Pre-assign a fresh child session file inside `sessionDir`.
 *
 * The name mirrors Pi's own `<ISO timestamp with ':' and '.' as '-'>_<id>.jsonl`
 * layout, so lexical order stays chronological. The parent directory is created
 * and canonicalized so the path is stable for later ownership checks and for
 * `tlh sessions` correlation, which compares realpaths. Nothing is created at
 * the returned path: Pi writes it when launched with `--session <path>`.
 */
export function allocateChildSessionFile(sessionDir: string, now: Date = new Date()): string {
  fs.mkdirSync(sessionDir, { recursive: true });
  const canonicalDir = fs.realpathSync(sessionDir);
  const fileTimestamp = now.toISOString().replace(/[:.]/g, "-");
  for (;;) {
    const candidate = path.join(canonicalDir, `${fileTimestamp}_${randomUUID()}.jsonl`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}
