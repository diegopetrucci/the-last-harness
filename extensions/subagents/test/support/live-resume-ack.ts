import * as fs from "node:fs";
import * as path from "node:path";
import {
  steerRequestsDir,
  writeChildMessageAcceptance,
} from "../../src/runs/background/control-channel.ts";

/** Stand in for a live runner: accept every resume follow-up request for child 0. */
export function acknowledgeResumeRequests(asyncDir: string): () => void {
  const seen = new Set<string>();
  const timer = setInterval(() => {
    const dir = steerRequestsDir(asyncDir);
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      if (seen.has(file)) continue;
      try {
        const request = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as {
          id: string;
        };
        writeChildMessageAcceptance(asyncDir, {
          requestId: request.id,
          type: "resume",
          status: "accepted",
          ts: Date.now(),
          acceptedIndexes: [0],
        });
        seen.add(file);
      } catch {
        // Partially written request; retried on the next tick.
      }
    }
  }, 25);
  return () => clearInterval(timer);
}
