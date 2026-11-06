// Subprocess helper: takes a session lease like the runner does, spawns one live
// owned child group that records itself in the lease, then idles until it is
// SIGKILLed by the test. The fixture child ignores SIGINT/SIGTERM and has a finite
// lifetime as a last-resort guard. Usage: <sessionFile> <pidFile> <outputFile>
import { openAttemptSessionLease } from "../../src/runs/background/attempt-session-lease.ts";
import { runPiStreaming } from "../../src/runs/background/pi-streaming.ts";

const [sessionFile, pidFile, outputFile] = process.argv.slice(2) as [string, string, string];
const childSource = [
  "const fs = require('node:fs');",
  "process.on('SIGINT', () => {});",
  "process.on('SIGTERM', () => {});",
  `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
  "setTimeout(() => process.exit(0), 30000);",
].join("\n");

process.env.PI_SUBAGENT_PI_BINARY = process.execPath;
const opened = openAttemptSessionLease(sessionFile, "lease-fault-run");
if (!opened.ok) throw new Error(opened.error);
const { lease } = opened;
void runPiStreaming(
  ["-e", childSource],
  process.cwd(),
  outputFile,
  () => undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  { restored: false, onChildSpawned: (groupId) => lease.recordProcessGroup(groupId) },
);
setInterval(() => undefined, 1000);
