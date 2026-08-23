import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
class AsyncStatusCorruptionError extends Error {
    name = "AsyncStatusCorruptionError";
    kind;
    asyncDir;
    statusPath;
    fingerprint;
    constructor(input) {
        super(input.message, input.cause ? { cause: input.cause } : undefined);
        this.kind = input.kind;
        this.asyncDir = input.asyncDir;
        this.statusPath = input.statusPath ?? path.join(input.asyncDir, "status.json");
        this.fingerprint =
            input.fingerprint ??
                (typeof input.content === "string"
                    ? fingerprintAsyncStatusContent(input.content)
                    : undefined);
    }
}
export function fingerprintAsyncStatusContent(content) {
    return Object.freeze({
        algorithm: "sha256",
        value: createHash("sha256").update(content, "utf8").digest("hex"),
    });
}
export function fingerprintAsyncStatusFile(asyncDir, statusPath = path.join(asyncDir, "status.json")) {
    try {
        return fingerprintAsyncStatusContent(fs.readFileSync(statusPath, "utf-8"));
    }
    catch {
        return undefined;
    }
}
export function isAsyncStatusCorruptionError(error) {
    return error instanceof AsyncStatusCorruptionError;
}
export function createAsyncStatusJsonParseError(input) {
    const cause = input.cause instanceof Error ? input.cause : new Error(String(input.cause));
    const statusPath = input.statusPath ?? path.join(input.asyncDir, "status.json");
    return new AsyncStatusCorruptionError({
        message: `Failed to parse async status file '${statusPath}': ${cause.message}`,
        kind: "json_parse",
        asyncDir: input.asyncDir,
        statusPath,
        content: input.content,
        cause,
    });
}
export function createAsyncStatusValidationError(input) {
    const statusPath = input.statusPath ?? path.join(input.asyncDir, "status.json");
    return new AsyncStatusCorruptionError({
        message: `Invalid async status '${statusPath}': ${input.message}`,
        kind: "persisted_validation",
        asyncDir: input.asyncDir,
        statusPath,
        fingerprint: input.fingerprint,
    });
}
