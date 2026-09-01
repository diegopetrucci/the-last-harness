import { isParallelStep, type ChainStep, type SequentialStep } from "../../shared/settings.ts";
import type { SubagentRunPlan } from "./parallel-utils.ts";
import type {
  SingleResult,
  SubagentRunMode,
  WorkflowGraphNode,
  WorkflowGraphSnapshot,
  WorkflowNodeStatus,
} from "../../shared/types.ts";

interface WorkflowGraphBuildInput {
  runId: string;
  mode?: SubagentRunMode;
  /** Legacy chain graph input retained for historical readers. */
  steps?: ChainStep[];
  /** Direct single/parallel graph input used by active runs. */
  plan?: SubagentRunPlan;
  results?: Array<Pick<SingleResult, "exitCode" | "interrupted" | "error" | "acceptance">>;
  currentFlatIndex?: number;
  currentStepIndex?: number;
  stepStatuses?: Array<{ status?: string; error?: string }>;
}

function normalizeStatus(status: string | undefined): WorkflowNodeStatus | undefined {
  switch (status) {
    case "complete":
    case "completed":
      return "completed";
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "paused":
      return "paused";
    case "pending":
      return "pending";
    default:
      return undefined;
  }
}

function resultStatus(
  result: Pick<SingleResult, "exitCode" | "interrupted"> | undefined,
): WorkflowNodeStatus | undefined {
  if (!result) return undefined;
  if (result.interrupted) return "paused";
  return result.exitCode === 0 ? "completed" : "failed";
}

function nodeStatus(input: WorkflowGraphBuildInput, flatIndex: number): WorkflowNodeStatus {
  return (
    normalizeStatus(input.stepStatuses?.[flatIndex]?.status) ??
    resultStatus(input.results?.[flatIndex]) ??
    (input.currentFlatIndex === flatIndex ? "running" : "pending")
  );
}

function pushPhase(
  phases: WorkflowGraphSnapshot["phases"],
  phase: string | undefined,
  nodeId: string,
): void {
  if (!phase) return;
  let group = phases.find((candidate) => candidate.title === phase);
  if (!group) {
    group = { title: phase, nodeIds: [] };
    phases.push(group);
  }
  group.nodeIds.push(nodeId);
}

function seqLabel(step: SequentialStep, stepIndex: number): string {
  return step.label?.trim() || step.agent || `Step ${stepIndex + 1}`;
}

function summarizeParallelStatuses(statuses: WorkflowNodeStatus[]): WorkflowNodeStatus {
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "paused")) return "paused";
  if (statuses.length > 0 && statuses.every((status) => status === "completed")) return "completed";
  if (statuses.some((status) => status === "completed")) return "running";
  return "pending";
}

