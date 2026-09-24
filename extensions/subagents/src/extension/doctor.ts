import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgentsAll } from "../agents/agents.ts";
import {
  resolveCanonicalGitWorktreeRoot,
  resolveProjectAgentTrust,
  type ProjectAgentTrustOptions,
  type ProjectAgentTrustResult,
} from "../agents/project-agent-loader.ts";
import { resolveExecutionPolicy } from "../agents/execution-ceiling.ts";
import { isAsyncAvailable } from "../runs/background/async-execution.ts";
import { discoverAvailableSkills, SOURCE_PRIORITY, type SkillSource } from "../agents/skills.ts";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  TEMP_ROOT_DIR,
  type ExtensionConfig,
  type SubagentState,
} from "../shared/types.ts";
import { inspectRuntimeDirs } from "./runtime-cleanup.ts";
import {
  listAsyncRuns,
  type AsyncRunUnreadableStatusIssue,
} from "../runs/background/async-status.ts";
import {
  formatUnreadableStatus,
  MAX_UNREADABLE_STATUS_REPORTS,
} from "../runs/background/async-status-boundary.ts";

interface DoctorPaths {
  tempRootDir: string;
  asyncDir: string;
  resultsDir: string;
}

interface DoctorDeps {
  isAsyncAvailable: () => boolean;
  discoverAgentsAll: typeof discoverAgentsAll;
  discoverAvailableSkills: typeof discoverAvailableSkills;
}

export type ProjectAgentDoctorTrust = ProjectAgentTrustResult | { readonly kind: "unavailable" };

export async function resolveProjectAgentDoctorTrust(
  cwd: string,
  options: ProjectAgentTrustOptions = {},
): Promise<ProjectAgentDoctorTrust> {
  const projectRoot = resolveCanonicalGitWorktreeRoot(cwd);
  if (!projectRoot) return { kind: "unavailable" };
  if (options.trustStore === undefined && options.createProjectTrustStore === undefined) {
    return { kind: "unavailable" };
  }
  return resolveProjectAgentTrust(projectRoot, options);
}

interface DoctorReportInput {
  cwd: string;
  config: ExtensionConfig;
  state: SubagentState;
  requestedSessionDir?: string;
  currentSessionFile?: string | null;
  currentSessionId?: string | null;
  sessionError?: string;
  expandTilde?: (value: string) => string;
  paths?: DoctorPaths;
  deps?: Partial<DoctorDeps>;
  /** Read-only persisted trust state for the request cwd's canonical Git root. */
  projectAgentTrust?: ProjectAgentDoctorTrust;
}

const DEFAULT_PATHS: DoctorPaths = {
  tempRootDir: TEMP_ROOT_DIR,
  asyncDir: ASYNC_DIR,
  resultsDir: RESULTS_DIR,
};

const DEFAULT_DEPS: DoctorDeps = {
  isAsyncAvailable,
  discoverAgentsAll,
  discoverAvailableSkills,
};

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function lineFromCheck(label: string, check: () => string): string {
  try {
    return check();
  } catch (error) {
    return `- ${label}: failed — ${errorText(error)}`;
  }
}

function formatExistingDirectory(label: string, dirPath: string): string {
  try {
    if (!fs.existsSync(dirPath)) return `- ${label}: missing (${dirPath})`;
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) throw new Error(`not a directory: ${dirPath}`);
    fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
    return `- ${label}: ok (${dirPath})`;
  } catch (error) {
    return `- ${label}: failed (${dirPath}) — ${errorText(error)}`;
  }
}

function formatSourceCounts(counts: {
  builtin: number;
  package: number;
  user: number;
  project: number;
}): string {
  return `builtin ${counts.builtin}, package ${counts.package}, user ${counts.user}, project ${counts.project}`;
}

// Canonical ordering derived from SOURCE_PRIORITY (descending priority).
// Sharing this with SOURCE_PRIORITY means adding a new SkillSource and
// assigning it a priority number here is sufficient — the doctor report
// and its test automatically pick it up.
const SKILL_SOURCE_ORDER: SkillSource[] = (Object.keys(SOURCE_PRIORITY) as SkillSource[]).sort(
  (a, b) => (SOURCE_PRIORITY[b] ?? 0) - (SOURCE_PRIORITY[a] ?? 0),
);

