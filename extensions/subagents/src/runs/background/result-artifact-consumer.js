import * as fs from "node:fs";
import * as path from "node:path";
const CLAIM_SUFFIX = ".claim";
export const RESULT_ARTIFACT_CLAIM_CLEANUP_MAX_ATTEMPTS = 5;
const RESULT_ARTIFACT_CLAIM_CLEANUP_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000];
export function resultArtifactClaimCleanupDelayMs(attempt) {
    const index = Math.max(0, Math.min(attempt, RESULT_ARTIFACT_CLAIM_CLEANUP_RETRY_DELAYS_MS.length - 1));
    return RESULT_ARTIFACT_CLAIM_CLEANUP_RETRY_DELAYS_MS[index] ?? 100;
}
function claimErrorCode(error) {
    return error instanceof Error && "code" in error
        ? error.code
        : undefined;
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
function wrapClaimError(operation, normalizedPath, error) {
    const wrapped = new Error(`Could not ${operation} result artifact '${normalizedPath}': ${errorText(error)}`, { cause: error });
    Object.defineProperty(wrapped, "resultArtifactOperation", {
        configurable: false,
        enumerable: false,
        value: operation,
        writable: false,
    });
    const code = claimErrorCode(error);
    if (code) {
        Object.defineProperty(wrapped, "code", {
            configurable: true,
            enumerable: false,
            value: code,
            writable: false,
        });
    }
    return wrapped;
}
function removeClaimMarker(fsApi, claimPath, normalizedPath) {
    try {
        fsApi.unlinkSync(claimPath);
        return true;
    }
    catch (error) {
        if (claimErrorCode(error) === "ENOENT")
            return true;
        throw wrapClaimError("remove claim sidecar", normalizedPath, error);
    }
}
export function claimResultArtifact(resultPath, fsApi = fs) {
    const normalizedPath = path.resolve(resultPath);
    const claimPath = `${normalizedPath}${CLAIM_SUFFIX}`;
    let resultExists;
    try {
        resultExists = fsApi.existsSync(normalizedPath);
    }
    catch (error) {
        throw wrapClaimError("check", normalizedPath, error);
    }
    if (!resultExists)
        return undefined;
    let descriptor;
    try {
        descriptor = fsApi.openSync(claimPath, "wx", 0o600);
    }
    catch (error) {
        if (claimErrorCode(error) === "EEXIST")
            return undefined;
        throw wrapClaimError("claim", normalizedPath, error);
    }
    try {
        fsApi.closeSync(descriptor);
    }
    catch (error) {
        try {
            removeClaimMarker(fsApi, claimPath, normalizedPath);
        }
        catch {
        }
        throw wrapClaimError("close claim sidecar", normalizedPath, error);
    }
    let decision = "held";
    return {
        path: normalizedPath,
        release() {
            if (decision === "committed" || decision === "released")
                return true;
            try {
                const released = removeClaimMarker(fsApi, claimPath, normalizedPath);
                decision = "released";
                return released;
            }
            catch (error) {
                decision = "held";
                throw error;
            }
        },
        commit() {
            decision = "committed";
            let artifactExists;
            try {
                artifactExists = fsApi.existsSync(normalizedPath);
            }
            catch (error) {
                throw wrapClaimError("verify delivered", normalizedPath, error);
            }
            if (artifactExists)
                return false;
            return removeClaimMarker(fsApi, claimPath, normalizedPath);
        },
    };
}
export function isResultArtifactClaimError(error) {
    return (error instanceof Error &&
        "resultArtifactOperation" in error &&
        typeof error.resultArtifactOperation === "string");
}
