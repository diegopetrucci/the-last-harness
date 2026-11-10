// Generated from extensions/shared/project-agent-provenance.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import * as os from "node:os";
import * as path from "node:path";
export const PACKAGED_PRIMARY_AGENT_ROLES = ["architect", "rush", "product", "bug-hunter"];
export const PACKAGED_MINOR_AGENT_ROLES = [
    "developer",
    "test-runner",
    "code-reviewer",
    "repo-scout",
    "diff-summarizer",
    "librarian",
    "web-scout",
    "oracle",
    "contrarian",
];
const packagedMinorAgentRoles = new Set(PACKAGED_MINOR_AGENT_ROLES);
function agentDir() {
    const configured = process.env.PI_CODING_AGENT_DIR?.trim();
    if (configured) {
        const expanded = configured === "~"
            ? os.homedir()
            : configured.startsWith("~/")
                ? path.join(os.homedir(), configured.slice(2))
                : configured;
        return path.resolve(expanded);
    }
    return path.join(os.homedir(), ".pi", "agent");
}
export function isCanonicalPackagedMinorAgent(agent) {
    if (typeof agent !== "object" || agent === null || Array.isArray(agent))
        return false;
    const candidate = agent;
    if (typeof candidate.name !== "string" ||
        !packagedMinorAgentRoles.has(candidate.name) ||
        typeof candidate.filePath !== "string") {
        return false;
    }
    try {
        const canonicalPath = path.join(agentDir(), "tlh", "agents", "subagents", `${candidate.name}.md`);
        return path.resolve(candidate.filePath) === path.resolve(canonicalPath);
    }
    catch {
        return false;
    }
}
