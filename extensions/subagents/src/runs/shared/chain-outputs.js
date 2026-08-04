import { isDynamicParallelStep, isParallelStep } from "../../shared/settings.js";
import { getSingleResultOutput } from "../../shared/utils.js";
import { DynamicFanoutError, hasDynamicFanoutFields, validateDynamicStepShape } from "./dynamic-fanout.js";
const OUTPUT_REF_PATTERN = /\{outputs\.([^}]*)\}/g;
const SAFE_OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export class ChainOutputValidationError extends Error {
}
function outputNamesForStep(step) {
    if (isParallelStep(step))
        return step.parallel.map((task) => task.as).filter((name) => Boolean(name));
    if (isDynamicParallelStep(step))
        return [step.collect.as];
    const name = step.as;
    return name ? [name] : [];
}
function taskTemplatesForStep(step) {
    if (isParallelStep(step))
        return step.parallel.map((task) => task.task ?? "{previous}");
    if (isDynamicParallelStep(step))
        return [step.parallel.task ?? "{previous}", step.parallel.label ?? ""].filter(Boolean);
    return [step.task ?? "{previous}"];
}
export function validateChainOutputBindings(steps, dynamicFanoutConfig = {}) {
    validateChainOutputBindingsWithContext(steps, dynamicFanoutConfig);
}
export function validateChainOutputBindingsWithContext(steps, dynamicFanoutConfig = {}, context = {}) {
    const priorOutputNames = [...(context.priorOutputNames ?? [])];
    const available = new Set(priorOutputNames);
    const seen = new Set(priorOutputNames);
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
        const displayStepIndex = (context.startStepIndex ?? 0) + stepIndex + 1;
        const step = steps[stepIndex];
        if (hasDynamicFanoutFields(step)) {
            if (!isDynamicParallelStep(step)) {
                throw new ChainOutputValidationError(`Dynamic chain step ${displayStepIndex} requires expand, a single parallel template object, and collect; dynamic expand/collect cannot be mixed with static parallel arrays.`);
            }
            try {
                validateDynamicStepShape(step, displayStepIndex - 1, dynamicFanoutConfig);
            }
            catch (error) {
                if (error instanceof DynamicFanoutError)
                    throw new ChainOutputValidationError(error.message);
                throw error;
            }
            if (!available.has(step.expand.from.output)) {
                throw new ChainOutputValidationError(`Dynamic chain step ${displayStepIndex} references unknown output '${step.expand.from.output}'. Named outputs are only available after producing step/group completes.`);
            }
        }
        for (const name of outputNamesForStep(step)) {
            if (!SAFE_OUTPUT_NAME_PATTERN.test(name)) {
                throw new ChainOutputValidationError(`Invalid chain output name '${name}' at step ${displayStepIndex}. Use /^[A-Za-z_][A-Za-z0-9_]*$/.`);
            }
            if (seen.has(name)) {
                throw new ChainOutputValidationError(`Duplicate chain output name '${name}'. Each as name must be unique.`);
            }
            seen.add(name);
        }
        for (const template of taskTemplatesForStep(step)) {
            for (const match of template.matchAll(OUTPUT_REF_PATTERN)) {
                const rawReference = match[0];
                const name = match[1];
                if (!SAFE_OUTPUT_NAME_PATTERN.test(name)) {
                    throw new ChainOutputValidationError(`Invalid chain output reference '${rawReference}' at step ${displayStepIndex}. Use {outputs.name} with /^[A-Za-z_][A-Za-z0-9_]*$/ names.`);
                }
                if (!available.has(name)) {
                    throw new ChainOutputValidationError(`Unknown chain output reference '${rawReference}' at step ${displayStepIndex}. Named outputs are only available after producing step/group completes.`);
                }
            }
        }
        for (const name of outputNamesForStep(step)) {
            available.add(name);
        }
    }
}
export function resolveOutputReferences(template, outputs) {
    return template.replace(OUTPUT_REF_PATTERN, (rawReference, name) => {
        if (!SAFE_OUTPUT_NAME_PATTERN.test(name)) {
            throw new ChainOutputValidationError(`Invalid chain output reference '${rawReference}'. Use {outputs.name} with /^[A-Za-z_][A-Za-z0-9_]*$/ names.`);
        }
        const entry = outputs[name];
        if (!entry)
            throw new ChainOutputValidationError(`Unknown chain output reference '${rawReference}'.`);
        return entry.text;
    });
}
function compactStructuredText(value) {
    return JSON.stringify(value);
}
export function outputEntryFromResult(result, stepIndex) {
    return {
        text: result.structuredOutput !== undefined ? compactStructuredText(result.structuredOutput) : getSingleResultOutput(result),
        ...(result.structuredOutput !== undefined ? { structured: result.structuredOutput } : {}),
        agent: result.agent,
        stepIndex,
    };
}
export function outputEntryFromAsyncResult(result, stepIndex) {
    return {
        text: result.structuredOutput !== undefined ? compactStructuredText(result.structuredOutput) : result.output,
        ...(result.structuredOutput !== undefined ? { structured: result.structuredOutput } : {}),
        agent: result.agent,
        stepIndex,
    };
}
