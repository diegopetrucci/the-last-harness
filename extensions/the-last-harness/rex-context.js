// Generated from extensions/the-last-harness/rex-context.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import { execFileSync } from "node:child_process";
import { REX_SESSION_START_TIMEOUT_MS } from "./constants.js";
const REX_SESSION_START_ARGS = [
    "__internal",
    "session-start",
    "--agent",
    "pi",
    "--autostart=false",
];
const runRexSessionStartWithSubprocess = (command, args) => execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: REX_SESSION_START_TIMEOUT_MS,
});
let runRexSessionStart = runRexSessionStartWithSubprocess;
let cached;
export function getRexSessionContext() {
    if (!process.env.REX_SESSION)
        return undefined;
    if (!cached) {
        let context;
        try {
            context = runRexSessionStart("rex", REX_SESSION_START_ARGS).trim() || undefined;
        }
        catch {
            context = undefined;
        }
        cached = { context };
    }
    return cached.context;
}
export const __testing = {
    setRunnerForTests(runner) {
        runRexSessionStart = runner;
        cached = undefined;
    },
    resetForTests() {
        runRexSessionStart = runRexSessionStartWithSubprocess;
        cached = undefined;
    },
};
