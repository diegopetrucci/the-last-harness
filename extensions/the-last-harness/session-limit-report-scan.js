import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const DEFAULT_WINDOW_DURATION_MS = 5 * 60 * 60 * 1000;
const SUBAGENT_ARTIFACTS_DIR = "subagent-artifacts";
export function resolveSessionLimitWindow(snapshot, nowMs = Date.now()) {
    const sessionWindow = snapshot?.windows?.session;
    if (sessionWindow) {
        const resetsAtMs = sessionWindow.resetsAt ? Date.parse(sessionWindow.resetsAt) : NaN;
        if (Number.isFinite(resetsAtMs)) {
            const durationMs = sessionWindow.durationMs ?? DEFAULT_WINDOW_DURATION_MS;
            return {
                startMs: resetsAtMs - durationMs,
                endMs: resetsAtMs,
                source: "snapshot",
            };
        }
    }
    return {
        startMs: nowMs - DEFAULT_WINDOW_DURATION_MS,
        endMs: nowMs,
        source: "fallback",
    };
}
export function discoverSessionFiles(sessionsRoot, windowStartMs) {
    const files = [];
    const caveats = [];
    let projectDirs;
    try {
        projectDirs = readdirSync(sessionsRoot, { withFileTypes: true, encoding: "utf8" })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(sessionsRoot, entry.name));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        caveats.push(`Could not read sessions root: ${message}`);
        return { files, caveats };
    }
    for (const projectDir of projectDirs) {
        collectSessionFilesFromProjectDir(projectDir, windowStartMs, files, caveats);
    }
    return { files, caveats };
}
function collectSessionFilesFromProjectDir(projectDir, windowStartMs, files, caveats) {
    let entries;
    try {
        entries = readdirSync(projectDir, { withFileTypes: true, encoding: "utf8" });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        caveats.push(`Could not read project directory: ${message}`);
        return;
    }
    for (const entry of entries) {
        const entryPath = join(projectDir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === SUBAGENT_ARTIFACTS_DIR) {
                continue;
            }
            collectSessionFilesRecursive(entryPath, windowStartMs, files, caveats);
            continue;
        }
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            collectIfFresh(entryPath, windowStartMs, files, caveats);
        }
    }
}
function collectSessionFilesRecursive(dir, windowStartMs, files, caveats) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        caveats.push(`Could not read directory: ${message}`);
        return;
    }
    for (const entry of entries) {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === SUBAGENT_ARTIFACTS_DIR) {
                continue;
            }
            collectSessionFilesRecursive(entryPath, windowStartMs, files, caveats);
            continue;
        }
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            collectIfFresh(entryPath, windowStartMs, files, caveats);
        }
    }
}
function collectIfFresh(filePath, windowStartMs, files, caveats) {
    try {
        const st = statSync(filePath);
        if (st.mtimeMs >= windowStartMs) {
            files.push(filePath);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        caveats.push(`Could not stat file ${filePath}: ${message}`);
    }
}
export async function parseSessionJsonl(filePath) {
    let raw;
    try {
        raw = await readFile(filePath, "utf8");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not read session file ${filePath}: ${message}`, { cause: error });
    }
    const entries = [];
    let malformedLineCount = 0;
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            continue;
        }
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed !== null &&
                typeof parsed === "object" &&
                !Array.isArray(parsed) &&
                typeof parsed.type === "string") {
                entries.push(parsed);
            }
            else {
                malformedLineCount += 1;
            }
        }
        catch {
            malformedLineCount += 1;
        }
    }
    return { entries, malformedLineCount };
}
