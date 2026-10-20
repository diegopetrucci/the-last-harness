import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentDiscoveryDiagnostic, AgentScope } from "../../agents/agents.ts";
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
  /** Retained project-agent controls require an enabled primary agent. */
  canManage?: boolean;
  /** True only while the architect is active; retained for compatibility diagnostics. */
  architect: boolean;
  /** Enabled primaries and disabled mode may initiate a new project-agent execution. */
  canInitiate?: boolean;
  /**
   * Resume/steer may only target authorized embedded project agents (Rush).
   * Enforced by the executor against the exact persisted child records it acts on.
   */
  controlRestrictedToEmbedded?: boolean;
  /** Host-supplied rejection texts for restricted resume/steer. */
  resumeRestrictionReason?: string;
  steerRestrictionReason?: string;
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

export interface ExecutorDeps {
  pi: ExtensionAPI;
  state: SubagentState;
  config: ExtensionConfig;
  /** Resolved once by the trusted parent; optional for direct test/legacy callers. */
  artifactConfig?: ResolvedArtifactConfig;
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
  /** Narrow functional seams for exercising async dispatch without spawning a child. */
  executeAsyncSingle?: typeof import("../background/async-execution.ts").executeAsyncSingle;
  executeAsyncParallel?: typeof import("../background/async-execution.ts").executeAsyncParallel;
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  /** Parent-captured telemetry provenance forwarded to child runs. */
  telemetryProvenance?: import("../../shared/telemetry.ts").SubagentTelemetryProvenance;
}
