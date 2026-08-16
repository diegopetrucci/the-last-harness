import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";

export const SUBAGENT_SAFETY_GUIDANCE = `SAFETY-CRITICAL SUBAGENT GUIDANCE:
• Use { action: "list" } before execution and run only agents shown there.
• Keep execution and actions separate: omit action for SINGLE { agent, task? } or PARALLEL { tasks:[...] }; use action only for list, get, status, interrupt, resume, steer, or doctor.
• Async/background runs: set async:true only when work can continue without waiting. Do not sleep or poll status just to wait; continue useful work or reply and let completion notifications arrive.
• Child-safety boundary: subagents cannot spawn subagents. Subagent processes do not have orchestrator capability.
• Writing safety: keep one writer for the same cwd. Use fresh read-only reviewers or validators for independent checks, then have the parent apply edits as the sole writer.
• Status/artifacts essentials: async runs expose asyncId and asyncDir with status.json, events.jsonl, output logs, and status via { action: "status", id }. Include output paths and residual risks when reporting results.`;

export const FULL_SUBAGENT_TOOL_DESCRIPTION = `Delegate to subagents with the TLH minimal contract.

Use exactly one mode per call.

EXECUTION
• Before execution, call { action: "list" } to inspect available agents. Only run agents listed as executable and not disabled.
• SINGLE mode: { agent, task? }. Use one agent. task is optional for self-contained agents.
• PARALLEL mode: { tasks:[{ agent, task, count?, output?, outputMode?, reads?, progress?, model? }, ...], concurrency? }. Use this for concurrent work across multiple agents.
• Optional context: { context: "fresh" | "fork" }. An explicit value applies to every child in the call. When omitted, each requested agent uses its own defaultContext when available; otherwise fresh is used.
• Optional async/background execution: { async: true }. This launches background work in detached mode so the parent can continue.
• Optional runtime controls for execution: { timeoutMs }, { cwd }, { artifacts }, { includeProgress }.

OUTPUT, READS, AND MODELS
• SINGLE mode accepts { output } and { outputMode } for saved output handling, plus { model } and { fallbackModels } for model selection.
• Each PARALLEL task accepts { output }, { outputMode }, { reads }, { progress }, and { model }.
• output may be a path string or false. Relative paths resolve from cwd.
• outputMode may be "inline" or "file-only".
• reads may be an array of file paths or false.
• model overrides the primary model for the current execution.
• fallbackModels supplies extra models to try after the primary model.

ACTIONS
Use action only with the supported TLH action set:
• { action: "list" } shows executable agents.
• { action: "get", agent: "name" } returns full details for one agent.
• { action: "status", id?: "..." } inspects an async/background run by id or prefix, including durable paused-awaiting-supervisor state where no child process is running.
• { action: "interrupt", id?: "..." } requests a soft interrupt for a running child, or cancels a durable paused child before continuation starts.
• { action: "resume", id: "...", message: "...", index?: 0 } resumes a durably paused child. Omit message for an unchanged resume, or pass message for guided resume.
• { action: "steer", id: "...", message: "...", index?: 0 } queues mid-run guidance for a live async child without pausing it.
• { action: "doctor" } returns a read-only runtime report.
• Agent acceptanceRole may be "read-only" or "writer" when configured through management or frontmatter. It affects inferred acceptance only, never tool access; explicit task mutation or no-edit intent wins, and false clears the override.


${SUBAGENT_SAFETY_GUIDANCE}`;

export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = `Delegate to subagents with the TLH minimal contract. Use exactly one mode per call.

EXECUTION
• Call { action: "list" } first; run only listed executable agents.
• SINGLE: { agent, task? }.
• PARALLEL: { tasks:[{ agent, task, count?, output?, outputMode?, reads?, progress?, model? }, ...], concurrency? }.
• Optional execution fields: context:"fresh"|"fork", async:true, timeoutMs, cwd, artifacts, includeProgress.

OUTPUT / MODELS
• SINGLE also accepts output, outputMode, model, fallbackModels.
• PARALLEL tasks accept output, outputMode, reads, progress, model.
• output can be a path string or false. outputMode can be "inline" or "file-only".
• Agent acceptanceRole may be "read-only" or "writer" when configured through management or frontmatter. It affects inferred acceptance only, never tools; explicit task intent wins, omission keeps name heuristics, and false clears the override.


ACTIONS
• Supported actions only: { action: "list" }, { action: "get", agent: "name" }, { action: "status", id?: "..." }, { action: "interrupt", id?: "..." }, { action: "resume", id: "...", message?: "...", index?: 0 }, { action: "steer", id: "...", message: "...", index?: 0 }, { action: "doctor" }.
• Paused-awaiting-supervisor status reports that no child process is running and gives exact unchanged resume, guided resume, and cancel commands.

ASYNC / SAFETY
• async:true launches detached background work. Do not sleep or poll just to wait; continue useful work or let completion notifications arrive.
• Subagents cannot spawn subagents. Subagent processes do not have orchestrator capability.
• Keep one writer per cwd; use fresh read-only review when needed, then have the parent apply edits.
• Async status/artifacts live under asyncId/asyncDir with status.json, events.jsonl, output logs, and { action:"status", id:"..." }.`;

function isToolDescriptionMode(value: unknown): value is ToolDescriptionMode {
  return value === "full" || value === "compact";
}

function warn(options: ToolDescriptionOptions | undefined, message: string): void {
  (options?.warn ?? console.warn)(`[pi-subagents] ${message}`);
}

export interface ToolDescriptionOptions {
  cwd?: string;
  agentDir?: string;
  warn?: (message: string) => void;
}

export function resolveToolDescriptionMode(
  config: Pick<ExtensionConfig, "toolDescriptionMode">,
  options?: ToolDescriptionOptions,
): ToolDescriptionMode {
  const mode = config.toolDescriptionMode;
  if (mode === undefined) return "full";
  if (isToolDescriptionMode(mode)) return mode;
  warn(
    options,
    `Ignoring invalid toolDescriptionMode ${JSON.stringify(mode)}; expected "full" or "compact".`,
  );
  return "full";
}

export function buildSubagentToolDescription(
  config: Pick<ExtensionConfig, "toolDescriptionMode"> = {},
  options?: ToolDescriptionOptions,
): string {
  const mode = resolveToolDescriptionMode(config, options);
  if (mode === "compact") return COMPACT_SUBAGENT_TOOL_DESCRIPTION;
  return FULL_SUBAGENT_TOOL_DESCRIPTION;
}
