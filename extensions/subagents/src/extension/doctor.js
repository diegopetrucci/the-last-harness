import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgentsAll } from "../agents/agents.js";
import { isAsyncAvailable } from "../runs/background/async-execution.js";
import { discoverAvailableSkills, SOURCE_PRIORITY } from "../agents/skills.js";
import { ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR, } from "../shared/types.js";
import { inspectRuntimeDirs } from "./runtime-cleanup.js";
const DEFAULT_PATHS = {
    tempRootDir: TEMP_ROOT_DIR,
    asyncDir: ASYNC_DIR,
    resultsDir: RESULTS_DIR,
};
const DEFAULT_DEPS = {
    isAsyncAvailable,
    discoverAgentsAll,
    discoverAvailableSkills,
};
function errorText(error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
function lineFromCheck(label, check) {
    try {
        return check();
    }
    catch (error) {
        return `- ${label}: failed — ${errorText(error)}`;
    }
}
function formatExistingDirectory(label, dirPath) {
    try {
        if (!fs.existsSync(dirPath))
            return `- ${label}: missing (${dirPath})`;
        const stats = fs.statSync(dirPath);
        if (!stats.isDirectory())
            throw new Error(`not a directory: ${dirPath}`);
        fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
        return `- ${label}: ok (${dirPath})`;
    }
    catch (error) {
        return `- ${label}: failed (${dirPath}) — ${errorText(error)}`;
    }
}
function formatSourceCounts(counts) {
    return `builtin ${counts.builtin}, package ${counts.package}, user ${counts.user}, project ${counts.project}`;
}
const SKILL_SOURCE_ORDER = Object.keys(SOURCE_PRIORITY).sort((a, b) => (SOURCE_PRIORITY[b] ?? 0) - (SOURCE_PRIORITY[a] ?? 0));
function formatSkillSourceCounts(skills) {
    const counts = new Map();
    for (const skill of skills)
        counts.set(skill.source, (counts.get(skill.source) ?? 0) + 1);
    const parts = SKILL_SOURCE_ORDER.map((source) => `${source} ${counts.get(source) ?? 0}`).filter((part) => !part.endsWith(" 0"));
    return parts.length > 0 ? parts.join(", ") : "none";
}
function formatConfiguredSessionDir(input) {
    if (input.requestedSessionDir) {
        return path.resolve(input.expandTilde?.(input.requestedSessionDir) ?? input.requestedSessionDir);
    }
    return "not configured";
}
function formatSessionLines(input) {
    const sessionFile = input.currentSessionFile ?? null;
    const lines = [
        lineFromCheck("configured session dir", () => `- configured session dir: ${formatConfiguredSessionDir(input)}`),
        `- current session file: ${sessionFile ?? "not available"}`,
        `- current session dir: ${sessionFile ? path.dirname(sessionFile) : "not available"}`,
        `- current session id: ${input.currentSessionId ?? input.state.currentSessionId ?? "not available"}`,
    ];
    if (input.sessionError)
        lines.push(`- session manager: failed — ${input.sessionError}`);
    return lines;
}
function formatRuntimeDirCounts(paths) {
    const counts = inspectRuntimeDirs({
        asyncDir: paths.asyncDir,
        nestedRunsDir: path.join(paths.tempRootDir, "nested-subagent-runs"),
        nestedEventsDir: path.join(paths.tempRootDir, "nested-subagent-events"),
    });
    return (`- runtime dir counts: async ${counts.topLevelAsyncDirs + counts.nestedAsyncDirs} ` +
        `(top-level ${counts.topLevelAsyncDirs}, nested ${counts.nestedAsyncDirs}, active/live ${counts.activeOrLiveAsyncDirs}, stale ${counts.staleAsyncDirs}); ` +
        `nested event routes ${counts.nestedEventDirs} (unreferenced ${counts.unreferencedNestedEventDirs})`);
}
function formatDiscovery(input, deps) {
    return [
        lineFromCheck("agents", () => {
            const discovered = deps.discoverAgentsAll(input.cwd);
            const agentCounts = {
                builtin: discovered.builtin.length,
                package: discovered.package?.length ?? 0,
                user: discovered.user.length,
                project: discovered.project.length,
            };
            return `- agents: total ${agentCounts.builtin + agentCounts.package + agentCounts.user + agentCounts.project} (${formatSourceCounts(agentCounts)})`;
        }),
        lineFromCheck("skills", () => {
            const skills = deps.discoverAvailableSkills(input.cwd);
            return `- skills: total ${skills.length} (${formatSkillSourceCounts(skills)})`;
        }),
    ];
}
function formatHeartbeatSection(summary) {
    if (!summary)
        return [`- heartbeat: not available`];
    if (!summary.enabled)
        return [`- heartbeat: disabled (enabled: false in config)`];
    const costStr = summary.totalBeatCostUsd > 0
        ? `$${summary.totalBeatCostUsd.toFixed(5)} total beat cost`
        : "$0 beat cost";
    const gapsStr = [
        summary.gapsSaved > 0 ? `${summary.gapsSaved} saved` : null,
        summary.gapsWasted > 0 ? `${summary.gapsWasted} wasted` : null,
        summary.gapsLost > 0 ? `${summary.gapsLost} lost` : null,
        summary.gapsUnneeded > 0 ? `${summary.gapsUnneeded} unneeded` : null,
    ]
        .filter(Boolean)
        .join(", ");
    return [
        `- heartbeat: enabled`,
        `- beats this session: ${summary.totalBeats}`,
        `- cache-read tokens: ${summary.totalCacheReadTokens}`,
        `- ${costStr}`,
        `- gaps: ${gapsStr || "none yet"}`,
        `- circuit breaker: ${summary.breakerDisabled ? "open (disabled after failures)" : "closed"}`,
    ];
}
function formatPermissionSystemSection() {
    const lines = [];
    const parentSession = process.env["PI_SUBAGENT_PARENT_SESSION"] ?? "";
    const trimmed = parentSession.trim();
    if (trimmed) {
        lines.push(`- parent session: set (${trimmed})`);
    }
    else {
        lines.push("- parent session: not set — ask forwarding from subprocess children will not reach a parent UI");
    }
    const isChild = process.env["PI_SUBAGENT_CHILD"] === "1";
    lines.push(`- subagent process: ${isChild ? "yes (PI_SUBAGENT_CHILD=1)" : "no"}`);
    return lines;
}
export function buildDoctorReport(input) {
    const paths = input.paths ?? DEFAULT_PATHS;
    const deps = { ...DEFAULT_DEPS, ...input.deps };
    const lines = [
        "Subagents doctor report",
        "",
        "Runtime",
        `- cwd: ${input.cwd}`,
        lineFromCheck("async support", () => `- async support: ${deps.isAsyncAvailable() ? "available" : "unavailable"}`),
        ...formatSessionLines(input),
        "",
        "Filesystem",
        formatExistingDirectory("temp root", paths.tempRootDir),
        formatExistingDirectory("async runs", paths.asyncDir),
        formatExistingDirectory("results", paths.resultsDir),
        lineFromCheck("runtime dir counts", () => formatRuntimeDirCounts(paths)),
        "",
        "Discovery",
        ...formatDiscovery(input, deps),
        "",
        "Permission system",
        ...formatPermissionSystemSection(),
        "",
        "Heartbeat",
        ...formatHeartbeatSection(input.heartbeat),
    ];
    return lines.join("\n");
}
