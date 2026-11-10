import * as os from "node:os";
import * as path from "node:path";

export const PACKAGED_PRIMARY_AGENT_ROLES = ["architect", "rush", "product", "bug-hunter"] as const;

export const PACKAGED_MINOR_AGENT_ROLES = [
  "developer",
  "test-runner",
  "code-reviewer",
  "repo-scout",
  "diff-summarizer",
  "librarian",
  "web-scout",
  "oracle",
  "contrarian",
] as const;

const packagedMinorAgentRoles = new Set<string>(PACKAGED_MINOR_AGENT_ROLES);

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (configured) {
    const expanded =
      configured === "~"
        ? os.homedir()
        : configured.startsWith("~/")
          ? path.join(os.homedir(), configured.slice(2))
          : configured;
    return path.resolve(expanded);
  }
  return path.join(os.homedir(), ".pi", "agent");
}

/** Return whether a config is the exact installer-managed TLH minor-agent file. */
export function isCanonicalPackagedMinorAgent(agent: unknown): boolean {
  if (typeof agent !== "object" || agent === null || Array.isArray(agent)) return false;
  const candidate = agent as { name?: unknown; filePath?: unknown };
  if (
    typeof candidate.name !== "string" ||
    !packagedMinorAgentRoles.has(candidate.name) ||
    typeof candidate.filePath !== "string"
  ) {
    return false;
  }
  try {
    const canonicalPath = path.join(
      agentDir(),
      "tlh",
      "agents",
      "subagents",
      `${candidate.name}.md`,
    );
    return path.resolve(candidate.filePath) === path.resolve(canonicalPath);
  } catch {
    return false;
  }
}
