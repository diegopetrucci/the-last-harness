import { getSingleResultOutput } from "../../shared/utils.js";
import { validateStructuredOutputValue } from "./structured-output.js";
export class DynamicFanoutError extends Error {
}
const SAFE_OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ITEM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ITEM_REF_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)(?:\.([^{}]+))?\}/g;
const RESERVED_TEMPLATE_NAMES = new Set(["task", "previous", "chain_dir", "outputs"]);
const DYNAMIC_STEP_KEYS = new Set(["expand", "parallel", "collect", "concurrency", "failFast", "phase", "label", "acceptance"]);
const RUNNER_DYNAMIC_STEP_KEYS = new Set([...DYNAMIC_STEP_KEYS, "effectiveAcceptance", "acceptanceInput", "acceptanceRole", "sessionFiles", "thinkingOverrides"]);
const DYNAMIC_EXPAND_KEYS = new Set(["from", "item", "key", "maxItems", "onEmpty"]);
const DYNAMIC_EXPAND_FROM_KEYS = new Set(["output", "path"]);
const DYNAMIC_PARALLEL_KEYS = new Set(["agent", "task", "phase", "label", "outputSchema", "cwd", "output", "outputMode", "reads", "progress", "skill", "model", "fallbackModels", "modelFallbackNotice", "toolBudget", "acceptance"]);
const RUNNER_DYNAMIC_PARALLEL_KEYS = new Set([
    ...DYNAMIC_PARALLEL_KEYS,
    "outputName", "structured", "inheritProjectContext", "inheritSkills", "skills", "outputPath", "maxSubagentDepth",
    "structuredOutput", "structuredOutputSchema", "tools", "extensions", "subagentOnlyExtensions", "mcpDirectTools", "completionGuard", "systemPrompt",
    "systemPromptMode", "thinking", "modelCandidates", "sessionFile", "effectiveAcceptance", "acceptanceInput", "acceptanceRole", "parentSessionId", "timeoutMs",
]);
const DYNAMIC_COLLECT_KEYS = new Set(["as", "outputSchema"]);
export function isSafeOutputName(name) {
    return SAFE_OUTPUT_NAME_PATTERN.test(name);
}
export function assertJsonPointer(pointer, label) {
    if (pointer === "")
        return;
    if (!pointer.startsWith("/")) {
        throw new DynamicFanoutError(`${label} must be a JSON Pointer starting with '/'.`);
    }
    for (const segment of pointer.slice(1).split("/")) {
        if (/~(?![01])/.test(segment)) {
            throw new DynamicFanoutError(`${label} contains invalid JSON Pointer escape.`);
        }
    }
}
function decodePointerSegment(segment) {
    return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}