export function buildWorkflowGraphSnapshot(input: WorkflowGraphBuildInput): WorkflowGraphSnapshot {
  const nodes: WorkflowGraphNode[] = [];
  const phases: WorkflowGraphSnapshot["phases"] = [];
  let flatIndex = 0;
  let currentNodeId: string | undefined;

  if (input.plan) {
    if (input.plan.kind === "parallel") {
      const stepIndex = 0;
      const groupId = "step-0";
      const children: WorkflowGraphNode[] = [];
      const childStatuses: WorkflowNodeStatus[] = [];
      for (let taskIndex = 0; taskIndex < input.plan.tasks.length; taskIndex++) {
        const task = input.plan.tasks[taskIndex]!;
        const status = nodeStatus(input, flatIndex);
        childStatuses.push(status);
        const childId = `step-0-agent-${taskIndex}`;
        const child: WorkflowGraphNode = {
          id: childId,
          kind: "agent",
          agent: task.agent,
          phase: task.phase,
          label: task.label?.trim() || task.agent || `Agent ${taskIndex + 1}`,
          status,
          flatIndex,
          stepIndex,
          outputName: task.outputName,
          structured: Boolean(task.structured),
          acceptanceStatus: input.results?.[flatIndex]?.acceptance?.status,
          error: input.stepStatuses?.[flatIndex]?.error ?? input.results?.[flatIndex]?.error,
        };
        children.push(child);
        pushPhase(phases, task.phase, childId);
        if (status === "running" || input.currentFlatIndex === flatIndex) currentNodeId = childId;
        flatIndex++;
      }
      if (input.currentStepIndex === stepIndex && !currentNodeId) currentNodeId = groupId;
      nodes.push({
        id: groupId,
        kind: "parallel-group",
        label:
          input.plan.tasks.length === 1
            ? "Parallel task"
            : `Parallel group (${input.plan.tasks.length})`,
        status: summarizeParallelStatuses(childStatuses),
        stepIndex,
        children,
      });
    } else {
      const task = input.plan.task;
      const status = nodeStatus(input, flatIndex);
      const id = "step-0";
      nodes.push({
        id,
        kind: "step",
        agent: task.agent,
        phase: task.phase,
        label: task.label?.trim() || task.agent || "Step 1",
        status,
        flatIndex,
        stepIndex: 0,
        outputName: task.outputName,
        structured: Boolean(task.structured),
        acceptanceStatus: input.results?.[flatIndex]?.acceptance?.status,
        error: input.stepStatuses?.[flatIndex]?.error ?? input.results?.[flatIndex]?.error,
      });
      pushPhase(phases, task.phase, id);
      if (
        status === "running" ||
        input.currentFlatIndex === flatIndex ||
        input.currentStepIndex === 0
      )
        currentNodeId = id;
    }
    return {
      runId: input.runId,
      mode: input.mode ?? (input.plan.kind === "parallel" ? "parallel" : "single"),
      phases,
      nodes,
      currentNodeId,
    };
  }

  const steps = input.steps ?? [];
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex]!;
    if (isParallelStep(step)) {
      const groupId = `step-${stepIndex}`;
      const children: WorkflowGraphNode[] = [];
      const childStatuses: WorkflowNodeStatus[] = [];
      for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
        const task = step.parallel[taskIndex]!;
        const status = nodeStatus(input, flatIndex);
        childStatuses.push(status);
        const childId = `step-${stepIndex}-agent-${taskIndex}`;
        const child: WorkflowGraphNode = {
          id: childId,
          kind: "agent",
          agent: task.agent,
          phase: task.phase,
          label: task.label?.trim() || task.agent || `Agent ${taskIndex + 1}`,
          status,
          flatIndex,
          stepIndex,
          outputName: task.as,
          structured: Boolean(task.outputSchema),
          acceptanceStatus: input.results?.[flatIndex]?.acceptance?.status,
          error: input.stepStatuses?.[flatIndex]?.error ?? input.results?.[flatIndex]?.error,
        };
        children.push(child);
        pushPhase(phases, task.phase, childId);
        if (status === "running" || input.currentFlatIndex === flatIndex) currentNodeId = childId;
        flatIndex++;
      }
      const groupStatus = summarizeParallelStatuses(childStatuses);
      if (input.currentStepIndex === stepIndex && !currentNodeId) currentNodeId = groupId;
      nodes.push({
        id: groupId,
        kind: "parallel-group",
        label:
          step.parallel.length === 1 ? "Parallel task" : `Parallel group (${step.parallel.length})`,
        status: groupStatus,
        stepIndex,
        children,
      });
      continue;
    }

    const seq = step as SequentialStep;
    const status = nodeStatus(input, flatIndex);
    const id = `step-${stepIndex}`;
    nodes.push({
      id,
      kind: "step",
      agent: seq.agent,
      phase: seq.phase,
      label: seqLabel(seq, stepIndex),
      status,
      flatIndex,
      stepIndex,
      outputName: seq.as,
      structured: Boolean(seq.outputSchema),
      acceptanceStatus: input.results?.[flatIndex]?.acceptance?.status,
      error: input.stepStatuses?.[flatIndex]?.error ?? input.results?.[flatIndex]?.error,
    });
    pushPhase(phases, seq.phase, id);
    if (
      status === "running" ||
      input.currentFlatIndex === flatIndex ||
      input.currentStepIndex === stepIndex
    )
      currentNodeId = id;
    flatIndex++;
  }

  return {
    runId: input.runId,
    mode: input.mode ?? "chain",
    phases,
    nodes,
    currentNodeId,
  };
}
