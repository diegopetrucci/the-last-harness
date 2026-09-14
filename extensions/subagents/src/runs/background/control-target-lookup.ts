import * as fs from "node:fs";
import * as path from "node:path";

import {
  clearTlhSubagentControlTargetAccessProvider,
  setTlhSubagentControlTargetAccessProvider,
} from "../../../../the-last-harness/subagent-control-access.mjs";
import { resolveAsyncRunLocation } from "./async-resume.ts";
import { resolveSubagentRunId } from "./run-id-resolver.ts";
import type {
  AsyncJobState,
  AsyncStatus,
  ForegroundResumeRun,
  NestedRunSummary,
  SubagentState,
} from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";

export type SubagentControlTargetRequest = {
  action?: string;
  id?: string;
  dir?: string;
  index?: number;
};

type TargetMetadataStep = {
  agent: unknown;
  status?: unknown;
};

type TargetMetadata = {
  state?: unknown;
  agent?: unknown;
  steps: TargetMetadataStep[];
  hasRoleFields: boolean;
};

type MetadataRecord = {
  state?: unknown;
  agent?: unknown;
  steps?: unknown;
  results?: unknown;
};

type AsyncTarget = {
  kind: "async";
  runId: string;
  asyncDir: string | null;
  resultPath: string | null;
  stateJob?: AsyncJobState;
};

type ForegroundTarget = {
  kind: "foreground";
  run: ForegroundResumeRun;
};

type NestedTarget = {
  kind: "nested";
  run: NestedRunSummary;
};

type Target = AsyncTarget | ForegroundTarget | NestedTarget;

type TargetResolution =
  | { status: "found"; target: Target }
  | { status: "missing" | "ambiguous" | "opaque" };

type Selection = { status: "found"; agents: string[] } | { status: "ambiguous" | "opaque" };

export type SubagentControlTargetAccess =
  | { status: "found"; runId?: string; agents: string[] }
  | { status: "missing" | "ambiguous" | "opaque" };

export type SubagentControlTargetLookupOptions = {
  asyncDirRoot: string;
  resultsDir: string;
};