function formatSkillSourceCounts(skills: Array<{ source: SkillSource }>): string {
  const counts = new Map<SkillSource, number>();
  for (const skill of skills) counts.set(skill.source, (counts.get(skill.source) ?? 0) + 1);
  const parts = SKILL_SOURCE_ORDER.map((source) => `${source} ${counts.get(source) ?? 0}`).filter(
    (part) => !part.endsWith(" 0"),
  );
  return parts.length > 0 ? parts.join(", ") : "none";
}

function formatConfiguredSessionDir(input: DoctorReportInput): string {
  if (input.requestedSessionDir) {
    return path.resolve(
      input.expandTilde?.(input.requestedSessionDir) ?? input.requestedSessionDir,
    );
  }
  return "not configured";
}

function formatSessionLines(input: DoctorReportInput): string[] {
  const sessionFile = input.currentSessionFile ?? null;
  const lines = [
    lineFromCheck(
      "configured session dir",
      () => `- configured session dir: ${formatConfiguredSessionDir(input)}`,
    ),
    `- current session file: ${sessionFile ?? "not available"}`,
    `- current session dir: ${sessionFile ? path.dirname(sessionFile) : "not available"}`,
    `- current session id: ${input.currentSessionId ?? input.state.currentSessionId ?? "not available"}`,
  ];
  if (input.sessionError) lines.push(`- session manager: failed — ${input.sessionError}`);
  return lines;
}

function formatExecutionSection(input: DoctorReportInput): string[] {
  const policy = resolveExecutionPolicy(input.config.execution);
  const runCeiling = policy.maxRunTimeMs === false ? "disabled" : `${policy.maxRunTimeMs}ms`;
  return [
    `- shared run ceiling: ${runCeiling}`,
    "- role ceilings: fresh wall-clock deadline per child spawn (fallback/resume restart the clock)",
    ...(policy.diagnostic ? [`- execution policy: warning — ${policy.diagnostic}`] : []),
  ];
}

function formatRuntimeDirCounts(paths: DoctorPaths): string {
  const counts = inspectRuntimeDirs({
    asyncDir: paths.asyncDir,
    nestedRunsDir: path.join(paths.tempRootDir, "nested-subagent-runs"),
    nestedEventsDir: path.join(paths.tempRootDir, "nested-subagent-events"),
  });
  return (
    `- runtime dir counts: async ${counts.topLevelAsyncDirs + counts.nestedAsyncDirs} ` +
    `(top-level ${counts.topLevelAsyncDirs}, nested ${counts.nestedAsyncDirs}, active/live ${counts.activeOrLiveAsyncDirs}, stale ${counts.staleAsyncDirs}); ` +
    `nested event routes ${counts.nestedEventDirs} (unreferenced ${counts.unreferencedNestedEventDirs})`
  );
}

function formatStatusHealth(paths: DoctorPaths): string[] {
  const unreadableStatuses: AsyncRunUnreadableStatusIssue[] = [];
  try {
    listAsyncRuns(paths.asyncDir, {
      reconcile: false,
      onUnreadable: (issue) => unreadableStatuses.push(issue),
    });
  } catch (error) {
    return [`- status scan: failed — ${errorText(error)}`];
  }
  if (unreadableStatuses.length === 0) return ["- unreadable statuses: none"];
  const lines = unreadableStatuses
    .slice(0, MAX_UNREADABLE_STATUS_REPORTS)
    .map((issue) => `- ${formatUnreadableStatus(issue.statusPath)}`);
  const remaining = unreadableStatuses.length - MAX_UNREADABLE_STATUS_REPORTS;
  if (remaining > 0) lines.push(`- and ${remaining} more unreadable statuses`);
  return lines;
}

