// Generated from extensions/subagents/src/runs/background/terminal-record.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { truncateWithMarker } from "../../shared/string-utils.js";
import { RESULTS_DIR, } from "../../shared/types.js";
import { checkPidLiveness, isCompletedLifecycleStepState, isTerminalLifecycleState, } from "../shared/lifecycle-state.js";
export const TERMINAL_RECORD_FILE = "terminal-record.json";
export const TERMINAL_RETRIEVAL_FILE = "terminal-record.retrieved.json";
const TERMINAL_RECORD_VERSION = 2;
export const TERMINAL_RECORD_CHILD_OUTPUT_CHARS = 16_000;
const TERMINAL_RECORD_ERROR_CHARS = 2_000;
const TERMINAL_RECORD_SUMMARY_CHARS = 2_000;
const TERMINAL_RECORD_PATH_CHARS = 1_024;
const TERMINAL_RECORD_MAX_CHILDREN = 64;
const OUTPUT_MARKER = "… [output truncated; see artifact path for full output]";
const TEXT_MARKER = "… [truncated]";
function bound(value, max, marker = TEXT_MARKER) {
    return typeof value === "string" && value.length > 0
        ? truncateWithMarker(value, max, marker)
        : undefined;
}
function childStatusFromResult(item) {
    if (item.skipped)
        return "skipped";
    if (item.cancel)
        return "cancelled";
    if (item.interrupted || item.pause)
        return "paused";
    return item.success ? "completed" : "failed";
}
export function terminalRecordFromArtifact(artifact, options = {}) {
    const items = artifact.results.slice(0, TERMINAL_RECORD_MAX_CHILDREN);
    const children = items.map((item, index) => {
        const raw = item.finalOutput ?? item.output ?? "";
        const output = truncateWithMarker(raw, TERMINAL_RECORD_CHILD_OUTPUT_CHARS, OUTPUT_MARKER);
        return {
            index,
            agent: item.agent,
            status: childStatusFromResult(item),
            output,
            ...(output.length < raw.length || item.truncated ? { outputTruncated: true } : {}),
            ...optionalField("error", bound(item.error, TERMINAL_RECORD_ERROR_CHARS)),
            ...optionalField("sessionFile", bound(item.sessionFile, TERMINAL_RECORD_PATH_CHARS, "")),
            ...optionalField("artifactPath", bound(item.artifactPaths?.outputPath ?? item.savedOutputPath, TERMINAL_RECORD_PATH_CHARS, "")),
        };
    });
    return {
        version: TERMINAL_RECORD_VERSION,
        runId: artifact.id,
        revision: randomUUID(),
        state: artifact.state,
        mode: artifact.mode,
        agent: artifact.agent,
        success: artifact.success,
        summary: bound(artifact.summary, TERMINAL_RECORD_SUMMARY_CHARS) ?? "",
        ...optionalField("error", bound(artifact.error, TERMINAL_RECORD_ERROR_CHARS)),
        ...optionalField("sessionId", artifact.sessionId ?? undefined),
        endedAt: artifact.timestamp,
        ...(options.synthesized ? { synthesized: true } : {}),
        ...(artifact.results.length > items.length
            ? { childrenOmitted: artifact.results.length - items.length }
            : {}),
        children,
    };
}
function optionalField(key, value) {
    return (value === undefined ? {} : { [key]: value });
}
export function terminalRecordFromStatus(status) {
    const steps = (status.steps ?? []).slice(0, TERMINAL_RECORD_MAX_CHILDREN);
    const state = status.state;
    const fallbackOutput = status.error ?? "(no output recorded; result artifact was unavailable)";
    const children = steps.map((step, index) => {
        const completed = isCompletedLifecycleStepState(step.status);
        const childStatus = completed
            ? "completed"
            : step.status === "paused" || step.status === "pausing"
                ? "paused"
                : step.status === "cancelled"
                    ? "cancelled"
                    : step.status === "pending"
                        ? "skipped"
                        : "failed";
        const output = step.recentOutput?.join("\n") ||
            step.error ||
            (completed ? "(no output recorded; result artifact was unavailable)" : fallbackOutput);
        return {
            index,
            agent: step.agent,
            status: childStatus,
            output: truncateWithMarker(output, TERMINAL_RECORD_CHILD_OUTPUT_CHARS, OUTPUT_MARKER),
            outputTruncated: true,
            ...optionalField("error", bound(step.error, TERMINAL_RECORD_ERROR_CHARS)),
            ...optionalField("sessionFile", bound(step.sessionFile, TERMINAL_RECORD_PATH_CHARS, "")),
        };
    });
    return {
        version: TERMINAL_RECORD_VERSION,
        runId: status.runId,
        revision: randomUUID(),
        state,
        mode: status.mode,
        agent: steps[0]?.agent ?? "unknown",
        success: state === "complete",
        summary: bound(status.error, TERMINAL_RECORD_SUMMARY_CHARS) ??
            `Run ${state}; the result artifact was unavailable, so this record was synthesized from status.`,
        ...optionalField("error", bound(status.error, TERMINAL_RECORD_ERROR_CHARS)),
        ...optionalField("sessionId", status.sessionId),
        endedAt: status.endedAt ?? status.lastUpdate ?? Date.now(),
        synthesized: true,
        ...((status.steps?.length ?? 0) > steps.length
            ? { childrenOmitted: (status.steps?.length ?? 0) - steps.length }
            : {}),
        children,
    };
}
export function writeTerminalRecord(asyncDir, record) {
    writeAtomicJson(path.join(asyncDir, TERMINAL_RECORD_FILE), record);
    fs.rmSync(path.join(asyncDir, TERMINAL_RETRIEVAL_FILE), { force: true });
}
export function ensureTerminalRecordFromArtifact(candidate, runId) {
    if (!isTerminalArtifactFor(candidate, runId))
        return false;
    const artifact = candidate;
    const asyncDir = artifact.asyncDir;
    if (typeof asyncDir !== "string" || asyncDir.length === 0)
        return false;
    if (!fs.existsSync(asyncDir))
        return false;
    if (readTerminalRecord(asyncDir, artifact.id))
        return true;
    writeTerminalRecord(asyncDir, terminalRecordFromArtifact(artifact));
    return true;
}
export function tryWriteTerminalRecordFromArtifact(asyncDir, artifact) {
    try {
        writeTerminalRecord(asyncDir, terminalRecordFromArtifact(artifact));
    }
    catch (error) {
        console.error(`Failed to write terminal record in ${asyncDir}:`, error);
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isTerminalRecordFor(value, runId) {
    return (isRecord(value) &&
        value.version === TERMINAL_RECORD_VERSION &&
        value.runId === runId &&
        typeof value.revision === "string" &&
        value.revision.length > 0 &&
        Array.isArray(value.children));
}
function isTerminalArtifactFor(value, runId) {
    return (isRecord(value) &&
        value.id === runId &&
        isTerminalLifecycleState(value.state) &&
        Array.isArray(value.results));
}
export function readTerminalRecord(asyncDir, runId) {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(asyncDir, TERMINAL_RECORD_FILE), "utf-8"));
        if (isTerminalRecordFor(parsed, runId))
            return parsed;
    }
    catch {
    }
    return undefined;
}
function readResultsDirArtifact(resultsDir, runId) {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(resultsDir, `${runId}.json`), "utf-8"));
        if (isTerminalArtifactFor(parsed, runId))
            return parsed;
    }
    catch {
    }
    return undefined;
}
function finalizedForSynthesis(status, kill) {
    if (!isTerminalLifecycleState(status.state))
        return false;
    if (typeof status.endedAt !== "number" || !Number.isFinite(status.endedAt))
        return false;
    if (status.pid === undefined)
        return true;
    return checkPidLiveness(status.pid, kill) === "dead";
}
export function ensureTerminalRecord(asyncDir, status, options = {}) {
    if (!isTerminalLifecycleState(status.state))
        return undefined;
    const runId = status.runId || path.basename(asyncDir);
    const existing = readTerminalRecord(asyncDir, runId);
    if (existing)
        return existing;
    const artifact = readResultsDirArtifact(options.resultsDir ?? RESULTS_DIR, runId);
    try {
        if (artifact) {
            const record = terminalRecordFromArtifact(artifact);
            writeTerminalRecord(asyncDir, record);
            return record;
        }
        if (!finalizedForSynthesis(status, options.kill))
            return undefined;
        const record = terminalRecordFromStatus(status);
        writeTerminalRecord(asyncDir, record);
        return record;
    }
    catch {
        return undefined;
    }
}
function readRetrievalMarker(asyncDir, revision) {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(asyncDir, TERMINAL_RETRIEVAL_FILE), "utf-8"));
        if (isRecord(parsed) && parsed.revision === revision && Array.isArray(parsed.retrievedIndices))
            return {
                revision,
                retrievedIndices: parsed.retrievedIndices.filter((value) => Number.isInteger(value) && value >= 0),
            };
    }
    catch {
    }
    return { retrievedIndices: [] };
}
function hasRetrievalMarker(asyncDir, revision) {
    return readRetrievalMarker(asyncDir, revision).revision === revision;
}
export function markTerminalRecordRetrieved(asyncDir, record, indices) {
    if (readTerminalRecord(asyncDir, record.runId)?.revision !== record.revision)
        return;
    const next = new Set(readRetrievalMarker(asyncDir, record.revision).retrievedIndices);
    for (const index of indices ?? record.children.map((child) => child.index))
        next.add(index);
    writeAtomicJson(path.join(asyncDir, TERMINAL_RETRIEVAL_FILE), {
        revision: record.revision,
        retrievedAt: Date.now(),
        retrievedIndices: [...next].sort((a, b) => a - b),
    });
}
export function hasUnretrievedTerminalRecord(asyncDir, record) {
    const retrieved = new Set(readRetrievalMarker(asyncDir, record.revision).retrievedIndices);
    return record.children.length === 0
        ? !hasRetrievalMarker(asyncDir, record.revision)
        : record.children.some((child) => !retrieved.has(child.index));
}
export function unretrievedChildIndices(asyncDir, record) {
    const retrieved = new Set(readRetrievalMarker(asyncDir, record.revision).retrievedIndices);
    return record.children.map((child) => child.index).filter((index) => !retrieved.has(index));
}
