/**
 * Child-only prompt boundary shared by the TLH root and subagent runtimes.
 *
 * Keep this module dependency-free: the root extension uses it to place its
 * child additions before a boundary that may already have been appended by
 * the explicit subagent prompt-runtime extension.
 */
export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
  "You are a child subagent, not the parent orchestrator.",
  "The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
  "Ignore prior parent-only orchestration instructions in inherited conversation history.",
  "Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
  "If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

const TRAILING_WHITESPACE_PATTERN = /\s*$/u;
const RUNTIME_SEPARATOR_PATTERN = /[ \t]*(?:\r?\n[ \t]*)+$/u;

function removeTerminalRuntimeBlock(prompt: string, block: string): string | undefined {
  const trailingWhitespace = prompt.match(TRAILING_WHITESPACE_PATTERN)?.[0] ?? "";
  const contentEnd = prompt.length - trailingWhitespace.length;
  const blockStart = contentEnd - block.length;
  if (blockStart < 0 || prompt.slice(blockStart, contentEnd) !== block) return undefined;

  // Runtime blocks are joined with a blank line. Remove only that separator
  // while preserving all preceding prompt text byte-for-byte.
  return prompt.slice(0, blockStart).replace(RUNTIME_SEPARATOR_PATTERN, "");
}

/**
 * Add root child prompt material before an already-installed child boundary.
 *
 * The explicit subagent runtime is registered before the packaged TLH root
 * runtime in child processes. When it runs first, it leaves the boundary at
 * the end of the prompt. When it runs second, this helper removes only that
 * terminal boundary and reinstates it after the root additions. If no
 * boundary exists, preserve the root runtime's historical behavior and append
 * only the additions; the explicit runtime will install the boundary later.
 */
export function appendBeforeChildSubagentBoundary(prompt: string, additions: string): string {
  if (!additions) return prompt;
  const withoutBoundary = removeTerminalRuntimeBlock(prompt, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS);
  if (withoutBoundary === undefined) {
    return [prompt, additions].filter(Boolean).join("\n\n");
  }
  return [withoutBoundary, additions, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS]
    .filter(Boolean)
    .join("\n\n");
}
