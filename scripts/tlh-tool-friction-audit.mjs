#!/usr/bin/env node
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { discoverSessionFiles, parseSessionJsonl } from "../extensions/the-last-harness/session-limit-report-scan.js";
export const LARGE_OUTPUT_THRESHOLD_CHARACTERS = 50_000;
const RATE_DENOMINATOR_LABEL = "per-1000-tool-results";
const RATE_DENOMINATOR_MULTIPLIER = 1_000;
export const PATH_MISS_ERROR_RE = /ENOENT|Path not found|Search path .* is not a directory|No such file or directory/i;
export const EDIT_NON_UNIQUE_RE = /Found \d+ occurrences/i;
export const EDIT_VALIDATION_RE = /Validation failed for tool "edit"/i;
export const EDIT_NOT_FOUND_RE = /Could not find the exact text/i;
export const MISSING_PYTHON_ERROR_RE = /python(?:3)?: (?:command )?not found|command not found: python\b/i;
export const INVALID_REGEX_ERROR_RE = /regex parse error|invalid regex|invalid regular expression/i;
export const UNSUPPORTED_COMPOUND_FIND_ERROR_RE = /rtk: rtk find does not support compound predicates or actions/i;
export async function auditToolFriction(options) {
    const window = resolveAuditWindow(options.startIso, options.endIso);
    const sessionRoots = options.sessionRoots.map((root) => resolve(root));
    if (sessionRoots.length === 0) {
        throw new Error("At least one --session-root is required.");
    }
    const seenFingerprints = new Set();
    const uniqueFiles = new Set();
    const toolBreakdown = new Map();
    const counts = {
        pathMisses: 0,
        editFailures: 0,
        missingPython: 0,
        invalidRegex: 0,
        unsupportedCompoundFind: 0,
        largeOutput: 0,
    };
    const editSubtypeCounts = {
        "non-unique": 0,
        validation: 0,
        "not-found": 0,
    };
    let filesParsed = 0;
    let parseFailures = 0;
    let discoveryCaveatCount = 0;
    let malformedLines = 0;
    let rawInWindow = 0;
    let uniqueInWindow = 0;
    let errorResults = 0;
    let duplicateLogicalResultsSkipped = 0;
    let largeOutputTotalCharacters = 0;
    let largeOutputTotalUtf8Bytes = 0;
    let largeOutputMaxCharacters = 0;
    let largeOutputMaxUtf8Bytes = 0;
    for (const sessionRoot of sessionRoots) {
        // Explicit ISO bounds are the source of truth for inclusion. Avoid mtime pruning so
        // copied/exported session trees with stale mtimes are still audited deterministically.
        const discovered = discoverSessionFiles(sessionRoot, 0);
        discoveryCaveatCount += discovered.caveats.length;
        for (const filePath of discovered.files) {
            uniqueFiles.add(filePath);
        }
    }
    const discoveredFiles = [...uniqueFiles].sort((a, b) => a.localeCompare(b));
    for (const filePath of discoveredFiles) {
        let parsed;
        try {
            parsed = await parseSessionJsonl(filePath);
        }
        catch {
            parseFailures += 1;
            continue;
        }
        filesParsed += 1;
        malformedLines += parsed.malformedLineCount;
        for (const entry of parsed.entries) {
            const toolResult = getToolResultView(entry);
            if (!toolResult) {
                continue;
            }
            const entryMs = Date.parse(toolResult.timestamp);
            if (!Number.isFinite(entryMs) || entryMs < window.startMs || entryMs > window.endMs) {
                continue;
            }
            rawInWindow += 1;
            const fingerprint = createResultFingerprint(toolResult);
            if (seenFingerprints.has(fingerprint)) {
                duplicateLogicalResultsSkipped += 1;
                continue;
            }
            seenFingerprints.add(fingerprint);
            uniqueInWindow += 1;
            const toolCounts = getOrCreateToolBreakdown(toolBreakdown, toolResult.toolName);
            toolCounts.uniqueToolResults += 1;
            if (toolResult.isError) {
                errorResults += 1;
                toolCounts.errorToolResults += 1;
            }
            if (toolResult.isError && PATH_MISS_ERROR_RE.test(toolResult.joinedText)) {
                counts.pathMisses += 1;
                toolCounts.pathMisses += 1;
            }
            if (toolResult.isError && toolResult.toolName === "edit") {
                const editSubtype = classifyEditFailureSubtype(toolResult.joinedText);
                if (editSubtype) {
                    counts.editFailures += 1;
                    editSubtypeCounts[editSubtype] += 1;
                    toolCounts.editFailures += 1;
                }
            }
            if (toolResult.isError && MISSING_PYTHON_ERROR_RE.test(toolResult.joinedText)) {
                counts.missingPython += 1;
                toolCounts.missingPython += 1;
            }
            if (toolResult.isError && INVALID_REGEX_ERROR_RE.test(toolResult.joinedText)) {
                counts.invalidRegex += 1;
                toolCounts.invalidRegex += 1;
            }
            if (toolResult.isError && UNSUPPORTED_COMPOUND_FIND_ERROR_RE.test(toolResult.joinedText)) {
                counts.unsupportedCompoundFind += 1;
                toolCounts.unsupportedCompoundFind += 1;
            }
            const characterCount = toolResult.joinedText.length;
            if (characterCount >= LARGE_OUTPUT_THRESHOLD_CHARACTERS) {
                const utf8Bytes = Buffer.byteLength(toolResult.joinedText, "utf8");
                counts.largeOutput += 1;
                toolCounts.largeOutput += 1;
                largeOutputTotalCharacters += characterCount;
                largeOutputTotalUtf8Bytes += utf8Bytes;
                largeOutputMaxCharacters = Math.max(largeOutputMaxCharacters, characterCount);
                largeOutputMaxUtf8Bytes = Math.max(largeOutputMaxUtf8Bytes, utf8Bytes);
            }
        }
    }
    const result = {
        schemaVersion: 1,
        window: {
            startIso: new Date(window.startMs).toISOString(),
            endIso: new Date(window.endMs).toISOString(),
            inclusive: true,
        },
        inputs: {
            sessionRootCount: sessionRoots.length,
        },
        scan: {
            filesDiscovered: discoveredFiles.length,
            filesParsed,
            parseFailures,
            discoveryCaveatCount,
            malformedLines,
        },
        toolResults: {
            rawInWindow,
            uniqueInWindow,
            duplicateLogicalResultsSkipped,
            errorResults,
            rateDenominator: {
                label: RATE_DENOMINATOR_LABEL,
                multiplier: RATE_DENOMINATOR_MULTIPLIER,
            },
        },
        friction: {
            pathMisses: buildBreakdown(counts.pathMisses, uniqueInWindow),
            editFailures: {
                ...buildBreakdown(counts.editFailures, uniqueInWindow),
                subtypes: {
                    "non-unique": buildBreakdown(editSubtypeCounts["non-unique"], uniqueInWindow),
                    validation: buildBreakdown(editSubtypeCounts.validation, uniqueInWindow),
                    "not-found": buildBreakdown(editSubtypeCounts["not-found"], uniqueInWindow),
                },
            },
            missingPython: buildBreakdown(counts.missingPython, uniqueInWindow),
            invalidRegex: buildBreakdown(counts.invalidRegex, uniqueInWindow),
            unsupportedCompoundFind: buildBreakdown(counts.unsupportedCompoundFind, uniqueInWindow),
            largeOutput: {
                ...buildBreakdown(counts.largeOutput, uniqueInWindow),
                thresholdCharacters: LARGE_OUTPUT_THRESHOLD_CHARACTERS,
                thresholdLabel: "50,000 characters",
                totalCharacters: largeOutputTotalCharacters,
                totalUtf8Bytes: largeOutputTotalUtf8Bytes,
                maxCharacters: largeOutputMaxCharacters,
                maxUtf8Bytes: largeOutputMaxUtf8Bytes,
            },
        },
        toolBreakdown: [...toolBreakdown.values()].sort((left, right) => {
            if (right.uniqueToolResults !== left.uniqueToolResults) {
                return right.uniqueToolResults - left.uniqueToolResults;
            }
            return left.toolName.localeCompare(right.toolName);
        }),
    };
    return result;
}
function resolveAuditWindow(startIso, endIso) {
    const startMs = Date.parse(startIso);
    if (!Number.isFinite(startMs)) {
        throw new Error(`Invalid --start ISO timestamp: ${startIso}`);
    }
    const endMs = Date.parse(endIso);
    if (!Number.isFinite(endMs)) {
        throw new Error(`Invalid --end ISO timestamp: ${endIso}`);
    }
    if (startMs > endMs) {
        throw new Error("--start must be less than or equal to --end.");
    }
    return { startMs, endMs };
}
function buildBreakdown(count, toolResultsDenominator) {
    return {
        count,
        ratePer1000ToolResults: toolResultsDenominator > 0 ? Number(((count / toolResultsDenominator) * 1_000).toFixed(2)) : 0,
        toolResultsDenominator,
    };
}
function classifyEditFailureSubtype(joinedText) {
    if (EDIT_NON_UNIQUE_RE.test(joinedText)) {
        return "non-unique";
    }
    if (EDIT_VALIDATION_RE.test(joinedText)) {
        return "validation";
    }
    if (EDIT_NOT_FOUND_RE.test(joinedText)) {
        return "not-found";
    }
    return null;
}
function createResultFingerprint(toolResult) {
    return createHash("sha256")
        .update(toolResult.timestamp)
        .update("\u0000")
        .update(toolResult.toolName)
        .update("\u0000")
        .update(String(toolResult.isError))
        .update("\u0000")
        .update(toolResult.joinedText)
        .digest("hex");
}
function getOrCreateToolBreakdown(toolBreakdown, toolName) {
    let counts = toolBreakdown.get(toolName);
    if (counts) {
        return counts;
    }
    counts = {
        toolName,
        uniqueToolResults: 0,
        errorToolResults: 0,
        pathMisses: 0,
        editFailures: 0,
        missingPython: 0,
        invalidRegex: 0,
        unsupportedCompoundFind: 0,
        largeOutput: 0,
    };
    toolBreakdown.set(toolName, counts);
    return counts;
}
function getToolResultView(entry) {
    if (entry.type !== "message") {
        return null;
    }
    const message = entry.message;
    if (!isRecord(message) || message.role !== "toolResult") {
        return null;
    }
    if (typeof entry.timestamp !== "string") {
        return null;
    }
    return {
        timestamp: entry.timestamp,
        toolName: typeof message.toolName === "string" && message.toolName.length > 0 ? message.toolName : "unknown",
        isError: message.isError === true,
        joinedText: joinToolResultText(message.content),
    };
}
function joinToolResultText(content) {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .map((part) => {
        if (typeof part === "string") {
            return part;
        }
        if (isRecord(part) && typeof part.text === "string") {
            return part.text;
        }
        return "";
    })
        .filter((part) => part.length > 0)
        .join("\n");
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function usage() {
    return [
        "Usage: node scripts/tlh-tool-friction-audit.mjs --session-root <path> [--session-root <path> ...] --start <iso> --end <iso>",
        "",
        "Audit aggregate TLH tool-friction counts across exported session JSONL roots.",
        "",
        "Options:",
        "  --session-root <path>  Session root to scan (repeatable, required)",
        "  --start <iso>          Inclusive ISO-8601 lower bound (required)",
        "  --end <iso>            Inclusive ISO-8601 upper bound (required)",
        "  -h, --help             Show this help",
    ].join("\n");
}
export function parseArgs(argv) {
    const args = {
        sessionRoots: [],
        startIso: "",
        endIso: "",
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "-h" || arg === "--help") {
            args.help = true;
            continue;
        }
        if (arg === "--session-root") {
            args.sessionRoots.push(readRequiredValue(argv, ++index, arg));
            continue;
        }
        if (arg.startsWith("--session-root=")) {
            const value = arg.slice("--session-root=".length);
            if (!value) {
                throw new Error("--session-root requires a value");
            }
            args.sessionRoots.push(value);
            continue;
        }
        if (arg === "--start") {
            args.startIso = readRequiredValue(argv, ++index, arg);
            continue;
        }
        if (arg.startsWith("--start=")) {
            args.startIso = arg.slice("--start=".length);
            if (!args.startIso) {
                throw new Error("--start requires a value");
            }
            continue;
        }
        if (arg === "--end") {
            args.endIso = readRequiredValue(argv, ++index, arg);
            continue;
        }
        if (arg.startsWith("--end=")) {
            args.endIso = arg.slice("--end=".length);
            if (!args.endIso) {
                throw new Error("--end requires a value");
            }
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    if (!args.help) {
        if (args.sessionRoots.length === 0) {
            throw new Error("At least one --session-root is required.");
        }
        if (!args.startIso) {
            throw new Error("--start is required.");
        }
        if (!args.endIso) {
            throw new Error("--end is required.");
        }
    }
    return args;
}
function readRequiredValue(argv, index, flag) {
    const value = argv[index];
    if (!value) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}
export async function runCli(argv) {
    try {
        const args = parseArgs(argv);
        if (args.help) {
            process.stdout.write(`${usage()}\n`);
            return 0;
        }
        const result = await auditToolFriction(args);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n\n${usage()}\n`);
        return 1;
    }
}
const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
    const exitCode = await runCli(process.argv.slice(2));
    if (exitCode !== 0) {
        process.exitCode = exitCode;
    }
}
