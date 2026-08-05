import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_ARTIFACTS_DIR } from "./types.js";
import { getAgentDir } from "./utils.js";
const CLEANUP_MARKER_FILE = ".last-cleanup";
const PROJECT_ARTIFACT_ROOT = ".pi-subagents";
export function getProjectSubagentsDir(cwd) {
    return path.join(cwd, PROJECT_ARTIFACT_ROOT);
}
export function getProjectArtifactsDir(cwd) {
    return path.join(getProjectSubagentsDir(cwd), "artifacts");
}
export function getProjectChainRunsDir(cwd) {
    return path.join(getProjectSubagentsDir(cwd), "chain-runs");
}
export function getArtifactsDir(sessionFile, projectCwd) {
    if (projectCwd)
        return getProjectArtifactsDir(projectCwd);
    if (sessionFile) {
        const sessionDir = path.dirname(sessionFile);
        return path.join(sessionDir, "subagent-artifacts");
    }
    return TEMP_ARTIFACTS_DIR;
}
export function getArtifactPaths(artifactsDir, runId, agent, index) {
    const suffix = index !== undefined ? `_${index}` : "";
    const safeAgent = agent.replace(/[^\w.-]/g, "_");
    const base = `${runId}_${safeAgent}${suffix}`;
    return {
        inputPath: path.join(artifactsDir, `${base}_input.md`),
        outputPath: path.join(artifactsDir, `${base}_output.md`),
        jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
        transcriptPath: path.join(artifactsDir, `${base}_transcript.jsonl`),
        metadataPath: path.join(artifactsDir, `${base}_meta.json`),
    };
}
export function ensureArtifactsDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}
export function writeArtifact(filePath, content) {
    fs.writeFileSync(filePath, content, "utf-8");
}
export function writeMetadata(filePath, metadata) {
    fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), "utf-8");
}
export function appendJsonl(filePath, line) {
    fs.appendFileSync(filePath, `${line}\n`);
}
function isFullyExpiredTree(dir, cutoff) {
    let stat;
    try {
        stat = fs.lstatSync(dir);
    }
    catch {
        return false;
    }
    if (!stat.isDirectory())
        return stat.mtimeMs < cutoff;
    if (stat.mtimeMs >= cutoff)
        return false;
    let entries;
    try {
        entries = fs.readdirSync(dir);
    }
    catch {
        return false;
    }
    for (const entry of entries) {
        if (!isFullyExpiredTree(path.join(dir, entry), cutoff))
            return false;
    }
    return true;
}
export function cleanupOldArtifacts(dir, maxAgeDays) {
    if (!fs.existsSync(dir))
        return;
    const markerPath = path.join(dir, CLEANUP_MARKER_FILE);
    const now = Date.now();
    if (fs.existsSync(markerPath)) {
        const stat = fs.statSync(markerPath);
        if (now - stat.mtimeMs < 24 * 60 * 60 * 1000)
            return;
    }
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoff = now - maxAgeMs;
    for (const file of fs.readdirSync(dir)) {
        if (file === CLEANUP_MARKER_FILE)
            continue;
        const filePath = path.join(dir, file);
        try {
            if (!isFullyExpiredTree(filePath, cutoff))
                continue;
            const stat = fs.lstatSync(filePath);
            if (stat.isDirectory()) {
                fs.rmSync(filePath, { recursive: true, force: false });
            }
            else {
                fs.unlinkSync(filePath);
            }
        }
        catch {
        }
    }
    fs.writeFileSync(markerPath, String(now));
}
export function cleanupAllArtifactDirs(maxAgeDays) {
    cleanupOldArtifacts(TEMP_ARTIFACTS_DIR, maxAgeDays);
    const sessionsBase = path.join(getAgentDir(), "sessions");
    if (!fs.existsSync(sessionsBase))
        return;
    let dirs;
    try {
        dirs = fs.readdirSync(sessionsBase);
    }
    catch {
        return;
    }
    for (const dir of dirs) {
        const artifactsDir = path.join(sessionsBase, dir, "subagent-artifacts");
        try {
            cleanupOldArtifacts(artifactsDir, maxAgeDays);
        }
        catch {
        }
    }
}
