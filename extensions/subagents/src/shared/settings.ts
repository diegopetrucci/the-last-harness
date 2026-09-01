/**
 * Chain behavior, template resolution, and directory management
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agents.ts";
import {
  CHAIN_RUNS_DIR,
  type AcceptanceInput,
  type JsonSchemaObject,
  type OutputMode,
  type ToolBudgetConfig,
} from "./types.ts";
const CHAIN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const INITIAL_PROGRESS_CONTENT =
  "# Progress\n\n## Status\nIn Progress\n\n## Tasks\n\n## Files Changed\n\n## Notes\n";

// =============================================================================
// Behavior Resolution Types
// =============================================================================

export interface ResolvedStepBehavior {
  output: string | false;
  outputMode: OutputMode;
  reads: string[] | false;
  progress: boolean;
  skills: string[] | false;
  model?: string;
  fallbackModels?: string[];
  modelFallbackNotice?: string;
}

export interface StepOverrides {
  output?: string | false;
  outputMode?: OutputMode;
  reads?: string[] | false;
  progress?: boolean;
  skills?: string[] | false;
  model?: string;
  fallbackModels?: string[];
  modelFallbackNotice?: string;
}

function normalizeOutputOverride(output: string | false | undefined): string | false | undefined {
  return output === "false" ? false : output;
}

// =============================================================================
// Chain Step Types
// =============================================================================

/** Sequential step: single agent execution */
export interface SequentialStep {
  agent: string;
  task?: string;
  phase?: string;
  label?: string;
  as?: string;
  outputSchema?: JsonSchemaObject;
  cwd?: string;
  output?: string | false;
  outputMode?: OutputMode;
  reads?: string[] | false;
  progress?: boolean;
  model?: string;
  fallbackModels?: string[];
  modelFallbackNotice?: string;
  toolBudget?: ToolBudgetConfig;
  acceptance?: AcceptanceInput;
}

/** Parallel task item within a parallel step */
interface ParallelTaskItem {
  agent: string;
  task?: string;
  phase?: string;
  label?: string;
  as?: string;
  outputSchema?: JsonSchemaObject;
  cwd?: string;
  count?: number;
  output?: string | false;
  outputMode?: OutputMode;
  reads?: string[] | false;
  progress?: boolean;
  model?: string;
  fallbackModels?: string[];
  modelFallbackNotice?: string;
  toolBudget?: ToolBudgetConfig;
  acceptance?: AcceptanceInput;
}

/** Parallel step: multiple agents running concurrently */
interface ParallelStep {
  parallel: ParallelTaskItem[];
  concurrency?: number;
  failFast?: boolean;
  cwd?: string;
}

/** Union type for chain steps */
export type ChainStep = SequentialStep | ParallelStep;

// =============================================================================
// Type Guards
// =============================================================================

export function isParallelStep(step: ChainStep): step is ParallelStep {
  return "parallel" in step && Array.isArray((step as ParallelStep).parallel);
}

// =============================================================================
// Chain Directory Management
// =============================================================================

export function cleanupOldChainDirs(): void {
  if (!fs.existsSync(CHAIN_RUNS_DIR)) return;
  const now = Date.now();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(CHAIN_RUNS_DIR);
  } catch {
    // Startup cleanup is best-effort. If the scoped temp root is unreadable,
    // skip cleanup instead of failing extension startup.
    return;
  }

  for (const dir of dirs) {
    try {
      const dirPath = path.join(CHAIN_RUNS_DIR, dir);
      const stat = fs.statSync(dirPath);
      if (stat.isDirectory() && now - stat.mtimeMs > CHAIN_DIR_MAX_AGE_MS) {
        fs.rmSync(dirPath, { recursive: true });
      }
    } catch {
      // Skip directories that can't be processed; continue with others
    }
  }
}

// =============================================================================
// Behavior Resolution
// =============================================================================

/**
 * Resolve effective chain behavior per step.
 * Priority: step override > agent frontmatter > false (disabled)
 */
