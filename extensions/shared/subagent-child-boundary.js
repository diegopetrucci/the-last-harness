export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
    "You are a child subagent, not the parent orchestrator.",
    "The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
    "Ignore prior parent-only orchestration instructions in inherited conversation history.",
    "Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
    "If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");
export const CHILD_SUBAGENT_ROOT_RUNTIME_OPEN = "<!-- tlh:child-root-runtime:start -->";
export const CHILD_SUBAGENT_ROOT_RUNTIME_CLOSE = "<!-- tlh:child-root-runtime:end -->";
export const CHILD_SUBAGENT_EXPLICIT_RUNTIME_OPEN = "<!-- tlh:child-explicit-runtime:start -->";
export const CHILD_SUBAGENT_EXPLICIT_RUNTIME_CLOSE = "<!-- tlh:child-explicit-runtime:end -->";
export const CHILD_SUBAGENT_ROOT_RUNTIME_SECTION = "tlh_child_root_runtime";
export const CHILD_SUBAGENT_EXPLICIT_RUNTIME_SECTION = "tlh_child_explicit_runtime";
const RESERVED_RUNTIME_MARKER_NAMESPACE_PATTERN = /<!-- tlh:child-[^>\s]+-runtime(?::|(?=\s|-->|$))/gu;
const DEFANGED_RUNTIME_MARKER_PREFIX = "[tlh child-runtime marker: ";
const RUNTIME_WRAPPER_MARKERS = {
    root: {
        open: CHILD_SUBAGENT_ROOT_RUNTIME_OPEN,
        close: CHILD_SUBAGENT_ROOT_RUNTIME_CLOSE,
    },
    explicit: {
        open: CHILD_SUBAGENT_EXPLICIT_RUNTIME_OPEN,
        close: CHILD_SUBAGENT_EXPLICIT_RUNTIME_CLOSE,
    },
};
function readBlockedForcedSystemPrompt() {
    return undefined;
}
function ignoreBlockedForcedSystemPrompt(_value) {
}
export function blockForcedSystemPrompt(options) {
    const descriptor = Object.getOwnPropertyDescriptor(options, "forceSystemPrompt");
    if (descriptor?.get === readBlockedForcedSystemPrompt &&
        descriptor.set === ignoreBlockedForcedSystemPrompt) {
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
function defangReservedRuntimeMarkers(content) {
    return content.replace(RESERVED_RUNTIME_MARKER_NAMESPACE_PATTERN, DEFANGED_RUNTIME_MARKER_PREFIX);
}
function wrapRuntimeBlock(owner, additions) {
    const content = additions.filter(Boolean).map(defangReservedRuntimeMarkers).join("\n\n");
    if (!content)
        return "";
    const { open, close } = RUNTIME_WRAPPER_MARKERS[owner];
    return [open, content, close].join("\n");
}
export function setStructuredChildPromptRuntime(sections, owner, additions) {
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
    if (nextRootSection)
        sections[CHILD_SUBAGENT_ROOT_RUNTIME_SECTION] = nextRootSection;
    if (nextExplicitSection)
        sections[CHILD_SUBAGENT_EXPLICIT_RUNTIME_SECTION] = nextExplicitSection;
}
