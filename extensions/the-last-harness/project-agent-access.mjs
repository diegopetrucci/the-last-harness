/**
 * Process-private bridge for the trusted project-agent snapshot.
 *
 * The snapshot capability never crosses the model-facing subagent parameter
 * boundary. The provider below is installed by the TLH primary runtime and is
 * queried only by the local subagent executor.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let activeProjectAgentAccessProvider;
let activeProjectAgentSnapshotOperations;
const PROJECT_AGENT_SNAPSHOT_OPERATIONS_KEY = Symbol.for(
  "the-last-harness.project-agent-snapshot-operations",
);

function isSnapshotOperations(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.retainSnapshotReference === "function" &&
    typeof value.releaseSnapshotReference === "function" &&
    typeof value.releaseRunReferencesForSession === "function" &&
    typeof value.getRunReferenceMetadata === "function" &&
    typeof value.lookupRunReference === "function"
  );
}

function sanitizeTempScopeSegment(value) {
  const sanitized = String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return sanitized || "unknown";
}

function resolveTempScopeId() {
  if (typeof process.getuid === "function") {
    try {
      return `uid-${process.getuid()}`;
    } catch {
      // Continue with the portable identity fallbacks.
    }
  }
  for (const key of ["USERNAME", "USER", "LOGNAME"]) {
    const value = process.env[key];
    if (value) return `user-${sanitizeTempScopeSegment(value)}`;
  }
  try {
    const username = os.userInfo().username;
    if (username) return `user-${sanitizeTempScopeSegment(username)}`;
  } catch {
    // Fall through to home-directory-based scoping.
  }
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) return `home-${sanitizeTempScopeSegment(home)}`;
  try {
    const fallbackHome = os.homedir();
    if (fallbackHome) return `home-${sanitizeTempScopeSegment(fallbackHome)}`;
  } catch {
    // Fall through to the last-resort shared scope.
  }
  return "shared";
}

function asyncRoots() {
  const override = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  const tempRoot = override || path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
  return {
    asyncDir: path.join(tempRoot, "async-subagent-runs"),
    resultsDir: path.join(tempRoot, "async-subagent-results"),
  };
}

function pathInsideRoot(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertRunId(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error("id must not be empty.");
  if (path.isAbsolute(value) || /[\\/]/u.test(value) || value.includes("..")) {
    throw new Error("id must be an async run id or prefix, not a path.");
  }
  return value;
}

function exactResultPath(resultsDir, runId) {
  const resultPath = path.join(resultsDir, `${runId}.json`);
  if (!pathInsideRoot(resultsDir, resultPath))
    throw new Error("Async result file is outside its root.");
  return fs.existsSync(resultPath) ? resultPath : null;
}

function prefixedRunIds(dir, prefix, suffix = "") {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.startsWith(prefix) && (!suffix || entry.endsWith(suffix)))
    .map((entry) => (suffix ? entry.slice(0, -suffix.length) : entry))
    .sort();
}

function resolveMarkerLocation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("project-agent control input must be an object.");
  }
  const params = input;
  const requestedId = assertRunId(params.id);
  const roots = asyncRoots();
  if (params.dir) {
    if (typeof params.dir !== "string" || params.dir.trim() === "") {
      throw new Error("dir must be a non-empty path.");
    }
    const asyncDir = path.resolve(params.dir);
    if (!pathInsideRoot(roots.asyncDir, asyncDir)) {
      throw new Error("Async run directory must be inside its root.");
    }
    const resolvedId = requestedId ?? path.basename(asyncDir);
    if (requestedId && requestedId !== path.basename(asyncDir)) {
      throw new Error("Async run id does not match its directory.");
    }
    return { asyncDir, resultPath: exactResultPath(roots.resultsDir, resolvedId) };
  }
  if (!requestedId) return { asyncDir: null, resultPath: null };

  const directAsyncDir = path.join(roots.asyncDir, requestedId);
  if (!pathInsideRoot(roots.asyncDir, directAsyncDir)) {
    throw new Error("Async run directory must be inside its root.");
  }
  const directResultPath = exactResultPath(roots.resultsDir, requestedId);
  if (fs.existsSync(directAsyncDir) || directResultPath) {
    return {
      asyncDir: fs.existsSync(directAsyncDir) ? directAsyncDir : null,
      resultPath: directResultPath,
    };
  }

  const matchingIds = [
    ...new Set([
      ...prefixedRunIds(roots.asyncDir, requestedId),
      ...prefixedRunIds(roots.resultsDir, requestedId, ".json"),
    ]),
  ].sort();
  if (matchingIds.length > 1) throw new Error("Async run id prefix is ambiguous.");
  const resolvedId = matchingIds[0];
  if (!resolvedId) return { asyncDir: null, resultPath: null };
  return {
    asyncDir: fs.existsSync(path.join(roots.asyncDir, resolvedId))
      ? path.join(roots.asyncDir, resolvedId)
      : null,
    resultPath: exactResultPath(roots.resultsDir, resolvedId),
  };
}

function hasPersistedProjectAgentMarker(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.hasOwn(value, "projectAgent") || Object.hasOwn(value, "projectAgents")) return true;
  for (const field of ["steps", "results", "children", "nestedChildren"]) {
    const children = value[field];
    if (
      Array.isArray(children) &&
      children.some((child) => hasPersistedProjectAgentMarker(child))
    ) {
      return true;
    }
  }
  return false;
}

function persistedProjectAgentMarkerFromFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? "absent" : "unavailable";
  }
  try {
    return hasPersistedProjectAgentMarker(JSON.parse(content)) ? "present" : "absent";
  } catch {
    return /["']projectAgents?["']\s*:/u.test(content) ? "present" : "unavailable";
  }
}

function probeProjectAgentRunMarker(input) {
  try {
    const location = resolveMarkerLocation(input);
    const files = [
      location.asyncDir ? path.join(location.asyncDir, "status.json") : undefined,
      location.resultPath ?? undefined,
    ].filter(Boolean);
    if (files.length === 0) return { status: "absent" };
    let unavailable = false;
    for (const filePath of files) {
      const result = persistedProjectAgentMarkerFromFile(filePath);
      if (result === "present") return { status: "present" };
      if (result === "unavailable") unavailable = true;
    }
    return { status: unavailable ? "unavailable" : "absent" };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * @param {((request: unknown) => unknown) | undefined} provider
 */
