import {
  type SubagentResultChild,
  type SubagentResultStatus,
  type SubagentRunMode,
  normalizeSubagentRunMode,
} from "./types.ts";
import { truncateWithMarker } from "./string-utils.ts";
import { safeTerminalDocumentLeaf, safeTerminalText } from "./display-text.ts";

export function resolveSubagentResultStatus(input: {
  exitCode?: number;
  success?: boolean;
  state?: string;
  interrupted?: boolean;
}): SubagentResultStatus {
  if (input.interrupted || input.state === "paused") return "paused";
  if (typeof input.success === "boolean") return input.success ? "completed" : "failed";
  if (input.state === "complete") return "completed";
  if (input.state === "failed") return "failed";
  if (typeof input.exitCode === "number") return input.exitCode === 0 ? "completed" : "failed";
  return "failed";
}

function countStatuses(children: SubagentResultChild[]): Record<SubagentResultStatus, number> {
  const counts: Record<SubagentResultStatus, number> = {
    completed: 0,
    failed: 0,
    paused: 0,
  };
  for (const child of children) {
    counts[child.status] += 1;
  }
  return counts;
}

function formatStatusCounts(counts: Record<SubagentResultStatus, number>): string {
  const parts = [
    counts.completed ? `${counts.completed} completed` : undefined,
    counts.failed ? `${counts.failed} failed` : undefined,
    counts.paused ? `${counts.paused} paused` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(", ") : "0 results";
}

function resolveGroupedStatus(children: SubagentResultChild[]): SubagentResultStatus {
  const counts = countStatuses(children);
  if (counts.failed > 0) return "failed";
  if (counts.paused > 0) return "paused";
  if (counts.completed > 0) return "completed";
  return "failed";
}

const MAX_NATIVE_FOREGROUND_CHARS = 8_000;
const MAX_NATIVE_FOREGROUND_CHILDREN = 8;
const MAX_NATIVE_FOREGROUND_SUMMARY_CHARS = 1_200;
const MAX_NATIVE_FOREGROUND_LABEL_CHARS = 160;
const MAX_NATIVE_FOREGROUND_REFERENCE_CHARS = 500;
const MAX_NATIVE_FOREGROUND_ERROR_CHARS = 1_200;

function boundedNativeForegroundLabel(value: string): string {
  return truncateWithMarker(
    safeTerminalText(value),
    MAX_NATIVE_FOREGROUND_LABEL_CHARS,
    "… [label truncated]",
  );
}

function boundedNativeForegroundReference(value: string): string {
  return truncateWithMarker(
    safeTerminalText(value),
    MAX_NATIVE_FOREGROUND_REFERENCE_CHARS,
    "… [reference truncated]",
  );
}

function boundedNativeForegroundError(value: string): string {
  return truncateWithMarker(
    safeTerminalText(value),
    MAX_NATIVE_FOREGROUND_ERROR_CHARS,
    "… [error truncated; full text is unavailable]",
  );
}

/**
 * Bounds the per-child summary to maxChars, choosing the appropriate truncation marker.
 * Returns "" when the budget cannot hold a well-formed marker so that callers can suppress
 * the summary line entirely rather than emitting a sliced fragment.
 */
function boundedNativeForegroundSummary(child: SubagentResultChild, maxChars: number): string {
  const raw = safeTerminalDocumentLeaf(child.summary).trim() || "(no output)";
  if (raw.length <= maxChars) return raw;
  // Select the marker first, then suppress when the budget cannot hold it.
  // Comparing against the selected marker's own length avoids suppressing a short
  // no-references marker (49 chars) because the longer with-references marker (59
  // chars) does not fit — the two markers have different lengths.
  const marker =
    child.artifactPath || child.sessionPath
      ? "… [summary truncated; see references below for full output]"
      : "… [summary truncated; full output is unavailable]";
  if (maxChars < marker.length) return "";
  return truncateWithMarker(raw, maxChars, marker);
}

interface NativeForegroundChild extends SubagentResultChild {
  displayIndex?: number;
  displayTotal?: number;
  nativeForegroundPriority?: number;
}

function prioritizedNativeForegroundChildren(
  children: NativeForegroundChild[],
): Array<{ child: NativeForegroundChild; originalIndex: number }> {
  const statusPriority = new Map<SubagentResultStatus, number>([
    ["failed", 0],
    ["paused", 1],
    ["completed", 2],
  ]);
  return children
    .map((child, index) => ({ child, originalIndex: child.index ?? index, inputOrder: index }))
    .sort((a, b) => {
      const priorityDelta =
        (b.child.nativeForegroundPriority ?? 0) - (a.child.nativeForegroundPriority ?? 0);
      if (priorityDelta !== 0) return priorityDelta;
      const statusDelta =
        (statusPriority.get(a.child.status) ?? 99) - (statusPriority.get(b.child.status) ?? 99);
      if (statusDelta !== 0) return statusDelta;
      return a.inputOrder - b.inputOrder;
    })
    .slice(0, MAX_NATIVE_FOREGROUND_CHILDREN)
    .map(({ child, originalIndex }) => ({ child, originalIndex }));
}

/**
 * Character cost of a set of lines once joined with newlines, counted conservatively
 * (one extra char per line so reserved space is never undersized).
 */
function joinedLineCost(lines: string[]): number {
  return lines.reduce((total, line) => total + line.length + 1, 0);
}

/**
 * Divides the space remaining after all fixed scaffolding costs are reserved among the
 * displayed children for summary text. Reserving fixed scaffolding (labels and reference
 * lines) before the division ensures summary text receives only the
 * space that remains after every recovery pointer is guaranteed.
 */
function resolveNativeForegroundPerChildSummaryBudget(
  count: number,
  fixedCost: number,
  ceiling: number,
): number {
  const effectiveCount = Math.max(count, 1);
  const available = Math.max(ceiling - fixedCost, 0);
  return Math.min(MAX_NATIVE_FOREGROUND_SUMMARY_CHARS, Math.floor(available / effectiveCount));
}

function formatForegroundNativeSubagentText(input: {
  runId: string;
  mode: SubagentRunMode;
  status: SubagentResultStatus;
  children: NativeForegroundChild[];
  errorSummary?: string;
}): string {
  const counts = countStatuses(input.children);

  // Build the fixed outer header lines.
  const outerLines: string[] = [
    "subagent results",
    "",
    `Run: ${boundedNativeForegroundReference(input.runId)}`,
    `Mode: ${boundedNativeForegroundLabel(input.mode)}`,
    `Status: ${boundedNativeForegroundLabel(input.status)}`,
    `Children: ${formatStatusCounts(counts)}`,
  ];
  if (input.errorSummary) {
    outerLines.push("", "Error:", boundedNativeForegroundError(input.errorSummary));
  }

  // Apply priority ordering and cap at MAX_NATIVE_FOREGROUND_CHILDREN.
  const displayedChildren = prioritizedNativeForegroundChildren(input.children);

  // Top-level omission (children beyond the priority cap).
  const priorityOmittedCount = input.children.length - displayedChildren.length;
  const priorityOmissionLine =
    priorityOmittedCount > 0
      ? `… [${priorityOmittedCount} child results omitted; highest-priority results shown first; full set is unavailable]`
      : null;

  // Pre-compute per-child fixed lines (everything except the summary body).
  // These carry the recovery pointers and must be reserved before the summary
  // budget is divided so end-truncation can never destroy them.
  interface ChildFixedData {
    child: NativeForegroundChild;
    originalIndex: number;
    labelLine: string;
    refLines: string[];
    fixedCost: number;
  }

  const childFixedData: ChildFixedData[] = displayedChildren.map(({ child, originalIndex }) => {
    const displayIndex = child.displayIndex ?? originalIndex + 1;
    const displayTotal = child.displayTotal ?? input.children.length;
    const labelLine = `${displayIndex}/${displayTotal}. ${boundedNativeForegroundLabel(child.agent)} — ${boundedNativeForegroundLabel(child.status)}`;
    const refLines: string[] = [];
    if (child.artifactPath)
      refLines.push(`Output artifact: ${boundedNativeForegroundReference(child.artifactPath)}`);
    if (child.sessionPath)
      refLines.push(`Session: ${boundedNativeForegroundReference(child.sessionPath)}`);
    // Fixed cost: blank separator + label + "Summary:" header + reference lines.
    // The summary body itself is NOT included here — it is conditional on the per-child
    // budget and must not be pre-counted, or the fit decision will drop children one char
    // early when the budget is tight.
    const fixedCost = joinedLineCost(["", labelLine, "Summary:", ...refLines]);
    return { child, originalIndex, labelLine, refLines, fixedCost };
  });

  // Dynamic reduction: drop trailing displayed children when their scaffolding alone
  // exceeds the ceiling. Each dropped child is counted in an explicit omission marker
  // rather than being silently tail-cut.
  const outerCost =
    joinedLineCost(outerLines) +
    (priorityOmissionLine ? joinedLineCost(["", priorityOmissionLine]) : 0);
  let effectiveCount = displayedChildren.length;
  while (effectiveCount > 0) {
    const partialFixedCost = childFixedData
      .slice(0, effectiveCount)
      .reduce((s, c) => s + c.fixedCost, 0);
    const budgetOmittedHere = displayedChildren.length - effectiveCount;
    // The loop always tests whether effectiveCount >= 1 children fit. The omitted
    // children's paths are never emitted; do not direct the reader to paths that
    // belong to the retained children.
    const budgetOmissionCostHere =
      budgetOmittedHere > 0
        ? joinedLineCost([
            "",
            `… [${budgetOmittedHere} additional child results omitted; their output is not reachable from this envelope]`,
          ])
        : 0;
    if (outerCost + partialFixedCost + budgetOmissionCostHere <= MAX_NATIVE_FOREGROUND_CHARS) break;
    effectiveCount--;
  }

  const effectiveChildData = childFixedData.slice(0, effectiveCount);
  const budgetOmittedCount = displayedChildren.length - effectiveCount;
  // When every child is dropped (effectiveCount === 0) there are no paths above;
  // state unavailability plainly. When some children are retained, the omitted
  // children's paths are not emitted, so do not imply they are reachable above.
  const budgetOmissionLine =
    budgetOmittedCount > 0
      ? effectiveCount === 0
        ? `… [${budgetOmittedCount} child results omitted due to display size limit; full output is unavailable]`
        : `… [${budgetOmittedCount} additional child results omitted; their output is not reachable from this envelope]`
      : null;

  // Compute total fixed cost and derive per-child summary budget from remaining space.
  // +effectiveCount reserves one char per displayed child for the newline that joins("\n")
  // emits between the summary text and the following ref lines. The loop's drop decision
  // does NOT include this char (it checks bare scaffolding only), so it must be added
  // here to keep the rendered total within the ceiling.
  const totalFixedCost =
    outerCost +
    (budgetOmissionLine ? joinedLineCost(["", budgetOmissionLine]) : 0) +
    effectiveChildData.reduce((s, c) => s + c.fixedCost, 0);

  const perChildSummaryBudget = resolveNativeForegroundPerChildSummaryBudget(
    effectiveCount,
    totalFixedCost + effectiveCount,
    MAX_NATIVE_FOREGROUND_CHARS,
  );

  // Render.
  const lines: string[] = [...outerLines];
  if (priorityOmissionLine) lines.push("", priorityOmissionLine);
  if (budgetOmissionLine) lines.push("", budgetOmissionLine);

  for (const { child, labelLine, refLines } of effectiveChildData) {
    lines.push("", labelLine);
    // Emit summary text with per-child budget. Suppress the 'Summary:' heading
    // entirely when the budget cannot hold a well-formed truncation marker — an
    // orphaned heading with nothing beneath it is worse than no heading at all.
    const summaryText = boundedNativeForegroundSummary(child, perChildSummaryBudget);
    if (summaryText) lines.push("Summary:", summaryText);
    lines.push(...refLines);
  }

  return lines.join("\n");
}

interface GroupedNativeForegroundMessageInput {
  runId: string;
  mode: SubagentRunMode;
  children: NativeForegroundChild[];
  statusOverride?: SubagentResultStatus;
  errorSummary?: string;
}

export function formatForegroundNativeSubagentResult(input: GroupedNativeForegroundMessageInput): {
  text: string;
  status: SubagentResultStatus;
  summary: string;
} {
  const children = input.children.map((child) => ({
    ...child,
    summary: child.summary.trim() || "(no output)",
  }));
  const status = input.statusOverride ?? resolveGroupedStatus(children);
  const summary = formatStatusCounts(countStatuses(children));
  return {
    status,
    summary,
    text: formatForegroundNativeSubagentText({
      runId: input.runId,
      mode: normalizeSubagentRunMode(input.mode),
      status,
      children,
      ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
    }),
  };
}
