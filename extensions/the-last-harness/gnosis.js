import { execFileSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { GNOSIS_VALIDATION_TIMEOUT_MS } from "./constants.js";
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
            execFileSync(command, args, { stdio: "ignore", timeout: GNOSIS_VALIDATION_TIMEOUT_MS });
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
function findValidGnosisCommand(agentDir, options = {}) {
    const candidates = uniqueGnosisCandidates([join(agentDir, "bin", "gn"), "gn"]);
    for (const candidate of candidates) {
        if (!validateGnosisCommand(candidate))
            continue;
        if (options.prependPath && candidate !== "gn") {
            prependProcessPath(dirname(candidate));
        }
        return candidate;
    }
    return undefined;
}
export function shouldAppendGnosisPrompt(_cwd) {
    const agentDir = getAgentDir();
    return Boolean(findValidGnosisCommand(agentDir, { prependPath: true }));
}