export function resolveJsonPointer(value, pointer, label) {
    assertJsonPointer(pointer, label);
    if (pointer === "")
        return value;
    let current = value;
    for (const rawSegment of pointer.slice(1).split("/")) {
        const segment = decodePointerSegment(rawSegment);
        if (Array.isArray(current)) {
            if (!/^(0|[1-9][0-9]*)$/.test(segment)) {
                throw new DynamicFanoutError(`${label} segment '${segment}' does not address an array index.`);
            }
            const index = Number(segment);
            if (index >= current.length)
                throw new DynamicFanoutError(`${label} does not exist.`);
            current = current[index];
            continue;
        }
        if (!current || typeof current !== "object") {
            throw new DynamicFanoutError(`${label} does not exist.`);
        }
        const record = current;
        if (!Object.prototype.hasOwnProperty.call(record, segment)) {
            throw new DynamicFanoutError(`${label} does not exist.`);
        }
        current = record[segment];
    }
    return current;
}
function hasControlCharacters(value) {
    return [...value].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f || character.codePointAt(0) === 0x7f);
}
function scalarToKey(value, label) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        const key = String(value);
        if (!key.trim())
            throw new DynamicFanoutError(`${label} resolved to an empty key.`);
        if (hasControlCharacters(key))
            throw new DynamicFanoutError(`${label} resolved to an unsafe key.`);
        if (key.length > 200)
            throw new DynamicFanoutError(`${label} resolved to a key longer than 200 characters.`);
        return key;
    }
    throw new DynamicFanoutError(`${label} must resolve to a string, number, or boolean.`);
}
export function normalizeItemKeyForId(key) {
    const normalized = key
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return normalized || "item";
}
function valueToTemplateText(value, reference) {
    if (value === undefined)
        throw new DynamicFanoutError(`Unresolved item reference '${reference}'.`);
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean" || value === null)
        return String(value);
    return JSON.stringify(value);
}
function resolveItemPath(item, pathText, reference) {
    if (!pathText)
        return item;
    const pointer = `/${pathText.split(".").map((segment) => segment.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
    return resolveJsonPointer(item, pointer, reference);
}
export function resolveItemTemplate(template, itemName, item) {
    return template.replace(ITEM_REF_PATTERN, (raw, name, pathText) => {
        if (name !== itemName)
            return raw;
        if (pathText !== undefined && (!pathText.trim() || pathText.includes(".."))) {
            throw new DynamicFanoutError(`Invalid item reference '${raw}'.`);
        }
        return valueToTemplateText(resolveItemPath(item, pathText, raw), raw);
    });
}
function assertOnlyKeys(value, allowed, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new DynamicFanoutError(`${label} must be an object.`);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            throw new DynamicFanoutError(`${label} does not support field '${key}'.`);
    }
}
export function assertNoUnresolvedItemReferences(template, itemName, label) {
    for (const match of template.matchAll(/\{([^{}]*)\}/g)) {
        const raw = match[0];
        const reference = match[1];
        if (reference === itemName || reference.startsWith(`${itemName}.`)) {
            if (!ITEM_REF_PATTERN.test(raw) || reference === `${itemName}.` || reference.includes("..")) {
                throw new DynamicFanoutError(`Invalid item reference '${raw}' in ${label}.`);
            }
            ITEM_REF_PATTERN.lastIndex = 0;
            continue;
        }
        ITEM_REF_PATTERN.lastIndex = 0;
        const name = reference.match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
        if (name === itemName)
            throw new DynamicFanoutError(`Invalid item reference '${raw}' in ${label}.`);
        if (name && RESERVED_TEMPLATE_NAMES.has(name))
            continue;
        if (name)
            throw new DynamicFanoutError(`Unsupported template reference '${raw}' in ${label}.`);
    }
    ITEM_REF_PATTERN.lastIndex = 0;
    if (template.includes(`{${itemName}.}`) || new RegExp(`\\{${itemName}(?:\\.|$)[^}]*$`).test(template)) {
        throw new DynamicFanoutError(`Invalid item reference in ${label}.`);
    }
}
export function hasDynamicFanoutFields(step) {
    return !!step && typeof step === "object" && !Array.isArray(step)
        && (Object.prototype.hasOwnProperty.call(step, "expand") || Object.prototype.hasOwnProperty.call(step, "collect"));
}
export function validateDynamicStepShape(step, stepIndex, config = {}) {
    const prefix = `Dynamic chain step ${stepIndex + 1}`;
    assertOnlyKeys(step, config.allowRunnerFields ? RUNNER_DYNAMIC_STEP_KEYS : DYNAMIC_STEP_KEYS, prefix);
    if (!step.expand || !step.expand.from)
        throw new DynamicFanoutError(`${prefix} requires expand.from.`);
    assertOnlyKeys(step.expand, DYNAMIC_EXPAND_KEYS, `${prefix} expand`);
    assertOnlyKeys(step.expand.from, DYNAMIC_EXPAND_FROM_KEYS, `${prefix} expand.from`);
    if (!isSafeOutputName(step.expand.from.output))
        throw new DynamicFanoutError(`${prefix} has invalid expand.from.output '${step.expand.from.output}'.`);
    assertJsonPointer(step.expand.from.path, `${prefix} expand.from.path`);
    if (step.expand.key !== undefined)
        assertJsonPointer(step.expand.key, `${prefix} expand.key`);
    const itemName = step.expand.item ?? "item";
    if (!ITEM_NAME_PATTERN.test(itemName))
        throw new DynamicFanoutError(`${prefix} has invalid expand.item '${itemName}'.`);
    if (step.expand.maxItems === undefined && config.maxItems === undefined) {
        throw new DynamicFanoutError(`${prefix} requires expand.maxItems or config.chain.dynamicFanout.maxItems.`);
    }
    if (step.expand.maxItems !== undefined && (!Number.isInteger(step.expand.maxItems) || step.expand.maxItems < 0)) {
        throw new DynamicFanoutError(`${prefix} expand.maxItems must be an integer >= 0.`);
    }
    if (config.maxItems !== undefined && (!Number.isInteger(config.maxItems) || config.maxItems < 0)) {
        throw new DynamicFanoutError("config.chain.dynamicFanout.maxItems must be an integer >= 0.");
    }
    if (!step.parallel || Array.isArray(step.parallel))
        throw new DynamicFanoutError(`${prefix} requires a single parallel template object and cannot mix dynamic expand/collect with static parallel arrays.`);
    assertOnlyKeys(step.parallel, config.allowRunnerFields ? RUNNER_DYNAMIC_PARALLEL_KEYS : DYNAMIC_PARALLEL_KEYS, `${prefix} parallel`);
    const runnerTimeoutMs = step.parallel.timeoutMs;
    if (runnerTimeoutMs !== undefined && (!config.allowRunnerFields || typeof runnerTimeoutMs !== "number" || !Number.isSafeInteger(runnerTimeoutMs) || runnerTimeoutMs < 1)) {
        throw new DynamicFanoutError(`${prefix} parallel.timeoutMs must be internal runner metadata containing a positive safe integer.`);
    }
    if ("expand" in step.parallel)
        throw new DynamicFanoutError(`${prefix} does not support nested dynamic fanout.`);
    if (!step.parallel.agent)
        throw new DynamicFanoutError(`${prefix} parallel.agent is required.`);
    if (!step.collect?.as || !isSafeOutputName(step.collect.as))
        throw new DynamicFanoutError(`${prefix} requires collect.as with a safe output name.`);
    assertOnlyKeys(step.collect, DYNAMIC_COLLECT_KEYS, `${prefix} collect`);
    for (const [label, template] of [
        ["parallel.task", step.parallel.task],
        ["parallel.label", step.parallel.label],
    ]) {
        if (template)
            assertNoUnresolvedItemReferences(template, itemName, `${prefix} ${label}`);
    }
}
export function resolveDynamicFanoutItems(step, outputs, stepIndex, config = {}) {
    validateDynamicStepShape(step, stepIndex, config);
    const sourceName = step.expand.from.output;
    const source = outputs[sourceName];
    if (!source)
        throw new DynamicFanoutError(`Dynamic chain step ${stepIndex + 1} references unknown output '${sourceName}'.`);
    if (source.structured === undefined)
        throw new DynamicFanoutError(`Dynamic chain step ${stepIndex + 1} requires structured output '${sourceName}'.`);
    const value = resolveJsonPointer(source.structured, step.expand.from.path, `Dynamic chain step ${stepIndex + 1} expand.from.path`);
    if (!Array.isArray(value))
        throw new DynamicFanoutError(`Dynamic chain step ${stepIndex + 1} expand.from.path must resolve to an array.`);
    const maxItems = step.expand.maxItems ?? config.maxItems;
    if (maxItems === undefined)
        throw new DynamicFanoutError(`Dynamic chain step ${stepIndex + 1} requires an effective maxItems.`);
    if (value.length > maxItems)
        throw new DynamicFanoutError(`Dynamic chain step ${stepIndex + 1} resolved ${value.length} items, exceeding maxItems ${maxItems}.`);
    const seen = new Set();
    const seenIds = new Set();
    return value.map((item, index) => {
        const key = step.expand.key === undefined
            ? String(index)
            : scalarToKey(resolveJsonPointer(item, step.expand.key, `Dynamic chain step ${stepIndex + 1} expand.key`), `Dynamic chain step ${stepIndex + 1} expand.key`);
        if (seen.has(key))
            throw new DynamicFanoutError(`Dynamic chain step ${stepIndex + 1} produced duplicate item key '${key}'.`);
        seen.add(key);
        const idKey = normalizeItemKeyForId(key);
        if (seenIds.has(idKey))
            throw new DynamicFanoutError(`Dynamic chain step ${stepIndex + 1} produced colliding item id '${idKey}'.`);
        seenIds.add(idKey);
        return { index, key, idKey, item };
    });
}
export function materializeDynamicParallelStep(step, outputs, stepIndex, config = {}) {
    const items = resolveDynamicFanoutItems(step, outputs, stepIndex, config);
    if (items.length === 0) {
        if ((step.expand.onEmpty ?? "skip") === "fail") {
            throw new DynamicFanoutError(`Dynamic chain step ${stepIndex + 1} source array is empty.`);
        }
        return { items, parallel: [], collectedOnEmpty: [] };
    }
    const itemName = step.expand.item ?? "item";
    const parallel = items.map((entry) => {
        const task = resolveItemTemplate(step.parallel.task ?? "{previous}", itemName, entry.item);
        const label = step.parallel.label ? resolveItemTemplate(step.parallel.label, itemName, entry.item) : undefined;
        return {
            ...step.parallel,
            task,
            ...(label !== undefined ? { label } : {}),
        };
    });
    return { items, parallel };
}
export function collectDynamicResults(step, items, results) {
    return items.map((entry, index) => {
        const result = results[index];
        const text = result
            ? ("output" in result && typeof result.output === "string" ? result.output : getSingleResultOutput(result))
            : "";
        return {
            key: entry.key,
            index: entry.index,
            item: entry.item,
            agent: result?.agent ?? step.parallel.agent,
            exitCode: result?.exitCode ?? null,
            text,
            ...(result?.structuredOutput !== undefined ? { structured: result.structuredOutput } : {}),
            ...(result?.error ? { error: result.error } : {}),
            ...(result?.timedOut ? { timedOut: true } : {}),
            ...(result?.savedOutputPath ? { outputPath: result.savedOutputPath } : {}),
            ...(result?.artifactPaths ? { artifactPaths: result.artifactPaths } : {}),
        };
    });
}
export function validateDynamicCollection(schema, value) {
    if (!schema)
        return;
    const validation = validateStructuredOutputValue(schema, value);
    if (validation.status === "invalid") {
        throw new DynamicFanoutError(`Collected output validation failed: ${validation.message}`);
    }
}
