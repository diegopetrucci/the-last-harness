import { formatDuration, formatTokens, shortenPath } from "../../shared/formatters.js";
import { formatActivityLabel } from "../../shared/status-format.js";
import { safeTerminalText } from "../../shared/display-text.js";
export function countNestedRuns(children) {
    const counts = {
        total: 0,
        running: 0,
        paused: 0,
        complete: 0,
        failed: 0,
        queued: 0,
    };
    for (const child of children ?? []) {
        counts.total++;
        counts[child.state]++;
        const nested = countNestedRuns([
            ...(child.children ?? []),
            ...(child.steps?.flatMap((step) => step.children ?? []) ?? []),
        ]);
        counts.total += nested.total;
        counts.running += nested.running;
        counts.paused += nested.paused;
        counts.complete += nested.complete;
        counts.failed += nested.failed;
        counts.queued += nested.queued;
    }
    return counts;
}
function formatNestedAggregate(children) {
    const counts = countNestedRuns(children);
    if (counts.total === 0)
        return undefined;
    const parts = [
        counts.running > 0 ? `${counts.running} running` : "",
        counts.paused > 0 ? `${counts.paused} paused` : "",
        counts.failed > 0 ? `${counts.failed} failed` : "",
        counts.complete > 0 ? `${counts.complete} complete` : "",
        counts.queued > 0 ? `${counts.queued} queued` : "",
    ].filter(Boolean);
    return `+${counts.total} nested run${counts.total === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}
function nestedRunLabel(run) {
    if (run.agent)
        return safeTerminalText(run.agent);
    if (run.agents?.length)
        return safeTerminalText(run.agents.length === 1
            ? run.agents[0]
            : `${run.agents.slice(0, 2).join(", ")}${run.agents.length > 2 ? ` +${run.agents.length - 2}` : ""}`);
    return safeTerminalText(run.id);
}
function formatNestedActivity(input) {
    const facts = [];
    const currentTool = input.currentTool ? safeTerminalText(input.currentTool) : undefined;
    if (currentTool && input.currentToolStartedAt !== undefined)
        facts.push(`tool ${currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`);
    else if (currentTool)
        facts.push(`tool ${currentTool}`);
    if (!input.redactSensitiveDetails && input.currentPath)
        facts.push(safeTerminalText(shortenPath(input.currentPath)));
    if (input.turnCount !== undefined)
        facts.push(`${input.turnCount} turns`);
    if (input.toolCount !== undefined)
        facts.push(`${input.toolCount} tools`);
    if (input.totalTokens)
        facts.push(`${formatTokens(input.totalTokens.total)} tok`);
    const activity = formatActivityLabel(input.lastActivityAt, input.activityState);
    return activity || facts.length ? [activity, ...facts].filter(Boolean).join(" | ") : undefined;
}
function formatNestedRunLines(children, options) {
    const lines = [];
    const append = (items, depth, indent) => {
        if (!items?.length || lines.length >= options.maxLines)
            return;
        if (depth > options.maxDepth) {
            const aggregate = formatNestedAggregate(items);
            if (aggregate && lines.length < options.maxLines)
                lines.push(`${indent}↳ ${aggregate}`);
            return;
        }
        for (let index = 0; index < items.length; index++) {
            const child = items[index];
            if (lines.length >= options.maxLines) {
                const aggregate = formatNestedAggregate(items.slice(index));
                if (aggregate)
                    lines[lines.length - 1] = `${indent}↳ ${aggregate}`;
                return;
            }
            const activity = child.state === "running"
                ? formatNestedActivity({
                    ...child,
                    redactSensitiveDetails: options.redactSensitiveDetails,
                })
                : undefined;
            const error = child.error
                ? ` | error: ${options.redactSensitiveDetails ? "lifecycle status requires attention" : safeTerminalText(child.error)}`
                : "";
            const childId = safeTerminalText(child.id);
            lines.push(`${indent}↳ ${nestedRunLabel(child)} [${childId}] ${safeTerminalText(child.state)}${activity ? ` | ${activity}` : ""}${error}`);
            if (options.commandHints && lines.length < options.maxLines)
                lines.push(`${indent}  Status: subagent({ action: "status", id: "${childId}" })`);
            if (depth === options.maxDepth) {
                const aggregate = formatNestedAggregate([
                    ...(child.steps?.flatMap((step) => step.children ?? []) ?? []),
                    ...(child.children ?? []),
                ]);
                if (aggregate && lines.length < options.maxLines)
                    lines.push(`${indent}  ↳ ${aggregate}`);
                continue;
            }
            for (const [stepIndex, step] of (child.steps ?? []).entries()) {
                if (lines.length >= options.maxLines)
                    return;
                const stepActivity = step.status === "running"
                    ? formatNestedActivity({
                        ...step,
                        redactSensitiveDetails: options.redactSensitiveDetails,
                    })
                    : undefined;
                const stepAgent = safeTerminalText(step.agent);
                const stepError = step.error
                    ? ` | error: ${options.redactSensitiveDetails ? "lifecycle status requires attention" : safeTerminalText(step.error)}`
                    : "";
                lines.push(`${indent}  ${stepIndex + 1}. ${stepAgent} ${safeTerminalText(step.status)}${stepActivity ? ` | ${stepActivity}` : ""}${stepError}`);
                append(step.children, depth + 1, `${indent}    `);
            }
            append(child.children, depth + 1, `${indent}  `);
        }
    };
    append(children, 0, options.indent);
    return lines;
}
export function formatNestedRunStatusLines(children, options = {}) {
    return formatNestedRunLines(children, {
        indent: options.indent ?? "  ",
        maxDepth: options.maxDepth ?? 2,
        maxLines: options.maxLines ?? 40,
        commandHints: options.commandHints ?? false,
        redactSensitiveDetails: options.redactSensitiveDetails ?? false,
    });
}
