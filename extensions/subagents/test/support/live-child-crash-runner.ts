// Subprocess helper: behaves like a runner with one live owned child group, then
// throws an uncaught error. The fixture child ignores SIGINT/SIGTERM and has a
// finite lifetime as a last-resort guard. Usage: <pidFile> <outputFile>
import * as fs from "node:fs";
import { runPiStreaming } from "../../src/runs/background/pi-streaming.ts";
import { ensureKillCleanup } from "../../src/runs/background/single-step-execution.ts";

const [pidFile, outputFile] = process.argv.slice(2) as [string, string];
const childSource = [
  "const fs = require('node:fs');",
  "process.on('SIGINT', () => {});",
  "process.on('SIGTERM', () => {});",
  `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
  "setTimeout(() => process.exit(0), 30000);",
].join("\n");

process.env.PI_SUBAGENT_PI_BINARY = process.execPath;
ensureKillCleanup();
void runPiStreaming(["-e", childSource], process.cwd(), outputFile, () => undefined);

const poll = (): void => {
  if (!fs.existsSync(pidFile)) {
    setTimeout(poll, 10);
    return;
  }
  setTimeout(() => {
    throw new Error("simulated uncaught runner failure");
  }, 0);
};
poll();
