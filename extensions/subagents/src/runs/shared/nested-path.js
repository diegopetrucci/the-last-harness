import * as path from "node:path";
const MAX_NESTED_ID_LENGTH = 128;
export const MAX_NESTED_PATH_ENTRIES = 4;
export function isSafeNestedPathId(value) {
    return typeof value === "string"
        && value.length > 0
        && value.length <= MAX_NESTED_ID_LENGTH
        && !path.isAbsolute(value)
        && !value.includes("/")
        && !value.includes("\\")
        && !value.includes("..");
}
function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function nonEmptyString(value, max) {
    return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}
export function sanitizeNestedPath(value) {
    if (!Array.isArray(value))
        return [];
    return value.map((part) => {
        if (!part || typeof part !== "object")
            return undefined;
        const record = part;
        if (!isSafeNestedPathId(record.runId))
            return undefined;
        return {
            runId: record.runId,
            ...(finiteNumber(record.stepIndex) !== undefined ? { stepIndex: finiteNumber(record.stepIndex) } : {}),
            ...(nonEmptyString(record.agent, 128) ? { agent: nonEmptyString(record.agent, 128) } : {}),
        };
    }).filter((part) => Boolean(part)).slice(0, MAX_NESTED_PATH_ENTRIES);
}
export function parseNestedPathEnv(value) {
    if (!value)
        return [];
    try {
        return sanitizeNestedPath(JSON.parse(value));
    }
    catch {
        return [];
    }
}
export function encodeNestedPathEnv(value) {
    const sanitized = sanitizeNestedPath(value);
    return sanitized.length ? JSON.stringify(sanitized) : "";
}
