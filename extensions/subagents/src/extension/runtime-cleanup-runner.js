import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupRuntimeDirs } from "./runtime-cleanup.js";
import { RUNTIME_CLEANUP_MARKER_NAME } from "./runtime-cleanup-constants.js";
import { TEMP_ROOT_DIR } from "../shared/types.js";
export function runCleanupRunner(deps = {}) {
    const cleanup = deps.cleanup ?? cleanupRuntimeDirs;
    const markerPath = deps.markerPath ?? path.join(TEMP_ROOT_DIR, RUNTIME_CLEANUP_MARKER_NAME);
    const now = deps.now ?? (() => Date.now());
    const exit = deps.exit ?? ((code) => process.exit(code));
    try {
        cleanup();
    }
    catch (error) {
        process.stderr.write(`[pi-subagents] runtime-cleanup-runner: cleanupRuntimeDirs failed: ${error instanceof Error ? error.message : String(error)}\n`);
        exit(1);
        return;
    }
    try {
        const ts = new Date(now());
        fs.utimesSync(markerPath, ts, ts);
    }
    catch {
    }
}
function _realpath(p) {
    try {
        return fs.realpathSync(p);
    }
    catch {
        return path.resolve(p);
    }
}
const _thisFile = fileURLToPath(import.meta.url);
if (_realpath(process.argv[1] ?? "") === _realpath(_thisFile)) {
    runCleanupRunner();
}
