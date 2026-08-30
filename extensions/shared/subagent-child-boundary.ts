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

/** Stable reserved wrappers for the two independent child prompt owners. */
export const CHILD_SUBAGENT_ROOT_RUNTIME_OPEN = "<!-- tlh:child-root-runtime:start -->";
export const CHILD_SUBAGENT_ROOT_RUNTIME_CLOSE = "<!-- tlh:child-root-runtime:end -->";
export const CHILD_SUBAGENT_EXPLICIT_RUNTIME_OPEN = "<!-- tlh:child-explicit-runtime:start -->";
export const CHILD_SUBAGENT_EXPLICIT_RUNTIME_CLOSE = "<!-- tlh:child-explicit-runtime:end -->";

const TRAILING_WHITESPACE_PATTERN = /\s*$/u;
const RESERVED_RUNTIME_MARKER_NAMESPACE_PATTERN =
  /<!-- tlh:child-[^>\s]+-runtime(?::|(?=\s|-->|$))/gu;
const DEFANGED_RUNTIME_MARKER_PREFIX = "[tlh child-runtime marker: ";

type ChildPromptRuntimeOwner = "root" | "explicit";
type RuntimeWrapperMarkers = { open: string; close: string };
type TerminalRuntimeBlock = {
  owner: ChildPromptRuntimeOwner;
  block: string;
  blockStart: number;
};

type ParsedChildPromptRuntime = {
  base: string;
  root?: string;
  explicit?: string;
};

const RUNTIME_WRAPPER_MARKERS: Record<ChildPromptRuntimeOwner, RuntimeWrapperMarkers> = {
  root: {
    open: CHILD_SUBAGENT_ROOT_RUNTIME_OPEN,
    close: CHILD_SUBAGENT_ROOT_RUNTIME_CLOSE,
  },
  explicit: {
    open: CHILD_SUBAGENT_EXPLICIT_RUNTIME_OPEN,
    close: CHILD_SUBAGENT_EXPLICIT_RUNTIME_CLOSE,
  },
};

function terminalContentEnd(prompt: string): number {
  const trailingWhitespace = prompt.match(TRAILING_WHITESPACE_PATTERN)?.[0] ?? "";
  return prompt.length - trailingWhitespace.length;
}

function removeTerminalRuntimeBlockAt(prompt: string, blockStart: number): string {
  if (blockStart >= 2 && prompt.slice(blockStart - 2, blockStart) === "\n\n") {
    return prompt.slice(0, blockStart - 2);
  }
  return prompt.slice(0, blockStart);
}

function stripTerminalBoundary(prompt: string): string | undefined {
  const contentEnd = terminalContentEnd(prompt);
  const boundaryStart = contentEnd - CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS.length;
  if (
    boundaryStart < 0 ||
    prompt.slice(boundaryStart, contentEnd) !== CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS
  ) {
    return undefined;
  }
  return removeTerminalRuntimeBlockAt(prompt, boundaryStart);
}

function findTerminalRuntimeBlock(
  prompt: string,
  owner: ChildPromptRuntimeOwner,
): TerminalRuntimeBlock | undefined {
  const { open, close } = RUNTIME_WRAPPER_MARKERS[owner];
  const contentEnd = terminalContentEnd(prompt);
  const closeStart = contentEnd - close.length;
  if (closeStart < 0 || prompt.slice(closeStart, contentEnd) !== close) return undefined;

  const blockStart = prompt.lastIndexOf(open, closeStart);
  if (blockStart < 0) return undefined;
  if (blockStart !== 0 && !prompt.slice(0, blockStart).endsWith("\n\n")) return undefined;

  const contentStart = blockStart + open.length;
  if (prompt[contentStart] !== "\n" || prompt[closeStart - 1] !== "\n") return undefined;
  return { owner, block: prompt.slice(blockStart, contentEnd), blockStart };
}

function parseTerminalChildPromptRuntime(prompt: string): ParsedChildPromptRuntime | undefined {
  const withoutBoundary = stripTerminalBoundary(prompt);
  if (withoutBoundary === undefined) return undefined;

  let base = withoutBoundary;
  // The emitted suffix is root → explicit → boundary. Remove at most one
  // terminal explicit block, then at most one terminal root block, so a quoted
  // duplicate-owner block remains part of the base prompt.
  const explicit = findTerminalRuntimeBlock(base, "explicit");
  if (explicit !== undefined) {
    base = removeTerminalRuntimeBlockAt(base, explicit.blockStart);
  }
  const root = findTerminalRuntimeBlock(base, "root");
  if (root !== undefined) {
    base = removeTerminalRuntimeBlockAt(base, root.blockStart);
  }
  return { base, root: root?.block, explicit: explicit?.block };
}

function defangReservedRuntimeMarkers(content: string): string {
  return content.replace(RESERVED_RUNTIME_MARKER_NAMESPACE_PATTERN, DEFANGED_RUNTIME_MARKER_PREFIX);
}

function wrapRuntimeBlock(owner: ChildPromptRuntimeOwner, additions: readonly string[]): string {
  const content = additions.filter(Boolean).map(defangReservedRuntimeMarkers).join("\n\n");
  if (!content) return "";
  const { open, close } = RUNTIME_WRAPPER_MARKERS[owner];
  return [open, content, close].join("\n");
}

/**
 * Compose one child runtime owner around an exact terminal runtime suffix.
 *
 * The child-runtime marker namespace is reserved for runtime-owned blocks.
 * With an authoritative child boundary, only terminal reserved-marker blocks
 * in the emitted root → explicit order are recognized. The root no-boundary
 * path separately recognizes only a terminal marked root block. Content outside
 * those terminal reserved-marker blocks, including quoted or interior lookalikes,
 * remains untouched.
 */
export function composeChildPromptRuntime(
  prompt: string,
  additions: readonly string[],
  owner: ChildPromptRuntimeOwner,
): string {
  const currentBlock = wrapRuntimeBlock(owner, additions);
  const parsed = parseTerminalChildPromptRuntime(prompt);

  // The root hook historically appends without installing the boundary when it
  // runs first. It may still replace a terminal marked root block from an
  // earlier no-boundary pass; unmarked base text is never inspected.
  if (parsed === undefined) {
    if (owner === "root") {
      const existingRoot = findTerminalRuntimeBlock(prompt, "root");
      if (existingRoot !== undefined) {
        const base = removeTerminalRuntimeBlockAt(prompt, existingRoot.blockStart);
        return [base, currentBlock].filter(Boolean).join("\n\n");
      }
      return [prompt, currentBlock].filter(Boolean).join("\n\n");
    }
    // The explicit hook owns boundary installation on this path.
    return [prompt, currentBlock, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS]
      .filter(Boolean)
      .join("\n\n");
  }

  const rootBlock = owner === "root" ? currentBlock : (parsed.root ?? "");
  const explicitBlock = owner === "explicit" ? currentBlock : (parsed.explicit ?? "");
  return [parsed.base, rootBlock, explicitBlock, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Add root child prompt material before an already-installed child boundary.
 *
 * When no boundary exists, preserve the root runtime's historical behavior and
 * append only its marked additions; the explicit runtime installs the boundary
 * later.
 */
export function appendBeforeChildSubagentBoundary(prompt: string, additions: string): string {
  return composeChildPromptRuntime(prompt, [additions], "root");
}