function formatDiscovery(input: DoctorReportInput, deps: DoctorDeps): string[] {
  let discovered: ReturnType<DoctorDeps["discoverAgentsAll"]> | undefined;
  const lines = [
    lineFromCheck("agents", () => {
      const current = deps.discoverAgentsAll(input.cwd);
      discovered = current;
      const agentCounts = {
        builtin: current.builtin.length,
        package: current.package?.length ?? 0,
        user: current.user.length,
        project: current.project.length,
      };
      return `- agents: total ${agentCounts.builtin + agentCounts.package + agentCounts.user + agentCounts.project} (${formatSourceCounts(agentCounts)})`;
    }),
    lineFromCheck("skills", () => {
      const skills = deps.discoverAvailableSkills(input.cwd);
      return `- skills: total ${skills.length} (${formatSkillSourceCounts(skills)})`;
    }),
  ];
  const obsoleteCompletionGuardNotices = (discovered?.agentDiagnostics ?? []).filter(
    (diagnostic) =>
      diagnostic.kind === "notice" &&
      diagnostic.error.includes("Obsolete") &&
      diagnostic.error.includes("completionGuard"),
  );
  if (obsoleteCompletionGuardNotices.length > 0) {
    lines.push(
      "- agent migration notices:",
      ...obsoleteCompletionGuardNotices.map(
        (diagnostic) => `  - ${diagnostic.filePath}: ${diagnostic.error}`,
      ),
    );
  }
  return lines;
}

function formatProjectAgentTrust(value: ProjectAgentDoctorTrust | undefined): string {
  if (!value || value.kind === "unavailable") return "- project-agent trust: unavailable";
  if (value.trusted) return "- project-agent trust: trusted";
  switch (value.source) {
    case "saved-negative":
    case "explicit-negative":
      return "- project-agent trust: denied";
    case "no-persisted-trust":
      return "- project-agent trust: not configured";
    case "trust-path-mismatch":
      return "- project-agent trust: path mismatch";
    case "trust-store-error":
      return "- project-agent trust: trust-store error";
    default:
      return "- project-agent trust: unavailable";
  }
}

function formatLegacyHeartbeatNotice(config: ExtensionConfig): string[] {
  if (!("heartbeat" in config)) return [];
  return [
    "",
    "Notices",
    "- heartbeat key: the 'heartbeat' config key is no longer used and can be removed.",
    "  Prompt-cache warming is now Pi-native (see the cacheWarming setting; docs/subagents.md).",
  ];
}

function formatPermissionSystemSection(): string[] {
  const lines: string[] = [];
  const parentSession = process.env["PI_SUBAGENT_PARENT_SESSION"] ?? "";
  const trimmed = parentSession.trim();
  if (trimmed) {
    lines.push(`- parent session: set (${trimmed})`);
  } else {
    lines.push(
      "- parent session: not set — ask forwarding from subprocess children will not reach a parent UI",
    );
  }
  const isChild = process.env["PI_SUBAGENT_CHILD"] === "1";
  lines.push(`- subagent process: ${isChild ? "yes (PI_SUBAGENT_CHILD=1)" : "no"}`);
  // Whether pi-permission-system is installed and where it stores config is
  // outside pi-subagents' control, so we only report the forwarding signal we
  // own. Run `pi list` to confirm the permission extension is installed.
  return lines;
}

export function buildDoctorReport(input: DoctorReportInput): string {
  const paths = input.paths ?? DEFAULT_PATHS;
  const deps = { ...DEFAULT_DEPS, ...input.deps };
  const lines = [
    "Subagents doctor report",
    "",
    "Runtime",
    `- cwd: ${input.cwd}`,
    lineFromCheck(
      "async support",
      () => `- async support: ${deps.isAsyncAvailable() ? "available" : "unavailable"}`,
    ),
    ...formatSessionLines(input),
    "",
    "Execution",
    ...formatExecutionSection(input),
    "",
    "Filesystem",
    formatExistingDirectory("temp root", paths.tempRootDir),
    formatExistingDirectory("async runs", paths.asyncDir),
    formatExistingDirectory("results", paths.resultsDir),
    lineFromCheck("runtime dir counts", () => formatRuntimeDirCounts(paths)),
    ...formatStatusHealth(paths),
    "",
    "Discovery",
    ...formatDiscovery(input, deps),
    "",
    "Project agents",
    formatProjectAgentTrust(input.projectAgentTrust),
    "",
    "Permission system",
    ...formatPermissionSystemSection(),
    ...formatLegacyHeartbeatNotice(input.config),
  ];
  return lines.join("\n");
}
