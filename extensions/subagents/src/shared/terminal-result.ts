import { MAX_TOP_LEVEL_PARALLEL_TASKS } from "./parallel-limits.ts";
import type {
  GitWorkspaceSnapshot,
  PostRunFacts,
  ProviderTokenUsage,
  SubagentAttemptFacts,
  SubagentTerminalResult,
  SubagentTerminalState,
  SubagentWorkspaceAttribution,
  TokenUsage,
  WorkspaceSnapshotUnavailableReason,
} from "./types.ts";

/** Maximum number of fallback/resume attempts retained in one terminal result. */
export const MAX_SUBAGENT_TERMINAL_ATTEMPTS = 64;

/** Maximum UTF-8 bytes retained across all workspace evidence in one result. */
export const MAX_SUBAGENT_TERMINAL_SNAPSHOT_BYTES = 1024 * 1024;

/**
 * Bound ordinary status documents to the existing attribution envelope. A
 * status can carry one bounded terminal result per supported child step plus a
 * second evidence budget for lifecycle metadata and future status fields.
 */
export const MAX_ATTRIBUTION_STATUS_BYTES =
  MAX_SUBAGENT_TERMINAL_SNAPSHOT_BYTES * MAX_TOP_LEVEL_PARALLEL_TASKS * 2;

/** Maximum UTF-8 bytes retained for each raw workspace evidence field. */
export const MAX_SUBAGENT_WORKSPACE_EVIDENCE_BYTES = 256 * 1024;

/** Maximum UTF-8 bytes retained for an exit signal name. */
const MAX_SUBAGENT_EXIT_SIGNAL_BYTES = 64;

/** Clone the evidence while projecting a lifecycle status onto its terminal state. */
export function terminalResultForStatusStep(
  result: { terminalResult?: SubagentTerminalResult },
  status: string,
): SubagentTerminalResult | undefined {
  if (!result.terminalResult) return undefined;
  const terminalState =
    status === "cancelled"
      ? "cancelled"
      : status === "paused"
        ? "paused"
        : status === "complete"
          ? "completed"
          : "failed";
  return {
    state: terminalState,
    facts: { attempts: boundSubagentAttemptFacts(result.terminalResult.facts.attempts) },
  };
}

const TERMINAL_STATES: ReadonlySet<SubagentTerminalState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "paused",
]);
const WORKSPACE_ATTRIBUTIONS: ReadonlySet<SubagentWorkspaceAttribution> = new Set([
  "exclusive",
  "shared",
  "unknown",
]);
const WORKSPACE_UNAVAILABLE_REASONS: ReadonlySet<WorkspaceSnapshotUnavailableReason> = new Set([
  "not_git_repository",
  "command_failed",
  "not_captured",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function boundedString(value: unknown, maxBytes: number, allowEmpty = true): string | undefined {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) return undefined;
  return Buffer.byteLength(value, "utf-8") <= maxBytes ? value : undefined;
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safeNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
}

function parseTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isPlainObject(value) || !hasExactKeys(value, ["input", "output", "total"])) return undefined;
  const input = safeNonNegativeInteger(value.input);
  const output = safeNonNegativeInteger(value.output);
  const total = safeNonNegativeInteger(value.total);
  if (input === undefined || output === undefined || total === undefined) return undefined;
  return { input, output, total };
}

function parseProviderTokens(value: unknown): ProviderTokenUsage | undefined {
  if (!isPlainObject(value) || typeof value.status !== "string") return undefined;
  if (value.status === "unavailable") {
    return hasExactKeys(value, ["status"]) ? { status: "unavailable" } : undefined;
  }
  if (value.status !== "available" || !hasExactKeys(value, ["status", "usage"])) return undefined;
  const usage = parseTokenUsage(value.usage);
  return usage ? { status: "available", usage: { ...usage } } : undefined;
}

function parseExit(value: unknown): SubagentAttemptFacts["exit"] | undefined {
  if (!isPlainObject(value) || !hasExactKeys(value, ["code", "signal"])) return undefined;
  const code = value.code === null ? null : safeNonNegativeInteger(value.code);
  const signal =
    value.signal === null
      ? null
      : boundedString(value.signal, MAX_SUBAGENT_EXIT_SIGNAL_BYTES, false);
  if (code === undefined || signal === undefined) return undefined;
  return { code, signal };
}

function parseRequestedToolCalls(
  value: unknown,
): SubagentAttemptFacts["requestedToolCalls"] | undefined {
  if (!isPlainObject(value) || !hasExactKeys(value, ["edit", "write", "bash"])) return undefined;
  const edit = safeNonNegativeInteger(value.edit);
  const write = safeNonNegativeInteger(value.write);
  const bash = safeNonNegativeInteger(value.bash);
  if (edit === undefined || write === undefined || bash === undefined) return undefined;
  return { edit, write, bash };
}

