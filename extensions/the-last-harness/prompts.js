import { join } from "node:path";
import { SELECTABLE_PRIMARY_AGENTS } from "../the-last-harness-primary-agent.mjs";
import { allowedSubagentsForExperimentalConfig } from "../the-last-harness-subagent-safety.mjs";
import { CHILD_SUBAGENT_PROMPT, HARNESS_PROMPT } from "./constants.js";
import { readMarkdownFilesRecursive, readText } from "./common.js";
import { packageRoot } from "./package-version.js";
import { isThinkingLevel } from "./thinking.js";
import { formatProjectAgentGuidance, } from "../shared/project-agent-guidance.js";
export { formatProjectAgentGuidance } from "../shared/project-agent-guidance.js";
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_MODEL_ID = /^(?!\/)(?!.*\/$)[^\s\0]+$/;
const LEGACY_OPENAI_PROVIDERS = new Set(["openai", "openai-codex"]);
const LEGACY_ANTHROPIC_PROVIDERS = new Set(["anthropic"]);
function parseScalarValue(value) {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
function stripCommonIndent(lines) {
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) {
        return "";
    }
    const commonIndent = Math.min(...nonEmptyLines.map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0));
    return lines
        .map((line) => line.slice(Math.min(commonIndent, line.length)))
        .join("\n")
        .replace(/^\n/, "");
}
function parseProviderId(value) {
    const provider = parseScalarValue(value);
    return provider && SAFE_PROVIDER_ID.test(provider) ? provider : undefined;
}
function parseProviderLocalModelId(value) {
    const modelId = parseScalarValue(value);
    return modelId && SAFE_MODEL_ID.test(modelId) ? modelId : undefined;
}
function parseInlineModelIds(value, provider) {
    const trimmed = value.trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
        return undefined;
    }
    const contents = trimmed.slice(1, -1).trim();
    if (!contents) {
        return [];
    }
    const modelIds = contents.split(",").map((modelId) => {
        const parsed = parseProviderLocalModelId(modelId);
        return parsed && !parsed.startsWith(`${provider}/`) ? parsed : undefined;
    });
    return modelIds.every((modelId) => modelId !== undefined)
        ? modelIds
        : undefined;
}
function parseTlhModelDefaults(value) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string") {
        return [];
    }
    const defaults = [];
    const seenProviders = new Set();
    const lines = value.replace(/\r\n/g, "\n").split("\n");
    let listIndent;
    let pending;
    const flush = () => {
        if (!pending || pending.malformed || !pending.provider) {
            pending = undefined;
            return;
        }
        const provider = pending.provider;
        const hasModel = (pending.models?.length ?? 0) > 0;
        const hasValidEffort = pending.effort !== undefined;
        if (!hasModel && !hasValidEffort) {
            pending = undefined;
            return;
        }
        if (seenProviders.has(provider)) {
            pending = undefined;
            return;
        }
        const entry = { provider };
        if (pending.hasModels && pending.models) {
            entry.models = pending.models.map((id) => ({ provider, id }));
        }
        if (pending.hasEffort) {
            entry.effort = pending.effort;
        }
        defaults.push(entry);
        seenProviders.add(provider);
        pending = undefined;
    };
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const listItem = line.match(/^(\s*)-\s*(.*)$/);
        if (listItem) {
            flush();
            const indent = listItem[1].length;
            const itemBody = listItem[2];
            const providerMatch = itemBody.match(/^provider:\s*(.*?)\s*$/);
            if (listIndent === undefined) {
                listIndent = indent;
            }
            pending = {
                indent,
                provider: providerMatch ? parseProviderId(providerMatch[1]) : undefined,
                hasModels: false,
                hasEffort: false,
                malformed: indent !== listIndent || providerMatch === null,
            };
            continue;
        }
        if (!pending) {
            continue;
        }
        const indent = line.search(/\S|$/);
        if (indent <= pending.indent) {
            flush();
            continue;
        }
        const field = line.match(/^\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
        if (!field) {
            pending.malformed = true;
            continue;
        }
        switch (field[1]) {
            case "provider":
                pending.malformed = true;
                break;
            case "models": {
                if (pending.hasModels) {
                    pending.malformed = true;
                    break;
                }
                pending.hasModels = true;
                const modelIds = pending.provider
                    ? parseInlineModelIds(field[2], pending.provider)
                    : undefined;
                if (modelIds === undefined) {
                    pending.malformed = true;
                }
                else {
                    pending.models = modelIds;
                }
                break;
            }
            case "effort": {
                if (pending.hasEffort) {
                    pending.malformed = true;
                    break;
                }
                pending.hasEffort = true;
                const effort = parseThinkingLevelValue(parseScalarValue(field[2]));
                if (effort === undefined) {
                    pending.malformed = true;
                }
                else {
                    pending.effort = effort;
                }
                break;
            }
            default:
                pending.malformed = true;
                break;
        }
    }
    flush();
    return defaults;
}
function parseLegacyProviderModelReference(value) {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) {
        return undefined;
    }
    const provider = trimmed.slice(0, slash);
    const id = trimmed.slice(slash + 1);
    if (!SAFE_PROVIDER_ID.test(provider) || !SAFE_MODEL_ID.test(id)) {
        return undefined;
    }
    return { provider, id };
}
function normalizeLegacyModelDefaults(openaiModels, anthropicModels, genericThinking, openaiEffort, anthropicEffort, openrouterEffort) {
    const defaults = [];
    const providersWithModels = new Set();
    const addModel = (rawModel, allowedProviders, effort) => {
        const parsed = parseLegacyProviderModelReference(rawModel);
        if (!parsed || !allowedProviders.has(parsed.provider)) {
            return;
        }
        const entry = {
            provider: parsed.provider,
            models: [parsed],
        };
        const resolvedEffort = effort ?? genericThinking;
        if (resolvedEffort !== undefined) {
            entry.effort = resolvedEffort;
        }
        defaults.push(entry);
        providersWithModels.add(parsed.provider);
    };
    for (const candidate of openaiModels) {
        addModel(candidate, LEGACY_OPENAI_PROVIDERS, openaiEffort);
    }
    for (const candidate of anthropicModels) {
        addModel(candidate, LEGACY_ANTHROPIC_PROVIDERS, anthropicEffort);
    }
    const addEffortOnly = (provider, effort) => {
        if (effort !== undefined && !providersWithModels.has(provider)) {
            defaults.push({ provider, effort });
        }
    };
    addEffortOnly("openai", openaiEffort);
    addEffortOnly("openai-codex", openaiEffort);
    addEffortOnly("anthropic", anthropicEffort);
    addEffortOnly("openrouter", openrouterEffort);
    return defaults;
}
export function parseFrontmatter(content) {
    if (!content.startsWith("---")) {
        return { frontmatter: {}, body: content.trim() };
    }
    const end = content.indexOf("\n---", 3);
    if (end === -1) {
        return { frontmatter: {}, body: content.trim() };
    }
    const frontmatter = {};
    let modelDefaultsRaw;
    let hasModelDefaults = false;
    const lines = content.slice(3, end).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!match) {
            continue;
        }
        const key = match[1];
        const value = parseScalarValue(match[2]);
        if (key !== "tlhModelDefaults") {
            frontmatter[key] = value;
            continue;
        }
        hasModelDefaults = true;
        if (value) {
            modelDefaultsRaw = value;
            continue;
        }
        const keyIndent = line.search(/\S|$/);
        const blockLines = [];
        let nextIndex = index + 1;
        for (; nextIndex < lines.length; nextIndex += 1) {
            const nextLine = lines[nextIndex];
            const nextIndent = nextLine.search(/\S|$/);
            if (nextLine.trim() && nextIndent <= keyIndent) {
                break;
            }
            blockLines.push(nextLine);
        }
        modelDefaultsRaw = stripCommonIndent(blockLines);
        index = nextIndex - 1;
    }
    const body = content.slice(content.indexOf("\n", end + 1) + 1).trim();
    if (!hasModelDefaults) {
        return { frontmatter, body };
    }
    return {
        frontmatter,
        tlhModelDefaults: parseTlhModelDefaults(modelDefaultsRaw) ?? [],
        body,
    };
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
export function normalizeAgentModelDefaults(frontmatter, explicitModelDefaults) {
    const model = frontmatter.model?.trim() || undefined;
    const thinking = parseThinkingLevelValue(frontmatter.thinking);
    if (explicitModelDefaults !== undefined) {
        return {
            tlhModelDefaults: explicitModelDefaults,
            tlhModelDefaultsSource: "frontmatter",
        };
    }
    const preferredModel = parseLegacyProviderModelReference(model);
    const openaiModels = splitCommaList(frontmatter.tlhOpenaiModels);
    const anthropicModels = splitCommaList(frontmatter.tlhAnthropicModels);
    const openaiEffort = parseThinkingLevelValue(frontmatter.tlhOpenaiThinking);
    const anthropicEffort = parseThinkingLevelValue(frontmatter.tlhAnthropicThinking);
    const openrouterEffort = parseThinkingLevelValue(frontmatter.tlhOpenrouterThinking);
    return {
        model,
        tlhModelDefaults: normalizeLegacyModelDefaults(openaiModels, anthropicModels, thinking, openaiEffort, anthropicEffort, openrouterEffort),
        tlhModelDefaultsSource: "legacy",
        preferredModel,
        thinking,
    };
}
function firstDeclaredModel(defaults) {
    for (const entry of defaults) {
        const model = entry.models?.find((candidate) => candidate.provider === entry.provider);
        if (model) {
            return model;
        }
    }
    return undefined;
}
function parseAgentPrompt(filePath) {
    const content = readText(filePath);
    if (!content) {
        return undefined;
    }
    const { frontmatter, tlhModelDefaults, body } = parseFrontmatter(content);
    const name = frontmatter.name?.trim();
    const description = frontmatter.description?.trim();
    if (!name || !description) {
        return undefined;
    }
    const modelDefaults = normalizeAgentModelDefaults(frontmatter, tlhModelDefaults);
    return {
        name,
        description,
        ...modelDefaults,
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
        .filter((agent) => agent !== undefined && selectable.has(agent.name))
        .map((agent) => {
        if (agent.tlhModelDefaultsSource !== "frontmatter" || agent.preferredModel) {
            return agent;
        }
        const preferredModel = firstDeclaredModel(agent.tlhModelDefaults);
        return preferredModel ? { ...agent, preferredModel } : agent;
    });
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
        tlhModelDefaults: agent.tlhModelDefaults,
        tlhModelDefaultsSource: agent.tlhModelDefaultsSource,
        thinking: agent.thinking,
        preferOppositeProvider: agent.preferOppositeProvider,
    }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
const REVIEW_HANDOFF_PROMPT = `
## /review handoff

When the incoming user turn's first line is exactly \`[/review]\`, treat it as a review-only request.

- Delegate the review immediately to the \`code-reviewer\` subagent in a **fresh (isolated) context**, passing the full envelope contents as the task input. Never resume an existing run for this request.
- Do not relay raw subagent findings back to the user.
- Critically evaluate the reviewer's findings, then present a concise digested summary with your own assessment.
- Keep this handoff review-only; do not perform implementation work as part of this request.
`;
function formatAllowedSubagents(primary, subagents, options = {}) {
    const allowed = new Set(allowedSubagentsForExperimentalConfig());
    const lines = subagents
        .filter((agent) => allowed.has(agent.name))
        .map((agent) => `- ${agent.name}: ${agent.description}`);
    if (lines.length === 0) {
        return "";
    }
    const managementGuidance = `For subagent management \`action: "list"\`/\`"get"\`/\`"resume"\` calls, omit \`agentScope\` or use \`"user"\`. For \`action: "resume"\`, also omit \`context\` or use \`"fresh"\`. TLH minor agents are isolated to the user scope.`;
    if (options.neutral) {
        return `## TLH Allowed Minor Subagents\n\nThe subagent tool may delegate to these bundled TLH minor agents:\n\n${lines.join("\n")}\n\n${managementGuidance} Trusted \`embedded.<slug>\` agents may also be used only when the user explicitly names or asks for that trusted agent; never proactively choose embedded agents on the user's behalf. TLH resolves them only from \`.tlh/agents/custom/<UPPERCASE-SLUG>.md\`.`;
    }
    const isArchitect = primary?.name === "architect";
    if (isArchitect) {
        return `## TLH Allowed Minor Subagents\n\nYou may delegate to these minor agents via the subagent tool:\n\n${lines.join("\n")}\n\n${managementGuidance} Trusted project agents are intentionally omitted from management \`list\`/\`get\` output. After the user asks for the \`xyz\` project subagent, map it to \`embedded.xyz\`; this trusted project-agent exception may be invoked even though management output omits it. You may also delegate to a trusted \`embedded.<slug>\` agent only when the user explicitly names or asks for that trusted agent; never proactively choose embedded agents on the user's behalf. TLH resolves project agents only from \`.tlh/agents/custom/<UPPERCASE-SLUG>.md\`.`;
    }
    return `## TLH Allowed Minor Subagents\n\nYou may delegate only to these minor agents via the subagent tool:\n\n${lines.join("\n")}\n\n${managementGuidance}\n\nDo not delegate outside this bundled TLH minor-agent list.`;
}
export function buildTlhSystemPrompt(primary, subagents, primaryEnabled, projectAgentGuidanceInventory) {
    const prompts = [HARNESS_PROMPT.trim()];
    if (primaryEnabled) {
        if (primary) {
            prompts.push(primary.systemPrompt.trim());
            prompts.push(formatProjectAgentGuidance(projectAgentGuidanceInventory, primary.name));
        }
        prompts.push(formatAllowedSubagents(primary, subagents));
    }
    else {
        prompts.push(formatAllowedSubagents(undefined, subagents, { neutral: true }));
        prompts.push(REVIEW_HANDOFF_PROMPT.trim());
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
