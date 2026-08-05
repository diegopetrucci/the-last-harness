import * as fs from "node:fs";
import * as path from "node:path";
import { isDynamicParallelStep, isParallelStep } from "./settings.js";
import { splitKnownThinkingSuffix, THINKING_LEVELS } from "./model-info.js";
export function formatTokens(n) {
    return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}
export function formatModelThinking(model, thinking) {
    const parsed = model ? splitKnownThinkingSuffix(model) : undefined;
    let displayModel = parsed?.baseModel ?? model;
    const explicitThinking = THINKING_LEVELS.find((level) => level === thinking?.trim());
    const displayThinking = parsed?.thinkingSuffix ? parsed.thinkingSuffix.slice(1) : explicitThinking;
    if (displayModel) {
        const slashIdx = displayModel.lastIndexOf("/");
        if (slashIdx !== -1)
            displayModel = displayModel.slice(slashIdx + 1);
    }
    return [displayModel, displayThinking ? `thinking ${displayThinking}` : undefined].filter(Boolean).join(" · ");
}
export function formatUsage(u, model) {
    const parts = [];
    if (u.turns)
        parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
    if (u.input)
        parts.push(`in:${formatTokens(u.input)}`);
    if (u.output)
        parts.push(`out:${formatTokens(u.output)}`);
    if (u.cacheRead)
        parts.push(`R${formatTokens(u.cacheRead)}`);
    if (u.cacheWrite)
        parts.push(`W${formatTokens(u.cacheWrite)}`);
    if (u.cost)
        parts.push(`$${u.cost.toFixed(4)}`);
    if (model)
        parts.push(model);
    return parts.join(" ");
}
export function formatDuration(ms) {
    if (ms < 1000)
        return `${ms}ms`;
    if (ms < 60000)
        return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}
export function buildChainSummary(steps, results, chainDir, status, failedStep) {
    const stepNames = steps
        .map((step) => (isParallelStep(step) ? `parallel[${step.parallel.length}]` : isDynamicParallelStep(step) ? `expand:${step.parallel.agent}` : step.agent))
        .join(" → ");
    const totalDuration = results.reduce((sum, r) => sum + (r.progress?.durationMs || 0), 0);
    const durationStr = formatDuration(totalDuration);
    const progressPath = path.join(chainDir, "progress.md");
    const hasProgress = fs.existsSync(progressPath);
    const allSkills = new Set();
    for (const r of results) {
        if (r.skills)
            r.skills.forEach((s) => allSkills.add(s));
    }
    const skillsLine = allSkills.size > 0 ? `🔧 Skills: ${[...allSkills].join(", ")}` : "";
    const fallbackNotices = [...new Set(results
            .map((result) => result.modelFallbackNotice?.trim())
            .filter((notice) => Boolean(notice)))];
    const fallbackLine = fallbackNotices.length > 0 ? `ℹ️ Fallbacks: ${fallbackNotices.join("; ")}` : "";
    if (status === "completed") {
        const stepWord = results.length === 1 ? "step" : "steps";
        return `✅ Chain completed: ${stepNames} (${results.length} ${stepWord}, ${durationStr})${fallbackLine ? `\n${fallbackLine}` : ""}${skillsLine ? `\n${skillsLine}` : ""}

📋 Progress: ${hasProgress ? progressPath : "(none)"}
📁 Artifacts: ${chainDir}`;
    }
    else {
        const stepInfo = failedStep ? ` at step ${failedStep.index + 1}` : "";
        const errorInfo = failedStep?.error ? `: ${failedStep.error}` : "";
        return `❌ Chain failed${stepInfo}${errorInfo}${fallbackLine ? `\n${fallbackLine}` : ""}${skillsLine ? `\n${skillsLine}` : ""}

📋 Progress: ${hasProgress ? progressPath : "(none)"}
📁 Artifacts: ${chainDir}`;
    }
}
export function formatToolCall(name, args, expanded = false) {
    switch (name) {
        case "bash": {
            const command = typeof args.command === "string" ? args.command : "";
            const maxLength = expanded ? 240 : 60;
            return `$ ${command.slice(0, maxLength)}${command.length > maxLength ? "..." : ""}`;
        }
        case "read":
        case "write":
        case "edit": {
            const target = typeof args.path === "string"
                ? args.path
                : typeof args.file_path === "string"
                    ? args.file_path
                    : "";
            return `${name} ${shortenPath(target)}`;
        }
        default: {
            const s = JSON.stringify(args);
            const maxLength = expanded ? 160 : 40;
            return `${name} ${s.slice(0, maxLength)}${s.length > maxLength ? "..." : ""}`;
        }
    }
}
export function shortenPath(p) {
    const home = process.env.HOME;
    if (home && p.startsWith(home)) {
        return `~${p.slice(home.length)}`;
    }
    return p;
}
