import { execFileSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { GNOSIS_VALIDATION_TIMEOUT_MS } from "./constants.js";
const GNOSIS_NEGATIVE_CACHE_TTL_MS = 30_000;
const validatedGnosisCommands = new Map();
const runGnosisHelpWithSubprocess = (command, args) => {
    execFileSync(command, args, { stdio: "ignore", timeout: GNOSIS_VALIDATION_TIMEOUT_MS });
};
let runGnosisHelp = runGnosisHelpWithSubprocess;
let currentTime = Date.now;
function uniqueGnosisCandidates(candidates) {
    const seen = new Set();
    const unique = [];
    for (const candidate of candidates) {
        if (!candidate)
            continue;
        const key = candidate === "gn" ? candidate : resolve(candidate);
        if (seen.has(key))
            continue;
        seen.add(key);
        unique.push(candidate);
    }
    return unique;
}
function validateGnosisCommand(command) {
    try {
        for (const args of [
            ["help", "plan"],
            ["help", "review"],
        ]) {
            runGnosisHelp(command, args);
        }
        return true;
    }
    catch {
        return false;
    }
}
function prependProcessPath(dir) {
    const currentPath = process.env.PATH || "";
    const entries = currentPath.split(delimiter).filter(Boolean);
    if (entries.includes(dir)) {
        return;
    }
    process.env.PATH = [dir, ...entries].join(delimiter);
}
function findValidGnosisCommand(agentDir) {
    const candidates = uniqueGnosisCandidates([join(agentDir, "bin", "gn"), "gn"]);
    for (const candidate of candidates) {
        if (validateGnosisCommand(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
function shouldAppendGnosisPromptForAgentDir(agentDir) {
    const resolvedAgentDir = resolve(agentDir);
    const now = currentTime();
    const cached = validatedGnosisCommands.get(resolvedAgentDir);
    let command = cached?.command;
    if (!cached || (!cached.command && now - cached.checkedAt >= GNOSIS_NEGATIVE_CACHE_TTL_MS)) {
        command = findValidGnosisCommand(resolvedAgentDir);
        validatedGnosisCommands.set(resolvedAgentDir, { command, checkedAt: currentTime() });
    }
    if (command && command !== "gn") {
        prependProcessPath(dirname(command));
    }
    return command !== undefined;
}
export function shouldAppendGnosisPrompt(_cwd) {
    return shouldAppendGnosisPromptForAgentDir(getAgentDir());
}
export const __testing = {
    shouldAppendGnosisPromptForAgentDir,
    setGnosisHelpRunnerForTests(runner) {
        runGnosisHelp = runner;
        validatedGnosisCommands.clear();
    },
    setClockForTests(clock) {
        currentTime = clock;
        validatedGnosisCommands.clear();
    },
    resetForTests() {
        runGnosisHelp = runGnosisHelpWithSubprocess;
        currentTime = Date.now;
        validatedGnosisCommands.clear();
    },
};
