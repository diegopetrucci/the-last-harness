import { truncateWithMarker } from "../../shared/string-utils.ts";
import type { TerminalRecord, TerminalRecordChild } from "./terminal-record.ts";

/** Fixed per-child budget; a child's report never shrinks because it has siblings. */
export const RESULT_CHILD_OUTPUT_CHARS = 8_000;
const RESULT_MARKER = "… [output truncated";

function childSection(child: TerminalRecordChild, budget: number): string {
  const marker = child.artifactPath
    ? `${RESULT_MARKER}; full output: ${child.artifactPath}]`
    : `${RESULT_MARKER}]`;
  const output = truncateWithMarker(child.output, budget, marker);
  const lines = [`## Child ${child.index}: ${child.agent} — ${child.status}`];
  if (child.error) lines.push(`Error: ${child.error}`);
  if (child.sessionFile) lines.push(`Session: ${child.sessionFile}`);
  if (child.artifactPath) lines.push(`Artifact: ${child.artifactPath}`);
  lines.push("", output || "(no output)");
  return lines.join("\n");
}

/**
 * Format a bounded per-child result. Each child is truncated against its own
 * budget so a long early output can never hide later or failed children.
 */
export function formatTerminalRecordResult(
  record: TerminalRecord,
  index?: number,
): { text: string; indices: number[] } {
  const selected =
    index === undefined
      ? record.children
      : record.children.filter((child) => child.index === index);
  const counts = new Map<string, number>();
  for (const child of selected) counts.set(child.status, (counts.get(child.status) ?? 0) + 1);
  const header = [
    `Run ${record.runId}: ${record.state}${record.synthesized ? " (synthesized from status; result artifact unavailable)" : ""}`,
    `Children: ${[...counts].map(([status, n]) => `${n} ${status}`).join(", ") || "none"}`,
  ];
  if (record.error) header.push(`Error: ${record.error}`);
  if (record.childrenOmitted) header.push(`(${record.childrenOmitted} further children omitted)`);
  const sections = selected.map((child) => childSection(child, RESULT_CHILD_OUTPUT_CHARS));
  if (selected.length === 0) sections.push(record.summary);
  return {
    text: `${header.join("\n")}\n\n${sections.join("\n\n")}`,
    indices: selected.map((child) => child.index),
  };
}

/** Terminal runs shown in `status`; further ones are summarized as a count. */
export const MAX_UNRETRIEVED_STATUS_RUNS = 10;

export interface UnretrievedRunEntry {
  record: TerminalRecord;
  /** Child indices whose output has not been returned through `result`. */
  unretrievedIndices: number[];
}

/** Runtime-generated listing of terminal runs whose output was not yet retrieved. */
export function formatUnretrievedRuns(entries: readonly UnretrievedRunEntry[]): string {
  if (entries.length === 0) return "";
  const lines = [`Unretrieved terminal results: ${entries.length}`, ""];
  for (const { record, unretrievedIndices } of entries.slice(0, MAX_UNRETRIEVED_STATUS_RUNS)) {
    const counts = new Map<string, number>();
    for (const child of record.children)
      counts.set(child.status, (counts.get(child.status) ?? 0) + 1);
    const summary = [...counts].map(([status, n]) => `${n} ${status}`).join(", ") || "no children";
    const pending =
      record.children.length > 0 && unretrievedIndices.length < record.children.length
        ? ` | unretrieved children: ${unretrievedIndices.join(", ")}`
        : "";
    lines.push(
      `- ${record.runId} | ${record.state} | ${record.children.length} children (${summary})${pending}`,
      `  Fetch: subagent({ action: "result", id: ${JSON.stringify(record.runId)} })`,
    );
  }
  const more = entries.length - MAX_UNRETRIEVED_STATUS_RUNS;
  if (more > 0) lines.push(`- and ${more} more`);
  return lines.join("\n");
}
