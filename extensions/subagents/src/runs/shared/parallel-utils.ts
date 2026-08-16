export interface RunnerSubagentStep {
  /** Session id of the direct parent session for permission-system ask forwarding. */
  parentSessionId?: string;
  agent: string;
  task: string;
  phase?: string;
  label?: string;
  outputName?: string;
  structured?: boolean;
  cwd?: string;
  model?: string;
  thinking?: string;
  modelIdentity?: import("../../shared/types.ts").SubagentModelIdentity;
  modelResolution?: import("../../shared/types.ts").SubagentModelResolution;
  /** Persisted context diagnostics used to initialize a durable continuation. */
  contextUsage?: import("../../shared/types.ts").ContextUsageDiagnostics;
  contextPressure?: import("../../shared/types.ts").ContextPressureProjection;
  contextPressureCrossedThresholds?: import("../../shared/types.ts").ContextPressureThreshold[];
  /** Notes collected while preparing this dispatch, surfaced with attempt notes. */
  attemptNotes?: string[];
  /**
   * Model references whose configured thinking level dispatch preparation
   * dropped as unsupported. Authoritative per-candidate metadata that survives
   * cross-step deduplication of duplicate human-facing attempt notes.
   */
  thinkingDroppedModels?: string[];
  modelCandidates?: string[];
  /** Effective context windows keyed by provider-qualified base model ids, without thinking suffixes. */
  contextWindows?: Record<string, number>;
  modelFallbackNotice?: string;
  tools?: string[];
  extensions?: string[];
  subagentOnlyExtensions?: string[];
  completionGuard?: boolean;
  systemPrompt?: string | null;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  skills?: string[];
  outputPath?: string;
  outputMode?: "inline" | "file-only";
  sessionFile?: string;
  maxSubagentDepth?: number;
  structuredOutput?: {
    schema: import("../../shared/types.ts").JsonSchemaObject;
    schemaPath: string;
    outputPath: string;
  };
  structuredOutputSchema?: import("../../shared/types.ts").JsonSchemaObject;
  effectiveAcceptance?: import("../../shared/types.ts").ResolvedAcceptanceConfig;
  acceptanceInput?: import("../../shared/types.ts").AcceptanceInput;
  acceptanceRole?: import("../../shared/types.ts").AcceptanceRole;
  toolBudget?: import("../../shared/types.ts").ResolvedToolBudget;
  /** Remaining active execution allowance for this child segment. */
  timeoutMs?: number;
  /** Active child runtime accumulated before this segment. */
  activeRuntimeMs?: number;
}

export interface ParallelStepGroup {
  parallel: RunnerSubagentStep[];
  concurrency?: number;
  failFast?: boolean;
}

export type RunnerStep = RunnerSubagentStep | ParallelStepGroup;

export function isParallelGroup(step: RunnerStep): step is ParallelStepGroup {
  return "parallel" in step && Array.isArray(step.parallel);
}

export function flattenSteps(steps: RunnerStep[]): RunnerSubagentStep[] {
  const flat: RunnerSubagentStep[] = [];
  for (const step of steps) {
    if (isParallelGroup(step)) {
      for (const task of step.parallel) flat.push(task);
    } else {
      flat.push(step);
    }
  }
  return flat;
}

export const DEFAULT_GLOBAL_CONCURRENCY_LIMIT = 20;

/**
 * A promise-based semaphore for limiting concurrent access across multiple
 * mapConcurrent calls within a single run. Enforces a global cap on the total
 * number of subagent tasks executing simultaneously, regardless of each step's
 * per-step concurrency limit.
 */
export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.available = Math.max(1, Math.floor(limit) || 1);
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
}

export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
  globalSemaphore?: Semaphore,
): Promise<R[]> {
  const safeLimit = Math.max(1, Math.floor(limit) || 1);
  const results: R[] = Array.from<R>({ length: items.length });
  let next = 0;

  async function worker(_workerIndex: number): Promise<void> {
    while (next < items.length) {
      const i = next++;
      if (globalSemaphore) {
        await globalSemaphore.acquire();
        try {
          results[i] = await fn(items[i], i);
        } finally {
          globalSemaphore.release();
        }
      } else {
        results[i] = await fn(items[i], i);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(safeLimit, items.length) }, (_, wi) => worker(wi)),
  );
  return results;
}

export interface ParallelTaskResult {
  agent: string;
  taskIndex?: number;
  output: string;
  exitCode: number | null;
  error?: string;
  timedOut?: boolean;
  model?: string;
  attemptedModels?: string[];
  modelFallbackNotice?: string;
  outputTargetPath?: string;
  outputTargetExists?: boolean;
}

export function aggregateParallelOutputs(
  results: ParallelTaskResult[],
  headerFormat: (index: number, agent: string) => string = (i, agent) =>
    `=== Parallel Task ${i + 1} (${agent}) ===`,
): string {
  return results
    .map((r, i) => {
      const header = headerFormat(r.taskIndex ?? i, r.agent);
      const hasOutput = Boolean(r.output?.trim());
      const notice = r.modelFallbackNotice ? `Notice: ${r.modelFallbackNotice}` : "";
      const status = r.timedOut
        ? `TIMED OUT${r.error ? `: ${r.error}` : ""}`
        : r.exitCode === -1
          ? "SKIPPED"
          : r.exitCode !== 0 && r.exitCode !== null
            ? `FAILED (exit code ${r.exitCode})${r.error ? `: ${r.error}` : ""}`
            : r.error
              ? `WARNING: ${r.error}`
              : !hasOutput && r.outputTargetPath && r.outputTargetExists === false
                ? `EMPTY OUTPUT (expected output file missing: ${r.outputTargetPath})`
                : !hasOutput && !r.outputTargetPath
                  ? "EMPTY OUTPUT (no textual response returned)"
                  : "";
      const body = status ? (hasOutput ? `${status}\n${r.output}` : status) : r.output;
      return `${header}\n${[notice, body].filter(Boolean).join("\n")}`;
    })
    .join("\n\n");
}

export const MAX_PARALLEL_CONCURRENCY = 4;
