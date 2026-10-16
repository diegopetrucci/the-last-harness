// Generated from extensions/subagents/src/agents/agent-scope.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
export function resolveExecutionAgentScope(scope) {
    if (scope === "user" || scope === "project" || scope === "both")
        return scope;
    return "both";
}
