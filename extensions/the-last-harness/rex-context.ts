import { execFileSync } from "node:child_process";

import { REX_SESSION_START_TIMEOUT_MS } from "./constants.js";

type RexSessionStartRunner = (command: string, args: string[]) => string;

const REX_SESSION_START_ARGS = [
  "__internal",
  "session-start",
  "--agent",
  "pi",
  "--autostart=false",
];

const runRexSessionStartWithSubprocess: RexSessionStartRunner = (command, args) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: REX_SESSION_START_TIMEOUT_MS,
  });
let runRexSessionStart = runRexSessionStartWithSubprocess;

// Launch estimation and before_agent_start build the same prompt; run rex once per process and
// cache the outcome (including failure) so it never repeats.
let cached: { context: string | undefined } | undefined;

/** Rex session-start context for the primary prompt, or undefined outside Rex or on any failure. */
export function getRexSessionContext(): string | undefined {
  if (!process.env.REX_SESSION) return undefined;
  if (!cached) {
    let context: string | undefined;
    try {
      context = runRexSessionStart("rex", REX_SESSION_START_ARGS).trim() || undefined;
    } catch {
      context = undefined;
    }
    cached = { context };
  }
  return cached.context;
}

/** @internal Exported only for deterministic unit coverage. */
export const __testing = {
  setRunnerForTests(runner: RexSessionStartRunner) {
    runRexSessionStart = runner;
    cached = undefined;
  },
  resetForTests() {
    runRexSessionStart = runRexSessionStartWithSubprocess;
    cached = undefined;
  },
};
