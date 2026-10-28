import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let sharedAsyncDir: string | undefined;

/**
 * Complete a hand-written results-file fixture so the watcher can persist a durable
 * terminal record (usable asyncDir, terminal state, results array) and therefore
 * unlink it after delivery. Explicit fixture fields always win.
 */
export function durableArtifact<T extends Record<string, unknown>>(
  data: T,
): Record<string, unknown> {
  if (sharedAsyncDir === undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-durable-artifact-"));
    sharedAsyncDir = dir;
    process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  }
  const runId = (data.runId ?? data.id) as string | undefined;
  const asyncDir = path.join(sharedAsyncDir, runId ?? "run");
  fs.mkdirSync(asyncDir, { recursive: true });
  // The terminal record is only durable (retrievable by `result`) with a readable status.
  fs.writeFileSync(
    path.join(asyncDir, "status.json"),
    JSON.stringify({
      runId: runId ?? "run",
      mode: "single",
      state: "complete",
      startedAt: 1,
      endedAt: 2,
      steps: [],
    }),
  );
  return { state: "complete", results: [], asyncDir, ...data };
}
