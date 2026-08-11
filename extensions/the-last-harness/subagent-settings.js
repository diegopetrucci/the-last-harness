import { SettingsManager, getAgentDir, } from "@earendil-works/pi-coding-agent";
import { formatHomePath, isRecord } from "./common.js";
import { findAvailableProviderModel, formatProviderModelReference, formatResolvedProviderModelReference, formatUnavailableStoredModelWarning, parseProviderModelReference, resolveProviderAwareSubagentResolution, } from "./model-defaults.js";
import { getUnfilteredAvailableModels } from "./model-visibility.js";
import { loadSubagentMetadata } from "./prompts.js";
import { hasMeaningfulSubagentOverride, recordOverrideBaseline } from "./model-effort-reconcile.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
import { getAvailableThinkingLevels, isThinkingLevel } from "./thinking.js";
const SUBAGENT_SETTINGS_COMMAND = "subagent-settings";
const INDEPENDENCE_SENSITIVE_AGENTS = new Set(["code-reviewer", "oracle", "contrarian"]);
const INDEPENDENCE_WARNING = "Provider independence is not guaranteed when a fixed model override is configured for this role.";
const SETTINGS_WRITE_ERROR = "Refusing to write minor-agent settings outside the isolated TLH profile.";
function getTlhGlobalSettings(cwd) {
    try {
        const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
        return isRecord(settings) ? settings : {};
    }
    catch {
        return {};
    }
}
function parseTlhSettingsContent(content) {
    if (!content) {
        return {};
    }
    const parsed = JSON.parse(content);
    if (!isRecord(parsed)) {
        throw new Error("settings.json must contain a JSON object");
    }
    return parsed;
}
function bundledSubagentMap(subagents) {
    return new Map(subagents.map((agent) => [agent.name, agent]));
}
function currentModelReference(ctx) {
    if (!ctx.model?.provider || !ctx.model?.id) {
        return undefined;
    }
    return { provider: ctx.model.provider, id: ctx.model.id };
}
function availableModels(ctx) {
    try {
        return [...getUnfilteredAvailableModels(ctx.modelRegistry)]
            .filter((model) => Boolean(model?.provider && model?.id))
            .map((model) => model)
            .sort((a, b) => formatProviderModelReference(a).localeCompare(formatProviderModelReference(b)));
    }
    catch {
        return [];
    }
}
function getStoredOverrides(cwd) {
    const overrides = getTlhGlobalSettings(cwd).subagents?.agentOverrides;
    if (!isRecord(overrides)) {
        return new Map();
    }
    return new Map(Object.entries(overrides)
        .filter(([, value]) => isRecord(value))
        .map(([agent, value]) => [agent, value]));
}
function availableThinkingLevels(model) {
    return getAvailableThinkingLevels(model);
}
function fixedModelWarning(agentName, override) {
    return typeof override?.model === "string" && INDEPENDENCE_SENSITIVE_AGENTS.has(agentName)
        ? INDEPENDENCE_WARNING
        : undefined;
}
function notifyWriteResult(ctx, result, warning) {
    const changedLabel = result.changed ? "Updated" : "No change to";
    const backupLabel = result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
    const warningLabel = warning ? ` ${warning}` : "";
    ctx.ui.notify(`${changedLabel} TLH minor-agent settings at ${formatHomePath(result.settingsPath)}.${backupLabel}${warningLabel}`, "info");
}
function usageMessage() {
    return "Usage: /subagent-settings [status [role]|set <role> [model <provider/id>] [effort <off|minimal|low|medium|high|xhigh|max>]|reset <role> [model|effort]|reset-all]";
}
function ensureMutableOverridePath(settings) {
    const rawSubagents = settings.subagents;
    let subagents;
    if (rawSubagents === undefined) {
        subagents = {};
        settings.subagents = subagents;
    }
    else if (isRecord(rawSubagents)) {
        subagents = rawSubagents;
    }
    else {
        throw new Error("settings.subagents must be an object to update minor-agent settings.");
    }
    const rawOverrides = subagents.agentOverrides;
    let overrides;
    if (rawOverrides === undefined) {
        overrides = {};
        subagents.agentOverrides = overrides;
    }
    else if (isRecord(rawOverrides)) {
        overrides = rawOverrides;
    }
    else {
        throw new Error("settings.subagents.agentOverrides must be an object to update minor-agent settings.");
    }
    return { overrides };
}
function cleanupOverrideContainers(settings) {
    const subagents = isRecord(settings.subagents) ? settings.subagents : undefined;
    if (!subagents) {
        return;
    }
    const overrides = isRecord(subagents.agentOverrides) ? subagents.agentOverrides : undefined;
    if (overrides && Object.keys(overrides).length === 0) {
        delete subagents.agentOverrides;
    }
    if (Object.keys(subagents).length === 0) {
        delete settings.subagents;
    }
}
function writeSubagentOverridePatch(cwd, agentName, patch) {
    return withLockedTlhSettingsWrite(cwd, SETTINGS_WRITE_ERROR, (current) => {
        const settings = parseTlhSettingsContent(current);
        const currentOverrides = isRecord(settings.subagents) && isRecord(settings.subagents.agentOverrides)
            ? settings.subagents.agentOverrides
            : undefined;
        const existingValue = currentOverrides?.[agentName];
        if (existingValue !== undefined && !isRecord(existingValue)) {
            throw new Error(`settings.subagents.agentOverrides.${agentName} must be an object to update minor-agent settings.`);
        }
        const existing = isRecord(existingValue) ? existingValue : undefined;
        const nextModel = patch.model !== undefined ? patch.model : existing?.model;
        const nextThinking = patch.thinking !== undefined ? patch.thinking : existing?.thinking;
        if (nextModel === existing?.model && nextThinking === existing?.thinking) {
            return { changed: false };
        }
        const { overrides } = ensureMutableOverridePath(settings);
        const base = isRecord(overrides[agentName]) ? { ...overrides[agentName] } : {};
        if (patch.model !== undefined) {
            base.model = patch.model;
        }
        if (patch.thinking !== undefined) {
            base.thinking = patch.thinking;
        }
        overrides[agentName] = base;
        return {
            changed: true,
            nextContent: `${JSON.stringify(settings, null, 2)}\n`,
        };
    });
}
function resetSubagentOverride(cwd, agentName, field) {
    return withLockedTlhSettingsWrite(cwd, SETTINGS_WRITE_ERROR, (current) => {
        const settings = parseTlhSettingsContent(current);
        const rawSubagents = settings.subagents;
        if (!isRecord(rawSubagents) || !isRecord(rawSubagents.agentOverrides)) {
            return { changed: false };
        }
        const overrides = rawSubagents.agentOverrides;
        const existingValue = overrides[agentName];
        if (!isRecord(existingValue)) {
            return { changed: false };
        }
        const nextValue = { ...existingValue };
        let changed = false;
        for (const key of field ? [field] : ["model", "thinking"]) {
            if (Object.hasOwn(nextValue, key)) {
                delete nextValue[key];
                changed = true;
            }
        }
        if (!changed) {
            return { changed: false };
        }
        if (Object.keys(nextValue).length === 0) {
            delete overrides[agentName];
        }
        else {
            overrides[agentName] = nextValue;
        }
        cleanupOverrideContainers(settings);
        return {
            changed: true,
            nextContent: `${JSON.stringify(settings, null, 2)}\n`,
        };
    });
}
function resetAllBundledSubagentOverrides(cwd, bundledAgentNames) {
    return withLockedTlhSettingsWrite(cwd, SETTINGS_WRITE_ERROR, (current) => {
        const settings = parseTlhSettingsContent(current);
        const rawSubagents = settings.subagents;
        if (!isRecord(rawSubagents) || !isRecord(rawSubagents.agentOverrides)) {
            return { changed: false };
        }
        const overrides = rawSubagents.agentOverrides;
        let changed = false;
        for (const agentName of bundledAgentNames) {
            const existingValue = overrides[agentName];
            if (!isRecord(existingValue)) {
                continue;
            }
            const nextValue = { ...existingValue };
            let entryChanged = false;
            for (const key of ["model", "thinking"]) {
                if (Object.hasOwn(nextValue, key)) {
                    delete nextValue[key];
                    entryChanged = true;
                }
            }
            if (!entryChanged) {
                continue;
            }
            changed = true;
            if (Object.keys(nextValue).length === 0) {
                delete overrides[agentName];
            }
            else {
                overrides[agentName] = nextValue;
            }
        }
        if (!changed) {
            return { changed: false };
        }
        cleanupOverrideContainers(settings);
        return {
            changed: true,
            nextContent: `${JSON.stringify(settings, null, 2)}\n`,
        };
    });
}
function effectiveModelForEffort(agent, override, models, ctx) {
    return resolveProviderAwareSubagentResolution(agent, models, ctx.model?.provider, currentModelReference(ctx), override).model;
}
function formatEffectiveModelAndThinking(model, thinking) {
    if (!model) {
        return thinking ? `no model (effort ${thinking})` : "no model";
    }
    if (typeof model === "string") {
        return model;
    }
    return formatResolvedProviderModelReference(model, thinking);
}
function formatStoredOverrideValue(override, field) {
    if (!override || !Object.hasOwn(override, field)) {
        return "default";
    }
    const value = override[field];
    if (value === false) {
        return "disabled (false)";
    }
    const isStandard = field === "model"
        ? typeof value === "string" && parseProviderModelReference(value) !== undefined
        : typeof value === "string" && isThinkingLevel(value);
    if (isStandard) {
        return String(value);
    }
    const rendered = JSON.stringify(value);
    return `stored nonstandard/disabled (${rendered === undefined ? String(value) : rendered})`;
}
function formatStatusForAgent(agent, override, ctx) {
    const models = availableModels(ctx);
    const baseResolution = resolveProviderAwareSubagentResolution(agent, models, ctx.model?.provider, currentModelReference(ctx));
    const overrideResolution = resolveProviderAwareSubagentResolution(agent, models, ctx.model?.provider, currentModelReference(ctx), override);
    const overrideModel = formatStoredOverrideValue(override, "model");
    const overrideThinking = formatStoredOverrideValue(override, "thinking");
    const warnings = [
        fixedModelWarning(agent.name, override),
        overrideResolution.unavailableModel
            ? formatUnavailableStoredModelWarning(agent.name, overrideResolution.unavailableModel)
            : undefined,
        overrideResolution.warning,
    ].filter((warning) => Boolean(warning));
    const effectiveModel = overrideResolution.unavailableModel ?? overrideResolution.model;
    const effectiveThinking = overrideResolution.unavailableModel ? undefined : overrideResolution.thinking;
    const lines = [
        `- ${agent.name}: default ${formatEffectiveModelAndThinking(baseResolution.model, baseResolution.thinking)}; override model=${overrideModel}, effort=${overrideThinking}; effective ${formatEffectiveModelAndThinking(effectiveModel, effectiveThinking)}.`,
        ...warnings.map((warning) => `  ${warning}`),
    ];
    return lines.join("\n");
}
function formatStatusMessage(ctx, subagents, selectedAgentName) {
    const overrides = getStoredOverrides(ctx.cwd);
    const selectedAgents = selectedAgentName ? subagents.filter((agent) => agent.name === selectedAgentName) : subagents;
    const currentModel = currentModelReference(ctx);
    const header = `TLH minor-agent settings for ${currentModel ? formatProviderModelReference(currentModel) : "this session"}:`;
    return [header, ...selectedAgents.map((agent) => formatStatusForAgent(agent, overrides.get(agent.name), ctx))].join("\n");
}
function validateAgentName(agentName, subagents) {
    const agent = subagents.get(agentName);
    if (!agent) {
        throw new Error(`Unknown TLH minor-agent role "${agentName}".`);
    }
    return agent;
}
function parseAvailableModel(models, modelRef) {
    const parsed = parseProviderModelReference(modelRef);
    if (parsed) {
        const exactModel = models.find((entry) => entry.provider === parsed.provider && entry.id === parsed.id);
        if (exactModel) {
            return exactModel;
        }
    }
    const model = findAvailableProviderModel(models, modelRef);
    if (model && modelRef.includes(":")) {
        throw new Error("Model overrides must omit any :effort suffix. Use the effort field separately.");
    }
    if (!model) {
        throw new Error(`Model "${modelRef}" is not currently available.`);
    }
    return model;
}
function validateModelEffortPair(model, effort) {
    if (typeof effort !== "string" || !isThinkingLevel(effort)) {
        return;
    }
    const supportedLevels = availableThinkingLevels(model);
    if (!supportedLevels.includes(effort)) {
        throw new Error(`Effort "${effort}" is not supported by ${model ? formatProviderModelReference(model) : "the effective model"}. Available: ${supportedLevels.join(", ")}.`);
    }
}
function parseSetArguments(parts, agent, models, ctx, override) {
    if (parts.length < 2 || parts.length % 2 !== 0) {
        throw new Error(usageMessage());
    }
    const patch = {};
    let selectedModel;
    for (let index = 0; index < parts.length; index += 2) {
        const field = parts[index]?.toLowerCase();
        const value = parts[index + 1];
        if (field === "model") {
            selectedModel = parseAvailableModel(models, value);
            patch.model = formatProviderModelReference(selectedModel);
            continue;
        }
        if (field === "effort") {
            const normalizedValue = value.toLowerCase();
            if (!isThinkingLevel(normalizedValue)) {
                throw new Error(`Unsupported effort "${value}". Available values: off, minimal, low, medium, high, xhigh, max.`);
            }
            patch.thinking = normalizedValue;
            continue;
        }
        throw new Error(usageMessage());
    }
    const finalModel = selectedModel ?? effectiveModelForEffort(agent, override, models, ctx);
    const finalEffort = patch.thinking ?? override?.thinking;
    validateModelEffortPair(finalModel, finalEffort);
    return patch;
}
async function confirmFixedModelOverride(ctx, agentName, model) {
    if (!model || !INDEPENDENCE_SENSITIVE_AGENTS.has(agentName)) {
        return true;
    }
    if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") {
        throw new Error(`Cannot confirm the independence warning for ${agentName} in this mode.`);
    }
    return ctx.ui.confirm("Confirm fixed minor-agent model override", `${agentName} will use the fixed model ${model} on future dispatches. ${INDEPENDENCE_WARNING}`);
}
function subagentPickerOption(agent, override, ctx) {
    const models = availableModels(ctx);
    const effective = resolveProviderAwareSubagentResolution(agent, models, ctx.model?.provider, currentModelReference(ctx), override);
    const effectiveLabel = formatEffectiveModelAndThinking(effective.unavailableModel ?? effective.model, effective.unavailableModel ? undefined : effective.thinking);
    const hasOverride = Boolean(override && (Object.hasOwn(override, "model") || Object.hasOwn(override, "thinking")));
    const overrideMarker = hasOverride ? "●" : "○";
    const riskMarker = fixedModelWarning(agent.name, override) ? " ⚠ independence" : "";
    return `${overrideMarker} ${agent.name} — ${effectiveLabel}${riskMarker}`;
}
function modelPickerOption(model, currentOverride, bundledDefault) {
    const label = formatProviderModelReference(model);
    const markers = [
        currentOverride === label ? "current override" : undefined,
        bundledDefault === label ? "bundled default" : undefined,
    ]
        .filter(Boolean)
        .join(", ");
    return markers ? `${label} — ${markers}` : label;
}
function thinkingPickerOption(level, currentOverride) {
    return currentOverride === level ? `${level} — current override` : level;
}
async function runInteractivePicker(ctx, subagents, subagentMap) {
    if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.select !== "function") {
        ctx.ui.notify(formatStatusMessage(ctx, subagents), "info");
        return;
    }
    while (true) {
        const overrides = getStoredOverrides(ctx.cwd);
        const optionToAgent = new Map(subagents.map((agent) => [subagentPickerOption(agent, overrides.get(agent.name), ctx), agent.name]));
        const selectedOption = await ctx.ui.select("TLH minor-agent settings", [...optionToAgent.keys()]);
        if (!selectedOption) {
            return;
        }
        const agentName = optionToAgent.get(selectedOption);
        if (!agentName) {
            ctx.ui.notify("Unknown TLH minor-agent picker selection.", "error");
            return;
        }
        const agent = validateAgentName(agentName, subagentMap);
        const override = overrides.get(agentName);
        const action = await ctx.ui.select(`Configure ${agentName}`, [
            "status",
            "set model",
            "set effort",
            "reset model",
            "reset effort",
            "reset role",
        ]);
        if (!action) {
            continue;
        }
        if (action === "status") {
            ctx.ui.notify(formatStatusMessage(ctx, subagents, agentName), "info");
            continue;
        }
        if (action === "reset model") {
            notifyWriteResult(ctx, resetSubagentOverride(ctx.cwd, agentName, "model"), fixedModelWarning(agentName, getStoredOverrides(ctx.cwd).get(agentName)));
            continue;
        }
        if (action === "reset effort") {
            notifyWriteResult(ctx, resetSubagentOverride(ctx.cwd, agentName, "thinking"), fixedModelWarning(agentName, getStoredOverrides(ctx.cwd).get(agentName)));
            continue;
        }
        if (action === "reset role") {
            notifyWriteResult(ctx, resetSubagentOverride(ctx.cwd, agentName), undefined);
            continue;
        }
        const models = availableModels(ctx);
        if (action === "set model") {
            const bundledDefault = resolveProviderAwareSubagentResolution(agent, models, ctx.model?.provider, currentModelReference(ctx)).model;
            const optionToModel = new Map(models.map((model) => [
                modelPickerOption(model, typeof override?.model === "string" ? override.model : undefined, bundledDefault ? formatProviderModelReference(bundledDefault) : undefined),
                formatProviderModelReference(model),
            ]));
            const selectedModelOption = await ctx.ui.select(`Pick model for ${agentName}`, [...optionToModel.keys()]);
            if (!selectedModelOption) {
                continue;
            }
            const model = optionToModel.get(selectedModelOption);
            if (!model) {
                ctx.ui.notify("Unknown model picker selection.", "error");
                continue;
            }
            let selectedModel;
            try {
                selectedModel = parseAvailableModel(models, model);
                validateModelEffortPair(selectedModel, override?.thinking);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(message, "error");
                continue;
            }
            if (!(await confirmFixedModelOverride(ctx, agentName, model))) {
                ctx.ui.notify("Model override cancelled.", "info");
                continue;
            }
            const hadModelOverride = hasMeaningfulSubagentOverride(override);
            const modelWriteResult = writeSubagentOverridePatch(ctx.cwd, agentName, { model });
            notifyWriteResult(ctx, modelWriteResult, fixedModelWarning(agentName, { ...override, model }));
            if (modelWriteResult.changed && !hadModelOverride) {
                recordOverrideBaseline(agentName, agent, ctx.model?.provider);
            }
            continue;
        }
        const model = effectiveModelForEffort(agent, override, models, ctx);
        const supportedLevels = availableThinkingLevels(model);
        const currentThinkingOverride = override?.thinking === false ? "off" : typeof override?.thinking === "string" ? override.thinking : undefined;
        const optionToThinking = new Map(supportedLevels.map((level) => [thinkingPickerOption(level, currentThinkingOverride), level]));
        const selectedThinkingOption = await ctx.ui.select(`Pick effort for ${agentName}`, [...optionToThinking.keys()]);
        if (!selectedThinkingOption) {
            continue;
        }
        const thinking = optionToThinking.get(selectedThinkingOption);
        if (!thinking) {
            ctx.ui.notify("Unknown effort picker selection.", "error");
            continue;
        }
        const hadEffortOverride = hasMeaningfulSubagentOverride(override);
        const effortWriteResult = writeSubagentOverridePatch(ctx.cwd, agentName, { thinking });
        notifyWriteResult(ctx, effortWriteResult, fixedModelWarning(agentName, getStoredOverrides(ctx.cwd).get(agentName)));
        if (effortWriteResult.changed && !hadEffortOverride) {
            recordOverrideBaseline(agentName, agent, ctx.model?.provider);
        }
    }
}
function commandCompletions(prefix) {
    const values = ["status", "set", "reset", "reset-all"];
    const normalized = prefix.trim().toLowerCase();
    const completions = values.filter((value) => value.startsWith(normalized)).map((value) => ({ value, label: value }));
    return completions.length > 0 ? completions : null;
}
export function registerSubagentSettingsCommand(pi) {
    const subagents = loadSubagentMetadata();
    const subagentMap = bundledSubagentMap(subagents);
    pi.registerCommand(SUBAGENT_SETTINGS_COMMAND, {
        description: "Show or edit TLH bundled minor-agent model and effort overrides",
        getArgumentCompletions: commandCompletions,
        handler: async (args, ctx) => {
            const trimmed = args.trim();
            if (!trimmed) {
                await runInteractivePicker(ctx, subagents, subagentMap);
                return;
            }
            const parts = trimmed.split(/\s+/).filter(Boolean);
            const command = parts[0]?.toLowerCase();
            const rawAgentName = parts[1]?.toLowerCase();
            const rest = parts.slice(2);
            try {
                if (command === "status") {
                    if (rest.length > 0) {
                        throw new Error(usageMessage());
                    }
                    if (rawAgentName) {
                        validateAgentName(rawAgentName, subagentMap);
                    }
                    ctx.ui.notify(formatStatusMessage(ctx, subagents, rawAgentName), "info");
                    return;
                }
                if (command === "reset-all") {
                    if (rawAgentName || rest.length > 0) {
                        throw new Error(usageMessage());
                    }
                    const result = resetAllBundledSubagentOverrides(ctx.cwd, subagents.map((agent) => agent.name));
                    notifyWriteResult(ctx, result, undefined);
                    return;
                }
                if (!rawAgentName) {
                    throw new Error(usageMessage());
                }
                const agent = validateAgentName(rawAgentName, subagentMap);
                if (command === "reset") {
                    if (rest.length > 1) {
                        throw new Error(usageMessage());
                    }
                    const field = rest[0];
                    if (field && field !== "model" && field !== "effort") {
                        throw new Error(usageMessage());
                    }
                    const resetField = field === "effort" ? "thinking" : field === "model" ? "model" : undefined;
                    const result = resetSubagentOverride(ctx.cwd, rawAgentName, resetField);
                    notifyWriteResult(ctx, result, fixedModelWarning(rawAgentName, getStoredOverrides(ctx.cwd).get(rawAgentName)));
                    return;
                }
                if (command !== "set") {
                    throw new Error(usageMessage());
                }
                const models = availableModels(ctx);
                const currentOverride = getStoredOverrides(ctx.cwd).get(rawAgentName);
                const hadMeaningfulOverride = hasMeaningfulSubagentOverride(currentOverride);
                const patch = parseSetArguments(rest, agent, models, ctx, currentOverride);
                if (!(await confirmFixedModelOverride(ctx, rawAgentName, patch.model))) {
                    ctx.ui.notify("Model override cancelled.", "info");
                    return;
                }
                const result = writeSubagentOverridePatch(ctx.cwd, rawAgentName, patch);
                notifyWriteResult(ctx, result, fixedModelWarning(rawAgentName, { ...currentOverride, ...patch }));
                if (result.changed && !hadMeaningfulOverride) {
                    recordOverrideBaseline(rawAgentName, agent, ctx.model?.provider);
                }
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(message, "error");
            }
        },
    });
}
export { INDEPENDENCE_WARNING, resetSubagentOverride };
