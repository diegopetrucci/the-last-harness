import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { getMcpToolKind } from "./mcp-tools.js";
import type {
  StartupPromptResourceMetadata,
  TlhLaunchContextAllocation,
  TlhLaunchContextTokenAllocation,
} from "./types.js";

const CHARS_PER_TOKEN = 4;

type TlhLaunchContextCharacterAllocation = Record<keyof TlhLaunchContextTokenAllocation, number>;

type EstimateTlhLaunchContextAllocationOptions = {
  contextWindow: number | undefined;
  baseSystemPrompt: string;
  launchSystemPrompt: string;
  promptMetadata: StartupPromptResourceMetadata;
  activeToolNames: readonly string[];
  allTools: readonly ToolInfo[];
};

function estimateTokensFromChars(charCount: number): number {
  return charCount > 0 ? Math.ceil(charCount / CHARS_PER_TOKEN) : 0;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

// Claim only metadata that is already present in Pi's base prompt. This keeps resource
// attribution from adding the same text a second time to the launch total.
class PromptContributionTracker {
  private unclaimedPrompt: string;

  constructor(prompt: string) {
    this.unclaimedPrompt = prompt;
  }

  consume(value: string): number {
    if (!value) {
      return 0;
    }
    const index = this.unclaimedPrompt.indexOf(value);
    if (index === -1) {
      return 0;
    }
    this.unclaimedPrompt = `${this.unclaimedPrompt.slice(0, index)}${"\0".repeat(value.length)}${this.unclaimedPrompt.slice(index + value.length)}`;
    return value.length;
  }
}

function activeToolsForEstimate(
  activeToolNames: readonly string[],
  allTools: readonly ToolInfo[],
): ToolInfo[] {
  const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
  const seen = new Set<string>();
  const activeTools: ToolInfo[] = [];
  for (const name of activeToolNames) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const tool = toolsByName.get(name);
    if (tool) {
      activeTools.push(tool);
    }
  }
  return activeTools;
}

function consumeContextMetadata(
  tracker: PromptContributionTracker,
  promptMetadata: StartupPromptResourceMetadata,
): number {
  let chars = 0;
  for (const contextFile of promptMetadata.contextFiles) {
    chars += tracker.consume(contextFile.path);
    chars += tracker.consume(contextFile.content);
  }
  return chars;
}

function consumeSkillMetadata(
  tracker: PromptContributionTracker,
  promptMetadata: StartupPromptResourceMetadata,
): number {
  let chars = 0;
  for (const skill of promptMetadata.skills) {
    chars += tracker.consume(escapeXml(skill.name));
    chars += tracker.consume(escapeXml(skill.description));
    chars += tracker.consume(escapeXml(skill.filePath));
  }
  return chars;
}

// Process all tools in a single pass with one shared `seen` set so each guideline
// is claimed against the tracker at most once. Returns the char counts split by
// MCP vs non-MCP for bucket attribution.
function consumeToolGuidelinesPartitioned(
  tracker: PromptContributionTracker,
  tools: readonly ToolInfo[],
): { mcp: number; nonMcp: number } {
  let mcpChars = 0;
  let nonMcpChars = 0;
  const seen = new Set<string>();
  for (const tool of tools) {
    const isMcp = getMcpToolKind(tool.name, tool) !== undefined;
    for (const guideline of tool.promptGuidelines ?? []) {
      const normalized = guideline.trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      const claimed = tracker.consume(normalized);
      if (isMcp) {
        mcpChars += claimed;
      } else {
        nonMcpChars += claimed;
      }
    }
  }
  return { mcp: mcpChars, nonMcp: nonMcpChars };
}

// Prompt guidelines are embedded in the base system prompt and claimed above. The
// provider-facing definition adds the remaining model-visible tool metadata/schema.
function toolDefinitionChars(tools: readonly ToolInfo[]): number {
  if (tools.length === 0) {
    return 0;
  }
  return serializedLength(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );
}

function tokenAllocationFromChars(
  chars: TlhLaunchContextCharacterAllocation,
): TlhLaunchContextTokenAllocation {
  return {
    tlh: estimateTokensFromChars(chars.tlh),
    agentsClaude: estimateTokensFromChars(chars.agentsClaude),
    skills: estimateTokensFromChars(chars.skills),
    tools: estimateTokensFromChars(chars.tools),
    mcp: estimateTokensFromChars(chars.mcp),
    other: estimateTokensFromChars(chars.other),
  };
}

export function estimateTlhLaunchContextAllocation(
  options: EstimateTlhLaunchContextAllocationOptions,
): TlhLaunchContextAllocation | undefined {
  if (
    typeof options.contextWindow !== "number" ||
    !Number.isFinite(options.contextWindow) ||
    options.contextWindow <= 0
  ) {
    return undefined;
  }

  const tracker = new PromptContributionTracker(options.baseSystemPrompt);
  const activeTools = activeToolsForEstimate(options.activeToolNames, options.allTools);
  const mcpActiveTools = activeTools.filter(
    (tool) => getMcpToolKind(tool.name, tool) !== undefined,
  );
  const agentsClaudeChars = consumeContextMetadata(tracker, options.promptMetadata);
  const skillsChars = options.activeToolNames.includes("read")
    ? consumeSkillMetadata(tracker, options.promptMetadata)
    : 0;
  // Single pass across all active tools preserves the one-claim-per-guideline invariant.
  const guidelineChars = consumeToolGuidelinesPartitioned(tracker, activeTools);
  const embeddedToolChars = guidelineChars.mcp + guidelineChars.nonMcp;
  const baseInstructionChars = Math.max(
    0,
    options.baseSystemPrompt.length - agentsClaudeChars - skillsChars - embeddedToolChars,
  );
  const appendedTlhChars = options.launchSystemPrompt.startsWith(options.baseSystemPrompt)
    ? options.launchSystemPrompt.length - options.baseSystemPrompt.length
    : 0;

  return {
    contextWindow: options.contextWindow,
    estimatedTokens: tokenAllocationFromChars({
      // The ticket defines Pi's base runtime/system instructions as TLH context. We have no
      // provider protocol-overhead input, so do not invent an Other estimate.
      tlh: baseInstructionChars + appendedTlhChars,
      agentsClaude: agentsClaudeChars,
      skills: skillsChars,
      // Compute combined definition chars once; subtract the MCP partition to avoid
      // counting JSON array framing twice and keep tools + mcp == the pre-split total.
      tools:
        guidelineChars.nonMcp +
        toolDefinitionChars(activeTools) -
        toolDefinitionChars(mcpActiveTools),
      mcp: guidelineChars.mcp + toolDefinitionChars(mcpActiveTools),
      other: 0,
    }),
  };
}
