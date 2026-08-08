import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeSkillInput } from "../agents/skills.js";
import { CHAIN_RUNS_DIR, } from "./types.js";
const CHAIN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INITIAL_PROGRESS_CONTENT = "# Progress\n\n## Status\nIn Progress\n\n## Tasks\n\n## Files Changed\n\n## Notes\n";
function normalizeOutputOverride(output) {
    return output === "false" ? false : output;
}
export function isParallelStep(step) {
    return "parallel" in step && Array.isArray(step.parallel);
}
export function getStepAgents(step) {
    if (isParallelStep(step)) {
        return step.parallel.map((t) => t.agent);
    }
    return [step.agent];
}
export function createChainDir(runId, baseDir) {
    const chainDir = path.join(baseDir ? path.resolve(baseDir) : CHAIN_RUNS_DIR, runId);
    fs.mkdirSync(chainDir, { recursive: true });
    return chainDir;
}
export function removeChainDir(chainDir) {
    try {
        fs.rmSync(chainDir, { recursive: true });
    }
    catch {
    }
}
export function cleanupOldChainDirs() {
    if (!fs.existsSync(CHAIN_RUNS_DIR))
        return;
    const now = Date.now();
    let dirs;
    try {
        dirs = fs.readdirSync(CHAIN_RUNS_DIR);
    }
    catch {
        return;
    }
    for (const dir of dirs) {
        try {
            const dirPath = path.join(CHAIN_RUNS_DIR, dir);
            const stat = fs.statSync(dirPath);
            if (stat.isDirectory() && now - stat.mtimeMs > CHAIN_DIR_MAX_AGE_MS) {
                fs.rmSync(dirPath, { recursive: true });
            }
        }
        catch {
        }
    }
}
export function resolveChainTemplates(steps) {
    return steps.map((step, i) => {
        if (isParallelStep(step)) {
            return step.parallel.map((task) => {
                if (task.task)
                    return task.task;
                return "{previous}";
            });
        }
        const seq = step;
        if (seq.task)
            return seq.task;
        return i === 0 ? "{task}" : "{previous}";
    });
}
export function resolveStepBehavior(agentConfig, stepOverrides, chainSkills) {
    const stepOutput = normalizeOutputOverride(stepOverrides.output);
    const output = stepOutput !== undefined ? stepOutput : (normalizeOutputOverride(agentConfig.output) ?? false);
    const reads = stepOverrides.reads !== undefined ? stepOverrides.reads : (agentConfig.defaultReads ?? false);
    const progress = stepOverrides.progress !== undefined ? stepOverrides.progress : (agentConfig.defaultProgress ?? false);
    let skills;
    if (stepOverrides.skills === false) {
        skills = false;
    }
    else if (stepOverrides.skills !== undefined) {
        skills = [...stepOverrides.skills];
        if (chainSkills && chainSkills.length > 0) {
            skills = [...new Set([...skills, ...chainSkills])];
        }
    }
    else {
        skills = agentConfig.skills ? [...agentConfig.skills] : [];
        if (chainSkills && chainSkills.length > 0) {
            skills = [...new Set([...skills, ...chainSkills])];
        }
    }
    const outputMode = stepOverrides.outputMode ?? "inline";
    const model = stepOverrides.model ?? agentConfig.model;
    const fallbackModels = stepOverrides.fallbackModels;
    const modelFallbackNotice = stepOverrides.modelFallbackNotice;
    return { output, outputMode, reads, progress, skills, model, fallbackModels, modelFallbackNotice };
}
export function resolveTaskTextForFileUpdatePolicy(task, originalTask) {
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
    return behavior.progress && taskDisallowsFileUpdates(policyTask) ? { ...behavior, progress: false } : behavior;
}
function resolveChainPath(filePath, chainDir) {
    return path.isAbsolute(filePath) ? filePath : path.join(chainDir, filePath);
}
export function writeInitialProgressFile(progressDir) {
    fs.mkdirSync(progressDir, { recursive: true });
    fs.writeFileSync(path.join(progressDir, "progress.md"), INITIAL_PROGRESS_CONTENT);
}
export function buildChainInstructions(behavior, chainDir, isFirstProgressAgent, previousSummary) {
    const prefixParts = [];
    const suffixParts = [];
    if (behavior.reads && behavior.reads.length > 0) {
        const files = behavior.reads.map((f) => resolveChainPath(f, chainDir));
        prefixParts.push(`[Read from: ${files.join(", ")}]`);
    }
    if (behavior.output) {
        const outputPath = resolveChainPath(behavior.output, chainDir);
        prefixParts.push(`[Write to: ${outputPath}]`);
    }
    if (behavior.progress) {
        const progressPath = path.join(chainDir, "progress.md");
        if (isFirstProgressAgent) {
            suffixParts.push(`Create and maintain progress at: ${progressPath}`);
        }
        else {
            suffixParts.push(`Update progress at: ${progressPath}`);
        }
    }
    if (previousSummary && previousSummary.trim()) {
        suffixParts.push(`Previous step output:\n${previousSummary.trim()}`);
    }
    const prefix = prefixParts.length > 0 ? prefixParts.join("\n") + "\n\n" : "";
    const suffix = suffixParts.length > 0 ? "\n\n---\n" + suffixParts.join("\n") : "";
    return { prefix, suffix };
}
export function resolveParallelBehaviors(tasks, agentConfigs, stepIndex, chainSkills) {
    return tasks.map((task, taskIndex) => {
        const config = agentConfigs.find((a) => a.name === task.agent);
        if (!config) {
            throw new Error(`Unknown agent: ${task.agent}`);
        }
        const subdir = path.join(`parallel-${stepIndex}`, `${taskIndex}-${task.agent}`);
        let output = false;
        const taskOutput = normalizeOutputOverride(task.output);
        const configOutput = normalizeOutputOverride(config.output);
        if (taskOutput !== undefined) {
            if (taskOutput === false) {
                output = false;
            }
            else if (path.isAbsolute(taskOutput)) {
                output = taskOutput;
            }
            else {
                output = path.join(subdir, taskOutput);
            }
        }
        else if (configOutput) {
            output = path.join(subdir, configOutput);
        }
        const reads = task.reads !== undefined ? task.reads : (config.defaultReads ?? false);
        const progress = task.progress !== undefined ? task.progress : (config.defaultProgress ?? false);
        const taskSkillInput = normalizeSkillInput(task.skill);
        let skills;
        if (taskSkillInput === false) {
            skills = false;
        }
        else if (taskSkillInput !== undefined) {
            skills = [...taskSkillInput];
            if (chainSkills && chainSkills.length > 0) {
                skills = [...new Set([...skills, ...chainSkills])];
            }
        }
        else {
            skills = config.skills ? [...config.skills] : [];
            if (chainSkills && chainSkills.length > 0) {
                skills = [...new Set([...skills, ...chainSkills])];
            }
        }
        const outputMode = task.outputMode ?? "inline";
        const model = task.model ?? config.model;
        const fallbackModels = task.fallbackModels;
        const modelFallbackNotice = task.modelFallbackNotice;
        return { output, outputMode, reads, progress, skills, model, fallbackModels, modelFallbackNotice };
    });
}
export function createParallelDirs(chainDir, stepIndex, taskCount, agentNames) {
    for (let i = 0; i < taskCount; i++) {
        const subdir = path.join(chainDir, `parallel-${stepIndex}`, `${i}-${agentNames[i]}`);
        fs.mkdirSync(subdir, { recursive: true });
    }
}
export { aggregateParallelOutputs } from "../runs/shared/parallel-utils.js";
