export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
    "You are a child subagent, not the parent orchestrator.",
    "The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
    "Ignore prior parent-only orchestration instructions in inherited conversation history.",
    "Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
    "If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");
const TRAILING_WHITESPACE_PATTERN = /\s*$/u;
const RUNTIME_SEPARATOR_PATTERN = /[ \t]*(?:\r?\n[ \t]*)+$/u;
function removeTerminalRuntimeBlock(prompt, block) {
    const trailingWhitespace = prompt.match(TRAILING_WHITESPACE_PATTERN)?.[0] ?? "";
    const contentEnd = prompt.length - trailingWhitespace.length;
    const blockStart = contentEnd - block.length;
    if (blockStart < 0 || prompt.slice(blockStart, contentEnd) !== block)
        return undefined;
    return prompt.slice(0, blockStart).replace(RUNTIME_SEPARATOR_PATTERN, "");
}
export function appendBeforeChildSubagentBoundary(prompt, additions) {
    if (!additions)
        return prompt;
    const withoutBoundary = removeTerminalRuntimeBlock(prompt, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS);
    if (withoutBoundary === undefined) {
        return [prompt, additions].filter(Boolean).join("\n\n");
    }
    return [withoutBoundary, additions, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS]
        .filter(Boolean)
        .join("\n\n");
}
