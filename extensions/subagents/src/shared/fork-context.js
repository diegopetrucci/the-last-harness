import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
export function resolveSubagentContext(value) {
    return value === "fork" ? "fork" : "fresh";
}
function isUnsafeAnthropicThinkingBlock(message, block) {
    if (!message || !block || typeof block !== "object" || !("type" in block))
        return false;
    const blockRecord = block;
    const provider = typeof message.provider === "string" ? message.provider.toLowerCase() : "";
    const api = typeof message.api === "string" ? message.api.toLowerCase() : "";
    const model = typeof message.model === "string" ? message.model.toLowerCase() : "";
    const isAnthropic = provider === "anthropic" || api === "anthropic-messages" || model.startsWith("anthropic/");
    if (blockRecord.type === "redacted_thinking")
        return true;
    if (blockRecord.type !== "thinking" || !isAnthropic)
        return false;
    const signature = typeof blockRecord.thinkingSignature === "string"
        ? blockRecord.thinkingSignature
        : typeof blockRecord.signature === "string"
            ? blockRecord.signature
            : undefined;
    return blockRecord.redacted === true || (typeof signature === "string" && signature.length > 0);
}
function createEntryId(entries) {
    const ids = new Set(entries.map((entry) => entry.id).filter((id) => typeof id === "string"));
    for (let attempt = 0; attempt < 100; attempt++) {
        const id = randomUUID().slice(0, 8);
        if (!ids.has(id))
            return id;
    }
    return randomUUID();
}
function appendThinkingOffEntry(entries) {
    const last = entries[entries.length - 1];
    if (last?.type === "thinking_level_change" && last.thinkingLevel === "off")
        return;
    const parent = [...entries].reverse().find((entry) => typeof entry.id === "string");
    entries.push({
        type: "thinking_level_change",
        id: createEntryId(entries),
        parentId: parent?.id ?? null,
        timestamp: new Date().toISOString(),
        thinkingLevel: "off",
    });
}
function sanitizeUnsafeThinkingBlocks(entries) {
    let sanitized = false;
    for (const entry of entries) {
        if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content))
            continue;
        const filtered = entry.message.content.filter((block) => !isUnsafeAnthropicThinkingBlock(entry.message, block));
        if (filtered.length === entry.message.content.length)
            continue;
        entry.message.content = filtered;
        sanitized = true;
    }
    if (sanitized)
        appendThinkingOffEntry(entries);
    return sanitized;
}
function readSessionEntries(sessionFile) {
    const lines = fs
        .readFileSync(sessionFile, "utf-8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
    return lines.map((line, index) => {
        try {
            return JSON.parse(line);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Unable to inspect forked session ${sessionFile}: invalid JSONL on line ${index + 1}: ${message}`, { cause: error });
        }
    });
}
export function createForkContextResolver(sessionManager, requestedContext, options = {}) {
    if (resolveSubagentContext(requestedContext) !== "fork") {
        return {
            sessionFileForIndex: () => undefined,
            thinkingOverrideForIndex: () => undefined,
        };
    }
    const parentSessionFile = sessionManager.getSessionFile();
    if (!parentSessionFile) {
        throw new Error("Forked subagent context requires a persisted parent session.");
    }
    const leafId = sessionManager.getLeafId();
    if (!leafId) {
        throw new Error("Forked subagent context requires a current leaf to fork from.");
    }
    const openSession = options.openSession ??
        sessionManager.openSession ??
        ((file, dir) => SessionManager.open(file, dir));
    const sessionDir = sessionManager.getSessionDir?.();
    const cachedResolutions = new Map();
    const resolveFork = (index = 0) => {
        const cached = cachedResolutions.get(index);
        if (cached)
            return cached;
        try {
            if (!fs.existsSync(parentSessionFile)) {
                throw new Error(`Parent session file does not exist: ${parentSessionFile}. Pi has not persisted enough history to fork yet.`);
            }
            const sourceManager = openSession(parentSessionFile, sessionDir);
            const sessionFile = sourceManager.createBranchedSession(leafId);
            if (!sessionFile) {
                throw new Error("Session manager did not return a forked session file.");
            }
            let thinkingOverride;
            if (!fs.existsSync(sessionFile)) {
                const header = sourceManager.getHeader?.();
                const entries = sourceManager.getEntries?.();
                if (!header || !entries) {
                    throw new Error(`Session manager returned a forked session file that does not exist and cannot be persisted by fallback: ${sessionFile}`);
                }
                if (sanitizeUnsafeThinkingBlocks(entries))
                    thinkingOverride = "off";
                fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
                fs.writeFileSync(sessionFile, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
            }
            else {
                const entries = readSessionEntries(sessionFile);
                if (sanitizeUnsafeThinkingBlocks(entries)) {
                    thinkingOverride = "off";
                    fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
                }
            }
            const resolution = { sessionFile, ...(thinkingOverride ? { thinkingOverride } : {}) };
            cachedResolutions.set(index, resolution);
            return resolution;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to create forked subagent session: ${message}`, { cause: error });
        }
    };
    return {
        sessionFileForIndex(index = 0) {
            return resolveFork(index).sessionFile;
        },
        thinkingOverrideForIndex(index = 0) {
            return resolveFork(index).thinkingOverride;
        },
    };
}
