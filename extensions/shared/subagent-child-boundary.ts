/**
 * Child-only prompt boundary shared by the TLH root and subagent runtimes.
 *
 * Keep this module dependency-free: both runtimes write their owned material to
 * structured Pi prompt sections, while this module keeps those sections
 * ordered and sanitizes their reserved marker namespace.
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

/** Structured Pi prompt sections reserved for the two child-runtime owners. */
export const CHILD_SUBAGENT_ROOT_RUNTIME_SECTION = "tlh_child_root_runtime";
export const CHILD_SUBAGENT_EXPLICIT_RUNTIME_SECTION = "tlh_child_explicit_runtime";

const RESERVED_RUNTIME_MARKER_NAMESPACE_PATTERN =
  /<!-- tlh:child-[^>\s]+-runtime(?::|(?=\s|-->|$))/gu;
const DEFANGED_RUNTIME_MARKER_PREFIX = "[tlh child-runtime marker: ";

type ChildPromptRuntimeOwner = "root" | "explicit";
type RuntimeWrapperMarkers = { open: string; close: string };
type ForcedSystemPromptOptions = { forceSystemPrompt?: string };

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

function readBlockedForcedSystemPrompt(): undefined {
  return undefined;
}

function ignoreBlockedForcedSystemPrompt(_value: unknown): void {
  // Pi's extension runner assigns returned systemPrompt values through this setter.
}

/**
 * Keep Pi 0.87's later before_agent_start handlers from restoring an opaque
 * full-prompt replacement after TLH has installed structured child sections.
 * The no-op setter is deliberate: rejecting the assignment without throwing
 * keeps Pi's handler chain running while preserving the child boundary.
 */
export function blockForcedSystemPrompt(options: ForcedSystemPromptOptions): void {
  const descriptor = Object.getOwnPropertyDescriptor(options, "forceSystemPrompt");
  if (
    descriptor?.get === readBlockedForcedSystemPrompt &&
    descriptor.set === ignoreBlockedForcedSystemPrompt
  ) {
    return;
  }

  delete options.forceSystemPrompt;
  Object.defineProperty(options, "forceSystemPrompt", {
    configurable: true,
    enumerable: true,
    get: readBlockedForcedSystemPrompt,
    set: ignoreBlockedForcedSystemPrompt,
  });
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
 * Set a structured child-runtime section while keeping root content before the
 * explicit content regardless of hook registration order.
 *
 * The explicit owner also carries the shared child boundary. The root owner
 * only contributes its additions; the fallback root registrar may include the
 * boundary in its own builder when no explicit runtime is registered.
 */
export function setStructuredChildPromptRuntime(
  sections: Record<string, string>,
  owner: ChildPromptRuntimeOwner,
  additions: readonly string[],
): void {
  const rootSection = sections[CHILD_SUBAGENT_ROOT_RUNTIME_SECTION];
  const explicitSection = sections[CHILD_SUBAGENT_EXPLICIT_RUNTIME_SECTION];
  delete sections[CHILD_SUBAGENT_ROOT_RUNTIME_SECTION];
  delete sections[CHILD_SUBAGENT_EXPLICIT_RUNTIME_SECTION];

  const runtime = [
    wrapRuntimeBlock(owner, additions),
    owner === "explicit" ? CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const nextRootSection = owner === "root" ? runtime : rootSection;
  const nextExplicitSection = owner === "explicit" ? runtime : explicitSection;
  if (nextRootSection) sections[CHILD_SUBAGENT_ROOT_RUNTIME_SECTION] = nextRootSection;
  if (nextExplicitSection) sections[CHILD_SUBAGENT_EXPLICIT_RUNTIME_SECTION] = nextExplicitSection;
}
