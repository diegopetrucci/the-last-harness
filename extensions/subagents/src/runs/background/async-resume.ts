import * as fs from "node:fs";
import * as path from "node:path";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  type AsyncResultArtifact,
  type AsyncStatus,
} from "../../shared/types.ts";
import {
  lifecycleContinuationForIndex,
  normalizeActiveRuntimeCheckpointAt,
  normalizeActiveRuntimeMs,
  recoverStaleLifecycleContinuationClaim,
} from "../shared/lifecycle-state.ts";
import {
  normalizeProjectAgentRunCapture,
  type ProjectAgentRunCapture,
} from "../../agents/project-agent-snapshot.ts";
import { reconcileAsyncRun } from "./stale-run-reconciler.ts";
import { normalizeTkTicketMetadata } from "../shared/tk-ticket.ts";
import {
  canonicalSubagentModelIdentity,
  sanitizeSubagentModelIdentity,
  sanitizeSubagentModelResolution,
} from "../shared/model-fallback.ts";
import type {
  ContextPressureProjection,
  ContextUsageDiagnostics,
  SubagentModelIdentity,
  SubagentModelResolution,
  SubagentTerminationReason,
} from "../../shared/types.ts";
import {
  parseContextPressureCrossedThresholds,
  parseContextPressureProjection,
  parseContextUsageDiagnostics,
  parseSubagentTerminationReason,
} from "../../shared/context-diagnostics.ts";
import { parseThinkingLevel } from "../../shared/model-info.ts";
import { readStatus } from "../../shared/utils.ts";

/**
 * Guards against a persisted `skipped` acceptance ledger whose `effectiveAcceptance`
 * is malformed or partial (e.g. missing the required arrays, or arrays holding
 * malformed elements). Without this check a partial/corrupt config would flow into
 * mergeContinuationAcceptance/formatAcceptancePrompt, which spread and dereference
 * base.criteria/verify/evidence/stopRules elements (e.g. criterion.id) and throw an
 * unhandled TypeError, or silently weaken the acceptance contract. Mirrors the exact
 * shape the runner always writes via resolveAcceptanceConfig/buildSkippedAcceptanceLedger:
 * `level` (string), `explicit` (boolean), and the always-present arrays
 * inferredReason/criteria/evidence/verify/stopRules with well-typed elements.
 * `review` and `reason` are legitimately optional and are not required here.
 * Only fields the runner ALWAYS writes are required at element level:
 *  - criteria: ResolvedAcceptanceGate — required el.id: string (optional must/evidence/severity not required)
 *  - verify: AcceptanceVerifyCommand — required el.command: string
 *  - evidence/stopRules/inferredReason: string elements
 * Empty arrays pass vacuously.
 */
function isStringArray(x: unknown): boolean {
  return Array.isArray(x) && x.every((el) => typeof el === "string");
}

function isWellFormedResolvedAcceptance(
  x: unknown,
): x is import("../../shared/types.ts").ResolvedAcceptanceConfig {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.level === "string" &&
    typeof c.explicit === "boolean" &&
    isStringArray(c.inferredReason) &&
    isStringArray(c.evidence) &&
    isStringArray(c.stopRules) &&
    Array.isArray(c.criteria) &&
    c.criteria.every(
      (el) =>
        typeof el === "object" &&
        el !== null &&
        !Array.isArray(el) &&
        typeof (el as Record<string, unknown>).id === "string",
    ) &&
    Array.isArray(c.verify) &&
    c.verify.every(
      (el) =>
        typeof el === "object" &&
        el !== null &&
        !Array.isArray(el) &&
        typeof (el as Record<string, unknown>).command === "string",
    )
  );
}

function resolvePausedContinuationAcceptance(
  runId: string,
  acceptance: unknown,
): import("../../shared/types.ts").ResolvedAcceptanceConfig | undefined {
  if (typeof acceptance !== "object" || acceptance === null || Array.isArray(acceptance)) {
    throw new Error(
      `Async run '${runId}' is paused but its persisted acceptance ledger is incomplete or malformed; refusing to resume with an unverified acceptance contract.`,
    );
  }
  const ledger = acceptance as { status?: unknown; effectiveAcceptance?: unknown };
  if (!isWellFormedResolvedAcceptance(ledger.effectiveAcceptance)) {
    throw new Error(
      `Async run '${runId}' is paused but its persisted acceptance ledger is incomplete or malformed; refusing to resume with an unverified acceptance contract.`,
    );
  }
  if (ledger.status === "skipped") {
    if (ledger.effectiveAcceptance.level === "none") {
      throw new Error(
        `Async run '${runId}' is paused but its persisted acceptance ledger is incompatible with continuation resume: status 'skipped' cannot carry effective level 'none'.`,
      );
    }
    return ledger.effectiveAcceptance;
  }
  if (ledger.status === "not-required") {
    if (ledger.effectiveAcceptance.level !== "none") {
      throw new Error(
        `Async run '${runId}' is paused but its persisted acceptance ledger is incompatible with continuation resume: status 'not-required' must carry effective level 'none'.`,
      );
    }
    return undefined;
  }
  const persistedStatus = typeof ledger.status === "string" ? ledger.status : "unknown";
  throw new Error(
    `Async run '${runId}' is paused but its persisted acceptance ledger status '${persistedStatus}' is incompatible with continuation resume; expected 'skipped' or 'not-required'.`,
  );
}

interface AsyncResumeParams {
  id?: string;
  dir?: string;
  index?: number;
}

interface AsyncResumeDeps {
  asyncDirRoot?: string;
  resultsDir?: string;
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  now?: () => number;
}

interface AsyncResumeOptions {
  requireSessionFile?: boolean;
  /** Read persisted state without repairing lifecycle metadata before a resume gate. */
  readOnly?: boolean;
}