export function resolveStepBehavior(
  agentConfig: AgentConfig,
  stepOverrides: StepOverrides,
): ResolvedStepBehavior {
  // Output: step override > frontmatter > false (no output)
  const stepOutput = normalizeOutputOverride(stepOverrides.output);
  const output =
    stepOutput !== undefined ? stepOutput : (normalizeOutputOverride(agentConfig.output) ?? false);

  // Reads: step override > frontmatter defaultReads > false (no reads)
  const reads =
    stepOverrides.reads !== undefined ? stepOverrides.reads : (agentConfig.defaultReads ?? false);

  // Progress: step override > frontmatter defaultProgress > false
  const progress =
    stepOverrides.progress !== undefined
      ? stepOverrides.progress
      : (agentConfig.defaultProgress ?? false);

  let skills: string[] | false;
  if (stepOverrides.skills === false) {
    skills = false;
  } else if (stepOverrides.skills !== undefined) {
    skills = [...stepOverrides.skills];
  } else {
    skills = agentConfig.skills ? [...agentConfig.skills] : [];
  }

  const outputMode = stepOverrides.outputMode ?? "inline";
  const model = stepOverrides.model ?? agentConfig.model;
  const fallbackModels = stepOverrides.fallbackModels;
  const modelFallbackNotice = stepOverrides.modelFallbackNotice;
  return {
    output,
    outputMode,
    reads,
    progress,
    skills,
    model,
    fallbackModels,
    modelFallbackNotice,
  };
}

function resolveTaskTextForFileUpdatePolicy(
  task: string | undefined,
  originalTask?: string,
): string | undefined {
  if (!task) return originalTask;
  return originalTask ? task.replaceAll("{task}", originalTask) : task;
}

export function taskDisallowsFileUpdates(task: string | undefined): boolean {
  if (!task) return false;
  return (
    /\breview[- ]only\b/i.test(task) ||
    /\bread[- ]only\s+(?:review|audit|inspection|pass)\b/i.test(task) ||
    /\b(?:no|without)\s+(?:file\s+)?edits?\b/i.test(task) ||
    /\b(?:do not|don't|must not)\s+(?:edit|modify|write|touch)\b/i.test(task) ||
    /\bleave\s+files?\s+unchanged\b/i.test(task)
  );
}

export function suppressProgressForReadOnlyTask(
  behavior: ResolvedStepBehavior,
  task: string | undefined,
  originalTask?: string,
): ResolvedStepBehavior {
  const policyTask = resolveTaskTextForFileUpdatePolicy(task, originalTask);
  return behavior.progress && taskDisallowsFileUpdates(policyTask)
    ? { ...behavior, progress: false }
    : behavior;
}

// =============================================================================
// Execution Instruction Injection
// =============================================================================

/**
 * Resolve a file path: absolute paths pass through, relative paths get baseDir prepended.
 */
function resolveExecutionPath(filePath: string, baseDir: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(baseDir, filePath);
}

/**
 * Build execution instructions from resolved behavior.
 * These are appended to the task to tell the agent what to read/write.
 */
export function buildExecutionInstructions(
  behavior: ResolvedStepBehavior,
  baseDir: string,
  isFirstProgressAgent: boolean,
  previousSummary?: string,
): { prefix: string; suffix: string } {
  const prefixParts: string[] = [];
  const suffixParts: string[] = [];

  // READS - prepend to override any hardcoded filenames in task text
  if (behavior.reads && behavior.reads.length > 0) {
    const files = behavior.reads.map((f) => resolveExecutionPath(f, baseDir));
    prefixParts.push(`[Read from: ${files.join(", ")}]`);
  }

  // OUTPUT - prepend so agent knows where to write
  if (behavior.output) {
    const outputPath = resolveExecutionPath(behavior.output, baseDir);
    prefixParts.push(`[Write to: ${outputPath}]`);
  }

  // Progress instructions in suffix (less critical)
  if (behavior.progress) {
    const progressPath = path.join(baseDir, "progress.md");
    if (isFirstProgressAgent) {
      suffixParts.push(`Create and maintain progress at: ${progressPath}`);
    } else {
      suffixParts.push(`Update progress at: ${progressPath}`);
    }
  }

  // Include previous step's summary in suffix if available
  if (previousSummary && previousSummary.trim()) {
    suffixParts.push(`Previous step output:\n${previousSummary.trim()}`);
  }

  const prefix = prefixParts.length > 0 ? prefixParts.join("\n") + "\n\n" : "";

  const suffix = suffixParts.length > 0 ? "\n\n---\n" + suffixParts.join("\n") : "";

  return { prefix, suffix };
}

/**
 * Compatibility name retained for historical chain readers.
 */
export function buildChainInstructions(
  behavior: ResolvedStepBehavior,
  chainDir: string,
  isFirstProgressAgent: boolean,
  previousSummary?: string,
): { prefix: string; suffix: string } {
  return buildExecutionInstructions(behavior, chainDir, isFirstProgressAgent, previousSummary);
}

export function writeInitialProgressFile(progressDir: string): void {
  fs.mkdirSync(progressDir, { recursive: true });
  fs.writeFileSync(path.join(progressDir, "progress.md"), INITIAL_PROGRESS_CONTENT);
}

export type { ParallelTaskResult } from "../runs/shared/parallel-utils.ts";
export { aggregateParallelOutputs } from "../runs/shared/parallel-utils.ts";
