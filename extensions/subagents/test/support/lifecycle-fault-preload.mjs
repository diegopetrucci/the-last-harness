import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const targetDir = process.env.TLH_TEST_LIFECYCLE_FAULT_DIR
  ? path.resolve(process.env.TLH_TEST_LIFECYCLE_FAULT_DIR)
  : undefined;
const targetGeneration = Number.parseInt(process.env.TLH_TEST_LIFECYCLE_FAULT_GENERATION ?? "", 10);
const markerPath = process.env.TLH_TEST_LIFECYCLE_FAULT_MARKER;
const diagnosticWriteFailure = process.env.TLH_TEST_LIFECYCLE_DIAGNOSTIC_WRITE_FAILURE === "1";
const causeMarker = process.env.TLH_TEST_LIFECYCLE_FAULT_CAUSE ?? "synthetic lifecycle fault";
const causeBytes = Number.parseInt(process.env.TLH_TEST_LIFECYCLE_FAULT_CAUSE_BYTES ?? "0", 10);

const originalWriteFileSync = fs.writeFileSync;
const originalAppendFileSync = fs.appendFileSync;
let faultFired = false;

function payloadText(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return undefined;
}

function lifecycleStatusPayload(filePath, data) {
  if (!targetDir || !Number.isSafeInteger(targetGeneration)) return undefined;
  if (typeof filePath !== "string") return undefined;
  const resolvedPath = path.resolve(filePath);
  if (path.dirname(resolvedPath) !== targetDir) return undefined;
  const baseName = path.basename(resolvedPath);
  if (!baseName.startsWith(".status.json.") || !baseName.endsWith(".tmp")) return undefined;
  try {
    const parsed = JSON.parse(payloadText(data) ?? "");
    if (parsed?.lifecycle?.generation !== targetGeneration) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeFaultMarker(filePath, status) {
  if (!markerPath) return;
  originalWriteFileSync(
    markerPath,
    JSON.stringify({
      filePath,
      generation: status.lifecycle.generation,
      state: status.state,
    }),
    "utf8",
  );
}

function makeEnospcError() {
  const suffix = Number.isSafeInteger(causeBytes) && causeBytes > 0 ? "x".repeat(causeBytes) : "";
  const nested = new Error(`nested ${causeMarker}`);
  const error = new Error(`${causeMarker}${suffix}`, { cause: nested });
  error.code = "ENOSPC";
  error.syscall = "write";
  return error;
}

fs.writeFileSync = function patchedWriteFileSync(filePath, data, ...options) {
  const status = lifecycleStatusPayload(filePath, data);
  if (status && !faultFired) {
    faultFired = true;
    writeFaultMarker(filePath, status);
    throw makeEnospcError();
  }
  return originalWriteFileSync(filePath, data, ...options);
};

fs.appendFileSync = function patchedAppendFileSync(filePath, data, ...options) {
  if (
    diagnosticWriteFailure &&
    typeof filePath === "string" &&
    path.basename(filePath) === "events.jsonl" &&
    typeof payloadText(data) === "string" &&
    payloadText(data).includes('"subagent.run.lifecycle_transition_failed"')
  ) {
    const error = new Error("synthetic diagnostic append failure");
    error.code = "EIO";
    throw error;
  }
  return originalAppendFileSync(filePath, data, ...options);
};

syncBuiltinESMExports();
