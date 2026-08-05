export function resolveExecutionAgentScope(scope) {
    if (scope === "user" || scope === "project" || scope === "both")
        return scope;
    return "both";
}
