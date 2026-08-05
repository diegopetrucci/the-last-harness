import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";

const CUSTOM_TOOL_DESCRIPTION_FILE = "subagent-tool-description.md";
const CUSTOM_TOOL_DESCRIPTION_MAX_BYTES = 50 * 1024;

export const SUBAGENT_SAFETY_GUIDANCE = `SAFETY-CRITICAL SUBAGENT GUIDANCE:
• Use { action: "list" } before execution and run only agents shown there.
• Keep execution and actions separate: omit action for SINGLE { agent, task? } or PARALLEL { tasks:[...] }; use action only for list, get, models, status, interrupt, resume, steer, or doctor.
• Async/background runs: set async:true only when work can continue without waiting. Do not sleep or poll status just to wait; continue useful work or reply and let completion notifications arrive.
• Child-safety boundary: ordinary child subagents are not orchestrators and must not run subagents. Only explicit fanout children may use the child-safe subagent tool, still bounded by depth/session limits.
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
• { action: "models", agent?: "name" } shows runtime-loaded builtin model mappings, optionally filtered to one builtin.
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
• Supported actions only: { action: "list" }, { action: "get", agent: "name" }, { action: "models", agent?: "name" }, { action: "status", id?: "..." }, { action: "interrupt", id?: "..." }, { action: "resume", id: "...", message?: "...", index?: 0 }, { action: "steer", id: "...", message: "...", index?: 0 }, { action: "doctor" }.
• Paused-awaiting-supervisor status reports that no child process is running and gives exact unchanged resume, guided resume, and cancel commands.

ASYNC / SAFETY
• async:true launches detached background work. Do not sleep or poll just to wait; continue useful work or let completion notifications arrive.
• Ordinary child subagents are not orchestrators and must not run subagents. Only explicit fanout children may use the child-safe subagent tool.
• Keep one writer per cwd; use fresh read-only review when needed, then have the parent apply edits.
• Async status/artifacts live under asyncId/asyncDir with status.json, events.jsonl, output logs, and { action:"status", id:"..." }.`;

function isToolDescriptionMode(value: unknown): value is ToolDescriptionMode {
	return value === "full" || value === "compact" || value === "custom";
}

function warn(options: ToolDescriptionOptions | undefined, message: string): void {
	(options?.warn ?? console.warn)(`[pi-subagents] ${message}`);
}

export interface ToolDescriptionOptions {
	cwd?: string;
	agentDir?: string;
	warn?: (message: string) => void;
}

export function resolveToolDescriptionMode(config: Pick<ExtensionConfig, "toolDescriptionMode">, options?: ToolDescriptionOptions): ToolDescriptionMode {
	const mode = config.toolDescriptionMode;
	if (mode === undefined) return "full";
	if (isToolDescriptionMode(mode)) return mode;
	warn(options, `Ignoring invalid toolDescriptionMode ${JSON.stringify(mode)}; expected "full", "compact", or "custom".`);
	return "full";
}

function customDescriptionPaths(options?: ToolDescriptionOptions): string[] {
	const cwd = options?.cwd ?? process.cwd();
	const agentDir = options?.agentDir ?? getAgentDir();
	return [
		path.join(getProjectConfigDir(cwd), CUSTOM_TOOL_DESCRIPTION_FILE),
		path.join(agentDir, CUSTOM_TOOL_DESCRIPTION_FILE),
	];
}

function renderCustomTemplate(template: string, options?: ToolDescriptionOptions): string {
	const cwd = options?.cwd ?? process.cwd();
	const agentDir = options?.agentDir ?? getAgentDir();
	const projectConfigDir = getProjectConfigDir(cwd);
	const variables: Record<string, () => string> = {
		fullDescription: () => FULL_SUBAGENT_TOOL_DESCRIPTION,
		full: () => FULL_SUBAGENT_TOOL_DESCRIPTION,
		compactDescription: () => COMPACT_SUBAGENT_TOOL_DESCRIPTION,
		compact: () => COMPACT_SUBAGENT_TOOL_DESCRIPTION,
		safetyGuidance: () => SUBAGENT_SAFETY_GUIDANCE,
		safety: () => SUBAGENT_SAFETY_GUIDANCE,
		agentDir: () => agentDir,
		projectConfigDir: () => projectConfigDir,
	};
	return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
		const replacement = variables[name];
		if (replacement) return replacement();
		warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE}: unknown placeholder ${raw} left unchanged.`);
		return raw;
	});
}

function loadCustomToolDescription(options?: ToolDescriptionOptions): string | undefined {
	for (const filePath of customDescriptionPaths(options)) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(filePath);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			warn(options, `Failed to inspect custom tool description '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!stat.isFile()) {
			warn(options, `Ignoring custom tool description '${filePath}' because it is not a file.`);
			continue;
		}
		if (stat.size > CUSTOM_TOOL_DESCRIPTION_MAX_BYTES) {
			warn(options, `Ignoring custom tool description '${filePath}' because it is larger than ${CUSTOM_TOOL_DESCRIPTION_MAX_BYTES} bytes.`);
			continue;
		}
		try {
			const template = fs.readFileSync(filePath, "utf-8").trim();
			if (!template) {
				warn(options, `Ignoring empty custom tool description '${filePath}'.`);
				continue;
			}
			const rendered = renderCustomTemplate(template, options).trim();
			if (!rendered) {
				warn(options, `Ignoring custom tool description '${filePath}' because it rendered empty.`);
				continue;
			}
			return rendered;
		} catch (error) {
			warn(options, `Failed to read custom tool description '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return undefined;
}

function withMandatorySafetyGuidance(description: string): string {
	const customDescription = description
		.split(SUBAGENT_SAFETY_GUIDANCE)
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
	return customDescription
		? `${customDescription}\n\n${SUBAGENT_SAFETY_GUIDANCE}`
		: SUBAGENT_SAFETY_GUIDANCE;
}

export function buildSubagentToolDescription(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}, options?: ToolDescriptionOptions): string {
	const mode = resolveToolDescriptionMode(config, options);
	if (mode === "compact") return COMPACT_SUBAGENT_TOOL_DESCRIPTION;
	if (mode === "custom") {
		const custom = loadCustomToolDescription(options);
		if (custom) return withMandatorySafetyGuidance(custom);
		warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE} was not found or valid for toolDescriptionMode "custom"; using full description.`);
	}
	return FULL_SUBAGENT_TOOL_DESCRIPTION;
}