const CONTROL_ACTIONS = new Set(["resume", "steer"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAgent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeRequest(
  request: SubagentControlTargetRequest,
):
  | { status: "valid"; action: "resume" | "steer"; id?: string; dir?: string; index?: number }
  | { status: "missing" | "opaque" } {
  if (!CONTROL_ACTIONS.has(request.action ?? "")) return { status: "opaque" };
  const action = request.action as "resume" | "steer";
  if (request.id !== undefined) {
    if (typeof request.id !== "string" || request.id.trim().length === 0) {
      return { status: "opaque" };
    }
  }
  if (request.dir !== undefined) {
    if (typeof request.dir !== "string" || request.dir.trim().length === 0) {
      return { status: "opaque" };
    }
  }
  if (request.index !== undefined && (!Number.isInteger(request.index) || request.index < 0)) {
    return { status: "opaque" };
  }
  if (request.id === undefined && request.dir === undefined) return { status: "missing" };
  return {
    status: "valid",
    action,
    ...(request.id !== undefined ? { id: request.id.trim() } : {}),
    ...(request.dir !== undefined ? { dir: request.dir } : {}),
    ...(request.index !== undefined ? { index: request.index } : {}),
  };
}

function asyncJobForTarget(
  state: SubagentState,
  target: { runId?: string; asyncDir: string | null },
): AsyncJobState | undefined {
  const jobs = [...state.asyncJobs.values()];
  const runId = target.runId;
  if (runId) {
    const exact = jobs.find((job) => job.asyncId === runId || state.asyncJobs.get(runId) === job);
    if (exact) return exact;
  }
  if (!target.asyncDir) return undefined;
  const targetDir = path.resolve(target.asyncDir);
  return jobs.find((job) => path.resolve(job.asyncDir) === targetDir);
}

function stateAsyncPrefixTarget(
  state: SubagentState,
  prefix: string,
): { status: "found"; target: AsyncTarget } | { status: "ambiguous" | "missing" } {
  const matches = [...state.asyncJobs.entries()]
    .filter(([key, job]) => job.asyncId.startsWith(prefix) || key.startsWith(prefix))
    .map(([, job]) => job);
  if (matches.length > 1) return { status: "ambiguous" };
  const job = matches[0];
  if (!job) return { status: "missing" };
  return {
    status: "found",
    target: {
      kind: "async",
      runId: job.asyncId,
      asyncDir: job.asyncDir,
      resultPath: null,
      stateJob: job,
    },
  };
}

function resolveTarget(
  request: ReturnType<typeof normalizeRequest> & { status: "valid" },
  state: SubagentState,
  options: SubagentControlTargetLookupOptions,
): TargetResolution {
  if (request.dir !== undefined) {
    try {
      const location = resolveAsyncRunLocation(
        { id: request.id, dir: request.dir, index: request.index },
        options.asyncDirRoot,
        options.resultsDir,
      );
      const runId = location.resolvedId ?? path.basename(location.asyncDir ?? request.dir);
      return {
        status: "found",
        target: {
          kind: "async",
          runId,
          asyncDir: location.asyncDir,
          resultPath: location.resultPath,
          stateJob: asyncJobForTarget(state, location),
        },
      };
    } catch {
      return { status: "opaque" };
    }
  }

  const requestedId = request.id;
  if (!requestedId) return { status: "missing" };

  let resolved: ReturnType<typeof resolveSubagentRunId>;
  try {
    resolved = resolveSubagentRunId(requestedId, {
      state,
      asyncDirRoot: options.asyncDirRoot,
      resultsDir: options.resultsDir,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return /ambiguous/i.test(message) ? { status: "ambiguous" } : { status: "opaque" };
  }

  if (resolved?.kind === "async") {
    return {
      status: "found",
      target: {
        kind: "async",
        runId: resolved.id,
        asyncDir: resolved.location.asyncDir,
        resultPath: resolved.location.resultPath,
        stateJob: asyncJobForTarget(state, resolved.location),
      },
    };
  }
  if (resolved?.kind === "foreground") {
    const run = state.foregroundRuns?.get(resolved.id);
    return run ? { status: "found", target: { kind: "foreground", run } } : { status: "opaque" };
  }
  if (resolved?.kind === "nested") {
    return { status: "found", target: { kind: "nested", run: resolved.match.run } };
  }

  const stateTarget = stateAsyncPrefixTarget(state, requestedId);
  if (stateTarget.status === "found") return stateTarget;
  return stateTarget;
}

function metadataFromRecord(record: MetadataRecord, result: boolean): TargetMetadata {
  const rawSteps = result ? record.results : record.steps;
  const steps = Array.isArray(rawSteps)
    ? rawSteps.map((rawStep): TargetMetadataStep => {
        if (!isRecord(rawStep)) return { agent: undefined };
        const status =
          typeof rawStep.status === "string"
            ? rawStep.status
            : result && typeof rawStep.success === "boolean"
              ? rawStep.success
                ? "complete"
                : "failed"
              : undefined;
        return { agent: rawStep.agent, ...(status !== undefined ? { status } : {}) };
      })
    : [];
  const hasRoleFields = steps.length > 0 || Object.hasOwn(record, "agent");
  return {
    state: record.state,
    agent: record.agent,
    steps,
    hasRoleFields,
  };
}

function metadataFromStatus(status: AsyncStatus): TargetMetadata {
  return metadataFromRecord(status, false);
}

function readPersistedMetadata(
  target: AsyncTarget,
): { status: "found"; metadata: TargetMetadata; runId: string } | { status: "missing" | "opaque" } {
  let status: AsyncStatus | null = null;
  if (target.asyncDir) {
    const statusPath = path.join(target.asyncDir, "status.json");
    if (fs.existsSync(statusPath)) {
      try {
        status = readStatus(target.asyncDir);
      } catch {
        return { status: "opaque" };
      }
      if (status) {
        const metadata = metadataFromStatus(status);
        if (metadata.hasRoleFields) {
          return { status: "found", metadata, runId: status.runId || target.runId };
        }
      }
    }
  }

  if (target.resultPath && fs.existsSync(target.resultPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(target.resultPath, "utf8"));
    } catch {
      return { status: "opaque" };
    }
    if (!isRecord(parsed)) return { status: "opaque" };
    const metadata = metadataFromRecord(parsed, true);
    if (metadata.hasRoleFields) {
      const runId =
        (typeof parsed.runId === "string" && parsed.runId) ||
        (typeof parsed.id === "string" && parsed.id) ||
        target.runId;
      return { status: "found", metadata, runId };
    }
  }

  if (status) return { status: "found", metadata: metadataFromStatus(status), runId: status.runId };
  return { status: "missing" };
}

function metadataFromAsyncJob(job: AsyncJobState | undefined): TargetMetadata | undefined {
  if (!job) return undefined;
  if (Array.isArray(job.steps) && job.steps.length > 0) {
    return {
      state: job.status,
      steps: job.steps.map((step) => ({ agent: step.agent, status: step.status })),
      hasRoleFields: true,
    };
  }
  if (Array.isArray(job.agents) && job.agents.length > 0) {
    return {
      state: job.status,
      steps: job.agents.map((agent) => ({ agent, status: job.status })),
      hasRoleFields: true,
    };
  }
  return undefined;
}

function metadataFromForegroundRun(run: ForegroundResumeRun): TargetMetadata {
  return {
    steps: run.children.map((child) => ({ agent: child.agent, status: child.status })),
    hasRoleFields: run.children.length > 0,
  };
}

function metadataFromNestedRun(run: NestedRunSummary): TargetMetadata {
  if (Array.isArray(run.steps) && run.steps.length > 0) {
    return {
      state: run.state,
      steps: run.steps.map((step) => ({ agent: step.agent, status: step.status })),
      hasRoleFields: true,
    };
  }
  return {
    state: run.state,
    agent: run.agent,
    steps: [],
    hasRoleFields: Object.hasOwn(run, "agent"),
  };
}

function roleMetadataForTarget(
  target: Target,
): { status: "found"; metadata: TargetMetadata; runId: string } | { status: "missing" | "opaque" } {
  if (target.kind === "async") {
    const persisted = readPersistedMetadata(target);
    if (persisted.status === "found") return persisted;
    if (persisted.status === "opaque") return persisted;
    const live = metadataFromAsyncJob(target.stateJob);
    return live ? { status: "found", metadata: live, runId: target.runId } : { status: "missing" };
  }
  if (target.kind === "foreground") {
    return {
      status: "found",
      metadata: metadataFromForegroundRun(target.run),
      runId: target.run.runId,
    };
  }
  return { status: "found", metadata: metadataFromNestedRun(target.run), runId: target.run.id };
}

function selectAgents(
  metadata: TargetMetadata,
  request: ReturnType<typeof normalizeRequest> & { status: "valid" },
): Selection {
  if (!metadata.hasRoleFields) return { status: "opaque" };

  const steps = metadata.steps;
  if (steps.length === 0) {
    if (request.index !== undefined) return { status: "opaque" };
    const agent = normalizeAgent(metadata.agent);
    return agent ? { status: "found", agents: [agent] } : { status: "opaque" };
  }

  const normalizeSelected = (selected: TargetMetadataStep[]): Selection => {
    const agents = selected.map((step) => normalizeAgent(step.agent));
    if (agents.some((agent): agent is undefined => agent === undefined))
      return { status: "opaque" };
    return { status: "found", agents: [...new Set(agents as string[])] };
  };

  if (request.index !== undefined) {
    const selected = steps[request.index];
    return selected ? normalizeSelected([selected]) : { status: "opaque" };
  }

  if (request.action === "resume") {
    if (metadata.state === "running") {
      const running = steps.filter((step) => step.status === "running");
      if (running.length === 1) return normalizeSelected(running);
      // The executor still rejects an index-less ambiguous resume. Expose all
      // known running roles here solely so the disabled staff safety gate can
      // block a mixed target without changing non-staff executor behavior.
      return running.length > 1 ? normalizeSelected(running) : { status: "ambiguous" };
    }
    if (steps.length === 1) return normalizeSelected([steps[0]!]);
    // As above, preserve the executor's ambiguity while making a known mixed
    // terminal cohort visible to the staff safety gate.
    return normalizeSelected(steps);
  }

  const running = steps.filter((step) => step.status === "running");
  if (running.length > 0) return normalizeSelected(running);
  if (steps.length === 1) return normalizeSelected([steps[0]!]);
  // A no-index steer with no running child remains executor-invalid, but a
  // known mixed cohort must still be denied when it contains staff.
  return normalizeSelected(steps);
}

/**
 * Inspect live and persisted control metadata without reconciling lifecycle
 * state.  The returned object contains only target role names; it never
 * exposes status objects, paths, control inboxes, or nested capabilities.
 */
export function lookupSubagentControlTarget(
  request: SubagentControlTargetRequest,
  state: SubagentState,
  options: SubagentControlTargetLookupOptions,
): SubagentControlTargetAccess {
  const normalized = normalizeRequest(request);
  if (normalized.status !== "valid") return normalized;

  const target = resolveTarget(normalized, state, options);
  if (target.status !== "found") return target;
  const metadata = roleMetadataForTarget(target.target);
  if (metadata.status !== "found") return metadata;
  const selection = selectAgents(metadata.metadata, normalized);
  if (selection.status !== "found") return selection;
  return { status: "found", runId: metadata.runId, agents: selection.agents };
}

/**
 * Register the production bridge used by the primary runtime.  Cleanup is
 * ownership-aware so a stale extension reload cannot remove a newer provider.
 */
export function registerSubagentControlTargetLookup(
  state: SubagentState,
  options: SubagentControlTargetLookupOptions,
): () => void {
  const provider = (request: SubagentControlTargetRequest): SubagentControlTargetAccess =>
    lookupSubagentControlTarget(request, state, options);
  setTlhSubagentControlTargetAccessProvider(provider);
  return () => clearTlhSubagentControlTargetAccessProvider(provider);
}
