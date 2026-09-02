import * as fs from "node:fs";
import * as path from "node:path";
const INITIAL_PROGRESS_CONTENT = "# Progress\n\n## Status\nIn Progress\n\n## Tasks\n\n## Files Changed\n\n## Notes\n";
function normalizeOutputOverride(output) {
    return output === "false" ? false : output;
}
export function resolveStepBehavior(agentConfig, stepOverrides) {
    const stepOutput = normalizeOutputOverride(stepOverrides.output);
    const output = stepOutput !== undefined ? stepOutput : (normalizeOutputOverride(agentConfig.output) ?? false);
    const reads = stepOverrides.reads !== undefined ? stepOverrides.reads : (agentConfig.defaultReads ?? false);
    const progress = stepOverrides.progress !== undefined
        ? stepOverrides.progress
        : (agentConfig.defaultProgress ?? false);
    let skills;
    if (stepOverrides.skills === false) {
        skills = false;
    }
    else if (stepOverrides.skills !== undefined) {
        skills = [...stepOverrides.skills];
    }
    else {
        skills = agentConfig.skills ? [...agentConfig.skills] : [];
    }
    const outputMode = stepOverrides.outputMode ?? "inline";
    const model = stepOverrides.model ?? agentConfig.model;
    const fallbackModels = stepOverrides.fallbackModels;
    const modelFallbackNotice = stepOverrides.modelFallbackNotice;
    return {
        output,
        outputMode,
        reads,
        progress,
        skills,
        model,
        fallbackModels,
        modelFallbackNotice,
    };
}
function resolveTaskTextForFileUpdatePolicy(task, originalTask) {
    if (!task)
        return originalTask;
    return originalTask ? task.replaceAll("{task}", originalTask) : task;
}
export function taskDisallowsFileUpdates(task) {
    if (!task)
        return false;
    return (/\breview[- ]only\b/i.test(task) ||
        /\bread[- ]only\s+(?:review|audit|inspection|pass)\b/i.test(task) ||
        /\b(?:no|without)\s+(?:file\s+)?edits?\b/i.test(task) ||
        /\b(?:do not|don't|must not)\s+(?:edit|modify|write|touch)\b/i.test(task) ||
        /\bleave\s+files?\s+unchanged\b/i.test(task));
}
export function suppressProgressForReadOnlyTask(behavior, task, originalTask) {
    const policyTask = resolveTaskTextForFileUpdatePolicy(task, originalTask);
    return behavior.progress && taskDisallowsFileUpdates(policyTask)
        ? { ...behavior, progress: false }
        : behavior;
}
function resolveExecutionPath(filePath, baseDir) {
    return path.isAbsolute(filePath) ? filePath : path.join(baseDir, filePath);
}
export function buildExecutionInstructions(behavior, baseDir, isFirstProgressAgent) {
    const prefixParts = [];
    const suffixParts = [];
    if (behavior.reads && behavior.reads.length > 0) {
        const files = behavior.reads.map((f) => resolveExecutionPath(f, baseDir));
        prefixParts.push(`[Read from: ${files.join(", ")}]`);
    }
    if (behavior.output) {
        const outputPath = resolveExecutionPath(behavior.output, baseDir);
        prefixParts.push(`[Write to: ${outputPath}]`);
    }
    if (behavior.progress) {
        const progressPath = path.join(baseDir, "progress.md");
        if (isFirstProgressAgent) {
            suffixParts.push(`Create and maintain progress at: ${progressPath}`);
        }
        else {
            suffixParts.push(`Update progress at: ${progressPath}`);
        }
    }
    const prefix = prefixParts.length > 0 ? prefixParts.join("\n") + "\n\n" : "";
    const suffix = suffixParts.length > 0 ? "\n\n---\n" + suffixParts.join("\n") : "";
    return { prefix, suffix };
}
export function writeInitialProgressFile(progressDir) {
    fs.mkdirSync(progressDir, { recursive: true });
    fs.writeFileSync(path.join(progressDir, "progress.md"), INITIAL_PROGRESS_CONTENT);
}
export { aggregateParallelOutputs } from "../runs/shared/parallel-utils.js";
