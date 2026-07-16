import { lstatSync } from "node:fs";
import { join } from "node:path";
import { SELECTABLE_PRIMARY_AGENTS } from "../the-last-harness-primary-agent.mjs";
import { allowedSubagentsForExperimentalConfig, isEmbeddedSubagentTarget, isExperimentalFeatureEnabled } from "../the-last-harness-subagent-safety.mjs";
import { EMBEDDED_SUBAGENTS_FEATURE } from "./experimental.js";
import { CHILD_SUBAGENT_PROMPT, HARNESS_PROMPT } from "./constants.js";
import { readMarkdownFilesRecursive, readText, uniqueSorted } from "./common.js";
import { packageRoot } from "./package-version.js";
import { isThinkingLevel } from "./thinking.js";
export function parseFrontmatter(content) {
    if (!content.startsWith("---")) {
        return { frontmatter: {}, body: content.trim() };
    }
    const end = content.indexOf("\n---", 3);
    if (end === -1) {
        return { frontmatter: {}, body: content.trim() };
    }
    const frontmatter = {};
    for (const line of content.slice(3, end).split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!match) {
            continue;
        }
        frontmatter[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
    return { frontmatter, body: content.slice(content.indexOf("\n", end + 1) + 1).trim() };
}
function splitCommaList(value) {
    return (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}
function parseThinkingLevelValue(value) {
    return value && isThinkingLevel(value) ? value : undefined;
}
function parseBooleanValue(value) {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "true") {
        return true;
    }
    if (normalized === "false") {
        return false;
    }
    return undefined;
}
function parseAgentPrompt(filePath) {
    const content = readText(filePath);
    if (!content) {
        return undefined;
    }
    const { frontmatter, body } = parseFrontmatter(content);
    const name = frontmatter.name?.trim();
    const description = frontmatter.description?.trim();
    if (!name || !description) {
        return undefined;
    }
    return {
        name,
        description,
        model: frontmatter.model?.trim() || undefined,
        tlhOpenaiModels: splitCommaList(frontmatter.tlhOpenaiModels),
        tlhAnthropicModels: splitCommaList(frontmatter.tlhAnthropicModels),
        thinking: parseThinkingLevelValue(frontmatter.thinking),
        tlhOpenaiThinking: parseThinkingLevelValue(frontmatter.tlhOpenaiThinking),
        preferCurrentOpenaiModel: parseBooleanValue(frontmatter.preferCurrentOpenaiModel),
        preferOppositeProvider: parseBooleanValue(frontmatter.preferOppositeProvider),
        applyModel: parseBooleanValue(frontmatter.applyModel),
        applyThinking: parseBooleanValue(frontmatter.applyThinking),
        lockThinking: parseBooleanValue(frontmatter.lockThinking),
        minThinking: parseThinkingLevelValue(frontmatter.minThinking),
        tools: splitCommaList(frontmatter.tools),
        systemPrompt: body,
        filePath,
    };
}
export function loadPrimaryAgents() {
    const selectable = new Set(SELECTABLE_PRIMARY_AGENTS);
    const agents = readMarkdownFilesRecursive(join(packageRoot(), "agents", "primary"))
        .map((filePath) => parseAgentPrompt(filePath))
        .filter((agent) => agent !== undefined && selectable.has(agent.name));
    return new Map(agents.map((agent) => [agent.name, agent]));
}
export function loadSubagentMetadata() {
    return readMarkdownFilesRecursive(join(packageRoot(), "agents", "subagents"))
        .map((filePath) => parseAgentPrompt(filePath))
        .filter((agent) => Boolean(agent))
        .map((agent) => ({
        name: agent.name,
        description: agent.description,
        model: agent.model,
        tlhOpenaiModels: agent.tlhOpenaiModels,
        tlhAnthropicModels: agent.tlhAnthropicModels,
        preferOppositeProvider: agent.preferOppositeProvider,
    }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
export function loadAuthorizedEmbeddedSubagentRuntimeNames(agentDir) {
    return uniqueSorted(readMarkdownFilesRecursive(join(agentDir, "agents"))
        .filter((filePath) => {
        if (filePath.endsWith(".chain.md")) {
            return false;
        }
        try {
            return lstatSync(filePath).isFile();
        }
        catch {
            return false;
        }
    })
        .map((filePath) => readText(filePath))
        .filter((content) => typeof content === "string")
        .map((content) => parseFrontmatter(content).frontmatter)
        .map((frontmatter) => {
        const name = frontmatter.name?.trim();
        const description = frontmatter.description?.trim();
        if (frontmatter.package?.trim() !== "embedded" || !name || !description) {
            return undefined;
        }
        const runtimeName = `embedded.${name}`;
        return isEmbeddedSubagentTarget(runtimeName) ? runtimeName : undefined;
    })
        .filter((runtimeName) => typeof runtimeName === "string"));
}
function formatAllowedSubagents(primary, subagents, experimentalConfig) {
    const allowed = new Set(allowedSubagentsForExperimentalConfig(experimentalConfig));
    const lines = subagents
        .filter((agent) => allowed.has(agent.name))
        .map((agent) => `- ${agent.name}: ${agent.description}`);
    if (lines.length === 0) {
        return "";
    }
    const managementGuidance = `For subagent management \`action: "list"\`/\`"get"\`/\`"resume"\` calls, omit \`agentScope\` or use \`"user"\`. For \`action: "resume"\`, also omit \`context\` or use \`"fresh"\`. TLH minor agents are isolated to the user scope.`;
    const isArchitect = primary?.name === "architect";
    const embeddedEnabled = isExperimentalFeatureEnabled(experimentalConfig, EMBEDDED_SUBAGENTS_FEATURE);
    if (isArchitect && embeddedEnabled) {
        return `## TLH Allowed Minor Subagents\n\nYou may delegate to these minor agents via the subagent tool:\n\n${lines.join("\n")}\n\n${managementGuidance} You may also delegate to a trusted \`embedded.<slug>\` subagent only when the user explicitly names or asks for that trusted agent; never proactively choose embedded agents on the user's behalf.`;
    }
    return `## TLH Allowed Minor Subagents\n\nYou may delegate only to these minor agents via the subagent tool:\n\n${lines.join("\n")}\n\n${managementGuidance}\n\nDo not delegate outside this bundled TLH minor-agent list.`;
}
export function buildTlhSystemPrompt(primary, subagents, primaryEnabled, experimentalConfig) {
    const prompts = [HARNESS_PROMPT.trim()];
    if (primaryEnabled) {
        if (primary) {
            prompts.push(primary.systemPrompt.trim());
        }
        prompts.push(formatAllowedSubagents(primary, subagents, experimentalConfig));
    }
    return prompts.filter(Boolean).join("\n\n");
}
export function buildChildSubagentSystemPrompt() {
    const prompts = [HARNESS_PROMPT.trim(), CHILD_SUBAGENT_PROMPT.trim()];
    return prompts.filter(Boolean).join("\n\n");
}
export function parseFrontmatterValue(content, key) {
    if (!content?.startsWith("---")) {
        return undefined;
    }
    const end = content.indexOf("\n---", 3);
    if (end === -1) {
        return undefined;
    }
    const frontmatter = content.slice(3, end).split(/\r?\n/);
    for (const line of frontmatter) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!match || match[1] !== key) {
            continue;
        }
        return match[2].trim().replace(/^["']|["']$/g, "") || undefined;
    }
    return undefined;
}
