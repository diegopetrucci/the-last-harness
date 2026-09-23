import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentDiscoveryDiagnostic, AgentScope } from "../../agents/agents.ts";
import type { ResolvedExecutionPolicy } from "../../agents/execution-ceiling.ts";
import type {
  ProjectAgentIdentity,
  ProjectAgentTrustStore,
} from "../../agents/project-agent-loader.ts";
import type {
  ControlConfig,
  ExtensionConfig,
  MaxOutputConfig,
  ResolvedArtifactConfig,
  SubagentState,
} from "../../shared/types.ts";
import type { ModelScopeConfig } from "./model-scope.ts";

export interface TaskParam {
  agent: string;
  task: string;
  ticket?: string;
  cwd?: string;
  count?: number;
  output?: string | boolean;
  outputMode?: "inline" | "file-only";
  model?: string;
  modelFallbackNotice?: string;
}

export interface SubagentParamsLike {
  action?: string;
  id?: string;
  /** Internal trusted directory override; omitted from the model-facing schema. */
  dir?: string;
  index?: number;
  /** Status-only retained-output view. */
  view?: "transcript";
  /** Status transcript tail size, bounded by the executor. */
  lines?: number;
  agent?: string;
  task?: string;
  ticket?: string;
  message?: string;
  /** Chain-shaped input is intentionally unsupported; kept only for fail-closed validation. */
  chain?: unknown;
  tasks?: TaskParam[];
  async?: boolean;
  clarify?: boolean;
  share?: boolean;
  control?: ControlConfig;
  sessionDir?: string;
  cwd?: string;
  maxOutput?: MaxOutputConfig;
  artifacts?: boolean;
  model?: string;
  modelFallbackNotice?: string;
  skill?: string | string[] | boolean;
  output?: string | boolean;
  outputMode?: "inline" | "file-only";
  agentScope?: unknown;
  chainDir?: string;
  schedule?: string;
  scheduleName?: string;
  chainName?: string;
  config?: unknown;
}

export interface ProjectAgentAccess {
  /** True only while the architect is active; retained controls require this. */
  architect: boolean;
  /** Architect and disabled mode may initiate a new project-agent execution. */
  canInitiate?: boolean;
  /** Host-owned persisted trust dependencies; never model-facing. */
  agentDir?: string;
  trustStore?: ProjectAgentTrustStore;
  createProjectTrustStore?: (agentDir: string) => ProjectAgentTrustStore;
}

export type ProjectAgentRunIdentity = ProjectAgentIdentity;

interface ProjectAgentAccessRequest {
  cwd: string;
  sessionId: string | null;
  targetNames: readonly string[];
}

/** Session-level heartbeat totals surfaced in the doctor output. */
interface HeartbeatSessionSummary {
  enabled: boolean;
  totalBeats: number;
  totalCacheReadTokens: number;
  totalBeatCostUsd: number;
  gapsSaved: number;
  gapsWasted: number;
  gapsLost: number;
  gapsUnneeded: number;
  breakerDisabled: boolean;
}

export interface ExecutorDeps {
  pi: ExtensionAPI;
  state: SubagentState;
  config: ExtensionConfig;
  /** Resolved once by the trusted parent; optional for direct test/legacy callers. */
  artifactConfig?: ResolvedArtifactConfig;
  /** Resolved once by the trusted parent; optional for direct test/legacy callers. */
  executionPolicy?: ResolvedExecutionPolicy;
  tempArtifactsDir: string;
  getSubagentSessionRoot: (parentSessionFile: string | null) => string;
  expandTilde: (p: string) => string;
  discoverAgents: (
    cwd: string,
    scope: AgentScope,
  ) => {
    agents: AgentConfig[];
    modelScope?: ModelScopeConfig;
    agentDiagnostics?: AgentDiscoveryDiagnostic[];
  };
  getProjectAgentAccess?: (request: ProjectAgentAccessRequest) => ProjectAgentAccess | undefined;
  /** Narrow functional seam for exercising continuation authorization without spawning a child. */
  executeAsyncSingle?: typeof import("../background/async-execution.ts").executeAsyncSingle;
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  /** Optional: retrieve current-session heartbeat totals for the doctor action. */
  getHeartbeatSummary?: () => HeartbeatSessionSummary;
}
