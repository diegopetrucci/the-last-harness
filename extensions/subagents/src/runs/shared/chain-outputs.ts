import { isParallelStep, type ChainStep, type SequentialStep } from "../../shared/settings.ts";
import type { ChainOutputMap, ChainOutputMapEntry } from "../../shared/types.ts";

const OUTPUT_REF_PATTERN = /\{outputs\.([^}]*)\}/g;
const SAFE_OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ChainOutputValidationError extends Error {}

export interface ChainOutputValidationContext {
  priorOutputNames?: Iterable<string>;
  startStepIndex?: number;
}

function outputNamesForStep(step: ChainStep): string[] {
  if (isParallelStep(step))
    return step.parallel.map((task) => task.as).filter((name): name is string => Boolean(name));
  const name = (step as SequentialStep).as;
  return name ? [name] : [];
}

function taskTemplatesForStep(step: ChainStep): string[] {
  if (isParallelStep(step)) return step.parallel.map((task) => task.task ?? "{previous}");
  return [(step as SequentialStep).task ?? "{previous}"];
}

export function validateChainOutputBindings(steps: ChainStep[]): void {
  validateChainOutputBindingsWithContext(steps);
}

export function validateChainOutputBindingsWithContext(
  steps: ChainStep[],
  context: ChainOutputValidationContext = {},
): void {
  const priorOutputNames = [...(context.priorOutputNames ?? [])];
  const available = new Set<string>(priorOutputNames);
  const seen = new Set<string>(priorOutputNames);
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const displayStepIndex = (context.startStepIndex ?? 0) + stepIndex + 1;
    const step = steps[stepIndex]!;
    for (const name of outputNamesForStep(step)) {
      if (!SAFE_OUTPUT_NAME_PATTERN.test(name)) {
        throw new ChainOutputValidationError(
          `Invalid chain output name '${name}' at step ${displayStepIndex}. Use /^[A-Za-z_][A-Za-z0-9_]*$/.`,
        );
      }
      if (seen.has(name)) {
        throw new ChainOutputValidationError(
          `Duplicate chain output name '${name}'. Each as name must be unique.`,
        );
      }
      seen.add(name);
    }
    for (const template of taskTemplatesForStep(step)) {
      for (const match of template.matchAll(OUTPUT_REF_PATTERN)) {
        const rawReference = match[0];
        const name = match[1]!;
        if (!SAFE_OUTPUT_NAME_PATTERN.test(name)) {
          throw new ChainOutputValidationError(
            `Invalid chain output reference '${rawReference}' at step ${displayStepIndex}. Use {outputs.name} with /^[A-Za-z_][A-Za-z0-9_]*$/ names.`,
          );
        }
        if (!available.has(name)) {
          throw new ChainOutputValidationError(
            `Unknown chain output reference '${rawReference}' at step ${displayStepIndex}. Named outputs are only available after producing step/group completes.`,
          );
        }
      }
    }
    for (const name of outputNamesForStep(step)) {
      available.add(name);
    }
  }
}

export function resolveOutputReferences(template: string, outputs: ChainOutputMap): string {
  return template.replace(OUTPUT_REF_PATTERN, (rawReference, name: string) => {
    if (!SAFE_OUTPUT_NAME_PATTERN.test(name)) {
      throw new ChainOutputValidationError(
        `Invalid chain output reference '${rawReference}'. Use {outputs.name} with /^[A-Za-z_][A-Za-z0-9_]*$/ names.`,
      );
    }
    const entry = outputs[name];
    if (!entry)
      throw new ChainOutputValidationError(`Unknown chain output reference '${rawReference}'.`);
    return entry.text;
  });
}

function compactStructuredText(value: unknown): string {
  return JSON.stringify(value);
}

export function outputEntryFromAsyncResult(
  result: { agent: string; output: string; structuredOutput?: unknown },
  stepIndex: number,
): ChainOutputMapEntry {
  return {
    text:
      result.structuredOutput !== undefined
        ? compactStructuredText(result.structuredOutput)
        : result.output,
    ...(result.structuredOutput !== undefined ? { structured: result.structuredOutput } : {}),
    agent: result.agent,
    stepIndex,
  };
}