type AsyncResumeTarget = {
  kind: "live" | "revive";
  runId: string;
  asyncDir?: string;
  state: AsyncStatus["state"];
  agent: string;
  index: number;
  cwd?: string;
  sessionFile?: string;
  tkTicket?: import("../../shared/types.ts").TkTicketMetadata;
  modelIdentity?: SubagentModelIdentity;
  modelResolution?: SubagentModelResolution;
  contextUsage?: ContextUsageDiagnostics;
  contextPressure?: ContextPressureProjection;
  contextPressureCrossedThresholds?: import("../../shared/types.ts").ContextPressureThreshold[];
  terminationReason?: SubagentTerminationReason;
  pauseKind?: import("../../shared/types.ts").AsyncPauseState;
  claimed?: boolean;
  continuationAcceptance?: import("../../shared/types.ts").ResolvedAcceptanceConfig;
  activeRuntimeMs?: number;
  activeRuntimeCheckpointAt?: number;
  /** Selected-child success, independent of the aggregate async lifecycle state. */
  successfulCompletion?: boolean;
  projectAgent?: ProjectAgentRunCapture;
  /** Present only when the persisted run carried a run-level project inventory. */
  projectAgents?: ProjectAgentRunCapture[];
};

/**
 * Defensive top-level widener: makes every field optional and widens
 * string-literal-union values to `string` for safe untrusted-JSON parsing.
 * Array items are shallow-widened one level deep.
 */
type Defensive<T> = {
  [K in keyof T]?: T[K] extends string
    ? string
    : T[K] extends Array<infer U>
      ? Array<{ [IK in keyof U]?: U[IK] extends string ? string : U[IK] }>
      : T[K];
};

/**
 * All-optional defensive reader type derived from the canonical
 * AsyncResultArtifact so that field renames are caught at compile time.
 * Every field is optional because the file may be truncated or malformed.
 *
 * Legacy top-level fields (runId, model, thinking, modelIdentity,
 * modelResolution, contextUsage, contextPressure,
 * contextPressureCrossedThresholds) were written by older result formats;
 * the current writers only emit these inside results items.
 */
type AsyncResultFile = Defensive<AsyncResultArtifact> & {
  // Legacy top-level reader fields not present in current writer output.
  runId?: string;
  model?: string;
  thinking?: string;
  modelIdentity?: SubagentModelIdentity;
  modelResolution?: SubagentModelResolution;
  contextUsage?: ContextUsageDiagnostics;
  contextPressure?: ContextPressureProjection;
  contextPressureCrossedThresholds?: import("../../shared/types.ts").ContextPressureThreshold[];
  projectAgent?: ProjectAgentRunCapture;
  projectAgents?: ProjectAgentRunCapture[];
  // Override results to add legacy per-item `thinking` field (written by
  // older runners but not part of the current canonical result item type).
  results?: Array<
    {
      [
        IK in keyof import("../../shared/types.ts").AsyncResultArtifactResultItem
      ]?: import("../../shared/types.ts").AsyncResultArtifactResultItem[IK] extends string
        ? string
        : import("../../shared/types.ts").AsyncResultArtifactResultItem[IK];
    } & { thinking?: string }
  >;
};

type AsyncStatusStep = NonNullable<AsyncStatus["steps"]>[number];
type AsyncResultStep = NonNullable<AsyncResultFile["results"]>[number];

type AsyncResumeModelMetadata = Pick<AsyncResumeTarget, "modelIdentity" | "modelResolution">;

type AsyncResumeDiagnosticMetadata = Pick<
  AsyncResumeTarget,
  "contextUsage" | "contextPressure" | "contextPressureCrossedThresholds" | "terminationReason"
>;

interface AsyncResumeResolutionContext {
  asyncDirRoot: string;
  resultsDir: string;
  requireSessionFile: boolean;
  location: AsyncRunLocation;
  status: AsyncStatus | null;
  result?: AsyncResultFile;
  runId: string;
  state: AsyncStatus["state"];
  statusSteps: AsyncStatusStep[];
  resultSteps: AsyncResultStep[];
  stepCount: number;
  requestedIndex?: number;
  deps: AsyncResumeDeps;
  options: AsyncResumeOptions;
  tkTicket?: import("../../shared/types.ts").TkTicketMetadata;
}

const RESUME_TERMINAL_STEP_STATUSES = new Set(["complete", "completed", "failed", "paused"]);

