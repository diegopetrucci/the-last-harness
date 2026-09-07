import * as fs from "node:fs";
import * as path from "node:path";
import { isEffectivelyEmpty } from "../runs/shared/acceptance.js";
import { DEFAULT_ARTIFACT_CONFIG, TEMP_ARTIFACTS_DIR, } from "./types.js";
import { getAgentDir } from "./utils.js";
const CLEANUP_MARKER_FILE = ".last-cleanup";
const PROJECT_ARTIFACT_ROOT = ".pi-subagents";
const LEGACY_DETAILED_ARTIFACT_CONFIG = {
    mode: "debug",
    enabled: true,
    includeInput: true,
    includeOutput: true,
    includeJsonl: false,
    includeTranscript: true,
    includeChildEventProjections: true,
    includeMetadata: true,
    cleanupDays: DEFAULT_ARTIFACT_CONFIG.cleanupDays,
};
let invalidArtifactModeWarningShown = false;
function isArtifactConfigRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function warnInvalidArtifactMode() {
    if (invalidArtifactModeWarningShown)
        return;
    invalidArtifactModeWarningShown = true;
    console.warn("[pi-subagents] Invalid artifacts.mode; using compact artifact mode.");
}
function resolveArtifactMode(value, legacy) {
    if (value === undefined)
        return legacy ? "debug" : "compact";
    if (value === "compact" || value === "debug")
        return value;
    warnInvalidArtifactMode();
    return "compact";
}
function optionalBoolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
}
function optionalCleanupDays(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
export function resolveArtifactConfig(source, options = {}) {
    const sourceRecord = isArtifactConfigRecord(source) ? source : undefined;
    const legacy = options.legacy === true;
    const sourceMode = sourceRecord
        ? Object.hasOwn(sourceRecord, "mode")
            ? sourceRecord.mode
            : undefined
        : source;
    const hasExplicitMode = sourceMode !== undefined;
    const mode = resolveArtifactMode(sourceMode, legacy && !hasExplicitMode);
    const profile = mode === "debug" ? LEGACY_DETAILED_ARTIFACT_CONFIG : DEFAULT_ARTIFACT_CONFIG;
    const enabled = options.enabled ??
        (legacy ? optionalBoolean(sourceRecord?.enabled, profile.enabled) : profile.enabled);
    if (!hasExplicitMode && legacy) {
        return {
            mode,
            enabled,
            includeInput: optionalBoolean(sourceRecord?.includeInput, profile.includeInput),
            includeOutput: optionalBoolean(sourceRecord?.includeOutput, profile.includeOutput),
            includeJsonl: optionalBoolean(sourceRecord?.includeJsonl, profile.includeJsonl),
            includeTranscript: optionalBoolean(sourceRecord?.includeTranscript, profile.includeTranscript ?? false),
            includeChildEventProjections: optionalBoolean(sourceRecord?.includeChildEventProjections, true),
            includeMetadata: optionalBoolean(sourceRecord?.includeMetadata, profile.includeMetadata),
            cleanupDays: optionalCleanupDays(sourceRecord?.cleanupDays, profile.cleanupDays),
        };
    }
    return {
        mode,
        enabled,
        includeInput: profile.includeInput,
        includeOutput: profile.includeOutput,
        includeJsonl: false,
        includeTranscript: profile.includeTranscript ?? false,
        includeChildEventProjections: legacy
            ? optionalBoolean(sourceRecord?.includeChildEventProjections, true)
            : profile.includeChildEventProjections,
        includeMetadata: profile.includeMetadata,
        cleanupDays: profile.cleanupDays,
    };
}
export function getProjectSubagentsDir(cwd) {
    return path.join(cwd, PROJECT_ARTIFACT_ROOT);
}
export function getProjectArtifactsDir(cwd) {
    return path.join(getProjectSubagentsDir(cwd), "artifacts");
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
export function writeArtifactWithFloor(filePath, computedContent, rawOutput, isArchive) {
    const content = !isArchive && rawOutput.trim() && isEffectivelyEmpty(computedContent)
        ? rawOutput
        : computedContent;
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