function parseWorkspaceSnapshot(value: unknown): GitWorkspaceSnapshot | undefined {
  if (!isPlainObject(value) || typeof value.status !== "string") return undefined;
  if (value.status === "unavailable") {
    return hasExactKeys(value, ["status", "reason"]) &&
      typeof value.reason === "string" &&
      WORKSPACE_UNAVAILABLE_REASONS.has(value.reason as WorkspaceSnapshotUnavailableReason)
      ? { status: "unavailable", reason: value.reason as WorkspaceSnapshotUnavailableReason }
      : undefined;
  }
  if (
    value.status !== "available" ||
    !hasExactKeys(value, ["status", "statusPorcelainZ", "worktreeDiffStat", "indexDiffStat"])
  )
    return undefined;
  const statusPorcelainZ = boundedString(
    value.statusPorcelainZ,
    MAX_SUBAGENT_WORKSPACE_EVIDENCE_BYTES,
  );
  const worktreeDiffStat = boundedString(
    value.worktreeDiffStat,
    MAX_SUBAGENT_WORKSPACE_EVIDENCE_BYTES,
  );
  const indexDiffStat = boundedString(value.indexDiffStat, MAX_SUBAGENT_WORKSPACE_EVIDENCE_BYTES);
  if (
    statusPorcelainZ === undefined ||
    worktreeDiffStat === undefined ||
    indexDiffStat === undefined
  )
    return undefined;
  return { status: "available", statusPorcelainZ, worktreeDiffStat, indexDiffStat };
}

function parseWorkspace(value: unknown): SubagentAttemptFacts["workspace"] | undefined {
  if (!isPlainObject(value) || !hasExactKeys(value, ["baseline", "post", "attribution"]))
    return undefined;
  const baseline = parseWorkspaceSnapshot(value.baseline);
  const post = parseWorkspaceSnapshot(value.post);
  const attribution = value.attribution;
  if (
    !baseline ||
    !post ||
    typeof attribution !== "string" ||
    !WORKSPACE_ATTRIBUTIONS.has(attribution as SubagentWorkspaceAttribution)
  )
    return undefined;
  return {
    baseline,
    post,
    attribution: attribution as SubagentWorkspaceAttribution,
  };
}

function boundedEvidence(value: string): string {
  if (Buffer.byteLength(value, "utf-8") <= MAX_SUBAGENT_WORKSPACE_EVIDENCE_BYTES) return value;
  let bounded = Buffer.from(value, "utf-8")
    .subarray(0, MAX_SUBAGENT_WORKSPACE_EVIDENCE_BYTES)
    .toString("utf-8");
  // A partial multibyte sequence is decoded as U+FFFD, whose three UTF-8 bytes
  // can make the decoded value one or two bytes larger than the source slice.
  while (Buffer.byteLength(bounded, "utf-8") > MAX_SUBAGENT_WORKSPACE_EVIDENCE_BYTES)
    bounded = bounded.slice(0, -1);
  return bounded;
}

function cloneWorkspaceSnapshot(snapshot: GitWorkspaceSnapshot): GitWorkspaceSnapshot {
  if (snapshot.status !== "available") return { ...snapshot };
  return {
    status: "available",
    statusPorcelainZ: boundedEvidence(snapshot.statusPorcelainZ),
    worktreeDiffStat: boundedEvidence(snapshot.worktreeDiffStat),
    indexDiffStat: boundedEvidence(snapshot.indexDiffStat),
  };
}

function workspaceEvidenceBytes(snapshot: GitWorkspaceSnapshot): number {
  if (snapshot.status !== "available") return 0;
  return (
    Buffer.byteLength(snapshot.statusPorcelainZ, "utf-8") +
    Buffer.byteLength(snapshot.worktreeDiffStat, "utf-8") +
    Buffer.byteLength(snapshot.indexDiffStat, "utf-8")
  );
}

function attemptWorkspaceEvidenceBytes(attempt: SubagentAttemptFacts): number {
  return (
    workspaceEvidenceBytes(attempt.workspace.baseline) +
    workspaceEvidenceBytes(attempt.workspace.post)
  );
}

interface BoundedWorkspaceSnapshot {
  snapshot: GitWorkspaceSnapshot;
  bytes: number;
  captured: boolean;
}

function boundWorkspaceSnapshot(
  snapshot: GitWorkspaceSnapshot,
  remainingBytes: number,
): BoundedWorkspaceSnapshot {
  const bounded = cloneWorkspaceSnapshot(snapshot);
  const bytes = workspaceEvidenceBytes(bounded);
  if (bytes > remainingBytes) {
    return {
      snapshot: { status: "unavailable", reason: "not_captured" },
      bytes: 0,
      captured: false,
    };
  }
  return { snapshot: bounded, bytes, captured: true };
}