export interface AsyncRunLocation {
  asyncDir: string | null;
  resultPath: string | null;
  resolvedId?: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureObject(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Async result file '${source}' must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function validateOptionalString(
  value: Record<string, unknown>,
  field: string,
  source: string,
  displayField = field,
): string | undefined {
  const fieldValue = value[field];
  if (fieldValue === undefined) return undefined;
  if (typeof fieldValue !== "string")
    throw new Error(`Invalid async result file '${source}': ${displayField} must be a string.`);
  return fieldValue;
}

function validateModelIdentity(
  value: unknown,
  source: string,
  field: string,
): SubagentModelIdentity | undefined {
  if (value === undefined) return undefined;
  const identity = sanitizeSubagentModelIdentity(value);
  if (!identity) {
    throw new Error(
      `Invalid async result file '${source}': ${field} must contain a provider and model.`,
    );
  }
  return identity;
}

function validateModelResolution(
  value: unknown,
  source: string,
  field: string,
): SubagentModelResolution | undefined {
  if (value === undefined) return undefined;
  const resolution = sanitizeSubagentModelResolution(value);
  if (!resolution) {
    throw new Error(`Invalid async result file '${source}': ${field} is invalid.`);
  }
  return resolution;
}

function parseResultModelIdentity(
  value: unknown,
  source: string,
  field: string,
): SubagentModelIdentity | undefined {
  try {
    return validateModelIdentity(value, source, field);
  } catch {
    return undefined;
  }
}

function parseResultModelResolution(
  value: unknown,
  source: string,
  field: string,
): SubagentModelResolution | undefined {
  try {
    return validateModelResolution(value, source, field);
  } catch {
    return undefined;
  }
}

function validateResultFile(value: unknown, resultPath: string): AsyncResultFile {
  const data = ensureObject(value, resultPath);
  const resultsValue = data.results;
  let results: AsyncResultFile["results"];
  if (resultsValue !== undefined) {
    if (!Array.isArray(resultsValue))
      throw new Error(`Invalid async result file '${resultPath}': results must be an array.`);
    results = resultsValue.map((entry, index) => {
      const child = ensureObject(entry, `${resultPath} results[${index}]`);
      const agent = validateOptionalString(child, "agent", resultPath, `results[${index}].agent`);
      const sessionFile = validateOptionalString(
        child,
        "sessionFile",
        resultPath,
        `results[${index}].sessionFile`,
      );
      const model = validateOptionalString(child, "model", resultPath, `results[${index}].model`);
      const thinking = parseThinkingLevel(child.thinking);
      const modelIdentity = parseResultModelIdentity(
        child.modelIdentity,
        resultPath,
        `results[${index}].modelIdentity`,
      );
      const modelResolution = parseResultModelResolution(
        child.modelResolution,
        resultPath,
        `results[${index}].modelResolution`,
      );
      // Result-only artifacts are recovered best-effort: these optional
      // diagnostics were added after legacy result files were already in use.
      // Status validation remains strict, while malformed result diagnostics are
      // omitted so session/acceptance recovery can continue.
      const contextUsage = parseContextUsageDiagnostics(child.contextUsage);
      const contextPressure = parseContextPressureProjection(child.contextPressure);
      const contextPressureCrossedThresholds = parseContextPressureCrossedThresholds(
        child.contextPressureCrossedThresholds,
      );
      const terminationReason = parseSubagentTerminationReason(child.terminationReason);
      const success = child.success;
      if (success !== undefined && typeof success !== "boolean")
        throw new Error(
          `Invalid async result file '${resultPath}': results[${index}].success must be a boolean.`,
        );
      const interrupted = child.interrupted;
      if (interrupted !== undefined && typeof interrupted !== "boolean")
        throw new Error(
          `Invalid async result file '${resultPath}': results[${index}].interrupted must be a boolean.`,
        );
      const activeRuntimeMs = child.activeRuntimeMs;
      if (
        activeRuntimeMs !== undefined &&
        (typeof activeRuntimeMs !== "number" ||
          !Number.isFinite(activeRuntimeMs) ||
          activeRuntimeMs < 0)
      ) {
        throw new Error(
          `Invalid async result file '${resultPath}': results[${index}].activeRuntimeMs must be a non-negative finite number.`,
        );
      }
      // Checkpoint timestamps are optional diagnostics. Invalid external values
      // are unknown and must not affect continuation selection.
      const activeRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(
        child.activeRuntimeCheckpointAt,
      );
      // Acceptance is accepted opaquely — the caller validates contract fields.
      const acceptance =
        child.acceptance !== undefined &&
        typeof child.acceptance === "object" &&
        !Array.isArray(child.acceptance)
          ? (child.acceptance as import("../../shared/types.ts").AcceptanceLedger)
          : undefined;
      const projectAgent = parseProjectAgentCapture(
        child.projectAgent,
        resultPath,
        `results[${index}].projectAgent`,
      );
      return {
        agent,
        sessionFile,
        ...(typeof success === "boolean" ? { success } : {}),
        ...(typeof interrupted === "boolean" ? { interrupted } : {}),
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
        ...(modelIdentity ? { modelIdentity } : {}),
        ...(modelResolution ? { modelResolution } : {}),
        ...(contextUsage ? { contextUsage } : {}),
        ...(contextPressure ? { contextPressure } : {}),
        ...(contextPressureCrossedThresholds ? { contextPressureCrossedThresholds } : {}),
        ...(terminationReason ? { terminationReason } : {}),
        ...(typeof activeRuntimeMs === "number" ? { activeRuntimeMs } : {}),
        ...(activeRuntimeCheckpointAt !== undefined ? { activeRuntimeCheckpointAt } : {}),
        ...(acceptance ? { acceptance } : {}),
        ...(projectAgent ? { projectAgent } : {}),
      };
    });
  }
  const success = data.success;
  if (success !== undefined && typeof success !== "boolean")
    throw new Error(`Invalid async result file '${resultPath}': success must be a boolean.`);
  const projectAgent =
    data.projectAgent === undefined
      ? undefined
      : parseProjectAgentCapture(data.projectAgent, resultPath, "projectAgent");
  const projectAgents = data.projectAgents;
  if (projectAgents !== undefined && !Array.isArray(projectAgents)) {
    throw new Error(`Invalid async result file '${resultPath}': projectAgents must be an array.`);
  }
  const normalizedProjectAgents = projectAgents
    ?.map((capture, index) =>
      parseProjectAgentCapture(capture, resultPath, `projectAgents[${index}]`),
    )
    .filter((capture): capture is ProjectAgentRunCapture => Boolean(capture));
  const activeRuntimeMs = normalizeActiveRuntimeMs(data.activeRuntimeMs);
  const activeRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(
    data.activeRuntimeCheckpointAt,
  );
  return {
    id: validateOptionalString(data, "id", resultPath),
    runId: validateOptionalString(data, "runId", resultPath),
    agent: validateOptionalString(data, "agent", resultPath),
    mode: validateOptionalString(data, "mode", resultPath),
    state: validateOptionalString(data, "state", resultPath),
    cwd: validateOptionalString(data, "cwd", resultPath),
    sessionFile: validateOptionalString(data, "sessionFile", resultPath),
    model: validateOptionalString(data, "model", resultPath),
    thinking: parseThinkingLevel(data.thinking),
    modelIdentity: parseResultModelIdentity(data.modelIdentity, resultPath, "modelIdentity"),
    modelResolution: parseResultModelResolution(
      data.modelResolution,
      resultPath,
      "modelResolution",
    ),
    ...(parseContextUsageDiagnostics(data.contextUsage)
      ? { contextUsage: parseContextUsageDiagnostics(data.contextUsage) }
      : {}),
    ...(parseContextPressureProjection(data.contextPressure)
      ? { contextPressure: parseContextPressureProjection(data.contextPressure) }
      : {}),
    ...(parseContextPressureCrossedThresholds(data.contextPressureCrossedThresholds)
      ? {
          contextPressureCrossedThresholds: parseContextPressureCrossedThresholds(
            data.contextPressureCrossedThresholds,
          ),
        }
      : {}),
    ...(typeof success === "boolean" ? { success } : {}),
    ...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
    ...(activeRuntimeCheckpointAt !== undefined ? { activeRuntimeCheckpointAt } : {}),
    ...(results ? { results } : {}),
    ...(projectAgent ? { projectAgent } : {}),
    ...(normalizedProjectAgents ? { projectAgents: normalizedProjectAgents } : {}),
  };
}

function parseProjectAgentCapture(
  value: unknown,
  source: string,
  field: string,
): ProjectAgentRunCapture | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeProjectAgentRunCapture(value);
  if (!normalized) throw new Error(`Invalid async result file '${source}': ${field} is invalid.`);
  return normalized;
}

function readResultFile(resultPath: string): AsyncResultFile {
  let raw: string;
  try {
    raw = fs.readFileSync(resultPath, "utf-8");
  } catch (error) {
    throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
      cause: error,
    });
  }
  try {
    return validateResultFile(JSON.parse(raw), resultPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Failed to parse async result file '${resultPath}': ${getErrorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

function assertRunId(value: string | undefined, field: "id"): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") throw new Error(`${field} must not be empty.`);
  if (path.isAbsolute(value) || /[\\/]/.test(value) || value.includes("..")) {
    throw new Error(`${field} must be an async run id or prefix, not a path.`);
  }
  return value;
}

function assertInsideRoot(root: string, target: string, label: string): void {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(target);
  const relative = path.relative(rootPath, targetPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${label} must be inside ${rootPath}.`);
}

function prefixedRunIds(dir: string, prefix: string, suffix = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.startsWith(prefix) && (!suffix || entry.endsWith(suffix)))
    .map((entry) => (suffix ? entry.slice(0, -suffix.length) : entry))
    .sort();
}

function exactResultPath(resultsDir: string, runId: string): string | null {
  const resultPath = path.join(resultsDir, `${runId}.json`);
  assertInsideRoot(resultsDir, resultPath, "Async result file");
  return fs.existsSync(resultPath) ? resultPath : null;
}

export function findAsyncRunPrefixMatches(
  prefix: string,
  asyncDirRoot: string,
  resultsDir: string,
): Array<{ id: string; location: AsyncRunLocation }> {
  const requestedId = assertRunId(prefix, "id");
  if (!requestedId) return [];
  const asyncRoot = path.resolve(asyncDirRoot);
  const resultRoot = path.resolve(resultsDir);
  const matchingIds = [
    ...new Set([
      ...prefixedRunIds(asyncRoot, requestedId),
      ...prefixedRunIds(resultRoot, requestedId, ".json"),
    ]),
  ].sort();
  return matchingIds.map((id) => {
    const asyncDir = path.join(asyncRoot, id);
    assertInsideRoot(asyncRoot, asyncDir, "Async run directory");
    return {
      id,
      location: {
        asyncDir: fs.existsSync(asyncDir) ? asyncDir : null,
        resultPath: exactResultPath(resultRoot, id),
        resolvedId: id,
      },
    };
  });
}

export function resolveAsyncRunLocation(
  params: AsyncResumeParams,
  asyncDirRoot: string,
  resultsDir: string,
): AsyncRunLocation {
  const asyncRoot = path.resolve(asyncDirRoot);
  const resultRoot = path.resolve(resultsDir);
  const requestedId = assertRunId(params.id, "id");
  if (params.dir) {
    const asyncDir = path.resolve(params.dir);
    assertInsideRoot(asyncRoot, asyncDir, "Async run directory");
    const resolvedId = requestedId ?? path.basename(asyncDir);
    if (requestedId && requestedId !== path.basename(asyncDir)) {
      throw new Error(
        `Async run id '${requestedId}' does not match directory '${path.basename(asyncDir)}'.`,
      );
    }
    return { asyncDir, resultPath: exactResultPath(resultRoot, resolvedId), resolvedId };
  }
  if (!requestedId) return { asyncDir: null, resultPath: null };

  const directAsyncDir = path.join(asyncRoot, requestedId);
  assertInsideRoot(asyncRoot, directAsyncDir, "Async run directory");
  const directResultPath = exactResultPath(resultRoot, requestedId);
  if (fs.existsSync(directAsyncDir) || directResultPath) {
    return {
      asyncDir: fs.existsSync(directAsyncDir) ? directAsyncDir : null,
      resultPath: directResultPath,
      resolvedId: requestedId,
    };
  }

  const matching = findAsyncRunPrefixMatches(requestedId, asyncRoot, resultRoot);
  if (matching.length === 0) return { asyncDir: null, resultPath: null, resolvedId: requestedId };
  if (matching.length > 1) {
    throw new Error(
      `Ambiguous async run id prefix '${requestedId}' matched: ${matching.map((match) => match.id).join(", ")}. Provide a longer id.`,
    );
  }
  return matching[0]!.location;
}

/**
 * Read one optional object property without asserting through an intermediate
 * unknown value. This keeps the untrusted persisted boundary explicit.
 */
function ownObjectProperty(value: unknown, key: string): { present: boolean; value: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { present: false, value: undefined };
  }
  const record = value as Record<string, unknown>;
  return { present: Object.hasOwn(record, key), value: record[key] };
}

/**
 * Detect project-agent fields in persisted control data without granting any
 * authority. This intentionally recognizes even malformed marker values: a
 * missing process-private reference must deny rather than downgrade a control
 * request to profile behavior.
 */
function hasPersistedProjectAgentMarker(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "projectAgent") || Object.hasOwn(record, "projectAgents")) {
    return true;
  }
  for (const field of ["steps", "results", "children", "nestedChildren"] as const) {
    const children = record[field];
    if (
      Array.isArray(children) &&
      children.some((child) => hasPersistedProjectAgentMarker(child))
    ) {
      return true;
    }
  }
  return false;
}

function persistedProjectAgentMarkerFromFile(
  filePath: string,
): "present" | "absent" | "unavailable" {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable";
  }
  try {
    return hasPersistedProjectAgentMarker(JSON.parse(content)) ? "present" : "absent";
  } catch {
    // A malformed artifact with marker-shaped bytes is still denied. A
    // malformed artifact without a marker will fail its normal parser later.
    return /["']projectAgents?["']\s*:/.test(content) ? "present" : "unavailable";
  }
}

export type AsyncProjectAgentMarkerProbe = {
  status: "present" | "absent" | "unavailable";
};

/**
 * Narrow, read-only probe used by the primary hook before its executor. It
 * reuses canonical async id/path resolution and never returns a capability or
 * config; the result can only deny a potentially project-owned control.
 */
export function probeAsyncRunForProjectAgentMarker(
  params: AsyncResumeParams,
  deps: Pick<AsyncResumeDeps, "asyncDirRoot" | "resultsDir"> = {},
): AsyncProjectAgentMarkerProbe {
  let location: AsyncRunLocation;
  try {
    location = resolveAsyncRunLocation(
      params,
      deps.asyncDirRoot ?? ASYNC_DIR,
      deps.resultsDir ?? RESULTS_DIR,
    );
  } catch {
    return { status: "unavailable" };
  }
  // Exercise the canonical status/result parser first. Its result is not used
  // as authority and may legitimately fail for a terminal or malformed run;
  // the raw known-field scan below preserves the deny-only marker signal.
  try {
    resolveAsyncResumeTarget(
      params,
      {
        asyncDirRoot: deps.asyncDirRoot ?? ASYNC_DIR,
        resultsDir: deps.resultsDir ?? RESULTS_DIR,
      },
      { requireSessionFile: false, readOnly: true },
    );
  } catch {
    // Continue to the marker-only scan; parsing failures never authorize.
  }
  const files = [
    location.asyncDir ? path.join(location.asyncDir, "status.json") : undefined,
    location.resultPath ?? undefined,
  ].filter((filePath): filePath is string => Boolean(filePath));
  if (files.length === 0) return { status: "absent" };
  let unavailable = false;
  for (const filePath of files) {
    const result = persistedProjectAgentMarkerFromFile(filePath);
    if (result === "present") return { status: "present" };
    if (result === "unavailable") unavailable = true;
  }
  return { status: unavailable ? "unavailable" : "absent" };
}

function persistedModelIdentity(input: {
  identity?: unknown;
  model?: string;
  thinking?: unknown;
}): SubagentModelIdentity | undefined {
  return (
    sanitizeSubagentModelIdentity(input.identity) ??
    canonicalSubagentModelIdentity(input.model, parseThinkingLevel(input.thinking))
  );
}

function resultState(result: AsyncResultFile): AsyncStatus["state"] {
  if (
    result.state === "complete" ||
    result.state === "failed" ||
    result.state === "paused" ||
    result.state === "cancelled" ||
    result.state === "continued" ||
    result.state === "running" ||
    result.state === "queued" ||
    result.state === "pausing"
  ) {
    return result.state;
  }
  return result.success ? "complete" : "failed";
}

function validateStatusForResume(status: AsyncStatus | null, source: string): void {
  if (!status) return;
  if (typeof status.runId !== "string")
    throw new Error(`Invalid async status '${source}': runId must be a string.`);
  if (status.sessionId !== undefined && typeof status.sessionId !== "string")
    throw new Error(`Invalid async status '${source}': sessionId must be a string.`);
  if (status.cwd !== undefined && typeof status.cwd !== "string")
    throw new Error(`Invalid async status '${source}': cwd must be a string.`);
  if (status.sessionFile !== undefined && typeof status.sessionFile !== "string")
    throw new Error(`Invalid async status '${source}': sessionFile must be a string.`);
  const statusProjectAgent = ownObjectProperty(status, "projectAgent");
  if (statusProjectAgent.present) {
    if (!normalizeProjectAgentRunCapture(statusProjectAgent.value))
      throw new Error(`Invalid async status '${source}': projectAgent is invalid.`);
  }
  if (status.projectAgents !== undefined) {
    if (!Array.isArray(status.projectAgents))
      throw new Error(`Invalid async status '${source}': projectAgents must be an array.`);
    for (const [index, capture] of status.projectAgents.entries()) {
      if (!normalizeProjectAgentRunCapture(capture))
        throw new Error(`Invalid async status '${source}': projectAgents[${index}] is invalid.`);
    }
  }
  if (status.steps !== undefined) {
    if (!Array.isArray(status.steps))
      throw new Error(`Invalid async status '${source}': steps must be an array.`);
    status.steps.forEach((step, index) => {
      if (!step || typeof step !== "object" || Array.isArray(step))
        throw new Error(`Invalid async status '${source}': steps[${index}] must be an object.`);
      if (typeof step.agent !== "string")
        throw new Error(
          `Invalid async status '${source}': steps[${index}].agent must be a string.`,
        );
      if (step.sessionFile !== undefined && typeof step.sessionFile !== "string")
        throw new Error(
          `Invalid async status '${source}': steps[${index}].sessionFile must be a string.`,
        );
      if (step.projectAgent !== undefined && !normalizeProjectAgentRunCapture(step.projectAgent))
        throw new Error(
          `Invalid async status '${source}': steps[${index}].projectAgent is invalid.`,
        );
      if (step.model !== undefined && typeof step.model !== "string")
        throw new Error(
          `Invalid async status '${source}': steps[${index}].model must be a string.`,
        );
      if (step.thinking !== undefined && typeof step.thinking !== "string")
        throw new Error(
          `Invalid async status '${source}': steps[${index}].thinking must be a string.`,
        );
      validateModelIdentity(step.modelIdentity, source, `steps[${index}].modelIdentity`);
      validateModelResolution(step.modelResolution, source, `steps[${index}].modelResolution`);
      if (step.contextUsage !== undefined && !parseContextUsageDiagnostics(step.contextUsage))
        throw new Error(
          `Invalid async status '${source}': steps[${index}].contextUsage is invalid.`,
        );
      if (
        step.contextPressure !== undefined &&
        !parseContextPressureProjection(step.contextPressure)
      )
        throw new Error(
          `Invalid async status '${source}': steps[${index}].contextPressure is invalid.`,
        );
      if (
        step.contextPressureCrossedThresholds !== undefined &&
        !parseContextPressureCrossedThresholds(step.contextPressureCrossedThresholds)
      )
        throw new Error(
          `Invalid async status '${source}': steps[${index}].contextPressureCrossedThresholds is invalid.`,
        );
      if (
        step.terminationReason !== undefined &&
        !parseSubagentTerminationReason(step.terminationReason)
      )
        throw new Error(
          `Invalid async status '${source}': steps[${index}].terminationReason is invalid.`,
        );
    });
  }
}

function validateResumeSessionFile(
  runId: string,
  sessionFile: string,
  options: { allowMissing?: boolean } = {},
): string | undefined {
  if (path.extname(sessionFile) !== ".jsonl")
    throw new Error(`Async run '${runId}' session file must be a .jsonl file: ${sessionFile}`);
  const resolved = path.resolve(sessionFile);
  if (!fs.existsSync(resolved)) {
    if (options.allowMissing) return undefined;
    throw new Error(`Async run '${runId}' session file does not exist: ${sessionFile}`);
  }
  return resolved;
}

function resolveResumeModelMetadata(
  index: number,
  statusStep: AsyncStatusStep | undefined,
  resultSteps: AsyncResultStep[],
  result: AsyncResultFile | undefined,
): AsyncResumeModelMetadata {
  const resultStep = resultSteps[index];
  const modelIdentity =
    persistedModelIdentity({
      identity: statusStep?.modelIdentity,
      model: statusStep?.model,
      thinking: statusStep?.thinking,
    }) ??
    persistedModelIdentity({
      identity: resultStep?.modelIdentity,
      model: resultStep?.model,
      thinking: resultStep?.thinking,
    }) ??
    persistedModelIdentity({
      identity: result?.modelIdentity,
      model: result?.model,
      thinking: result?.thinking,
    });
  const modelResolution =
    sanitizeSubagentModelResolution(statusStep?.modelResolution) ??
    sanitizeSubagentModelResolution(resultStep?.modelResolution) ??
    sanitizeSubagentModelResolution(result?.modelResolution);
  return {
    ...(modelIdentity ? { modelIdentity } : {}),
    ...(modelResolution ? { modelResolution } : {}),
  };
}

function resolveResumeDiagnosticMetadata(
  index: number,
  statusStep: AsyncStatusStep | undefined,
  resultSteps: AsyncResultStep[],
  result: AsyncResultFile | undefined,
): AsyncResumeDiagnosticMetadata {
  const resultStep = resultSteps[index];
  const contextUsage =
    parseContextUsageDiagnostics(statusStep?.contextUsage) ??
    parseContextUsageDiagnostics(resultStep?.contextUsage) ??
    parseContextUsageDiagnostics(result?.contextUsage);
  const contextPressure =
    parseContextPressureProjection(statusStep?.contextPressure) ??
    parseContextPressureProjection(resultStep?.contextPressure) ??
    parseContextPressureProjection(result?.contextPressure);
  const contextPressureCrossedThresholds =
    parseContextPressureCrossedThresholds(statusStep?.contextPressureCrossedThresholds) ??
    parseContextPressureCrossedThresholds(resultStep?.contextPressureCrossedThresholds) ??
    parseContextPressureCrossedThresholds(result?.contextPressureCrossedThresholds);
  const terminationReason = statusStep?.terminationReason ?? resultStep?.terminationReason;
  return {
    ...(contextUsage ? { contextUsage } : {}),
    ...(contextPressure ? { contextPressure } : {}),
    ...(contextPressureCrossedThresholds ? { contextPressureCrossedThresholds } : {}),
    ...(terminationReason ? { terminationReason } : {}),
  };
}

type AsyncResumeProjectAgentMetadata = Pick<AsyncResumeTarget, "projectAgent" | "projectAgents">;

function resolveProjectAgentMetadata(
  context: AsyncResumeResolutionContext,
  index: number,
  statusStep: AsyncStatusStep | undefined,
): AsyncResumeProjectAgentMetadata {
  const selectedCandidate = statusStep?.projectAgent ?? context.resultSteps[index]?.projectAgent;
  let projectAgent: ProjectAgentRunCapture | undefined;
  if (selectedCandidate !== undefined) {
    projectAgent = normalizeProjectAgentRunCapture(selectedCandidate);
    if (!projectAgent) {
      throw new Error(`Invalid persisted project-agent capture for async run child ${index}.`);
    }
  }
  const topLevelProjectAgent =
    normalizeProjectAgentRunCapture(ownObjectProperty(context.status, "projectAgent").value) ??
    context.result?.projectAgent;
  const explicitProjectAgents = context.status?.projectAgents ?? context.result?.projectAgents;
  const childProjectAgents = [...context.statusSteps, ...context.resultSteps].flatMap((step) => {
    const candidate = step?.projectAgent;
    if (candidate === undefined) return [];
    const normalized = normalizeProjectAgentRunCapture(candidate);
    return normalized ? [normalized] : [];
  });
  const projectAgents =
    explicitProjectAgents ?? (childProjectAgents.length > 0 ? childProjectAgents : undefined);
  return {
    ...(topLevelProjectAgent ? { projectAgent: topLevelProjectAgent } : {}),
    ...(projectAgents !== undefined ? { projectAgents } : {}),
    ...(projectAgent ? { projectAgent } : {}),
  };
}

function buildLiveAsyncResumeTarget(
  context: AsyncResumeResolutionContext,
  index: number,
  statusStep: AsyncStatusStep,
): AsyncResumeTarget {
  const target: AsyncResumeTarget = {
    kind: "live",
    runId: context.runId,
    asyncDir: context.location.asyncDir ?? undefined,
    state: context.state,
    agent: statusStep.agent,
    index,
    cwd: context.status?.cwd ?? context.result?.cwd,
    sessionFile:
      statusStep.sessionFile ?? context.status?.sessionFile ?? context.result?.sessionFile,
  };
  const metadata = resolveResumeModelMetadata(
    index,
    statusStep,
    context.resultSteps,
    context.result,
  );
  const projectMetadata = resolveProjectAgentMetadata(context, index, statusStep);
  return {
    ...target,
    ...(projectMetadata.projectAgent ? { projectAgent: projectMetadata.projectAgent } : {}),
    ...(projectMetadata.projectAgents ? { projectAgents: projectMetadata.projectAgents } : {}),
    ...(metadata.modelIdentity ? { modelIdentity: metadata.modelIdentity } : {}),
    ...(metadata.modelResolution ? { modelResolution: metadata.modelResolution } : {}),
    ...(context.tkTicket ? { tkTicket: context.tkTicket } : {}),
  };
}

function resolveLiveAsyncResumeTarget(
  context: AsyncResumeResolutionContext,
): AsyncResumeTarget | undefined {
  const requestedIndex = context.requestedIndex;
  if (requestedIndex !== undefined) {
    if (requestedIndex < 0 || requestedIndex >= context.stepCount)
      throw new Error(
        `Async run '${context.runId}' has ${context.stepCount} children. Index ${requestedIndex} is out of range.`,
      );
    const selectedStep = context.statusSteps[requestedIndex];
    if (selectedStep?.status === "running")
      return buildLiveAsyncResumeTarget(context, requestedIndex, selectedStep);
    if (selectedStep?.status === "pending")
      throw new Error(
        `Async run '${context.runId}' child ${requestedIndex} is pending and has not started yet. Wait for it to run or complete before resuming.`,
      );
    if (selectedStep && !RESUME_TERMINAL_STEP_STATUSES.has(selectedStep.status))
      throw new Error(
        `Async run '${context.runId}' child ${requestedIndex} is ${selectedStep.status} and cannot be revived yet.`,
      );
    return undefined;
  }

  const running = context.statusSteps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.status === "running");
  const selected = running.length === 1 ? running[0] : undefined;
  if (!selected)
    throw new Error(
      `Async run '${context.runId}' has ${running.length} running children. Provide index to choose one.`,
    );
  return buildLiveAsyncResumeTarget(context, selected.index, selected.step);
}

function selectedChildSuccessfulCompletion(
  context: AsyncResumeResolutionContext,
  index: number,
): boolean {
  const statusStep = context.statusSteps[index];
  const resultStep = context.resultSteps[index];
  if (
    statusStep?.terminationReason === "interrupted" ||
    resultStep?.interrupted === true ||
    resultStep?.terminationReason === "interrupted"
  ) {
    return false;
  }
  const status = statusStep?.status;
  if (status !== undefined) {
    return status === "complete" || status === "completed";
  }
  const resultSuccess = resultStep?.success;
  if (typeof resultSuccess === "boolean") return resultSuccess;
  // Older single-child artifacts did not always persist per-child evidence.
  // Preserve their aggregate completion fallback without letting a failed
  // parallel cohort reset an unrelated child's runtime ledger.
  return context.stepCount === 1 && context.state === "complete";
}

function resolveTerminalAsyncResumeTarget(
  context: AsyncResumeResolutionContext,
): AsyncResumeTarget {
  const requestedIndex = context.requestedIndex;
  if (context.stepCount > 1 && requestedIndex === undefined) {
    throw new Error(
      `Async run '${context.runId}' has ${context.stepCount} children. Provide index to choose one.`,
    );
  }
  const index = requestedIndex ?? 0;
  if (!Number.isInteger(index))
    throw new Error(`Async run '${context.runId}' index must be an integer.`);
  if (index < 0 || index >= context.stepCount)
    throw new Error(
      `Async run '${context.runId}' has ${context.stepCount} children. Index ${index} is out of range.`,
    );

  let selectedStatusStep = context.statusSteps[index];
  let selectedContinuation = lifecycleContinuationForIndex(context.status, index);
  if (
    !context.options.readOnly &&
    typeof selectedContinuation?.claimToken === "string" &&
    selectedContinuation.claimToken.length > 0 &&
    context.location.asyncDir
  ) {
    const recovered = recoverStaleLifecycleContinuationClaim(context.location.asyncDir, index, {
      kill: context.deps.kill,
      now: context.deps.now,
      asyncDirRoot: context.asyncDirRoot,
      resultsDir: context.resultsDir,
    });
    if (recovered.recovered) {
      context.status = recovered.status ?? context.status;
      context.statusSteps = context.status?.steps ?? [];
      selectedStatusStep = context.statusSteps[index];
      selectedContinuation = lifecycleContinuationForIndex(context.status, index);
    }
  }

  if (context.state === "continued")
    throw new Error(
      `Async run '${context.runId}' already launched continuation '${selectedContinuation?.continuationRunId ?? context.status?.lifecycle?.continuation?.continuationRunId ?? "unknown"}' and cannot be resumed again.`,
    );
  if (selectedStatusStep?.status === "cancelled")
    throw new Error(
      `Async run '${context.runId}' child ${index} was cancelled and cannot be resumed.`,
    );
  if (selectedStatusStep?.status === "continued")
    throw new Error(
      `Async run '${context.runId}' child ${index} already launched its continuation and cannot be resumed again.`,
    );
  if (
    !context.options.readOnly &&
    typeof selectedContinuation?.claimToken === "string" &&
    selectedContinuation.claimToken.length > 0
  ) {
    const continuationRunId = selectedContinuation.continuationRunId;
    if (
      (selectedContinuation.phase === "reserved" || selectedContinuation.phase === "launched") &&
      continuationRunId
    ) {
      throw new Error(
        `Async run '${context.runId}' child ${index} already launched continuation '${continuationRunId}' and cannot be resumed again.`,
      );
    }
    throw new Error(
      `Async run '${context.runId}' child ${index} was already claimed for continuation and cannot be resumed again.`,
    );
  }

  const agent =
    selectedStatusStep?.agent ?? context.resultSteps[index]?.agent ?? context.result?.agent;
  if (!agent) throw new Error(`Could not determine child agent for async run '${context.runId}'.`);
  const sessionFile =
    context.statusSteps[index]?.sessionFile ??
    context.resultSteps[index]?.sessionFile ??
    (context.stepCount === 1
      ? (context.status?.sessionFile ?? context.result?.sessionFile)
      : undefined);
  const selectedChildPaused =
    context.statusSteps[index]?.status === "paused" ||
    (context.statusSteps.length === 0 &&
      context.state === "paused" &&
      context.resultSteps[index]?.interrupted === true);
  if (!sessionFile && context.requireSessionFile)
    throw new Error(
      `Async run '${context.runId}' child ${index} does not have a persisted session file to resume from.`,
    );
  const resolvedSessionFile = sessionFile
    ? validateResumeSessionFile(context.runId, sessionFile, { allowMissing: selectedChildPaused })
    : undefined;
  // When the status file is absent (result-only revival), read acceptance from the
  // result artifact’s per-child entry; otherwise mirror the status-path behaviour.
  const pausedStepAcceptance =
    context.statusSteps.length > 0
      ? context.statusSteps[index]?.acceptance
      : context.resultSteps[index]?.acceptance;
  if (selectedChildPaused && pausedStepAcceptance === undefined) {
    throw new Error(
      `Async run '${context.runId}' is paused but its skipped acceptance ledger has not been persisted yet. Retry the resume once pause metadata is written.`,
    );
  }
  // Fail closed at this common read site (covers both status and result-only paths)
  // so only explicitly compatible paused ledgers can resume without re-inferring a
  // contract, and malformed or terminal statuses never reach continuation merge logic.
  const continuationAcceptance = selectedChildPaused
    ? resolvePausedContinuationAcceptance(context.runId, pausedStepAcceptance)
    : undefined;
  const target: AsyncResumeTarget = {
    kind: "revive",
    runId: context.runId,
    asyncDir: context.location.asyncDir ?? undefined,
    state: context.state,
    agent,
    index,
    cwd: context.status?.cwd ?? context.result?.cwd,
    ...(resolvedSessionFile ? { sessionFile: resolvedSessionFile } : {}),
  };
  const modelMetadata = resolveResumeModelMetadata(
    index,
    selectedStatusStep,
    context.resultSteps,
    context.result,
  );
  const projectMetadata = resolveProjectAgentMetadata(context, index, selectedStatusStep);
  const targetWithModelMetadata: AsyncResumeTarget = {
    ...target,
    ...(projectMetadata.projectAgent ? { projectAgent: projectMetadata.projectAgent } : {}),
    ...(projectMetadata.projectAgents ? { projectAgents: projectMetadata.projectAgents } : {}),
    ...(modelMetadata.modelIdentity ? { modelIdentity: modelMetadata.modelIdentity } : {}),
    ...(modelMetadata.modelResolution ? { modelResolution: modelMetadata.modelResolution } : {}),
    ...(context.tkTicket ? { tkTicket: context.tkTicket } : {}),
    ...(selectedStatusStep?.pause?.kind
      ? { pauseKind: selectedStatusStep.pause.kind }
      : context.status?.pause?.kind
        ? { pauseKind: context.status.pause.kind }
        : {}),
    ...(typeof selectedContinuation?.claimToken === "string" &&
    selectedContinuation.claimToken.length > 0
      ? { claimed: true }
      : {}),
    ...(continuationAcceptance ? { continuationAcceptance } : {}),
  };
  const diagnosticMetadata = resolveResumeDiagnosticMetadata(
    index,
    selectedStatusStep,
    context.resultSteps,
    context.result,
  );
  const successfulCompletion = selectedChildSuccessfulCompletion(context, index);
  const selectedActiveRuntimeMs = normalizeActiveRuntimeMs(selectedStatusStep?.activeRuntimeMs);
  const resultActiveRuntimeMs = normalizeActiveRuntimeMs(
    context.resultSteps[index]?.activeRuntimeMs,
  );
  const selectedActiveRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(
    selectedStatusStep?.activeRuntimeCheckpointAt,
  );
  const resultActiveRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(
    context.resultSteps[index]?.activeRuntimeCheckpointAt,
  );
  return {
    ...targetWithModelMetadata,
    ...(diagnosticMetadata.contextUsage ? { contextUsage: diagnosticMetadata.contextUsage } : {}),
    ...(diagnosticMetadata.contextPressure
      ? { contextPressure: diagnosticMetadata.contextPressure }
      : {}),
    ...(diagnosticMetadata.contextPressureCrossedThresholds
      ? { contextPressureCrossedThresholds: diagnosticMetadata.contextPressureCrossedThresholds }
      : {}),
    ...(diagnosticMetadata.terminationReason
      ? { terminationReason: diagnosticMetadata.terminationReason }
      : {}),
    ...(selectedActiveRuntimeMs !== undefined
      ? { activeRuntimeMs: selectedActiveRuntimeMs }
      : resultActiveRuntimeMs !== undefined
        ? { activeRuntimeMs: resultActiveRuntimeMs }
        : {}),
    ...(selectedActiveRuntimeCheckpointAt !== undefined
      ? { activeRuntimeCheckpointAt: selectedActiveRuntimeCheckpointAt }
      : resultActiveRuntimeCheckpointAt !== undefined
        ? { activeRuntimeCheckpointAt: resultActiveRuntimeCheckpointAt }
        : {}),
    successfulCompletion,
  };
}

export function resolveAsyncResumeTarget(
  params: AsyncResumeParams,
  deps: AsyncResumeDeps = {},
  options: AsyncResumeOptions = {},
): AsyncResumeTarget {
  const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
  const resultsDir = deps.resultsDir ?? RESULTS_DIR;
  const requireSessionFile = options.requireSessionFile ?? true;
  const location = resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
  if (!location.asyncDir && !location.resultPath) {
    throw new Error("Async run not found. Provide id or dir.");
  }

  const reconciliation =
    location.asyncDir && !options.readOnly
      ? reconcileAsyncRun(location.asyncDir, { resultsDir, kill: deps.kill, now: deps.now })
      : undefined;
  let status =
    reconciliation?.status ??
    (options.readOnly && location.asyncDir ? readStatus(location.asyncDir) : null);
  validateStatusForResume(
    status,
    location.asyncDir ? path.join(location.asyncDir, "status.json") : "status.json",
  );
  const result = location.resultPath ? readResultFile(location.resultPath) : undefined;
  const runId =
    status?.runId ??
    result?.runId ??
    result?.id ??
    location.resolvedId ??
    (location.asyncDir ? path.basename(location.asyncDir) : "unknown");
  const state = status?.state ?? (result ? resultState(result) : undefined);
  const tkTicket = normalizeTkTicketMetadata(status?.tkTicket);
  if (!state) throw new Error(`Status file not found for async run '${runId}'.`);
  if (state === "cancelled")
    throw new Error(`Async run '${runId}' was cancelled and cannot be resumed.`);
  if (state === "pausing")
    throw new Error(`Async run '${runId}' is still pausing and cannot be resumed yet.`);

  const statusSteps = status?.steps ?? [];
  const resultSteps = result?.results ?? [];
  const stepCount = statusSteps.length || resultSteps.length || (result?.agent ? 1 : 0);
  const requestedIndex = params.index;
  if (requestedIndex !== undefined && !Number.isInteger(requestedIndex))
    throw new Error(`Async run '${runId}' index must be an integer.`);

  const context: AsyncResumeResolutionContext = {
    asyncDirRoot,
    resultsDir,
    requireSessionFile,
    location,
    status,
    result,
    runId,
    state,
    statusSteps,
    resultSteps,
    stepCount,
    requestedIndex,
    deps,
    options,
    tkTicket,
  };
  if (state === "running") {
    const liveTarget = resolveLiveAsyncResumeTarget(context);
    if (liveTarget) return liveTarget;
  }
  return resolveTerminalAsyncResumeTarget(context);
}

export function buildRevivedAsyncTask(target: AsyncResumeTarget, message: string): string {
  return [
    "You are reviving a previous subagent conversation.",
    "",
    `Original run: ${target.runId}`,
    `Original agent: ${target.agent}`,
    target.sessionFile ? `Original session file: ${target.sessionFile}` : undefined,
    "",
    "Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.",
    "",
    "Follow-up:",
    message,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
