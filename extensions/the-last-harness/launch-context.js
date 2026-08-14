const CHARS_PER_TOKEN = 4;
function estimateTokensFromChars(charCount) {
    return charCount > 0 ? Math.ceil(charCount / CHARS_PER_TOKEN) : 0;
}
function escapeXml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
function serializedLength(value) {
    try {
        return JSON.stringify(value)?.length ?? 0;
    }
    catch {
        return 0;
    }
}
class PromptContributionTracker {
    unclaimedPrompt;
    constructor(prompt) {
        this.unclaimedPrompt = prompt;
    }
    consume(value) {
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
function activeToolsForEstimate(activeToolNames, allTools) {
    const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
    const seen = new Set();
    const activeTools = [];
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
function consumeContextMetadata(tracker, promptMetadata) {
    let chars = 0;
    for (const contextFile of promptMetadata.contextFiles) {
        chars += tracker.consume(contextFile.path);
        chars += tracker.consume(contextFile.content);
    }
    return chars;
}
function consumeSkillMetadata(tracker, promptMetadata) {
    let chars = 0;
    for (const skill of promptMetadata.skills) {
        chars += tracker.consume(escapeXml(skill.name));
        chars += tracker.consume(escapeXml(skill.description));
        chars += tracker.consume(escapeXml(skill.filePath));
    }
    return chars;
}
function consumeToolGuidelines(tracker, tools) {
    let chars = 0;
    const seen = new Set();
    for (const tool of tools) {
        for (const guideline of tool.promptGuidelines ?? []) {
            const normalized = guideline.trim();
            if (!normalized || seen.has(normalized)) {
                continue;
            }
            seen.add(normalized);
            chars += tracker.consume(normalized);
        }
    }
    return chars;
}
function toolDefinitionChars(tools) {
    if (tools.length === 0) {
        return 0;
    }
    return serializedLength(tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
    })));
}
function tokenAllocationFromChars(chars) {
    return {
        tlh: estimateTokensFromChars(chars.tlh),
        agentsClaude: estimateTokensFromChars(chars.agentsClaude),
        skills: estimateTokensFromChars(chars.skills),
        tools: estimateTokensFromChars(chars.tools),
        other: estimateTokensFromChars(chars.other),
    };
}
export function estimateTlhLaunchContextAllocation(options) {
    if (typeof options.contextWindow !== "number" ||
        !Number.isFinite(options.contextWindow) ||
        options.contextWindow <= 0) {
        return undefined;
    }
    const tracker = new PromptContributionTracker(options.baseSystemPrompt);
    const activeTools = activeToolsForEstimate(options.activeToolNames, options.allTools);
    const agentsClaudeChars = consumeContextMetadata(tracker, options.promptMetadata);
    const skillsChars = options.activeToolNames.includes("read")
        ? consumeSkillMetadata(tracker, options.promptMetadata)
        : 0;
    const embeddedToolChars = consumeToolGuidelines(tracker, activeTools);
    const baseInstructionChars = Math.max(0, options.baseSystemPrompt.length - agentsClaudeChars - skillsChars - embeddedToolChars);
    const appendedTlhChars = options.launchSystemPrompt.startsWith(options.baseSystemPrompt)
        ? options.launchSystemPrompt.length - options.baseSystemPrompt.length
        : 0;
    return {
        contextWindow: options.contextWindow,
        estimatedTokens: tokenAllocationFromChars({
            tlh: baseInstructionChars + appendedTlhChars,
            agentsClaude: agentsClaudeChars,
            skills: skillsChars,
            tools: embeddedToolChars + toolDefinitionChars(activeTools),
            other: 0,
        }),
    };
}