/** Keep retained attempt evidence within the field, attempt, and aggregate bounds. */
export function boundSubagentAttemptFacts(
  attempts: readonly SubagentAttemptFacts[],
): SubagentAttemptFacts[] {
  let remainingBytes = MAX_SUBAGENT_TERMINAL_SNAPSHOT_BYTES;
  return attempts.slice(0, MAX_SUBAGENT_TERMINAL_ATTEMPTS).map((attempt) => {
    const baseline = boundWorkspaceSnapshot(attempt.workspace.baseline, remainingBytes);
    remainingBytes -= baseline.bytes;
    const post = boundWorkspaceSnapshot(attempt.workspace.post, remainingBytes);
    remainingBytes -= post.bytes;
    const workspaceCaptured = baseline.captured && post.captured;
    return {
      ...attempt,
      exit: { ...attempt.exit },
      requestedToolCalls: { ...attempt.requestedToolCalls },
      workspace: {
        baseline: baseline.snapshot,
        post: post.snapshot,
        attribution: workspaceCaptured ? attempt.workspace.attribution : "unknown",
      },
      providerTokens:
        attempt.providerTokens.status === "available"
          ? { status: "available", usage: { ...attempt.providerTokens.usage } }
          : { status: "unavailable" },
    };
  });
}

export function appendBoundedSubagentAttemptFact(
  attempts: readonly SubagentAttemptFacts[],
  attempt: SubagentAttemptFacts,
): SubagentAttemptFacts[] {
  return boundSubagentAttemptFacts([...attempts, attempt]);
}

function parseAttempt(value: unknown): SubagentAttemptFacts | undefined {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "attempt",
      "exit",
      "durationMs",
      "providerTokens",
      "requestedToolCalls",
      "workspace",
    ])
  )
    return undefined;
  const attempt = safePositiveInteger(value.attempt);
  const exit = parseExit(value.exit);
  const durationMs = safeNonNegativeNumber(value.durationMs);
  const providerTokens = parseProviderTokens(value.providerTokens);
  const requestedToolCalls = parseRequestedToolCalls(value.requestedToolCalls);
  const workspace = parseWorkspace(value.workspace);
  if (
    attempt === undefined ||
    !exit ||
    durationMs === undefined ||
    !providerTokens ||
    !requestedToolCalls ||
    !workspace
  )
    return undefined;
  return {
    attempt,
    exit: { ...exit },
    durationMs,
    providerTokens,
    requestedToolCalls: { ...requestedToolCalls },
    workspace: {
      baseline: { ...workspace.baseline },
      post: { ...workspace.post },
      attribution: workspace.attribution,
    },
  };
}

function parseFacts(value: unknown): PostRunFacts | undefined {
  if (!isPlainObject(value) || !hasExactKeys(value, ["attempts"]) || !Array.isArray(value.attempts))
    return undefined;
  if (value.attempts.length < 1 || value.attempts.length > MAX_SUBAGENT_TERMINAL_ATTEMPTS)
    return undefined;
  const attempts: SubagentAttemptFacts[] = [];
  let snapshotBytes = 0;
  for (const [index, valueAttempt] of value.attempts.entries()) {
    const attempt = parseAttempt(valueAttempt);
    if (!attempt || attempt.attempt !== index + 1) return undefined;
    snapshotBytes += attemptWorkspaceEvidenceBytes(attempt);
    if (snapshotBytes > MAX_SUBAGENT_TERMINAL_SNAPSHOT_BYTES) return undefined;
    attempts.push(attempt);
  }
  return { attempts };
}

/**
 * Parse one persisted per-child terminal result.
 *
 * The input is untrusted JSON. The parser accepts only the complete, exact
 * TLH-owned shape and returns newly allocated objects, preserving raw NUL-
 * delimited porcelain evidence without allowing unknown fields through.
 */
export function parseSubagentTerminalResult(value: unknown): SubagentTerminalResult | undefined {
  try {
    if (!isPlainObject(value) || !hasExactKeys(value, ["state", "facts"])) return undefined;
    if (
      typeof value.state !== "string" ||
      !TERMINAL_STATES.has(value.state as SubagentTerminalState)
    )
      return undefined;
    const facts = parseFacts(value.facts);
    if (!facts) return undefined;
    return {
      state: value.state as SubagentTerminalState,
      facts: {
        attempts: facts.attempts.map((attempt) => ({
          ...attempt,
          exit: { ...attempt.exit },
          providerTokens:
            attempt.providerTokens.status === "available"
              ? { status: "available", usage: { ...attempt.providerTokens.usage } }
              : { status: "unavailable" },
          requestedToolCalls: { ...attempt.requestedToolCalls },
          workspace: {
            baseline: { ...attempt.workspace.baseline },
            post: { ...attempt.workspace.post },
            attribution: attempt.workspace.attribution,
          },
        })),
      },
    };
  } catch {
    // A hostile object/proxy must be treated exactly like malformed JSON.
    return undefined;
  }
}
