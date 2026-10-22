// Subprocess helper: performs repeated lock-protected status writes, yielding to
// the event loop between writes, until it is killed. Set TLH_TEST_NO_KILL_CLEANUP=1
// to skip installing the runner's signal handler (reproduces the pre-fix runner).
import { ensureKillCleanup } from "../../src/runs/background/single-step-execution.ts";
import { mergeAndWriteSourceRunnerStatus } from "../../src/runs/shared/lifecycle-state.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";

const asyncDir = process.argv[2]!;
if (process.env.TLH_TEST_NO_KILL_CLEANUP !== "1") ensureKillCleanup();

const now = Date.now();
const status: AsyncStatus = {
  lifecycleArtifactVersion: 1,
  runId: "signal-writer",
  mode: "single",
  state: "running",
  startedAt: now,
  lastActivityAt: now,
  lastUpdate: now,
  currentStep: 0,
  cwd: asyncDir,
  pid: process.pid,
  steps: [{ agent: "worker", status: "running", startedAt: now }],
};

console.log("ready");
const loop = (): void => {
  status.lastUpdate = Date.now();
  mergeAndWriteSourceRunnerStatus(asyncDir, status);
  setImmediate(loop);
};
loop();