export function setTlhProjectAgentAccessProvider(provider) {
  activeProjectAgentAccessProvider = typeof provider === "function" ? provider : undefined;
}

/**
 * @param {unknown} request
 * @returns {unknown}
 */
export function getTlhProjectAgentAccess(request) {
  const provider = activeProjectAgentAccessProvider;
  if (!provider) return undefined;
  try {
    return provider(request);
  } catch {
    // An unavailable bridge is never permission to execute a project agent.
    return undefined;
  }
}

/**
 * Install host/jiti-owned snapshot operations. Keeping these callbacks in the
 * host graph prevents this native bridge from loading a second copy of the
 * process-private snapshot registry.
 */
export function setTlhProjectAgentSnapshotOperations(operations) {
  activeProjectAgentSnapshotOperations = isSnapshotOperations(operations) ? operations : undefined;
}

function requireSnapshotOperation(name) {
  const globalOperations = globalThis[PROJECT_AGENT_SNAPSHOT_OPERATIONS_KEY];
  const operations = activeProjectAgentSnapshotOperations ?? globalOperations;
  const operation = operations?.[name];
  if (typeof operation !== "function") {
    throw new Error("Project-agent snapshot operations are unavailable.");
  }
  return operation;
}

/** @param {unknown} capability @param {string} referenceId */
export async function retainTlhProjectAgentSnapshotReference(capability, referenceId) {
  requireSnapshotOperation("retainSnapshotReference")(capability, referenceId);
}

/** @param {string} referenceId */
export async function releaseTlhProjectAgentSnapshotReference(referenceId) {
  requireSnapshotOperation("releaseSnapshotReference")(referenceId);
}

/** @param {string} sessionId */
export async function releaseTlhProjectAgentRunReferencesForSession(sessionId) {
  requireSnapshotOperation("releaseRunReferencesForSession")(sessionId);
}

/** @param {string} runId */
export async function getTlhProjectAgentRunReferenceMetadata(runId) {
  return requireSnapshotOperation("getRunReferenceMetadata")(runId);
}

/** @param {string} runId */
export async function lookupTlhProjectAgentRunReference(runId) {
  return requireSnapshotOperation("lookupRunReference")(runId);
}

/**
 * Read-only deny signal for persisted project-agent control markers. This
 * native implementation intentionally performs no full async-run parsing; it
 * only detects a persisted project marker and can never authorize a control.
 *
 * @param {{ id?: string, dir?: string | null }} input
 * @returns {Promise<{status: "present" | "absent" | "unavailable"}>}
 */
export async function probeTlhProjectAgentRunMarker(input) {
  return probeProjectAgentRunMarker(input);
}
